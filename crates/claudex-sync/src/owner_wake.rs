//! Identity-only activation hints for already published stable Claude owners.
//! No transport, transcript read, registration, discovery or model input occurs.
use crate::{
    bridge::Side,
    desktop::{Record, State},
    events::{Event, Inbox, Kind},
    history::digest_bytes,
    hooks, packet,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity, StableFile};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;
fn remote_id(id: &str) -> bool {
    id.strip_prefix("cse_").is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 200
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
fn canonical_cwd(value: &str) -> bool {
    if value.len() > 4096
        || !Path::new(value).is_absolute()
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return false;
    }
    let mut normalized = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Normal(_) => {
                normalized.push(component)
            }
            _ => return false,
        }
    }
    normalized.as_os_str() == std::ffi::OsStr::new(value)
}
fn truthy(value: &Value) -> bool {
    !value.is_null() && *value != false && *value != "" && *value != 0
}
fn validate_map(value: &Value) -> Result<()> {
    ensure!(
        packet::exact_keys(value, &["version", "entries"]) && value["version"] == 1,
        "Invalid published folder map."
    );
    let entries = value["entries"]
        .as_array()
        .filter(|e| e.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("Published folder map exceeds its bound."))?;
    let mut ids = std::collections::BTreeSet::new();
    for row in entries {
        ensure!(
            packet::exact_keys(row, &["canonicalCwd", "remoteId", "verified"])
                && row["verified"] == true
                && row["remoteId"].as_str().is_some_and(remote_id)
                && row["canonicalCwd"].as_str().is_some_and(canonical_cwd)
                && ids.insert(row["remoteId"].as_str().unwrap()),
            "Published folder map identity is invalid or duplicated."
        );
    }
    Ok(())
}
pub fn validate_request(params: &Value) -> Result<&str> {
    ensure!(
        packet::exact_keys(params, &["remoteId"])
            && params["remoteId"].as_str().is_some_and(remote_id),
        "Owner wake accepts only one exact Remote Control identity."
    );
    Ok(params["remoteId"].as_str().unwrap())
}
fn directory(path: &Path) -> Result<FileIdentity> {
    storage::require_private_directory(path)?;
    ensure!(
        fs::canonicalize(path)? == path,
        "Owner activation metadata directory is not canonical."
    );
    Ok(FileIdentity::from_metadata(&fs::symlink_metadata(path)?))
}
/// Reads owner metadata, the Desktop ledger and the folder map. The bound must
/// accept everything their writers may store; the generated map keeps its own
/// tighter byte bound at publication.
fn metadata(path: &Path) -> Result<StableFile> {
    let file = storage::read_stable_with_limit(path, crate::owner::OWNER_STATE_LIMIT)?;
    ensure!(
        file.identity.uid == storage::uid().to_string()
            && file.identity.nlink == "1"
            && file.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Owner activation metadata is not a private owned single-link file."
    );
    Ok(file)
}
pub fn ledger(root: &Path) -> Result<State> {
    directory(root)?;
    let data = metadata(&root.join("desktop-state.json"))?;
    let state: State = serde_json::from_slice(&data.bytes)?;
    ensure!(state.version == 2, "Unsupported owner activation ledger.");
    Ok(state)
}
pub struct Target {
    pub record: Record,
    pub owner: Value,
    files: Vec<(PathBuf, FileIdentity)>,
    directories: Vec<(PathBuf, FileIdentity)>,
    native: Vec<(PathBuf, FileIdentity, PathBuf, FileIdentity)>,
}
impl Target {
    pub fn recheck(&self) -> Result<()> {
        for (path, identity) in &self.directories {
            ensure!(
                directory(path)?.same_inode(identity),
                "Owner activation metadata directory changed."
            );
        }
        for (path, identity) in &self.files {
            let current = metadata(path)?;
            ensure!(
                &current.identity == identity,
                "Owner activation metadata changed before publication."
            );
        }
        for (cwd, dir, path, file) in &self.native {
            let d = fs::symlink_metadata(cwd)?;
            let f = fs::symlink_metadata(path)?;
            ensure!(
                d.is_dir()
                    && FileIdentity::from_metadata(&d).same_inode(dir)
                    && fs::canonicalize(cwd)? == *cwd
                    && f.is_file()
                    && FileIdentity::from_metadata(&f).same_inode(file)
                    && FileIdentity::from_metadata(&f).uid == storage::uid().to_string()
                    && fs::canonicalize(path)? == *path,
                "Current native project or history changed before owner activation."
            );
        }
        Ok(())
    }
}
pub enum Inspection {
    Ready(Target),
    Ignored(&'static str),
}
pub fn inspect(root: &Path, state: &State, id: &str, allow_pending: bool) -> Result<Inspection> {
    ensure!(
        remote_id(id) && state.version == 2,
        "Invalid owner activation identity or ledger."
    );
    if state.pending.is_some() && !allow_pending {
        return Ok(Inspection::Ignored("pending transaction"));
    }
    let root_id = directory(root)?;
    let map_path = root.join("folder-map.json");
    let map = match metadata(&map_path) {
        Ok(data) => data,
        Err(e) if storage::is_not_found(&e) => {
            return Ok(Inspection::Ignored("folder map unavailable"));
        }
        Err(e) => return Err(e),
    };
    let value: Value = serde_json::from_slice(&map.bytes)?;
    validate_map(&value)?;
    let entries = value["entries"].as_array().unwrap();
    let Some(row) = entries.iter().find(|row| row["remoteId"] == id) else {
        return Ok(Inspection::Ignored("unpublished Remote Control identity"));
    };
    let candidates = state
        .records
        .iter()
        .filter(|record| {
            record.side == Side::Claude
                && record.managed
                && record.verified
                && record.kind == "owner"
                && record.status == "current"
                && record
                    .extra
                    .get("retiredOwner")
                    .is_none_or(|v| v.is_null() || *v == false)
                && json!(record.cwd) == row["canonicalCwd"]
        })
        .collect::<Vec<_>>();
    ensure!(
        candidates.len() <= 4096,
        "Owner activation candidates exceed their bound."
    );
    let owners = root.join("owners");
    let mut directories = vec![(root.into(), root_id)];
    if !candidates.is_empty() {
        directories.push((owners.clone(), directory(&owners)?));
    }
    let mut files = vec![(map_path, map.identity)];
    let mut matches = vec![];
    for record in candidates {
        Uuid::parse_str(&record.conversation_id)?;
        Uuid::parse_str(&record.native_id)?;
        let path = owners.join(format!(
            "{}.json",
            digest_bytes(record.conversation_id.as_bytes())
        ));
        let saved = match metadata(&path) {
            Ok(data) => data,
            Err(e) if storage::is_not_found(&e) => continue,
            Err(e) => return Err(e),
        };
        let data: Value = serde_json::from_slice(&saved.bytes)?;
        files.push((path, saved.identity));
        if data["remoteId"] == id {
            matches.push((record.clone(), data));
        }
    }
    if matches.len() != 1 {
        return Ok(Inspection::Ignored(
            "current owner unavailable or ambiguous",
        ));
    }
    let (record, owner) = matches.pop().unwrap();
    let Some(conversation) = state
        .conversations
        .get(&record.conversation_id)
        .filter(|c| c.id == record.conversation_id && c.tracked())
    else {
        return Ok(Inspection::Ignored("conversation is not tracked"));
    };
    if conversation.cwd != record.cwd
        || owner["version"] != 1
        || owner["conversationId"] != record.conversation_id
        || owner["sessionId"] != record.native_id
        || owner["cwd"] != record.cwd
        || owner["registration"] != "registered"
    {
        return Ok(Inspection::Ignored("current owner identity changed"));
    }
    if truthy(&owner["blocked"])
        || !owner["pending"].is_null()
        || !owner["reset"].is_null()
        || !owner["displayTitleMigration"].is_null()
    {
        return Ok(Inspection::Ignored("owner is blocked or transitioning"));
    }
    let currents = state
        .records
        .iter()
        .filter(|r| r.conversation_id == record.conversation_id && r.status == "current")
        .collect::<Vec<_>>();
    if currents.len() != 2
        || [Side::Codex, Side::Claude]
            .iter()
            .any(|side| currents.iter().filter(|r| r.side == *side).count() != 1)
    {
        return Ok(Inspection::Ignored(
            "current conversation pair is unavailable or ambiguous",
        ));
    }
    let mut native = vec![];
    for current in currents {
        if current.cwd != conversation.cwd
            || !Path::new(&current.cwd).is_absolute()
            || !current.path.is_absolute()
        {
            return Ok(Inspection::Ignored("current project identity changed"));
        }
        let proof = (|| -> Result<_> {
            let cwd = PathBuf::from(&current.cwd);
            let d = fs::symlink_metadata(&cwd)?;
            let f = fs::symlink_metadata(&current.path)?;
            ensure!(
                d.is_dir()
                    && fs::canonicalize(&cwd)? == cwd
                    && f.is_file()
                    && fs::canonicalize(&current.path)? == current.path
                    && FileIdentity::from_metadata(&f).uid == storage::uid().to_string(),
                "Current project or history is unavailable or aliased."
            );
            Ok((
                cwd,
                FileIdentity::from_metadata(&d),
                current.path.clone(),
                FileIdentity::from_metadata(&f),
            ))
        })();
        match proof {
            Ok(proof) => native.push(proof),
            Err(e)
                if storage::is_not_found(&e)
                    || e.to_string().contains("unavailable or aliased") =>
            {
                return Ok(Inspection::Ignored(
                    "current project or history is unavailable or aliased",
                ));
            }
            Err(e) => return Err(e),
        }
    }
    let target = Target {
        record,
        owner,
        files,
        directories,
        native,
    };
    target.recheck()?;
    Ok(Inspection::Ready(target))
}
/// Presentation-only projection. The caller holds the coordinator lock; no
/// transcript is opened and no native process is started for this publication.
pub fn publish_folders(root: &Path, state: &State) -> Result<Value> {
    ensure!(
        state.version == 2 && canonical_cwd(&root.to_string_lossy()),
        "A canonical private root and Desktop ledger are required."
    );
    if state.pending.is_some() {
        return Ok(json!({"changed":false,"entries":null,"deferred":"pending"}));
    }
    let root_identity = directory(root)?;
    let selected = state
        .records
        .iter()
        .filter(|r| {
            r.side == Side::Claude
                && r.managed
                && r.verified
                && r.kind == "owner"
                && r.status == "current"
                && state
                    .conversations
                    .get(&r.conversation_id)
                    .is_some_and(|c| c.tracked())
        })
        .collect::<Vec<_>>();
    ensure!(
        selected.len() <= 4096,
        "Owner count exceeds the folder projection bound."
    );
    let owners = root.join("owners");
    let owners_identity = if selected.is_empty() {
        None
    } else {
        Some(directory(&owners)?)
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut remote_ids = std::collections::BTreeSet::new();
    let mut snapshots = vec![];
    let mut entries = vec![];
    let mut unavailable = vec![];
    let mut unavailable_count = 0;
    for record in selected {
        Uuid::parse_str(&record.conversation_id)?;
        Uuid::parse_str(&record.native_id)?;
        let conversation = &state.conversations[&record.conversation_id];
        ensure!(
            conversation.id == record.conversation_id
                && canonical_cwd(&record.cwd)
                && conversation.cwd == record.cwd
                && seen.insert(&record.conversation_id),
            "Current owner ledger identity is invalid or duplicated."
        );
        let path = owners.join(format!(
            "{}.json",
            digest_bytes(record.conversation_id.as_bytes())
        ));
        let snapshot = metadata(&path)?;
        let owner: Value = serde_json::from_slice(&snapshot.bytes)?;
        ensure!(
            owner["version"] == 1
                && owner["conversationId"] == record.conversation_id
                && owner["sessionId"] == record.native_id
                && owner["cwd"] == record.cwd
                && owner["remoteId"].as_str().is_some_and(remote_id)
                && owner["registration"] == "registered"
                && !truthy(&owner["blocked"]),
            "Saved owner identity or Remote Control registration does not match its ledger."
        );
        if !owner["pending"].is_null() || !owner["reset"].is_null() {
            return Ok(json!({"changed":false,"entries":null,"deferred":"owner_transition"}));
        }
        let available = match fs::symlink_metadata(&record.cwd) {
            Ok(info) => info.is_dir() && fs::canonicalize(&record.cwd)? == Path::new(&record.cwd),
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                false
            }
            Err(error) => return Err(error.into()),
        };
        if !available {
            unavailable_count += 1;
            if unavailable.len() < 20 {
                unavailable.push(json!({"conversationId":record.conversation_id,"reason":"source cwd is not an existing canonical directory."}));
            }
            continue;
        }
        ensure!(
            remote_ids.insert(owner["remoteId"].as_str().unwrap().to_owned()),
            "Duplicate Remote Control identity in folder projection."
        );
        entries
            .push(json!({"remoteId":owner["remoteId"],"canonicalCwd":record.cwd,"verified":true}));
        snapshots.push((path, snapshot.identity));
    }
    entries.sort_by(|a, b| a["remoteId"].as_str().cmp(&b["remoteId"].as_str()));
    let value = json!({"version":1,"entries":entries});
    let mut bytes = claudex_core::json::stringify(&value)?.into_bytes();
    bytes.push(b'\n');
    ensure!(
        bytes.len() <= 2 * 1024 * 1024,
        "Generated folder map exceeds its byte bound."
    );
    let path = root.join("folder-map.json");
    let previous = match metadata(&path) {
        Ok(file) => {
            validate_map(&serde_json::from_slice::<Value>(&file.bytes)?)?;
            Some(file)
        }
        Err(error) if storage::is_not_found(&error) => None,
        Err(error) => return Err(error),
    };
    let recheck = || -> Result<()> {
        ensure!(
            directory(root)?.same_inode(&root_identity),
            "Folder projection root changed."
        );
        if let Some(identity) = &owners_identity {
            ensure!(
                directory(&owners)?.same_inode(identity),
                "Owner metadata directory changed during projection."
            );
        }
        for (path, identity) in &snapshots {
            ensure!(
                metadata(path)?.identity == *identity,
                "Owner metadata changed before folder projection publication."
            );
        }
        match &previous {
            Some(old) => ensure!(
                metadata(&path)?.identity == old.identity,
                "Folder map changed during publication."
            ),
            None => ensure!(
                matches!(fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
                "Another publisher created the folder map."
            ),
        }
        Ok(())
    };
    recheck()?;
    let mut report = json!({"changed":false,"entries":entries.len(),"deferred":null});
    if unavailable_count > 0 {
        report["unavailable"] = json!(unavailable);
        report["unavailableCount"] = json!(unavailable_count);
    }
    if previous.as_ref().is_some_and(|p| p.bytes == bytes) {
        return Ok(report);
    }
    let temporary = root.join(format!(".folder-map.{}.tmp", Uuid::new_v4()));
    storage::publish_exclusive(&temporary, &bytes)?;
    let identity = metadata(&temporary)?.identity;
    let publication = (|| -> Result<()> {
        recheck()?;
        ensure!(
            metadata(&temporary)?.identity == identity,
            "Folder map staging identity changed."
        );
        fs::rename(&temporary, &path)?;
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if publication.is_err() {
        if fs::symlink_metadata(&temporary)
            .is_ok_and(|m| FileIdentity::from_metadata(&m).same_inode(&identity))
        {
            fs::remove_file(&temporary)?;
        }
    }
    publication?;
    report["changed"] = json!(true);
    Ok(report)
}
pub struct Publisher {
    root: PathBuf,
    recent: Mutex<BTreeMap<String, Instant>>,
}
impl Publisher {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            recent: Mutex::new(BTreeMap::new()),
        }
    }
    pub async fn publish(&self, params: &Value) -> Result<Value> {
        let id = validate_request(params)?;
        let mut recent = self.recent.lock().await;
        if hooks::app_stopped(&self.root)? {
            return Ok(json!({"accepted":false,"reason":"application stopped"}));
        }
        recent.retain(|_, time| time.elapsed() < Duration::from_secs(30));
        if recent
            .get(id)
            .is_some_and(|time| time.elapsed() < Duration::from_secs(5))
            || recent.len() >= 16
        {
            return Ok(json!({"accepted":false,"reason":"rate limited"}));
        }
        let state = ledger(&self.root)?;
        let target = match inspect(&self.root, &state, id, true)? {
            Inspection::Ready(target) => target,
            Inspection::Ignored(reason) => return Ok(json!({"accepted":false,"reason":reason})),
        };
        target.recheck()?;
        if hooks::app_stopped(&self.root)? {
            return Ok(json!({"accepted":false,"reason":"application stopped"}));
        }
        let inbox = Inbox::new(&self.root)?;
        inbox.initialize()?;
        inbox
            .publish(Event {
                side: Side::Claude,
                native_id: target.record.native_id,
                kind: Kind::OwnerWake,
                turn_id: None,
                remote_id: Some(id.into()),
            })
            .await?;
        recent.insert(id.into(), Instant::now());
        Ok(json!({"accepted":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::{Checkpoint, Conversation};
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, PathBuf, State, String) {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = storage::private_directory(root.join("project")).unwrap();
        let owners = storage::private_directory(root.join("owners")).unwrap();
        let conversation_id = Uuid::new_v4().to_string();
        let mut state = State::default();
        let checkpoint = Checkpoint {
            count: 2,
            digest: Some("a".repeat(64)),
        };
        state.conversations.insert(
            conversation_id.clone(),
            Conversation {
                id: conversation_id.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                title: "A conversation".into(),
                canonical: checkpoint.clone(),
                extra: Default::default(),
            },
        );
        for side in [Side::Codex, Side::Claude] {
            let path = root.join(format!("{}.jsonl", side.name()));
            fs::write(&path, []).unwrap();
            let mut record = Record::source(side, &path, &Uuid::new_v4().to_string());
            record.conversation_id = conversation_id.clone();
            record.cwd = cwd.to_string_lossy().into_owned();
            record.verified = true;
            record.managed = true;
            record.kind = if side == Side::Claude {
                "owner"
            } else {
                "snapshot"
            }
            .into();
            record.checkpoint = checkpoint.clone();
            if side == Side::Claude {
                storage::write_json(owners.join(format!("{}.json", digest_bytes(conversation_id.as_bytes()))), &json!({"version":1,"conversationId":conversation_id,"sessionId":record.native_id,"cwd":record.cwd,"remoteId":"cse_native_owner","registration":"registered","pending":null,"reset":null})).unwrap();
            }
            state.records.push(record);
        }
        storage::write_json(
            root.join("desktop-state.json"),
            &serde_json::to_value(&state).unwrap(),
        )
        .unwrap();
        (tmp, root, state, conversation_id)
    }
    #[tokio::test]
    async fn folder_publication_and_activation_publish_only_identity_hints() {
        let (_tmp, root, state, _) = fixture();
        assert_eq!(publish_folders(&root, &state).unwrap()["entries"], 1);
        assert_eq!(publish_folders(&root, &state).unwrap()["changed"], false);
        let target = match inspect(&root, &state, "cse_native_owner", false).unwrap() {
            Inspection::Ready(t) => t,
            _ => panic!("expected ready"),
        };
        target.recheck().unwrap();
        let publisher = Publisher::new(&root);
        assert_eq!(
            publisher
                .publish(&json!({"remoteId":"cse_native_owner"}))
                .await
                .unwrap()["accepted"],
            true
        );
        assert_eq!(
            Inbox::new(&root).unwrap().list().unwrap()[0].event.kind,
            Kind::OwnerWake
        );
        assert_eq!(
            publisher
                .publish(&json!({"remoteId":"cse_native_owner"}))
                .await
                .unwrap()["reason"],
            "rate limited"
        );
        assert!(
            publisher
                .publish(&json!({"remoteId":"cse_native_owner","text":"ignored"}))
                .await
                .is_err()
        );
        fs::remove_file(root.join("codex.jsonl")).unwrap();
        assert!(matches!(
            inspect(&root, &state, "cse_native_owner", false).unwrap(),
            Inspection::Ignored(_)
        ));
    }
    #[test]
    fn unavailable_and_stopped_projects_lose_only_their_folder_override() {
        let (_tmp, root, mut state, id) = fixture();
        let cwd = &state.conversations[&id].cwd;
        fs::remove_dir(cwd).unwrap();
        let report = publish_folders(&root, &state).unwrap();
        assert_eq!(report["entries"], 0);
        assert_eq!(report["unavailableCount"], 1);
        state
            .conversations
            .get_mut(&id)
            .unwrap()
            .extra
            .insert("tracking".into(), json!({"status":"stopped","stoppedAt":1}));
        assert_eq!(publish_folders(&root, &state).unwrap()["entries"], 0);
        assert!(canonical_cwd("/"));
        assert!(canonical_cwd("/a/b"));
        for bad in ["/a/", "/a/../b", "/a/./b", "//a", "/a//b", "relative"] {
            assert!(!canonical_cwd(bad), "{bad}");
        }
    }
    #[test]
    fn owner_metadata_with_large_last_append_still_projects() {
        let (_tmp, root, state, id) = fixture();
        let path = root
            .join("owners")
            .join(format!("{}.json", digest_bytes(id.as_bytes())));
        let mut owner = storage::read_json(&path).unwrap();
        owner["lastAppend"] = json!({"operationId":"op","uuid":"u","contentHash":"h",
            "content":[{"type":"text","text":"x".repeat(3 * 1024 * 1024)}],"recovered":false});
        fs::remove_file(&path).unwrap();
        storage::write_json(&path, &owner).unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 2 * 1024 * 1024);
        assert_eq!(publish_folders(&root, &state).unwrap()["entries"], 1);
        assert!(matches!(
            inspect(&root, &state, "cse_native_owner", false).unwrap(),
            Inspection::Ready(_)
        ));
    }
}
