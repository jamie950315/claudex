use crate::{model::*, processes, workspace};
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, watch},
};

#[derive(Debug, Clone)]
pub struct Invocation {
    pub task: Value,
    pub prompt: String,
    pub mcp: Value,
    pub cancellation: watch::Receiver<bool>,
}
#[derive(Debug, Clone)]
pub struct NativeResult {
    pub text: String,
    pub session_id: Option<String>,
    pub usage: Option<Value>,
    pub activity: Option<Value>,
}
#[derive(Debug)]
pub struct NativeFailure {
    pub message: String,
    pub uncertain: bool,
    pub usage: Option<Value>,
    pub activity: Option<Value>,
}
impl NativeFailure {
    pub fn before(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            uncertain: false,
            usage: None,
            activity: None,
        }
    }
    pub fn uncertain(message: impl Into<String>) -> Self {
        Self {
            uncertain: true,
            ..Self::before(message)
        }
    }
}
#[async_trait]
pub trait NativeRunner: Send + Sync {
    async fn run(
        &self,
        invocation: Invocation,
        events: mpsc::Sender<Value>,
    ) -> std::result::Result<NativeResult, NativeFailure>;
    fn tracks_owned_processes(&self) -> bool {
        false
    }
}
pub struct NativeCliRunner {
    pub codex: PathBuf,
    pub claude: PathBuf,
}
impl Default for NativeCliRunner {
    fn default() -> Self {
        Self {
            codex: "codex".into(),
            claude: "claude".into(),
        }
    }
}
pub fn launch_args(t: &Value, mcp: &Value, registered: bool) -> Result<Vec<String>> {
    let p = Provider::parse(t["owner"].as_str().unwrap_or(""))?;
    let permission = Permission::parse(t["permission"].as_str().unwrap_or(""))?;
    let full = permission == Permission::FullAccess;
    let mut args: Vec<String> = if p == Provider::Codex {
        vec!["exec", "--json", "--ephemeral"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        vec![
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    };
    if p == Provider::Codex {
        if !full {
            args.push("--ignore-user-config".into());
        }
        args.extend([
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            if full {
                "danger-full-access".into()
            } else {
                permission.as_str().into()
            },
            "-c".into(),
            "approval_policy=\"never\"".into(),
        ]);
        if full && registered {
            args.extend(["-c".into(), "mcp_servers.claudex-work.enabled=false".into()]);
        }
        if let Some(m) = t["model"].as_str() {
            args.extend(["--model".into(), m.into()]);
        }
        if let Some(e) = t["effort"].as_str() {
            p.validate_effort(&json!(e))?;
            args.extend(["-c".into(), format!("model_reasoning_effort={}", json!(e))]);
        }
        for dir in array(&t["writableDirs"]) {
            args.extend([
                "--add-dir".into(),
                dir.as_str().context("Invalid write directory")?.into(),
            ]);
        }
        if permission == Permission::WorkspaceWrite && !array(&t["readOnlyDirs"]).is_empty() {
            args.extend([
                "-c".into(),
                "sandbox_workspace_write.exclude_tmpdir_env_var=true".into(),
                "-c".into(),
                "sandbox_workspace_write.exclude_slash_tmp=true".into(),
            ]);
        }
        if mcp.is_object() {
            for (k, v) in [
                ("command", mcp["command"].clone()),
                ("args", mcp["args"].clone()),
                (
                    "env_vars",
                    json!(
                        mcp["env"]
                            .as_object()
                            .map(|m| m.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    ),
                ),
                ("required", json!(true)),
                ("default_tools_approval_mode", json!("approve")),
            ] {
                args.extend(["-c".into(), format!("mcp_servers.claudex.{k}={v}")]);
            }
        }
        args.push("-".into());
    } else {
        if full {
            args.extend([
                "--dangerously-skip-permissions".into(),
                "--disallowedTools".into(),
                "mcp__claudex-work".into(),
            ]);
        } else {
            let tools = if permission == Permission::ReadOnly {
                "Read,Glob,Grep"
            } else {
                "Read,Glob,Grep,Edit,Write"
            };
            args.extend([
                "--restricted".into(),
                "--strict-mcp-config".into(),
                "--permission-mode".into(),
                "dontAsk".into(),
                "--permission-prompts".into(),
                "none".into(),
                "--tools".into(),
                tools.into(),
                "--allowedTools".into(),
                if mcp.is_object() {
                    format!("{tools},mcp__claudex__*")
                } else {
                    tools.into()
                },
            ]);
        }
        let additional = if full {
            array(&t["writableDirs"])
        } else {
            [array(&t["readOnlyDirs"]), array(&t["writableDirs"])].concat()
        };
        if !additional.is_empty() {
            args.push("--add-dir".into());
            for p in additional {
                args.push(p.as_str().context("Invalid additional directory")?.into());
            }
        }
        if permission == Permission::WorkspaceWrite && !array(&t["readOnlyDirs"]).is_empty() {
            let mut deny = vec![];
            for p in array(&t["readOnlyDirs"]) {
                let path = p.as_str().context("Invalid reference directory")?;
                if path
                    .chars()
                    .any(|c| c.is_control() || "*?[]{}()!\\".contains(c))
                {
                    bail!(
                        "Claude read-only directory cannot be represented safely in native permission rules."
                    );
                }
                deny.extend([format!("Edit(/{path})"), format!("Edit(/{path}/**)")]);
            }
            args.extend([
                "--settings".into(),
                json!({"permissions":{"deny":deny}}).to_string(),
            ]);
        }
        for (k, flag) in [("model", "--model"), ("effort", "--effort")] {
            if let Some(v) = t[k].as_str() {
                if k == "effort" {
                    p.validate_effort(&json!(v))?;
                }
                args.extend([flag.into(), v.into()]);
            }
        }
        if mcp.is_object() {
            args.extend([
                "--mcp-config".into(),
                json!({"mcpServers":{"claudex":{"command":mcp["command"],"args":mcp["args"]}}})
                    .to_string(),
            ]);
        }
    }
    Ok(args)
}
pub fn normalize_usage(p: Provider, raw: &Value, cost: Option<f64>) -> Option<Value> {
    let count = |k: &str, default: Option<u64>| {
        raw.get(k)
            .map_or(default, Value::as_u64)
            .filter(|x| *x <= 9_007_199_254_740_991)
    };
    let (output, input, read, write, reason) = if p == Provider::Codex {
        (
            count("output_tokens", None)?,
            count("input_tokens", None)?,
            count("cached_input_tokens", Some(0))?,
            count("cache_write_input_tokens", Some(0))?,
            Some(count("reasoning_output_tokens", Some(0))?),
        )
    } else {
        let r = count("cache_read_input_tokens", Some(0))?;
        let w = count("cache_creation_input_tokens", Some(0))?;
        (
            count("output_tokens", None)?,
            count("input_tokens", None)?
                .checked_add(r)?
                .checked_add(w)?,
            r,
            w,
            None,
        )
    };
    if read.checked_add(write)? > input || reason.unwrap_or(0) > output {
        return None;
    }
    let mut v = json!({"inputTokens":input,"cacheReadInputTokens":read,"cacheWriteInputTokens":write,"outputTokens":output});
    if let Some(r) = reason {
        v["reasoningOutputTokens"] = json!(r);
    }
    if let Some(c) = cost.filter(|c| c.is_finite() && *c >= 0.0) {
        v["reportedCostUsd"] = json!(c);
    }
    Some(v)
}
pub fn failure_detail(values: Vec<&str>) -> String {
    fn bounded(s: &str) -> String {
        let mut count = 0;
        s.chars()
            .take_while(|c| {
                count += c.len_utf16();
                count <= 1536
            })
            .collect()
    }
    let joined = values
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .take(4)
        .map(|s| {
            bounded(s)
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
                .trim()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("; ");
    bounded(&joined)
}
#[derive(Default)]
pub struct Decoder {
    pub text: String,
    pub session: Option<String>,
    pub terminal: Option<bool>,
    pub conflicting: bool,
    pub failure: String,
    pub usage: Value,
    pub cost: Option<f64>,
}
impl Decoder {
    pub fn observe(&mut self, p: Provider, e: &Value) {
        let ty = e["type"].as_str().unwrap_or("");
        if p == Provider::Codex {
            if ty == "thread.started" {
                self.session = e["thread_id"].as_str().map(str::to_owned);
            }
            if ty == "item.completed" && e["item"]["type"] == "agent_message" {
                if let Some(s) = e["item"]["text"].as_str() {
                    self.text = s.into();
                }
            }
            if matches!(ty, "turn.completed" | "turn.failed") {
                let good = ty == "turn.completed";
                if self.terminal.is_some_and(|old| old != good) {
                    self.conflicting = true;
                }
                self.terminal = Some(good);
                self.usage = e["usage"].clone();
                if !good {
                    self.failure =
                        failure_detail(e["error"]["message"].as_str().into_iter().collect());
                }
            }
        } else {
            if let Some(id) = e["session_id"].as_str() {
                self.session = Some(id.into());
            }
            if ty == "result" {
                if let Some(failed) = e["is_error"].as_bool() {
                    let good = !failed;
                    if self.terminal.is_some_and(|old| old != good) {
                        self.conflicting = true;
                    }
                    self.terminal = Some(good);
                    if let Some(s) = e["result"].as_str() {
                        self.text = s.into();
                    }
                    self.usage = e["usage"].clone();
                    self.cost = e["total_cost_usd"].as_f64();
                    if failed {
                        self.failure = failure_detail(
                            e["errors"]
                                .as_array()
                                .map(|v| v.iter().filter_map(Value::as_str).collect())
                                .unwrap_or_default(),
                        );
                        if self.failure.is_empty() {
                            self.failure =
                                failure_detail(e["result"].as_str().into_iter().collect());
                        }
                    }
                }
            }
        }
    }
}
async fn registered(command: &PathBuf) -> Result<bool> {
    let mut cmd = Command::new(command);
    cmd.args(["mcp", "get", "claudex-work", "--json"]);
    for k in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ] {
        cmd.env_remove(k);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await??;
    if out.stdout.len() > 65536 || out.stderr.len() > 4096 {
        bail!("Native MCP registration output exceeded its bound.");
    }
    if out.status.success() {
        return Ok(serde_json::from_slice::<Value>(&out.stdout)?["name"] == "claudex-work");
    }
    if String::from_utf8_lossy(&out.stderr).contains("No MCP server named") {
        return Ok(false);
    }
    bail!("Could not read native Codex MCP configuration.")
}
async fn bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<usize> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(line.len());
        }
        let end = available.iter().position(|b| *b == b'\n');
        let take = end.map(|n| n + 1).unwrap_or(available.len());
        if line.len() + take > 2 * 1024 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Native line exceeds 2 MiB.",
            ));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() {
            return Ok(line.len());
        }
    }
}
async fn login_path() -> Result<String> {
    static PATH: std::sync::LazyLock<tokio::sync::Mutex<Option<(std::time::Instant, String)>>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
    let mut saved = PATH.lock().await;
    if let Some((at, value)) = &*saved
        && at.elapsed() < std::time::Duration::from_secs(600)
    {
        return Ok(value.clone());
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| std::path::Path::new(s).is_absolute())
        .unwrap_or("/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args([
        "-l",
        "-i",
        "-c",
        "printf \"__CLAUDEX_PATH__%s__END__\" \"$PATH\"",
    ])
    .env_clear()
    .env(
        "PATH",
        std::env::var("PATH").unwrap_or("/usr/bin:/bin".into()),
    )
    .env("TERM", "dumb")
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    for k in ["HOME", "USER", "LOGNAME", "SHELL", "LANG"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut bytes = vec![];
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        stdout.take(262145).read_to_end(&mut bytes).await?;
        if bytes.len() > 262144 {
            bail!("Login shell PATH output exceeded its bound.");
        }
        child.wait().await?;
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let raw = std::str::from_utf8(&bytes)?;
    let value = raw
        .split_once("__CLAUDEX_PATH__")
        .and_then(|(_, s)| s.split_once("__END__"))
        .map(|(s, _)| s)
        .context("The login shell did not report PATH")?;
    if value.is_empty()
        || value.len() > 65536
        || value
            .split(':')
            .any(|p| !p.is_empty() && !std::path::Path::new(p).is_absolute())
    {
        bail!("The login shell did not report a usable PATH.");
    }
    let value = value.to_owned();
    *saved = Some((std::time::Instant::now(), value.clone()));
    Ok(value)
}
#[async_trait]
impl NativeRunner for NativeCliRunner {
    fn tracks_owned_processes(&self) -> bool {
        true
    }
    async fn run(
        &self,
        mut inv: Invocation,
        events: mpsc::Sender<Value>,
    ) -> std::result::Result<NativeResult, NativeFailure> {
        let p = Provider::parse(inv.task["owner"].as_str().unwrap_or(""))
            .map_err(|e| NativeFailure::before(e.to_string()))?;
        workspace::revalidate(&inv.task).map_err(|e| NativeFailure::before(e.to_string()))?;
        if *inv.cancellation.borrow() {
            return Err(NativeFailure::before(
                "Native execution was cancelled before launch.",
            ));
        }
        let full = inv.task["permission"] == "full-access";
        let command = if p == Provider::Codex {
            &self.codex
        } else {
            &self.claude
        };
        let registration = if p == Provider::Codex && full {
            registered(command)
                .await
                .map_err(|e| NativeFailure::before(e.to_string()))?
        } else {
            false
        };
        let mut args = launch_args(&inv.task, &inv.mcp, registration)
            .map_err(|e| NativeFailure::before(e.to_string()))?;
        let mut decoder = Decoder::default();
        if p == Provider::Claude {
            let id = uuid::Uuid::new_v4().to_string();
            args.extend(["--session-id".into(), id.clone()]);
            decoder.session = Some(id);
        }
        let mut cmd = Command::new(command);
        if full {
            match login_path().await {
                Ok(path) => {
                    cmd.env("PATH", path);
                }
                Err(_) => eprintln!(
                    "Claudex could not read the login shell PATH for a full-access worker; inherited PATH remains in use."
                ),
            }
        }
        cmd.args(args)
            .current_dir(inv.task["cwd"].as_str().unwrap_or(""))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0);
        for k in [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CODEX_THREAD_ID",
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
        ] {
            cmd.env_remove(k);
        }
        if p == Provider::Claude {
            cmd.env_remove("CLAUDE_CONFIG_DIR")
                .env_remove("CLAUDE_CODE_EFFORT_LEVEL");
        }
        if let Some(env) = inv.mcp["env"].as_object() {
            for (k, v) in env {
                if [
                    "OPENAI_API_KEY",
                    "CODEX_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                ]
                .contains(&k.as_str())
                {
                    return Err(NativeFailure::before(
                        "mcp.env cannot override native account authentication.",
                    ));
                }
                cmd.env(k, v.as_str().unwrap_or(""));
            }
        }
        cmd.env("CLAUDEX_COLLABORATION_WORKER", "1");
        let mut child = cmd
            .spawn()
            .map_err(|_| NativeFailure::before("Could not start native collaboration process."))?;
        let pid = child
            .id()
            .ok_or_else(|| NativeFailure::uncertain("Native process identity is unavailable."))?;
        events
            .send(json!({"type":"spawn","pid":pid}))
            .await
            .map_err(|_| NativeFailure::uncertain("Native event handler failed."))?;
        let mut owned = vec![];
        let initial = processes::table()
            .await
            .and_then(|table| processes::refresh(&mut owned, pid, &table));
        if let Err(e) = initial {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = events
                .send(json!({"type":"process-inspection-failed"}))
                .await;
            return Err(NativeFailure::uncertain(e.to_string()));
        }
        events
            .send(json!({"type":"processes","ownedProcesses":owned}))
            .await
            .map_err(|_| NativeFailure::uncertain("Native event handler failed."))?;
        let stdin = child.stdin.take().unwrap();
        let prompt = inv.prompt;
        let mut input = tokio::spawn(async move {
            let mut s = stdin;
            s.write_all(prompt.as_bytes()).await?;
            s.shutdown().await
        });
        let stderr = child.stderr.take().unwrap();
        let mut stderr_task = tokio::spawn(async move {
            let mut s = stderr;
            let mut buffer = vec![];
            let mut chunk = [0; 4096];
            let mut total = 0;
            loop {
                let n = s.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                total += n;
                if total <= 4096 {
                    buffer.extend_from_slice(&chunk[..n]);
                } else {
                    buffer.clear();
                }
            }
            Ok::<_, std::io::Error>((total, buffer))
        });
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = vec![];
        let mut stdout_bytes = 0;
        let mut problem = None;
        let mut cancelled = false;
        let mut session_reported = false;
        let mut monitor = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut unreadable_since = None;
        let mut cancelled_at = None;
        let mut eof = false;
        let mut status = None;
        let mut exited_at = None;
        loop {
            if eof && status.is_some() {
                break;
            }
            tokio::select! {
                _=async{if let Some(at)=exited_at{tokio::time::sleep_until(at+std::time::Duration::from_secs(2)).await;}else{std::future::pending::<()>().await;}},if !eof=>{problem=Some("Native output streams did not close after process exit.".into());break;},
                changed=inv.cancellation.changed(),if !cancelled=>{if changed.is_ok()&&*inv.cancellation.borrow(){cancelled=true;cancelled_at=Some(tokio::time::Instant::now());problem=Some("Native execution was cancelled.".to_string());if let Err(e)=processes::signal(&owned,libc::SIGTERM).await{problem=Some(e.to_string());} }},
                _=monitor.tick()=>{if cancelled_at.is_some_and(|t:tokio::time::Instant|t.elapsed()>=std::time::Duration::from_secs(2)){let _=processes::signal(&owned,libc::SIGKILL).await;}match processes::sampled_table().await{Ok(table)=>{unreadable_since=None;match processes::refresh(&mut owned,pid,&table){Ok(changed)=>{if changed{let _=events.send(json!({"type":"processes","ownedProcesses":owned})).await;}},Err(e)=>{problem=Some(e.to_string());let _=events.send(json!({"type":"process-inspection-failed"})).await;let _=child.start_kill();}}},Err(_)=>{let since=unreadable_since.get_or_insert(now());if now().saturating_sub(*since)>=10000{problem=Some("Native process ownership inspection failed.".into());let _=events.send(json!({"type":"process-inspection-failed"})).await;let _=child.start_kill();}}}},
                exit=child.wait(),if status.is_none()=>{status=exit.ok();exited_at=Some(tokio::time::Instant::now());if status.is_none(){problem=Some("Native exit status could not be read.".into());break;}},
                read=bounded_line(&mut reader,&mut line),if !eof=>{match read{Err(_)=>{problem=Some("Native output could not be read.".into());break;},Ok(0)=>{eof=true;},Ok(n)=>{stdout_bytes+=n;if stdout_bytes>8*1024*1024||line.len()>2*1024*1024{problem=Some("Native output exceeded its limit.".into());let _=processes::signal(&owned,libc::SIGTERM).await;break;}if line.iter().all(u8::is_ascii_whitespace){line.clear();continue;}match serde_json::from_slice::<Value>(&line){Ok(event)if event.is_object()&&event["type"].as_str().is_some_and(|s|!s.is_empty())=>{decoder.observe(p,&event);if !session_reported{if let Some(id)=&decoder.session{session_reported=true;let _=events.send(json!({"type":"session","sessionId":id})).await;}}let _=events.send(json!({"type":"native","provider":p,"event":event})).await;line.clear();},_=>{problem=Some("Native execution emitted invalid JSON.".into());let _=processes::signal(&owned,libc::SIGTERM).await;break;}}}}}
            }
        }
        if problem.is_some() {
            let _ = processes::signal(&owned, libc::SIGTERM).await;
        }
        let status = if status.is_some() {
            status
        } else if problem.is_some() {
            match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
                Ok(Ok(s)) => Some(s),
                _ => {
                    let _ = processes::signal(&owned, libc::SIGKILL).await;
                    tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
                        .await
                        .ok()
                        .and_then(Result::ok)
                }
            }
        } else {
            child.wait().await.ok()
        };
        let mut closed = false;
        for i in 0..42 {
            match processes::inspect(&owned).await {
                Ok(e) => {
                    closed = e["processes"]
                        .as_array()
                        .is_some_and(|rows| rows.iter().all(|r| r["absent"] == true))
                        && e["processes"][0]["groupAbsent"] == true;
                }
                Err(_) => {
                    problem = Some("Native process ownership inspection failed.".into());
                    let _ = events
                        .send(json!({"type":"process-inspection-failed"}))
                        .await;
                }
            }
            if closed {
                break;
            }
            if i == 0 {
                let _ = processes::signal(&owned, libc::SIGTERM).await;
            }
            if i == 20 {
                let _ = processes::signal(&owned, libc::SIGKILL).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // Process-exit proof precedes pipe cleanup. A detached descendant can
        // retain stdin/stderr without yielding another byte; this cleanup bound
        // is not a deadline on an active native invocation.
        if tokio::time::timeout(std::time::Duration::from_millis(250), &mut input)
            .await
            .is_err()
        {
            input.abort();
        }
        let stderr =
            match tokio::time::timeout(std::time::Duration::from_millis(250), &mut stderr_task)
                .await
            {
                Ok(Ok(Ok(value))) => value,
                _ => {
                    stderr_task.abort();
                    problem.get_or_insert(
                        "Native diagnostic stream did not close after process exit.".into(),
                    );
                    (0, vec![])
                }
            };
        let usage = normalize_usage(p, &decoder.usage, decoder.cost);
        let failure = |message: String, uncertain: bool| NativeFailure {
            message,
            uncertain,
            usage: usage.clone(),
            activity: None,
        };
        if let Some(problem) = problem {
            return Err(failure(problem, !(cancelled && closed)));
        }
        if !closed {
            return Err(failure(
                "Native subprocesses survived completion.".into(),
                true,
            ));
        }
        if decoder.conflicting {
            return Err(failure(
                "Native execution emitted conflicting terminal receipts.".into(),
                true,
            ));
        }
        if decoder.terminal == Some(false) {
            return Err(failure(
                format!(
                    "Native {p} execution failed with a terminal receipt.{}",
                    if decoder.failure.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", decoder.failure)
                    }
                ),
                false,
            ));
        }
        if p == Provider::Codex
            && status.as_ref().and_then(|s| s.code()) == Some(1)
            && stdout_bytes == 0
            && decoder.session.is_none()
            && stderr.0 <= 4096
            && String::from_utf8_lossy(&stderr.1).trim()
                == "Not inside a trusted directory and --skip-git-repo-check was not specified."
        {
            return Err(failure("Codex refused the selected non-Git project before execution. Update the collaboration launcher; no model work was started.".into(),false));
        }
        if !status.is_some_and(|s| s.success())
            || decoder.terminal != Some(true)
            || decoder.text.is_empty()
        {
            return Err(failure(
                format!("Native {p} execution did not complete successfully."),
                true,
            ));
        }
        Ok(NativeResult {
            text: decoder.text,
            session_id: decoder.session,
            usage,
            activity: None,
        })
    }
}
pub type SharedRunner = Arc<dyn NativeRunner>;
