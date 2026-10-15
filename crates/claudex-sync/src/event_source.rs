//! Completion-gated exact-file notifications. Filesystem and native events are
//! scheduling hints only; the coordinator still proves every complete prefix.
use crate::{
    bridge::Side,
    desktop::State,
    events::{Event, Inbox, Kind, Receipt},
    runtime::Runtime,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, watch};
pub const RECONNECT_ID: &str = "00000000-0000-4000-8000-000000000001";
pub const CONFIG_ID: &str = "00000000-0000-4000-8000-000000000002";
fn hint(path: &Path) -> Result<Option<FileIdentity>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(FileIdentity::from_metadata(&m))),
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn event(kind: Kind) -> Event {
    Event {
        side: Side::Codex,
        native_id: if kind == Kind::Reconnect {
            RECONNECT_ID
        } else {
            CONFIG_ID
        }
        .into(),
        kind,
        turn_id: None,
        remote_id: None,
    }
}
struct Target {
    paths: Vec<PathBuf>,
    signature: Vec<Option<FileIdentity>>,
    event: Event,
}
struct SourceState {
    watcher: Option<RecommendedWatcher>,
    targets: BTreeMap<String, Target>,
    directories: BTreeSet<PathBuf>,
    external_directories: BTreeMap<PathBuf, FileIdentity>,
    active: BTreeSet<String>,
    root: PathBuf,
}
impl SourceState {
    fn watcher(&mut self) -> Result<&mut RecommendedWatcher> {
        self.watcher
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Synchronization event source is closed."))
    }
    fn subscribe(&mut self, key: &str, paths: Vec<PathBuf>, event: Event) -> Result<()> {
        if self.targets.get(key).is_some_and(|t| t.paths == paths) {
            return Ok(());
        }
        ensure!(
            self.targets.len() < 4104,
            "Completion-gated file watcher capacity exceeded."
        );
        for path in &paths {
            let parent = path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Watched file has no parent."))?;
            let info = match fs::symlink_metadata(parent) {
                Ok(m) => m,
                Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                    return Ok(());
                }
                Err(e) => return Err(e.into()),
            };
            ensure!(
                info.is_dir()
                    && !info.file_type().is_symlink()
                    && info.uid() == storage::uid()
                    && fs::canonicalize(parent)? == parent,
                "Unsafe notification directory."
            );
            if self.directories.insert(parent.into()) {
                self.watcher()?.watch(parent, RecursiveMode::NonRecursive)?;
            }
        }
        let signature = paths.iter().map(|p| hint(p)).collect::<Result<_>>()?;
        self.targets.insert(
            key.into(),
            Target {
                paths,
                signature,
                event,
            },
        );
        Ok(())
    }
    fn disarm(&mut self, key: &str) {
        self.targets.remove(key);
    }
    fn release_unused(&mut self) -> Result<()> {
        let used = self
            .targets
            .values()
            .flat_map(|t| {
                t.paths
                    .iter()
                    .filter_map(|p| p.parent().map(Path::to_path_buf))
            })
            .collect::<BTreeSet<_>>();
        for dir in self.directories.clone() {
            if !used.contains(&dir) && !self.external_directories.contains_key(&dir) {
                self.watcher()?.unwatch(&dir)?;
                self.directories.remove(&dir);
            }
        }
        Ok(())
    }
    fn connection(&mut self) -> Result<()> {
        let shared = self.root.join("codex-shared");
        match fs::symlink_metadata(&shared) {
            Ok(m) => {
                ensure!(
                    m.is_dir()
                        && !m.file_type().is_symlink()
                        && m.uid() == storage::uid()
                        && m.mode() & 0o77 == 0
                        && fs::canonicalize(&shared)? == shared,
                    "Unsafe shared native connection directory."
                );
                self.subscribe(
                    "connection",
                    vec![shared.join("owner.json"), shared.join("app.sock")],
                    event(Kind::Reconnect),
                )?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.targets.remove("connection");
            }
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }
    fn filesystem(&mut self, paths: &[PathBuf]) -> Result<Vec<Event>> {
        let mut published = vec![];
        let mut refresh = false;
        for (key, target) in &mut self.targets {
            if !paths.is_empty()
                && !paths.iter().any(|p| {
                    target
                        .paths
                        .iter()
                        .any(|target| p == target || p == target.parent().unwrap())
                })
            {
                continue;
            }
            let signature = target
                .paths
                .iter()
                .map(|p| hint(p))
                .collect::<Result<Vec<_>>>()?;
            if signature != target.signature {
                target.signature = signature;
                published.push(target.event.clone());
                refresh |= key == "shared-directory";
            }
        }
        if refresh {
            self.targets.remove("connection");
            // An OS watch belongs to a directory inode, not its pathname. A
            // replacement at the same pathname must acquire a fresh watch.
            let shared = self.root.join("codex-shared");
            if self.directories.remove(&shared) {
                match self.watcher()?.unwatch(&shared) {
                    Ok(()) => (),
                    Err(e) if matches!(e.kind, notify::ErrorKind::WatchNotFound) => (),
                    Err(e) => return Err(e.into()),
                }
            }
            self.connection()?;
            self.release_unused()?;
        }
        Ok(published)
    }
    fn native(&mut self, value: &Value) -> Result<Option<Event>> {
        ensure!(
            value["type"] != "native_event_overflow",
            "Native synchronization notification queue overflowed."
        );
        let mut candidate = None;
        if value["type"] == "codex_notification" {
            let notification = &value["event"];
            if notification["method"] == "claudex/disconnected" {
                return Ok(Some(event(Kind::Reconnect)));
            }
            candidate = crate::events::native_event(notification);
            if notification["method"] == "thread/status/changed" {
                let p = &notification["params"];
                let id = p
                    .get("threadId")
                    .or_else(|| p.get("thread_id"))
                    .or_else(|| p["thread"].get("id"))
                    .and_then(Value::as_str);
                if let Some(id) = id {
                    let status = p["status"].get("type").unwrap_or(&p["status"]);
                    let status = if status.is_null() {
                        &p["thread"]["status"]["type"]
                    } else {
                        status
                    };
                    let identity = Event {
                        side: Side::Codex,
                        native_id: id.into(),
                        kind: Kind::Started,
                        turn_id: None,
                        remote_id: None,
                    };
                    if status == "active" {
                        candidate = Some(identity)
                    } else if status == "idle" && self.active.contains(&identity.key()) {
                        candidate = Some(Event {
                            kind: Kind::Idle,
                            ..identity
                        })
                    }
                }
            }
        } else if value["type"] == "claude_notification" && value["suppressed"] != true {
            let source = &value["event"];
            let id = value["sessionId"].as_str().unwrap_or("");
            if source["session_id"]
                .as_str()
                .is_some_and(|native| native != id)
            {
                return Ok(None);
            }
            let identity = Event {
                side: Side::Claude,
                native_id: id.into(),
                kind: Kind::Started,
                turn_id: None,
                remote_id: None,
            };
            if source["type"] == "system" && source["subtype"] == "session_state_changed" {
                if source["state"] != "idle" {
                    candidate = Some(identity)
                } else if self.active.contains(&identity.key()) {
                    candidate = Some(Event {
                        kind: Kind::Idle,
                        ..identity
                    })
                }
            } else if source["type"] == "result"
                && (source["num_turns"].as_u64().unwrap_or(0) > 0
                    || source["duration_api_ms"].as_u64().unwrap_or(0) > 0)
            {
                candidate = Some(Event {
                    kind: Kind::Completed,
                    turn_id: source["uuid"].as_str().map(str::to_owned),
                    ..identity
                })
            }
        }
        if let Some(ref candidate) = candidate {
            if candidate.validate().is_err() {
                return Ok(None);
            }
            let key = candidate.key();
            if candidate.kind == Kind::Started {
                self.active.insert(key.clone());
                self.disarm(&key);
                self.release_unused()?;
            } else if matches!(
                candidate.kind,
                Kind::Completed | Kind::Interrupted | Kind::Idle
            ) {
                self.active.remove(&key);
            }
        }
        Ok(candidate)
    }
}
pub struct Source {
    state: Arc<Mutex<SourceState>>,
    failure: watch::Receiver<Option<String>>,
    task: Option<tokio::task::JoinHandle<()>>,
    filesystem_hints: broadcast::Sender<Vec<PathBuf>>,
}
#[derive(Clone)]
pub struct DirectoryWatch {
    state: Arc<Mutex<SourceState>>,
    failure: watch::Receiver<Option<String>>,
}
impl DirectoryWatch {
    pub fn check(&self) -> Result<()> {
        ensure!(
            self.failure.borrow().is_none(),
            "Synchronization event source failed: {}",
            self.failure.borrow().as_deref().unwrap_or("")
        );
        ensure!(
            self.state.lock().unwrap().watcher.is_some(),
            "Synchronization event source is closed."
        );
        Ok(())
    }
    pub fn watch_directory(&self, path: &Path) -> Result<()> {
        self.check()?;
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == storage::uid()
                && fs::canonicalize(path)? == path,
            "External notification directory is not canonical and owned."
        );
        let identity = FileIdentity::from_metadata(&metadata);
        let mut state = self.state.lock().unwrap();
        ensure!(
            state.watcher.is_some(),
            "Synchronization event source is closed."
        );
        if state
            .external_directories
            .get(path)
            .is_some_and(|old| old.same_inode(&identity))
        {
            return Ok(());
        }
        ensure!(
            state.external_directories.contains_key(path) || state.external_directories.len() < 256,
            "External notification directory capacity exceeded."
        );
        if state.directories.remove(path) {
            match state.watcher()?.unwatch(path) {
                Ok(()) => (),
                Err(e) if matches!(e.kind, notify::ErrorKind::WatchNotFound) => (),
                Err(e) => return Err(e.into()),
            }
        }
        state.watcher()?.watch(path, RecursiveMode::NonRecursive)?;
        state.directories.insert(path.into());
        state.external_directories.insert(path.into(), identity);
        Ok(())
    }
}
impl Source {
    pub fn start(runtime: Arc<Runtime>, config: &Value, inbox: Inbox) -> Result<Self> {
        let (send, mut receive) = mpsc::channel(1024);
        let (failure_send, failure) = watch::channel(None::<String>);
        let callback_failure = failure_send.clone();
        let (filesystem_hints, _) = broadcast::channel(1024);
        let hints = filesystem_hints.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if let Ok(notification) = &result {
                let _ = hints.send(notification.paths.clone());
            }
            if send.try_send(result).is_err() {
                let _ = callback_failure.send(Some(
                    "Filesystem synchronization notification queue overflowed.".into(),
                ));
            }
        })?;
        let root = runtime.options.root.clone();
        storage::require_private_directory(&root)?;
        let mut state = SourceState {
            watcher: Some(watcher),
            targets: BTreeMap::new(),
            directories: BTreeSet::new(),
            external_directories: BTreeMap::new(),
            active: BTreeSet::new(),
            root: root.clone(),
        };
        state.subscribe(
            "shared-directory",
            vec![root.join("codex-shared")],
            event(Kind::Reconnect),
        )?;
        state.connection()?;
        state.subscribe(
            "app-stop",
            vec![root.join("app-stop.json")],
            event(Kind::Configuration),
        )?;
        state.subscribe(
            "configuration",
            vec![root.join("config.json")],
            event(Kind::Configuration),
        )?;
        for (key, home, names) in [
            (
                "codex-config",
                runtime.options.codex_home.clone(),
                vec!["hooks.json", "config.toml"],
            ),
            (
                "claude-config",
                runtime.options.claude_home.clone(),
                vec!["settings.json"],
            ),
        ] {
            let metadata = fs::symlink_metadata(&home)?;
            ensure!(
                metadata.mode() & 0o22 == 0,
                "Native configuration directory has foreign writers."
            );
            state.subscribe(
                key,
                names.iter().map(|name| home.join(name)).collect(),
                event(Kind::Configuration),
            )?;
        }
        let _ = config;
        let state = Arc::new(Mutex::new(state));
        let process = state.clone();
        let mut native = runtime.subscribe();
        let task = tokio::spawn(async move {
            loop {
                let output = tokio::select! {
                    Some(notification)=receive.recv()=>match notification{Ok(notification)=>{tokio::time::sleep(Duration::from_millis(200)).await;process.lock().unwrap().filesystem(&notification.paths)},Err(e)=>Err(e.into())},
                    notification=native.recv()=>match notification{Ok(value)=>process.lock().unwrap().native(&value).map(|event|event.into_iter().collect()),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>Err(anyhow::anyhow!("Native synchronization notification queue overflowed.")),Err(_)=>break}
                };
                let result = async {
                    for event in output? {
                        inbox.publish(event).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if let Err(e) = result {
                    let _ = failure_send.send(Some(format!("{e:#}")));
                    break;
                }
            }
        });
        Ok(Self {
            state,
            failure,
            task: Some(task),
            filesystem_hints,
        })
    }
    /// Raw hints share this Source's OS subscriptions. Consumers must reprove
    /// their own cache/state; these hints never enter the synchronization inbox.
    pub fn filesystem_hints(&self) -> broadcast::Receiver<Vec<PathBuf>> {
        self.filesystem_hints.subscribe()
    }
    pub fn directory_watch(&self) -> DirectoryWatch {
        DirectoryWatch {
            state: self.state.clone(),
            failure: self.failure.clone(),
        }
    }
    pub fn watch_directory(&self, path: &Path) -> Result<()> {
        self.directory_watch().watch_directory(path)
    }
    pub fn check(&self) -> Result<()> {
        ensure!(
            self.failure.borrow().is_none(),
            "Synchronization event source failed: {}",
            self.failure.borrow().as_deref().unwrap_or("")
        );
        Ok(())
    }
    pub async fn failed(&mut self) {
        let _ = self.failure.changed().await;
    }
    pub fn observe(&self, batch: &[Receipt], state: &State, inbox: &Inbox) -> Result<()> {
        self.check()?;
        let current = inbox.read()?;
        let mut source = self.state.lock().unwrap();
        let eligible = state
            .records
            .iter()
            .filter(|r| {
                r.verified
                    && matches!(
                        r.status.as_str(),
                        "current" | "original" | "dependency-anchor" | "previous"
                    )
            })
            .collect::<Vec<_>>();
        let keys = source
            .targets
            .keys()
            .filter(|key| key.starts_with("codex:") || key.starts_with("claude:"))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            let records = eligible
                .iter()
                .filter(|r| format!("{}:{}", r.side.name(), r.native_id.to_lowercase()) == key)
                .collect::<Vec<_>>();
            if records.len() != 1 || source.targets[&key].paths.first() != Some(&records[0].path) {
                source.disarm(&key);
            }
        }
        for receipt in batch {
            if current
                .entries
                .get(&receipt.event.key())
                .is_none_or(|entry| entry.revision != receipt.revision)
            {
                continue;
            }
            let key = receipt.event.key();
            if receipt.event.kind == Kind::Started {
                source.active.insert(key.clone());
                source.disarm(&key);
                continue;
            }
            if !matches!(
                receipt.event.kind,
                Kind::Completed | Kind::Interrupted | Kind::Idle | Kind::Changed
            ) || receipt.event.kind == Kind::Changed && source.active.contains(&key)
            {
                continue;
            }
            source.active.remove(&key);
            let records = eligible
                .iter()
                .filter(|r| {
                    r.side == receipt.event.side
                        && r.native_id.eq_ignore_ascii_case(&receipt.event.native_id)
                })
                .collect::<Vec<_>>();
            if records.len() != 1 {
                source.disarm(&key);
                continue;
            }
            let path = records[0].path.clone();
            let mut paths = vec![path.clone()];
            if records[0].side == Side::Codex {
                paths.push(PathBuf::from(format!("{}.zst", path.display())));
            }
            source.subscribe(
                &key,
                paths,
                Event {
                    kind: Kind::Changed,
                    turn_id: None,
                    ..receipt.event.clone()
                },
            )?;
        }
        source.release_unused()
    }
    pub async fn close(mut self) -> Result<()> {
        let result = self.check();
        self.state.lock().unwrap().watcher.take();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        result
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        self.state.lock().unwrap().watcher.take();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn directory_watch_rearms_replaced_inodes_and_cloned_handles_remain_closed() -> Result<()>
    {
        let fixture = tempfile::tempdir_in("/tmp")?;
        let base = fixture.path().canonicalize()?;
        let root = storage::private_directory(base.join("state"))?;
        let codex = storage::private_directory(base.join("codex"))?;
        let claude = storage::private_directory(base.join("claude"))?;
        let config = json!({"codexHome":codex,"claudeHome":claude,"contextMode":"archive","versionPolicy":"warn"});
        let runtime = Runtime::new(crate::runtime::Options::from_config(&root, &config)?)?;
        let source = Source::start(runtime.clone(), &config, Inbox::new(&root)?)?;
        let handle = source.directory_watch();
        let directory = storage::private_directory(base.join("cache"))?;
        let mut hints = source.filesystem_hints();
        handle.watch_directory(&directory)?;
        let first = source.state.lock().unwrap().external_directories[&directory].clone();
        handle.watch_directory(&directory)?;
        assert_eq!(source.state.lock().unwrap().external_directories.len(), 1);
        fs::rename(&directory, base.join("previous-cache"))?;
        storage::private_directory(&directory)?;
        handle.watch_directory(&directory)?;
        let second = source.state.lock().unwrap().external_directories[&directory].clone();
        assert!(!first.same_inode(&second));
        assert!(
            source
                .state
                .lock()
                .unwrap()
                .directories
                .contains(&directory)
        );
        let child = directory.join("new-native-cache");
        fs::write(&child, b"Fresh inode notification")?;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let paths = hints.recv().await?;
                if paths
                    .iter()
                    .any(|path| path == &child || path == &directory)
                {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        })
        .await??;
        source.close().await?;
        assert!(handle.check().is_err());
        assert!(handle.watch_directory(&directory).is_err());
        runtime.close().await?;
        Ok(())
    }
    #[test]
    fn rearming_an_existing_directory_does_not_consume_another_capacity_slot() -> Result<()> {
        let fixture = tempfile::tempdir_in("/tmp")?;
        let base = fixture.path().canonicalize()?;
        let watcher = notify::recommended_watcher(|_: notify::Result<notify::Event>| {})?;
        let directory = storage::private_directory(base.join("cache"))?;
        let (_, failure) = watch::channel(None::<String>);
        let state = Arc::new(Mutex::new(SourceState {
            watcher: Some(watcher),
            targets: BTreeMap::new(),
            directories: BTreeSet::new(),
            external_directories: BTreeMap::new(),
            active: BTreeSet::new(),
            root: base.clone(),
        }));
        let handle = DirectoryWatch {
            state: state.clone(),
            failure,
        };
        handle.watch_directory(&directory)?;
        let identity = state.lock().unwrap().external_directories[&directory].clone();
        for index in 0..255 {
            state
                .lock()
                .unwrap()
                .external_directories
                .insert(base.join(format!("occupied-{index}")), identity.clone());
        }
        fs::rename(&directory, base.join("old-cache"))?;
        storage::private_directory(&directory)?;
        handle.watch_directory(&directory)?;
        assert_eq!(state.lock().unwrap().external_directories.len(), 256);
        let extra = storage::private_directory(base.join("extra"))?;
        assert!(handle.watch_directory(&extra).is_err());
        Ok(())
    }
}
