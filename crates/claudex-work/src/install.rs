pub use crate::desktop_install::desktop_wake;
use crate::{Config, Permission, archive, model::*};
use anyhow::{Context, Result, bail};
use claudex_core::storage;
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub struct Definition {
    pub label: String,
    pub path: PathBuf,
    pub plist: String,
    pub args: Vec<String>,
}
pub fn definition(root: &Path, home: &Path, c: &Config) -> Result<Definition> {
    if !root.is_absolute() || !home.is_absolute() || !c.executable.is_absolute() {
        bail!("Collaboration root, executable and home must be absolute paths.");
    }
    if c.default_permission == Permission::FullAccess
        || c.default_permission == Permission::WorkspaceWrite && !c.allow_write
    {
        bail!("Default permission exceeds installation authorization.");
    }
    let mut args = vec![
        c.executable.to_string_lossy().into_owned(),
        "collaboration".into(),
        "serve".into(),
        "--root".into(),
        root.to_string_lossy().into_owned(),
    ];
    if c.allow_write {
        args.push("--allow-write".into());
    }
    if c.default_permission != Permission::ReadOnly {
        args.extend([
            "--default-permission".into(),
            c.default_permission.as_str().into(),
        ]);
    }
    for (flag, binary, default) in [
        ("--codex-binary", &c.codex_binary, "codex"),
        ("--claude-binary", &c.claude_binary, "claude"),
    ] {
        if binary != Path::new(default) {
            if !binary.is_absolute() {
                bail!("Installed native CLI paths must be absolute.");
            }
            args.extend([flag.into(), binary.to_string_lossy().into_owned()]);
        }
    }
    render_definition(root, home, c, args)
}
fn render_definition(
    root: &Path,
    home: &Path,
    c: &Config,
    args: Vec<String>,
) -> Result<Definition> {
    let label = format!(
        "dev.0ruka.claudex.collaboration.{}",
        &hash(root.to_string_lossy().as_bytes())[..12]
    );
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let strings = args
        .iter()
        .map(|s| format!("<string>{}</string>", xml(s)))
        .collect::<String>();
    let path_env = xml(&c
        .environment_path
        .clone()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or("/usr/bin:/bin".into())));
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{label}</string>\n<key>ProgramArguments</key><array>{strings}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>{path_env}</string></dict>\n<key>WorkingDirectory</key><string>{}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>AbandonProcessGroup</key><true/>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n",
        xml(&root.to_string_lossy())
    );
    Ok(Definition {
        label,
        path,
        plist,
        args,
    })
}
async fn command(program: &str, args: &[String]) -> Result<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(program).args(args).output(),
    )
    .await??;
    if output.stdout.len() > 1024 * 1024 || output.stderr.len() > 65536 {
        bail!("Installation command output exceeded its bound.");
    }
    if !output.status.success() {
        bail!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    }
    Ok(String::from_utf8(output.stdout)?)
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
fn owned_definition(path: &Path) -> Result<Option<String>> {
    let m = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != storage::uid()
        || m.nlink() != 1
        || m.mode() & 0o022 != 0
        || m.len() > 65536
    {
        bail!("Collaboration LaunchAgent is not an owned regular file.");
    }
    Ok(Some(String::from_utf8(storage::read_stable(path)?.bytes)?))
}
fn check_journal(v: &Value, d: &Definition) -> Result<()> {
    if v["version"] != 1
        || v["label"] != d.label
        || v["path"] != json!(d.path)
        || !matches!(v["phase"].as_str(), Some("prepared" | "installed"))
        || v["after"]
            .as_str()
            .is_none_or(|s| v["afterHash"] != hash(s))
        || !v["before"].is_null()
            && v["before"]
                .as_str()
                .is_none_or(|s| v["beforeHash"] != hash(s))
    {
        bail!("Collaboration installation journal is invalid.");
    }
    Ok(())
}
fn exact_stdio(v: &Value, exe: &Path, root: &Path, peer: Provider) -> bool {
    stdio_command(
        v,
        exe,
        &json!(["collaboration", "mcp", "--root", root, "--peer", peer]),
    )
}
pub async fn register(root: &Path, home: &Path, exe: &Path) -> Result<Value> {
    register_with_paths(root, home, exe, Path::new("codex"), Path::new("claude")).await
}
pub async fn register_with_paths(
    root: &Path,
    home: &Path,
    exe: &Path,
    codex_binary: &Path,
    claude_binary: &Path,
) -> Result<Value> {
    let codex_binary = codex_binary.to_str().context("Invalid Codex CLI path")?;
    let claude_binary = claude_binary.to_str().context("Invalid Claude CLI path")?;
    let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(home.to_path_buf());
    register_at(root, home, exe, codex_binary, claude_binary, &claude_home).await
}
async fn register_at(
    root: &Path,
    home: &Path,
    exe: &Path,
    codex_binary: &str,
    claude_binary: &str,
    claude_home: &Path,
) -> Result<Value> {
    let _lock = storage::FileLock::acquire(root.join("collaboration-mcp.lock"), true)?;
    let codex = match command(
        codex_binary,
        &strings(&["mcp", "get", "claudex-work", "--json"]),
    )
    .await
    {
        Ok(s) => Some(serde_json::from_str::<Value>(&s)?),
        Err(e) if e.to_string().contains("No MCP server named") => None,
        Err(_) => bail!("Could not inspect the Codex MCP registration."),
    };
    let claude_visible =
        match command(claude_binary, &strings(&["mcp", "get", "claudex-work"])).await {
            Ok(s) => {
                if !s.contains("Scope: User config") {
                    bail!("Claude MCP name is shadowed by a non-user registration.");
                }
                true
            }
            Err(e) if e.to_string().contains("No MCP server named") => false,
            Err(_) => bail!("Could not inspect the Claude MCP registration."),
        };
    let claude_config = claude_home.join(".claude.json");
    let claude = match std::fs::symlink_metadata(&claude_config) {
        Ok(m) => {
            if !m.is_file()
                || m.file_type().is_symlink()
                || m.uid() != storage::uid()
                || m.nlink() != 1
                || m.len() > 16 * 1024 * 1024
            {
                bail!("Claude MCP configuration is not a bounded owned file.");
            }
            storage::read_json(&claude_config)?["mcpServers"]
                .get("claudex-work")
                .cloned()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let legacy_codex = legacy_registration(root, home, exe, Provider::Codex)?;
    let legacy_claude = legacy_registration(root, home, exe, Provider::Claude)?;
    let matches_legacy = |v: &Value, old: &Option<Value>| {
        old.as_ref().is_some_and(|old| {
            stdio_command(v, Path::new(old["command"].as_str().unwrap()), &old["args"])
        })
    };
    let codex_old = codex
        .as_ref()
        .is_some_and(|v| matches_legacy(&v["transport"], &legacy_codex));
    let claude_old = claude
        .as_ref()
        .is_some_and(|v| matches_legacy(v, &legacy_claude));
    if let Some(v) = &codex {
        if v["name"] != "claudex-work"
            || v["enabled"] == false
            || (!exact_stdio(&v["transport"], exe, root, Provider::Codex) && !codex_old)
        {
            bail!("Existing Codex MCP name belongs to a different registration.");
        }
    }
    if claude_visible != claude.is_some() {
        bail!(
            "Claude MCP visibility differs from its user registration; no configuration was changed."
        );
    }
    if let Some(v) = &claude {
        if !exact_stdio(v, exe, root, Provider::Claude) && !claude_old {
            bail!("Existing Claude MCP name belongs to a different registration.");
        }
    }
    let migration_path = root.join("collaboration-mcp-migration.json");
    let prior_migration = archive::optional(&migration_path, 131072)?;
    if let Some(m) = &prior_migration {
        if m["version"] != 1
            || m["root"] != json!(root)
            || !m["executable"]
                .as_str()
                .is_some_and(|p| Path::new(p).is_absolute())
            || !matches!(m["phase"].as_str(), Some("prepared" | "installed"))
            || m["phase"] == "prepared" && m["executable"] != json!(exe)
        {
            bail!("MCP migration journal differs from the requested registration.");
        }
    }
    if codex_old || claude_old {
        if !processes_stopped(root).await? {
            bail!(
                "Stop the owned collaboration broker and workers before migrating native MCP registrations."
            );
        }
        let journal = json!({"version":1,"phase":"prepared","root":root,"executable":exe,"codexBefore":codex,"claudeBefore":claude,"preparedAt":now(),"previous":prior_migration});
        storage::write_json(&migration_path, &journal)?;
    }
    for (peer, exists) in [
        (Provider::Codex, codex.is_some() && !codex_old),
        (Provider::Claude, claude.is_some() && !claude_old),
    ] {
        if exists {
            continue;
        }
        let old = if peer == Provider::Codex {
            codex_old
        } else {
            claude_old
        };
        if old {
            // Re-read the exact entry immediately before removing this one name.
            if peer == Provider::Codex {
                let current: Value = serde_json::from_str(
                    &command(
                        codex_binary,
                        &strings(&["mcp", "get", "claudex-work", "--json"]),
                    )
                    .await?,
                )?;
                if Some(&current) != codex.as_ref() {
                    bail!("Codex registration changed before migration.");
                }
                command(codex_binary, &strings(&["mcp", "remove", "claudex-work"])).await?;
            } else {
                let current = storage::read_json(&claude_config)?;
                if current["mcpServers"].get("claudex-work") != claude.as_ref() {
                    bail!("Claude registration changed before migration.");
                }
                command(
                    claude_binary,
                    &strings(&["mcp", "remove", "--scope", "user", "claudex-work"]),
                )
                .await?;
            }
        }
        let mut args = if peer == Provider::Codex {
            strings(&["mcp", "add", "claudex-work", "--"])
        } else {
            strings(&["mcp", "add", "--scope", "user", "claudex-work", "--"])
        };
        args.extend([
            exe.to_string_lossy().into_owned(),
            "collaboration".into(),
            "mcp".into(),
            "--root".into(),
            root.to_string_lossy().into_owned(),
            "--peer".into(),
            peer.to_string(),
        ]);
        command(
            if peer == Provider::Codex {
                codex_binary
            } else {
                claude_binary
            },
            &args,
        )
        .await?;
        if peer == Provider::Codex {
            let saved: Value = serde_json::from_str(
                &command(
                    codex_binary,
                    &strings(&["mcp", "get", "claudex-work", "--json"]),
                )
                .await?,
            )?;
            if !exact_stdio(&saved["transport"], exe, root, peer) {
                bail!("Codex did not retain the MCP registration.");
            }
        } else {
            let saved = storage::read_json(&claude_config)?;
            if !exact_stdio(&saved["mcpServers"]["claudex-work"], exe, root, peer) {
                bail!("Claude did not retain the MCP registration.");
            }
        }
    }
    if let Some(mut journal) = archive::optional(&migration_path, 131072)? {
        journal["phase"] = json!("installed");
        journal["installedAt"] = json!(now());
        storage::write_json(&migration_path, &journal)?;
    }
    Ok(json!({"codex":true,"claude":true,"name":"claudex-work","migrated":codex_old||claude_old}))
}
pub async fn install(root: &Path, home: &Path, c: &Config) -> Result<Value> {
    if !cfg!(target_os = "macos") {
        bail!("Collaboration LaunchAgent installation supports macOS only.");
    }
    storage::private_directory(root)?;
    storage::require_private_directory(root)?;
    let d = definition(root, home, c)?;
    let _lock = storage::FileLock::acquire(root.join("collaboration-install.lock"), true)?;
    storage::private_directory(d.path.parent().unwrap())?;
    let meta = std::fs::symlink_metadata(d.path.parent().unwrap())?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != storage::uid()
        || meta.mode() & 0o022 != 0
    {
        bail!("LaunchAgents directory is not owned or is writable by others.");
    }
    let journal_path = root.join("collaboration-install.json");
    let mut journal = archive::optional(&journal_path, 131072)?;
    let before = owned_definition(&d.path)?;
    let target = format!("gui/{}/{}", storage::uid(), d.label);
    let loaded = command("launchctl", &strings(&["print", &target])).await;
    let is_loaded = match &loaded {
        Ok(_) => true,
        Err(e)
            if e.to_string().contains("Could not find")
                || e.to_string().contains("No such process")
                || e.to_string().contains("No such file") =>
        {
            false
        }
        Err(e) => return Err(anyhow::anyhow!(e.to_string())),
    };
    if let Some(j) = &journal {
        check_journal(j, &d)?;
        if j["phase"] == "prepared" {
            if j["after"] != d.plist
                || before.as_ref().map(|s| json!(s)).unwrap_or(Value::Null) != j["before"]
                    && before.as_ref().map(|s| json!(s)).unwrap_or(Value::Null) != j["after"]
            {
                bail!("Prepared collaboration upgrade differs from its journal.");
            }
        } else if before.as_ref().map(|s| json!(s)).unwrap_or(Value::Null) != j["after"] {
            bail!("Existing LaunchAgent differs from its ownership journal.");
        }
    } else if before.is_some() || is_loaded {
        bail!("Existing collaboration LaunchAgent has no ownership journal; it was preserved.");
    }
    if is_loaded {
        let previous = saved_definition(root, home, c, journal.as_ref())?;
        validate_loaded(loaded.as_ref().unwrap(), &previous)?;
    }
    if before.as_deref() != Some(&d.plist) {
        if is_loaded {
            bail!("Stop the loaded collaboration job before upgrading its LaunchAgent.");
        }
        if journal.as_ref().is_none_or(|j| j["phase"] != "prepared") {
            journal = Some(
                json!({"version":1,"phase":"prepared","label":d.label,"path":d.path,"before":before,"beforeHash":before.as_ref().map(hash),"after":d.plist,"afterHash":hash(&d.plist),"preparedAt":now()}),
            );
            storage::write_json(&journal_path, journal.as_ref().unwrap())?;
        }
        if owned_definition(&d.path)? != before {
            bail!("LaunchAgent changed before publication.");
        }
        if before.is_none() {
            storage::publish_exclusive(&d.path, &d.plist)?;
        } else {
            storage::atomic_write(&d.path, &d.plist)?;
        }
    }
    command(
        "plutil",
        &["-lint".into(), d.path.to_string_lossy().into_owned()],
    )
    .await?;
    let mcp = register_with_paths(root, home, &c.executable, &c.codex_binary, &c.claude_binary)
        .await
        .context(
            "Collaboration service artifact is prepared; MCP registration stopped before launch",
        )?;
    if !is_loaded {
        command(
            "launchctl",
            &[
                "bootstrap".into(),
                format!("gui/{}", storage::uid()),
                d.path.to_string_lossy().into_owned(),
            ],
        )
        .await?;
    }
    let actual = command("launchctl", &strings(&["print", &target]))
        .await
        .context("LaunchAgent did not become loaded; installation remains recoverable")?;
    validate_loaded(&actual, &d)?;
    let mut journal = journal.unwrap_or(json!({}));
    journal["phase"] = json!("installed");
    journal["installedAt"] = json!(now());
    storage::write_json(&journal_path, &journal)?;
    drop(_lock);
    Ok(
        json!({"installed":true,"label":d.label,"launchAgent":d.path,"loaded":true,"mcpRegistered":true,"mcp":mcp}),
    )
}

/// Exact loaded artifact comparison, not substring matching. Launchd's arguments
/// block is one verbatim argument per line; a different order or extra flag fails.
pub fn validate_loaded(output: &str, d: &Definition) -> Result<()> {
    let value = |key: &str| {
        output
            .lines()
            .find_map(|line| line.trim().strip_prefix(&format!("{key} = ")))
    };
    let mut arguments = None;
    let mut collecting = false;
    let mut rows = vec![];
    for line in output.lines() {
        let line = line.trim();
        if collecting {
            if line == "}" {
                arguments = Some(rows);
                break;
            }
            if !line.is_empty() {
                rows.push(line.to_owned());
            }
        } else if line == "arguments = {" {
            collecting = true;
        }
    }
    if value("path") != d.path.to_str()
        || value("program") != d.args.first().map(String::as_str)
        || arguments.as_ref() != Some(&d.args)
    {
        bail!(
            "Loaded collaboration LaunchAgent differs from the exact owned installation; it was preserved."
        );
    }
    Ok(())
}
async fn loaded(d: Option<&Definition>, label: &str) -> Result<Value> {
    let target = format!("gui/{}/{label}", storage::uid());
    match command("launchctl", &strings(&["print", &target])).await {
        Ok(output) => {
            let d = d.context(
                "Loaded collaboration job has no owned installation artifact; it was preserved",
            )?;
            validate_loaded(&output, d)?;
            Ok(json!({"loaded":true,"running":output.lines().any(|l|l.trim()=="state = running")}))
        }
        Err(e)
            if ["Could not find", "No such process", "No such file"]
                .iter()
                .any(|s| e.to_string().contains(s)) =>
        {
            Ok(json!({"loaded":false,"running":false}))
        }
        Err(e) => Err(e),
    }
}
fn legacy_cli(path: &Path) -> bool {
    path.is_absolute()
        && path
            .file_name()
            .is_some_and(|n| n == "claudex-collaboration.mjs")
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "bin")
}
fn stdio_command(v: &Value, command: &Path, args: &Value) -> bool {
    v["command"] == command.to_string_lossy().as_ref()
        && v["args"] == *args
        && v.get("type").is_none_or(|v| v == "stdio")
        && v.get("env")
            .is_none_or(|v| v.is_null() || v.as_object().is_some_and(|o| o.is_empty()))
        && v.get("url").is_none()
        && v.get("cwd").is_none_or(Value::is_null)
        && v.get("env_vars")
            .is_none_or(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
}
/// Legacy registrations are selected only by a complete, private, hash-checked
/// installation journal and an exactly reconstructed launch artifact.
fn legacy_registration(
    root: &Path,
    home: &Path,
    exe: &Path,
    peer: Provider,
) -> Result<Option<Value>> {
    let Some(journal) = archive::optional(&root.join("collaboration-install.json"), 131072)? else {
        return Ok(None);
    };
    let c = Config {
        executable: exe.into(),
        ..Config::default()
    };
    let d = definition(root, home, &c)?;
    check_journal(&journal, &d)?;
    for key in ["after", "before"] {
        let Some(saved) = journal[key].as_str() else {
            continue;
        };
        let prior = saved_definition(root, home, &c, Some(&json!({"after":saved})))?;
        if prior.args[1] == "collaboration" && prior.args[0] != exe.to_string_lossy() {
            return Ok(Some(
                json!({"command":prior.args[0],"args":["collaboration","mcp","--root",root,"--peer",peer]}),
            ));
        }
        if prior.args.len() >= 5 && legacy_cli(Path::new(&prior.args[1])) {
            return Ok(Some(
                json!({"command":prior.args[0],"args":[prior.args[1],"mcp","--root",root,"--peer",peer]}),
            ));
        }
    }
    Ok(None)
}
fn unxml(value: &str) -> String {
    value
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}
fn saved_definition(
    root: &Path,
    home: &Path,
    c: &Config,
    journal: Option<&Value>,
) -> Result<Definition> {
    let Some(saved) = journal.and_then(|j| j["after"].as_str()) else {
        return definition(root, home, c);
    };
    let arg_block = regex::Regex::new(r"(?s)<key>ProgramArguments</key><array>(.*?)</array>")?;
    let strings_re = regex::Regex::new(r"(?s)<string>(.*?)</string>")?;
    let captures = arg_block
        .captures(saved)
        .context("Collaboration launch arguments are missing")?;
    let args = strings_re
        .captures_iter(&captures[1])
        .map(|c| unxml(&c[1]))
        .collect::<Vec<_>>();
    let native = args.first().is_some_and(|p| Path::new(p).is_absolute())
        && args.get(1).map(String::as_str) == Some("collaboration");
    let legacy =
        args.len() >= 5 && Path::new(&args[0]).is_absolute() && legacy_cli(Path::new(&args[1]));
    if (!native && !legacy)
        || args.get(2).map(String::as_str) != Some("serve")
        || args.get(3).map(String::as_str) != Some("--root")
        || args.get(4) != Some(&root.to_string_lossy().into_owned())
    {
        bail!("Collaboration executable or root differs from the requested installation.");
    }
    let mut parsed = c.clone();
    parsed.allow_write = false;
    parsed.allow_full_access = false;
    parsed.default_permission = Permission::ReadOnly;
    parsed.codex_binary = "codex".into();
    parsed.claude_binary = "claude".into();
    let mut seen = std::collections::BTreeSet::new();
    let mut index = 5;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag) {
            bail!("Duplicate collaboration launch option.");
        }
        if flag == "--allow-write" {
            parsed.allow_write = true;
        } else {
            index += 1;
            let value = args
                .get(index)
                .context("Incomplete collaboration launch option")?;
            match flag {
                "--default-permission" => parsed.default_permission = Permission::parse(value)?,
                "--codex-binary" => parsed.codex_binary = value.into(),
                "--claude-binary" => parsed.claude_binary = value.into(),
                _ => bail!("Unknown collaboration launch option."),
            }
        }
        index += 1;
    }
    let env = regex::Regex::new(
        r"(?s)<key>EnvironmentVariables</key><dict><key>PATH</key><string>(.*?)</string></dict>",
    )?;
    parsed.environment_path = Some(unxml(
        &env.captures(saved)
            .context("Collaboration launch environment is missing")?[1],
    ));
    parsed.executable = args[0].clone().into();
    let mut expected = definition(root, home, &parsed)?.args;
    if legacy {
        expected[1] = args[1].clone();
    }
    let d = render_definition(root, home, &parsed, expected)?;
    if d.plist != saved {
        bail!("Collaboration launch definition is not a recognized exact artifact.");
    }
    Ok(d)
}

pub async fn processes_stopped(root: &Path) -> Result<bool> {
    let lock = archive::optional(&root.join("broker.lock"), 131072)?;
    let endpoint = archive::optional(&root.join("endpoint.json"), 131072)?;
    let mut pids = std::collections::BTreeSet::new();
    for record in [lock.as_ref(), endpoint.as_ref()].into_iter().flatten() {
        let pid = record["pid"]
            .as_u64()
            .filter(|n| *n > 1 && *n <= i32::MAX as u64)
            .context("Collaboration broker process identity is invalid")?;
        pids.insert(pid as u32);
    }
    if let Some(endpoint) = &endpoint {
        if endpoint["version"] != 1 {
            bail!("Collaboration endpoint is malformed.");
        }
    }
    match std::fs::symlink_metadata(root.join("rpc.sock")) {
        Ok(m) => {
            use std::os::unix::fs::FileTypeExt;
            if !m.file_type().is_socket()
                || m.uid() != storage::uid()
                || m.mode() & 0o777 != 0o600
                || endpoint
                    .as_ref()
                    .is_none_or(|v| v["dev"] != m.dev() || v["ino"] != m.ino())
            {
                bail!("Collaboration socket has no matching owned endpoint evidence.");
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let Some(work) = archive::optional(&root.join("work.json"), 128 * 1024 * 1024)? {
        if work["version"] != 1 || !work["tasks"].is_object() {
            bail!("Collaboration work evidence is malformed.");
        }
        for t in work["tasks"].as_object().unwrap().values() {
            let e = if t["active"].is_object() {
                &t["active"]
            } else if t["status"] == "uncertain"
                || t["lastExecution"].get("ownedProcesses").is_some()
                || t["lastExecution"]["processInventoryRequired"] == true
            {
                &t["lastExecution"]
            } else {
                if matches!(t["status"].as_str(), Some("running" | "uncertain")) {
                    bail!(
                        "Cannot verify collaboration shutdown: native process identity is missing."
                    );
                }
                continue;
            };
            let pid = e["pid"]
                .as_u64()
                .filter(|p| *p > 1 && *p <= i32::MAX as u64)
                .context(
                    "Cannot verify collaboration shutdown: native process identity is missing",
                )? as u32;
            if e["processInventoryRequired"] == true && !e["ownedProcesses"].is_array() {
                bail!(
                    "Cannot verify collaboration shutdown: native descendant identities are missing."
                );
            }
            if e["processInventoryError"] == true
                && !(t["status"] == "failed"
                    && t["resolution"]["processInventoryReconciled"] == true)
            {
                bail!(
                    "Cannot verify collaboration shutdown: native process inventory is incomplete."
                );
            }
            if e["ownedProcesses"].is_array() {
                let records = serde_json::from_value::<Vec<crate::processes::ProcessIdentity>>(
                    e["ownedProcesses"].clone(),
                )?;
                let proof = crate::processes::inspect(&records).await?;
                let rows = array(&proof["processes"]);
                if rows.len() != records.len() || rows.iter().any(|r| r["absent"] != true) {
                    return Ok(false);
                }
                if rows
                    .iter()
                    .any(|r| r["pid"] == pid && r["pgid"] == pid && r["groupAbsent"] == true)
                {
                    continue;
                }
            }
            pids.insert(pid);
        }
    }
    for pid in pids {
        if storage::process_alive(pid)? {
            return Ok(false);
        }
        let result = unsafe { libc::kill(-(pid as i32), 0) };
        if result == 0 {
            return Ok(false);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(true)
}
/// Controls only the exact journal-backed installation. `stopped` includes
/// native leader, group and recorded-descendant proofs, not just launchd state.
pub async fn control(action: &str, root: &Path, home: &Path, c: &Config) -> Result<Value> {
    if !matches!(action, "start" | "stop" | "status") || !cfg!(target_os = "macos") {
        bail!("Collaboration start/stop/status control supports macOS only.");
    }
    match std::fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && action != "start" => {
            let d = definition(root, home, c)?;
            let status = loaded(None, &d.label).await?;
            return Ok(
                json!({"installed":false,"loaded":status["loaded"],"running":false,"stopped":true,"shutdownRequested":false}),
            );
        }
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    storage::require_private_directory(root)?;
    if root.canonicalize()? != root {
        bail!("Collaboration root is not canonical.");
    }
    let _lock = if action == "status" {
        None
    } else {
        Some(storage::FileLock::acquire(
            root.join("collaboration-install.lock"),
            true,
        )?)
    };
    let journal = archive::optional(&root.join("collaboration-install.json"), 131072)?;
    let d = saved_definition(root, home, c, journal.as_ref())?;
    let before = owned_definition(&d.path)?;
    if journal.is_none() && before.is_none() {
        let status = loaded(None, &d.label).await?;
        if action == "start" {
            bail!("Collaboration is not installed.");
        }
        return Ok(
            json!({"installed":false,"loaded":status["loaded"],"running":status["running"],"stopped":processes_stopped(root).await?,"shutdownRequested":false}),
        );
    }
    let journal = journal.context("Collaboration installation has no ownership journal")?;
    check_journal(&journal, &d)?;
    let m = std::fs::symlink_metadata(d.path.parent().unwrap())?;
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != storage::uid()
        || m.mode() & 0o022 != 0
        || journal["after"] != d.plist
        || before.as_deref() != Some(&d.plist)
    {
        bail!(
            "Collaboration control requires the exact owned installation; artifacts were preserved."
        );
    }
    let mut status = loaded(Some(&d), &d.label).await?;
    let mut shutdown = false;
    if action == "start" && status["loaded"] != true {
        if !processes_stopped(root).await? {
            bail!("Prior collaboration broker or native process group has not safely stopped.");
        }
        if owned_definition(&d.path)?.as_deref() != Some(&d.plist) {
            bail!("Collaboration artifact changed before launch.");
        }
        command(
            "launchctl",
            &[
                "bootstrap".into(),
                format!("gui/{}", storage::uid()),
                d.path.to_string_lossy().into_owned(),
            ],
        )
        .await?;
        status = loaded(Some(&d), &d.label).await?;
        if status["loaded"] != true {
            bail!(
                "Collaboration LaunchAgent did not become loaded; application stop hold was preserved."
            );
        }
    }
    if action == "stop" && status["loaded"] == true {
        command(
            "launchctl",
            &[
                "bootout".into(),
                format!("gui/{}/{}", storage::uid(), d.label),
            ],
        )
        .await?;
        shutdown = true;
        status = loaded(Some(&d), &d.label).await?;
    }
    let stopped = status["loaded"] != true && processes_stopped(root).await?;
    Ok(
        json!({"installed":true,"label":d.label,"launchAgent":d.path,"loaded":status["loaded"],"running":status["running"],"stopped":stopped,"shutdownRequested":shutdown}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn journal(d: &Definition, before: Option<&str>) -> Value {
        json!({"version":1,"phase":"installed","label":d.label,"path":d.path,"before":before,"beforeHash":before.map(hash),"after":d.plist,"afterHash":hash(&d.plist)})
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
        exe: PathBuf,
        codex: PathBuf,
        claude: PathBuf,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let base = temp.path().canonicalize()?;
            let root = base.join("work");
            let home = base.join("home");
            storage::private_directory(&root)?;
            storage::private_directory(&home)?;
            let f = Self {
                _temp: temp,
                root,
                home: home.clone(),
                exe: base.join("claudex"),
                codex: home.join("codex-cli"),
                claude: home.join("claude-cli"),
            };
            let quote = |s: &Path| format!("'{}'", s.to_string_lossy().replace('\'', "'\\''"));
            let body = format!(
                "#!/bin/sh\nset -eu\ncd {}\nprintf '%s\\n' \"$(basename \"$0\") $*\" >> operations\ncase \"$2\" in\nget) if [ -f codex-current ]; then cat codex-current; else echo 'No MCP server named' >&2;exit 1;fi;;\nremove) rm codex-current;;\nadd) cp codex-desired codex-current;;\n*) exit 2;;\nesac\n",
                quote(&home)
            );
            fs::write(&f.codex, body)?;
            fs::set_permissions(&f.codex, fs::Permissions::from_mode(0o700))?;
            let body = format!(
                "#!/bin/sh\nset -eu\ncd {}\nprintf '%s\\n' \"$(basename \"$0\") $*\" >> operations\ncase \"$2\" in\nget) if [ -f claude-present ]; then echo 'Scope: User config';else echo 'No MCP server named' >&2;exit 1;fi;;\nremove) rm claude-present;cp claude-empty .claude.json;;\nadd) if [ -f fail-claude-add ];then echo 'Synthetic add interrupted' >&2;exit 1;fi;cp claude-desired .claude.json;touch claude-present;;\n*) exit 2;;\nesac\n",
                quote(&home)
            );
            fs::write(&f.claude, body)?;
            fs::set_permissions(&f.claude, fs::Permissions::from_mode(0o700))?;
            storage::write_json(home.join("claude-empty"), &json!({"mcpServers":{}}))?;
            f.desired()?;
            Ok(f)
        }
        fn config(&self) -> Config {
            Config {
                executable: self.exe.clone(),
                environment_path: Some("/usr/bin:/bin".into()),
                ..Config::default()
            }
        }
        fn desired(&self) -> Result<()> {
            storage::write_json(
                self.home.join("codex-desired"),
                &json!({"name":"claudex-work","enabled":true,"transport":{"type":"stdio","command":self.exe,"args":["collaboration","mcp","--root",self.root,"--peer","codex"]}}),
            )?;
            storage::write_json(
                self.home.join("claude-desired"),
                &json!({"mcpServers":{"claudex-work":{"type":"stdio","command":self.exe,"args":["collaboration","mcp","--root",self.root,"--peer","claude"]}}}),
            )?;
            Ok(())
        }
        fn legacy(&self) -> Result<Definition> {
            let c = self.config();
            let d = render_definition(
                &self.root,
                &self.home,
                &c,
                vec![
                    "/fixture/node".into(),
                    "/fixture/engine/bin/claudex-collaboration.mjs".into(),
                    "serve".into(),
                    "--root".into(),
                    self.root.to_string_lossy().into_owned(),
                ],
            )?;
            storage::write_json(
                self.root.join("collaboration-install.json"),
                &journal(&d, None),
            )?;
            for peer in [Provider::Codex, Provider::Claude] {
                let entry = json!({"type":"stdio","command":"/fixture/node","args":["/fixture/engine/bin/claudex-collaboration.mjs","mcp","--root",self.root,"--peer",peer]});
                if peer == Provider::Codex {
                    storage::write_json(
                        self.home.join("codex-current"),
                        &json!({"name":"claudex-work","enabled":true,"transport":entry}),
                    )?;
                } else {
                    storage::write_json(
                        self.home.join(".claude.json"),
                        &json!({"mcpServers":{"claudex-work":entry}}),
                    )?;
                    fs::write(self.home.join("claude-present"), "")?;
                }
            }
            Ok(d)
        }
        async fn register(&self) -> Result<Value> {
            register_at(
                &self.root,
                &self.home,
                &self.exe,
                self.codex.to_str().unwrap(),
                self.claude.to_str().unwrap(),
                &self.home,
            )
            .await
        }
    }
    #[test]
    fn exact_legacy_artifacts_reconstruct_and_reject_unsupported_launches() -> Result<()> {
        let f = Fixture::new()?;
        let d = f.legacy()?;
        let loaded = saved_definition(&f.root, &f.home, &f.config(), Some(&journal(&d, None)))?;
        assert_eq!(loaded.plist, d.plist);
        assert_eq!(loaded.args, d.args);
        let new = definition(&f.root, &f.home, &f.config())?;
        storage::write_json(
            f.root.join("collaboration-install.json"),
            &journal(&new, Some(&d.plist)),
        )?;
        let old = legacy_registration(&f.root, &f.home, &f.exe, Provider::Codex)?.unwrap();
        assert_eq!(old["command"], "/fixture/node");
        let mut unsafe_args = d.args.clone();
        unsafe_args.extend(["--default-permission".into(), "full-access".into()]);
        let unsafe_d = render_definition(&f.root, &f.home, &f.config(), unsafe_args)?;
        assert!(
            saved_definition(
                &f.root,
                &f.home,
                &f.config(),
                Some(&journal(&unsafe_d, None))
            )
            .is_err()
        );
        let mut reordered = d.args.clone();
        reordered.extend([
            "--codex-binary".into(),
            "/fixture/codex".into(),
            "--allow-write".into(),
        ]);
        let reordered = render_definition(&f.root, &f.home, &f.config(), reordered)?;
        assert!(
            saved_definition(
                &f.root,
                &f.home,
                &f.config(),
                Some(&journal(&reordered, None))
            )
            .is_err()
        );
        Ok(())
    }
    #[tokio::test]
    async fn owned_legacy_mcp_migrates_both_peers_and_is_idempotent() -> Result<()> {
        let f = Fixture::new()?;
        f.legacy()?;
        assert_eq!(f.register().await?["migrated"], true);
        assert_eq!(
            storage::read_json(f.home.join("codex-current"))?,
            storage::read_json(f.home.join("codex-desired"))?
        );
        assert_eq!(
            storage::read_json(f.home.join(".claude.json"))?,
            storage::read_json(f.home.join("claude-desired"))?
        );
        assert_eq!(f.register().await?["migrated"], false);
        let log = fs::read_to_string(f.home.join("operations"))?;
        assert_eq!(log.lines().filter(|l| l.contains("mcp remove")).count(), 2);
        assert_eq!(log.lines().filter(|l| l.contains("mcp add")).count(), 2);
        assert_eq!(
            storage::read_json(f.root.join("collaboration-mcp-migration.json"))?["phase"],
            "installed"
        );
        Ok(())
    }
    #[tokio::test]
    async fn interrupted_mcp_migration_resumes_only_missing_registration() -> Result<()> {
        let f = Fixture::new()?;
        f.legacy()?;
        fs::write(f.home.join("fail-claude-add"), "")?;
        assert!(f.register().await.is_err());
        assert_eq!(
            storage::read_json(f.root.join("collaboration-mcp-migration.json"))?["phase"],
            "prepared"
        );
        fs::remove_file(f.home.join("fail-claude-add"))?;
        f.register().await?;
        let log = fs::read_to_string(f.home.join("operations"))?;
        assert_eq!(
            log.lines()
                .filter(|l| l.starts_with("codex-cli mcp add"))
                .count(),
            1
        );
        assert_eq!(log.lines().filter(|l| l.contains("mcp remove")).count(), 2);
        assert_eq!(
            storage::read_json(f.root.join("collaboration-mcp-migration.json"))?["phase"],
            "installed"
        );
        Ok(())
    }
    #[tokio::test]
    async fn foreign_peer_and_live_broker_refuse_before_any_native_mutation() -> Result<()> {
        for live in [false, true] {
            let f = Fixture::new()?;
            f.legacy()?;
            if live {
                storage::write_json(
                    f.root.join("broker.lock"),
                    &json!({"pid":std::process::id()}),
                )?;
            } else {
                storage::write_json(
                    f.home.join(".claude.json"),
                    &json!({"mcpServers":{"claudex-work":{"command":"/foreign/server","args":[]}}}),
                )?;
            }
            assert!(f.register().await.is_err());
            let log = fs::read_to_string(f.home.join("operations"))?;
            assert!(!log.contains("mcp add"));
            assert!(!log.contains("mcp remove"));
            assert!(!f.root.join("collaboration-mcp-migration.json").exists());
        }
        Ok(())
    }
    #[tokio::test]
    async fn finished_migration_can_upgrade_a_journal_owned_rust_executable() -> Result<()> {
        let mut f = Fixture::new()?;
        f.legacy()?;
        f.register().await?;
        let old = definition(&f.root, &f.home, &f.config())?;
        storage::write_json(
            f.root.join("collaboration-install.json"),
            &journal(&old, None),
        )?;
        f.exe = f.exe.with_file_name("claudex-next");
        f.desired()?;
        assert_eq!(f.register().await?["migrated"], true);
        assert_eq!(
            storage::read_json(f.home.join("codex-current"))?["transport"]["command"],
            json!(f.exe)
        );
        Ok(())
    }
}
