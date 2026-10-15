//! Broker-owned finite native warming. Codex observations and claims are private.
use crate::{
    codex_cache_native::{self as native, Envelope, Event, Native, Observer, UsageCounter},
    warm::{CacheWarmManager, WarmSettings},
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use claudex_sync::codex_wake::DispatchGuard;
pub use native::Environment as CacheEnvironment;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use uuid::Uuid;
const RISKS: &str = "Best-effort only: no composer-draft inspection and no per-turn tool prohibition. Existing native model, effort and permissions are inherited. Real OK turns consume plan usage and remain in history. Cache reads have no token limit. The output-token budget stops future refreshes; it is not a hard output cap. The 30-minute evidence window is a local scheduling assumption, not a configurable or verified native TTL. Busy, missed deadlines, tool activity and uncertain delivery stop warming; uncertain input is never resent.";
fn now() -> u64 {
    native::now()
}
fn limits(p: &Value) -> Result<Value> {
    ensure!(
        p["bestEffort"] == true,
        "Explicit best-effort consent is required."
    );
    ensure!(p.get("maxReadTokens").is_none_or(|v|v.is_null()||v.as_u64().is_some_and(|n|(1..=100000000).contains(&n))),"Invalid Codex maxReadTokens.");
    ensure!(
        p.get("fixedEnd").is_none_or(|v| v == true)
            && p.get("compact").is_none_or(Value::is_boolean),
        "Invalid Codex cache-warm limits."
    );
    let mut out = json!({"refreshMinutes":25,"maxMinutes":60,"maxRefreshes":3,"maxReadTokens":null,"maxOutputTokens":256});
    for (k, max) in [
        ("refreshMinutes", 25),
        ("maxMinutes", 10080),
        ("maxRefreshes", 500),
        ("maxOutputTokens", 1000000),
    ] {
        if let Some(v) = p.get(k) {
            ensure!(
                v.as_u64().is_some_and(|n| (1..=max).contains(&n)),
                "Invalid Codex cache-warm {k}."
            );
            out[k] = v.clone();
        }
    }
    for k in ["fixedEnd", "compact"] {
        if let Some(v) = p.get(k) {
            out[k] = v.clone();
        }
    }
    Ok(out)
}
type Admissions = Arc<Mutex<BTreeMap<String, Arc<AtomicBool>>>>;
struct Request {
    method: String,
    peer: String,
    params: Value,
    settings: WarmSettings,
    stopped: bool,
    reply: oneshot::Sender<Result<Value>>,
}
enum Command {
    Request(Request),
    Close(oneshot::Sender<Result<()>>),
}
pub struct CacheRuntime {
    tx: mpsc::Sender<Command>,
    admissions: Admissions,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl CacheRuntime {
    pub fn supports(method: &str) -> bool {
        method.strip_prefix("cache_warm_").is_some_and(|s| {
            ["list", "configure", "observe", "claim", "check", "receipt"].contains(&s)
        }) || method
            .strip_prefix("codex_cache_warm_")
            .is_some_and(|s| ["list", "prepare", "confirm", "off"].contains(&s))
    }
    pub async fn open(
        sync_root: PathBuf,
        codex_home: PathBuf,
        environment: Arc<dyn CacheEnvironment>,
    ) -> Result<Self> {
        let root = sync_root.join("collaboration");
        Self::open_with_root(sync_root, root, codex_home, environment).await
    }
    pub async fn open_with_root(
        sync_root: PathBuf,
        root: PathBuf,
        codex_home: PathBuf,
        environment: Arc<dyn CacheEnvironment>,
    ) -> Result<Self> {
        let claude = CacheWarmManager::open(root.clone(), "claude")?;
        let codex = CacheWarmManager::open(root, "codex")?;
        let (tx, rx) = mpsc::channel(128);
        let (events, event_rx) = mpsc::channel(256);
        let admissions = Arc::new(Mutex::new(BTreeMap::new()));
        let actor = Actor {
            claude,
            codex,
            native: Native {
                root: sync_root,
                home: codex_home,
            },
            environment,
            bindings: BTreeMap::new(),
            previews: BTreeMap::new(),
            reasons: VecDeque::new(),
            admissions: admissions.clone(),
            events,
            closed: false,
            failure: None,
            clock: 0,
        };
        let task = tokio::spawn(actor.run(rx, event_rx));
        Ok(Self {
            tx,
            admissions,
            task: Mutex::new(Some(task)),
        })
    }
    pub async fn dispatch(
        &self,
        method: &str,
        peer: &str,
        params: Value,
        settings: WarmSettings,
        stopped: bool,
    ) -> Result<Value> {
        ensure!(Self::supports(method), "Unsupported cache-warming method.");
        settings.validate()?;
        // Revoke the final fence before queuing behind in-flight native I/O.
        if method == "codex_cache_warm_off" {
            native::target(&params)?;
            if let Some(flag) = self
                .admissions
                .lock()
                .unwrap()
                .get(params["sessionId"].as_str().unwrap())
            {
                flag.store(false, Ordering::SeqCst);
            }
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Request(Request {
                method: method.into(),
                peer: peer.into(),
                params,
                settings,
                stopped,
                reply: tx,
            }))
            .await
            .context("Cache-warming service closed.")?;
        rx.await
            .context("Cache-warming operation is not confirmed; do not repeat uncertain input.")?
    }
    pub async fn close(&self) -> Result<()> {
        for flag in self.admissions.lock().unwrap().values() {
            flag.store(false, Ordering::SeqCst);
        }
        let (tx, rx) = oneshot::channel();
        let sent = self.tx.send(Command::Close(tx)).await;
        let result = if sent.is_ok() { rx.await? } else { Ok(()) };
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.await?;
        }
        result
    }
}
struct Preview {
    value: Value,
    peer: String,
}
struct Turn {
    id: String,
    started: u64,
    observed: bool,
    usage: bool,
}
struct Compact {
    id: String,
    turn: Option<String>,
    seen: bool,
}
struct Binding {
    session: String,
    cwd: String,
    instance: String,
    epoch: u64,
    sequence: u64,
    state: Value,
    phase: String,
    observer: Option<Observer>,
    counter: UsageCounter,
    samples: Vec<Value>,
    enabled: Arc<AtomicBool>,
    reason: String,
    turn: Option<Turn>,
    attempt: Option<Value>,
    warm_turn: Option<String>,
    tool: bool,
    next: Option<u64>,
    until: u64,
    completion: Option<u64>,
    compacting: Option<Compact>,
}
impl Binding {
    fn fields(&self) -> Value {
        json!({"sessionId":self.session,"cwd":self.cwd,"instanceId":self.instance,"epoch":self.epoch})
    }
    fn observe(
        &mut self,
        manager: &mut CacheWarmManager,
        sample: Option<Value>,
        phase: Option<&str>,
        settings: &WarmSettings,
    ) -> Result<Value> {
        self.sequence += 1;
        let mut p = self.fields();
        p["sequence"] = json!(self.sequence);
        p["phase"] = json!(phase.unwrap_or(&self.phase));
        if let Some(sample) = sample {
            p["sample"] = sample;
        }
        if let Some(a) = &self.attempt {
            p["attemptId"] = a["id"].clone();
        }
        let result = manager.dispatch("observe", p, now(), false, settings)?;
        ensure!(result["observed"] == true, "Native observation refused.");
        Ok(result)
    }
}
struct Actor {
    claude: CacheWarmManager,
    codex: CacheWarmManager,
    native: Native,
    environment: Arc<dyn CacheEnvironment>,
    bindings: BTreeMap<String, Binding>,
    previews: BTreeMap<String, Preview>,
    reasons: VecDeque<(String, String)>,
    admissions: Admissions,
    events: mpsc::Sender<Envelope>,
    closed: bool,
    failure: Option<Value>,
    clock: u64,
}
impl Actor {
    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut events: mpsc::Receiver<Envelope>,
    ) {
        loop {
            let deadline = self
                .bindings
                .values()
                .flat_map(|b| {
                    [
                        b.next,
                        b.completion,
                        if b.enabled.load(Ordering::SeqCst) && b.until > 0 && b.compacting.is_none()
                        {
                            Some(b.until)
                        } else {
                            None
                        },
                    ]
                })
                .flatten()
                .min();
            let wait = std::time::Duration::from_millis(
                deadline
                    .map(|t| t.saturating_sub(now()))
                    .unwrap_or(86400000)
                    .min(86400000),
            );
            tokio::select! {
                command=commands.recv()=>match command{
                    Some(Command::Request(r))=>{let result=self.dispatch(&r.method,&r.peer,r.params,&r.settings,r.stopped).await;let _=r.reply.send(result);},
                    Some(Command::Close(reply))=>{let result=self.close().await;let _=reply.send(result);break;},
                    None=>{let _=self.close().await;break;}
                },
                event=events.recv()=>if let Some(event)=event {
                    if self.bindings.get(&event.session).is_none_or(|b|b.instance!=event.instance){continue}
                    let result=async {
                        let settings=self.environment.settings().await?;settings.validate()?;
                        let mut b=self.bindings.remove(&event.session).unwrap();let result=self.event(&mut b,event.event,&settings).await;
                        if let Err(e)=result{self.fail(&mut b,&e.to_string(),true,&settings).await?;}
                        if b.observer.is_some(){self.bindings.insert(b.session.clone(),b);}Ok::<_,anyhow::Error>(())
                    }.await;
                    if result.is_err(){self.provider_failure("native-events").await;}
                },
                _=tokio::time::sleep(wait)=>{
                    if self.background().await.is_err(){self.provider_failure("schedule").await;}
                }
            }
        }
    }
    async fn close(&mut self) -> Result<()> {
        self.closed = true;
        self.previews.clear();
        let mut error = None;
        for (_, mut b) in std::mem::take(&mut self.bindings) {
            b.enabled.store(false, Ordering::SeqCst);
            if let Some(o) = b.observer.take() {
                if let Err(e) = o.close().await {
                    error = Some(e);
                }
            }
        }
        self.admissions.lock().unwrap().clear();
        if let Err(e) = self.claude.close(now(), None) {
            error = Some(e);
        }
        if let Err(e) = self.codex.close(now(), None) {
            error = Some(e);
        }
        if let Some(e) = error { Err(e) } else { Ok(()) }
    }
    async fn provider_failure(&mut self, phase: &str) {
        self.closed = true;
        self.failure.get_or_insert(json!({"code":"CACHE_WARM_PROVIDER_FAILED","reason":"native-service-failed","phase":phase}));
        self.previews.clear();
        for (_, mut b) in std::mem::take(&mut self.bindings) {
            b.enabled.store(false, Ordering::SeqCst);
            if let Some(o) = b.observer.take() {
                let _ = o.close().await;
            }
        }
        self.admissions.lock().unwrap().clear();
        let _ = self.codex.close(
            now(),
            Some((
                "CACHE_WARM_PROVIDER_FAILED".into(),
                "native-service-failed".into(),
            )),
        );
    }
    async fn dispatch(
        &mut self,
        method: &str,
        peer: &str,
        params: Value,
        settings: &WarmSettings,
        stopped: bool,
    ) -> Result<Value> {
        if let Some(action) = method.strip_prefix("cache_warm_") {
            return self
                .claude
                .dispatch(action, params, now(), stopped, settings);
        }
        let action = method
            .strip_prefix("codex_cache_warm_")
            .context("Unsupported cache method.")?;
        match action {
            "list" => self.list(params, settings),
            "prepare" => self.prepare(params, peer, stopped).await,
            "confirm" => self.confirm(params, peer, settings, stopped).await,
            "off" => self.off(params, settings).await,
            _ => bail!("Public Codex observe and claim methods are unavailable."),
        }
    }
    fn list(&mut self, p: Value, settings: &WarmSettings) -> Result<Value> {
        if p.get("sessionId").is_some() || p.get("cwd").is_some() {
            native::target(&p)?;
        }
        let mut v = self
            .codex
            .dispatch("list", json!({}), now(), false, settings)?;
        let matches = |row: &Value| {
            p.get("sessionId").is_none()
                || row["sessionId"] == p["sessionId"] && row["cwd"] == p["cwd"]
        };
        for key in ["policies", "attempts"] {
            if let Some(a) = v[key].as_array_mut() {
                a.retain(&matches);
            }
        }
        for policy in v["policies"].as_array_mut().unwrap() {
            let id = policy["sessionId"].as_str().unwrap();
            policy["nativeReason"] = self
                .bindings
                .get(id)
                .map(|b| json!(b.reason))
                .or_else(|| {
                    self.reasons
                        .iter()
                        .find(|(s, _)| s == id)
                        .map(|(_, r)| json!(r))
                })
                .unwrap_or(policy["reason"].clone());
        }
        v["bestEffort"] = json!(true);
        v["limitations"] = json!(RISKS);
        v["providerStatus"]["closed"] = json!(self.closed || self.codex.closed);
        v["providerStatus"]["bindings"] = json!(self.bindings.len());
        if let Some(f) = &self.failure {
            for (k, item) in f.as_object().unwrap() {
                v["providerStatus"][k] = item.clone();
            }
        }
        v["usageProvenance"] = json!("native-request-and-cumulative-delta");
        v["modelEvidence"] = json!("configured-thread-settings");
        v["upstreamResponseIds"] = json!(false);
        Ok(v)
    }
    async fn prepare(&mut self, p: Value, peer: &str, stopped: bool) -> Result<Value> {
        native::target(&p)?;
        let bounds = limits(&p)?;
        ensure!(
            !self.closed && !stopped && !self.environment.stopped().await?,
            "Claudex is stopped; warming cannot be prepared."
        );
        self.previews
            .retain(|_, p| p.value["expiresAt"].as_u64().unwrap() > now());
        ensure!(
            self.previews.len() < 64,
            "Cache-warm preview capacity reached."
        );
        let state = self.native.inspect(&p).await?;
        ensure!(
            !self.closed && !self.environment.stopped().await?,
            "Claudex stopped during native inspection."
        );
        let id = Uuid::new_v4().to_string();
        let mut v = json!({"confirmationId":id,"sessionId":p["sessionId"],"cwd":p["cwd"],"bestEffort":true,"expiresAt":now()+120000,"native":state,"risks":RISKS});
        v.as_object_mut()
            .unwrap()
            .extend(bounds.as_object().unwrap().clone());
        self.previews.insert(
            id,
            Preview {
                value: v.clone(),
                peer: peer.into(),
            },
        );
        v["state"] = json!("confirmation-required");
        v["inferenceStarted"] = json!(false);
        Ok(v)
    }
    async fn confirm(
        &mut self,
        p: Value,
        peer: &str,
        settings: &WarmSettings,
        stopped: bool,
    ) -> Result<Value> {
        let id = p["confirmationId"]
            .as_str()
            .context("Confirmation ID required.")?;
        let preview = self
            .previews
            .get(id)
            .context("Confirmation is missing, consumed or belongs to another controller.")?;
        ensure!(
            preview.peer == peer,
            "Confirmation belongs to another controller."
        );
        if p.get("sessionId").is_some() || p.get("cwd").is_some() {
            native::target(&p)?;
            ensure!(
                p["sessionId"] == preview.value["sessionId"] && p["cwd"] == preview.value["cwd"],
                "Confirmation belongs to another native chat."
            );
        }
        let preview = self.previews.remove(id).unwrap().value;
        ensure!(
            p["bestEffort"] == true
                && now() < preview["expiresAt"].as_u64().unwrap()
                && !self.closed
                && !stopped
                && !self.environment.stopped().await?,
            "Confirmation expired or explicit consent missing."
        );
        let session = preview["sessionId"].as_str().unwrap().to_owned();
        ensure!(
            !self.codex.pending(&session),
            "Native attempt still awaits evidence."
        );
        let state = self.native.inspect(&preview).await?;
        ensure!(
            state["fingerprint"] == preview["native"]["fingerprint"],
            "Native configuration or owner changed; prepare again."
        );
        ensure!(
            self.bindings.contains_key(&session) || self.bindings.len() < 64,
            "Native binding capacity reached."
        );
        if let Some(mut old) = self.bindings.remove(&session) {
            self.detach(&mut old, settings).await?;
        }
        self.clock = now().max(self.clock + 1);
        let instance = format!("warm-{}-{}", self.clock, Uuid::new_v4());
        let enabled = Arc::new(AtomicBool::new(true));
        self.admissions
            .lock()
            .unwrap()
            .insert(session.clone(), enabled.clone());
        let mut b = Binding {
            session: session.clone(),
            cwd: preview["cwd"].as_str().unwrap().into(),
            instance,
            epoch: 0,
            sequence: 0,
            state: state.clone(),
            phase: state["phase"].as_str().unwrap().into(),
            observer: None,
            counter: UsageCounter::default(),
            samples: vec![],
            enabled,
            reason: "awaiting-evidence".into(),
            turn: None,
            attempt: None,
            warm_turn: None,
            tool: false,
            next: None,
            until: 0,
            completion: None,
            compacting: None,
        };
        let result = async {
            let observer = self.native.connect(&preview).await?;
            ensure!(
                observer.state["fingerprint"] == preview["native"]["fingerprint"]
                    && now() < preview["expiresAt"].as_u64().unwrap()
                    && !self.closed
                    && !self.environment.stopped().await?
                    && b.enabled.load(Ordering::SeqCst),
                "Native binding changed or confirmation expired."
            );
            b.phase = observer.state["phase"].as_str().unwrap().into();
            b.turn = observer.initial.as_ref().map(|t| Turn {
                id: t["id"].as_str().unwrap().into(),
                started: t["startedAt"].as_u64().unwrap(),
                observed: false,
                usage: false,
            });
            b.observer = Some(observer);
            b.observe(&mut self.codex, None, None, settings)?;
            let mut config = limits(&preview)?;
            config
                .as_object_mut()
                .unwrap()
                .extend(b.fields().as_object().unwrap().clone());
            config["provider"] = json!("codex");
            config["enabled"] = json!(true);
            config["bestEffort"] = json!(true);
            config["requestId"] = json!(format!("codex-confirm:{id}"));
            let mut reply = self
                .codex
                .dispatch("configure", config, now(), false, settings)?;
            ensure!(
                b.enabled.load(Ordering::SeqCst),
                "Native enrollment was stopped."
            );
            b.reason = reply["reason"]
                .as_str()
                .unwrap_or("awaiting-evidence")
                .into();
            b.until = reply["policy"]["until"].as_u64().unwrap();
            b.observer
                .as_mut()
                .unwrap()
                .listen(b.instance.clone(), self.events.clone())?;
            b.next = reply["nextAt"].as_u64();
            reply["bestEffort"] = json!(true);
            reply["risks"] = json!(RISKS);
            reply["awaitingFreshUsage"] = json!(false);
            Ok(reply)
        }
        .await;
        match result {
            Ok(value) => {
                self.bindings.insert(session, b);
                Ok(value)
            }
            Err(error) => {
                self.detach(&mut b, settings).await?;
                Err(error)
            }
        }
    }
    async fn off(&mut self, p: Value, settings: &WarmSettings) -> Result<Value> {
        native::target(&p)?;
        let id = p["sessionId"].as_str().unwrap().to_owned();
        self.previews
            .retain(|_, v| v.value["sessionId"] != p["sessionId"] || v.value["cwd"] != p["cwd"]);
        if let Some(b) = self.bindings.get(&id) {
            ensure!(
                b.cwd == p["cwd"].as_str().unwrap(),
                "Native directory changed."
            );
        }
        let mut p = p;
        p["provider"] = json!("codex");
        p["enabled"] = json!(false);
        let reply = self
            .codex
            .dispatch("configure", p, now(), false, settings)?;
        if let Some(mut b) = self.bindings.remove(&id) {
            b.enabled.store(false, Ordering::SeqCst);
            b.next = None;
            b.until = 0;
            b.reason = "disabled".into();
            if b.attempt.is_none() && b.compacting.is_none() {
                self.detach(&mut b, settings).await?;
            } else {
                self.bindings.insert(id, b);
            }
        }
        Ok(reply)
    }
    async fn detach(&mut self, b: &mut Binding, settings: &WarmSettings) -> Result<()> {
        b.enabled.store(false, Ordering::SeqCst);
        b.next = None;
        b.until = 0;
        b.completion = None;
        if let Some(observer) = b.observer.take() {
            let result = observer.close().await;
            b.observe(&mut self.codex, None, Some("ended"), settings)?;
            result?;
        }
        self.admissions.lock().unwrap().remove(&b.session);
        self.reasons.retain(|(s, _)| s != &b.session);
        self.reasons
            .push_back((b.session.clone(), b.reason.clone()));
        while self.reasons.len() > 64 {
            self.reasons.pop_front();
        }
        Ok(())
    }
    async fn fail(
        &mut self,
        b: &mut Binding,
        reason: &str,
        uncertain: bool,
        settings: &WarmSettings,
    ) -> Result<()> {
        b.next = None;
        b.enabled.store(false, Ordering::SeqCst);
        b.reason = reason.into();
        self.codex.dispatch(
            "configure",
            json!({"provider":"codex","sessionId":b.session,"cwd":b.cwd,"enabled":false}),
            now(),
            false,
            settings,
        )?;
        if b.attempt.is_none() || uncertain {
            self.detach(b, settings).await?;
        }
        Ok(())
    }
    async fn finish_compact(
        &mut self,
        b: &mut Binding,
        id: &str,
        outcome: &str,
        settings: &WarmSettings,
    ) -> Result<()> {
        b.compacting = None;
        b.completion = None;
        b.next = None;
        b.enabled.store(false, Ordering::SeqCst);
        b.reason = match outcome {
            "compacted" => "compacted",
            "rejected" => "compact-skipped",
            _ => "native-uncertain",
        }
        .into();
        let mut p = b.fields();
        p["attemptId"] = json!(id);
        p["outcome"] = json!(outcome);
        let result = self.codex.dispatch("receipt", p, now(), false, settings);
        self.detach(b, settings).await?;
        result?;
        Ok(())
    }
    async fn event(
        &mut self,
        b: &mut Binding,
        event: Event,
        settings: &WarmSettings,
    ) -> Result<()> {
        if let Some(c) = &mut b.compacting {
            let mut outcome = None;
            match event {
                Event::Compacted => c.seen = true,
                Event::Invalidated(_) => outcome = Some("uncertain"),
                Event::Start { turn, .. } => {
                    if c.turn.is_none() {
                        c.turn = Some(turn)
                    } else {
                        outcome = Some("uncertain")
                    }
                }
                Event::Complete { turn, status, .. } => {
                    outcome = Some(
                        if c.turn.as_ref() == Some(&turn) && status == "completed" && c.seen {
                            "compacted"
                        } else {
                            "uncertain"
                        },
                    )
                }
                _ => (),
            }
            if let Some(outcome) = outcome {
                let id = c.id.clone();
                self.finish_compact(b, &id, outcome, settings).await?;
            }
            return Ok(());
        }
        match event {
            Event::Invalidated(reason) => self.fail(b, &reason, true, settings).await?,
            Event::Start { turn, at } => {
                if let Some(old) = &b.turn {
                    if old.id == turn && b.phase == "busy" {
                        ensure!(old.started == at, "Native turn start changed.");
                        return Ok(());
                    }
                }
                b.next = None;
                ensure!(
                    b.attempt.is_none() || b.warm_turn.as_deref() == Some(&turn),
                    "Competing native turn."
                );
                b.epoch += 1;
                b.phase = "busy".into();
                b.samples.clear();
                b.tool = false;
                b.turn = Some(Turn {
                    id: turn,
                    started: at,
                    observed: true,
                    usage: false,
                });
                b.observe(&mut self.codex, None, None, settings)?;
            }
            Event::Tool { turn } => {
                if b.attempt.is_some() && b.warm_turn.as_deref() == Some(&turn) {
                    b.tool = true;
                    self.fail(b, "native-tool-activity", false, settings)
                        .await?;
                }
            }
            Event::Usage { turn, usage, at } => {
                if let Some(t) = &mut b.turn {
                    if t.id == turn {
                        t.usage = true;
                    }
                }
                let first = b.attempt.as_ref().is_some_and(|a| a["kind"] == "prime")
                    && b.warm_turn.as_deref() == Some(&turn)
                    && b.turn.as_ref().is_some_and(|t| t.id == turn && t.observed);
                if let Some((id, u)) = b.counter.observe(&b.session, &turn, &usage, first)? {
                    let t = b
                        .turn
                        .as_ref()
                        .filter(|t| t.id == turn)
                        .context("Native turn evidence unavailable.")?;
                    ensure!(b.samples.len() < 64, "Native response capacity.");
                    let mut sample = json!({"id":id,"startedAt":t.started,"completedAt":at,"model":b.state["model"],"effort":b.state["effort"],"ttlMs":1800000,"ttlSource":"configured-window","inputTokens":u["inputTokens"],"cacheReadTokens":u["cachedInputTokens"],"cacheWriteTokens":u["cacheWriteInputTokens"],"outputTokens":u["outputTokens"],"stopReason":"end_turn"});
                    if let Some(a) = &b.attempt {
                        sample["attemptId"] = a["id"].clone();
                    }
                    b.samples.push(sample);
                }
            }
            Event::Complete {
                turn,
                status,
                at: _,
            } => {
                let t = b
                    .turn
                    .as_ref()
                    .filter(|t| t.id == turn)
                    .context("Native completion identity changed.")?;
                b.completion = None;
                let own = b.attempt.is_some();
                if !b.observer.as_ref().unwrap().settings_ready() && t.observed && t.usage {
                    b.observer.as_ref().unwrap().accept_unreported();
                }
                if b.samples.is_empty() {
                    if own {
                        return self
                            .fail(b, "native-usage-unavailable", true, settings)
                            .await;
                    }
                    b.phase = "idle".into();
                    b.turn = None;
                    let reply = b.observe(&mut self.codex, None, None, settings)?;
                    b.reason = reply["reason"]
                        .as_str()
                        .unwrap_or("awaiting-evidence")
                        .into();
                    b.next = reply["nextAt"].as_u64();
                    return Ok(());
                }
                let samples = if own {
                    std::mem::take(&mut b.samples)
                } else {
                    vec![b.samples.pop().unwrap()]
                };
                for mut sample in samples {
                    sample["stopReason"] = json!(if status != "completed" {
                        "aborted"
                    } else if own && b.tool {
                        "tool_use"
                    } else {
                        "end_turn"
                    });
                    b.observe(&mut self.codex, Some(sample), Some("busy"), settings)?;
                }
                b.phase = "idle".into();
                let reply = b.observe(&mut self.codex, None, None, settings)?;
                b.attempt = None;
                b.warm_turn = None;
                b.turn = None;
                b.samples.clear();
                b.enabled.store(
                    b.enabled.load(Ordering::SeqCst) && reply["policy"]["enabled"] == true,
                    Ordering::SeqCst,
                );
                b.reason = reply["reason"]
                    .as_str()
                    .unwrap_or("awaiting-evidence")
                    .into();
                b.next = reply["nextAt"].as_u64().or(reply["compactAt"].as_u64());
                if !b.enabled.load(Ordering::SeqCst) || b.next.is_none() {
                    self.detach(b, settings).await?;
                } else {
                    b.until = reply["policy"]["until"].as_u64().unwrap();
                }
            }
            Event::Compacted => (),
        }
        Ok(())
    }
    async fn background(&mut self) -> Result<()> {
        let settings = self.environment.settings().await?;
        settings.validate()?;
        let ids = self.bindings.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let mut b = self.bindings.remove(&id).unwrap();
            let result = async {
                if b.observer
                    .as_ref()
                    .is_some_and(|o| o.invalid.load(Ordering::SeqCst))
                {
                    return self
                        .fail(&mut b, "native-observer-invalidated", true, &settings)
                        .await;
                }
                if b.completion.is_some_and(|at| now() >= at) {
                    if let Some(c) = &b.compacting {
                        let id = c.id.clone();
                        return self
                            .finish_compact(&mut b, &id, "uncertain", &settings)
                            .await;
                    }
                    return self
                        .fail(&mut b, "native-completion-timeout", true, &settings)
                        .await;
                }
                if b.next.is_some_and(|at| now() >= at) && b.enabled.load(Ordering::SeqCst) {
                    return self.tick(&mut b, &settings).await;
                }
                if b.until > 0
                    && now() >= b.until
                    && b.enabled.load(Ordering::SeqCst)
                    && b.compacting.is_none()
                {
                    let list = self
                        .codex
                        .dispatch("list", json!({}), now(), false, &settings)?;
                    let compact = list["policies"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|p| p["sessionId"] == b.session)
                        .and_then(|p| p["compactAt"].as_u64());
                    if let Some(at) = compact {
                        b.next = Some(at);
                        b.until = 0;
                    } else {
                        self.fail(&mut b, "duration-limit", false, &settings)
                            .await?;
                    }
                }
                Ok(())
            }
            .await;
            if let Err(e) = result {
                self.fail(&mut b, &e.to_string(), true, &settings).await?;
            }
            if b.observer.is_some() {
                self.bindings.insert(id, b);
            }
        }
        Ok(())
    }
    async fn tick(&mut self, b: &mut Binding, settings: &WarmSettings) -> Result<()> {
        b.next = None;
        if self.environment.stopped().await? {
            return self.fail(b, "app-stopped", false, settings).await;
        }
        let state = b.observer.as_ref().unwrap().inspect().await?;
        ensure!(
            state["phase"] == "idle" && state["fingerprint"] == b.state["fingerprint"],
            "Native busy or configuration changed."
        );
        let claim = self
            .codex
            .dispatch("claim", b.fields(), now(), false, settings)?;
        if claim["claimed"] != true {
            if let Some(at) = claim["compactAt"].as_u64() {
                if now() >= at {
                    return self.compact(b, settings).await;
                } else {
                    b.next = Some(at);
                    return Ok(());
                }
            }
            if claim["reason"] == "not-due" {
                b.next = claim["nextAt"].as_u64();
                return Ok(());
            }
            return self
                .fail(
                    b,
                    claim["reason"].as_str().unwrap_or("claim-refused"),
                    false,
                    settings,
                )
                .await;
        }
        b.attempt = Some(claim["attempt"].clone());
        let mut outcome = "rejected";
        let _result = async {
            let owner = b.observer.as_ref().unwrap().preflight().await?;
            let mut p = b.fields();
            p["attemptId"] = claim["attempt"]["id"].clone();
            let check = self.codex.dispatch("check", p, now(), false, settings)?;
            ensure!(
                check["ready"] == true,
                "Native warm dispatch check refused."
            );
            outcome = "uncertain";
            let guard = Fence {
                observer: b.observer.as_ref().unwrap(),
                enabled: b.enabled.clone(),
                environment: self.environment.clone(),
                fingerprint: b.state["fingerprint"].clone(),
                expires: check["expiresAt"].as_u64().unwrap(),
                compact: false,
            };
            let result = owner
                .dispatch(
                    &format!("cache-warm:{}", claim["attempt"]["id"].as_str().unwrap()),
                    claim["attempt"]["prompt"].as_str().unwrap(),
                    Some(&guard),
                )
                .await;
            if result["status"] == "accepted"
                && result["turnId"].as_str().is_some_and(|s| !s.is_empty())
            {
                outcome = "submitted";
                b.warm_turn = result["turnId"].as_str().map(str::to_owned);
                b.completion = Some(now() + 180000);
            } else if matches!(
                result["status"].as_str(),
                Some("busy" | "rejected" | "unavailable")
            ) {
                outcome = "rejected";
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let mut p = b.fields();
        p["attemptId"] = claim["attempt"]["id"].clone();
        p["outcome"] = json!(outcome);
        self.codex.dispatch("receipt", p, now(), false, settings)?;
        if outcome != "submitted" {
            b.attempt = None;
            self.fail(b, &format!("native-{outcome}"), false, settings)
                .await?;
        }
        Ok(())
    }
    async fn compact(&mut self, b: &mut Binding, settings: &WarmSettings) -> Result<()> {
        let mut p = b.fields();
        p["kind"] = json!("compact");
        let claim = self.codex.dispatch("claim", p, now(), false, settings)?;
        if claim["claimed"] != true {
            return self.fail(b, "compact-unavailable", false, settings).await;
        }
        let id = claim["attempt"]["id"].as_str().unwrap().to_owned();
        let mut outcome = "rejected";
        let _result = async {
            let owner = b.observer.as_ref().unwrap().preflight().await?;
            let mut p = b.fields();
            p["attemptId"] = json!(id);
            let check = self.codex.dispatch("check", p, now(), false, settings)?;
            ensure!(check["ready"] == true, "Compaction dispatch check refused.");
            outcome = "uncertain";
            let guard = Fence {
                observer: b.observer.as_ref().unwrap(),
                enabled: b.enabled.clone(),
                environment: self.environment.clone(),
                fingerprint: b.state["fingerprint"].clone(),
                expires: check["expiresAt"].as_u64().unwrap(),
                compact: true,
            };
            let result = owner.compact(Some(&guard)).await;
            if result["status"] == "accepted" {
                outcome = "accepted";
                b.compacting = Some(Compact {
                    id: id.clone(),
                    turn: None,
                    seen: false,
                });
                b.completion = Some(now() + 600000);
            } else if matches!(
                result["status"].as_str(),
                Some("busy" | "rejected" | "unavailable")
            ) {
                outcome = "rejected";
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if outcome != "accepted" {
            self.finish_compact(b, &id, outcome, settings).await?;
        }
        Ok(())
    }
}
struct Fence<'a> {
    observer: &'a Observer,
    enabled: Arc<AtomicBool>,
    environment: Arc<dyn CacheEnvironment>,
    fingerprint: Value,
    expires: u64,
    compact: bool,
}
#[async_trait]
impl DispatchGuard for Fence<'_> {
    async fn check(&self) -> Result<()> {
        let fresh = self.observer.inspect().await?;
        let stopped = self.environment.stopped().await?;
        ensure!(
            self.enabled.load(Ordering::SeqCst)
                && !stopped
                && now() < self.expires
                && fresh["phase"] == "idle"
                && fresh["fingerprint"] == self.fingerprint
                && !self.observer.invalid.load(Ordering::SeqCst),
            "Native dispatch fence refused."
        );
        if self.compact {
            self.observer.expect_compaction();
        }
        Ok(())
    }
}
