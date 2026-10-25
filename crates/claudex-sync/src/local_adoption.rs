//! At-most-once adoption through Desktop's ordinary CLI resume picker.
//! The SDK seed stays immutable; only native APIs create Desktop registry rows.
use crate::{
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

fn read(path: &Path) -> Result<Value> {
    let f = storage::read_stable_with_limit(path, packet::MAX_PACKET_BYTES + 2 * 1024 * 1024)?;
    ensure!(
        f.identity.uid == storage::uid().to_string()
            && f.identity.nlink == "1"
            && f.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Local adoption metadata must be private, owned and single-link."
    );
    Ok(serde_json::from_slice(&f.bytes)?)
}
fn directory(root: &Path) -> Result<PathBuf> {
    storage::require_private_directory(root)?;
    ensure!(
        fs::canonicalize(root)? == root,
        "Local adoption root must be canonical."
    );
    let d = storage::private_directory(root.join("local-adoption"))?;
    storage::require_private_directory(&d)?;
    ensure!(
        fs::canonicalize(&d)? == d,
        "Local adoption directory is aliased."
    );
    Ok(d)
}
fn path(root: &Path, op: &str) -> Result<PathBuf> {
    Uuid::parse_str(op)?;
    Ok(directory(root)?.join(format!("{op}.json")))
}
fn uuid(v: &Value, key: &str) -> Result<String> {
    let s = v[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing native resume identity."))?;
    Uuid::parse_str(s)?;
    Ok(s.into())
}
fn journal(root: &Path, op: &str) -> Result<Value> {
    let j = read(&path(root, op)?)?;
    ensure!(
        j["version"] == 1 && j["entry"]["opId"] == op && j["seedIdentity"].is_object(),
        "Invalid native resume journal."
    );
    for k in [
        "opId",
        "sourceOperationId",
        "conversationId",
        "cliSessionId",
        "seedUuid",
    ] {
        uuid(&j["entry"], k)?;
    }
    ensure!(
        j["entry"]["seedContentDigest"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            && j["entry"]["expiresAt"].is_i64(),
        "Invalid native resume proof."
    );
    Ok(j)
}
fn authority(root: &Path, j: &Value, unchanged: bool) -> Result<Value> {
    ensure!(
        !hooks::app_stopped(root)?,
        "Claudex application is stopped."
    );
    let e = &j["entry"];
    let ledger = read(&root.join("desktop-state.json"))?;
    let p = &ledger["pending"];
    ensure!(
        ledger["version"] == 2
            && p["operationId"] == e["sourceOperationId"]
            && p["record"]["nativeId"] == e["cliSessionId"]
            && p["record"]["cwd"] == e["cwd"]
            && p["record"]["conversationId"] == e["conversationId"],
        "Native resume is not the current pending transaction."
    );
    let op = root.join("owners").join(format!(
        "{}.json",
        digest_bytes(e["conversationId"].as_str().unwrap().as_bytes())
    ));
    let o =
        owner::owned_state(&op)?.ok_or_else(|| anyhow::anyhow!("Native resume owner missing."))?;
    ensure!(
        o["sessionId"] == e["cliSessionId"]
            && o["conversationId"] == e["conversationId"]
            && o["registration"] != "registering"
            && o["cwd"] == e["cwd"]
            && o["transport"] == "local-mod"
            && matches!(
                o["localPhase"].as_str(),
                Some("handoff-intent" | "handoff-sent" | "adopted")
            )
            && o["remoteId"].is_null()
            && o["pending"].is_null()
            && o["reset"].is_null()
            && o["lastAppend"]["contentHash"] == j["seedOwnerHash"]
            && storage::hash_json(&owner::normalize_content(&o["lastAppend"]["content"])?)?
                == j["seedOwnerHash"]
            && o["lastAppend"]["operationId"] == e["sourceOperationId"]
            && o["lastAppend"]["uuid"] == e["seedUuid"]
            && !PathBuf::from(format!("{}.lock", op.display())).try_exists()?,
        "Native resume writer authority changed."
    );
    let snapshot = storage::snapshot_with_limit(
        p["record"]["path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Native seed path missing."))?,
        packet::MAX_PACKET_BYTES + 2 * 1024 * 1024,
    )?;
    let seed: Vec<_> = snapshot
        .rows
        .iter()
        .filter(|r| r["uuid"] == e["seedUuid"])
        .collect();
    ensure!(
        seed.len() == 1
            && seed[0]["type"] == "user"
            && seed[0]["sessionId"] == e["cliSessionId"]
            && seed[0]["message"]["role"] == "user"
            && seed[0]["queueTranscriptOnly"] == true
            && storage::hash_json(&seed[0]["message"]["content"])? == e["seedContentDigest"],
        "Exact native seed changed before adoption."
    );
    if unchanged {
        ensure!(
            json!(snapshot.file_identity) == j["seedIdentity"],
            "Native seed file changed before resume claim."
        );
    }
    Ok(o)
}
fn publish(root: &Path, entry: Option<&Value>) -> Result<()> {
    storage::write_json(
        root.join("local-adoption-manifest.json"),
        &json!({"version":1,"entries":entry.into_iter().collect::<Vec<_>>()}),
    )
}
/// A registry mapping alone is not the final ACK. The caller still requires the
/// existing no-query Mod command and exact persisted command graph.
pub fn prepare(root: &Path, registry: &Path, r: &Record, p: &Pending) -> Result<bool> {
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let op = owner::append_uuid(&r.native_id, &format!("native-resume:{}", p.operation_id));
    let file = path(root, &op)?;
    let mut j = match journal(root, &op) {
        Ok(v) => v,
        Err(e) if storage::is_not_found(&e) => {
            let owner_file = root.join("owners").join(format!(
                "{}.json",
                digest_bytes(r.conversation_id.as_bytes())
            ));
            let o = owner::owned_state(&owner_file)?
                .ok_or_else(|| anyhow::anyhow!("Native resume owner missing."))?;
            let snapshot =
                storage::snapshot_with_limit(&r.path, packet::MAX_PACKET_BYTES + 2 * 1024 * 1024)?;
            let seed: Vec<_> = snapshot
                .rows
                .iter()
                .filter(|v| v["uuid"] == o["lastAppend"]["uuid"])
                .collect();
            ensure!(
                seed.len() == 1,
                "Native resume needs exactly one persisted seed."
            );
            json!({"version":1,"entry":{"opId":op,"sourceOperationId":p.operation_id,"conversationId":r.conversation_id,
                "cliSessionId":r.native_id,"cwd":r.cwd,"seedUuid":o["lastAppend"]["uuid"],
                "seedContentDigest":storage::hash_json(&seed[0]["message"]["content"])?,"expiresAt":storage::now_ms()+600_000},
                "seedIdentity":snapshot.file_identity,"seedOwnerHash":o["lastAppend"]["contentHash"],"claim":null,"observed":null,"activation":null})
        }
        Err(e) => return Err(e),
    };
    authority(root, &j, false)?;
    let mappings = desktop_mapping::mappings(registry, &[r.native_id.clone()])?;
    if let Some(m) = mappings.get(&r.native_id) {
        ensure!(
            m["cwd"] == r.cwd && m["isArchived"] == false,
            "Native resumed target identity changed."
        );
        if let Some(claim) = j["claim"].as_object() {
            if let Some(result) = claim.get("outcome").filter(|v| v["outcome"] == "resumed") {
                ensure!(
                    result["localSessionId"] == m["sessionId"],
                    "Native resume returned a different Local identity."
                );
            }
        }
        if !j["activation"].is_null() {
            storage::write_json(&file, &j)?;
            publish(root, None)?;
            return Ok(true);
        }
        // Warming is separate one-use authority: native adoption creates a cold
        // Local row; only a no-input native warm can load the Mod command.
        let mut activation = j["entry"].clone();
        activation["action"] = json!("activate");
        for k in ["title", "lastActivityAt", "registryPath"] {
            activation[k] = m[k].clone();
        }
        activation["localSessionId"] = m["sessionId"].clone();
        if j["activationEntry"].is_null() {
            activation["expiresAt"] = json!(storage::now_ms() + 600_000);
            j["activationEntry"] = activation.clone();
        } else {
            activation["expiresAt"] = j["activationEntry"]["expiresAt"].clone();
            if activation != j["activationEntry"] {
                // Native activity may be the exact Mod ACK being reconciled.
                // It withdraws warm authority, not that independent ACK proof.
                j["activationRefused"] = json!("native-mapping-changed");
                storage::write_json(&file, &j)?;
                publish(root, None)?;
                return Ok(true);
            }
            if j["activation"].is_null()
                && activation["expiresAt"]
                    .as_i64()
                    .is_some_and(|n| n <= storage::now_ms())
            {
                authority(root, &j, true)?;
                activation["expiresAt"] = json!(storage::now_ms() + 600_000);
                j["activationEntry"] = activation.clone();
            }
        }
        storage::write_json(&file, &j)?;
        publish(root, Some(&activation))?;
        return Ok(true);
    }
    if j["claim"].is_null()
        && j["entry"]["expiresAt"]
            .as_i64()
            .is_some_and(|n| n <= storage::now_ms())
    {
        authority(root, &j, true)?;
        j["entry"]["expiresAt"] = json!(storage::now_ms() + 600_000);
    }
    storage::write_json(&file, &j)?;
    let mut entry = j["entry"].clone();
    entry["action"] = json!("resume");
    publish(root, Some(&entry))?;
    Ok(false)
}
/// Records native list/preview evidence before consuming any write authority.
/// Unknown claims are durable and can never authorize a second resume.
pub fn claim(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(
            p,
            &[
                "opId",
                "handle",
                "cwd",
                "seedUuid",
                "seedContentDigest",
                "resumable"
            ]
        ),
        "Invalid native resume claim fields."
    );
    let op = uuid(p, "opId")?;
    uuid(p, "handle")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    for k in ["cwd", "seedUuid", "seedContentDigest"] {
        ensure!(
            p[k] == j["entry"][k],
            "Native resume API seed proof differs."
        );
    }
    ensure!(
        p["resumable"] == true,
        "Native resume picker refused the seed."
    );
    authority(root, &j, true)?;
    ensure!(
        desktop_mapping::mappings(
            registry,
            &[j["entry"]["cliSessionId"].as_str().unwrap().into()]
        )?
        .is_empty(),
        "Native seed already has a Desktop owner."
    );
    if !j["claim"].is_null() {
        return Ok(json!({"ready":false}));
    }
    ensure!(
        j["entry"]["expiresAt"]
            .as_i64()
            .is_some_and(|n| n > storage::now_ms()),
        "Native resume intent expired."
    );
    let claim_id = Uuid::new_v4().to_string();
    j["observed"] = p.clone();
    j["claim"] = json!({"id":claim_id,"at":storage::now_ms(),"outcome":null});
    storage::write_json(path(root, &op)?, &j)?;
    Ok(
        json!({"ready":true,"opId":op,"claimId":claim_id,"handle":p["handle"],"cliSessionId":j["entry"]["cliSessionId"]}),
    )
}
pub fn receipt(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(
            p,
            &["opId", "claimId", "outcome", "localSessionId", "reason"]
        ),
        "Invalid native resume receipt fields."
    );
    let op = uuid(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    ensure!(
        p["claimId"] == j["claim"]["id"] && p["claimId"].is_string(),
        "Native resume claim mismatch."
    );
    ensure!(
        matches!(
            p["outcome"].as_str(),
            Some("resumed" | "unknown" | "rejected")
        ),
        "Invalid native resume outcome."
    );
    ensure!(
        p["reason"].is_null()
            || matches!(
                p["reason"].as_str(),
                Some(
                    "running"
                        | "liveness_unknown"
                        | "workspace_untrusted"
                        | "folder_missing"
                        | "failed"
                        | "authority-changed"
                )
            ),
        "Invalid native resume refusal."
    );
    if p["outcome"] == "resumed" {
        ensure!(
            p["localSessionId"].as_str().is_some_and(|s| s
                .strip_prefix("local_")
                .is_some_and(|s| Uuid::parse_str(s).is_ok())),
            "Invalid native resumed Local identity."
        );
    } else {
        ensure!(
            p["localSessionId"].is_null(),
            "Uncertain native resume cannot name a confirmed target."
        );
    }
    let value =
        json!({"outcome":p["outcome"],"localSessionId":p["localSessionId"],"reason":p["reason"]});
    ensure!(
        j["claim"]["outcome"].is_null() || j["claim"]["outcome"] == value,
        "Native resume outcome changed."
    );
    j["claim"]["outcome"] = value;
    storage::write_json(path(root, &op)?, &j)?;
    Ok(json!({"recorded":true}))
}

/// Exact Local mapping and immutable seed authorize one no-input native warm.
pub fn activation_claim(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "localSessionId", "lastActivityAt"]),
        "Invalid native activation claim fields."
    );
    let op = uuid(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    authority(root, &j, true)?;
    if !j["activation"].is_null() {
        return Ok(json!({"ready":false}));
    }
    let manifest = read(&root.join("local-adoption-manifest.json"))?;
    let entries = manifest["entries"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native activation manifest missing."))?;
    ensure!(
        entries.len() == 1 && entries[0]["opId"] == op && entries[0]["action"] == "activate",
        "Native activation is not published."
    );
    let e = &entries[0];
    for key in [
        "opId",
        "sourceOperationId",
        "conversationId",
        "cliSessionId",
        "cwd",
        "seedUuid",
        "seedContentDigest",
    ] {
        ensure!(
            e[key] == j["entry"][key],
            "Native activation does not match the saved seed."
        );
    }
    ensure!(
        p["localSessionId"] == e["localSessionId"]
            && p["lastActivityAt"] == e["lastActivityAt"]
            && e["expiresAt"]
                .as_i64()
                .is_some_and(|n| n > storage::now_ms()),
        "Native activation identity changed."
    );
    let mappings = desktop_mapping::mappings(
        registry,
        &[j["entry"]["cliSessionId"].as_str().unwrap().into()],
    )?;
    let m = mappings
        .get(j["entry"]["cliSessionId"].as_str().unwrap())
        .ok_or_else(|| anyhow::anyhow!("Native adopted Local mapping missing."))?;
    ensure!(
        m["isArchived"] == false
            && m["sessionId"] == p["localSessionId"]
            && m["cwd"] == e["cwd"]
            && m["lastActivityAt"] == p["lastActivityAt"]
            && m["title"] == e["title"]
            && m["registryPath"] == e["registryPath"],
        "Native activation mapping changed."
    );
    let id = Uuid::new_v4().to_string();
    j["activation"] = json!({"id":id,"at":storage::now_ms(),"entry":e,"outcome":null});
    storage::write_json(path(root, &op)?, &j)?;
    Ok(
        json!({"ready":true,"opId":op,"claimId":id,"localSessionId":p["localSessionId"],"lastActivityAt":p["lastActivityAt"]}),
    )
}
pub fn activation_receipt(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "claimId", "outcome"]),
        "Invalid native activation receipt fields."
    );
    let op = uuid(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    ensure!(
        p["claimId"].is_string() && p["claimId"] == j["activation"]["id"],
        "Native activation claim mismatch."
    );
    ensure!(
        matches!(
            p["outcome"].as_str(),
            Some("returned" | "unknown" | "rejected")
        ),
        "Invalid native activation outcome."
    );
    ensure!(
        j["activation"]["outcome"].is_null() || j["activation"]["outcome"] == p["outcome"],
        "Native activation outcome changed."
    );
    j["activation"]["outcome"] = p["outcome"].clone();
    storage::write_json(path(root, &op)?, &j)?;
    Ok(json!({"recorded":true}))
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
        record: Record,
        pending: Pending,
        op: String,
        params: Value,
        seed: Vec<u8>,
    }
    fn fixture(phase: &str) -> Result<Fixture> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        storage::private_directory(&root)?;
        let registry = storage::private_directory(root.join("registry"))?;
        let cwd = storage::private_directory(root.join("project"))?;
        let session = Uuid::new_v4().to_string();
        let conversation = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let seed_uuid = owner::append_uuid(&session, &operation);
        let content = json!([{"type":"text","text":"Synthetic exact seed"}]);
        let row = json!({"type":"user","uuid":seed_uuid,"sessionId":session,"cwd":cwd,"queueTranscriptOnly":true,"message":{"role":"user","content":content}});
        let transcript = root.join("transcript.jsonl");
        storage::atomic_write(
            &transcript,
            format!("{}\n", serde_json::to_string(&row)?).as_bytes(),
        )?;
        let mut record = Record::source(Side::Claude, &transcript, &session);
        record.conversation_id = conversation.clone();
        record.cwd = cwd.to_string_lossy().into();
        let pending = Pending {
            phase: Phase::Prepared,
            operation_id: operation.clone(),
            record: record.clone(),
            source_id: String::new(),
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
        storage::private_directory(root.join("owners"))?;
        storage::write_json(
            root.join("owners")
                .join(format!("{}.json", digest_bytes(conversation.as_bytes()))),
            &json!({"version":1,"sessionId":session,"conversationId":conversation,"cwd":cwd,"transport":"local-mod","localPhase":phase,"remoteId":null,"pending":null,"reset":null,"lastAppend":{"operationId":operation,"uuid":seed_uuid,"contentHash":storage::hash_json(&content)?,"content":content}}),
        )?;
        storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":pending}),
        )?;
        let op = owner::append_uuid(&session, &format!("native-resume:{operation}"));
        let params = json!({"opId":op,"handle":Uuid::new_v4().to_string(),"cwd":cwd,"seedUuid":seed_uuid,"seedContentDigest":storage::hash_json(&content)?,"resumable":true});
        let seed = fs::read(&transcript)?;
        Ok(Fixture {
            _temp: temp,
            root,
            registry,
            record,
            pending,
            op,
            params,
            seed,
        })
    }
    fn mapping(f: &Fixture, local: &str) -> Result<()> {
        storage::write_json(
            f.registry.join(format!("{local}.json")),
            &json!({"sessionId":local,"cliSessionId":f.record.native_id,"cwd":f.record.cwd,"title":"Fixture","isArchived":false,"lastActivityAt":1}),
        )
    }
    #[test]
    fn fresh_and_legacy_seeded_intents_resume_once_without_writing_transcript() -> Result<()> {
        for phase in ["handoff-intent", "handoff-sent"] {
            let f = fixture(phase)?;
            assert!(!prepare(&f.root, &f.registry, &f.record, &f.pending)?);
            assert_eq!(
                read(&f.root.join("local-adoption-manifest.json"))?["entries"][0]["action"],
                "resume"
            );
            let c = claim(&f.root, &f.registry, &f.params)?;
            assert_eq!(c["ready"], true);
            assert_eq!(claim(&f.root, &f.registry, &f.params)?["ready"], false);
            receipt(
                &f.root,
                &json!({"opId":f.op,"claimId":c["claimId"],"outcome":"unknown","localSessionId":null,"reason":null}),
            )?;
            // A reopened coordinator retains the consumed claim even without a receipt/mapping.
            assert!(!prepare(&f.root, &f.registry, &f.record, &f.pending)?);
            assert_eq!(claim(&f.root, &f.registry, &f.params)?["ready"], false);
            assert_eq!(fs::read(&f.record.path)?, f.seed);
        }
        Ok(())
    }
    #[test]
    fn changed_seed_or_file_identity_never_claims() -> Result<()> {
        let f = fixture("handoff-intent")?;
        prepare(&f.root, &f.registry, &f.record, &f.pending)?;
        let mut wrong = f.params.clone();
        wrong["seedContentDigest"] = json!("0".repeat(64));
        assert!(claim(&f.root, &f.registry, &wrong).is_err());
        // Identical bytes in a replaced inode are not the original claimed seed.
        storage::atomic_write(&f.record.path, &f.seed)?;
        assert!(claim(&f.root, &f.registry, &f.params).is_err());
        assert!(journal(&f.root, &f.op)?["claim"].is_null());
        Ok(())
    }
    #[test]
    fn exact_mapping_authorizes_one_separate_activation_and_preserves_seed() -> Result<()> {
        let f = fixture("handoff-intent")?;
        prepare(&f.root, &f.registry, &f.record, &f.pending)?;
        let c = claim(&f.root, &f.registry, &f.params)?;
        let local = format!("local_{}", f.record.native_id);
        receipt(
            &f.root,
            &json!({"opId":f.op,"claimId":c["claimId"],"outcome":"resumed","localSessionId":local,"reason":null}),
        )?;
        mapping(&f, &local)?;
        assert!(prepare(&f.root, &f.registry, &f.record, &f.pending)?);
        let p = json!({"opId":f.op,"localSessionId":local,"lastActivityAt":1});
        let a = activation_claim(&f.root, &f.registry, &p)?;
        assert_eq!(a["ready"], true);
        activation_receipt(
            &f.root,
            &json!({"opId":f.op,"claimId":a["claimId"],"outcome":"unknown"}),
        )?;
        assert!(prepare(&f.root, &f.registry, &f.record, &f.pending)?);
        assert_eq!(activation_claim(&f.root, &f.registry, &p)?["ready"], false);
        let registry_file = f.registry.join(format!("{local}.json"));
        let mut mapped = storage::read_json(&registry_file)?;
        mapped["lastActivityAt"] = json!(2);
        storage::write_json(&registry_file, &mapped)?;
        // A Mod ACK changes native activity; consumed activation must not block
        // the coordinator from reconciling that independent exact proof.
        assert!(prepare(&f.root, &f.registry, &f.record, &f.pending)?);
        assert_eq!(
            read(&f.root.join("local-adoption-manifest.json"))?["entries"],
            json!([])
        );
        assert_eq!(fs::read(&f.record.path)?, f.seed);
        Ok(())
    }
    #[test]
    fn returned_mapping_mismatch_and_changed_pending_refuse() -> Result<()> {
        let f = fixture("handoff-intent")?;
        prepare(&f.root, &f.registry, &f.record, &f.pending)?;
        let c = claim(&f.root, &f.registry, &f.params)?;
        receipt(
            &f.root,
            &json!({"opId":f.op,"claimId":c["claimId"],"outcome":"resumed","localSessionId":format!("local_{}",Uuid::new_v4()),"reason":null}),
        )?;
        mapping(&f, &format!("local_{}", f.record.native_id))?;
        assert!(prepare(&f.root, &f.registry, &f.record, &f.pending).is_err());
        storage::write_json(
            f.root.join("desktop-state.json"),
            &json!({"version":2,"pending":null}),
        )?;
        assert!(claim(&f.root, &f.registry, &f.params).is_err());
        Ok(())
    }
}
