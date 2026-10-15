//! Journaled cold /clear transitions. Native transcripts are read, never edited;
//! an uncertain sent operation cannot be retried or exposed through Remote Control.
use crate::{
    codecs,
    owner::{self, Session},
};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::broadcast;
use uuid::Uuid;

#[async_trait]
pub trait Host: Send {
    fn state(&self) -> Value;
    /// Persist atomically and update the native transcript path when sessionId changes.
    fn save_state(&mut self, state: Value) -> Result<()>;
    fn session(&self) -> Arc<dyn Session>;
    fn clear_supported(&self) -> bool;
    /// Require an unexposed, freshly started cold process, revision zero, idle,
    /// no background tasks, no failure and the original writer lease.
    async fn assert_safe(&self) -> Result<()>;
    async fn verify_policy(&mut self) -> Result<()>;
    /// Local-only correlation fence; this never writes native input.
    async fn prepare_clear(&mut self, old_id: &str, clear_uuid: &str) -> Result<()>;
    async fn append_reset(
        &mut self,
        operation: &str,
        content: &[Value],
        reset_operation: &str,
    ) -> Result<Value>;
    async fn has_append(&mut self, operation: &str, content: &[Value]) -> Result<bool>;
}
pub struct Options {
    pub claude_home: PathBuf,
    pub cwd: PathBuf,
    pub receipt_timeout: Duration,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    pub session_id: String,
    pub transcript_path: PathBuf,
    pub dev: u64,
    pub ino: u64,
    pub bytes: u64,
    pub hash: String,
    #[serde(default)]
    pub cost_checkpoint: Value,
    #[serde(default)]
    pub image_bindings: Value,
    #[serde(default)]
    pub last_append: Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sealed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_prefix: Option<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Prepared,
    Sent,
    Cleared,
    Restoring,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reset {
    operation_id: String,
    clear_uuid: String,
    restore_operation_id: String,
    phase: Phase,
    previous: Generation,
    remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    init_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<Receipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    uuid: String,
    session_id: String,
    local_command: String,
    num_turns: u64,
    api_ms: u64,
    cost: u64,
}
fn uuid(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|v| v.to_string().eq_ignore_ascii_case(id))
}
fn remote(id: &str) -> bool {
    id.strip_prefix("cse_").is_some_and(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    })
}
fn bounded_id(id: &str) -> bool {
    !id.is_empty() && id.encode_utf16().count() <= 256
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|v| v != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn scalar_equal(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}
fn zero(value: &Value) -> bool {
    value.is_number() && value.as_f64() == Some(0.0)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn generation_path(options: &Options, id: &str) -> Result<PathBuf> {
    codecs::claude_path(&options.claude_home, &options.cwd.to_string_lossy(), id)
}
fn raw(options: &Options, id: &str) -> Result<Snapshot> {
    let path = generation_path(options, id)?;
    let data = storage::snapshot(&path)?;
    ensure!(
        data.file_identity.uid == storage::uid().to_string()
            && data.file_identity.nlink == "1"
            && data.file_identity.mode.parse::<u32>()? & 0o077 == 0,
        "Retained native transcript must be private, owned and single-link."
    );
    Ok(data)
}
pub fn assert_cold_boundary(data: &Snapshot, state: &Value) -> Result<()> {
    let last = data.rows.iter().rev().find(|r| {
        !truthy(&r["isSidechain"])
            && !truthy(&r["isMeta"])
            && matches!(r["type"].as_str(), Some("user" | "assistant"))
    });
    ensure!(
        last.is_some_and(|r| r["type"] == "assistant"
            && matches!(
                r["message"]["stop_reason"].as_str(),
                Some("end_turn" | "stop_sequence")
            )
            || r["type"] == "user"
                && r["uuid"].is_string()
                && r["uuid"] == state["lastAppend"]["uuid"]),
        "Wait for a complete assistant turn or verified no-query append before cold context maintenance."
    );
    Ok(())
}
pub fn capture_generation(options: &Options, state: &Value) -> Result<Generation> {
    let id = state["sessionId"]
        .as_str()
        .filter(|s| uuid(s))
        .ok_or_else(|| anyhow::anyhow!("Invalid reset source session identity."))?;
    let data = raw(options, id)?;
    ensure!(
        data.bytes > 0,
        "Context reset requires an existing native transcript."
    );
    assert_cold_boundary(&data, state)?;
    let mut queued = 0i64;
    for row in data.rows.iter().filter(|r| r["type"] == "queue-operation") {
        ensure!(
            row["sessionId"] == id,
            "Native input queue session identity does not match reset source."
        );
        match row["operation"].as_str() {
            Some("enqueue") => queued += 1,
            Some("dequeue") => queued -= 1,
            _ => bail!("Native input queue history cannot authorize context reset."),
        }
        ensure!(
            queued >= 0,
            "Native input queue history is incomplete; context reset refused."
        );
    }
    ensure!(
        queued == 0,
        "Native input queue has unresolved work; context reset refused."
    );
    Ok(Generation {
        session_id: id.into(),
        transcript_path: generation_path(options, id)?,
        dev: data.file_identity.dev.parse()?,
        ino: data.file_identity.ino.parse()?,
        bytes: data.bytes,
        hash: data.hash,
        cost_checkpoint: data
            .rows
            .iter()
            .rev()
            .find(|r| r["type"] == "cost-state")
            .cloned()
            .unwrap_or(Value::Null),
        image_bindings: state.get("imageBindings").cloned().unwrap_or(json!({})),
        last_append: state["lastAppend"].clone(),
        sealed: false,
        original_prefix: None,
    })
}
fn verify(options: &Options, previous: &Generation, receipt: Option<&Receipt>) -> Result<Snapshot> {
    ensure!(
        uuid(&previous.session_id)
            && previous.transcript_path == generation_path(options, &previous.session_id)?
            && previous.bytes > 0
            && previous.bytes <= 9_007_199_254_740_991
            && hash(&previous.hash),
        "Invalid retained context-reset source identity."
    );
    let parent = previous.transcript_path.parent().unwrap();
    let directory = fs::symlink_metadata(parent)?;
    ensure!(
        directory.is_dir() && !directory.file_type().is_symlink(),
        "Retained native project directory is unsafe."
    );
    let data = raw(options, &previous.session_id)?;
    let bytes = data.text.as_bytes();
    let prefix = usize::try_from(previous.bytes)?;
    // A reboot can renumber st_dev. The live parent and file must still share
    // one volume; saved inode and exact content remain authoritative.
    ensure!(
        data.file_identity.dev == directory.dev().to_string()
            && data.file_identity.ino == previous.ino.to_string()
            && data.bytes >= previous.bytes
            && bytes.len() >= prefix
            && storage::hash_bytes(String::from_utf8_lossy(&bytes[..prefix]).as_bytes())
                == previous.hash,
        "The preserved context-reset source changed; concurrent history was retained."
    );
    let after = fs::symlink_metadata(parent)?;
    ensure!(
        directory.dev() == after.dev()
            && directory.ino() == after.ino()
            && directory.mode() == after.mode(),
        "Retained native project directory changed."
    );
    if data.bytes == previous.bytes {
        return Ok(data);
    }
    ensure!(
        !previous.sealed && receipt.is_some_and(|r| r.local_command == "clear"),
        "The preserved context-reset source changed; concurrent history was retained."
    );
    let tail = std::str::from_utf8(&bytes[prefix..])?
        .trim()
        .split('\n')
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        tail.len() >= 2
            && tail[0]["type"] == "queue-operation"
            && tail[0]["operation"] == "enqueue"
            && tail[0]["content"] == "/clear"
            && tail[1]["type"] == "queue-operation"
            && tail[1]["operation"] == "dequeue"
            && tail[1].get("content").is_none()
            && tail.iter().all(|r| r["sessionId"] == previous.session_id),
        "Preserved context-reset source changed outside its exact clear transport tail."
    );
    let (mut bridge, mut cost) = (false, false);
    for row in &tail[2..] {
        if row["type"] == "bridge-session"
            && !bridge
            && !cost
            && row["bridgeSessionId"] == ""
            && zero(&row["lastSequenceNum"])
        {
            bridge = true;
            continue;
        }
        if row["type"] == "cost-state" && !cost {
            let before = &previous.cost_checkpoint;
            for key in [
                "totalCostUSD",
                "totalAPIDuration",
                "totalAPIDurationWithoutRetries",
                "totalToolDuration",
                "totalLinesAdded",
                "totalLinesRemoved",
            ] {
                ensure!(
                    scalar_equal(
                        row.get(key).filter(|v| !v.is_null()).unwrap_or(&json!(0)),
                        before
                            .get(key)
                            .filter(|v| !v.is_null())
                            .unwrap_or(&json!(0))
                    ),
                    "Preserved context-reset source has unaccounted native usage."
                );
            }
            ensure!(
                storage::hash_json(
                    row.get("modelUsage")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&json!({}))
                )? == storage::hash_json(
                    before
                        .get("modelUsage")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&json!({}))
                )? && row
                    .get("hasUnknownModelCost")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&json!(false))
                    == before
                        .get("hasUnknownModelCost")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&json!(false)),
                "Preserved context-reset source has unaccounted native usage."
            );
            cost = true;
            continue;
        }
        bail!("Preserved context-reset source changed outside its exact clear transport tail.");
    }
    Ok(data)
}
pub fn verify_retained(options: &Options, state: &Value) -> Result<()> {
    if !state["retainedGeneration"].is_null() {
        verify(
            options,
            &serde_json::from_value(state["retainedGeneration"].clone())?,
            None,
        )?;
    }
    Ok(())
}
/// Read only the generation bound to this reset operation. This is a source
/// proof for coordinator recovery, never permission to resume a sent clear.
pub fn inspect_source(
    options: &Options,
    state: &Value,
    operation: &str,
    session: &str,
) -> Result<Snapshot> {
    ensure!(
        bounded_id(operation) && uuid(session),
        "Invalid reset source request."
    );
    if state["reset"]["operationId"] == operation {
        let reset: Reset = serde_json::from_value(state["reset"].clone())?;
        ensure!(
            reset.previous.session_id == session,
            "Reset source identity does not match its intent."
        );
        return verify(
            options,
            &reset.previous,
            if matches!(reset.phase, Phase::Cleared | Phase::Restoring) {
                reset.receipt.as_ref()
            } else {
                None
            },
        );
    }
    ensure!(
        state["lastReset"]["operationId"] == operation
            && state["lastReset"]["previousSessionId"] == session,
        "Reset source is not bound to this operation."
    );
    let previous: Generation = serde_json::from_value(state["retainedGeneration"].clone())?;
    ensure!(
        previous.session_id == session && previous.sealed,
        "Reset source lacks its sealed retained generation."
    );
    verify(options, &previous, None)
}
fn receipt_valid(reset: &Reset) -> bool {
    reset.receipt.as_ref().is_some_and(|r| {
        r.uuid == reset.clear_uuid
            && r.session_id == reset.target_session_id.as_deref().unwrap_or("")
            && r.local_command == "clear"
            && r.num_turns == 0
            && r.api_ms == 0
            && r.cost == 0
    })
}
pub fn validate_recovery(options: &Options, state: &Value) -> Result<()> {
    let reset: Reset = serde_json::from_value(state["reset"].clone())?;
    ensure!(
        bounded_id(&reset.operation_id)
            && uuid(&reset.clear_uuid)
            && remote(&reset.remote_id)
            && state["remoteId"] == reset.remote_id
            && bounded_id(&reset.restore_operation_id),
        "Invalid durable context-reset intent."
    );
    verify(
        options,
        &reset.previous,
        if matches!(reset.phase, Phase::Cleared | Phase::Restoring) {
            reset.receipt.as_ref()
        } else {
            None
        },
    )?;
    ensure!(
        reset.phase != Phase::Sent,
        "Context clear outcome is unknown; automatic resend and empty-session restart are refused."
    );
    if reset.phase == Phase::Prepared {
        ensure!(
            state["sessionId"] == reset.previous.session_id && state["pending"].is_null(),
            "Prepared context-reset identity is inconsistent."
        );
    } else {
        let id = reset.target_session_id.as_deref().unwrap_or("");
        ensure!(
            uuid(id)
                && id != reset.previous.session_id
                && reset.init_session_id.as_deref() == Some(id)
                && state["sessionId"] == id
                && receipt_valid(&reset),
            "Context-reset native identity lacks a verified no-query receipt and matching init."
        );
        ensure!(
            state["pending"].is_null()
                || state["pending"]["operationId"] == reset.restore_operation_id,
            "Context reset has an unrelated pending append."
        );
    }
    Ok(())
}
fn save(host: &mut dyn Host, reset: &Reset) -> Result<()> {
    let mut state = host.state();
    state["reset"] = serde_json::to_value(reset)?;
    host.save_state(state)
}
fn keys(event: &Value) -> Vec<Value> {
    let mut result = vec![];
    for key in std::iter::once(&event["user_message_uuid"])
        .chain(event["user_message_uuids"].as_array().into_iter().flatten())
    {
        if truthy(key) && !result.iter().any(|previous| scalar_equal(previous, key)) {
            result.push(key.clone());
        }
    }
    result
}
fn consume(reset: &mut Reset, event: &Value) -> Result<bool> {
    let keys = keys(event);
    let correlated = keys
        .iter()
        .any(|key| key.as_str() == Some(&reset.clear_uuid));
    if event["type"] == "conversation_reset" && correlated {
        return Ok(false);
    }
    let is_receipt = event["type"] == "result" && correlated;
    let is_init = event["type"] == "system" && event["subtype"] == "init";
    if !is_receipt && !is_init {
        return Ok(false);
    }
    if is_init
        && event["session_id"] == reset.previous.session_id
        && reset.target_session_id.is_none()
    {
        return Ok(false);
    }
    let id = event["session_id"]
        .as_str()
        .filter(|s| uuid(s) && *s != reset.previous.session_id)
        .ok_or_else(|| {
            anyhow::anyhow!("Context clear did not establish a new native session identity.")
        })?;
    if is_receipt {
        ensure!(
            keys.len() == 1
                && event["subtype"] == "success"
                && !truthy(&event["is_error"])
                && event["local_command"] == "clear"
                && zero(&event["num_turns"])
                && zero(&event["duration_api_ms"])
                && zero(&event["total_cost_usd"]),
            "Context clear received a querying or ambiguous result."
        );
        ensure!(
            reset.target_session_id.as_deref().is_none_or(|s| s == id),
            "Context clear returned conflicting native identities."
        );
        reset.target_session_id = Some(id.into());
        reset.receipt = Some(Receipt {
            uuid: reset.clear_uuid.clone(),
            session_id: id.into(),
            local_command: "clear".into(),
            num_turns: 0,
            api_ms: 0,
            cost: 0,
        });
    } else {
        ensure!(
            reset.init_session_id.as_deref().is_none_or(|s| s == id),
            "Context clear returned conflicting init identities."
        );
        reset.init_session_id = Some(id.into());
    }
    if let (Some(target), Some(init)) = (&reset.target_session_id, &reset.init_session_id) {
        ensure!(
            target == init,
            "Context clear receipt and native init identities disagree."
        );
        reset.phase = Phase::Cleared;
    }
    Ok(true)
}
async fn idle(
    session: &dyn Session,
    events: &mut broadcast::Receiver<Value>,
    duration: Duration,
) -> Result<()> {
    tokio::time::timeout(duration, async {
        loop {
            let status = session.status().await;
            ensure!(
                status["identityUncertain"] != true && status["failure"].is_null(),
                "Native context maintenance identity or transport is uncertain."
            );
            if status["nativeState"] == "idle" {
                return Ok::<_, anyhow::Error>(());
            }
            events.recv().await?;
        }
    })
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "Native context maintenance has not returned to idle; its state was preserved."
        )
    })?
}
pub async fn reset(
    host: &mut dyn Host,
    options: &Options,
    operation_id: &str,
    build: &(dyn Fn(&str) -> Result<Vec<Value>> + Send + Sync),
) -> Result<Value> {
    ensure!(
        bounded_id(operation_id),
        "Context reset requires a bounded operation identity."
    );
    let state = host.state();
    if state["lastReset"]["operationId"] == operation_id {
        ensure!(
            state["retainedGeneration"].is_object(),
            "Completed context reset is missing its retained native generation."
        );
        let id = state["lastReset"]["sessionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Completed context reset has no native identity."))?;
        let content = build(id)?;
        ensure!(
            host.has_append(
                state["lastReset"]["restoreOperationId"]
                    .as_str()
                    .unwrap_or(""),
                &content
            )
            .await?,
            "Completed context-reset bootstrap is missing or changed."
        );
        verify_retained(options, &host.state())?;
        let mut result = state["lastReset"].clone();
        result["duplicate"] = json!(true);
        return Ok(result);
    }
    ensure!(
        state["reset"].is_null() || state["reset"]["operationId"] == operation_id,
        "A different context-reset transaction must be resolved first."
    );
    ensure!(
        !state["reset"].is_null() || state["retainedGeneration"].is_null(),
        "A retained context generation needs verified retirement; another reset is refused."
    );
    ensure!(
        !state["reset"].is_null() || state["pending"].is_null(),
        "A durable append must be resolved before context reset."
    );
    let remote_id = state["remoteId"]
        .as_str()
        .filter(|s| remote(s))
        .ok_or_else(|| {
            anyhow::anyhow!("Context reset requires an existing stable Remote Control identity.")
        })?;
    host.assert_safe().await?;
    ensure!(
        host.clear_supported(),
        "Native runtime did not advertise the clear command."
    );
    let mut reset = if !state["reset"].is_null() {
        validate_recovery(options, &state)?;
        serde_json::from_value(state["reset"].clone())?
    } else {
        let previous = capture_generation(options, &state)?;
        let reset = Reset {
            operation_id: operation_id.into(),
            clear_uuid: owner::append_uuid(&previous.session_id, &format!("reset:{operation_id}")),
            restore_operation_id: format!(
                "restore:{}",
                storage::hash_bytes(operation_id.as_bytes())
            ),
            phase: Phase::Prepared,
            previous,
            remote_id: remote_id.into(),
            target_session_id: None,
            init_session_id: None,
            receipt: None,
            content_hash: None,
        };
        save(host, &reset)?;
        reset
    };
    verify(options, &reset.previous, reset.receipt.as_ref())?;
    let session = host.session();
    let mut events = session.subscribe();
    if reset.phase == Phase::Prepared {
        host.verify_policy().await?;
        host.assert_safe().await?;
        reset.phase = Phase::Sent;
        save(host, &reset)?;
        host.prepare_clear(&reset.previous.session_id, &reset.clear_uuid)
            .await?;
        if let Err(error) = host.assert_safe().await {
            reset.phase = Phase::Prepared;
            save(host, &reset)?;
            return Err(error);
        }
        session.send(json!({"type":"user","uuid":reset.clear_uuid,"session_id":reset.previous.session_id,"message":{"role":"user","content":"/clear"},"shouldQuery":false})).await?;
        tokio::time::timeout(options.receipt_timeout, async {
            while reset.phase == Phase::Sent {
                let event = events.recv().await?;
                if consume(&mut reset, &event)? {
                    let mut state = host.state();
                    state["reset"] = serde_json::to_value(&reset)?;
                    if reset.phase == Phase::Cleared {
                        state["sessionId"] = json!(reset.target_session_id);
                        state["lastAppend"] = Value::Null;
                        state["imageBindings"] = json!({});
                    }
                    host.save_state(state)?;
                }
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "Context clear receipt timed out; outcome remains pending without resend."
            )
        })??;
    }
    idle(session.as_ref(), &mut events, options.receipt_timeout).await?;
    verify(options, &reset.previous, reset.receipt.as_ref())?;
    host.assert_safe().await?;
    let content = build(reset.target_session_id.as_deref().unwrap())?;
    ensure!(
        !content.is_empty(),
        "Context-reset archive bootstrap cannot be empty."
    );
    for block in &content {
        if block["type"] == "image" {
            crate::packet::validate_image(block)?
        } else {
            ensure!(
                crate::packet::exact_keys(block, &["type", "text"])
                    && block["type"] == "text"
                    && block["text"].as_str().is_some_and(|s| !s.trim().is_empty()),
                "Context-reset archive bootstrap contains unsupported input."
            );
        }
    }
    let content_hash = storage::hash_json(&owner::normalize_content(&json!(content))?)?;
    ensure!(
        reset
            .content_hash
            .as_ref()
            .is_none_or(|s| *s == content_hash),
        "Context-reset archive builder returned different content."
    );
    reset.content_hash = Some(content_hash.clone());
    reset.phase = Phase::Restoring;
    save(host, &reset)?;
    host.assert_safe().await?;
    let restored = host
        .append_reset(&reset.restore_operation_id, &content, operation_id)
        .await?;
    idle(session.as_ref(), &mut events, options.receipt_timeout).await?;
    let previous = verify(options, &reset.previous, reset.receipt.as_ref())?;
    if !reset.previous.sealed {
        reset.previous.original_prefix =
            Some(json!({"bytes":reset.previous.bytes,"hash":reset.previous.hash}));
        reset.previous.bytes = previous.bytes;
        reset.previous.hash = previous.hash;
        reset.previous.sealed = true;
        save(host, &reset)?;
    }
    host.assert_safe().await?;
    let mut state = host.state();
    state["retainedGeneration"] = serde_json::to_value(&reset.previous)?;
    state["lastReset"] = json!({"operationId":operation_id,"previousSessionId":reset.previous.session_id,"sessionId":reset.target_session_id,"remoteId":reset.remote_id,"bootstrapUuid":restored["uuid"],"restoreOperationId":reset.restore_operation_id,"contentHash":content_hash,"recovered":restored["recovered"],"receipt":reset.receipt});
    state["reset"] = Value::Null;
    host.save_state(state)?;
    let mut result = host.state()["lastReset"].clone();
    result["duplicate"] = json!(false);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::OpenOptionsExt, sync::Mutex};

    // These writers implement the native protocol only inside a fresh fixture.
    // The production reset module never opens a native file for writing.
    fn append(path: &std::path::Path, row: &Value) -> Result<()> {
        storage::private_directory(path.parent().unwrap())?;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(path)?;
        writeln!(file, "{}", serde_json::to_string(row)?)?;
        Ok(())
    }
    struct FakeSession {
        state: Arc<Mutex<Value>>,
        events: broadcast::Sender<Value>,
        status: Mutex<Value>,
        faults: Mutex<Value>,
        sends: Mutex<Vec<Value>>,
        old: PathBuf,
        new: PathBuf,
        new_id: String,
    }
    #[async_trait]
    impl Session for FakeSession {
        async fn control(&self, _: Value) -> Result<Value> {
            bail!("Reset must not expose Remote Control.")
        }
        async fn send(&self, message: Value) -> Result<()> {
            self.sends.lock().unwrap().push(message.clone());
            let state = self.state.lock().unwrap().clone();
            assert_eq!(state["reset"]["phase"], "sent");
            assert_eq!(message["shouldQuery"], false);
            assert!(message.get("client_composed").is_none());
            assert_eq!(message["message"]["content"], "/clear");
            let faults = self.faults.lock().unwrap().clone();
            let old_id = message["session_id"].as_str().unwrap();
            append(
                &self.new,
                &json!({"type":"system","subtype":"fixture-init","sessionId":self.new_id}),
            )?;
            if faults["tail"] == true {
                for row in [
                    json!({"type":"queue-operation","operation":"enqueue","sessionId":old_id,"content":"/clear"}),
                    json!({"type":"queue-operation","operation":"dequeue","sessionId":old_id}),
                    json!({"type":"bridge-session","sessionId":old_id,"bridgeSessionId":"","lastSequenceNum":0.0}),
                    json!({"type":"cost-state","sessionId":old_id,"totalCostUSD":faults.get("cost").cloned().unwrap_or(json!(0.0)),"modelUsage":{},"hasUnknownModelCost":false}),
                ] {
                    append(&self.old, &row)?;
                }
            }
            if faults["modifyOld"] == true {
                append(
                    &self.old,
                    &json!({"type":"user","sessionId":old_id,"uuid":Uuid::new_v4(),"message":{"content":"Concurrent work"}}),
                )?;
            }
            if faults["dropClear"] == true {
                return Ok(());
            }
            let uuid = &message["uuid"];
            let _ = self
                .events
                .send(json!({"type":"system","subtype":"init","session_id":old_id}));
            let _ = self.events.send(json!({"type":"conversation_reset","session_id":old_id,"new_conversation_id":Uuid::new_v4(),"user_message_uuid":uuid}));
            let mut receipt = json!({"type":"result","subtype":"success","is_error":false,"local_command":"clear","session_id":self.new_id,"user_message_uuid":uuid,"user_message_uuids":[uuid],"num_turns":0.0,"duration_api_ms":0.0,"total_cost_usd":0.0});
            for (key, value) in faults["receipt"].as_object().into_iter().flatten() {
                receipt[key] = value.clone();
            }
            let init = json!({"type":"system","subtype":"init","session_id":if faults["wrongInit"] == true {Uuid::new_v4().to_string()} else {self.new_id.clone()}});
            if faults["initFirst"] == true {
                let _ = self.events.send(init.clone());
            }
            let _ = self.events.send(receipt);
            if faults["initFirst"] != true && faults["dropInit"] != true {
                let _ = self.events.send(init);
            }
            Ok(())
        }
        fn subscribe(&self) -> broadcast::Receiver<Value> {
            self.events.subscribe()
        }
        async fn status(&self) -> Value {
            self.status.lock().unwrap().clone()
        }
        async fn close(&self) -> Result<()> {
            Ok(())
        }
    }
    struct FakeHost {
        state: Arc<Mutex<Value>>,
        native: Arc<FakeSession>,
        options: Options,
        policy_ok: bool,
        safe: bool,
        advertised: bool,
        prepared: usize,
        appended: usize,
    }
    #[async_trait]
    impl Host for FakeHost {
        fn state(&self) -> Value {
            self.state.lock().unwrap().clone()
        }
        fn save_state(&mut self, state: Value) -> Result<()> {
            *self.state.lock().unwrap() = state;
            Ok(())
        }
        fn session(&self) -> Arc<dyn Session> {
            self.native.clone()
        }
        fn clear_supported(&self) -> bool {
            self.advertised
        }
        async fn assert_safe(&self) -> Result<()> {
            ensure!(self.safe, "Fixture owner is not cold and idle.");
            Ok(())
        }
        async fn verify_policy(&mut self) -> Result<()> {
            ensure!(self.policy_ok, "Policy changed after startup.");
            Ok(())
        }
        async fn prepare_clear(&mut self, old_id: &str, uuid: &str) -> Result<()> {
            assert_eq!(self.state()["reset"]["phase"], "sent");
            assert_eq!(self.state()["sessionId"], old_id);
            assert_eq!(self.state()["reset"]["clearUuid"], uuid);
            self.prepared += 1;
            Ok(())
        }
        async fn append_reset(
            &mut self,
            operation: &str,
            content: &[Value],
            reset_operation: &str,
        ) -> Result<Value> {
            assert_eq!(self.state()["reset"]["phase"], "restoring");
            assert_eq!(self.state()["reset"]["operationId"], reset_operation);
            let recovered = self.has_append(operation, content).await?;
            let mut state = self.state();
            let id = state["sessionId"].as_str().unwrap();
            let uuid = owner::append_uuid(id, operation);
            if !recovered {
                append(
                    &self.native.new,
                    &json!({"type":"user","sessionId":id,"uuid":uuid,"message":{"role":"user","content":content}}),
                )?;
                self.appended += 1;
            }
            if self.native.faults.lock().unwrap()["dropRestore"] == true {
                state["pending"] = json!({"operationId":operation});
                self.save_state(state)?;
                bail!("Fixture append receipt timed out.");
            }
            state["pending"] = Value::Null;
            state["lastAppend"] = json!({"operationId":operation,"uuid":uuid,"contentHash":storage::hash_json(&json!(content))?});
            self.save_state(state)?;
            Ok(json!({"uuid":uuid,"recovered":recovered}))
        }
        async fn has_append(&mut self, operation: &str, content: &[Value]) -> Result<bool> {
            let state = self.state();
            let id = state["sessionId"].as_str().unwrap();
            let path = generation_path(&self.options, id)?;
            let data = storage::snapshot(path)?;
            let uuid = owner::append_uuid(id, operation);
            Ok(data
                .rows
                .iter()
                .any(|row| row["uuid"] == uuid && row["message"]["content"] == json!(content)))
        }
    }
    fn fixture() -> Result<(tempfile::TempDir, FakeHost, Options)> {
        let temp = tempfile::tempdir()?;
        let cwd = temp.path().canonicalize()?;
        let home = cwd.join("claude");
        storage::private_directory(&home)?;
        let old_id = Uuid::new_v4().to_string();
        let new_id = Uuid::new_v4().to_string();
        let options = Options {
            claude_home: home.clone(),
            cwd: cwd.clone(),
            receipt_timeout: Duration::from_millis(30),
        };
        let old = generation_path(&options, &old_id)?;
        let new = generation_path(&options, &new_id)?;
        let last = Uuid::new_v4().to_string();
        append(
            &old,
            &json!({"type":"user","sessionId":old_id,"uuid":last,"message":{"role":"user","content":"Original checkpoint"}}),
        )?;
        let state = Arc::new(Mutex::new(
            json!({"sessionId":old_id,"remoteId":"cse_fixture","lastAppend":{"uuid":last},"imageBindings":{"fixture":"kept"}}),
        ));
        let native = Arc::new(FakeSession {
            state: state.clone(),
            events: broadcast::channel(32).0,
            status: Mutex::new(json!({"nativeState":"idle"})),
            faults: Mutex::new(json!({})),
            sends: Mutex::new(vec![]),
            old,
            new,
            new_id,
        });
        let host = FakeHost {
            state,
            native,
            options: Options {
                claude_home: home,
                cwd,
                receipt_timeout: options.receipt_timeout,
            },
            policy_ok: true,
            safe: true,
            advertised: true,
            prepared: 0,
            appended: 0,
        };
        Ok((temp, host, options))
    }
    fn build(id: &str) -> Result<Vec<Value>> {
        Ok(vec![
            json!({"type":"text","text":format!("Authenticated archive for {id}")}),
        ])
    }

    #[tokio::test]
    async fn reset_seals_original_uses_native_identity_and_deduplicates_without_exposing_remote()
    -> Result<()> {
        for init_first in [false, true] {
            let (_temp, mut host, options) = fixture()?;
            let original = fs::read(&host.native.old)?;
            host.native.faults.lock().unwrap()["initFirst"] = json!(init_first);
            let result = reset(&mut host, &options, "rotation-1", &build).await?;
            assert_eq!(result["sessionId"], host.native.new_id);
            assert_eq!(result["remoteId"], "cse_fixture");
            assert_eq!(result["receipt"]["localCommand"], "clear");
            assert_eq!(fs::read(&host.native.old)?, original);
            assert_eq!(
                inspect_source(
                    &options,
                    &host.state(),
                    "rotation-1",
                    result["previousSessionId"].as_str().unwrap()
                )?
                .text
                .as_bytes(),
                original
            );
            assert!(
                inspect_source(
                    &options,
                    &host.state(),
                    "different",
                    result["previousSessionId"].as_str().unwrap()
                )
                .is_err()
            );
            assert_eq!(host.state()["retainedGeneration"]["sealed"], true);
            assert_eq!(
                host.state()["retainedGeneration"]["imageBindings"],
                json!({"fixture":"kept"})
            );
            assert!(host.state()["reset"].is_null());
            assert_eq!(
                reset(&mut host, &options, "rotation-1", &build).await?["duplicate"],
                true
            );
            assert!(
                reset(&mut host, &options, "rotation-2", &build)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("retained context generation")
            );
            assert_eq!((host.prepared, host.appended), (1, 1));
            assert_eq!(host.native.sends.lock().unwrap().len(), 1);
        }
        Ok(())
    }
    #[tokio::test]
    async fn exact_clear_transport_tail_keeps_numeric_usage_semantics_and_seals_every_byte()
    -> Result<()> {
        let (_temp, mut host, options) = fixture()?;
        host.native.faults.lock().unwrap()["tail"] = json!(true);
        reset(&mut host, &options, "rotation", &build).await?;
        let state = host.state();
        assert!(
            state["retainedGeneration"]["bytes"].as_u64()
                > state["retainedGeneration"]["originalPrefix"]["bytes"].as_u64()
        );
        verify_retained(&options, &state)?;
        let mut changed_device = state.clone();
        changed_device["retainedGeneration"]["dev"] = json!(0);
        verify_retained(&options, &changed_device)?;
        append(
            &host.native.old,
            &json!({"type":"unknown-metadata","sessionId":state["retainedGeneration"]["sessionId"]}),
        )?;
        assert!(verify_retained(&options, &state).is_err());
        Ok(())
    }
    #[tokio::test]
    async fn querying_ambiguous_or_conflicting_clear_receipts_never_restore() -> Result<()> {
        for fault in [
            json!({"receipt":{"num_turns":1}}),
            json!({"receipt":{"is_error":"error"}}),
            json!({"receipt":{"user_message_uuids":[7]}}),
            json!({"wrongInit":true}),
        ] {
            let (_temp, mut host, options) = fixture()?;
            *host.native.faults.lock().unwrap() = fault;
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .is_err()
            );
            assert_eq!(host.state()["reset"]["phase"], "sent");
            assert_eq!(host.appended, 0);
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .is_err()
            );
            assert_eq!(host.native.sends.lock().unwrap().len(), 1);
        }
        Ok(())
    }
    #[tokio::test]
    async fn lost_receipt_or_missing_init_remains_sent_and_cannot_be_replayed() -> Result<()> {
        for fault in ["dropClear", "dropInit"] {
            let (_temp, mut host, options) = fixture()?;
            host.native.faults.lock().unwrap()[fault] = json!(true);
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("timed out")
            );
            assert!(
                validate_recovery(&options, &host.state())
                    .unwrap_err()
                    .to_string()
                    .contains("outcome is unknown")
            );
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .is_err()
            );
            assert_eq!(host.native.sends.lock().unwrap().len(), 1);
            assert_eq!(host.appended, 0);
        }
        Ok(())
    }
    #[tokio::test]
    async fn verified_clear_can_recover_builder_interruption_and_persisted_bootstrap_without_resend()
    -> Result<()> {
        let (_temp, mut host, options) = fixture()?;
        assert!(
            reset(&mut host, &options, "rotation", &|_| bail!(
                "Fixture builder interruption"
            ))
            .await
            .is_err()
        );
        assert_eq!(host.state()["reset"]["phase"], "cleared");
        validate_recovery(&options, &host.state())?;
        let previous = host.state()["reset"]["previous"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        inspect_source(&options, &host.state(), "rotation", &previous)?;
        host.native.faults.lock().unwrap()["dropRestore"] = json!(true);
        assert!(
            reset(&mut host, &options, "rotation", &build)
                .await
                .is_err()
        );
        assert_eq!(host.state()["reset"]["phase"], "restoring");
        validate_recovery(&options, &host.state())?;
        assert!(
            reset(&mut host, &options, "rotation", &|_| Ok(vec![
                json!({"type":"text","text":"Different archive"})
            ]))
            .await
            .unwrap_err()
            .to_string()
            .contains("different content")
        );
        host.native.faults.lock().unwrap()["dropRestore"] = json!(false);
        assert_eq!(
            reset(&mut host, &options, "rotation", &build).await?["recovered"],
            true
        );
        assert_eq!(host.native.sends.lock().unwrap().len(), 1);
        assert_eq!(host.appended, 1);
        Ok(())
    }
    #[tokio::test]
    async fn changed_source_or_unaccounted_usage_prevents_bootstrap() -> Result<()> {
        for fault in [json!({"modifyOld":true}), json!({"tail":true,"cost":1})] {
            let (_temp, mut host, options) = fixture()?;
            *host.native.faults.lock().unwrap() = fault;
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .is_err()
            );
            assert_eq!(host.appended, 0);
            assert!(validate_recovery(&options, &host.state()).is_err());
        }
        Ok(())
    }
    #[tokio::test]
    async fn policy_advertisement_and_cold_lease_fail_before_any_native_input() -> Result<()> {
        for failure in ["policy", "advertisement", "lease"] {
            let (_temp, mut host, options) = fixture()?;
            if failure == "policy" {
                host.policy_ok = false;
            }
            if failure == "advertisement" {
                host.advertised = false;
            }
            if failure == "lease" {
                host.safe = false;
            }
            assert!(
                reset(&mut host, &options, "rotation", &build)
                    .await
                    .is_err()
            );
            assert!(host.native.sends.lock().unwrap().is_empty());
            if failure == "policy" {
                assert_eq!(host.state()["reset"]["phase"], "prepared");
            }
        }
        Ok(())
    }
    #[test]
    fn incomplete_turns_and_unresolved_queues_do_not_authorize_cold_generation() -> Result<()> {
        let (_temp, mut host, options) = fixture()?;
        append(
            &host.native.old,
            &json!({"type":"user","sessionId":host.state()["sessionId"],"uuid":Uuid::new_v4(),"message":{"content":"Unfinished input"}}),
        )?;
        assert!(capture_generation(&options, &host.state()).is_err());
        append(
            &host.native.old,
            &json!({"type":"assistant","message":{"stop_reason":"end_turn"}}),
        )?;
        capture_generation(&options, &host.state())?;
        append(
            &host.native.old,
            &json!({"type":"queue-operation","sessionId":host.state()["sessionId"],"operation":"enqueue"}),
        )?;
        assert!(capture_generation(&options, &host.state()).is_err());
        let mut state = host.state();
        state["sessionId"] = json!("invalid");
        host.save_state(state)?;
        assert!(capture_generation(&options, &host.state()).is_err());
        Ok(())
    }
}
