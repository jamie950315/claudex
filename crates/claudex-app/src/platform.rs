use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub const PRIVATE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Identity(Vec<String>);
impl Identity {
    pub fn of(m: &std::fs::Metadata) -> Self {
        Self(vec![
            m.dev().to_string(),
            m.ino().to_string(),
            m.size().to_string(),
            m.uid().to_string(),
            m.mode().to_string(),
            m.nlink().to_string(),
            format!("{}{:09}", m.mtime(), m.mtime_nsec()),
            format!("{}{:09}", m.ctime(), m.ctime_nsec()),
        ])
    }
}
pub fn uid() -> u32 {
    unsafe { libc::geteuid() }
}
pub fn absolute(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute()
            && !path.to_string_lossy().chars().any(char::is_control)
            && !path.components().any(|c| matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
        "Use a canonical absolute single-line path."
    );
    Ok(())
}
pub fn directory(path: &Path, private: bool, allow_root: bool) -> Result<()> {
    absolute(path)?;
    let m = std::fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && (m.uid() == uid() || allow_root && m.uid() == 0)
            && m.mode() & if private { 0o077 } else { 0o022 } == 0
            && std::fs::canonicalize(path)? == path,
        "Directory is not canonical, owned and protected from foreign writes."
    );
    Ok(())
}
pub fn create_private(path: &Path) -> Result<()> {
    if !path.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    directory(path, true, false)
}
use std::os::unix::fs::DirBuilderExt;
pub fn safe_bytes(path: &Path, limit: usize, private: bool, allow_root: bool) -> Result<Vec<u8>> {
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let m = f.metadata()?;
    ensure!(
        m.is_file()
            && (m.uid() == uid() || allow_root && m.uid() == 0)
            && m.nlink() == 1
            && m.mode() & if private { 0o077 } else { 0o022 } == 0
            && m.size() <= limit as u64,
        "File must be bounded, owned, regular, single-link and protected from foreign writes."
    );
    let identity = Identity::of(&m);
    ensure!(
        identity == Identity::of(&std::fs::symlink_metadata(path)?),
        "File changed while opening."
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit
            && identity == Identity::of(&f.metadata()?)
            && identity == Identity::of(&std::fs::symlink_metadata(path)?),
        "File changed during inspection."
    );
    Ok(bytes)
}
pub fn optional_json(path: &Path, limit: usize, private: bool) -> Result<Option<Value>> {
    match safe_bytes(path, limit, private, false) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).context(
            "Malformed private JSON state; existing data was preserved.",
        )?)),
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}
pub fn stop_state(root: &Path) -> Result<Option<Value>> {
    let value = optional_json(&root.join("app-stop.json"), 4096, true)?;
    if let Some(v) = &value {
        ensure!(
            v["version"] == 1
                && v["stopped"].is_boolean()
                && (v.get("resuming").is_none() || v["resuming"].is_boolean()),
            "Invalid application stop state."
        );
    }
    Ok(value)
}
pub fn stopped(root: &Path) -> Result<bool> {
    Ok(stop_state(root)?.is_some_and(|v| v["stopped"] == true || v["resuming"] == true))
}
pub fn publish(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::File::open(path.parent().context("Missing parent")?)?.sync_all()?;
    Ok(())
}
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    if path.exists() {
        safe_bytes(path, PRIVATE_LIMIT, true, false)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}-{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    publish(&tmp, &bytes, 0o600)?;
    std::fs::rename(&tmp, path)?;
    std::fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
pub fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Clone, Debug, Default)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub input: Vec<u8>,
    pub timeout: Duration,
    pub max_bytes: usize,
}
impl CommandSpec {
    pub fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            timeout: Duration::from_secs(30),
            max_bytes: 1024 * 1024,
            ..Default::default()
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}
#[async_trait]
pub trait Runner: Send + Sync {
    async fn run(&self, spec: CommandSpec) -> Result<CommandOutput>;
}
pub struct SystemRunner;
#[async_trait]
impl Runner for SystemRunner {
    async fn run(&self, spec: CommandSpec) -> Result<CommandOutput> {
        ensure!(
            spec.program.is_absolute(),
            "Native command path must be absolute."
        );
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !spec.env.is_empty() {
            command.env_clear().envs(&spec.env);
        }
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let input = spec.input;
        let work = async {
            let (written, out, err, status) = tokio::join!(
                async {
                    let result = stdin.write_all(&input).await;
                    // ChildStdin shutdown does not close the OS pipe. Consumers
                    // reading bounded stdin to EOF need the handle dropped.
                    drop(stdin);
                    result
                },
                async {
                    let mut b = Vec::new();
                    stdout
                        .take(spec.max_bytes as u64 + 1)
                        .read_to_end(&mut b)
                        .await?;
                    Ok::<_, std::io::Error>(b)
                },
                async {
                    let mut b = Vec::new();
                    stderr
                        .take(spec.max_bytes as u64 + 1)
                        .read_to_end(&mut b)
                        .await?;
                    Ok::<_, std::io::Error>(b)
                },
                child.wait()
            );
            // Early native refusal may close stdin before reading the request.
            if let Err(e) = written {
                if e.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(e.into());
                }
            }
            let out = out?;
            let err = err?;
            let status = status?;
            ensure!(
                out.len() <= spec.max_bytes && err.len() <= spec.max_bytes,
                "Native command exceeded its output bound."
            );
            Ok(CommandOutput {
                stdout: String::from_utf8(out)?,
                stderr: String::from_utf8(err)?,
                code: status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
            })
        };
        tokio::time::timeout(spec.timeout, work).await.context(
            "Native command timed out; its invocation must not be replayed if it could write.",
        )?
    }
}
pub async fn checked(runner: &dyn Runner, spec: CommandSpec) -> Result<CommandOutput> {
    let output = runner.run(spec).await?;
    ensure!(
        output.code == 0,
        "Native command failed (exit {}).",
        output.code
    );
    Ok(output)
}

#[derive(Default)]
pub struct Options {
    pub positions: Vec<String>,
    pub values: BTreeMap<String, String>,
}
impl Options {
    pub fn parse(args: &[String]) -> Result<Self> {
        let mut out = Self::default();
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];
            if let Some(key) = arg.strip_prefix("--") {
                ensure!(!key.is_empty(), "Invalid option.");
                if [
                    "read-only",
                    "enable",
                    "no-native-wake",
                    "no-self-wake",
                    "native-wake",
                    "self-wake",
                    "help",
                ]
                .contains(&key)
                {
                    out.values.insert(key.into(), "true".into());
                } else {
                    i += 1;
                    let value = args
                        .get(i)
                        .filter(|v| !v.starts_with("--"))
                        .context("Option requires a value.")?;
                    ensure!(
                        out.values.insert(key.into(), value.clone()).is_none(),
                        "Duplicate option."
                    );
                }
            } else if arg.starts_with('-') {
                bail!("Unsupported option {arg}");
            } else {
                out.positions.push(arg.clone());
            }
            i += 1;
        }
        Ok(out)
    }
    pub fn action(&self) -> &str {
        self.positions.first().map(String::as_str).unwrap_or("")
    }
    pub fn flag(&self, key: &str) -> bool {
        self.values.get(key).is_some_and(|v| v == "true")
    }
    pub fn path(&self, key: &str) -> Option<PathBuf> {
        self.values.get(key).map(PathBuf::from)
    }
    pub fn required_path(&self, key: &str) -> Result<PathBuf> {
        let p = self
            .path(key)
            .with_context(|| format!("--{key} is required."))?;
        absolute(&p)?;
        Ok(p)
    }
}
