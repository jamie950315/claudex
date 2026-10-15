use crate::args::{Args, home};
use anyhow::{Context, Result, bail};
use claudex_core::{storage::*, version::VersionPolicy};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

pub const HELP:&str="Claudex: bounded conversation synchronization and opt-in model collaboration

  claudex init [--all-projects | --project PATH] [--codex-home PATH] [--claude-home PATH]
  claudex track --from codex|claude --source PATH [--title TITLE]
  claudex sync CONVERSATION_ID [--from codex|claude]
  claudex watch                    Event-driven conversation synchronization
  claudex hooks install|status     Native completion hooks (no inference)
  claudex status                   Current identities, pending work and diagnostics
  claudex gc                      Apply owned-backup retention
  claudex recover                  Recover the existing durable transaction
  claudex abort                    Abandon only a proven unpublished projection
  claudex archive-original CONVERSATION_ID --id NATIVE_ID
  claudex untrack CONVERSATION_ID
  claudex resume-tracking CONVERSATION_ID
  claudex split-original CONVERSATION_ID --id NATIVE_ID --record-id RECORD_ID --expected-count N --expected-digest SHA256
  claudex recover-lock [--watch]    Clear a proven dead coordinator lock
  claudex doctor                   Check native versions without model execution
  claudex version-policy [strict|warn]
  claudex service install|start|stop|status|uninstall
  claudex desktop install|uninstall
  claudex desktop folders enable|disable|status
  claudex desktop handoffs enable|disable|status
  claudex status-app install|status
  claudex collaboration help

Global: --root PATH (default ~/.local/share/claudex).
Original histories and uncertain native operations are never discarded or replayed.
";

pub async fn run(raw: &[String]) -> Result<()> {
    if raw == ["--version"] {
        println!("claudex {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let args = Args::parse(
        raw,
        &[
            "root",
            "from",
            "source",
            "id",
            "title",
            "codex-home",
            "claude-home",
            "codex-binary",
            "claude-binary",
            "project",
            "record-id",
            "expected-count",
            "expected-digest",
        ],
        &["help", "watch", "all-projects"],
    )?;
    let command = args
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or("help");
    if args.flag("help") || command == "help" {
        print!("{HELP}");
        return Ok(());
    }
    if command == "version" {
        println!("claudex {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let root = private_directory(args.root()?)?;
    if command == "init" {
        return output(&initialize(&root, &args)?);
    }
    let config = read_json_or(root.join("config.json"), Value::Null)?;
    if config.is_null() {
        bail!("Run claudex init first.");
    }
    if config["version"] != 1 {
        bail!("Unsupported configuration version.");
    }
    match command {
        "status" => output(&status(&root, &config)?),
        "version-policy" => {
            if args.positionals.len() > 2 {
                bail!("Use version-policy strict or version-policy warn.");
            }
            let selected = VersionPolicy::parse(
                args.positionals
                    .get(1)
                    .map(String::as_str)
                    .or(config["versionPolicy"].as_str()),
            )?;
            if args.positionals.len() == 2 {
                let mut next = config.clone();
                next["versionPolicy"] = serde_json::to_value(selected)?;
                write_json(root.join("config.json"), &next)?;
            }
            output(
                &json!({"versionPolicy":selected,"versionGuardEnabled":selected==VersionPolicy::Strict,
                "note":"Applies when the watcher/native owner next starts. Runtime data and safety checks are unchanged."}),
            )
        }
        "doctor" => output(&doctor(&config).await?),
        "recover-lock" => output(&recover_lock(&root, &config, args.flag("watch"))?),
        "service" => {
            let action = args
                .positionals
                .get(1)
                .context("Use service install, start, stop, status, or uninstall.")?;
            if action == "install"
                && config["allProjects"] != true
                && !config["projects"].as_array().is_some_and(|v| !v.is_empty())
            {
                let ledger = read_json_or(
                    root.join(if config["mode"] == "desktop" {
                        "desktop-state.json"
                    } else {
                        "state.json"
                    }),
                    json!({"records":[]}),
                )?;
                if !ledger["records"].as_array().is_some_and(|v| !v.is_empty()) {
                    bail!(
                        "Select all projects, specific projects, or track a conversation before installing the service."
                    );
                }
            }
            let options = crate::service::ServiceOptions {
                root: root.clone(),
                cli: std::env::current_exe()?,
                home: home()?,
                environment_path: std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
            };
            let result = if action == "install" {
                crate::service::install(
                    &options,
                    &crate::service::NativeCommands,
                    &crate::service::NativeProcesses,
                )
                .await?
            } else {
                crate::service::control(
                    action,
                    &options,
                    &crate::service::NativeCommands,
                    &crate::service::NativeProcesses,
                )
                .await?
            };
            output(&result)
        }
        "service-supervise" => {
            let (send, receive) = tokio::sync::watch::channel(false);
            let signals = tokio::spawn(async move {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
                let mut interrupt =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
                tokio::select! {_=terminate.recv()=>(),_=interrupt.recv()=>()}
                let _ = send.send(true);
                std::future::pending::<Result<()>>().await
            });
            let result = crate::service::supervise(
                crate::service::SupervisorOptions::new(root, std::env::current_exe()?),
                receive,
            )
            .await;
            signals.abort();
            result.map(|_| ())
        }
        _ => bail!(
            "Rust command integration is not implemented yet: {command}. No legacy JavaScript runtime was started."
        ),
    }
}
pub fn output(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn initialize(root: &Path, args: &Args) -> Result<Value> {
    if args.flag("all-projects") && args.values.get("project").is_some_and(|v| !v.is_empty()) {
        bail!("Choose --all-projects or --project, not both.");
    }
    let path = root.join("config.json");
    if !read_json_or(&path, Value::Null)?.is_null() {
        bail!("Already initialized; existing configuration was not changed.");
    }
    let home = home()?;
    let codex_home = fs::canonicalize(
        args.value("codex-home")
            .map(std::path::PathBuf::from)
            .unwrap_or(home.join(".codex")),
    )?;
    let claude_home = fs::canonicalize(
        args.value("claude-home")
            .map(std::path::PathBuf::from)
            .unwrap_or(home.join(".claude")),
    )?;
    let projects = args
        .values
        .get("project")
        .into_iter()
        .flatten()
        .map(fs::canonicalize)
        .collect::<std::io::Result<Vec<_>>>()?;
    let config = json!({"version":1,"codexHome":codex_home,"claudeHome":claude_home,
        "binary":args.value("codex-binary").unwrap_or("codex"),"projects":projects,
        "allProjects":args.flag("all-projects"),"since":now_ms()});
    write_json(&path, &config)?;
    Ok(
        json!({"initialized":root,"projects":projects,"allProjects":args.flag("all-projects"),"watching":false}),
    )
}
pub fn status(root: &Path, config: &Value) -> Result<Value> {
    let desktop = config["mode"] == "desktop";
    let path = root.join(if desktop {
        "desktop-state.json"
    } else {
        "state.json"
    });
    let state = read_json_or(
        &path,
        json!({"version":if desktop {2}else{1},"conversations":{},"records":[],"pending":null,"audit":[]}),
    )?;
    if state["version"] != if desktop { 2 } else { 1 } {
        bail!("Unsupported bridge state version.");
    }
    let conversations = state["conversations"]
        .as_object()
        .context("Malformed bridge conversation index.")?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let pending = if state["pending"].is_null() {
        Value::Null
    } else {
        json!({"phase":state["pending"]["phase"],"nativeId":state["pending"]["record"]["nativeId"],"side":state["pending"]["record"]["side"]})
    };
    Ok(
        json!({"mode":config["mode"].as_str().unwrap_or("legacy"),"versionPolicy":VersionPolicy::parse(config["versionPolicy"].as_str())?,
        "contextMode":if desktop {json!(config["contextMode"].as_str().unwrap_or("inline"))}else{Value::Null},
        "allProjects":config["allProjects"]==true,"conversations":conversations,"records":state["records"],"pending":pending,"audit":state["audit"],
        "watcher":read_json_or(root.join("watcher-status.json"),Value::Null)?,"service":read_json_or(root.join("service-status.json"),Value::Null)?}),
    )
}
pub fn recover_lock(root: &Path, config: &Value, watch: bool) -> Result<Value> {
    let path = root.join(if watch {
        "watch.lock"
    } else if config["mode"] == "desktop" {
        "desktop-operation.lock"
    } else {
        "operation.lock"
    });
    let first = match read_stable(&path) {
        Ok(v) => v,
        Err(e) if is_not_found(&e) => return Ok(json!({"cleared":false})),
        Err(e) => return Err(e),
    };
    let record: Value = serde_json::from_slice(&first.bytes)
        .context("Malformed lock; manual inspection required.")?;
    let pid = record["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
        .context("Malformed lock; manual inspection required.")? as u32;
    if process_alive(pid)? {
        bail!("Lock owner is still alive; it was not removed.");
    }
    let current = read_stable(&path)?;
    if first.identity != current.identity || first.bytes != current.bytes {
        bail!("Lock changed; it was not removed.");
    }
    fs::remove_file(path)?;
    Ok(json!({"cleared":true,"pendingTransactionPreserved":true}))
}
async fn bounded_version(binary: &str) -> Result<String> {
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .context("Native version output is unavailable.")?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout.take(4097).read_to_end(&mut bytes).await?;
        if bytes.len() > 4096 {
            bail!("Native version output exceeds its byte limit.");
        }
        let exit = child.wait().await?;
        if !exit.success() {
            bail!("Native version inspection failed.");
        }
        Ok::<_, anyhow::Error>(String::from_utf8(bytes)?.trim().to_owned())
    };
    timeout(Duration::from_secs(10), operation)
        .await
        .context("Native version inspection timed out.")?
}
async fn doctor(config: &Value) -> Result<Value> {
    let codex = bounded_version(config["binary"].as_str().unwrap_or("codex")).await?;
    let claude = bounded_version(config["claudeBinary"].as_str().unwrap_or("claude")).await?;
    let claude_version = claude.split_whitespace().next().unwrap_or("");
    let verified_claude = if config["mode"] == "desktop" {
        ["2.1.281"].contains(&claude_version)
    } else {
        ["2.1.210", "2.1.281"].contains(&claude_version)
    };
    let policy = VersionPolicy::parse(config["versionPolicy"].as_str())?;
    Ok(
        json!({"codex":codex,"claude":claude,"verifiedCodex":claudex_core::version::is_supported_codex_version(&codex),"verifiedClaude":verified_claude,
        "versionPolicy":policy,"synchronizationAllowedByVersionPolicy":policy.allows_codex(&codex)&&policy.permits(claude_version,verified_claude.then_some(claude_version)),
        "note":if policy==VersionPolicy::Warn {"Version changes alone do not produce warnings. Protocol, ownership and history failures remain explicit."}else{"Other native versions require compatibility validation."}}),
    )
}
