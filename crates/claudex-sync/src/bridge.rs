//! Durable turn-boundary coordinator. Native authority belongs to the driver;
//! no source is overwritten and no uncertain native operation is resent.
use crate::{
    history::{Common, assert_complete, fingerprint},
    retention::{self, Policy, RetainedRecord},
};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::{FileLock, private_directory, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Codex,
    Claude,
}
impl Side {
    pub fn other(self) -> Self {
        match self {
            Self::Codex => Self::Claude,
            Self::Claude => Self::Codex,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}
impl std::str::FromStr for Side {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => bail!("Unknown source side."),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub native_id: String,
    pub path: PathBuf,
    pub conversation_id: String,
    pub cwd: String,
    pub side: Side,
    pub managed: bool,
    pub verified: bool,
    pub status: String,
    pub bytes: u64,
    pub created_at: u64,
    #[serde(default)]
    pub checkpoint: String,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub raw_hash: Option<String>,
    #[serde(default)]
    pub compaction_id: Option<String>,
    #[serde(default)]
    pub retired_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub cwd: String,
    pub title: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Prepared,
    Verified,
    Promoted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub phase: Phase,
    pub source_id: String,
    pub source_digest: String,
    pub old_target_id: Option<String>,
    pub record: Record,
    pub common: Common,
    pub title: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub conversations: BTreeMap<String, Conversation>,
    pub records: Vec<Record>,
    pub pending: Option<Pending>,
    pub audit: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            conversations: BTreeMap::new(),
            records: vec![],
            pending: None,
            audit: vec![],
            extra: Map::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Inspection {
    pub common: Common,
    pub native_id: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub raw_hash: Option<String>,
    pub compaction_id: Option<String>,
    pub compaction_offset: Option<u64>,
    pub prefix_unchanged: bool,
    pub extra: Map<String, Value>,
}
impl Inspection {
    pub fn digest(&self) -> Result<String> {
        self.common.fingerprint()
    }
    pub fn checkpoint(&self, record: &mut Record) -> Result<()> {
        record.checkpoint = self.digest()?;
        record.message_count = self.common.messages.len();
        record.bytes = self.bytes;
        record.raw_hash = self.raw_hash.clone();
        record.compaction_id = self.compaction_id.clone();
        record.extra.extend(self.extra.clone());
        Ok(())
    }
    pub fn preserves(&self, record: &Record) -> Result<bool> {
        if self.common.messages.len() >= record.message_count
            && fingerprint(&self.common.messages, record.message_count)? == record.checkpoint
        {
            return Ok(true);
        }
        Ok(self.compaction_id.as_ref().is_some_and(|s| !s.is_empty())
            && self.compaction_id != record.compaction_id
            && self.compaction_offset.is_some_and(|v| v >= record.bytes)
            && record.raw_hash.as_ref().is_some_and(|s| !s.is_empty())
            && self.prefix_unchanged)
    }
}

#[async_trait]
pub trait Driver: Send + Sync {
    async fn inspect(&self, record: &Record) -> Result<Inspection>;
    async fn assert_readable(&self, record: &Record) -> Result<()> {
        self.assert_idle(record).await
    }
    async fn assert_idle(&self, record: &Record) -> Result<()>;
    async fn plan(
        &self,
        native_id: &str,
        common: &Common,
        title: &str,
    ) -> Result<(PathBuf, Map<String, Value>)>;
    /// Recover an exactly owned publication. Must not repeat a native request
    /// whose durable outcome is unknown or replace a mismatching file.
    async fn materialize(&self, record: &Record, common: &Common, title: &str) -> Result<()>;
    async fn verify(&self, record: &Record, common: &Common) -> Result<Inspection> {
        let result = self.inspect(record).await?;
        ensure!(
            result.digest()? == common.fingerprint()?,
            "Projection canonical history changed."
        );
        Ok(result)
    }
    async fn exists(&self, record: &Record) -> Result<bool>;
    async fn hide(&self, record: &Record) -> Result<Map<String, Value>>;
    async fn remove(&self, record: &Record) -> Result<()>;
}

pub struct Bridge {
    pub root: PathBuf,
    pub drivers: BTreeMap<Side, Arc<dyn Driver>>,
    pub policy: Policy,
}
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
impl Bridge {
    pub fn new(root: impl Into<PathBuf>, drivers: BTreeMap<Side, Arc<dyn Driver>>) -> Self {
        Self {
            root: root.into(),
            drivers,
            policy: Policy::default(),
        }
    }
    fn driver(&self, side: Side) -> Result<&Arc<dyn Driver>> {
        self.drivers
            .get(&side)
            .ok_or_else(|| anyhow::anyhow!("Unknown source side."))
    }
    fn load(&self) -> Result<State> {
        let state: State = serde_json::from_value(read_json_or(
            &self.root.join("state.json"),
            serde_json::to_value(State::default())?,
        )?)?;
        ensure!(state.version == 1, "Unsupported bridge state version.");
        Ok(state)
    }
    fn save(&self, state: &mut State, event: Option<Value>) -> Result<()> {
        if let Some(mut event) = event {
            event["at"] = json!(now());
            state.audit.push(event);
        }
        if state.audit.len() > self.policy.max_audit_entries {
            state
                .audit
                .drain(..state.audit.len() - self.policy.max_audit_entries);
        }
        write_json(&self.root.join("state.json"), &serde_json::to_value(state)?)
    }
    fn lock(&self) -> Result<FileLock> {
        private_directory(&self.root)?;
        FileLock::acquire(&self.root.join("operation.lock"), true)
    }
    pub fn status(&self) -> Result<State> {
        private_directory(&self.root)?;
        self.load()
    }
    pub async fn track(&self, side: Side, path: &Path, title: Option<&str>) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        ensure!(
            state.pending.is_none(),
            "An unfinished transaction requires recovery."
        );
        let mut record = Record {
            id: Uuid::new_v4().to_string(),
            native_id: String::new(),
            path: path.into(),
            conversation_id: String::new(),
            cwd: String::new(),
            side,
            managed: false,
            verified: false,
            status: "current".into(),
            bytes: 0,
            created_at: now(),
            checkpoint: String::new(),
            message_count: 0,
            raw_hash: None,
            compaction_id: None,
            retired_at: None,
            extra: Map::new(),
        };
        let source = self.driver(side)?.inspect(&record).await?;
        assert_complete(&source.common)?;
        record.native_id = source.native_id.clone();
        record.cwd = source.common.cwd()?.into();
        record.path = source.path.clone();
        self.driver(side)?.assert_readable(&record).await?;
        if let Some(existing) = state
            .records
            .iter()
            .find(|r| r.side == side && r.native_id == source.native_id)
        {
            return Ok(json!({"conversationId":existing.conversation_id,"existing":true}));
        }
        let id = Uuid::new_v4().to_string();
        record.conversation_id = id.clone();
        record.verified = true;
        source.checkpoint(&mut record)?;
        let derived = source
            .common
            .messages
            .iter()
            .find(|m| m.role == "user")
            .and_then(|m| m.content.iter().find_map(|b| b["text"].as_str()))
            .unwrap_or("Claudex conversation")
            .trim()
            .lines()
            .next()
            .unwrap_or("Claudex conversation")
            .chars()
            .take(100)
            .collect::<String>();
        state.conversations.insert(
            id.clone(),
            Conversation {
                id: id.clone(),
                cwd: record.cwd.clone(),
                title: title
                    .map(str::to_owned)
                    .or_else(|| {
                        source
                            .common
                            .meta
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or(derived),
                extra: Map::new(),
            },
        );
        state.records.push(record);
        self.save(
            &mut state,
            Some(json!({"event":"tracked","conversationId":id,"side":side})),
        )?;
        Ok(json!({"conversationId":id,"existing":false}))
    }
    pub async fn sync(&self, id: &str, side: Side) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        ensure!(
            state.pending.is_none(),
            "An unfinished transaction requires recovery."
        );
        self.collect_locked(&mut state).await?;
        let source_record = state
            .records
            .iter()
            .find(|r| r.conversation_id == id && r.side == side && r.status == "current")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No tracked source for this conversation and side."))?;
        self.driver(side)?.assert_readable(&source_record).await?;
        let source = self.driver(side)?.inspect(&source_record).await?;
        assert_complete(&source.common)?;
        ensure!(
            source.preserves(&source_record)?,
            "Source history changed before its checkpoint; automatic handoff paused."
        );
        let other = side.other();
        let target = state
            .records
            .iter()
            .find(|r| r.conversation_id == id && r.side == other && r.status == "current")
            .cloned();
        if let Some(target) = &target {
            let destination = self.driver(other)?.inspect(target).await?;
            if source.digest()? == source_record.checkpoint {
                return Ok(json!({"changed":false,"reason":"No new source messages."}));
            }
            ensure!(
                destination.digest()? == target.checkpoint,
                "Both sides have unsynchronized changes. No history was replaced."
            );
            self.driver(other)?.assert_idle(target).await?;
        }
        let conversation = state
            .conversations
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Missing logical conversation."))?;
        let native_id = Uuid::new_v4().to_string();
        let mut common = source.common.clone();
        common.meta.insert("cwd".into(), json!(conversation.cwd));
        common.meta.insert(
            "timestamp".into(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        let (path, extra) = self
            .driver(other)?
            .plan(&native_id, &common, &conversation.title)
            .await?;
        let record = Record {
            id: Uuid::new_v4().to_string(),
            native_id,
            path,
            conversation_id: id.into(),
            cwd: conversation.cwd.clone(),
            side: other,
            managed: true,
            verified: false,
            status: "current".into(),
            bytes: 0,
            created_at: now(),
            checkpoint: String::new(),
            message_count: 0,
            raw_hash: None,
            compaction_id: None,
            retired_at: None,
            extra,
        };
        state.pending = Some(Pending {
            phase: Phase::Prepared,
            source_id: source_record.id,
            source_digest: source.digest()?,
            old_target_id: target.map(|r| r.id),
            record,
            common,
            title: conversation.title.clone(),
            extra: Map::new(),
        });
        self.save(
            &mut state,
            Some(json!({"event":"prepared","conversationId":id,"side":other})),
        )?;
        self.complete_locked(&mut state).await
    }
    pub async fn recover(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        if state.pending.is_none() {
            return Ok(json!({"changed":false,"reason":"No pending transaction."}));
        }
        self.complete_locked(&mut state).await
    }
    async fn complete_locked(&self, state: &mut State) -> Result<Value> {
        let mut pending = state
            .pending
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Missing pending transaction."))?;
        let driver = self.driver(pending.record.side)?;
        let source_record = state
            .records
            .iter()
            .find(|r| r.id == pending.source_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Transaction source is missing."))?;
        if !matches!(pending.phase, Phase::Promoted) {
            self.driver(source_record.side)?
                .assert_readable(&source_record)
                .await?;
            let source = self
                .driver(source_record.side)?
                .inspect(&source_record)
                .await?;
            ensure!(
                source.digest()? == pending.source_digest,
                "Source changed during handoff; pending evidence was preserved."
            );
            let old = state
                .records
                .iter()
                .find(|r| Some(&r.id) == pending.old_target_id.as_ref())
                .cloned();
            if let Some(old) = &old {
                driver.assert_idle(old).await?;
                ensure!(
                    driver.inspect(old).await?.digest()? == old.checkpoint,
                    "Destination changed during handoff."
                );
            }
            driver
                .materialize(&pending.record, &pending.common, &pending.title)
                .await?;
            let verified = driver.verify(&pending.record, &pending.common).await?;
            verified.checkpoint(&mut pending.record)?;
            pending.record.verified = true;
            pending.phase = Phase::Verified;
            state.pending = Some(pending.clone());
            self.save(
                state,
                Some(json!({"event":"verified","conversationId":pending.record.conversation_id})),
            )?;
            ensure!(
                self.driver(source_record.side)?
                    .inspect(&source_record)
                    .await?
                    .digest()?
                    == pending.source_digest,
                "Source changed before promotion."
            );
            if let Some(old) = old {
                ensure!(
                    driver.inspect(&old).await?.digest()? == old.checkpoint,
                    "Destination changed before promotion."
                );
                let old = state.records.iter_mut().find(|r| r.id == old.id).unwrap();
                old.status = "previous".into();
                old.retired_at = Some(now());
            }
            source.checkpoint(
                state
                    .records
                    .iter_mut()
                    .find(|r| r.id == source_record.id)
                    .unwrap(),
            )?;
            state.records.push(pending.record.clone());
            pending.phase = Phase::Promoted;
            state.pending = Some(pending.clone());
            self.save(
                state,
                Some(json!({"event":"promoted","conversationId":pending.record.conversation_id})),
            )?;
        }
        if let Some(previous) = state
            .records
            .iter()
            .find(|r| Some(&r.id) == pending.old_target_id.as_ref())
            .cloned()
        {
            if previous.managed {
                driver.assert_idle(&previous).await?;
                ensure!(
                    driver.inspect(&previous).await?.digest()? == previous.checkpoint,
                    "Previous version was edited; retirement paused."
                );
                let mut extras = driver.hide(&previous).await?;
                let saved = state
                    .records
                    .iter_mut()
                    .find(|r| r.id == previous.id)
                    .unwrap();
                if let Some(path) = extras.remove("path") {
                    saved.path = serde_json::from_value(path)?;
                }
                saved.extra.extend(extras);
            } else {
                state
                    .records
                    .iter_mut()
                    .find(|r| r.id == previous.id)
                    .unwrap()
                    .status = "original".into();
            }
        }
        let result = json!({"changed":true,"conversationId":pending.record.conversation_id,"side":pending.record.side,"nativeId":pending.record.native_id,"path":pending.record.path});
        state.pending = None;
        self.save(
            state,
            Some(json!({"event":"completed","conversationId":pending.record.conversation_id})),
        )?;
        self.collect_locked(state).await?;
        Ok(result)
    }
    pub async fn abort(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        let Some(pending) = state.pending.clone() else {
            return Ok(json!({"aborted":false}));
        };
        ensure!(
            matches!(pending.phase, Phase::Prepared),
            "Applied or promoted transactions must be recovered, not aborted."
        );
        ensure!(
            !self
                .driver(pending.record.side)?
                .exists(&pending.record)
                .await?,
            "A native projection exists; recover its exact pending transaction."
        );
        state.pending = None;
        self.save(&mut state, Some(json!({"event":"aborted"})))?;
        Ok(json!({"aborted":true}))
    }
    pub async fn collect(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending handoff before collection."
        );
        self.collect_locked(&mut state).await
    }
    async fn collect_locked(&self, state: &mut State) -> Result<Value> {
        for current in state
            .records
            .iter()
            .filter(|r| r.status == "current" || r.status == "original")
        {
            let data = self.driver(current.side)?.inspect(current).await?;
            if current.status == "original" {
                ensure!(
                    data.common.messages.len() == current.message_count
                        && data.digest()? == current.checkpoint,
                    "Superseded original changed; backups were preserved."
                );
            } else {
                ensure!(
                    data.preserves(current)?,
                    "Tracked history changed before its checkpoint; backups were preserved."
                );
            }
        }
        let candidates: Vec<_> = state
            .records
            .iter()
            .filter(|r| r.managed && r.status == "previous")
            .cloned()
            .collect();
        for record in candidates {
            let driver = self.driver(record.side)?;
            if !driver.exists(&record).await? {
                state.records.retain(|r| r.id != record.id);
                continue;
            }
            let data = driver.inspect(&record).await?;
            ensure!(
                data.digest()? == record.checkpoint,
                "A retained version was edited; no automatic deletion is safe."
            );
            driver.assert_idle(&record).await?;
            state
                .records
                .iter_mut()
                .find(|r| r.id == record.id)
                .unwrap()
                .bytes = data.bytes;
        }
        let records: Vec<RetainedRecord> = state
            .records
            .iter()
            .filter(|r| {
                r.managed
                    && matches!(
                        r.status.as_str(),
                        "current" | "previous" | "dependency-anchor"
                    )
            })
            .map(|r| {
                let mut value = serde_json::to_value(r)?;
                value["createdAt"] = json!(r.retired_at.unwrap_or(r.created_at));
                Ok(serde_json::from_value(value)?)
            })
            .collect::<Result<_>>()?;
        let plan = retention::plan(&records, now(), &self.policy)?;
        ensure!(
            plan.blocked.is_empty(),
            "Retention quota cannot be met safely; new handoffs are paused."
        );
        for id in &plan.remove {
            let record = state
                .records
                .iter()
                .find(|r| &r.id == id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Missing retention target."))?;
            ensure!(
                record.managed && record.verified && record.status == "previous",
                "Unsafe retention target."
            );
            let driver = self.driver(record.side)?;
            driver.assert_idle(&record).await?;
            ensure!(
                driver.inspect(&record).await?.digest()? == record.checkpoint,
                "Retention target changed; collection paused."
            );
            driver.remove(&record).await?;
            state.records.retain(|r| r.id != record.id);
            self.save(state,Some(json!({"event":"pruned","conversationId":record.conversation_id,"side":record.side})))?;
        }
        self.save(state, None)?;
        Ok(json!({"removed":plan.remove.len(),"backupBytes":plan.backup_bytes}))
    }
}
