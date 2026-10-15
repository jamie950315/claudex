//! One guarded native own-child inbox submission. A flush is not a native ACK.
use crate::{
    mod_protocol::{ModError, insist},
    platform::{self, CommandSpec, Runner},
};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
#[derive(Clone, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    nlink: u64,
    ctime: (i64, i64),
    mtime: (i64, i64),
}
impl Identity {
    fn of(m: &fs::Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            uid: m.uid(),
            mode: m.mode(),
            nlink: m.nlink(),
            ctime: (m.ctime(), m.ctime_nsec()),
            mtime: (m.mtime(), m.mtime_nsec()),
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Files {
    canonical: PathBuf,
    socket: Identity,
    parent: Identity,
}
#[derive(Clone, PartialEq, Eq)]
struct Parent {
    pid: u32,
    birth: String,
    executable: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Proof {
    files: Files,
    parent: Parent,
}
pub struct Configuration {
    path: PathBuf,
    token: String,
    uid: u32,
    parent_pid: u32,
}
fn require(value: bool, code: &str) -> Result<()> {
    insist(
        value,
        code,
        &format!("Own-inbox inspection failed: {code}."),
    )
}
impl Configuration {
    pub fn environment() -> Result<Self> {
        require(cfg!(target_os = "macos"), "unsupported-platform")?;
        let path = std::env::var("CLAUDE_CODE_MESSAGING_SOCKET").unwrap_or_default();
        let token = std::env::var("CLAUDE_CODE_MESSAGING_TOKEN").unwrap_or_default();
        require(
            path.len() > 1
                && path.len() <= 1024
                && Path::new(&path).is_absolute()
                && !path.contains(['\0', '\r', '\n'])
                && !path.starts_with("//")
                && !Path::new(&path).components().any(|c| {
                    matches!(
                        c,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
                && !path.ends_with('/'),
            "missing-native-inbox",
        )?;
        // Components normalizes repeated separators; the native pathname may not.
        require(
            Path::new(&path)
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
                .replace("//", "/")
                == path,
            "missing-native-inbox",
        )?;
        require(
            !token.is_empty() && token.len() <= 4096 && !token.contains(['\0', '\r', '\n']),
            "missing-native-token",
        )?;
        Ok(Self {
            path: path.into(),
            token,
            uid: platform::uid(),
            parent_pid: unsafe { libc::getppid() } as u32,
        })
    }
    fn files(&self) -> Result<Files> {
        let mut current = PathBuf::from("/");
        let parts: Vec<_> = self.path.components().skip(1).collect();
        for (index, part) in parts.iter().enumerate() {
            current.push(part);
            let stat = fs::symlink_metadata(&current)?;
            if stat.file_type().is_symlink() {
                require(
                    index == 0
                        && [Path::new("/var"), Path::new("/tmp")].contains(&current.as_path())
                        && stat.uid() == 0
                        && fs::canonicalize(&current)?
                            == PathBuf::from(format!("/private{}", current.display())),
                    "unsafe-inbox-link",
                )?;
            } else if index < parts.len() - 1 {
                require(
                    stat.is_dir()
                        && (stat.uid() == 0 || stat.uid() == self.uid)
                        && (stat.mode() & 0o022 == 0
                            || (stat.uid() == 0 && stat.mode() & 0o1000 != 0)),
                    "unsafe-inbox-ancestor",
                )?;
            }
        }
        let canonical = fs::canonicalize(&self.path)?;
        let named = fs::symlink_metadata(&self.path)?;
        let socket = fs::symlink_metadata(&canonical)?;
        let parent_path = canonical.parent().unwrap();
        let parent = fs::symlink_metadata(parent_path)?;
        require(
            socket.file_type().is_socket()
                && !named.file_type().is_symlink()
                && Identity::of(&named) == Identity::of(&socket)
                && socket.uid() == self.uid
                && socket.nlink() == 1
                && socket.mode() & 0o777 == 0o600,
            "unsafe-inbox-socket",
        )?;
        require(
            parent.is_dir()
                && !parent.file_type().is_symlink()
                && parent.uid() == self.uid
                && parent.mode() & 0o777 == 0o700
                && fs::canonicalize(parent_path)? == parent_path,
            "unsafe-inbox-parent",
        )?;
        Ok(Files {
            canonical,
            socket: Identity::of(&socket),
            parent: Identity::of(&parent),
        })
    }
    fn metadata(&self, program: &str, args: Vec<String>) -> CommandSpec {
        let mut spec = CommandSpec::new(program, args);
        spec.env = BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("LC_ALL".into(), "C".into()),
            ("TZ".into(), "UTC".into()),
        ]);
        spec.timeout = Duration::from_secs(2);
        spec.max_bytes = 256 * 1024;
        spec
    }
    async fn inspect(&self, run: &dyn Runner) -> Result<Proof> {
        let files = self.files()?;
        let pid = self.parent_pid;
        require(
            pid > 1 && unsafe { libc::getppid() } as u32 == pid,
            "invalid-native-parent",
        )?;
        let output = run
            .run(self.metadata(
                "/bin/ps",
                vec![
                    "-p".into(),
                    pid.to_string(),
                    "-o".into(),
                    "pid=,ppid=,uid=,lstart=,comm=".into(),
                ],
            ))
            .await?;
        require(
            output.code == 0 && output.stdout.len() <= 8192,
            "invalid-native-parent",
        )?;
        let re = regex::Regex::new(
            r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+([^\r\n]+)\s*$",
        )?;
        let captures = re.captures(&output.stdout);
        require(captures.is_some(), "invalid-native-parent")?;
        let captures = captures.unwrap();
        require(
            captures[1].parse::<u32>()? == pid
                && captures[3].parse::<u32>()? == self.uid
                && Path::new(captures[5].trim())
                    .file_name()
                    .is_some_and(|v| v == "claude"),
            "invalid-native-parent",
        )?;
        let parent = Parent {
            pid,
            birth: captures[4].split_whitespace().collect::<Vec<_>>().join(" "),
            executable: captures[5].trim().into(),
        };
        let out = run
            .run(self.metadata(
                "/usr/sbin/lsof",
                vec![
                    "-a".into(),
                    "-p".into(),
                    pid.to_string(),
                    "-U".into(),
                    "-F".into(),
                    "pftn".into(),
                ],
            ))
            .await?;
        require(
            out.code == 0 && out.stdout.len() <= 256 * 1024,
            "invalid-socket-owner",
        )?;
        let mut current_pid = 0;
        let mut file: Option<(String, String)> = None;
        let mut count = 0;
        let matches = |pid_now: u32, file: &Option<(String, String)>| {
            usize::from(
                pid_now == pid
                    && file.as_ref().is_some_and(|(kind, name)| {
                        kind == "unix"
                            && (Path::new(name) == self.path || Path::new(name) == files.canonical)
                    }),
            )
        };
        for row in out.stdout.lines().filter(|v| !v.is_empty()) {
            if let Some(value) = row.strip_prefix('p') {
                count += matches(current_pid, &file);
                file = None;
                current_pid = value.parse().unwrap_or(0);
            } else if row.starts_with('f') {
                count += matches(current_pid, &file);
                file = Some(Default::default());
            } else if let Some((kind, name)) = &mut file {
                if let Some(value) = row.strip_prefix('t') {
                    *kind = value.into();
                } else if let Some(value) = row.strip_prefix('n') {
                    *name = value.into();
                }
            }
        }
        count += matches(current_pid, &file);
        require(
            count >= 1 && unsafe { libc::getppid() } as u32 == pid,
            "invalid-socket-owner",
        )?;
        require(self.files()? == files, "inbox-changed")?;
        Ok(Proof { files, parent })
    }
}
fn safe_code(e: &anyhow::Error) -> &str {
    e.downcast_ref::<ModError>()
        .map(|e| e.code.as_str())
        .filter(|v| {
            [
                "unsupported-platform",
                "invalid-owner",
                "missing-native-inbox",
                "missing-native-token",
                "unsafe-inbox-link",
                "unsafe-inbox-ancestor",
                "unsafe-inbox-socket",
                "unsafe-inbox-parent",
                "invalid-native-parent",
                "invalid-socket-owner",
                "inbox-changed",
                "invalid-text",
                "invalid-timeout",
                "before-write-refused",
            ]
            .contains(v)
        })
        .unwrap_or("inspection-failed")
}
pub async fn inspect(run: &dyn Runner) -> Result<Value> {
    let result = async {
        Configuration::environment()?.inspect(run).await?;
        Ok(json!({"ready":true,"transport":"own-inbox","platform":"darwin"}))
    }
    .await;
    result.map_err(|e: anyhow::Error| {
        ModError {
            code: safe_code(&e).into(),
            message: format!("Own-inbox inspection failed: {}.", safe_code(&e)),
        }
        .into()
    })
}
#[async_trait]
pub trait Guard: Send + Sync {
    async fn before_write(&self) -> Result<bool>;
}
fn outcome(state: &str, reason: &str) -> Value {
    json!({"state":state,"reason":reason,"automaticReplay":false})
}
pub async fn submit(text: &str, guard: &dyn Guard, run: &dyn Runner, timeout: Duration) -> Value {
    let initial: Result<_> = async {
        require(!text.is_empty() && text.len() <= 256 * 1024, "invalid-text")?;
        require(
            (1..=30000).contains(&(timeout.as_millis() as u64)),
            "invalid-timeout",
        )?;
        let config = Configuration::environment()?;
        let user = claudex_core::json::stringify(
            &json!({"type":"user","message":{"role":"user","content":text}}),
        )?;
        let auth = claudex_core::json::stringify(&json!({"type":"auth","token":config.token}))?;
        require(user.len() + auth.len() + 2 <= 512 * 1024, "invalid-text")?;
        let proof = config.inspect(run).await?;
        Ok((config, proof, format!("{auth}\n{user}\n")))
    }
    .await;
    let (config, initial, payload) = match initial {
        Ok(v) => v,
        Err(e) => return outcome("rejected", safe_code(&e)),
    };
    let mut may_have_written = false;
    let result = tokio::time::timeout(timeout, async {
        let stream = UnixStream::connect(&initial.files.canonical)
            .await
            .map_err(|_| "socket-connect-failed")?;
        let (mut input, mut output) = stream.into_split();
        let write = async {
            let current = config
                .inspect(run)
                .await
                .map_err(|e| safe_code(&e).to_string())?;
            require(current == initial, "inbox-changed").map_err(|e| safe_code(&e).to_string())?;
            let allowed = guard.before_write().await.unwrap_or(false);
            require(allowed, "before-write-refused").map_err(|e| safe_code(&e).to_string())?;
            let current = config
                .inspect(run)
                .await
                .map_err(|e| safe_code(&e).to_string())?;
            require(current == initial, "inbox-changed").map_err(|e| safe_code(&e).to_string())?;
            may_have_written = true;
            output
                .write_all(payload.as_bytes())
                .await
                .map_err(|_| "socket-error".to_string())?;
            output
                .shutdown()
                .await
                .map_err(|_| "socket-error".to_string())?;
            Ok::<_, String>(())
        };
        let read = async {
            let mut total = 0;
            let mut buffer = [0; 1024];
            loop {
                let bytes = input
                    .read(&mut buffer)
                    .await
                    .map_err(|_| "socket-error".to_string())?;
                if bytes == 0 {
                    return Err::<(), _>("socket-closed".into());
                }
                total += bytes;
                if total > 4096 {
                    return Err("socket-response-bound".into());
                }
            }
        };
        tokio::select! {biased;result=write=>result,result=read=>result}
    })
    .await;
    match result {
        Ok(Ok(())) => outcome("submitted", "socket-written"),
        Ok(Err(e)) => outcome(
            if may_have_written {
                "uncertain"
            } else {
                "rejected"
            },
            &e,
        ),
        Err(_) => outcome(
            if may_have_written {
                "uncertain"
            } else {
                "rejected"
            },
            "socket-timeout",
        ),
    }
}
