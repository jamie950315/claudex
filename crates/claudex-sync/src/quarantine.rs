//! Explicit stopped-service isolation of an uncertain handoff. Never dispatches native work.
use crate::desktop::{DesktopBridge, PendingOperation, Record, State};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const LIMIT: usize = 512 * 1024 * 1024;
fn exact_uuid(value: &str) -> Result<()> {
    ensure!(
        Uuid::parse_str(value)?.to_string() == value,
        "Exact UUID required."
    );
    Ok(())
}
fn private_read(path: &Path) -> Result<storage::StableFile> {
    storage::require_private_directory(path.parent().unwrap())?;
    let file = storage::read_stable_with_limit(path, LIMIT)?;
    ensure!(
        file.identity.uid == storage::uid().to_string()
            && file.identity.mode.parse::<u32>()? & 0o7777 == 0o600
            && file.identity.nlink == "1",
        "Quarantine evidence must be private and single-link."
    );
    Ok(file)
}
fn capture(path: &Path) -> Result<Value> {
    let file = private_read(path)?;
    Ok(json!({"identity":file.identity,"bytes":STANDARD.encode(file.bytes)}))
}
fn decoded(value: &Value) -> Result<Vec<u8>> {
    Ok(STANDARD.decode(
        value["bytes"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing preserved evidence bytes."))?,
    )?)
}
fn receipt_path(root: &Path, operation: &str) -> PathBuf {
    root.join("quarantined-handoffs")
        .join(format!("{operation}.json"))
}
fn read_receipt(root: &Path, operation: &str, intent: &str) -> Result<Value> {
    exact_uuid(operation)?;
    let receipt: Value =
        serde_json::from_slice(&private_read(&receipt_path(root, operation))?.bytes)?;
    ensure!(
        receipt["version"] == 1
            && receipt["operationId"] == operation
            && storage::hash_json(&receipt)? == intent,
        "Quarantine receipt integrity or intent mismatch; evidence was not changed."
    );
    Ok(receipt)
}
/// Every ledger read authenticates the retained receipt, including cached ledgers.
pub(crate) fn validate(root: &Path, state: &State) -> Result<()> {
    for (id, c) in &state.conversations {
        let Some(q) = c.extra.get("quarantine") else {
            continue;
        };
        let operation = q["operationId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing quarantine operation."))?;
        let intent = q["intent"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing quarantine intent."))?;
        exact_uuid(operation)?;
        ensure!(
            crate::packet::hex_digest(&json!(intent)),
            "Invalid quarantine intent."
        );
        let path = receipt_path(root, operation);
        storage::require_private_directory(path.parent().unwrap())?;
        // The ledger binds the exact post-publication inode identity. Opening the
        // immutable receipt without reading its large preserved ledger detects
        // replacement, writes, chmod and extra links through nanosecond ctime.
        let expected: storage::FileIdentity = serde_json::from_value(q["receiptIdentity"].clone())?;
        ensure!(
            expected.uid == storage::uid().to_string()
                && expected.mode.parse::<u32>()? & 0o7777 == 0o600
                && expected.nlink == "1",
            "Invalid quarantine receipt ownership proof."
        );
        let named = fs::symlink_metadata(&path)?;
        ensure!(
            named.is_file() && !named.file_type().is_symlink(),
            "Unsafe quarantine receipt."
        );
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)?;
        ensure!(
            storage::FileIdentity::from_metadata(&named) == expected
                && storage::FileIdentity::from_metadata(&file.metadata()?) == expected
                && storage::FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == expected,
            "Quarantine receipt changed or disappeared; unresolved evidence remains protected."
        );
        ensure!(
            !c.tracked() && q["status"] == "unresolved" && q["identities"].is_array(),
            "Invalid unresolved quarantine metadata."
        );
        for identity in q["identities"].as_array().unwrap() {
            ensure!(
                state.records.iter().any(|r| r.conversation_id == *id
                    && json!(r.side) == identity["side"]
                    && r.native_id == identity["nativeId"]
                    && r.extra.get("quarantineOperation") == Some(&json!(operation))),
                "Quarantined native identity reservation is missing."
            );
        }
    }
    Ok(())
}
pub(crate) fn admit_record(state: &State, record: &Record) -> Result<()> {
    ensure!(
        !state
            .conversations
            .get(&record.conversation_id)
            .is_some_and(|c| c.quarantined())
            && !state.records.iter().any(|r| r.side == record.side
                && r.native_id == record.native_id
                && state
                    .conversations
                    .get(&r.conversation_id)
                    .is_some_and(|c| c.quarantined())),
        "Quarantined history is retained as inert evidence; native inspection and ownership are disabled."
    );
    Ok(())
}
fn stopped(root: &Path) -> Result<()> {
    ensure!(
        crate::hooks::app_stopped(root)?,
        "Stop Claudex services before quarantine maintenance."
    );
    for name in ["watch.lock", "service-supervisor.lock", "operation.lock"] {
        for suffix in ["", ".reclaim"] {
            ensure!(
                matches!(fs::symlink_metadata(root.join(format!("{name}{suffix}"))), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
                "A coordinator or recovery claim remains; stop services before quarantine maintenance."
            );
        }
    }
    if root.join("owners").try_exists()? {
        storage::require_private_directory(root.join("owners"))?;
        for entry in fs::read_dir(root.join("owners"))? {
            let name = entry?.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Unsafe owner filename."))?;
            ensure!(
                !name.ends_with(".lock") && !name.ends_with(".lock.reap"),
                "A native owner lease remains; stop services before quarantine maintenance."
            );
        }
    }
    Ok(())
}
fn capture_tree(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Value>,
    directories: &mut BTreeMap<String, storage::FileIdentity>,
    depth: usize,
) -> Result<()> {
    ensure!(
        depth <= 16 && files.len() + directories.len() < 16384,
        "Recovery evidence subtree exceeds its inspection bound."
    );
    storage::require_private_directory(directory)?;
    let before = storage::FileIdentity::from_metadata(&fs::symlink_metadata(directory)?);
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if fs::symlink_metadata(&path)?.is_dir() {
            capture_tree(root, &path, files, directories, depth + 1)?;
        } else {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Unsafe evidence filename."))?
                .to_owned();
            files.insert(relative, capture(&path)?);
        }
    }
    ensure!(
        storage::FileIdentity::from_metadata(&fs::symlink_metadata(directory)?) == before,
        "Recovery evidence subtree changed during inspection."
    );
    directories.insert(
        directory
            .strip_prefix(root)?
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Unsafe evidence directory."))?
            .to_owned(),
        before,
    );
    Ok(())
}
fn revoked_manifest() -> Result<Vec<u8>> {
    // Exact empty publication from local_handoff::revoke(root, false). This is
    // the sole receipt-first crash transition admitted by quarantine recovery.
    Ok(format!(
        "{}\n",
        claudex_core::json::stringify(&json!({"version":1,
        "kind":"claude-local-archive","generatedAt":null,"expiresAt":null,
        "actions":[],"anchorsUpdatedAt":null,"anchors":[]}))?
    )
    .into_bytes())
}
fn same_preserved_intent(current: &Value, preserved: &Value) -> Result<bool> {
    let mut current = current.clone();
    let previous = &preserved["handoff"];
    if current["handoff"] != *previous {
        if current["handoff"].is_null() || decoded(&current["handoff"])? != revoked_manifest()? {
            return Ok(false);
        }
        current["handoff"] = previous.clone();
    }
    Ok(current == *preserved)
}
fn capture_candidate(root: &Path, state: &State, id: &str, operation: &str) -> Result<Value> {
    let Some(PendingOperation::Handoff(p)) = &state.pending else {
        anyhow::bail!("An exact pending handoff is required; nothing changed.");
    };
    ensure!(
        p.operation_id == operation
            && p.record.conversation_id == id
            && state.conversations.contains_key(id),
        "Pending conversation or operation does not match; nothing changed."
    );
    let owner_hash = storage::hash_bytes(id.as_bytes());
    let mut files = BTreeMap::new();
    // Only app-owned state is read. Native histories, registries and model APIs are never opened.
    for directory in [
        "owners",
        "owners/retired",
        "local-start",
        "native-operations",
    ] {
        let dir = root.join(directory);
        match fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
            Ok(_) => storage::require_private_directory(&dir)?,
        }
        let entries = fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
        ensure!(
            entries.len() <= 16384,
            "Evidence directory exceeds inspection bound."
        );
        for entry in entries {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Unsafe evidence filename."))?;
            let selected = match directory {
                "owners" => name == format!("{owner_hash}.json"),
                "owners/retired" => name.starts_with(&format!("{owner_hash}-")),
                "local-start" => name == format!("{operation}.json"),
                _ => state
                    .records
                    .iter()
                    .filter(|r| r.conversation_id == id)
                    .chain(std::iter::once(&p.record))
                    .any(|r| name.starts_with(&format!("{}-", r.id))),
            };
            if selected {
                files.insert(format!("{directory}/{name}"), capture(&entry.path())?);
            }
        }
    }
    let mut directories = BTreeMap::new();
    let sync = root.join("local-sync");
    match fs::symlink_metadata(&sync) {
        Ok(_) => {
            storage::require_private_directory(&sync)?;
            let subtree = sync.join(operation);
            match fs::symlink_metadata(&subtree) {
                Ok(_) => capture_tree(root, &subtree, &mut files, &mut directories, 0)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    let handoff = match capture(&root.join("desktop-handoff.json")) {
        Ok(v) => v,
        Err(e) if storage::is_not_found(&e) => Value::Null,
        Err(e) => return Err(e),
    };
    Ok(
        json!({"version":1,"conversationId":id,"operationId":operation,
        "ledger":capture(&root.join("desktop-state.json"))?,"files":files,
        "directories":directories,"handoff":handoff}),
    )
}
fn reserved(receipt: &Value) -> Result<Vec<Record>> {
    let state: State = serde_json::from_slice(&decoded(&receipt["ledger"])?)?;
    let Some(PendingOperation::Handoff(p)) = state.pending else {
        anyhow::bail!("Receipt lacks pending handoff.")
    };
    let id = receipt["conversationId"].as_str().unwrap();
    let operation = receipt["operationId"].as_str().unwrap();
    let mut records = vec![p.record.clone()];
    if let Some(local) = receipt["files"].get(format!("local-start/{operation}.json")) {
        let local: Value = serde_json::from_slice(&decoded(local)?)?;
        ensure!(
            local["opId"] == operation && local["originalPending"] == serde_json::to_value(&p)?,
            "Local recovery journal does not match the pending operation."
        );
        if !local["resolved"].is_null() {
            let mut resolved: Record = serde_json::from_value(local["resolved"].clone())?;
            ensure!(
                resolved.conversation_id == id
                    && resolved.side == p.record.side
                    && resolved.cwd == p.record.cwd
                    && resolved.extra.get("nativeStartOperation") == Some(&json!(operation))
                    && local["newOwner"]["conversationId"] == id
                    && local["newOwner"]["sessionId"] == resolved.native_id
                    && local["mapping"]["nativeId"] == resolved.native_id,
                "Resolved native identity is not bound to this exact handoff."
            );
            exact_uuid(&resolved.native_id)?;
            if resolved.native_id != p.record.native_id {
                resolved.id = Uuid::from_slice(
                    &hex::decode(storage::hash_bytes(
                        format!("{operation}:{}", resolved.native_id).as_bytes(),
                    ))?[..16],
                )?
                .to_string();
                records.push(resolved);
            }
        }
    }
    let owner_name = format!("owners/{}.json", storage::hash_bytes(id.as_bytes()));
    if let Some(owner) = receipt["files"].get(&owner_name) {
        let owner: Value = serde_json::from_slice(&decoded(owner)?)?;
        ensure!(
            owner["conversationId"] == id
                && records.iter().any(|r| owner["sessionId"] == r.native_id),
            "Saved owner has an unproven native identity."
        );
    }
    Ok(records)
}
impl DesktopBridge {
    /// Inspect/confirm by exact intent. Receipt-first publication is restart-idempotent.
    pub fn quarantine_pending(
        &self,
        id: &str,
        operation: &str,
        expected: Option<&str>,
    ) -> Result<Value> {
        exact_uuid(id)?;
        exact_uuid(operation)?;
        storage::require_private_directory(&self.root)?;
        stopped(&self.root)?;
        let _supervisor = FileLock::acquire(self.root.join("service-supervisor.lock"), true)?;
        let _watch = FileLock::acquire(self.root.join("watch.lock"), true)?;
        let _operation = self.lock()?;
        let mut state = self.status()?;
        if let Some(q) = state
            .conversations
            .get(id)
            .and_then(|c| c.extra.get("quarantine"))
        {
            ensure!(
                q["operationId"] == operation && expected.is_none_or(|e| q["intent"] == e),
                "Quarantine confirmation does not match the retained intent."
            );
            read_receipt(&self.root, operation, q["intent"].as_str().unwrap())?;
            return Ok(
                json!({"changed":false,"quarantined":true,"resolved":false,"conversationId":id,"operationId":operation,"intent":q["intent"],"receipt":receipt_path(&self.root, operation)}),
            );
        }
        let current = capture_candidate(&self.root, &state, id, operation)?;
        let path = receipt_path(&self.root, operation);
        let candidate = match private_read(&path) {
            Ok(file) => {
                let preserved: Value = serde_json::from_slice(&file.bytes)?;
                ensure!(
                    preserved["version"] == 1
                        && preserved["conversationId"] == id
                        && preserved["operationId"] == operation
                        && same_preserved_intent(&current, &preserved)?,
                    "Existing quarantine receipt conflicts with current evidence."
                );
                preserved
            }
            Err(e) if storage::is_not_found(&e) => current,
            Err(e) => return Err(e),
        };
        let intent = storage::hash_json(&candidate)?;
        let mut records = reserved(&candidate)?;
        for record in &records {
            ensure!(
                !state.records.iter().any(|r| (r.side == record.side
                    && r.native_id == record.native_id)
                    && r.conversation_id != id),
                "Quarantined native identity belongs to another conversation."
            );
            ensure!(
                !state
                    .records
                    .iter()
                    .any(|r| r.id == record.id && r.native_id != record.native_id),
                "Quarantined record identity conflicts."
            );
        }
        let identities: Vec<_> = state
            .records
            .iter()
            .filter(|r| r.conversation_id == id)
            .chain(records.iter())
            .map(|r| json!({"side":r.side,"nativeId":r.native_id}))
            .collect();
        let result = json!({"changed":false,"quarantined":false,"resolved":false,"conversationId":id,
            "operationId":operation,"intent":intent,"identities":identities,"receipt":receipt_path(&self.root, operation)});
        if expected.is_none() {
            return Ok(result);
        }
        ensure!(
            expected == Some(intent.as_str()),
            "Pending intent or evidence changed since inspection; nothing changed."
        );
        match private_read(&path) {
            Ok(_) => {
                ensure!(
                    read_receipt(&self.root, operation, &intent)? == candidate,
                    "Existing quarantine receipt conflicts with current evidence."
                );
            }
            Err(e) if storage::is_not_found(&e) => {
                storage::private_directory(path.parent().unwrap())?;
                storage::require_private_directory(path.parent().unwrap())?;
                let bytes = serde_json::to_vec_pretty(&candidate)?;
                ensure!(
                    bytes.len() <= LIMIT,
                    "Quarantine receipt exceeds its immutable read bound."
                );
                storage::publish_exclusive(&path, bytes)?;
            }
            Err(e) => return Err(e),
        }
        // Fence evidence drift after publication. A crash leaves the immutable receipt for the same confirmation.
        ensure!(
            same_preserved_intent(
                &capture_candidate(&self.root, &state, id, operation)?,
                &candidate
            )?,
            "Quarantine evidence changed after receipt publication; pending work remains blocked."
        );
        // Preserve the old manifest in the durable receipt before revoking
        // app-owned archival authority. No native action is dispatched.
        crate::local_handoff::revoke(&self.root, false)?;
        let revoked: Value = serde_json::from_slice(&decoded(&capture(
            &self.root.join("desktop-handoff.json"),
        )?)?)?;
        ensure!(
            revoked["version"] == 1
                && revoked["kind"] == "claude-local-archive"
                && revoked["actions"].as_array().is_some_and(Vec::is_empty)
                && revoked["anchors"].as_array().is_some_and(Vec::is_empty),
            "Local handoff authority was not fully revoked; pending work remains blocked."
        );
        ensure!(
            same_preserved_intent(
                &capture_candidate(&self.root, &state, id, operation)?,
                &candidate
            )?,
            "Preserved evidence changed during authority revocation; pending work remains blocked."
        );
        for record in state.records.iter_mut().filter(|r| r.conversation_id == id) {
            record
                .extra
                .insert("quarantineOperation".into(), json!(operation));
        }
        for mut record in records.drain(..) {
            if state
                .records
                .iter()
                .any(|r| r.side == record.side && r.native_id == record.native_id)
            {
                continue;
            }
            ensure!(
                !state.records.iter().any(|r| r.id == record.id),
                "Quarantined record identity conflicts."
            );
            record.status = "quarantined".into();
            record
                .extra
                .insert("quarantineOperation".into(), json!(operation));
            state.records.push(record);
        }
        let published = private_read(&path)?;
        ensure!(
            storage::hash_json(&serde_json::from_slice(&published.bytes)?)? == intent,
            "Published quarantine receipt changed before ledger commit."
        );
        let receipt_identity = published.identity;
        let conversation = state.conversations.get_mut(id).unwrap();
        conversation.extra.insert(
            "tracking".into(),
            json!({"status":"stopped","stoppedAt":storage::now_ms()}),
        );
        conversation.extra.insert("quarantine".into(),json!({"status":"unresolved","operationId":operation,"intent":intent,"identities":identities,"receiptIdentity":receipt_identity}));
        // The transaction is retained in the immutable receipt, not marked applied, promoted, completed or abandoned.
        state.pending = None;
        self.save(&mut state,Some(json!({"event":"pending-quarantined","conversationId":id,"operationId":operation,"intent":intent})))?;
        Ok(
            json!({"changed":true,"quarantined":true,"resolved":false,"conversationId":id,"operationId":operation,"intent":intent,"receipt":path}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        bridge::Side,
        desktop::{Checkpoint, Conversation, Pending, Phase},
        history::{Common, Message},
    };
    use serde_json::Map;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn fixture() -> Result<(tempfile::TempDir, DesktopBridge, String, String, String)> {
        let tmp = tempfile::tempdir()?;
        let root = storage::private_directory(tmp.path())?;
        let id = Uuid::new_v4().to_string();
        let op = Uuid::new_v4().to_string();
        let mut common = Common {
            meta: Map::from_iter([("cwd".into(), json!("/fixture-project"))]),
            messages: vec![
                Message::text("user", "Preserve this history"),
                Message::text("assistant", "Retained answer"),
            ],
            extra: Map::new(),
        };
        common.messages[0].content.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}));
        let checkpoint = Checkpoint::of(&common)?;
        let mut source = Record::source(
            Side::Codex,
            Path::new("/never-open-source"),
            &Uuid::new_v4().to_string(),
        );
        source.conversation_id = id.clone();
        source.cwd = "/fixture-project".into();
        source.checkpoint = checkpoint.clone();
        source.verified = true;
        let mut target = Record::source(
            Side::Claude,
            Path::new("/never-open-provisional"),
            &Uuid::new_v4().to_string(),
        );
        target.conversation_id = id.clone();
        target.cwd = source.cwd.clone();
        target.kind = "owner".into();
        target.managed = true;
        let pending = Pending {
            phase: Phase::Prepared,
            operation_id: op.clone(),
            record: target.clone(),
            source_id: source.id.clone(),
            target_id: None,
            archive_original_id: None,
            reuse: false,
            common,
            checkpoint: checkpoint.clone(),
            previous: Checkpoint::empty(),
            extra: Map::new(),
        };
        let mut state = State::default();
        state.conversations.insert(
            id.clone(),
            Conversation {
                id: id.clone(),
                cwd: source.cwd.clone(),
                title: "Uncertain handoff".into(),
                canonical: checkpoint,
                extra: Map::new(),
            },
        );
        state.records.push(source);
        state.pending = Some(pending.clone().into());
        storage::write_json(
            root.join("desktop-state.json"),
            &serde_json::to_value(&state)?,
        )?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        let mut resolved = target;
        let actual = Uuid::new_v4().to_string();
        resolved.native_id = actual.clone();
        resolved.path = "/never-open-actual".into();
        resolved
            .extra
            .insert("nativeStartOperation".into(), json!(op));
        let owner = json!({"conversationId":id,"sessionId":actual,"transport":"local-mod","nativeStartOperation":op});
        storage::write_json(
            root.join("owners")
                .join(format!("{}.json", storage::hash_bytes(id.as_bytes()))),
            &owner,
        )?;
        storage::write_json(
            root.join("local-start").join(format!("{op}.json")),
            &json!({"version":1,"opId":op,"originalPending":pending,"resolved":resolved,"newOwner":owner,"mapping":{"nativeId":actual,"sessionId":"local_fixture"}}),
        )?;
        storage::write_json(
            root.join("local-sync").join(&op).join("operation.json"),
            &json!({"operationId":op,"phase":"consumed","content":"Retain exact native sync intent"}),
        )?;
        storage::write_json(
            root.join("local-sync")
                .join(&op)
                .join("images/image-0.json"),
            &json!({"original":"AA==","resized":"AQ==","complete":false}),
        )?;
        storage::write_json(
            root.join("desktop-handoff.json"),
            &json!({"version":1,"kind":"claude-local-archive","actions":[{"id":"old-archive-action"}],"anchors":[{"id":"old-anchor"}]}),
        )?;
        let bridge = DesktopBridge::new(root, BTreeMap::new());
        Ok((tmp, bridge, id, op, actual))
    }
    fn confirm(bridge: &DesktopBridge, id: &str, op: &str) -> Result<Value> {
        let preview = bridge.quarantine_pending(id, op, None)?;
        bridge.quarantine_pending(id, op, preview["intent"].as_str())
    }
    #[tokio::test]
    async fn quarantine_preserves_uncertain_write_without_any_native_adapter_and_fences_readers()
    -> Result<()> {
        let (_tmp, bridge, id, op, actual) = fixture()?;
        let before = fs::read(bridge.root.join("desktop-state.json"))?;
        let handoff = private_read(&bridge.root.join("desktop-handoff.json"))?;
        let image_path = format!("local-sync/{op}/images/image-0.json");
        let image = private_read(&bridge.root.join(&image_path))?;
        let preview = bridge.quarantine_pending(&id, &op, None)?;
        assert_eq!(
            private_read(&bridge.root.join("desktop-handoff.json"))?.identity,
            handoff.identity
        );
        assert_eq!(fs::read(bridge.root.join("desktop-state.json"))?, before);
        assert!(!receipt_path(&bridge.root, &op).exists());
        let answer = bridge.quarantine_pending(&id, &op, preview["intent"].as_str())?;
        assert_eq!(answer["resolved"], false);
        let receipt = read_receipt(&bridge.root, &op, answer["intent"].as_str().unwrap())?;
        assert_eq!(decoded(&receipt["ledger"])?, before);
        assert_eq!(decoded(&receipt["handoff"])?, handoff.bytes);
        assert_eq!(decoded(&receipt["files"][&image_path])?, image.bytes);
        assert_eq!(
            private_read(&bridge.root.join(&image_path))?.identity,
            image.identity
        );
        assert_eq!(
            storage::read_json(bridge.root.join("desktop-handoff.json"))?["actions"],
            json!([])
        );
        assert_eq!(
            storage::read_json(bridge.root.join("desktop-handoff.json"))?["anchors"],
            json!([])
        );
        let state = bridge.status()?;
        assert!(state.pending.is_none());
        assert!(!state.conversations[&id].tracked());
        assert_eq!(state.conversations[&id].canonical.count, 2);
        assert_eq!(state.records.len(), 3);
        assert!(state.records.iter().any(|r| r.native_id == actual));
        for record in &state.records {
            assert!(
                format!("{:#}", bridge.inspect(record).await.unwrap_err())
                    .contains("inert evidence")
            );
            assert_eq!(
                bridge
                    .track(
                        Record::source(record.side, &record.path, &record.native_id),
                        None
                    )
                    .await?["existing"],
                true
            );
        }
        assert_eq!(bridge.sync(&id).await?["quarantined"], true);
        assert!(
            format!("{:#}", bridge.resume_tracking(&id).await.unwrap_err())
                .contains("explicit transaction resolution")
        );
        let restarted = DesktopBridge::new(&bridge.root, BTreeMap::new());
        assert_eq!(
            restarted.quarantine_pending(&id, &op, preview["intent"].as_str())?["changed"],
            false
        );
        assert_eq!(
            restarted.quarantine_pending(&id, &op, None)?["quarantined"],
            true
        );
        Ok(())
    }
    #[test]
    fn quarantine_restarts_after_receipt_publication_without_rewriting_receipt() -> Result<()> {
        let (_tmp, bridge, id, op, _) = fixture()?;
        let candidate = capture_candidate(&bridge.root, &bridge.status()?, &id, &op)?;
        let intent = storage::hash_json(&candidate)?;
        let path = receipt_path(&bridge.root, &op);
        storage::publish_exclusive(&path, serde_json::to_vec_pretty(&candidate)?)?;
        let before = private_read(&path)?.identity;
        let restarted = DesktopBridge::new(&bridge.root, BTreeMap::new());
        assert_eq!(
            restarted.quarantine_pending(&id, &op, Some(&intent))?["changed"],
            true
        );
        assert_eq!(private_read(&path)?.identity, before);
        Ok(())
    }
    #[test]
    fn quarantine_recovers_crash_after_metadata_revocation_without_losing_the_old_manifest()
    -> Result<()> {
        let (_tmp, bridge, id, op, _) = fixture()?;
        let original = capture_candidate(&bridge.root, &bridge.status()?, &id, &op)?;
        let intent = storage::hash_json(&original)?;
        storage::publish_exclusive(
            receipt_path(&bridge.root, &op),
            serde_json::to_vec_pretty(&original)?,
        )?;
        crate::local_handoff::revoke(&bridge.root, false)?;
        let revoked = private_read(&bridge.root.join("desktop-handoff.json"))?.identity;
        let restarted = DesktopBridge::new(&bridge.root, BTreeMap::new());
        assert_eq!(
            restarted.quarantine_pending(&id, &op, None)?["intent"],
            intent
        );
        assert!(restarted.status()?.pending.is_some());
        assert_eq!(
            restarted.quarantine_pending(&id, &op, Some(&intent))?["changed"],
            true
        );
        assert_eq!(
            private_read(&bridge.root.join("desktop-handoff.json"))?.identity,
            revoked
        );
        assert_eq!(read_receipt(&bridge.root, &op, &intent)?, original);
        assert_eq!(
            restarted.quarantine_pending(&id, &op, Some(&intent))?["changed"],
            false
        );
        Ok(())
    }
    #[test]
    fn quarantine_refuses_drifted_subtree_or_archive_authority_after_receipt_publication()
    -> Result<()> {
        for target in ["local-sync", "desktop-handoff"] {
            let (_tmp, bridge, id, op, _) = fixture()?;
            let original = capture_candidate(&bridge.root, &bridge.status()?, &id, &op)?;
            let intent = storage::hash_json(&original)?;
            storage::publish_exclusive(
                receipt_path(&bridge.root, &op),
                serde_json::to_vec_pretty(&original)?,
            )?;
            let path = if target == "local-sync" {
                bridge
                    .root
                    .join("local-sync")
                    .join(&op)
                    .join("operation.json")
            } else {
                bridge.root.join("desktop-handoff.json")
            };
            let mut changed = storage::read_json(&path)?;
            changed["changed"] = json!(true);
            storage::write_json(path, &changed)?;
            assert!(bridge.quarantine_pending(&id, &op, Some(&intent)).is_err());
            assert!(bridge.status()?.pending.is_some());
            assert_eq!(read_receipt(&bridge.root, &op, &intent)?, original);
        }
        Ok(())
    }
    #[test]
    fn quarantine_refuses_unsafe_recovery_subtrees() -> Result<()> {
        for kind in ["file-symlink", "directory-symlink", "mode", "hardlink"] {
            let (_tmp, bridge, id, op, _) = fixture()?;
            let directory = bridge.root.join("local-sync").join(&op);
            let file = directory.join("operation.json");
            match kind {
                "file-symlink" => symlink(&file, directory.join("alias.json"))?,
                "directory-symlink" => symlink(directory.join("images"), directory.join("alias"))?,
                "mode" => fs::set_permissions(
                    directory.join("images"),
                    fs::Permissions::from_mode(0o755),
                )?,
                _ => fs::hard_link(&file, directory.join("alias.json"))?,
            }
            assert!(bridge.quarantine_pending(&id, &op, None).is_err(), "{kind}");
            assert!(bridge.status()?.pending.is_some());
        }
        Ok(())
    }
    #[test]
    fn quarantine_rejects_wrong_ids_changed_intent_and_changed_evidence() -> Result<()> {
        let (_tmp, bridge, id, op, _) = fixture()?;
        let preview = bridge.quarantine_pending(&id, &op, None)?;
        for (conversation, operation) in [
            (Uuid::new_v4().to_string(), op.clone()),
            (id.clone(), Uuid::new_v4().to_string()),
        ] {
            assert!(
                bridge
                    .quarantine_pending(&conversation, &operation, preview["intent"].as_str())
                    .is_err()
            );
        }
        assert!(
            bridge
                .quarantine_pending(&id, &op, Some(&"0".repeat(64)))
                .is_err()
        );
        let owner = bridge
            .root
            .join("owners")
            .join(format!("{}.json", storage::hash_bytes(id.as_bytes())));
        let mut altered = storage::read_json(&owner)?;
        altered["extra"] = json!("drift");
        storage::write_json(&owner, &altered)?;
        assert!(
            bridge
                .quarantine_pending(&id, &op, preview["intent"].as_str())
                .is_err()
        );
        assert!(bridge.status()?.pending.is_some());
        assert!(!receipt_path(&bridge.root, &op).exists());
        Ok(())
    }
    #[test]
    fn quarantine_requires_stopped_services_and_no_native_owner_leases() -> Result<()> {
        for file in [
            "app-stop.json",
            "watch.lock",
            "service-supervisor.lock",
            "operation.lock",
            "owners/unknown.json.lock",
        ] {
            let (_tmp, bridge, id, op, _) = fixture()?;
            if file == "app-stop.json" {
                fs::remove_file(bridge.root.join(file))?;
            } else {
                fs::write(bridge.root.join(file), b"occupied")?;
            }
            assert!(bridge.quarantine_pending(&id, &op, None).is_err(), "{file}");
            assert!(bridge.status()?.pending.is_some());
        }
        Ok(())
    }
    #[tokio::test]
    async fn quarantine_keeps_uncertain_snapshot_bytes_in_retention_without_native_reads()
    -> Result<()> {
        let (_tmp, bridge, id, op, _) = fixture()?;
        fs::remove_dir_all(bridge.root.join("local-start"))?;
        fs::remove_dir_all(bridge.root.join("owners"))?;
        let mut state = bridge.status()?;
        let Some(PendingOperation::Handoff(p)) = state.pending.as_mut() else {
            unreachable!()
        };
        p.record.side = Side::Codex;
        p.record.kind = "snapshot".into();
        p.record.bytes = 1234;
        bridge.save(&mut state, None)?;
        confirm(&bridge, &id, &op)?;
        let collected = bridge.collect().await?;
        assert_eq!(collected["backupBytes"], 1234);
        assert_eq!(collected["removed"], 0);
        assert_eq!(bridge.status()?.records.len(), 2);
        Ok(())
    }
    #[test]
    fn quarantine_crash_receipt_refuses_a_later_changed_intent() -> Result<()> {
        let (_tmp, bridge, id, op, _) = fixture()?;
        let original = capture_candidate(&bridge.root, &bridge.status()?, &id, &op)?;
        storage::publish_exclusive(
            receipt_path(&bridge.root, &op),
            serde_json::to_vec_pretty(&original)?,
        )?;
        let mut state = bridge.status()?;
        state.conversations.get_mut(&id).unwrap().title = "Changed intent".into();
        bridge.save(&mut state, None)?;
        assert!(confirm(&bridge, &id, &op).is_err());
        assert!(bridge.status()?.pending.is_some());
        assert_eq!(
            read_receipt(&bridge.root, &op, &storage::hash_json(&original)?)?,
            original
        );
        Ok(())
    }
    #[test]
    fn quarantine_refuses_unsafe_evidence_and_receipt_storage() -> Result<()> {
        for kind in [
            "owner-mode",
            "owner-link",
            "owner-symlink",
            "directory-mode",
            "directory-symlink",
            "receipt-link",
            "receipt-symlink",
        ] {
            let (_tmp, bridge, id, op, _) = fixture()?;
            let owner = bridge
                .root
                .join("owners")
                .join(format!("{}.json", storage::hash_bytes(id.as_bytes())));
            let receipt = receipt_path(&bridge.root, &op);
            match kind {
                "owner-mode" => fs::set_permissions(&owner, fs::Permissions::from_mode(0o644))?,
                "owner-link" => fs::hard_link(&owner, bridge.root.join("alias"))?,
                "owner-symlink" => {
                    fs::rename(&owner, bridge.root.join("original"))?;
                    symlink(bridge.root.join("original"), &owner)?;
                }
                "directory-mode" => {
                    storage::private_directory(receipt.parent().unwrap())?;
                    fs::set_permissions(
                        receipt.parent().unwrap(),
                        fs::Permissions::from_mode(0o755),
                    )?;
                }
                "directory-symlink" => {
                    storage::private_directory(bridge.root.join("other"))?;
                    symlink(bridge.root.join("other"), receipt.parent().unwrap())?;
                }
                "receipt-link" => {
                    storage::private_directory(receipt.parent().unwrap())?;
                    fs::hard_link(&owner, &receipt)?;
                }
                _ => {
                    storage::private_directory(receipt.parent().unwrap())?;
                    symlink(&owner, &receipt)?;
                }
            }
            let outcome = if kind.starts_with("owner") {
                bridge.quarantine_pending(&id, &op, None)
            } else {
                confirm(&bridge, &id, &op)
            };
            assert!(outcome.is_err(), "{kind}");
            assert!(bridge.status()?.pending.is_some());
        }
        Ok(())
    }
    #[test]
    fn quarantine_refuses_missing_replaced_modified_or_exposed_receipts_even_with_cached_state()
    -> Result<()> {
        for kind in ["missing", "replaced", "modified", "mode", "link", "symlink"] {
            let (_tmp, bridge, id, op, _) = fixture()?;
            let answer = confirm(&bridge, &id, &op)?;
            bridge.status()?;
            let path = receipt_path(&bridge.root, &op);
            match kind {
                "missing" => fs::remove_file(&path)?,
                "replaced" => {
                    let bytes = fs::read(&path)?;
                    storage::atomic_write(&path, bytes)?;
                }
                "modified" => fs::write(&path, b"altered")?,
                "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?,
                "link" => fs::hard_link(&path, bridge.root.join("alias"))?,
                _ => {
                    fs::rename(&path, bridge.root.join("original"))?;
                    symlink(bridge.root.join("original"), &path)?;
                }
            }
            assert!(bridge.status().is_err(), "{kind}");
            assert!(
                bridge
                    .quarantine_pending(&id, &op, answer["intent"].as_str())
                    .is_err(),
                "{kind}"
            );
        }
        Ok(())
    }
}
