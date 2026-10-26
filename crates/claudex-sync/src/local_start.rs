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
fn original_path(root: &Path, op: &str) -> Result<PathBuf> {
    Uuid::parse_str(op)?;
    Ok(dir(root)?.join(format!("{op}.json")))
}
fn path(root: &Path, op: &str) -> Result<PathBuf> {
    let original = original_path(root, op)?;
    let replacement = original.with_extension("prewarm-v2.json");
    if replacement.try_exists()? {
        Ok(replacement)
    } else {
        Ok(original)
    }
}
fn prewarm_proof() -> Value {
    json!({"options":{"cwd":"","message":"","useWorktree":false}})
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
        matches!(j["version"].as_u64(), Some(1 | 2))
            && j["opId"] == op
            && j["originalPending"]["operationId"] == op,
        "Invalid native Local journal."
    );
    if j["version"] == 2 {
        let original = original_path(root, op)?;
        ensure!(
            json!(storage::read_stable_with_limit(&original, LIMIT)?.identity)
                == j["supersedes"]["identity"],
            "Retained prewarm rejection journal changed."
        );
    }
    id(&j, "opId")?;
    id(&j["originalOwner"], "sessionId")?;
    id(&j["originalOwner"], "conversationId")?;
    let pending: Pending = serde_json::from_value(j["originalPending"].clone())?;
    if let Some(registry) = j.get("registryRoot") {
        ensure!(
            registry
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute()),
            "Native Local journal deployment registry is invalid."
        );
    }
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
    if let Some(bound) = j.get("registryRoot") {
        ensure!(
            *bound == json!(registry),
            "Native Local operation belongs to another Desktop deployment; original claims are preserved."
        );
    }
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
    authority_mode(root, j, false)
}
fn authority_mode(root: &Path, j: &Value, stopped: bool) -> Result<()> {
    ensure!(
        hooks::app_stopped(root)? == stopped,
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
    if action.is_some() {
        ensure!(
            j["registryRoot"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute()),
            "Legacy native Local action lacks a proven deployment registry; preserved action requires exact recovery evidence."
        );
    }
    let entries = action.map(|stage| vec![json!({"opId":j["opId"],"stage":stage,"registryRoot":j["registryRoot"],
        "cwd":j["originalPending"]["record"]["cwd"],"title":j["originalOwner"]["displayTitle"],
        "prewarm":j["prewarm"]["result"],"bootstrap":j["bootstrap"],"mapping":j["mapping"],"command":COMMAND,"expiresAt":j["expiresAt"]})]).unwrap_or_default();
    storage::write_json(
        root.join("local-start-manifest.json"),
        &json!({"version":3,"entries":entries}),
    )
}
/// Certify only the shipped v1 missing-message prewrite rejection. The caller
/// must verify the still-running native artifact and retained v1 renderer; this
/// does not replay an uncertain action or modify its original journal.
/// The ordinary coordinator lock and stopped state fence every other writer.
pub fn recover_prewarm(
    root: &Path,
    registry: &Path,
    certify: impl FnOnce(i64) -> Result<Value>,
) -> Result<Value> {
    let _coordinator = FileLock::acquire(root.join("desktop-operation.lock"), true)?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    ensure!(
        hooks::app_stopped(root)?,
        "Stop and drain Claudex before prewarm recovery."
    );
    let stopped = read(&root.join("app-stop.json"))?;
    ensure!(
        stopped["stopped"] == true && stopped["resuming"] != true,
        "Prewarm recovery requires a completed stop, not a resume."
    );
    let ledger = read(&root.join("desktop-state.json"))?;
    let op = id(&ledger["pending"], "operationId")?;
    let original = original_path(root, &op)?;
    let replacement = original.with_extension("prewarm-v2.json");
    if replacement.try_exists()? {
        let j = journal(root, &op)?;
        authority_mode(root, &j, true)?;
        original_native_clear(root, registry, &j)?;
        return Ok(json!({"recovered":true,"alreadyCertified":true,"opId":op}));
    }
    let saved = storage::read_stable_with_limit(&original, LIMIT)?;
    let mut j = journal(root, &op)?;
    authority_mode(root, &j, true)?;
    original_native_clear(root, registry, &j)?;
    ensure!(
        j["version"] == 1
            && j["prewarm"]["proof"] == json!({})
            && j["prewarm"]["outcome"] == "unknown"
            && j["prewarm"]["result"].is_null()
            && [
                "start",
                "bootstrap",
                "move",
                "mapping",
                "resolved",
                "newOwner",
                "targetProof"
            ]
            .iter()
            .all(|k| j[*k].is_null()),
        "Only an untouched v1 missing-message prewarm rejection can be certified."
    );
    id(&j["prewarm"], "id")?;
    let at = j["prewarm"]["at"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Prewarm claim timestamp missing."))?;
    let proof = certify(at)?;
    ensure!(
        proof["reason"] == "v1-missing-message-ipc-prewrite-rejection"
            && proof["options"] == json!({"cwd":"","useWorktree":false}),
        "Prewarm rejection certification is incomplete."
    );
    // Recheck exact originals/authority after potentially slow artifact inspection.
    ensure!(
        saved.identity == storage::read_stable_with_limit(&original, LIMIT)?.identity,
        "Original prewarm journal changed during certification."
    );
    authority_mode(root, &j, true)?;
    original_native_clear(root, registry, &j)?;
    j["supersedes"] = json!({"identity":saved.identity,"claim":j["prewarm"],"certification":proof});
    j["version"] = json!(2);
    j["registryRoot"] = json!(registry);
    j["prewarm"] = Value::Null;
    j["status"] = json!("prewarm-prewrite-rejection-certified");
    j["expiresAt"] = json!(storage::now_ms() + 600000);
    storage::write_json(&replacement, &j)?;
    // The namespace-bound manifest cannot be consumed by a legacy renderer. Startup
    // republishes the new intent after the corrected renderer is installed.
    publish(root, &j)?;
    Ok(json!({"recovered":true,"alreadyCertified":false,"opId":op}))
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
            json!({"version":1,"registryRoot":registry,"opId":p.operation_id,"originalPending":p,"originalOwner":o,"originalIdentity":identity,
                "prewarm":null,"start":null,"bootstrap":null,"move":null,"resolved":null,"newOwner":null,"mapping":null,"status":"prewarm-pending","expiresAt":storage::now_ms()+600_000})
        }
        Err(e) => return Err(e),
    };
    if j.get("registryRoot").is_none() {
        ensure!(
            j["prewarm"].is_null()
                || j["mapping"]["registryPath"]
                    .as_str()
                    .is_some_and(|path| Path::new(path).starts_with(registry)),
            "Legacy native Local action lacks a proven deployment registry; original claim is preserved."
        );
        j["registryRoot"] = json!(registry);
    }
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
    ensure!(
        j["registryRoot"] == json!(registry),
        "Native Local claim deployment differs from its saved namespace."
    );
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
        "prewarm" => ensure!(
            p["proof"] == prewarm_proof(),
            "Invalid native prewarm proof."
        ),
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
/// Recover only the retained creation identity, never an active writer lease.
pub(crate) fn deployment_mapping(root: &Path, record: &Record, operation: &str) -> Result<Value> {
    let j = journal(root, operation)?;
    let mapping = &j["targetProof"]["mapping"];
    ensure!(
        j["status"] == "packet-acknowledged"
            && j["resolved"]["nativeId"] == record.native_id
            && j["resolved"]["path"] == json!(record.path)
            && j["resolved"]["cwd"] == record.cwd
            && j["resolved"]["conversationId"] == record.conversation_id
            && j["newOwner"]["sessionId"] == record.native_id
            && mapping["nativeId"] == record.native_id
            && mapping["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && mapping["cwd"] == record.cwd
            && mapping["registryPath"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute()),
        "Saved native Local deployment lacks its complete creation and packet-ACK proof."
    );
    Ok(json!({"registryRoot":j["registryRoot"],"mapping":mapping}))
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
    let texts = [args.as_str(), ""]
        .map(|args| json!([{"type":"text","text":crate::local_sync::command_text(COMMAND, args)}]));
    let candidates: Vec<_> = rows
        .iter()
        .filter(|r| {
            r["type"] == "user"
                && owner::normalize_content(&r["message"]["content"])
                    .ok()
                    .is_some_and(|content| texts.contains(&content))
        })
        .collect();
    ensure!(
        candidates.len() == 1,
        "Native Local bootstrap command missing or duplicated."
    );
    let proof = json!({"opId":j["opId"],"claim":{"id":j["start"]["id"]},"entry":{"inputUuid":candidates[0]["uuid"]},"content":[],"cwd":j["bootstrap"]["cwd"],"cliSessionId":j["bootstrap"]["sessionId"],"pluginName":j["bootstrap"]["pluginName"],"kind":"adopt","applied":{"textUuid":null}});
    let mut remove =
        crate::local_sync::verified_command(&proof, rows, COMMAND, "CLAUDEX_LOCAL_READY")?;
    // changeCwd records its new project environment as a transcript-only user
    // context, not an independently authored prompt. Bind that one native row
    // to the claimed move and bootstrap completion before excluding it from
    // portable dialogue. The original transcript, including CLAUDE.md, stays whole.
    if !j["move"].is_null() {
        let cwd = j["originalPending"]["record"]["cwd"].as_str().unwrap();
        let contexts: Vec<_> = rows
            .iter()
            .filter(|r| {
                r["type"] == "user"
                    && r["message"]["role"] == "user"
                    && r["isMeta"] == true
                    && r["queueTranscriptOnly"] == true
                    && r["queueSkipSlashCommands"] == true
                    && r["queueSkipAttachments"] == true
                    && r["sessionId"] == j["bootstrap"]["sessionId"]
                    && r["cwd"] == cwd
                    && r["parentUuid"] == remove[2]
                    && r["message"]["content"].as_str().is_some_and(|s| {
                        [false, true].into_iter().any(|stale| {
                            let note = move_context(cwd, stale);
                            s == note
                                || s.strip_prefix(&note).is_some_and(|s| s.starts_with("\n\n"))
                        })
                    })
            })
            .collect();
        ensure!(contexts.len() <= 1, "Native Local move context duplicated.");
        if let Some(context) = contexts.first() {
            let uuid = id(context, "uuid")?;
            ensure!(
                rows.iter().filter(|r| r["uuid"] == uuid).count() == 1,
                "Native Local move context identity duplicated."
            );
            // Resuming this native moved, no-query bootstrap may record one
            // zero-usage placeholder before the first packet. Its direct
            // journal-proven context parent, session and cwd distinguish it
            // from real assistant output or an unrelated synthetic record.
            let placeholders: Vec<_> = rows
                .iter()
                .filter(|r| {
                    r["type"] == "assistant"
                        && r["message"]["role"] == "assistant"
                        && r["parentUuid"] == uuid
                        && r["sessionId"] == j["bootstrap"]["sessionId"]
                        && r["cwd"] == cwd
                        && r["message"]["model"] == "<synthetic>"
                        && r["message"]["stop_reason"] == "stop_sequence"
                        && r["message"]["content"]
                            == json!([{"type":"text","text":"No response requested."}])
                        && r["message"]["usage"].as_object().is_some_and(|usage| {
                            usage.get("input_tokens") == Some(&json!(0))
                                && usage.get("output_tokens") == Some(&json!(0))
                                && ["cache_read_input_tokens", "cache_creation_input_tokens"]
                                    .iter()
                                    .all(|field| {
                                        usage
                                            .get(*field)
                                            .is_none_or(|v| v.is_null() || v == &json!(0))
                                    })
                        })
                })
                .collect();
            ensure!(
                placeholders.len() <= 1,
                "Native Local bootstrap placeholder duplicated."
            );
            if let Some(placeholder) = placeholders.first() {
                remove.push(id(placeholder, "uuid")?);
            }
            remove.push(uuid);
        }
    }
    crate::local_sync::without_transport_rows(rows, &remove)
}
fn move_context(cwd: &str, stale: bool) -> String {
    let stale = if stale {
        "The environment block at the start of this conversation still names the previous directory — that information is stale. "
    } else {
        ""
    };
    format!(
        "<system-reminder>\nThe session's working directory has changed to {cwd} (by the user). {stale}All tool calls and relative paths now resolve from {cwd}. Project settings (permission rules, hooks), project MCP servers, and project skills now come from {cwd}; its CLAUDE.md, if any, follows below. Environment variables set by the previous directory's settings stay in effect for this process — they cannot be unset — and the new directory's settings env is applied on top of them.\n</system-reminder>"
    )
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
    fn legacy_unknown(f: &Fixture) -> Result<PathBuf> {
        prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
        let file = original_path(&f.root, &f.pending.operation_id)?;
        let mut j = read(&file)?;
        j["prewarm"] = json!({"id":Uuid::new_v4(),"at":storage::now_ms()-10000,
            "proof":{},"outcome":"unknown","result":null});
        j["status"] = json!("prewarm-unknown");
        storage::write_json(&file, &j)?;
        storage::write_json(
            f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        Ok(file)
    }
    fn certification(_: i64) -> Result<Value> {
        Ok(json!({"reason":"v1-missing-message-ipc-prewrite-rejection",
            "options":{"cwd":"","useWorktree":false},"synthetic":true}))
    }
    #[test]
    fn namespace_bound_manifest_and_claim_never_borrow_another_deployment() -> Result<()> {
        let f = fixture(false)?;
        prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
        let manifest = read(&f.root.join("local-start-manifest.json"))?;
        assert_eq!(manifest["version"], 3);
        assert_eq!(manifest["entries"][0]["registryRoot"], json!(f.registry));
        let file = original_path(&f.root, &f.pending.operation_id)?;
        let before = storage::read_stable(&file)?;
        let other = storage::private_directory(f.root.join("other-registry"))?;
        assert!(prepare(&f.root, &other, &f.state, &f.record, &f.pending).is_err());
        assert!(
            claim(
                &f.root,
                &other,
                &json!({"opId":f.pending.operation_id,"stage":"prewarm","proof":prewarm_proof()})
            )
            .is_err()
        );
        assert_eq!(storage::read_stable(&file)?.identity, before.identity);
        assert_eq!(read(&f.root.join("local-start-manifest.json"))?, manifest);
        Ok(())
    }
    #[test]
    fn unclaimed_legacy_pending_binds_once_through_normal_preparation() -> Result<()> {
        let f = fixture(false)?;
        prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
        let file = original_path(&f.root, &f.pending.operation_id)?;
        let mut legacy = read(&file)?;
        legacy.as_object_mut().unwrap().remove("registryRoot");
        storage::write_json(&file, &legacy)?;
        let other = storage::private_directory(f.root.join("gateway-registry"))?;

        assert!(prepare(&f.root, &other, &f.state, &f.record, &f.pending)?.is_none());
        let mut expected = legacy;
        expected["registryRoot"] = json!(other);
        assert_eq!(read(&file)?, expected);
        let manifest = read(&f.root.join("local-start-manifest.json"))?;
        assert_eq!(manifest["version"], 3);
        assert_eq!(manifest["entries"][0]["registryRoot"], json!(other));
        assert_eq!(manifest["entries"][0]["stage"], "prewarm");
        assert_eq!(
            read(&f.root.join("desktop-state.json"))?["pending"],
            json!(f.pending)
        );

        let claim = claim(
            &f.root,
            &other,
            &json!({"opId":f.pending.operation_id,"stage":"prewarm","proof":prewarm_proof()}),
        )?;
        assert_eq!(claim["ready"], true);
        let saved = storage::read_stable(&file)?;
        assert!(prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err());
        assert_eq!(storage::read_stable(&file)?.identity, saved.identity);
        assert_eq!(read(&f.root.join("local-start-manifest.json"))?, manifest);
        Ok(())
    }
    #[test]
    fn claimed_legacy_prewarm_without_mapping_never_binds_a_selected_registry() -> Result<()> {
        let f = fixture(false)?;
        prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?;
        begin(&f, "prewarm")?;
        let file = original_path(&f.root, &f.pending.operation_id)?;
        let mut legacy = read(&file)?;
        legacy.as_object_mut().unwrap().remove("registryRoot");
        storage::write_json(&file, &legacy)?;
        let saved = storage::read_stable(&file)?;
        let manifest = read(&f.root.join("local-start-manifest.json"))?;
        let other = storage::private_directory(f.root.join("gateway-registry"))?;
        assert!(prepare(&f.root, &other, &f.state, &f.record, &f.pending).is_err());
        assert_eq!(storage::read_stable(&file)?.identity, saved.identity);
        assert_eq!(read(&f.root.join("local-start-manifest.json"))?, manifest);
        Ok(())
    }
    #[test]
    fn certified_prewrite_rejection_retains_original_and_issues_a_separate_corrected_claim()
    -> Result<()> {
        let f = fixture(true)?;
        let original = legacy_unknown(&f)?;
        let saved = storage::read_stable(&original)?;
        let first = recover_prewarm(&f.root, &f.registry, certification)?;
        assert_eq!(first["alreadyCertified"], false);
        let retained = storage::read_stable(&original)?;
        assert_eq!(saved.bytes, retained.bytes);
        assert_eq!(saved.identity, retained.identity);
        assert_eq!(
            read(&f.root.join("local-start-manifest.json"))?["version"],
            3
        );
        assert_eq!(
            recover_prewarm(&f.root, &f.registry, |_| panic!(
                "certification must be idempotent"
            ))?["alreadyCertified"],
            true
        );
        storage::write_json(
            f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )?;
        let c = begin(&f, "prewarm")?;
        assert_eq!(
            journal(&f.root, &f.pending.operation_id)?["prewarm"]["proof"],
            prewarm_proof()
        );
        result(&f, &c, "unknown", Value::Null)?;
        assert!(recover_prewarm(&f.root, &f.registry, certification).is_err());
        assert_eq!(read(&original)?["prewarm"]["outcome"], "unknown");
        storage::write_json(&original, &read(&original)?)?;
        assert!(journal(&f.root, &f.pending.operation_id).is_err());
        Ok(())
    }
    #[test]
    fn certification_failure_or_changed_authority_never_creates_a_replacement() -> Result<()> {
        for change in ["source", "pending", "owner", "later", "options", "running"] {
            let f = fixture(true)?;
            let original = legacy_unknown(&f)?;
            match change {
                "pending" => {
                    let mut v = read(&f.root.join("desktop-state.json"))?;
                    v["pending"]["sourceId"] = json!(Uuid::new_v4());
                    storage::write_json(f.root.join("desktop-state.json"), &v)?;
                }
                "owner" => {
                    let j = read(&original)?;
                    let p = owner_path(&f.root, &j);
                    let mut v = read(&p)?;
                    v["displayTitle"] = json!("Changed");
                    storage::write_json(p, &v)?;
                }
                "later" | "options" => {
                    let mut j = read(&original)?;
                    if change == "later" {
                        j["start"] = json!({"outcome":"unknown"});
                    } else {
                        j["prewarm"]["proof"] = prewarm_proof();
                    }
                    storage::write_json(&original, &j)?;
                }
                "running" => storage::write_json(
                    f.root.join("app-stop.json"),
                    &json!({"version":1,"stopped":false}),
                )?,
                _ => {}
            }
            let saved = storage::read_stable(&original)?;
            assert!(
                recover_prewarm(&f.root, &f.registry, |at| {
                    if change == "source" {
                        anyhow::bail!("Source/process proof changed");
                    }
                    certification(at)
                })
                .is_err(),
                "{change}"
            );
            assert!(!original.with_extension("prewarm-v2.json").try_exists()?);
            assert_eq!(saved.identity, storage::read_stable(&original)?.identity);
        }
        Ok(())
    }
    fn entry(f: &Fixture) -> Result<Value> {
        Ok(read(&f.root.join("local-start-manifest.json"))?["entries"][0].clone())
    }
    fn begin(f: &Fixture, stage: &str) -> Result<Value> {
        let e = entry(f)?;
        assert_eq!(e["stage"], stage);
        let proof = match stage {
            "prewarm" => prewarm_proof(),
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
    fn moved_context(f: &Fixture, parent: &Value) -> Value {
        json!({"type":"user","uuid":Uuid::new_v4(),"parentUuid":parent,"sessionId":f.cli,"cwd":f.record.cwd,
            "isMeta":true,"queueTranscriptOnly":true,"queueSkipSlashCommands":true,"queueSkipAttachments":true,
            "message":{"role":"user","content":move_context(&f.record.cwd, true)}})
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
    fn native_move_after_trust_verifies_withheld_bootstrap_arguments_without_replay() -> Result<()>
    {
        let f = fixture(true)?;
        let original = storage::read_stable(&f.record.path)?;
        let (c, mut rows) = boot(&f)?;
        result(&f, &c, "needs_trust", Value::Null)?;
        rows[1]["message"]["content"] = json!(crate::local_sync::command_text(COMMAND, ""));
        rows[2]["commandRun"]["args"] = json!("");
        rows.push(moved_context(&f, &rows[2]["uuid"]));
        let retained = journal(&f.root, &f.pending.operation_id)?;
        registry(&f, Path::new(&f.record.cwd))?;
        let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
        storage::private_directory(target.parent().unwrap())?;
        storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
        let native = storage::read_stable(&target)?;
        let r = prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending)?.unwrap();
        let migrated = journal(&f.root, &f.pending.operation_id)?;
        for key in [
            "originalPending",
            "originalOwner",
            "prewarm",
            "start",
            "bootstrap",
            "move",
        ] {
            assert_eq!(retained[key], migrated[key], "{key}");
        }
        assert_eq!(migrated["status"], "target-migrated");
        assert_eq!(migrated["move"]["outcome"], "needs_trust");
        assert_eq!(r.native_id, f.cli);
        assert!(verify_resolution(&f.root, &f.record, &r, &f.pending)?);
        assert!(normalize_journal(&migrated, &rows)?.is_empty());
        for stale in [false, true] {
            for suffix in [
                "",
                "\n\n<system-reminder>\nSynthetic project CLAUDE.md context.\n</system-reminder>",
            ] {
                let mut variant = rows.clone();
                variant[3]["message"]["content"] =
                    json!(format!("{}{suffix}", move_context(&f.record.cwd, stale)));
                assert!(normalize_journal(&migrated, &variant)?.is_empty());
            }
        }
        assert_eq!(
            original.identity,
            storage::read_stable(&f.record.path)?.identity
        );
        assert_eq!(native.identity, storage::read_stable(&target)?.identity);
        for stage in ["prewarm", "start", "move"] {
            assert_eq!(
                claim(
                    &f.root,
                    &f.registry,
                    &json!({"opId":f.pending.operation_id,"stage":stage,"proof":{}})
                )?["ready"],
                false
            );
        }
        // Redaction never permits mismatched envelopes or competing commands.
        let mut mismatch = rows.clone();
        mismatch[2]["commandRun"]["args"] = json!(format!(
            "{} {}",
            f.pending.operation_id,
            retained["start"]["id"].as_str().unwrap()
        ));
        assert!(normalize_journal(&migrated, &mismatch).is_err());
        let duplicate = rows[1].clone();
        rows.push(duplicate);
        assert!(normalize_journal(&migrated, &rows).is_err());
        Ok(())
    }
    #[test]
    fn resumed_bootstrap_placeholder_preserves_first_packet_parent_closure() -> Result<()> {
        let f = fixture(false)?;
        let (_, mut rows) = boot(&f)?;
        let context = moved_context(&f, &rows[2]["uuid"]);
        let placeholder = json!({"type":"assistant","uuid":Uuid::new_v4(),
            "parentUuid":context["uuid"],"sessionId":f.cli,"cwd":f.record.cwd,
            "message":{"role":"assistant","model":"<synthetic>","stop_reason":"stop_sequence",
                "content":[{"type":"text","text":"No response requested."}],
                "usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}});
        let key = [7; 32];
        let messages = vec![
            crate::history::Message::text("user", "Imported question"),
            crate::history::Message::text("assistant", "Imported answer"),
        ];
        let content = packet::encode_inline(
            &messages,
            json!({"conversationId":f.record.conversation_id,"targetSessionId":f.cli,
                "operationId":f.pending.operation_id,"sourceSide":"codex","previousDigest":null}),
            &key,
        )?;
        rows.push(context);
        rows.push(placeholder.clone());
        rows.push(
            json!({"type":"user","uuid":Uuid::new_v4(),"parentUuid":placeholder["uuid"],
            "sessionId":f.cli,"cwd":f.record.cwd,"timestamp":"2026-10-26T00:00:00.000Z",
            "queueTranscriptOnly":true,"message":{"role":"user","content":content}}),
        );
        let original = rows.clone();
        let j = journal(&f.root, &f.pending.operation_id)?;
        let normalized = normalize_journal(&j, &rows)?;
        assert_eq!(normalized.len(), 1);
        assert!(normalized[0]["parentUuid"].is_null());
        let decoded = crate::owned_history::completed_claude(
            &codecs::serialize_rows(&normalized)?,
            &f.root,
            &f.record.conversation_id,
            &f.cli,
            Some(&key),
        )?;
        assert_eq!(decoded.common.messages, messages);
        assert!(!decoded.incomplete_tail);
        assert_eq!(rows, original);
        for change in [
            "content",
            "model",
            "usage",
            "stop",
            "session",
            "cwd",
            "parent",
            "duplicate",
        ] {
            let mut variant = rows.clone();
            match change {
                "content" => variant[4]["message"]["content"][0]["text"] = json!("Real reply"),
                "model" => variant[4]["message"]["model"] = json!("real-model"),
                "usage" => variant[4]["message"]["usage"]["input_tokens"] = json!(1),
                "stop" => variant[4]["message"]["stop_reason"] = json!("end_turn"),
                "session" => variant[4]["sessionId"] = json!(Uuid::new_v4()),
                "cwd" => variant[4]["cwd"] = json!(f.scratch),
                "parent" => variant[4]["parentUuid"] = rows[2]["uuid"].clone(),
                "duplicate" => variant.push(variant[4].clone()),
                _ => unreachable!(),
            }
            let result = normalize_journal(&j, &variant).and_then(|v| {
                crate::owned_history::completed_claude(
                    &codecs::serialize_rows(&v)?,
                    &f.root,
                    &f.record.conversation_id,
                    &f.cli,
                    Some(&key),
                )
            });
            assert!(result.is_err(), "{change}");
        }
        Ok(())
    }
    #[test]
    fn unproven_move_context_or_independent_input_never_migrates() -> Result<()> {
        for change in ["cwd", "parent", "flags", "text", "duplicate", "authored"] {
            let f = fixture(false)?;
            let (c, mut rows) = boot(&f)?;
            result(&f, &c, "needs_trust", Value::Null)?;
            let mut context = moved_context(&f, &rows[2]["uuid"]);
            match change {
                "cwd" => context["cwd"] = json!(f.scratch),
                "parent" => context["parentUuid"] = json!(Uuid::new_v4()),
                "flags" => context["queueTranscriptOnly"] = json!(false),
                "text" => {
                    context["message"]["content"] =
                        json!("<system-reminder>Independent input.</system-reminder>")
                }
                "duplicate" => rows.push(context.clone()),
                "authored" => context["isMeta"] = json!(false),
                _ => unreachable!(),
            }
            rows.push(context);
            registry(&f, Path::new(&f.record.cwd))?;
            let target = codecs::claude_path(&f.home, &f.record.cwd, &f.cli)?;
            storage::private_directory(target.parent().unwrap())?;
            storage::atomic_write(&target, codecs::serialize_rows(&rows)?)?;
            assert!(
                prepare(&f.root, &f.registry, &f.state, &f.record, &f.pending).is_err(),
                "{change}"
            );
            let j = journal(&f.root, &f.pending.operation_id)?;
            assert!(j["resolved"].is_null());
            assert_eq!(j["move"]["outcome"], "needs_trust");
        }
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
