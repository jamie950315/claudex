//! Sole-writer native Claude owner. Native inputs are at-most-once, explicitly
//! no-query messages; journal reconciliation is read-only after uncertainty.
use crate::{codecs, history::digest_bytes, packet};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast, oneshot},
};
use uuid::Uuid;

pub const CLAUDE_CLI_VERSION: &str = "2.1.281";
#[derive(Debug)]
pub struct ControlRequestFailed;
impl std::fmt::Display for ControlRequestFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Native control request failed explicitly.")
    }
}
impl std::error::Error for ControlRequestFailed {}

/// Match the native SDK's no-callback behavior. Remote tool routing and user
/// dialogs belong to the capable serving client, not the history bridge.
fn control_reply(event: &Value) -> Result<Option<Value>> {
    let id = event["request_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("Malformed native control request identity."))?;
    let subtype = event["request"]["subtype"].as_str().unwrap_or("");
    if matches!(
        subtype,
        "remote_tool_call"
            | "remote_plumbing_call"
            | "remote_tools_probe"
            | "remote_tools_reannounce"
            | "request_user_dialog"
    ) {
        return Ok(None);
    }
    if subtype == "elicitation" {
        return Ok(Some(
            json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":{"action":"decline"}}}),
        ));
    }
    let error = match subtype {
        "can_use_tool" => "canUseTool callback is not provided.",
        "oauth_token_refresh" => "getOAuthToken callback is not provided.",
        "host_auth_token_refresh" => "getHostAuthToken callback is not provided.",
        "remote_control_work_secret" => "refreshWorkSecret callback is not provided.",
        _ => "Unsupported control request subtype.",
    };
    Ok(Some(
        json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":error}}),
    ))
}
async fn checked_executable(
    binary: &Path,
    cwd: &Path,
    policy: claudex_core::version::VersionPolicy,
) -> Result<PathBuf> {
    let candidates = if binary.is_absolute() || binary.components().count() > 1 {
        vec![if binary.is_absolute() {
            binary.to_path_buf()
        } else {
            cwd.join(binary)
        }]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(binary))
            .collect::<Vec<_>>()
    };
    let executable = candidates
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .find(|path| fs::metadata(path).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0))
        .ok_or_else(|| {
            anyhow::anyhow!("Claude owner executable could not be resolved to an executable file.")
        })?;
    let mut child = Command::new(&executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = vec![];
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        child
            .stdout
            .take()
            .unwrap()
            .take(4097)
            .read_to_end(&mut output)
            .await?;
        ensure!(
            output.len() <= 4096,
            "Claude version response exceeds its byte limit."
        );
        ensure!(
            child.wait().await?.success(),
            "Claude version command failed."
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    match result {
        Ok(result) => result?,
        Err(_) => bail!("Claude version command timed out."),
    }
    let text = std::str::from_utf8(&output)?;
    let version = text.split_whitespace().next().unwrap_or("");
    ensure!(
        policy.permits(version, Some(CLAUDE_CLI_VERSION)),
        "Unsupported Claude owner native CLI version; use the pinned version or an explicit warn policy."
    );
    Ok(executable)
}

/// Resolve only the native settings namespace used by this process. Local
/// settings are user-owned; repository-committed project settings cannot select
/// an escalating mode. No default permission is invented by Claudex.
pub fn configured_permission_mode(claude_home: &Path, cwd: &Path) -> Result<Option<String>> {
    let namespace = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|p| p.join(".claude"))
        });
    if namespace
        .as_ref()
        .and_then(|p| fs::canonicalize(p).ok())
        .as_deref()
        != Some(claude_home)
    {
        return Ok(None);
    }
    let sources = [
        ("user", claude_home.join("settings.json")),
        ("project", cwd.join(".claude/settings.json")),
        ("local", cwd.join(".claude/settings.local.json")),
        (
            "managed",
            PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"),
        ),
    ];
    let mut mode = None;
    let mut bypass_disabled = false;
    for (tier, path) in sources {
        let data = match storage::read_stable(&path) {
            Ok(data) => data,
            Err(e) if storage::is_not_found(&e) => continue,
            Err(e) => return Err(e),
        };
        ensure!(
            data.bytes.len() <= 4 * 1024 * 1024,
            "Native permission settings exceed the read bound."
        );
        let settings: Value = serde_json::from_slice(&data.bytes)?;
        ensure!(
            settings.is_object(),
            "Malformed native permission settings."
        );
        if let Some(disabled) = settings["permissions"]["disableBypassPermissionsMode"].as_str() {
            bypass_disabled = disabled == "disable";
        }
        if let Some(value) = settings["permissions"]["defaultMode"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            if tier != "project" || !matches!(value, "bypassPermissions" | "auto" | "acceptEdits") {
                mode = Some(value.to_owned());
            }
        }
    }
    if mode.as_deref() == Some("default")
        || mode.as_deref() == Some("bypassPermissions") && (bypass_disabled || storage::uid() == 0)
    {
        mode = None;
    }
    Ok(mode)
}

pub(crate) fn owned_state(path: &Path) -> Result<Option<Value>> {
    match storage::read_stable_with_limit(path, 64 * 1024 * 1024) {
        Ok(data) => {
            ensure!(
                data.identity.uid == storage::uid().to_string()
                    && data.identity.nlink == "1"
                    && data.identity.mode.parse::<u32>()? & 0o7777 == 0o600
                    && data.bytes.len() <= 64 * 1024 * 1024,
                "Claude owner metadata must be private owned single-link file."
            );
            Ok(Some(serde_json::from_slice(&data.bytes)?))
        }
        Err(e) if storage::is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
fn unrecorded_native_child(created: i64, written: i64) -> Result<bool> {
    let mut process = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,uid=,lstart=,comm="])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = process
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Native process inventory has no output."))?;
    let reader = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
        use std::io::Read;
        let mut bytes = vec![];
        stdout.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = process.try_wait()? {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            let _ = process.kill();
            let _ = process.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Native process inventory reader failed."))??;
    ensure!(
        status.is_some_and(|s| s.success()) && bytes.len() <= 4 * 1024 * 1024,
        "Native process inventory is unavailable; owner lock preserved."
    );
    let pattern = regex::Regex::new(
        r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$",
    )?;
    for line in std::str::from_utf8(&bytes)?
        .lines()
        .filter(|s| !s.trim().is_empty())
    {
        let row = pattern.captures(line).ok_or_else(|| {
            anyhow::anyhow!("Native process inventory is malformed; owner lock preserved.")
        })?;
        if row[2].parse::<u32>()? != 1
            || row[3].parse::<u32>()? != storage::uid()
            || !row[5].to_ascii_lowercase().contains("claude")
        {
            continue;
        }
        let born = chrono::NaiveDateTime::parse_from_str(&row[4], "%a %b %e %H:%M:%S %Y")?
            .and_utc()
            .timestamp_millis();
        if born >= created.saturating_sub(2000) && born <= written.saturating_add(120_000) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn owner_holder_alive(value: Option<&Value>, written: i64, created: i64) -> Result<bool> {
    if let Some(value) = value {
        let pid = value["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("Malformed owner PID."))?;
        ensure!(
            value["nonce"]
                .as_str()
                .is_some_and(|v| Uuid::parse_str(v).is_ok())
                && value.get("childPid").is_some(),
            "Malformed owner lock identity."
        );
        if storage::lock_holder_alive(pid as u32, written)? {
            return Ok(true);
        }
        if !value["childPid"].is_null() {
            let child = value["childPid"]
                .as_u64()
                .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                .ok_or_else(|| anyhow::anyhow!("Malformed owner child PID."))?;
            return storage::lock_holder_alive(child as u32, written);
        }
    }
    unrecorded_native_child(created, written)
}
pub struct OwnerLease {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
    state: Value,
}
impl OwnerLease {
    pub fn acquire(path: &Path) -> Result<Self> {
        Self::acquire_with(path, &owner_holder_alive)
    }
    fn acquire_with(
        path: &Path,
        held: &dyn Fn(Option<&Value>, i64, i64) -> Result<bool>,
    ) -> Result<Self> {
        storage::private_directory(path.parent().unwrap())?;
        storage::require_private_directory(path.parent().unwrap())?;
        let create = || {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
        };
        let file = match create() {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let before = storage::read_stable(path)?;
                ensure!(
                    before.identity.uid == storage::uid().to_string()
                        && before.identity.nlink == "1"
                        && before.identity.mode.parse::<u32>()? & 0o7777 == 0o600
                        && before.bytes.len() <= 65536,
                    "Owner lock must be a bounded private owned single-link file."
                );
                let written = (before.identity.mtime_ns.parse::<i128>()? / 1_000_000).try_into()?;
                let created = storage::epoch_ms(fs::symlink_metadata(path)?.created()?)?;
                let value = if before.bytes.is_empty() {
                    ensure!(
                        storage::now_ms().saturating_sub(written) >= 60_000,
                        "Owner lock publication is still pending."
                    );
                    None
                } else {
                    Some(serde_json::from_slice::<Value>(&before.bytes)?)
                };
                let live = || held(value.as_ref(), written, created);
                ensure!(
                    !live()?,
                    "Claude owner or its recorded child is still running."
                );
                let claim = path.with_extension("lock.reap");
                fs::hard_link(path, &claim).map_err(|_| {
                    anyhow::anyhow!("Another owner recovery has claimed this lock.")
                })?;
                let result = (|| {
                    let current = storage::read_stable(path)?;
                    let claimed = storage::read_stable(&claim)?;
                    ensure!(
                        current.bytes == before.bytes
                            && current.identity.same_inode(&before.identity)
                            && claimed.identity == current.identity
                            && current.identity.nlink == "2"
                            && current.identity.uid == before.identity.uid
                            && current.identity.mode == before.identity.mode
                            && current.identity.size == before.identity.size
                            && current.identity.mtime_ns == before.identity.mtime_ns
                            && !live()?,
                        "Owner lock changed during recovery."
                    );
                    fs::remove_file(path)?;
                    Ok::<_, anyhow::Error>(create()?)
                })();
                fs::remove_file(&claim)?;
                result?
            }
            Err(e) => return Err(e.into()),
        };
        let identity = FileIdentity::from_metadata(&file.metadata()?);
        let state =
            json!({"pid":std::process::id(),"childPid":null,"nonce":Uuid::new_v4().to_string()});
        let mut lease = Self {
            path: path.into(),
            file,
            identity,
            state,
        };
        lease.save()?;
        Ok(lease)
    }
    fn save(&mut self) -> Result<()> {
        let named = FileIdentity::from_metadata(&fs::symlink_metadata(&self.path)?);
        let opened = self.file.metadata()?;
        ensure!(
            opened.is_file()
                && FileIdentity::from_metadata(&opened) == named
                && self.identity.same_inode(&named)
                && named.uid == storage::uid().to_string()
                && named.nlink == "1"
                && named.mode.parse::<u32>()? & 0o7777 == 0o600,
            "Owner lock identity changed."
        );
        self.file.set_len(0)?;
        use std::io::{Seek, SeekFrom};
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&serde_json::to_vec(&self.state)?)?;
        self.file.sync_all()?;
        Ok(())
    }
    pub fn set_child(&mut self, pid: u32) -> Result<()> {
        ensure!(pid > 0, "Invalid owner child PID.");
        self.state["childPid"] = json!(pid);
        self.save()
    }
    pub fn release(self) -> Result<()> {
        let current = owned_state(&self.path)?
            .ok_or_else(|| anyhow::anyhow!("Owner lock missing before release."))?;
        let named = FileIdentity::from_metadata(&fs::symlink_metadata(&self.path)?);
        ensure!(
            current["nonce"] == self.state["nonce"] && named.same_inode(&self.identity),
            "Owner lock changed before release."
        );
        fs::remove_file(&self.path)?;
        Ok(())
    }
}
impl Drop for OwnerLease {
    fn drop(&mut self) {
        // No child was ever launched: releasing this process's own unchanged lease
        // is safe. A spawned child's lock intentionally survives an unexpected drop.
        if self.state["childPid"].is_null() {
            if let Ok(Some(current)) = owned_state(&self.path) {
                if current["nonce"] == self.state["nonce"]
                    && fs::symlink_metadata(&self.path)
                        .ok()
                        .is_some_and(|m| FileIdentity::from_metadata(&m).same_inode(&self.identity))
                {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

#[async_trait]
pub trait Session: Send + Sync {
    async fn control(&self, request: Value) -> Result<Value>;
    async fn prepare_clear(&self, _old_id: &str, _uuid: &str) -> Result<()> {
        bail!("Native session does not support a correlated cold clear.")
    }
    async fn send(&self, message: Value) -> Result<()>;
    fn subscribe(&self) -> broadcast::Receiver<Value>;
    async fn status(&self) -> Value;
    async fn close(&self) -> Result<()>;
}
type PendingControls = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
pub struct CliSession {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    controls: PendingControls,
    events: broadcast::Sender<Value>,
    status: Arc<Mutex<Value>>,
}
fn native_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn native_zero(value: &Value) -> bool {
    value.is_number() && value.as_f64() == Some(0.0)
}
fn consume_identity(state: &mut Value, event: &Value, original: &str) {
    let expected = state["sessionId"].as_str().unwrap_or(original).to_owned();
    let Some(id) = event["session_id"].as_str() else {
        return;
    };
    if id == expected {
        return;
    }
    let mut keys = HashSet::new();
    if let Some(key) = event["user_message_uuid"].as_str() {
        keys.insert(key);
    }
    for key in event["user_message_uuids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        keys.insert(key);
    }
    let malformed = event
        .get("user_message_uuid")
        .is_some_and(|v| !v.is_string())
        || event
            .get("user_message_uuids")
            .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)));
    let transition = state["clearTransition"].clone();
    let clear = !malformed
        && transition["uuid"]
            .as_str()
            .is_some_and(|key| keys.contains(key));
    if transition.is_object() && event["type"] == "conversation_reset" && clear {
        return;
    }
    let init = event["type"] == "system" && event["subtype"] == "init";
    let receipt = event["type"] == "result"
        && clear
        && keys.len() == 1
        && event["subtype"] == "success"
        && !native_truthy(&event["is_error"])
        && event["local_command"] == "clear"
        && native_zero(&event["num_turns"])
        && native_zero(&event["duration_api_ms"])
        && native_zero(&event["total_cost_usd"]);
    if transition.is_object()
        && (init || receipt)
        && Uuid::parse_str(id).is_ok()
        && transition["oldId"] != id
        && (transition["target"].is_null() || transition["target"] == id)
    {
        state["clearTransition"]["target"] = json!(id);
        if init {
            state["clearTransition"]["init"] = json!(true);
        }
        if receipt {
            state["clearTransition"]["receipt"] = json!(true);
        }
        if state["clearTransition"]["init"] == true && state["clearTransition"]["receipt"] == true {
            state["sessionId"] = json!(id);
            state["clearTransition"] = Value::Null;
        }
        return;
    }
    state["nativeState"] = json!("unknown");
    state["identityUncertain"] = json!(true);
}
impl CliSession {
    pub async fn launch(
        binary: &Path,
        claude_home: &Path,
        cwd: &Path,
        id: &str,
        resume: bool,
        permission_mode: Option<&str>,
        lease: &mut OwnerLease,
        event_sink: Option<broadcast::Sender<Value>>,
        activity_suppressed: Arc<AtomicBool>,
        conversation_id: String,
        maintenance: bool,
    ) -> Result<Arc<Self>> {
        Uuid::parse_str(id)?;
        ensure!(
            fs::canonicalize(cwd)? == cwd,
            "Tracked working directory is unavailable or an alias."
        );
        let mut command = Command::new(binary);
        command.args([
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
        ]);
        if maintenance {
            command.args(["--setting-sources=","--strict-mcp-config","--mcp-config",r#"{"mcpServers":{}}"#,"--tools","","--settings",r#"{"remoteControlAtStartup":false,"crossSessionInbound":"refuse","disableAllHooks":true,"enabledPlugins":{}}"#]);
        } else {
            command.arg("--setting-sources=user,project,local");
        }
        command.arg(if resume {
            format!("--resume={id}")
        } else {
            format!("--session-id={id}")
        });
        if let Some(mode) = permission_mode.filter(|m| *m != "default") {
            command.args(["--permission-mode", mode]);
            if mode == "bypassPermissions" {
                ensure!(
                    storage::uid() != 0,
                    "Bypass permission mode is unavailable as root."
                );
                command.arg("--allow-dangerously-skip-permissions");
            }
        }
        let default = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join(".claude"));
        if default
            .as_ref()
            .is_some_and(|p| fs::canonicalize(p).ok() == fs::canonicalize(claude_home).ok())
        {
            command.env_remove("CLAUDE_CONFIG_DIR");
        } else {
            command.env("CLAUDE_CONFIG_DIR", claude_home);
        }
        command
            .env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
            .env_remove("NODE_OPTIONS")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn()?;
        lease.set_child(
            child
                .id()
                .ok_or_else(|| anyhow::anyhow!("Native owner has no child PID."))?,
        )?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (events, _) = broadcast::channel(4096);
        let controls: PendingControls = Arc::new(Mutex::new(HashMap::new()));
        let status = Arc::new(Mutex::new(
            json!({"nativeState":"unknown","backgroundTasks":[],"identityUncertain":false,"sessionId":id,"activityRevision":0,"everConnected":false}),
        ));
        let session = Arc::new(Self {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            controls: controls.clone(),
            events: events.clone(),
            status: status.clone(),
        });
        let expected = id.to_owned();
        let weak_session = Arc::downgrade(&session);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = vec![];
            let failure = loop {
                let available = match reader.fill_buf().await {
                    Ok(a) => a,
                    Err(_) => break "Native owner output failed.",
                };
                if available.is_empty() {
                    break "Native owner transport ended.";
                }
                let count = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(available.len());
                if buffer.len() + count > 64 * 1024 * 1024 {
                    break "Native owner frame exceeds its byte bound.";
                }
                buffer.extend_from_slice(&available[..count]);
                reader.consume(count);
                if buffer.last() != Some(&b'\n') {
                    continue;
                }
                let event = match serde_json::from_slice::<Value>(&buffer) {
                    Ok(v) => v,
                    Err(_) => break "Native owner emitted malformed JSON.",
                };
                buffer.clear();
                if event["type"] == "control_request" {
                    match control_reply(&event) {
                        Ok(Some(response)) => {
                            let Some(session) = weak_session.upgrade() else {
                                break "Native owner handle disappeared.";
                            };
                            if session.send(response).await.is_err() {
                                break "Native owner control response failed.";
                            }
                        }
                        Ok(None) => (),
                        Err(_) => break "Native owner emitted malformed control request.",
                    }
                    continue;
                }
                if event["type"] == "control_response" {
                    let response = &event["response"];
                    if let Some(id) = response["request_id"].as_str() {
                        if let Some(sender) = controls.lock().await.remove(id) {
                            let result = if response["subtype"] == "success" {
                                Ok(response["response"].clone())
                            } else {
                                Err(ControlRequestFailed.into())
                            };
                            let _ = sender.send(result);
                        }
                    }
                    continue;
                }
                {
                    let mut state = status.lock().await;
                    consume_identity(&mut state, &event, &expected);
                    if event["type"] == "system" && event["subtype"] == "bridge_state" {
                        state["everConnected"] = json!(true);
                    }
                    let suppressed = activity_suppressed.load(Ordering::Acquire);
                    if event["type"] == "system" && event["subtype"] == "session_state_changed" {
                        state["nativeState"] = event["state"].clone();
                        if event["state"] != "idle" && !suppressed {
                            let revision = state["activityRevision"].as_u64().unwrap_or(0) + 1;
                            state["activityRevision"] = json!(revision);
                        }
                    }
                    if event["type"] == "system" && event["subtype"] == "background_tasks_changed" {
                        state["backgroundTasks"] = event["tasks"].clone();
                        if !event["tasks"].as_array().is_some_and(Vec::is_empty) {
                            let revision = state["activityRevision"].as_u64().unwrap_or(0) + 1;
                            state["activityRevision"] = json!(revision);
                        }
                    }
                    if !suppressed
                        && matches!(
                            event["type"].as_str(),
                            Some("user" | "assistant" | "result")
                        )
                    {
                        let revision = state["activityRevision"].as_u64().unwrap_or(0) + 1;
                        state["activityRevision"] = json!(revision);
                    }
                }
                if let Some(sink) = &event_sink {
                    let _=sink.send(json!({"type":"claude_notification","conversationId":conversation_id,"sessionId":status.lock().await["sessionId"],"suppressed":activity_suppressed.load(Ordering::Acquire),"event":event}));
                }
                let _ = events.send(event);
            };
            status.lock().await["failure"] = json!(failure);
            let mut pending = controls.lock().await;
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(anyhow::anyhow!(failure)));
            }
        });
        Ok(session)
    }
}
#[async_trait]
impl Session for CliSession {
    async fn prepare_clear(&self, old_id: &str, uuid: &str) -> Result<()> {
        let mut state = self.status.lock().await;
        ensure!(
            state["sessionId"] == old_id
                && state["identityUncertain"] != true
                && state["nativeState"] == "idle"
                && state["clearTransition"].is_null(),
            "Native clear correlation is not idle or already reserved."
        );
        state["clearTransition"] =
            json!({"oldId":old_id,"uuid":uuid,"target":null,"init":false,"receipt":false});
        Ok(())
    }
    async fn control(&self, request: Value) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.controls.lock().await.insert(id.clone(), sender);
        if let Err(error) = self
            .send(json!({"type":"control_request","request_id":id,"request":request}))
            .await
        {
            self.controls.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => bail!("Native owner control transport ended; outcome unknown."),
            Err(_) => {
                self.controls.lock().await.remove(&id);
                bail!("Native owner control timed out; outcome unknown, never resend.")
            }
        }
    }
    async fn send(&self, message: Value) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let input = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Native owner input closed."))?;
        let mut bytes = claudex_core::json::stringify(&message)?.into_bytes();
        bytes.push(b'\n');
        input.write_all(&bytes).await?;
        input.flush().await?;
        Ok(())
    }
    fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
    async fn status(&self) -> Value {
        self.status.lock().await.clone()
    }
    async fn close(&self) -> Result<()> {
        let status = self.status().await;
        ensure!(
            status["nativeState"] == "idle"
                && status["identityUncertain"] == false
                && status["backgroundTasks"]
                    .as_array()
                    .is_some_and(Vec::is_empty),
            "Claude owner is busy; refusing to interrupt user work."
        );
        if let Some(mut stdin) = self.stdin.lock().await.take() {
            stdin.shutdown().await?;
        }
        let status = self.child.lock().await.wait().await?;
        ensure!(
            status.success(),
            "Native owner exited unsuccessfully during safe closure."
        );
        Ok(())
    }
}

pub struct Owner {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub claude_home: PathBuf,
    pub conversation_id: String,
    pub state_path: PathBuf,
    pub state: Value,
    pub transcript_path: PathBuf,
    pub session: Option<Arc<dyn Session>>,
    pub restart_required: bool,
    connected: bool,
    pub event_sink: Option<broadcast::Sender<Value>>,
    activity_suppressed: Arc<AtomicBool>,
    lease: Option<OwnerLease>,
    pub maintenance: bool,
    cold_verified: bool,
    clear_supported: bool,
    policy: Option<crate::maintenance_policy::PolicySnapshot>,
}
impl Owner {
    pub(crate) fn retire(root: &Path, record: &crate::desktop::Record) -> Result<()> {
        ensure!(
            record.side == crate::bridge::Side::Claude
                && record.managed
                && record.kind == "owner"
                && record.verified,
            "Only a verified owner may be retired for relocation."
        );
        let directory = root.join("owners");
        let path = directory.join(format!(
            "{}.json",
            digest_bytes(record.conversation_id.as_bytes())
        ));
        let retired = directory.join("retired").join(format!(
            "{}-{}.json",
            digest_bytes(record.conversation_id.as_bytes()),
            record.native_id
        ));
        let _lease = OwnerLease::acquire(&PathBuf::from(format!("{}.lock", path.display())))?;
        let saved = owned_state(&path)?;
        if saved
            .as_ref()
            .is_none_or(|s| s["sessionId"] != record.native_id)
        {
            ensure!(
                owned_state(&retired)?.is_some_and(|s| s["sessionId"] == record.native_id
                    && s["conversationId"] == record.conversation_id
                    && s["cwd"] == record.cwd),
                "Retired owner identity is missing or changed."
            );
            return Ok(());
        }
        let saved = saved.unwrap();
        ensure!(
            saved["version"] == 1
                && saved["conversationId"] == record.conversation_id
                && saved["cwd"] == record.cwd
                && saved["pending"].is_null()
                && saved["reset"].is_null(),
            "Owner state is transitioning or does not match its relocation."
        );
        let before = storage::read_stable(&path)?;
        ensure!(
            serde_json::from_slice::<Value>(&before.bytes)? == saved,
            "Owner state changed before retirement."
        );
        storage::private_directory(retired.parent().unwrap())?;
        storage::require_private_directory(retired.parent().unwrap())?;
        ensure!(
            matches!(fs::symlink_metadata(&retired),Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                && FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == before.identity,
            "Retired owner target exists or source changed."
        );
        fs::rename(&path, &retired)?;
        File::open(&directory)?.sync_all()?;
        File::open(retired.parent().unwrap())?.sync_all()?;
        Ok(())
    }
    pub fn open(
        root: &Path,
        cwd: &Path,
        claude_home: &Path,
        conversation_id: &str,
        title: &str,
    ) -> Result<Self> {
        Self::open_profile(root, cwd, claude_home, conversation_id, title, false)
    }
    pub fn open_maintenance(
        root: &Path,
        cwd: &Path,
        claude_home: &Path,
        conversation_id: &str,
        title: &str,
    ) -> Result<Self> {
        Self::open_profile(root, cwd, claude_home, conversation_id, title, true)
    }
    fn open_profile(
        root: &Path,
        cwd: &Path,
        claude_home: &Path,
        conversation_id: &str,
        title: &str,
        maintenance: bool,
    ) -> Result<Self> {
        ensure!(
            fs::canonicalize(cwd)? == cwd && fs::canonicalize(claude_home)? == claude_home,
            "Owner working directory or native home is unavailable or aliased."
        );
        let directory = root.join("owners");
        storage::private_directory(&directory)?;
        storage::require_private_directory(&directory)?;
        let state_path =
            directory.join(format!("{}.json", digest_bytes(conversation_id.as_bytes())));
        let lease = OwnerLease::acquire(&PathBuf::from(format!("{}.lock", state_path.display())))?;
        let mut state=owned_state(&state_path)?.unwrap_or_else(||json!({"version":1,"conversationId":conversation_id,"cwd":cwd,"claudeHome":claude_home,"sessionId":Uuid::new_v4().to_string(),"remoteId":null,"registration":null,"pending":null,"lastAppend":null,"displayTitle":title}));
        ensure!(
            state["version"] == 1
                && state["conversationId"] == conversation_id
                && state["cwd"] == json!(cwd)
                && state["claudeHome"] == json!(claude_home),
            "Owner state identity mismatch."
        );
        let id = state["sessionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing owner session identity."))?;
        let transcript_path = codecs::claude_path(claude_home, &cwd.to_string_lossy(), id)?;
        ensure!(
            state["reset"].is_null() || maintenance,
            "Pending native context reset requires maintenance recovery."
        );
        if state["blockedEngine"] == env!("CARGO_PKG_VERSION") && !state["blocked"].is_null() {
            bail!("Owner is blocked by an earlier native protocol failure.");
        }
        if let Some(map) = state.as_object_mut() {
            map.remove("blocked");
            map.remove("blockedEngine");
        }
        let suppressed = maintenance || !state["pending"].is_null() || !state["reset"].is_null();
        let mut owner = Self {
            root: root.into(),
            cwd: cwd.into(),
            claude_home: claude_home.into(),
            conversation_id: conversation_id.into(),
            state_path,
            state,
            transcript_path,
            session: None,
            restart_required: false,
            connected: false,
            event_sink: None,
            activity_suppressed: Arc::new(AtomicBool::new(suppressed)),
            lease: Some(lease),
            maintenance,
            cold_verified: false,
            clear_supported: false,
            policy: None,
        };
        let reset_options = crate::owner_reset::Options {
            claude_home: owner.claude_home.clone(),
            cwd: owner.cwd.clone(),
            receipt_timeout: Duration::from_secs(30),
        };
        crate::owner_reset::verify_retained(&reset_options, &owner.state)?;
        if !owner.state["reset"].is_null() {
            crate::owner_reset::validate_recovery(&reset_options, &owner.state)?;
        } else {
            owner.recover_remote()?;
        }
        owner.reconcile_pending()?;
        if maintenance && owner.state["reset"].is_null() {
            if let Some(raw) = owner.snapshot()? {
                crate::owner_reset::assert_cold_boundary(&raw, &owner.state)?;
            }
        }
        owner.save()?;
        Ok(owner)
    }
    pub fn save(&self) -> Result<()> {
        storage::write_json(&self.state_path, &self.state)
    }
    fn verify_maintenance_policy(&mut self) -> Result<()> {
        ensure!(
            self.maintenance,
            "Policy verification requires the cold maintenance profile."
        );
        let current = crate::maintenance_policy::read(&self.claude_home, &self.cwd)?;
        let previous = self.policy.as_ref().ok_or_else(|| {
            anyhow::anyhow!("Cold maintenance policy was not captured before launch.")
        })?;
        crate::maintenance_policy::verify(previous, &current)
    }
    pub fn snapshot(&self) -> Result<Option<storage::Snapshot>> {
        crate::owner_reset::verify_retained(
            &crate::owner_reset::Options {
                claude_home: self.claude_home.clone(),
                cwd: self.cwd.clone(),
                receipt_timeout: Duration::from_secs(30),
            },
            &self.state,
        )?;
        match storage::snapshot(&self.transcript_path) {
            Ok(mut data) => {
                ensure!(
                    data.file_identity.uid == storage::uid().to_string()
                        && data.file_identity.nlink == "1"
                        && data.file_identity.mode.parse::<u32>()? & 0o077 == 0,
                    "Owner transcript must be private and owned."
                );
                for row in &data.rows {
                    if let Some(id) = row["sessionId"].as_str() {
                        ensure!(
                            id == self.state["sessionId"].as_str().unwrap(),
                            "Owner transcript identity changed."
                        );
                    }
                    // Native tools can change cwd before their results and a
                    // later response are persisted. The owner state fixes the
                    // launch root; graph and checkpoint readers validate the
                    // logical history instead of relabeling native rows.
                }
                if let Some(bindings) = self.state.get("imageBindings") {
                    data.rows = crate::image_assets::restore(&self.root, &data.rows, bindings)?;
                    data.text = codecs::serialize_rows(&data.rows)?;
                }
                Ok(Some(data))
            }
            Err(e) if storage::is_not_found(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn recover_remote(&mut self) -> Result<()> {
        let transcript = self.snapshot()?;
        if transcript.is_none() {
            ensure!(
                self.state["remoteId"].is_null()
                    && self.state["lastAppend"].is_null()
                    && self.state["registration"] != "registered",
                "Owned native transcript missing; refusing empty restart."
            );
        }
        let ids: HashSet<_> = transcript
            .as_ref()
            .into_iter()
            .flat_map(|s| s.rows.iter())
            .filter(|r| r["type"] == "bridge-session" && r["sessionId"] == self.state["sessionId"])
            .map(|r| r["bridgeSessionId"].as_str().unwrap_or(""))
            .collect();
        ensure!(ids.len() <= 1, "Native Remote Control identity ambiguous.");
        if let Some(id) = ids.into_iter().next() {
            ensure!(valid_remote_id(id), "Invalid Remote Control identity.");
            ensure!(
                self.state["remoteId"].is_null() || self.state["remoteId"] == id,
                "Native Remote Control identity changed."
            );
            self.state["remoteId"] = json!(id);
            self.state["registration"] = json!("registered");
        }
        ensure!(
            self.state["registration"] != "registering" || !self.state["remoteId"].is_null(),
            "Remote registration outcome unknown; never allocate another remote conversation."
        );
        Ok(())
    }
    pub fn find_append(&mut self, intent: &Value) -> Result<bool> {
        let temp = std::env::var_os("CLAUDE_CODE_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    PathBuf::from("/tmp")
                } else {
                    std::env::temp_dir()
                }
            })
            .join(format!("claude-{}", storage::uid()));
        self.find_append_at(intent, &temp)
    }
    fn find_append_at(&mut self, intent: &Value, temp: &Path) -> Result<bool> {
        let Some(snapshot) = self.snapshot()? else {
            return Ok(false);
        };
        let matches: Vec<_> = snapshot
            .rows
            .iter()
            .filter(|r| r["uuid"] == intent["uuid"])
            .collect();
        if matches.is_empty() {
            return Ok(false);
        }
        ensure!(
            matches.len() == 1
                && matches[0]["type"] == "user"
                && matches[0]["sessionId"] == self.state["sessionId"]
                && matches[0]["message"]["role"] == "user"
                && matches[0]["queueTranscriptOnly"] == true,
            "Owned append native provenance mismatch."
        );
        ensure!(
            storage::hash_json(&normalize_content(&intent["content"])?)? == intent["contentHash"],
            "Durable append content changed."
        );
        if normalize_content(&matches[0]["message"]["content"])?
            != normalize_content(&intent["content"])?
        {
            ensure!(
                self.state["imageBindings"]
                    .get(intent["uuid"].as_str().unwrap_or(""))
                    .is_none(),
                "Previously bound native append content changed."
            );
            let (_, bindings) = crate::image_assets::capture(
                &self.root,
                temp,
                &self.cwd.to_string_lossy(),
                self.state["sessionId"].as_str().unwrap(),
                matches[0],
                &intent["content"],
                &intent["contentHash"],
                claudex_core::version::VersionPolicy::read(&self.root)?,
            )?;
            if self.state["imageBindings"].is_null() {
                self.state["imageBindings"] = json!({});
            }
            self.state["imageBindings"][intent["uuid"].as_str().unwrap()] = bindings;
            self.save()?;
        }
        Ok(true)
    }
    pub fn reconcile_pending(&mut self) -> Result<bool> {
        let pending = self.state["pending"].clone();
        if pending.is_null() {
            return Ok(false);
        }
        ensure!(
            matches!(pending["phase"].as_str(), Some("prepared" | "sent")),
            "Unknown owner pending phase."
        );
        if self.find_append(&pending)? {
            self.state["lastAppend"] = json!({"operationId":pending["operationId"],"uuid":pending["uuid"],"contentHash":pending["contentHash"],"content":pending["content"],"recovered":true});
            self.state["pending"] = Value::Null;
            self.activity_suppressed
                .store(self.maintenance, Ordering::Release);
            self.save()?;
            return Ok(true);
        }
        ensure!(
            pending["phase"] == "prepared",
            "Native append outcome unknown; intent preserved and never resent."
        );
        Ok(false)
    }
    pub async fn start(&mut self, binary: &Path, permission_mode: Option<&str>) -> Result<()> {
        ensure!(self.session.is_none(), "Owner already started.");
        if self.lease.is_none() {
            self.lease = Some(OwnerLease::acquire(&PathBuf::from(format!(
                "{}.lock",
                self.state_path.display()
            )))?);
        }
        let binary = checked_executable(
            binary,
            &self.cwd,
            claudex_core::version::VersionPolicy::read(&self.root)?,
        )
        .await?;
        if self.maintenance {
            self.policy = Some(crate::maintenance_policy::read(
                &self.claude_home,
                &self.cwd,
            )?);
        }
        let id = self.state["sessionId"].as_str().unwrap().to_owned();
        let session = CliSession::launch(
            &binary,
            &self.claude_home,
            &self.cwd,
            &id,
            self.transcript_path.exists(),
            permission_mode,
            self.lease.as_mut().unwrap(),
            self.event_sink.clone(),
            self.activity_suppressed.clone(),
            self.conversation_id.clone(),
            self.maintenance,
        )
        .await?;
        self.session = Some(session.clone());
        let initialized = session
            .control(json!({"subtype":"initialize","title":self.state["displayTitle"]}))
            .await?;
        session.status.lock().await["nativeState"] = initialized
            .get("session_state")
            .cloned()
            .unwrap_or(json!("idle"));
        self.clear_supported = initialized["commands"]
            .as_array()
            .is_some_and(|commands| commands.iter().any(|c| c["name"] == "clear"));
        if self.maintenance {
            let status = session.control(json!({"subtype":"mcp_status"})).await?;
            ensure!(
                status["mcpServers"].as_array().is_some_and(Vec::is_empty),
                "Cold maintenance requires an empty native MCP server inventory."
            );
            self.cold_verified = initialized["session_state"] == "idle";
        }
        if !self.state["remoteId"].is_null() && !self.maintenance {
            self.connect().await?;
        }
        Ok(())
    }
    pub async fn connect(&mut self) -> Result<()> {
        if self.connected {
            return Ok(());
        }
        ensure!(
            self.state["reset"].is_null(),
            "Context reset must be restored before Remote Control connection."
        );
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Owner not started."))?
            .clone();
        let previous = self.state["remoteId"].clone();
        let mut request =
            json!({"subtype":"remote_control","enabled":true,"keep_session_on_exit":true});
        if previous.is_null() {
            self.state["registration"] = json!("registering");
            self.save()?;
            request["name"] = self.state["displayTitle"].clone();
        } else {
            request["reattach_session_id"] = previous.clone();
        }
        let result = match session.control(request).await {
            Ok(result) => result,
            Err(error) => {
                if previous.is_null() && error.downcast_ref::<ControlRequestFailed>().is_some() {
                    self.state.as_object_mut().unwrap().remove("registration");
                    self.save()?;
                    self.restart_required = true;
                }
                return Err(error);
            }
        };
        let id = result["bridge_session_id"]
            .as_str()
            .filter(|s| valid_remote_id(s))
            .ok_or_else(|| anyhow::anyhow!("Native Remote Control returned invalid identity."))?;
        ensure!(
            previous.is_null() || previous == id,
            "Remote Control changed saved identity."
        );
        self.state["remoteId"] = json!(id);
        self.state["registration"] = json!("registered");
        self.save()?;
        self.connected = true;
        Ok(())
    }
    pub async fn assert_idle(&self) -> Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Owner is not running."))?;
        let status = session.status().await;
        ensure!(
            status["nativeState"] == "idle"
                && status["identityUncertain"] != true
                && status["backgroundTasks"]
                    .as_array()
                    .is_some_and(Vec::is_empty),
            "Claude owner is busy; refusing to interrupt user work."
        );
        Ok(())
    }
    pub async fn append(&mut self, operation_id: &str, content: &[Value]) -> Result<Value> {
        self.append_inner(operation_id, content, None).await
    }
    async fn append_inner(
        &mut self,
        operation_id: &str,
        content: &[Value],
        reset_operation: Option<&str>,
    ) -> Result<Value> {
        ensure!(
            self.state["reset"].is_null()
                || reset_operation.is_some_and(|id| self.state["reset"]["operationId"] == id),
            "Context reset must be restored before ordinary append."
        );
        self.assert_idle().await?;
        ensure!(
            !operation_id.is_empty() && operation_id.len() <= 256,
            "Invalid logical append identity."
        );
        for block in content {
            if block["type"] == "image" {
                packet::validate_image(block)?;
            } else {
                ensure!(
                    packet::exact_keys(block, &["type", "text"])
                        && block["type"] == "text"
                        && block["text"].as_str().is_some_and(|s| !s.trim().is_empty()),
                    "Owner append supports only nonempty text and inline images."
                );
            }
        }
        let content = json!(content);
        let content_hash = storage::hash_json(&normalize_content(&content)?)?;
        if self.state["lastAppend"]["operationId"] == operation_id {
            ensure!(
                self.state["lastAppend"]["contentHash"] == content_hash,
                "Append identity reused with different content."
            );
            let mut intent = self.state["lastAppend"].clone();
            if intent.get("content").is_none() {
                intent["content"] = content.clone();
            }
            ensure!(
                self.find_append(&intent)?,
                "Previously committed owner append missing."
            );
            return Ok(json!({"duplicate":true,"uuid":intent["uuid"]}));
        }
        if !self.state["pending"].is_null() {
            ensure!(
                self.state["pending"]["operationId"] == operation_id
                    && self.state["pending"]["contentHash"] == content_hash,
                "Different owner append remains pending."
            );
        } else {
            self.state["pending"] = json!({"operationId":operation_id,"uuid":append_uuid(self.state["sessionId"].as_str().unwrap(),operation_id),"contentHash":content_hash,"content":content,"phase":"prepared"});
            self.save()?;
        }
        self.activity_suppressed.store(true, Ordering::Release);
        if self.reconcile_pending()? {
            return Ok(json!({"duplicate":true,"uuid":self.state["lastAppend"]["uuid"]}));
        }
        let pending = self.state["pending"].clone();
        let session = self.session.as_ref().unwrap().clone();
        let mut events = session.subscribe();
        self.state["pending"]["phase"] = json!("sent");
        self.save()?;
        session.send(json!({"type":"user","uuid":pending["uuid"],"session_id":self.state["sessionId"],"parent_tool_use_id":null,"message":{"role":"user","content":content},"shouldQuery":false,"client_composed":true})).await?;
        let expected_id = self.state["sessionId"].clone();
        let receipt = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let event = events.recv().await?;
                if !event["session_id"].is_null() {
                    ensure!(
                        event["session_id"] == expected_id,
                        "Native owner event session identity mismatch."
                    );
                }
                let mut keys = HashSet::new();
                if let Some(id) = event["user_message_uuid"].as_str() {
                    keys.insert(id.to_owned());
                }
                if let Some(ids) = event["user_message_uuids"].as_array() {
                    for id in ids {
                        if let Some(id) = id.as_str() {
                            keys.insert(id.into());
                        }
                    }
                }
                if event["type"] == "result" && keys.contains(pending["uuid"].as_str().unwrap()) {
                    ensure!(
                        keys.len() == 1
                            && event["subtype"] == "success"
                            && !native_truthy(&event["is_error"])
                            && native_zero(&event["num_turns"])
                            && native_zero(&event["duration_api_ms"])
                            && event["total_cost_usd"]
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && n >= 0.0),
                        "No-query append received querying or ambiguous result."
                    );
                    return Ok::<_, anyhow::Error>(event);
                }
            }
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!("Owner append receipt timed out; durable sent intent preserved.")
        })??;
        ensure!(
            self.find_append(&pending)?,
            "No-query receipt lacks exact persisted native append."
        );
        self.state["lastAppend"] = json!({"operationId":operation_id,"uuid":pending["uuid"],"contentHash":content_hash,"content":content,"recovered":false});
        self.state["pending"] = Value::Null;
        self.save()?;
        self.activity_suppressed
            .store(self.maintenance, Ordering::Release);
        if !self.maintenance {
            self.connect().await?;
        }
        Ok(
            json!({"duplicate":false,"uuid":pending["uuid"],"cumulativeCost":receipt["total_cost_usd"]}),
        )
    }
    pub async fn close(&mut self) -> Result<()> {
        if let Some(session) = &self.session {
            self.assert_idle().await?;
            session.close().await?;
            self.session = None;
            self.connected = false;
        }
        if let Some(lease) = self.lease.take() {
            lease.release()?;
        }
        Ok(())
    }
}
#[async_trait]
impl crate::owner_reset::Host for Owner {
    fn state(&self) -> Value {
        self.state.clone()
    }
    fn save_state(&mut self, state: Value) -> Result<()> {
        let id = state["sessionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Reset owner identity missing."))?;
        self.transcript_path =
            codecs::claude_path(&self.claude_home, &self.cwd.to_string_lossy(), id)?;
        self.state = state;
        self.save()
    }
    fn session(&self) -> Arc<dyn Session> {
        self.session.as_ref().unwrap().clone()
    }
    fn clear_supported(&self) -> bool {
        self.clear_supported
    }
    async fn assert_safe(&self) -> Result<()> {
        ensure!(
            self.maintenance && self.cold_verified && !self.connected && self.lease.is_some(),
            "Context reset requires a fresh unexposed cold owner."
        );
        self.assert_idle().await?;
        let status = self.session.as_ref().unwrap().status().await;
        ensure!(
            status["everConnected"] != true
                && status["activityRevision"] == 0
                && status["failure"].is_null(),
            "Native activity or an exposed channel prevents cold reset."
        );
        Ok(())
    }
    async fn verify_policy(&mut self) -> Result<()> {
        self.verify_maintenance_policy()
    }
    async fn prepare_clear(&mut self, old: &str, uuid: &str) -> Result<()> {
        self.activity_suppressed.store(true, Ordering::Release);
        self.session
            .as_ref()
            .unwrap()
            .prepare_clear(old, uuid)
            .await
    }
    async fn append_reset(
        &mut self,
        operation: &str,
        content: &[Value],
        reset: &str,
    ) -> Result<Value> {
        self.append_inner(operation, content, Some(reset)).await
    }
    async fn has_append(&mut self, operation: &str, content: &[Value]) -> Result<bool> {
        let intent = json!({"operationId":operation,"uuid":append_uuid(self.state["sessionId"].as_str().unwrap(),operation),"content":content,"contentHash":storage::hash_json(&normalize_content(&json!(content))?)?});
        self.find_append(&intent)
    }
}
fn valid_remote_id(id: &str) -> bool {
    id.strip_prefix("cse_").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    })
}
pub(crate) fn normalize_content(content: &Value) -> Result<Value> {
    if let Some(text) = content.as_str() {
        return Ok(json!([{"type":"text","text":text}]));
    }
    let blocks = content
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Malformed native append content."))?;
    Ok(Value::Array(blocks.iter().map(|b|if b["type"]=="text"{json!({"type":"text","text":b["text"]})}else if b["type"]=="image"{json!({"type":"image","source":{"type":b["source"]["type"],"media_type":b["source"]["media_type"],"data":b["source"]["data"]}})}else{b.clone()}).collect()))
}
pub fn append_uuid(session: &str, operation: &str) -> String {
    let mut digits = digest_bytes(format!("{session}\0{operation}").as_bytes())[..32]
        .as_bytes()
        .to_vec();
    digits[12] = b'5';
    let n = (digits[16] as char).to_digit(16).unwrap();
    digits[16] = char::from_digit((n & 3) | 8, 16).unwrap() as u8;
    let s = String::from_utf8(digits).unwrap();
    format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn cold_clear_identity_adoption_requires_correlated_init_and_zero_query_receipt() {
        let old = Uuid::new_v4().to_string();
        let new = Uuid::new_v4().to_string();
        let init = json!({"type":"system","subtype":"init","session_id":new});
        let receipt = json!({"type":"result","subtype":"success","session_id":new,"user_message_uuid":"clear","local_command":"clear","num_turns":0.0,"duration_api_ms":0.0,"total_cost_usd":0.0});
        let original = json!({"sessionId":old,"nativeState":"idle","identityUncertain":false,"clearTransition":{"uuid":"clear","oldId":old,"target":null,"init":false,"receipt":false}});
        for reverse in [false, true] {
            let mut state = original.clone();
            let events = if reverse {
                [&receipt, &init]
            } else {
                [&init, &receipt]
            };
            consume_identity(&mut state, events[0], &old);
            assert_eq!(state["sessionId"], old);
            consume_identity(&mut state, events[1], &old);
            assert_eq!(state["sessionId"], new);
            assert_eq!(state["identityUncertain"], false);
        }
        let mut bad = receipt.clone();
        bad["user_message_uuids"] = json!(["clear", false]);
        let mut state = original.clone();
        consume_identity(&mut state, &bad, &old);
        assert_eq!(state["identityUncertain"], true);
        let mut bad = receipt;
        bad["is_error"] = json!("yes");
        let mut state = original;
        consume_identity(&mut state, &bad, &old);
        assert_eq!(state["identityUncertain"], true);
    }
    #[tokio::test]
    async fn relocation_retirement_is_durable_idempotent_and_keeps_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(temp.path())?;
        let cwd = storage::private_directory(root.join("project"))?;
        let home = storage::private_directory(root.join("claude"))?;
        let mut owner = Owner::open(&root, &cwd, &home, "move", "Title")?;
        let mut record = crate::desktop::Record::source(
            crate::bridge::Side::Claude,
            &owner.transcript_path,
            owner.state["sessionId"].as_str().unwrap(),
        );
        record.conversation_id = "move".into();
        record.cwd = cwd.to_string_lossy().into();
        record.managed = true;
        record.verified = true;
        record.kind = "owner".into();
        let saved = owner.state.clone();
        let state_path = owner.state_path.clone();
        assert!(Owner::retire(&root, &record).is_err());
        owner.close().await?;
        drop(owner);
        Owner::retire(&root, &record)?;
        assert!(!state_path.exists());
        let retired = root.join("owners/retired").join(format!(
            "{}-{}.json",
            digest_bytes(b"move"),
            record.native_id
        ));
        assert_eq!(owned_state(&retired)?.unwrap(), saved);
        Owner::retire(&root, &record)?;
        let mut replacement = Owner::open(&root, &cwd, &home, "move", "Title")?;
        let new_state = replacement.state.clone();
        assert_ne!(new_state["sessionId"], saved["sessionId"]);
        replacement.close().await?;
        drop(replacement);
        Owner::retire(&root, &record)?;
        assert_eq!(owned_state(&state_path)?.unwrap(), new_state);
        Ok(())
    }
    #[test]
    fn append_identity_is_stable_and_uuid_typed() {
        let a = append_uuid("session", "operation");
        assert_eq!(a, append_uuid("session", "operation"));
        assert_ne!(a, append_uuid("session", "other"));
        assert_eq!(Uuid::parse_str(&a).unwrap().get_version_num(), 5);
    }
    #[test]
    fn dead_owner_recovery_requires_absent_child_proof_and_single_reaper() {
        let tmp = tempfile::tempdir().unwrap();
        let root = storage::private_directory(tmp.path()).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("owner.lock");
        let old = json!({"pid":123,"childPid":null,"nonce":Uuid::new_v4().to_string()});
        storage::write_json(&path, &old).unwrap();
        assert!(OwnerLease::acquire_with(&path, &|_, _, _| Ok(true)).is_err());
        assert_eq!(storage::read_json(&path).unwrap(), old);
        let lease = OwnerLease::acquire_with(&path, &|value, _, _| {
            assert!(value.unwrap()["childPid"].is_null());
            Ok(false)
        })
        .unwrap();
        assert_ne!(lease.state["nonce"], old["nonce"]);
        assert!(!path.with_extension("lock.reap").exists());
        lease.release().unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn recent_empty_owner_lock_blocks_but_abandoned_publication_can_recover() {
        use std::time::SystemTime;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("owner.lock");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        assert!(OwnerLease::acquire_with(&path, &|_, _, _| Ok(false)).is_err());
        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(61)),
        )
        .unwrap();
        let lease = OwnerLease::acquire_with(&path, &|value, _, _| {
            assert!(value.is_none());
            Ok(false)
        })
        .unwrap();
        lease.release().unwrap();
    }
    #[tokio::test]
    async fn image_pending_survives_capture_failure_then_recovers_without_resend() -> Result<()> {
        let f = crate::image_assets::tests::fixture("image/png", false, true)?;
        let home = storage::private_directory(&f.temp.path().join("claude"))?;
        let mut owner = Owner::open(
            &f.root,
            Path::new(&f.cwd),
            &home,
            "image-recovery",
            "Images",
        )?;
        let mut row = f.row.clone();
        row["sessionId"] = owner.state["sessionId"].clone();
        let intent = json!({"phase":"sent","uuid":row["uuid"],"operationId":"image","content":f.expected,"contentHash":f.hash});
        owner.state["pending"] = intent.clone();
        owner.save()?;
        storage::private_directory(owner.transcript_path.parent().unwrap())?;
        storage::publish_exclusive(
            &owner.transcript_path,
            codecs::serialize_rows(&[row.clone()])?,
        )?;
        assert!(owner.find_append_at(&intent, &f.cache).is_err());
        assert_eq!(owner.state["pending"], intent);
        assert_eq!(storage::read_json(&owner.state_path)?["pending"], intent);
        let images = f
            .project
            .join(owner.state["sessionId"].as_str().unwrap())
            .join("images");
        storage::private_directory(&images)?;
        storage::publish_exclusive(images.join("1.png"), &f.original)?;
        assert!(owner.find_append_at(&intent, &f.cache)?);
        assert_eq!(owner.state["pending"], intent);
        let raw = storage::snapshot(&owner.transcript_path)?;
        assert!(owner.reconcile_pending()?);
        assert!(owner.state["pending"].is_null());
        assert_eq!(owner.state["lastAppend"]["recovered"], true);
        assert_eq!(storage::snapshot(&owner.transcript_path)?.hash, raw.hash);
        let path = owner.transcript_path.clone();
        owner.close().await?;
        drop(owner);
        fs::remove_file(images.join("1.png"))?;
        let mut reopened = Owner::open(
            &f.root,
            Path::new(&f.cwd),
            &home,
            "image-recovery",
            "Images",
        )?;
        assert_eq!(
            reopened.snapshot()?.unwrap().rows[0]["message"]["content"],
            f.expected
        );
        assert_eq!(storage::snapshot(path)?.hash, raw.hash);
        reopened.close().await?;
        Ok(())
    }
}
