//! Durable identity-only wake hints. Revisions, not wall time, determine which
//! hints a completed operation is allowed to consume.
use crate::bridge::Side;
use anyhow::{Context, Result, bail, ensure};
use claudex_core::storage::{self, FileIdentity, FileLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{Notify, watch},
};
use uuid::Uuid;

const MAX_KEYS: usize = 4096;
const MAX_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Completed,
    Idle,
    Interrupted,
    Session,
    Changed,
    Reconnect,
    Started,
    Configuration,
    OwnerWake,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub side: Side,
    pub native_id: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
}
impl Event {
    pub fn validate(&self) -> Result<()> {
        Uuid::parse_str(&self.native_id)?;
        if self.kind == Kind::OwnerWake {
            ensure!(
                self.side == Side::Claude
                    && self.turn_id.is_none()
                    && self
                        .remote_id
                        .as_ref()
                        .is_some_and(|s| s.starts_with("cse_")
                            && (5..=204).contains(&s.len())
                            && s[4..]
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')),
                "Invalid Claude owner wake identity."
            );
        } else {
            ensure!(
                self.remote_id.is_none(),
                "Remote identity only belongs to owner wake."
            );
            if let Some(id) = &self.turn_id {
                ensure!(
                    !id.is_empty()
                        && id.len() <= 160
                        && id
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c)),
                    "Invalid event turn identity."
                );
            }
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        format!(
            "{}:{}{}",
            self.side.name(),
            self.native_id.to_lowercase(),
            if self.kind == Kind::OwnerWake {
                ":owner-wake"
            } else {
                ""
            }
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    #[serde(flatten)]
    pub event: Event,
    pub revision: String,
    pub pending: bool,
    pub at: i64,
}
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct InboxState {
    pub version: u8,
    pub entries: BTreeMap<String, Receipt>,
}
#[derive(Clone)]
pub struct Inbox {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub path: PathBuf,
    pub socket: PathBuf,
    local_wake: Arc<Mutex<Option<Weak<Notify>>>>,
}
fn lock_contention(error: &anyhow::Error) -> bool {
    if storage::is_not_found(error) {
        return true;
    }
    let text = format!("{error:#}");
    [
        "Another bridge operation holds the lock",
        "Lock is not a private owned regular file",
        "Lock identity changed",
        "Lock state changed during owner publication",
        "Lock changed during stale recovery",
        "Malformed lock owner",
        "Another stale-lock recovery",
        "Transcript changed while being read",
    ]
    .iter()
    .any(|prefix| text.contains(prefix))
}

fn retryable_current_lock(path: &Path) -> Option<bool> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let check_missing = || match fs::symlink_metadata(path) {
        Ok(_) => None,
        Err(current) => Some(current.kind() == std::io::ErrorKind::NotFound),
    };
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return check_missing(),
        Err(_) => return Some(false),
    };
    let before = match file.metadata() {
        Ok(m) => m,
        Err(_) => return Some(false),
    };
    if !before.is_file()
        || before.uid() != storage::uid()
        || before.mode() & 0o777 != 0o600
        || before.nlink() > 1
        || before.len() > 1024
    {
        return Some(false);
    }
    let mtime_ms = before.mtime().saturating_mul(1000) + before.mtime_nsec() / 1_000_000;
    if before.nlink() == 0 || (before.len() == 0 && storage::now_ms() - mtime_ms <= 1000) {
        return None;
    }
    let mut bytes = Vec::new();
    if std::io::Read::by_ref(&mut file)
        .take(1025)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 1024
    {
        return Some(false);
    }
    let owner: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Some(false),
    };
    let Some(pid) = owner["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
    else {
        return Some(false);
    };
    if owner["started"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none()
    {
        return Some(false);
    }
    let after = match file.metadata() {
        Ok(m) => m,
        Err(_) => return Some(false),
    };
    let named = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return check_missing(),
        Err(_) => return Some(false),
    };
    if named.nlink() == 0 {
        return None;
    }
    if !named.is_file()
        || named.file_type().is_symlink()
        || named.uid() != storage::uid()
        || named.mode() & 0o777 != 0o600
        || named.nlink() != 1
    {
        return Some(false);
    }
    let before_id = FileIdentity::from_metadata(&before);
    if before_id != FileIdentity::from_metadata(&after)
        || before_id != FileIdentity::from_metadata(&named)
    {
        return None;
    }
    Some(storage::process_alive(pid as u32).unwrap_or(false))
}

impl Inbox {
    pub fn new(root: &Path) -> Result<Self> {
        ensure!(root.is_absolute(), "A private absolute root is required.");
        Ok(Self {
            root: root.into(),
            directory: root.join("sync-events"),
            path: root.join("sync-events/inbox.json"),
            socket: root.join("sync-events/wake.sock"),
            local_wake: Arc::new(Mutex::new(None)),
        })
    }
    pub fn initialize(&self) -> Result<()> {
        for path in [&self.root, &self.directory] {
            storage::private_directory(path)?;
            storage::require_private_directory(path)?;
            ensure!(
                fs::canonicalize(path)? == *path,
                "Event directory must be canonical."
            );
        }
        self.read()?;
        Ok(())
    }
    pub fn read(&self) -> Result<InboxState> {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(InboxState {
                    version: 1,
                    entries: BTreeMap::new(),
                });
            }
            Err(e) => return Err(e.into()),
        };
        let before = file.metadata()?;
        ensure!(
            before.is_file()
                && before.uid() == storage::uid()
                && before.mode() & 0o777 == 0o600
                && before.nlink() <= 1
                && before.len() <= MAX_BYTES as u64,
            "Unsafe synchronization inbox."
        );
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take((MAX_BYTES as u64).saturating_add(1))
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_BYTES,
            "Synchronization inbox exceeds bound."
        );
        let after = file.metadata()?;
        let before_id = FileIdentity::from_metadata(&before);
        let after_id = FileIdentity::from_metadata(&after);
        ensure!(
            after.is_file()
                && after.uid() == storage::uid()
                && after.mode() & 0o777 == 0o600
                && after.nlink() <= 1
                && before_id.dev == after_id.dev
                && before_id.ino == after_id.ino
                && before_id.size == after_id.size
                && before_id.mtime_ns == after_id.mtime_ns
                && (after.nlink() != 1 || before_id.ctime_ns == after_id.ctime_ns),
            "Synchronization event inbox changed while being read."
        );
        let mut named = fs::symlink_metadata(&self.path)?;
        if named.nlink() == 0 && after_id.same_inode(&FileIdentity::from_metadata(&named)) {
            named = fs::symlink_metadata(&self.path)?;
        }
        ensure!(
            named.is_file()
                && !named.file_type().is_symlink()
                && named.uid() == storage::uid()
                && named.mode() & 0o777 == 0o600
                && named.nlink() == 1
                && named.len() <= MAX_BYTES as u64,
            "Unsafe synchronization inbox."
        );
        let state: InboxState = serde_json::from_slice(&bytes)?;
        ensure!(
            state.version == 1 && state.entries.len() <= MAX_KEYS,
            "Malformed synchronization inbox."
        );
        for (key, receipt) in &state.entries {
            receipt.event.validate()?;
            Uuid::parse_str(&receipt.revision)?;
            ensure!(
                *key == receipt.event.key(),
                "Malformed synchronization event receipt."
            );
        }
        Ok(state)
    }
    fn write(&self, state: &InboxState) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut contents = serde_json::to_vec_pretty(state)?;
        contents.push(b'\n');
        ensure!(
            contents.len() <= MAX_BYTES,
            "Synchronization inbox exceeds bound."
        );
        let temporary = self.directory.join("inbox.next");
        match fs::symlink_metadata(&temporary) {
            Ok(previous) => {
                ensure!(
                    previous.is_file()
                        && !previous.file_type().is_symlink()
                        && previous.uid() == storage::uid()
                        && previous.mode() & 0o777 == 0o600
                        && previous.nlink() == 1
                        && previous.len() <= MAX_BYTES as u64,
                    "Unsafe synchronization event scratch file."
                );
                fs::remove_file(&temporary)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&temporary)?;
        if let Err(e) = file.write_all(&contents).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(e.into());
        }
        drop(file);
        let result = (|| -> Result<()> {
            fs::rename(&temporary, &self.path)?;
            fs::File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        match fs::remove_file(&temporary) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) if result.is_ok() => return Err(e.into()),
            Err(_) => (),
        }
        result
    }
    async fn lock(&self) -> Result<FileLock> {
        let path = self.directory.join("inbox.lock");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match FileLock::acquire(&path, true) {
                Ok(l) => return Ok(l),
                Err(e) => {
                    if !lock_contention(&e) || tokio::time::Instant::now() >= deadline {
                        return Err(e);
                    }
                    let mut retryable;
                    loop {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        retryable = retryable_current_lock(&path);
                        if retryable.is_some() || tokio::time::Instant::now() >= deadline {
                            break;
                        }
                    }
                    if retryable != Some(true) {
                        return Err(e);
                    }
                }
            }
        }
    }
    pub async fn publish(&self, mut event: Event) -> Result<Receipt> {
        event.validate()?;
        event.native_id.make_ascii_lowercase();
        self.initialize()?;
        let result = {
            let _lock = self.lock().await?;
            let mut state = self.read()?;
            let key = event.key();
            if event.kind == Kind::Changed {
                if let Some(prior) = state
                    .entries
                    .get(&key)
                    .filter(|r| r.event.kind == Kind::Started)
                {
                    return Ok(prior.clone());
                }
            }
            if !state.entries.contains_key(&key) && state.entries.len() >= MAX_KEYS {
                let remove = state
                    .entries
                    .iter()
                    .filter(|(_, r)| !r.pending)
                    .min_by_key(|(_, r)| r.at)
                    .map(|(k, _)| k.clone())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "Synchronization inbox is full; existing events were preserved."
                        )
                    })?;
                state.entries.remove(&remove);
            }
            let receipt = Receipt {
                event,
                revision: Uuid::new_v4().to_string(),
                pending: true,
                at: storage::now_ms(),
            };
            state.entries.insert(key, receipt.clone());
            self.write(&state)?;
            receipt
        };
        self.wake().await?;
        Ok(result)
    }
    pub fn list(&self) -> Result<Vec<Receipt>> {
        Ok(self
            .read()?
            .entries
            .into_values()
            .filter(|r| r.pending)
            .collect())
    }
    pub async fn acknowledge(&self, batch: &[Receipt]) -> Result<usize> {
        let _lock = self.lock().await?;
        let mut state = self.read()?;
        let mut count = 0;
        for receipt in batch {
            receipt.event.validate()?;
            if let Some(current) = state.entries.get_mut(&receipt.event.key()) {
                if current.revision == receipt.revision && current.pending {
                    current.pending = false;
                    count += 1;
                }
            }
        }
        if count > 0 {
            self.write(&state)?;
        }
        Ok(count)
    }
    pub async fn wake(&self) -> Result<()> {
        if let Some(notify) = self
            .local_wake
            .lock()
            .unwrap()
            .as_ref()
            .and_then(Weak::upgrade)
        {
            // Clones used by this listener's event source are already in the
            // consumer process. A socket deadline is only for other processes.
            notify.notify_one();
            return Ok(());
        }
        let metadata = match fs::symlink_metadata(&self.socket) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        ensure!(
            metadata.file_type().is_socket()
                && metadata.uid() == storage::uid()
                && metadata.mode() & 0o7777 == 0o600
                && metadata.nlink() == 1,
            "Unsafe synchronization wake socket."
        );
        let operation = async {
            let mut stream = UnixStream::connect(&self.socket).await?;
            stream.write_all(b"w").await?;
            let mut bytes = [0; 2];
            stream.read(&mut bytes).await?;
            Ok::<_, std::io::Error>(())
        };
        match tokio::time::timeout(Duration::from_millis(300), operation).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                Ok(())
            }
            Ok(Err(e)) => Err(e).context("Synchronization socket wake delivery failed."),
            Err(_) => bail!("Wake delivery timed out; durable event was preserved."),
        }
    }
    fn listener_owner(&self) -> Result<Option<(Value, FileIdentity)>> {
        let stored =
            match storage::read_stable_with_limit(self.directory.join("listener.json"), 1024) {
                Ok(stored) => stored,
                Err(error) if storage::is_not_found(&error) => return Ok(None),
                Err(error) => return Err(error),
            };
        ensure!(
            stored.identity.uid == storage::uid().to_string()
                && stored.identity.mode.parse::<u32>()? & 0o7777 == 0o600
                && stored.identity.nlink == "1",
            "Unsafe synchronization listener owner."
        );
        let owner: Value = serde_json::from_slice(&stored.bytes)?;
        ensure!(
            owner["pid"]
                .as_u64()
                .is_some_and(|p| p > 0 && p <= i32::MAX as u64)
                && owner["revision"]
                    .as_str()
                    .is_some_and(|id| Uuid::parse_str(id).is_ok())
                && owner["socket"]["dev"].is_u64()
                && owner["socket"]["ino"].is_u64(),
            "Malformed synchronization listener owner."
        );
        Ok(Some((owner, stored.identity)))
    }
    pub async fn listen(&self) -> Result<Listener> {
        self.listen_with_publisher(|path, bytes| storage::publish_exclusive(path, bytes))
            .await
    }
    async fn listen_with_publisher(
        &self,
        publish: impl FnOnce(&Path, &[u8]) -> Result<()>,
    ) -> Result<Listener> {
        self.initialize()?;
        let _lock = self.lock().await?;
        let owner_path = self.directory.join("listener.json");
        let prior = self.listener_owner()?;
        let existing = match fs::symlink_metadata(&self.socket) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some((prior, owner_identity)) = prior {
            let pid = prior["pid"]
                .as_u64()
                .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                .ok_or_else(|| anyhow::anyhow!("Malformed synchronization listener owner."))?;
            ensure!(
                !storage::process_alive(pid as u32)?,
                "Another synchronization consumer is active."
            );
            if let Some(m) = &existing {
                ensure!(
                    m.file_type().is_socket()
                        && m.uid() == storage::uid()
                        && m.mode() & 0o7777 == 0o600
                        && m.nlink() == 1
                        && prior["socket"]["dev"].as_u64() == Some(m.dev())
                        && prior["socket"]["ino"].as_u64() == Some(m.ino()),
                    "Synchronization socket owner changed."
                );
                ensure!(
                    FileIdentity::from_metadata(&fs::symlink_metadata(&self.socket)?)
                        == FileIdentity::from_metadata(m),
                    "Synchronization socket changed before stale removal."
                );
                fs::remove_file(&self.socket)?;
            }
            ensure!(
                FileIdentity::from_metadata(&fs::symlink_metadata(&owner_path)?) == owner_identity,
                "Synchronization listener owner changed before stale removal."
            );
            fs::remove_file(&owner_path)?;
        } else {
            ensure!(
                existing.is_none(),
                "Synchronization socket has no verified owner; it was preserved."
            );
        }
        let listener = UnixListener::bind(&self.socket)?;
        let bound = FileIdentity::from_metadata(&fs::symlink_metadata(&self.socket)?);
        let revision = Uuid::new_v4().to_string();
        let initialized = (|| -> Result<_> {
            fs::set_permissions(&self.socket, fs::Permissions::from_mode(0o600))?;
            let metadata = fs::symlink_metadata(&self.socket)?;
            ensure!(
                FileIdentity::from_metadata(&metadata).same_inode(&bound)
                    && metadata.file_type().is_socket()
                    && metadata.uid() == storage::uid()
                    && metadata.nlink() == 1,
                "Synchronization socket changed during startup."
            );
            publish(
                &owner_path,
                &serde_json::to_vec(
                    &json!({"pid":std::process::id(),"revision":revision,"socket":{"dev":metadata.dev(),"ino":metadata.ino()}}),
                )?,
            )?;
            Ok(metadata)
        })();
        let metadata = match initialized {
            Ok(metadata) => metadata,
            Err(error) => {
                drop(listener);
                // Only the socket bound by this attempt may be removed. A
                // replacement and any publication evidence remain untouched.
                let current = fs::symlink_metadata(&self.socket)?;
                ensure!(
                    FileIdentity::from_metadata(&current).same_inode(&bound)
                        && current.file_type().is_socket()
                        && current.uid() == storage::uid()
                        && current.nlink() == 1,
                    "Synchronization startup failed and its socket changed; replacement evidence was preserved: {error}"
                );
                fs::remove_file(&self.socket)?;
                return Err(error);
            }
        };
        let notify = Arc::new(Notify::new());
        let wake = notify.clone();
        let (failed, failure) = watch::channel(None::<String>);
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((mut stream, _)) => {
                        // A busy coordinator cannot acknowledge its socket.
                        // This independent acceptor acknowledges only delivery
                        // of a hint; the durable inbox remains authoritative.
                        let _ = tokio::time::timeout(Duration::from_millis(200), async {
                            // Dropping an accepted stream before reading
                            // the publisher's byte closes its read half:
                            // a descheduled publisher then gets EPIPE.
                            let mut byte = [0; 1];
                            stream.read_exact(&mut byte).await?;
                            wake.notify_one();
                            stream.write_all(b"ok").await
                        })
                        .await;
                    }
                    Err(error) => {
                        let _ = failed.send(Some(error.to_string()));
                        wake.notify_one();
                        break;
                    }
                }
            }
        });
        *self.local_wake.lock().unwrap() = Some(Arc::downgrade(&notify));
        Ok(Listener {
            inbox: self.clone(),
            notify,
            failure,
            task: Some(task),
            revision,
            identity: FileIdentity::from_metadata(&metadata),
        })
    }
}
pub struct Listener {
    inbox: Inbox,
    notify: Arc<Notify>,
    failure: watch::Receiver<Option<String>>,
    task: Option<tokio::task::JoinHandle<()>>,
    revision: String,
    identity: FileIdentity,
}
impl Listener {
    fn release_local_wake(&self) {
        let mut local = self.inbox.local_wake.lock().unwrap();
        if local
            .as_ref()
            .is_some_and(|w| w.ptr_eq(&Arc::downgrade(&self.notify)))
        {
            local.take();
        }
    }
    /// Wait for a new hint without inspecting or consuming queued work. App
    /// holds use this path so a preserved inbox cannot cause a busy loop.
    pub async fn wait_hint(
        &self,
        timeout: Duration,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<()> {
        ensure!(
            self.failure.borrow().is_none(),
            "Synchronization listener failed."
        );
        if *shutdown.borrow() {
            return Ok(());
        }
        let mut failure = self.failure.clone();
        tokio::select! {
            _=self.notify.notified()=>ensure!(self.failure.borrow().is_none(),"Synchronization listener failed."),
            _=failure.changed()=>bail!("Synchronization listener stopped unexpectedly."),
            _=tokio::time::sleep(timeout)=>(),
            _=shutdown.changed()=>(),
        }
        Ok(())
    }
    pub async fn wait(
        &self,
        timeout: Duration,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<Vec<Receipt>> {
        ensure!(
            self.failure.borrow().is_none(),
            "Synchronization listener failed: {}",
            self.failure.borrow().as_deref().unwrap_or("")
        );
        let pending = self.inbox.list()?;
        if !pending.is_empty() {
            return Ok(pending);
        }
        if *shutdown.borrow() {
            return Ok(vec![]);
        }
        let mut failure = self.failure.clone();
        tokio::select! {
            _=self.notify.notified()=>{
                ensure!(self.failure.borrow().is_none(), "Synchronization listener failed: {}", self.failure.borrow().as_deref().unwrap_or(""));
                self.inbox.list()
            },
            _=failure.changed()=>bail!("Synchronization listener stopped unexpectedly."),
            _=tokio::time::sleep(timeout)=>Ok(vec![]),
            _=shutdown.changed()=>Ok(vec![])
        }
    }
    pub async fn close(mut self) -> Result<()> {
        let _lock = self.inbox.lock().await?;
        let owner_path = self.inbox.directory.join("listener.json");
        let (owner, owner_identity) = self
            .inbox
            .listener_owner()?
            .ok_or_else(|| anyhow::anyhow!("Synchronization listener owner is missing."))?;
        let current = FileIdentity::from_metadata(&fs::symlink_metadata(&self.inbox.socket)?);
        ensure!(
            owner["pid"] == std::process::id()
                && owner["revision"] == self.revision
                && current == self.identity,
            "Synchronization listener ownership changed; teardown refused."
        );
        fs::remove_file(&self.inbox.socket)?;
        ensure!(
            FileIdentity::from_metadata(&fs::symlink_metadata(&owner_path)?) == owner_identity,
            "Synchronization listener owner changed; teardown refused."
        );
        fs::remove_file(owner_path)?;
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        Ok(())
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.release_local_wake();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub fn native_event(value: &Value) -> Option<Event> {
    let method = value["method"].as_str()?;
    let p = &value["params"];
    let id = p
        .get("threadId")
        .or_else(|| p.get("thread_id"))
        .or_else(|| p.get("thread").and_then(|t| t.get("id")))?
        .as_str()?;
    let kind = match method {
        "turn/started" => Kind::Started,
        "turn/completed" => {
            if matches!(p["turn"]["status"].as_str(), Some("interrupted" | "failed")) {
                Kind::Interrupted
            } else {
                Kind::Completed
            }
        }
        "thread/started" => Kind::Session,
        _ => return None,
    };
    let event = Event {
        side: Side::Codex,
        native_id: id.into(),
        kind,
        turn_id: p["turn"]["id"].as_str().map(str::to_owned),
        remote_id: None,
    };
    event.validate().ok()?;
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revisions_preserve_newer_events() {
        let t = tempfile::tempdir().unwrap();
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        let inbox = Inbox::new(&root).unwrap();
        let event = Event {
            side: Side::Codex,
            native_id: Uuid::new_v4().to_string(),
            kind: Kind::Completed,
            turn_id: None,
            remote_id: None,
        };
        let first = inbox.publish(event.clone()).await.unwrap();
        let second = inbox.publish(event).await.unwrap();
        assert_eq!(inbox.acknowledge(&[first]).await.unwrap(), 0);
        assert_eq!(inbox.list().unwrap()[0].revision, second.revision);
        assert_eq!(inbox.acknowledge(&[second]).await.unwrap(), 1);
    }
    #[tokio::test]
    async fn listener_keeps_the_read_half_open_for_a_delayed_publisher() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        let listener = inbox.listen().await?;
        let mut publisher = UnixStream::connect(&inbox.socket).await?;
        // A publisher may be descheduled between connect and its one-byte
        // write. The acceptor must not ACK and fully close its read half first.
        tokio::time::sleep(Duration::from_millis(25)).await;
        publisher.write_all(b"w").await?;
        let mut ack = [0; 2];
        publisher.read_exact(&mut ack).await?;
        assert_eq!(&ack, b"ok");
        listener.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn cloned_consumer_publish_wakes_locally_without_a_socket_roundtrip() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        let publisher = inbox.clone();
        let mut listener = inbox.listen().await?;
        // Isolate local delivery from the independent socket acceptor. A local
        // publisher still commits its revision and wakes this exact listener.
        let acceptor = listener.task.take().unwrap();
        acceptor.abort();
        let _ = acceptor.await;
        let receipt = publisher
            .publish(Event {
                side: Side::Codex,
                native_id: Uuid::new_v4().to_string(),
                kind: Kind::Completed,
                turn_id: None,
                remote_id: None,
            })
            .await?;
        tokio::time::timeout(Duration::from_millis(50), listener.notify.notified()).await?;
        assert_eq!(inbox.list()?[0].revision, receipt.revision);
        assert!(
            publisher
                .local_wake
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .is_some()
        );
        listener.close().await?;
        assert!(publisher.local_wake.lock().unwrap().is_none());
        Ok(())
    }
    #[tokio::test]
    async fn publisher_is_acknowledged_while_consumer_is_busy() {
        let t = tempfile::tempdir().unwrap();
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        let inbox = Inbox::new(&root).unwrap();
        let listener = inbox.listen().await.unwrap();
        let publisher = Inbox::new(&root).unwrap();
        let event = Event {
            side: Side::Codex,
            native_id: Uuid::new_v4().to_string(),
            kind: Kind::Completed,
            turn_id: None,
            remote_id: None,
        };
        // No listener.wait is running during publication.
        publisher.publish(event).await.unwrap();
        let (_, mut shutdown) = watch::channel(false);
        assert_eq!(
            listener
                .wait(Duration::from_secs(1), &mut shutdown)
                .await
                .unwrap()
                .len(),
            1
        );
        listener.close().await.unwrap();
    }
    #[tokio::test]
    async fn failed_listener_publication_removes_only_its_bound_socket_and_can_restart()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        let attempt = inbox
            .listen_with_publisher(|_, _| bail!("Fixture publication failure."))
            .await;
        assert!(attempt.is_err());
        assert!(!inbox.socket.exists());
        assert!(!inbox.directory.join("listener.json").exists());
        let listener = inbox.listen().await?;
        listener.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn failed_startup_preserves_a_replaced_socket_and_unrelated_owner_metadata() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        let preserved = inbox.directory.join("original-socket");
        let attempt = inbox
            .listen_with_publisher(|owner, _| {
                fs::rename(&inbox.socket, &preserved)?;
                fs::write(&inbox.socket, b"Replacement evidence")?;
                fs::write(owner, b"Unrelated owner evidence")?;
                bail!("Fixture publication failure.")
            })
            .await;
        assert!(
            attempt
                .err()
                .unwrap()
                .to_string()
                .contains("replacement evidence was preserved")
        );
        assert_eq!(fs::read(&inbox.socket)?, b"Replacement evidence");
        assert_eq!(
            fs::read(inbox.directory.join("listener.json"))?,
            b"Unrelated owner evidence"
        );
        assert!(fs::symlink_metadata(preserved)?.file_type().is_socket());
        Ok(())
    }
    #[tokio::test]
    async fn unsafe_listener_owner_is_refused_before_binding_or_removal() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        inbox.initialize()?;
        let path = inbox.directory.join("listener.json");
        storage::write_json(
            &path,
            &json!({"pid":std::process::id(),"revision":Uuid::new_v4(),"socket":{"dev":1,"ino":2}}),
        )?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        let before = fs::read(&path)?;
        assert!(inbox.listen().await.is_err());
        assert_eq!(fs::read(&path)?, before);
        assert!(!inbox.socket.exists());
        Ok(())
    }
    #[tokio::test]
    async fn concurrent_reads_and_publishes_tolerate_atomic_replacement_and_lock_contention()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = temp.path().canonicalize()?;
        let inbox = Inbox::new(&root)?;
        inbox.initialize()?;
        let id = Uuid::new_v4().to_string();
        let writer_inbox = inbox.clone();
        let writer = tokio::spawn(async move {
            for i in 0..40 {
                writer_inbox
                    .publish(Event {
                        side: Side::Codex,
                        native_id: id.clone(),
                        kind: if i % 2 == 0 {
                            Kind::Changed
                        } else {
                            Kind::Completed
                        },
                        turn_id: None,
                        remote_id: None,
                    })
                    .await?;
            }
            Ok::<_, anyhow::Error>(())
        });
        for _ in 0..80 {
            let _ = inbox.list()?;
            tokio::task::yield_now().await;
        }
        writer.await??;
        assert_eq!(inbox.list()?.len(), 1);
        Ok(())
    }
}
