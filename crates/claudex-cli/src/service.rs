//! Read-only ownership preflight and a non-destructive watcher supervisor.
use anyhow::{Context, Result, bail};
use claudex_core::storage::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
    time::Duration,
};
use tokio::{process::Command, sync::watch, time::sleep};

#[derive(Clone, Debug)]
pub struct ServiceOptions {
    pub root: PathBuf,
    pub cli: PathBuf,
    pub home: PathBuf,
    pub environment_path: String,
}
#[derive(Clone, Debug)]
pub struct ServiceDefinition {
    pub label: String,
    pub args: Vec<String>,
    pub path: PathBuf,
    pub plist: String,
}
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn unxml(text: &str) -> String {
    text.replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}
pub fn definition(options: &ServiceOptions) -> Result<ServiceDefinition> {
    if !options.root.is_absolute()
        || !options.cli.is_absolute()
        || !options.home.is_absolute()
        || options.environment_path.contains('\0')
    {
        bail!("Service paths must be absolute and PATH must not contain NUL.");
    }
    let label = format!(
        "dev.0ruka.claudex.{}",
        &hash_bytes(
            options
                .root
                .to_str()
                .context("Service root must be UTF-8")?
        )[..12]
    );
    let args = vec![
        options
            .cli
            .to_str()
            .context("Service executable must be UTF-8")?
            .into(),
        "service-supervise".into(),
        "--root".into(),
        options.root.to_str().unwrap().into(),
    ];
    Ok(generated_definition(
        options,
        &label,
        args,
        &options.environment_path,
        false,
    ))
}
fn generated_definition(
    options: &ServiceOptions,
    label: &str,
    args: Vec<String>,
    environment: &str,
    legacy: bool,
) -> ServiceDefinition {
    let lifecycle = if legacy {
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>"
    } else {
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>AbandonProcessGroup</key><true/>"
    };
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array>{}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict>\n<key>WorkingDirectory</key><string>{}</string>\n{}\n<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n",
        xml(label),
        args.iter()
            .map(|a| format!("<string>{}</string>", xml(a)))
            .collect::<String>(),
        xml(environment),
        xml(options.root.to_str().unwrap_or("")),
        lifecycle
    );
    ServiceDefinition {
        label: label.into(),
        args,
        path: options
            .home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist")),
        plist,
    }
}
pub fn owned_definition(
    contents: &str,
    options: &ServiceOptions,
    legacy_cli: Option<&Path>,
) -> Result<Option<ServiceDefinition>> {
    static ARGS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?s)<key>ProgramArguments</key><array>(.*?)</array>")
            .expect("constant plist regex")
    });
    static STRING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<string>([^<]*)</string>").expect("constant string regex"));
    static ENV: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<key>PATH</key><string>([^<]*)</string>").expect("constant environment regex")
    });
    let Some(args) = ARGS.captures(contents) else {
        return Ok(None);
    };
    let values = STRING
        .captures_iter(&args[1])
        .map(|m| unxml(&m[1]))
        .collect::<Vec<_>>();
    let Some(environment) = ENV.captures(contents).map(|m| unxml(&m[1])) else {
        return Ok(None);
    };
    if values.is_empty() {
        return Ok(None);
    }
    let desired = definition(options)?;
    let own = generated_definition(options, &desired.label, desired.args, &environment, false);
    if own.plist == contents {
        return Ok(Some(own));
    }
    // A prior journal supplies the old CLI identity, never an arbitrary adopted job.
    if let Some(cli) = legacy_cli.filter(|p| p.is_absolute()) {
        let root = options
            .root
            .to_str()
            .context("Service root must be UTF-8")?;
        let cli = cli.to_str().context("Prior service CLI must be UTF-8")?;
        for legacy in [true, false] {
            let args = if legacy {
                vec![
                    values[0].clone(),
                    cli.into(),
                    "watch".into(),
                    "--root".into(),
                    root.into(),
                ]
            } else {
                vec![
                    values[0].clone(),
                    Path::new(cli)
                        .parent()
                        .context("Prior service CLI has no parent")?
                        .join("claudex-service.mjs")
                        .to_str()
                        .context("Prior supervisor path must be UTF-8")?
                        .into(),
                    "--cli".into(),
                    cli.into(),
                    "--root".into(),
                    root.into(),
                ]
            };
            let candidate = generated_definition(options, &own.label, args, &environment, legacy);
            if candidate.plist == contents {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}
fn definition_contents(path: &Path) -> Result<Option<String>> {
    let stable = match read_stable(path) {
        Ok(v) => v,
        Err(e) if is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let i = stable.identity;
    if i.uid != uid().to_string()
        || i.nlink != "1"
        || i.mode.parse::<u32>()? & 0o022 != 0
        || stable.bytes.len() > 65536
    {
        bail!("Service definition is not an owned regular file.");
    }
    Ok(Some(String::from_utf8(stable.bytes)?))
}
#[derive(Clone, Debug)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}
#[async_trait::async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput>;
}
pub struct NativeCommands;
#[async_trait::async_trait]
impl CommandRunner for NativeCommands {
    async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput> {
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            Command::new(program)
                .args(args)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .context("Service command timed out")??;
        if output.stdout.len() > 4 * 1024 * 1024 || output.stderr.len() > 65536 {
            bail!("Service command output exceeded its byte limit.");
        }
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8(output.stdout)?,
            stderr: String::from_utf8(output.stderr)?,
        })
    }
}
async fn checked(
    runner: &dyn CommandRunner,
    program: &str,
    args: Vec<String>,
) -> Result<CommandOutput> {
    let output = runner.run(program, &args).await?;
    if !output.success {
        bail!("Service command failed: {program}");
    }
    Ok(output)
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct NativeStatus {
    pub loaded: bool,
    pub running: bool,
}
async fn native_status(
    runner: &dyn CommandRunner,
    target: &str,
    definition: Option<&ServiceDefinition>,
) -> Result<NativeStatus> {
    let output = runner
        .run("launchctl", &["print".into(), target.into()])
        .await?;
    if !output.success {
        let text = output.stderr.to_ascii_lowercase();
        if ["could not find", "no such process", "no such file"]
            .iter()
            .any(|s| text.contains(s))
        {
            return Ok(NativeStatus {
                loaded: false,
                running: false,
            });
        }
        bail!("Could not inspect the loaded service LaunchAgent.");
    }
    let definition = definition.context(
        "Loaded service LaunchAgent differs from the owned installation; it was preserved.",
    )?;
    let field = |key: &str| {
        output
            .stdout
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix(&format!("{key} = ")))
    };
    let mut in_args = false;
    let mut args = Vec::new();
    for line in output.stdout.lines() {
        let line = line.trim();
        if line == "arguments = {" {
            in_args = true;
            continue;
        }
        if in_args {
            if line == "}" {
                break;
            }
            if !line.is_empty() {
                args.push(line.to_owned());
            }
        }
    }
    if field("path") != definition.path.to_str()
        || field("program") != definition.args.first().map(String::as_str)
        || args != definition.args
    {
        bail!("Loaded service LaunchAgent differs from the owned installation; it was preserved.");
    }
    Ok(NativeStatus {
        loaded: true,
        running: output.stdout.contains("state = running"),
    })
}
fn validated_journal(root: &Path, definition: &ServiceDefinition) -> Result<Value> {
    let journal = read_json_or(root.join("service-install.json"), Value::Null)?;
    if journal.is_null() {
        return Ok(journal);
    }
    let valid_hash = |value: &Value, key: &str, hash: &str| {
        value[key]
            .as_str()
            .is_some_and(|s| value[hash].as_str() == Some(hash_bytes(s).as_str()))
    };
    if journal["version"] != 1
        || journal["label"] != definition.label
        || journal["path"].as_str() != definition.path.to_str()
        || !journal["cli"]
            .as_str()
            .is_some_and(|p| Path::new(p).is_absolute())
        || !matches!(journal["phase"].as_str(), Some("prepared" | "installed"))
        || !valid_hash(&journal, "after", "afterHash")
        || (!journal["before"].is_null() && !valid_hash(&journal, "before", "beforeHash"))
    {
        bail!("Service installation journal is invalid; no definition was changed.");
    }
    Ok(journal)
}
pub async fn install(
    options: &ServiceOptions,
    runner: &dyn CommandRunner,
    probe: &dyn ProcessInspector,
) -> Result<Value> {
    if !cfg!(target_os = "macos") {
        bail!("Background service installation currently supports macOS only.");
    }
    private_directory(&options.root)?;
    let definition = definition(options)?;
    let target = format!("gui/{}/{}", uid(), definition.label);
    let lock = FileLock::acquire(options.root.join("service-install.lock"), true)?;
    let mut journal = validated_journal(&options.root, &definition)?;
    let mut contents = definition_contents(&definition.path)?;
    let legacy_cli = journal["cli"].as_str().map(PathBuf::from);
    let owned = contents
        .as_deref()
        .map(|s| owned_definition(s, options, legacy_cli.as_deref()))
        .transpose()?
        .flatten();
    let loaded = native_status(runner, &target, owned.as_ref()).await?;
    if journal["phase"] == "prepared" {
        let current = contents.as_ref().map(|s| json!(s)).unwrap_or(Value::Null);
        if journal["after"] != definition.plist
            || (current != journal["before"] && current != journal["after"])
        {
            bail!("Service definition changed during a prepared upgrade; it was not overwritten.");
        }
    } else if contents.is_some() && owned.is_none() {
        bail!("Existing service definition differs; it was not overwritten.");
    }
    if contents.as_deref() != Some(&definition.plist) {
        if loaded.loaded {
            bail!("Stop the loaded service safely before upgrading its definition.");
        }
        if !inspect_start(&options.root, true, probe, now_ms())?.allowed {
            bail!("Stop the watcher and all native owners safely before upgrading the service.");
        }
        if journal["phase"] != "prepared" {
            journal = json!({"version":1,"phase":"prepared","label":definition.label,"path":definition.path,"cli":options.cli,"previousCli":legacy_cli,"before":contents,"beforeHash":contents.as_ref().map(hash_bytes),"after":definition.plist,"afterHash":hash_bytes(&definition.plist),"preparedAt":now_ms()});
            write_json(options.root.join("service-install.json"), &journal)?;
        }
        if definition_contents(&definition.path)? != contents {
            bail!("Service definition changed before publication.");
        }
        if contents.is_none() {
            publish_exclusive(&definition.path, &definition.plist)?;
        } else {
            atomic_write(&definition.path, &definition.plist)?;
        }
        contents = Some(definition.plist.clone());
    }
    checked(
        runner,
        "plutil",
        vec![
            "-lint".into(),
            definition
                .path
                .to_str()
                .context("Service definition path must be UTF-8")?
                .into(),
        ],
    )
    .await?;
    if !loaded.loaded {
        checked(
            runner,
            "launchctl",
            vec![
                "bootstrap".into(),
                format!("gui/{}", uid()),
                definition.path.to_str().unwrap().into(),
            ],
        )
        .await?;
    }
    if !native_status(runner, &target, Some(&definition))
        .await?
        .loaded
    {
        bail!("Service LaunchAgent did not become loaded; installation remains recoverable.");
    }
    if journal["after"] != definition.plist {
        journal = json!({"version":1,"label":definition.label,"path":definition.path,"cli":options.cli,"before":contents,"beforeHash":contents.as_ref().map(hash_bytes),"after":definition.plist,"afterHash":hash_bytes(&definition.plist),"preparedAt":now_ms()});
    }
    journal["phase"] = json!("installed");
    journal["installedAt"] = json!(now_ms());
    write_json(options.root.join("service-install.json"), &journal)?;
    lock.release()?;
    Ok(
        json!({"label":definition.label,"installed":definition.path,"autoRestart":true,"note":"Starts at login. Unexpected watcher exits recover with bounded backoff; native owner locks and pending transactions remain authoritative."}),
    )
}
pub async fn control(
    action: &str,
    options: &ServiceOptions,
    runner: &dyn CommandRunner,
    probe: &dyn ProcessInspector,
) -> Result<Value> {
    if !cfg!(target_os = "macos") {
        bail!("Background service installation currently supports macOS only.");
    }
    let desired = definition(options)?;
    let target = format!("gui/{}/{}", uid(), desired.label);
    let journal = validated_journal(&options.root, &desired)?;
    let contents = definition_contents(&desired.path)?;
    let owned = contents
        .as_deref()
        .map(|s| owned_definition(s, options, journal["cli"].as_str().map(Path::new)))
        .transpose()?
        .flatten();
    let status = native_status(runner, &target, owned.as_ref()).await?;
    if action == "status" {
        return Ok(
            json!({"label":desired.label,"loaded":status.loaded,"running":status.running,"supervisor":read_json_or(options.root.join("service-status.json"),Value::Null)?}),
        );
    }
    let owned = owned.context("Service ownership could not be verified.")?;
    match action {
        "stop" | "uninstall" => {
            if status.loaded {
                checked(runner, "launchctl", vec!["bootout".into(), target]).await?;
            }
            if action == "uninstall" {
                if !inspect_start(&options.root, true, probe, now_ms())?.allowed {
                    bail!(
                        "Service shutdown is still waiting for native owners; the installed definition was preserved."
                    );
                }
                if definition_contents(&owned.path)? != contents {
                    bail!("Service definition changed before removal.");
                }
                fs::remove_file(&owned.path)?;
                return Ok(
                    json!({"label":owned.label,"removed":owned.path,"conversationDataPreserved":true}),
                );
            }
            Ok(
                json!({"label":owned.label,"action":action,"shutdownRequested":true,"note":"Native busy owners are allowed to finish. No forced termination is requested."}),
            )
        }
        "start" => {
            if !status.loaded {
                checked(
                    runner,
                    "launchctl",
                    vec![
                        "bootstrap".into(),
                        format!("gui/{}", uid()),
                        owned
                            .path
                            .to_str()
                            .context("Service definition path must be UTF-8")?
                            .into(),
                    ],
                )
                .await?;
            }
            if !native_status(runner, &target, Some(&owned)).await?.loaded {
                bail!(
                    "Service LaunchAgent did not become loaded; the application stop hold was preserved."
                );
            }
            Ok(json!({"label":owned.label,"action":action}))
        }
        _ => bail!("Unknown service action."),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub kind: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_pid: Option<u32>,
}
impl Blocker {
    fn new(kind: &str, code: &str) -> Self {
        Self {
            kind: kind.into(),
            code: code.into(),
            pid: None,
            child_pid: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInspection {
    pub allowed: bool,
    pub blocker_count: usize,
    pub blockers: Vec<Blocker>,
}
#[derive(Clone, Debug)]
pub struct Orphan {
    pub pid: u32,
    pub started_at: i64,
    pub command: String,
}
pub trait ProcessInspector: Send + Sync {
    fn alive(&self, pid: u32) -> Result<bool>;
    fn started_at(&self, pid: u32) -> Option<i64>;
    fn orphans(&self) -> Result<Vec<Orphan>>;
}
pub struct NativeProcesses;
impl ProcessInspector for NativeProcesses {
    fn alive(&self, pid: u32) -> Result<bool> {
        process_alive(pid)
    }
    fn started_at(&self, pid: u32) -> Option<i64> {
        process_started_at(pid)
    }
    fn orphans(&self) -> Result<Vec<Orphan>> {
        let output = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,uid=,lstart=,comm="])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .output()?;
        if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
            bail!("Native process inventory is unavailable.");
        }
        static ROW: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$").expect("constant process regex")
        });
        Ok(String::from_utf8(output.stdout)?
            .lines()
            .filter_map(|line| {
                let row = ROW.captures(line)?;
                if row[2].parse::<u32>().ok()? != 1 || row[3].parse::<u32>().ok()? != uid() {
                    return None;
                }
                Some(Orphan {
                    pid: row[1].parse().ok()?,
                    started_at: chrono::NaiveDateTime::parse_from_str(
                        &row[4],
                        "%a %b %e %H:%M:%S %Y",
                    )
                    .ok()?
                    .and_utc()
                    .timestamp_millis(),
                    command: row[5].to_owned(),
                })
            })
            .collect())
    }
}
fn private_json(path: &Path) -> Result<Option<Value>> {
    let file = match read_stable(path) {
        Ok(v) => v,
        Err(e) if is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let identity = &file.identity;
    let mode = identity.mode.parse::<u32>()?;
    if identity.uid != uid().to_string()
        || mode & 0o077 != 0
        || identity.nlink != "1"
        || file.bytes.len() > 65536
    {
        bail!("Unverified service state file.");
    }
    Ok(Some(serde_json::from_slice(&file.bytes)?))
}
fn valid_pid(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
        .map(|p| p as u32)
}
fn holds(probe: &dyn ProcessInspector, pid: u32, written: Option<i64>) -> Result<bool> {
    if !probe.alive(pid)? {
        return Ok(false);
    }
    Ok(!written
        .zip(probe.started_at(pid))
        .is_some_and(|(at, born)| born > at.saturating_add(2000)))
}
fn inspect_lock(
    path: &Path,
    kind: &str,
    owner: bool,
    probe: &dyn ProcessInspector,
    now: i64,
) -> Result<Vec<Blocker>> {
    let info = match fs::symlink_metadata(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let written_ms = info.mtime() * 1000 + info.mtime_nsec() / 1_000_000;
    if !owner && info.is_file() && info.size() == 0 && now - written_ms >= 60000 {
        return Ok(vec![]);
    }
    let Some(value) = private_json(path)? else {
        return Ok(vec![]);
    };
    let started = value["started"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis());
    let Some(pid) = valid_pid(&value["pid"]) else {
        return Ok(vec![Blocker::new(kind, "malformed-lock")]);
    };
    static UUID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
            .expect("constant UUID regex")
    });
    if (owner
        && (!value["nonce"].as_str().is_some_and(|v| UUID.is_match(v))
            || (!value["childPid"].is_null() && valid_pid(&value["childPid"]).is_none())))
        || (!owner && started.is_none())
    {
        return Ok(vec![Blocker::new(kind, "malformed-lock")]);
    }
    let written = if owner { Some(written_ms) } else { started };
    if holds(probe, pid, written)? {
        let mut b = Blocker::new(kind, "live-owner");
        b.pid = Some(pid);
        return Ok(vec![b]);
    }
    if owner {
        if let Some(child) = valid_pid(&value["childPid"]) {
            if holds(probe, child, written)? {
                let mut b = Blocker::new(kind, "live-native-child");
                b.child_pid = Some(child);
                return Ok(vec![b]);
            }
        } else {
            let created = epoch_ms(info.created()?)?;
            if probe.orphans()?.iter().any(|p| {
                p.command.to_ascii_lowercase().contains("claude")
                    && p.started_at >= created - 2000
                    && p.started_at <= written_ms + 120000
            }) {
                return Ok(vec![Blocker::new(kind, "unrecorded-native-child")]);
            }
        }
    }
    Ok(vec![])
}
pub fn inspect_start(
    root: &Path,
    include_supervisor: bool,
    probe: &dyn ProcessInspector,
    now: i64,
) -> Result<StartInspection> {
    let mut blockers = Vec::new();
    if require_private_directory(root).is_err() {
        return Ok(StartInspection {
            allowed: false,
            blocker_count: 1,
            blockers: vec![Blocker::new("ownership", "unverified-root")],
        });
    }
    let mut locks = vec![
        ("watch.lock", "watcher"),
        ("desktop-operation.lock", "operation"),
        ("operation.lock", "operation"),
    ];
    if include_supervisor {
        locks.push(("service-supervisor.lock", "supervisor"));
    }
    for (name, kind) in locks {
        match inspect_lock(&root.join(name), kind, false, probe, now) {
            Ok(mut b) => blockers.append(&mut b),
            Err(_) => blockers.push(Blocker::new(kind, "unverified-lock")),
        }
        match fs::symlink_metadata(root.join(format!("{name}.reclaim"))) {
            Ok(m) if now - (m.ctime() * 1000 + m.ctime_nsec() / 1_000_000) < 60000 => {
                blockers.push(Blocker::new(kind, "recovery-claim-present"))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => blockers.push(Blocker::new(kind, "unverified-recovery-claim")),
        }
    }
    let owners = root.join("owners");
    let owner_check = (|| -> Result<()> {
        match fs::symlink_metadata(&owners) {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        require_private_directory(&owners)?;
        let names = fs::read_dir(&owners)?.collect::<std::io::Result<Vec<_>>>()?;
        if names.len() > 16384 {
            bail!("Native owner directory exceeds the inspection bound.");
        }
        static NAME: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^[a-f0-9]{64}\.json\.lock$").expect("constant owner regex")
        });
        for entry in names {
            let name = entry.file_name();
            let name = name.to_str().context("Unverified native owner filename")?;
            if NAME.is_match(name) {
                match inspect_lock(&entry.path(), "claude-owner", true, probe, now) {
                    Ok(mut b) => blockers.append(&mut b),
                    Err(_) => blockers.push(Blocker::new("claude-owner", "unverified-lock")),
                }
            } else if name.ends_with(".lock") || name.ends_with(".lock.reap") {
                blockers.push(Blocker::new(
                    "claude-owner",
                    "unverified-lock-name-or-recovery-claim",
                ));
            }
        }
        Ok(())
    })();
    if owner_check.is_err() {
        blockers.push(Blocker::new("ownership", "unverified-owner-directory"));
    }
    let blocker_count = blockers.len();
    blockers.truncate(20);
    Ok(StartInspection {
        allowed: blocker_count == 0,
        blocker_count,
        blockers,
    })
}
pub fn restart_delay(failures: u32) -> Duration {
    Duration::from_millis((5000u64 * (1u64 << failures.saturating_sub(1).min(4))).min(60000))
}

#[derive(Clone, Debug)]
pub struct SupervisorOptions {
    pub root: PathBuf,
    pub cli: PathBuf,
    pub heartbeat: Duration,
    pub check: Duration,
    pub stable: Duration,
}
impl SupervisorOptions {
    pub fn new(root: PathBuf, cli: PathBuf) -> Self {
        Self {
            root,
            cli,
            heartbeat: Duration::from_secs(5),
            check: Duration::from_secs(5),
            stable: Duration::from_secs(120),
        }
    }
}
async fn pause(duration: Duration, shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    tokio::select! {_=sleep(duration)=>(),_=shutdown.changed()=>()}
}
fn publish(path: &Path, status: &mut Value, fields: Value) -> Result<()> {
    for (key, value) in fields
        .as_object()
        .context("Invalid supervisor status update")?
    {
        status[key] = value.clone();
    }
    status["updatedAt"] = json!(now_ms());
    write_diagnostic_json(path, status)
}
pub async fn supervise(
    options: SupervisorOptions,
    mut shutdown: watch::Receiver<bool>,
) -> Result<Value> {
    let root = private_directory(&options.root)?;
    let lock = FileLock::acquire(root.join("service-supervisor.lock"), true)?;
    let path = root.join("service-status.json");
    let mut status = json!({"version":1,"kind":"claudex-service","pid":std::process::id(),"startedAt":now_ms(),"updatedAt":now_ms(),"state":"starting","watcherPid":null,"restartCount":0,"consecutiveFailures":0,"autoRestart":true,"nextAttemptAt":null,"lastExit":null,"blockerCount":0,"blockers":[]});
    publish(&path, &mut status, json!({}))?;
    while !*shutdown.borrow() {
        let check = inspect_start(&root, false, &NativeProcesses, now_ms())?;
        if !check.allowed {
            publish(
                &path,
                &mut status,
                json!({"state":"blocked","watcherPid":null,"blockerCount":check.blocker_count,"blockers":check.blockers,"nextAttemptAt":now_ms()+options.check.as_millis() as i64}),
            )?;
            pause(options.check, &mut shutdown).await;
            continue;
        }
        publish(
            &path,
            &mut status,
            json!({"state":"starting","blockerCount":0,"blockers":[],"nextAttemptAt":null}),
        )?;
        if *shutdown.borrow() {
            break;
        }
        let launched = now_ms();
        let mut command = Command::new(&options.cli);
        command
            .args(["watch", "--root"])
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(false);
        command.as_std_mut().process_group(0);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let failures = status["consecutiveFailures"].as_u64().unwrap_or(0) + 1;
                let delay = restart_delay(failures as u32);
                let restarts = status["restartCount"].as_u64().unwrap_or(0) + 1;
                publish(
                    &path,
                    &mut status,
                    json!({"state":"backoff","watcherPid":null,"lastExit":{"pid":null,"code":null,"signal":null,"at":now_ms(),"runtimeMs":now_ms()-launched,"error":error.to_string()},"consecutiveFailures":failures,"restartCount":restarts,"nextAttemptAt":now_ms()+delay.as_millis() as i64}),
                )?;
                pause(delay, &mut shutdown).await;
                continue;
            }
        };
        let pid = child.id();
        let mut stop_sent = false;
        publish(
            &path,
            &mut status,
            json!({"state":"running","watcherPid":pid}),
        )?;
        let exit = loop {
            if *shutdown.borrow() && !stop_sent {
                if let Some(pid) = pid {
                    // Signal only the exact child; never terminate its native descendants.
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                stop_sent = true;
                publish(&path, &mut status, json!({"state":"stopping"}))?;
            }
            if stop_sent {
                tokio::select! {result=child.wait()=>break result?,_=sleep(options.heartbeat)=>publish(&path,&mut status,json!({"state":"stopping"}))?}
            } else {
                tokio::select! {result=child.wait()=>break result?,_=sleep(options.heartbeat)=>publish(&path,&mut status,json!({"state":"running"}))?,_=shutdown.changed()=>()}
            }
        };
        use std::os::unix::process::ExitStatusExt;
        let mut error = Value::Null;
        if let Ok(Some(watcher)) = private_json(&root.join("watcher-status.json")) {
            if watcher["pid"].as_u64() == pid.map(u64::from) {
                if let Some(text) = watcher["error"].as_str() {
                    error = json!(text.chars().take(2000).collect::<String>());
                }
            }
        }
        let runtime = now_ms() - launched;
        publish(
            &path,
            &mut status,
            json!({"watcherPid":null,"lastExit":{"pid":pid,"code":exit.code(),"signal":exit.signal().map(|n|match n{libc::SIGTERM=>"SIGTERM".into(),libc::SIGINT=>"SIGINT".into(),other=>format!("SIG{other}")}),"at":now_ms(),"runtimeMs":runtime,"error":error}}),
        )?;
        if *shutdown.borrow() || exit.success() {
            break;
        }
        let failures = if runtime >= options.stable.as_millis() as i64 {
            1
        } else {
            status["consecutiveFailures"].as_u64().unwrap_or(0) + 1
        };
        let restarts = status["restartCount"].as_u64().unwrap_or(0) + 1;
        let delay = restart_delay(failures as u32);
        publish(
            &path,
            &mut status,
            json!({"state":"backoff","consecutiveFailures":failures,"restartCount":restarts,"nextAttemptAt":now_ms()+delay.as_millis() as i64}),
        )?;
        pause(delay, &mut shutdown).await;
    }
    publish(
        &path,
        &mut status,
        json!({"state":"stopped","watcherPid":null,"nextAttemptAt":null}),
    )?;
    lock.release()?;
    Ok(status)
}
