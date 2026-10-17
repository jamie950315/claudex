//! Bounded, expiring native Local archive intents. This publisher never writes
//! native registries or transcripts and never grants a transcript writer lease.
use crate::{
    bridge::Side,
    codecs,
    desktop::{Conversation, Reading, Record, State},
    desktop_mapping,
    history::digest_bytes,
};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, FileIdentity, StableFile};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_METADATA: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT: usize = 512 * 1024 * 1024;
#[async_trait]
pub trait Inspector: Sync {
    async fn inspect_handoff(&self, record: &Record) -> Result<Reading>;
}
#[derive(Debug)]
pub struct Deferred(pub &'static str);
impl std::fmt::Display for Deferred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Claude Local handoff deferred: {}", self.0)
    }
}
impl std::error::Error for Deferred {}
fn canonical(value: &str) -> bool {
    let path = Path::new(value);
    if !path.is_absolute() || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return false;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Normal(_) => {
                normalized.push(component)
            }
            _ => return false,
        }
    }
    normalized.as_os_str() == std::ffi::OsStr::new(value)
}
fn uuid(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() == 36 && Uuid::parse_str(s).is_ok())
}
fn remote(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("cse_"))
        .is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 200
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}
fn truthy(value: &Value) -> bool {
    !value.is_null() && *value != false && *value != "" && *value != 0
}
fn directory(path: &Path) -> Result<FileIdentity> {
    storage::require_private_directory(path)?;
    ensure!(
        fs::canonicalize(path)? == path,
        "Local handoff directory is not canonical."
    );
    Ok(FileIdentity::from_metadata(&fs::symlink_metadata(path)?))
}
fn identity(path: &Path, limit: usize, private: bool) -> Result<FileIdentity> {
    ensure!(
        path.to_str().is_some_and(canonical) && fs::canonicalize(path)? == path,
        "Local handoff file path is not canonical."
    );
    let metadata = fs::symlink_metadata(path)?;
    let identity = FileIdentity::from_metadata(&metadata);
    ensure!(
        metadata.is_file()
            && identity.uid == storage::uid().to_string()
            && identity.nlink == "1"
            && metadata.len() <= limit as u64
            && (!private || identity.mode.parse::<u32>()? & 0o7777 == 0o600),
        "Local handoff file is not bounded, owned, regular and single-link."
    );
    Ok(identity)
}
fn metadata(path: &Path) -> Result<StableFile> {
    bounded_metadata(path, MAX_METADATA)
}
/// Owner metadata may reach the owner writer's bound (it keeps the last
/// appended packet), unlike the handoff manifest written here.
fn owner_metadata(path: &Path) -> Result<StableFile> {
    bounded_metadata(path, crate::owner::OWNER_STATE_LIMIT)
}
fn bounded_metadata(path: &Path, limit: usize) -> Result<StableFile> {
    let before = identity(path, limit, true)?;
    let data = storage::read_stable_with_limit(path, limit)?;
    ensure!(
        data.identity == before,
        "Local handoff metadata changed before read."
    );
    Ok(data)
}
fn manifest(root: &Path) -> Result<Option<StableFile>> {
    let data = match metadata(&root.join("desktop-handoff.json")) {
        Ok(data) => data,
        Err(e) if storage::is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let value: Value = serde_json::from_slice(&data.bytes)?;
    ensure!(
        value.is_object()
            && value["version"] == 1
            && value["kind"] == "claude-local-archive"
            && value["actions"].as_array().is_some_and(|a| a.len() <= 32)
            && value
                .get("anchors")
                .is_none_or(|a| a.as_array().is_some_and(|a| a.len() <= 4096)),
        "Existing Local handoff manifest is not owned metadata."
    );
    Ok(Some(data))
}
fn unchanged(path: &Path, saved: &FileIdentity, private: bool) -> Result<()> {
    ensure!(
        &identity(
            path,
            if private {
                // Exact identity equality is the proof; the manifest writer
                // enforces its own tighter bound.
                crate::owner::OWNER_STATE_LIMIT
            } else {
                MAX_TRANSCRIPT
            },
            private
        )? == saved,
        "Local handoff observation changed."
    );
    Ok(())
}
fn write_manifest(root: &Path, actions: &[Value], anchors: &[Value], now: u64) -> Result<bool> {
    let root_before = directory(root)?;
    let previous = manifest(root)?;
    let value = json!({"version":1,"kind":"claude-local-archive","generatedAt":if actions.is_empty(){Value::Null}else{json!(now)},
        "expiresAt":if actions.is_empty(){Value::Null}else{json!(now+15_000)},"actions":actions,
        "anchorsUpdatedAt":if anchors.is_empty(){Value::Null}else{json!(now)},"anchors":anchors});
    // An empty configuration-only pass must not renew presentation timestamps.
    if let Some(previous) = &previous {
        let old: Value = serde_json::from_slice(&previous.bytes)?;
        if actions.is_empty()
            && old["actions"].as_array().is_some_and(Vec::is_empty)
            && old["anchors"] == value["anchors"]
        {
            return Ok(false);
        }
    }
    let bytes = format!("{}\n", claudex_core::json::stringify(&value)?).into_bytes();
    ensure!(
        bytes.len() <= MAX_METADATA,
        "Local handoff manifest exceeds its byte limit."
    );
    let temporary = root.join(format!(".desktop-handoff.{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(&temporary)?;
    let created = FileIdentity::from_metadata(&file.metadata()?);
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        ensure!(
            directory(root)?.same_inode(&root_before),
            "Local handoff root changed during publication."
        );
        if let Some(previous) = previous {
            unchanged(&root.join("desktop-handoff.json"), &previous.identity, true)?;
        } else {
            ensure!(
                matches!(fs::symlink_metadata(root.join("desktop-handoff.json")), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
                "Another publisher created Local handoff metadata."
            );
        }
        let staged = identity(&temporary, MAX_METADATA, true)?;
        ensure!(
            staged.same_inode(&created),
            "Local handoff staging inode changed."
        );
        fs::rename(&temporary, root.join("desktop-handoff.json"))?;
        fs::File::open(root)?.sync_all()?;
        Ok(true)
    })();
    if fs::symlink_metadata(&temporary)
        .is_ok_and(|m| FileIdentity::from_metadata(&m).same_inode(&created))
    {
        fs::remove_file(temporary)?;
    }
    result
}
pub fn revoke(root: &Path, keep_anchors: bool) -> Result<bool> {
    let anchors = if keep_anchors {
        manifest(root)?
            .map(|s| serde_json::from_slice::<Value>(&s.bytes))
            .transpose()?
            .and_then(|v| v["anchors"].as_array().cloned())
            .unwrap_or_default()
    } else {
        vec![]
    };
    write_manifest(root, &[], &anchors, storage::now_ms().try_into()?)
}
#[derive(Clone)]
struct Candidate {
    original: Record,
    current: Record,
    conversation: Conversation,
}
fn candidates(state: &State) -> Result<Vec<Candidate>> {
    ensure!(state.version == 2, "Invalid Local handoff ledger.");
    if state.pending.is_some() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for current in state.records.iter().filter(|r| {
        r.side == Side::Claude
            && r.status == "current"
            && r.kind == "owner"
            && r.managed
            && r.verified
            && state
                .conversations
                .get(&r.conversation_id)
                .is_some_and(Conversation::tracked)
    }) {
        let originals = state
            .records
            .iter()
            .filter(|r| {
                r.conversation_id == current.conversation_id
                    && r.side == Side::Claude
                    && r.status == "original"
                    && r.kind == "original"
                    && !r.managed
                    && r.verified
            })
            .collect::<Vec<_>>();
        if originals.is_empty() {
            continue;
        }
        ensure!(
            originals.len() == 1,
            "Ambiguous Local predecessor originals."
        );
        let original = originals[0];
        let conversation = &state.conversations[&current.conversation_id];
        if original.cwd != conversation.cwd
            && current.cwd == conversation.cwd
            && state.records.iter().any(|r| {
                r.conversation_id == current.conversation_id
                    && r.status == "current"
                    && r.extra.get("relocation").is_some_and(|v| {
                        v["kind"] == "codex-project-move" && v["originCwd"] == original.cwd
                    })
            })
        {
            continue;
        }
        original.checkpoint.validate()?;
        conversation.canonical.validate()?;
        ensure!(
            Uuid::parse_str(&conversation.id).is_ok()
                && conversation.id == current.conversation_id
                && Uuid::parse_str(&current.native_id).is_ok()
                && Uuid::parse_str(&original.native_id).is_ok()
                && current.native_id != original.native_id
                && canonical(&conversation.cwd)
                && original.cwd == conversation.cwd
                && current.cwd == conversation.cwd
                && original.path.to_str().is_some_and(canonical)
                && current.path.to_str().is_some_and(canonical)
                && current.checkpoint == conversation.canonical
                && original.checkpoint.count < conversation.canonical.count
                && !conversation.title.trim().is_empty()
                && conversation.title.encode_utf16().count() <= 4096
                && !conversation
                    .title
                    .chars()
                    .any(|c| c <= '\u{1f}' || c == '\u{7f}'),
            "Invalid Local predecessor or promoted replacement ledger identity."
        );
        result.push(Candidate {
            original: original.clone(),
            current: current.clone(),
            conversation: conversation.clone(),
        });
    }
    result.sort_by(|a, b| a.conversation.id.cmp(&b.conversation.id));
    ensure!(
        result.len() <= 4096
            && result
                .windows(2)
                .all(|w| w[0].conversation.id != w[1].conversation.id),
        "Duplicated or excessive Local handoff candidates."
    );
    Ok(result)
}
fn owner(root: &Path, candidate: &Candidate) -> Result<(PathBuf, StableFile, Value)> {
    directory(&root.join("owners"))?;
    let path = root.join("owners").join(format!(
        "{}.json",
        digest_bytes(candidate.conversation.id.as_bytes())
    ));
    let saved = owner_metadata(&path)?;
    let data: Value = serde_json::from_slice(&saved.bytes)?;
    ensure!(
        data.is_object()
            && data["version"] == 1
            && data["conversationId"] == candidate.conversation.id
            && data["sessionId"] == candidate.current.native_id
            && data["cwd"] == candidate.conversation.cwd
            && data["claudeHome"].as_str().is_some_and(canonical)
            && codecs::claude_path(
                Path::new(data["claudeHome"].as_str().unwrap()),
                &candidate.conversation.cwd,
                &candidate.current.native_id
            )? == candidate.current.path
            && data["registration"] == "registered"
            && remote(&data["remoteId"])
            && !truthy(&data["blocked"]),
        "Invalid registered Local replacement owner."
    );
    Ok((path, saved, data))
}
fn retain_anchors(root: &Path, registry: &Path, state: &State, anchors: &[Value]) -> Vec<Value> {
    let result = (|| -> Result<Vec<Value>> {
        ensure!(
            anchors.len() <= 4096,
            "Too many Local presentation anchors."
        );
        let mut selected = vec![];
        for anchor in anchors {
            let Some(id) = anchor["conversationId"].as_str() else {
                continue;
            };
            let Some(conversation) = state
                .conversations
                .get(id)
                .filter(|c| c.tracked() && c.id == id && json!(c.cwd) == anchor["cwd"])
            else {
                continue;
            };
            if !uuid(&anchor["conversationId"])
                || !uuid(&anchor["nativeId"])
                || !uuid(&anchor["replacementNativeId"])
                || !remote(&anchor["remoteId"])
                || anchors.iter().filter(|a| a["conversationId"] == id).count() != 1
            {
                continue;
            }
            let originals = state
                .records
                .iter()
                .filter(|r| {
                    r.conversation_id == id
                        && r.side == Side::Claude
                        && r.status == "original"
                        && !r.managed
                        && r.verified
                        && r.kind == "original"
                })
                .collect::<Vec<_>>();
            let currents = state
                .records
                .iter()
                .filter(|r| {
                    r.conversation_id == id
                        && r.side == Side::Claude
                        && r.status == "current"
                        && r.managed
                        && r.verified
                        && r.kind == "owner"
                })
                .collect::<Vec<_>>();
            if originals.len() != 1
                || currents.len() != 1
                || anchor["nativeId"] != originals[0].native_id
                || anchor["replacementNativeId"] != currents[0].native_id
                || originals[0].cwd != conversation.cwd
                || currents[0].cwd != conversation.cwd
            {
                continue;
            }
            selected.push((
                anchor.clone(),
                Candidate {
                    original: originals[0].clone(),
                    current: currents[0].clone(),
                    conversation: conversation.clone(),
                },
            ));
        }
        if selected.is_empty() {
            return Ok(vec![]);
        }
        let ids = selected
            .iter()
            .map(|(_, c)| c.original.native_id.clone())
            .collect::<Vec<_>>();
        let mappings = desktop_mapping::mappings(registry, &ids)?;
        let mut retained = vec![];
        let mut owners = vec![];
        for (mut anchor, candidate) in selected {
            let Some(mapping) = mappings.get(&candidate.original.native_id.to_lowercase()) else {
                continue;
            };
            if mapping["sessionId"] != anchor["localSessionId"]
                || mapping["nativeId"] != anchor["nativeId"]
                || mapping["cwd"] != anchor["cwd"]
            {
                continue;
            }
            let path = root.join("owners").join(format!(
                "{}.json",
                digest_bytes(candidate.conversation.id.as_bytes())
            ));
            let Ok(saved) = owner_metadata(&path) else {
                continue;
            };
            let data: Value = serde_json::from_slice(&saved.bytes)?;
            if data["version"] != 1
                || data["conversationId"] != anchor["conversationId"]
                || data["sessionId"] != anchor["replacementNativeId"]
                || data["cwd"] != anchor["cwd"]
                || data["remoteId"] != anchor["remoteId"]
                || data["registration"] != "registered"
            {
                continue;
            }
            owners.push((path, saved.identity));
            anchor["title"] = mapping["title"].clone();
            retained.push(anchor);
        }
        for (path, saved) in owners {
            unchanged(&path, &saved, true)?;
        }
        let latest = desktop_mapping::mappings(registry, &ids)?;
        Ok(retained
            .iter()
            .filter(|a| {
                latest
                    .get(&a["nativeId"].as_str().unwrap().to_lowercase())
                    .is_some_and(|m| {
                        m["sessionId"] == a["localSessionId"]
                            && m["nativeId"] == a["nativeId"]
                            && m["cwd"] == a["cwd"]
                            && m["title"] == a["title"]
                    })
                    && retained
                        .iter()
                        .filter(|b| {
                            b["remoteId"] == a["remoteId"]
                                || b["localSessionId"] == a["localSessionId"]
                                || b["nativeId"] == a["nativeId"]
                        })
                        .count()
                        == 1
            })
            .cloned()
            .collect())
    })();
    result.unwrap_or_default()
}
#[derive(Clone)]
struct Entry {
    hint: Value,
    verified_at: u64,
    archived: bool,
    action: Value,
    owner_path: PathBuf,
    owner: FileIdentity,
    original: PathBuf,
    original_identity: FileIdentity,
    current: PathBuf,
    current_identity: FileIdentity,
    mapping: Value,
}
#[derive(Default)]
pub struct Publisher {
    verified: BTreeMap<String, Entry>,
    last_verified: Option<String>,
}
impl Publisher {
    pub async fn publish(
        &mut self,
        root: &Path,
        registry: &Path,
        state: &State,
        scope: Option<&BTreeSet<String>>,
        inspector: &dyn Inspector,
        now: u64,
    ) -> Result<Value> {
        let previous = manifest(root)?
            .map(|s| serde_json::from_slice::<Value>(&s.bytes))
            .transpose()?
            .unwrap_or(Value::Null);
        let previous_anchors = previous["anchors"].as_array().cloned().unwrap_or_default();
        let result = self
            .run(
                root,
                registry,
                state,
                scope,
                inspector,
                now,
                &previous,
                &previous_anchors,
            )
            .await;
        if result.is_err() {
            self.verified.clear();
            let anchors = retain_anchors(root, registry, state, &previous_anchors);
            let changed = write_manifest(root, &[], &anchors, now)?;
            if let Some(error) = result
                .as_ref()
                .err()
                .and_then(|e| e.downcast_ref::<Deferred>())
            {
                return Ok(
                    json!({"changed":changed,"actions":0,"anchors":anchors.len(),"acknowledged":[],"deferred":error.0}),
                );
            }
        }
        result
    }
    async fn run(
        &mut self,
        root: &Path,
        registry: &Path,
        state: &State,
        scope: Option<&BTreeSet<String>>,
        inspector: &dyn Inspector,
        now: u64,
        previous: &Value,
        previous_anchors: &[Value],
    ) -> Result<Value> {
        ensure!(
            now <= 9_007_199_254_725_991,
            "Invalid Local handoff publication clock."
        );
        ensure!(
            canonical(&root.to_string_lossy()) && canonical(&registry.to_string_lossy()),
            "Local handoff roots are not canonical."
        );
        let selected = candidates(state)?;
        self.verified
            .retain(|id, _| selected.iter().any(|c| &c.conversation.id == id));
        if state.pending.is_some() {
            self.verified.clear();
            let anchors = retain_anchors(root, registry, state, previous_anchors);
            return Ok(
                json!({"changed":write_manifest(root,&[],&anchors,now)?,"actions":0,"anchors":anchors.len(),"deferred":"pending","acknowledged":[]}),
            );
        }
        let mappings = desktop_mapping::mappings(
            registry,
            &selected
                .iter()
                .map(|c| c.original.native_id.clone())
                .collect::<Vec<_>>(),
        )?;
        let mut ready = vec![];
        let mut dirty = vec![];
        let mut remotes = BTreeSet::new();
        for candidate in selected {
            let id = &candidate.conversation.id;
            let Some(mapping) = mappings.get(&candidate.original.native_id.to_lowercase()) else {
                self.verified.remove(id);
                continue;
            };
            ensure!(
                mapping["cwd"] == candidate.conversation.cwd
                    && mapping["title"] == candidate.conversation.title,
                "Local original title or cwd differs from its logical conversation."
            );
            let (owner_path, saved, data) = owner(root, &candidate)?;
            ensure!(
                remotes.insert(data["remoteId"].as_str().unwrap().to_owned()),
                "Duplicated Local replacement Remote Control identity."
            );
            if !data["pending"].is_null()
                || !data["reset"].is_null()
                || !data["displayTitleMigration"].is_null()
            {
                return Err(Deferred("owner_transition").into());
            }
            if scope.is_some_and(|s| !s.contains(id)) {
                continue;
            }
            let original_identity = identity(&candidate.original.path, MAX_TRANSCRIPT, false)?;
            let current_identity = identity(&candidate.current.path, MAX_TRANSCRIPT, false)?;
            let hint = json!({"original":candidate.original,"current":candidate.current,"conversation":candidate.conversation,"mapping":mapping,"ownerIdentity":saved.identity,"originalIdentity":original_identity,"currentIdentity":current_identity});
            let prior = self.verified.get(id);
            let scoped_valid = scope.is_none()
                || previous["expiresAt"].as_u64().is_some_and(|v| v > now)
                    && previous["generatedAt"].as_u64().is_some_and(|v| v <= now)
                    && previous["actions"].as_array().is_some_and(|a| {
                        a.iter().any(|a| {
                            prior.is_some_and(|p| a["operationId"] == p.action["operationId"])
                        })
                    });
            if let Some(prior) = prior.filter(|p| {
                p.hint == hint
                    && now >= p.verified_at
                    && now - p.verified_at < 60_000
                    && scoped_valid
            }) {
                ready.push(prior.clone());
            } else {
                dirty.push((
                    candidate,
                    mapping.clone(),
                    owner_path,
                    saved.identity,
                    data,
                    original_identity,
                    current_identity,
                    hint,
                ));
            }
        }
        let mut acknowledged = vec![];
        if !dirty.is_empty() {
            let anchors = retain_anchors(root, registry, state, previous_anchors);
            write_manifest(root, &[], &anchors, now)?;
            // The dirty inventory changes as proofs expire. An index into that
            // shrinking list can repeatedly skip the same conversation.
            let index = self
                .last_verified
                .as_ref()
                .and_then(|last| dirty.iter().position(|(c, ..)| c.conversation.id > *last))
                .unwrap_or(0);
            let (
                candidate,
                mapping,
                owner_path,
                owner_identity,
                data,
                original_identity,
                current_identity,
                hint,
            ) = dirty.swap_remove(index);
            self.last_verified = Some(candidate.conversation.id.clone());
            for (record, checkpoint) in [
                (&candidate.original, &candidate.original.checkpoint),
                (&candidate.current, &candidate.conversation.canonical),
            ] {
                let mut read = inspector.inspect_handoff(record).await?;
                // Checkpoints name the coordinator's portable messages, not
                // raw codec rows (which may include empty thinking-only rows).
                read.common.make_portable();
                for message in &mut read.common.messages {
                    message.extra.clear();
                }
                crate::history::assert_complete(&read.common)?;
                ensure!(
                    read.native_id == record.native_id
                        && read.path == record.path
                        && !read.incomplete_tail
                        && read.common.cwd()? == candidate.conversation.cwd
                        && checkpoint.exact(&read.common)?,
                    "Local handoff history differs from its complete saved checkpoint."
                );
            }
            unchanged(&candidate.original.path, &original_identity, false)
                .map_err(|_| Deferred("history_changed"))?;
            unchanged(&candidate.current.path, &current_identity, false)
                .map_err(|_| Deferred("history_changed"))?;
            unchanged(&owner_path, &owner_identity, true)?;
            ensure!(
                desktop_mapping::mappings(registry, &[candidate.original.native_id.clone()])?
                    .get(&candidate.original.native_id.to_lowercase())
                    == Some(&mapping),
                "Local native registration changed during verification."
            );
            let raw = storage::read_stable_with_limit(&candidate.original.path, MAX_TRANSCRIPT)?;
            ensure!(
                raw.identity == original_identity,
                "Original Local history changed before prefix proof."
            );
            let mut original_proof = json!({"checkpoint":candidate.original.checkpoint,"path":candidate.original.path,"bytes":raw.bytes.len(),"sha256":digest_bytes(&raw.bytes),"fileIdentity":original_identity});
            let previous_action = self
                .verified
                .get(&candidate.conversation.id)
                .map(|e| &e.action)
                .or_else(|| {
                    previous["actions"].as_array().and_then(|a| {
                        a.iter().find(|a| {
                            a["conversationId"] == candidate.conversation.id
                                && a["localSessionId"] == mapping["sessionId"]
                                && a["nativeId"] == candidate.original.native_id
                                && a["remoteId"] == data["remoteId"]
                        })
                    })
                });
            if mapping["isArchived"] == true {
                if let Some(previous_action) = previous_action {
                    let saved = &previous_action["originalProof"];
                    let length = saved["bytes"]
                        .as_u64()
                        .and_then(|n| usize::try_from(n).ok())
                        .filter(|n| *n <= raw.bytes.len())
                        .ok_or_else(|| {
                            anyhow::anyhow!("Saved Local original prefix length is invalid.")
                        })?;
                    ensure!(
                        saved["path"] == json!(candidate.original.path)
                            && saved["checkpoint"] == json!(candidate.original.checkpoint)
                            && crate::packet::hex_digest(&saved["sha256"])
                            && saved["sha256"] == digest_bytes(&raw.bytes[..length]),
                        "Archived Local original no longer preserves its verified byte prefix."
                    );
                    original_proof = saved.clone();
                }
            }
            let action = json!({"operationId":Uuid::new_v4(),"conversationId":candidate.conversation.id,"localSessionId":mapping["sessionId"],"nativeId":candidate.original.native_id,"remoteId":data["remoteId"],
                "cwd":candidate.conversation.cwd,"title":candidate.conversation.title,"expectedLastActivityAt":mapping["lastActivityAt"],"registryProof":{"path":mapping["registryPath"],"identity":mapping["registryIdentity"]},
                "originalProof":original_proof,"replacement":{"nativeId":candidate.current.native_id,"checkpoint":candidate.conversation.canonical}});
            let archived = mapping["isArchived"] == true;
            let entry = Entry {
                hint,
                verified_at: now,
                archived,
                action,
                owner_path,
                owner: owner_identity,
                original: candidate.original.path,
                original_identity,
                current: candidate.current.path,
                current_identity,
                mapping,
            };
            if archived {
                acknowledged.push(json!({"conversationId":entry.action["conversationId"],"localSessionId":entry.action["localSessionId"]}));
            }
            self.verified
                .insert(candidate.conversation.id, entry.clone());
            ready.push(entry);
        }
        let latest = desktop_mapping::mappings(
            registry,
            &ready
                .iter()
                .map(|e| e.action["nativeId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
        )?;
        for entry in &ready {
            unchanged(&entry.owner_path, &entry.owner, true)?;
            unchanged(&entry.original, &entry.original_identity, false)?;
            unchanged(&entry.current, &entry.current_identity, false)?;
            ensure!(
                latest.get(&entry.action["nativeId"].as_str().unwrap().to_lowercase())
                    == Some(&entry.mapping),
                "Local observations changed before publication."
            );
        }
        let actions = ready
            .iter()
            .filter(|e| !e.archived)
            .take(32)
            .map(|e| e.action.clone())
            .collect::<Vec<_>>();
        let mut anchor_candidates = previous_anchors
            .iter()
            .filter_map(|a| {
                a["conversationId"]
                    .as_str()
                    .map(|id| (id.to_owned(), a.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        for entry in ready {
            let a = entry.action;
            anchor_candidates.insert(a["conversationId"].as_str().unwrap().into(),json!({"conversationId":a["conversationId"],"localSessionId":a["localSessionId"],"nativeId":a["nativeId"],"replacementNativeId":a["replacement"]["nativeId"],"remoteId":a["remoteId"],"cwd":a["cwd"],"title":a["title"]}));
        }
        let anchors = retain_anchors(
            root,
            registry,
            state,
            &anchor_candidates.into_values().collect::<Vec<_>>(),
        );
        Ok(
            json!({"changed":write_manifest(root,&actions,&anchors,now)?,"actions":actions.len(),"anchors":anchors.len(),"acknowledged":acknowledged,"deferred":if dirty.is_empty(){Value::Null}else{json!("verification_queue")}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        desktop::Checkpoint,
        history::{Common, Message},
    };
    use serde_json::Map;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicUsize, Ordering},
    };
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        registry: PathBuf,
        state: State,
        original: Record,
        current: Record,
        common: Common,
        local: String,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let root = fs::canonicalize(temp.path())?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            let registry = storage::private_directory(root.join("registry"))?;
            let claude = storage::private_directory(root.join("claude"))?;
            let cwd = storage::private_directory(root.join("project"))?
                .to_string_lossy()
                .into_owned();
            let id = Uuid::new_v4().to_string();
            let original_id = Uuid::new_v4().to_string();
            let current_id = Uuid::new_v4().to_string();
            let local = format!("local_{}", Uuid::new_v4());
            let common = Common {
                meta: json!({"cwd":cwd}).as_object().unwrap().clone(),
                messages: vec![
                    Message::text("user", "question"),
                    Message::text("assistant", "first"),
                    Message::text("user", "next"),
                    Message::text("assistant", "second"),
                ],
                extra: Map::new(),
            };
            let mut original =
                Record::source(Side::Claude, &root.join("original.jsonl"), &original_id);
            original.conversation_id = id.clone();
            original.cwd = cwd.clone();
            original.verified = true;
            original.status = "original".into();
            original.checkpoint = Checkpoint::of(&Common {
                messages: common.messages[..2].to_vec(),
                ..common.clone()
            })?;
            let current_path = codecs::claude_path(&claude, &cwd, &current_id)?;
            storage::private_directory(current_path.parent().unwrap())?;
            let mut current = Record::source(Side::Claude, &current_path, &current_id);
            current.conversation_id = id.clone();
            current.cwd = cwd.clone();
            current.verified = true;
            current.managed = true;
            current.kind = "owner".into();
            current.checkpoint = Checkpoint::of(&common)?;
            fs::write(&original.path, b"original\n")?;
            fs::write(&current.path, b"replacement\n")?;
            let mut state = State::default();
            state.conversations.insert(
                id.clone(),
                Conversation {
                    id: id.clone(),
                    cwd: cwd.clone(),
                    title: "Example".into(),
                    canonical: current.checkpoint.clone(),
                    extra: Map::new(),
                },
            );
            state.records = vec![original.clone(), current.clone()];
            storage::private_directory(root.join("owners"))?;
            storage::write_json(
                root.join("owners")
                    .join(format!("{}.json", digest_bytes(id.as_bytes()))),
                &json!({"version":1,"conversationId":id,"sessionId":current_id,"cwd":cwd,"claudeHome":claude,"registration":"registered","remoteId":"cse_example"}),
            )?;
            storage::write_json(
                registry.join(format!("{local}.json")),
                &json!({"sessionId":local,"cliSessionId":original_id,"cwd":cwd,"title":"Example","lastActivityAt":1,"isArchived":false}),
            )?;
            Ok(Self {
                _temp: temp,
                root,
                registry,
                state,
                original,
                current,
                common,
                local,
            })
        }
        fn inspector(&self) -> Fake {
            Fake {
                common: self.common.clone(),
                original: self.original.clone(),
                reads: AtomicUsize::new(0),
                deferred: false,
                empty_thinking: false,
            }
        }
        fn manifest(&self) -> Value {
            storage::read_json(self.root.join("desktop-handoff.json")).unwrap()
        }
    }
    struct Fake {
        common: Common,
        original: Record,
        reads: AtomicUsize,
        deferred: bool,
        empty_thinking: bool,
    }
    #[async_trait]
    impl Inspector for Fake {
        async fn inspect_handoff(&self, record: &Record) -> Result<Reading> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.deferred {
                return Err(Deferred("owner_not_idle").into());
            }
            let mut common = self.common.clone();
            if record.id == self.original.id {
                common.messages.truncate(2);
            }
            if self.empty_thinking {
                common.messages.insert(
                    1,
                    Message {
                        role: "assistant".into(),
                        content: vec![json!({"type":"thinking","text":""})],
                        extra: Map::new(),
                    },
                );
            }
            Ok(Reading {
                common,
                native_id: record.native_id.clone(),
                path: record.path.clone(),
                bytes: fs::metadata(&record.path)?.len(),
                incomplete_tail: false,
                extra: Map::new(),
            })
        }
    }
    struct Inventory(BTreeMap<String, Fake>);
    #[async_trait]
    impl Inspector for Inventory {
        async fn inspect_handoff(&self, record: &Record) -> Result<Reading> {
            self.0[&record.conversation_id].inspect_handoff(record).await
        }
    }
    #[tokio::test]
    async fn expiring_cached_candidates_cannot_starve_the_round_robin() -> Result<()> {
        let mut f = Fixture::new()?;
        let others = (0..12).map(|_| Fixture::new()).collect::<Result<Vec<_>>>()?;
        let mut inspect = Inventory(BTreeMap::from([(
            f.original.conversation_id.clone(),
            f.inspector(),
        )]));
        for other in &others {
            let id = &other.original.conversation_id;
            inspect.0.insert(id.clone(), other.inspector());
            f.state
                .conversations
                .extend(other.state.conversations.clone());
            f.state.records.extend(other.state.records.clone());
            let name = format!("{}.json", digest_bytes(id.as_bytes()));
            let mut owner = storage::read_json(other.root.join("owners").join(&name))?;
            owner["remoteId"] = json!(format!("cse_{id}"));
            storage::write_json(f.root.join("owners").join(&name), &owner)?;
            let name = format!("{}.json", other.local);
            storage::write_json(
                f.registry.join(&name),
                &storage::read_json(other.registry.join(&name))?,
            )?;
        }
        let mut publisher = Publisher::default();
        for pass in 0..13 {
            publisher
                .publish(
                    &f.root,
                    &f.registry,
                    &f.state,
                    None,
                    &inspect,
                    100_000 + pass * 30_000,
                )
                .await?;
        }
        for (id, inspector) in &inspect.0 {
            assert_eq!(inspector.reads.load(Ordering::SeqCst), 2, "{id}");
        }
        Ok(())
    }
    #[tokio::test]
    async fn scoped_expiration_never_revives_authority_and_anchors_do_not_read_history()
    -> Result<()> {
        let f = Fixture::new()?;
        let inspect = f.inspector();
        let mut publisher = Publisher::default();
        let first = publisher
            .publish(&f.root, &f.registry, &f.state, None, &inspect, 100_000)
            .await?;
        assert_eq!(first["actions"], 1);
        assert_eq!(first["anchors"], 1);
        assert_eq!(inspect.reads.load(Ordering::SeqCst), 2);
        let action = f.manifest()["actions"][0].clone();
        assert_eq!(action["localSessionId"], f.local);
        assert_eq!(action["replacement"]["nativeId"], f.current.native_id);
        assert_eq!(f.manifest()["expiresAt"], 115_000);
        let empty = BTreeSet::new();
        let next = publisher
            .publish(
                &f.root,
                &f.registry,
                &f.state,
                Some(&empty),
                &inspect,
                116_000,
            )
            .await?;
        assert_eq!(next["actions"], 0);
        assert_eq!(next["anchors"], 1);
        assert_eq!(inspect.reads.load(Ordering::SeqCst), 2);
        let before = f.manifest();
        let next = publisher
            .publish(
                &f.root,
                &f.registry,
                &f.state,
                Some(&empty),
                &inspect,
                117_000,
            )
            .await?;
        assert_eq!(next["changed"], false);
        assert_eq!(f.manifest(), before);
        Ok(())
    }
    #[tokio::test]
    async fn checkpoint_counts_use_the_same_portable_messages_as_synchronization() -> Result<()> {
        let f = Fixture::new()?;
        let mut inspect = f.inspector();
        inspect.empty_thinking = true;
        let original = fs::read(&f.original.path)?;
        let replacement = fs::read(&f.current.path)?;
        let mut publisher = Publisher::default();
        for now in [100_000, 160_000, 220_000] {
            let result = publisher
                .publish(&f.root, &f.registry, &f.state, None, &inspect, now)
                .await?;
            assert_eq!(result["actions"], 1);
            assert_eq!(
                f.manifest()["actions"][0]["originalProof"]["checkpoint"],
                json!(f.original.checkpoint)
            );
            assert_eq!(
                f.manifest()["actions"][0]["replacement"]["checkpoint"],
                json!(f.current.checkpoint)
            );
        }
        assert_eq!(inspect.reads.load(Ordering::SeqCst), 6);
        assert_eq!(fs::read(&f.original.path)?, original);
        assert_eq!(fs::read(&f.current.path)?, replacement);
        Ok(())
    }
    #[tokio::test]
    async fn owner_activity_revokes_commands_before_slow_inspection() -> Result<()> {
        let f = Fixture::new()?;
        let inspect = f.inspector();
        let mut publisher = Publisher::default();
        publisher
            .publish(&f.root, &f.registry, &f.state, None, &inspect, 100_000)
            .await?;
        fs::write(&f.current.path, b"new activity\n")?;
        let mut busy = f.inspector();
        busy.deferred = true;
        let result = publisher
            .publish(&f.root, &f.registry, &f.state, None, &busy, 101_000)
            .await?;
        assert_eq!(result["deferred"], "owner_not_idle");
        assert_eq!(f.manifest()["actions"], json!([]));
        assert_eq!(f.manifest()["anchors"].as_array().unwrap().len(), 1);
        Ok(())
    }
    #[tokio::test]
    async fn archived_ack_requires_previous_original_prefix_preserved() -> Result<()> {
        let f = Fixture::new()?;
        let inspect = f.inspector();
        let mut publisher = Publisher::default();
        publisher
            .publish(&f.root, &f.registry, &f.state, None, &inspect, 100_000)
            .await?;
        let registry_path = f.registry.join(format!("{}.json", f.local));
        let mut registry = storage::read_json(&registry_path)?;
        registry["isArchived"] = json!(true);
        storage::write_json(&registry_path, &registry)?;
        fs::write(&f.original.path, b"original\narchival metadata\n")?;
        let result = publisher
            .publish(&f.root, &f.registry, &f.state, None, &inspect, 101_000)
            .await?;
        assert_eq!(result["actions"], 0);
        assert_eq!(result["acknowledged"].as_array().unwrap().len(), 1);
        fs::write(&f.original.path, b"modified\narchival metadata\n")?;
        assert!(
            publisher
                .publish(&f.root, &f.registry, &f.state, None, &inspect, 102_000)
                .await
                .is_err()
        );
        assert_eq!(f.manifest()["actions"], json!([]));
        Ok(())
    }
    #[tokio::test]
    async fn failed_checkpoint_never_leaves_previous_action_actionable() -> Result<()> {
        let f = Fixture::new()?;
        let inspect = f.inspector();
        let mut publisher = Publisher::default();
        publisher
            .publish(&f.root, &f.registry, &f.state, None, &inspect, 100_000)
            .await?;
        let mut changed = f.inspector();
        changed.common.messages[3] = Message::text("assistant", "different");
        fs::write(&f.current.path, b"different\n")?;
        assert!(
            publisher
                .publish(&f.root, &f.registry, &f.state, None, &changed, 101_000)
                .await
                .is_err()
        );
        assert!(f.manifest()["actions"].as_array().unwrap().is_empty());
        Ok(())
    }
}
