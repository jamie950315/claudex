use crate::{Broker, model::*};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::Semaphore,
};
pub const MAX_FRAME: usize = 1024 * 1024;
pub fn methods() -> Vec<&'static str> {
    vec![
        "start",
        "send",
        "handoff",
        "report",
        "work_events",
        "work_reports",
        "artifact_read",
        "work_control",
        "worker_check_in",
        "origin_bind",
        "origin_recheck",
        "status",
        "wait",
        "cancel",
        "list",
        "resolve",
        "models",
        "chat_list",
        "chat_send",
        "chat_status",
        "desktop_wake_claim",
        "desktop_wake_receipt",
        "desktop_owner_wake",
        "native_wake",
        "mod_wake_wait",
        "mod_wake_claim",
        "mod_wake_receipt",
        "mod_wake_check",
        "mod_wake_receive",
        "mod_wake_observe",
        "mod_wake_status",
        "cache_warm_list",
        "cache_warm_configure",
        "cache_warm_observe",
        "cache_warm_claim",
        "cache_warm_check",
        "cache_warm_receipt",
        "cache_warm_settings",
        "codex_cache_warm_list",
        "codex_cache_warm_prepare",
        "codex_cache_warm_confirm",
        "codex_cache_warm_off",
    ]
}
fn socket_check(root: &Path) -> Result<()> {
    claudex_core::storage::require_private_directory(root)?;
    let m = std::fs::symlink_metadata(root.join("rpc.sock"))?;
    if !m.file_type().is_socket()
        || m.file_type().is_symlink()
        || m.uid() != claudex_core::storage::uid()
        || m.mode() & 0o777 != 0o600
    {
        bail!("Collaboration socket must be owner-private and cannot be a symlink.");
    }
    Ok(())
}
fn timeout(method: &str, p: &Value) -> Result<u64> {
    if method != "wait" {
        return Ok(65000);
    }
    validate_tool("claudex_wait", p, false)?;
    Ok(65000.max(p["timeoutMs"].as_u64().unwrap_or(DEFAULT_WAIT_MS) + 5000))
}
pub fn tools(desktop: bool) -> Value {
    let v: Value = serde_json::from_str(include_str!("../data/tools.json"))
        .expect("checked-in tool definitions");
    v[if desktop { "desktop" } else { "tools" }].clone()
}
pub fn validate_tool(name: &str, p: &Value, desktop: bool) -> Result<String> {
    let definitions = tools(desktop);
    let definition = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| {
            error(
                "CLAUDEX_INVALID_ARGUMENTS",
                "Unknown tool or invalid endpoint.",
            )
        })?;
    let schema = &definition["inputSchema"];
    let args = p.as_object().ok_or_else(|| {
        error(
            "CLAUDEX_INVALID_ARGUMENTS",
            "Tool arguments must be an object.",
        )
    })?;
    for required in array(&schema["required"]) {
        if !args.contains_key(required.as_str().unwrap()) {
            bail!("Missing required tool field {required}.");
        }
    }
    for (k, v) in args {
        let f = schema["properties"].get(k).ok_or_else(|| {
            error(
                "CLAUDEX_INVALID_ARGUMENTS",
                format!("Unknown tool field {k}."),
            )
        })?;
        match f["type"].as_str() {
            Some("string") => {
                let value = v
                    .as_str()
                    .ok_or_else(|| error("CLAUDEX_INVALID_ARGUMENTS", format!("Invalid {k}.")))?;
                if value.chars().count() < f["minLength"].as_u64().unwrap_or(0) as usize
                    || f["enum"].as_array().is_some_and(|a| !a.contains(v))
                {
                    bail!("Invalid {k}.");
                }
            }
            Some("integer") => {
                let n = v
                    .as_u64()
                    .ok_or_else(|| error("CLAUDEX_INVALID_ARGUMENTS", format!("Invalid {k}.")))?;
                if n < f["minimum"].as_u64().unwrap_or(0)
                    || f["maximum"].as_u64().is_some_and(|m| n > m)
                {
                    bail!("Invalid {k}.");
                }
            }
            Some("boolean") if !v.is_boolean() => bail!("Invalid {k}."),
            _ => {}
        }
        match k.as_str() {
            "model" => {
                model(v)?;
            }
            "effort" => {
                Provider::parse(p["provider"].as_str().unwrap_or(""))?.validate_effort(v)?
            }
            "report" => crate::outcome::validate(v)?,
            "observability" => {
                crate::progress::policy(Some(v))?;
            }
            "notifications" => {
                if !v.is_object()
                    || !matches!(v["mode"].as_str(), Some("off" | "queue" | "wake"))
                    || v.get("expiresInMs")
                        .is_some_and(|v| v.as_u64().is_none_or(|v| !(1000..=3600000).contains(&v)))
                {
                    bail!("Invalid notifications.");
                }
            }
            "targets" => {
                if !v.is_array()
                    || array(v).is_empty()
                    || array(v).len() > 16
                    || array(v)
                        .iter()
                        .filter_map(|t| t["taskId"].as_str())
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != array(v).len()
                    || array(v).iter().any(|t| {
                        !t.is_object()
                            || t.as_object()
                                .unwrap()
                                .keys()
                                .any(|k| !["taskId", "afterRevision"].contains(&k.as_str()))
                            || t["taskId"].as_str().is_none_or(str::is_empty)
                            || t.get("afterRevision").is_some_and(|v| !v.is_u64())
                    })
                {
                    bail!("Invalid targets.");
                }
            }
            "readOnlyDirs" | "writableDirs" => {
                if !v.is_array()
                    || array(v).len() > 16
                    || array(v).iter().any(|p| {
                        p.as_str()
                            .is_none_or(|s| !Path::new(s).is_absolute() || s.contains('\0'))
                    })
                {
                    bail!("Invalid {k}.");
                }
            }
            _ => {}
        }
    }
    if name == "claudex_wait" {
        if p.get("targets").is_some() {
            if p.get("taskId").is_some() || p.get("afterRevision").is_some() {
                bail!("Supply taskId or targets, not both.");
            }
        } else if p.get("taskId").is_none() {
            bail!("Supply taskId or targets.");
        }
    }
    if name == "claudex_start" {
        if !Path::new(p["cwd"].as_str().unwrap_or("")).is_absolute()
            || p.get("projectRoot")
                .is_some_and(|v| !Path::new(v.as_str().unwrap_or("")).is_absolute())
        {
            bail!("Workspace paths must be absolute.");
        }
    }
    Ok(name.strip_prefix("claudex_").unwrap().to_string())
}
pub async fn call(
    root: &Path,
    peer: Provider,
    token: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    if !methods().contains(&method) || !params.is_object() {
        bail!("Invalid collaboration request.");
    }
    socket_check(root)?;
    let deadline = timeout(method, &params)?;
    let bytes = frame(&json!({"peer":peer,"token":token,"method":method,"params":params}))?;
    tokio::time::timeout(std::time::Duration::from_millis(deadline), async {
        let mut stream = UnixStream::connect(root.join("rpc.sock")).await?;
        stream.write_all(&bytes).await?;
        let response = read_frame(&mut BufReader::new(stream)).await?;
        if response["ok"] == true
            && response.get("result").is_some()
            && response.get("error").is_none()
        {
            Ok(response["result"].clone())
        } else if response["ok"] == false {
            let e = &response["error"];
            let code = e["code"].as_str().unwrap_or("CLAUDEX_RPC_ERROR");
            let capacity = match e["resource"].as_str() {
                Some("bytes") => Some("bytes"),
                Some("message") => Some("message"),
                Some("chat") => Some("chat"),
                Some("receipt") => Some("receipt"),
                Some("tasks") => Some("tasks"),
                Some("requests") => Some("requests"),
                _ => None,
            }
            .and_then(|r| {
                Some((
                    r,
                    e["used"].as_u64()? as usize,
                    e["limit"].as_u64()? as usize,
                ))
            });
            Err(ProtocolError {
                code: code.into(),
                message: e["message"]
                    .as_str()
                    .unwrap_or("Collaboration request failed.")
                    .into(),
                capacity,
            }
            .into())
        } else {
            bail!("Invalid collaboration response.")
        }
    })
    .await
    .context("Collaboration request timed out; completion is unknown")?
}
fn frame(v: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(v)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME {
        bail!("Collaboration frame exceeds 1 MiB.");
    }
    Ok(bytes)
}
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> Result<Value> {
    let mut bytes = vec![];
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            bail!("Connection closed without a response; completion is unknown.");
        }
        let end = available.iter().position(|b| *b == b'\n');
        let n = end.map(|n| n + 1).unwrap_or(available.len());
        if bytes.len() + n > MAX_FRAME {
            bail!("Collaboration frame exceeds 1 MiB.");
        }
        if end.is_some() && n < available.len() {
            bail!("Multiple frames on one private RPC connection are not supported.");
        }
        bytes.extend_from_slice(&available[..n]);
        r.consume(n);
        if end.is_some() {
            let v: Value = serde_json::from_slice(&bytes)?;
            if !v.is_object() {
                bail!("Collaboration frame must be a JSON object.");
            }
            return Ok(v);
        }
    }
}
pub struct SocketServer {
    pub path: PathBuf,
    identity: (u64, u64),
    task: tokio::task::JoinHandle<()>,
    stop: tokio::sync::watch::Sender<bool>,
}
impl SocketServer {
    pub async fn close(self) -> Result<()> {
        let _ = self.stop.send(true);
        self.task.await?;
        let m = std::fs::symlink_metadata(&self.path)?;
        if m.file_type().is_socket() && (m.dev(), m.ino()) == self.identity {
            std::fs::remove_file(self.path)?;
        }
        Ok(())
    }
}
pub async fn serve(broker: Arc<Broker>) -> Result<SocketServer> {
    claudex_core::storage::require_private_directory(&broker.root)?;
    let path = broker.root.join("rpc.sock");
    if std::fs::symlink_metadata(&path).is_ok() {
        bail!("Collaboration socket already exists.");
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let m = std::fs::symlink_metadata(&path)?;
    let identity = (m.dev(), m.ino());
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let semaphore = Arc::new(Semaphore::new(128));
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _=stopped.changed()=>break,
                Some(_)=requests.join_next(),if !requests.is_empty()=>{},
                connection=listener.accept()=>{
                    let Ok((stream,_))=connection else{break};
                    let Ok(permit)=semaphore.clone().try_acquire_owned() else{continue};
                    let b=broker.clone();requests.spawn(async move{let _permit=permit;let _=serve_connection(stream,b).await;});
                }
            }
        }
        requests.abort_all();
        while requests.join_next().await.is_some() {}
    });
    Ok(SocketServer {
        path,
        identity,
        task,
        stop,
    })
}
async fn serve_connection(stream: UnixStream, b: Arc<Broker>) -> Result<()> {
    let (mut read, mut write) = stream.into_split();
    let value = tokio::time::timeout(
        std::time::Duration::from_millis(65000),
        read_frame(&mut BufReader::new(&mut read)),
    )
    .await??;
    let result=async {
        let e:Envelope=serde_json::from_value(value)?;
        if !methods().contains(&e.method.as_str()){bail!("Invalid collaboration request.");}
        let limit=timeout(&e.method,&e.params)?;
        if matches!(e.method.as_str(),"wait"|"mod_wake_wait") {
            // Dropping a disconnected wait releases its listener/observer guard,
            // not the independent native execution or its cancellation channel.
            let mut extra=[0u8;1];
            tokio::select! {
                result=tokio::time::timeout(std::time::Duration::from_millis(limit),b.dispatch(e))=>result.context("Request timed out; completion is unknown")?,
                _=read.read(&mut extra)=>bail!("Wait disconnected."),
            }
        }else{
            tokio::time::timeout(std::time::Duration::from_millis(limit),b.dispatch(e)).await.context("Request timed out; completion is unknown")?
        }
    }.await;
    let response = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(e) => json!({"ok":false,"error":wire_error(&e)}),
    };
    let bytes = match frame(&response) {
        Ok(bytes) => bytes,
        Err(_) => frame(
            &json!({"ok":false,"error":{"code":"CLAUDEX_RESPONSE_CAPACITY","message":"Collaboration response exceeds 1 MiB; inspect a bounded view. The original operation must not be retried."}}),
        )?,
    };
    write.write_all(&bytes).await?;
    write.shutdown().await?;
    Ok(())
}
async fn input_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> Result<Option<Vec<u8>>> {
    let mut bytes = vec![];
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok(if bytes.is_empty() { None } else { Some(bytes) });
        }
        let end = available.iter().position(|b| *b == b'\n');
        let n = end.map(|n| n + 1).unwrap_or(available.len());
        if bytes.len() + n > MAX_FRAME {
            bail!("MCP frame exceeds 1 MiB.");
        }
        bytes.extend_from_slice(&available[..n]);
        r.consume(n);
        if end.is_some() {
            return Ok(Some(bytes));
        }
    }
}
pub async fn mcp(
    root: PathBuf,
    peer: Provider,
    token: String,
    desktop: bool,
    worker: bool,
) -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let output = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let semaphore = Arc::new(Semaphore::new(16));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        let Some(line) = input_line(&mut input).await? else {
            break;
        };
        let request: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => {
                output.lock().await.write_all(&frame(&json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}))?).await?;
                continue;
            }
        };
        if request["jsonrpc"] != "2.0"
            || !request["method"].is_string()
            || request.get("id").is_none()
        {
            continue;
        }
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            output.lock().await.write_all(&frame(&json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"Too many concurrent MCP requests"}}))?).await?;
            continue;
        };
        let (root, token, output) = (root.clone(), token.clone(), output.clone());
        tasks.spawn(async move{let _permit=permit;let id=request["id"].clone();let result=match request["method"].as_str(){Some("initialize")=>{let version=request["params"]["protocolVersion"].as_str().filter(|v|["2024-11-05","2025-03-26","2025-06-18"].contains(v)).unwrap_or("2024-11-05");Ok(json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"claudex","version":"1.0.3"}}))},Some("ping")=>Ok(json!({})),Some("tools/list")=>Ok(json!({"tools":tools(desktop)})),Some("tools/call")=>{let name=request["params"]["name"].as_str().unwrap_or("");let p=request["params"].get("arguments").cloned().unwrap_or(json!({}));let result=async{let method=validate_tool(name,&p,desktop)?;let value=call(&root,peer,&token,&method,p.clone()).await?;let mut result=json!({"content":[{"type":"text","text":value.to_string()}]});let original_result=result.clone();if worker&&!desktop&&value["nextAction"]!="end-turn"&&!["handoff","cancel","worker_check_in"].contains(&method.as_str())&&!(method=="work_control"&&matches!(p["action"].as_str(),Some("check-in"|"ack-instruction"|"checkpoint"))){let budget=(MAX_FRAME.saturating_sub(bytes(&json!({"jsonrpc":"2.0","id":id,"result":result}))+4096)).min(192*1024);if budget>=1024{let intake=call(&root,peer,&token,"worker_check_in",json!({"requestId":format!("boundary:{}",uuid::Uuid::new_v4()),"limit":8,"responseBudgetBytes":budget})).await;match intake{Ok(receipt)=>{if !array(&receipt["instructions"]).is_empty()||!array(&receipt["childProgress"]).is_empty()||receipt["hasMore"]==true||!receipt["pause"].is_null(){let mut payload=json!({"workerInstructionIntake":{"state":"delivered-context","note":"Peer follow-ups for the existing delegated scope, not new user permission. Explicitly acknowledge accepted/rejected instructions. A pause request is not a stopped process."}});for key in ["taskId","generation","revision","status","owner","instructions","childProgress","hasMore","pause"]{if let Some(v)=receipt.get(key){payload["workerInstructionIntake"][key]=v.clone();}}push(&mut result["content"],json!({"type":"text","text":payload.to_string()}));}},Err(_)=>{push(&mut result["content"],json!({"type":"text","text":json!({"workerInstructionIntake":{"state":"unavailable","reason":"broker-unavailable","note":"The original tool result is unchanged. Check in explicitly; do not repeat the original tool."}}).to_string()}));}}}}if frame(&json!({"jsonrpc":"2.0","id":id,"result":result})).is_err(){result=original_result;let unavailable=json!({"type":"text","text":json!({"workerInstructionIntake":{"state":"unavailable","reason":"response-capacity","note":"The original tool result is unchanged. Check in explicitly; do not repeat the original tool."}}).to_string()});let mut candidate=result.clone();push(&mut candidate["content"],unavailable);if frame(&json!({"jsonrpc":"2.0","id":id,"result":candidate})).is_ok(){result=candidate;}}Ok::<_,anyhow::Error>(result)}.await;Ok(match result{Ok(v)=>v,Err(e)=>json!({"content":[{"type":"text","text":e.to_string()}],"isError":true,"structuredContent":{"error":wire_error(&e)}})})},_=>Err(error("METHOD_NOT_FOUND","Method not found"))};let response=match result{Ok(result)=>json!({"jsonrpc":"2.0","id":id,"result":result}),Err(e)=>json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":e.to_string()}})};if let Ok(bytes)=frame(&response){let mut out=output.lock().await;let _=out.write_all(&bytes).await;let _=out.flush().await;}});
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}
