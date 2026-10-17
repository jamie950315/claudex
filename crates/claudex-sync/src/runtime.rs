//! Native Desktop adapter. The shared Codex backend remains the only Codex
//! writer; the stream-json Claude owner remains the only Claude writer.
use crate::{
    archive,
    bridge::Side,
    codecs,
    desktop::{Adapter, ArchiveDispatch, DesktopBridge, Pending, PlanInput, Reading, Record},
    history::{Common, digest_bytes},
    native, native_history, owned_history,
    owner::Owner,
    packet,
};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::{
    rpc::CodexClient,
    storage::{self, FileLock},
    version::VersionPolicy,
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

fn projected_images(common: &Common) -> bool {
    common
        .messages
        .iter()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant" | "system"))
        .any(|m| {
            m.content.iter().any(|b| {
                if packet::validate_image(b).is_ok() {
                    return true;
                }
                let Some(object) = b.as_object() else {
                    return false;
                };
                let id = b.get("tool_use_id").or_else(|| b.get("id"));
                b["type"] == "tool_result"
                    && object.keys().all(|k| {
                        matches!(
                            k.as_str(),
                            "type" | "tool_use_id" | "id" | "content" | "is_error"
                        )
                    })
                    && id.is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                    && (b.get("tool_use_id").is_none()
                        || b.get("id").is_none()
                        || b["tool_use_id"] == b["id"])
                    && b.get("is_error").is_none_or(Value::is_boolean)
                    && b["content"].as_array().is_some_and(|a| {
                        a.iter().all(|v| {
                            packet::validate_image(v).is_ok()
                                || packet::exact_keys(v, &["type", "text"])
                                    && v["type"] == "text"
                                    && v["text"].is_string()
                        }) && a.iter().any(|v| packet::validate_image(v).is_ok())
                    })
            })
        })
}
fn resolve_reset_record(record: &Record, pending: &Pending, owner: &Owner) -> Result<Record> {
    let reset = &owner.state["lastReset"];
    if reset["operationId"] != pending.operation_id {
        return Ok(record.clone());
    }
    ensure!(
        reset["sessionId"] == owner.state["sessionId"]
            && reset["remoteId"] == owner.state["remoteId"]
            && (reset["previousSessionId"] == record.native_id
                || reset["sessionId"] == record.native_id),
        "Applied context reset has an inconsistent native identity."
    );
    let mut resolved = record.clone();
    resolved.native_id = reset["sessionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Applied reset identity missing."))?
        .into();
    resolved.path = owner.transcript_path.clone();
    Ok(resolved)
}

#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
    pub claude_binary: PathBuf,
    pub context_mode: String,
    pub version_policy: VersionPolicy,
    pub limits: native_history::Limits,
    pub owner_idle: Duration,
}
impl Options {
    pub fn from_config(root: &Path, config: &Value) -> Result<Self> {
        let mode = config["contextMode"].as_str().unwrap_or("inline");
        ensure!(
            matches!(mode, "inline" | "archive"),
            "Unsupported Desktop context mode."
        );
        let idle = config["claudeOwnerIdleSeconds"].as_u64().unwrap_or(900);
        ensure!(
            (60..=86400).contains(&idle),
            "Invalid Claude owner idle limit."
        );
        let mut limits = native_history::Limits::default();
        if let Some(v) = config["nativeHistoryMaxBytes"].as_u64() {
            limits.max_bytes = v.try_into()?;
        }
        if let Some(v) = config["nativeHistoryPageSize"].as_u64() {
            limits.page_size = v.try_into()?;
        }
        limits.validate()?;
        Ok(Self {
            root: fs::canonicalize(root)?,
            codex_home: fs::canonicalize(
                config["codexHome"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing Codex home."))?,
            )?,
            claude_home: fs::canonicalize(
                config["claudeHome"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing Claude home."))?,
            )?,
            claude_binary: config["claudeBinary"].as_str().unwrap_or("claude").into(),
            context_mode: mode.into(),
            version_policy: VersionPolicy::parse(config["versionPolicy"].as_str())?,
            limits,
            owner_idle: Duration::from_secs(idle),
        })
    }
}
pub fn packet_key(root: &Path) -> Result<Vec<u8>> {
    storage::private_directory(root)?;
    let _lock = FileLock::acquire(&root.join("packet-key.lock"), true)?;
    let path = root.join("packet-key");
    if !path.try_exists()? {
        let state = storage::read_json_or(root.join("desktop-state.json"), Value::Null)?;
        let owners = match fs::read_dir(root.join("owners")) {
            Ok(entries) => entries
                .collect::<std::io::Result<Vec<_>>>()?
                .iter()
                .any(|e| e.path().extension().is_some_and(|e| e == "json")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        ensure!(
            !state["records"].as_array().is_some_and(|a| !a.is_empty())
                && state["pending"].is_null()
                && !owners,
            "Packet key missing for existing Desktop state; restore it before synchronizing."
        );
        use std::io::Read;
        let mut bytes = [0u8; 32];
        fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        storage::publish_exclusive(&path, format!("{}\n", hex::encode(bytes)))?;
    }
    let data = storage::read_stable(path)?;
    ensure!(
        data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && data.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Packet key must be private, owned and single-link."
    );
    let text = std::str::from_utf8(&data.bytes)?.trim();
    ensure!(
        packet::hex_digest(&json!(text)),
        "Invalid packet signing key."
    );
    Ok(hex::decode(text)?)
}
struct OwnerEntry {
    owner: Owner,
    used: Instant,
    startup_error: Option<String>,
}
pub struct Runtime {
    pub options: Options,
    shared_transport_root: PathBuf,
    key: Vec<u8>,
    client: Mutex<Option<CodexClient>>,
    native_version: Mutex<Option<String>>,
    owners: Mutex<HashMap<String, Arc<Mutex<OwnerEntry>>>>,
    native_events: tokio::sync::broadcast::Sender<Value>,
    handoffs: Mutex<crate::local_handoff::Publisher>,
}
struct RuntimeProofs {
    rollout: crate::native_proofs::RolloutProofs,
    provenance: crate::codex_provenance::Provenance,
    late_items_enabled: bool,
}
#[async_trait]
impl native_history::Proofs for RuntimeProofs {
    async fn empty_turns(&self, id: &str, turns: &[Value]) -> Result<Option<Value>> {
        native_history::Proofs::empty_turns(&self.rollout, id, turns).await
    }
    async fn initial_goal(&self, id: &str, turn: &Value) -> Result<Option<Value>> {
        native_history::Proofs::initial_goal(&self.rollout, id, turn).await
    }
    async fn late_items(
        &self,
        id: &str,
        turns: &[Value],
        empty: &std::collections::BTreeSet<String>,
    ) -> Result<Option<Value>> {
        if !self.late_items_enabled {
            return Ok(None);
        }
        ensure!(
            id == self.provenance.thread_id,
            "Native late-item thread identity changed."
        );
        self.provenance.late_items(turns, empty)
    }
}
pub struct NativeAdapter {
    runtime: Arc<Runtime>,
    side: Side,
}
fn admit_codex_source(record: &Record, metadata: &Value) -> Result<()> {
    if !record.verified
        && !record.managed
        && record.conversation_id.is_empty()
        && crate::discovery::codex_subagent(&metadata["source"])
    {
        return Err(crate::discovery::CodexSubagentSource.into());
    }
    Ok(())
}
impl Runtime {
    pub fn new(options: Options) -> Result<Arc<Self>> {
        let shared_transport_root = options.root.clone();
        Self::initialize(options, shared_transport_root)
    }
    /// Reuse an independently verified shared backend without moving this
    /// runtime's packet key, archives, owners, ledger or mutation journals.
    pub fn new_with_shared_transport_root(
        options: Options,
        shared_transport_root: PathBuf,
    ) -> Result<Arc<Self>> {
        ensure!(
            shared_transport_root.is_absolute(),
            "Shared transport root must be absolute."
        );
        Self::initialize(options, shared_transport_root)
    }
    fn initialize(options: Options, shared_transport_root: PathBuf) -> Result<Arc<Self>> {
        let key = packet_key(&options.root)?;
        let (native_events, _) = tokio::sync::broadcast::channel(4096);
        Ok(Arc::new(Self {
            options,
            shared_transport_root,
            key,
            client: Mutex::new(None),
            native_version: Mutex::new(None),
            owners: Mutex::new(HashMap::new()),
            native_events,
            handoffs: Mutex::new(crate::local_handoff::Publisher::default()),
        }))
    }
    pub fn bridge(self: &Arc<Self>) -> DesktopBridge {
        DesktopBridge::new(
            &self.options.root,
            [Side::Codex, Side::Claude]
                .into_iter()
                .map(|side| {
                    (
                        side,
                        Arc::new(NativeAdapter {
                            runtime: self.clone(),
                            side,
                        }) as Arc<dyn Adapter>,
                    )
                })
                .collect(),
        )
    }
    pub async fn synchronization_hooks(&self) -> Result<Value> {
        let options = crate::hooks::Options {
            root: self.options.root.clone(),
            codex_home: self.options.codex_home.clone(),
            claude_home: self.options.claude_home.clone(),
            executable: std::env::current_exe()?,
        };
        crate::hooks::inspect_native_trust(&options, &self.client().await?).await
    }
    pub fn cold_scheduler(&self) -> Result<crate::cold_cache::Scheduler> {
        let code = crate::history::digest_json(&json!([
            include_str!("history.rs"),
            include_str!("codecs.rs"),
            include_str!("claude_parallel.rs"),
            include_str!("claude_annotations.rs"),
            include_str!("claude_fork.rs"),
            include_str!("image_assets.rs"),
            include_str!("owned_history.rs"),
            include_str!("native_history.rs"),
            include_str!("native_proofs.rs"),
            include_str!("native_order.rs"),
            include_str!("codex_provenance.rs"),
            include_str!("rollout_header.rs"),
            include_str!("relocation.rs"),
            include_str!("archive.rs"),
            include_str!("packet.rs"),
            include_str!("runtime.rs"),
            include_str!("cold_cache.rs")
        ]))?;
        crate::cold_cache::Scheduler::new(
            &self.options.root,
            &self.key,
            json!({"code":code,"engine":env!("CARGO_PKG_VERSION"),"root":self.options.root,"codexHome":self.options.codex_home,"claudeHome":self.options.claude_home,"contextMode":self.options.context_mode,"versionPolicy":self.options.version_policy,"nativeHistoryMaxBytes":self.options.limits.max_bytes,"nativeHistoryPageSize":self.options.limits.page_size}),
        )
    }
    pub async fn client(&self) -> Result<CodexClient> {
        let mut cached = self.client.lock().await;
        if let Some(client) = cached.as_ref().filter(|c| !c.is_closed()) {
            return Ok(client.clone());
        }
        let session = claudex_core::shared_codex::connect(
            &self.shared_transport_root,
            &self.options.codex_home,
            self.options.version_policy,
            self.options
                .limits
                .max_bytes
                .max(claudex_core::rpc::MAX_FRAME_BYTES),
        )
        .await?;
        *self.native_version.lock().await =
            session.manifest["cliVersion"].as_str().map(str::to_owned);
        *cached = Some(session.client.clone());
        let mut events = session.client.subscribe();
        let sink = self.native_events.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let disconnected = event["method"] == "claudex/disconnected";
                        let _ = sink.send(json!({"type":"codex_notification","event":event}));
                        if disconnected {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sink.send(json!({"type":"native_event_overflow"}));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(session.client)
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.native_events.subscribe()
    }
    pub(crate) fn cold_packet(
        &self,
        common: &crate::history::Common,
        conversation: &str,
        target: &str,
        operation: &str,
    ) -> Result<Vec<Value>> {
        archive::encode(
            &self.options.root,
            &common.messages,
            json!({"conversationId":conversation,"targetSessionId":target,"operationId":operation,"sourceSide":"codex","previousDigest":null}),
            &self.key,
            &archive::PacketOptions::default(),
        )
    }
    async fn owner(&self, id: &str, cwd: &str, title: &str) -> Result<Arc<Mutex<OwnerEntry>>> {
        self.owner_profile(id, cwd, title, false).await
    }
    async fn owner_profile(
        &self,
        id: &str,
        cwd: &str,
        title: &str,
        maintenance: bool,
    ) -> Result<Arc<Mutex<OwnerEntry>>> {
        loop {
            let entry = {
                let mut owners = self.owners.lock().await;
                if let Some(entry) = owners.get(id) {
                    entry.clone()
                } else {
                    let mut owner = if maintenance {
                        Owner::open_maintenance(
                            &self.options.root,
                            Path::new(cwd),
                            &self.options.claude_home,
                            id,
                            title,
                        )?
                    } else {
                        Owner::open(
                            &self.options.root,
                            Path::new(cwd),
                            &self.options.claude_home,
                            id,
                            title,
                        )?
                    };
                    owner.event_sink = Some(self.native_events.clone());
                    let entry = Arc::new(Mutex::new(OwnerEntry {
                        owner,
                        used: Instant::now(),
                        startup_error: None,
                    }));
                    owners.insert(id.into(), entry.clone());
                    entry
                }
            };
            {
                let handle = entry.clone();
                let mut entry = entry.lock().await;
                entry.used = Instant::now();
                if entry.owner.maintenance != maintenance {
                    ensure!(
                        !maintenance,
                        "Inline context migration requires a fresh cold native owner; active input channels were preserved."
                    );
                    ensure!(
                        entry.owner.state["pending"].is_null()
                            && entry.owner.state["reset"].is_null(),
                        "Cold owner recovery must complete before normal input."
                    );
                    entry.owner.close().await?;
                    drop(entry);
                    let mut owners = self.owners.lock().await;
                    if owners
                        .get(id)
                        .is_some_and(|saved| Arc::ptr_eq(saved, &handle))
                    {
                        owners.remove(id);
                    }
                    drop(owners);
                    continue;
                }
                if entry.owner.restart_required {
                    entry.owner.close().await?;
                    entry.owner.restart_required = false;
                    entry.startup_error = None;
                }
                ensure!(
                    entry.owner.cwd == Path::new(cwd),
                    "Owner working directory changed without relocation proof."
                );
                if let Some(error) = &entry.startup_error {
                    bail!("{error}");
                }
                if entry.owner.session.is_none() {
                    let permission = if maintenance {
                        None
                    } else {
                        crate::owner::configured_permission_mode(
                            &self.options.claude_home,
                            Path::new(cwd),
                        )?
                    };
                    if let Err(error) = entry
                        .owner
                        .start(&self.options.claude_binary, permission.as_deref())
                        .await
                    {
                        entry.startup_error = Some(format!("{error:#}"));
                        return Err(error);
                    }
                }
            }
            return Ok(entry);
        }
    }
    async fn reset_owner(&self, r: &Record, p: &Pending) -> Result<Arc<Mutex<OwnerEntry>>> {
        if let Some(entry) = self.owners.lock().await.get(&r.conversation_id).cloned() {
            let completed =
                entry.lock().await.owner.state["lastReset"]["operationId"] == p.operation_id;
            if completed {
                return Ok(entry);
            }
        }
        self.owner_profile(&r.conversation_id, &r.cwd, self.title(r), true)
            .await
    }
    fn title<'a>(&self, r: &'a Record) -> &'a str {
        r.extra
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Claudex conversation")
    }
    fn safe_cwd(&self, cwd: &str) -> Result<PathBuf> {
        let cwd = Path::new(cwd);
        ensure!(
            cwd.is_absolute(),
            "Native working directory must be absolute."
        );
        let canonical = match fs::canonicalize(cwd) {
            Ok(path) => path,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                anyhow::bail!(
                    "CLAUDEX_TRACKED_CWD_UNAVAILABLE: saved working directory is unavailable."
                )
            }
            Err(error) => return Err(error.into()),
        };
        ensure!(
            canonical.is_dir(),
            "CLAUDEX_TRACKED_CWD_UNAVAILABLE: saved working directory is not a directory."
        );
        Ok(canonical)
    }
    fn desktop_registry(&self) -> Result<PathBuf> {
        let config = storage::read_json_or(self.options.root.join("config.json"), Value::Null)?;
        Ok(config["desktopHome"].as_str().map(PathBuf::from).unwrap_or(
            PathBuf::from(
                std::env::var_os("HOME")
                    .ok_or_else(|| anyhow::anyhow!("Home directory unavailable."))?,
            )
            .join("Library/Application Support/Claude/claude-code-sessions"),
        ))
    }
    fn saved_owner(&self, r: &Record) -> Result<(Value, bool)> {
        let state = self.options.root.join("owners").join(format!(
            "{}.json",
            digest_bytes(r.conversation_id.as_bytes())
        ));
        let current = crate::owner::owned_state(&state)?;
        let retired = current
            .as_ref()
            .is_none_or(|s| s["sessionId"] != r.native_id);
        let owner = if retired {
            crate::owner::owned_state(&self.options.root.join("owners/retired").join(format!(
                "{}-{}.json",
                digest_bytes(r.conversation_id.as_bytes()),
                r.native_id
            )))?
        } else {
            current
        }
        .ok_or_else(|| anyhow::anyhow!("Saved Claude owner metadata is missing."))?;
        ensure!(
            owner["version"] == 1
                && owner["sessionId"] == r.native_id
                && owner["conversationId"] == r.conversation_id
                && owner["cwd"] == r.cwd
                && owner["claudeHome"] == json!(self.options.claude_home),
            "Saved Claude owner identity changed."
        );
        Ok((owner, retired))
    }
    fn reset_options(&self, cwd: &str) -> crate::owner_reset::Options {
        crate::owner_reset::Options {
            claude_home: self.options.claude_home.clone(),
            cwd: PathBuf::from(cwd),
            receipt_timeout: Duration::from_secs(30),
        }
    }
    fn reset_source(&self, r: &Record, operation: &str) -> Result<(Value, storage::Snapshot)> {
        let state = crate::owner::owned_state(&self.options.root.join("owners").join(format!(
            "{}.json",
            digest_bytes(r.conversation_id.as_bytes())
        )))?
        .ok_or_else(|| anyhow::anyhow!("Reset source owner metadata is missing."))?;
        ensure!(
            state["version"] == 1
                && state["conversationId"] == r.conversation_id
                && state["cwd"] == r.cwd
                && state["claudeHome"] == json!(self.options.claude_home),
            "Reset source owner identity changed."
        );
        if state["sessionId"] == r.native_id && state["reset"].is_null() {
            crate::owner_reset::verify_retained(&self.reset_options(&r.cwd), &state)?;
            return Ok((state, storage::snapshot(&r.path)?));
        }
        let data = crate::owner_reset::inspect_source(
            &self.reset_options(&r.cwd),
            &state,
            operation,
            &r.native_id,
        )?;
        let generation = if state["reset"]["operationId"] == operation {
            state["reset"]["previous"].clone()
        } else {
            state["retainedGeneration"].clone()
        };
        Ok((generation, data))
    }
    async fn inspect(&self, r: &Record) -> Result<Reading> {
        if r.side == Side::Codex {
            let client = self.client().await?;
            let id = if r.native_id.is_empty() {
                let raw = storage::snapshot(native::physical_rollout(&r.path)?)?;
                raw.rows
                    .iter()
                    .find(|r| r["type"] == "session_meta")
                    .and_then(|r| r["payload"]["id"].as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing native identity."))?
                    .to_owned()
            } else {
                r.native_id.clone()
            };
            Uuid::parse_str(&id)?;
            let metadata = client
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await?;
            let thread = &metadata["thread"];
            ensure!(
                thread["id"] == id,
                "Native Codex returned a different identity."
            );
            admit_codex_source(r, thread)?;
            let mut cwd = self.safe_cwd(
                thread["cwd"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing native cwd."))?,
            )?;
            if (r.managed || r.status == "original")
                && !r.cwd.is_empty()
                && self.safe_cwd(&r.cwd)? == cwd
            {
                cwd = PathBuf::from(&r.cwd);
            }
            let path = PathBuf::from(
                thread["path"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing native rollout path."))?,
            );
            let physical = native::physical_rollout(&path)?;
            native::safe_native_path(&physical, &self.options.codex_home)?;
            let provenance = crate::codex_provenance::Provenance {
                path: path.clone(),
                thread_id: id.clone(),
                cwd: cwd.clone(),
                codex_home: self.options.codex_home.clone(),
                max_bytes: 480 * 1024 * 1024,
            };
            let mut proofs = RuntimeProofs {
                rollout: crate::native_proofs::RolloutProofs {
                    path: path.clone(),
                    thread_id: id.clone(),
                    cwd: cwd.clone(),
                    max_bytes: 480 * 1024 * 1024,
                },
                provenance: provenance.clone(),
                late_items_enabled: false,
            };
            let mut snapshot = native_history::read_stable(
                &client,
                &id,
                &self.options.limits,
                true,
                r.extra.get("displayScreenshots") == Some(&json!("omitted")),
                &proofs,
            )
            .await?;
            if r.managed {
                owned_history::validate_codex_native_bootstrap(
                    &self.options.root,
                    &snapshot,
                    &r.conversation_id,
                    &id,
                    &self.key,
                )?;
            }
            let retained = r
                .extra
                .get("localImageRollouts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            ensure!(
                retained.is_empty() || r.verified,
                "Unverified source cannot supply retained native image evidence."
            );
            let mut images = provenance.hydrate(
                &mut snapshot.turns,
                &retained,
                if r.verified {
                    Some(r.path.as_path())
                } else {
                    None
                },
                self.options.limits.max_bytes,
            )?;
            let convert = |snapshot: &native_history::Snapshot| -> Result<Common> {
                if r.managed {
                    Ok(owned_history::decode_codex_native(
                        &self.options.root,
                        snapshot,
                        &r.conversation_id,
                        &id,
                        &cwd.to_string_lossy(),
                        &self.key,
                    )?
                    .common)
                } else {
                    native_history::convert_checkpoint(
                        snapshot,
                        &id,
                        &cwd.to_string_lossy(),
                        &r.checkpoint,
                    )
                }
            };
            let mut common = convert(&snapshot)?;
            let prove_late =
                native_history::needs_late_item_proof(r.verified, &r.checkpoint, &common)?;
            if prove_late {
                // Ordinary full native history is authoritative when its whole
                // saved prefix matches. Only an actual mismatch admits the
                // extra raw late-item proof and a fresh complete two-pass read.
                proofs.late_items_enabled = true;
                snapshot = native_history::read_stable(
                    &client,
                    &id,
                    &self.options.limits,
                    true,
                    r.extra.get("displayScreenshots") == Some(&json!("omitted")),
                    &proofs,
                )
                .await?;
                if r.managed {
                    owned_history::validate_codex_native_bootstrap(
                        &self.options.root,
                        &snapshot,
                        &r.conversation_id,
                        &id,
                        &self.key,
                    )?;
                }
                images = provenance.hydrate(
                    &mut snapshot.turns,
                    &retained,
                    r.verified.then_some(r.path.as_path()),
                    self.options.limits.max_bytes,
                )?;
                common = convert(&snapshot)?;
            }
            if r.verified && r.checkpoint.count > 0 && snapshot.late_item_evidence.is_some() {
                let mut matched = None;
                for candidate in crate::native_order::representations(&snapshot)? {
                    let converted = convert(&candidate)?;
                    if r.checkpoint.contains(&converted)? {
                        matched = Some((candidate, converted));
                        break;
                    }
                }
                let selected = matched.ok_or_else(|| {
                    anyhow::anyhow!(
                        "Native late item ordering does not preserve the complete saved checkpoint."
                    )
                })?;
                snapshot = selected.0;
                common = selected.1;
            }
            if prove_late {
                ensure!(
                    r.checkpoint.contains(&common)?,
                    "Native late item ordering does not preserve the complete saved checkpoint."
                );
            }
            ensure!(
                crate::history::canonical(&serde_json::to_value(&common)?)?.len()
                    <= self.options.limits.max_bytes,
                "Converted native history exceeds its byte limit."
            );
            images.native_message_count = crate::native_order::entries(&snapshot)?.len();
            let offset = common.messages.len() as isize - images.native_message_count as isize;
            let origins = images.promote(
                &common,
                &crate::native_order::image_positions(&snapshot)?,
                offset,
                if r.verified {
                    Some(&r.checkpoint)
                } else {
                    None
                },
                &retained,
            )?;
            if let Some(title) = thread
                .get("name")
                .or_else(|| thread.get("title"))
                .filter(|v| v.is_string())
            {
                common.meta.insert("title".into(), title.clone());
            }
            let bytes = storage::snapshot_with_limit(physical, 480 * 1024 * 1024)?.bytes;
            return Ok(Reading {
                common,
                native_id: id,
                path,
                bytes,
                incomplete_tail: snapshot.incomplete_tail,
                extra: {
                    let mut extra = json!({"closedTail":snapshot.closed_tail})
                        .as_object()
                        .unwrap()
                        .clone();
                    if origins.as_array().is_some_and(|a| !a.is_empty()) {
                        extra.insert("localImageRollouts".into(), origins);
                    }
                    extra
                },
            });
        }
        if !r.managed && r.verified && r.extra.contains_key("relocation") {
            return Ok(crate::relocation::claude(
                &self.options.claude_home,
                &self.desktop_registry()?,
                r,
            )?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Saved Claude relocation no longer has its exact native registry proof."
                )
            })?
            .reading);
        }
        native::safe_native_path(&r.path, &self.options.claude_home)?;
        let reset_operation = r
            .extra
            .get("readResetSourceForOperation")
            .and_then(Value::as_str);
        let reset_source = if r.managed {
            reset_operation
                .map(|op| self.reset_source(r, op))
                .transpose()?
        } else {
            None
        };
        let mut data = if let Some((_, data)) = &reset_source {
            data.clone()
        } else {
            storage::snapshot(&r.path)?
        };
        let mut retired = false;
        let mut reset_bootstrap = None;
        if r.managed {
            let (owner, is_retired) = if let Some((generation, _)) = reset_source {
                (generation, false)
            } else {
                let saved = self.saved_owner(r)?;
                crate::owner_reset::verify_retained(&self.reset_options(&r.cwd), &saved.0)?;
                saved
            };
            retired = is_retired;
            reset_bootstrap = owner.get("lastReset").filter(|v| !v.is_null()).cloned();
            ensure!(
                r.path == codecs::claude_path(&self.options.claude_home, &r.cwd, &r.native_id)?,
                "Saved Claude owner transcript path changed."
            );
            if let Some(bindings) = owner.get("imageBindings") {
                data.rows = crate::image_assets::restore(&self.options.root, &data.rows, bindings)?;
                data.text = codecs::serialize_rows(&data.rows)?;
            }
        }
        let owned = r.managed || r.extra.get("importPacket") == Some(&json!(true));
        let filename = r.path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let fork_parent = if !owned && (r.native_id.is_empty() || r.native_id == filename) {
            crate::claude_fork::parent(&data.text, filename)?
        } else {
            None
        };
        let mut decoded = owned_history::completed_claude_with_reset(
            &data.text,
            &self.options.root,
            &r.conversation_id,
            if fork_parent.is_some() {
                ""
            } else {
                &r.native_id
            },
            owned.then_some(self.key.as_slice()),
            self.options.version_policy,
            reset_bootstrap.as_ref(),
        )?;
        if let Some(parent) = fork_parent {
            let path = r.path.parent().unwrap().join(format!("{parent}.jsonl"));
            native::safe_native_path(&path, &self.options.claude_home)?;
            let parent = storage::snapshot_with_limit(path, 512 * 1024 * 1024)?;
            let mut cutoff = 0;
            let mut offset = 0;
            for line in data.text.split_inclusive('\n') {
                offset += line.len();
                if line.trim().is_empty() {
                    continue;
                }
                let row: Value = serde_json::from_str(line)?;
                if row["type"] == "assistant"
                    && row["isSidechain"] != true
                    && matches!(
                        row["message"]["stop_reason"].as_str(),
                        Some("end_turn" | "stop_sequence")
                    )
                {
                    cutoff = offset;
                }
            }
            crate::claude_fork::verify(
                &data.text,
                filename,
                crate::claude_fork::parent(&data.text, filename)?
                    .as_deref()
                    .unwrap(),
                &parent.text,
                &data.text[..cutoff],
            )?;
            decoded.common.meta.insert("id".into(), json!(filename));
        }
        if !retired && r.extra.get("relocationWitness") != Some(&json!(true)) {
            self.safe_cwd(decoded.common.cwd()?)?;
        }
        let native_id = decoded.common.meta["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Claude identity missing."))?
            .to_owned();
        Uuid::parse_str(&native_id)?;
        Ok(Reading {
            common: decoded.common,
            native_id,
            path: r.path.clone(),
            bytes: data.bytes,
            incomplete_tail: decoded.incomplete_tail,
            extra: Map::new(),
        })
    }
    fn content(&self, r: &Record, p: &Pending) -> Result<Vec<Value>> {
        let previous = if r.side == Side::Claude {
            p.previous.clone()
        } else {
            crate::desktop::Checkpoint::empty()
        };
        ensure!(
            previous.count <= p.common.messages.len(),
            "Invalid owner prefix checkpoint."
        );
        let metadata = json!({"conversationId":r.conversation_id,"targetSessionId":r.native_id,"operationId":p.operation_id,"sourceSide":r.side.other(),"previousDigest":previous.digest});
        let refresh = r.extra.get("contextRefresh") == Some(&json!(true));
        let messages = if refresh {
            &p.common.messages[..]
        } else {
            &p.common.messages[previous.count..]
        };
        if r.extra.get("packetVersion") == Some(&json!(2)) {
            let mut options = archive::PacketOptions::default();
            if refresh {
                options.history_prefix_count = Some(previous.count);
            }
            options.archive_version = r
                .extra
                .get("archiveVersion")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .try_into()?;
            options.image_projection_version = r
                .extra
                .get("imageProjectionVersion")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .try_into()?;
            options.max_native_bytes = self.options.limits.max_bytes.min(packet::MAX_PACKET_BYTES);
            archive::encode(&self.options.root, messages, metadata, &self.key, &options)
        } else {
            packet::encode_inline(messages, metadata, &self.key)
        }
    }
    async fn metadata(&self, id: &str) -> Result<Value> {
        let result = self
            .client()
            .await?
            .request("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        ensure!(
            result["thread"]["id"] == id,
            "Native thread identity changed."
        );
        Ok(result["thread"].clone())
    }
    async fn mutation(&self, r: &Record, action: &str, method: &str, params: Value) -> Result<()> {
        let path = self
            .options
            .root
            .join("native-operations")
            .join(format!("{}-{action}.json", r.id));
        let mut journal = storage::read_json_or(&path, Value::Null)?;
        if !journal.is_null() {
            ensure!(
                journal["nativeId"] == r.native_id
                    && journal["method"] == method
                    && journal["params"] == params,
                "Native mutation journal identity mismatch."
            );
            if journal["phase"] == "complete" {
                return Ok(());
            }
            let metadata = self.metadata(&r.native_id).await?;
            let recovered = match action {
                "register" => metadata["path"] == json!(r.path),
                "name" => metadata["name"] == params["name"],
                "archive" | "original-archive" => metadata["path"].as_str().is_some_and(|p| {
                    Path::new(p)
                        .components()
                        .any(|c| c.as_os_str() == "archived_sessions")
                }),
                _ => false,
            };
            ensure!(recovered, "Native operation outcome unknown; never resend.");
            journal["phase"] = json!("complete");
            storage::write_json(path, &journal)?;
            return Ok(());
        }
        journal = json!({"version":1,"nativeId":r.native_id,"recordId":r.id,"method":method,"params":params,"phase":"requested"});
        storage::write_json(&path, &journal)?;
        self.client().await?.request(method, params).await?;
        journal["phase"] = json!("complete");
        storage::write_json(path, &journal)
    }
    async fn register(&self, r: &Record) -> Result<()> {
        self.mutation(
            r,
            "register",
            "thread/resume",
            json!({"threadId":r.native_id,"path":r.path,"cwd":r.cwd,"excludeTurns":true}),
        )
        .await?;
        let title = self.title(r);
        if !title.is_empty() {
            self.mutation(
                r,
                "name",
                "thread/name/set",
                json!({"threadId":r.native_id,"name":title}),
            )
            .await?;
        }
        Ok(())
    }
    async fn dependency_edges(&self, id: &str) -> Result<Vec<crate::dependencies::Edge>> {
        let client = self.client().await?;
        let reader = DependencyMetadata {
            runtime: self,
            client: &client,
        };
        let mut inventory =
            crate::dependencies::read_for_parents(&client, &[id.into()], &reader).await?;
        Ok(inventory.remove(id).unwrap_or_default())
    }
    async fn dependencies(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .dependency_edges(id)
            .await?
            .into_iter()
            .map(|edge| edge.id)
            .collect())
    }
    fn source_untracked(&self, id: &str) -> Result<bool> {
        let raw = storage::read_stable(self.options.root.join("desktop-state.json"))?;
        ensure!(
            raw.identity.uid == storage::uid().to_string()
                && raw.identity.mode.parse::<u32>()? & 0o77 == 0,
            "Codex source tracking ledger is unsafe."
        );
        let state: Value = serde_json::from_slice(&raw.bytes)?;
        ensure!(state["version"] == 2, "Unsupported source tracking ledger.");
        let records = state["records"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Unreadable source tracking ledger."))?;
        for record in records {
            Uuid::parse_str(
                record["nativeId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Malformed native identity in ledger."))?,
            )?;
        }
        Ok(!records.iter().any(|r| {
            r["side"] == "codex"
                && r["nativeId"]
                    .as_str()
                    .is_some_and(|native| native.eq_ignore_ascii_case(id))
        }))
    }
    async fn independent(&self, r: &Record) -> Result<()> {
        let a = self.dependencies(&r.native_id).await?;
        let b = self.dependencies(&r.native_id).await?;
        ensure!(
            a == b && a.is_empty(),
            "Native snapshot has dependent threads or unstable inventory."
        );
        Ok(())
    }
    async fn unchanged(&self, r: &Record) -> Result<Reading> {
        let d = self.inspect(r).await?;
        ensure!(
            !d.incomplete_tail && r.checkpoint.exact(&d.common)?,
            "Native retirement history changed."
        );
        Ok(d)
    }
    async fn dependency_anchor_snapshot(&self, r: &Record) -> Result<(Value, u64)> {
        ensure!(
            r.side == Side::Codex && r.managed && r.verified && r.kind == "snapshot",
            "Dependency anchor requires a verified owned Codex snapshot."
        );
        r.checkpoint.validate()?;
        let before_metadata = self.metadata(&r.native_id).await?;
        ensure!(
            before_metadata["id"] == r.native_id
                && before_metadata["cwd"] == r.cwd
                && before_metadata["path"] == json!(r.path)
                && matches!(
                    before_metadata["status"]["type"].as_str(),
                    Some("idle" | "notLoaded")
                ),
            "Dependency anchor parent identity, path or idle state changed."
        );
        let before = crate::dependency_anchor::raw(r, &r.path)?;
        let data = self.unchanged(r).await?;
        ensure!(
            data.native_id == r.native_id
                && data.path == r.path
                && data.common.cwd()? == r.cwd
                && data.bytes >= before["bytes"].as_u64().unwrap(),
            "Dependency anchor canonical identity or aggregate bytes changed."
        );
        let after_metadata = self.metadata(&r.native_id).await?;
        ensure!(
            after_metadata["id"] == before_metadata["id"]
                && after_metadata["cwd"] == before_metadata["cwd"]
                && after_metadata["path"] == before_metadata["path"]
                && matches!(
                    after_metadata["status"]["type"].as_str(),
                    Some("idle" | "notLoaded")
                ),
            "Dependency anchor metadata changed during verification."
        );
        let after = crate::dependency_anchor::raw(r, &r.path)?;
        ensure!(
            before == after,
            "Dependency anchor raw history changed during canonical verification."
        );
        Ok((after, data.bytes))
    }
    async fn original_archive_snapshot(&self, r: &Record) -> Result<Value> {
        ensure!(
            r.side == Side::Codex
                && !r.managed
                && r.verified
                && r.kind == "original"
                && matches!(r.status.as_str(), "current" | "original"),
            "Only verified unmanaged Codex originals may be preserved-archived."
        );
        r.checkpoint.validate()?;
        let first = self.metadata(&r.native_id).await?;
        ensure!(
            first["cwd"] == r.cwd
                && matches!(first["status"]["type"].as_str(), Some("idle" | "notLoaded")),
            "Codex original identity, project or idle state changed."
        );
        let path = PathBuf::from(
            first["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing original archive path."))?,
        );
        let physical = native::physical_rollout(&path)?;
        native::safe_native_path(&physical, &self.options.codex_home)?;
        let before = storage::snapshot_with_limit(&physical, 512 * 1024 * 1024)?;
        ensure!(
            before.rows.first().is_some_and(
                |row| row["type"] == "session_meta" && row["payload"]["id"] == r.native_id
            ),
            "Original archive native header changed."
        );
        let data = self.inspect(r).await?;
        ensure!(
            !data.incomplete_tail
                && data.native_id == r.native_id
                && data.path == path
                && data.common.cwd()? == r.cwd
                && r.checkpoint.exact(&data.common)?,
            "Codex original history changed or has an unfinished turn."
        );
        let latest = self.metadata(&r.native_id).await?;
        ensure!(
            latest["id"] == first["id"]
                && latest["cwd"] == first["cwd"]
                && latest["path"] == first["path"]
                && matches!(
                    latest["status"]["type"].as_str(),
                    Some("idle" | "notLoaded")
                ),
            "Codex original metadata changed during archive preflight."
        );
        let after = storage::snapshot_with_limit(&physical, 512 * 1024 * 1024)?;
        ensure!(
            before.hash == after.hash && before.file_identity == after.file_identity,
            "Codex original bytes changed during archive preflight."
        );
        Ok(json!({"path":path,"hash":before.hash}))
    }
    async fn original_archive_tree(&self, r: &Record) -> Result<Value> {
        let client = self.client().await?;
        ensure!(
            self.native_version
                .lock()
                .await
                .as_deref()
                .is_some_and(
                    |version| ["0.155.0-alpha.16.4", "0.158.0-alpha.2.1", "0.159.2"]
                        .contains(&version)
                ),
            "Preserved original archive requires a validated native cascade-archive version."
        );
        crate::original_archive::snapshot(&client, &self.options.codex_home, &r.native_id, &r.cwd)
            .await
    }
    pub async fn close_idle_owners(&self, force: bool) -> Result<Vec<String>> {
        if !force && self.bridge_state()?.pending.is_some() {
            return Ok(vec![]);
        }
        let entries: Vec<_> = self
            .owners
            .lock()
            .await
            .iter()
            .map(|(id, e)| (id.clone(), e.clone()))
            .collect();
        let mut closed = vec![];
        for (id, entry) in entries {
            let mut e = entry.lock().await;
            if !force && e.used.elapsed() < self.options.owner_idle {
                continue;
            }
            if !force && (!e.owner.state["pending"].is_null() || !e.owner.state["reset"].is_null())
            {
                continue;
            }
            if e.owner.session.is_some() && e.owner.assert_idle().await.is_err() {
                continue;
            }
            e.owner.close().await?;
            drop(e);
            self.owners.lock().await.remove(&id);
            closed.push(id);
        }
        Ok(closed)
    }
    pub async fn close(&self) -> Result<()> {
        self.close_idle_owners(true).await?;
        ensure!(
            self.owners.lock().await.is_empty(),
            "Claude owner is busy; safe shutdown must wait."
        );
        if let Some(client) = self.client.lock().await.as_ref() {
            client.close().await?;
        }
        Ok(())
    }
    pub async fn wake_owner(&self, native_id: &str, remote_id: &str) -> Result<Value> {
        Uuid::parse_str(native_id)?;
        let _lock = FileLock::acquire(&self.options.root.join("desktop-operation.lock"), true)?;
        if crate::hooks::app_stopped(&self.options.root)? {
            return Ok(json!({"ignored":"application stopped"}));
        }
        let state = crate::owner_wake::ledger(&self.options.root)?;
        let target = match crate::owner_wake::inspect(&self.options.root, &state, remote_id, false)?
        {
            crate::owner_wake::Inspection::Ready(target) => target,
            crate::owner_wake::Inspection::Ignored(reason) => return Ok(json!({"ignored":reason})),
        };
        let record = &target.record;
        if record.native_id != native_id
            || target.owner["claudeHome"] != json!(self.options.claude_home)
            || record.path
                != codecs::claude_path(&self.options.claude_home, &record.cwd, native_id)?
        {
            return Ok(json!({"ignored":"owner identity or native home changed"}));
        }
        if let Some(existing) = self
            .owners
            .lock()
            .await
            .get(&record.conversation_id)
            .cloned()
        {
            let entry = existing.lock().await;
            if entry.startup_error.is_some()
                || !entry.owner.state["blocked"].is_null()
                || !entry.owner.state["pending"].is_null()
                || !entry.owner.state["reset"].is_null()
                || entry.owner.state["sessionId"] != native_id
                || entry.owner.state["remoteId"] != remote_id
            {
                return Ok(json!({"ignored":"live owner is blocked, transitioning or changed"}));
            }
        }
        target.recheck()?;
        if crate::hooks::app_stopped(&self.options.root)? {
            return Ok(json!({"ignored":"application stopped"}));
        }
        let active = self
            .owner(&record.conversation_id, &record.cwd, self.title(record))
            .await?;
        let entry = active.lock().await;
        ensure!(
            entry.owner.state["sessionId"] == native_id
                && entry.owner.state["remoteId"] == remote_id,
            "Owner wake changed native or Remote Control identity."
        );
        Ok(json!({"woken":true}))
    }
    pub async fn publish_folders(&self) -> Result<Value> {
        let _lock = FileLock::acquire(&self.options.root.join("desktop-operation.lock"), true)?;
        let state = self.bridge_state()?;
        crate::owner_wake::publish_folders(&self.options.root, &state)
    }
    pub fn revoke_handoff_actions(&self) -> Result<bool> {
        let _lock = FileLock::acquire(&self.options.root.join("desktop-operation.lock"), true)?;
        crate::local_handoff::revoke(&self.options.root, true)
    }
    pub async fn publish_handoffs(
        &self,
        registry: &Path,
        scope: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<Value> {
        let _lock = FileLock::acquire(&self.options.root.join("desktop-operation.lock"), true)?;
        let state = self.bridge_state()?;
        self.handoffs
            .lock()
            .await
            .publish(
                &self.options.root,
                registry,
                &state,
                scope,
                self,
                storage::now_ms().try_into()?,
            )
            .await
    }
    fn bridge_state(&self) -> Result<crate::desktop::State> {
        let state: crate::desktop::State = serde_json::from_value(storage::read_json_or(
            self.options.root.join("desktop-state.json"),
            serde_json::to_value(crate::desktop::State::default())?,
        )?)?;
        ensure!(state.version == 2, "Unsupported Desktop state.");
        Ok(state)
    }
}
#[async_trait]
impl crate::local_handoff::Inspector for Runtime {
    async fn inspect_handoff(&self, record: &Record) -> Result<Reading> {
        if record.managed {
            let live = self
                .owners
                .lock()
                .await
                .get(&record.conversation_id)
                .cloned();
            if let Some(live) = live {
                let entry = live.lock().await;
                if entry.startup_error.is_some() || entry.owner.assert_idle().await.is_err() {
                    return Err(crate::local_handoff::Deferred("owner_not_idle").into());
                }
            } else {
                let path = self.options.root.join("owners").join(format!(
                    "{}.json.lock",
                    digest_bytes(record.conversation_id.as_bytes())
                ));
                if path.try_exists()? {
                    return Err(crate::local_handoff::Deferred("owner_not_idle").into());
                }
            }
        }
        self.inspect(record).await
    }
}
struct DependencyMetadata<'a> {
    runtime: &'a Runtime,
    client: &'a CodexClient,
}
#[async_trait]
impl crate::dependencies::Metadata for DependencyMetadata<'_> {
    async fn read(
        &self,
        id: &str,
        options: &crate::dependencies::ReadOptions,
    ) -> Result<Option<Value>> {
        match self
            .client
            .request("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await
        {
            Ok(result) => Ok(Some(result)),
            Err(error) => {
                if options.transient_candidate
                    && self.runtime.source_untracked(id)?
                    && crate::dependencies::rollout_absent(&self.runtime.options.codex_home, id)?
                    && !crate::dependencies::inventory_contains(
                        self.client,
                        id,
                        &options.parent_ids,
                    )
                    .await?
                    && crate::dependencies::rollout_absent(&self.runtime.options.codex_home, id)?
                    && self.runtime.source_untracked(id)?
                {
                    return Ok(None);
                }
                Err(error)
            }
        }
    }
}
#[async_trait]
impl Adapter for NativeAdapter {
    async fn inspect(&self, r: &Record) -> Result<Reading> {
        ensure!(r.side == self.side, "Wrong native adapter side.");
        self.runtime.inspect(r).await
    }
    async fn reconcile_relocation(
        &self,
        r: &Record,
        thorough: bool,
    ) -> Result<Option<crate::desktop::Relocation>> {
        if r.managed || !r.verified || r.kind != "original" || r.status != "current" {
            return Ok(None);
        }
        if self.side == Side::Claude {
            if r.extra.get("importPacket") == Some(&json!(true)) {
                return Ok(None);
            }
            if !r.extra.contains_key("relocation") {
                match fs::symlink_metadata(&r.path) {
                    Ok(_) => return Ok(None),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.into()),
                }
            }
            return Ok(crate::relocation::claude(
                &self.runtime.options.claude_home,
                &self.runtime.desktop_registry()?,
                r,
            )?
            .filter(|p| p.record.path != r.path || p.record.cwd != r.cwd));
        }
        let previous = match fs::canonicalize(&r.cwd) {
            Ok(path) => Some(path),
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => None,
            Err(e) => return Err(e.into()),
        };
        if previous.as_deref() == Some(Path::new(&r.cwd)) && !thorough {
            return Ok(None);
        }
        let metadata = self.runtime.metadata(&r.native_id).await?;
        let Some(native_cwd) = metadata["cwd"]
            .as_str()
            .filter(|p| Path::new(p).is_absolute())
        else {
            return Ok(None);
        };
        let cwd = match fs::canonicalize(native_cwd) {
            Ok(path) => path,
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if cwd == Path::new(&r.cwd)
            || !cwd.is_dir()
            || previous
                .as_ref()
                .is_some_and(|p| p != &cwd && p != Path::new(&r.cwd))
        {
            return Ok(None);
        }
        let reading = self.runtime.inspect(r).await?;
        ensure!(
            Path::new(reading.common.cwd()?) == cwd,
            "Codex relocation native project changed during history inspection."
        );
        let directory = storage::FileIdentity::from_metadata(&fs::symlink_metadata(&cwd)?);
        let previous_state = if previous.is_none() {
            "absent"
        } else if previous.as_deref() == Some(Path::new(&r.cwd)) {
            "independent"
        } else {
            "alias"
        };
        let mut record = r.clone();
        record.cwd = cwd.to_string_lossy().into_owned();
        record.path = reading.path.clone();
        record.extra.insert("relocation".into(),json!({"version":1,"kind":"codex-project-move","originCwd":r.extra.get("relocation").and_then(|v|v.get("originCwd")).cloned().unwrap_or(json!(r.cwd)),"previousCwd":r.cwd,"previousPath":r.path,"previousCwdState":previous_state}));
        Ok(Some(crate::desktop::Relocation {
            record,
            reading,
            proof: json!({"cwd":cwd,"dev":directory.dev,"ino":directory.ino,"previousCwdState":previous_state}),
        }))
    }
    async fn inspect_relocation_counterpart(&self, r: &Record) -> Result<Reading> {
        let mut witness = r.clone();
        witness
            .extra
            .insert("relocationWitness".into(), json!(true));
        self.assert_idle(&witness).await?;
        self.runtime.inspect(&witness).await
    }
    async fn assert_idle(&self, r: &Record) -> Result<()> {
        if r.side == Side::Codex {
            ensure!(
                self.runtime.metadata(&r.native_id).await?["status"]["type"] != "active",
                "Codex destination is active."
            );
            return Ok(());
        }
        if r.managed {
            if let Some(operation) = r
                .extra
                .get("readResetSourceForOperation")
                .and_then(Value::as_str)
            {
                self.runtime.reset_source(r, operation)?;
                if let Some(entry) = self
                    .runtime
                    .owners
                    .lock()
                    .await
                    .get(&r.conversation_id)
                    .cloned()
                {
                    entry.lock().await.owner.assert_idle().await?;
                }
                let data = self.runtime.inspect(r).await?;
                ensure!(
                    !data.incomplete_tail,
                    "Reset source contains an incomplete native turn."
                );
                return Ok(());
            }
            let entry = self
                .runtime
                .owners
                .lock()
                .await
                .get(&r.conversation_id)
                .cloned();
            let saved = self.runtime.saved_owner(r)?;
            ensure!(
                saved.0["pending"].is_null() && saved.0["reset"].is_null(),
                "Claude owner has pending append or reset recovery."
            );
            if let Some(entry) = entry.filter(|_| !saved.1) {
                let entry = entry.lock().await;
                entry.owner.assert_idle().await?;
            } else if !saved.1 {
                let path = self.runtime.options.root.join("owners").join(format!(
                    "{}.json.lock",
                    digest_bytes(r.conversation_id.as_bytes())
                ));
                ensure!(
                    !path.try_exists()?,
                    "Closed Claude owner still has a writer lease; recover it before use."
                );
            }
        }
        let d = self.runtime.inspect(r).await?;
        ensure!(!d.incomplete_tail, "Claude turn is still running.");
        Ok(())
    }
    async fn needs_maintenance(&self, r: &Record, data: &Reading) -> Result<Option<String>> {
        if !r.managed || self.runtime.options.context_mode != "archive" {
            return Ok(None);
        }
        let images = r.extra.get("packetVersion") == Some(&json!(2))
            && r.extra.get("imageProjectionVersion") != Some(&json!(1))
            && projected_images(&data.common);
        if self.side == Side::Codex {
            return Ok((images && r.kind == "snapshot").then(|| "images".into()));
        }
        if r.status == "retired-owner" || r.cwd != data.common.cwd()? {
            return Ok(None);
        }
        if r.extra.get("packetVersion") != Some(&json!(2)) {
            self.assert_idle(r).await?;
            if let Some(entry) = self
                .runtime
                .owners
                .lock()
                .await
                .get(&r.conversation_id)
                .cloned()
            {
                ensure!(
                    entry.lock().await.owner.maintenance,
                    "Inline context migration requires a fresh cold native owner; active input channels were preserved."
                );
            }
            return Ok(Some("reset".into()));
        }
        Ok(images.then(|| "images".into()))
    }
    async fn plan(&self, input: &PlanInput) -> Result<Record> {
        let mut record = Record::source(self.side, Path::new("/"), &input.native_id);
        record.conversation_id = input.conversation_id.clone();
        record.cwd = input.common.cwd()?.into();
        record.managed = true;
        record.extra.insert("title".into(), json!(input.title));
        let archive = self.runtime.options.context_mode == "archive";
        record
            .extra
            .insert("packetVersion".into(), json!(if archive { 2 } else { 1 }));
        if archive {
            record.extra.insert("archiveVersion".into(), json!(2));
            record
                .extra
                .insert("imageProjectionVersion".into(), json!(1));
        }
        if self.side == Side::Claude {
            if input.relocation {
                let target = input
                    .target
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Relocation owner target missing."))?;
                ensure!(
                    target.managed
                        && target.verified
                        && target.kind == "owner"
                        && target.cwd != input.common.cwd()?,
                    "Owner relocation requires its exact verified prior owner."
                );
                let active = self
                    .runtime
                    .owners
                    .lock()
                    .await
                    .get(&input.conversation_id)
                    .cloned();
                if let Some(active) = active {
                    let mut entry = active.lock().await;
                    ensure!(
                        entry.owner.state["sessionId"] == target.native_id,
                        "Running relocation owner identity changed."
                    );
                    entry.owner.close().await?;
                    drop(entry);
                    self.runtime
                        .owners
                        .lock()
                        .await
                        .remove(&input.conversation_id);
                }
                Owner::retire(&self.runtime.options.root, target)?;
            }
            let owner = self
                .runtime
                .owner_profile(
                    &input.conversation_id,
                    input.common.cwd()?,
                    &input.title,
                    input.context_reset,
                )
                .await?;
            let owner = owner.lock().await;
            if input.context_reset {
                crate::owner_reset::Host::assert_safe(&owner.owner).await?;
                record.extra.insert("contextReset".into(), json!(true));
            }
            let refresh =
                !input.relocation
                    && !input.context_reset
                    && archive
                    && input.target.as_ref().is_some_and(|t| t.managed)
                    && (input.context_refresh
                        || input.target.as_ref().is_some_and(|t| {
                            t.extra.get("imageProjectionVersion") != Some(&json!(1))
                        }) && projected_images(&input.common));
            if refresh {
                record.extra.insert("contextRefresh".into(), json!(true));
            }
            record.native_id = owner.owner.state["sessionId"].as_str().unwrap().into();
            record.path = owner.owner.transcript_path.clone();
            record.kind = "owner".into();
            if let Some(target) = &input.target {
                ensure!(
                    !target.managed || target.native_id == record.native_id || input.relocation,
                    "Existing Claude owner changed identity."
                );
            }
        } else {
            record.path = codecs::codex_projection_path(
                &self.runtime.options.codex_home,
                &input.common,
                &record.native_id,
            )?;
            record.kind = "snapshot".into();
        }
        Ok(record)
    }
    async fn operation_applied(&self, r: &Record, p: &Pending) -> Result<bool> {
        if self.side == Side::Claude {
            if r.extra.get("contextReset") == Some(&json!(true)) {
                let entry = self.runtime.reset_owner(r, p).await?;
                let mut entry = entry.lock().await;
                if entry.owner.state["lastReset"]["operationId"] != p.operation_id {
                    return Ok(false);
                }
                let resolved = resolve_reset_record(r, p, &entry.owner)?;
                let content = self.runtime.content(&resolved, p)?;
                let restore = entry.owner.state["lastReset"]["restoreOperationId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let applied =
                    crate::owner_reset::Host::has_append(&mut entry.owner, &restore, &content)
                        .await?;
                crate::owner_reset::verify_retained(
                    &self.runtime.reset_options(&r.cwd),
                    &entry.owner.state,
                )?;
                return Ok(applied);
            }
            let entry = self
                .runtime
                .owner(&r.conversation_id, &r.cwd, self.runtime.title(r))
                .await?;
            let mut entry = entry.lock().await;
            ensure!(
                entry.owner.state["sessionId"] == r.native_id,
                "Native owner identity changed."
            );
            let content = self.runtime.content(r, p)?;
            let intent = json!({"uuid":crate::owner::append_uuid(&r.native_id,&p.operation_id),"content":content,"contentHash":storage::hash_json(&json!(content))?});
            let applied = entry.owner.find_append(&intent)?;
            if applied {
                entry.owner.reconcile_pending()?;
                if entry.owner.state["remoteId"].is_null() {
                    entry.owner.connect().await?;
                }
            }
            return Ok(applied);
        }
        match native::physical_rollout(&r.path) {
            Err(e) if storage::is_not_found(&e) => Ok(false),
            Err(e) => Err(e),
            Ok(path) => {
                native::safe_native_path(&path, &self.runtime.options.codex_home)?;
                let data = storage::snapshot(path)?;
                let decoded = owned_history::decode_codex(
                    &self.runtime.options.root,
                    &data.text,
                    &r.conversation_id,
                    &r.native_id,
                    &self.runtime.key,
                )?;
                ensure!(
                    decoded.metadata["operationId"] == p.operation_id
                        && decoded.metadata["digest"] == json!(p.checkpoint.digest),
                    "Existing projection differs from durable handoff."
                );
                self.runtime.register(r).await?;
                Ok(true)
            }
        }
    }
    async fn apply(&self, r: &Record, p: &Pending) -> Result<()> {
        if self.side == Side::Claude {
            if r.extra.get("contextReset") == Some(&json!(true)) {
                let entry = self.runtime.reset_owner(r, p).await?;
                let mut entry = entry.lock().await;
                entry.owner.assert_idle().await?;
                ensure!(
                    entry.owner.session.as_ref().unwrap().status().await["failure"].is_null(),
                    "Native reset owner has a protocol failure."
                );
                let options = self.runtime.reset_options(&r.cwd);
                let builder = |id: &str| {
                    let mut record = r.clone();
                    record.native_id = id.into();
                    self.runtime.content(&record, p)
                };
                crate::owner_reset::reset(&mut entry.owner, &options, &p.operation_id, &builder)
                    .await?;
                return Ok(());
            }
            let content = self.runtime.content(r, p)?;
            let entry = self
                .runtime
                .owner(&r.conversation_id, &r.cwd, self.runtime.title(r))
                .await?;
            entry
                .lock()
                .await
                .owner
                .append(&p.operation_id, &content)
                .await?;
            return Ok(());
        }
        let content = self.runtime.content(r, p)?;
        let common = owned_history::build_codex(&p.common, content, &r.native_id)?;
        let text = codecs::encode_codex(&common, &r.native_id, true)?;
        let expected = owned_history::decode_codex(
            &self.runtime.options.root,
            &text,
            &r.conversation_id,
            &r.native_id,
            &self.runtime.key,
        )?;
        ensure!(
            p.checkpoint.exact(&expected.common)?,
            "Native projection changes canonical checkpoint; nothing published."
        );
        storage::publish_exclusive(&r.path, text)?;
        self.runtime.register(r).await
    }
    async fn resolve_applied(&self, r: &Record, p: &Pending) -> Result<Record> {
        if self.side != Side::Claude || r.extra.get("contextReset") != Some(&json!(true)) {
            return Ok(r.clone());
        }
        let entry = self.runtime.reset_owner(r, p).await?;
        resolve_reset_record(r, p, &entry.lock().await.owner)
    }
    async fn complete_promotion(&self, r: &Record) -> Result<()> {
        if self.side == Side::Claude && r.managed && self.runtime.options.context_mode == "archive"
        {
            let entry = self
                .runtime
                .owner(&r.conversation_id, &r.cwd, self.runtime.title(r))
                .await?;
            let mut entry = entry.lock().await;
            ensure!(
                entry.owner.state["sessionId"] == r.native_id,
                "Normal owner startup changed the promoted native identity."
            );
            entry.owner.connect().await?;
        }
        Ok(())
    }
    async fn exists(&self, r: &Record) -> Result<bool> {
        if self.side == Side::Claude {
            return Ok(r.path.try_exists()?);
        }
        let response = self
            .runtime
            .client()
            .await?
            .request(
                "thread/read",
                json!({"threadId":r.native_id,"includeTurns":false}),
            )
            .await;
        match response {
            Ok(v) => {
                ensure!(
                    v["thread"]["id"] == r.native_id,
                    "Unexpected native identity while probing existence."
                );
                Ok(true)
            }
            Err(e)
                if e.downcast_ref::<claudex_core::rpc::RpcError>()
                    .is_some_and(|e| {
                        e.code == Some(json!(-32602)) && {
                            let message = e.to_string().to_lowercase();
                            ["not found", "no rollout", "does not exist"]
                                .iter()
                                .any(|text| message.contains(text))
                        }
                    }) =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }
    async fn hide(&self, r: &Record) -> Result<Map<String, Value>> {
        ensure!(
            self.side == Side::Codex && r.managed && r.verified && r.kind == "snapshot",
            "Only a verified owned Codex snapshot may retire."
        );
        self.assert_idle(r).await?;
        self.runtime.unchanged(r).await?;
        self.runtime.independent(r).await?;
        self.runtime
            .mutation(
                r,
                "archive",
                "thread/archive",
                json!({"threadId":r.native_id}),
            )
            .await?;
        let thread = self.runtime.metadata(&r.native_id).await?;
        Ok(json!({"path":thread["path"]}).as_object().unwrap().clone())
    }
    async fn remove(&self, r: &Record) -> Result<()> {
        ensure!(
            self.side == Side::Codex
                && r.managed
                && r.verified
                && r.kind == "snapshot"
                && r.status == "previous",
            "Only a verified previous owned snapshot may be deleted."
        );
        self.assert_idle(r).await?;
        self.runtime.unchanged(r).await?;
        self.runtime.independent(r).await?;
        self.runtime
            .mutation(
                r,
                "delete",
                "thread/delete",
                json!({"threadId":r.native_id}),
            )
            .await
    }
    async fn prepare_dependency_anchor(&self, r: &Record) -> Result<Option<Map<String, Value>>> {
        if self.side != Side::Codex {
            return Ok(None);
        }
        let first = self.runtime.dependency_edges(&r.native_id).await?;
        if first.is_empty() {
            return Ok(None);
        }
        let before = self.runtime.dependency_anchor_snapshot(r).await?;
        let second = self.runtime.dependency_edges(&r.native_id).await?;
        ensure!(first == second, "Dependency inventory changed.");
        let after = self.runtime.dependency_anchor_snapshot(r).await?;
        ensure!(
            before == after,
            "Dependency anchor parent changed during dependency inventory."
        );
        let fields = json!({"dependencyIds":first.iter().map(|e|&e.id).collect::<Vec<_>>(),"dependencyAnchor":{"version":1,"dependencies":first,"raw":after.0},"bytes":after.1});
        Ok(Some(fields.as_object().unwrap().clone()))
    }
    async fn assert_dependency_anchor(&self, r: &Record) -> Result<Option<Value>> {
        ensure!(
            self.side == Side::Codex && r.status == "dependency-anchor",
            "Invalid dependency anchor side or state."
        );
        let proof = self.runtime.dependency_anchor_snapshot(r).await?;
        crate::dependency_anchor::compare(r, &proof.0, proof.1)
    }
    async fn assert_can_archive_original(&self, r: &Record) -> Result<()> {
        ensure!(
            self.side == Side::Codex && !r.managed && r.verified && r.kind == "original",
            "Invalid preserved original."
        );
        self.assert_idle(r).await?;
        self.runtime.unchanged(r).await?;
        self.runtime.independent(r).await
    }
    async fn archive_original(&self, r: &Record) -> Result<Map<String, Value>> {
        self.assert_can_archive_original(r).await?;
        self.runtime
            .mutation(
                r,
                "original-archive",
                "thread/archive",
                json!({"threadId":r.native_id}),
            )
            .await?;
        self.runtime.unchanged(r).await?;
        let metadata = self.runtime.metadata(&r.native_id).await?;
        Ok(json!({"path":metadata["path"]})
            .as_object()
            .unwrap()
            .clone())
    }
    async fn assert_archive_replacement(
        &self,
        original: &Record,
        replacement: &Record,
        title: &str,
    ) -> Result<()> {
        ensure!(
            replacement.managed
                && replacement.verified
                && replacement.status == "current"
                && replacement.kind == "snapshot"
                && replacement.side == Side::Codex
                && original.native_id != replacement.native_id,
            "Original archive requires its exact verified current replacement."
        );
        for record in [original, replacement] {
            let thread = self.runtime.metadata(&record.native_id).await?;
            ensure!(
                thread["name"] == title
                    && thread["cwd"] == record.cwd
                    && matches!(
                        thread["status"]["type"].as_str(),
                        Some("idle" | "notLoaded")
                    ),
                "Original archive title, project or idle state does not match its replacement."
            );
        }
        Ok(())
    }
    async fn prepare_original_archive_tree(&self, r: &Record) -> Result<Value> {
        let original = self.runtime.original_archive_snapshot(r).await?;
        let proof = self.runtime.original_archive_tree(r).await?;
        crate::original_archive::compare(
            &proof,
            &self.runtime.original_archive_tree(r).await?,
            false,
        )?;
        let after = self.runtime.original_archive_snapshot(r).await?;
        ensure!(
            original == after && proof["members"][0]["hash"] == after["hash"],
            "Codex original changed while preparing its archive tree."
        );
        Ok(proof)
    }
    async fn archive_original_tree(
        &self,
        r: &Record,
        proof: &Value,
        allow_write: bool,
        dispatch: &dyn ArchiveDispatch,
    ) -> Result<Map<String, Value>> {
        let original = self.runtime.original_archive_snapshot(r).await?;
        let before = self.runtime.original_archive_tree(r).await?;
        let already_archived =
            crate::original_archive::archived(Path::new(original["path"].as_str().unwrap()));
        crate::original_archive::compare(proof, &before, already_archived)?;
        if !already_archived {
            ensure!(
                allow_write,
                "Original archive request outcome is unknown; no native request was repeated."
            );
            crate::original_archive::compare(
                proof,
                &self.runtime.original_archive_tree(r).await?,
                false,
            )?;
            let client = self.runtime.client().await?;
            dispatch.before_dispatch().await?;
            client
                .request("thread/archive", json!({"threadId":r.native_id}))
                .await?;
        }
        let after = self.runtime.original_archive_tree(r).await?;
        crate::original_archive::compare(proof, &after, true)?;
        let confirmed = self.runtime.original_archive_snapshot(r).await?;
        ensure!(
            crate::original_archive::archived(Path::new(confirmed["path"].as_str().unwrap()))
                && confirmed["hash"] == original["hash"],
            "Codex original archive changed its history; intent was preserved."
        );
        Ok(json!({"path":confirmed["path"],"archivedTree":after})
            .as_object()
            .unwrap()
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn late_proof_gate_skips_normal_reads_and_preserves_admitted_proof_failures() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        let id = Uuid::new_v4().to_string();
        let path = root.join("missing-rollout.jsonl");
        let mut proofs = RuntimeProofs {
            rollout: crate::native_proofs::RolloutProofs {
                path: path.clone(),
                thread_id: id.clone(),
                cwd: root.clone(),
                max_bytes: 1024 * 1024,
            },
            provenance: crate::codex_provenance::Provenance {
                path,
                thread_id: id.clone(),
                cwd: root.clone(),
                codex_home: root,
                max_bytes: 1024 * 1024,
            },
            late_items_enabled: false,
        };
        let turns = vec![json!({"items":[{"type":"commandExecution"}]})];
        let empty = std::collections::BTreeSet::new();
        assert!(
            native_history::Proofs::late_items(&proofs, &id, &turns, &empty)
                .await?
                .is_none()
        );
        proofs.late_items_enabled = true;
        assert!(
            native_history::Proofs::late_items(&proofs, &id, &turns, &empty)
                .await
                .is_err()
        );
        Ok(())
    }
    #[test]
    fn only_fresh_unenrolled_subagents_are_excluded_by_native_metadata() -> Result<()> {
        let source = Record::source(
            Side::Codex,
            Path::new("/native/rollout.jsonl"),
            &Uuid::new_v4().to_string(),
        );
        let subagent = json!({"source":{"subAgent":{"thread_spawn":{
            "parent_thread_id":Uuid::new_v4(),"depth":1
        }}}});
        assert!(
            admit_codex_source(&source, &subagent)
                .unwrap_err()
                .is::<crate::discovery::CodexSubagentSource>()
        );
        // Fork ancestry and unknown metadata are not subagent evidence.
        admit_codex_source(
            &source,
            &json!({"source":"cli","forkedFrom":Uuid::new_v4()}),
        )?;
        admit_codex_source(&source, &json!({"source":{"future":"metadata"}}))?;
        let mut record = source;
        record.verified = true;
        admit_codex_source(&record, &subagent)?;
        record.verified = false;
        record.managed = true;
        admit_codex_source(&record, &subagent)?;
        record.managed = false;
        record.conversation_id = "existing-conversation".into();
        admit_codex_source(&record, &subagent)?;
        Ok(())
    }
    #[test]
    fn shared_transport_root_default_preserves_relative_runtime_root() -> Result<()> {
        let cwd = std::env::current_dir()?;
        let temp = tempfile::tempdir_in(&cwd)?;
        let base = storage::private_directory(temp.path())?;
        let options = Options::from_config(&base, &json!({"codexHome":base,"claudeHome":base}))?;
        let relative_root = temp.path().strip_prefix(&cwd)?.join("runtime");
        assert!(!relative_root.is_absolute());
        let runtime = Runtime::new(Options {
            root: relative_root.clone(),
            ..options
        })?;
        assert_eq!(runtime.options.root, relative_root);
        assert_eq!(runtime.shared_transport_root, relative_root);
        assert!(relative_root.join("packet-key").is_file());
        Ok(())
    }
    #[tokio::test]
    async fn shared_transport_root_defaults_locally_and_explicit_root_keeps_state_private()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let base = storage::private_directory(temp.path())?;
        let private = storage::private_directory(base.join("private"))?;
        let existing = storage::private_directory(base.join("existing"))?;
        let codex = storage::private_directory(base.join("codex"))?;
        let claude = storage::private_directory(base.join("claude"))?;
        let options =
            Options::from_config(&private, &json!({"codexHome":codex,"claudeHome":claude}))?;
        let default = Runtime::new(options.clone())?;
        assert_eq!(default.shared_transport_root, private);
        let explicit = Runtime::new_with_shared_transport_root(options.clone(), existing.clone())?;
        assert_eq!(explicit.shared_transport_root, existing);
        assert_eq!(explicit.options.root, private);
        assert_eq!(explicit.bridge().root, private);
        assert!(private.join("packet-key").is_file());
        assert_eq!(fs::read_dir(&existing)?.count(), 0);
        // No manifest or fallback backend may be created when admission fails.
        assert!(explicit.client().await.is_err());
        assert_eq!(fs::read_dir(&existing)?.count(), 0);
        assert!(!private.join("codex-shared").exists());
        assert!(
            Runtime::new_with_shared_transport_root(options, PathBuf::from("relative")).is_err()
        );
        Ok(())
    }
    #[test]
    fn archive_refresh_carries_full_history_and_exact_prefix_without_inventing_turns() -> Result<()>
    {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(temp.path())?;
        let codex = storage::private_directory(root.join("codex"))?;
        let claude = storage::private_directory(root.join("claude"))?;
        let runtime = Runtime::new(Options::from_config(
            &root,
            &json!({"codexHome":codex,"claudeHome":claude,"contextMode":"archive"}),
        )?)?;
        let mut common = Common {
            meta: json!({"cwd":root}).as_object().unwrap().clone(),
            messages: vec![
                crate::history::Message::text("user", "Request"),
                crate::history::Message::text("assistant", "Answer"),
            ],
            extra: Map::new(),
        };
        common.messages[0].content.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="}}));
        let mut record = Record::source(
            Side::Claude,
            &root.join("native.jsonl"),
            &Uuid::new_v4().to_string(),
        );
        record.conversation_id = Uuid::new_v4().to_string();
        record.extra=json!({"packetVersion":2,"archiveVersion":2,"imageProjectionVersion":1,"contextRefresh":true}).as_object().unwrap().clone();
        let checkpoint = crate::desktop::Checkpoint::of(&common)?;
        let mut pending = Pending {
            phase: crate::desktop::Phase::Prepared,
            operation_id: Uuid::new_v4().to_string(),
            record: record.clone(),
            source_id: "source".into(),
            target_id: Some(record.id.clone()),
            archive_original_id: None,
            reuse: true,
            common: common.clone(),
            checkpoint: checkpoint.clone(),
            previous: checkpoint.clone(),
            extra: Map::new(),
        };
        let content = runtime.content(&record, &pending)?;
        let (messages, metadata) = owned_history::decode_packet(
            &root,
            &content,
            &record.conversation_id,
            &record.native_id,
            &runtime.key,
        )?
        .unwrap();
        assert_eq!(messages, common.messages);
        assert_eq!(metadata["historyPrefixCount"], 2);
        assert_eq!(metadata["previousDigest"], json!(checkpoint.digest));
        record.extra.remove("contextRefresh");
        record.extra.insert("contextReset".into(), json!(true));
        record.native_id = Uuid::new_v4().to_string();
        pending.previous = crate::desktop::Checkpoint::empty();
        let content = runtime.content(&record, &pending)?;
        let (messages, metadata) = owned_history::decode_packet(
            &root,
            &content,
            &record.conversation_id,
            &record.native_id,
            &runtime.key,
        )?
        .unwrap();
        assert_eq!(messages, common.messages);
        assert!(metadata.get("historyPrefixCount").is_none());
        assert_eq!(metadata["previousDigest"], Value::Null);
        Ok(())
    }
    #[test]
    fn image_maintenance_uses_real_source_blocks_not_arbitrary_tool_json() {
        let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="}});
        let mut common = Common {
            meta: Map::new(),
            extra: Map::new(),
            messages: vec![crate::history::Message {
                role: "assistant".into(),
                extra: Map::new(),
                content: vec![
                    json!({"type":"tool_use","id":"call","tool":{"name":"Raw","input":image}}),
                ],
            }],
        };
        assert!(!projected_images(&common));
        common.messages[0].content =
            vec![json!({"type":"tool_result","tool_use_id":"call","content":[image]})];
        assert!(projected_images(&common));
        common.messages[0].content[0]["unknown"] = json!(true);
        assert!(!projected_images(&common));
    }
    #[tokio::test]
    async fn managed_claude_reads_use_the_saved_reset_bootstrap_proof() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(temp.path())?;
        let codex = storage::private_directory(root.join("codex"))?;
        let claude = storage::private_directory(root.join("claude"))?;
        let runtime = Runtime::new(Options::from_config(
            &root,
            &json!({"codexHome":codex,"claudeHome":claude}),
        )?)?;
        let id = Uuid::new_v4().to_string();
        let cwd = root.to_string_lossy();
        let (rows, proof, common) =
            owned_history::tests::reset_fixture(&root, &cwd, &id, &runtime.key)?;
        let path = codecs::claude_path(&claude, &cwd, &id)?;
        storage::private_directory(path.parent().unwrap())?;
        storage::publish_exclusive(&path, codecs::serialize_rows(&rows)?)?;
        let owners = storage::private_directory(root.join("owners"))?;
        let state = owners.join(format!("{}.json", digest_bytes(b"c")));
        storage::write_json(
            &state,
            &json!({"version":1,"conversationId":"c","sessionId":id,"cwd":cwd,"claudeHome":claude,"lastReset":proof}),
        )?;
        let mut record = Record::source(Side::Claude, &path, &id);
        record.cwd = cwd.into();
        record.conversation_id = "c".into();
        record.managed = true;
        assert_eq!(
            runtime.inspect(&record).await?.common.fingerprint()?,
            common.fingerprint()?
        );
        let mut owner = storage::read_json(&state)?;
        owner.as_object_mut().unwrap().remove("lastReset");
        storage::write_json(&state, &owner)?;
        assert!(runtime.inspect(&record).await.is_err());
        Ok(())
    }
    #[tokio::test]
    async fn managed_claude_image_reads_restore_before_authentication_and_keep_raw_byte_count()
    -> Result<()> {
        let f = crate::image_assets::tests::fixture("image/png", false, true)?;
        let codex = storage::private_directory(&f.temp.path().join("codex"))?;
        let claude = storage::private_directory(&f.temp.path().join("claude"))?;
        let runtime = Runtime::new(Options::from_config(
            &f.root,
            &json!({"codexHome":codex,"claudeHome":claude}),
        )?)?;
        let common = crate::history::Common {
            messages: vec![
                crate::history::Message {
                    role: "user".into(),
                    content: f.expected.as_array().unwrap().clone(),
                    extra: Map::new(),
                },
                crate::history::Message::text("assistant", "Preserved"),
            ],
            meta: json!({"cwd":f.cwd,"timestamp":"2026-10-16T00:00:00.000Z"})
                .as_object()
                .unwrap()
                .clone(),
            extra: Map::new(),
        };
        let conversation = Uuid::new_v4().to_string();
        let content =
            runtime.cold_packet(&common, &conversation, &f.id, &Uuid::new_v4().to_string())?;
        let mut row = f.row.clone();
        row["message"]["content"] = json!(content);
        row["timestamp"] = json!("2026-10-16T00:00:00.000Z");
        let expected = row["message"]["content"].clone();
        let image = expected
            .as_array()
            .unwrap()
            .iter()
            .position(|b| b["type"] == "image")
            .unwrap();
        row["message"]["content"][image] = f.row["message"]["content"][1].clone();
        let (_, bindings) = crate::image_assets::capture(
            &f.root,
            &f.cache,
            &f.cwd,
            &f.id,
            &row,
            &expected,
            &json!(storage::hash_json(&expected)?),
            VersionPolicy::Strict,
        )?;
        let path = codecs::claude_path(&claude, &f.cwd, &f.id)?;
        storage::private_directory(path.parent().unwrap())?;
        storage::publish_exclusive(&path, codecs::serialize_rows(&[row.clone()])?)?;
        let owners = storage::private_directory(&f.root.join("owners"))?;
        let state = owners.join(format!("{}.json", digest_bytes(conversation.as_bytes())));
        storage::write_json(
            state,
            &json!({"version":1,"conversationId":conversation,"sessionId":f.id,"cwd":f.cwd,"claudeHome":claude,"imageBindings":{row["uuid"].as_str().unwrap():bindings}}),
        )?;
        let mut record = Record::source(Side::Claude, &path, &f.id);
        record.cwd = f.cwd.clone();
        record.conversation_id = conversation;
        record.managed = true;
        let reading = runtime.inspect(&record).await?;
        assert_eq!(reading.common.fingerprint()?, common.fingerprint()?);
        assert_eq!(reading.bytes, storage::snapshot(&path)?.bytes);
        row["message"]["content"][0]["text"] = json!("changed packet");
        storage::atomic_write(&path, codecs::serialize_rows(&[row])?)?;
        assert!(runtime.inspect(&record).await.is_err());
        Ok(())
    }
}
