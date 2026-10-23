//! Explicit one-time historical imports. Allocation is durable before native
//! publication; re-entry never replaces an existing transcript or enrolls a copy.
use crate::{
    bridge::Side,
    codecs,
    desktop::{DesktopBridge, Record, State},
    desktop_mapping,
    history::Common,
    runtime::Runtime,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;
pub struct Importer {
    root: PathBuf,
    runtime: Arc<Runtime>,
    bridge: DesktopBridge,
}
impl Importer {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self {
            root: runtime.options.root.clone(),
            bridge: runtime.bridge(),
            runtime,
        }
    }
    pub fn status(&self) -> Result<Value> {
        let journal = storage::read_json_or(
            self.root.join("cold-imports.json"),
            json!({"version":1,"sources":{}}),
        )?;
        ensure!(
            journal["version"] == 1
                && journal["sources"]
                    .as_object()
                    .is_some_and(|s| s.len() <= 4096),
            "Unsupported or oversized cold-import journal."
        );
        Ok(journal)
    }
    fn validate(&self, entry: &Value, native: &str) -> Result<Record> {
        ensure!(
            matches!(
                entry["phase"].as_str(),
                Some("prepared" | "paired" | "adopted")
            ) && entry["sourceNativeId"] == native
                && crate::packet::hex_digest(&entry["digest"])
                && entry["count"].as_u64().is_some_and(|n| n > 0),
            "Invalid cold-import journal phase or source proof."
        );
        let id = entry["conversationId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing cold-import conversation."))?;
        Uuid::parse_str(id)?;
        Uuid::parse_str(
            entry["operationId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing cold-import operation."))?,
        )?;
        // Allocation journals precede enrollment. The JavaScript journal saves
        // only a native source descriptor, not a fully enrolled ledger record.
        let saved = &entry["target"];
        let native_id = saved["nativeId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing cold-import target identity."))?;
        Uuid::parse_str(native_id)?;
        let path = saved["path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing cold-import target path."))?;
        let mut target = Record::source(Side::Claude, Path::new(path), native_id);
        target.conversation_id = saved["conversationId"].as_str().unwrap_or("").into();
        target.cwd = saved["cwd"].as_str().unwrap_or("").into();
        ensure!(
            saved["side"] == "claude" && saved["managed"] == false && saved["kind"] == "original",
            "Invalid cold-import source descriptor."
        );
        target
            .extra
            .insert("importPacket".into(), saved["importPacket"].clone());
        target
            .extra
            .insert("packetVersion".into(), saved["packetVersion"].clone());
        ensure!(
            target.side == Side::Claude
                && !target.managed
                && target.kind == "original"
                && target.conversation_id == id
                && entry["cwd"] == target.cwd
                && target.extra.get("importPacket") == Some(&json!(true))
                && target.extra.get("packetVersion") == Some(&json!(2))
                && target.path
                    == codecs::claude_path(
                        &self.runtime.options.claude_home,
                        &target.cwd,
                        &target.native_id
                    )?,
            "Invalid cold-import target allocation."
        );
        Ok(target)
    }
    fn paired(state: &State, native: &str, entry: &Value, target: &Record) -> Result<()> {
        let source = state
            .records
            .iter()
            .find(|r| r.side == Side::Codex && r.native_id == native);
        let saved = state
            .records
            .iter()
            .find(|r| r.side == Side::Claude && r.native_id == target.native_id);
        ensure!(
            source.is_some_and(|r| r.conversation_id == target.conversation_id
                && !r.managed
                && r.kind == "original"
                && r.cwd == target.cwd)
                && saved.is_some_and(|r| r.conversation_id == target.conversation_id
                    && !r.managed
                    && r.kind == "original"
                    && r.cwd == target.cwd
                    && r.path == target.path
                    && r.extra.get("importPacket") == Some(&json!(true))
                    && r.extra.get("packetVersion") == Some(&json!(2)))
                && state
                    .conversations
                    .get(&target.conversation_id)
                    .is_some_and(|c| c.extra.get("discoveryMode") == Some(&json!("cold-import")))
                && entry["conversationId"] == target.conversation_id,
            "Cold-import journal does not match its paired ledger."
        );
        Ok(())
    }
    pub async fn publish(
        &self,
        native: &str,
        path: &Path,
        title: Option<&str>,
        expected: Option<&crate::desktop::Checkpoint>,
    ) -> Result<Value> {
        Uuid::parse_str(native)?;
        let _lock = FileLock::acquire(self.root.join("cold-import.lock"), true)?;
        let mut journal = self.status()?;
        let state = self.bridge.status()?;
        let mut entry = journal["sources"][native].clone();
        let tracked = state
            .records
            .iter()
            .find(|r| r.side == Side::Codex && r.native_id == native);
        if tracked.is_some() && entry.is_null() {
            return Ok(
                json!({"status":"already-tracked","conversationId":tracked.unwrap().conversation_id}),
            );
        }
        if !entry.is_null() {
            let target = self.validate(&entry, native)?;
            if entry["phase"] != "prepared"
                || tracked.is_some()
                || state
                    .records
                    .iter()
                    .any(|r| r.side == Side::Claude && r.native_id == target.native_id)
                || state.conversations.contains_key(&target.conversation_id)
            {
                Self::paired(&state, native, &entry, &target)?;
                if entry["phase"] == "prepared" {
                    entry["phase"] = json!("paired");
                    entry["pairedAt"] = json!(storage::now_ms());
                    journal["sources"][native] = entry.clone();
                    storage::write_json(self.root.join("cold-imports.json"), &journal)?;
                }
                return Ok(entry);
            }
        }
        ensure!(
            state.pending.is_none(),
            "Recover pending Desktop handoff before allocating a cold import."
        );
        let mut source = Record::source(Side::Codex, path, native);
        if entry.is_null() {
            crate::native_realtime::enroll(&mut source.extra);
        } else if let Some(policy) = entry.get(crate::native_realtime::POLICY_KEY) {
            source
                .extra
                .insert(crate::native_realtime::POLICY_KEY.into(), policy.clone());
        }
        let data = self.bridge.inspect(&source).await?;
        let digest = data.common.fingerprint()?;
        let count = data.common.messages.len();
        let cwd = data.common.cwd()?;
        if let Some(expected) = expected {
            ensure!(
                expected.exact(&data.common)?,
                "Cold-import source changed after preflight."
            );
        }
        if !entry.is_null() {
            ensure!(
                entry["digest"] == digest && entry["count"] == count && entry["cwd"] == cwd,
                "Cold-import source changed after allocation; prior evidence preserved."
            );
        } else {
            let id = Uuid::new_v4().to_string();
            let target_id = Uuid::new_v4().to_string();
            let mut target = Record::source(
                Side::Claude,
                &codecs::claude_path(&self.runtime.options.claude_home, cwd, &target_id)?,
                &target_id,
            );
            target.conversation_id = id.clone();
            target.cwd = cwd.into();
            target.extra.insert("importPacket".into(), json!(true));
            target.extra.insert("packetVersion".into(), json!(2));
            entry = json!({"phase":"prepared","conversationId":id,"sourceNativeId":native,"digest":digest,"count":count,"cwd":cwd,"title":title.or_else(||data.common.meta.get("title").and_then(Value::as_str)).unwrap_or("Claudex conversation"),"createdAt":storage::now_ms(),"operationId":Uuid::new_v4(),"target":target});
            entry[crate::native_realtime::POLICY_KEY] =
                source.extra[crate::native_realtime::POLICY_KEY].clone();
            journal["sources"][native] = entry.clone();
            storage::write_json(self.root.join("cold-imports.json"), &journal)?;
        }
        let target = self.validate(&entry, native)?;
        if matches!(std::fs::symlink_metadata(&target.path),Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            let content = self.runtime.cold_packet(
                &data.common,
                &target.conversation_id,
                &target.native_id,
                entry["operationId"].as_str().unwrap(),
            )?;
            let mut common = Common {
                messages: vec![crate::history::Message {
                    role: "user".into(),
                    content,
                    extra: Default::default(),
                }],
                ..data.common.clone()
            };
            let created = entry["createdAt"]
                .as_i64()
                .and_then(chrono::DateTime::from_timestamp_millis)
                .ok_or_else(|| anyhow::anyhow!("Invalid cold-import creation time."))?;
            common.meta.insert(
                "timestamp".into(),
                json!(created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
            let text = codecs::encode_claude(
                &common,
                &target.native_id,
                None,
                entry["title"].as_str(),
                None,
            )?;
            storage::private_directory(target.path.parent().unwrap())?;
            storage::publish_exclusive(&target.path, text)?;
        }
        let published = self.bridge.inspect(&target).await?;
        ensure!(
            published.common.fingerprint()? == digest
                && published.common.messages.len() == count
                && !published.incomplete_tail,
            "Published cold import failed authentication; existing transcript was preserved."
        );
        self.bridge
            .track_imported_pair(
                &target.conversation_id,
                Record {
                    path: data.path,
                    cwd: cwd.into(),
                    ..source
                },
                target.clone(),
                entry["title"].as_str().unwrap(),
            )
            .await?;
        entry["phase"] = json!("paired");
        entry["pairedAt"] = json!(storage::now_ms());
        journal["sources"][native] = entry.clone();
        storage::write_json(self.root.join("cold-imports.json"), &journal)?;
        Ok(entry)
    }
    pub fn verify_adopted(&self, native: &str, registry: &Path) -> Result<Value> {
        Uuid::parse_str(native)?;
        let _lock = FileLock::acquire(self.root.join("cold-import.lock"), true)?;
        let mut journal = self.status()?;
        let mut entry = journal["sources"][native].clone();
        ensure!(
            matches!(entry["phase"].as_str(), Some("paired" | "adopted")),
            "Cold import is not paired."
        );
        let target = self.validate(&entry, native)?;
        Self::paired(&self.bridge.status()?, native, &entry, &target)?;
        ensure!(
            desktop_mapping::mappings(registry, &[target.native_id.clone()])?
                .contains_key(&target.native_id.to_lowercase()),
            "Native Desktop has not adopted this cold import."
        );
        entry["phase"] = json!("adopted");
        if entry["adoptedAt"].is_null() {
            entry["adoptedAt"] = json!(storage::now_ms());
        }
        journal["sources"][native] = entry.clone();
        storage::write_json(self.root.join("cold-imports.json"), &journal)?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::{Adapter, Pending, PlanInput, Reading};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Source {
        common: Common,
        calls: AtomicUsize,
        fail_at: usize,
    }
    #[async_trait]
    impl Adapter for Source {
        async fn inspect(&self, r: &Record) -> Result<Reading> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            ensure!(
                call != self.fail_at,
                "Injected cold source inspection failure."
            );
            Ok(Reading {
                common: self.common.clone(),
                native_id: r.native_id.clone(),
                path: r.path.clone(),
                bytes: 42,
                incomplete_tail: false,
                extra: Default::default(),
            })
        }
        async fn assert_idle(&self, _: &Record) -> Result<()> {
            Ok(())
        }
        async fn plan(&self, _: &PlanInput) -> Result<Record> {
            anyhow::bail!("Cold import must not allocate a live native owner.")
        }
        async fn operation_applied(&self, _: &Record, _: &Pending) -> Result<bool> {
            anyhow::bail!("No live mutation in cold import.")
        }
        async fn apply(&self, _: &Record, _: &Pending) -> Result<()> {
            anyhow::bail!("No live mutation in cold import.")
        }
        async fn hide(&self, _: &Record) -> Result<serde_json::Map<String, Value>> {
            anyhow::bail!("No archival in cold import.")
        }
        async fn remove(&self, _: &Record) -> Result<()> {
            anyhow::bail!("No deletion in cold import.")
        }
        async fn exists(&self, _: &Record) -> Result<bool> {
            Ok(true)
        }
    }
    async fn recover_publication(legacy: bool) -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(temp.path().join("root"))?;
        let codex = storage::private_directory(temp.path().join("codex"))?;
        let claude = storage::private_directory(temp.path().join("claude"))?;
        let cwd = storage::private_directory(temp.path().join("project"))?;
        let runtime = Runtime::new(crate::runtime::Options::from_config(
            &root,
            &json!({"codexHome":codex,"claudeHome":claude}),
        )?)?;
        let common = Common {
            meta: json!({"cwd":cwd,"timestamp":"2026-10-16T00:00:00.000Z"})
                .as_object()
                .unwrap()
                .clone(),
            messages: vec![
                crate::history::Message::text("user", "Preserved request"),
                crate::history::Message::text("assistant", "Preserved answer"),
            ],
            extra: Default::default(),
        };
        let source = Arc::new(Source {
            common: common.clone(),
            calls: AtomicUsize::new(0),
            fail_at: 2,
        });
        let mut bridge = runtime.bridge();
        bridge.adapters.insert(Side::Codex, source.clone());
        let importer = Importer {
            root: root.clone(),
            runtime,
            bridge,
        };
        let native = Uuid::new_v4().to_string();
        let path = codex.join(format!("{native}.jsonl"));
        let error = importer
            .publish(&native, &path, Some("Historical conversation"), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Injected cold source"));
        let mut journal = importer.status()?;
        let mut prepared = journal["sources"][&native].clone();
        assert_eq!(prepared["phase"], "prepared");
        assert_eq!(prepared["realtimeHistory"], "transcript-v1");
        if legacy {
            prepared.as_object_mut().unwrap().remove("realtimeHistory");
            journal["sources"][&native] = prepared.clone();
            storage::write_json(root.join("cold-imports.json"), &journal)?;
        }
        let target = importer.validate(&prepared, &native)?;
        let before = storage::read_stable(&target.path)?;
        assert!(importer.bridge.status()?.records.is_empty());
        let paired = importer
            .publish(&native, &path, Some("Ignored new title"), None)
            .await?;
        assert_eq!(paired["phase"], "paired");
        assert_eq!(paired["target"], prepared["target"]);
        assert_eq!(paired["operationId"], prepared["operationId"]);
        let after = storage::read_stable(&target.path)?;
        assert_eq!(after.identity, before.identity);
        assert_eq!(after.bytes, before.bytes);
        let state = importer.bridge.status()?;
        assert_eq!(state.records.len(), 2);
        assert_eq!(
            crate::native_realtime::enabled(&state.conversations[&target.conversation_id].extra)?,
            !legacy
        );
        assert!(
            state
                .records
                .iter()
                .all(|r| crate::native_realtime::enabled(&r.extra).unwrap() == !legacy)
        );
        assert!(
            state
                .records
                .iter()
                .all(|r| !r.managed && r.kind == "original")
        );
        assert_eq!(
            state.conversations[&target.conversation_id].canonical,
            crate::desktop::Checkpoint::of(&common)?
        );
        assert_eq!(
            state.conversations[&target.conversation_id].extra["discoveryMode"],
            "cold-import"
        );
        assert!(!root.join("owners").exists());
        assert_eq!(importer.publish(&native, &path, None, None).await?, paired);
        assert_eq!(
            storage::read_stable(&target.path)?.identity,
            before.identity
        );
        Ok(())
    }
    #[tokio::test]
    async fn publication_recovers_exact_packet_and_its_original_realtime_policy() -> Result<()> {
        recover_publication(false).await?;
        recover_publication(true).await
    }
    #[test]
    fn javascript_allocation_descriptor_is_not_a_full_ledger_record() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(&temp.path().join("root"))?;
        let codex = storage::private_directory(&temp.path().join("codex"))?;
        let claude = storage::private_directory(&temp.path().join("claude"))?;
        let cwd = storage::private_directory(&temp.path().join("cwd"))?;
        let runtime = Runtime::new(crate::runtime::Options::from_config(
            &root,
            &json!({"codexHome":codex,"claudeHome":claude}),
        )?)?;
        let importer = Importer::new(runtime);
        let native = Uuid::new_v4().to_string();
        let target = Uuid::new_v4().to_string();
        let conversation = Uuid::new_v4().to_string();
        let entry = json!({"phase":"prepared","sourceNativeId":native,"conversationId":conversation,"operationId":Uuid::new_v4(),"digest":"a".repeat(64),"count":2,"cwd":cwd,"target":{"side":"claude","nativeId":target,"conversationId":conversation,"cwd":cwd,"path":codecs::claude_path(&claude,&cwd.to_string_lossy(),&target)?,"managed":false,"kind":"original","importPacket":true,"packetVersion":2}});
        let record = importer.validate(&entry, &native)?;
        assert_eq!(record.native_id, target);
        assert!(!record.managed);
        let mut invalid = entry.clone();
        invalid["target"]["managed"] = json!(true);
        assert!(importer.validate(&invalid, &native).is_err());
        invalid = entry.clone();
        invalid["target"]["path"] = json!(cwd.join("wrong.jsonl"));
        assert!(importer.validate(&invalid, &native).is_err());
        invalid = entry.clone();
        invalid["target"]["conversationId"] = json!(Uuid::new_v4());
        assert!(importer.validate(&invalid, &native).is_err());
        Ok(())
    }
}
