//! Exact-context previews, durable no-replay actions, and native wake receipts.
use crate::{
    mod_inbox,
    mod_journal::{self, Journal, Kind},
    mod_protocol::{self, insist},
    mod_storage as storage,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    time::Duration,
};
const TTL: u64 = 10 * 60 * 1000;
pub fn fingerprint(method: &str, params: &Value) -> Result<String> {
    Ok(claudex_core::storage::hash_bytes(
        claudex_core::json::canonical_stringify(&json!({"method":method,"params":params}))?,
    ))
}
pub fn validate_receipt(saved: &Value, id: &str) -> Result<()> {
    insist(
        saved.is_object()
            && saved["version"] == 1
            && saved["id"] == id
            && saved["state"].as_str().is_some_and(|v| {
                ["prepared", "dispatching", "completed", "uncertain"].contains(&v)
            })
            && saved["context"].is_object()
            && saved["params"].is_object(),
        "INVALID_RECEIPT",
        "Preserve the malformed action receipt for inspection.",
    )?;
    let ctx = mod_protocol::context(&saved["context"])?;
    let prepared = saved["preparedAt"].as_u64();
    insist(
        serde_json::to_value(ctx)? == saved["context"]
            && prepared.is_some_and(|v| {
                v <= 9007199254740991
                    && v.checked_add(TTL)
                        .is_some_and(|v| saved["expiresAt"].as_u64() == Some(v))
            }),
        "INVALID_RECEIPT",
        "Invalid action receipt identity or expiry.",
    )?;
    let method = saved["method"].as_str().unwrap_or("");
    let mut params = saved["params"].clone();
    if method != "models" {
        insist(
            params["requestId"] == format!("mod:{id}"),
            "INVALID_RECEIPT",
            "Invalid action request identity.",
        )?;
        params.as_object_mut().unwrap().remove("requestId");
    }
    let normalized = mod_protocol::params(method, &params, true)?;
    insist(
        saved["fingerprint"] == fingerprint(method, &normalized)?,
        "INVALID_RECEIPT",
        "Action payload or identity changed. Preserve the receipt for inspection.",
    )
}
fn same_context(a: &Value, b: &Value) -> bool {
    a["sessionId"] == b["sessionId"] && a["cwd"] == b["cwd"]
}
fn public(saved: &Value) -> Result<Value> {
    let mut out = json!({"id":saved["id"],"state":saved["state"],"method":saved["method"],"params":saved["params"],"context":saved["context"],"preparedAt":saved["preparedAt"],"expiresAt":saved["expiresAt"],"automaticReplay":false});
    if saved["method"] == "start" {
        out["capabilities"] = json!({"network":false,"userConfig":false,"shell":saved["params"]["provider"]=="codex"});
        out["notice"] = json!({"code":"SANDBOX_NO_NETWORK","message":"read-only and workspace-write run in an isolated sandbox with NO network access and do not load the user's Codex/Claude config, plugins, MCP servers or hooks (Claude: no Bash or web tools). The Mod defaults to read-only and only permits sandboxed levels. For network access or user tools/config, use the existing agent/operator workflow with an authorized full-access default."});
    }
    for key in ["finishedAt", "error"] {
        if let Some(v) = saved.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(result) = saved.get("result") {
        let large = claudex_core::json::stringify(result)?.len() > 256 * 1024;
        out["result"] = if large { Value::Null } else { result.clone() };
        out["resultStoredOnly"] = json!(large);
    }
    Ok(out)
}
#[async_trait]
pub trait Rpc: Send + Sync {
    async fn call(
        &self,
        root: &Path,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value>;
}
#[async_trait]
pub trait Inbox: Send + Sync {
    async fn inspect(&self) -> Result<Value>;
    async fn submit(&self, text: &str, guard: &dyn mod_inbox::Guard) -> Value;
}
pub struct NativeInbox<'a> {
    pub runner: &'a dyn crate::platform::Runner,
}
#[async_trait]
impl Inbox for NativeInbox<'_> {
    async fn inspect(&self) -> Result<Value> {
        mod_inbox::inspect(self.runner).await
    }
    async fn submit(&self, text: &str, guard: &dyn mod_inbox::Guard) -> Value {
        mod_inbox::submit(text, guard, self.runner, Duration::from_secs(5)).await
    }
}
pub struct Bridge<'a> {
    pub root: PathBuf,
    pub rpc: &'a dyn Rpc,
    pub inbox: &'a dyn Inbox,
    pub worker: bool,
    pub native_wake: bool,
    pub self_wake: bool,
}
impl Bridge<'_> {
    fn stopped(&self) -> Result<bool> {
        let value = storage::json(&self.root.join("app-stop.json"), true, 4096)?;
        if let Some(v) = &value {
            insist(
                v["version"] == 1
                    && v["stopped"].is_boolean()
                    && v.get("resuming").is_none_or(|v| v.is_boolean()),
                "INVALID_STOP_STATE",
                "Application stop state requires inspection.",
            )?;
        }
        Ok(value.is_some_and(|v| v["stopped"] == true || v["resuming"] == true))
    }
    fn active(&self) -> Result<()> {
        insist(
            !self.stopped()?,
            "APP_STOPPED",
            "Claudex is stopped or resuming; inspect its normal application lifecycle.",
        )
    }
    async fn call(&self, method: &str, mut params: Value) -> Result<Value> {
        let root = self.root.join("collaboration");
        storage::directory(&root, false)?;
        let capability = storage::read(&root.join("controller-key"), false, 65)?.unwrap();
        insist(
            capability.len() == 65
                && capability[64] == b'\n'
                && capability[..64]
                    .iter()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
            "INVALID_CAPABILITY",
            "The controller capability requires inspection.",
        )?;
        if method == "start" {
            params["notifications"] = json!({"mode":"off"});
        }
        self.rpc
            .call(
                &root,
                method,
                params,
                Duration::from_secs(if method == "mod_wake_wait" { 25 } else { 12 }),
            )
            .await
    }
    fn receipt(&self, id: &str) -> Result<Value> {
        mod_protocol::identity(&json!(id), true)?;
        let value = Journal::new(&self.root, Kind::Actions)
            .read(&format!("{id}.json"), false)?
            .unwrap();
        validate_receipt(&value, id)?;
        Ok(value)
    }
    async fn flush(&self, path: &Path, request: &Value, journal: &Journal) -> Result<Value> {
        let result = self
            .call("mod_wake_receipt", wake_receipt_params(request))
            .await?;
        insist(
            result["messageId"] == request["messageId"]
                && result["targetProvider"] == "claude"
                && result["targetSessionId"] == request["target"]["sessionId"]
                && result["wakeRoute"] == request.get("route").cloned().unwrap_or(json!("mod"))
                && result["state"]
                    .as_str()
                    .is_some_and(|s| ["offered", "acknowledged"].contains(&s))
                && result["wake"]["claimId"] == request["claimId"]
                && result["wake"]["state"] == request["status"]
                && result["wake"]["source"].is_object()
                && same_context(&result["wake"]["source"], &request["context"]),
            "INVALID_RECEIPT",
            "The broker did not confirm this exact native delivery outcome. Pending evidence was retained.",
        )?;
        let name = format!("{}.done.json", request["claimId"].as_str().unwrap());
        let done = journal.directory.join(&name);
        if let Some(v) = journal.read(&name, true)? {
            same_request(&v, request)?;
        }
        match fs::rename(path, &done) {
            Ok(()) => storage::sync_dir(&journal.directory)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                same_request(
                    &storage::json(&done, false, storage::LIMIT)?.unwrap(),
                    request,
                )?;
            }
            Err(e) => return Err(e.into()),
        }
        Ok(result)
    }
    async fn record_outbox(&self, request: &Value, now: u64) -> Result<Value> {
        let j = Journal::new(&self.root, Kind::WakeOutbox);
        let _lock = j.transaction()?;
        let name = format!("{}.done.json", request["claimId"].as_str().unwrap());
        if let Some(done) = j.read(&name, true)? {
            same_request(&done, request)?;
            return Ok(json!({"recorded":true}));
        }
        let path = j.directory.join(format!(
            "{}.pending.json",
            request["claimId"].as_str().unwrap()
        ));
        if let Some(saved) = storage::json(&path, true, storage::LIMIT)? {
            same_request(&saved, request)?;
        } else {
            j.reserve(now)?;
            storage::write(&path, &json!({"version":1,"request":request}), true)?;
        }
        self.flush(&path, request, &j).await
    }
    async fn recover_outbox(&self) -> Result<usize> {
        let j = Journal::new(&self.root, Kind::WakeOutbox);
        let _lock = j.transaction()?;
        let mut names = vec![];
        for e in fs::read_dir(&j.directory)? {
            let name = e?
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Invalid wake outbox entry."))?;
            if regex::Regex::new(r"^[a-f0-9-]{36}\.pending\.json$")?.is_match(&name) {
                names.push(name);
            }
        }
        insist(
            names.len() <= 2048,
            "JOURNAL_CAPACITY_EXHAUSTED",
            "Wake receipt storage is full.",
        )?;
        names.sort();
        for name in names.iter().take(4) {
            let path = j.directory.join(name);
            if let Some(saved) = storage::json(&path, true, storage::LIMIT)? {
                let request = checked_outbox(&saved)?;
                insist(
                    *name == format!("{}.pending.json", request["claimId"].as_str().unwrap()),
                    "INVALID_RECEIPT",
                    "Wake receipt identity changed.",
                )?;
                if storage::json(&path, true, storage::LIMIT)?.is_some() {
                    self.flush(&path, &request, &j).await?;
                }
            }
        }
        Ok(names.len().saturating_sub(4))
    }
    pub async fn handle(&self, input: &Value, now: u64) -> Result<Value> {
        insist(
            !self.worker,
            "MANAGED_WORKER",
            "Managed workers retain their generation-scoped MCP capabilities.",
        )?;
        let request = mod_protocol::request(input)?;
        storage::directory(&self.root, false)?;
        let op = request["op"].as_str().unwrap();
        let ctx = &request["context"];
        if op == "doctor" {
            let root = self.root.join("collaboration");
            let socket_present = if crate::status_app::exists(&root)? {
                storage::directory(&root, false)?;
                match fs::symlink_metadata(root.join("rpc.sock")) {
                    Ok(m) => {
                        m.file_type().is_socket()
                            && m.uid() == crate::platform::uid()
                            && m.mode() & 0o777 == 0o600
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                    Err(e) => return Err(e.into()),
                }
            } else {
                false
            };
            return Ok(
                json!({"version":1,"root":self.root,"stopped":self.stopped()?,"socketPresent":socket_present,"runtime":"rust","runtimeVersion":env!("CARGO_PKG_VERSION"),"nativeWakeEnabled":self.native_wake,"synchronizationPolicy":"unchanged","journals":mod_journal::inspect(&self.root,now),"compatibility":{"documentedModBaseline":"2.1.287","versionLoadGate":false,"synchronizationAcceptance":"separate-required-check"},"note":"A socket pathname is presence evidence. Refresh task status to verify a broker response. Keep existing hooks and renderer fallbacks."}),
            );
        }
        if op == "receipt" {
            let saved = self.receipt(request["id"].as_str().unwrap())?;
            insist(
                same_context(&saved["context"], ctx),
                "CONTEXT_CHANGED",
                "Inspect this receipt from its original exact session and directory, or use the local operator workflow.",
            )?;
            return public(&saved);
        }
        if op == "wake-next" && self.native_wake && self.recover_outbox().await? > 0 {
            return Ok(json!({"state":"receipt-recovery","messages":[]}));
        }
        let action = request["action"].as_str().unwrap_or("");
        let p = &request["params"];
        let cache_finishing = op == "cache-warm"
            && (action == "list"
                || action == "receipt"
                || action == "settings"
                    && ![
                        "defaultLimit",
                        "ttlPreference",
                        "ttlLastChoice",
                        "onUserMessage",
                        "compactAfterWarm",
                    ]
                    .iter()
                    .any(|k| p.get(*k).is_some())
                || action == "configure" && p["enabled"] == false
                || action == "observe" && p["phase"] == "ended");
        if op != "wake-receipt"
            && !(op == "wake-observe" && request["observation"]["lifecycle"] == "ended")
            && !cache_finishing
        {
            self.active()?;
        }
        if op == "cache-warm" {
            let mut p = p.clone();
            p["sessionId"] = ctx["sessionId"].clone();
            p["cwd"] = ctx["cwd"].clone();
            if action == "configure" {
                p["provider"] = json!("claude");
            } else {
                p.as_object_mut().unwrap().remove("provider");
            }
            let result = self.call(&format!("cache_warm_{action}"), p).await?;
            if ["claim", "check"].contains(&action) {
                self.active()?;
            }
            return Ok(result);
        }
        if op == "wake-observe" {
            let mut observation = request["observation"].clone();
            observation["nativeWake"] = json!(self.native_wake);
            observation["selfWake"] = json!(self.self_wake);
            return self
                .call(
                    "mod_wake_observe",
                    json!({"source":ctx,"observation":observation}),
                )
                .await;
        }
        if op == "read" {
            return self
                .call(request["method"].as_str().unwrap(), p.clone())
                .await;
        }
        if op == "prepare" {
            return self.prepare(&request, now).await;
        }
        if op == "commit" {
            let id = request["id"].as_str().unwrap();
            let root = self.root.join("mod-companion");
            storage::directory(&root, false)?;
            let Some(_lock) = storage::Lock::acquire(&root.join(format!("{id}.lock")), false)?
            else {
                return Ok(locked());
            };
            let mut saved = self.receipt(id)?;
            insist(
                same_context(&saved["context"], ctx),
                "CONTEXT_CHANGED",
                "Session or directory changed after preview. Prepare a new action in the intended session.",
            )?;
            if saved["state"] != "prepared" {
                return public(&saved);
            }
            insist(
                saved["expiresAt"]
                    .as_u64()
                    .is_some_and(|expiry| now < expiry),
                "PREVIEW_EXPIRED",
                "The ten-minute preview expired. Review a fresh action.",
            )?;
            self.active()?;
            saved["state"] = json!("dispatching");
            saved["dispatchedAt"] = json!(now);
            let path = root.join(format!("{id}.json"));
            storage::write(&path, &saved, false)?;
            match self
                .call(saved["method"].as_str().unwrap(), saved["params"].clone())
                .await
            {
                Ok(result) => {
                    saved["result"] = result;
                    saved["state"] = json!("completed");
                }
                Err(_) => {
                    saved["state"] = json!("uncertain");
                    saved["error"] = json!({"code":"DISPATCH_UNCERTAIN","message":"Inspect the broker using the saved requestId/task/message identity. Automatic replay is disabled."});
                }
            }
            saved["finishedAt"] = json!(now);
            storage::write(&path, &saved, false)?;
            return public(&saved);
        }
        insist(
            self.native_wake,
            "NATIVE_WAKE_DISABLED",
            "Enable native receipt only after the documented local acceptance checks.",
        )?;
        if op.starts_with("wake-self-") || request["route"] == "mod-self" {
            insist(
                self.self_wake
                    && request["route"] == "mod-self"
                    && same_context(ctx, &request["target"]),
                "SELF_WAKE_DISABLED",
                "Enable own-inbox delivery explicitly and use the current exact session.",
            )?;
        }
        let mut wake =
            json!({"source":ctx,"target":request["target"],"messageId":request["messageId"]});
        for key in ["claimId", "route"] {
            if let Some(value) = request.get(key) {
                wake[key] = value.clone();
            }
        }
        match op {
            "wake-next" => {
                let mut p = json!({"source":ctx,"excludeIds":request["excludeIds"]});
                if let Some(value) = request.get("observation") {
                    let mut o = value.clone();
                    o["nativeWake"] = json!(self.native_wake);
                    o["selfWake"] = json!(self.self_wake);
                    p["observation"] = o;
                }
                if self.self_wake {
                    p["self"] = json!(true);
                }
                self.call("mod_wake_wait", p).await
            }
            "wake-peek" => {
                let mut p = json!({"source":ctx,"timeoutMs":0});
                if self.self_wake {
                    p["self"] = json!(true);
                }
                let result = self.call("mod_wake_wait", p).await?;
                let messages = result["messages"]
                    .as_array()
                    .context("Malformed broker wake response.")?
                    .iter()
                    .filter(|m| same_context(&m["target"], &request["target"]))
                    .cloned()
                    .collect::<Vec<_>>();
                Ok(json!({"target":request["target"],"messages":messages}))
            }
            "wake-claim" => {
                if request["route"] == "mod-self" {
                    self.inbox.inspect().await?;
                }
                self.call("mod_wake_claim", wake).await
            }
            "wake-check" | "wake-self-receive" => {
                let result = self
                    .call(
                        if op == "wake-check" {
                            "mod_wake_check"
                        } else {
                            "mod_wake_receive"
                        },
                        wake,
                    )
                    .await?;
                self.active()?;
                Ok(result)
            }
            "wake-self-send" => {
                let j = Journal::new(&self.root, Kind::SelfDispatch);
                storage::directory(&j.directory, true)?;
                let claim = request["claimId"].as_str().unwrap();
                let Some(_lock) =
                    storage::Lock::acquire(&j.directory.join(format!("{claim}.lock")), false)?
                else {
                    return Ok(locked());
                };
                let identity = json!({"context":ctx,"target":request["target"],"messageId":request["messageId"],"claimId":request["claimId"],"route":request["route"]});
                let path = j.directory.join(format!("{claim}.json"));
                if let Some(saved) = j.read(&format!("{claim}.json"), true)? {
                    insist(
                        saved["version"] == 1
                            && claudex_core::json::stringify(&saved["identity"])?
                                == claudex_core::json::stringify(&identity)?,
                        "INVALID_RECEIPT",
                        "Self-dispatch identity changed.",
                    )?;
                    return Ok(saved.get("outcome").cloned().unwrap_or(json!({"state":"uncertain","reason":"dispatch-recorded","automaticReplay":false})));
                }
                {
                    let _tx = j.transaction()?;
                    j.reserve(now)?;
                    storage::write(&path, &json!({"version":1,"identity":identity}), true)?;
                }
                let payload = format!(
                    "CLAUDEX_SELF_INBOX_V1\n{}",
                    claudex_core::json::stringify(
                        &json!({"messageId":request["messageId"],"claimId":request["claimId"],"target":request["target"]})
                    )?
                );
                let guard = DispatchGuard {
                    bridge: self,
                    params: wake,
                };
                let outcome = self.inbox.submit(&payload, &guard).await;
                storage::write(
                    &path,
                    &json!({"version":1,"identity":identity,"outcome":outcome}),
                    false,
                )?;
                Ok(outcome)
            }
            "wake-receipt" => self.record_outbox(&request, now).await,
            _ => {
                insist(false, "UNSUPPORTED_OPERATION", "Unsupported operation.")?;
                unreachable!()
            }
        }
    }
    async fn prepare(&self, request: &Value, now: u64) -> Result<Value> {
        storage::directory(&self.root.join("collaboration"), false)?;
        let j = Journal::new(&self.root, Kind::Actions);
        storage::directory(&j.directory, true)?;
        let mut normalized = request["params"].clone();
        let method = request["method"].as_str().unwrap();
        if method == "start"
            && (normalized.get("model").is_none() || normalized.get("effort").is_none())
        {
            let defaults = self.call("models", json!({})).await?;
            let provider = normalized["provider"].as_str().unwrap().to_string();
            insist(
                defaults["defaultModels"].is_object()
                    && defaults["defaultEfforts"].is_object()
                    && defaults["defaultModels"].get(&provider).is_some()
                    && defaults["defaultEfforts"].get(&provider).is_some(),
                "INVALID_DEFAULTS",
                "Read verified provider defaults before delegation.",
            )?;
            if normalized.get("model").is_none() {
                normalized["model"] = defaults["defaultModels"][&provider].clone();
            }
            if normalized.get("effort").is_none() {
                normalized["effort"] = defaults["defaultEfforts"][&provider].clone();
            }
            mod_protocol::params("start", &normalized, true)?;
        }
        let fingerprint = fingerprint(method, &normalized)?;
        let intents = j.directory.join("intents");
        storage::directory(&intents, true)?;
        let path = intents.join(format!("intent-{fingerprint}.json"));
        let Some(_lock) = storage::Lock::acquire(
            &j.directory.join(format!("intent-{fingerprint}.lock")),
            false,
        )?
        else {
            return Ok(locked());
        };
        let current = storage::json(&path, true, 4096)?;
        let intent = if current.is_some() {
            current.clone()
        } else {
            storage::json(
                &j.directory.join(format!("intent-{fingerprint}.json")),
                true,
                4096,
            )?
        };
        if let Some(intent) = intent {
            insist(
                intent["version"] == 1 && intent["id"].is_string(),
                "INVALID_RECEIPT",
                "Invalid intent pointer.",
            )?;
            let previous = self.receipt(intent["id"].as_str().unwrap())?;
            insist(
                previous["fingerprint"] == fingerprint,
                "INVALID_RECEIPT",
                "Intent fingerprint changed.",
            )?;
            insist(
                !previous["state"]
                    .as_str()
                    .is_some_and(|s| ["dispatching", "uncertain"].contains(&s)),
                "UNCERTAIN_ACTION",
                "An equivalent action has an uncertain dispatch. Preserve its receipt and inspect the broker before further work.",
            )?;
            if previous["state"] == "prepared"
                && previous["expiresAt"].as_u64().is_some_and(|v| v > now)
            {
                insist(
                    same_context(&previous["context"], &request["context"]),
                    "PREVIEW_HELD",
                    "An equivalent preview belongs to another exact session; wait for its expiry or inspect it locally.",
                )?;
                return public(&previous);
            }
        }
        let _transaction = j.transaction()?;
        j.reserve(now)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut params = normalized;
        if method != "models" {
            params["requestId"] = json!(format!("mod:{id}"));
        }
        let saved = json!({"version":1,"id":id,"fingerprint":fingerprint,"method":method,"params":params,"context":request["context"],"state":"prepared","preparedAt":now,"expiresAt":now+TTL});
        storage::write(&j.directory.join(format!("{id}.json")), &saved, true)?;
        storage::write(&path, &json!({"version":1,"id":id}), current.is_none())?;
        public(&saved)
    }
}
struct DispatchGuard<'a, 'b> {
    bridge: &'a Bridge<'b>,
    params: Value,
}
#[async_trait]
impl mod_inbox::Guard for DispatchGuard<'_, '_> {
    async fn before_write(&self) -> Result<bool> {
        let result = self
            .bridge
            .call("mod_wake_check", self.params.clone())
            .await?;
        insist(
            result["ready"] == true,
            "INVALID_RECEIPT",
            "Self dispatch readiness was not confirmed.",
        )?;
        self.bridge.active()?;
        Ok(true)
    }
}
fn checked_outbox(saved: &Value) -> Result<Value> {
    insist(
        saved["version"] == 1 && saved["request"]["op"] == "wake-receipt",
        "INVALID_RECEIPT",
        "Invalid wake outbox receipt.",
    )?;
    mod_protocol::request(&saved["request"])
}
fn same_request(saved: &Value, request: &Value) -> Result<()> {
    insist(
        claudex_core::json::stringify(&checked_outbox(saved)?)?
            == claudex_core::json::stringify(request)?,
        "INVALID_RECEIPT",
        "Wake receipt changed; preserve its durable evidence.",
    )
}
fn wake_receipt_params(r: &Value) -> Value {
    let mut p = json!({"source":r["context"],"target":r["target"],"messageId":r["messageId"],"claimId":r["claimId"],"status":r["status"],"reason":r["reason"]});
    if let Some(route) = r.get("route") {
        p["route"] = route.clone();
    }
    p
}
fn locked() -> Value {
    json!({"state":"locked","outcome":"inspect-receipt","automaticReplay":false})
}

/// The executable composition supplies the normal authenticated broker client.
/// Worker refusal precedes stdin and capability access.
pub async fn stdio(args: &[String], rpc: &dyn Rpc) -> Result<()> {
    use tokio::io::AsyncReadExt;
    let operation=async {
        insist(std::env::var("CLAUDEX_COLLABORATION_WORKER").as_deref()!=Ok("1"),"MANAGED_WORKER","Managed worker controller access is disabled.")?;
        let options=crate::platform::Options::parse(args)?;insist(options.positions.is_empty()&&options.values.keys().all(|k|["root","native-wake","self-wake"].contains(&k.as_str())),"INVALID_REQUEST","Invalid companion arguments.")?;
        let root=options.required_path("root")?;let mut bytes=Vec::new();tokio::io::stdin().take(mod_protocol::MAX_REQUEST_BYTES as u64+1).read_to_end(&mut bytes).await?;insist(bytes.len()<=mod_protocol::MAX_REQUEST_BYTES,"INPUT_BOUND","Companion input exceeds 96 KiB.")?;
        let input:Value=serde_json::from_slice(&bytes)?;let runner=crate::platform::SystemRunner;let inbox=NativeInbox{runner:&runner};let bridge=Bridge{root,rpc,inbox:&inbox,worker:false,native_wake:options.flag("native-wake"),self_wake:options.flag("self-wake")};
        let now=claudex_core::storage::now_ms().try_into()?;let result=bridge.handle(&input,now).await?;let output=claudex_core::json::stringify(&json!({"ok":true,"result":result}))?;
        insist(output.len()+1<=mod_protocol::MAX_RESPONSE_BYTES,"OUTPUT_BOUND","Response exceeds the UI bound. Inspect the durable action receipt or use the existing operator CLI.")?;Ok::<_,anyhow::Error>(output)
    }.await;
    match operation {
        Ok(output) => {
            println!("{output}");
            Ok(())
        }
        Err(e) => {
            let error = if let Some(e) = e.downcast_ref::<mod_protocol::ModError>() {
                json!({"code":e.code,"message":e.message})
            } else {
                json!({"code":"COMPANION_UNAVAILABLE","message":"The local companion could not verify or complete this operation. Preserve its receipt; inspect setup and broker status."})
            };
            println!(
                "{}",
                claudex_core::json::stringify(&json!({"ok":false,"error":error}))?
            );
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::DirBuilderExt, sync::Mutex};
    struct Fake {
        calls: Mutex<Vec<(String, Value)>>,
        fail: bool,
        inbox_count: Mutex<u32>,
    }
    #[async_trait]
    impl Rpc for Fake {
        async fn call(&self, _: &Path, method: &str, params: Value, _: Duration) -> Result<Value> {
            self.calls
                .lock()
                .unwrap()
                .push((method.into(), params.clone()));
            if method == "models" {
                return Ok(
                    json!({"defaultModels":{"claude":null,"codex":null},"defaultEfforts":{"claude":null,"codex":null}}),
                );
            }
            if self.fail && method == "start" {
                anyhow::bail!("Uncertain transport.");
            }
            if method == "mod_wake_check" {
                return Ok(json!({"ready":true}));
            }
            if method == "mod_wake_receipt" {
                return Ok(
                    json!({"messageId":params["messageId"],"targetProvider":"claude","targetSessionId":params["target"]["sessionId"],"wakeRoute":params.get("route").cloned().unwrap_or(json!("mod")),"state":"offered","wake":{"claimId":params["claimId"],"state":params["status"],"source":params["source"]}}),
                );
            }
            Ok(json!({"taskId":"synthetic-task"}))
        }
    }
    #[async_trait]
    impl Inbox for Fake {
        async fn inspect(&self) -> Result<Value> {
            Ok(json!({"ready":true}))
        }
        async fn submit(&self, text: &str, guard: &dyn mod_inbox::Guard) -> Value {
            assert!(text.starts_with("CLAUDEX_SELF_INBOX_V1\n"));
            if guard.before_write().await.unwrap_or(false) {
                *self.inbox_count.lock().unwrap() += 1;
                json!({"state":"submitted","reason":"socket-written","automaticReplay":false})
            } else {
                json!({"state":"rejected","reason":"before-write-refused","automaticReplay":false})
            }
        }
    }
    fn fixture() -> Result<(tempfile::TempDir, PathBuf)> {
        let t = tempfile::tempdir()?;
        let root = fs::canonicalize(t.path())?;
        let collaboration = root.join("collaboration");
        fs::DirBuilder::new().mode(0o700).create(&collaboration)?;
        crate::platform::publish(
            &collaboration.join("controller-key"),
            format!("{}\n", "a".repeat(64)).as_bytes(),
            0o600,
        )?;
        Ok((t, root))
    }
    fn fake(fail: bool) -> Fake {
        Fake {
            calls: Mutex::new(vec![]),
            fail,
            inbox_count: Mutex::new(0),
        }
    }
    fn ctx() -> Value {
        json!({"sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","cwd":"/private/project"})
    }
    fn req(op: &str) -> Value {
        json!({"version":1,"op":op,"context":ctx()})
    }
    #[tokio::test]
    async fn preview_commit_is_exact_one_use_and_origin_notifications_are_off() -> Result<()> {
        let (_t, root) = fixture()?;
        let f = fake(false);
        let b = Bridge {
            root,
            rpc: &f,
            inbox: &f,
            worker: false,
            native_wake: false,
            self_wake: false,
        };
        let mut r = req("prepare");
        r["method"] = json!("start");
        r["params"] = json!({"provider":"codex","cwd":"/private/project","prompt":"review"});
        let prepared = b.handle(&r, 100).await?;
        assert_eq!(prepared["params"]["permission"], "read-only");
        assert_eq!(prepared["capabilities"]["network"], false);
        assert_eq!(b.handle(&r, 101).await?["id"], prepared["id"]);
        let mut commit = req("commit");
        commit["id"] = prepared["id"].clone();
        assert_eq!(b.handle(&commit, 102).await?["state"], "completed");
        assert_eq!(b.handle(&commit, 103).await?["state"], "completed");
        let calls = f.calls.lock().unwrap();
        let starts: Vec<_> = calls.iter().filter(|(m, _)| m == "start").collect();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].1["notifications"], json!({"mode":"off"}));
        assert_eq!(
            starts[0].1["requestId"],
            format!("mod:{}", prepared["id"].as_str().unwrap())
        );
        Ok(())
    }
    #[tokio::test]
    async fn uncertain_dispatch_and_cross_context_preview_never_replay() -> Result<()> {
        let (_t, root) = fixture()?;
        let f = fake(true);
        let b = Bridge {
            root,
            rpc: &f,
            inbox: &f,
            worker: false,
            native_wake: false,
            self_wake: false,
        };
        let mut r = req("prepare");
        r["method"] = json!("start");
        r["params"] = json!({"provider":"claude","cwd":"/private/project","prompt":"review"});
        let prepared = b.handle(&r, 100).await?;
        let mut changed = r.clone();
        changed["context"]["cwd"] = json!("/private/other");
        assert!(b.handle(&changed, 101).await.is_err());
        let mut commit = req("commit");
        commit["id"] = prepared["id"].clone();
        assert_eq!(b.handle(&commit, 102).await?["state"], "uncertain");
        assert_eq!(b.handle(&commit, 103).await?["state"], "uncertain");
        assert!(b.handle(&r, 104).await.is_err());
        assert_eq!(
            f.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == "start")
                .count(),
            1
        );
        Ok(())
    }
    #[tokio::test]
    async fn own_inbox_dispatch_and_receipt_outbox_are_durable_and_single_use() -> Result<()> {
        let (_t, root) = fixture()?;
        let f = fake(false);
        let b = Bridge {
            root: root.clone(),
            rpc: &f,
            inbox: &f,
            worker: false,
            native_wake: true,
            self_wake: true,
        };
        let mut r = req("wake-self-send");
        r["messageId"] = json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        r["claimId"] = json!("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
        r["route"] = json!("mod-self");
        assert_eq!(b.handle(&r, 100).await?["state"], "submitted");
        assert_eq!(b.handle(&r, 101).await?["state"], "submitted");
        assert_eq!(*f.inbox_count.lock().unwrap(), 1);
        r["op"] = json!("wake-receipt");
        r["status"] = json!("submitted");
        r["reason"] = json!("inbox_written");
        b.handle(&r, 102).await?;
        assert_eq!(b.handle(&r, 103).await?["recorded"], true);
        assert!(
            root.join("mod-wake-receipts/cccccccc-cccc-4ccc-8ccc-cccccccccccc.done.json")
                .exists()
        );
        assert_eq!(
            f.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == "mod_wake_receipt")
                .count(),
            1
        );
        Ok(())
    }
    #[tokio::test]
    async fn app_hold_allows_only_finishing_evidence_and_worker_refusal_is_early() -> Result<()> {
        let (_t, root) = fixture()?;
        storage::write(
            &root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
            true,
        )?;
        let f = fake(false);
        let b = Bridge {
            root: root.clone(),
            rpc: &f,
            inbox: &f,
            worker: false,
            native_wake: false,
            self_wake: false,
        };
        let mut r = req("read");
        r["method"] = json!("list");
        r["params"] = json!({});
        assert!(b.handle(&r, 100).await.is_err());
        assert!(f.calls.lock().unwrap().is_empty());
        r = req("cache-warm");
        r["action"] = json!("list");
        r["params"] = json!({});
        b.handle(&r, 101).await?;
        let worker = Bridge {
            root: root.join("missing"),
            rpc: &f,
            inbox: &f,
            worker: true,
            native_wake: true,
            self_wake: true,
        };
        assert_eq!(
            worker
                .handle(&Value::Null, 102)
                .await
                .unwrap_err()
                .downcast_ref::<mod_protocol::ModError>()
                .unwrap()
                .code,
            "MANAGED_WORKER"
        );
        Ok(())
    }
}
