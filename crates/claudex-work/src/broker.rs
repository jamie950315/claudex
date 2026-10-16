use crate::{
    archive::{self, WorkArchive},
    events,
    mailbox::ChatMailbox,
    model::*,
    native::{Invocation, NativeFailure, NativeRunner},
    outcome, processes, progress, workspace,
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, Notify, mpsc, watch};

#[async_trait]
pub trait Integration: Send + Sync {
    async fn start(&self) -> Result<()> {
        Ok(())
    }
    fn supports(&self, _method: &str) -> bool {
        false
    }
    fn origin_available(&self) -> bool {
        false
    }
    async fn dispatch(&self, _method: &str, _peer: Provider, _params: Value) -> Result<Value> {
        bail!("Native integration is unavailable.")
    }
    async fn origin_verify(&self, _params: &Value) -> Result<Value> {
        Err(error(
            "ORIGIN_PROOF_UNAVAILABLE",
            "Independent native origin evidence is unavailable.",
        ))
    }
    async fn dispatch_fenced(
        &self,
        method: &str,
        peer: Provider,
        params: Value,
        guard: Arc<dyn crate::notifications::NativeDispatchGuard>,
    ) -> Result<Value> {
        guard.check().await?;
        self.dispatch(method, peer, params).await
    }
    async fn validate_warm_limit(&self, _limit: &str) -> Result<String> {
        bail!("Cache warming limit validation is unavailable.")
    }
    async fn warm_dispatch(
        &self,
        method: &str,
        peer: Provider,
        params: Value,
        _settings: Value,
        _stopped: bool,
    ) -> Result<Value> {
        self.dispatch(method, peer, params).await
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
}
pub struct NoIntegration;
#[async_trait]
impl Integration for NoIntegration {}
pub struct Broker {
    pub root: PathBuf,
    pub config: Config,
    pub mailbox: ChatMailbox,
    pub(crate) state: Mutex<Value>,
    controller: String,
    runner: Arc<dyn NativeRunner>,
    pub(crate) integration: Arc<dyn Integration>,
    pub(crate) mod_state: Arc<std::sync::Mutex<crate::mod_wake::ModState>>,
    running: Mutex<BTreeMap<String, watch::Sender<bool>>>,
    pub(crate) changed: Notify,
    pub(crate) closed: AtomicBool,
    pub(crate) fatal: std::sync::Mutex<Option<String>>,
    pub(crate) notification_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub(crate) origin_epoch: AtomicU64,
    pub(crate) origin_timers: std::sync::Mutex<BTreeMap<String, tokio::task::AbortHandle>>,
    pub(crate) wake_epoch: AtomicU64,
    pub(crate) wake_manifest: Mutex<crate::wake_manifest::Publication>,
    pub(crate) wake_diagnostics: std::sync::Mutex<Value>,
    origin_flights: Arc<std::sync::Mutex<BTreeMap<String, OriginCheck>>>,
    pumping: AtomicBool,
    pump_requested: AtomicBool,
}
#[derive(Clone)]
struct Actor {
    peer: Provider,
    task: Option<String>,
    key: String,
}
struct OriginCheck {
    requested: Value,
    receiver: watch::Receiver<Option<Value>>,
}
struct OriginFlight {
    flights: Arc<std::sync::Mutex<BTreeMap<String, OriginCheck>>>,
    id: String,
    sender: watch::Sender<Option<Value>>,
}
impl Drop for OriginFlight {
    fn drop(&mut self) {
        if self.sender.borrow().is_none() {
            self.sender.send_replace(Some(json!({"ok":false,"error":{"code":"CLAUDEX_ORIGIN_EXPIRED","message":"Native origin verification was interrupted."}})));
        }
        self.flights.lock().unwrap().remove(&self.id);
    }
}
impl Broker {
    pub async fn open(
        root: PathBuf,
        config: Config,
        runner: Arc<dyn NativeRunner>,
    ) -> Result<Arc<Self>> {
        Self::open_with_integration(root, config, runner, Arc::new(NoIntegration)).await
    }
    pub async fn open_with_integration(
        root: PathBuf,
        config: Config,
        runner: Arc<dyn NativeRunner>,
        integration: Arc<dyn Integration>,
    ) -> Result<Arc<Self>> {
        config.validate()?;
        if !root.is_absolute() {
            bail!("Absolute collaboration root is required.");
        }
        let root = claudex_core::storage::private_directory(root)?;
        claudex_core::storage::require_private_directory(&root)?;
        let key_path = root.join("controller-key");
        if !key_path.exists() {
            let token = random_token();
            claudex_core::storage::publish_exclusive(&key_path, format!("{token}\n"))?;
        }
        let meta = std::fs::symlink_metadata(&key_path)?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != claudex_core::storage::uid()
            || meta.nlink() != 1
            || meta.mode() & 0o777 != 0o600
            || meta.len() != 65
        {
            bail!("Unsafe collaboration controller key.");
        }
        let controller = String::from_utf8(claudex_core::storage::read_stable(&key_path)?.bytes)?
            .trim()
            .to_owned();
        if !token_valid(&controller) {
            bail!("Malformed collaboration controller key.");
        }
        let original =
            match archive::private_read_text(&root.join("work.json"), config.max_state_bytes + 1) {
                Ok(text) => Some(text),
                Err(e) if claudex_core::storage::is_not_found(&e) => None,
                Err(e) => return Err(e),
            };
        let mut state = match original.as_deref() {
            Some(text) => serde_json::from_str(text)?,
            None => json!({"version":1,"tasks":{},"requests":{}}),
        };
        let recovered_placeholders = crate::notifications::recover_empty_placeholders(&mut state);
        validate_state(&state)?;
        if recovered_placeholders {
            let path = root.join("work-notification-placeholders-v1.json");
            let original = original.as_ref().unwrap();
            match archive::private_read_text(&path, config.max_state_bytes + 1) {
                Ok(saved) if saved == *original => {}
                Ok(_) => bail!(
                    "Notification recovery backup conflicts; original evidence was preserved."
                ),
                Err(e) if claudex_core::storage::is_not_found(&e) => {
                    claudex_core::storage::publish_exclusive(&path, original)?;
                }
                Err(e) => return Err(e),
            }
        }
        if state.get("defaultModels").is_none() {
            state["defaultModels"] = json!({"codex":null,"claude":null});
        }
        if state.get("defaultEfforts").is_none() {
            state["defaultEfforts"] = json!({"codex":null,"claude":null});
        }
        for task in state["tasks"].as_object_mut().unwrap().values_mut() {
            if task.get("effort").is_none() {
                task["effort"] = Value::Null;
            }
            if task["pendingHandoff"].is_object() && task["pendingHandoff"].get("effort").is_none()
            {
                task["pendingHandoff"]["effort"] = Value::Null;
            }
            if task["status"] == "running" {
                task["status"] = json!("uncertain");
                task["error"] = json!(
                    "Broker stopped during native execution. No automatic replay or ownership transfer is allowed."
                );
                bump(task);
            }
            if let Some(deliveries) = task
                .get_mut("notification")
                .and_then(|n| n.get_mut("deliveries"))
                .and_then(Value::as_array_mut)
            {
                for d in deliveries {
                    if d["state"] == "dispatching" {
                        d["state"] = json!("uncertain");
                        d["reason"] = json!("broker-restarted-during-dispatch");
                    }
                }
            }
        }
        let broker = Arc::new(Self {
            mailbox: ChatMailbox::new(root.join("chat-mailbox")),
            root,
            config,
            state: Mutex::new(state),
            controller,
            runner,
            integration,
            mod_state: Arc::new(std::sync::Mutex::new(crate::mod_wake::ModState::default())),
            running: Mutex::new(BTreeMap::new()),
            changed: Notify::new(),
            closed: AtomicBool::new(false),
            fatal: std::sync::Mutex::new(None),
            notification_task: std::sync::Mutex::new(None),
            origin_epoch: AtomicU64::new(0),
            origin_timers: std::sync::Mutex::new(BTreeMap::new()),
            wake_epoch: AtomicU64::new(0),
            wake_manifest: Mutex::new(crate::wake_manifest::Publication::default()),
            wake_diagnostics: std::sync::Mutex::new(Value::Null),
            origin_flights: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
            pumping: AtomicBool::new(false),
            pump_requested: AtomicBool::new(false),
        });
        {
            let state = broker.state.lock().await;
            claudex_core::storage::atomic_write(
                broker.root.join("work.json"),
                format!("{state}\n"),
            )?;
        }
        let weak = Arc::downgrade(&broker);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let Some(b) = weak.upgrade() else { break };
                if b.closed.load(Ordering::Acquire) {
                    break;
                }
                if b.auto_resolve().await.unwrap_or(0) > 0 {
                    b.schedule();
                }
            }
        });
        broker.auto_resolve().await?;
        broker.start_notifications()?;
        Ok(broker)
    }
    pub fn controller_token(&self) -> &str {
        &self.controller
    }
    pub async fn snapshot(&self) -> Value {
        self.state.lock().await.clone()
    }
    pub async fn wait_closed(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            changed.await;
        }
    }
    pub(crate) fn fail(&self, error: impl std::fmt::Display) {
        self.fatal
            .lock()
            .unwrap()
            .get_or_insert_with(|| error.to_string());
        self.closed.store(true, Ordering::Release);
        self.stop_origin_rechecks();
        self.suspend_renderer_manifest();
        self.changed.notify_waiters();
    }
    fn actor(&self, e: &Envelope, s: &Value) -> Result<Actor> {
        if !token_valid(&e.token) {
            bail!("Invalid worker capability.");
        }
        if e.token == self.controller {
            return Ok(Actor {
                peer: e.peer,
                task: None,
                key: format!("controller:{}", e.peer),
            });
        }
        let hash = hash(&e.token);
        let task = s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .find(|t| {
                t["status"] == "running"
                    && t["owner"] == e.peer.as_str()
                    && t["active"]["tokenHash"] == hash
            })
            .ok_or_else(|| {
                error(
                    "CLAUDEX_ACCESS_DENIED",
                    "Worker capability expired or does not match its owner.",
                )
            })?;
        let id = task["id"].as_str().unwrap().to_string();
        Ok(Actor {
            peer: e.peer,
            key: format!("worker:{id}:{}", task["generation"]),
            task: Some(id),
        })
    }
    fn allowed(&self, a: &Actor, t: &Value, s: &Value) -> Result<()> {
        if t.is_null() {
            return Err(error("CLAUDEX_TASK_NOT_FOUND", "Unknown task."));
        }
        if let Some(id) = &a.task {
            let mut cursor = t;
            let mut seen = BTreeSet::new();
            while !cursor.is_null() {
                if cursor["id"] == *id {
                    return Ok(());
                }
                let Some(parent) = cursor["parentId"].as_str() else {
                    break;
                };
                if !seen.insert(parent) {
                    bail!("Malformed task ancestry.");
                }
                cursor = &s["tasks"][parent];
            }
            return Err(error(
                "CLAUDEX_ACCESS_DENIED",
                "Worker may only access its own task and descendants.",
            ));
        }
        Ok(())
    }
    fn effective(&self, s: &Value) -> Result<Permission> {
        s["defaultPermission"]
            .as_str()
            .map(Permission::parse)
            .unwrap_or(Ok(self.config.default_permission))
    }
    fn ceiling(&self, s: &Value) -> Result<Permission> {
        Ok(self.effective(s)?.max(if self.config.allow_full_access {
            Permission::FullAccess
        } else if self.config.allow_write {
            Permission::WorkspaceWrite
        } else {
            Permission::ReadOnly
        }))
    }
    fn check_permission(&self, p: Permission, parent: Option<&Value>, s: &Value) -> Result<()> {
        if p > self.ceiling(s)?
            || parent.is_some_and(|t| {
                Permission::parse(t["permission"].as_str().unwrap_or("")).is_ok_and(|pp| p > pp)
            })
        {
            bail!("Requested permission is not authorized by the broker or parent.");
        }
        Ok(())
    }
    pub(crate) fn commit(&self, old: &mut Value, mut next: Value) -> Result<()> {
        if *old == next {
            return Ok(());
        }
        if archive::capacity(&self.config, &next)["available"] != true {
            WorkArchive::new(&self.root).make_room(&self.config, old, &mut next)?;
        }
        let serialized = format!("{next}\n");
        if crate::mailbox::origin_references(old, now())
            != crate::mailbox::origin_references(&next, now())
        {
            self.mailbox.with_retention_lock(|| {
                claudex_core::storage::atomic_write(self.root.join("work.json"), serialized)
            })?;
        } else {
            claudex_core::storage::atomic_write(self.root.join("work.json"), serialized)?;
        }
        *old = next;
        self.changed.notify_waiters();
        Ok(())
    }
    pub async fn dispatch(self: &Arc<Self>, e: Envelope) -> Result<Value> {
        if !e.params.is_object() {
            bail!("Invalid protocol envelope.");
        }
        let actor = {
            let s = self.state.lock().await;
            self.actor(&e, &s)?
        };
        let method = e.method.as_str();
        let p = &e.params;
        if method == "wait" {
            return self.wait(&e, &actor).await;
        }
        if method == "status" {
            return self
                .read_tasks(&e, &actor, &[p.clone()], false, false)
                .await
                .map(|mut v| v.remove(0));
        }
        if method == "list" {
            return self.list(p, &actor).await;
        }
        if matches!(method, "work_events" | "work_reports" | "artifact_read") {
            let s = self.state.lock().await;
            let id = text(&p["taskId"], "taskId", 36)?;
            let t = s["tasks"]
                .get(id)
                .cloned()
                .or(WorkArchive::new(&self.root).task(id)?)
                .unwrap_or(Value::Null);
            self.allowed(&actor, &t, &s)?;
            return match method {
                "work_events" => events::query(&t, p),
                "work_reports" => progress::query_reports(&t, p),
                _ => self.artifact(&t, p).await,
            };
        }
        if method == "models" {
            if actor.task.is_some() {
                bail!("Only the controller may manage default models.");
            }
            let mut s = self.state.lock().await;
            let mut next = s.clone();
            for k in p.as_object().unwrap().keys() {
                if !["defaultModels", "defaultEfforts", "defaultPermission"].contains(&k.as_str()) {
                    bail!("Invalid model settings parameters.");
                }
            }
            for k in ["defaultModels", "defaultEfforts"] {
                if let Some(v) = p.get(k) {
                    if !v.is_object()
                        || v.as_object().unwrap().len() != 2
                        || v.get("codex").is_none()
                        || v.get("claude").is_none()
                    {
                        bail!("Both provider defaults are required.");
                    }
                    for provider in [Provider::Codex, Provider::Claude] {
                        if k == "defaultModels" {
                            model(&v[provider.as_str()])?;
                        } else {
                            provider.validate_effort(&v[provider.as_str()])?;
                        }
                    }
                    next[k] = v.clone();
                }
            }
            if let Some(v) = p.get("defaultPermission") {
                Permission::parse(v.as_str().unwrap_or(""))?;
                next["defaultPermission"] = v.clone();
            }
            if !p.as_object().unwrap().is_empty() && self.closed.load(Ordering::Acquire) {
                bail!("Broker is stopping; new mutations are refused.");
            }
            let result = json!({"defaultModels":next["defaultModels"],"defaultEfforts":next["defaultEfforts"],"defaultPermission":self.effective(&next)?});
            self.commit(&mut s, next)?;
            return Ok(result);
        }
        if method == "worker_check_in" {
            let Some(task) = &actor.task else {
                return Err(error(
                    "CLAUDEX_WORKER_REQUIRED",
                    "Only an active worker may request its own response-boundary inbox.",
                ));
            };
            let s = self.state.lock().await;
            let mut controls = p.clone();
            controls["taskId"] = json!(task);
            controls["generation"] = s["tasks"][task]["generation"].clone();
            controls["action"] = json!("check-in");
            let mut preview = s["tasks"][task].clone();
            let result = progress::check_in(&mut preview, &controls, false)?;
            if result["newlyDelivered"] == 0 && result["newlySeenProgress"] == 0 {
                return Ok(result);
            }
            drop(s);
            let mut next = e.clone();
            next.method = "work_control".into();
            next.params = controls;
            return Box::pin(self.dispatch(next)).await;
        }
        if matches!(method, "origin_bind" | "origin_recheck") {
            return self.origin(&e, &actor).await;
        }
        if method.starts_with("chat_")
            || method.starts_with("mod_wake_")
            || method.starts_with("desktop_wake_")
            || method == "native_wake"
        {
            if actor.task.is_some() {
                bail!("Only an external controller may coordinate native chats.");
            }
            if method.starts_with("mod_wake_") || method == "native_wake" {
                return self.mod_dispatch(&e).await;
            }
            return self.chat(&e).await;
        }
        if method == "cache_warm_settings" || self.integration.supports(method) {
            if actor.task.is_some() {
                bail!("Managed workers cannot manage native integrations.");
            }
            if method == "desktop_owner_wake" {
                let id = text(&p["remoteId"], "Remote Control identity", 204)?;
                if e.peer != Provider::Claude
                    || self.notification_stopped()?
                    || p.as_object().unwrap().len() != 1
                    || !id.strip_prefix("cse_").is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 200
                            && s.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    })
                {
                    bail!(
                        "Owner wake accepts only one exact Remote Control identity at the native Claude controller endpoint."
                    );
                }
            }
            if method.starts_with("cache_warm_") || method.starts_with("codex_cache_warm_") {
                return self.cache_warm(&e).await;
            }
            return self.integration.dispatch(method, e.peer, p.clone()).await;
        }
        if ![
            "start",
            "send",
            "handoff",
            "cancel",
            "resolve",
            "report",
            "work_control",
        ]
        .contains(&method)
        {
            bail!("Unknown collaboration method.");
        }
        if self.closed.load(Ordering::Acquire) {
            bail!("Broker is stopping; new mutations are refused.");
        }
        id(&p["requestId"])?;
        let mut s = self.state.lock().await;
        let actor = self.actor(&e, &s)?;
        let mut next = s.clone();
        let receipt_key = hash(format!(
            "{}:{}",
            actor.key,
            p["requestId"].as_str().unwrap()
        ));
        let fingerprint = hash_value(&json!({"method":method,"params":p}));
        if let Some(r) = next["requests"]
            .get(&receipt_key)
            .cloned()
            .or(WorkArchive::new(&self.root).request(&receipt_key)?)
        {
            if r["fingerprint"] != fingerprint {
                return Err(error(
                    "CLAUDEX_REQUEST_ID_CONFLICT",
                    "requestId was reused with different input.",
                ));
            }
            let mut result = r["result"].clone();
            result["replayed"] = json!(true);
            return Ok(result);
        }
        if let Some(a) = &actor.task {
            let task = &next["tasks"][a];
            if task["pendingHandoff"].is_object()
                || task["cancelRequested"] == true
                || task["pause"]["state"] == "checkpoint"
            {
                bail!("Worker has relinquished ownership; further mutations are refused.");
            }
        }
        let task_id;
        let mut extras = json!({});
        let mut cancel_accepted = false;
        if method == "start" {
            let provider = Provider::parse(p["provider"].as_str().unwrap_or(""))?;
            text(&p["prompt"], "prompt", 16384)?;
            let parent = actor.task.as_ref().map(|id| &next["tasks"][id]);
            let permission = p["permission"]
                .as_str()
                .map(Permission::parse)
                .transpose()?
                .unwrap_or(if let Some(parent) = parent {
                    Permission::parse(parent["permission"].as_str().unwrap_or(""))?
                } else {
                    self.effective(&next)?
                });
            self.check_permission(permission, parent, &next)?;
            let depth = parent.map_or(0, |t| t["depth"].as_u64().unwrap_or(0) + 1);
            if depth > self.config.max_depth {
                bail!("Delegation depth limit reached.");
            }
            if parent.is_some()
                && next["tasks"]
                    .as_object()
                    .unwrap()
                    .values()
                    .filter(|t| matches!(t["status"].as_str(), Some("ready" | "running")))
                    .count()
                    >= self.config.max_workers
            {
                bail!("Worker capacity reached. Wait for existing children.");
            }
            let workspace = workspace::resolve(p, permission, parent)?;
            let notifications = notification_policy(
                p.get("notifications"),
                !actor.task.is_some() && self.integration.origin_available(),
            )?;
            if notifications["mode"] != "off"
                && (actor.task.is_some() || !self.integration.origin_available())
            {
                return Err(error(
                    "CLAUDEX_ORIGIN_UNAVAILABLE",
                    "Origin notifications require an external root caller and available native origin verifier.",
                ));
            }
            let mut observability = progress::policy(p.get("observability"))?;
            if p["observability"].get("blockerNotifications").is_none() {
                observability["blockerNotifications"] =
                    json!(actor.task.is_none() && notifications["mode"] == "wake");
            }
            if observability["blockerNotifications"] == true
                && actor.task.is_none()
                && notifications["mode"] == "off"
            {
                bail!("External blocker notifications require queue or wake policy.");
            }
            let selected_model = p
                .get("model")
                .cloned()
                .unwrap_or(next["defaultModels"][provider.as_str()].clone());
            model(&selected_model)?;
            let effort = p
                .get("effort")
                .cloned()
                .unwrap_or(next["defaultEfforts"][provider.as_str()].clone());
            provider.validate_effort(&effort)?;
            task_id = uuid::Uuid::new_v4().to_string();
            let from = actor.task.clone().unwrap_or(actor.peer.to_string());
            let mut task = json!({"id":task_id,"parentId":actor.task,"returnTo":from,"owner":provider,"permission":permission,"model":selected_model,"effort":effort,"depth":depth,"generation":0,"status":"ready","revision":1,"createdAt":now(),"updatedAt":now(),"active":null,"pendingHandoff":null,"cancelRequested":false,"error":null,"result":null,"messages":[{"from":from,"kind":"request","text":p["prompt"],"at":now()}],"observability":observability});
            task.as_object_mut()
                .unwrap()
                .extend(workspace.as_object().unwrap().clone());
            events::initialize(&mut task);
            if notifications["mode"] != "off" {
                task["notification"] = json!({"policy":notifications,"requestKey":receipt_key,"challenge":random_token(),"challengeExpiresAt":now()+300000,"origin":null,"deliveries":[],"suppressedRevision":null});
            }
            if p.get("permission").is_some() && permission < self.effective(&next)? {
                extras["notice"] = json!({"code":"PERMISSION_NARROWED","defaultPermission":self.effective(&next)?,"message":format!("Permission was narrowed below the broker default. {SANDBOX_DESCRIPTION}")});
            }
            next["tasks"][&task_id] = task;
        } else {
            task_id = text(&p["taskId"], "taskId", 36)?.to_string();
            if next["tasks"].get(&task_id).is_none() && actor.task.is_none() {
                WorkArchive::new(&self.root).restore(&mut next, &task_id)?;
            }
            self.allowed(&actor, &next["tasks"][&task_id], &next)?;
            let mut task = next["tasks"][&task_id].clone();
            let annotation = method == "work_control"
                && task["status"] == "completed"
                && matches!(
                    p["action"].as_str(),
                    Some("review-result" | "resolve-blocker")
                );
            if !["cancel", "resolve"].contains(&method)
                && matches!(
                    task["status"].as_str(),
                    Some("failed" | "cancelled" | "uncertain")
                )
            {
                bail!("Failed, cancelled, or uncertain work cannot be implicitly restarted.");
            }
            let from = actor.task.clone().unwrap_or(actor.peer.to_string());
            let provenance = if actor.task.is_some() {
                "parent-worker-reported"
            } else {
                "controller-reported"
            };
            match method {
                "send" => {
                    let message = text(&p["message"], "message", 16384)?;
                    if actor.task.as_deref() == Some(&task_id) {
                        bail!("Send follow-ups to a child task, not your own running turn.");
                    }
                    if task["pendingHandoff"].is_object()
                        || task["cancelRequested"] == true
                        || task["pause"]["state"] == "checkpoint"
                    {
                        bail!("Task is already transferring, cancelling or checkpointing.");
                    }
                    extras["instructionId"] = json!(progress::instruction(
                        &mut task,
                        &from,
                        provenance,
                        message,
                        json!({})
                    )?);
                    if task["status"] == "completed" {
                        task["status"] = json!("ready");
                    }
                }
                "handoff" => {
                    let provider = Provider::parse(p["provider"].as_str().unwrap_or(""))?;
                    text(&p["message"], "message", 16384)?;
                    if p["revision"] != task["revision"] {
                        bail!("Task revision changed; read status before handing off.");
                    }
                    if task["owner"] == provider.as_str()
                        || task["pendingHandoff"].is_object()
                        || task["cancelRequested"] == true
                        || matches!(
                            task["pause"]["state"].as_str(),
                            Some("requested" | "checkpoint" | "paused")
                        )
                    {
                        bail!("Handoff requires a different owner and no pending transition.");
                    }
                    if children_active(&next, &task_id) {
                        bail!("Finish or cancel active child work before transferring ownership.");
                    }
                    let model = p
                        .get("model")
                        .cloned()
                        .unwrap_or(next["defaultModels"][provider.as_str()].clone());
                    crate::model::model(&model)?;
                    let effort = p
                        .get("effort")
                        .cloned()
                        .unwrap_or(next["defaultEfforts"][provider.as_str()].clone());
                    provider.validate_effort(&effort)?;
                    let mut message =
                        json!({"from":from,"kind":"handoff","text":p["message"],"at":now()});
                    if let Some(r) = p.get("report") {
                        outcome::validate(r)?;
                        let mut report = r.clone();
                        report["provenance"] = json!(if actor.task.as_deref() == Some(&task_id) {
                            "worker-self-reported"
                        } else {
                            provenance
                        });
                        report["reporterTaskId"] = json!(actor.task);
                        report["generation"] = task["generation"].clone();
                        report["provider"] = json!(actor.peer);
                        message["report"] = report;
                    }
                    push(&mut task["messages"], message);
                    if task["status"] == "running" {
                        task["pendingHandoff"] =
                            json!({"provider":provider,"model":model,"effort":effort});
                    } else {
                        task["owner"] = json!(provider);
                        task["model"] = model;
                        task["effort"] = effort;
                        task["status"] = json!("ready");
                    }
                    extras["nextAction"] = json!("end-turn");
                    extras["finalResponse"] = json!("CLAUDEX_HANDOFF");
                    extras["instruction"] = json!(
                        "The handoff context is saved. End this native turn now with exactly CLAUDEX_HANDOFF. Do not call tools, wait, or repeat the handoff summary. Ownership transfers only after successful native completion and process exit."
                    );
                }
                "report" => {
                    if actor.task.as_deref() != Some(&task_id) || task["status"] != "running" {
                        return Err(error(
                            "CLAUDEX_REPORT_OWNER_REQUIRED",
                            "Only the active worker may report its own outcome.",
                        ));
                    }
                    outcome::validate(&p["report"])?;
                    let mut report = p["report"].clone();
                    report["provenance"] = json!("worker-self-reported");
                    report["generation"] = task["generation"].clone();
                    report["provider"] = json!(actor.peer);
                    report["reportedAt"] = json!(now());
                    extras = progress::record(&mut task, report.clone())?;
                    if extras["reportChanged"] == true {
                        task["active"]["report"] = report;
                        deliver_progress(&mut next, &task, &extras)?;
                    }
                }
                "work_control" => {
                    extras = progress::control(
                        &mut task,
                        p,
                        &from,
                        actor.task.as_deref() == Some(&task_id),
                        actor.task.is_some(),
                        children_active(&next, &task_id),
                    )?;
                }
                "resolve" => {
                    if actor.task.is_some()
                        || task["status"] != "uncertain"
                        || p["outcome"] != "failed"
                        || p["revision"] != task["revision"]
                    {
                        bail!(
                            "Resolution requires controller, exact uncertain revision and failed outcome."
                        );
                    }
                    let reason = text(&p["reason"], "resolution reason", 2048)?;
                    let execution = if task["active"].is_object() {
                        &task["active"]
                    } else {
                        &task["lastExecution"]
                    };
                    let attested = execution["processInventoryError"] == true;
                    if attested
                        && (p["processInventoryReconciled"] != true
                            || text(
                                &p["processInventoryNotes"],
                                "process inventory reconciliation notes",
                                4096,
                            )
                            .is_err())
                    {
                        bail!("Incomplete process inventory requires explicit reconciliation.");
                    }
                    let proof = self.exit_proof(&next, &task, attested).await?;
                    let mut resolution = json!({"outcome":"failed","reason":reason,"previousStatus":task["status"],"previousError":task["error"],"previousRevision":task["revision"],"inspectedAt":now(),"pid":proof["pid"],"processAbsent":true,"groupAbsent":true,"resolvedAt":now(),"controller":actor.peer,"ownedProcessInspection":proof["ownedProcessInspection"]});
                    if task["permission"] != "read-only" {
                        if p["workspaceReconciled"] != true {
                            bail!(
                                "Writable uncertain execution requires explicit workspace reconciliation acknowledgement."
                            );
                        }
                        let notes = text(
                            &p["reconciliationNotes"],
                            "workspace reconciliation notes",
                            4096,
                        )?;
                        resolution["workspaceReconciled"] = json!(true);
                        resolution["workspaceReconciliation"] = json!({"notes":notes,"cwd":task["cwd"],"projectRoot":task.get("projectRoot").unwrap_or(&task["cwd"]),"readOnlyDirs":array(&task["readOnlyDirs"]),"writableDirs":array(&task["writableDirs"])});
                    }
                    if attested {
                        resolution["processInventoryReconciled"] = json!(true);
                        resolution["processInventoryReconciliation"] =
                            json!({"notes":p["processInventoryNotes"]});
                    }
                    task["resolution"] = resolution;
                    task["status"] = json!("failed");
                }
                "cancel" => {
                    if task["status"] == "uncertain" {
                        bail!(
                            "Uncertain execution requires operator inspection; cancellation cannot prove an unknown writer stopped."
                        );
                    }
                    cancel_accepted = !terminal(&task["status"]) && task["cancelRequested"] != true;
                    next["tasks"][&task_id] = task.clone();
                    cancel_tree(&mut next, &task_id);
                    task = next["tasks"][&task_id].clone();
                }
                _ => unreachable!(),
            }
            let no_change = method == "report" && extras["reportChanged"] == false
                || method == "work_control"
                    && p["action"] == "check-in"
                    && extras["newlyDelivered"] == 0
                    && extras["newlySeenProgress"] == 0;
            if method != "cancel" && !annotation && !no_change {
                bump(&mut task);
            }
            if bytes(&task["messages"]) > 192 * 1024 {
                bail!("Task context capacity reached; no messages were truncated.");
            }
            next["tasks"][&task_id] = task.clone();
            if method == "resolve" {
                deliver_parent(&mut next, &task);
            }
        }
        let task = &next["tasks"][&task_id];
        progress::capacity(task)?;
        let mut receipt = json!({"taskId":task_id,"revision":task["revision"],"status":task["status"],"owner":task["owner"],"handoffPending":task["pendingHandoff"].is_object(),"returnTo":task["returnTo"]});
        receipt
            .as_object_mut()
            .unwrap()
            .extend(extras.as_object().unwrap().clone());
        if matches!(method, "start" | "handoff") {
            let permission = Permission::parse(task["permission"].as_str().unwrap())?;
            let provider = Provider::parse(if method == "handoff" {
                p["provider"].as_str().unwrap()
            } else {
                task["owner"].as_str().unwrap()
            })?;
            receipt["permission"] = json!(permission);
            receipt["capabilities"] = permission.capabilities(Some(provider));
        }
        if method == "start" {
            for k in ["cwd", "projectRoot", "readOnlyDirs", "writableDirs"] {
                receipt[k] = task[k].clone();
            }
            if task["notification"].is_object() {
                receipt["originChallenge"] = task["notification"]["challenge"].clone();
                receipt["originChallengeExpiresAt"] =
                    task["notification"]["challengeExpiresAt"].clone();
                receipt["notificationMode"] = task["notification"]["policy"]["mode"].clone();
            }
        }
        if method == "cancel" {
            receipt["cancelAccepted"] = json!(cancel_accepted);
            receipt["cancelPending"] =
                json!(task["status"] == "running" && task["cancelRequested"] == true);
            receipt["cancelRequested"] = task["cancelRequested"].clone();
            receipt["terminal"] = json!(terminal(&task["status"]));
            receipt["phase"] = presentation(task)["phase"].clone();
        }
        if progress::mcp_bytes(&receipt)
            > p["responseBudgetBytes"].as_u64().unwrap_or(768 * 1024) as usize
        {
            return Err(error(
                "CLAUDEX_RESPONSE_CAPACITY",
                "Mutation response exceeds its byte bound; no receipt or delivery was committed.",
            ));
        }
        next["requests"][&receipt_key] = json!({"fingerprint":fingerprint,"result":receipt});
        self.commit(&mut s, next)?;
        drop(s);
        if method == "cancel" {
            let state = self.state.lock().await;
            for (id, cancel) in self.running.lock().await.iter() {
                if state["tasks"][id]["cancelRequested"] == true {
                    let _ = cancel.send(true);
                }
            }
        }
        self.schedule();
        Ok(receipt)
    }
    async fn list(&self, p: &Value, a: &Actor) -> Result<Value> {
        let limit = p["limit"].as_u64().unwrap_or(100);
        let order = p["order"].as_str().unwrap_or("id");
        if limit == 0
            || limit > 100
            || !["id", "recent"].contains(&order)
            || p.as_object().unwrap().keys().any(|k| {
                !["status", "parentId", "project", "limit", "cursor", "order"].contains(&k.as_str())
            })
        {
            return Err(error(
                "CLAUDEX_INVALID_QUERY",
                "Invalid task list filters or bounds.",
            ));
        }
        let s = self.state.lock().await;
        let mut filter = json!([
            p["status"],
            p["parentId"],
            p.get("parentId").is_some(),
            p["project"],
            a.key
        ]);
        if order == "recent" {
            push(&mut filter, json!(order));
        }
        let digest = hash_value(&filter);
        let mut after = Value::Null;
        if let Some(c) = p["cursor"].as_str() {
            let v = events::decode(c)?;
            if c.len() > 512
                || v["filter"] != digest
                || order == "id" && !v["after"].is_string()
                || order == "recent"
                    && (!v["after"]["updatedAt"].is_u64() || !v["after"]["id"].is_string())
            {
                return Err(error(
                    "CLAUDEX_INVALID_CURSOR",
                    "Task cursor does not match this query.",
                ));
            }
            after = v["after"].clone();
        }
        let mut tasks = s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter(|t| {
                self.allowed(a, t, &s).is_ok()
                    && p.get("status").is_none_or(|v| v == &t["status"])
                    && p.get("parentId").is_none_or(|v| v == &t["parentId"])
                    && p.get("project")
                        .is_none_or(|v| v == t.get("projectRoot").unwrap_or(&t["cwd"]))
            })
            .cloned()
            .collect::<Vec<_>>();
        tasks.sort_by(|a, b| {
            if order == "recent" {
                b["updatedAt"]
                    .as_u64()
                    .cmp(&a["updatedAt"].as_u64())
                    .then(a["id"].as_str().cmp(&b["id"].as_str()))
            } else {
                a["id"].as_str().cmp(&b["id"].as_str())
            }
        });
        let total = tasks.len();
        let remaining = tasks
            .into_iter()
            .filter(|t| {
                after.is_null()
                    || if order == "id" {
                        t["id"].as_str() > after.as_str()
                    } else {
                        t["updatedAt"].as_u64() < after["updatedAt"].as_u64()
                            || t["updatedAt"] == after["updatedAt"]
                                && t["id"].as_str() > after["id"].as_str()
                    }
            })
            .collect::<Vec<_>>();
        let page = remaining.iter().take(limit as usize).collect::<Vec<_>>();
        let cursor = if remaining.len() > page.len() {
            let last = page.last().unwrap();
            Some(events::encode(
                &json!({"filter":digest,"after":if order=="id"{last["id"].clone()}else{json!({"updatedAt":last["updatedAt"],"id":last["id"]})}}),
            ))
        } else {
            None
        };
        let running = self
            .running
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut capabilities = json!({});
        for p in [
            Permission::ReadOnly,
            Permission::WorkspaceWrite,
            Permission::FullAccess,
        ] {
            capabilities[p.as_str()] = p.capabilities(None);
        }
        let mut result = json!({"tasks":page.iter().map(|t|{let mut v=json!({"id":t["id"],"parentId":t["parentId"],"owner":t["owner"],"status":t["status"],"projectRoot":t.get("projectRoot").unwrap_or(&t["cwd"]),"waitReason":wait_reason(t,&s,&running,self.closed.load(Ordering::Acquire),self.config.max_workers),"revision":t["revision"],"updatedAt":t["updatedAt"]});v.as_object_mut().unwrap().extend(presentation(t).as_object().unwrap().clone());v}).collect::<Vec<_>>(),"inventoryScope":"active","archivedTaskCount":s["archive"]["tasks"].as_u64().unwrap_or(0),"totalCount":total,"nextCursor":cursor,"limits":{"maxWorkers":self.config.max_workers,"maxDepth":self.config.max_depth,"maxSteps":self.config.max_steps,"maxTasks":self.config.max_tasks,"maxRequests":self.config.max_requests,"maxStateBytes":self.config.max_state_bytes,"capacity":archive::capacity(&self.config,&s),"archive":s.get("archive").cloned().unwrap_or(json!({"tasks":0,"requests":0})),"allowWrite":self.ceiling(&s)?>=Permission::WorkspaceWrite,"allowFullAccess":self.ceiling(&s)?>=Permission::FullAccess,"defaultPermission":self.effective(&s)?,"permissionCapabilities":capabilities,"defaultModels":s["defaultModels"],"defaultEfforts":s["defaultEfforts"],"allProjects":true},"blockedByUncertainWork":s["tasks"].as_object().unwrap().values().any(|t|t["status"]=="uncertain"),"rendererWakeManifest":self.renderer_manifest(),"completionDelivery":crate::notifications::completion_capability(&self.root,&s,&self.mod_status()),"uncertainTasks":s["tasks"].as_object().unwrap().values().filter(|t|t["status"]=="uncertain").take(20).map(|t|json!({"id":t["id"],"owner":t["owner"],"permission":t["permission"],"cwd":t["cwd"],"error":t["error"],"revision":t["revision"],"updatedAt":t["updatedAt"]})).collect::<Vec<_>>()});
        if a.task.is_none() {
            result["chatMailbox"] = self.mailbox.diagnostics()?;
        }
        Ok(result)
    }
    async fn wait(&self, e: &Envelope, a: &Actor) -> Result<Value> {
        let p = &e.params;
        let many = p.get("targets").is_some();
        let mut targets = if many {
            array(&p["targets"])
        } else {
            vec![json!({"taskId":p["taskId"],"afterRevision":p["afterRevision"]})]
        };
        let timeout = p["timeoutMs"].as_u64().unwrap_or(DEFAULT_WAIT_MS);
        if timeout > MAX_WAIT_MS
            || targets.is_empty()
            || targets.len() > 16
            || many && (p.get("taskId").is_some() || p.get("afterRevision").is_some())
            || targets
                .iter()
                .filter_map(|t| t["taskId"].as_str())
                .collect::<BTreeSet<_>>()
                .len()
                != targets.len()
        {
            return Err(error(
                "CLAUDEX_INVALID_WAIT",
                "Wait requires 1–16 distinct targets and valid bounds.",
            ));
        }
        let start = tokio::time::Instant::now();
        {
            let s = self.state.lock().await;
            for t in &mut targets {
                let id = text(&t["taskId"], "taskId", 36)?;
                let task = s["tasks"]
                    .get(id)
                    .cloned()
                    .or(WorkArchive::new(&self.root).task(id)?)
                    .unwrap_or(Value::Null);
                self.allowed(a, &task, &s)?;
                if a.task.as_deref() == Some(id) {
                    return Err(error(
                        "CLAUDEX_SELF_WAIT",
                        "A worker cannot wait on its own running task.",
                    ));
                }
                if let Some(v) = t.get("afterRevision").filter(|v| !v.is_null()) {
                    if !v.is_u64() {
                        bail!("Invalid wait revision.");
                    }
                }
                t["baseline"] = t
                    .get("afterRevision")
                    .filter(|v| v.is_u64())
                    .cloned()
                    .unwrap_or(task["revision"].clone());
            }
        }
        let mut timed_out = false;
        let chosen = loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let s = self.state.lock().await;
            let mut ready = vec![];
            for t in &targets {
                let id = t["taskId"].as_str().unwrap();
                let task = s["tasks"]
                    .get(id)
                    .cloned()
                    .or(WorkArchive::new(&self.root).task(id)?)
                    .unwrap_or(Value::Null);
                if terminal(&task["status"]) || task["revision"].as_u64() > t["baseline"].as_u64() {
                    ready.push(t.clone());
                }
            }
            drop(s);
            if !ready.is_empty() {
                break ready;
            }
            if timeout == 0
                || start.elapsed().as_millis() >= timeout as u128
                || self.closed.load(Ordering::Acquire)
            {
                timed_out = timeout != 0;
                break targets.clone();
            }
            let remaining =
                std::time::Duration::from_millis(timeout).saturating_sub(start.elapsed());
            if tokio::time::timeout(remaining, notified).await.is_err() {
                timed_out = true;
                break targets.clone();
            }
        };
        let mut envelope = e.clone();
        if many && p.get("view").is_none() {
            envelope.params["view"] = json!("summary");
        }
        let mut result = self
            .read_tasks(&envelope, a, &chosen, timed_out, many)
            .await?;
        if !many {
            return Ok(result.remove(0));
        }
        Ok(
            json!({"timedOut":timed_out,"changed":result.iter().any(|t|t["changed"]==true),"terminal":result.iter().all(|t|t["terminal"]==true),"requestedCount":targets.len(),"tasks":result}),
        )
    }
    async fn read_tasks(
        &self,
        e: &Envelope,
        _a: &Actor,
        targets: &[Value],
        timed_out: bool,
        bounded: bool,
    ) -> Result<Vec<Value>> {
        let view = e.params["view"].as_str().unwrap_or("full");
        if !["full", "summary"].contains(&view) {
            bail!("Invalid task view.");
        }
        let mut s = self.state.lock().await;
        let a = self.actor(e, &s)?;
        let running = self
            .running
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut next = s.clone();
        let mut responses = vec![];
        let mut continuations = vec![];
        let mut acknowledgements = vec![];
        for target in targets {
            let id = text(&target["taskId"], "taskId", 36)?;
            let archived = s["tasks"].get(id).is_none();
            let task = s["tasks"]
                .get(id)
                .cloned()
                .or(WorkArchive::new(&self.root).task(id)?)
                .unwrap_or(Value::Null);
            self.allowed(&a, &task, &s)?;
            let child = a
                .task
                .as_ref()
                .is_some_and(|parent| task["parentId"] == *parent)
                && terminal(&task["status"]);
            let unseen = child
                && a.task.as_ref().is_some_and(|parent| {
                    s["tasks"][parent]["active"]["seenChildren"][id] != task["revision"]
                });
            let include = view == "full"
                || terminal(&task["status"])
                    && (target.get("afterRevision").is_none_or(|v| v.is_null())
                        || task["revision"].as_u64() > target["afterRevision"].as_u64()
                        || unseen);
            let mut response = if view == "full" {
                let mut public = task.clone();
                if let Some(active) = public["active"].as_object_mut() {
                    active.remove("tokenHash");
                }
                for key in ["workEvents", "reportHistory"] {
                    public.as_object_mut().unwrap().remove(key);
                }
                public
            } else {
                let execution = if task["active"].is_object() {
                    &task["active"]
                } else {
                    &task["lastExecution"]
                };
                json!({"id":id,"taskId":id,"parentId":task["parentId"],"owner":task["owner"],"model":task["model"],"effort":task["effort"],"projectRoot":task.get("projectRoot").unwrap_or(&task["cwd"]),"readOnlyDirs":array(&task["readOnlyDirs"]),"writableDirs":array(&task["writableDirs"]),"permission":task["permission"],"status":task["status"],"revision":task["revision"],"generation":task["generation"],"updatedAt":task["updatedAt"],"cancelRequested":task["cancelRequested"],"execution":{"generation":execution.get("generation").unwrap_or(&task["generation"]),"inputs":execution["inputs"],"usage":if task["active"].is_object(){Value::Null}else{execution["usage"].clone()},"activity":execution["activity"],"modelEvidence":execution["activity"].get("models").cloned().unwrap_or(json!({"status":"not-reported","main":[]}))},"usageTotals":task["usageTotals"]})
            };
            if include {
                response["result"] = task["result"].clone();
                response["error"] = task["error"].clone();
            }
            response
                .as_object_mut()
                .unwrap()
                .extend(presentation(&task).as_object().unwrap().clone());
            response
                .as_object_mut()
                .unwrap()
                .extend(progress::presentation(&task).as_object().unwrap().clone());
            response["archived"] = json!(archived);
            response["limits"] = json!({"maxSteps":self.config.max_steps,"transitionBudget":{"used":task["generation"],"remaining":self.config.max_steps.saturating_sub(task["generation"].as_u64().unwrap_or(0))},"capacity":archive::capacity(&self.config,&s),"archive":s.get("archive").cloned().unwrap_or(json!({"tasks":0,"requests":0}))});
            response["waitReason"] = wait_reason(
                &task,
                &s,
                &running,
                self.closed.load(Ordering::Acquire),
                self.config.max_workers,
            );
            response["notification"] = self.notification_presentation(&task)?;
            if e.params["checkNotification"] == true {
                if a.task.is_some() {
                    bail!("Only an external controller may inspect its native continuation route.");
                }
                continuations.push((responses.len(), task.clone()));
            }
            if include || !terminal(&task["status"]) {
                response["outcome"] = outcome::presentation(&task);
            }
            response["objective"] = json!(
                array(&task["messages"])
                    .iter()
                    .find(|m| m["kind"] == "request")
                    .and_then(|m| m["text"].as_str())
                    .unwrap_or("")
                    .chars()
                    .take(2048)
                    .collect::<String>()
            );
            let children = s["tasks"]
                .as_object()
                .unwrap()
                .values()
                .filter(|t| t["parentId"] == id)
                .collect::<Vec<_>>();
            response["childrenTotalCount"] = json!(children.len());
            response["childrenTruncated"] = json!(children.len() > 64);
            response["children"]=json!(children.iter().take(64).map(|t|json!({"taskId":t["id"],"status":t["status"],"generation":t["generation"],"revision":t["revision"],"unread":terminal(&t["status"])&&task["active"].get("seenChildren").or(task["lastExecution"].get("seenChildren")).unwrap_or(&Value::Null)[t["id"].as_str().unwrap()]!=t["revision"]})).collect::<Vec<_>>());
            if bounded || e.method == "wait" || view == "summary" {
                let baseline = target
                    .get("baseline")
                    .or(target.get("afterRevision"))
                    .and_then(Value::as_u64);
                response["changed"] =
                    json!(baseline.is_none_or(|b| task["revision"].as_u64().unwrap_or(0) > b));
                response["timedOut"] = json!(timed_out);
            }
            response["completionDelivery"] = crate::notifications::task_completion(
                crate::notifications::completion_capability(&self.root, &s, &self.mod_status()),
                &task,
                None,
            );
            response["rendererWakeManifest"] = self.renderer_manifest();
            if child && include && unseen {
                acknowledgements.push((id.to_string(), task["revision"].clone()));
            }
            responses.push(response);
        }
        let value = if bounded {
            json!({"tasks":responses})
        } else {
            responses.first().cloned().unwrap_or(Value::Null)
        };
        if progress::mcp_bytes(&value) > 768 * 1024 {
            return Err(error(
                "CLAUDEX_RESPONSE_CAPACITY",
                "Task response exceeds its bound; no outcomes were acknowledged.",
            ));
        }
        if !acknowledgements.is_empty() {
            let parent = a.task.unwrap();
            if !next["tasks"][&parent]["active"]["seenChildren"].is_object() {
                next["tasks"][&parent]["active"]["seenChildren"] = json!({});
            }
            for (id, revision) in acknowledgements {
                next["tasks"][&parent]["active"]["seenChildren"][&id] = revision;
            }
            self.commit(&mut s, next)?;
        }
        drop(s);
        for (index, task) in continuations {
            let continuation = self.continuation(&task).await?;
            responses[index]["completionDelivery"] = crate::notifications::task_completion(
                responses[index]["completionDelivery"].clone(),
                &task,
                Some(&continuation),
            );
            responses[index]["notification"]["continuation"] = continuation;
        }
        Ok(responses)
    }
    pub fn schedule(self: &Arc<Self>) {
        self.pump_requested.store(true, Ordering::Release);
        if self.closed.load(Ordering::Acquire) || self.pumping.swap(true, Ordering::AcqRel) {
            return;
        }
        let b = self.clone();
        tokio::spawn(async move {
            b.pump_requested.store(false, Ordering::Release);
            let result = b.pump().await;
            b.pumping.store(false, Ordering::Release);
            if b.pump_requested.load(Ordering::Acquire) && !b.closed.load(Ordering::Acquire) {
                b.schedule();
            }
            if let Err(e) = result {
                eprintln!("Claudex collaboration broker: {e}");
                b.fail(e);
            }
        });
    }
    async fn pump(self: &Arc<Self>) -> Result<()> {
        loop {
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            let mut s = self.state.lock().await;
            let mut running = self.running.lock().await;
            if running.len() >= self.config.max_workers {
                break;
            }
            let selected = s["tasks"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(id, t)| {
                    t["status"] == "ready"
                        && !running.contains_key(*id)
                        && uncertain_blockers(&s, t).is_empty()
                })
                .map(|(id, _)| id.clone());
            let Some(id) = selected else { break };
            let mut next = s.clone();
            let mut task = next["tasks"][&id].clone();
            let permission = Permission::parse(task["permission"].as_str().unwrap())?;
            let failure = if permission > self.ceiling(&next)? {
                Some("The current broker no longer authorizes this permission.".into())
            } else if task["generation"].as_u64().unwrap_or(0) >= self.config.max_steps {
                Some("Execution/ownership transition limit reached.".into())
            } else {
                workspace::revalidate(&task).err().map(|e| e.to_string())
            };
            if let Some(message) = failure {
                task["status"] = json!("failed");
                task["error"] = json!(message);
                bump(&mut task);
                next["tasks"][&id] = task.clone();
                deliver_parent(&mut next, &task);
                self.commit(&mut s, next)?;
                continue;
            }
            let token = random_token();
            task["status"] = json!("running");
            task["generation"] = json!(task["generation"].as_u64().unwrap() + 1);
            bump(&mut task);
            let from = task["lastExecution"]["messageCount"].as_u64().unwrap_or(0) as usize;
            let messages = array(&task["messages"]);
            let kinds = messages
                .iter()
                .skip(from)
                .filter_map(|m| m["kind"].as_str())
                .filter(|k| {
                    [
                        "request",
                        "message",
                        "child-result",
                        "child-progress",
                        "handoff",
                    ]
                    .contains(k)
                })
                .collect::<BTreeSet<_>>();
            task["active"] = json!({"generation":task["generation"],"tokenHash":hash(&token),"messageCount":messages.len(),"provider":task["owner"],"startedAt":now(),"pid":null,"sessionId":null,"seenChildren":{},"inputs":{"from":from,"to":messages.len(),"kinds":kinds}});
            if self.runner.tracks_owned_processes() {
                task["active"]["processInventoryRequired"] = json!(true);
            }
            let instruction_generation = task["active"]["generation"].clone();
            if let Some(instructions) = task["instructions"].as_array_mut() {
                for r in instructions {
                    if r["state"] == "queued"
                        || r["state"] == "delivered"
                            && messages
                                .iter()
                                .skip(from)
                                .any(|m| m["instructionId"] == r["id"])
                    {
                        r["state"] = json!("delivered");
                        r["generation"] = instruction_generation.clone();
                        r["deliveredAt"] = json!(now());
                        r["deliveryProvenance"] = json!("broker-context");
                        r["deliveryCount"] = json!(r["deliveryCount"].as_u64().unwrap_or(0) + 1);
                    }
                }
            }
            next["tasks"][&id] = task.clone();
            self.commit(&mut s, next)?;
            let (cancel, cancellation) = watch::channel(false);
            running.insert(id.clone(), cancel);
            drop(running);
            drop(s);
            let b = self.clone();
            tokio::spawn(async move {
                let result = b.execute(task, token, cancellation).await;
                if let Err(e) = result {
                    eprintln!("Claudex native completion: {e}");
                    b.fail(e);
                }
                b.running.lock().await.remove(&id);
                b.changed.notify_waiters();
                b.schedule();
            });
        }
        Ok(())
    }
    async fn execute(
        self: &Arc<Self>,
        task: Value,
        token: String,
        cancellation: watch::Receiver<bool>,
    ) -> Result<()> {
        let id = task["id"].as_str().unwrap().to_string();
        let generation = task["generation"].clone();
        let mcp = json!({"command":self.config.executable,"args":["collaboration","mcp","--root",self.root,"--peer",task["owner"]],"env":{"CLAUDEX_WORK_TOKEN":token}});
        let (tx, mut rx) = mpsc::channel(128);
        let invocation = Invocation {
            prompt: prompt(&task),
            task: task.clone(),
            mcp,
            cancellation,
        };
        let runner = self.runner.clone();
        let worker = tokio::spawn(async move { runner.run(invocation, tx).await });
        let mut event_failure = None;
        while let Some(event) = rx.recv().await {
            if event_failure.is_some() {
                continue;
            }
            let handled = async {
                let mut s = self.state.lock().await;
                let mut next = s.clone();
                let t = &mut next["tasks"][&id];
                if t["status"] != "running" || t["active"]["generation"] != generation {
                    bail!("Native event has a stale ownership generation.");
                }
                match event["type"].as_str() {
                    Some("spawn") => {
                        if event["pid"].as_u64().is_none_or(|p| p <= 1) {
                            bail!("Invalid native process identity.");
                        }
                        t["active"]["pid"] = event["pid"].clone();
                    }
                    Some("session") => {
                        text(&event["sessionId"], "sessionId", 200)?;
                        t["active"]["sessionId"] = event["sessionId"].clone();
                    }
                    Some("process-inspection-failed") => {
                        t["active"]["processInventoryRequired"] = json!(true);
                        t["active"]["processInventoryError"] = json!(true);
                    }
                    Some("processes") => {
                        let records: Vec<processes::ProcessIdentity> =
                            serde_json::from_value(event["ownedProcesses"].clone())?;
                        processes::validate(&records)?;
                        if records.first().map(|r| r.pid as u64) != t["active"]["pid"].as_u64() {
                            bail!("Native process inventory changed its saved ownership proof.");
                        }
                        if let Some(previous) = t["active"].get("ownedProcesses") {
                            let previous: Vec<processes::ProcessIdentity> =
                                serde_json::from_value(previous.clone())?;
                            if previous.first() != records.first()
                                || records
                                    .iter()
                                    .any(|r| previous.iter().any(|p| p.pid == r.pid && p != r))
                            {
                                bail!(
                                    "Native process inventory changed a retained exact identity."
                                );
                            }
                        }
                        t["active"]["ownedProcesses"] = event["ownedProcesses"].clone();
                    }
                    Some("work-event") => {
                        let mut e = event["event"].clone();
                        e["generation"] = generation.clone();
                        events::append(t, e);
                    }
                    Some("native") => {
                        let native = &event["event"];
                        let provider = task["owner"].as_str().unwrap();
                        observe_native(t, provider, native);
                    }
                    _ => {}
                }
                self.commit(&mut s, next)?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = handled {
                self.fail(&error);
                if let Some(cancel) = self.running.lock().await.get(&id) {
                    let _ = cancel.send(true);
                }
                event_failure = Some(error);
            }
        }
        let result = worker
            .await
            .unwrap_or_else(|_| Err(NativeFailure::uncertain("Native worker task failed.")));
        if let Some(error) = event_failure {
            return Err(error);
        }
        let mut s = self.state.lock().await;
        let mut next = s.clone();
        let active_children = children_active(&next, &id);
        let mut current = next["tasks"][&id].clone();
        if current["status"] != "running" || current["active"]["generation"] != generation {
            bail!("Native completion does not match the active generation.");
        }
        let mut active = current["active"].clone();
        let successful = result.is_ok();
        match result {
            Err(failure) => {
                current["status"] = json!(if failure.uncertain {
                    "uncertain"
                } else if current["cancelRequested"] == true {
                    "cancelled"
                } else {
                    "failed"
                });
                current["error"] = json!(failure.message.chars().take(2048).collect::<String>());
                current["pendingHandoff"] = Value::Null;
                if let Some(usage) = failure.usage {
                    record_usage(&mut current, &mut active, &task["owner"], usage);
                }
                if let Some(activity) = failure.activity {
                    active["activity"] = crate::activity::sanitize(&activity);
                }
                if !failure.uncertain
                    && active["pid"].is_null()
                    && active.get("ownedProcesses").is_none()
                {
                    active["notStarted"] = json!(true);
                    active
                        .as_object_mut()
                        .unwrap()
                        .remove("processInventoryRequired");
                    active
                        .as_object_mut()
                        .unwrap()
                        .remove("processInventoryError");
                }
            }
            Ok(result) => {
                text(&json!(result.text), "native result", 65536)?;
                current["result"] = json!({"text":result.text,"provider":task["owner"],"sessionId":result.session_id.map(Value::String).unwrap_or(active["sessionId"].clone()),"generation":generation,"at":now()});
                push(
                    &mut current["messages"],
                    json!({"from":task["owner"],"kind":"result","text":result.text,"at":now()}),
                );
                if let Some(usage) = result.usage {
                    record_usage(&mut current, &mut active, &task["owner"], usage);
                }
                if let Some(activity) = result.activity {
                    active["activity"] = crate::activity::sanitize(&activity);
                }
                let from = active["messageCount"].as_u64().unwrap_or(0) as usize;
                let messages = array(&current["messages"]);
                let new = messages
                    .iter()
                    .skip(from)
                    .take(messages.len().saturating_sub(from + 1));
                if current["cancelRequested"] == true {
                    current["status"] = json!("cancelled");
                    current["pendingHandoff"] = Value::Null;
                } else if current["pause"]["state"] == "checkpoint"
                    && current["pause"]["generation"] == generation
                {
                    current["status"] = json!("paused");
                    current["pause"]["state"] = json!("paused");
                    current["pause"]["pausedAt"] = json!(now());
                    current["pause"]["boundaryProvenance"] = json!("native-completion-and-exit");
                } else if current["pendingHandoff"].is_object() {
                    for (k, target) in [
                        ("provider", "owner"),
                        ("model", "model"),
                        ("effort", "effort"),
                    ] {
                        current[target] = current["pendingHandoff"][k].clone();
                    }
                    current["pendingHandoff"] = Value::Null;
                    current["status"] = json!("ready");
                } else if new.clone().any(|m| {
                    matches!(m["kind"].as_str(), Some("message" | "child-progress"))
                        && !progress::consumed(&current, m, &active)
                }) {
                    current["status"] = json!("ready");
                } else if active_children {
                    current["status"] = json!("waiting");
                } else {
                    current["status"] = json!(if new.clone().any(|m| m["kind"] == "child-result"
                        && !progress::consumed(&current, m, &active))
                    {
                        "ready"
                    } else {
                        "completed"
                    });
                }
                if bytes(&current["messages"]) > 192 * 1024 {
                    current["status"] = json!("failed");
                    current["error"] = json!(
                        "Task context capacity reached; output preserved but no further execution is allowed."
                    );
                }
            }
        }
        if matches!(
            current["pause"]["state"].as_str(),
            Some("requested" | "checkpoint")
        ) {
            current["pause"]["state"] = json!("not-paused");
            current["pause"]["reason"] = json!(if successful {
                "Worker completed without acknowledging the requested checkpoint."
            } else {
                "Native execution failed before a verified pause."
            });
        }
        let status = current["status"].clone();
        events::append(
            &mut current,
            json!({"generation":generation,"source":"broker","kind":"termination","status":status}),
        );
        active["boundary"] = json!(
            successful
                && (matches!(current["status"].as_str(), Some("waiting" | "paused"))
                    || current["owner"] != task["owner"])
        );
        active.as_object_mut().unwrap().remove("tokenHash");
        current["lastExecution"] = active;
        current["active"] = Value::Null;
        bump(&mut current);
        next["tasks"][&id] = current.clone();
        if terminal(&current["status"]) {
            deliver_parent(&mut next, &current);
        }
        self.commit(&mut s, next)?;
        Ok(())
    }
    async fn exit_proof(&self, s: &Value, t: &Value, inventory_attested: bool) -> Result<Value> {
        let id = t["id"].as_str().unwrap();
        let descendants = s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter(|child| ancestry_contains(s, child, id))
            .collect::<Vec<_>>();
        let running = self.running.lock().await;
        if descendants
            .iter()
            .any(|c| running.contains_key(c["id"].as_str().unwrap()))
        {
            bail!("An in-memory native worker is still active.");
        }
        drop(running);
        if descendants.iter().any(|c| {
            c["id"] != id
                && !matches!(
                    c["status"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                )
        }) {
            bail!("Resolve or finish descendant work first.");
        }
        let e = if t["active"].is_object() {
            &t["active"]
        } else {
            &t["lastExecution"]
        };
        let pid = e["pid"]
            .as_u64()
            .filter(|p| *p > 1 && *p <= i32::MAX as u64)
            .ok_or_else(|| {
                error(
                    "CLAUDEX_PROCESS_IDENTITY_UNAVAILABLE",
                    "Recorded native process identity is missing or ambiguous.",
                )
            })?;
        if e["generation"] != t["generation"]
            || e["processInventoryRequired"] == true && e.get("ownedProcesses").is_none()
            || e["processInventoryError"] == true && !inventory_attested
        {
            bail!(
                "Recorded native process inventory is incomplete; process absence cannot be established."
            );
        }
        let owned = if let Some(records) = e.get("ownedProcesses") {
            let records: Vec<processes::ProcessIdentity> = serde_json::from_value(records.clone())?;
            let proof = processes::inspect(&records).await?;
            if !proof["processes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["absent"] == true)
            {
                bail!("Recorded native descendants must all be confirmed absent.");
            }
            proof
        } else {
            Value::Null
        };
        let leader = unsafe { libc::kill(pid as i32, 0) };
        let leader_absent =
            leader == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        let group = unsafe { libc::kill(-(pid as i32), 0) };
        let group_absent =
            group == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if !leader_absent || !group_absent {
            bail!("Recorded native process and process group must both be confirmed absent.");
        }
        Ok(
            json!({"pid":pid,"processAbsent":true,"groupAbsent":true,"inspectedAt":now(),"ownedProcessInspection":owned}),
        )
    }
    pub async fn auto_resolve(&self) -> Result<usize> {
        let mut s = self.state.lock().await;
        let mut next = s.clone();
        let mut count = 0;
        loop {
            let mut uncertain = next["tasks"]
                .as_object()
                .unwrap()
                .values()
                .filter(|t| t["status"] == "uncertain")
                .cloned()
                .collect::<Vec<_>>();
            uncertain.sort_by_key(|t| std::cmp::Reverse(t["depth"].as_u64().unwrap_or(0)));
            let mut changed = false;
            for mut task in uncertain {
                let proof = match self.exit_proof(&next, &task, false).await {
                    Ok(proof) => proof,
                    Err(_) => continue,
                };
                task["resolution"] = json!({"outcome":"failed","automatic":true,"reason":"Every recorded native process was confirmed exited after an unknown outcome. Nothing was replayed.","previousStatus":task["status"],"previousError":task["error"],"previousRevision":task["revision"],"inspectedAt":proof["inspectedAt"],"pid":proof["pid"],"processAbsent":true,"groupAbsent":true,"resolvedAt":now(),"ownedProcessInspection":proof["ownedProcessInspection"]});
                if task["permission"] != "read-only" {
                    task["resolution"]["workspaceReviewRecommended"] = json!(true);
                    task["error"]=json!(format!("{} Its workspace may contain partial changes; review them before relying on it.",task["error"].as_str().unwrap_or("Native execution outcome was unknown.")).chars().take(2048).collect::<String>());
                }
                task["status"] = json!("failed");
                bump(&mut task);
                let id = task["id"].as_str().unwrap().to_owned();
                next["tasks"][&id] = task.clone();
                deliver_parent(&mut next, &task);
                count += 1;
                changed = true;
            }
            if !changed {
                break;
            }
        }
        self.commit(&mut s, next)?;
        Ok(count)
    }
    pub async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        self.suspend_renderer_manifest();
        self.stop_origin_rechecks();
        self.changed.notify_waiters();
        let notification_task = self.notification_task.lock().unwrap().take();
        if let Some(task) = notification_task {
            task.await?;
        }
        while self.pumping.load(Ordering::Acquire) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        for sender in self.running.lock().await.values() {
            let _ = sender.send(true);
        }
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.running.lock().await.is_empty() {
                break;
            }
            notified.await;
        }
        self.integration.close().await?;
        if let Some(error) = self.fatal.lock().unwrap().as_ref() {
            bail!("Collaboration broker stopped after a fatal error: {error}");
        }
        Ok(())
    }
    async fn artifact(&self, t: &Value, p: &Value) -> Result<Value> {
        crate::artifact::read(t, p).await
    }
    async fn chat(&self, e: &Envelope) -> Result<Value> {
        let p = &e.params;
        let method = e.method.as_str();
        if method == "native_wake" {
            let mut s = self.state.lock().await;
            let mut next = s.clone();
            if let Some(route) = p.get("route") {
                if !matches!(route.as_str(), Some("mod" | "mod-self" | "renderer")) {
                    bail!("Invalid native wake route.");
                }
                next["nativeWakeRoute"] = route.clone();
                self.commit(&mut s, next)?;
            }
            return Ok(json!({"route":s["nativeWakeRoute"].as_str().unwrap_or("mod-self")}));
        }
        if method == "chat_status" {
            let mut value = self
                .mailbox
                .status(text(&p["messageId"], "messageId", 128)?)?;
            value["deliveryObservation"] = self.mod_diagnosis(&value).await?;
            return Ok(value);
        }
        if method == "chat_list" {
            let mut chats = self.mailbox.list()?;
            if self.integration.supports("chat_titles") {
                chats = array(
                    &self
                        .integration
                        .dispatch("chat_titles", e.peer, json!({"chats":chats}))
                        .await?,
                );
            }
            if p.get("query").is_some()
                && p["provider"] != "claude"
                && self.integration.supports("native_chat_discovery")
            {
                let discovered = self
                    .integration
                    .dispatch("native_chat_discovery", e.peer, json!({"query":p["query"]}))
                    .await?;
                if discovered.get("nextCursor").is_some_and(|v| !v.is_null()) {
                    return Err(error(
                        "NATIVE_CHAT_DISCOVERY_INCOMPLETE",
                        "Use a longer, more specific native title query.",
                    ));
                }
                for c in array(discovered.get("chats").unwrap_or(&discovered)) {
                    if !chats.iter().any(|old| old["chatId"] == c["chatId"]) {
                        chats.push(c);
                    }
                }
            }
            let q = p["query"].as_str().map(|s| s.trim().to_lowercase());
            chats.retain(|c| p.get("provider").is_none_or(|v| v == &c["provider"]));
            for c in &mut chats {
                c["titleMatch"] = if let (Some(query), Some(title)) = (&q, c["title"].as_str()) {
                    if title.trim().to_lowercase() == *query {
                        json!("exact")
                    } else if title.to_lowercase().contains(query) {
                        json!("contains")
                    } else {
                        Value::Null
                    }
                } else {
                    Value::Null
                };
            }
            if q.is_some() {
                chats.retain(|c| {
                    c["titleError"].is_string()
                        || c["titleMatch"] == "exact"
                        || p["match"] != "exact" && c["titleMatch"] == "contains"
                });
                chats.sort_by_key(|c| !c["titleError"].is_null());
            }
            let limit = p["limit"].as_u64().unwrap_or(50);
            let start = p["cursor"].as_str().unwrap_or("0").parse::<usize>()?;
            if limit == 0 || limit > 100 {
                bail!("Invalid native chat page bounds.");
            }
            let page = chats
                .iter()
                .skip(start)
                .take(limit as usize)
                .cloned()
                .collect::<Vec<_>>();
            let next = start + page.len();
            return Ok(
                json!({"chats":page,"totalCount":chats.len(),"nextCursor":if next<chats.len(){Some(next.to_string())}else{None},"unavailableTitleCount":chats.iter().filter(|c|c["title"].is_null()||!c["titleError"].is_null()).count(),"exactMatchCount":if q.is_some(){json!(chats.iter().filter(|c|c["titleMatch"]=="exact").count())}else{Value::Null},"deliveryMode":"next-native-hook","idleWakeSupported":false,"wakeProviders":{"codex":self.integration.supports("native_chat_wake"),"claude":self.integration.supports("native_chat_wake")},"scope":if q.is_some(){"registered-and-native-metadata"}else{"hook-registered-native-chats"},"note":"Titles are metadata, not unique IDs. Confirm the exact candidate when duplicate or partial titles match; send by sessionId with expectedTitle."}),
            );
        }
        if method == "chat_send" {
            if self.closed.load(Ordering::Acquire) {
                bail!("Broker is stopping; new messages are refused.");
            }
            id(&p["requestId"])?;
            let mut provider = p["provider"].clone();
            let mut session = p["sessionId"].clone();
            let mut title = p["expectedTitle"].clone();
            if let Some(requested) = p["title"].as_str() {
                if p.get("sessionId").is_some() || p.get("expectedTitle").is_some() {
                    bail!("Use title or sessionId/expectedTitle, not both.");
                }
                let mut chats = self.mailbox.list()?;
                if self.integration.supports("chat_titles") {
                    chats = array(
                        &self
                            .integration
                            .dispatch("chat_titles", e.peer, json!({"chats":chats}))
                            .await?,
                    );
                }
                let candidates = chats
                    .into_iter()
                    .filter(|c| {
                        c["titleError"].is_null()
                            && c["archived"] != true
                            && c["title"].as_str().is_some_and(|s| {
                                s.trim().to_lowercase() == requested.trim().to_lowercase()
                            })
                            && (provider.is_null() || c["provider"] == provider)
                    })
                    .collect::<Vec<_>>();
                if candidates.len() != 1 {
                    return Ok(
                        json!({"status":if candidates.is_empty(){"not-found"}else{"needs-selection"},"queued":false,"candidates":candidates,"note":"Confirm the exact recipient; no message was queued."}),
                    );
                }
                provider = candidates[0]["provider"].clone();
                session = candidates[0]["sessionId"].clone();
                title = candidates[0]["title"].clone();
            }
            if !title.is_null() {
                if !self.integration.supports("chat_titles") {
                    bail!("Native chat title could not be verified; no message was queued.");
                }
                let exact = self
                    .mailbox
                    .list()?
                    .into_iter()
                    .filter(|c| c["provider"] == provider && c["sessionId"] == session)
                    .collect::<Vec<_>>();
                let titled = self
                    .integration
                    .dispatch("chat_titles", e.peer, json!({"chats":exact}))
                    .await?;
                let candidates = array(&titled);
                if candidates.len() != 1
                    || candidates[0]["title"] != title
                    || !candidates[0]["titleError"].is_null()
                    || candidates[0]["archived"] == true
                {
                    return Err(error(
                        "CLAUDEX_NOTIFICATION_TARGET_UNAVAILABLE",
                        "Native chat title changed or could not be verified; no message was queued.",
                    ));
                }
            }
            let wake = p["wake"] != false;
            let route = self.state.lock().await["nativeWakeRoute"]
                .as_str()
                .unwrap_or("mod-self")
                .to_string();
            let mut params = json!({"fromProvider":e.peer,"targetProvider":provider,"targetSessionId":session,"message":p["message"],"requestId":p["requestId"],"wakeRequested":wake});
            if let Some(ttl) = p.get("expiresInMs") {
                params["expiresInMs"] = ttl.clone();
            }
            if provider == "claude" && wake {
                params["wakeRoute"] = json!(route);
            }
            let mut receipt = self.mailbox.send(&params, None)?;
            self.changed.notify_waiters();
            receipt["wakeStatus"] = json!(if !wake {
                "disabled"
            } else if provider == "claude" && matches!(route.as_str(), "mod" | "mod-self") {
                "waiting-for-mod"
            } else {
                "unavailable"
            });
            if wake && provider == "claude" && route == "renderer" {
                self.refresh_renderer_manifest().await;
                receipt["wakeStatus"] =
                    json!(if self.renderer_manifest()["state"] == "published" {
                        "waiting-for-renderer"
                    } else {
                        "unavailable"
                    });
                receipt["rendererWakeManifest"] = self.renderer_manifest();
            }
            if wake
                && provider == "codex"
                && self.integration.supports("native_chat_wake")
                && receipt["state"] == "queued"
            {
                let prepared = self
                    .integration
                    .dispatch(
                        "native_chat_wake",
                        e.peer,
                        json!({"action":"prepare","provider":provider,"sessionId":session}),
                    )
                    .await?;
                if prepared["status"] == "ready" {
                    let claim = self.mailbox.claim_wake(
                        receipt["messageId"].as_str().unwrap(),
                        None,
                        None,
                    )?;
                    if !claim.is_null() {
                        let outcome=self.integration.dispatch("native_chat_wake",e.peer,json!({"action":"dispatch","provider":provider,"sessionId":session,"messageId":claim["messageId"],"context":claim["context"],"prepared":prepared})).await.unwrap_or(json!({"status":"uncertain"}));
                        let state = match outcome["status"].as_str() {
                            Some("accepted") => "accepted",
                            Some("busy" | "unavailable") => "deferred",
                            Some("rejected") => "rejected",
                            _ => "uncertain",
                        };
                        receipt=self.mailbox.finish_wake(claim["messageId"].as_str().unwrap(),claim["wake"]["claimId"].as_str().unwrap(),state,"Native owner outcome; hook acknowledgement and work completion are separate.")?;
                        receipt["wakeStatus"] = json!(state);
                    }
                }
            }
            receipt["deliveryMode"] = json!(if receipt["wake"]["state"] == "accepted" {
                "native-owner"
            } else {
                "next-native-hook"
            });
            receipt["idleWakeSupported"] = json!(if provider == "claude" {
                self.integration.supports("desktop_wake_verify")
            } else {
                self.integration.supports("native_chat_wake")
            });
            return Ok(receipt);
        }
        if method == "desktop_wake_claim" {
            if e.peer != Provider::Claude
                || !self.integration.supports("desktop_wake_verify")
                || self.notification_stopped()?
            {
                bail!("Native Desktop wake endpoint is unavailable.");
            }
            let current = self
                .mailbox
                .status(text(&p["messageId"], "messageId", 128)?)?;
            if current["targetSessionId"] != p["sessionId"]
                || current["targetProvider"] != "claude"
                || current["wakeRequested"] != true
                || matches!(current["wakeRoute"].as_str(), Some("mod" | "mod-self"))
            {
                bail!("Desktop wake identity mismatch.");
            }
            self.integration
                .dispatch(
                    "desktop_wake_verify",
                    e.peer,
                    json!({"sessionId":p["sessionId"]}),
                )
                .await?;
            if self.notification_stopped()? {
                bail!("Native Desktop wake is stopped.");
            }
            let claim = self.mailbox.claim_wake(
                text(&p["messageId"], "messageId", 128)?,
                Some("renderer"),
                None,
            )?;
            if claim.is_null() {
                return Ok(json!({"claimed":false}));
            }
            return Ok(
                json!({"claimed":true,"messageId":claim["messageId"],"claimId":claim["wake"]["claimId"],"context":claim["context"]}),
            );
        }
        if method == "desktop_wake_receipt" {
            if e.peer != Provider::Claude
                || !matches!(p["status"].as_str(), Some("accepted" | "uncertain"))
            {
                bail!("Invalid Desktop wake receipt.");
            }
            let current = self
                .mailbox
                .status(text(&p["messageId"], "messageId", 128)?)?;
            if current["targetSessionId"] != p["sessionId"]
                || current["targetProvider"] != "claude"
                || current["wakeRequested"] != true
                || matches!(current["wakeRoute"].as_str(), Some("mod" | "mod-self"))
            {
                bail!("Desktop wake identity mismatch.");
            }
            let result = self.mailbox.finish_wake(
                p["messageId"].as_str().unwrap(),
                text(&p["claimId"], "claimId", 128)?,
                p["status"].as_str().unwrap(),
                text(&p["detail"], "detail", 2048)?,
            )?;
            self.changed.notify_waiters();
            self.refresh_renderer_manifest().await;
            return Ok(result);
        }
        if self.integration.supports(method) {
            return self.integration.dispatch(method, e.peer, p.clone()).await;
        }
        bail!("Native wake integration is unavailable.")
    }
    async fn origin(self: &Arc<Self>, e: &Envelope, a: &Actor) -> Result<Value> {
        if a.task.is_some() || !self.integration.origin_available() {
            return Err(error(
                "CLAUDEX_ORIGIN_UNAVAILABLE",
                "Native origin verification is unavailable.",
            ));
        }
        let p = &e.params;
        if e.method == "origin_recheck" {
            if p.as_object()
                .unwrap()
                .keys()
                .any(|k| !["sessionId", "cwd", "event"].contains(&k.as_str()))
                || !matches!(
                    p["event"].as_str(),
                    Some("SessionStart" | "UserPromptSubmit" | "Stop")
                )
            {
                bail!("Invalid origin lifecycle hint.");
            }
            let s = self.state.lock().await;
            let mut matches = s["tasks"]
                .as_object()
                .unwrap()
                .values()
                .filter(|t| {
                    t["notification"]["origin"].is_null()
                        && t["notification"]["originHint"]["provider"] == e.peer.as_str()
                        && t["notification"]["originHint"]["sessionId"] == p["sessionId"]
                        && t["notification"]["originHint"]["cwd"] == p["cwd"]
                        && t["notification"]["originHint"]["attempts"]
                            .as_u64()
                            .unwrap_or(3)
                            < 3
                        && t["notification"]["challengeExpiresAt"]
                            .as_u64()
                            .unwrap_or(0)
                            > now()
                })
                .map(|t| (t["id"].clone(), t["notification"]["originHint"].clone()))
                .collect::<Vec<_>>();
            matches.sort_by_key(|(_, h)| h["lastAttemptAt"].as_u64().unwrap_or(0));
            matches.truncate(4);
            drop(s);
            let mut results = vec![];
            for (id, hint) in matches {
                let mut next = e.clone();
                next.method = "origin_bind".into();
                next.params = json!({"taskId":id,"sessionId":hint["sessionId"],"cwd":hint["cwd"],"toolUseId":hint["toolUseId"]});
                if let Some(turn) = hint.get("turnId") {
                    next.params["turnId"] = turn.clone();
                }
                results.push(
                    Box::pin(self.origin(&next, a)).await.unwrap_or(
                        json!({"taskId":id,"bound":false,"reason":"native-proof-refused"}),
                    ),
                );
            }
            return Ok(json!({"checked":results.len(),"results":results}));
        }
        let id = text(&p["taskId"], "taskId", 36)?;
        if p.as_object()
            .unwrap()
            .keys()
            .any(|k| !["taskId", "sessionId", "cwd", "toolUseId", "turnId"].contains(&k.as_str()))
        {
            bail!("Invalid origin binding fields.");
        }
        uuid::Uuid::parse_str(id)?;
        uuid::Uuid::parse_str(text(&p["sessionId"], "sessionId", 36)?)?;
        if !Path::new(text(&p["cwd"], "cwd", 4096)?).is_absolute()
            || p["cwd"].as_str().unwrap().contains(['\r', '\n'])
        {
            bail!("Origin binding requires exact native identity hints.");
        }
        text(&p["toolUseId"], "toolUseId", 256)?;
        let mut requested = json!({"provider":e.peer,"sessionId":p["sessionId"],"cwd":p["cwd"],"toolUseId":p["toolUseId"]});
        if let Some(t) = p.get("turnId") {
            requested["turnId"] = t.clone();
        }
        let (sender, receiver) = watch::channel(None);
        let existing = {
            let mut flights = self.origin_flights.lock().unwrap();
            if let Some(active) = flights.get(id) {
                if !same_origin(&active.requested, &requested) {
                    return Err(error(
                        "CLAUDEX_ORIGIN_CONFLICT",
                        "Another exact origin is being verified.",
                    ));
                }
                Some(active.receiver.clone())
            } else {
                flights.insert(
                    id.to_owned(),
                    OriginCheck {
                        requested: requested.clone(),
                        receiver,
                    },
                );
                None
            }
        };
        if let Some(mut receiver) = existing {
            loop {
                let reply = receiver.borrow().clone();
                if let Some(reply) = reply {
                    return if reply["ok"] == true {
                        Ok(reply["value"].clone())
                    } else {
                        Err(error(
                            reply["error"]["code"]
                                .as_str()
                                .unwrap_or("CLAUDEX_ORIGIN_REFUSED"),
                            reply["error"]["message"]
                                .as_str()
                                .unwrap_or("Native origin verification failed."),
                        ))
                    };
                }
                if receiver.changed().await.is_err() {
                    return Err(error(
                        "CLAUDEX_ORIGIN_EXPIRED",
                        "Native origin verification was interrupted.",
                    ));
                }
            }
        }
        let flight = OriginFlight {
            flights: self.origin_flights.clone(),
            id: id.to_owned(),
            sender,
        };
        if let Some(timer) = self.origin_timers.lock().unwrap().remove(id) {
            timer.abort();
        }
        let epoch = self.origin_epoch.load(Ordering::Acquire);
        let result = self.origin_one(e, requested, epoch).await;
        flight.sender.send_replace(Some(match &result {
            Ok(v) => json!({"ok":true,"value":v}),
            Err(e) => json!({"ok":false,"error":wire_error(e)}),
        }));
        result
    }
    async fn origin_one(
        self: &Arc<Self>,
        e: &Envelope,
        requested: Value,
        epoch: u64,
    ) -> Result<Value> {
        let id = e.params["taskId"].as_str().unwrap();
        let mut s = self.state.lock().await;
        let t = &s["tasks"][id];
        let n = &t["notification"];
        if !t["parentId"].is_null() || t["returnTo"] != e.peer.as_str() || !n.is_object() {
            return Err(error(
                "CLAUDEX_ORIGIN_UNAVAILABLE",
                "This task has no eligible native origin notification request.",
            ));
        }
        if n["origin"].is_object() {
            if !same_origin(&n["origin"], &requested) {
                return Err(error(
                    "CLAUDEX_ORIGIN_CONFLICT",
                    "The task already has a different verified origin.",
                ));
            }
            return Ok(json!({"bound":true,"origin":n["origin"],"replayed":true}));
        }
        if n["originHint"].is_object() && !same_origin(&n["originHint"], &requested) {
            return Err(error(
                "CLAUDEX_ORIGIN_CONFLICT",
                "The task already retains a different exact origin hint.",
            ));
        }
        if n["challengeExpiresAt"].as_u64().unwrap_or(0) <= now() || self.notification_stopped()? {
            return Err(error(
                "CLAUDEX_ORIGIN_EXPIRED",
                "Origin verification expired or broker stopped.",
            ));
        }
        let attempt = n["originHint"]["attempts"].as_u64().unwrap_or(0) + 1;
        if attempt > 3 {
            return Ok(json!({"bound":false,"reason":"native-proof-attempts-exhausted"}));
        }
        let challenge = n["challenge"].clone();
        let receipt = s["requests"][n["requestKey"].as_str().unwrap_or("")].clone();
        let mut verify = requested.clone();
        verify["expectedFingerprint"] = receipt["fingerprint"].clone();
        verify["expectedReceipt"] = receipt["result"].clone();
        let mut next = s.clone();
        let mut hint = requested.clone();
        hint["attempts"] = json!(attempt);
        hint["lastAttemptAt"] = json!(now());
        hint["error"] = json!("ORIGIN_PROOF_UNAVAILABLE");
        next["tasks"][id]["notification"]["originHint"] = hint;
        self.commit(&mut s, next)?;
        drop(s);
        let proof = self.integration.origin_verify(&verify).await;
        let mut s = self.state.lock().await;
        let n = &s["tasks"][id]["notification"];
        if n["challenge"] != challenge
            || n["challengeExpiresAt"].as_u64().unwrap_or(0) <= now()
            || self.notification_stopped()?
            || self.origin_epoch.load(Ordering::Acquire) != epoch
        {
            return Err(error(
                "CLAUDEX_ORIGIN_EXPIRED",
                "Origin verification no longer applies.",
            ));
        }
        match proof {
            Ok(proof) => {
                if !same_origin(&proof, &requested)
                    || proof["source"].as_str().is_none_or(|s| s.len() > 100)
                    || !proof["verifiedAt"].is_u64()
                {
                    let mut next = s.clone();
                    next["tasks"][id]["notification"]["originHint"]["attempts"] = json!(3);
                    next["tasks"][id]["notification"]["originHint"]["error"] =
                        json!("ORIGIN_PROOF_INVALID");
                    self.commit(&mut s, next)?;
                    return Err(error(
                        "ORIGIN_PROOF_INVALID",
                        "Native proof did not match the requested origin.",
                    ));
                }
                let mut origin = requested;
                origin["source"] = proof["source"].clone();
                origin["verifiedAt"] = proof["verifiedAt"].clone();
                let mut next = s.clone();
                next["tasks"][id]["notification"]["origin"] = origin.clone();
                next["tasks"][id]["notification"]
                    .as_object_mut()
                    .unwrap()
                    .remove("originHint");
                self.commit(&mut s, next)?;
                drop(s);
                self.schedule();
                Ok(json!({"bound":true,"origin":origin}))
            }
            Err(err) => {
                let missing = err
                    .downcast_ref::<ProtocolError>()
                    .is_some_and(|e| e.code == "ORIGIN_PROOF_UNAVAILABLE");
                if !missing {
                    let mut next = s.clone();
                    next["tasks"][id]["notification"]["originHint"]["attempts"] = json!(3);
                    next["tasks"][id]["notification"]["originHint"]["error"] = json!(
                        err.downcast_ref::<ProtocolError>()
                            .map(|e| e.code.as_str())
                            .filter(|s| matches!(
                                *s,
                                "ORIGIN_PROOF_INVALID" | "ORIGIN_PROOF_BOUND_EXCEEDED"
                            ))
                            .unwrap_or("ORIGIN_PROOF_UNAVAILABLE")
                    );
                    self.commit(&mut s, next)?;
                    return Err(err);
                }
                if attempt < 3 {
                    self.arm_origin_recheck(
                        e.clone(),
                        attempt,
                        s["tasks"][id]["notification"]["challengeExpiresAt"]
                            .as_u64()
                            .unwrap_or(0),
                    );
                }
                Ok(json!({"bound":false,"reason":"awaiting-native-evidence","attempts":attempt}))
            }
        }
    }
    fn arm_origin_recheck(self: &Arc<Self>, envelope: Envelope, attempt: u64, expires_at: u64) {
        let delay = if attempt == 1 { 1000 } else { 3000 };
        if now().saturating_add(delay) >= expires_at || self.notification_stopped().unwrap_or(true)
        {
            return;
        }
        let b = Arc::downgrade(self);
        let epoch = self.origin_epoch.load(Ordering::Acquire);
        let id = envelope.params["taskId"].as_str().unwrap_or("").to_owned();
        let timer_id = id.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            if let Some(b) = b.upgrade() {
                if !b.notification_stopped().unwrap_or(true)
                    && b.origin_epoch.load(Ordering::Acquire) == epoch
                {
                    let s = b.state.lock().await;
                    let n = &s["tasks"][&timer_id]["notification"];
                    if n["origin"].is_object()
                        || n["originHint"]["attempts"] != attempt
                        || n["challengeExpiresAt"].as_u64().unwrap_or(0) <= now()
                    {
                        return;
                    }
                    drop(s);
                    b.origin_timers.lock().unwrap().remove(&timer_id);
                    let actor = Actor {
                        peer: envelope.peer,
                        task: None,
                        key: format!("controller:{}", envelope.peer),
                    };
                    let _ = b.origin_boxed(envelope, actor).await;
                }
            }
        });
        if let Some(old) = self
            .origin_timers
            .lock()
            .unwrap()
            .insert(id, task.abort_handle())
        {
            old.abort();
        }
    }
    pub(crate) fn stop_origin_rechecks(&self) {
        self.origin_epoch.fetch_add(1, Ordering::AcqRel);
        for (_, timer) in std::mem::take(&mut *self.origin_timers.lock().unwrap()) {
            timer.abort();
        }
    }
    fn origin_boxed(
        self: Arc<Self>,
        e: Envelope,
        a: Actor,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>> {
        Box::pin(async move { self.origin(&e, &a).await })
    }
    fn notification_presentation(&self, t: &Value) -> Result<Value> {
        let n = &t["notification"];
        if n.is_null() {
            return Ok(json!({"mode":"off"}));
        }
        let mut missed = 0;
        let mut acknowledged = false;
        let mut deliveries = vec![];
        for d in array(&n["deliveries"]) {
            let mut value = d.clone();
            if let Some(message) = d["messageId"].as_str() {
                let receipt = self.mailbox.status(message)?;
                value["dispatchState"] = d["state"].clone();
                value["state"] = receipt["state"].clone();
                value["deliveryStatus"] = receipt["deliveryStatus"].clone();
                value["wakeState"] = receipt["wake"]["state"].clone();
                if d["kind"].as_str().unwrap_or("terminal") == "terminal"
                    && d["revision"] == t["revision"]
                    && receipt["state"] == "acknowledged"
                {
                    acknowledged = true;
                }
            }
            if matches!(value["state"].as_str(), Some("expired" | "failed-not-sent")) {
                missed += 1;
            }
            deliveries.push(value);
        }
        let pending=crate::notifications::target(t).and_then(|target|{
            let expires=target["at"].as_u64().unwrap_or(0)+n["policy"]["expiresInMs"].as_u64().unwrap_or(0);
            if expires<=now(){missed+=1;Some(json!({"kind":target["kind"],"revision":target["revision"],"state":"expired","reason":"expired-before-publication","expiresAt":expires}))}
            else if ["kind","revision","generation","blockerId","blockerRevision"].iter().all(|k|n["pending"][*k]==target[*k]){Some(n["pending"].clone())}else{None}
        }).unwrap_or(Value::Null);
        Ok(
            json!({"mode":n["policy"]["mode"],"expiresInMs":n["policy"]["expiresInMs"],"expiryStartsAt":"terminal-or-blocker-transition","unreadResult":terminal(&t["status"])&&t["resultReview"]["generation"]!=t["generation"]&&!acknowledged,"bindingStatus":if n["origin"].is_object(){"verified"}else if n["challengeExpiresAt"].as_u64().unwrap_or(0)<=now(){"expired"}else{"awaiting-native-proof"},"origin":n["origin"],"deliveries":deliveries,"pending":pending,"missed":missed,"pendingVerification":if n["originHint"].is_object(){json!({"attempts":n["originHint"]["attempts"],"lastAttemptAt":n["originHint"]["lastAttemptAt"],"error":n["originHint"]["error"]})}else{Value::Null},"suppressedRevision":n["suppressedRevision"],"suppressedBlockers":n.get("suppressedBlockers").cloned().unwrap_or(json!({})),"suppressionReason":n["suppressionReason"]}),
        )
    }
    async fn continuation(&self, t: &Value) -> Result<Value> {
        let result = |action: &str, reason: &str| json!({"nextAction":action,"reason":reason,"evidence":null,"checkedAt":now(),"diagnosticOnly":true,"deliveryGuaranteed":false});
        if terminal(&t["status"]) {
            return Ok(result("read-result", "task-terminal"));
        }
        if array(&t["blockers"])
            .iter()
            .any(|b| b["state"] == "open" && b["generation"] == t["generation"])
        {
            return Ok(result("read-result", "open-blocker"));
        }
        let n = &t["notification"];
        if n.is_null() || n["policy"]["mode"] == "off" {
            return Ok(result("wait", "notifications-off"));
        }
        if n["policy"]["mode"] != "wake" {
            return Ok(result("wait", "queue-does-not-wake"));
        }
        if n["origin"].is_null() {
            if n["challengeExpiresAt"].as_u64().unwrap_or(0) <= now() {
                return Ok(result("wait", "origin-expired"));
            }
            if n["originHint"]["attempts"].as_u64().unwrap_or(0) >= 3
                && !self
                    .origin_flights
                    .lock()
                    .unwrap()
                    .contains_key(t["id"].as_str().unwrap_or(""))
            {
                return Ok(result("wait", "native-proof-attempts-exhausted"));
            }
            let mut v = result("wait", "awaiting-native-proof");
            v["retryAfterMs"] = json!(2000);
            return Ok(v);
        }
        let route = {
            let s = self.state.lock().await;
            if let Some(limit) = crate::notifications::quota(&s, n, now(), "terminal") {
                return Ok(result("wait", limit["reason"].as_str().unwrap()));
            }
            if n["origin"]["provider"] == "claude" {
                s["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    .to_owned()
            } else {
                "native-owner".into()
            }
        };
        if self.notification_stopped()? {
            return Ok(result("wait", "app-stopped"));
        }
        let chat = self.mailbox.list()?.into_iter().find(|c| {
            c["provider"] == n["origin"]["provider"]
                && c["sessionId"] == n["origin"]["sessionId"]
                && c["cwd"] == n["origin"]["cwd"]
        });
        let Some(chat) = chat else {
            return Ok(result(
                "wait",
                if self.mailbox.diagnostics()?["chatCapacityExhausted"] == true {
                    "mailbox-capacity-exhausted"
                } else {
                    "origin-not-registered"
                },
            ));
        };
        if chat["phase"] == "ended" {
            return Ok(result("wait", "waiting-for-resume"));
        }
        let observation = if n["origin"]["provider"] == "codex" {
            if self.integration.supports("notification_preflight") {
                self.integration
                    .dispatch(
                        "notification_preflight",
                        Provider::Codex,
                        json!({"origin":n["origin"],"route":route}),
                    )
                    .await
                    .unwrap_or(result("wait", "native-owner-unavailable"))
            } else {
                result("wait", "wake-probe-unavailable")
            }
        } else if matches!(route.as_str(), "mod" | "mod-self") {
            let diagnosis=self.mod_diagnosis(&json!({"targetProvider":"claude","targetSessionId":n["origin"]["sessionId"],"wakeRoute":route,"state":"queued"})).await?;
            let reason = diagnosis["reason"]
                .as_str()
                .unwrap_or("receiver-unavailable");
            let mut v = result(
                if matches!(
                    reason,
                    "receiver-observed" | "receiver-observed-native-default" | "sender-observed"
                ) {
                    "await-notification"
                } else {
                    "wait"
                },
                reason,
            );
            if v["nextAction"] == "await-notification" {
                v["evidence"] = json!("mod-self-reported");
            }
            for k in ["detail", "missingEvidence", "missingProof", "nextStep"] {
                if let Some(x) = diagnosis.get(k) {
                    v[k] = x.clone();
                }
            }
            v
        } else {
            result("wait", "renderer-readiness-unverified")
        };
        if self.notification_stopped()? {
            return Ok(result("wait", "app-stopped"));
        }
        let latest = self.mailbox.list()?.into_iter().find(|c| {
            c["provider"] == n["origin"]["provider"]
                && c["sessionId"] == n["origin"]["sessionId"]
                && c["cwd"] == n["origin"]["cwd"]
        });
        if latest.is_none_or(|c| c["phase"] == "ended") {
            return Ok(result("wait", "waiting-for-resume"));
        }
        let s = self.state.lock().await;
        let current = &s["tasks"][t["id"].as_str().unwrap()];
        if terminal(&current["status"]) {
            return Ok(result("read-result", "task-terminal"));
        }
        if current.is_null()
            || current["revision"] != t["revision"]
            || !same_origin(&current["notification"]["origin"], &n["origin"])
            || n["origin"]["provider"] == "claude"
                && s["nativeWakeRoute"].as_str().unwrap_or("mod-self") != route
        {
            return Ok(result("wait", "task-or-route-changed"));
        }
        if let Some(limit) =
            crate::notifications::quota(&s, &current["notification"], now(), "terminal")
        {
            return Ok(result("wait", limit["reason"].as_str().unwrap()));
        }
        if self.notification_stopped()? {
            return Ok(result("wait", "app-stopped"));
        }
        Ok(observation)
    }
}
fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn token_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn same_origin(a: &Value, b: &Value) -> bool {
    ["provider", "sessionId", "cwd", "toolUseId", "turnId"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
fn notification_policy(v: Option<&Value>, default_wake: bool) -> Result<Value> {
    let v = v
        .cloned()
        .unwrap_or(json!({"mode":if default_wake{"wake"}else{"off"}}));
    if !v.is_object()
        || v.as_object()
            .unwrap()
            .keys()
            .any(|k| !["mode", "expiresInMs"].contains(&k.as_str()))
        || !matches!(v["mode"].as_str(), Some("off" | "queue" | "wake"))
        || v.get("expiresInMs").is_some_and(|v| !v.is_u64())
    {
        bail!("Invalid notification policy.");
    }
    let expires = v["expiresInMs"].as_u64().unwrap_or(3600000);
    if !(1000..=3600000).contains(&expires) {
        bail!("Notification expiry must be 1 second to 1 hour.");
    }
    Ok(json!({"mode":v["mode"],"expiresInMs":expires}))
}
fn children_active(s: &Value, id: &str) -> bool {
    s["tasks"]
        .as_object()
        .unwrap()
        .values()
        .any(|t| t["parentId"] == id && !terminal(&t["status"]))
}
fn ancestry_contains(s: &Value, t: &Value, id: &str) -> bool {
    let mut cursor = t;
    let mut seen = BTreeSet::new();
    loop {
        if cursor["id"] == id {
            return true;
        }
        let Some(p) = cursor["parentId"].as_str() else {
            return false;
        };
        if !seen.insert(p) {
            return false;
        }
        cursor = &s["tasks"][p];
    }
}
fn uncertain_blockers(s: &Value, candidate: &Value) -> Vec<String> {
    let root = |t: &Value| {
        let mut cursor = t.clone();
        let mut seen = BTreeSet::new();
        while let Some(p) = cursor["parentId"].as_str() {
            if !seen.insert(p.to_string()) || s["tasks"].get(p).is_none() {
                break;
            }
            cursor = s["tasks"][p].clone();
        }
        cursor["id"].as_str().unwrap_or("").to_string()
    };
    let target = root(candidate);
    s["tasks"]
        .as_object()
        .unwrap()
        .values()
        .filter(|t| {
            t["status"] == "uncertain"
                && (root(t) == target
                    || t["permission"] != "read-only" && workspace::conflicts(t, candidate))
        })
        .filter_map(|t| t["id"].as_str().map(str::to_owned))
        .collect()
}
fn wait_reason(t: &Value, s: &Value, running: &[String], closed: bool, max: usize) -> Value {
    let ids = if t["status"] == "running" && t["cancelRequested"] == true {
        return json!({"kind":"cancelling","taskIds":[]});
    } else if t["status"] == "paused"
        || matches!(
            t["pause"]["state"].as_str(),
            Some("requested" | "checkpoint")
        )
    {
        return json!({"kind":if t["status"]=="paused"{"paused"}else{"pause-checkpoint"},"taskIds":[]});
    } else if t["pendingHandoff"].is_object() {
        return json!({"kind":"handoff","taskIds":[]});
    } else if t["status"] == "waiting" {
        s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter(|c| c["parentId"] == t["id"] && !terminal(&c["status"]))
            .filter_map(|c| c["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    } else if t["status"] != "ready" {
        return Value::Null;
    } else {
        let blockers = uncertain_blockers(s, t);
        if !blockers.is_empty() {
            return json!({"kind":"uncertain-overlap","taskIds":blockers.iter().take(64).collect::<Vec<_>>(),"totalTaskCount":blockers.len(),"truncated":blockers.len()>64});
        }
        if closed {
            return json!({"kind":"broker-stopping","taskIds":[]});
        }
        if running.len() >= max {
            return json!({"kind":"capacity","taskIds":running});
        }
        return json!({"kind":"queued","taskIds":[]});
    };
    json!({"kind":"children","taskIds":ids.iter().take(64).collect::<Vec<_>>(),"totalTaskCount":ids.len(),"truncated":ids.len()>64})
}
fn presentation(t: &Value) -> Value {
    let cancel = t["status"] == "running" && t["cancelRequested"] == true;
    let final_result = t["status"] == "completed"
        && t["result"].is_object()
        && t["result"]["generation"] == t["generation"];
    let phase = if terminal(&t["status"]) {
        t["status"].clone()
    } else if cancel {
        json!("cancelling")
    } else if matches!(
        t["pause"]["state"].as_str(),
        Some("requested" | "checkpoint")
    ) {
        json!("pause-pending")
    } else if t["pendingHandoff"].is_object() {
        json!("handoff-pending")
    } else if t["status"] == "waiting" {
        json!("waiting-for-children")
    } else if t["status"] == "ready" {
        json!("queued")
    } else {
        t["status"].clone()
    };
    json!({"phase":phase,"terminal":terminal(&t["status"]),"cancelPending":cancel,"resultFinal":final_result,"resultRole":if t["result"].is_null(){"none"}else if final_result{"final"}else if t["status"]=="cancelled"{"cancelled"}else if t["result"]["generation"]==t["generation"]&&(matches!(t["status"].as_str(),Some("waiting"|"paused"))||t["status"]=="ready"&&(t["lastExecution"]["boundary"]==true||t["owner"]!=t["result"]["provider"])){"boundary"}else{"superseded"},"resultGeneration":t["result"]["generation"]})
}
fn deliver_parent(s: &mut Value, t: &Value) {
    let Some(parent) = t["parentId"].as_str() else {
        return;
    };
    let Some(p) = s["tasks"].get(parent) else {
        return;
    };
    if terminal(&p["status"]) {
        return;
    }
    let mut p = p.clone();
    push(
        &mut p["messages"],
        json!({"from":t["id"],"kind":"child-result","sourceRevision":t["revision"],"text":json!({"taskId":t["id"],"status":t["status"],"provider":t["owner"],"result":t["result"]["text"],"error":t["error"],"outcome":outcome::presentation(t)}).to_string(),"at":now()}),
    );
    bump(&mut p);
    if bytes(&p["messages"]) > 192 * 1024 {
        p["error"] = json!(
            "Child results exceed task context capacity. Inspect results explicitly; no further execution is allowed."
        );
        if p["status"] != "running" {
            p["status"] = json!("failed");
        }
    } else if p["status"] == "waiting" && !children_active(s, parent) {
        p["status"] = json!("ready");
    }
    s["tasks"][parent] = p;
}
fn deliver_progress(s: &mut Value, t: &Value, progress: &Value) -> Result<()> {
    let Some(parent) = t["parentId"].as_str() else {
        return Ok(());
    };
    let Some(p) = s["tasks"].get(parent) else {
        return Ok(());
    };
    if terminal(&p["status"]) {
        return Ok(());
    }
    let mut p = p.clone();
    bump(&mut p);
    if !(progress["blockerChanged"] == true && t["observability"]["blockerNotifications"] == true)
        && t["observability"]["reports"] != "milestones"
    {
        s["tasks"][parent] = p;
        return Ok(());
    }
    push(
        &mut p["messages"],
        json!({"kind":"child-progress","from":t["id"],"sourceRevision":t["revision"].as_u64().unwrap_or(0)+1,"progressId":progress["reportId"],"at":now(),"text":json!({"taskId":t["id"],"generation":t["generation"],"reportId":progress["reportId"],"blockerId":progress["blockerId"],"nextAction":"read-child-status","provenance":"worker-self-reported"}).to_string()}),
    );
    if bytes(&p["messages"]) > 192 * 1024 {
        bail!("Parent context capacity reached; blocker report was not committed.");
    }
    if p["status"] == "waiting" {
        p["status"] = json!("ready");
    }
    s["tasks"][parent] = p;
    Ok(())
}
fn cancel_tree(s: &mut Value, id: &str) {
    let mut t = s["tasks"][id].clone();
    if terminal(&t["status"]) || t["cancelRequested"] == true {
        return;
    }
    t["cancelRequested"] = json!(true);
    t["pendingHandoff"] = Value::Null;
    if t["pause"].is_object() {
        t["pause"]["state"] = json!("cancelled");
    }
    if matches!(t["status"].as_str(), Some("ready" | "waiting" | "paused")) {
        t["status"] = json!("cancelled");
    }
    bump(&mut t);
    s["tasks"][id] = t.clone();
    let children = s["tasks"]
        .as_object()
        .unwrap()
        .values()
        .filter(|c| c["parentId"] == id)
        .filter_map(|c| c["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    for child in children {
        cancel_tree(s, &child);
    }
    if t["status"] == "cancelled" {
        deliver_parent(s, &t);
    }
}
fn record_usage(t: &mut Value, active: &mut Value, p: &Value, usage: Value) {
    if !usage.is_object()
        || [
            "inputTokens",
            "cacheReadInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
        ]
        .iter()
        .any(|k| !usage[*k].is_u64())
    {
        return;
    }
    active["usage"] = usage.clone();
    let provider = p.as_str().unwrap();
    if !t["usageTotals"].is_object() {
        t["usageTotals"] = json!({});
    }
    if !t["usageTotals"][provider].is_object() {
        t["usageTotals"][provider] = json!({"invocations":0});
    }
    let total = &mut t["usageTotals"][provider];
    total["invocations"] = json!(total["invocations"].as_u64().unwrap_or(0) + 1);
    for (k, v) in usage.as_object().unwrap() {
        if k == "reportedCostUsd" {
            if let Some(x) = v.as_f64().filter(|x| x.is_finite() && *x >= 0.0) {
                total[k] = json!(total[k].as_f64().unwrap_or(0.0) + x);
            }
        } else if let Some(x) = v.as_u64() {
            if let Some(sum) = total[k]
                .as_u64()
                .unwrap_or(0)
                .checked_add(x)
                .filter(|x| *x <= 9_007_199_254_740_991)
            {
                total[k] = json!(sum);
            }
        }
    }
}

fn observe_native(t: &mut Value, p: &str, e: &Value) {
    t["active"]["activity"] = crate::activity::observe(&t["active"]["activity"], p, e);
    let generation = t["generation"].clone();
    if e["parent_tool_use_id"].is_null() && e["isSidechain"] != true && e["is_sidechain"] != true {
        if p == "codex" {
            let item = &e["item"];
            if e["type"] == "item.completed" && item["type"] == "agent_message" {
                events::append(
                    t,
                    json!({"generation":generation,"source":"native:codex","kind":"assistant-message","nativeId":item["id"],"text":item["text"],"granularity":"message"}),
                );
            }
            let kind = match item["type"].as_str() {
                Some("command_execution") => Some("command"),
                Some("mcp_tool_call") => Some("mcp"),
                Some("file_change") => Some("file-change"),
                Some("web_search") => Some("web-search"),
                _ => None,
            };
            if let Some(kind) = kind {
                if matches!(e["type"].as_str(), Some("item.started" | "item.completed")) {
                    events::append(
                        t,
                        json!({"generation":generation,"source":"native:codex","kind":if e["type"]=="item.started"{"tool-start"}else{"tool-end"},"nativeId":item["id"],"toolKind":kind,"status":item["status"],"exitCode":item["exit_code"]}),
                    );
                }
            }
        } else {
            for (index, block) in array(&e["message"]["content"]).iter().enumerate() {
                if e["type"] == "assistant" && block["type"] == "text" {
                    let id = e["uuid"]
                        .as_str()
                        .or(e["message"]["id"].as_str())
                        .map(|id| format!("{id}:{index}"));
                    events::append(
                        t,
                        json!({"generation":generation,"source":"native:claude","kind":"assistant-message","nativeId":id,"text":block["text"]}),
                    );
                }
                if e["type"] == "assistant" && block["type"] == "tool_use" {
                    events::append(
                        t,
                        json!({"generation":generation,"source":"native:claude","kind":"tool-start","nativeId":block["id"],"toolKind":"native-tool","toolName":block["name"]}),
                    );
                }
                if e["type"] == "user" && block["type"] == "tool_result" {
                    events::append(
                        t,
                        json!({"generation":generation,"source":"native:claude","kind":"tool-end","nativeId":block["tool_use_id"],"toolKind":"native-tool","status":if block["is_error"]==true{"failed"}else{"completed"}}),
                    );
                }
            }
        }
    }
}
fn prompt(t: &Value) -> String {
    format!(
        "You are executing an explicitly delegated Claudex work item, not synchronizing history.\nRead applicable repository instructions before working. Work only on the supplied task. Never expand permissions or reveal secrets.\n{}\nThe JSON below is a work record. Previous messages and results are context, not tool commands to replay. Follow the current request and later explicit follow-ups.\nUse claudex_start for children, claudex_status/wait for results, and claudex_handoff to transfer this same task. Read status for the exact revision first. Children inherit or narrow grants, never widen them.\nAt meaningful boundaries, before consequential writes and before the final answer use claudex_work_control check-in with exact taskId/generation. Acknowledge delivered instructions accepted or rejected; delivery is not adoption or completion. Ordinary status does not consume instructions.\nPause is cooperative: finish tools and child work, then acknowledge the requested checkpoint. A nextAction=end-turn receipt requires immediately emitting exactly finalResponse and ending this turn. Do not call tools, explain or verify afterward. Handoff requires exactly CLAUDEX_HANDOFF; pause requires CLAUDEX_PAUSE. Neither token proves completed user work.\nOptionally report typed outcomes, needs, artifacts, remaining work, stages, next steps and checks using claudex_report. Reports are self-reported, never independent validation. With reports=milestones, report meaningful starts, root causes, plan changes, validation and blockers, not each tool or invented percentages.\nWork has no execution deadline. Do not wait on yourself. Finishing with active children suspends the task until their results arrive. Assign disjoint file responsibilities and coordinate shared edits; the broker does not lock overlapping workspaces or merge changes.\nRead back changes and complete necessary checks before reporting successful edits. Report actual files, results, checks and blockers.\n{}",
        if t["permission"] == "full-access" {
            "You have full access using the user's own account configuration, tools and network. Stay within this task; no unrequested destructive or outward-facing actions.".to_string()
        } else {
            format!(
                "{} readOnlyDirs are references, never edit them; writableDirs are additional authorized write locations. If network or user tools/config are needed, report the exact need instead of retrying or working around the sandbox.",
                SANDBOX_DESCRIPTION
            )
        },
        json!({"protocol":"claudex-work-v1","taskId":t["id"],"parentId":t["parentId"],"revision":t["revision"],"owner":t["owner"],"permission":t["permission"],"cwd":t["cwd"],"workspace":{"projectRoot":t.get("projectRoot").unwrap_or(&t["cwd"]),"readOnlyDirs":array(&t["readOnlyDirs"]),"writableDirs":array(&t["writableDirs"])},"execution":{"generation":t["generation"],"inputs":t["active"]["inputs"]},"observability":t["observability"],"instructions":array(&t["instructions"]),"pause":t["pause"],"blockers":array(&t["blockers"]),"messages":t["messages"]})
    )
}
fn validate_state(s: &Value) -> Result<()> {
    if s["version"] != 1 || !s["tasks"].is_object() || !s["requests"].is_object() {
        bail!("Unsupported collaboration ledger.");
    }
    if let Some(a) = s.get("archive") {
        if a.as_object().is_none_or(|o| o.len() != 2)
            || !a["tasks"].is_u64()
            || !a["requests"].is_u64()
        {
            bail!("Malformed work archive inventory was preserved.");
        }
    }
    for key in ["defaultModels", "defaultEfforts"] {
        if let Some(v) = s.get(key) {
            if v.as_object().is_none_or(|o| o.len() != 2)
                || v.get("codex").is_none()
                || v.get("claude").is_none()
            {
                bail!("Malformed provider defaults.");
            }
            for provider in [Provider::Codex, Provider::Claude] {
                if key == "defaultModels" {
                    model(&v[provider.as_str()])?;
                } else {
                    provider.validate_effort(&v[provider.as_str()])?;
                }
            }
        }
    }
    crate::warm::validate_settings(s)?;
    if let Some(v) = s.get("nativeWakeRoute") {
        if !matches!(v.as_str(), Some("mod" | "mod-self" | "renderer")) {
            bail!("Malformed Claude native wake route.");
        }
    }
    if let Some(v) = s.get("defaultPermission") {
        Permission::parse(v.as_str().unwrap_or(""))?;
    }
    for (key, r) in s["requests"].as_object().unwrap() {
        if !token_valid(key)
            || !r["result"].is_object()
            || !r["fingerprint"].as_str().is_some_and(token_valid)
        {
            bail!("Malformed collaboration request receipt.");
        }
    }
    for (id, t) in s["tasks"].as_object().unwrap() {
        if t["id"] != id.as_str()
            || uuid::Uuid::parse_str(id).is_err()
            || !matches!(
                t["status"].as_str(),
                Some(
                    "ready"
                        | "running"
                        | "waiting"
                        | "paused"
                        | "completed"
                        | "failed"
                        | "cancelled"
                        | "uncertain"
                )
            )
            || !t["messages"].is_array()
            || t["revision"].as_u64().is_none_or(|r| r == 0)
            || !t["generation"].is_u64()
            || !t["depth"].is_u64()
            || array(&t["messages"])
                .iter()
                .any(|m| !m["text"].is_string() || !m["kind"].is_string())
            || !Path::new(t["cwd"].as_str().unwrap_or("")).is_absolute()
        {
            bail!("Malformed collaboration task.");
        }
        let provider = Provider::parse(t["owner"].as_str().unwrap_or(""))?;
        Permission::parse(t["permission"].as_str().unwrap_or(""))?;
        if let Some(e) = t.get("effort") {
            provider.validate_effort(e)?;
        }
        if let Some(m) = t.get("model") {
            model(m)?;
        }
        progress::validate(t)?;
        crate::notifications::validate_task(t, &s["requests"])?;
        events::validate(t)?;
        if let Some(p) = t.get("projectRoot") {
            if !p.as_str().is_some_and(|p| Path::new(p).is_absolute()) || p != &t["cwd"] {
                bail!("Malformed collaboration workspace scope.");
            }
        }
        for key in ["readOnlyDirs", "writableDirs"] {
            if let Some(v) = t.get(key) {
                if !v.is_array()
                    || array(v).len() > 16
                    || array(v)
                        .iter()
                        .any(|p| !p.as_str().is_some_and(|p| Path::new(p).is_absolute()))
                {
                    bail!("Malformed collaboration workspace scope.");
                }
            }
        }
        for execution in [&t["active"], &t["lastExecution"]] {
            if let Some(rows) = execution.get("ownedProcesses") {
                processes::validate(&serde_json::from_value::<Vec<processes::ProcessIdentity>>(
                    rows.clone(),
                )?)?;
            }
        }
        if let Some(p) = t.get("pendingHandoff").filter(|v| !v.is_null()) {
            let provider = Provider::parse(p["provider"].as_str().unwrap_or(""))?;
            model(&p["model"])?;
            if let Some(e) = p.get("effort") {
                provider.validate_effort(e)?;
            }
        }
        if t["status"] == "running"
            && (t["active"]["generation"] != t["generation"]
                || t["active"]["tokenHash"]
                    .as_str()
                    .is_none_or(|s| !token_valid(s))
                || !t["active"]["messageCount"].is_u64())
        {
            bail!("Malformed active worker generation.");
        }
        if let Some(parent) = t["parentId"].as_str() {
            if s["tasks"][parent]["depth"].as_u64().map(|d| d + 1) != t["depth"].as_u64() {
                bail!("Malformed task parent/depth.");
            }
        } else if t["depth"] != 0 {
            bail!("Malformed root depth.");
        }
    }
    Ok(())
}
