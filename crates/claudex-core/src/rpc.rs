//! Bounded native Codex JSON-RPC. Failed requests are never replayed.
use crate::storage::{FileIdentity, uid};
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::{Child, Command},
    sync::{Mutex, broadcast, mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const UNKNOWN: &str = "completion is unknown, do not retry writes automatically";

/// A missing endpoint before admission, not a missing history or uncertain RPC.
#[derive(Debug)]
pub struct TransportUnavailable {
    pub operation: &'static str,
    pub path: PathBuf,
    detail: String,
}
impl std::fmt::Display for TransportUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Shared Codex transport unavailable: {} at {}: {}",
            self.operation,
            self.path.display(),
            self.detail
        )
    }
}
impl std::error::Error for TransportUnavailable {}

/// Apply only to endpoint I/O. Other native files and admission refusals retain
/// their original failure; an unavailable endpoint never authorizes a retry.
pub(crate) fn endpoint_result<T>(
    result: Result<T>,
    operation: &'static str,
    path: &Path,
) -> Result<T> {
    result.map_err(|error| {
        if crate::storage::is_not_found(&error) {
            let context = TransportUnavailable {
                operation,
                path: path.to_owned(),
                detail: error.to_string(),
            };
            error.context(context)
        } else {
            error
        }
    })
}

#[derive(Clone, Debug)]
pub struct SocketEndpoint {
    pub socket_path: PathBuf,
    pub socket_identity: FileIdentity,
    pub listener_identity: FileIdentity,
}
pub fn inspect_codex_socket(path: &Path) -> Result<SocketEndpoint> {
    if !path.is_absolute() {
        bail!("The Codex socket path must be absolute");
    }
    let entry = endpoint_result(
        fs::symlink_metadata(path).map_err(Into::into),
        "inspect listener",
        path,
    )?;
    let parent = path.parent().context("Socket parent is absent")?;
    let directory = endpoint_result(
        fs::symlink_metadata(parent).map_err(Into::into),
        "inspect listener directory",
        parent,
    )?;
    if !directory.is_dir()
        || directory.file_type().is_symlink()
        || directory.mode() & 0o777 != 0o700
        || entry.uid() != uid()
        || directory.uid() != uid()
    {
        bail!("The Codex socket must be owner-only in a private directory");
    }
    let target = if entry.file_type().is_symlink() {
        let target = endpoint_result(
            fs::read_link(path).map_err(Into::into),
            "read listener alias",
            path,
        )?;
        let expected = fs::canonicalize("/tmp")?.join(format!("codex-daemon-{}", uid()));
        let name = target.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !target.is_absolute()
            || target.parent() != Some(expected.as_path())
            || name.len() != 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            bail!("Unexpected native Codex socket alias");
        }
        let m = endpoint_result(
            fs::symlink_metadata(&expected).map_err(Into::into),
            "inspect native socket directory",
            &expected,
        )?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.uid() != uid()
            || m.mode() & 0o777 != 0o700
        {
            bail!("The native Codex socket directory is not private");
        }
        target
    } else {
        path.to_owned()
    };
    let socket = endpoint_result(
        fs::symlink_metadata(&target).map_err(Into::into),
        "inspect native socket",
        &target,
    )?;
    if !socket.file_type().is_socket()
        || socket.file_type().is_symlink()
        || socket.uid() != uid()
        || socket.mode() & 0o777 != 0o600
    {
        bail!("The Codex socket must be owner-only in a private directory");
    }
    Ok(SocketEndpoint {
        socket_path: target,
        socket_identity: FileIdentity::from_metadata(&socket),
        listener_identity: FileIdentity::from_metadata(&entry),
    })
}

pub async fn connect_codex_socket(
    path: &Path,
    max_payload: usize,
) -> Result<WebSocketStream<UnixStream>> {
    let endpoint = inspect_codex_socket(path)?;
    let stream = endpoint_result(
        timeout(
            Duration::from_secs(30),
            UnixStream::connect(&endpoint.socket_path),
        )
        .await?
        .map_err(Into::into),
        "connect native socket",
        &endpoint.socket_path,
    )?;
    let fresh = inspect_codex_socket(path)?;
    if endpoint.socket_path != fresh.socket_path
        || endpoint.listener_identity != fresh.listener_identity
        || endpoint.socket_identity != fresh.socket_identity
    {
        bail!("Shared Codex socket identity changed during connection");
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(max_payload))
        .max_frame_size(Some(max_payload));
    let (ws, _) = timeout(
        Duration::from_secs(30),
        tokio_tungstenite::client_async_with_config("ws://localhost/rpc", stream, Some(config)),
    )
    .await??;
    Ok(ws)
}

#[derive(Clone, Debug)]
pub struct RpcError {
    pub message: String,
    pub code: Option<Value>,
    pub execution_uncertain: bool,
}
impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RpcError {}
type Pending = HashMap<u64, oneshot::Sender<std::result::Result<Value, RpcError>>>;
struct Inner {
    outgoing: mpsc::Sender<Value>,
    pending: Mutex<Pending>,
    notifications: broadcast::Sender<Value>,
    closed: AtomicBool,
    initializing: AtomicBool,
    initialized: AtomicBool,
    next_id: AtomicU64,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    child: Mutex<Option<Child>>,
    timeout: Duration,
}
impl Drop for Inner {
    fn drop(&mut self) {
        // Shared-socket tasks carry weak references, so abandoning a bounded
        // read/initialize cannot keep the connection alive through a task cycle.
        for task in self.tasks.get_mut().drain(..) {
            task.abort();
        }
    }
}
#[derive(Clone)]
pub struct CodexClient {
    inner: Arc<Inner>,
}
impl CodexClient {
    fn new() -> (Self, mpsc::Receiver<Value>) {
        let (outgoing, rx) = mpsc::channel(128);
        let (notifications, _) = broadcast::channel(1024);
        (
            Self {
                inner: Arc::new(Inner {
                    outgoing,
                    pending: Mutex::new(HashMap::new()),
                    notifications,
                    closed: AtomicBool::new(false),
                    initializing: AtomicBool::new(false),
                    initialized: AtomicBool::new(false),
                    next_id: AtomicU64::new(1),
                    tasks: Mutex::new(Vec::new()),
                    child: Mutex::new(None),
                    timeout: Duration::from_secs(30),
                }),
            },
            rx,
        )
    }
    pub async fn connect(path: &Path) -> Result<Self> {
        Self::connect_with_limit(path, MAX_FRAME_BYTES).await
    }
    pub async fn connect_with_limit(path: &Path, max_payload: usize) -> Result<Self> {
        if !(MAX_FRAME_BYTES..=1024 * 1024 * 1024).contains(&max_payload) {
            bail!("Invalid shared Codex frame limit.");
        }
        let ws = connect_codex_socket(path, max_payload).await?;
        let (client, mut outgoing) = Self::new();
        let (mut sink, mut stream) = ws.split();
        let send = Arc::downgrade(&client.inner);
        let writer = tokio::spawn(async move {
            while let Some(value) = outgoing.recv().await {
                let text = match crate::json::stringify(&value) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
            if let Some(inner) = send.upgrade() {
                CodexClient { inner }
                    .fail("Shared Codex transport failed")
                    .await;
            }
        });
        let receive = Arc::downgrade(&client.inner);
        let reader = tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                let Some(inner) = receive.upgrade() else {
                    break;
                };
                let client = CodexClient { inner };
                match frame {
                    Ok(Message::Text(text)) => {
                        if client.receive(text.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => (),
                    _ => break,
                }
            }
            if let Some(inner) = receive.upgrade() {
                CodexClient { inner }
                    .fail("Shared Codex transport closed")
                    .await;
            }
        });
        client.inner.tasks.lock().await.extend([writer, reader]);
        Ok(client)
    }
    pub async fn spawn(binary: &Path, codex_home: &Path) -> Result<Self> {
        let mut child = Command::new(binary)
            .args(["app-server", "--stdio"])
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child
            .stdin
            .take()
            .context("Codex transport stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Codex transport stdout is unavailable")?;
        let (client, mut outgoing) = Self::new();
        *client.inner.child.lock().await = Some(child);
        let send = client.clone();
        let writer = tokio::spawn(async move {
            while let Some(value) = outgoing.recv().await {
                let mut text = match crate::json::stringify(&value) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                text.push('\n');
                if stdin.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
            }
            send.fail("Codex transport failed").await;
        });
        let receive = client.clone();
        let reader = tokio::spawn(async move {
            let mut input = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                // Read in bounded chunks: never allocate an unbounded JSONL line.
                let read = async {
                    loop {
                        let chunk = input.fill_buf().await?;
                        if chunk.is_empty() {
                            return Ok::<bool, std::io::Error>(false);
                        }
                        let count = chunk
                            .iter()
                            .position(|b| *b == b'\n')
                            .map(|n| n + 1)
                            .unwrap_or(chunk.len());
                        if line.len().saturating_add(count) > MAX_FRAME_BYTES {
                            return Err(std::io::Error::other(
                                "Codex response exceeded the transport frame limit",
                            ));
                        }
                        line.extend_from_slice(&chunk[..count]);
                        let done = chunk[count - 1] == b'\n';
                        input.consume(count);
                        if done {
                            return Ok(true);
                        }
                    }
                }
                .await;
                if !matches!(read, Ok(true)) || receive.receive(&line).await.is_err() {
                    break;
                }
            }
            receive.fail("Codex transport exited").await;
        });
        client.inner.tasks.lock().await.extend([writer, reader]);
        Ok(client)
    }
    async fn receive(&self, bytes: &[u8]) -> Result<()> {
        let value: Value =
            serde_json::from_slice(bytes).context("Invalid JSON from Codex transport")?;
        if !value.is_object() {
            bail!("Invalid JSON from Codex transport");
        }
        if value.get("id").is_some() && value.get("method").is_some() {
            self.send(json!({"id":value["id"],"error":{"code":-32601,"message":"Interactive requests are not supported by the history bridge"}})).await?;
        } else if let Some(id) = value.get("id").and_then(Value::as_u64) {
            if let Some(reply) = self.inner.pending.lock().await.remove(&id) {
                let response = match value.get("error") {
                    Some(error) => Err(RpcError {
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex RPC error")
                            .to_owned(),
                        code: error.get("code").cloned(),
                        execution_uncertain: false,
                    }),
                    None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(response);
            }
        } else {
            let _ = self.inner.notifications.send(value);
        }
        Ok(())
    }
    async fn fail(&self, message: &str) {
        if !self.inner.closed.swap(true, Ordering::SeqCst) {
            for (_, reply) in self.inner.pending.lock().await.drain() {
                let _ = reply.send(Err(RpcError {
                    message: format!("{message}; {UNKNOWN}"),
                    code: None,
                    execution_uncertain: true,
                }));
            }
            let _ = self
                .inner
                .notifications
                .send(json!({"method":"claudex/disconnected","params":{}}));
        }
    }
    async fn send(&self, value: Value) -> Result<()> {
        if self.inner.closed.load(Ordering::SeqCst) {
            bail!("Codex transport is not connected");
        }
        if crate::json::stringify(&value)?.len() > MAX_FRAME_BYTES {
            bail!("Codex message exceeds the transport size limit");
        }
        self.inner
            .outgoing
            .send(value)
            .await
            .with_context(|| format!("Codex send failed; {UNKNOWN}"))
    }
    pub async fn initialize(&self) -> Result<Value> {
        if self.inner.initializing.swap(true, Ordering::SeqCst)
            || self.inner.initialized.load(Ordering::SeqCst)
        {
            bail!("Codex client is already initialized or initializing");
        }
        let result=self.request("initialize",json!({"clientInfo":{"name":"claudex","version":"1.0.3"},"capabilities":{"experimentalApi":true}})).await;
        self.inner.initializing.store(false, Ordering::SeqCst);
        match result {
            Ok(result) => {
                self.notify("initialized", json!({})).await?;
                self.inner.initialized.store(true, Ordering::SeqCst);
                Ok(result)
            }
            Err(e) => {
                self.close().await?;
                Err(e)
            }
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.notifications.subscribe()
    }
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if self.inner.closed.load(Ordering::SeqCst) {
            bail!("Codex transport is not connected");
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, rx) = oneshot::channel();
        {
            let mut pending = self.inner.pending.lock().await;
            if pending.len() >= 128 {
                bail!("Too many pending Codex requests");
            }
            pending.insert(id, reply);
        }
        if let Err(error) = self
            .send(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        let result = timeout(self.inner.timeout, rx).await;
        self.inner.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error.into()),
            Ok(Err(_)) => bail!("Codex transport closed; {UNKNOWN}"),
            Err(_) => bail!("Codex request timed out: {method}; {UNKNOWN}"),
        }
    }
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"method":method,"params":params})).await
    }
    pub async fn close(&self) -> Result<()> {
        self.fail("Codex client closed").await;
        for task in self.inner.tasks.lock().await.drain(..) {
            task.abort();
            let _ = task.await;
        }
        if let Some(mut child) = self.inner.child.lock().await.take() {
            if child.try_wait()?.is_none() {
                if let Some(pid) = child.id() {
                    // Only this client's independently spawned native process is signaled.
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                    child.kill().await?;
                    child.wait().await?;
                }
            }
        }
        Ok(())
    }
}
