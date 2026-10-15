//! A guarded, once-per-process normal restart after login bypassed the launcher.
use crate::{
    desktop::InstalledLauncher,
    service::{CommandRunner, ProcessInspector},
};
use anyhow::{Context, Result, bail, ensure};
use chrono::{Datelike, Local, TimeZone};
use claudex_core::storage::*;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
}
pub fn parse_processes(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(char::is_whitespace)?;
            let (ppid, command) = rest.trim_start().split_once(char::is_whitespace)?;
            Some(Process {
                pid: pid.parse().ok()?,
                ppid: ppid.parse().ok()?,
                command: command.trim_start().into(),
            })
        })
        .collect()
}
fn primary(command: &str) -> bool {
    let args: Vec<_> = command.split_whitespace().collect();
    args.contains(&"app-server")
        && !args
            .iter()
            .any(|a| *a == "--listen" || a.starts_with("--listen="))
}
pub fn classify(processes: &[Process], executable: &Path, launcher: &InstalledLauncher) -> Value {
    let mains: Vec<_> = processes
        .iter()
        .filter(|p| p.command == executable.to_string_lossy())
        .collect();
    if mains.is_empty() {
        return json!({"state":"not-running"});
    }
    if mains.len() > 1 {
        return json!({"state":"unknown","reason":"multiple Desktop processes"});
    }
    let pid = mains[0].pid;
    let children: Vec<_> = processes
        .iter()
        .filter(|p| p.ppid == pid && primary(&p.command))
        .collect();
    let mut host = format!(
        "{} {} ",
        launcher.node.display(),
        launcher.launcher.display()
    );
    if let Some(engine) = &launcher.engine {
        host.push_str(&format!("{} ", engine.display()));
    }
    if children.iter().any(|p| p.command.starts_with(&host)) {
        return json!({"state":"shared","pid":pid});
    }
    if children.iter().any(|p| {
        p.command
            .starts_with(&format!("{} ", launcher.binary.display()))
    }) {
        return json!({"state":"bypassed","pid":pid});
    }
    json!({"state":"unknown","pid":pid,"reason":"Desktop backend not started yet"})
}
async fn text(runner: &dyn CommandRunner, program: &str, args: Vec<String>) -> Result<String> {
    let result = runner.run(program, &args).await?;
    ensure!(result.success, "Desktop relaunch inspection failed.");
    Ok(result.stdout.trim().into())
}
fn recent_rollout(home: &Path, since: i64, now: i64) -> Result<bool> {
    for offset in [0, 1] {
        let day = Local
            .timestamp_millis_opt(now - offset * 86_400_000)
            .single()
            .context("Invalid relaunch time")?;
        let path = home
            .join("sessions")
            .join(day.year().to_string())
            .join(format!("{:02}", day.month()))
            .join(format!("{:02}", day.day()));
        let entries = match fs::read_dir(path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        for (i, entry) in entries.enumerate() {
            ensure!(
                i < 100_000,
                "Native rollout directory exceeds bounded activity inspection."
            );
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".jsonl") && !name.ends_with(".jsonl.zst") {
                continue;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "Native activity path is unsafe."
            );
            use std::os::unix::fs::MetadataExt;
            if metadata.mtime() * 1000 + metadata.mtime_nsec() / 1_000_000 >= since {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub struct Options {
    pub root: PathBuf,
    pub codex_home: PathBuf,
    pub quiet: Duration,
    pub quit_timeout: Duration,
    pub poll: Duration,
}
impl Options {
    pub fn new(root: PathBuf, codex_home: PathBuf) -> Self {
        Self {
            root,
            codex_home,
            quiet: Duration::from_secs(60),
            quit_timeout: Duration::from_secs(60),
            poll: Duration::from_secs(1),
        }
    }
}
fn report(root: &Path, value: Value) -> Result<Value> {
    let mut status = value.clone();
    status["updatedAt"] = json!(now_ms());
    write_diagnostic_json(root.join("desktop-relaunch-status.json"), &status)?;
    Ok(value)
}
async fn process_state(
    runner: &dyn CommandRunner,
    executable: &Path,
    launcher: &InstalledLauncher,
) -> Result<Value> {
    Ok(classify(
        &parse_processes(
            &text(
                runner,
                "/bin/ps",
                vec!["-axo".into(), "pid=,ppid=,command=".into()],
            )
            .await?,
        ),
        executable,
        launcher,
    ))
}
pub async fn check(
    options: &Options,
    runner: &dyn CommandRunner,
    probe: &dyn ProcessInspector,
) -> Result<Value> {
    check_fenced(options, runner, probe, &|| Ok(())).await
}
/// Shutdown fences preserve a write-ahead quit outcome rather than reopening
/// an application after this watcher's native-action lease has ended.
pub async fn check_fenced(
    options: &Options,
    runner: &dyn CommandRunner,
    probe: &dyn ProcessInspector,
    fence: &(dyn Fn() -> Result<()> + Send + Sync),
) -> Result<Value> {
    fence()?;
    let root = &options.root;
    if claudex_sync::hooks::app_stopped(root)? {
        return report(root, json!({"state":"stopped"}));
    }
    let Some(launcher) = crate::desktop::installed_launcher(root)? else {
        return report(root, json!({"state":"not-installed"}));
    };
    let bundle = claudex_core::codex_layout::codex_app_bundle(&launcher.binary)
        .context("Codex binary is not inside an observed application bundle.")?;
    let info = bundle.join("Contents/Info.plist");
    let info = info.to_str().context("Invalid app metadata path")?;
    let id = text(
        runner,
        "/usr/bin/plutil",
        vec![
            "-extract".into(),
            "CFBundleIdentifier".into(),
            "raw".into(),
            info.into(),
        ],
    )
    .await?;
    ensure!(
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
        "Invalid Desktop application identity."
    );
    let name = text(
        runner,
        "/usr/bin/plutil",
        vec![
            "-extract".into(),
            "CFBundleExecutable".into(),
            "raw".into(),
            info.into(),
        ],
    )
    .await?;
    ensure!(
        !name.is_empty() && !name.contains(['/', '\0', '\n', '\r']) && name != "." && name != "..",
        "Invalid Desktop executable name."
    );
    let executable = bundle.join("Contents/MacOS").join(name);
    let desktop = process_state(runner, &executable, &launcher).await?;
    if desktop["state"] != "bypassed" {
        return report(root, desktop);
    }
    let pid = desktop["pid"]
        .as_u64()
        .context("Missing Desktop process identity")? as u32;
    let waiting = |reason: &str| {
        let mut value = desktop.clone();
        value["waiting"] = json!(reason);
        value
    };
    if text(
        runner,
        "/bin/launchctl",
        vec!["getenv".into(), "CODEX_CLI_PATH".into()],
    )
    .await?
        != launcher.shim.to_string_lossy()
    {
        return report(root, waiting("launcher override is not active"));
    }
    let Some(started_at) = probe.started_at(pid) else {
        return report(root, waiting("Desktop start time unavailable"));
    };
    let record_path = root.join("desktop-relaunch.json");
    let previous = read_json_or(&record_path, Value::Null)?;
    if previous["pid"] == pid && previous["startedAt"] == started_at {
        return report(
            root,
            json!({"state":"relaunch-failed","pid":pid,"outcome":previous["outcome"]}),
        );
    }
    let inbox = claudex_sync::events::Inbox::new(root)?.read()?;
    if inbox.entries.values().any(|e| {
        e.event.side == claudex_sync::bridge::Side::Codex
            && e.event.kind == claudex_sync::events::Kind::Started
            && e.at >= started_at
    }) || recent_rollout(
        &options.codex_home,
        now_ms() - options.quiet.as_millis() as i64,
        now_ms(),
    )? {
        return report(root, waiting("Codex activity"));
    }
    if claudex_sync::hooks::app_stopped(root)?
        || probe.started_at(pid) != Some(started_at)
        || process_state(runner, &executable, &launcher).await? != desktop
    {
        return report(root, waiting("Desktop lifecycle changed"));
    }
    let action_fence = || -> Result<()> {
        fence()?;
        ensure!(
            !claudex_sync::hooks::app_stopped(root)?,
            "Application hold interrupted Desktop relaunch."
        );
        Ok(())
    };
    action_fence()?;
    write_json(
        &record_path,
        &json!({"pid":pid,"startedAt":started_at,"at":now_ms(),"outcome":"quitting"}),
    )?;
    report(root, json!({"state":"relaunching","pid":pid}))?;
    action_fence()?;
    let _ = runner
        .run(
            "/usr/bin/osascript",
            &[
                "-e".into(),
                format!(
                    "tell application id {} to quit",
                    serde_json::to_string(&id)?
                ),
            ],
        )
        .await;
    action_fence()?;
    let deadline = tokio::time::Instant::now() + options.quit_timeout;
    while tokio::time::Instant::now() < deadline
        && probe.alive(pid)?
        && probe.started_at(pid) == Some(started_at)
    {
        action_fence()?;
        tokio::time::sleep(options.poll).await;
    }
    action_fence()?;
    if probe.alive(pid)? && probe.started_at(pid) == Some(started_at) {
        write_json(
            &record_path,
            &json!({"pid":pid,"startedAt":started_at,"at":now_ms(),"outcome":"quit-declined"}),
        )?;
        return report(
            root,
            json!({"state":"relaunch-failed","pid":pid,"outcome":"quit-declined"}),
        );
    }
    action_fence()?;
    let opened = runner
        .run("/usr/bin/open", &["-g".into(), "-b".into(), id])
        .await?;
    if !opened.success {
        bail!("Desktop normal reopening failed; no retry was started.");
    }
    write_json(
        &record_path,
        &json!({"pid":pid,"startedAt":started_at,"at":now_ms(),"outcome":"relaunched"}),
    )?;
    report(root, json!({"state":"relaunched","previousPid":pid}))
}
pub async fn monitor(options: Options, mut stop: watch::Receiver<bool>) -> Result<()> {
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let closed = stop.clone();
        let fence = || -> Result<()> {
            ensure!(!*closed.borrow(), "Desktop relaunch monitor is closed.");
            Ok(())
        };
        if check_fenced(
            &options,
            &crate::service::NativeCommands,
            &crate::service::NativeProcesses,
            &fence,
        )
        .await
        .is_err()
        {
            if *stop.borrow() {
                return Ok(());
            }
            report(
                &options.root,
                json!({"state":"error","code":"CLAUDEX_DESKTOP_RELAUNCH_UNAVAILABLE"}),
            )?;
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(15))=>(),changed=stop.changed()=>if changed.is_err(){return Ok(());}}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        desktop::{self, InstallOptions},
        service::{CommandOutput, Orphan},
    };
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    struct Accept;
    #[async_trait::async_trait]
    impl claudex_core::codex_layout::BinaryVerifier for Accept {
        async fn verify(&self, _: &Path, _: &str) -> Result<()> {
            Ok(())
        }
    }
    struct Native {
        environment: Mutex<String>,
        processes: Mutex<String>,
        calls: Mutex<Vec<String>>,
        alive: AtomicBool,
        decline: bool,
    }
    impl ProcessInspector for Native {
        fn alive(&self, _: u32) -> Result<bool> {
            Ok(self.alive.load(Ordering::SeqCst))
        }
        fn started_at(&self, _: u32) -> Option<i64> {
            Some(1_000)
        }
        fn orphans(&self) -> Result<Vec<Orphan>> {
            Ok(vec![])
        }
    }
    #[async_trait::async_trait]
    impl CommandRunner for Native {
        async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput> {
            self.calls.lock().unwrap().push(program.into());
            let value = match (program, args.first().map(String::as_str)) {
                ("launchctl", Some("getenv")) | ("/bin/launchctl", Some("getenv")) => {
                    self.environment.lock().unwrap().clone()
                }
                ("launchctl", Some("setenv")) => {
                    *self.environment.lock().unwrap() = args[2].clone();
                    String::new()
                }
                ("/usr/bin/plutil", _) => {
                    if args[1] == "CFBundleIdentifier" {
                        "com.openai.codex".into()
                    } else {
                        "Codex".into()
                    }
                }
                ("/bin/ps", _) => self.processes.lock().unwrap().clone(),
                ("/usr/bin/osascript", _) => {
                    if !self.decline {
                        self.alive.store(false, Ordering::SeqCst);
                    }
                    String::new()
                }
                ("/usr/bin/open", _) => String::new(),
                _ => bail!("Unexpected relaunch operation"),
            };
            Ok(CommandOutput {
                success: true,
                stdout: value,
                stderr: String::new(),
            })
        }
    }
    async fn fixture(temp: &Path, decline: bool) -> Result<(Options, Native)> {
        let root = fs::canonicalize(temp)?;
        let binary = root.join("Example.app/Contents/Resources/codex");
        let node = root.join("Example.app/Contents/Resources/cua_node/bin/node");
        let engine = root.join("engine");
        for p in [&binary, &node, &engine] {
            fs::create_dir_all(p.parent().unwrap())?;
            fs::write(p, "#!/bin/sh\nexit 0\n")?;
            fs::set_permissions(p, fs::Permissions::from_mode(0o700))?;
        }
        let state = private_directory(root.join("state"))?;
        let native = Native {
            environment: Mutex::default(),
            processes: Mutex::new(format!(
                "10 1 {}/Example.app/Contents/MacOS/Codex\n11 10 {} app-server --analytics-default-enabled\n",
                root.display(),
                binary.display()
            )),
            calls: Mutex::default(),
            alive: AtomicBool::new(true),
            decline,
        };
        desktop::install(
            &InstallOptions {
                root: state.clone(),
                engine,
                binary,
                node: Some(node),
            },
            &native,
            &Accept,
        )
        .await?;
        let mut options = Options::new(state, root.join("native-home"));
        options.quit_timeout = Duration::from_millis(5);
        options.poll = Duration::from_millis(1);
        Ok((options, native))
    }
    #[tokio::test]
    async fn bypassed_process_is_quit_normally_and_refused_quit_is_never_forced_or_retried()
    -> Result<()> {
        for decline in [false, true] {
            let temp = tempfile::tempdir()?;
            let (options, native) = fixture(temp.path(), decline).await?;
            let result = check(&options, &native, &native).await?;
            assert_eq!(
                result["state"],
                if decline {
                    "relaunch-failed"
                } else {
                    "relaunched"
                }
            );
            assert_eq!(
                check(&options, &native, &native).await?["state"],
                "relaunch-failed"
            );
            let calls = native.calls.lock().unwrap();
            assert_eq!(
                calls
                    .iter()
                    .filter(|p| p.as_str() == "/usr/bin/osascript")
                    .count(),
                1
            );
            assert_eq!(
                calls
                    .iter()
                    .filter(|p| p.as_str() == "/usr/bin/open")
                    .count(),
                usize::from(!decline)
            );
        }
        Ok(())
    }
    #[tokio::test]
    async fn current_native_activity_and_app_hold_defer_without_quitting() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (options, native) = fixture(temp.path(), false).await?;
        let inbox = claudex_sync::events::Inbox::new(&options.root)?;
        inbox
            .publish(claudex_sync::events::Event {
                side: claudex_sync::bridge::Side::Codex,
                native_id: "00000000-0000-4000-8000-000000000001".into(),
                kind: claudex_sync::events::Kind::Started,
                turn_id: None,
                remote_id: None,
            })
            .await?;
        assert_eq!(
            check(&options, &native, &native).await?["waiting"],
            "Codex activity"
        );
        write_json(
            options.root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        assert_eq!(check(&options, &native, &native).await?["state"], "stopped");
        assert!(
            !native
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/usr/bin/osascript")
        );
        Ok(())
    }
    struct Closing<'a> {
        native: &'a Native,
        closed: &'a AtomicBool,
        after_quit: bool,
    }
    #[async_trait::async_trait]
    impl CommandRunner for Closing<'_> {
        async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput> {
            let result = self.native.run(program, args).await;
            if self.after_quit && program == "/usr/bin/osascript"
                || !self.after_quit && program == "/bin/ps"
            {
                self.closed.store(true, Ordering::SeqCst);
            }
            result
        }
    }
    #[tokio::test]
    async fn shutdown_before_or_after_quit_never_reopens_or_replays() -> Result<()> {
        for after_quit in [false, true] {
            let temp = tempfile::tempdir()?;
            let (options, native) = fixture(temp.path(), false).await?;
            let closed = AtomicBool::new(false);
            let runner = Closing {
                native: &native,
                closed: &closed,
                after_quit,
            };
            let fence = || -> Result<()> {
                ensure!(
                    !closed.load(Ordering::SeqCst),
                    "Closed native-action lease."
                );
                Ok(())
            };
            assert!(
                check_fenced(&options, &runner, &native, &fence)
                    .await
                    .is_err()
            );
            let previous = read_json_or(options.root.join("desktop-relaunch.json"), Value::Null)?;
            if after_quit {
                assert_eq!(previous["outcome"], "quitting");
                // A new watch never replays an uncertain normal Quit.
                assert_eq!(
                    check(&options, &native, &native).await?["state"],
                    "relaunch-failed"
                );
            } else {
                assert!(previous.is_null());
            }
            let calls = native.calls.lock().unwrap();
            assert_eq!(
                calls
                    .iter()
                    .filter(|p| p.as_str() == "/usr/bin/osascript")
                    .count(),
                usize::from(after_quit)
            );
            assert!(!calls.iter().any(|p| p == "/usr/bin/open"));
        }
        Ok(())
    }
    #[test]
    fn signed_host_is_shared_while_auxiliary_stdio_is_not_an_owner() {
        let launcher = InstalledLauncher {
            shim: "/root/codex-launcher".into(),
            binary: "/app/codex".into(),
            node: "/app/node".into(),
            launcher: "/root/codex-host.mjs".into(),
            engine: Some("/engine/claudex".into()),
        };
        for (command, state) in [
            (
                "/app/node /root/codex-host.mjs /engine/claudex app-server --analytics",
                "shared",
            ),
            ("/app/codex app-server --analytics", "bypassed"),
            ("/app/codex app-server --listen stdio://", "unknown"),
        ] {
            let processes = parse_processes(&format!("10 1 /app/Main\n11 10 {command}\n"));
            assert_eq!(
                classify(&processes, Path::new("/app/Main"), &launcher)["state"],
                state
            );
        }
    }
}
