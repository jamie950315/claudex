//! Native adapters for the CLI projection bridge. Only newly allocated owned
//! projections are published; retirement is guarded and journaled separately.
use crate::{
    bridge::{Driver, Inspection, Record, Side},
    codecs,
    history::{Common, assert_complete, digest_bytes},
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::{
    rpc::CodexClient,
    storage::{self, FileIdentity},
};
use serde_json::{Map, Value, json};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Clone)]
pub struct NativeOptions {
    pub root: PathBuf,
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
    pub binary: PathBuf,
    pub desktop_registry: Option<PathBuf>,
}
pub struct NativeDriver {
    pub side: Side,
    pub options: NativeOptions,
    client: Arc<OnceCell<CodexClient>>,
}
pub fn drivers(options: NativeOptions) -> BTreeMap<Side, Arc<dyn Driver>> {
    let client = Arc::new(OnceCell::new());
    [Side::Codex, Side::Claude]
        .into_iter()
        .map(|side| {
            (
                side,
                Arc::new(NativeDriver {
                    side,
                    options: options.clone(),
                    client: client.clone(),
                }) as Arc<dyn Driver>,
            )
        })
        .collect()
}
pub fn physical_rollout(logical: &Path) -> Result<PathBuf> {
    match fs::symlink_metadata(logical) {
        Ok(_) => Ok(logical.into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let compressed = PathBuf::from(format!("{}.zst", logical.display()));
            fs::symlink_metadata(&compressed).with_context(|| {
                format!(
                    "Cannot inspect Codex rollout representation {} (logical path {}).",
                    compressed.display(),
                    logical.display()
                )
            })?;
            Ok(compressed)
        }
        Err(e) => {
            Err(e).with_context(|| format!("Cannot inspect Codex rollout {}.", logical.display()))
        }
    }
}
pub fn safe_native_path(path: &Path, root: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Native transcript has no parent."))?;
    let parent = fs::canonicalize(parent).with_context(|| {
        format!(
            "Cannot resolve native transcript parent {}.",
            parent.display()
        )
    })?;
    let root = fs::canonicalize(root)
        .with_context(|| format!("Cannot resolve native store {}.", root.display()))?;
    let metadata = || {
        fs::symlink_metadata(path)
            .with_context(|| format!("Cannot inspect native transcript {}.", path.display()))
    };
    ensure!(
        parent.starts_with(&root) && metadata()?.is_file() && !metadata()?.file_type().is_symlink(),
        "Native path is outside its configured store or is unsafe."
    );
    Ok(())
}
fn same_identity(path: &Path, identity: &FileIdentity) -> Result<()> {
    ensure!(
        FileIdentity::from_metadata(&fs::symlink_metadata(path)?) == *identity,
        "Native transcript changed before mutation."
    );
    Ok(())
}
impl NativeDriver {
    async fn client(&self) -> Result<&CodexClient> {
        self.client
            .get_or_try_init(|| async {
                let client =
                    CodexClient::spawn(&self.options.binary, &self.options.codex_home).await?;
                client.initialize().await?;
                Ok(client)
            })
            .await
    }
    fn located(&self, record: &Record) -> Result<PathBuf> {
        if self.side == Side::Codex {
            if let Ok(path) = physical_rollout(&record.path) {
                return Ok(path);
            }
            let archived = self.options.codex_home.join("archived_sessions").join(
                record
                    .path
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("Invalid rollout path."))?,
            );
            physical_rollout(&archived)
        } else {
            match fs::symlink_metadata(&record.path) {
                Ok(_) => Ok(record.path.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let path = self
                        .options
                        .root
                        .join("rollback")
                        .join(format!("{}.jsonl", record.native_id));
                    fs::symlink_metadata(&path)?;
                    Ok(path)
                }
                Err(e) => Err(e.into()),
            }
        }
    }
    async fn owned(&self, record: &Record) -> Result<(Inspection, storage::Snapshot)> {
        ensure!(
            record.managed && record.verified,
            "Refusing to modify unmanaged or unverified session."
        );
        Uuid::parse_str(&record.native_id)?;
        let inspection = self.inspect(record).await?;
        let raw = storage::snapshot(&inspection.path)?;
        if self.side == Side::Codex {
            ensure!(
                raw.rows.iter().any(|r| r["type"] == "session_meta"
                    && r["payload"]["originator"] == "claudex"
                    && r["payload"]["id"] == record.native_id),
                "Codex projection ownership marker missing."
            );
            self.assert_no_dependencies(record).await?;
        } else {
            ensure!(
                raw.rows.iter().any(|r| r["type"] == "claudex-owner"
                    && r["sessionId"] == record.native_id
                    && r["owner"] == json!(self.options.root)),
                "Claude projection ownership marker missing."
            );
        }
        let companions = if self.side == Side::Claude {
            let mut paths = vec![record.path.with_extension("")];
            for name in ["file-history", "tasks", "image-cache", "session-env"] {
                paths.push(self.options.claude_home.join(name).join(&record.native_id));
            }
            paths
        } else {
            vec![
                self.options
                    .codex_home
                    .join("sessions")
                    .join(&record.native_id),
            ]
        };
        for path in companions {
            match fs::symlink_metadata(path) {
                Ok(_) => bail!("Session has auxiliary data; transcript-only retirement is unsafe."),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        ensure!(
            inspection.digest()? == record.checkpoint,
            "Retirement source changed from its checkpoint."
        );
        Ok((inspection, raw))
    }
    async fn assert_no_dependencies(&self, record: &Record) -> Result<()> {
        let client = self.client().await?;
        for archived in [false, true] {
            let page=client.request("thread/list",json!({"ancestorThreadId":record.native_id,"archived":archived,"sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"],"limit":1})).await?;
            ensure!(
                page["data"].as_array().is_some_and(Vec::is_empty),
                "Codex snapshot has dependent threads or unreadable dependency inventory."
            );
            let mut cursor = None::<String>;
            let mut seen = HashSet::new();
            loop {
                let mut params = json!({"archived":archived,"sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"],"limit":100});
                if let Some(c) = &cursor {
                    params["cursor"] = json!(c);
                }
                let page = client.request("thread/list", params).await?;
                let threads = page["data"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid native dependency inventory."))?;
                for thread in threads {
                    let id = thread["id"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Missing native dependency identity."))?;
                    if id == record.native_id {
                        continue;
                    }
                    let detail = client
                        .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                        .await?;
                    ensure!(
                        detail["thread"]["forkedFromId"] != record.native_id,
                        "Codex snapshot has a dependent fork."
                    );
                }
                match page.get("nextCursor").filter(|v| !v.is_null()) {
                    None => break,
                    Some(v) => {
                        let c = v
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| anyhow::anyhow!("Invalid dependency cursor."))?;
                        ensure!(
                            seen.insert(c.to_owned()) && seen.len() <= 256,
                            "Dependency inventory pagination cycle or limit."
                        );
                        cursor = Some(c.into());
                    }
                }
            }
        }
        Ok(())
    }
    fn journal_path(&self, record: &Record, action: &str) -> PathBuf {
        self.options
            .root
            .join("native-operations")
            .join(format!("{}-{action}.json", record.id))
    }
    async fn mutation(
        &self,
        record: &Record,
        action: &str,
        method: &str,
        params: Value,
    ) -> Result<()> {
        let path = self.journal_path(record, action);
        let existing = storage::read_json_or(&path, Value::Null)?;
        if !existing.is_null() {
            ensure!(
                existing["nativeId"] == record.native_id
                    && existing["method"] == method
                    && existing["params"] == params,
                "Native mutation journal identity mismatch."
            );
            if existing["phase"] == "complete" {
                return Ok(());
            }
            bail!(
                "Native operation outcome is unknown; read-only recovery is required, never resend."
            );
        }
        let mut journal = json!({"version":1,"nativeId":record.native_id,"recordId":record.id,"method":method,"params":params,"phase":"requested"});
        storage::write_json(&path, &journal)?;
        self.client().await?.request(method, params).await?;
        journal["phase"] = json!("complete");
        storage::write_json(&path, &journal)?;
        Ok(())
    }
}
#[async_trait]
impl Driver for NativeDriver {
    async fn inspect(&self, record: &Record) -> Result<Inspection> {
        let path = self.located(record)?;
        let root = if self.side == Side::Codex {
            &self.options.codex_home
        } else if path.starts_with(self.options.root.join("rollback")) {
            &self.options.root
        } else {
            &self.options.claude_home
        };
        safe_native_path(&path, root)?;
        let raw = storage::snapshot(&path)?;
        let mut common = if self.side == Side::Claude {
            let cwd: HashSet<_> = raw.rows.iter().filter_map(|r| r["cwd"].as_str()).collect();
            ensure!(cwd.len() <= 1, "Claude working directory changed.");
            let last = raw
                .rows
                .iter()
                .rev()
                .find(|r| matches!(r["type"].as_str(), Some("user" | "assistant")))
                .ok_or_else(|| anyhow::anyhow!("No native dialogue."))?;
            ensure!(
                last["type"] == "assistant"
                    && matches!(
                        last["message"]["stop_reason"].as_str(),
                        Some("end_turn" | "stop_sequence")
                    ),
                "Wait for complete assistant turn with terminal stop reason."
            );
            codecs::decode_claude(&raw.text, false, record.managed)?
        } else {
            codecs::decode_codex(&raw.text)?
        };
        assert_complete(&common)?;
        let native_id = common
            .meta
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Missing native session identity."))?
            .to_owned();
        Uuid::parse_str(&native_id)?;
        ensure!(
            record.native_id.is_empty() || record.native_id == native_id,
            "Native identity changed."
        );
        let cwd = fs::canonicalize(common.cwd()?)
            .map_err(|_| anyhow::anyhow!("Source working directory is unavailable."))?;
        common.meta.insert("cwd".into(), json!(cwd));
        let compaction = common.meta.get("compaction");
        let compaction_id = compaction.and_then(|c| c["id"].as_str()).map(str::to_owned);
        let compaction_offset = compaction.and_then(|c| c["offset"].as_u64());
        let prefix_unchanged = record.raw_hash.as_ref().is_some_and(|hash| {
            record.bytes <= raw.text.len() as u64
                && raw.text.is_char_boundary(record.bytes as usize)
                && digest_bytes(&raw.text.as_bytes()[..record.bytes as usize]) == *hash
        });
        let mut extra = Map::new();
        if self.side == Side::Codex {
            if let Some(origin) = raw
                .rows
                .iter()
                .find(|r| r["type"] == "session_meta")
                .and_then(|r| r["payload"].get("originator"))
            {
                extra.insert("originator".into(), origin.clone());
            }
        }
        Ok(Inspection {
            common,
            native_id,
            path,
            bytes: raw.bytes,
            raw_hash: Some(raw.hash),
            compaction_id,
            compaction_offset,
            prefix_unchanged,
            extra,
        })
    }
    async fn assert_readable(&self, record: &Record) -> Result<()> {
        self.inspect(record).await?;
        Ok(())
    }
    async fn assert_idle(&self, record: &Record) -> Result<()> {
        if self.side == Side::Codex {
            if !record.managed {
                return Ok(());
            }
            let result = self
                .client()
                .await?
                .request(
                    "thread/read",
                    json!({"threadId":record.native_id,"includeTurns":false}),
                )
                .await?;
            ensure!(
                result["thread"]["status"]["type"] != "active",
                "Codex destination is active."
            );
        } else {
            if let Some(registry) = &self.options.desktop_registry {
                ensure!(
                    !desktop_owns(registry, &record.native_id)?,
                    "Claude Desktop owns this session; external writer ownership refused."
                );
            }
            let sessions = self.options.claude_home.join("sessions");
            match fs::read_dir(sessions) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = entry?;
                        if entry.path().extension().is_none_or(|e| e != "json") {
                            continue;
                        }
                        let state = storage::read_json(entry.path())?;
                        let pid = state["pid"]
                            .as_u64()
                            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                            .ok_or_else(|| anyhow::anyhow!("Unknown Claude activity marker."))?;
                        if !storage::process_alive(pid as u32)? {
                            continue;
                        }
                        let id = state["sessionId"].as_str().ok_or_else(|| {
                            anyhow::anyhow!("Unknown active Claude session identity.")
                        })?;
                        Uuid::parse_str(id)?;
                        ensure!(
                            id != record.native_id,
                            "Claude Code is open; close destination before switching."
                        );
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    async fn plan(
        &self,
        id: &str,
        common: &Common,
        _title: &str,
    ) -> Result<(PathBuf, Map<String, Value>)> {
        let path = if self.side == Side::Codex {
            codecs::codex_projection_path(&self.options.codex_home, common, id)?
        } else {
            codecs::claude_path(&self.options.claude_home, common.cwd()?, id)?
        };
        Ok((path, Map::new()))
    }
    async fn materialize(&self, record: &Record, common: &Common, title: &str) -> Result<()> {
        if fs::symlink_metadata(&record.path).is_ok() {
            ensure!(
                self.inspect(record).await?.digest()? == common.fingerprint()?,
                "Existing projection differs from pending intent."
            );
        } else {
            let text = if self.side == Side::Codex {
                codecs::encode_codex(common, &record.native_id, false)?
            } else {
                codecs::encode_claude(
                    common,
                    &record.native_id,
                    None,
                    Some(title),
                    Some(
                        self.options
                            .root
                            .to_str()
                            .ok_or_else(|| anyhow::anyhow!("Invalid root encoding."))?,
                    ),
                )?
            };
            let expected = if self.side == Side::Codex {
                codecs::decode_codex(&text)?
            } else {
                codecs::decode_claude(&text, false, true)?
            };
            ensure!(
                expected.fingerprint()? == common.fingerprint()?,
                "Native conversion changes canonical history; nothing published."
            );
            storage::publish_exclusive(&record.path, text)?;
        }
        if self.side == Side::Codex {
            let result = storage::read_json_or(self.journal_path(record, "register"), Value::Null)?;
            if result["phase"] != "complete" && result.is_null() {
                self.mutation(
                    record,
                    "register",
                    "thread/resume",
                    json!({"threadId":record.native_id,"path":record.path,"cwd":record.cwd}),
                )
                .await?;
            } else if !result.is_null() && result["phase"] != "complete" {
                let visible = self
                    .client()
                    .await?
                    .request(
                        "thread/read",
                        json!({"threadId":record.native_id,"includeTurns":true}),
                    )
                    .await?;
                ensure!(
                    visible["thread"]["id"] == record.native_id
                        && visible["thread"]["turns"]
                            .as_array()
                            .is_some_and(|a| !a.is_empty()),
                    "Native registration outcome remains unknown; no resend."
                );
                let mut result = result;
                result["phase"] = json!("complete");
                storage::write_json(self.journal_path(record, "register"), &result)?;
            }
            if !title.is_empty() {
                self.mutation(
                    record,
                    "name",
                    "thread/name/set",
                    json!({"threadId":record.native_id,"name":title}),
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn exists(&self, record: &Record) -> Result<bool> {
        match self.located(record) {
            Ok(_) => Ok(true),
            Err(e) if storage::is_not_found(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }
    async fn hide(&self, record: &Record) -> Result<Map<String, Value>> {
        self.assert_idle(record).await?;
        let (inspection, raw) = self.owned(record).await?;
        same_identity(&inspection.path, &raw.file_identity)?;
        let path = if self.side == Side::Codex {
            let archived = self
                .options
                .codex_home
                .join("archived_sessions")
                .join(record.path.file_name().unwrap());
            if !inspection
                .path
                .starts_with(self.options.codex_home.join("archived_sessions"))
            {
                self.mutation(
                    record,
                    "archive",
                    "thread/archive",
                    json!({"threadId":record.native_id}),
                )
                .await?;
            }
            archived
        } else {
            let path = self
                .options
                .root
                .join("rollback")
                .join(format!("{}.jsonl", record.native_id));
            storage::private_directory(path.parent().unwrap())?;
            if path != inspection.path {
                ensure!(!path.exists(), "Rollback slot already exists.");
                same_identity(&inspection.path, &raw.file_identity)?;
                fs::rename(&inspection.path, &path)?;
            }
            path
        };
        Ok(json!({"path":path,"originalPath":record.path})
            .as_object()
            .unwrap()
            .clone())
    }
    async fn remove(&self, record: &Record) -> Result<()> {
        self.assert_idle(record).await?;
        let (inspection, raw) = self.owned(record).await?;
        same_identity(&inspection.path, &raw.file_identity)?;
        if self.side == Side::Codex {
            self.mutation(
                record,
                "delete",
                "thread/delete",
                json!({"threadId":record.native_id}),
            )
            .await?;
        } else {
            fs::remove_file(&inspection.path)?;
        }
        Ok(())
    }
}

/// Conservative protection includes archived and not-yet-started Local entries.
pub fn desktop_owns(root: &Path, native_id: &str) -> Result<bool> {
    Uuid::parse_str(native_id)?;
    fn visit(path: &Path, id: &str, depth: usize, count: &mut usize) -> Result<bool> {
        let before = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && depth == 0 => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        ensure!(
            before.is_dir() && !before.file_type().is_symlink(),
            "Unsafe Desktop registry directory."
        );
        let identity = FileIdentity::from_metadata(&before);
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            *count += 1;
            ensure!(*count <= 16_384, "Desktop registry scan exceeds bound.");
            let metadata = fs::symlink_metadata(entry.path())?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "Symlinked Desktop registry refused."
            );
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("local_") && name.ends_with(".json") {
                let ui = &name[6..name.len() - 5];
                Uuid::parse_str(ui)
                    .map_err(|_| anyhow::anyhow!("Ambiguous Desktop registry filename."))?;
                ensure!(
                    metadata.is_file() && metadata.uid() == storage::uid() && metadata.nlink() == 1,
                    "Unsafe Desktop registry record."
                );
                if ui.eq_ignore_ascii_case(id) {
                    return Ok(true);
                }
                let record = storage::read_stable(entry.path())?;
                ensure!(
                    record.bytes.len() <= 8 * 1024 * 1024 && metadata.mode() & 0o022 == 0,
                    "Unsafe Desktop registry record."
                );
                let record: Value = serde_json::from_slice(&record.bytes)?;
                ensure!(
                    record["sessionId"] == format!("local_{ui}"),
                    "Desktop registry identity mismatch."
                );
                if record["cliSessionId"].is_null() {
                    continue;
                }
                let cli = record["cliSessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Ambiguous Desktop CLI identity."))?;
                Uuid::parse_str(cli)?;
                if cli.eq_ignore_ascii_case(id) {
                    return Ok(true);
                }
            } else if depth < 2 && metadata.is_dir() && visit(&entry.path(), id, depth + 1, count)?
            {
                return Ok(true);
            }
        }
        ensure!(
            FileIdentity::from_metadata(&fs::symlink_metadata(path)?) == identity,
            "Desktop registry changed during ownership lookup."
        );
        Ok(false)
    }
    visit(root, native_id, 0, &mut 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_native_paths_keep_the_exact_path_and_io_classification() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().canonicalize()?;
        let logical = root.join("missing.jsonl");
        let error = physical_rollout(&logical).unwrap_err();
        assert!(storage::is_not_found(&error));
        assert!(format!("{error:#}").contains(&logical.display().to_string()));
        assert!(format!("{error:#}").contains("missing.jsonl.zst"));

        let error = safe_native_path(&logical, &root).unwrap_err();
        assert!(storage::is_not_found(&error));
        assert!(format!("{error:#}").contains(&logical.display().to_string()));

        let missing_parent = root.join("removed-project");
        let error = safe_native_path(&missing_parent.join("native.jsonl"), &root).unwrap_err();
        assert!(storage::is_not_found(&error));
        assert!(format!("{error:#}").contains(&missing_parent.display().to_string()));
        Ok(())
    }
}
