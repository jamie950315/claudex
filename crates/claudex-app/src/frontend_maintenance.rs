//! Watcher-owned, event-driven renderer maintenance. No polling or native work.
use crate::{
    frontend_graph,
    frontend_install::{self, Failure, FailureCode, Pass},
    platform,
};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_core::storage::FileIdentity;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, task::JoinHandle, time::Instant};

const CHECKING: &str = "The frontend cache changed during inspection. Claudex is checking it again; no action is required.";
const HELD: &str = "Desktop integration is waiting for Claudex to resume and finish checking. No action is required.";

#[derive(Clone)]
pub struct Config {
    pub root: PathBuf,
    pub home: PathBuf,
    pub folders: bool,
    pub settle: Duration,
    pub settling: Duration,
    pub refresh: Duration,
}
impl Config {
    pub fn new(root: PathBuf, home: PathBuf, folders: bool) -> Self {
        Self {
            root,
            home,
            folders,
            settle: Duration::from_secs(1),
            settling: Duration::from_secs(60),
            refresh: Duration::from_secs(10),
        }
    }
}

/// Root composition may decorate the native runtime with status and relaunch
/// consumers. A consumer failure is not a frontend-cache failure.
#[async_trait]
pub trait Runtime: Send + Sync + 'static {
    fn maintain(&self, config: &Config, fence: &dyn Fn() -> Result<()>) -> Result<Pass> {
        frontend_install::ensure(&config.root, &config.home, config.folders, fence)
    }
    fn stopped(&self, root: &Path) -> Result<bool> {
        platform::stopped(root)
    }
    fn changed_hint(
        &self,
        home: &Path,
        name: &str,
        observations: &BTreeMap<String, FileIdentity>,
    ) -> Result<bool> {
        frontend_graph::changed_hint(home, name, observations)
    }
    fn publish(&self, root: &Path, summary: &Value) -> Result<()> {
        platform::write_json(&root.join("renderer-adapters-status.json"), summary)
    }
    fn on_status(&self, _summary: &Value) {}
    async fn after_pass(&self, _summary: &Value) -> Result<bool> {
        Ok(false)
    }
}
#[async_trait]
pub trait AfterPass: Send + Sync + 'static {
    async fn consume(&self, summary: &Value) -> Result<bool>;
}
pub type StatusObserver = Arc<dyn Fn(&Value) + Send + Sync>;
#[derive(Default)]
pub struct NativeRuntime {
    pub after_pass: Option<Arc<dyn AfterPass>>,
    pub on_status: Option<StatusObserver>,
}
impl NativeRuntime {
    pub fn with_after_pass(consumer: Arc<dyn AfterPass>) -> Self {
        Self {
            after_pass: Some(consumer),
            on_status: None,
        }
    }
}
#[async_trait]
impl Runtime for NativeRuntime {
    fn on_status(&self, summary: &Value) {
        if let Some(observer) = &self.on_status {
            observer(summary);
        }
    }
    async fn after_pass(&self, summary: &Value) -> Result<bool> {
        if let Some(consumer) = &self.after_pass {
            consumer.consume(summary).await
        } else {
            Ok(false)
        }
    }
}

struct Hints {
    names: BTreeSet<String>,
    anonymous: bool,
    due: Option<Instant>,
}
struct Shared {
    config: Config,
    runtime: Arc<dyn Runtime>,
    hints: Mutex<Hints>,
    wake: Notify,
    closed: AtomicBool,
    started: AtomicBool,
    notifications_failed: AtomicBool,
    startup_done: AtomicBool,
    startup: Notify,
    snapshot: RwLock<Value>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct Maintenance {
    shared: Arc<Shared>,
}
impl Maintenance {
    /// Subscribe the shared Source to this handle before calling start, so an
    /// app-stop release between service startup and its first check is retained.
    pub fn new(config: Config, runtime: Arc<dyn Runtime>) -> Result<Self> {
        platform::absolute(&config.root)?;
        platform::absolute(&config.home)?;
        ensure!(
            config.settle <= Duration::from_secs(60),
            "Invalid renderer maintenance settle interval."
        );
        Ok(Self {
            shared: Arc::new(Shared {
                config,
                runtime,
                hints: Mutex::new(Hints {
                    names: BTreeSet::new(),
                    anonymous: true,
                    due: Some(Instant::now()),
                }),
                wake: Notify::new(),
                closed: AtomicBool::new(false),
                started: AtomicBool::new(false),
                notifications_failed: AtomicBool::new(false),
                startup_done: AtomicBool::new(false),
                startup: Notify::new(),
                snapshot: RwLock::new(json!({"state":"starting"})),
                task: tokio::sync::Mutex::new(None),
            }),
        })
    }
    pub async fn start(&self) -> Result<Value> {
        let mut task = self.shared.task.lock().await;
        ensure!(
            !self.shared.closed.load(Ordering::Acquire),
            "Renderer maintenance is closed."
        );
        if !self.shared.started.swap(true, Ordering::AcqRel) {
            let shared = self.shared.clone();
            *task = Some(tokio::spawn(async move {
                Worker::new(shared).run().await;
            }));
        }
        drop(task);
        loop {
            let done = self.shared.startup.notified();
            if self.shared.startup_done.load(Ordering::Acquire) {
                break;
            }
            done.await;
        }
        Ok(self.snapshot())
    }
    pub fn notify(&self, filename: Option<String>) {
        if self.shared.closed.load(Ordering::Acquire) {
            return;
        }
        if filename
            .as_ref()
            .is_some_and(|name| !frontend_graph::cache_filename(name))
        {
            return;
        }
        let mut hints = self.shared.hints.lock().unwrap();
        if let Some(name) = filename {
            if hints.names.len() < 4096 {
                hints.names.insert(name);
            } else {
                hints.anonymous = true;
            }
        } else {
            hints.anonymous = true;
        }
        hints
            .due
            .get_or_insert_with(|| Instant::now() + self.shared.config.settle);
        drop(hints);
        self.shared.wake.notify_one();
    }
    pub fn app_stop_changed(&self) {
        self.notify(None);
    }
    pub fn notifications_failed(&self) {
        self.shared
            .notifications_failed
            .store(true, Ordering::Release);
        self.shared.wake.notify_one();
    }
    pub fn snapshot(&self) -> Value {
        self.shared.snapshot.read().unwrap().clone()
    }
    /// Fence immediately, then drain all cache/status/consumer work before the
    /// caller releases watch.lock. Multiple close callers share that drain.
    pub async fn close(&self) {
        self.shared.closed.store(true, Ordering::Release);
        self.shared.wake.notify_one();
        let mut task = self.shared.task.lock().await;
        if let Some(task) = task.take() {
            let _ = task.await;
        }
        self.shared.startup_done.store(true, Ordering::Release);
        self.shared.startup.notify_waiters();
    }
}

struct Worker {
    shared: Arc<Shared>,
    observations: BTreeMap<String, FileIdentity>,
    revalidation: bool,
    last_failure: Option<Value>,
    transient_since: Option<Instant>,
    settlement: Option<(Instant, Value)>,
    last_coherent: Option<Value>,
    refreshed: Option<Instant>,
    reported_notifications_failure: bool,
}
impl Worker {
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            observations: BTreeMap::new(),
            revalidation: false,
            last_failure: None,
            transient_since: None,
            settlement: None,
            last_coherent: None,
            refreshed: None,
            reported_notifications_failure: false,
        }
    }
    fn closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
    fn notifications_failed(&self) -> bool {
        self.shared.notifications_failed.load(Ordering::Acquire)
    }
    fn remember(&mut self, phase: &str, code: FailureCode) {
        self.last_failure = Some(json!({"at":now(),"phase":phase,"code":code.name()}));
    }
    fn settled(&mut self) {
        self.transient_since = None;
        self.settlement = None;
    }
    fn settling(&mut self, explicit: Value) -> bool {
        let since = *self.transient_since.get_or_insert_with(Instant::now);
        let deadline = since + self.shared.config.settling;
        if deadline <= Instant::now() || self.notifications_failed() {
            self.settlement = None;
            return false;
        }
        self.settlement = Some((deadline, explicit));
        true
    }
    fn present(&self, mut summary: Value) -> Value {
        if self.closed() {
            return summary;
        }
        summary["updatedAt"] = json!(now());
        if let Some(failure) = &self.last_failure {
            summary["lastFailure"] = failure.clone();
        }
        if serde_json::to_vec(&summary).map_or(true, |bytes| bytes.len() > 1024 * 1024) {
            summary = json!({"updatedAt":now(),"state":"skipped","reason":"Renderer maintenance status exceeds its bound"});
        }
        if self
            .shared
            .runtime
            .publish(&self.shared.config.root, &summary)
            .is_err()
        {
            summary["state"] = json!("skipped");
            summary["reason"] = json!("Renderer maintenance status could not be published");
        }
        *self.shared.snapshot.write().unwrap() = summary.clone();
        self.shared.runtime.on_status(&summary);
        summary
    }
    async fn consume(&mut self, summary: Value) {
        if self.closed() {
            return;
        }
        let loaded = self
            .shared
            .runtime
            .after_pass(&summary)
            .await
            .unwrap_or(false);
        if !loaded || !awaiting_restart(&summary) || self.closed() {
            return;
        }
        let mut summary = summary;
        if let Some(adapters) = summary["adapters"].as_object_mut() {
            for row in adapters
                .values_mut()
                .filter(|row| row["activation"] == "restart-required")
            {
                row["changed"] = json!(false);
                row["activation"] = json!("load-not-verified");
            }
        }
        let summary = self.present(summary);
        self.last_coherent = (summary["state"] == "ready").then_some(summary);
    }
    async fn pass(&mut self, names: BTreeSet<String>, anonymous: bool) {
        let mut phase = "lifecycle";
        let mut changed = anonymous || self.revalidation;
        let initial = (|| -> Result<()> {
            if self.closed() {
                return Err(Failure(FailureCode::Stopped).into());
            }
            if self.shared.runtime.stopped(&self.shared.config.root)? {
                return Err(Failure(FailureCode::Held).into());
            }
            phase = "cache-hint";
            if !changed {
                for name in names {
                    if self.shared.runtime.changed_hint(
                        &self.shared.config.home,
                        &name,
                        &self.observations,
                    )? {
                        changed = true;
                        break;
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = initial {
            self.failed(phase, frontend_install::failure_code(&error), false);
            return;
        }
        if !changed {
            if self.last_coherent.as_ref().is_some_and(awaiting_restart)
                && self
                    .refreshed
                    .is_none_or(|at| at.elapsed() >= self.shared.config.refresh)
            {
                self.refreshed = Some(Instant::now());
                let mut summary = self.last_coherent.clone().unwrap();
                if let Some(adapters) = summary["adapters"].as_object_mut() {
                    for row in adapters.values_mut() {
                        row["changed"] = json!(false);
                    }
                }
                self.consume(summary).await;
            }
            return;
        }
        phase = "discovery-or-installation";
        for attempt in 0..2 {
            if self.closed() {
                break;
            }
            let shared = self.shared.clone();
            let result = tokio::task::spawn_blocking(move || {
                let fence = || {
                    if shared.closed.load(Ordering::Acquire) {
                        Err(Failure(FailureCode::Stopped).into())
                    } else {
                        Ok(())
                    }
                };
                shared.runtime.maintain(&shared.config, &fence)
            })
            .await
            .unwrap_or_else(|_| Err(Failure(FailureCode::ValidationRefused).into()));
            if self.closed() {
                break;
            }
            match result {
                Ok(pass) => {
                    let details = details(&pass.summary);
                    let refusals = details["adapters"]
                        .as_object()
                        .unwrap()
                        .values()
                        .filter(|row| row["status"] == "skipped")
                        .map(|row| code(row["failure"]["code"].as_str()))
                        .collect::<Vec<_>>();
                    let refused = !refusals.is_empty();
                    let all_transient = refused && refusals.iter().all(|code| code.transient());
                    let retry = attempt == 0 && refusals.iter().any(|code| code.transient());
                    self.revalidation = refused;
                    if refused {
                        self.observations.clear();
                        self.remember(
                            phase,
                            *refusals
                                .iter()
                                .find(|code| !code.transient())
                                .unwrap_or(&refusals[0]),
                        );
                    } else {
                        self.observations = pass.observations;
                        if let Some(failure) = &mut self.last_failure {
                            if failure.get("recoveredAt").is_none() {
                                failure["recoveredAt"] = json!(now());
                            }
                        }
                    }
                    let mut explicit = details.clone();
                    explicit["state"] = json!(if refused { "degraded" } else { "ready" });
                    if !all_transient {
                        self.settled();
                    }
                    let checking = all_transient
                        && (self.settling(explicit.clone()) || retry)
                        && !self.notifications_failed();
                    let mut summary = explicit;
                    if self.notifications_failed() {
                        summary["state"] = json!("skipped");
                        summary["reason"] = json!("Frontend cache notifications unavailable");
                    } else if checking {
                        summary["state"] = json!("checking");
                        summary["reason"] = json!(CHECKING);
                    }
                    let summary = self.present(summary);
                    self.last_coherent = (summary["state"] == "ready").then(|| summary.clone());
                    self.consume(summary).await;
                    if !retry {
                        break;
                    }
                }
                Err(error) => {
                    let code = frontend_install::failure_code(&error);
                    let retry = attempt == 0 && code.transient();
                    self.failed(phase, code, retry);
                    if let Some(partial) = frontend_install::interrupted_summary(&error) {
                        let mut partial = details(partial);
                        partial["state"] = json!(if code == FailureCode::Held {
                            "held"
                        } else {
                            "skipped"
                        });
                        self.consume(partial).await;
                    }
                    if !retry {
                        break;
                    }
                }
            }
        }
    }
    fn failed(&mut self, phase: &str, code: FailureCode, retry: bool) {
        if self.closed() {
            return;
        }
        self.observations.clear();
        self.last_coherent = None;
        self.revalidation = true;
        let held = code == FailureCode::Held;
        if !held {
            self.remember(phase, code);
        }
        if held || !code.transient() {
            self.settled();
        }
        let explicit = json!({"state":"skipped","reason":format!("Frontend cache discovery or maintenance refused; no native work was restarted [{phase}/{}]",code.name()),"failure":{"phase":phase,"code":code.name()}});
        let checking = !held
            && code.transient()
            && (self.settling(explicit.clone()) || retry)
            && !self.notifications_failed();
        let mut summary = explicit;
        if held && !self.notifications_failed() {
            summary = json!({"state":"held","reason":HELD});
        } else if checking {
            summary["state"] = json!("checking");
            summary["reason"] = json!(CHECKING);
        }
        self.present(summary);
    }
    async fn run(mut self) {
        loop {
            if self.closed() {
                break;
            }
            if self.notifications_failed() && !self.reported_notifications_failure {
                self.reported_notifications_failure = true;
                self.settled();
                self.last_coherent = None;
                self.present(
                    json!({"state":"skipped","reason":"Frontend cache notifications unavailable"}),
                );
            }
            let hints = {
                let mut hints = self.shared.hints.lock().unwrap();
                if hints.due.is_some_and(|due| due <= Instant::now()) {
                    hints.due = None;
                    Some((
                        std::mem::take(&mut hints.names),
                        std::mem::take(&mut hints.anonymous),
                    ))
                } else {
                    None
                }
            };
            if let Some((names, anonymous)) = hints {
                self.pass(names, anonymous).await;
                self.shared.startup_done.store(true, Ordering::Release);
                self.shared.startup.notify_waiters();
                continue;
            }
            if self
                .settlement
                .as_ref()
                .is_some_and(|(due, _)| *due <= Instant::now())
            {
                let (_, explicit) = self.settlement.take().unwrap();
                self.present(explicit);
                continue;
            }
            let wake = self.shared.wake.notified();
            // Notify retains a permit across the synchronous deadline read.
            let hint_due = self.shared.hints.lock().unwrap().due;
            let due = hint_due
                .into_iter()
                .chain(self.settlement.as_ref().map(|(at, _)| *at))
                .min();
            if let Some(due) = due {
                tokio::select! { _ = wake => {}, _ = tokio::time::sleep_until(due) => {} }
            } else {
                wake.await;
            }
        }
        self.shared.startup_done.store(true, Ordering::Release);
        self.shared.startup.notify_waiters();
    }
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn awaiting_restart(summary: &Value) -> bool {
    summary["adapters"].as_object().is_some_and(|adapters| {
        adapters
            .values()
            .any(|row| row["activation"] == "restart-required")
    })
}
fn code(name: Option<&str>) -> FailureCode {
    match name {
        Some("cache-entry-missing") => FailureCode::CacheMissing,
        Some("cache-changed") => FailureCode::CacheChanged,
        Some("recovery-evidence-missing") => FailureCode::EvidenceMissing,
        Some("required-file-missing") => FailureCode::RequiredFileMissing,
        Some("access-denied") => FailureCode::AccessDenied,
        Some("held") => FailureCode::Held,
        Some("stopped") => FailureCode::Stopped,
        _ => FailureCode::ValidationRefused,
    }
}
fn details(source: &Value) -> Value {
    let mut adapters = serde_json::Map::new();
    let mut refused = vec![];
    if let Some(rows) = source["adapters"].as_object() {
        for (name, value) in rows {
            let mut row = serde_json::Map::new();
            for field in [
                "status",
                "asset",
                "reason",
                "changed",
                "activation",
                "search",
            ] {
                if let Some(value) = value.get(field) {
                    row.insert(field.into(), value.clone());
                }
            }
            if value.get("failure").is_some() {
                row.insert(
                    "failure".into(),
                    json!({"code":code(value["failure"]["code"].as_str()).name()}),
                );
            }
            if value["status"] == "skipped" {
                refused.push(name.clone());
            }
            adapters.insert(name.clone(), Value::Object(row));
        }
    }
    json!({"entry":source["entry"],"missingChunks":source["missingChunks"],"refusedAdapters":refused,"adapters":adapters})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Condvar, atomic::AtomicUsize},
    };
    use tokio::sync::watch;

    enum Plan {
        Pass(Value),
        Fail(FailureCode),
    }
    struct Gate {
        entered: Notify,
        open: Mutex<bool>,
        changed: Condvar,
    }
    impl Gate {
        fn new() -> Self {
            Self {
                entered: Notify::new(),
                open: Mutex::new(false),
                changed: Condvar::new(),
            }
        }
        fn release(&self) {
            *self.open.lock().unwrap() = true;
            self.changed.notify_all();
        }
    }
    struct Fake {
        plans: Mutex<VecDeque<Plan>>,
        calls: AtomicUsize,
        hints: AtomicUsize,
        held: AtomicBool,
        hint_changed: AtomicBool,
        loaded: AtomicBool,
        statuses: watch::Sender<Value>,
        consumers: Mutex<Vec<Value>>,
        gate: Option<Arc<Gate>>,
    }
    impl Fake {
        fn new(plans: Vec<Plan>) -> Self {
            Self {
                plans: Mutex::new(plans.into()),
                calls: AtomicUsize::new(0),
                hints: AtomicUsize::new(0),
                held: AtomicBool::new(false),
                hint_changed: AtomicBool::new(false),
                loaded: AtomicBool::new(false),
                statuses: watch::channel(Value::Null).0,
                consumers: Mutex::new(vec![]),
                gate: None,
            }
        }
        async fn until(&self, predicate: impl Fn(&Value) -> bool) -> Value {
            let mut rx = self.statuses.subscribe();
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let value = rx.borrow_and_update().clone();
                    if predicate(&value) {
                        return value;
                    }
                    rx.changed().await.unwrap();
                }
            })
            .await
            .expect("Expected renderer status was not published")
        }
    }
    #[async_trait]
    impl Runtime for Fake {
        fn maintain(&self, _config: &Config, fence: &dyn Fn() -> Result<()>) -> Result<Pass> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            if let Some(gate) = &self.gate {
                gate.entered.notify_one();
                let mut open = gate.open.lock().unwrap();
                while !*open {
                    open = gate.changed.wait(open).unwrap();
                }
            }
            fence()?;
            match self
                .plans
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Plan::Pass(good(false)))
            {
                Plan::Pass(summary) => Ok(Pass {
                    summary,
                    observations: BTreeMap::new(),
                }),
                Plan::Fail(code) => Err(Failure(code).into()),
            }
        }
        fn stopped(&self, _root: &Path) -> Result<bool> {
            Ok(self.held.load(Ordering::Acquire))
        }
        fn changed_hint(
            &self,
            _home: &Path,
            _name: &str,
            _observations: &BTreeMap<String, FileIdentity>,
        ) -> Result<bool> {
            self.hints.fetch_add(1, Ordering::AcqRel);
            Ok(self.hint_changed.load(Ordering::Acquire))
        }
        fn publish(&self, _root: &Path, summary: &Value) -> Result<()> {
            self.statuses.send_replace(summary.clone());
            Ok(())
        }
        async fn after_pass(&self, summary: &Value) -> Result<bool> {
            self.consumers.lock().unwrap().push(summary.clone());
            Ok(self.loaded.load(Ordering::Acquire))
        }
    }
    fn good(changed: bool) -> Value {
        json!({"entry":{"asset":"index-test.js"},"missingChunks":[],"adapters":{"folders":{"status":"disabled"},"chatWake":{"status":"installed","changed":changed,"activation":if changed {"restart-required"} else {"load-not-verified"},"asset":"chat.js"}}})
    }
    fn setup(fake: Arc<Fake>) -> (tempfile::TempDir, Maintenance) {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let mut config = Config::new(root.clone(), root, false);
        config.settle = Duration::from_millis(1);
        config.settling = Duration::from_millis(30);
        (temp, Maintenance::new(config, fake).unwrap())
    }
    #[tokio::test]
    async fn initial_hold_and_release_are_event_driven_without_failure() {
        let fake = Arc::new(Fake::new(vec![]));
        fake.held.store(true, Ordering::Release);
        let (_temp, maintenance) = setup(fake.clone());
        let summary = maintenance.start().await.unwrap();
        assert_eq!(summary["state"], "held");
        assert!(summary.get("lastFailure").is_none());
        assert_eq!(fake.calls.load(Ordering::Acquire), 0);
        fake.held.store(false, Ordering::Release);
        maintenance.app_stop_changed();
        fake.until(|v| v["state"] == "ready").await;
        assert_eq!(fake.calls.load(Ordering::Acquire), 1);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn subscription_release_before_start_is_not_lost() {
        let fake = Arc::new(Fake::new(vec![]));
        let (_temp, maintenance) = setup(fake.clone());
        maintenance.app_stop_changed();
        assert_eq!(maintenance.start().await.unwrap()["state"], "ready");
        assert_eq!(fake.calls.load(Ordering::Acquire), 1);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn exactly_one_immediate_rediscovery_and_settlement_never_inspects_cache() {
        let fake = Arc::new(Fake::new(vec![
            Plan::Fail(FailureCode::CacheMissing),
            Plan::Fail(FailureCode::CacheChanged),
        ]));
        let (_temp, maintenance) = setup(fake.clone());
        assert_eq!(maintenance.start().await.unwrap()["state"], "checking");
        assert_eq!(fake.calls.load(Ordering::Acquire), 2);
        let explicit = fake.until(|v| v["state"] == "skipped").await;
        assert_eq!(explicit["lastFailure"]["code"], "cache-changed");
        assert_eq!(fake.calls.load(Ordering::Acquire), 2);
        assert_eq!(fake.hints.load(Ordering::Acquire), 0);
        // An unknown, already evicted filename cannot be discarded after an
        // interrupted inventory; it requests one complete new proof.
        maintenance.notify(Some("ffffffffffffffff_0".into()));
        let recovered = fake.until(|v| v["state"] == "ready").await;
        assert!(recovered["lastFailure"]["recoveredAt"].is_number());
        assert_eq!(fake.calls.load(Ordering::Acquire), 3);
        assert_eq!(fake.hints.load(Ordering::Acquire), 0);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn evidence_loss_is_not_retried_and_next_hint_revalidates() {
        let fake = Arc::new(Fake::new(vec![Plan::Fail(FailureCode::EvidenceMissing)]));
        let (_temp, maintenance) = setup(fake.clone());
        let summary = maintenance.start().await.unwrap();
        assert_eq!(summary["state"], "skipped");
        assert_eq!(summary["failure"]["code"], "recovery-evidence-missing");
        assert_eq!(fake.calls.load(Ordering::Acquire), 1);
        maintenance.notify(Some("ffffffffffffffff_0".into()));
        fake.until(|v| v["state"] == "ready").await;
        assert_eq!(fake.calls.load(Ordering::Acquire), 2);
        assert_eq!(fake.hints.load(Ordering::Acquire), 0);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn mixed_refusals_are_degraded_and_keep_fixed_diagnostics() {
        let mut partial = good(true);
        partial["adapters"]["ownerWake"] = json!({"status":"skipped","reason":"Structural proof unavailable","failure":{"code":"validation-refused"},"cachePath":"/private/native"});
        partial["adapters"]["commands"] =
            json!({"status":"skipped","failure":{"code":"cache-changed"}});
        let fake = Arc::new(Fake::new(vec![
            Plan::Pass(partial.clone()),
            Plan::Pass(partial),
        ]));
        let (_temp, maintenance) = setup(fake.clone());
        let summary = maintenance.start().await.unwrap();
        assert_eq!(summary["state"], "degraded");
        assert_eq!(fake.calls.load(Ordering::Acquire), 2);
        assert_eq!(summary["lastFailure"]["code"], "validation-refused");
        assert_eq!(summary["refusedAdapters"].as_array().unwrap().len(), 2);
        assert!(summary["adapters"]["ownerWake"].get("cachePath").is_none());
        assert_eq!(
            summary["adapters"]["chatWake"]["activation"],
            "restart-required"
        );
        assert_eq!(fake.consumers.lock().unwrap().len(), 2);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn unchanged_hints_only_refresh_restart_consumer_without_recounting_writes() {
        let fake = Arc::new(Fake::new(vec![Plan::Pass(good(true))]));
        let (_temp, maintenance) = setup(fake.clone());
        assert_eq!(maintenance.start().await.unwrap()["state"], "ready");
        fake.loaded.store(true, Ordering::Release);
        maintenance.notify(Some("0000000000000001_0".into()));
        fake.until(|v| v["adapters"]["chatWake"]["activation"] == "load-not-verified")
            .await;
        assert_eq!(fake.calls.load(Ordering::Acquire), 1);
        let consumed = fake.consumers.lock().unwrap();
        assert_eq!(consumed.len(), 2);
        assert_eq!(consumed[1]["adapters"]["chatWake"]["changed"], false);
        drop(consumed);
        maintenance.close().await;
    }
    #[tokio::test]
    async fn close_fences_and_drains_inflight_publication() {
        let gate = Arc::new(Gate::new());
        let mut fake = Fake::new(vec![Plan::Pass(good(true))]);
        fake.gate = Some(gate.clone());
        let fake = Arc::new(fake);
        let (_temp, maintenance) = setup(fake.clone());
        let starting = {
            let maintenance = maintenance.clone();
            tokio::spawn(async move { maintenance.start().await })
        };
        gate.entered.notified().await;
        let closing = {
            let maintenance = maintenance.clone();
            tokio::spawn(async move { maintenance.close().await })
        };
        while !maintenance.shared.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert!(!closing.is_finished());
        gate.release();
        closing.await.unwrap();
        starting.await.unwrap().unwrap();
        assert_eq!(maintenance.snapshot()["state"], "starting");
        assert!(fake.statuses.borrow().is_null());
        assert!(fake.consumers.lock().unwrap().is_empty());
        maintenance.notify(None);
        assert!(maintenance.start().await.is_err());
        maintenance.close().await;
    }
}
