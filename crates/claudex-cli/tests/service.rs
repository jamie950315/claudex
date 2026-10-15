use anyhow::Result;
use claudex_cli::service::*;
use claudex_core::storage::*;
use serde_json::json;
use std::sync::Mutex;
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

struct Probe {
    live: Vec<u32>,
    born: Option<i64>,
    orphans: Vec<Orphan>,
}
impl ProcessInspector for Probe {
    fn alive(&self, pid: u32) -> Result<bool> {
        Ok(self.live.contains(&pid))
    }
    fn started_at(&self, _: u32) -> Option<i64> {
        self.born
    }
    fn orphans(&self) -> Result<Vec<Orphan>> {
        Ok(self.orphans.clone())
    }
}
fn dead() -> Probe {
    Probe {
        live: vec![],
        born: None,
        orphans: vec![],
    }
}

#[test]
fn supervisor_backoff_is_bounded() {
    let delays = (1..=7)
        .map(|n| restart_delay(n).as_millis())
        .collect::<Vec<_>>();
    assert_eq!(delays, vec![5000, 10000, 20000, 40000, 60000, 60000, 60000]);
}

#[test]
fn preflight_preserves_live_malformed_and_unrecorded_native_owners() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    let owners = root.join("owners");
    private_directory(&owners)?;
    let lock = owners.join(format!("{}.json.lock", "a".repeat(64)));
    write_json(
        &lock,
        &json!({"pid":100,"nonce":"00000000-0000-4000-8000-000000000001","childPid":200}),
    )?;
    let before = fs::read(&lock)?;
    let live = Probe {
        live: vec![200],
        born: None,
        orphans: vec![],
    };
    let result = inspect_start(root, false, &live, now_ms())?;
    assert!(!result.allowed);
    assert_eq!(result.blockers[0].code, "live-native-child");
    assert_eq!(fs::read(&lock)?, before);
    assert!(inspect_start(root, false, &dead(), now_ms())?.allowed);
    write_json(
        &lock,
        &json!({"pid":100,"nonce":"00000000-0000-4000-8000-000000000001","childPid":null}),
    )?;
    let orphan = Probe {
        live: vec![],
        born: None,
        orphans: vec![Orphan {
            pid: 300,
            started_at: now_ms(),
            command: "/placeholder/claude".into(),
        }],
    };
    assert_eq!(
        inspect_start(root, false, &orphan, now_ms())?.blockers[0].code,
        "unrecorded-native-child"
    );
    assert!(inspect_start(root, false, &dead(), now_ms())?.allowed);
    write_json(&lock, &json!({"pid":0}))?;
    assert_eq!(
        inspect_start(root, false, &dead(), now_ms())?.blockers[0].code,
        "malformed-lock"
    );
    Ok(())
}

#[test]
fn reused_pids_and_old_empty_locks_do_not_block_safe_start() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    let path = root.join("watch.lock");
    let now = now_ms();
    write_json(
        &path,
        &json!({"pid":100,"started":chrono::Utc::now().to_rfc3339()}),
    )?;
    let reused = Probe {
        live: vec![100],
        born: Some(now + 10000),
        orphans: vec![],
    };
    assert!(inspect_start(root, false, &reused, now)?.allowed);
    let unknown = Probe {
        live: vec![100],
        born: None,
        orphans: vec![],
    };
    assert!(!inspect_start(root, false, &unknown, now)?.allowed);
    fs::write(&path, "")?;
    assert!(!inspect_start(root, false, &dead(), now)?.allowed);
    assert!(inspect_start(root, false, &dead(), now + 61000)?.allowed);
    Ok(())
}

#[tokio::test]
async fn real_synthetic_watcher_exit_preserves_pending_bytes() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("root");
    private_directory(&root)?;
    let pending = root.join("desktop-state.json");
    let bytes = b"{\"version\":2,\"pending\":{\"phase\":\"requested\"}}\n";
    fs::write(&pending, bytes)?;
    let cli = temp.path().join("synthetic-watcher");
    fs::write(&cli, "#!/bin/sh\nexit 0\n")?;
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))?;
    let (_send, receive) = tokio::sync::watch::channel(false);
    let mut options = SupervisorOptions::new(root.clone(), cli);
    options.heartbeat = Duration::from_millis(5);
    let result = supervise(options, receive).await?;
    assert_eq!(result["state"], "stopped");
    assert_eq!(result["restartCount"], 0);
    assert_eq!(fs::read(pending)?, bytes);
    assert!(!root.join("service-supervisor.lock").exists());
    Ok(())
}

struct LaunchState {
    loaded: bool,
    bootstrap_works: bool,
    foreign: bool,
    calls: Vec<Vec<String>>,
}
struct LaunchFixture {
    options: ServiceOptions,
    state: Mutex<LaunchState>,
}
#[async_trait::async_trait]
impl CommandRunner for LaunchFixture {
    async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(
            std::iter::once(program.into())
                .chain(args.iter().cloned())
                .collect(),
        );
        if program == "plutil" {
            return Ok(CommandOutput {
                success: true,
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        match args.first().map(String::as_str) {
            Some("bootstrap") => {
                state.loaded = state.bootstrap_works;
                Ok(CommandOutput {
                    success: true,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
            Some("bootout") => {
                state.loaded = false;
                Ok(CommandOutput {
                    success: true,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
            Some("print") if !state.loaded => Ok(CommandOutput {
                success: false,
                stdout: String::new(),
                stderr: "Could not find service".into(),
            }),
            Some("print") => {
                let desired = definition(&self.options)?;
                let contents = fs::read_to_string(&desired.path).unwrap_or_default();
                let journal =
                    read_json_or(self.options.root.join("service-install.json"), json!(null))?;
                let actual = owned_definition(
                    &contents,
                    &self.options,
                    journal["cli"].as_str().map(std::path::Path::new),
                )?
                .unwrap_or(desired);
                let path = if state.foreign {
                    "/foreign/job.plist"
                } else {
                    actual.path.to_str().unwrap()
                };
                Ok(CommandOutput {
                    success: true,
                    stdout: format!(
                        "path = {path}\nprogram = {}\narguments = {{\n{}\n}}\nstate = running\n",
                        actual.args[0],
                        actual.args.join("\n")
                    ),
                    stderr: String::new(),
                })
            }
            _ => anyhow::bail!("unexpected synthetic command"),
        }
    }
}
fn launch_fixture(root: &std::path::Path) -> Result<LaunchFixture> {
    let private = root.join("private");
    private_directory(&private)?;
    Ok(LaunchFixture {
        options: ServiceOptions {
            root: private,
            cli: root.join("engine/bin/claudex"),
            home: root.join("home"),
            environment_path: "/placeholder/bin:/usr/bin:/bin".into(),
        },
        state: Mutex::new(LaunchState {
            loaded: false,
            bootstrap_works: true,
            foreign: false,
            calls: vec![],
        }),
    })
}

#[tokio::test]
async fn install_is_journaled_and_idempotent_and_stop_preserves_login_definition() -> Result<()> {
    let root = tempfile::tempdir()?;
    let f = launch_fixture(root.path())?;
    let result = install(&f.options, &f, &dead()).await?;
    assert_eq!(result["autoRestart"], true);
    let definition = definition(&f.options)?;
    let before = fs::read(&definition.path)?;
    install(&f.options, &f, &dead()).await?;
    assert_eq!(
        f.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|args| args.get(1).is_some_and(|v| v == "bootstrap"))
            .count(),
        1
    );
    assert_eq!(
        read_json(f.options.root.join("service-install.json"))?["phase"],
        "installed"
    );
    let result = control("stop", &f.options, &f, &dead()).await?;
    assert_eq!(result["shutdownRequested"], true);
    assert_eq!(fs::read(&definition.path)?, before);
    assert!(!f.state.lock().unwrap().loaded);
    Ok(())
}

#[tokio::test]
async fn foreign_loaded_jobs_are_never_adopted_stopped_or_reported_as_ours() -> Result<()> {
    let root = tempfile::tempdir()?;
    let f = launch_fixture(root.path())?;
    install(&f.options, &f, &dead()).await?;
    f.state.lock().unwrap().foreign = true;
    for action in ["status", "start", "stop", "uninstall"] {
        assert!(control(action, &f.options, &f, &dead()).await.is_err());
    }
    assert!(
        !f.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|args| args.get(1).is_some_and(|v| v == "bootout"))
    );
    assert!(definition(&f.options)?.path.exists());
    Ok(())
}

#[tokio::test]
async fn bootstrap_without_loaded_proof_remains_recoverable_and_changed_prepared_state_is_preserved()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let f = launch_fixture(root.path())?;
    f.state.lock().unwrap().bootstrap_works = false;
    assert!(install(&f.options, &f, &dead()).await.is_err());
    let definition = definition(&f.options)?;
    let journal = read_json(f.options.root.join("service-install.json"))?;
    assert_eq!(journal["phase"], "prepared");
    let changed = format!("{}<!-- foreign edit -->", definition.plist);
    atomic_write(&definition.path, &changed)?;
    f.state.lock().unwrap().bootstrap_works = true;
    assert!(install(&f.options, &f, &dead()).await.is_err());
    assert_eq!(fs::read_to_string(&definition.path)?, changed);
    assert_eq!(
        read_json(f.options.root.join("service-install.json"))?,
        journal
    );
    Ok(())
}

#[test]
fn definition_keeps_native_process_groups_and_exact_legacy_recognition() -> Result<()> {
    let root = tempfile::tempdir()?;
    let f = launch_fixture(root.path())?;
    let d = definition(&f.options)?;
    assert!(d.plist.contains("<key>AbandonProcessGroup</key><true/>"));
    assert_eq!(d.args[1], "service-supervise");
    assert!(owned_definition(&(d.plist.clone() + "<!-- foreign -->"), &f.options, None)?.is_none());
    let legacy_cli = root.path().join("old/bin/claudex.mjs");
    let old_args = format!(
        "<string>/old/node</string><string>{}</string><string>watch</string><string>--root</string><string>{}</string>",
        legacy_cli.display(),
        f.options.root.display()
    );
    let start = d.plist.find("<key>ProgramArguments</key><array>").unwrap()
        + "<key>ProgramArguments</key><array>".len();
    let end = d.plist[start..].find("</array>").unwrap() + start;
    let mut legacy = d.plist.clone();
    legacy.replace_range(start..end, &old_args);
    legacy=legacy.replace("<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>AbandonProcessGroup</key><true/>","<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>");
    assert!(owned_definition(&legacy, &f.options, None)?.is_none());
    assert!(owned_definition(&legacy, &f.options, Some(&legacy_cli))?.is_some());
    Ok(())
}
