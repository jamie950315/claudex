//! Desktop ledger version 2: one stable Claude owner, bounded Codex snapshots,
//! and an at-most-once handoff journal. Adapters own all native mutations.
use crate::{
    bridge::Side,
    history::{Common, assert_complete, dialogue_fingerprint, fingerprint},
    retention::{self, Policy, RetainedRecord},
};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, FileLock};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// `digest` authenticates the exact canonical bytes. `dialogue` authenticates
/// only the dialogue (see `history::dialogue_fingerprint`); it is recorded with
/// every new checkpoint and added to older ones on their next exact match.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Checkpoint {
    pub count: usize,
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue: Option<String>,
}
/// Both digests describe the same saved prefix, so identity is count and the
/// exact digest.
impl PartialEq for Checkpoint {
    fn eq(&self, other: &Self) -> bool {
        self.count == other.count && self.digest == other.digest
    }
}
impl Eq for Checkpoint {}
impl Checkpoint {
    pub fn of(common: &Common) -> Result<Self> {
        Ok(Self {
            count: common.messages.len(),
            digest: Some(common.fingerprint()?),
            dialogue: Some(dialogue_fingerprint(
                &common.messages,
                common.messages.len(),
            )?),
        })
    }
    pub fn empty() -> Self {
        Self {
            count: 0,
            digest: None,
            dialogue: None,
        }
    }
    /// Exact canonical bytes. Writes, archival, retirement, relocation and
    /// other identity proofs use this.
    pub fn contains(&self, common: &Common) -> Result<bool> {
        Ok(self.count <= common.messages.len()
            && self.digest.as_deref() == Some(&fingerprint(&common.messages, self.count)?))
    }
    pub fn exact(&self, common: &Common) -> Result<bool> {
        Ok(self.count == common.messages.len() && self.contains(common)?)
    }
    /// Reading a native history: the exact bytes, or the same dialogue. A
    /// re-projected tool or event payload is not a divergence.
    pub fn contains_dialogue(&self, common: &Common) -> Result<bool> {
        if self.contains(common)? {
            return Ok(true);
        }
        Ok(self.count <= common.messages.len()
            && self.dialogue.as_deref()
                == Some(&dialogue_fingerprint(&common.messages, self.count)?))
    }
    pub fn exact_dialogue(&self, common: &Common) -> Result<bool> {
        Ok(self.count == common.messages.len() && self.contains_dialogue(common)?)
    }
    /// A write proof: the copied tail `written..count` is byte-exact with the
    /// source, and the prefix the destination already held is the same dialogue.
    pub fn contains_written(
        &self,
        destination: &Common,
        source: &Common,
        written: usize,
    ) -> Result<bool> {
        if self.contains(destination)? {
            return Ok(true);
        }
        let tail = |c: &Common| c.messages.get(written..self.count).map(|m| m.to_vec());
        Ok(written <= self.count
            && self.contains_dialogue(destination)?
            && tail(destination).is_some_and(|d| {
                tail(source)
                    .is_some_and(|s| fingerprint(&d, d.len()).ok() == fingerprint(&s, s.len()).ok())
            }))
    }
    /// This checkpoint with its dialogue digest added, when it lacks one and
    /// `common` matches its exact bytes.
    pub fn with_dialogue(&self, common: &Common) -> Result<Option<Self>> {
        if self.dialogue.is_some() || self.count == 0 || !self.contains(common)? {
            return Ok(None);
        }
        Ok(Some(Self {
            dialogue: Some(dialogue_fingerprint(&common.messages, self.count)?),
            ..self.clone()
        }))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.count > 0
                && self
                    .digest
                    .as_ref()
                    .is_some_and(|s| crate::packet::hex_digest(&json!(s)))
                && self
                    .dialogue
                    .as_ref()
                    .is_none_or(|s| crate::packet::hex_digest(&json!(s))),
            "Invalid completed checkpoint."
        );
        Ok(())
    }
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self::empty()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub canonical: Checkpoint,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
impl Conversation {
    pub fn tracked(&self) -> bool {
        self.extra
            .get("tracking")
            .is_none_or(|t| t["status"] != "stopped")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub conversation_id: String,
    pub side: Side,
    pub native_id: String,
    pub path: PathBuf,
    pub cwd: String,
    pub managed: bool,
    pub kind: String,
    pub verified: bool,
    pub status: String,
    #[serde(default)]
    pub checkpoint: Checkpoint,
    pub bytes: u64,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
fn reset_source(record: &Record, pending: &Pending) -> Record {
    let mut source = record.clone();
    if pending.record.extra.get("contextReset") == Some(&json!(true)) {
        source.extra.insert(
            "readResetSourceForOperation".into(),
            json!(pending.operation_id),
        );
    }
    source
}
fn committed_extra(mut extra: Map<String, Value>, count: usize) -> Map<String, Value> {
    if let Some(origins) = extra
        .get_mut("localImageRollouts")
        .and_then(Value::as_array_mut)
    {
        for origin in origins.iter_mut() {
            if let Some(requests) = origin["requests"].as_array_mut() {
                requests.retain(|r| {
                    r["messageIndex"]
                        .as_u64()
                        .is_some_and(|index| index < count as u64)
                });
            }
        }
        origins.retain(|o| o["requests"].as_array().is_some_and(|r| !r.is_empty()));
        if origins.is_empty() {
            extra.remove("localImageRollouts");
        }
    }
    extra
}
impl Record {
    pub fn source(side: Side, path: &Path, native_id: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            conversation_id: String::new(),
            side,
            native_id: native_id.into(),
            path: path.into(),
            cwd: String::new(),
            managed: false,
            kind: "original".into(),
            verified: false,
            status: "current".into(),
            checkpoint: Checkpoint::empty(),
            bytes: 0,
            created_at: now(),
            retired_at: None,
            extra: Map::new(),
        }
    }
    pub fn patch(&mut self, mut fields: Map<String, Value>) -> Result<()> {
        if let Some(path) = fields.remove("path") {
            self.path = serde_json::from_value(path)?;
        }
        if let Some(bytes) = fields.remove("bytes") {
            self.bytes = serde_json::from_value(bytes)?;
        }
        self.extra.extend(fields);
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Prepared,
    Applied,
    Promoted,
    Requested,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub phase: Phase,
    pub operation_id: String,
    pub record: Record,
    #[serde(default)]
    pub source_id: String,
    pub target_id: Option<String>,
    #[serde(default)]
    pub archive_original_id: Option<String>,
    #[serde(default)]
    pub reuse: bool,
    pub common: Common,
    pub checkpoint: Checkpoint,
    pub previous: Checkpoint,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum OriginalArchiveKind {
    #[serde(rename = "original-archive")]
    OriginalArchive,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePending {
    pub kind: OriginalArchiveKind,
    pub phase: Phase,
    pub operation_id: String,
    pub record: Record,
    pub original_id: String,
    pub replacement_id: String,
    pub checkpoint: Checkpoint,
    pub title: String,
    pub archive_tree: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum PendingOperation {
    Handoff(Pending),
    OriginalArchive(ArchivePending),
}
impl From<Pending> for PendingOperation {
    fn from(value: Pending) -> Self {
        Self::Handoff(value)
    }
}
impl<'de> Deserialize<'de> for PendingOperation {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value.get("kind") {
            None => serde_json::from_value(value)
                .map(Self::Handoff)
                .map_err(serde::de::Error::custom),
            Some(kind) if kind == "original-archive" => serde_json::from_value(value)
                .map(Self::OriginalArchive)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom(
                "Unsupported Desktop transaction kind.",
            )),
        }
    }
}
impl PendingOperation {
    pub fn phase(&self) -> &Phase {
        match self {
            Self::Handoff(p) => &p.phase,
            Self::OriginalArchive(p) => &p.phase,
        }
    }
}
#[async_trait]
pub trait ArchiveDispatch: Send + Sync {
    async fn before_dispatch(&self) -> Result<()>;
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub conversations: BTreeMap<String, Conversation>,
    pub records: Vec<Record>,
    pub pending: Option<PendingOperation>,
    pub audit: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 2,
            conversations: BTreeMap::new(),
            records: vec![],
            pending: None,
            audit: vec![],
            extra: Map::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Reading {
    pub common: Common,
    pub native_id: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub incomplete_tail: bool,
    pub extra: Map<String, Value>,
}
#[derive(Clone, Debug)]
pub struct PlanInput {
    pub conversation_id: String,
    pub native_id: String,
    pub operation_id: String,
    pub common: Common,
    pub title: String,
    pub target: Option<Record>,
    pub relocation: bool,
    pub context_reset: bool,
    pub context_refresh: bool,
}
#[derive(Clone, Debug)]
pub struct Relocation {
    pub record: Record,
    pub reading: Reading,
    pub proof: Value,
}

#[async_trait]
pub trait Adapter: Send + Sync {
    async fn inspect(&self, record: &Record) -> Result<Reading>;
    async fn assert_idle(&self, record: &Record) -> Result<()>;
    async fn plan(&self, input: &PlanInput) -> Result<Record>;
    async fn operation_applied(&self, record: &Record, pending: &Pending) -> Result<bool>;
    async fn apply(&self, record: &Record, pending: &Pending) -> Result<()>;
    async fn needs_maintenance(
        &self,
        _record: &Record,
        _reading: &Reading,
    ) -> Result<Option<String>> {
        Ok(None)
    }
    async fn resolve_applied(&self, record: &Record, _pending: &Pending) -> Result<Record> {
        Ok(record.clone())
    }
    async fn hide(&self, record: &Record) -> Result<Map<String, Value>>;
    async fn remove(&self, record: &Record) -> Result<()>;
    async fn exists(&self, record: &Record) -> Result<bool>;
    /// Explicit conflict resolution only, never ordinary checkpoint recovery.
    async fn inspect_edited_source(&self, _record: &Record) -> Result<(Reading, Value)> {
        bail!("Edited-source selection proof is unavailable.")
    }
    async fn prove_unapplied_owner(&self, _record: &Record) -> Result<Value> {
        bail!("Unapplied Claude owner proof is unavailable.")
    }
    async fn reconcile_relocation(
        &self,
        _record: &Record,
        _thorough: bool,
    ) -> Result<Option<Relocation>> {
        Ok(None)
    }
    async fn inspect_relocation_counterpart(&self, record: &Record) -> Result<Reading> {
        self.assert_idle(record).await?;
        self.inspect(record).await
    }
    async fn working_directory_absent(&self, cwd: &str) -> Result<bool> {
        match std::fs::symlink_metadata(cwd) {
            Ok(_) => Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(e.into()),
        }
    }
    async fn revoke_archive_actions(&self) -> Result<()> {
        Ok(())
    }
    async fn prepare_dependency_anchor(
        &self,
        _record: &Record,
    ) -> Result<Option<Map<String, Value>>> {
        Ok(None)
    }
    async fn assert_dependency_anchor(&self, _record: &Record) -> Result<Option<Value>> {
        bail!("Dependency anchor verification is unavailable; histories preserved.")
    }
    async fn assert_can_archive_original(&self, _record: &Record) -> Result<()> {
        bail!("Original archival proof is unavailable; nothing allocated.")
    }
    async fn preserve_closed_tail(&self, _record: &Record) -> Result<Value> {
        bail!("Closed original tail preservation proof is unavailable.")
    }
    async fn inspect_preserved_closed_tail(&self, _record: &Record) -> Result<Reading> {
        bail!("Preserved original tail verification is unavailable.")
    }
    async fn archive_original(&self, _record: &Record) -> Result<Map<String, Value>> {
        bail!("Original archival is unavailable; intent preserved.")
    }
    async fn assert_archive_replacement(
        &self,
        _original: &Record,
        _replacement: &Record,
        _title: &str,
    ) -> Result<()> {
        bail!("Original archive replacement proof is unavailable.")
    }
    async fn prepare_original_archive_tree(&self, _record: &Record) -> Result<Value> {
        bail!("Original archive tree proof is unavailable.")
    }
    async fn archive_original_tree(
        &self,
        _record: &Record,
        _proof: &Value,
        _allow_write: bool,
        _dispatch: &dyn ArchiveDispatch,
    ) -> Result<Map<String, Value>> {
        bail!("Original archive tree protocol is unavailable; intent preserved.")
    }
    async fn complete_promotion(&self, _record: &Record) -> Result<()> {
        Ok(())
    }
}

struct ArchiveJournal<'a> {
    bridge: &'a DesktopBridge,
    state: tokio::sync::Mutex<&'a mut State>,
    operation_id: String,
}
#[async_trait]
impl ArchiveDispatch for ArchiveJournal<'_> {
    async fn before_dispatch(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        let Some(PendingOperation::OriginalArchive(pending)) = state.pending.as_mut() else {
            bail!("Original archive dispatch lost its durable intent.");
        };
        ensure!(
            pending.operation_id == self.operation_id && pending.phase == Phase::Prepared,
            "Original archive dispatch was already recorded."
        );
        pending.phase = Phase::Requested;
        let id = pending.record.conversation_id.clone();
        self.bridge.save(
            &mut state,
            Some(json!({"event":"original-archive-requested","conversationId":id})),
        )
    }
}
pub(crate) type StateCache = std::sync::Mutex<Option<(storage::FileIdentity, Vec<u8>, State)>>;
pub(crate) fn read_state(root: &Path, cache: &StateCache) -> Result<State> {
    let path = root.join("desktop-state.json");
    let stored = match storage::read_stable(&path) {
        Ok(stored) => Some(stored),
        Err(error) if storage::is_not_found(&error) => None,
        Err(error) => return Err(error),
    };
    if let Some(stored) = &stored {
        if let Some((identity, bytes, state)) = cache.lock().unwrap().as_ref() {
            if identity == &stored.identity && bytes == &stored.bytes {
                return Ok(state.clone());
            }
        }
    }
    let state: State = match &stored {
        Some(stored) => serde_json::from_slice(&stored.bytes).map_err(|_| {
            anyhow::anyhow!("Malformed JSON state; inspect the local file before continuing.")
        })?,
        None => State::default(),
    };
    ensure!(state.version == 2, "Unsupported Desktop state version.");
    for (id, c) in &state.conversations {
        ensure!(id == &c.id, "Logical conversation identity mismatch.");
        c.canonical.validate()?;
        ensure!(
            c.extra
                .get("tracking")
                .is_none_or(|v| v["status"] == "stopped" && v["stoppedAt"].is_u64()),
            "Invalid tracking enrollment metadata."
        );
    }
    if let Some(stored) = stored {
        *cache.lock().unwrap() = Some((stored.identity, stored.bytes, state.clone()));
    } else {
        *cache.lock().unwrap() = None;
    }
    Ok(state)
}
pub struct DesktopBridge {
    pub root: PathBuf,
    pub adapters: BTreeMap<Side, Arc<dyn Adapter>>,
    pub policy: Policy,
    pub(crate) state_cache: Arc<StateCache>,
    /// Dialogue digests learned while verifying superseded originals; the next
    /// sync records them under its lock.
    dialogue_upgrades: std::sync::Mutex<Vec<(String, Checkpoint)>>,
}
impl DesktopBridge {
    pub fn new(root: impl Into<PathBuf>, adapters: BTreeMap<Side, Arc<dyn Adapter>>) -> Self {
        Self::with_cache(root, adapters, Arc::default())
    }
    pub(crate) fn with_cache(
        root: impl Into<PathBuf>,
        adapters: BTreeMap<Side, Arc<dyn Adapter>>,
        state_cache: Arc<StateCache>,
    ) -> Self {
        Self {
            root: root.into(),
            adapters,
            policy: Policy::default(),
            state_cache,
            dialogue_upgrades: Default::default(),
        }
    }
    fn adapter(&self, side: Side) -> Result<&Arc<dyn Adapter>> {
        self.adapters
            .get(&side)
            .ok_or_else(|| anyhow::anyhow!("Missing Desktop native adapter."))
    }
    fn lock(&self) -> Result<FileLock> {
        storage::private_directory(&self.root)?;
        FileLock::acquire(&self.root.join("desktop-operation.lock"), true)
    }
    pub fn status(&self) -> Result<State> {
        read_state(&self.root, &self.state_cache)
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
        *self.state_cache.lock().unwrap() = None;
        storage::write_json(
            self.root.join("desktop-state.json"),
            &serde_json::to_value(state)?,
        )
    }
    fn current<'a>(&self, state: &'a State, id: &str, side: Side) -> Option<&'a Record> {
        state
            .records
            .iter()
            .find(|r| r.conversation_id == id && r.side == side && r.status == "current")
    }
    pub async fn inspect(&self, record: &Record) -> Result<Reading> {
        let adapter = self.adapter(record.side)?;
        let mut data = if record.extra.contains_key("preservedClosedTail") {
            adapter.inspect_preserved_closed_tail(record).await?
        } else {
            adapter.inspect(record).await?
        };
        ensure!(
            record.native_id.is_empty() || data.native_id == record.native_id,
            "Native source identity changed; synchronization paused."
        );
        data.common.make_portable();
        for m in &mut data.common.messages {
            m.extra.clear();
        }
        assert_complete(&data.common)?;
        ensure!(
            record.cwd.is_empty() || data.common.cwd()? == record.cwd,
            "Source working directory changed; synchronization paused."
        );
        Ok(data)
    }
    async fn reconcile_one(
        &self,
        state: &mut State,
        record: &Record,
        thorough: bool,
    ) -> Result<bool> {
        if state.pending.is_some()
            || record.managed
            || !record.verified
            || record.status != "current"
            || record.kind != "original"
            || !state
                .conversations
                .get(&record.conversation_id)
                .is_some_and(Conversation::tracked)
        {
            return Ok(false);
        }
        let adapter = self.adapter(record.side)?;
        let Some(first) = adapter.reconcile_relocation(record, thorough).await? else {
            return Ok(false);
        };
        let conversation = state
            .conversations
            .get(&record.conversation_id)
            .unwrap()
            .clone();
        let validate = |candidate: &Relocation| -> Result<()> {
            let invariant = |r: &Record| -> Result<Value> {
                let mut r = serde_json::to_value(r)?;
                for key in ["path", "cwd", "relocation"] {
                    r.as_object_mut().unwrap().remove(key);
                }
                Ok(r)
            };
            let moved = &candidate.record;
            ensure!(
                invariant(moved)? == invariant(record)?
                    && candidate.reading.native_id == record.native_id
                    && candidate.reading.path == moved.path
                    && moved.extra.get("relocation").is_some_and(Value::is_object)
                    && (moved.path != record.path || moved.cwd != record.cwd),
                "Relocation changed protected identity or lifecycle fields."
            );
            let common = candidate.reading.common.portable();
            assert_complete(&common)?;
            ensure!(
                common.cwd()? == moved.cwd
                    && conversation.canonical.contains(&common)?
                    && record.checkpoint == conversation.canonical,
                "Relocation does not preserve the exact synchronized prefix."
            );
            ensure!(
                !candidate.reading.incomplete_tail
                    || record.side == Side::Codex
                        && candidate.reading.extra.get("closedTail") == Some(&json!(true)),
                "Relocation waits for a complete native turn."
            );
            Ok(())
        };
        validate(&first)?;
        if let Some(target) = self.current(state, &record.conversation_id, record.side.other()) {
            let replaceable = if record.side == Side::Claude {
                target.managed && target.kind == "snapshot"
            } else if target.managed {
                target.kind == "owner"
            } else {
                target.kind == "original"
            };
            ensure!(
                replaceable && target.verified,
                "Relocation needs its exact verified replaceable counterpart."
            );
            let destination = self
                .adapter(target.side)?
                .inspect_relocation_counterpart(target)
                .await?;
            ensure!(
                destination.native_id == target.native_id
                    && destination.common.cwd()? == target.cwd
                    && !destination.incomplete_tail
                    && conversation
                        .canonical
                        .exact(&destination.common.portable())?
                    && target.checkpoint == conversation.canonical,
                "Counterpart changed during relocation; no branch was selected."
            );
        }
        let latest = adapter
            .reconcile_relocation(record, thorough)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Relocation proof disappeared during verification."))?;
        validate(&latest)?;
        ensure!(
            serde_json::to_value(&latest.record)? == serde_json::to_value(&first.record)?
                && latest.proof == first.proof
                && latest.reading.bytes == first.reading.bytes
                && latest.reading.common.messages.len() == first.reading.common.messages.len()
                && latest.reading.common.fingerprint()? == first.reading.common.fingerprint()?,
            "Source history changed between complete relocation reads."
        );
        *state
            .records
            .iter_mut()
            .find(|r| r.id == record.id)
            .unwrap() = latest.record;
        state
            .conversations
            .get_mut(&record.conversation_id)
            .unwrap()
            .cwd = state
            .records
            .iter()
            .find(|r| r.id == record.id)
            .unwrap()
            .cwd
            .clone();
        self.save(state,Some(json!({"event":format!("{}-original-relocated",record.side.name()),"conversationId":record.conversation_id,"nativeId":record.native_id})))?;
        Ok(true)
    }
    async fn reconcile_originals(&self, state: &mut State, id: &str, thorough: bool) -> Result<()> {
        let records = state
            .records
            .iter()
            .filter(|r| {
                r.conversation_id == id
                    && r.status == "current"
                    && !r.managed
                    && r.kind == "original"
            })
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            self.reconcile_one(state, &record, thorough).await?;
        }
        Ok(())
    }
    async fn current_reading(
        &self,
        state: &State,
        id: &str,
        c: &Conversation,
        side: Side,
    ) -> Result<Option<(Record, Reading)>> {
        let Some(record) = self.current(state, id, side) else {
            return Ok(None);
        };
        let mut data = if record.cwd != c.cwd {
            self.adapter(side)?
                .inspect_relocation_counterpart(record)
                .await?
        } else {
            self.inspect(record).await?
        };
        data.common.make_portable();
        for m in &mut data.common.messages {
            m.extra.clear();
        }
        assert_complete(&data.common)?;
        ensure!(
            data.native_id == record.native_id && data.common.cwd()? == record.cwd,
            "Native relocation counterpart identity changed."
        );
        ensure!(
            c.canonical.contains_dialogue(&data.common)?,
            "History diverged before the common checkpoint; no branch was selected."
        );
        Ok(Some((record.clone(), data)))
    }
    async fn current_readings(
        &self,
        state: &State,
        id: &str,
        c: &Conversation,
    ) -> Result<Vec<(Record, Reading)>> {
        let (codex, claude) = tokio::join!(
            self.current_reading(state, id, c, Side::Codex),
            self.current_reading(state, id, c, Side::Claude),
        );
        let mut readings = vec![];
        if let Some(reading) = codex? {
            readings.push(reading);
        }
        if let Some(reading) = claude? {
            readings.push(reading);
        }
        Ok(readings)
    }
    async fn inspect_superseded_original(&self, r: &Record) -> Result<()> {
        let data = self.inspect(r).await?;
        ensure!(
            (!data.incomplete_tail
                || r.extra.contains_key("preservedClosedTail")
                    && data.extra.get("closedTail") == Some(&json!(true)))
                && r.checkpoint.exact_dialogue(&data.common)?,
            "Superseded original changed; no branch was selected."
        );
        if let Some(upgraded) = r.checkpoint.with_dialogue(&data.common)? {
            self.dialogue_upgrades
                .lock()
                .unwrap()
                .push((r.id.clone(), upgraded));
        }
        Ok(())
    }
    /// Record dialogue digests for checkpoints that still lack one, from
    /// readings that matched their exact bytes.
    fn record_dialogue(
        &self,
        state: &mut State,
        id: &str,
        readings: &[(Record, Reading)],
    ) -> Result<bool> {
        let mut upgrades = std::mem::take(&mut *self.dialogue_upgrades.lock().unwrap());
        let mut changed = false;
        for (record, data) in readings {
            if let Some(upgraded) = record.checkpoint.with_dialogue(&data.common)? {
                upgrades.push((record.id.clone(), upgraded));
            }
            let conversation = state.conversations.get_mut(id).unwrap();
            if let Some(upgraded) = conversation.canonical.with_dialogue(&data.common)? {
                conversation.canonical = upgraded;
                changed = true;
            }
        }
        for (record_id, upgraded) in upgrades {
            if let Some(saved) = state.records.iter_mut().find(|r| {
                r.id == record_id && r.checkpoint == upgraded && r.checkpoint.dialogue.is_none()
            }) {
                saved.checkpoint = upgraded;
                changed = true;
            }
        }
        let canonical = &state.conversations[id].canonical;
        for saved in state
            .records
            .iter_mut()
            .filter(|r| r.conversation_id == id && r.checkpoint.dialogue.is_none())
        {
            if saved.checkpoint == *canonical && canonical.dialogue.is_some() {
                saved.checkpoint = canonical.clone();
                changed = true;
            }
        }
        Ok(changed)
    }
    async fn originals(
        &self,
        state: &State,
        id: Option<&str>,
        frozen: &BTreeSet<String>,
        except: Option<&str>,
    ) -> Result<Vec<(String, Value)>> {
        let mut extensions = vec![];
        let mut originals = vec![];
        for r in state.records.iter().filter(|r| {
            id.is_none_or(|id| r.conversation_id == id)
                && !frozen.contains(&r.conversation_id)
                && except != Some(r.id.as_str())
        }) {
            if r.status == "dependency-anchor" {
                ensure!(
                    r.managed && r.verified && r.kind == "snapshot" && r.side == Side::Codex,
                    "Invalid dependency anchor record."
                );
                if let Some(proof) = self.adapter(r.side)?.assert_dependency_anchor(r).await? {
                    extensions.push((r.id.clone(), proof));
                }
            }
            if r.status == "original" && !r.managed {
                originals.push(r);
            }
        }
        // Independent read-only checks; bound how many native reads run at once.
        for chunk in originals.chunks(4) {
            futures_util::future::try_join_all(
                chunk.iter().map(|r| self.inspect_superseded_original(r)),
            )
            .await?;
        }
        Ok(extensions)
    }
    pub async fn track(&self, mut source: Record, title: Option<&str>) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending Desktop handoff first."
        );
        if let Some(saved) = state.records.iter().find(|r| {
            r.side == source.side
                && ((!source.native_id.is_empty() && r.native_id == source.native_id)
                    || r.path == source.path)
        }) {
            return Ok(
                json!({"conversationId":saved.conversation_id,"existing":true,"tracking":if state.conversations[&saved.conversation_id].tracked(){"active"}else{"stopped"}}),
            );
        }
        source
            .extra
            .insert("displayScreenshots".into(), json!("omitted"));
        crate::native_realtime::enroll(&mut source.extra);
        let data = self.inspect(&source).await?;
        if let Some(saved) = state
            .records
            .iter()
            .find(|r| r.side == source.side && r.native_id == data.native_id)
        {
            return Ok(json!({"conversationId":saved.conversation_id,"existing":true}));
        }
        let id = Uuid::new_v4().to_string();
        let canonical = Checkpoint::of(&data.common)?;
        let cwd = data.common.cwd()?.to_owned();
        let title = title
            .map(str::to_owned)
            .or_else(|| {
                data.common
                    .meta
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .or_else(|| {
                data.common
                    .messages
                    .iter()
                    .find(|m| m.role == "user")
                    .and_then(|m| m.content.iter().find_map(|b| b["text"].as_str()))
                    .map(|s| s.lines().next().unwrap_or(s).chars().take(100).collect())
            })
            .unwrap_or_else(|| "Claudex conversation".into());
        let mut extra = Map::new();
        extra.insert("displayScreenshots".into(), json!("omitted"));
        crate::native_realtime::inherit(&source.extra, &mut extra);
        state.conversations.insert(
            id.clone(),
            Conversation {
                id: id.clone(),
                cwd: cwd.clone(),
                title,
                canonical: canonical.clone(),
                extra,
            },
        );
        source.conversation_id = id.clone();
        source.native_id = data.native_id;
        source.path = data.path;
        source.cwd = cwd;
        source.checkpoint = canonical;
        source.bytes = data.bytes;
        source.verified = true;
        source.extra.extend(data.extra);
        state.records.push(source);
        self.save(
            &mut state,
            Some(json!({"event":"tracked","conversationId":id})),
        )?;
        Ok(json!({"conversationId":id,"existing":false}))
    }
    /// Historical import enrollment is a module API, not a discovery shortcut.
    /// Both immutable originals must prove the same complete canonical history.
    pub async fn track_imported_pair(
        &self,
        id: &str,
        source: Record,
        mut target: Record,
        title: &str,
    ) -> Result<Value> {
        Uuid::parse_str(id)?;
        Uuid::parse_str(&source.native_id)?;
        Uuid::parse_str(&target.native_id)?;
        ensure!(
            source.side == Side::Codex
                && !source.managed
                && source.kind == "original"
                && target.side == Side::Claude
                && !target.managed
                && target.kind == "original"
                && target.conversation_id == id
                && target.extra.get("importPacket") == Some(&json!(true))
                && target.extra.get("packetVersion") == Some(&json!(2)),
            "Invalid cold-import pair."
        );
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover pending Desktop handoff before cold import."
        );
        let prior = state
            .records
            .iter()
            .find(|r| r.side == Side::Codex && r.native_id == source.native_id);
        let prior_target = state
            .records
            .iter()
            .find(|r| r.side == Side::Claude && r.native_id == target.native_id);
        if prior.is_some() || prior_target.is_some() || state.conversations.contains_key(id) {
            ensure!(
                prior.is_some_and(|r| r.conversation_id == id)
                    && prior_target.is_some_and(|r| r.conversation_id == id
                        && r.extra.get("importPacket") == Some(&json!(true)))
                    && state.conversations.get(id).is_some_and(
                        |c| c.extra.get("discoveryMode") == Some(&json!("cold-import"))
                    ),
                "Cold-import identity belongs to a different enrollment."
            );
            return Ok(
                json!({"conversationId":id,"existing":true,"tracking":if state.conversations[id].tracked(){"active"}else{"stopped"}}),
            );
        }
        crate::native_realtime::inherit(&source.extra, &mut target.extra);
        let from = self.inspect(&source).await?;
        let to = self.inspect(&target).await?;
        let canonical = Checkpoint::of(&from.common)?;
        let cwd = from.common.cwd()?.to_owned();
        ensure!(
            canonical.exact(&to.common)? && to.common.cwd()? == cwd && !to.incomplete_tail,
            "Cold import does not match the complete source checkpoint."
        );
        let latest = self.inspect(&source).await?;
        ensure!(
            canonical.exact(&latest.common)? && latest.common.cwd()? == cwd,
            "Cold-import source changed during pairing."
        );
        let mut extra = json!({"discoveryMode":"cold-import"})
            .as_object()
            .unwrap()
            .clone();
        crate::native_realtime::inherit(&source.extra, &mut extra);
        state.conversations.insert(
            id.into(),
            Conversation {
                id: id.into(),
                cwd: cwd.clone(),
                title: if title.is_empty() {
                    "Claudex conversation".into()
                } else {
                    title.into()
                },
                canonical: canonical.clone(),
                extra,
            },
        );
        for (mut record, data) in [(source, latest), (target, to)] {
            record.id = Uuid::new_v4().to_string();
            record.conversation_id = id.into();
            record.cwd = cwd.clone();
            record.path = data.path;
            record.managed = false;
            record.kind = "original".into();
            record.verified = true;
            record.status = "current".into();
            record.checkpoint = canonical.clone();
            record.bytes = data.bytes;
            record.created_at = now();
            record.extra.extend(data.extra);
            state.records.push(record);
        }
        self.save(
            &mut state,
            Some(json!({"event":"cold-import-paired","conversationId":id})),
        )?;
        Ok(json!({"conversationId":id,"existing":false}))
    }
    pub async fn untrack(&self, id: &str, missing_only: bool) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending Desktop handoff before changing tracking."
        );
        if missing_only {
            self.reconcile_originals(&mut state, id, false).await?;
        }
        let c = state
            .conversations
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Unknown Desktop conversation."))?;
        if !c.tracked() {
            return Ok(
                json!({"changed":false,"conversationId":id,"tracking":"stopped","historyPreserved":true}),
            );
        }
        let absent = || async {
            self.adapter(Side::Claude)?
                .working_directory_absent(&state.conversations[id].cwd)
                .await
        };
        if missing_only && !absent().await? {
            return Ok(json!({"changed":false,"tracking":"active"}));
        }
        self.adapter(Side::Claude)?.revoke_archive_actions().await?;
        if missing_only && !absent().await? {
            return Ok(json!({"changed":false,"tracking":"active"}));
        }
        state.conversations.get_mut(id).unwrap().extra.insert(
            "tracking".into(),
            json!({"status":"stopped","stoppedAt":now()}),
        );
        self.save(
            &mut state,
            Some(json!({"event":"tracking-stopped","conversationId":id})),
        )?;
        Ok(json!({"changed":true,"conversationId":id,"tracking":"stopped","historyPreserved":true}))
    }
    pub async fn resume_tracking(&self, id: &str) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending Desktop handoff before changing tracking."
        );
        let c = state
            .conversations
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Unknown Desktop conversation."))?;
        if c.tracked() {
            return Ok(json!({"changed":false,"tracking":"active"}));
        }
        self.originals(&state, Some(id), &BTreeSet::new(), None)
            .await?;
        let mut changed = 0;
        let records: Vec<_> = state
            .records
            .iter()
            .filter(|r| r.conversation_id == id && r.status == "current")
            .collect();
        ensure!(
            !records.is_empty(),
            "Stopped conversation has no current native history."
        );
        for r in records {
            self.adapter(r.side)?.assert_idle(r).await?;
            let d = self.inspect(r).await?;
            ensure!(
                !d.incomplete_tail && c.canonical.contains_dialogue(&d.common)?,
                "Stopped conversation lost its synchronized prefix; tracking remains stopped."
            );
            changed += usize::from(d.common.messages.len() > c.canonical.count);
        }
        ensure!(
            changed <= 1,
            "Both stopped sides changed; tracking remains stopped."
        );
        state
            .conversations
            .get_mut(id)
            .unwrap()
            .extra
            .remove("tracking");
        self.save(
            &mut state,
            Some(json!({"event":"tracking-resumed","conversationId":id})),
        )?;
        Ok(json!({"changed":true,"tracking":"active","conversationId":id}))
    }
    pub async fn sync(&self, id: &str) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending Desktop handoff first."
        );
        self.reconcile_originals(&mut state, id, false).await?;
        let mut c = state
            .conversations
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Unknown Desktop conversation."))?;
        if !c.tracked() {
            return Ok(json!({"changed":false,"tracking":"stopped","conversationId":id}));
        }
        let extensions = self
            .originals(&state, Some(id), &BTreeSet::new(), None)
            .await?;
        for (record_id, label_free) in extensions {
            let record = state
                .records
                .iter_mut()
                .find(|r| r.id == record_id)
                .unwrap();
            record.extra.get_mut("dependencyAnchor").unwrap()["raw"]["labelFree"] = label_free;
            self.save(
                &mut state,
                Some(json!({"event":"dependency-anchor-proof-extended","conversationId":id})),
            )?;
        }
        let readings = match self.current_readings(&state, id, &c).await {
            Ok(readings) => readings,
            Err(error)
                if error.to_string()
                    == "Source working directory changed; synchronization paused." =>
            {
                self.reconcile_originals(&mut state, id, true).await?;
                c = state.conversations[id].clone();
                self.current_readings(&state, id, &c).await?
            }
            Err(error) => return Err(error),
        };
        if self.record_dialogue(&mut state, id, &readings)? {
            self.save(
                &mut state,
                Some(json!({"event":"checkpoint-dialogue-recorded","conversationId":id})),
            )?;
            c = state.conversations[id].clone();
        }
        let changed: Vec<_> = readings
            .iter()
            .filter(|(_, d)| d.common.messages.len() > c.canonical.count)
            .collect();
        ensure!(
            changed.len() <= 1,
            "Both sides changed; no history was replaced."
        );
        let relocated = readings.iter().find(|(r, _)| r.cwd != c.cwd);
        if let Some((target, data)) = relocated {
            ensure!(
                readings.iter().any(|(source, _)| source.side != target.side
                    && !source.managed
                    && source.cwd == c.cwd
                    && source.extra.contains_key("relocation"))
                    && if target.side == Side::Codex {
                        target.managed && target.kind == "snapshot"
                    } else if target.managed {
                        target.kind == "owner"
                    } else {
                        target.kind == "original"
                    },
                "Project move requires its exact replaceable counterpart."
            );
            ensure!(
                !data.incomplete_tail && !changed.iter().any(|(r, _)| r.side == target.side),
                "Relocation counterpart independently changed; no branch was selected."
            );
        }
        let mut maintenance = vec![];
        if let Some((target, _)) = relocated {
            maintenance.push((target.side, "relocation".to_owned()));
        }
        for (record, data) in &readings {
            if let Some(kind) = self
                .adapter(record.side)?
                .needs_maintenance(record, data)
                .await?
            {
                ensure!(
                    matches!(kind.as_str(), "reset" | "images"),
                    "Unsupported native maintenance kind."
                );
                maintenance.push((record.side, kind));
            }
        }
        ensure!(
            maintenance
                .iter()
                .filter(|(_, kind)| kind == "reset")
                .count()
                <= 1,
            "Only one native context migration may be planned at a time."
        );
        let upkeep = maintenance
            .iter()
            .find(|(_, kind)| kind == "relocation")
            .or_else(|| maintenance.iter().find(|(_, kind)| kind == "reset"))
            .or_else(|| maintenance.first());
        if changed.is_empty() && readings.len() == 2 && upkeep.is_none() {
            return Ok(
                json!({"changed":false,"incompleteTail":readings.iter().any(|(_,d)|d.incomplete_tail)}),
            );
        }
        let (source, data) = changed
            .first()
            .copied()
            .or_else(|| upkeep.and_then(|(side, _)| readings.iter().find(|(r, _)| r.side != *side)))
            .or_else(|| readings.first())
            .ok_or_else(|| anyhow::anyhow!("Missing Desktop source history."))?;
        let source = source.clone();
        let data = data.clone();
        let side = source.side.other();
        let context_reset = upkeep.is_some_and(|(s, kind)| *s == side && kind == "reset");
        let context_refresh = upkeep.is_some_and(|(s, kind)| *s == side && kind == "images");
        let target = self.current(&state, id, side).cloned();
        if let Some(target) = &target {
            self.adapter(side)?.assert_idle(target).await?;
        }
        let mut original = if side == Side::Codex
            && !(context_refresh
                && changed.is_empty()
                && target.as_ref().is_some_and(|t| t.managed))
        {
            target.as_ref().filter(|r| !r.managed).cloned().or_else(|| {
                state
                    .records
                    .iter()
                    .find(|r| {
                        r.conversation_id == id
                            && r.side == side
                            && r.status == "original"
                            && !r.managed
                            && !r.extra.contains_key("archivedAt")
                    })
                    .cloned()
            })
        } else {
            None
        };
        let mut preserved_original = None;
        if let Some(original) = &original {
            if original.extra.contains_key("preservedClosedTail") {
                self.inspect(original).await?;
                preserved_original = Some((
                    original.id.clone(),
                    original.extra["preservedClosedTail"].clone(),
                ));
            } else if original.status == "current" {
                let data = &readings
                    .iter()
                    .find(|(r, _)| r.id == original.id)
                    .ok_or_else(|| anyhow::anyhow!("Original destination reading is missing."))?
                    .1;
                if data.incomplete_tail && data.extra.get("closedTail") == Some(&json!(true)) {
                    preserved_original = Some((
                        original.id.clone(),
                        self.adapter(side)?.preserve_closed_tail(original).await?,
                    ));
                }
            }
            if preserved_original.is_none() {
                self.adapter(side)?
                    .assert_can_archive_original(original)
                    .await?;
            }
        }
        if preserved_original.is_some() {
            original = None;
        }
        let owner_relocation = side == Side::Claude
            && upkeep.is_some_and(|(s, k)| *s == side && k == "relocation")
            && target
                .as_ref()
                .is_some_and(|t| t.managed && t.kind == "owner");
        let append = upkeep.is_none()
            && side == Side::Claude
            && target
                .as_ref()
                .is_some_and(|r| r.managed && r.kind == "owner");
        if !append {
            self.collect_locked(&mut state, Some(id)).await?;
        }
        ensure!(
            source.cwd == data.common.cwd()? && c.cwd == data.common.cwd()?,
            "Source project changed while preparing synchronization."
        );
        let mut common = data.common;
        common.meta.insert("cwd".into(), json!(c.cwd));
        common.meta.insert(
            "timestamp".into(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        let operation = Uuid::new_v4().to_string();
        let mut record = self
            .adapter(side)?
            .plan(&PlanInput {
                conversation_id: id.into(),
                native_id: Uuid::new_v4().to_string(),
                operation_id: operation.clone(),
                common: common.clone(),
                title: c.title,
                target: target.clone(),
                relocation: owner_relocation,
                context_reset,
                context_refresh,
            })
            .await?;
        crate::native_realtime::inherit(&c.extra, &mut record.extra);
        let reuse = target
            .as_ref()
            .is_some_and(|t| t.managed && t.native_id == record.native_id);
        ensure!(
            !owner_relocation || !reuse && record.kind == "owner",
            "A moved Claude owner must receive a new native owner."
        );
        ensure!(
            !context_reset
                || side == Side::Claude
                    && reuse
                    && record.kind == "owner"
                    && record.extra.get("contextReset") == Some(&json!(true)),
            "Context migration requires a reusable owned Claude reset plan."
        );
        ensure!(
            !context_refresh
                || record.extra.get("imageProjectionVersion") == Some(&json!(1))
                    && (side != Side::Claude
                        || record.extra.get("contextRefresh") == Some(&json!(true))),
            "Visual maintenance requires an explicit native image projection."
        );
        if reuse {
            ensure!(
                side == Side::Claude
                    && record.kind == "owner"
                    && target.as_ref().unwrap().kind == "owner",
                "Only a verified Claude owner may reuse its identity."
            );
            self.adapter(side)?
                .assert_idle(target.as_ref().unwrap())
                .await?;
        }
        if append
            && (!reuse
                || record.extra.get("contextReset") == Some(&json!(true))
                || record.extra.get("contextRefresh") == Some(&json!(true)))
        {
            self.collect_locked(&mut state, Some(id)).await?;
        }
        record.id = if reuse {
            target.as_ref().unwrap().id.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        record.side = side;
        record.conversation_id = id.into();
        record.cwd = c.cwd;
        record.managed = true;
        record.status = "current".into();
        record.verified = false;
        record.bytes = 0;
        record.created_at = if reuse {
            target.as_ref().unwrap().created_at
        } else {
            now()
        };
        ensure!(
            !record.native_id.is_empty() && matches!(record.kind.as_str(), "owner" | "snapshot"),
            "Invalid native handoff plan."
        );
        let checkpoint = Checkpoint::of(&common)?;
        if let Some((record_id, proof)) = preserved_original {
            state
                .records
                .iter_mut()
                .find(|r| r.id == record_id)
                .ok_or_else(|| anyhow::anyhow!("Preserved original destination is missing."))?
                .extra
                .insert("preservedClosedTail".into(), proof);
        }
        state.pending = Some(
            Pending {
                phase: Phase::Prepared,
                operation_id: operation,
                record,
                source_id: source.id,
                target_id: target.map(|r| r.id),
                archive_original_id: original.map(|r| r.id),
                reuse,
                common,
                checkpoint,
                previous: if reuse && !context_reset {
                    c.canonical
                } else {
                    Checkpoint::empty()
                },
                extra: if owner_relocation {
                    json!({"relocation":true}).as_object().unwrap().clone()
                } else {
                    Map::new()
                },
            }
            .into(),
        );
        self.save(
            &mut state,
            Some(json!({"event":"prepared","conversationId":id,"side":side})),
        )?;
        self.finish(&mut state).await
    }
    pub async fn recover(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        if state.pending.is_none() {
            return Ok(json!({"changed":false}));
        }
        self.finish(&mut state).await
    }
    async fn finish(&self, state: &mut State) -> Result<Value> {
        let mut p = match state
            .pending
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Missing pending Desktop transaction."))?
        {
            PendingOperation::Handoff(p) => p,
            PendingOperation::OriginalArchive(_) => {
                return self.finish_original_archive(state).await;
            }
        };
        self.originals(
            state,
            Some(&p.record.conversation_id),
            &BTreeSet::new(),
            None,
        )
        .await?;
        let adapter = self.adapter(p.record.side)?;
        if p.phase != Phase::Promoted {
            let source = state
                .records
                .iter()
                .find(|r| r.id == p.source_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Desktop handoff source is missing."))?;
            ensure!(
                p.checkpoint
                    .contains_dialogue(&self.inspect(&source).await?.common)?,
                "Source changed during handoff; pending preserved."
            );
            let target = state
                .records
                .iter()
                .find(|r| Some(&r.id) == p.target_id.as_ref())
                .cloned();
            let applied = adapter.operation_applied(&p.record, &p).await?;
            if let Some(target) = &target {
                if !applied || !p.reuse {
                    self.adapter(target.side)?
                        .assert_idle(&reset_source(target, &p))
                        .await?;
                    ensure!(
                        target.checkpoint.exact_dialogue(
                            &self.inspect(&reset_source(target, &p)).await?.common
                        )?,
                        "Destination changed during handoff; no branch was selected."
                    );
                }
            }
            if !applied {
                adapter.apply(&p.record, &p).await?;
            }
            let resolved = adapter.resolve_applied(&p.record, &p).await?;
            ensure!(
                resolved.native_id == p.record.native_id
                    || p.reuse
                        && p.record.side == Side::Claude
                        && p.record.extra.get("contextReset") == Some(&json!(true)),
                "Only a verified native context reset may adopt a different reusable identity."
            );
            if serde_json::to_value(&resolved)? != serde_json::to_value(&p.record)? {
                p.record = resolved;
                state.pending = Some(p.clone().into());
                self.save(state, None)?;
            }
            let target_data = self.inspect(&p.record).await?;
            ensure!(
                p.checkpoint
                    .contains_written(&target_data.common, &p.common, p.previous.count)?,
                "Native destination lost the complete copied checkpoint."
            );
            p.record.path = target_data.path;
            p.record.verified = true;
            p.record.checkpoint = p.checkpoint.clone();
            p.record.bytes = target_data.bytes;
            p.record
                .extra
                .extend(committed_extra(target_data.extra, p.checkpoint.count));
            p.phase = Phase::Applied;
            state.pending = Some(p.clone().into());
            self.save(
                state,
                Some(json!({"event":"verified","conversationId":p.record.conversation_id})),
            )?;
            let latest = self.inspect(&source).await?;
            ensure!(
                p.checkpoint.contains_dialogue(&latest.common)?,
                "Source changed before promotion; pending preserved."
            );
            self.originals(
                state,
                Some(&p.record.conversation_id),
                &BTreeSet::new(),
                None,
            )
            .await?;
            if let Some(target) = &target {
                if !p.reuse {
                    self.adapter(target.side)?.assert_idle(target).await?;
                    ensure!(
                        target
                            .checkpoint
                            .exact_dialogue(&self.inspect(target).await?.common)?,
                        "Destination changed before promotion."
                    );
                }
            }
            let saved = state
                .records
                .iter_mut()
                .find(|r| r.id == source.id)
                .unwrap();
            saved.path = latest.path;
            saved.checkpoint = p.checkpoint.clone();
            saved.bytes = latest.bytes;
            saved
                .extra
                .extend(committed_extra(latest.extra, p.checkpoint.count));
            if p.reuse {
                let index = state
                    .records
                    .iter()
                    .position(|r| r.id == p.record.id)
                    .ok_or_else(|| anyhow::anyhow!("Reusable owner record missing."))?;
                state.records[index] = p.record.clone();
            } else {
                if let Some(target) = target {
                    let old = state
                        .records
                        .iter_mut()
                        .find(|r| r.id == target.id)
                        .unwrap();
                    old.status =
                        if p.extra.get("relocation") == Some(&json!(true)) && old.kind == "owner" {
                            "retired-owner"
                        } else if old.managed {
                            "previous"
                        } else {
                            "original"
                        }
                        .into();
                    old.retired_at = Some(now());
                }
                state.records.push(p.record.clone());
            }
            state
                .conversations
                .get_mut(&p.record.conversation_id)
                .ok_or_else(|| anyhow::anyhow!("Missing conversation during promotion."))?
                .canonical = p.checkpoint.clone();
            p.phase = Phase::Promoted;
            state.pending = Some(p.clone().into());
            self.save(
                state,
                Some(json!({"event":"promoted","conversationId":p.record.conversation_id})),
            )?;
        }
        if !p.reuse {
            if let Some(old) = state
                .records
                .iter()
                .find(|r| Some(&r.id) == p.target_id.as_ref() && r.managed)
                .cloned()
                .filter(|r| r.status != "retired-owner")
            {
                ensure!(
                    old.kind == "snapshot",
                    "Stable owners cannot be retired as snapshots."
                );
                if old.status == "dependency-anchor" {
                    self.adapter(old.side)?
                        .assert_dependency_anchor(&old)
                        .await?;
                } else if !self.preserve_anchor(state, &old, Some(&p)).await? {
                    self.assert_unchanged(&old).await?;
                    let fields = self.adapter(old.side)?.hide(&old).await?;
                    state
                        .records
                        .iter_mut()
                        .find(|r| r.id == old.id)
                        .unwrap()
                        .patch(fields)?;
                    self.save(state, None)?;
                }
            }
        }
        if let Some(id) = &p.archive_original_id {
            let original = state
                .records
                .iter()
                .find(|r| &r.id == id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Missing archive original."))?;
            ensure!(
                !p.reuse
                    && p.record.side == Side::Codex
                    && !original.managed
                    && original.kind == "original"
                    && original.status == "original"
                    && original.conversation_id == p.record.conversation_id,
                "Archive intent does not match promoted handoff."
            );
            self.originals(
                state,
                Some(&original.conversation_id),
                &BTreeSet::new(),
                None,
            )
            .await?;
            let fields = adapter.archive_original(&original).await?;
            let saved = state
                .records
                .iter_mut()
                .find(|r| r.id == original.id)
                .unwrap();
            saved.patch(fields)?;
            saved.extra.entry("archivedAt").or_insert(json!(now()));
            self.save(state, None)?;
        }
        adapter.complete_promotion(&p.record).await?;
        let result = json!({"changed":true,"conversationId":p.record.conversation_id,"side":p.record.side,"nativeId":p.record.native_id});
        state.pending = None;
        self.save(
            state,
            Some(json!({"event":"completed","conversationId":p.record.conversation_id})),
        )?;
        if !(p.reuse
            && p.record.side == Side::Claude
            && p.record.kind == "owner"
            && p.record.extra.get("contextReset") != Some(&json!(true))
            && p.record.extra.get("contextRefresh") != Some(&json!(true)))
        {
            self.collect_locked(state, Some(&p.record.conversation_id))
                .await?;
        }
        Ok(result)
    }
    pub async fn archive_original(&self, conversation_id: &str, native_id: &str) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover the pending Desktop handoff before original archival."
        );
        let original = state
            .records
            .iter()
            .find(|r| {
                r.conversation_id == conversation_id
                    && r.native_id == native_id
                    && r.side == Side::Codex
                    && r.status == "original"
                    && r.kind == "original"
                    && !r.managed
                    && r.verified
            })
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("The exact superseded Codex original is missing."))?;
        let replacement = self
            .current(&state, conversation_id, Side::Codex)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("The current Codex replacement is missing."))?;
        let conversation = state
            .conversations
            .get(conversation_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("The exact logical conversation is missing."))?;
        ensure!(
            conversation.tracked(),
            "Restore the saved tracking enrollment before original archival."
        );
        if original
            .extra
            .get("archivedAt")
            .is_some_and(|v| v.as_u64().is_some_and(|v| v > 0))
        {
            return Ok(
                json!({"changed":false,"conversationId":conversation_id,"nativeId":native_id}),
            );
        }
        self.verify_archive_replacement(
            &state,
            &original,
            &replacement,
            &conversation.canonical,
            &conversation.title,
        )
        .await?;
        let tree = self
            .adapter(Side::Codex)?
            .prepare_original_archive_tree(&original)
            .await?;
        state.pending = Some(PendingOperation::OriginalArchive(ArchivePending {
            kind: OriginalArchiveKind::OriginalArchive,
            phase: Phase::Prepared,
            operation_id: Uuid::new_v4().to_string(),
            record: original,
            original_id: state
                .records
                .iter()
                .find(|r| r.conversation_id == conversation_id && r.native_id == native_id)
                .unwrap()
                .id
                .clone(),
            replacement_id: replacement.id,
            checkpoint: conversation.canonical,
            title: conversation.title,
            archive_tree: tree,
            extra: Map::new(),
        }));
        self.save(&mut state, Some(json!({"event":"original-archive-prepared","conversationId":conversation_id,"nativeId":native_id})))?;
        self.finish_original_archive(&mut state).await
    }
    async fn verify_archive_replacement(
        &self,
        state: &State,
        original: &Record,
        replacement: &Record,
        checkpoint: &Checkpoint,
        title: &str,
    ) -> Result<()> {
        ensure!(
            !original.managed
                && original.verified
                && original.status == "original"
                && original.kind == "original"
                && original.side == Side::Codex
                && replacement.managed
                && replacement.verified
                && replacement.status == "current"
                && replacement.side == Side::Codex
                && replacement.kind == "snapshot"
                && original.conversation_id == replacement.conversation_id
                && original.native_id != replacement.native_id,
            "Original archive intent no longer matches its replacement."
        );
        self.originals(
            state,
            Some(&original.conversation_id),
            &BTreeSet::new(),
            None,
        )
        .await?;
        let data = self.inspect(replacement).await?;
        ensure!(
            !data.incomplete_tail
                && checkpoint.exact(&data.common)?
                && original.checkpoint.contains(&data.common)?,
            "Original archive replacement changed or lost the exact original prefix."
        );
        self.adapter(Side::Codex)?
            .assert_archive_replacement(original, replacement, title)
            .await
    }
    async fn finish_original_archive(&self, state: &mut State) -> Result<Value> {
        let Some(PendingOperation::OriginalArchive(pending)) = state.pending.clone() else {
            bail!("Missing original archive journal.");
        };
        ensure!(
            matches!(pending.phase, Phase::Prepared | Phase::Requested),
            "Invalid preserved-original archive phase."
        );
        Uuid::parse_str(&pending.operation_id)?;
        let original = state
            .records
            .iter()
            .find(|r| r.id == pending.original_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Original archive source is missing."))?;
        let replacement = state
            .records
            .iter()
            .find(|r| r.id == pending.replacement_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Original archive replacement is missing."))?;
        ensure!(
            original.native_id == pending.record.native_id
                && original.conversation_id == pending.record.conversation_id
                && original.cwd == pending.record.cwd
                && original.checkpoint == pending.record.checkpoint,
            "Original archive journal identity changed."
        );
        self.verify_archive_replacement(
            state,
            &original,
            &replacement,
            &pending.checkpoint,
            &pending.title,
        )
        .await?;
        let allow_write = pending.phase == Phase::Prepared;
        let result = {
            let dispatch = ArchiveJournal {
                bridge: self,
                state: tokio::sync::Mutex::new(&mut *state),
                operation_id: pending.operation_id.clone(),
            };
            self.adapter(Side::Codex)?
                .archive_original_tree(&original, &pending.archive_tree, allow_write, &dispatch)
                .await?
        };
        self.verify_archive_replacement(
            state,
            &original,
            &replacement,
            &pending.checkpoint,
            &pending.title,
        )
        .await?;
        let preserved = result
            .get("archivedTree")
            .and_then(|v| v["members"].as_array())
            .map(|rows| {
                rows.iter()
                    .filter(|r| r["disposition"] == "archive")
                    .count()
                    .saturating_sub(1)
            })
            .unwrap_or(0);
        let saved = state
            .records
            .iter_mut()
            .find(|r| r.id == original.id)
            .unwrap();
        saved.patch(result)?;
        saved.extra.insert("archivedAt".into(), json!(now()));
        state.pending = None;
        self.save(state, Some(json!({"event":"original-archive-completed","conversationId":original.conversation_id,"nativeId":original.native_id,"preservedDescendants":preserved})))?;
        Ok(
            json!({"changed":true,"conversationId":original.conversation_id,"nativeId":original.native_id,"preservedDescendants":preserved}),
        )
    }
    pub async fn abandon_unapplied(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        let Some(PendingOperation::Handoff(p)) = state.pending.as_ref() else {
            return Ok(json!({"abandoned":false}));
        };
        if p.phase != Phase::Prepared
            || p.reuse
            || p.record.side != Side::Codex
            || p.record.kind != "snapshot"
            || p.extra.contains_key("kind")
            || p.archive_original_id.is_some()
        {
            return Ok(json!({"abandoned":false}));
        }
        let file_absent = match crate::native::physical_rollout(&p.record.path) {
            Ok(_) => false,
            Err(e) if storage::is_not_found(&e) => true,
            Err(_) => false,
        };
        if !file_absent
            || !matches!(
                self.adapter(Side::Codex)?.exists(&p.record).await,
                Ok(false)
            )
        {
            return Ok(json!({"abandoned":false}));
        }
        let id = p.record.conversation_id.clone();
        state.pending = None;
        self.save(
            &mut state,
            Some(json!({"event":"abandoned","conversationId":id})),
        )?;
        Ok(json!({"abandoned":true,"conversationId":id}))
    }
    /// Adopt an explicitly selected shorter native prefix, preserving the full
    /// former handoff before changing the ledger. This is not normal recovery.
    pub async fn resolve_edited_source(
        &self,
        id: &str,
        native_id: &str,
        operation_id: &str,
        expected: Option<Checkpoint>,
    ) -> Result<Value> {
        for value in [id, native_id, operation_id] {
            ensure!(
                Uuid::parse_str(value)?.to_string() == value,
                "Exact UUID required."
            );
        }
        if let Some(expected) = &expected {
            expected.validate()?;
        }
        let _lock = self.lock()?;
        let mut state = self.status()?;
        let receipt_path = self
            .root
            .join("edited-source-resolutions")
            .join(format!("{operation_id}.json"));
        let receipt = match storage::read_stable_with_limit(&receipt_path, 512 * 1024 * 1024) {
            Ok(file) => {
                storage::require_private_directory(receipt_path.parent().unwrap())?;
                ensure!(
                    file.identity.uid == storage::uid().to_string()
                        && file.identity.mode.parse::<u32>()? & 0o7777 == 0o600
                        && file.identity.nlink == "1",
                    "Edited-source receipt must be private and single-link."
                );
                Some(serde_json::from_slice::<Value>(&file.bytes)?)
            }
            Err(error) if storage::is_not_found(&error) => None,
            Err(error) => return Err(error),
        };
        if let Some(receipt) = &receipt {
            let selected: Checkpoint =
                serde_json::from_value(receipt["selectedCheckpoint"].clone())?;
            let source_id = receipt["source"]["id"].as_str().unwrap_or("");
            let retained: Common = serde_json::from_value(receipt["selectedCommon"].clone())?;
            let previous: Pending = serde_json::from_value(receipt["pending"].clone())?;
            ensure!(
                receipt["version"] == 1
                    && receipt["conversation"]["id"] == id
                    && receipt["source"]["nativeId"] == native_id
                    && receipt["pending"]["operationId"] == operation_id
                    && selected.exact(&retained)?
                    && previous.checkpoint.exact(&previous.common)?
                    && selected.count < previous.checkpoint.count
                    && selected.contains(&previous.common)?
                    && expected.as_ref().is_none_or(|e| e == &selected),
                "Edited-source receipt does not match the explicit selection."
            );
            if state.records.iter().any(|r| {
                r.id == source_id
                    && r.conversation_id == id
                    && r.native_id == native_id
                    && r.extra.get("editedSourceResolution") == Some(&json!(operation_id))
            }) {
                return Ok(
                    json!({"changed":false,"resolved":true,"conversationId":id,"nativeId":native_id,
                    "operationId":operation_id,"checkpoint":selected,"receipt":receipt_path}),
                );
            }
        }
        let Some(PendingOperation::Handoff(pending)) = state.pending.clone() else {
            bail!("Exact prepared Desktop handoff is required for edited-source resolution.");
        };
        let conversation = state
            .conversations
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Unknown Desktop conversation."))?;
        let source = state
            .records
            .iter()
            .find(|r| r.id == pending.source_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Edited-source record is missing."))?;
        ensure!(
            pending.phase == Phase::Prepared
                && pending.operation_id == operation_id
                && !pending.reuse
                && pending.target_id.is_none()
                && pending.archive_original_id.is_none()
                && pending.extra.is_empty()
                && pending.previous == Checkpoint::empty()
                && pending.record.conversation_id == id
                && pending.record.side == Side::Claude
                && pending.record.managed
                && !pending.record.verified
                && pending.record.kind == "owner"
                && pending.record.status == "current"
                && pending.record.checkpoint == Checkpoint::empty()
                && pending.record.cwd == conversation.cwd
                && ["contextReset", "contextRefresh", "relocation"]
                    .iter()
                    .all(|k| !pending.record.extra.contains_key(*k))
                && conversation.tracked()
                && source.conversation_id == id
                && source.native_id == native_id
                && source.side == Side::Codex
                && !source.managed
                && source.verified
                && source.kind == "original"
                && source.status == "current"
                && source.cwd == conversation.cwd
                && !source.extra.contains_key("preservedClosedTail")
                && !source.extra.contains_key("relocation")
                && source.checkpoint == conversation.canonical
                && source.checkpoint == pending.checkpoint
                && pending.checkpoint.exact(&pending.common)?
                && pending.common.cwd()? == conversation.cwd
                && state
                    .records
                    .iter()
                    .filter(|r| r.conversation_id == id)
                    .count()
                    == 1
                && state.records.iter().all(|r| r.id != pending.record.id
                    && !(r.side == Side::Claude && r.native_id == pending.record.native_id))
                && state
                    .records
                    .iter()
                    .filter(|r| r.side == Side::Codex && r.native_id == native_id)
                    .count()
                    == 1,
            "Edited-source resolution only supports an unapplied first Claude handoff from its exact current Codex original."
        );
        let target_proof = self
            .adapter(Side::Claude)?
            .prove_unapplied_owner(&pending.record)
            .await?;
        let (mut selected, source_proof) = self
            .adapter(Side::Codex)?
            .inspect_edited_source(&source)
            .await?;
        selected.common.make_portable();
        for message in &mut selected.common.messages {
            message.extra.clear();
        }
        assert_complete(&selected.common)?;
        let checkpoint = Checkpoint::of(&selected.common)?;
        ensure!(
            selected.native_id == native_id
                && selected.common.cwd()? == conversation.cwd
                && (!selected.incomplete_tail
                    || selected.extra.get("closedTail") == Some(&json!(true)))
                && checkpoint.count < pending.checkpoint.count
                && checkpoint.contains(&pending.common)?
                && expected.as_ref().is_none_or(|e| e == &checkpoint),
            "Selected native history is not the exact expected shorter completed prefix; nothing changed."
        );
        let result = json!({"changed":false,"resolved":false,"conversationId":id,"nativeId":native_id,
            "operationId":operation_id,"checkpoint":checkpoint,"savedCheckpoint":pending.checkpoint,
            "selectedPath":selected.path,"closedTail":selected.extra.get("closedTail"),"neverApplied":true,"receipt":receipt_path});
        if expected.is_none() {
            return Ok(result);
        }
        let candidate = json!({"version":1,"conversation":conversation,"source":source,"pending":pending,
            "selectedCheckpoint":checkpoint,"selectedCommon":selected.common,"selectedPath":selected.path,
            "sourceProof":source_proof,"targetProof":target_proof});
        if let Some(receipt) = receipt {
            ensure!(
                receipt == candidate,
                "Edited-source resolution backup conflicts with current proofs; nothing changed."
            );
        } else {
            storage::private_directory(receipt_path.parent().unwrap())?;
            storage::require_private_directory(receipt_path.parent().unwrap())?;
            storage::publish_exclusive(&receipt_path, serde_json::to_vec_pretty(&candidate)?)?;
        }
        // Recheck after durable backup, before the single ledger publication.
        let (mut latest, latest_proof) = self
            .adapter(Side::Codex)?
            .inspect_edited_source(&source)
            .await?;
        latest.common.make_portable();
        ensure!(
            latest_proof == source_proof
                && checkpoint.exact(&latest.common)?
                && self
                    .adapter(Side::Claude)?
                    .prove_unapplied_owner(&pending.record)
                    .await?
                    == target_proof,
            "Edited-source native evidence changed after backup; pending handoff preserved."
        );
        let saved = state
            .records
            .iter_mut()
            .find(|r| r.id == source.id)
            .unwrap();
        saved.checkpoint = checkpoint.clone();
        saved.path = selected.path;
        saved.bytes = selected.bytes;
        saved.extra.remove("localImageRollouts");
        saved
            .extra
            .extend(committed_extra(selected.extra, checkpoint.count));
        saved
            .extra
            .insert("editedSourceResolution".into(), json!(operation_id));
        state.conversations.get_mut(id).unwrap().canonical = checkpoint.clone();
        state.pending = None;
        self.save(&mut state, Some(json!({"event":"edited-source-resolved","conversationId":id,
            "nativeId":native_id,"operationId":operation_id,"previousCheckpoint":pending.checkpoint,"checkpoint":checkpoint})))?;
        Ok(
            json!({"changed":true,"resolved":true,"conversationId":id,"nativeId":native_id,
            "operationId":operation_id,"checkpoint":checkpoint,"receipt":receipt_path}),
        )
    }
    async fn assert_unchanged(&self, r: &Record) -> Result<Reading> {
        ensure!(
            r.managed && r.verified && r.kind == "snapshot",
            "Unowned or unverified retirement target."
        );
        self.adapter(r.side)?.assert_idle(r).await?;
        let d = self.inspect(r).await?;
        ensure!(
            !d.incomplete_tail && r.checkpoint.exact(&d.common)?,
            "A retained snapshot was edited; it was not retired."
        );
        Ok(d)
    }
    async fn preserve_anchor(
        &self,
        state: &mut State,
        r: &Record,
        p: Option<&Pending>,
    ) -> Result<bool> {
        let Some(proof) = self.adapter(r.side)?.prepare_dependency_anchor(r).await? else {
            return Ok(false);
        };
        ensure!(
            r.managed
                && r.verified
                && r.side == Side::Codex
                && r.kind == "snapshot"
                && proof
                    .get("dependencyIds")
                    .is_some_and(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                && proof.contains_key("dependencyAnchor"),
            "Dependency anchor proof incomplete."
        );
        let mut candidate = r.clone();
        candidate.status = "dependency-anchor".into();
        candidate.patch(proof)?;
        let mut records = state.records.clone();
        *records.iter_mut().find(|v| v.id == r.id).unwrap() = candidate.clone();
        let plan = self.retention_plan(&records, &BTreeSet::new())?;
        ensure!(
            plan.blocked.is_empty(),
            "Dependency anchor capacity exceeded."
        );
        if let Some(p) = p {
            for record in state
                .records
                .iter()
                .filter(|r| r.id == p.source_id || r.id == p.record.id)
            {
                ensure!(
                    p.checkpoint.contains(&self.inspect(record).await?.common)?,
                    "Dependency anchor replacement prefix changed."
                );
            }
        }
        self.adapter(r.side)?
            .assert_dependency_anchor(&candidate)
            .await?;
        *state.records.iter_mut().find(|v| v.id == r.id).unwrap() = candidate;
        self.save(
            state,
            Some(json!({"event":"dependency-anchor-preserved","conversationId":r.conversation_id})),
        )?;
        Ok(true)
    }
    fn retention_plan(
        &self,
        records: &[Record],
        frozen: &BTreeSet<String>,
    ) -> Result<retention::RetentionPlan> {
        let records = records
            .iter()
            .filter(|r| r.managed && r.kind == "snapshot")
            .map(|r| {
                let mut v = serde_json::to_value(r)?;
                v["createdAt"] = json!(r.retired_at.unwrap_or(r.created_at));
                if frozen.contains(&r.conversation_id) {
                    v["frozen"] = json!(true);
                }
                Ok(serde_json::from_value::<RetainedRecord>(v)?)
            })
            .collect::<Result<Vec<_>>>()?;
        retention::plan(&records, now(), &self.policy)
    }
    pub async fn collect(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover pending Desktop handoff before collection."
        );
        self.collect_locked(&mut state, None).await
    }
    pub async fn split_original(
        &self,
        id: &str,
        native_id: &str,
        record_id: &str,
        expected: Checkpoint,
    ) -> Result<Value> {
        for value in [id, native_id, record_id] {
            Uuid::parse_str(value)?;
        }
        expected.validate()?;
        let _lock = self.lock()?;
        let mut state = self.status()?;
        ensure!(
            state.pending.is_none(),
            "Recover pending Desktop handoff before splitting an original."
        );
        if let Some(branch) = state.conversations.values().find(|c| {
            c.extra.get("originalSplit").is_some_and(|r| {
                r["fromConversationId"] == id
                    && r["originalNativeId"] == native_id
                    && r["originalRecordId"] == record_id
            })
        }) {
            let receipt = &branch.extra["originalSplit"];
            let original = state
                .records
                .iter()
                .find(|r| r.id == record_id)
                .ok_or_else(|| anyhow::anyhow!("Split receipt enrollment missing."))?;
            ensure!(
                receipt["version"] == 1
                    && serde_json::from_value::<Checkpoint>(receipt["separatedCheckpoint"].clone())
                        .is_ok_and(|c| c == expected)
                    && original.conversation_id == branch.id
                    && original.native_id == native_id
                    && original.side == Side::Claude
                    && !original.managed
                    && original.verified
                    && original.kind == "original",
                "Original split receipt does not match enrollment."
            );
            return Ok(
                json!({"changed":false,"conversationId":branch.id,"fromConversationId":id,"originalNativeId":native_id,"originalRecordId":record_id,"checkpoint":expected}),
            );
        }
        let conversation = state
            .conversations
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Unknown Desktop conversation."))?;
        let original = state
            .records
            .iter()
            .find(|r| r.id == record_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Exact original record missing."))?;
        ensure!(
            conversation.tracked()
                && original.conversation_id == id
                && original.native_id == native_id
                && original.side == Side::Claude
                && !original.managed
                && original.verified
                && original.kind == "original"
                && original.status == "original"
                && original.cwd == conversation.cwd
                && !original.extra.contains_key("importPacket")
                && state
                    .records
                    .iter()
                    .filter(|r| r.side == Side::Claude && r.native_id == native_id)
                    .count()
                    == 1,
            "Only an exact tracked superseded unmanaged Claude original can be split."
        );
        original.checkpoint.validate()?;
        let currents: Vec<_> = state
            .records
            .iter()
            .filter(|r| r.conversation_id == id && r.status == "current")
            .cloned()
            .collect();
        ensure!(
            currents.len() == 2
                && [Side::Codex, Side::Claude].iter().all(|side| currents
                    .iter()
                    .filter(|r| &r.side == side)
                    .count()
                    == 1)
                && currents.iter().all(|r| r.managed
                    && r.verified
                    && r.kind
                        == if r.side == Side::Codex {
                            "snapshot"
                        } else {
                            "owner"
                        }
                    && r.checkpoint == conversation.canonical),
            "Original splitting requires unchanged verified current pair."
        );
        let source = self.proven_inspection(&original).await?;
        ensure!(
            original.checkpoint.contains(&source.0.common)?
                && source.0.common.messages.len() > original.checkpoint.count
                && expected.exact(&source.0.common)?,
            "Original no longer contains its saved prefix and exact inspected branch."
        );
        self.originals(&state, Some(id), &BTreeSet::new(), Some(record_id))
            .await?;
        let mut destinations = vec![];
        for current in &currents {
            let data = self.proven_inspection(current).await?;
            ensure!(
                conversation.canonical.exact(&data.0.common)?
                    && original.checkpoint.contains(&data.0.common)?,
                "Current pair changed or lost shared original prefix."
            );
            destinations.push((current, data));
        }
        let shared = expected.count.min(conversation.canonical.count);
        ensure!(
            fingerprint(&source.0.common.messages, shared)?
                != fingerprint(&destinations[0].1.0.common.messages, shared)?,
            "Histories are not independent branches; no original was split."
        );
        for (current, data) in &destinations {
            let latest = self.proven_inspection(current).await?;
            ensure!(
                latest.1 == data.1 && conversation.canonical.exact(&latest.0.common)?,
                "Current pair changed between verification reads."
            );
        }
        let latest = self.proven_inspection(&original).await?;
        ensure!(
            latest.1 == source.1 && expected.exact(&latest.0.common)?,
            "Original changed between verification reads."
        );
        let branch_id = Uuid::new_v4().to_string();
        let receipt = json!({"version":1,"fromConversationId":id,"originalNativeId":native_id,"originalRecordId":record_id,"previousCheckpoint":original.checkpoint,"separatedCheckpoint":expected,"at":now()});
        let mut extra = Map::new();
        extra.insert("originalSplit".into(), receipt);
        crate::native_realtime::inherit(&original.extra, &mut extra);
        state.conversations.insert(
            branch_id.clone(),
            Conversation {
                id: branch_id.clone(),
                cwd: conversation.cwd,
                title: conversation.title,
                canonical: expected.clone(),
                extra,
            },
        );
        let saved = state
            .records
            .iter_mut()
            .find(|r| r.id == record_id)
            .unwrap();
        saved.conversation_id = branch_id.clone();
        saved.status = "current".into();
        saved.checkpoint = expected.clone();
        saved.bytes = latest.0.bytes;
        saved.retired_at = None;
        self.save(&mut state,Some(json!({"event":"original-branch-split","conversationId":branch_id,"fromConversationId":id,"nativeId":native_id})))?;
        Ok(
            json!({"changed":true,"conversationId":branch_id,"fromConversationId":id,"originalNativeId":native_id,"originalRecordId":record_id,"checkpoint":expected}),
        )
    }
    async fn proven_inspection(&self, r: &Record) -> Result<(Reading, Value)> {
        self.adapter(r.side)?.assert_idle(r).await?;
        let path = if r.side == Side::Codex {
            crate::native::physical_rollout(&r.path)?
        } else {
            r.path.clone()
        };
        let before = storage::snapshot(&path)?;
        let data = self.inspect(r).await?;
        let after = storage::snapshot(&path)?;
        ensure!(
            data.path == r.path
                && !data.incomplete_tail
                && before.hash == after.hash
                && before.file_identity == after.file_identity,
            "Native history changed or has unfinished work; neither branch changed."
        );
        Ok((
            data,
            json!({"path":r.path,"hash":after.hash,"fileIdentity":after.file_identity}),
        ))
    }
    async fn collect_locked(&self, state: &mut State, caller: Option<&str>) -> Result<Value> {
        let mut frozen = BTreeSet::new();
        let mut holds = BTreeMap::new();
        if state.pending.is_none() {
            let originals = state
                .records
                .iter()
                .filter(|r| !r.managed && r.kind == "original" && r.status == "current")
                .cloned()
                .collect::<Vec<_>>();
            for original in originals {
                if let Err(error) = self.reconcile_one(state, &original, false).await {
                    if caller.is_none_or(|id| id == original.conversation_id)
                        || is_transport(&error)
                    {
                        return Err(error);
                    }
                    holds.insert(original.conversation_id.clone(), format!("{error:#}"));
                    frozen.insert(original.conversation_id);
                }
            }
        }
        for (id, c) in &state.conversations {
            if frozen.contains(id) {
                continue;
            }
            if !c.tracked() {
                frozen.insert(id.clone());
                continue;
            }
            for cwd in std::iter::once(c.cwd.as_str()).chain(
                state
                    .records
                    .iter()
                    .filter(|r| r.conversation_id == *id && r.status != "retired-owner")
                    .map(|r| r.cwd.as_str()),
            ) {
                if self
                    .adapter(Side::Codex)?
                    .working_directory_absent(cwd)
                    .await?
                {
                    frozen.insert(id.clone());
                    break;
                }
            }
        }
        let snapshots: Vec<_> = state
            .records
            .iter()
            .filter(|r| r.managed && r.kind == "snapshot")
            .cloned()
            .collect();
        let ids: BTreeSet<_> = snapshots
            .iter()
            .map(|r| r.conversation_id.clone())
            .collect();
        for id in ids {
            if frozen.contains(&id) {
                continue;
            }
            let verify = async {
                self.originals(state, Some(&id), &BTreeSet::new(), None)
                    .await?;
                for r in state
                    .records
                    .iter()
                    .filter(|r| r.conversation_id == id && r.status == "current")
                {
                    ensure!(
                        r.checkpoint.contains(&self.inspect(r).await?.common)?,
                        "Current history changed; snapshots preserved."
                    );
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(e) = verify {
                if caller.is_none_or(|c| c == id) || is_transport(&e) {
                    return Err(e);
                }
                holds.insert(id.clone(), format!("{e:#}"));
                frozen.insert(id);
            }
        }
        for r in snapshots.iter().filter(|r| r.status == "previous") {
            if frozen.contains(&r.conversation_id) {
                continue;
            }
            let verify = async {
                if !self.adapter(r.side)?.exists(r).await? {
                    state.records.retain(|v| v.id != r.id);
                    return Ok(());
                }
                if !self.preserve_anchor(state, r, None).await? {
                    let data = self.assert_unchanged(r).await?;
                    state
                        .records
                        .iter_mut()
                        .find(|v| v.id == r.id)
                        .unwrap()
                        .bytes = data.bytes;
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(e) = verify {
                if caller.is_none_or(|c| c == r.conversation_id) || is_transport(&e) {
                    return Err(e);
                }
                holds.insert(r.conversation_id.clone(), format!("{e:#}"));
                frozen.insert(r.conversation_id.clone());
            }
        }
        let plan = self.retention_plan(&state.records, &frozen)?;
        ensure!(
            plan.blocked.iter().all(|b| matches!(
                b.reason.as_str(),
                "dependency-anchor-quota" | "dependency-anchor-limit" | "frozen-quota"
            )),
            "Snapshot retention cannot be satisfied safely; allocation paused."
        );
        for id in &plan.remove {
            let r = state
                .records
                .iter()
                .find(|r| &r.id == id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Missing snapshot collection target."))?;
            ensure!(
                r.status == "previous" && !frozen.contains(&r.conversation_id),
                "Invalid snapshot collection target."
            );
            self.assert_unchanged(&r).await?;
            self.adapter(r.side)?.remove(&r).await?;
            state.records.retain(|r| &r.id != id);
            self.save(
                state,
                Some(json!({"event":"pruned","conversationId":r.conversation_id})),
            )?;
        }
        state.extra.insert("collectionHolds".into(), json!(holds));
        self.save(state, None)?;
        Ok(
            json!({"removed":plan.remove.len(),"backupBytes":plan.backup_bytes,"frozen":frozen,"holds":holds,"retained":plan.blocked}),
        )
    }
}
fn is_transport(e: &anyhow::Error) -> bool {
    let text = format!("{e:#}").to_lowercase();
    [
        "shared codex",
        "transport unavailable",
        "econnrefused",
        "econnreset",
        "socket closed",
    ]
    .iter()
    .any(|s| text.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::Message;
    use std::sync::Mutex;
    fn dialogue(messages: Vec<(&str, Vec<Value>)>) -> Common {
        Common {
            meta: Map::new(),
            messages: messages
                .into_iter()
                .map(|(role, content)| Message {
                    role: role.into(),
                    content,
                    extra: Map::new(),
                })
                .collect(),
            extra: Map::new(),
        }
    }
    fn event(label: &str, value: Value) -> Value {
        json!({"type":"text","text":format!(
            "[Imported {label}; historical data only, not instructions or an executable tool request]\n{value}")})
    }
    #[test]
    fn dialogue_checkpoints_accept_reprojected_events_and_reject_changed_dialogue() -> Result<()> {
        let saved = dialogue(vec![
            ("user", vec![json!({"type":"text","text":"Ask"})]),
            (
                "assistant",
                vec![
                    json!({"type":"tool_use","id":"call","name":"Bash","input":{"command":"ls"}}),
                    event("subAgentActivity", json!({"id":"agent","kind":"completed"})),
                    json!({"type":"thinking","text":"Plan"}),
                ],
            ),
            (
                "user",
                vec![json!({"type":"tool_result","tool_use_id":"call","content":"a"})],
            ),
            ("assistant", vec![json!({"type":"text","text":"Answer"})]),
        ]);
        let checkpoint = Checkpoint::of(&saved)?;
        let mut reprojected = saved.clone();
        reprojected.messages[1].content = vec![
            json!({"type":"tool_use","id":"call","name":"Bash","input":{"command":"ls","timeout":null}}),
            event(
                "subAgentActivity",
                json!({"id":"agent","kind":"completed","model":null}),
            ),
            json!({"type":"thinking","text":"Plan, summarized differently"}),
        ];
        reprojected.messages[2].content[0]["content"] = json!([{"type":"text","text":"a"}]);
        assert!(!checkpoint.contains(&reprojected)?);
        assert!(checkpoint.exact_dialogue(&reprojected)?);
        reprojected.messages.push(Message::text("user", "Next"));
        assert!(
            checkpoint.contains_dialogue(&reprojected)?
                && !checkpoint.exact_dialogue(&reprojected)?
        );
        let changes: [fn(&mut Common); 5] = [
            |c| c.messages[3].content[0]["text"] = json!("Edited answer"),
            |c| c.messages[0].role = "assistant".into(),
            |c| c.messages[1].content[0]["id"] = json!("other-call"),
            |c| c.messages[1].content[1] = event("subAgentActivity", json!({"id":"other-agent"})),
            |c| c.messages[2].content[0]["tool_use_id"] = json!("other-call"),
        ];
        for change in changes {
            let mut diverged = saved.clone();
            change(&mut diverged);
            assert!(!checkpoint.contains_dialogue(&diverged)?);
        }
        // An older checkpoint gains its dialogue only from an exact match.
        let legacy = Checkpoint {
            dialogue: None,
            ..checkpoint.clone()
        };
        assert!(!legacy.contains_dialogue(&reprojected)?);
        assert!(legacy.with_dialogue(&reprojected)?.is_none());
        assert_eq!(
            legacy.with_dialogue(&saved)?.unwrap().dialogue,
            checkpoint.dialogue
        );
        assert!(checkpoint.with_dialogue(&saved)?.is_none());
        // A write proof needs the copied tail byte-exact with its source.
        let mut source = saved.clone();
        source.messages.push(Message::text("user", "Copied"));
        let written = Checkpoint::of(&source)?;
        let mut destination = reprojected.clone();
        destination.messages[4] = Message::text("user", "Copied");
        assert!(written.contains_written(&destination, &source, saved.messages.len())?);
        destination.messages[4] = Message::text("user", "Copied, but changed");
        assert!(!written.contains_written(&destination, &source, saved.messages.len())?);
        destination.messages[4] = Message::text("user", "Copied");
        destination.messages[4]
            .content
            .push(json!({"type":"text","text":""}));
        assert!(!written.contains_written(&destination, &source, saved.messages.len())?);
        Ok(())
    }
    #[derive(Default)]
    struct Native {
        histories: BTreeMap<String, Common>,
        applied: BTreeSet<String>,
        applications: usize,
        fail_after_apply: bool,
        mutate_after_apply: Option<String>,
        hidden: Vec<String>,
        removed: Vec<String>,
        missing_cwd: bool,
        archive_writes: usize,
        archive_tree_done: bool,
        fail_after_archive: bool,
        archive_no_outcome: bool,
        relocations: BTreeMap<String, Relocation>,
        unstable_relocation: bool,
        relocation_reads: usize,
        maintenance: BTreeMap<String, String>,
        reset_ids: BTreeMap<String, String>,
        promotions: Vec<String>,
        fail_resolved_inspection: bool,
        fail_inspect: Option<String>,
        closed_tails: BTreeMap<String, Value>,
        edited_reads: usize,
        change_edited_proof: bool,
        refuse_unapplied: bool,
    }
    struct Mock {
        side: Side,
        native: Arc<Mutex<Native>>,
    }
    #[async_trait]
    impl Adapter for Mock {
        async fn inspect_edited_source(&self, r: &Record) -> Result<(Reading, Value)> {
            let reading = self.inspect(r).await?;
            let mut native = self.native.lock().unwrap();
            native.edited_reads += 1;
            let revision = if native.change_edited_proof {
                native.edited_reads
            } else {
                0
            };
            Ok((reading, json!({"rawRevision":revision})))
        }
        async fn prove_unapplied_owner(&self, r: &Record) -> Result<Value> {
            let native = self.native.lock().unwrap();
            ensure!(
                !native.refuse_unapplied && !native.histories.contains_key(&r.native_id),
                "Synthetic owner is applied or uncertain."
            );
            Ok(json!({"neverApplied":true,"nativeId":r.native_id}))
        }
        async fn inspect(&self, r: &Record) -> Result<Reading> {
            let mut state = self.native.lock().unwrap();
            if state.fail_inspect.as_deref() == Some(&r.native_id) {
                state.fail_inspect = None;
                bail!("Synthetic resolved inspection failed.");
            }
            let common = state
                .histories
                .get(&r.native_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Synthetic native source absent."))?;
            Ok(Reading {
                common,
                native_id: r.native_id.clone(),
                path: r.path.clone(),
                bytes: 10,
                incomplete_tail: state.closed_tails.contains_key(&r.native_id),
                extra: json!({"closedTail":state.closed_tails.contains_key(&r.native_id)})
                    .as_object()
                    .unwrap()
                    .clone(),
            })
        }
        async fn assert_idle(&self, _r: &Record) -> Result<()> {
            Ok(())
        }
        async fn reconcile_relocation(
            &self,
            r: &Record,
            _thorough: bool,
        ) -> Result<Option<Relocation>> {
            let mut state = self.native.lock().unwrap();
            state.relocation_reads += 1;
            Ok(state
                .relocations
                .get(&r.native_id)
                .filter(|m| m.record.cwd != r.cwd || m.record.path != r.path)
                .cloned()
                .map(|mut m| {
                    if state.unstable_relocation {
                        m.proof["reads"] = json!(state.relocation_reads);
                    }
                    m
                }))
        }
        async fn plan(&self, input: &PlanInput) -> Result<Record> {
            if self.side == Side::Claude {
                if let Some(r) = input
                    .target
                    .as_ref()
                    .filter(|r| r.managed && r.kind == "owner" && !input.relocation)
                {
                    let mut planned = r.clone();
                    if input.context_reset {
                        planned.extra.insert("contextReset".into(), json!(true));
                    }
                    if input.context_refresh {
                        planned.extra.insert("contextRefresh".into(), json!(true));
                    }
                    if input.context_reset || input.context_refresh {
                        planned.extra.insert("packetVersion".into(), json!(2));
                        planned
                            .extra
                            .insert("imageProjectionVersion".into(), json!(1));
                    }
                    return Ok(planned);
                }
            }
            let mut r = Record::source(self.side, Path::new("/synthetic-native"), &input.native_id);
            r.kind = if self.side == Side::Claude {
                "owner"
            } else {
                "snapshot"
            }
            .into();
            Ok(r)
        }
        async fn needs_maintenance(
            &self,
            r: &Record,
            _reading: &Reading,
        ) -> Result<Option<String>> {
            Ok(self
                .native
                .lock()
                .unwrap()
                .maintenance
                .get(&r.native_id)
                .cloned())
        }
        async fn resolve_applied(&self, r: &Record, p: &Pending) -> Result<Record> {
            let mut state = self.native.lock().unwrap();
            let mut resolved = r.clone();
            if let Some(id) = state.reset_ids.get(&p.operation_id).cloned() {
                resolved.native_id = id.clone();
                resolved.path = PathBuf::from(format!("/synthetic-{id}"));
                if state.fail_resolved_inspection {
                    state.fail_resolved_inspection = false;
                    state.fail_inspect = Some(id);
                }
            }
            Ok(resolved)
        }
        async fn complete_promotion(&self, r: &Record) -> Result<()> {
            self.native
                .lock()
                .unwrap()
                .promotions
                .push(r.native_id.clone());
            Ok(())
        }
        async fn operation_applied(&self, _r: &Record, p: &Pending) -> Result<bool> {
            Ok(self
                .native
                .lock()
                .unwrap()
                .applied
                .contains(&p.operation_id))
        }
        async fn apply(&self, r: &Record, p: &Pending) -> Result<()> {
            let mut state = self.native.lock().unwrap();
            ensure!(
                state.applied.insert(p.operation_id.clone()),
                "Synthetic mutation was resent."
            );
            state.applications += 1;
            let applied_id = if r.extra.get("contextReset") == Some(&json!(true)) {
                let id = Uuid::new_v4().to_string();
                state.reset_ids.insert(p.operation_id.clone(), id.clone());
                id
            } else {
                r.native_id.clone()
            };
            state.histories.insert(applied_id, p.common.clone());
            state.maintenance.remove(&r.native_id);
            if let Some(id) = state.mutate_after_apply.take() {
                extend(
                    state.histories.get_mut(&id).unwrap(),
                    "unexpected destination",
                );
            }
            if std::mem::take(&mut state.fail_after_apply) {
                bail!("Synthetic transport ended after native application.")
            }
            Ok(())
        }
        async fn hide(&self, r: &Record) -> Result<Map<String, Value>> {
            self.native.lock().unwrap().hidden.push(r.native_id.clone());
            Ok(Map::new())
        }
        async fn remove(&self, r: &Record) -> Result<()> {
            let mut s = self.native.lock().unwrap();
            s.removed.push(r.native_id.clone());
            s.histories.remove(&r.native_id);
            Ok(())
        }
        async fn exists(&self, r: &Record) -> Result<bool> {
            Ok(self
                .native
                .lock()
                .unwrap()
                .histories
                .contains_key(&r.native_id))
        }
        async fn assert_can_archive_original(&self, r: &Record) -> Result<()> {
            ensure!(
                !self
                    .native
                    .lock()
                    .unwrap()
                    .closed_tails
                    .contains_key(&r.native_id),
                "Native retirement history changed."
            );
            Ok(())
        }
        async fn preserve_closed_tail(&self, r: &Record) -> Result<Value> {
            let s = self.native.lock().unwrap();
            ensure!(
                r.side == Side::Codex
                    && !r.managed
                    && r.status == "current"
                    && r.checkpoint.exact(&s.histories[&r.native_id])?,
                "Invalid preserved original."
            );
            s.closed_tails
                .get(&r.native_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("No closed tail."))
        }
        async fn inspect_preserved_closed_tail(&self, r: &Record) -> Result<Reading> {
            let d = self.inspect(r).await?;
            ensure!(
                self.native.lock().unwrap().closed_tails.get(&r.native_id)
                    == r.extra.get("preservedClosedTail")
                    && d.incomplete_tail
                    && r.checkpoint.exact(&d.common)?,
                "Preserved original tail changed."
            );
            Ok(d)
        }
        async fn archive_original(&self, r: &Record) -> Result<Map<String, Value>> {
            self.hide(r).await
        }
        async fn working_directory_absent(&self, _cwd: &str) -> Result<bool> {
            Ok(self.native.lock().unwrap().missing_cwd)
        }
        async fn assert_archive_replacement(
            &self,
            _original: &Record,
            _replacement: &Record,
            _title: &str,
        ) -> Result<()> {
            Ok(())
        }
        async fn prepare_original_archive_tree(&self, r: &Record) -> Result<Value> {
            Ok(
                json!({"version":1,"parentId":r.native_id,"members":[{"id":r.native_id,"disposition":"archive"}]}),
            )
        }
        async fn archive_original_tree(
            &self,
            r: &Record,
            proof: &Value,
            allow_write: bool,
            dispatch: &dyn ArchiveDispatch,
        ) -> Result<Map<String, Value>> {
            let done = self.native.lock().unwrap().archive_tree_done;
            if !done {
                ensure!(
                    allow_write,
                    "Original archive outcome is unknown; no request repeated."
                );
                dispatch.before_dispatch().await?;
                let mut state = self.native.lock().unwrap();
                state.archive_writes += 1;
                if !state.archive_no_outcome {
                    state.archive_tree_done = true;
                }
                if std::mem::take(&mut state.fail_after_archive) {
                    bail!("Synthetic archive transport lost its reply.");
                }
            }
            Ok(json!({"path":r.path,"archivedTree":proof})
                .as_object()
                .unwrap()
                .clone())
        }
    }
    fn history() -> Common {
        Common {
            meta: Map::from_iter([("cwd".into(), json!("/synthetic-project"))]),
            messages: vec![
                Message::text("user", "first"),
                Message::text("assistant", "first answer"),
            ],
            extra: Map::new(),
        }
    }
    fn extend(common: &mut Common, text: &str) {
        common.messages.extend([
            Message::text("user", text),
            Message::text("assistant", format!("answer: {text}")),
        ]);
    }
    fn fixture() -> (tempfile::TempDir, DesktopBridge, Arc<Mutex<Native>>, Record) {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let native = Arc::new(Mutex::new(Native::default()));
        let adapters = [Side::Codex, Side::Claude]
            .into_iter()
            .map(|side| {
                (
                    side,
                    Arc::new(Mock {
                        side,
                        native: native.clone(),
                    }) as Arc<dyn Adapter>,
                )
            })
            .collect();
        let source = Record::source(
            Side::Codex,
            Path::new("/synthetic-original"),
            &Uuid::new_v4().to_string(),
        );
        native
            .lock()
            .unwrap()
            .histories
            .insert(source.native_id.clone(), history());
        (tmp, DesktopBridge::new(root, adapters), native, source)
    }
    async fn edited_fixture() -> Result<(
        tempfile::TempDir,
        DesktopBridge,
        Arc<Mutex<Native>>,
        String,
        Pending,
        Checkpoint,
    )> {
        let (tmp, bridge, native, source) = fixture();
        let mut old = native.lock().unwrap().histories[&source.native_id].clone();
        extend(&mut old, "removed request");
        native
            .lock()
            .unwrap()
            .histories
            .insert(source.native_id.clone(), old.clone());
        let id = bridge.track(source, Some("Saved logical title")).await?["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut state = bridge.status()?;
        let source = state.records[0].clone();
        let mut target = Record::source(
            Side::Claude,
            Path::new("/synthetic-target"),
            &Uuid::new_v4().to_string(),
        );
        target.conversation_id = id.clone();
        target.cwd = source.cwd.clone();
        target.managed = true;
        target.kind = "owner".into();
        let pending = Pending {
            phase: Phase::Prepared,
            operation_id: Uuid::new_v4().to_string(),
            record: target,
            source_id: source.id,
            target_id: None,
            archive_original_id: None,
            reuse: false,
            common: old,
            checkpoint: source.checkpoint,
            previous: Checkpoint::empty(),
            extra: Map::new(),
        };
        state.pending = Some(pending.clone().into());
        bridge.save(&mut state, None)?;
        let mut n = native.lock().unwrap();
        n.histories
            .get_mut(&source.native_id)
            .unwrap()
            .messages
            .truncate(2);
        let expected = Checkpoint::of(&n.histories[&source.native_id])?;
        drop(n);
        Ok((tmp, bridge, native, id, pending, expected))
    }
    #[tokio::test]
    async fn edited_source_resolution_preserves_full_old_history_and_is_restart_idempotent()
    -> Result<()> {
        let (_tmp, bridge, native, id, pending, expected) = edited_fixture().await?;
        let source = bridge.status()?.records[0].clone();
        let preview = bridge
            .resolve_edited_source(&id, &source.native_id, &pending.operation_id, None)
            .await?;
        assert_eq!(preview["checkpoint"]["count"], 2);
        assert!(bridge.status()?.pending.is_some());
        assert!(!bridge.root.join("edited-source-resolutions").exists());
        let result = bridge
            .resolve_edited_source(
                &id,
                &source.native_id,
                &pending.operation_id,
                Some(expected.clone()),
            )
            .await?;
        assert_eq!(result["resolved"], true);
        let path = PathBuf::from(result["receipt"].as_str().unwrap());
        let backup = storage::read_stable(&path)?;
        let receipt: Value = serde_json::from_slice(&backup.bytes)?;
        assert_eq!(receipt["pending"], serde_json::to_value(&pending)?);
        assert_eq!(receipt["source"], serde_json::to_value(&source)?);
        assert_eq!(
            receipt["pending"]["common"]["messages"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        let state = bridge.status()?;
        assert!(state.pending.is_none());
        assert_eq!(state.conversations[&id].canonical, expected);
        assert_eq!(state.conversations[&id].title, "Saved logical title");
        assert_eq!(
            state.records[0].extra["editedSourceResolution"],
            pending.operation_id
        );
        let restarted = DesktopBridge::new(bridge.root.clone(), bridge.adapters.clone());
        assert_eq!(
            restarted
                .resolve_edited_source(
                    &id,
                    &source.native_id,
                    &pending.operation_id,
                    Some(expected)
                )
                .await?["changed"],
            false
        );
        assert_eq!(storage::read_stable(path)?.bytes, backup.bytes);
        assert_eq!(native.lock().unwrap().applications, 0);
        Ok(())
    }
    #[tokio::test]
    async fn edited_source_resolution_rejects_mismatched_selection_and_unsafe_plans() -> Result<()>
    {
        for failure in [
            "operation",
            "native",
            "expected",
            "sourceCheckpoint",
            "canonical",
            "counterpart",
            "applied",
            "uncertain",
            "notPrefix",
            "reuse",
            "phase",
        ] {
            let (_tmp, bridge, native, id, pending, expected) = edited_fixture().await?;
            let mut state = bridge.status()?;
            let mut source = state.records[0].clone();
            let mut operation = pending.operation_id.clone();
            let mut selected = expected.clone();
            match failure {
                "operation" => operation = Uuid::new_v4().to_string(),
                "native" => source.native_id = Uuid::new_v4().to_string(),
                "expected" => selected.digest = Some("f".repeat(64)),
                "sourceCheckpoint" => state.records[0].checkpoint = expected,
                "canonical" => state.conversations.get_mut(&id).unwrap().canonical = expected,
                "counterpart" => state.records.push(pending.record.clone()),
                "applied" => {
                    native
                        .lock()
                        .unwrap()
                        .histories
                        .insert(pending.record.native_id.clone(), pending.common.clone());
                }
                "uncertain" => native.lock().unwrap().refuse_unapplied = true,
                "notPrefix" => {
                    native
                        .lock()
                        .unwrap()
                        .histories
                        .get_mut(&source.native_id)
                        .unwrap()
                        .messages[0] = Message::text("user", "edited first message")
                }
                "reuse" => {
                    let Some(PendingOperation::Handoff(p)) = &mut state.pending else {
                        panic!()
                    };
                    p.reuse = true;
                }
                "phase" => {
                    let Some(PendingOperation::Handoff(p)) = &mut state.pending else {
                        panic!()
                    };
                    p.phase = Phase::Applied;
                }
                _ => unreachable!(),
            }
            bridge.save(&mut state, None)?;
            let before = storage::read_stable(bridge.root.join("desktop-state.json"))?.bytes;
            assert!(
                bridge
                    .resolve_edited_source(&id, &source.native_id, &operation, Some(selected))
                    .await
                    .is_err(),
                "{failure}"
            );
            assert_eq!(
                storage::read_stable(bridge.root.join("desktop-state.json"))?.bytes,
                before,
                "{failure}"
            );
            assert!(
                !bridge.root.join("edited-source-resolutions").exists(),
                "{failure}"
            );
            assert_eq!(native.lock().unwrap().applications, 0);
        }
        Ok(())
    }
    #[tokio::test]
    async fn edited_source_resolution_recovers_backup_before_ledger_and_refuses_changed_raw_proof()
    -> Result<()> {
        let (_tmp, bridge, native, id, pending, expected) = edited_fixture().await?;
        let source = bridge.status()?.records[0].clone();
        let old_ledger = storage::read_stable(bridge.root.join("desktop-state.json"))?.bytes;
        bridge
            .resolve_edited_source(
                &id,
                &source.native_id,
                &pending.operation_id,
                Some(expected.clone()),
            )
            .await?;
        // Simulate termination after exclusive receipt publication but before ledger publication.
        storage::atomic_write(bridge.root.join("desktop-state.json"), &old_ledger)?;
        let restarted = DesktopBridge::new(bridge.root.clone(), bridge.adapters.clone());
        assert_eq!(
            restarted
                .resolve_edited_source(
                    &id,
                    &source.native_id,
                    &pending.operation_id,
                    Some(expected.clone())
                )
                .await?["changed"],
            true
        );
        storage::atomic_write(bridge.root.join("desktop-state.json"), &old_ledger)?;
        native.lock().unwrap().change_edited_proof = true;
        let restarted = DesktopBridge::new(bridge.root.clone(), bridge.adapters.clone());
        assert!(
            restarted
                .resolve_edited_source(
                    &id,
                    &source.native_id,
                    &pending.operation_id,
                    Some(expected)
                )
                .await
                .is_err()
        );
        assert_eq!(
            storage::read_stable(bridge.root.join("desktop-state.json"))?.bytes,
            old_ledger
        );
        Ok(())
    }
    fn move_source(native: &Arc<Mutex<Native>>, record: &Record) -> Relocation {
        let mut n = native.lock().unwrap();
        let mut moved = record.clone();
        moved.cwd = "/synthetic-moved".into();
        moved.path = "/synthetic-relocated.jsonl".into();
        moved
            .extra
            .insert("relocation".into(), json!({"version":1}));
        let history = n.histories.get_mut(&record.native_id).unwrap();
        history.meta.insert("cwd".into(), json!(moved.cwd));
        let relocation = Relocation {
            record: moved.clone(),
            reading: Reading {
                common: history.clone(),
                native_id: record.native_id.clone(),
                path: moved.path,
                bytes: 10,
                incomplete_tail: false,
                extra: Map::new(),
            },
            proof: json!({"proof":"stable"}),
        };
        n.relocations
            .insert(record.native_id.clone(), relocation.clone());
        relocation
    }
    #[tokio::test]
    async fn reverse_sync_preserves_closed_original_tail_across_recovery() -> Result<()> {
        for lost_reply in [false, true] {
            let (_tmp, bridge, native, source) = fixture();
            let original_id = source.native_id.clone();
            native.lock().unwrap().closed_tails.insert(
                original_id.clone(),
                json!({"raw":"original interrupted tail"}),
            );
            let id = bridge.track(source, None).await?["conversationId"]
                .as_str()
                .unwrap()
                .to_owned();
            bridge.sync(&id).await?;
            let state = bridge.status()?;
            let claude = bridge.current(&state, &id, Side::Claude).unwrap();
            {
                let mut n = native.lock().unwrap();
                extend(
                    n.histories.get_mut(&claude.native_id).unwrap(),
                    "Claude continuation",
                );
                n.fail_after_apply = lost_reply;
            }
            if lost_reply {
                assert!(bridge.sync(&id).await.is_err());
                let s = bridge.status()?;
                let PendingOperation::Handoff(p) = s.pending.unwrap() else {
                    panic!()
                };
                assert!(p.archive_original_id.is_none());
                assert_eq!(p.phase, Phase::Prepared);
                // A new bridge simulates a restart, with no in-memory proof cache.
                let restarted = DesktopBridge::new(bridge.root.clone(), bridge.adapters.clone());
                restarted.recover().await?;
            } else {
                bridge.sync(&id).await?;
            }
            let s = bridge.status()?;
            assert!(s.pending.is_none());
            let original = s
                .records
                .iter()
                .find(|r| r.native_id == original_id)
                .unwrap();
            assert_eq!(original.status, "original");
            assert!(original.extra.contains_key("preservedClosedTail"));
            assert!(!original.extra.contains_key("archivedAt"));
            assert!(!native.lock().unwrap().hidden.contains(&original_id));
            assert_eq!(native.lock().unwrap().applications, 2);
            assert_eq!(bridge.sync(&id).await?["changed"], false);
            // Even a change only in the excluded raw tail must stop synchronization.
            native.lock().unwrap().closed_tails.insert(
                original_id.clone(),
                json!({"raw":"changed interrupted tail"}),
            );
            assert!(
                bridge
                    .sync(&id)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("tail changed")
            );
            assert_eq!(native.lock().unwrap().applications, 2);
        }
        Ok(())
    }
    #[tokio::test]
    async fn preserved_closed_tail_change_after_apply_keeps_pending_without_replay() -> Result<()> {
        let (_tmp, bridge, native, source) = fixture();
        let original = source.native_id.clone();
        native
            .lock()
            .unwrap()
            .closed_tails
            .insert(original.clone(), json!({"raw":"closed"}));
        let id = bridge.track(source, None).await?["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.sync(&id).await?;
        let s = bridge.status()?;
        let claude = bridge.current(&s, &id, Side::Claude).unwrap();
        {
            let mut n = native.lock().unwrap();
            extend(n.histories.get_mut(&claude.native_id).unwrap(), "reverse");
            n.fail_after_apply = true;
        }
        assert!(bridge.sync(&id).await.is_err());
        native
            .lock()
            .unwrap()
            .closed_tails
            .insert(original.clone(), json!({"raw":"changed"}));
        assert!(bridge.recover().await.is_err());
        assert!(bridge.status()?.pending.is_some());
        assert_eq!(native.lock().unwrap().applications, 2);
        assert!(!native.lock().unwrap().hidden.contains(&original));
        Ok(())
    }
    #[tokio::test]
    async fn context_reset_promotes_new_native_identity_and_recovers_without_resend() -> Result<()>
    {
        for lost in [false, true] {
            let (_tmp, bridge, native, source) = fixture();
            let id = bridge.track(source, None).await?["conversationId"]
                .as_str()
                .unwrap()
                .to_owned();
            bridge.sync(&id).await?;
            let before = bridge.status()?;
            let old = bridge.current(&before, &id, Side::Claude).unwrap().clone();
            native
                .lock()
                .unwrap()
                .maintenance
                .insert(old.native_id.clone(), "reset".into());
            if lost {
                native.lock().unwrap().fail_after_apply = true;
            } else {
                native.lock().unwrap().fail_resolved_inspection = true;
            }
            assert!(bridge.sync(&id).await.is_err());
            let state = bridge.status()?;
            let PendingOperation::Handoff(p) = state.pending.as_ref().unwrap() else {
                panic!()
            };
            assert!(p.reuse);
            assert_eq!(p.record.id, old.id);
            assert_eq!(p.previous, Checkpoint::empty());
            assert_eq!(p.record.extra["contextReset"], true);
            if !lost {
                assert_ne!(p.record.native_id, old.native_id);
            }
            let count = native.lock().unwrap().applications;
            bridge.recover().await?;
            assert_eq!(native.lock().unwrap().applications, count);
            let after = bridge.status()?;
            let current = bridge.current(&after, &id, Side::Claude).unwrap();
            assert_ne!(current.native_id, old.native_id);
            assert_eq!(current.id, old.id);
            assert_eq!(
                after.conversations[&id].canonical,
                before.conversations[&id].canonical
            );
            assert_eq!(
                native.lock().unwrap().promotions.last(),
                Some(&current.native_id)
            );
            assert!(
                native
                    .lock()
                    .unwrap()
                    .histories
                    .contains_key(&old.native_id)
            );
            assert_eq!(bridge.sync(&id).await?["changed"], false);
        }
        Ok(())
    }
    #[test]
    fn committed_image_origins_exclude_uncommitted_requests() {
        let extra=json!({"localImageRollouts":[{"path":"retained","requests":[{"messageIndex":0},{"messageIndex":4}]},{"path":"new","requests":[{"messageIndex":5}]}]}).as_object().unwrap().clone();
        let filtered = committed_extra(extra, 4);
        assert_eq!(
            filtered["localImageRollouts"],
            json!([{"path":"retained","requests":[{"messageIndex":0}]}])
        );
    }
    #[tokio::test]
    async fn codex_move_replaces_owner_without_new_message_and_recovers_without_resend() {
        let (_tmp, bridge, native, source) = fixture();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.sync(&id).await.unwrap();
        let state = bridge.status().unwrap();
        let source = bridge.current(&state, &id, Side::Codex).unwrap().clone();
        let old = bridge
            .current(&state, &id, Side::Claude)
            .unwrap()
            .native_id
            .clone();
        move_source(&native, &source);
        native.lock().unwrap().fail_after_apply = true;
        assert!(bridge.sync(&id).await.is_err());
        let pending = bridge.status().unwrap();
        let PendingOperation::Handoff(p) = pending.pending.unwrap() else {
            panic!()
        };
        assert_eq!(p.extra["relocation"], true);
        assert_ne!(p.record.native_id, old);
        let applications = native.lock().unwrap().applications;
        bridge.recover().await.unwrap();
        assert_eq!(native.lock().unwrap().applications, applications);
        let state = bridge.status().unwrap();
        assert_eq!(state.conversations[&id].cwd, "/synthetic-moved");
        assert_eq!(
            state
                .records
                .iter()
                .find(|r| r.native_id == old)
                .unwrap()
                .status,
            "retired-owner"
        );
        assert!(!native.lock().unwrap().hidden.contains(&old));
        assert_eq!(bridge.sync(&id).await.unwrap()["changed"], false);
    }
    #[tokio::test]
    async fn relocation_rejects_changed_counterpart_and_unstable_source_before_commit() {
        for unstable in [false, true] {
            let (_tmp, bridge, native, source) = fixture();
            let id = bridge.track(source, None).await.unwrap()["conversationId"]
                .as_str()
                .unwrap()
                .to_owned();
            bridge.sync(&id).await.unwrap();
            let state = bridge.status().unwrap();
            let source = bridge.current(&state, &id, Side::Codex).unwrap().clone();
            move_source(&native, &source);
            if unstable {
                native.lock().unwrap().unstable_relocation = true;
            } else {
                let owner = bridge.current(&state, &id, Side::Claude).unwrap();
                extend(
                    native
                        .lock()
                        .unwrap()
                        .histories
                        .get_mut(&owner.native_id)
                        .unwrap(),
                    "independent",
                );
            }
            assert!(bridge.sync(&id).await.is_err());
            let after = bridge.status().unwrap();
            assert_eq!(after.conversations[&id].cwd, "/synthetic-project");
            assert!(after.pending.is_none());
            assert_eq!(native.lock().unwrap().applications, 1);
        }
    }
    #[tokio::test]
    async fn stable_owner_bounded_snapshots_and_no_duplicate_imports() {
        let (_tmp, bridge, native, source) = fixture();
        let original = source.native_id.clone();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(bridge.sync(&id).await.unwrap()["side"], "claude");
        let first = bridge.status().unwrap();
        let owner = bridge
            .current(&first, &id, Side::Claude)
            .unwrap()
            .native_id
            .clone();
        assert_eq!(bridge.sync(&id).await.unwrap()["changed"], false);
        extend(
            native.lock().unwrap().histories.get_mut(&owner).unwrap(),
            "owner advance",
        );
        bridge.sync(&id).await.unwrap();
        let second = bridge.status().unwrap();
        let snapshot = bridge
            .current(&second, &id, Side::Codex)
            .unwrap()
            .native_id
            .clone();
        assert_ne!(snapshot, original);
        assert!(native.lock().unwrap().hidden.contains(&original));
        extend(
            native.lock().unwrap().histories.get_mut(&snapshot).unwrap(),
            "codex advance",
        );
        bridge.sync(&id).await.unwrap();
        let third = bridge.status().unwrap();
        assert_eq!(
            bridge.current(&third, &id, Side::Claude).unwrap().native_id,
            owner
        );
        assert_eq!(third.conversations[&id].canonical.count, 6);
        assert_eq!(native.lock().unwrap().applications, 3);
        assert!(third.pending.is_none());
        // Checkpoints saved before dialogue digests existed gain them from the
        // next exact read, without a new write.
        let mut legacy = third.clone();
        legacy
            .conversations
            .get_mut(&id)
            .unwrap()
            .canonical
            .dialogue = None;
        legacy
            .records
            .iter_mut()
            .for_each(|r| r.checkpoint.dialogue = None);
        bridge.save(&mut legacy, None).unwrap();
        assert_eq!(bridge.sync(&id).await.unwrap()["changed"], false);
        let upgraded = bridge.status().unwrap();
        assert_eq!(
            upgraded.conversations[&id].canonical.dialogue,
            third.conversations[&id].canonical.dialogue
        );
        assert!(upgraded.conversations[&id].canonical.dialogue.is_some());
        assert!(
            upgraded
                .records
                .iter()
                .filter(|r| r.conversation_id == id && r.checkpoint.count > 0)
                .all(|r| r.checkpoint.dialogue.is_some())
        );
        assert_eq!(native.lock().unwrap().applications, 3);
        // A native release that re-projects a tool payload is not a divergence;
        // edited dialogue still is.
        let tool = |input: Value| {
            vec![
                Message::text("user", "use a tool"),
                Message {
                    role: "assistant".into(),
                    content: vec![
                        json!({"type":"tool_use","id":"call","name":"Bash","input":input}),
                    ],
                    extra: Map::new(),
                },
                Message {
                    role: "user".into(),
                    content: vec![
                        json!({"type":"tool_result","tool_use_id":"call","content":"listing"}),
                    ],
                    extra: Map::new(),
                },
                Message::text("assistant", "done"),
            ]
        };
        native
            .lock()
            .unwrap()
            .histories
            .get_mut(&owner)
            .unwrap()
            .messages
            .extend(tool(json!({"command":"ls"})));
        bridge.sync(&id).await.unwrap();
        assert_eq!(
            bridge.status().unwrap().conversations[&id].canonical.count,
            10
        );
        let mut native_now = native.lock().unwrap();
        let history = native_now.histories.get_mut(&owner).unwrap();
        history.messages.truncate(6);
        history
            .messages
            .extend(tool(json!({"command":"ls","description":null})));
        drop(native_now);
        assert_eq!(bridge.sync(&id).await.unwrap()["changed"], false);
        native
            .lock()
            .unwrap()
            .histories
            .get_mut(&owner)
            .unwrap()
            .messages[6] = Message::text("user", "edited");
        let error = bridge.sync(&id).await.unwrap_err().to_string();
        assert!(error.contains("diverged"), "{error}");
        assert_eq!(native.lock().unwrap().applications, 4);
    }
    #[tokio::test]
    async fn realtime_policy_enrolls_new_records_but_never_upgrades_existing_histories()
    -> Result<()> {
        for legacy in [false, true] {
            let (_temp, bridge, _native, source) = fixture();
            let id = bridge.track(source.clone(), None).await?["conversationId"]
                .as_str()
                .unwrap()
                .to_owned();
            let mut state = bridge.status()?;
            assert!(crate::native_realtime::enabled(
                &state.conversations[&id].extra
            )?);
            assert!(crate::native_realtime::enabled(&state.records[0].extra)?);
            if legacy {
                state
                    .conversations
                    .get_mut(&id)
                    .unwrap()
                    .extra
                    .remove(crate::native_realtime::POLICY_KEY);
                state.records[0]
                    .extra
                    .remove(crate::native_realtime::POLICY_KEY);
                bridge.save(&mut state, None)?;
            }
            assert_eq!(bridge.track(source, None).await?["existing"], true);
            bridge.sync(&id).await?;
            let state = bridge.status()?;
            assert_eq!(
                crate::native_realtime::enabled(&state.conversations[&id].extra)?,
                !legacy
            );
            assert!(state.records.len() >= 2);
            for record in &state.records {
                assert_eq!(crate::native_realtime::enabled(&record.extra)?, !legacy);
            }
        }
        Ok(())
    }
    #[tokio::test]
    async fn cold_import_pair_authenticates_both_originals_and_is_idempotent() {
        let (_temp, bridge, native, source) = fixture();
        let id = Uuid::new_v4().to_string();
        let mut target = Record::source(
            Side::Claude,
            Path::new("/synthetic-cold-import"),
            &Uuid::new_v4().to_string(),
        );
        target.conversation_id = id.clone();
        target.extra.insert("importPacket".into(), json!(true));
        target.extra.insert("packetVersion".into(), json!(2));
        native
            .lock()
            .unwrap()
            .histories
            .insert(target.native_id.clone(), history());
        assert_eq!(
            bridge
                .track_imported_pair(&id, source.clone(), target.clone(), "Imported")
                .await
                .unwrap()["existing"],
            false
        );
        let state = bridge.status().unwrap();
        assert_eq!(state.records.len(), 2);
        assert!(
            state
                .records
                .iter()
                .all(|r| !r.managed && r.kind == "original" && r.status == "current")
        );
        assert_eq!(
            state.conversations[&id].extra["discoveryMode"],
            "cold-import"
        );
        assert_eq!(
            bridge
                .track_imported_pair(&id, source, target, "Imported")
                .await
                .unwrap()["existing"],
            true
        );
        assert_eq!(native.lock().unwrap().applications, 0);
        assert_eq!(bridge.status().unwrap().records.len(), 2);
    }
    #[tokio::test]
    async fn recovery_proves_application_before_any_resend() {
        let (_tmp, bridge, native, source) = fixture();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        native.lock().unwrap().fail_after_apply = true;
        assert!(
            bridge
                .sync(&id)
                .await
                .unwrap_err()
                .to_string()
                .contains("after native application")
        );
        assert_eq!(
            *bridge.status().unwrap().pending.unwrap().phase(),
            Phase::Prepared
        );
        bridge.recover().await.unwrap();
        assert_eq!(native.lock().unwrap().applications, 1);
        assert!(bridge.status().unwrap().pending.is_none());
        assert_eq!(bridge.recover().await.unwrap()["changed"], false);
    }
    #[tokio::test]
    async fn destination_change_after_apply_preserves_pending_and_original() {
        let (_tmp, bridge, native, source) = fixture();
        let original = source.native_id.clone();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.sync(&id).await.unwrap();
        let state = bridge.status().unwrap();
        let owner = bridge
            .current(&state, &id, Side::Claude)
            .unwrap()
            .native_id
            .clone();
        {
            let mut state = native.lock().unwrap();
            extend(state.histories.get_mut(&owner).unwrap(), "owner advance");
            state.mutate_after_apply = Some(original.clone());
        }
        assert!(
            bridge
                .sync(&id)
                .await
                .unwrap_err()
                .to_string()
                .contains("Destination changed")
        );
        let state = bridge.status().unwrap();
        assert!(state.pending.is_some());
        assert_eq!(state.conversations[&id].canonical.count, 2);
        assert!(!native.lock().unwrap().hidden.contains(&original));
        assert!(bridge.recover().await.is_err());
        assert_eq!(native.lock().unwrap().applications, 2);
    }
    #[tokio::test]
    async fn stopped_tracking_freezes_collection_and_conflicting_resume() {
        let (_tmp, bridge, native, source) = fixture();
        let original = source.native_id.clone();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.sync(&id).await.unwrap();
        bridge.untrack(&id, false).await.unwrap();
        assert_eq!(bridge.sync(&id).await.unwrap()["tracking"], "stopped");
        let collection = bridge.collect().await.unwrap();
        assert_eq!(collection["frozen"], json!([id]));
        assert!(native.lock().unwrap().removed.is_empty());
        bridge.resume_tracking(&id).await.unwrap();
        bridge.untrack(&id, false).await.unwrap();
        let state = bridge.status().unwrap();
        let owner = bridge
            .current(&state, &id, Side::Claude)
            .unwrap()
            .native_id
            .clone();
        {
            let mut state = native.lock().unwrap();
            extend(state.histories.get_mut(&original).unwrap(), "left branch");
            extend(state.histories.get_mut(&owner).unwrap(), "right branch");
        }
        assert!(
            bridge
                .resume_tracking(&id)
                .await
                .unwrap_err()
                .to_string()
                .contains("Both stopped sides changed")
        );
        assert!(!bridge.status().unwrap().conversations[&id].tracked());
    }
    #[test]
    fn javascript_prepared_record_and_partial_retention_are_readable() {
        let (_tmp, _bridge, _native, record) = fixture();
        let mut value = serde_json::to_value(record).unwrap();
        value.as_object_mut().unwrap().remove("checkpoint");
        let record: Record = serde_json::from_value(value).unwrap();
        assert_eq!(record.checkpoint, Checkpoint::empty());
        let policy: Policy = serde_json::from_value(json!({"previousPerSide":2})).unwrap();
        assert_eq!(policy.previous_per_side, 2);
        assert_eq!(policy.max_age_ms, Policy::default().max_age_ms);
    }
    async fn legacy_archive_fixture() -> (
        tempfile::TempDir,
        DesktopBridge,
        Arc<Mutex<Native>>,
        String,
        String,
    ) {
        let (tmp, bridge, native, source) = fixture();
        let original = source.native_id.clone();
        let id = bridge.track(source, None).await.unwrap()["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.sync(&id).await.unwrap();
        let state = bridge.status().unwrap();
        let owner = bridge
            .current(&state, &id, Side::Claude)
            .unwrap()
            .native_id
            .clone();
        extend(
            native.lock().unwrap().histories.get_mut(&owner).unwrap(),
            "owner continuation",
        );
        bridge.sync(&id).await.unwrap();
        let mut state = bridge.status().unwrap();
        state
            .records
            .iter_mut()
            .find(|r| r.native_id == original)
            .unwrap()
            .extra
            .remove("archivedAt");
        bridge.save(&mut state, None).unwrap();
        (tmp, bridge, native, id, original)
    }
    #[tokio::test]
    async fn original_archive_journal_recovers_lost_reply_without_resending() {
        let (_tmp, bridge, native, id, original) = legacy_archive_fixture().await;
        native.lock().unwrap().fail_after_archive = true;
        assert!(bridge.archive_original(&id, &original).await.is_err());
        let state = bridge.status().unwrap();
        assert!(matches!(
            state.pending,
            Some(PendingOperation::OriginalArchive(_))
        ));
        assert_eq!(*state.pending.as_ref().unwrap().phase(), Phase::Requested);
        let journal = serde_json::to_value(state.pending.as_ref().unwrap()).unwrap();
        assert_eq!(journal["kind"], "original-archive");
        assert!(journal.get("common").is_none());
        let recovered: PendingOperation = serde_json::from_value(journal).unwrap();
        assert_eq!(*recovered.phase(), Phase::Requested);
        assert_eq!(
            bridge.abandon_unapplied().await.unwrap()["abandoned"],
            false
        );
        assert_eq!(bridge.recover().await.unwrap()["changed"], true);
        assert_eq!(native.lock().unwrap().archive_writes, 1);
        assert_eq!(
            bridge.archive_original(&id, &original).await.unwrap()["changed"],
            false
        );
    }
    #[tokio::test]
    async fn unknown_original_archive_outcome_remains_requested() {
        let (_tmp, bridge, native, id, original) = legacy_archive_fixture().await;
        {
            let mut state = native.lock().unwrap();
            state.fail_after_archive = true;
            state.archive_no_outcome = true;
        }
        assert!(bridge.archive_original(&id, &original).await.is_err());
        assert!(
            bridge
                .recover()
                .await
                .unwrap_err()
                .to_string()
                .contains("unknown")
        );
        assert_eq!(native.lock().unwrap().archive_writes, 1);
        assert_eq!(
            *bridge.status().unwrap().pending.as_ref().unwrap().phase(),
            Phase::Requested
        );
    }
}
