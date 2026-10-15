//! At-most-once normal Claude restart for newly written renderer adapters.
use anyhow::{Result, ensure};
use async_trait::async_trait;
use chrono::{Local, NaiveDateTime, TimeZone};
use claudex_app::platform::{self, CommandSpec, SystemRunner};
use claudex_core::storage::{self, FileLock, StableFile};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

pub const BUNDLE_ID: &str = "com.anthropic.claudefordesktop";

#[async_trait]
pub trait Environment: Send + Sync {
    fn now(&self) -> i64;
    fn alive(&self, pid: u32) -> Result<bool>;
    async fn command(&self, program: &str, args: &[String]) -> Result<String>;
    async fn sleep(&self, milliseconds: u64);
}
pub struct NativeEnvironment;
#[async_trait]
impl Environment for NativeEnvironment {
    fn now(&self) -> i64 {
        storage::now_ms()
    }
    fn alive(&self, pid: u32) -> Result<bool> {
        ensure!(
            pid > 0 && pid <= i32::MAX as u32,
            "Invalid Desktop process identity."
        );
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error.into())
        }
    }
    async fn command(&self, program: &str, args: &[String]) -> Result<String> {
        let mut spec = CommandSpec::new(program, args.iter().cloned());
        spec.env.extend([
            (
                "HOME".into(),
                crate::args::home()?.to_string_lossy().into_owned(),
            ),
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("LANG".into(), "C".into()),
            ("LC_ALL".into(), "C".into()),
        ]);
        Ok(platform::checked(&SystemRunner, spec)
            .await?
            .stdout
            .trim()
            .into())
    }
    async fn sleep(&self, milliseconds: u64) {
        tokio::time::sleep(Duration::from_millis(milliseconds)).await;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Outcome {
    Quitting,
    QuitDeclined,
    Relaunched,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    entry: String,
    pid: u32,
    started_at: i64,
    at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    entry: String,
    adapters: BTreeSet<String>,
    written_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    attempts: Vec<Attempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
}
impl Default for Record {
    fn default() -> Self {
        Self {
            version: 1,
            attempts: vec![],
            pending: None,
        }
    }
}
fn entry_asset(value: &str) -> bool {
    value.starts_with("index-") && platform_asset(value)
}
fn platform_asset(value: &str) -> bool {
    claudex_app::frontend_graph::asset_url(&format!(
        "{}{value}",
        claudex_app::frontend_graph::ASSET_ROOT
    ))
}
impl Record {
    fn validate(&self) -> Result<()> {
        let timestamp = |value: i64| (0..=9_007_199_254_740_991).contains(&value);
        ensure!(
            self.version == 1
                && self.attempts.len() <= 8
                && self.attempts.iter().all(|a| entry_asset(&a.entry)
                    && a.pid > 0
                    && a.pid <= i32::MAX as u32
                    && timestamp(a.at)
                    && timestamp(a.started_at)
                    && a.started_at <= a.at)
                && self.pending.as_ref().is_none_or(|p| entry_asset(&p.entry)
                    && timestamp(p.written_at)
                    && p.adapters.len() <= 4
                    && p.adapters
                        .iter()
                        .all(|s| ["folders", "chatWake", "ownerWake", "commands"]
                            .contains(&s.as_str()))),
            "Claude restart journal is invalid; prior outcomes were preserved."
        );
        Ok(())
    }
}
fn read_record(path: &Path) -> Result<(Record, Option<StableFile>)> {
    match crate::renderer_setup::private_snapshot(path, 32 * 1024) {
        Ok(snapshot) => {
            let record: Record = serde_json::from_slice(&snapshot.bytes)?;
            record.validate()?;
            Ok((record, Some(snapshot)))
        }
        Err(error) if storage::is_not_found(&error) => Ok((Record::default(), None)),
        Err(error) => Err(error),
    }
}
fn save_record(path: &Path, record: &Record, expected: &mut Option<StableFile>) -> Result<()> {
    record.validate()?;
    let (_, actual) = read_record(path)?;
    ensure!(
        match (expected.as_ref(), actual.as_ref()) {
            (Some(a), Some(b)) => a.identity == b.identity,
            (None, None) => true,
            _ => false,
        },
        "Claude restart journal changed; no native action was repeated."
    );
    platform::write_json(path, &serde_json::to_value(record)?)?;
    *expected = read_record(path)?.1;
    Ok(())
}
fn started_at(text: &str) -> Option<i64> {
    let time = NaiveDateTime::parse_from_str(text.trim(), "%a %b %e %T %Y").ok()?;
    Local
        .from_local_datetime(&time)
        .single()
        .map(|time| time.timestamp_millis())
}

pub struct Controller {
    root: PathBuf,
    environment: Arc<dyn Environment>,
    window_ms: i64,
    quit_timeout_ms: i64,
    last: Mutex<Option<Value>>,
}
impl Controller {
    pub fn new(root: PathBuf, environment: Arc<dyn Environment>) -> Result<Self> {
        platform::absolute(&root)?;
        Ok(Self {
            root,
            environment,
            window_ms: 60_000,
            quit_timeout_ms: 60_000,
            last: Mutex::new(None),
        })
    }
    fn stopped(&self) -> Result<bool> {
        claudex_sync::hooks::app_stopped(&self.root)
    }
    fn report(&self, last: &mut Option<Value>, value: Value) -> Result<Option<Value>> {
        if last.as_ref() != Some(&value) {
            let mut written = value.clone();
            written["updatedAt"] = json!(self.environment.now());
            storage::write_diagnostic_json(
                self.root.join("claude-relaunch-status.json"),
                &written,
            )?;
            *last = Some(value.clone());
        }
        Ok(Some(value))
    }
    pub async fn consider(&self, summary: &Value, automatic: bool) -> Result<Option<Value>> {
        self.consider_fenced(summary, automatic, &|| Ok(())).await
    }
    pub async fn consider_fenced(
        &self,
        summary: &Value,
        automatic: bool,
        fence: &(dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<Option<Value>> {
        fence()?;
        let Some(entry) = summary["entry"]["asset"]
            .as_str()
            .filter(|s| entry_asset(s))
        else {
            return Ok(None);
        };
        let Some(adapters) = summary["adapters"].as_object().filter(|a| !a.is_empty()) else {
            return Ok(None);
        };
        let mut last = self.last.lock().await;
        platform::directory(&self.root, true, false)?;
        let _lock = FileLock::acquire(self.root.join("claude-relaunch.lock"), true)?;
        let path = self.root.join("claude-relaunch.json");
        let (mut record, mut identity) = read_record(&path)?;
        let previous = record.pending.take();
        let mut changed = previous
            .as_ref()
            .is_some_and(|pending| pending.entry != entry);
        let mut pending = previous.filter(|p| p.entry == entry).unwrap_or(Pending {
            entry: entry.into(),
            adapters: Default::default(),
            written_at: 0,
        });
        for (name, adapter) in adapters {
            if adapter["status"] == "installed" && adapter["changed"] == true {
                ensure!(
                    ["folders", "chatWake", "ownerWake", "commands"].contains(&name.as_str()),
                    "Unknown renderer adapter write cannot authorize a restart."
                );
                pending.adapters.insert(name.clone());
                pending.written_at = self.environment.now();
                changed = true;
            }
        }
        let written_at = pending.written_at;
        record.pending = (!pending.adapters.is_empty()).then_some(pending);
        if changed {
            save_record(&path, &record, &mut identity)?;
        }
        if record.pending.is_none() {
            return Ok(None);
        }
        let manual = |reason: &str| json!({"state":"restart-required","entry":entry,"reason":reason,"requiredSince":written_at});
        if self.stopped()? {
            return self.report(
                &mut last,
                json!({"state":"waiting","entry":entry,"waiting":"Claudex is stopped"}),
            );
        }
        // Incomplete passes retain writes and can request a later manual
        // restart, but never initiate a quit.
        let processes = crate::relaunch::parse_processes(
            &self
                .environment
                .command("/bin/ps", &["-axo".into(), "pid=,ppid=,command=".into()])
                .await?,
        );
        fence()?;
        let mains = processes
            .iter()
            .filter(|p| p.ppid == 1 && p.command.ends_with(".app/Contents/MacOS/Claude"))
            .collect::<Vec<_>>();
        if mains.len() != 1 {
            return self.report(
                &mut last,
                if mains.is_empty() {
                    json!({"state":"not-running","entry":entry})
                } else {
                    manual("multiple Desktop processes")
                },
            );
        }
        let main = mains[0];
        let bundle = main.command.strip_suffix("/Contents/MacOS/Claude").unwrap();
        let identifier = self
            .environment
            .command(
                "/usr/bin/plutil",
                &[
                    "-extract".into(),
                    "CFBundleIdentifier".into(),
                    "raw".into(),
                    format!("{bundle}/Contents/Info.plist"),
                ],
            )
            .await?;
        fence()?;
        if identifier != BUNDLE_ID {
            return self.report(&mut last, manual("unrecognized Desktop application"));
        }
        let started = self
            .environment
            .command(
                "/bin/ps",
                &[
                    "-o".into(),
                    "lstart=".into(),
                    "-p".into(),
                    main.pid.to_string(),
                ],
            )
            .await?;
        fence()?;
        let Some(started) = started_at(&started) else {
            return self.report(&mut last, manual("Desktop start time unavailable"));
        };
        let now = self.environment.now();
        if started > now {
            return self.report(&mut last, manual("Desktop start time unavailable"));
        }
        if started > written_at {
            record.pending = None;
            save_record(&path, &record, &mut identity)?;
            return self.report(&mut last, json!({"state":"current","entry":entry}));
        }
        if summary["state"] != "ready"
            || adapters
                .values()
                .any(|a| a["status"] != "installed" && a["status"] != "disabled")
        {
            let mut value = manual("adapters still incomplete");
            value["notBefore"] = json!(started + self.window_ms);
            return self.report(&mut last, value);
        }
        if !automatic {
            return self.report(&mut last, manual("automatic restart is disabled"));
        }
        if record
            .attempts
            .iter()
            .any(|a| a.entry == entry && !matches!(a.outcome, Some(Outcome::Relaunched)))
        {
            return self.report(&mut last, manual("Desktop declined an earlier restart"));
        }
        if record
            .attempts
            .iter()
            .filter(|a| a.at >= now - 600_000)
            .count()
            >= 2
        {
            return self.report(&mut last, manual("restart limit reached"));
        }
        if now - started > self.window_ms {
            return self.report(&mut last, manual("Desktop is no longer newly started"));
        }
        let inbox = platform::optional_json(
            &self.root.join("sync-events/inbox.json"),
            2 * 1024 * 1024,
            true,
        )?
        .unwrap_or_else(|| json!({"entries":{}}));
        if inbox["entries"].as_object().is_some_and(|entries| {
            entries.values().any(|event| {
                event["side"] == "claude"
                    && event["kind"] == "started"
                    && event["at"].as_i64().is_some_and(|at| at >= started)
            })
        }) {
            return self.report(&mut last, manual("Claude activity since start"));
        }
        if self.stopped()? {
            return self.report(
                &mut last,
                json!({"state":"waiting","entry":entry,"waiting":"Claudex is stopped"}),
            );
        }
        let action_fence = || -> Result<()> {
            fence()?;
            ensure!(
                !self.stopped()?,
                "Application hold interrupted Claude relaunch."
            );
            Ok(())
        };
        action_fence()?;
        record.attempts.push(Attempt {
            entry: entry.into(),
            pid: main.pid,
            started_at: started,
            at: now,
            outcome: Some(Outcome::Quitting),
        });
        if record.attempts.len() > 8 {
            record.attempts.remove(0);
        }
        save_record(&path, &record, &mut identity)?;
        self.report(
            &mut last,
            json!({"state":"relaunching","entry":entry,"pid":main.pid}),
        )?;
        // A normal application quit may decline. It is never escalated to a signal.
        action_fence()?;
        let _ = self
            .environment
            .command(
                "/usr/bin/osascript",
                &[
                    "-e".into(),
                    format!("tell application id {BUNDLE_ID:?} to quit"),
                ],
            )
            .await;
        let deadline = self.environment.now() + self.quit_timeout_ms;
        while self.environment.now() < deadline && self.environment.alive(main.pid)? {
            action_fence()?;
            self.environment.sleep(1000).await;
        }
        action_fence()?;
        if self.environment.alive(main.pid)? {
            record.attempts.last_mut().unwrap().outcome = Some(Outcome::QuitDeclined);
            save_record(&path, &record, &mut identity)?;
            return self.report(&mut last, manual("Desktop declined to quit"));
        }
        action_fence()?;
        self.environment
            .command("/usr/bin/open", &["-b".into(), BUNDLE_ID.into()])
            .await?;
        record.pending = None;
        record.attempts.last_mut().unwrap().outcome = Some(Outcome::Relaunched);
        save_record(&path, &record, &mut identity)?;
        self.report(
            &mut last,
            json!({"state":"relaunched","entry":entry,"previousPid":main.pid}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex as StdMutex,
        atomic::{AtomicBool, AtomicI64, Ordering},
    };

    struct Fake {
        root: PathBuf,
        now: AtomicI64,
        started: AtomicI64,
        alive: AtomicBool,
        accept_quit: AtomicBool,
        fail_open: AtomicBool,
        calls: StdMutex<Vec<String>>,
    }
    impl Fake {
        fn new(root: PathBuf) -> Self {
            Self {
                root,
                now: AtomicI64::new(1_700_000_010_000),
                started: AtomicI64::new(1_700_000_000_000),
                alive: AtomicBool::new(true),
                accept_quit: AtomicBool::new(true),
                fail_open: AtomicBool::new(false),
                calls: StdMutex::new(vec![]),
            }
        }
        fn count(&self, program: &str) -> usize {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|p| p.as_str() == program)
                .count()
        }
    }
    #[async_trait]
    impl Environment for Fake {
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
        fn alive(&self, _: u32) -> Result<bool> {
            Ok(self.alive.load(Ordering::SeqCst))
        }
        async fn command(&self, program: &str, args: &[String]) -> Result<String> {
            self.calls.lock().unwrap().push(program.into());
            match program {
                "/bin/ps" if args[0] == "-axo" => Ok("41 1 /Applications/Claude.app/Contents/MacOS/Claude\n42 41 /native/claude --resume synthetic\n".into()),
                "/bin/ps" => Ok(Local.timestamp_millis_opt(self.started.load(Ordering::SeqCst)).single().unwrap().format("%a %b %e %T %Y").to_string()),
                "/usr/bin/plutil" => Ok(BUNDLE_ID.into()),
                "/usr/bin/osascript" => {
                    let (record,_) = read_record(&self.root.join("claude-relaunch.json"))?;
                    assert!(matches!(record.attempts.last().unwrap().outcome, Some(Outcome::Quitting)));
                    assert_eq!(args, ["-e", "tell application id \"com.anthropic.claudefordesktop\" to quit"]);
                    if self.accept_quit.load(Ordering::SeqCst) { self.alive.store(false, Ordering::SeqCst); }
                    Ok(String::new())
                }
                "/usr/bin/open" => {
                    ensure!(!self.fail_open.load(Ordering::SeqCst), "Synthetic unconfirmed open outcome.");
                    Ok(String::new())
                }
                _ => anyhow::bail!("Unexpected native command in isolated test."),
            }
        }
        async fn sleep(&self, ms: u64) {
            self.now.fetch_add(ms as i64, Ordering::SeqCst);
        }
    }
    fn profile() -> Result<(tempfile::TempDir, PathBuf, Arc<Fake>, Controller)> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = storage::private_directory(temp.path().canonicalize()?)?;
        let environment = Arc::new(Fake::new(root.clone()));
        let controller = Controller::new(root.clone(), environment.clone())?;
        Ok((temp, root, environment, controller))
    }
    fn pass(changed: bool) -> Value {
        json!({"state":"ready","entry":{"asset":"index-synthetic.js"},"adapters":{
            "folders":{"status":"disabled"},"chatWake":{"status":"installed","changed":changed},
            "ownerWake":{"status":"installed","changed":false},"commands":{"status":"installed","changed":false}}})
    }
    #[tokio::test]
    async fn freshly_written_complete_adapters_use_one_journaled_normal_restart() -> Result<()> {
        let (_temp, root, env, controller) = profile()?;
        let report = controller.consider(&pass(true), true).await?.unwrap();
        assert_eq!(report["state"], "relaunched");
        assert_eq!(env.count("/usr/bin/osascript"), 1);
        assert_eq!(env.count("/usr/bin/open"), 1);
        let record = read_record(&root.join("claude-relaunch.json"))?.0;
        assert!(record.pending.is_none());
        assert!(matches!(
            record.attempts[0].outcome,
            Some(Outcome::Relaunched)
        ));
        assert!(controller.consider(&pass(false), true).await?.is_none());
        assert_eq!(env.count("/usr/bin/osascript"), 1);
        Ok(())
    }
    #[tokio::test]
    async fn declined_or_unrecorded_quit_is_not_replayed_after_controller_restart() -> Result<()> {
        for decline in [true, false] {
            let (_temp, root, env, controller) = profile()?;
            env.accept_quit.store(!decline, Ordering::SeqCst);
            env.fail_open.store(!decline, Ordering::SeqCst);
            let result = controller.consider(&pass(true), true).await;
            if decline {
                assert_eq!(result?.unwrap()["reason"], "Desktop declined to quit");
            } else {
                assert!(result.is_err());
            }
            let restored = Controller::new(root, env.clone())?;
            // Give the fake Desktop the same original process; no second quit
            // or open is allowed even if a later observer sees it as idle.
            let status = restored.consider(&pass(false), true).await?.unwrap();
            assert_eq!(status["reason"], "Desktop declined an earlier restart");
            assert_eq!(env.count("/usr/bin/osascript"), 1);
            assert_eq!(env.count("/usr/bin/open"), usize::from(!decline));
        }
        Ok(())
    }
    #[tokio::test]
    async fn hold_activity_old_start_and_disabled_automation_never_quit() -> Result<()> {
        let (_temp, root, env, controller) = profile()?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        assert_eq!(
            controller.consider(&pass(true), true).await?.unwrap()["state"],
            "waiting"
        );
        assert_eq!(env.count("/bin/ps"), 0);
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )?;
        assert_eq!(
            controller.consider(&pass(false), false).await?.unwrap()["reason"],
            "automatic restart is disabled"
        );
        storage::private_directory(root.join("sync-events"))?;
        storage::write_json(
            root.join("sync-events/inbox.json"),
            &json!({"entries":{"one":{"side":"claude","kind":"started","at":env.now()}}}),
        )?;
        assert_eq!(
            controller.consider(&pass(false), true).await?.unwrap()["reason"],
            "Claude activity since start"
        );
        env.now.fetch_add(61_000, Ordering::SeqCst);
        assert_eq!(
            controller.consider(&pass(false), true).await?.unwrap()["reason"],
            "Desktop is no longer newly started"
        );
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        assert_eq!(env.count("/usr/bin/open"), 0);
        Ok(())
    }
    #[tokio::test]
    async fn partial_writes_survive_watcher_restart_and_new_native_start_settles_them() -> Result<()>
    {
        let (_temp, root, env, controller) = profile()?;
        let mut partial = pass(true);
        partial["state"] = json!("degraded");
        partial["adapters"]["commands"]["status"] = json!("skipped");
        let status = controller.consider(&partial, true).await?.unwrap();
        assert_eq!(status["reason"], "adapters still incomplete");
        assert!(status["notBefore"].is_i64());
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        let written = read_record(&root.join("claude-relaunch.json"))?
            .0
            .pending
            .unwrap()
            .written_at;
        let restored = Controller::new(root.clone(), env.clone())?;
        env.started.store(written + 1000, Ordering::SeqCst);
        env.now.store(written + 2000, Ordering::SeqCst);
        assert_eq!(
            restored.consider(&pass(false), true).await?.unwrap()["state"],
            "current"
        );
        assert!(
            read_record(&root.join("claude-relaunch.json"))?
                .0
                .pending
                .is_none()
        );
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        Ok(())
    }
    #[tokio::test]
    async fn lifecycle_close_fences_native_actions_and_never_replays_an_interrupted_quit()
    -> Result<()> {
        let (_temp, root, env, controller) = profile()?;
        let result = controller
            .consider_fenced(&pass(true), true, &|| {
                ensure!(
                    env.count("/bin/ps") < 2,
                    "Synthetic close before native action."
                );
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        assert!(
            read_record(&root.join("claude-relaunch.json"))?
                .0
                .pending
                .is_some()
        );
        let result = controller
            .consider_fenced(&pass(false), true, &|| {
                ensure!(
                    env.count("/usr/bin/osascript") == 0,
                    "Synthetic close after normal quit."
                );
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(env.count("/usr/bin/osascript"), 1);
        assert_eq!(env.count("/usr/bin/open"), 0);
        let restored = Controller::new(root, env.clone())?;
        assert_eq!(
            restored.consider(&pass(false), true).await?.unwrap()["reason"],
            "Desktop declined an earlier restart"
        );
        assert_eq!(env.count("/usr/bin/osascript"), 1);
        assert_eq!(env.count("/usr/bin/open"), 0);
        Ok(())
    }
    #[tokio::test]
    async fn app_hold_after_normal_quit_keeps_uncertain_outcome_without_reopening() -> Result<()> {
        let (_temp, root, env, controller) = profile()?;
        let result = controller
            .consider_fenced(&pass(true), true, &|| {
                if env.count("/usr/bin/osascript") > 0 {
                    storage::write_json(
                        root.join("app-stop.json"),
                        &json!({"version":1,"stopped":true}),
                    )?;
                }
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(env.count("/usr/bin/osascript"), 1);
        assert_eq!(env.count("/usr/bin/open"), 0);
        assert!(matches!(
            read_record(&root.join("claude-relaunch.json"))?.0.attempts[0].outcome,
            Some(Outcome::Quitting)
        ));
        Ok(())
    }
    #[tokio::test]
    async fn two_recent_restarts_and_foreign_journals_refuse() -> Result<()> {
        let (_temp, root, env, controller) = profile()?;
        let attempts = (0..2)
            .map(|n| Attempt {
                entry: format!("index-old-{n}.js"),
                pid: 10 + n,
                started_at: env.now() - 2000,
                at: env.now() - 1000,
                outcome: Some(Outcome::Relaunched),
            })
            .collect();
        let record = Record {
            version: 1,
            attempts,
            pending: None,
        };
        platform::write_json(
            &root.join("claude-relaunch.json"),
            &serde_json::to_value(record)?,
        )?;
        assert_eq!(
            controller.consider(&pass(true), true).await?.unwrap()["reason"],
            "restart limit reached"
        );
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        platform::write_json(
            &root.join("claude-relaunch.json"),
            &json!({"version":9,"attempts":[]}),
        )?;
        assert!(controller.consider(&pass(false), true).await.is_err());
        assert_eq!(env.count("/usr/bin/osascript"), 0);
        Ok(())
    }
}
