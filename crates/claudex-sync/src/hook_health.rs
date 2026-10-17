//! Bounded content-free hook diagnostics. These files authorize no native work.
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::path::Path;

const PHASES: &[&str] = &["input", "origin_bind", "origin_recheck", "mailbox", "sync"];
const CODES: &[&str] = &[
    "INPUT_INVALID",
    "ORIGIN_UNVERIFIED",
    "COORDINATION_UNVERIFIED",
    "SYNC_EVENT_UNRECORDED",
    "REQUIRED_FILE_MISSING",
    "ACCESS_DENIED",
    "UNSAFE_STORAGE",
    "STORAGE_CHANGED",
    "BROKER_UNAVAILABLE",
    "BROKER_TIMEOUT",
    "MAILBOX_CAPACITY_EXHAUSTED",
];
fn keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
}
fn time(v: &Value) -> bool {
    v.as_u64()
        .is_some_and(|n| n > 0 && n <= 8_640_000_000_000_000)
}
fn count(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= 1_000_000_000)
}
fn error(v: &Value) -> bool {
    keys(v, &["at", "phase", "code"])
        && time(&v["at"])
        && v["phase"].as_str().is_some_and(|s| PHASES.contains(&s))
        && v["code"].as_str().is_some_and(|s| CODES.contains(&s))
}
fn optional(path: &Path, max: usize) -> Result<Option<Value>> {
    let data = match storage::read_stable(path) {
        Ok(d) => d,
        Err(e) if storage::is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    ensure!(
        data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && data.identity.mode.parse::<u32>()? & 0o7777 == 0o600
            && data.bytes.len() <= max,
        "Unsafe hook diagnostic storage."
    );
    Ok(Some(serde_json::from_slice(&data.bytes)?))
}
fn validate(v: &Value, provider: &str) -> Result<()> {
    ensure!(
        keys(
            v,
            &["version", "provider", "errorCount", "phases", "history"]
        ) && v["version"] == 1
            && v["provider"] == provider
            && count(&v["errorCount"])
            && keys(&v["phases"], PHASES)
            && v["history"]
                .as_array()
                .is_some_and(|a| a.len() <= 16 && a.iter().all(error)),
        "Invalid hook health diagnostics."
    );
    for (phase, entry) in v["phases"].as_object().unwrap() {
        ensure!(
            keys(entry, &["errorCount", "lastError", "recoveredAt"])
                && count(&entry["errorCount"])
                && entry["errorCount"].as_u64().unwrap() > 0
                && error(&entry["lastError"])
                && entry["lastError"]["phase"] == phase.as_str()
                && entry
                    .get("recoveredAt")
                    .is_none_or(|v| time(v) && v.as_u64() >= entry["lastError"]["at"].as_u64()),
            "Invalid hook health phase diagnostics."
        );
    }
    Ok(())
}
pub fn code(phase: &str, candidate: Option<&str>) -> &'static str {
    if let Some(code) =
        candidate.and_then(|candidate| CODES.iter().find(|code| **code == candidate))
    {
        return code;
    }
    match phase {
        "input" => "INPUT_INVALID",
        "origin_bind" | "origin_recheck" => "ORIGIN_UNVERIFIED",
        "mailbox" => "COORDINATION_UNVERIFIED",
        _ => "SYNC_EVENT_UNRECORDED",
    }
}
/// `error_code` is deliberately a code, never an error message or hook payload.
pub fn record(root: &Path, provider: &str, phase: &str, error_code: Option<&str>) -> Result<()> {
    ensure!(
        ["codex", "claude"].contains(&provider) && PHASES.contains(&phase),
        "Invalid hook health operation."
    );
    storage::private_directory(root)?;
    storage::require_private_directory(root)?;
    let path = root.join(format!("sync-hook-health-{provider}.json"));
    if error_code.is_none() && optional(&path, 16384)?.is_none() {
        return Ok(());
    }
    let at = storage::now_ms().max(1);
    let marker = json!({"at":at,"phase":phase,"code":code(phase,error_code)});
    let _lock = match FileLock::acquire(&path.with_extension("json.lock"), true) {
        Ok(lock) => lock,
        Err(e) => {
            if error_code.is_none() {
                return Ok(());
            }
            let incomplete = root.join(format!("sync-hook-health-{provider}-incomplete.json"));
            match optional(&incomplete, 256)? {
                Some(v) => ensure!(error(&v), "Invalid hook diagnostic marker."),
                None => storage::publish_exclusive(incomplete, serde_json::to_vec(&marker)?)?,
            }
            return Err(e);
        }
    };
    let mut v = optional(&path, 16384)?.unwrap_or_else(
        || json!({"version":1,"provider":provider,"errorCount":0,"phases":{},"history":[]}),
    );
    validate(&v, provider)?;
    if error_code.is_none() {
        if let Some(entry) = v["phases"].get_mut(phase) {
            if entry.get("recoveredAt").is_some() {
                return Ok(());
            }
            entry["recoveredAt"] = json!(at.max(entry["lastError"]["at"].as_i64().unwrap()));
        } else {
            return Ok(());
        }
    } else {
        v["errorCount"] = json!((v["errorCount"].as_u64().unwrap() + 1).min(1_000_000_000));
        let count = v["phases"][phase]["errorCount"].as_u64().unwrap_or(0);
        v["phases"][phase] = json!({"errorCount":(count+1).min(1_000_000_000),"lastError":marker});
        let history = v["history"].as_array_mut().unwrap();
        history.push(marker);
        if history.len() > 16 {
            history.drain(..history.len() - 16);
        }
    }
    ensure!(
        serde_json::to_vec(&v)?.len() <= 16384,
        "Hook health diagnostics exceed bound."
    );
    storage::write_json(path, &v)
}
pub fn read(root: &Path) -> Value {
    let mut out = json!({});
    for provider in ["codex", "claude"] {
        let result = (|| {
            let v = optional(
                &root.join(format!("sync-hook-health-{provider}.json")),
                16384,
            )?;
            let marker = optional(
                &root.join(format!("sync-hook-health-{provider}-incomplete.json")),
                256,
            )?;
            let mut result = if let Some(v) = v {
                validate(&v, provider)?;
                let mut v = v;
                v["state"] = json!("recorded");
                v
            } else {
                json!({"state":"missing"})
            };
            if let Some(marker) = marker {
                ensure!(error(&marker), "Invalid hook diagnostic marker.");
                result["incomplete"] = marker;
            }
            Ok::<_, anyhow::Error>(result)
        })();
        out[provider] =
            result.unwrap_or_else(|_| json!({"state":"unavailable","code":"HEALTH_UNAVAILABLE"}));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_retains_content_free_error_evidence() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir()?;
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(0o700))?;
        let root = std::fs::canonicalize(t.path())?;
        record(&root, "codex", "mailbox", Some("private arbitrary message"))?;
        record(&root, "codex", "mailbox", None)?;
        let health = read(&root);
        assert_eq!(
            health["codex"]["phases"]["mailbox"]["lastError"]["code"],
            "COORDINATION_UNVERIFIED"
        );
        assert!(health["codex"]["phases"]["mailbox"]["recoveredAt"].is_number());
        assert!(!serde_json::to_string(&health)?.contains("private arbitrary"));
        Ok(())
    }
}
