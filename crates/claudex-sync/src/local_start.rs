//! Native Local creation, with a durable single-use claim for each native action.
//! This journal retains the original pending/owner/seed; it never edits native files.
use crate::{
    codecs,
    desktop::{Pending, Record},
    desktop_mapping,
    history::digest_bytes,
    hooks, owner, packet,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
const LIMIT: usize = 2 * packet::MAX_PACKET_BYTES + 8 * 1024 * 1024;
const COMMAND: &str = "claudex-bootstrap";
fn read(path: &Path) -> Result<Value> {
    let f = storage::read_stable_with_limit(path, LIMIT)?;
    ensure!(
        f.identity.uid == storage::uid().to_string()
            && f.identity.nlink == "1"
            && f.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Native Local journal must be private, owned and single-link."
    );
    Ok(serde_json::from_slice(&f.bytes)?)
}
fn dir(root: &Path) -> Result<PathBuf> {
    storage::require_private_directory(root)?;
    ensure!(
        fs::canonicalize(root)? == root,
        "Native Local root is aliased."
    );
    let d = storage::private_directory(root.join("local-start"))?;
    storage::require_private_directory(&d)?;
    ensure!(
        fs::canonicalize(&d)? == d,
        "Native Local journal directory is aliased."
    );
    Ok(d)
}
fn path(root: &Path, op: &str) -> Result<PathBuf> {
    Uuid::parse_str(op)?;
    Ok(dir(root)?.join(format!("{op}.json")))
}
fn id(p: &Value, k: &str) -> Result<String> {
    let v = p[k]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Native Local identity missing."))?;
    Uuid::parse_str(v)?;
    Ok(v.into())
}
fn local(p: &Value) -> Result<()> {
    let s = p["sessionId"]
        .as_str()
        .and_then(|v| v.strip_prefix("local_"))
        .ok_or_else(|| anyhow::anyhow!("Native Local identity missing."))?;
    Uuid::parse_str(s)?;
    let cwd = p["cwd"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Native Local cwd missing."))?;
    ensure!(
        Path::new(cwd).is_absolute()
            && fs::canonicalize(cwd)? == Path::new(cwd)
            && Path::new(cwd).is_dir(),
        "Native Local cwd changed or is aliased."
    );
    Ok(())
}
fn journal(root: &Path, op: &str) -> Result<Value> {
    let j = read(&path(root, op)?)?;
    ensure!(
        j["version"] == 1 && j["opId"] == op && j["originalPending"]["operationId"] == op,
        "Invalid native Local journal."
    );
    id(&j, "opId")?;
    id(&j["originalOwner"], "sessionId")?;
    id(&j["originalOwner"], "conversationId")?;
    let pending: Pending = serde_json::from_value(j["originalPending"].clone())?;
    ensure!(
        pending.record.native_id == j["originalOwner"]["sessionId"]
            && pending.record.conversation_id == j["originalOwner"]["conversationId"]
            && pending.record.cwd == j["originalOwner"]["cwd"]
            && j["originalOwner"]["claudeHome"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute()),
        "Native Local retained owner identity changed."
    );
    Ok(j)
}
fn owner_path(root: &Path, j: &Value) -> PathBuf {
    root.join("owners").join(format!(
        "{}.json",
        digest_bytes(
            j["originalOwner"]["conversationId"]
                .as_str()
                .unwrap()
                .as_bytes()
        )
    ))
}
fn original_unchanged(j: &Value) -> Result<()> {
    if !j["originalIdentity"].is_null() {
        let p = j["originalPending"]["record"]["path"].as_str().unwrap();
        ensure!(
            json!(storage::read_stable_with_limit(p, LIMIT)?.identity) == j["originalIdentity"],
            "Original Local seed changed; pending preserved."
        );
    } else {
        let p = j["originalPending"]["record"]["path"].as_str().unwrap();
        ensure!(
            matches!(fs::symlink_metadata(p),Err(e) if e.kind()==std::io::ErrorKind::NotFound),
            "Fresh provisional Local identity acquired unexpected native content."
        );
    }
    Ok(())
}
fn original_native_clear(root: &Path, registry: &Path, j: &Value) -> Result<()> {
    let old = id(&j["originalOwner"], "sessionId")?;
    ensure!(
        desktop_mapping::mappings(registry, &[old.clone()])?.is_empty(),
        "Original Local seed already has a Desktop owner; recover that identity instead of creating another."
    );
    if !j["originalOwner"]["lastAppend"].is_null() {
        let resume_op = owner::append_uuid(
            &old,
            &format!("native-resume:{}", j["opId"].as_str().unwrap()),
        );
        let prior = root
            .join("local-adoption")
            .join(format!("{resume_op}.json"));
        let prior = match read(&prior) {
            Ok(v) => Some(v),
            Err(e) if storage::is_not_found(&e) => None,
            Err(e) => return Err(e),
        };
        if let Some(prior) = prior {
            ensure!(
                prior["version"] == 1
                    && prior["entry"]["opId"] == resume_op
                    && prior["entry"]["sourceOperationId"] == j["opId"]
                    && prior["entry"]["cliSessionId"] == old
                    && prior["entry"]["cwd"] == j["originalOwner"]["cwd"]
                    && prior["entry"]["conversationId"] == j["originalOwner"]["conversationId"],
                "Legacy Local adoption evidence changed."
            );
            ensure!(
                (prior["claim"].is_null() || prior["claim"]["outcome"]["outcome"] == "rejected")
                    && (prior["activation"].is_null()
                        || prior["activation"]["outcome"] == "rejected"),
                "Legacy Local native action was consumed; recover its exact outcome without creating another target."
            );
        }
    }
    Ok(())
}
fn authority(root: &Path, j: &Value) -> Result<()> {
    ensure!(
        !hooks::app_stopped(root)?,
        "Claudex application is stopped."
    );
    let ledger = read(&root.join("desktop-state.json"))?;
    let p = &ledger["pending"];
    ensure!(
        ledger["version"] == 2
            && p["operationId"] == j["opId"]
            && p["record"]["conversationId"] == j["originalPending"]["record"]["conversationId"]
            && p["record"]["cwd"] == j["originalPending"]["record"]["cwd"]
            && (p["record"] == j["originalPending"]["record"]
                || (!j["resolved"].is_null()
                    && p["record"]["nativeId"] == j["resolved"]["nativeId"])),
        "Native Local is not the current durable transaction."
    );
    let mut expected = j["originalPending"].clone();
    expected["record"] = p["record"].clone();
    expected["phase"] = p["phase"].clone();
    ensure!(
        expected == *p,
        "Native Local pending history or source changed."
    );
    let p = owner_path(root, j);
    ensure!(
        !PathBuf::from(format!("{}.lock", p.display())).try_exists()?,
        "Native Local owner still has a writer lease."
    );
    let o =
        owner::owned_state(&p)?.ok_or_else(|| anyhow::anyhow!("Native Local owner missing."))?;
    ensure!(
        o == j["originalOwner"] || (!j["newOwner"].is_null() && o == j["newOwner"]),
        "Native Local owner changed."
    );
    original_unchanged(j)
}
fn mapping(registry: &Path, j: &Value, cwd: &str) -> Result<Value> {
    let cli = id(&j["bootstrap"], "sessionId")?;
    let m = desktop_mapping::mappings(registry, &[cli.clone()])?;
    let m = m
        .get(&cli)
        .ok_or_else(|| anyhow::anyhow!("Awaiting native Local registry mapping."))?;
    ensure!(
        m["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && m["cwd"] == cwd
            && m["isArchived"] == false,
        "Native Local registry identity changed."
    );
    Ok(m.clone())
}
fn publish(root: &Path, j: &Value) -> Result<()> {
    let action = if j["prewarm"].is_null() || j["prewarm"]["outcome"].is_null() {
        Some("prewarm")
    } else if j["prewarm"]["outcome"] == "returned"
        && (j["start"].is_null() || j["start"]["outcome"].is_null())
    {
        Some("start")
    } else if !j["bootstrap"].is_null()
        && !j["mapping"].is_null()
        && (j["move"].is_null() || j["move"]["outcome"].is_null())
    {
        Some("move")
    } else {
        None
    };
    let entries = action.map(|stage| vec![json!({"opId":j["opId"],"stage":stage,
        "cwd":j["originalPending"]["record"]["cwd"],"title":j["originalOwner"]["displayTitle"],
        "prewarm":j["prewarm"]["result"],"bootstrap":j["bootstrap"],"mapping":j["mapping"],"command":COMMAND,"expiresAt":j["expiresAt"]})]).unwrap_or_default();
    storage::write_json(
        root.join("local-start-manifest.json"),
        &json!({"version":1,"entries":entries}),
    )
}
/// Called by the locked coordinator after closing any old SDK writer. Fresh
/// owners have no seed. Completed legacy seeds remain in the retained journal.
pub fn prepare(
    root: &Path,
    registry: &Path,
    o: &Value,
    r: &Record,
    p: &Pending,
) -> Result<Option<Record>> {
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let file = path(root, &p.operation_id)?;
    let mut j = match journal(root, &p.operation_id) {
        Ok(j) => j,
        Err(e) if storage::is_not_found(&e) => {
            ensure!(
                o["transport"] == "local-mod"
                    && o["remoteId"].is_null()
                    && o["pending"].is_null()
                    && o["reset"].is_null()
                    && o["sessionId"] == r.native_id
                    && o["cwd"] == r.cwd
                    && !p.reuse
                    && !r.verified,
                "Native Local bootstrap requires an exact new pending owner."
            );
            let identity = match storage::read_stable_with_limit(&r.path, LIMIT) {
                Ok(f) => {
                    ensure!(
                        !o["lastAppend"].is_null(),
                        "Unexpected native content in a fresh Local owner."
                    );
                    json!(f.identity)
                }
                Err(e) if storage::is_not_found(&e) && o["lastAppend"].is_null() => Value::Null,
                Err(e) => return Err(e),
            };
            json!({"version":1,"opId":p.operation_id,"originalPending":p,"originalOwner":o,"originalIdentity":identity,
                "prewarm":null,"start":null,"bootstrap":null,"move":null,"resolved":null,"newOwner":null,"mapping":null,"status":"prewarm-pending","expiresAt":storage::now_ms()+600_000})
        }
        Err(e) => return Err(e),
    };
    authority(root, &j)?;
    original_native_clear(root, registry, &j)?;
    if j["expiresAt"]
        .as_i64()
        .is_some_and(|v| v <= storage::now_ms())
    {
        j["expiresAt"] = json!(storage::now_ms() + 600_000);
    }
    if !j["bootstrap"].is_null() {
        let cli = id(&j["bootstrap"], "sessionId")?;
        let mappings = desktop_mapping::mappings(registry, &[cli.clone()])?;
        let native = mappings.get(&cli);
        if let Some(m) = native {
            ensure!(
                m["sessionId"] == j["prewarm"]["result"]["sessionId"] && m["isArchived"] == false,
                "Native Local registry identity changed."
            );
            ensure!(
                m["cwd"] == j["bootstrap"]["cwd"] || m["cwd"] == r.cwd,
                "Native Local moved to an unrelated workspace."
            );
            if m["cwd"] == j["bootstrap"]["cwd"] && j["move"].is_null() {
                j["mapping"] = m.clone();
            }
        }
        let target = r.cwd.as_str();
        if let Some(m) = native.filter(|m| m["cwd"] == target) {
            ensure!(
                !j["move"].is_null(),
                "Native Local moved without its durable claim."
            );
            let cli = id(&j["bootstrap"], "sessionId")?;
            let home = Path::new(j["originalOwner"]["claudeHome"].as_str().unwrap());
            let transcript = codecs::claude_path(home, target, &cli)?;
            let snapshot = storage::snapshot_with_limit(&transcript, LIMIT)?;
            ensure!(
                snapshot.file_identity.uid == storage::uid().to_string()
                    && snapshot.file_identity.nlink == "1"
                    && snapshot.file_identity.mode.parse::<u32>()? & 0o077 == 0
                    && snapshot
                        .rows
                        .iter()
                        .all(|r| r["sessionId"].is_null() || r["sessionId"] == cli),
                "Native Local target transcript ownership changed."
            );
            let scratch = codecs::claude_path(home, j["bootstrap"]["cwd"].as_str().unwrap(), &cli)?;
            ensure!(
                scratch == transcript || !scratch.try_exists()?,
                "Native Local transcript relocation is incomplete."
            );
            let clean = normalize_journal(&j, &snapshot.rows)?;
            if j["resolved"].is_null() {
                ensure!(
                    !clean
                        .iter()
                        .any(|r| matches!(r["type"].as_str(), Some("user" | "assistant"))),
                    "Native Local has independent content before packet delivery."
                );
                let mut record = r.clone();
                record.native_id = cli.clone();
                record.path = transcript;
                record
                    .extra
                    .insert("nativeStartOperation".into(), json!(p.operation_id));
                record.extra.insert("title".into(), m["title"].clone());
                let mut state = j["originalOwner"].clone();
                state["sessionId"] = json!(cli);
                state["localPhase"] = json!("adopted");
                state["lastAppend"] = Value::Null;
                state["registration"] = Value::Null;
                state["nativeStartOperation"] = json!(p.operation_id);
                j["resolved"] = json!(record);
                j["newOwner"] = state;
                j["status"] = json!("target-migrated");
                j["targetProof"] = json!({"mapping":m,"transcriptIdentity":snapshot.file_identity});
                // Write-ahead migration: either owner generation can recover a crash.
                storage::write_json(&file, &j)?;
            }
            storage::write_json(owner_path(root, &j), &j["newOwner"])?;
            publish(root, &j)?;
            return Ok(Some(serde_json::from_value(j["resolved"].clone())?));
        }
    }
    storage::write_json(&file, &j)?;
    publish(root, &j)?;
    Ok(None)
}
pub fn claim(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "stage", "proof"]),
        "Invalid native Local claim."
    );
    let op = id(p, "opId")?;
    let stage = p["stage"]
        .as_str()
        .filter(|s| ["prewarm", "start", "move"].contains(s))
        .ok_or_else(|| anyhow::anyhow!("Invalid native Local stage."))?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    authority(root, &j)?;
    original_native_clear(root, registry, &j)?;
    ensure!(
        j["expiresAt"]
            .as_i64()
            .is_some_and(|v| v > storage::now_ms()),
        "Native Local intent expired."
    );
    if !j[stage].is_null() {
        return Ok(json!({"ready":false}));
    }
    match stage {
        "prewarm" => ensure!(p["proof"] == json!({}), "Invalid native prewarm proof."),
        "start" => {
            ensure!(
                j["prewarm"]["outcome"] == "returned"
                    && p["proof"]
                        == json!({"sessionId":j["prewarm"]["result"]["sessionId"],"cwd":j["prewarm"]["result"]["cwd"],"command":COMMAND,"unique":true}),
                "Native bootstrap requires the exact live command catalogue."
            );
            local(&j["prewarm"]["result"])?;
        }
        "move" => {
            ensure!(
                !j["bootstrap"].is_null() && !j["start"].is_null(),
                "Native bootstrap receipt missing."
            );
            let m = mapping(registry, &j, j["bootstrap"]["cwd"].as_str().unwrap())?;
            ensure!(
                p["proof"]
                    == json!({"sessionId":m["sessionId"],"cliSessionId":j["bootstrap"]["sessionId"],"cwd":m["cwd"],"lastActivityAt":m["lastActivityAt"]}),
                "Native project move proof changed."
            );
        }
        _ => unreachable!(),
    }
    let claim = Uuid::new_v4().to_string();
    j[stage] =
        json!({"id":claim,"at":storage::now_ms(),"proof":p["proof"],"outcome":null,"result":null});
    j["status"] = json!(format!("{stage}-claimed"));
    storage::write_json(path(root, &op)?, &j)?;
    publish(root, &j)?;
    Ok(json!({"ready":true,"opId":op,"stage":stage,"claimId":claim}))
}
pub fn receipt(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "stage", "claimId", "outcome", "result"]),
        "Invalid native Local receipt."
    );
    let op = id(p, "opId")?;
    let stage = p["stage"]
        .as_str()
        .filter(|s| ["prewarm", "start", "move"].contains(s))
        .ok_or_else(|| anyhow::anyhow!("Invalid native Local stage."))?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    ensure!(
        p["claimId"].is_string()
            && p["claimId"] == j[stage]["id"]
            && matches!(
                p["outcome"].as_str(),
                Some("returned" | "unknown" | "rejected" | "needs_trust")
            ),
        "Native Local receipt does not match claim."
    );
    if p["outcome"] == "returned" {
        match stage {
            "prewarm" => {
                ensure!(
                    packet::exact_keys(&p["result"], &["sessionId", "cwd"]),
                    "Invalid native prewarm result."
                );
                local(&p["result"])?;
            }
            "start" => ensure!(
                p["result"] == json!({"sessionId":j["prewarm"]["result"]["sessionId"]}),
                "Native start changed prewarm identity."
            ),
            "move" => ensure!(
                p["result"] == json!({"status":"ok","cwd":j["originalPending"]["record"]["cwd"]}),
                "Native move changed target cwd."
            ),
            _ => unreachable!(),
        }
    } else {
        ensure!(
            p["result"].is_null(),
            "Unconfirmed native action cannot name a confirmed result."
        );
    }
    ensure!(
        j[stage]["outcome"].is_null()
            || (j[stage]["outcome"] == p["outcome"] && j[stage]["result"] == p["result"]),
        "Native Local receipt changed."
    );
    j[stage]["outcome"] = p["outcome"].clone();
    j[stage]["result"] = p["result"].clone();
    j["status"] = json!(format!("{stage}-{}", p["outcome"].as_str().unwrap()));
    storage::write_json(path(root, &op)?, &j)?;
    publish(root, &j)?;
    Ok(json!({"recorded":true}))
}
/// Called only by the registered no-query Mod command. No packet is returned.
pub fn bootstrap(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "claimId", "sessionId", "cwd", "pluginName"]),
        "Invalid native bootstrap receipt."
    );
    let op = id(p, "opId")?;
    id(p, "sessionId")?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    authority(root, &j)?;
    ensure!(
        p["claimId"].is_string()
            && p["claimId"] == j["start"]["id"]
            && p["cwd"] == j["prewarm"]["result"]["cwd"]
            && p["pluginName"].as_str().is_some_and(|s| !s.is_empty()
                && s.len() < 256
                && !s.chars().any(char::is_control)),
        "Native bootstrap context changed."
    );
    ensure!(
        j["bootstrap"].is_null() || j["bootstrap"] == *p,
        "Native bootstrap identity changed."
    );
    j["bootstrap"] = p.clone();
    j["status"] = json!("bootstrap-received");
    storage::write_json(path(root, &op)?, &j)?;
    publish(root, &j)?;
    Ok(json!({"recorded":true}))
}
/// Content-free delivery diagnostic. The same exact rows must prove the ACK;
/// this status never grants write authority or substitutes for promotion.
pub fn record_ack(root: &Path, op: &str, session: &str, rows: &[Value]) -> Result<()> {
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let mut j = journal(root, op)?;
    ensure!(
        j["resolved"]["nativeId"] == session && crate::local_sync::is_applied(root, op, rows)?,
        "Native Local ACK is not proven."
    );
    j["status"] = json!("packet-acknowledged");
    storage::write_json(path(root, op)?, &j)
}
/// The pending record remains old until the coordinator has verified the new
/// packet ACK. Only this retained, exact migration can authorize that target.
pub fn matches_pending(
    root: &Path,
    registry: &Path,
    pending: &Value,
    session: &Value,
) -> Result<bool> {
    let Some(op) = pending["operationId"].as_str() else {
        return Ok(false);
    };
    let j = match journal(root, op) {
        Ok(j) => j,
        Err(e) if storage::is_not_found(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    if j["resolved"].is_null() || j["resolved"]["nativeId"] != *session {
        return Ok(false);
    }
    authority(root, &j)?;
    original_native_clear(root, registry, &j)?;
    Ok(pending["record"] == j["originalPending"]["record"]
        || pending["record"]["nativeId"] == *session)
}
pub fn verify_resolution(root: &Path, old: &Record, new: &Record, p: &Pending) -> Result<bool> {
    if old.native_id == new.native_id {
        return Ok(false);
    }
    let j = journal(root, &p.operation_id)?;
    ensure!(
        j["originalPending"] == json!(p)
            && j["resolved"] == json!(new)
            && j["originalPending"]["record"] == json!(old),
        "Native Local target migration changed."
    );
    original_unchanged(&j)?;
    Ok(true)
}
fn normalize_journal(j: &Value, rows: &[Value]) -> Result<Vec<Value>> {
    ensure!(
        !j["bootstrap"].is_null(),
        "Native Local bootstrap receipt missing."
    );
    let args = format!(
        "{} {}",
        j["opId"].as_str().unwrap(),
        j["start"]["id"].as_str().unwrap()
    );
    let text = format!(
        "<command-name>/{COMMAND}</command-name>\n            <command-message>{COMMAND}</command-message>\n            <command-args>{args}</command-args>"
    );
    let candidates: Vec<_> = rows
        .iter()
        .filter(|r| {
            r["type"] == "user"
                && owner::normalize_content(&r["message"]["content"]).ok()
                    == Some(json!([{"type":"text","text":text}]))
        })
        .collect();
    ensure!(
        candidates.len() == 1,
        "Native Local bootstrap command missing or duplicated."
    );
    let proof = json!({"opId":j["opId"],"claim":{"id":j["start"]["id"]},"entry":{"inputUuid":candidates[0]["uuid"]},"content":[],"cwd":j["bootstrap"]["cwd"],"cliSessionId":j["bootstrap"]["sessionId"],"pluginName":j["bootstrap"]["pluginName"],"kind":"adopt","applied":{"textUuid":null}});
    let remove = crate::local_sync::verified_command(&proof, rows, COMMAND, "CLAUDEX_LOCAL_READY")?;
    Ok(rows
        .iter()
        .filter(|r| {
            !r["uuid"]
                .as_str()
                .is_some_and(|s| remove.iter().any(|v| v == s))
        })
        .cloned()
        .collect())
}
pub fn normalize(root: &Path, state: &Value, rows: &[Value]) -> Result<Vec<Value>> {
    let Some(op) = state["nativeStartOperation"].as_str() else {
        return Ok(rows.to_vec());
    };
    let j = journal(root, op)?;
    ensure!(
        j["resolved"]["nativeId"] == state["sessionId"] && !j["resolved"].is_null(),
        "Native Local bootstrap owner differs."
    );
    normalize_journal(&j, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        bridge::Side,
        desktop::{Checkpoint, Phase},
        history::Common,
    };
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        registry: PathBuf,
        home: PathBuf,
        scratch: PathBuf,
        record: Record,
        pending: Pending,
        state: Value,
        cli: String,
        local: String,
    }
    fn fixture(seed: bool) -> Result<Fixture> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        storage::private_directory(&root)?;
        let registry = storage::private_directory(root.join("registry"))?;
        let home = storage::private_directory(root.join("claude"))?;
        let cwd = storage::private_directory(root.join("project"))?;
        let scratch = storage::private_directory(root.join("scratch"))?;
        let session = Uuid::new_v4().to_string();
        let conversation = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let old = codecs::claude_path(&home, cwd.to_str().unwrap(), &session)?;
        let mut state = json!({"version":1,"sessionId":session,"conversationId":conversation,"claudeHome":home,"cwd":cwd,"transport":"local-mod","localPhase":if seed{"handoff-intent"}else{"native-start"},"remoteId":null,"registration":null,"pending":null,"reset":null,"lastAppend":null,"displayTitle":"Fixture"});
        if seed {
            let content = json!([{"type":"text","text":"Synthetic retained original"}]);
            let uuid = owner::append_uuid(&session, &operation);
            let row = json!({"type":"user","uuid":uuid,"sessionId":session,"cwd":cwd,"queueTranscriptOnly":true,"message":{"role":"user","content":content}});
            storage::private_directory(old.parent().unwrap())?;
            storage::atomic_write(&old, codecs::serialize_rows(&[row])?)?;
            state["lastAppend"] = json!({"operationId":operation,"uuid":uuid,"content":content,"contentHash":storage::hash_json(&content)?});
        }
        let mut record = Record::source(Side::Claude, &old, &session);
        record.cwd = cwd.to_string_lossy().into();
        record.conversation_id = conversation.clone();
        record.managed = true;
        record.kind = "owner".into();
        record.extra.insert("title".into(), json!("Fixture"));
        let pending = Pending {
            phase: Phase::Prepared,
            operation_id: operation,
            record: record.clone(),
            source_id: Uuid::new_v4().to_string(),
            target_id: None,
            archive_original_id: None,
            reuse: false,
            common: Common {
                meta: Default::default(),
                messages: vec![],
                extra: Default::default(),
            },
            checkpoint: Checkpoint::empty(),
            previous: Checkpoint::empty(),
            extra: Default::default(),
        };
        storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":pending}),
        )?;
        storage::private_directory(root.join("owners"))?;
        storage::write_json(
            root.join("owners")
                .join(format!("{}.json", digest_bytes(conversation.as_bytes()))),
            &state,
        )?;
        Ok(Fixture {
            _temp: temp,
            root,
            registry,
            home,
            scratch,
            record,
            pending,
            state,
            cli: Uuid::new_v4().to_string(),
            local: format!("local_{}", Uuid::new_v4()),
        })
    }
    fn entry(f: &Fixture) -> Result<Value> {
        Ok(read(&f.root.join("local-start-manifest.json"))?["entries"][0].clone())
    }
    fn begin(f: &Fixture, stage: &str) -> Result<Value> {
        let e = entry(f)?;
        assert_eq!(e["stage"], stage);
        let proof = match stage {
            "prewarm" => json!({}),
            "start" => json!({"sessionId":f.local,"cwd":f.scratch,"command":COMMAND,"unique":true}),
            "move" => {
                json!({"sessionId":f.local,"cliSessionId":f.cli,"cwd":f.scratch,"lastActivityAt":1})
            }
            _ => unreachable!(),
        };
        let p = json!({"opId":f.pending.operation_id,"stage":stage,"proof":proof});
        let c = claim(&f.root, &f.registry, &p)?;
        assert_eq!(c["ready"], true);
        // Actual publication must preserve the entry for the renderer's exact
        // post-claim check; an unchanged mock manifest hid this regression.
        assert_eq!(entry(f)?, e);
        assert_eq!(claim(&f.root, &f.registry, &p)?["ready"], false);
        Ok(c)
    }
    fn result(f: &Fixture, c: &Value, outcome: &str, result: Value) -> Result<()> {
        receipt(
            &f.root,
            &json!({"opId":f.pending.operation_id,"stage":c["stage"],"claimId":c["claimId"],"outcome":outcome,"result":result}),
        )?;
        Ok(())
    }
    fn registry(f: &Fixture, cwd: &Path) -> Result<()> {
        storage::write_json(
            f.registry.join(format!("{}.json", f.local)),
            &json!({"sessionId":f.local,"cliSessionId":f.cli,"cwd":cwd,"title":"Fixture","isArchived":false,"lastActivityAt":1}),
        )
    }
    fn bootstrap_rows(f: &Fixture, c: &Value) -> Vec<Value> {
        let caveat = Uuid::new_v4().to_string();
        let cmd = Uuid::new_v4().to_string();
        let stdout = Uuid::new_v4().to_string();
        let args = format!(
            "{} {}",
            f.pending.operation_id,
            c["claimId"].as_str().unwrap()
        );
        vec![
            json!({"type":"user","uuid":caveat,"isMeta":true,"sessionId":f.cli,"message":{"role":"user","content":"<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>"}}),
            json!({"type":"user","uuid":cmd,"parentUuid":caveat,"sessionId":f.cli,"cwd":f.scratch,"message":{"role":"user","content":format!("<command-name>/{COMMAND}</command-name>\n            <command-message>{COMMAND}</command-message>\n            <command-args>{args}</command-args>")}}),
            json!({"type":"system","uuid":stdout,"parentUuid":cmd,"subtype":"local_command","sessionId":f.cli,"commandRun":{"command":COMMAND,"args":args,"plugin":"claudex@inline"},"content":format!("<local-command-stdout>claudex@inline: CLAUDEX_LOCAL_READY {}</local-command-stdout>",f.pending.operation_id)}),
        ]
    }
    fn boot(f: &Fixture) -> Result<(Value, Vec<Value>)> {
        boot_outcome(f, "returned")
    }
    fn boot_outcome(f: &Fixture, start_outcome: &str) -> Result<(Value, Vec<Value>)> {
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_none());
        let c = begin(f, "prewarm")?;
        result(
            f,
            &c,
            "returned",
            json!({"sessionId":f.local,"cwd":f.scratch}),
        )?;
        let c = begin(f, "start")?;
        bootstrap(
            &f.root,
            &json!({"opId":f.pending.operation_id,"claimId":c["claimId"],"sessionId":f.cli,"cwd":f.scratch,"pluginName":"claudex@inline"}),
        )?;
        let rows = bootstrap_rows(f, &c);
        result(
            f,
            &c,
            start_outcome,
            if start_outcome == "returned" {
                json!({"sessionId":f.local})
            } else {
                Value::Null
            },
        )?;
        registry(f, &f.scratch)?;
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_none());
        let c = begin(f, "move")?;
        Ok((c, rows))
    }
    #[test]
    fn fresh_and_completed_legacy_seed_migrate_only_after_native_target_proofs() -> Result<()> {
        for seed in [false, true] {
            let f = fixture(seed)?;
            let original = fs::read(&f.record.path).ok();
            let (c, rows) = boot(&f)?;
            result(
                &f,
                &c,
                "returned",
                json!({"status":"ok","cwd":f.record.cwd}),
            )?;
            // A receipt alone is not native target ownership or transcript proof.
            assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_none());
            registry(&f, Path::new(&f.record.cwd))?;
            assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err());
            let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
            storage::private_directory(target.parent().unwrap())?;
            storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
            let r = prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.unwrap();
            assert_eq!(r.native_id, f.cli);
            assert_eq!(r.path, target);
            assert!(verify_resolution(&f.root, &f.record, &r, &f.pending)?);
            assert!(matches_pending(
                &f.root,
                &f.registry,
                &json!(f.pending),
                &json!(f.cli)
            )?);
            let j = journal(&f.root, &f.pending.operation_id)?;
            assert_eq!(j["originalPending"], json!(f.pending));
            assert_eq!(j["originalOwner"], f.state);
            assert_eq!(fs::read(&f.record.path).ok(), original);
            let state = owner::owned_state(&owner_path(&f.root, &j))?.unwrap();
            assert_eq!(state["sessionId"], f.cli);
            assert!(normalize(&f.root, &state, &rows)?.is_empty());
            assert_eq!(
                prepare(&f.root, &f.registry, &state, &f.record, &f.pending)?
                    .unwrap()
                    .native_id,
                f.cli
            );
            assert_eq!(
                read(&f.root.join("local-start-manifest.json"))?["entries"],
                json!([])
            );
        }
        Ok(())
    }
    #[test]
    fn lost_or_unknown_actions_never_reclaim_after_restart() -> Result<()> {
        for outcome in [None, Some("unknown")] {
            let f = fixture(false)?;
            prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
            let c = begin(&f, "prewarm")?;
            if let Some(o) = outcome {
                result(&f, &c, o, Value::Null)?;
            }
            assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_none());
            assert_eq!(
                claim(
                    &f.root,
                    &f.registry,
                    &json!({"opId":f.pending.operation_id,"stage":"prewarm","proof":{}})
                )?["ready"],
                false
            );
        }
        Ok(())
    }
    #[test]
    fn unknown_start_and_move_reconcile_only_independent_exact_native_proof() -> Result<()> {
        let f = fixture(false)?;
        let (c, rows) = boot_outcome(&f, "unknown")?;
        result(&f, &c, "unknown", Value::Null)?;
        registry(&f, Path::new(&f.record.cwd))?;
        let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
        storage::private_directory(target.parent().unwrap())?;
        storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_some());
        Ok(())
    }
    #[test]
    fn changed_owner_pending_seed_cwd_and_bootstrap_graph_refuse() -> Result<()> {
        let f = fixture(true)?;
        let (c, mut rows) = boot(&f)?;
        result(
            &f,
            &c,
            "returned",
            json!({"status":"ok","cwd":f.record.cwd}),
        )?;
        registry(&f, Path::new(&f.record.cwd))?;
        let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
        storage::private_directory(target.parent().unwrap())?;
        rows[2]["content"] = json!("mismatched native output");
        storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err());
        let old = fs::read(&f.record.path)?;
        storage::atomic_write(&f.record.path, old)?;
        assert!(
            claim(
                &f.root,
                &f.registry,
                &json!({"opId":f.pending.operation_id,"stage":"move","proof":{}})
            )
            .is_err()
        );
        Ok(())
    }
    #[test]
    fn no_packet_is_published_before_target_migration_and_actual_ack_stays_separate() -> Result<()>
    {
        let f = fixture(false)?;
        let (c, rows) = boot(&f)?;
        assert!(!f.root.join("local-sync-manifest.json").try_exists()?);
        result(
            &f,
            &c,
            "returned",
            json!({"status":"ok","cwd":f.record.cwd}),
        )?;
        registry(&f, Path::new(&f.record.cwd))?;
        let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
        storage::private_directory(target.parent().unwrap())?;
        storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
        let r = prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.unwrap();
        let content =
            vec![json!({"type":"text","text":"Synthetic packet only after native target proof"})];
        let op = crate::local_sync::prepare(&f.root, &f.registry, &r, &f.pending, &content, false)?;
        assert!(!crate::local_sync::is_applied(&f.root, &op, &rows)?);
        let e = read(&f.root.join("local-sync-manifest.json"))?["entries"][0].clone();
        let c = crate::local_sync::claim(
            &f.root,
            &f.registry,
            &json!({"opId":op,"localSessionId":f.local,"cliSessionId":f.cli,"cwd":f.record.cwd}),
        )?;
        assert_eq!(c["ready"], true);
        assert_eq!(e["cliSessionId"], f.cli);
        assert!(!crate::local_sync::is_applied(&f.root, &op, &rows)?);
        Ok(())
    }
    fn old_resume(f: &Fixture, claim: Value, activation: Value) -> Result<()> {
        let op = owner::append_uuid(
            &f.record.native_id,
            &format!("native-resume:{}", f.pending.operation_id),
        );
        let d = storage::private_directory(f.root.join("local-adoption"))?;
        storage::write_json(
            d.join(format!("{op}.json")),
            &json!({"version":1,"entry":{"opId":op,"sourceOperationId":f.pending.operation_id,"cliSessionId":f.record.native_id,"cwd":f.record.cwd,"conversationId":f.record.conversation_id},"claim":claim,"activation":activation}),
        )
    }
    #[test]
    fn existing_native_seed_mapping_prevents_initial_and_late_duplicate_creation() -> Result<()> {
        for initial in [true, false] {
            let f = fixture(true)?;
            if !initial {
                prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
            }
            let name = format!("local_{}", Uuid::new_v4());
            storage::write_json(
                f.registry.join(format!("{name}.json")),
                &json!({"sessionId":name,"cliSessionId":f.record.native_id,"cwd":f.record.cwd,"title":"Existing native seed owner","isArchived":false,"lastActivityAt":1}),
            )?;
            assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err());
            if !initial {
                assert!(
                    claim(
                        &f.root,
                        &f.registry,
                        &json!({"opId":f.pending.operation_id,"stage":"prewarm","proof":{}})
                    )
                    .is_err()
                );
                assert!(journal(&f.root, &f.pending.operation_id)?["prewarm"].is_null());
            }
        }
        Ok(())
    }
    #[test]
    fn consumed_legacy_resume_or_activation_cannot_be_replaced_by_a_new_target() -> Result<()> {
        for (claim_value, activation) in [
            (json!({"id":Uuid::new_v4(),"outcome":null}), Value::Null),
            (
                json!({"id":Uuid::new_v4(),"outcome":{"outcome":"unknown"}}),
                Value::Null,
            ),
            (
                json!({"id":Uuid::new_v4(),"outcome":{"outcome":"resumed"}}),
                Value::Null,
            ),
            (Value::Null, json!({"id":Uuid::new_v4(),"outcome":null})),
            (
                Value::Null,
                json!({"id":Uuid::new_v4(),"outcome":"unknown"}),
            ),
            (
                Value::Null,
                json!({"id":Uuid::new_v4(),"outcome":"returned"}),
            ),
        ] {
            let f = fixture(true)?;
            prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
            old_resume(&f, claim_value, activation)?;
            assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err());
            assert!(
                claim(
                    &f.root,
                    &f.registry,
                    &json!({"opId":f.pending.operation_id,"stage":"prewarm","proof":{}})
                )
                .is_err()
            );
            assert!(journal(&f.root, &f.pending.operation_id)?["prewarm"].is_null());
        }
        let f = fixture(true)?;
        old_resume(&f, Value::Null, Value::Null)?;
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.is_none());
        assert_eq!(begin(&f, "prewarm")?["ready"], true);
        Ok(())
    }
}
