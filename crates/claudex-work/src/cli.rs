use crate::{
    Broker, Config, Integration, NativeCliRunner, NoIntegration, Permission, Provider, archive,
    model::*, transport,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::AsyncReadExt;
pub const HELP: &str = "Claudex collaboration: native work broker\n\n  claudex collaboration install [--allow-write]\n  claudex collaboration service start|stop|status\n  claudex collaboration serve [--allow-write] [--allow-full-access]\n  claudex collaboration mcp --peer codex|claude\n  claudex collaboration desktop-wake-mcp --peer claude\n  claudex collaboration status\n  claudex collaboration models [--codex-model ID --claude-model ID]\n  claudex collaboration models [--codex-effort LEVEL --claude-effort LEVEL]\n  claudex collaboration permissions [--default read-only|workspace-write|full-access]\n  claudex collaboration request METHOD --peer codex|claude\n  claudex collaboration native-wake [--route mod|mod-self|renderer]\n  claudex collaboration cache-warm [status|on|confirm TOKEN|off]\n\n--root selects the separate private collaboration root. Reads and installation do not request new model work. Requests may start real model work. Work has no execution deadline. Never replay uncertain native invocations. Sandboxed work has no network or user config; full-access requires explicit authorization and uses the native account.\n";
pub async fn run(args: &[String]) -> Result<()> {
    run_with_integration(args, Arc::new(NoIntegration)).await
}
pub async fn run_with_integration(
    args: &[String],
    integration: Arc<dyn Integration>,
) -> Result<()> {
    let (flags, positionals) = parse_args(args)?;
    let command = positionals.first().map(String::as_str).unwrap_or("help");
    if command == "help" || flags.contains_key("help") {
        print!("{HELP}");
        return Ok(());
    }
    let allowed_positionals = match command {
        "request" => 2,
        "cache-warm" => 3,
        "service" => 2,
        _ => 1,
    };
    if positionals.len() > allowed_positionals {
        bail!("Unexpected collaboration argument.");
    }
    let home = PathBuf::from(std::env::var_os("HOME").context("HOME is unavailable")?);
    let root = flags.get("root").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("CLAUDEX_HOME")
            .map(PathBuf::from)
            .unwrap_or(home.join(".local/share/claudex"))
            .join("collaboration")
    });
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()?.join(root)
    };
    let peer = Provider::parse(flags.get("peer").map(String::as_str).unwrap_or("codex"))?;
    if command == "service" {
        let action = positionals.get(1).map(String::as_str).unwrap_or("status");
        if !["start", "stop", "status"].contains(&action) {
            bail!("Use collaboration service start|stop|status.");
        }
        let result = crate::install::control(action, &root, &home, &Config::default()).await?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if command == "serve" {
        let config = cli_config(&flags)?;
        claudex_core::storage::private_directory(&root)?;
        let _lock = claudex_core::storage::FileLock::acquire(root.join("broker.lock"), true)?;
        reclaim_endpoint(&root)?;
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        if let Err(e) = integration.start().await {
            let _ = integration.close().await;
            return Err(e);
        }
        let runner = NativeCliRunner {
            codex: config.codex_binary.clone(),
            claude: config.claude_binary.clone(),
        };
        let broker = match Broker::open_with_integration(
            root.clone(),
            config,
            Arc::new(runner),
            integration.clone(),
        )
        .await
        {
            Ok(broker) => broker,
            Err(e) => {
                let _ = integration.close().await;
                return Err(e);
            }
        };
        let server = match transport::serve(broker.clone()).await {
            Ok(server) => server,
            Err(e) => {
                let _ = broker.close().await;
                return Err(e);
            }
        };
        let result=async {
            let m = std::fs::symlink_metadata(&server.path)?;
            claudex_core::storage::write_json(
            root.join("endpoint.json"),
            &json!({"version":1,"pid":std::process::id(),"dev":m.dev(),"ino":m.ino(),"startedAt":now()}),
        )?;
            broker.schedule();
            tokio::select! {_=interrupt.recv()=>{},_=term.recv()=>{},_=broker.wait_closed()=>{}}
            Ok::<_,anyhow::Error>(())
        }.await;
        let broker_result = broker.close().await;
        let server_result = server.close().await;
        result?;
        broker_result?;
        server_result?;
        return Ok(());
    }
    if command == "install" {
        let result = crate::install::install(&root, &home, &cli_config(&flags)?).await?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    run_connected(command, &positionals, &flags, root, peer).await
}
fn parse_args(args: &[String]) -> Result<(BTreeMap<String, String>, Vec<String>)> {
    let mut flags = BTreeMap::new();
    let mut positionals = vec![];
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            positionals.extend(args[index + 1..].iter().cloned());
            break;
        }
        let option = if arg == "-h" {
            Some("help")
        } else {
            arg.strip_prefix("--")
        };
        if let Some(option) = option {
            let (flag, inline) = option
                .split_once('=')
                .map_or((option, None), |(k, v)| (k, Some(v)));
            if flags.contains_key(flag) {
                bail!("Duplicate collaboration option --{flag}.");
            }
            if [
                "help",
                "allow-write",
                "allow-full-access",
                "accept-best-effort",
            ]
            .contains(&flag)
            {
                if inline.is_some() {
                    bail!("Boolean option --{flag} does not take a value.");
                }
                flags.insert(flag.to_string(), "true".to_string());
            } else {
                if ![
                    "root",
                    "peer",
                    "default",
                    "route",
                    "default-permission",
                    "codex-binary",
                    "claude-binary",
                    "codex-model",
                    "claude-model",
                    "codex-effort",
                    "claude-effort",
                    "session",
                    "cwd",
                    "provider",
                    "refresh-minutes",
                    "max-minutes",
                    "max-refreshes",
                    "max-read-tokens",
                    "max-output-tokens",
                ]
                .contains(&flag)
                {
                    bail!("Unknown collaboration option --{flag}.");
                }
                let value = if let Some(v) = inline {
                    v.to_owned()
                } else {
                    index += 1;
                    let v = args.get(index).context("Missing option value")?;
                    if v.starts_with('-') {
                        bail!(
                            "Missing option value for --{flag}; use --{flag}=VALUE for a value beginning with '-'."
                        );
                    }
                    v.clone()
                };
                flags.insert(flag.to_string(), value);
            }
        } else {
            if arg.starts_with('-') {
                bail!("Unknown collaboration option {arg}.");
            }
            positionals.push(arg.clone());
        }
        index += 1;
    }
    Ok((flags, positionals))
}
/// Read the same validated command/options as the collaboration entry point.
/// Consumers can defer inference-capable managers until the actual serve route.
pub fn command_and_root(args: &[String]) -> Result<(String, Option<PathBuf>)> {
    let (flags, positionals) = parse_args(args)?;
    let command = if flags.contains_key("help") {
        "help".to_owned()
    } else {
        positionals.first().cloned().unwrap_or("help".into())
    };
    Ok((command, flags.get("root").map(PathBuf::from)))
}
fn cli_config(flags: &BTreeMap<String, String>) -> Result<Config> {
    Ok(Config {
        allow_write: flags.contains_key("allow-write"),
        allow_full_access: flags.contains_key("allow-full-access"),
        default_permission: Permission::parse(
            flags
                .get("default-permission")
                .map(String::as_str)
                .unwrap_or("read-only"),
        )?,
        codex_binary: flags
            .get("codex-binary")
            .map(PathBuf::from)
            .unwrap_or("codex".into()),
        claude_binary: flags
            .get("claude-binary")
            .map(PathBuf::from)
            .unwrap_or("claude".into()),
        ..Config::default()
    })
}
async fn run_connected(
    command: &str,
    positionals: &[String],
    flags: &BTreeMap<String, String>,
    root: PathBuf,
    peer: Provider,
) -> Result<()> {
    let token = if let Ok(token) = std::env::var("CLAUDEX_WORK_TOKEN") {
        token
    } else {
        controller_token(&root)?
    };
    if command == "mcp" || command == "desktop-wake-mcp" {
        let desktop = command == "desktop-wake-mcp";
        if desktop && (peer != Provider::Claude || std::env::var_os("CLAUDEX_WORK_TOKEN").is_some())
        {
            bail!("Desktop wake requires the native Claude controller endpoint.");
        }
        return transport::mcp(
            root,
            peer,
            token,
            desktop,
            std::env::var_os("CLAUDEX_WORK_TOKEN").is_some(),
        )
        .await;
    }
    let (method, params) = match command {
        "status" => ("list".to_owned(), json!({})),
        "models" => {
            let mut p = json!({});
            for (pair, key) in [
                (["codex-model", "claude-model"], "defaultModels"),
                (["codex-effort", "claude-effort"], "defaultEfforts"),
            ] {
                if pair.iter().any(|k| flags.contains_key(*k)) {
                    if !pair.iter().all(|k| flags.contains_key(*k)) {
                        bail!("Both provider settings are required.");
                    }
                    let value = |flag: &str| {
                        let s = flags[flag].trim();
                        if s.is_empty() { Value::Null } else { json!(s) }
                    };
                    p[key] = json!({"codex":value(pair[0]),"claude":value(pair[1])});
                }
            }
            ("models".to_owned(), p)
        }
        "permissions" => (
            "models".to_owned(),
            flags
                .get("default")
                .map(|v| json!({"defaultPermission":v}))
                .unwrap_or(json!({})),
        ),
        "native-wake" => (
            "native_wake".to_owned(),
            flags
                .get("route")
                .map(|v| json!({"route":v}))
                .unwrap_or(json!({})),
        ),
        "request" => {
            let method = positionals
                .get(1)
                .context("A request method is required")?
                .clone();
            let mut input = vec![];
            tokio::io::stdin()
                .take(256 * 1024 + 1)
                .read_to_end(&mut input)
                .await?;
            if input.len() > 256 * 1024 {
                bail!("Request exceeds 256 KiB.");
            }
            let mut p = if input.is_empty() {
                json!({})
            } else {
                serde_json::from_slice::<Value>(&input)?
            };
            if method == "start"
                && std::env::var("CLAUDEX_COLLABORATION_WORKER").as_deref() != Ok("1")
                && p.get("notifications").is_none()
            {
                p["notifications"] = json!({"mode":"off"});
            }
            (method, p)
        }
        "cache-warm" => {
            if flags.contains_key("max-read-tokens") {
                bail!("Read-token limits have been removed; omit --max-read-tokens.");
            }
            let action = positionals.get(1).map(String::as_str).unwrap_or("status");
            if action == "confirm" && positionals.len() != 3
                || action != "confirm" && positionals.len() > 2
            {
                bail!(
                    "Unexpected cache-warm arguments; confirm requires exactly one confirmation token."
                );
            }
            let provider = flags
                .get("provider")
                .map(String::as_str)
                .unwrap_or("claude");
            let mut p = json!({});
            if provider == "codex" {
                if !["status", "list", "on", "confirm", "off"].contains(&action) {
                    bail!("Use Codex cache-warm status|on|confirm TOKEN|off.");
                }
                if ["on", "off"].contains(&action)
                    || flags.contains_key("session")
                    || flags.contains_key("cwd")
                {
                    p["sessionId"] = json!(
                        flags
                            .get("session")
                            .context("Both --session and --cwd are required")?
                    );
                    p["cwd"] = json!(
                        flags
                            .get("cwd")
                            .context("Both --session and --cwd are required")?
                    );
                }
                if ["on", "confirm"].contains(&action) {
                    if !flags.contains_key("accept-best-effort") {
                        bail!(
                            "Explicitly pass --accept-best-effort after reading the Codex limitations."
                        );
                    }
                    p["bestEffort"] = json!(true);
                }
                if action == "on" {
                    for (flag, key) in [
                        ("refresh-minutes", "refreshMinutes"),
                        ("max-minutes", "maxMinutes"),
                        ("max-refreshes", "maxRefreshes"),
                        ("max-output-tokens", "maxOutputTokens"),
                    ] {
                        if let Some(v) = flags.get(flag) {
                            let n = v.parse::<u64>()?;
                            if n == 0 {
                                bail!("Invalid --{flag}.");
                            }
                            p[key] = json!(n);
                        }
                    }
                } else if [
                    "refresh-minutes",
                    "max-minutes",
                    "max-refreshes",
                    "max-output-tokens",
                ]
                .iter()
                .any(|k| flags.contains_key(*k))
                {
                    bail!("Set bounds on cache-warm on, then review the new preview.");
                }
                if action == "confirm" {
                    p["confirmationId"] = json!(
                        positionals
                            .get(2)
                            .context("Supply the exact confirmation token")?
                    );
                }
                let suffix = match action {
                    "on" => "prepare",
                    "status" | "list" => "list",
                    x => x,
                };
                (format!("codex_cache_warm_{suffix}"), p)
            } else {
                if provider != "claude" || !["status", "list", "off"].contains(&action) {
                    bail!(
                        "Use cache-warm status or off. Enable from the intended native conversation."
                    );
                }
                if action == "off" {
                    p = json!({"provider":"claude","sessionId":flags.get("session").context("Both --session and --cwd are required")?,"cwd":flags.get("cwd").context("Both --session and --cwd are required")?,"enabled":false,"requestId":format!("cli-cache-warm:{}",uuid::Uuid::new_v4())});
                }
                (
                    if action == "off" {
                        "cache_warm_configure"
                    } else {
                        "cache_warm_list"
                    }
                    .into(),
                    p,
                )
            }
        }
        _ => bail!("Unknown collaboration command. Use collaboration help."),
    };
    let mut result = transport::call(&root, peer, &token, &method, params).await?;
    if command == "cache-warm" && method == "codex_cache_warm_prepare" {
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        result["confirm"] = json!(format!(
            "claudex collaboration cache-warm confirm {} --provider codex --accept-best-effort --root {} --peer {}",
            text(&result["confirmationId"], "confirmation ID", 256)?,
            quote(&root.to_string_lossy()),
            quote(peer.as_str())
        ));
    }
    if command == "permissions" {
        result = json!({"defaultPermission":result["defaultPermission"]});
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
pub fn controller_token(root: &Path) -> Result<String> {
    claudex_core::storage::require_private_directory(root)?;
    let m = std::fs::symlink_metadata(root.join("controller-key"))?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != claudex_core::storage::uid()
        || m.nlink() != 1
        || m.mode() & 0o777 != 0o600
        || m.len() != 65
    {
        bail!("Unsafe collaboration controller key.");
    }
    let data = claudex_core::storage::read_stable(root.join("controller-key"))?;
    let token = String::from_utf8(data.bytes)?.trim().to_owned();
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("Invalid collaboration controller key.");
    }
    Ok(token)
}
fn reclaim_endpoint(root: &Path) -> Result<()> {
    let path = root.join("rpc.sock");
    let m = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let saved = archive::private_read(&root.join("endpoint.json"), 4096)?;
    let pid = saved["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
        .context("Invalid prior broker process identity")?;
    if saved["version"] != 1
        || saved["dev"] != m.dev()
        || saved["ino"] != m.ino()
        || !m.file_type().is_socket()
        || m.uid() != claudex_core::storage::uid()
        || m.mode() & 0o777 != 0o600
    {
        bail!("Existing broker endpoint is not an authenticated stale socket; it was preserved.");
    }
    if claudex_core::storage::process_alive(pid as u32)? {
        bail!("Prior broker is still alive.");
    }
    let current = std::fs::symlink_metadata(&path)?;
    if current.dev() != m.dev() || current.ino() != m.ino() {
        bail!("Broker endpoint changed; it was preserved.");
    }
    std::fs::remove_file(path)?;
    Ok(())
}
