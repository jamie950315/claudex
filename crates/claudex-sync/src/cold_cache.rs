//! Authenticated no-op scheduling proofs. No cached value authorizes mutation,
//! retirement, a checkpoint or a managed owner's lifecycle transition.
use crate::{
    desktop::{DesktopBridge, State},
    history::{canonical, digest_json},
    native, packet,
    runtime::Runtime,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity, FileLock};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs,
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
tokio::task_local! {static CAPTURE:RefCell<Option<BTreeMap<PathBuf,FileIdentity>>>;}
pub(crate) fn asset(path: &Path, identity: &FileIdentity) {
    let _ = CAPTURE.try_with(|capture| {
        let mut capture = capture.borrow_mut();
        if let Some(files) = capture.as_mut() {
            if files.get(path).is_some_and(|old| old != identity) {
                *capture = None;
            } else {
                files.insert(path.into(), identity.clone());
            }
        }
    });
}
async fn capture<F: Future>(future: F) -> (F::Output, Option<Vec<Value>>) {
    CAPTURE
        .scope(RefCell::new(Some(BTreeMap::new())), async {
            let result = future.await;
            let files = CAPTURE.with(|capture| {
                capture.borrow().as_ref().map(|files| {
                    files
                        .iter()
                        .map(|(path, identity)| json!({"path":path,"identity":identity}))
                        .collect()
                })
            });
            (result, files)
        })
        .await
}
fn mac(payload: &Value, key: &[u8]) -> Result<String> {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|v| v ^ 0x36));
    inner.update(b"claudex-cold-verification\0");
    inner.update(canonical(payload)?);
    let mut outer = Sha256::new();
    outer.update(block.map(|v| v ^ 0x5c));
    outer.update(inner.finalize());
    Ok(hex::encode(outer.finalize()))
}
fn private_file(identity: &FileIdentity) -> bool {
    identity.uid == storage::uid().to_string()
        && identity.nlink == "1"
        && identity
            .mode
            .parse::<u32>()
            .is_ok_and(|m| m & 0o7777 == 0o600)
}
fn missing<T>(result: Result<T>) -> Result<Option<T>> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(e) if storage::is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
#[derive(Default)]
struct Health {
    state: String,
    reason: Option<String>,
    entries: Option<usize>,
    bytes: Option<u64>,
    reclaimed: usize,
    disabled: BTreeSet<String>,
    invalidated: BTreeSet<String>,
}
pub struct Cache {
    root: PathBuf,
    key: Vec<u8>,
    epoch: String,
    limits: (usize, u64),
    health: Mutex<Health>,
}
impl Cache {
    pub fn new(root: &Path, key: &[u8], epoch: &str) -> Result<Self> {
        ensure!(
            root.is_absolute() && key.len() >= 32 && !epoch.is_empty(),
            "Invalid cold cache configuration."
        );
        Ok(Self {
            root: root.into(),
            key: key.into(),
            epoch: epoch.into(),
            limits: (MAX_ENTRIES, MAX_TOTAL),
            health: Mutex::new(Health {
                state: "ready".into(),
                ..Default::default()
            }),
        })
    }
    fn dir(&self) -> PathBuf {
        self.root.join("cold-verification")
    }
    fn refuse(&self, reason: &str, state: &str) -> bool {
        let mut h = self.health.lock().unwrap();
        h.reason = Some(reason.into());
        h.state = state.into();
        false
    }
    pub fn diagnostics(&self) -> Value {
        let h = self.health.lock().unwrap();
        json!({"state":h.state,"reason":h.reason,"entries":h.entries,"bytes":h.bytes,"reclaimedEntries":h.reclaimed,"disabled":h.state=="disabled","capacityReached":h.state=="capacity","limits":{"entries":MAX_ENTRIES,"fileBytes":MAX_FILE,"totalBytes":MAX_TOTAL}})
    }
    fn directory(&self, create: bool) -> Result<FileIdentity> {
        storage::require_private_directory(&self.root)?;
        if create {
            storage::private_directory(self.dir())?;
        }
        storage::require_private_directory(self.dir())?;
        ensure!(
            fs::canonicalize(&self.root)? == self.root
                && fs::canonicalize(self.dir())? == self.dir(),
            "Unsafe cold cache directory."
        );
        Ok(FileIdentity::from_metadata(&fs::symlink_metadata(
            self.dir(),
        )?))
    }
    fn read_envelope(&self, path: &Path) -> Result<Option<(Value, FileIdentity)>> {
        let dir = self.directory(false)?;
        let raw = storage::read_stable_with_limit(path, MAX_FILE)?;
        ensure!(
            private_file(&raw.identity) && !raw.bytes.is_empty(),
            "Unsafe cold cache proof."
        );
        let envelope: Value = serde_json::from_slice(&raw.bytes)?;
        let supplied = envelope["mac"].as_str().unwrap_or("");
        if !packet::exact_keys(&envelope, &["mac", "payload"])
            || !packet::hex_digest(&envelope["mac"])
        {
            return Ok(None);
        }
        let expected = mac(&envelope["payload"], &self.key)?;
        if supplied
            .as_bytes()
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |n, (a, b)| n | (a ^ b))
            != 0
        {
            return Ok(None);
        }
        ensure!(
            self.directory(false)?.same_inode(&dir),
            "Cold cache directory changed."
        );
        Ok(Some((envelope["payload"].clone(), raw.identity)))
    }
    fn generation(&self) -> Result<Value> {
        match missing(self.read_envelope(&self.dir().join(".revocation.json")))? {
            None => Ok(Value::Null),
            Some(Some((v, _))) => {
                ensure!(
                    v["version"] == 1
                        && v["generation"]
                            .as_str()
                            .is_some_and(|s| Uuid::parse_str(s).is_ok()),
                    "Invalid cold cache revocation fence."
                );
                Ok(v["generation"].clone())
            }
            _ => anyhow::bail!("Invalid cold cache revocation fence."),
        }
    }
    fn read(&self, id: &str) -> Result<Option<Value>> {
        if Uuid::parse_str(id).is_err() || self.health.lock().unwrap().disabled.contains(id) {
            return Ok(None);
        }
        let generation = self.generation()?;
        let entry = missing(self.read_envelope(&self.dir().join(format!("{id}.json"))))?
            .flatten()
            .map(|v| v.0);
        Ok(entry.filter(|v| {
            v["version"] == 1
                && v["epoch"] == self.epoch
                && v["id"] == id
                && v["cacheGeneration"] == generation
                && self.generation().ok().as_ref() == Some(&generation)
        }))
    }
    fn asset_directory(&self) -> Result<Value> {
        let path = self.root.join("history-assets");
        storage::require_private_directory(&path)?;
        ensure!(
            fs::canonicalize(&path)? == path,
            "Aliased archive directory."
        );
        let i = FileIdentity::from_metadata(&fs::symlink_metadata(&path)?);
        Ok(json!({"path":path,"dev":i.dev,"ino":i.ino,"uid":i.uid,"mode":i.mode}))
    }
    fn files(&self, files: &Value, directory: &Value) -> Result<bool> {
        if &self.asset_directory()? != directory {
            return Ok(false);
        }
        let Some(files) = files.as_array().filter(|a| a.len() <= 65536) else {
            return Ok(false);
        };
        let mut names = BTreeSet::new();
        for file in files {
            let Some(path) = file["path"].as_str() else {
                return Ok(false);
            };
            let p = Path::new(path);
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                return Ok(false);
            };
            if p.parent() != Some(self.root.join("history-assets").as_path())
                || !packet::hex_digest(&json!(name))
                || !names.insert(path)
            {
                return Ok(false);
            }
            let i = FileIdentity::from_metadata(&fs::symlink_metadata(p)?);
            if !private_file(&i)
                || serde_json::to_value(&i)? != file["identity"]
                || fs::canonicalize(p)? != p
            {
                return Ok(false);
            }
        }
        Ok(self.asset_directory()? == *directory)
    }
    pub fn load(&self, id: &str, signature: &Value, context: &Value) -> Option<Value> {
        let result = (|| -> Result<Option<Value>> {
            let Some(v) = self.read(id)? else {
                return Ok(None);
            };
            if v["invalidated"] == true
                || v["signature"] != digest_json(signature)?
                || v["contextHash"] != digest_json(context)?
                || !v["verifiedAt"]
                    .as_u64()
                    .is_some_and(|t| t <= storage::now_ms().max(0) as u64)
                || !self.files(&v["files"], &v["assetDirectory"])?
            {
                return Ok(None);
            }
            if self.read(id)? != Some(v.clone()) {
                return Ok(None);
            }
            Ok(Some(v))
        })();
        match result {
            Ok(v) => v,
            Err(e) => {
                if !storage::is_not_found(&e) {
                    self.refuse("storage-unavailable", "disabled");
                }
                None
            }
        }
    }
    fn inventory(&self) -> Result<Option<(u64, Vec<(PathBuf, FileIdentity)>)>> {
        let mut files = vec![];
        let mut bytes = 0;
        for (index, entry) in fs::read_dir(self.dir())?.enumerate() {
            let entry = entry?;
            if index > MAX_ENTRIES {
                self.refuse("entry-capacity", "capacity");
                return Ok(None);
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            ensure!(
                name == ".revocation.json"
                    || name
                        .strip_suffix(".json")
                        .is_some_and(|n| Uuid::parse_str(n).is_ok()),
                "Unexpected cold cache storage."
            );
            let i = FileIdentity::from_metadata(&fs::symlink_metadata(entry.path())?);
            ensure!(private_file(&i), "Unsafe cold cache inventory.");
            bytes += i.size.parse::<u64>()?;
            if name != ".revocation.json" {
                files.push((entry.path(), i));
            }
        }
        let mut h = self.health.lock().unwrap();
        h.entries = Some(files.len());
        h.bytes = Some(bytes);
        Ok(Some((bytes, files)))
    }
    fn publish(&self, name: &str, payload: &Value, dir: &FileIdentity) -> Result<bool> {
        ensure!(
            self.directory(false)?.same_inode(dir),
            "Cold cache directory changed."
        );
        storage::atomic_write(
            self.dir().join(name),
            canonical(&json!({"payload":payload,"mac":mac(payload,&self.key)?}))?,
        )?;
        ensure!(
            self.directory(false)?.same_inode(dir),
            "Cold cache directory changed."
        );
        Ok(true)
    }
    fn write(&self, id: &str, payload: Value) -> Result<bool> {
        ensure!(Uuid::parse_str(id).is_ok(), "Invalid cold proof identity.");
        let dir = self.directory(true)?;
        let _lock = FileLock::acquire(&self.root.join("cold-verification.lock"), true)?;
        let mut generation = self.generation()?;
        let mut value = payload.clone();
        if !generation.is_null() {
            value["cacheGeneration"] = generation.clone();
        }
        let size = |v: &Value| -> Result<u64> {
            Ok(canonical(&json!({"payload":v,"mac":mac(v,&self.key)?}))?.len() as u64)
        };
        if size(&value)? > MAX_FILE as u64 {
            return Ok(self.refuse("file-capacity", "capacity"));
        }
        let Some((mut bytes, mut files)) = self.inventory()? else {
            return Ok(false);
        };
        let fits = |bytes: u64, files: &[(PathBuf, FileIdentity)], size: u64| {
            let old = files
                .iter()
                .find(|(p, _)| p == &self.dir().join(format!("{id}.json")));
            files.len() + usize::from(old.is_none()) <= self.limits.0
                && bytes
                    - old
                        .and_then(|(_, i)| i.size.parse::<u64>().ok())
                        .unwrap_or(0)
                    + size
                    <= self.limits.1
        };
        if !fits(bytes, &files, size(&value)?) {
            let mut revoked = vec![];
            let mut fence = false;
            for (path, identity) in &files {
                if let Some((p, i)) = self.read_envelope(path)? {
                    let file_id = path.file_stem().unwrap().to_string_lossy();
                    let current = p["cacheGeneration"] == generation;
                    if i == *identity
                        && p["version"] == 1
                        && p["epoch"] == self.epoch
                        && p["id"] == file_id.as_ref()
                        && (p["invalidated"] == true || !current)
                    {
                        revoked.push((path.clone(), i));
                        fence |= current;
                    }
                }
            }
            if revoked.is_empty() {
                return Ok(self.refuse(
                    if files.len() >= MAX_ENTRIES {
                        "entry-capacity"
                    } else {
                        "byte-capacity"
                    },
                    "capacity",
                ));
            }
            if fence {
                generation = json!(Uuid::new_v4().to_string());
                self.publish(
                    ".revocation.json",
                    &json!({"version":1,"generation":generation}),
                    &dir,
                )?;
            }
            for (path, identity) in revoked {
                ensure!(
                    self.directory(false)?.same_inode(&dir)
                        && FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == identity,
                    "Cold proof changed before reclamation."
                );
                fs::remove_file(path)?;
                self.health.lock().unwrap().reclaimed += 1;
            }
            fs::File::open(self.dir())?.sync_all()?;
            value = payload;
            value["cacheGeneration"] = generation.clone();
            let Some(inventory) = self.inventory()? else {
                return Ok(false);
            };
            (bytes, files) = inventory;
            if !fits(bytes, &files, size(&value)?) {
                return Ok(self.refuse("byte-capacity", "capacity"));
            }
        }
        ensure!(
            self.generation()? == generation,
            "Cold cache revocation changed."
        );
        self.publish(&format!("{id}.json"), &value, &dir)?;
        self.inventory()?;
        let mut h = self.health.lock().unwrap();
        h.state = "ready".into();
        h.reason = None;
        Ok(true)
    }
    pub fn store(&self, id: &str, signature: &Value, context: &Value, files: Vec<Value>) -> bool {
        let result = (|| -> Result<bool> {
            let directory = self.asset_directory()?;
            let files = json!(files);
            ensure!(self.files(&files, &directory)?, "Archive proof changed.");
            let payload = json!({"version":1,"epoch":self.epoch,"id":id,"signature":digest_json(signature)?,"contextHash":digest_json(context)?,"verifiedAt":storage::now_ms(),"assetDirectory":directory,"files":files});
            if !self.write(id, payload)? {
                return Ok(false);
            }
            let mut h = self.health.lock().unwrap();
            h.disabled.remove(id);
            h.invalidated.remove(id);
            Ok(true)
        })();
        result.unwrap_or_else(|_| self.refuse("storage-unavailable", "disabled"))
    }
    pub fn invalidate(&self, id: &str) -> bool {
        let mut h = self.health.lock().unwrap();
        h.disabled.insert(id.into());
        if h.invalidated.contains(id) {
            return true;
        }
        drop(h);
        match self.write(
            id,
            json!({"version":1,"epoch":self.epoch,"id":id,"invalidated":true}),
        ) {
            Ok(true) => {
                self.health.lock().unwrap().invalidated.insert(id.into());
                true
            }
            _ => self.refuse("revocation-unavailable", "disabled"),
        }
    }
}
fn records<'a>(state: &'a State, id: &str) -> Option<Vec<&'a crate::desktop::Record>> {
    if state.pending.is_some()
        || state.conversations.get(id)?.extra.get("discoveryMode") != Some(&json!("cold-import"))
    {
        return None;
    }
    let records = state
        .records
        .iter()
        .filter(|r| r.conversation_id == id)
        .collect::<Vec<_>>();
    if records.is_empty()
        || records.iter().any(|r| {
            r.side == crate::bridge::Side::Claude
                && r.managed
                && r.kind == "owner"
                && r.status == "current"
        })
    {
        None
    } else {
        Some(records)
    }
}
fn hint(state: &State, id: &str) -> Result<Option<Value>> {
    let Some(records) = records(state, id) else {
        return Ok(None);
    };
    let mut files = vec![];
    for r in &records {
        let path = if r.side == crate::bridge::Side::Codex {
            native::physical_rollout(&r.path)?
        } else {
            r.path.clone()
        };
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        if !meta.is_file() || meta.file_type().is_symlink() || fs::canonicalize(&path)? != path {
            return Ok(None);
        }
        files.push(json!([path, FileIdentity::from_metadata(&meta)]));
    }
    Ok(Some(
        json!({"conversation":state.conversations[id],"records":records,"files":files}),
    ))
}
fn persistent(state: &State, id: &str) -> bool {
    let Some(records) = records(state, id) else {
        return false;
    };
    let checkpoint = &state.conversations[id].canonical;
    records.len() == 2
        && checkpoint.count > 0
        && checkpoint.digest.is_some()
        && records.iter().all(|r| {
            r.status == "current"
                && !r.managed
                && r.kind == "original"
                && r.verified
                && r.checkpoint == *checkpoint
                && !r.extra.contains_key("relocation")
                && !r.extra.contains_key("localImageRollouts")
        })
        && records
            .iter()
            .filter(|r| r.side == crate::bridge::Side::Codex)
            .count()
            == 1
        && records.iter().any(|r| {
            r.side == crate::bridge::Side::Claude
                && r.extra.get("importPacket") == Some(&json!(true))
                && r.extra.get("packetVersion") == Some(&json!(2))
        })
}
async fn inactive(runtime: &Runtime, state: &State, id: &str) -> Result<Option<Value>> {
    let Some(records) = records(state, id) else {
        return Ok(None);
    };
    let client = runtime.client().await?;
    let mut identities = vec![];
    for r in records
        .into_iter()
        .filter(|r| r.side == crate::bridge::Side::Codex)
    {
        let answer = client
            .request(
                "thread/read",
                json!({"threadId":r.native_id,"includeTurns":false}),
            )
            .await?;
        let t = &answer["thread"];
        ensure!(t["id"] == r.native_id, "Codex cold identity changed.");
        if !matches!(t["status"]["type"].as_str(), Some("idle" | "notLoaded")) {
            return Ok(None);
        }
        let Some(path) = t["path"].as_str() else {
            return Ok(None);
        };
        let Some(cwd) = t["cwd"].as_str() else {
            return Ok(None);
        };
        let resolved = match (
            native::physical_rollout(Path::new(path)),
            fs::canonicalize(cwd),
        ) {
            (Ok(p), Ok(c)) => (p, c),
            (Err(e), _) if storage::is_not_found(&e) => return Ok(None),
            (_, Err(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(None);
            }
            (Err(e), _) => return Err(e),
            (_, Err(e)) => return Err(e.into()),
        };
        if path != r.path.to_string_lossy()
            || resolved.1 != Path::new(&r.cwd)
            || fs::canonicalize(&resolved.0)? != resolved.0
        {
            return Ok(None);
        }
        identities.push(json!({"nativeId":r.native_id,"path":path,"cwd":cwd,"inactive":true,"updatedAt":t["updatedAt"]}));
    }
    Ok(Some(json!(identities)))
}
pub struct Scheduler {
    pub cache: Arc<Cache>,
    context: Value,
    hints: Mutex<BTreeMap<String, (Value, i64)>>,
    attempts: Mutex<BTreeMap<String, i64>>,
}
impl Scheduler {
    pub fn new(root: &Path, key: &[u8], context: Value) -> Result<Self> {
        Ok(Self {
            cache: Arc::new(Cache::new(root, key, "cold-verification-v1")?),
            context,
            hints: Mutex::new(BTreeMap::new()),
            attempts: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn due(&self, state: &State) -> Option<String> {
        let hints = self.hints.lock().unwrap();
        let attempts = self.attempts.lock().unwrap();
        let now = storage::now_ms();
        state
            .conversations
            .iter()
            .filter(|(id, c)| c.tracked() && records(state, id).is_some() && !persistent(state, id))
            .map(|(id, _)| {
                (
                    id,
                    hints
                        .get(id)
                        .map(|(_, at)| *at)
                        .or_else(|| attempts.get(id).copied())
                        .unwrap_or(0),
                )
            })
            .filter(|(_, at)| now.saturating_sub(*at) >= 60_000)
            .min_by_key(|(_, at)| *at)
            .map(|(id, _)| id.clone())
    }
    pub async fn sync(&self, runtime: &Runtime, bridge: &DesktopBridge, id: &str) -> Result<Value> {
        self.attempts
            .lock()
            .unwrap()
            .insert(id.into(), storage::now_ms());
        let result = self.run(runtime, bridge, id).await;
        if result.is_err() {
            self.hints.lock().unwrap().remove(id);
            self.cache.invalidate(id);
        }
        result
    }
    async fn run(&self, runtime: &Runtime, bridge: &DesktopBridge, id: &str) -> Result<Value> {
        let stopped = bridge.untrack(id, true).await?;
        if stopped["tracking"] == "stopped" {
            self.hints.lock().unwrap().remove(id);
            self.cache.invalidate(id);
            return Ok(stopped);
        }
        let state = bridge.status()?;
        let before = hint(&state, id)?;
        let persistent = before.is_some() && persistent(&state, id);
        let identity = if persistent {
            inactive(runtime, &state, id).await?
        } else {
            None
        };
        let context = json!({"runtime":self.context,"nativeIdentity":identity});
        // A checkpoint saved before dialogue digests existed gets one from its
        // next real read; reuse would postpone that indefinitely.
        let canonical = &state.conversations[id].canonical;
        let needs_dialogue = canonical.count > 0 && canonical.dialogue.is_none();
        if let Some(before) = before.as_ref().filter(|_| !needs_dialogue) {
            if persistent && identity.is_some() {
                if self.cache.load(id, before, &context).is_some()
                    && hint(&bridge.status()?, id)?.as_ref() == Some(before)
                {
                    return Ok(json!({"changed":false,"reused":true}));
                }
            } else if self
                .hints
                .lock()
                .unwrap()
                .get(id)
                .is_some_and(|(signature, at)| {
                    signature == before && storage::now_ms().saturating_sub(*at) < 60_000
                })
            {
                return Ok(json!({"changed":false,"reused":true}));
            }
        }
        self.hints.lock().unwrap().remove(id);
        let (result, files) = if persistent {
            capture(bridge.sync(id)).await
        } else {
            (bridge.sync(id).await, None)
        };
        let value = result?;
        if value["changed"] == false && (value["incompleteTail"] != true || persistent) {
            if let Some(before) = &before {
                let latest = bridge.status()?;
                let after = hint(&latest, id)?;
                let latest_identity = inactive(runtime, &latest, id).await?;
                if after.as_ref() == Some(before) && latest_identity.is_some() {
                    self.hints
                        .lock()
                        .unwrap()
                        .insert(id.into(), (before.clone(), storage::now_ms()));
                    if persistent && latest_identity == identity {
                        if let Some(files) = files {
                            self.cache.store(id, before, &context, files);
                        }
                    }
                }
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Result<(tempfile::TempDir, Cache)> {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(temp.path())?;
        storage::private_directory(root.join("history-assets"))?;
        let cache = Cache::new(&root, &[41; 32], "cold-verification-v1")?;
        Ok((temp, cache))
    }
    #[test]
    fn verification_hints_bind_realtime_policy_on_conversations_and_records() -> Result<()> {
        use crate::{
            bridge::Side,
            desktop::{Checkpoint, Conversation, Record},
        };
        let (_temp, cache) = fixture()?;
        let id = Uuid::new_v4().to_string();
        let mut state = State::default();
        state.conversations.insert(
            id.clone(),
            Conversation {
                id: id.clone(),
                cwd: cache.root.to_string_lossy().into(),
                title: "Historical".into(),
                canonical: Checkpoint::empty(),
                extra: json!({"discoveryMode":"cold-import"})
                    .as_object()
                    .unwrap()
                    .clone(),
            },
        );
        let path = cache.root.join("source.jsonl");
        storage::publish_exclusive(&path, b"native history")?;
        let mut record = Record::source(Side::Codex, &path, &Uuid::new_v4().to_string());
        record.conversation_id = id.clone();
        state.records.push(record);
        let legacy = hint(&state, &id)?.unwrap();
        crate::native_realtime::enroll(&mut state.conversations.get_mut(&id).unwrap().extra);
        let conversation = hint(&state, &id)?.unwrap();
        assert_ne!(legacy, conversation);
        crate::native_realtime::enroll(&mut state.records[0].extra);
        assert_ne!(conversation, hint(&state, &id)?.unwrap());
        Ok(())
    }
    #[test]
    fn proofs_survive_restart_bind_assets_and_revoke_failed_verification() -> Result<()> {
        let (_temp, cache) = fixture()?;
        let id = Uuid::new_v4().to_string();
        let signature = json!({"canonical":"exact","files":[]});
        let context = json!({"decoder":"rust","nativeIdentity":{"inactive":true}});
        let path = cache.root.join("history-assets").join("a".repeat(64));
        storage::publish_exclusive(&path, b"authenticated asset")?;
        let files = vec![
            json!({"path":path,"identity":FileIdentity::from_metadata(&fs::symlink_metadata(&path)?)}),
        ];
        assert!(cache.store(&id, &signature, &context, files));
        assert!(cache.load(&id, &signature, &context).is_some());
        let restart = Cache::new(&cache.root, &[41; 32], "cold-verification-v1")?;
        assert!(restart.load(&id, &signature, &context).is_some());
        assert!(
            restart
                .load(&id, &signature, &json!({"decoder":"changed"}))
                .is_none()
        );
        fs::write(&path, b"modified asset")?;
        assert!(restart.load(&id, &signature, &context).is_none());
        assert!(restart.invalidate(&id));
        let saved = storage::read_json(cache.dir().join(format!("{id}.json")))?;
        assert_eq!(saved["payload"]["invalidated"], true);
        assert!(cache.load(&id, &signature, &context).is_none());
        Ok(())
    }
    #[test]
    fn reclamation_fences_restored_proofs_and_retains_valid_capacity_entries() -> Result<()> {
        let (_temp, mut cache) = fixture()?;
        cache.limits = (2, MAX_TOTAL);
        let signature = json!("stable");
        let context = json!({});
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        let c = Uuid::new_v4().to_string();
        assert!(cache.store(&a, &signature, &context, vec![]));
        assert!(cache.store(&b, &signature, &context, vec![]));
        let saved = storage::read_stable(cache.dir().join(format!("{b}.json")))?.bytes;
        assert!(!cache.store(&c, &signature, &context, vec![]));
        assert_eq!(cache.diagnostics()["state"], "capacity");
        assert!(cache.load(&b, &signature, &context).is_some());
        assert!(cache.invalidate(&a));
        assert!(cache.store(&c, &signature, &context, vec![]));
        assert_eq!(cache.diagnostics()["reclaimedEntries"], 1);
        assert!(!cache.dir().join(format!("{a}.json")).exists());
        storage::atomic_write(cache.dir().join(format!("{b}.json")), &saved)?;
        let restart = Cache::new(&cache.root, &[41; 32], "cold-verification-v1")?;
        assert!(restart.load(&b, &signature, &context).is_none());
        assert!(restart.load(&c, &signature, &context).is_some());
        Ok(())
    }
    #[tokio::test]
    async fn archive_capture_records_only_authenticated_stable_reads() -> Result<()> {
        let (_temp, cache) = fixture()?;
        let messages = (0..130)
            .map(|i| {
                crate::history::Message::text(
                    if i % 2 == 0 { "user" } else { "assistant" },
                    format!("message {i}"),
                )
            })
            .collect::<Vec<_>>();
        let reference = crate::archive::persist(&cache.root, &messages, 2)?;
        let (result, files) =
            capture(async { crate::archive::load(&cache.root, &reference) }).await;
        assert_eq!(result?, messages);
        let files = files.unwrap();
        // Every message, all three reference pages and the manifest must reach
        // the caller's task-local proof even when message reads use OS workers.
        assert_eq!(files.len(), 130 + 3 + 1);
        for file in files {
            let identity =
                FileIdentity::from_metadata(&fs::symlink_metadata(file["path"].as_str().unwrap())?);
            assert_eq!(file["identity"], serde_json::to_value(identity)?);
        }
        Ok(())
    }
}
