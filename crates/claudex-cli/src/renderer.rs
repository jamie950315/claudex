//! Compose renderer maintenance with the watcher's shared filesystem source.
use crate::claude_relaunch::{Controller, NativeEnvironment};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_app::{
    frontend_graph,
    frontend_maintenance::{AfterPass, Config, Maintenance, NativeRuntime, Runtime},
};
use claudex_sync::{
    commands::WatchLifecycle,
    event_source::{DirectoryWatch, Source},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{Mutex, broadcast, watch},
    task::JoinHandle,
};

struct RestartConsumer {
    controller: Controller,
    automatic: bool,
    closed: AtomicBool,
    request: Arc<RwLock<Value>>,
}
#[async_trait]
impl AfterPass for RestartConsumer {
    async fn consume(&self, summary: &Value) -> Result<bool> {
        let fence = || -> Result<()> {
            ensure!(
                !self.closed.load(Ordering::Acquire),
                "Renderer restart consumer is closed."
            );
            Ok(())
        };
        let decision = self
            .controller
            .consider_fenced(summary, self.automatic, &fence)
            .await?;
        fence()?;
        *self.request.write().unwrap() = decision.as_ref()
            .filter(|value| value["state"] == "restart-required" && value["requiredSince"].is_i64())
            .map(|value| {
                let mut request = json!({"entry":value["entry"],"requiredSince":value["requiredSince"],"reason":value["reason"]});
                if value["notBefore"].is_i64() { request["notBefore"] = value["notBefore"].clone(); }
                request
            }).unwrap_or(Value::Null);
        Ok(decision
            .is_some_and(|value| value["state"] == "current" || value["state"] == "relaunched"))
    }
}

struct Running {
    maintenance: Maintenance,
    consumer: Option<Arc<RestartConsumer>>,
    stop: watch::Sender<bool>,
    hints: JoinHandle<()>,
}
pub struct Renderer {
    home: PathBuf,
    running: Mutex<Option<Running>>,
    visible: RwLock<Option<Maintenance>>,
    restart: Arc<RwLock<Value>>,
    // An injected runtime exercises this composition without touching a native
    // cache or application. Production always uses NativeRuntime.
    runtime: Option<Arc<dyn Runtime>>,
}
impl Renderer {
    pub fn new(home: PathBuf) -> Result<Self> {
        claudex_app::platform::absolute(&home)?;
        Ok(Self {
            home,
            running: Mutex::new(None),
            visible: RwLock::new(None),
            restart: Arc::new(RwLock::new(Value::Null)),
            runtime: None,
        })
    }
    fn enabled(&self, config: &Value) -> bool {
        config["rendererAdapters"]["enabled"] != false
            && (config["rendererAdapters"]["enabled"] == true
                || config["folderProjection"]["enabled"] == true
                    && config["folderProjection"]["cachePath"]
                        .as_str()
                        .is_some_and(|path| {
                            Path::new(path).parent()
                                == Some(frontend_graph::cache_directory(&self.home).as_path())
                        }))
    }
}

/// Watch each existing part of the native cache path. Its parent reports an
/// inode replacement; the nearest existing ancestor reports a later creation.
/// This shares Source's OS watcher and creates no files or timer.
fn watch_cache(watcher: &DirectoryWatch, home: &Path, cache: &Path) -> Result<()> {
    let suffix = cache.strip_prefix(home)?;
    let mut directory = home.to_path_buf();
    watcher.watch_directory(&directory)?;
    for component in suffix.components() {
        directory.push(component);
        match fs::symlink_metadata(&directory) {
            Ok(_) => watcher.watch_directory(&directory)?,
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                break;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn cache_related(path: &Path, home: &Path, cache: &Path) -> bool {
    path.starts_with(cache) || path.starts_with(home) && cache.starts_with(path)
}
async fn receive_hints(
    mut hints: broadcast::Receiver<Vec<PathBuf>>,
    watcher: DirectoryWatch,
    root: PathBuf,
    home: PathBuf,
    maintenance: Maintenance,
    mut stop: watch::Receiver<bool>,
) {
    let cache = frontend_graph::cache_directory(&home);
    loop {
        let paths = tokio::select! {
            biased;
            _ = stop.changed() => break,
            paths = hints.recv() => match paths {
                Ok(paths) => paths,
                Err(_) => { maintenance.notifications_failed(); break; }
            }
        };
        if *stop.borrow() {
            break;
        }
        if watcher.check().is_err() {
            maintenance.notifications_failed();
            break;
        }
        if paths.is_empty() {
            if watch_cache(&watcher, &home, &cache).is_err() {
                maintenance.notifications_failed();
                break;
            }
            maintenance.app_stop_changed();
            continue;
        }
        if paths
            .iter()
            .any(|path| path == &root || path == &root.join("app-stop.json"))
        {
            maintenance.app_stop_changed();
        }
        let relevant = paths
            .iter()
            .filter(|path| cache_related(path, &home, &cache))
            .collect::<Vec<_>>();
        if relevant.is_empty() {
            continue;
        }
        if watch_cache(&watcher, &home, &cache).is_err() {
            maintenance.notifications_failed();
            break;
        }
        for path in relevant {
            if path.parent() == Some(cache.as_path()) {
                if let Some(name) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| frontend_graph::cache_filename(name))
                {
                    maintenance.notify(Some(name.into()));
                }
            } else if path == &cache || cache.starts_with(path) {
                maintenance.notify(None);
            }
        }
    }
}

#[async_trait]
impl WatchLifecycle for Renderer {
    async fn start(&self, source: &Source, root: &Path, config: &Value) -> Result<()> {
        let mut running = self.running.lock().await;
        ensure!(running.is_none(), "Renderer lifecycle has already started.");
        if !self.enabled(config) {
            return Ok(());
        }
        // Subscribe before both directory registration and the first hold check.
        let hints = source.filesystem_hints();
        let watcher = source.directory_watch();
        let mut options = Config::new(
            root.into(),
            self.home.clone(),
            config["folderProjection"]["enabled"] == true,
        );
        if cfg!(test) {
            options.settle = std::time::Duration::from_millis(10);
        }
        let consumer = if self.runtime.is_none() {
            Some(Arc::new(RestartConsumer {
                controller: Controller::new(root.into(), Arc::new(NativeEnvironment))?,
                automatic: config["rendererAdapters"]["relaunchAfterUpdate"] != false,
                closed: AtomicBool::new(false),
                request: self.restart.clone(),
            }))
        } else {
            None
        };
        let runtime: Arc<dyn Runtime> = self.runtime.clone().unwrap_or_else(|| {
            Arc::new(NativeRuntime::with_after_pass(
                consumer.as_ref().unwrap().clone(),
            ))
        });
        let maintenance = Maintenance::new(options, runtime)?;
        *self.visible.write().unwrap() = Some(maintenance.clone());
        let registration = watch_cache(
            &watcher,
            &self.home,
            &frontend_graph::cache_directory(&self.home),
        );
        let (stop, receive) = watch::channel(false);
        let task = tokio::spawn(receive_hints(
            hints,
            watcher,
            root.into(),
            self.home.clone(),
            maintenance.clone(),
            receive,
        ));
        *running = Some(Running {
            maintenance: maintenance.clone(),
            consumer,
            stop,
            hints: task,
        });
        // A notification failure is isolated to renderer status. History sync
        // keeps its independent Source failure and native ownership checks.
        if registration.is_err() {
            maintenance.notifications_failed();
        }
        maintenance.start().await?;
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        let mut running = self.running.lock().await;
        if let Some(running) = running.take() {
            if let Some(consumer) = &running.consumer {
                consumer.closed.store(true, Ordering::Release);
            }
            let _ = running.stop.send(true);
            running.maintenance.close().await;
            running.hints.await?;
        }
        Ok(())
    }
    fn status(&self) -> Value {
        self.visible
            .read()
            .unwrap()
            .as_ref()
            .map(Maintenance::snapshot)
            .unwrap_or(Value::Null)
    }
    fn restart(&self) -> Value {
        self.restart.read().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use claudex_app::frontend_install::Pass;
    use claudex_core::storage;
    use claudex_sync::{
        events::Inbox,
        runtime::{Options, Runtime as SyncRuntime},
    };
    use std::{sync::atomic::AtomicUsize, time::Duration};

    struct Manual {
        started: std::sync::atomic::AtomicI64,
        now: std::sync::atomic::AtomicI64,
    }
    #[async_trait]
    impl crate::claude_relaunch::Environment for Manual {
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
        fn alive(&self, _: u32) -> Result<bool> {
            panic!("Manual restart diagnostics must not quit an app")
        }
        async fn command(&self, program: &str, args: &[String]) -> Result<String> {
            match program {
                "/bin/ps" if args[0] == "-axo" => {
                    Ok("41 1 /Applications/Claude.app/Contents/MacOS/Claude".into())
                }
                "/bin/ps" => Ok(chrono::Local
                    .timestamp_millis_opt(self.started.load(Ordering::SeqCst))
                    .single()
                    .unwrap()
                    .format("%a %b %e %T %Y")
                    .to_string()),
                "/usr/bin/plutil" => Ok(crate::claude_relaunch::BUNDLE_ID.into()),
                _ => anyhow::bail!("Manual diagnostics attempted a native mutation"),
            }
        }
        async fn sleep(&self, _: u64) {
            panic!("Manual diagnostics must not poll")
        }
    }
    #[tokio::test]
    async fn restart_request_reaches_the_existing_status_contract_and_ends_after_a_new_start()
    -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir_in("/tmp")?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(temp.path().canonicalize()?)?;
        let environment = Arc::new(Manual {
            started: std::sync::atomic::AtomicI64::new(1_700_000_000_000),
            now: std::sync::atomic::AtomicI64::new(1_700_000_010_000),
        });
        let request = Arc::new(RwLock::new(Value::Null));
        let consumer = RestartConsumer {
            controller: Controller::new(root, environment.clone())?,
            automatic: false,
            closed: AtomicBool::new(false),
            request: request.clone(),
        };
        let mut summary = json!({"state":"ready","entry":{"asset":"index-synthetic.js"},"adapters":{"folders":{"status":"disabled"},"chatWake":{"status":"installed","changed":true},"ownerWake":{"status":"installed"},"commands":{"status":"installed"}}});
        assert!(!consumer.consume(&summary).await?);
        assert_eq!(
            request.read().unwrap()["requiredSince"],
            1_700_000_010_000i64
        );
        assert_eq!(request.read().unwrap()["entry"], "index-synthetic.js");
        summary["adapters"]["chatWake"]["changed"] = json!(false);
        environment
            .started
            .store(1_700_000_011_000, Ordering::SeqCst);
        environment.now.store(1_700_000_012_000, Ordering::SeqCst);
        assert!(consumer.consume(&summary).await?);
        assert!(request.read().unwrap().is_null());
        consumer.closed.store(true, Ordering::Release);
        assert!(consumer.consume(&summary).await.is_err());
        Ok(())
    }

    struct Fake {
        calls: AtomicUsize,
    }
    #[async_trait]
    impl Runtime for Fake {
        fn maintain(&self, _: &Config, fence: &dyn Fn() -> Result<()>) -> Result<Pass> {
            fence()?;
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Pass {
                summary: json!({"entry":{"asset":"index-synthetic.js"},"adapters":{"folders":{"status":"disabled"},"chatWake":{"status":"installed","changed":false,"activation":"load-not-verified"}}}),
                observations: Default::default(),
            })
        }
    }
    async fn until(renderer: &Renderer, predicate: impl Fn(&Value) -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !predicate(&renderer.status()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Shared Source failed to deliver renderer lifecycle hint");
    }
    #[tokio::test]
    async fn shared_source_releases_startup_hold_without_cache_activity_and_drains() -> Result<()> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = storage::private_directory(temp.path().canonicalize()?.join("state"))?;
        let home = storage::private_directory(root.parent().unwrap().join("home"))?;
        let codex = storage::private_directory(home.join("codex"))?;
        let claude = storage::private_directory(home.join("claude"))?;
        let config = json!({"mode":"desktop","codexHome":codex,"claudeHome":claude,"rendererAdapters":{"enabled":true},"folderProjection":{"enabled":false}});
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true,"resuming":true}),
        )?;
        let sync = SyncRuntime::new(Options::from_config(&root, &config)?)?;
        let inbox = Inbox::new(&root)?;
        let source = Source::start(sync.clone(), &config, inbox.clone())?;
        let fake = Arc::new(Fake {
            calls: AtomicUsize::new(0),
        });
        let mut renderer = Renderer::new(home.clone())?;
        renderer.runtime = Some(fake.clone());
        renderer.start(&source, &root, &config).await?;
        assert_eq!(renderer.status()["state"], "held");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        assert!(!frontend_graph::cache_directory(&home).exists());
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )?;
        until(&renderer, |value| value["state"] == "ready").await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        // Missing cache directory creation is caught through the same Source,
        // and only configuration hints (not cache) reach the durable inbox.
        let cache = frontend_graph::cache_directory(&home);
        storage::private_directory(&cache)?;
        until(&renderer, |_| fake.calls.load(Ordering::SeqCst) > 1).await;
        assert!(
            inbox
                .list()?
                .iter()
                .all(|row| row.event.kind == claudex_sync::events::Kind::Configuration)
        );
        source.close().await?;
        renderer.stop().await?;
        let calls = fake.calls.load(Ordering::SeqCst);
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        renderer.stop().await?;
        sync.close().await?;
        Ok(())
    }
    #[test]
    fn explicit_disable_and_legacy_cache_opt_in_are_preserved() -> Result<()> {
        let renderer = Renderer::new(PathBuf::from("/synthetic/home"))?;
        let mut config = json!({"folderProjection":{"enabled":true,"cachePath":frontend_graph::cache_directory(&renderer.home).join("0123456789abcdef_0")}});
        assert!(renderer.enabled(&config));
        config["rendererAdapters"] = json!({"enabled":false});
        assert!(!renderer.enabled(&config));
        config["rendererAdapters"]["enabled"] = json!(true);
        config["folderProjection"]["enabled"] = json!(false);
        assert!(renderer.enabled(&config));
        Ok(())
    }
}
