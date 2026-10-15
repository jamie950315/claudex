//! Signed-host transport policy and exact native backend ownership.
use anyhow::{Context, Result, bail};
use claudex_core::{
    rpc::{SocketEndpoint, inspect_codex_socket},
    storage::*,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::PermissionsExt,
    pin::Pin,
    task::{Context as TaskContext, Poll},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};

pub const MAX_DESKTOP_FRAME_BYTES: usize = 1024 * 1024 * 1024;
pub const SIGNED_HOST_SCRIPT: &str = include_str!("../host/codex-host.mjs");

/// Replace transport options only; preserve all original native argument bytes.
pub fn shared_server_arguments(args: &[String], socket: &Path) -> Result<Option<Vec<String>>> {
    const GLOBAL: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "-C",
        "--cd",
        "-p",
        "--profile",
    ];
    const SERVER: &[&str] = &[
        "--code-mode-host",
        "--ws-auth",
        "--ws-token-file",
        "--ws-token-sha256",
        "--ws-shared-secret-file",
        "--ws-issuer",
        "--ws-audience",
        "--ws-max-clock-skew-seconds",
    ];
    let mut i = 0;
    let mut command = None;
    while i < args.len() {
        let arg = args[i].as_str();
        if GLOBAL.contains(&arg) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        command = Some(i);
        break;
    }
    let Some(command) = command else {
        return Ok(None);
    };
    if args[command] != "app-server" {
        return Ok(None);
    }
    let mut result = args[..=command].to_vec();
    i = command + 1;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--stdio" {
            i += 1;
            continue;
        }
        if arg == "--listen" {
            if i + 1 >= args.len() {
                bail!("Missing app-server transport argument");
            }
            i += 2;
            continue;
        }
        if arg.starts_with("--listen=") {
            i += 1;
            continue;
        }
        if ["--help", "-h", "--version", "-V"].contains(&arg) {
            return Ok(None);
        }
        if GLOBAL.contains(&arg) || SERVER.contains(&arg) {
            if i + 1 >= args.len() {
                bail!("Missing app-server option argument");
            }
            result.extend_from_slice(&args[i..=i + 1]);
            i += 2;
            continue;
        }
        if !arg.starts_with('-') {
            return Ok(None);
        }
        result.push(args[i].clone());
        i += 1;
    }
    result.extend([
        "--listen".into(),
        format!(
            "unix://{}",
            socket
                .to_str()
                .context("The shared Codex socket path must be UTF-8")?
        ),
    ]);
    Ok(Some(result))
}
pub fn is_auxiliary_stdio(args: &[String]) -> bool {
    args == ["app-server", "--listen", "stdio://"]
}
fn identity_pair(identity: &FileIdentity) -> Result<Value> {
    Ok(json!({"dev":identity.dev.parse::<u64>()?,"ino":identity.ino.parse::<u64>()?}))
}
fn same_pair(value: &Value, identity: &FileIdentity) -> bool {
    value["dev"].as_u64().map(|v| v.to_string()).as_ref() == Some(&identity.dev)
        && value["ino"].as_u64().map(|v| v.to_string()).as_ref() == Some(&identity.ino)
}
fn maybe_identity(path: &Path) -> Result<Option<FileIdentity>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(FileIdentity::from_metadata(&m))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn unlink_same(path: &Path, expected: Option<&FileIdentity>, allow_link: bool) -> Result<()> {
    let Some(actual) = maybe_identity(path)? else {
        return Ok(());
    };
    let expected = expected.context("Shared transport ownership changed; refusing cleanup")?;
    if !actual.same_inode(expected)
        || actual.uid != uid().to_string()
        || (!allow_link
            && (actual != *expected
                || actual.nlink != "1"
                || !fs::symlink_metadata(path)?.is_file()))
    {
        bail!("Shared transport ownership changed; refusing cleanup");
    }
    fs::remove_file(path)?;
    Ok(())
}
fn exclusive_record(path: &Path, record: &Value) -> Result<FileIdentity> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let mut bytes = claudex_core::json::stringify(record)?.into_bytes();
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(FileIdentity::from_metadata(&file.metadata()?))
}

pub struct LauncherOwner {
    directory: PathBuf,
    path: PathBuf,
    socket: PathBuf,
    record: Value,
    identity: FileIdentity,
    staged: Option<FileIdentity>,
}
impl LauncherOwner {
    pub async fn claim(
        directory: &Path,
        socket: &Path,
        binary: &Path,
        version: &str,
        native_only: bool,
        host_pid: u32,
    ) -> Result<Self> {
        if host_pid <= 1 || host_pid > i32::MAX as u32 || !process_alive(host_pid)? {
            bail!("The signed native host must own the backend lease");
        }
        require_private_directory(directory)?;
        let path = directory.join("owner.json");
        if maybe_identity(&directory.join("owner.next"))?.is_some() {
            bail!("An interrupted owner checkpoint requires verification before restart");
        }
        if let Some(identity) = maybe_identity(&path)? {
            if identity.uid != uid().to_string()
                || identity.nlink != "1"
                || identity.mode.parse::<u32>()? & 0o777 != 0o600
                || identity.size.parse::<u64>()? > 4096
            {
                bail!("Invalid shared transport ownership record");
            }
            let data = read_stable_with_limit(&path, 4096)?;
            if data.identity != identity {
                bail!("Shared transport ownership changed during inspection");
            }
            let record: Value = serde_json::from_slice(&data.bytes)
                .context("Incomplete shared transport ownership record; refusing recovery")?;
            let pid = record["pid"]
                .as_u64()
                .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                .context("Invalid shared transport ownership record")? as u32;
            let child = if record["childPid"].is_null() {
                None
            } else {
                Some(
                    record["childPid"]
                        .as_u64()
                        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                        .context("Invalid shared transport ownership record")?
                        as u32,
                )
            };
            if record["version"] != 1
                || (!record["transportMode"].is_null() && record["transportMode"] != "native")
            {
                bail!("Invalid shared transport ownership record");
            }
            if process_alive(pid)? || child.map(process_alive).transpose()?.unwrap_or(false) {
                bail!("A live process already owns the shared Codex transport");
            }
            if record["listenerPath"].as_str() != socket.to_str()
                || record["binary"].as_str() != binary.to_str()
                || record["cliVersion"] != version
            {
                bail!("Stale shared transport identity does not match; refusing recovery");
            }
            if let Some(socket_identity) = maybe_identity(socket)? {
                if child.is_none()
                    || !same_pair(&record["listenerIdentity"], &socket_identity)
                    || socket_identity.uid != uid().to_string()
                {
                    bail!("Unproven stale socket ownership; refusing recovery");
                }
                let target = record["socketPath"]
                    .as_str()
                    .map(PathBuf::from)
                    .context("Unproven stale socket ownership; refusing recovery")?;
                if let Some(target_identity) = maybe_identity(&target)? {
                    let verified = inspect_codex_socket(socket)?;
                    if verified.socket_path != target
                        || !same_pair(&record["socketIdentity"], &target_identity)
                    {
                        bail!("The stale socket identity changed");
                    }
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        tokio::net::UnixStream::connect(&verified.socket_path),
                    )
                    .await
                    {
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                            ()
                        }
                        _ => bail!(
                            "The recorded socket may still have a live listener; refusing recovery"
                        ),
                    }
                } else if !fs::symlink_metadata(socket)?.file_type().is_symlink()
                    || fs::read_link(socket)? != target
                {
                    bail!("Unproven stale socket alias; refusing recovery");
                }
                unlink_same(socket, Some(&socket_identity), true)?;
            }
            unlink_same(&path, Some(&identity), false)?;
        } else if maybe_identity(socket)?.is_some() {
            bail!("A socket exists without an ownership record; refusing replacement");
        }
        // The signed host outlives both the engine and native child. If a
        // child-start checkpoint fails, its still-live host keeps this lease
        // exclusive until native shutdown, even though childPid is still null.
        let mut record = json!({"version":1,"pid":host_pid,"childPid":null,"listenerPath":socket,"listenerIdentity":null,"socketPath":null,"socketIdentity":null,"binary":binary,"cliVersion":version});
        if native_only {
            record["transportMode"] = json!("native");
        }
        let identity = exclusive_record(&path, &record)?;
        File::open(directory)?.sync_all()?;
        Ok(Self {
            directory: directory.into(),
            path,
            socket: socket.into(),
            record,
            identity,
            staged: None,
        })
    }
    fn save(&mut self, patch: Value) -> Result<()> {
        for (key, value) in patch.as_object().context("Invalid shared owner update")? {
            self.record[key] = value.clone();
        }
        let stage = self.directory.join("owner.next");
        self.staged = Some(exclusive_record(&stage, &self.record)?);
        let current = maybe_identity(&self.path)?.context("Shared owner record changed")?;
        if current != self.identity {
            bail!("Shared owner record changed");
        }
        fs::rename(&stage, &self.path)?;
        self.staged = None;
        self.identity = FileIdentity::from_metadata(&fs::symlink_metadata(&self.path)?);
        // The directory entry is ownership state, not disposable diagnostics.
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
    pub fn child_started(&mut self, pid: u32) -> Result<()> {
        if pid == 0 || pid > i32::MAX as u32 {
            bail!("Invalid native backend process identity");
        }
        self.save(json!({"childPid":pid}))
    }
    pub fn listener_ready(&mut self, endpoint: &SocketEndpoint) -> Result<()> {
        self.save(json!({"listenerIdentity":identity_pair(&endpoint.listener_identity)?,"socketPath":endpoint.socket_path,"socketIdentity":identity_pair(&endpoint.socket_identity)?}))
    }
    pub fn cleanup(self, socket_identity: Option<&FileIdentity>) -> Result<()> {
        if self.record["childPid"]
            .as_u64()
            .map(|pid| process_alive(pid as u32))
            .transpose()?
            .unwrap_or(false)
        {
            bail!("The owned backend has not exited; keeping its ownership record");
        }
        unlink_same(&self.socket, socket_identity, true)?;
        if let Some(staged) = &self.staged {
            unlink_same(&self.directory.join("owner.next"), Some(staged), false)?;
        }
        unlink_same(&self.path, Some(&self.identity), false)
    }
}

/// Inherited host pipes must not leave uncancellable blocking stdin threads.
struct Pipe {
    fd: tokio::io::unix::AsyncFd<File>,
    flags: i32,
}
impl Pipe {
    fn inherited(fd: i32, duplicate: bool) -> io::Result<Self> {
        // F_GETFL validates the inherited descriptor before taking ownership.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = if duplicate {
            let copied = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
            if copied < 0 {
                return Err(io::Error::last_os_error());
            }
            copied
        } else {
            fd
        };
        // The descriptor is valid and owned by this Pipe from this point.
        let file = unsafe { File::from_raw_fd(fd) };
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            // File owns the valid descriptor until the reactor registration
            // drops it. No other owner can close or replace this descriptor.
            fd: unsafe { tokio::io::unix::AsyncFd::register(file) }?,
            flags,
        })
    }
}
impl Drop for Pipe {
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.fd.get_ref().as_raw_fd(), libc::F_SETFL, self.flags);
        }
    }
}
impl AsyncRead for Pipe {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut ready = std::task::ready!(self.fd.poll_read_ready(cx))?;
            match ready.try_io(|fd| {
                let buffer = buf.initialize_unfilled();
                // The initialized buffer is writable for exactly buffer.len() bytes.
                let n = unsafe {
                    libc::read(
                        fd.get_ref().as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if n < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            }) {
                Ok(Ok(n)) => {
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(e)) => return Poll::Ready(Err(e)),
                Err(_) => continue,
            }
        }
    }
}
impl AsyncWrite for Pipe {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = std::task::ready!(self.fd.poll_write_ready(cx))?;
            match ready.try_io(|fd| {
                // The borrowed input remains readable for the duration of write.
                let n = unsafe {
                    libc::write(fd.get_ref().as_raw_fd(), buf.as_ptr().cast(), buf.len())
                };
                if n < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            }) {
                Ok(v) => return Poll::Ready(v),
                Err(_) => continue,
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
struct SignedHost {
    writer: Pipe,
    reader: BufReader<Pipe>,
    pending: Vec<u8>,
}
impl SignedHost {
    fn inherited() -> Result<Self> {
        Ok(Self {
            writer: Pipe::inherited(3, false)?,
            reader: BufReader::new(Pipe::inherited(4, false)?),
            pending: Vec::new(),
        })
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await?;
        self.writer.flush().await?;
        Ok(())
    }
    async fn next(&mut self) -> Result<Value> {
        let value = read_frame(&mut self.reader, &mut self.pending, 65536)
            .await?
            .context(
                "Signed native host closed before reporting backend exit; ownership was preserved.",
            )?;
        serde_json::from_slice(&value).context("Invalid signed native host control event")
    }
    async fn spawn(&mut self, binary: &Path, args: &[String], mode: &str) -> Result<u32> {
        self.send(json!({"op":"spawn","binary":binary,"args":args,"mode":mode}))
            .await?;
        let event = self.next().await?;
        if event["type"] != "spawned" {
            bail!("Could not start the native Codex backend");
        }
        Ok(event["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
            .context("Invalid signed native host child identity")? as u32)
    }
    async fn stop(&mut self, signal: &str) -> Result<()> {
        self.send(json!({"op":"stop","signal":signal})).await
    }
}
async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    pending: &mut Vec<u8>,
    limit: usize,
) -> Result<Option<Vec<u8>>> {
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if !pending.is_empty() {
                bail!("Native transport has an incomplete final frame");
            }
            return Ok(None);
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let length = newline.unwrap_or(chunk.len());
        if pending.len().saturating_add(length) > limit {
            bail!("Desktop JSONL frame exceeds the transport size limit");
        }
        pending.extend_from_slice(&chunk[..length]);
        let consumed = length + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(std::mem::take(pending)));
        }
    }
}
fn resolve_binary(value: &Path) -> Result<PathBuf> {
    let candidates = if value.components().count() > 1 || value.is_absolute() {
        vec![crate::args::absolute(value)?]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(value))
            .collect()
    };
    let own = std::env::current_exe()?;
    for candidate in candidates {
        match fs::canonicalize(&candidate) {
            Ok(path) => {
                let m = fs::metadata(&path)?;
                if path != own && m.is_file() && m.permissions().mode() & 0o111 != 0 {
                    return Ok(path);
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::NotADirectory
                ) =>
            {
                ()
            }
            Err(e) => return Err(e.into()),
        }
    }
    bail!("A separate executable Codex CLI was not found")
}
async fn wait_exit(
    host: &mut SignedHost,
    terminate: &mut tokio::signal::unix::Signal,
    interrupt: &mut tokio::signal::unix::Signal,
) -> Result<Value> {
    loop {
        tokio::select! {
            event=host.next()=>{let event=event?;if event["type"]=="exit"{return Ok(event);}bail!("Native host failed while waiting for backend exit");},
            _=terminate.recv()=>host.stop("SIGTERM").await?,
            _=interrupt.recv()=>host.stop("SIGINT").await?,
        }
    }
}
fn exit_code(event: &Value, normal_stop: bool) -> i32 {
    event["code"].as_i64().map(|n| n as i32).unwrap_or_else(|| {
        if normal_stop && event["signal"] == "SIGTERM" {
            0
        } else {
            match event["signal"].as_str() {
                Some("SIGTERM") => -libc::SIGTERM,
                Some("SIGINT") => -libc::SIGINT,
                Some("SIGKILL") => -libc::SIGKILL,
                Some("SIGABRT") => -libc::SIGABRT,
                Some("SIGSEGV") => -libc::SIGSEGV,
                Some("SIGHUP") => -libc::SIGHUP,
                Some("SIGPIPE") => -libc::SIGPIPE,
                _ => 1,
            }
        }
    })
}

pub async fn run_host(args: &[String]) -> Result<i32> {
    let mut host = SignedHost::inherited()
        .context("Codex transport requires the installed signed native host pipes")?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let requested =
        PathBuf::from(std::env::var_os("CLAUDEX_CODEX_BINARY").unwrap_or_else(|| "codex".into()));
    // Resolve an observed package relocation before checking the former flat
    // executable, which may no longer exist after an ordinary app update.
    let requested = claudex_core::codex_layout::resolve_bundled_codex(&requested).await?;
    let binary = resolve_binary(&requested)?;
    let root = crate::args::absolute(
        &std::env::var_os("CLAUDEX_HOME")
            .map(PathBuf::from)
            .unwrap_or(crate::args::home()?.join(".local/share/claudex")),
    )?;
    let directory = root.join("codex-shared");
    let socket = directory.join("app.sock");
    let shared = if is_auxiliary_stdio(args) {
        None
    } else {
        shared_server_arguments(args, &socket)?
    };
    let Some(server_args) = shared else {
        host.spawn(&binary, args, "passthrough").await?;
        return Ok(exit_code(
            &wait_exit(&mut host, &mut terminate, &mut interrupt).await?,
            false,
        ));
    };
    if socket.as_os_str().len() > 103 {
        bail!("The shared Codex socket path is too long");
    }
    let version = crate::commands::bounded_version(
        binary
            .to_str()
            .context("Codex executable path must be UTF-8")?,
    )
    .await?;
    if !claudex_core::version::VersionPolicy::Warn.permits(&version, Some(&version)) {
        bail!("Unrecognized Codex version response");
    }
    private_directory(&root)?;
    private_directory(&directory)?;
    require_private_directory(&root)?;
    require_private_directory(&directory)?;
    let policy = claudex_core::version::VersionPolicy::read(&root)?;
    let native_only = !policy.allows_codex(&version);
    // getppid is supplied by the kernel, not by a caller-controlled environment
    // variable. The installed host waits for its native child before exiting.
    let host_pid = unsafe { libc::getppid() } as u32;
    let mut owner = LauncherOwner::claim(
        &directory,
        &socket,
        &binary,
        &version,
        native_only,
        host_pid,
    )
    .await?;
    if native_only {
        eprintln!(
            "Claudex synchronization is paused for unvalidated {version}; Desktop is using its original native transport."
        );
        let child = host.spawn(&binary, args, "passthrough").await?;
        owner.child_started(child)?;
        let result = wait_exit(&mut host, &mut terminate, &mut interrupt).await?;
        owner.cleanup(None)?;
        return Ok(exit_code(&result, false));
    }
    let child = host.spawn(&binary, &server_args, "shared").await?;
    owner.child_started(child)?;
    let mut socket_identity = None;
    let mut exited = None;
    let operation=async {
        let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(30);
        let endpoint=loop {
            match fs::symlink_metadata(&socket){
                Ok(m)=>{
                    use std::os::unix::fs::FileTypeExt;
                    if (!m.file_type().is_socket()&&!m.file_type().is_symlink())||m.uid()!=uid(){bail!("The created Codex listener is not an owned socket");}
                    socket_identity=Some(FileIdentity::from_metadata(&m));
                    if !m.file_type().is_symlink(){fs::set_permissions(&socket,fs::Permissions::from_mode(0o600))?;}
                    let endpoint=inspect_codex_socket(&socket)?;
                    if !process_alive(child)? {bail!("Codex backend exited during listener validation");}
                    owner.listener_ready(&endpoint)?;break endpoint;
                }
                Err(e)if e.kind()==io::ErrorKind::NotFound=>(),Err(e)=>return Err(e.into()),
            }
            if tokio::time::Instant::now()>=deadline{bail!("Timed out starting the shared Codex listener");}
            tokio::select!{
                event=host.next()=>{exited=Some(event?);bail!("Codex backend exited before transport was ready");},
                _=tokio::time::sleep(std::time::Duration::from_millis(25))=>(),
                _=terminate.recv()=>bail!("Desktop transport stopped before readiness"),
                _=interrupt.recv()=>bail!("Desktop transport stopped before readiness"),
            }
        };
        let ws=claudex_core::rpc::connect_codex_socket(&endpoint.socket_path,MAX_DESKTOP_FRAME_BYTES).await?;
        let mut input=BufReader::new(Pipe::inherited(0,true)?);let mut output=Pipe::inherited(1,true)?;let mut pending=Vec::new();
        let (mut sink,mut stream)=ws.split();
        let send=async {loop {match read_frame(&mut input,&mut pending,MAX_DESKTOP_FRAME_BYTES).await? {
            Some(frame)if frame.is_empty()=>(),
            Some(frame)=>sink.send(tokio_tungstenite::tungstenite::Message::Text(String::from_utf8(frame)?.into())).await?,
            None=>return Ok::<_,anyhow::Error>(()),
        }}};
        let receive=async {loop {match stream.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))=>{output.write_all(text.as_bytes()).await?;output.write_all(b"\n").await?;},
            Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_)|tokio_tungstenite::tungstenite::Message::Pong(_)))=>(),
            _=>bail!("Shared Codex transport closed"),
        }}};
        // The outer select also cancels a blocked stdout write or WS send.
        // A Desktop that has stopped reading must not prevent owned shutdown.
        tokio::select!{
            result=send=>result?,
            result=receive=>result?,
            event=host.next()=>{exited=Some(event?);bail!("Native Codex backend exited during Desktop ownership");},
            _=terminate.recv()=>(),
            _=interrupt.recv()=>(),
        }
        Ok::<_,anyhow::Error>(())
    }.await;
    if exited.is_none() {
        host.stop("SIGTERM").await?;
        exited = Some(wait_exit(&mut host, &mut terminate, &mut interrupt).await?);
    }
    owner.cleanup(socket_identity.as_ref())?;
    operation?;
    Ok(exit_code(
        exited
            .as_ref()
            .context("Native backend exit was not observed")?,
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn transport_replacement_preserves_native_options_and_auxiliary_routes() -> Result<()> {
        let socket = Path::new("/private/socket");
        assert_eq!(
            shared_server_arguments(
                &args(&[
                    "-c",
                    "foo=\"app-server\"",
                    "app-server",
                    "--stdio",
                    "-c",
                    "plugins.codex-app-tools.enabled=true"
                ]),
                socket
            )?,
            Some(args(&[
                "-c",
                "foo=\"app-server\"",
                "app-server",
                "-c",
                "plugins.codex-app-tools.enabled=true",
                "--listen",
                "unix:///private/socket"
            ]))
        );
        assert_eq!(
            shared_server_arguments(
                &args(&[
                    "app-server",
                    "--ws-auth",
                    "capability-token",
                    "--ws-token-file",
                    "/synthetic/token",
                    "--listen=stdio://",
                    "--analytics-default-enabled"
                ]),
                socket
            )?,
            Some(args(&[
                "app-server",
                "--ws-auth",
                "capability-token",
                "--ws-token-file",
                "/synthetic/token",
                "--analytics-default-enabled",
                "--listen",
                "unix:///private/socket"
            ]))
        );
        for input in [
            args(&["app-server", "proxy", "--sock", "/somewhere"]),
            args(&["app-server", "--help"]),
            args(&["exec", "app-server"]),
        ] {
            assert!(shared_server_arguments(&input, socket)?.is_none());
        }
        assert!(shared_server_arguments(&args(&["app-server", "--listen"]), socket).is_err());
        assert!(is_auxiliary_stdio(&args(&[
            "app-server",
            "--listen",
            "stdio://"
        ])));
        assert!(!is_auxiliary_stdio(&args(&[
            "app-server",
            "--listen",
            "stdio://",
            "--extra"
        ])));
        Ok(())
    }

    #[tokio::test]
    async fn fragmented_jsonl_is_bounded_complete_and_cancellation_safe() -> Result<()> {
        let (mut writer, reader) = tokio::io::duplex(8);
        let producer = tokio::spawn(async move {
            writer.write_all(b"{\"x\":").await?;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            writer.write_all(b"1}\n\n").await
        });
        let mut reader = BufReader::new(reader);
        let mut pending = Vec::new();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(5),
                read_frame(&mut reader, &mut pending, 7)
            )
            .await
            .is_err()
        );
        assert_eq!(
            read_frame(&mut reader, &mut pending, 7).await?,
            Some(b"{\"x\":1}".to_vec())
        );
        assert_eq!(
            read_frame(&mut reader, &mut pending, 7).await?,
            Some(Vec::new())
        );
        assert_eq!(read_frame(&mut reader, &mut pending, 7).await?, None);
        producer.await??;
        assert!(
            read_frame(&mut BufReader::new(&b"1234\n"[..]), &mut Vec::new(), 3)
                .await
                .is_err()
        );
        assert!(
            read_frame(&mut BufReader::new(&b"123"[..]), &mut Vec::new(), 3)
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn failed_child_checkpoint_retains_the_live_host_lease() -> Result<()> {
        let t = tempfile::tempdir()?;
        let root = fs::canonicalize(t.path())?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let socket = root.join("app.sock");
        let binary = Path::new("/synthetic/codex");
        let mut owner = LauncherOwner::claim(
            &root,
            &socket,
            binary,
            "synthetic",
            false,
            std::process::id(),
        )
        .await?;
        // An existing staging record makes the durable child-start update fail.
        publish_exclusive(root.join("owner.next"), b"foreign checkpoint")?;
        assert!(owner.child_started(std::process::id()).is_err());
        let saved = read_json(root.join("owner.json"))?;
        assert_eq!(saved["pid"], std::process::id());
        assert!(saved["childPid"].is_null());
        // Removing the injected fixture obstruction does not release the host's
        // lease: a contender must still refuse the saved null-child record.
        fs::remove_file(root.join("owner.next"))?;
        assert!(
            LauncherOwner::claim(
                &root,
                &socket,
                binary,
                "synthetic",
                false,
                std::process::id()
            )
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("live process")
        );
        Ok(())
    }
}
