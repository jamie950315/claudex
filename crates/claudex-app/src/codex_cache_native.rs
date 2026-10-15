//! Read-only admission and bounded observation of the existing Desktop backend.
//! Native input is submitted only through a separately re-proved one-use owner.
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::{
    json,
    rpc::{CodexClient, MAX_FRAME_BYTES},
    shared_codex, storage,
    version::VersionPolicy,
};
use claudex_sync::codex_wake;
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

const CORE: &[&str] = &[
    "model",
    "modelProvider",
    "cwd",
    "serviceTier",
    "disabledPluginIds",
    "approvalPolicy",
    "approvalsReviewer",
    "sandboxPolicy",
    "activePermissionProfile",
    "effort",
    "collaborationMode",
    "multiAgentMode",
];
const SECURITY: &[&str] = &[
    "modelProvider",
    "disabledPluginIds",
    "approvalPolicy",
    "approvalsReviewer",
    "sandboxPolicy",
    "activePermissionProfile",
];
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn identifier(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 200 && !s.contains('\0'))
}
fn uuid(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 36 && uuid::Uuid::parse_str(s).is_ok())
}
fn nullable(v: &Value) -> bool {
    v.is_null() || identifier(v)
}
fn keys(v: &Value, names: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == names.len() && names.iter().all(|n| o.contains_key(*n)))
}
fn path(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.encode_utf16().count() <= 4096
            && Path::new(s).is_absolute()
            && !s.chars().any(char::is_control)
    })
}
pub fn target(v: &Value) -> Result<()> {
    ensure!(
        uuid(&v["sessionId"]) && path(&v["cwd"]),
        "Exact native Codex session UUID and absolute cwd are required."
    );
    let cwd = v["cwd"].as_str().unwrap();
    ensure!(
        Path::new(cwd).components().all(|c| !matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )) && Path::new(cwd).components().collect::<PathBuf>().to_str() == Some(cwd),
        "Native cwd must be normalized."
    );
    Ok(())
}
fn digest(v: &Value) -> Result<String> {
    Ok(storage::hash_bytes(json::stringify(v)?.as_bytes()))
}
fn raw_digest(v: &Value) -> Result<String> {
    Ok(storage::hash_bytes(
        v.as_str()
            .context("Native fingerprint string is unavailable.")?
            .as_bytes(),
    ))
}
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut names = o.keys().collect::<Vec<_>>();
            names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Value::Object(
                names
                    .into_iter()
                    .map(|k| (k.clone(), canonical(&o[k])))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        _ => v.clone(),
    }
}
#[derive(Clone, Debug)]
struct Hashes {
    security: String,
    model: Option<String>,
    cwd: Option<String>,
    effort: Option<String>,
    collaboration_model: Option<String>,
    full: Option<String>,
}
fn settings(source: &Value, resume: bool) -> Result<Hashes> {
    ensure!(
        source.is_object()
            && (resume || keys(source, &[CORE, &["summary", "personality"]].concat())),
        "Invalid native settings."
    );
    let mut value = Map::new();
    for key in CORE {
        let source_key = match (*key, resume) {
            ("sandboxPolicy", true) => "sandbox",
            ("effort", true) => "reasoningEffort",
            _ => key,
        };
        ensure!(source.get(source_key).is_some(), "Missing native setting.");
        value.insert((*key).into(), source[source_key].clone());
    }
    ensure!(
        identifier(&value["model"])
            && identifier(&value["modelProvider"])
            && path(&value["cwd"])
            && nullable(&value["serviceTier"])
            && nullable(&value["effort"])
            && value["disabledPluginIds"]
                .as_array()
                .is_some_and(|a| a.len() <= 1024 && a.iter().all(identifier))
            && matches!(
                value["approvalsReviewer"].as_str(),
                Some("user" | "auto_review" | "guardian_subagent")
            ),
        "Invalid native settings."
    );
    value["disabledPluginIds"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| {
            a.as_str()
                .unwrap()
                .encode_utf16()
                .cmp(b.as_str().unwrap().encode_utf16())
        });
    let approval = &value["approvalPolicy"];
    ensure!(
        matches!(
            approval.as_str(),
            Some("untrusted" | "on-request" | "never")
        ) || keys(approval, &["granular"])
            && keys(
                &approval["granular"],
                &[
                    "sandbox_approval",
                    "rules",
                    "skill_approval",
                    "request_permissions",
                    "mcp_elicitations"
                ]
            )
            && approval["granular"]
                .as_object()
                .unwrap()
                .values()
                .all(Value::is_boolean),
        "Invalid approval policy."
    );
    let sandbox = &value["sandboxPolicy"];
    let valid = match sandbox["type"].as_str() {
        Some("dangerFullAccess") => keys(sandbox, &["type"]),
        Some("readOnly") => {
            keys(sandbox, &["type", "networkAccess"]) && sandbox["networkAccess"].is_boolean()
        }
        Some("externalSandbox") => {
            keys(sandbox, &["type", "networkAccess"])
                && matches!(
                    sandbox["networkAccess"].as_str(),
                    Some("restricted" | "enabled")
                )
        }
        Some("workspaceWrite") => {
            keys(
                sandbox,
                &[
                    "type",
                    "writableRoots",
                    "networkAccess",
                    "excludeTmpdirEnvVar",
                    "excludeSlashTmp",
                ],
            ) && sandbox["writableRoots"]
                .as_array()
                .is_some_and(|a| a.len() <= 1024 && a.iter().all(path))
                && ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]
                    .iter()
                    .all(|k| sandbox[*k].is_boolean())
        }
        _ => false,
    };
    ensure!(valid, "Invalid sandbox settings.");
    if value["sandboxPolicy"]["type"] == "workspaceWrite" {
        value["sandboxPolicy"]["writableRoots"]
            .as_array_mut()
            .unwrap()
            .sort_by(|a, b| {
                a.as_str()
                    .unwrap()
                    .encode_utf16()
                    .cmp(b.as_str().unwrap().encode_utf16())
            });
    }
    let profile = &value["activePermissionProfile"];
    ensure!(
        profile.is_null()
            || keys(profile, &["id", "extends"])
                && identifier(&profile["id"])
                && nullable(&profile["extends"]),
        "Invalid permission profile."
    );
    let collab = &value["collaborationMode"];
    ensure!(
        resume || !collab.is_null(),
        "Missing native collaboration settings."
    );
    let collaboration_model = if !collab.is_null() {
        ensure!(
            keys(collab, &["mode", "settings"])
                && matches!(collab["mode"].as_str(), Some("plan" | "default"))
                && keys(
                    &collab["settings"],
                    &["model", "reasoning_effort", "developer_instructions"]
                )
                && identifier(&collab["settings"]["model"])
                && nullable(&collab["settings"]["reasoning_effort"])
                && (collab["settings"]["developer_instructions"].is_null()
                    || collab["settings"]["developer_instructions"]
                        .as_str()
                        .is_some_and(|s| s.encode_utf16().count() <= 262144)),
            "Invalid collaboration settings."
        );
        let model = raw_digest(&collab["settings"]["model"])?;
        if let Some(text) =
            value["collaborationMode"]["settings"]["developer_instructions"].as_str()
        {
            value["collaborationMode"]["settings"]["developer_instructions"] =
                json!(storage::hash_bytes(text.as_bytes()));
        }
        Some(model)
    } else {
        None
    };
    let multi = &value["multiAgentMode"];
    if !matches!(multi.as_str(), Some("explicitRequestOnly" | "proactive")) {
        ensure!(
            keys(multi, &["custom"])
                && multi["custom"]
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 262144),
            "Invalid multi-agent settings."
        );
        value["multiAgentMode"] =
            json!({"custom":storage::hash_bytes(multi["custom"].as_str().unwrap().as_bytes())});
    }
    let security = digest(&canonical(&Value::Object(
        SECURITY
            .iter()
            .map(|k| ((*k).into(), value[*k].clone()))
            .collect(),
    )))?;
    if resume {
        return Ok(Hashes {
            security,
            model: None,
            cwd: None,
            effort: None,
            collaboration_model: None,
            full: None,
        });
    }
    ensure!(
        source["summary"].is_null()
            || matches!(
                source["summary"].as_str(),
                Some("auto" | "concise" | "detailed" | "none")
            ),
        "Invalid native summary."
    );
    ensure!(
        source["personality"].is_null()
            || matches!(
                source["personality"].as_str(),
                Some("none" | "friendly" | "pragmatic")
            ),
        "Invalid native personality."
    );
    let model = raw_digest(&value["model"])?;
    let cwd = raw_digest(&value["cwd"])?;
    let effort = digest(&canonical(&value["effort"]))?;
    value.insert("summary".into(), source["summary"].clone());
    value.insert("personality".into(), source["personality"].clone());
    Ok(Hashes {
        security,
        model: Some(model),
        cwd: Some(cwd),
        effort: Some(effort),
        collaboration_model,
        full: Some(digest(&canonical(&Value::Object(value)))?),
    })
}
pub fn version(result: &Value) -> Result<String> {
    let agent = result["userAgent"].as_str().unwrap_or("");
    let re =
        regex::Regex::new(r"(?:^|[\s/])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s;)]+)?)(?:$|[\s;)])")?;
    let v = re
        .captures(agent)
        .context("Unsupported native version.")?
        .get(1)
        .unwrap()
        .as_str();
    let p = v
        .split(['-', '+'])
        .next()
        .unwrap()
        .split('.')
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        v == "0.160.0" || p[0] > 0 || p[1] > 160 || p[1] == 160 && p[2] > 0,
        "Unsupported native version."
    );
    Ok(v.into())
}
pub fn metadata(
    thread: &Value,
    expected: &Value,
    native_version: &str,
    owner: &str,
) -> Result<Value> {
    ensure!(
        thread["id"] == expected["sessionId"]
            && thread["cwd"] == expected["cwd"]
            && thread["ephemeral"] == false
            && thread["parentThreadId"].is_null()
            && thread["forkedFromId"].is_null()
            && matches!(thread["source"].as_str(), Some("cli" | "vscode" | "exec"))
            && matches!(thread["status"]["type"].as_str(), Some("idle" | "active"))
            && identifier(&thread["model"])
            && (thread["reasoningEffort"].is_null() || identifier(&thread["reasoningEffort"])),
        "Thread is not an exact loaded persistent primary target."
    );
    let mut state = json!({"sessionId":expected["sessionId"],"cwd":expected["cwd"],"model":thread["model"],"effort":thread["reasoningEffort"],"ownerClientId":owner,"nativeVersion":native_version});
    let fingerprint = digest(&state)?;
    state["effort"] = thread
        .get("reasoningEffort")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("native-default"));
    state["phase"] = json!(if thread["status"]["type"] == "idle" {
        "idle"
    } else {
        "busy"
    });
    state["fingerprint"] = json!(fingerprint);
    Ok(state)
}
#[derive(Clone, Debug)]
pub enum Event {
    Invalidated(String),
    Start {
        turn: String,
        at: u64,
    },
    Complete {
        turn: String,
        status: String,
        at: u64,
    },
    Usage {
        turn: String,
        usage: Value,
        at: u64,
    },
    Tool {
        turn: String,
    },
    Compacted,
}
fn seconds(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n * 1000.0)
        .filter(|n| n.fract() == 0.0 && *n <= 9007199254740991.0)
        .map(|n| n as u64)
}
fn notification(v: &Value, id: &str, compacting: bool) -> Option<Event> {
    if v["method"] == "claudex/disconnected" {
        return Some(Event::Invalidated("disconnected".into()));
    }
    let p = &v["params"];
    if p["threadId"] != id {
        return None;
    }
    let m = v["method"].as_str().unwrap_or("");
    if compacting
        && (m == "thread/compacted"
            || matches!(m, "item/started" | "item/completed")
                && p["item"]["type"] == "contextCompaction")
    {
        return Some(Event::Compacted);
    }
    let reason = match m {
        "thread/compacted" => Some("context-compacted"),
        "model/rerouted" => Some("model-rerouted"),
        "thread/closed" => Some("thread-closed"),
        "thread/archived" => Some("thread-archived"),
        "thread/deleted" => Some("thread-deleted"),
        "error" => Some("native-error"),
        "thread/status/changed"
            if matches!(
                p["status"]["type"].as_str(),
                Some("notLoaded" | "systemError")
            ) =>
        {
            Some("native-thread-unavailable")
        }
        _ => None,
    };
    if let Some(r) = reason {
        return Some(Event::Invalidated(r.into()));
    }
    let turn = p["turnId"].as_str().unwrap_or("").to_owned();
    match m {
        "turn/started" => Some(
            match (
                identifier(&p["turn"]["id"]),
                seconds(&p["turn"]["startedAt"]),
            ) {
                (true, Some(at)) => Event::Start {
                    turn: p["turn"]["id"].as_str().unwrap().into(),
                    at,
                },
                _ => Event::Invalidated("invalid-turn-start".into()),
            },
        ),
        "turn/completed" => Some(
            match (
                identifier(&p["turn"]["id"]),
                seconds(&p["turn"]["completedAt"]),
                p["turn"]["status"].as_str(),
            ) {
                (true, Some(at), Some(status @ ("completed" | "failed" | "interrupted"))) => {
                    Event::Complete {
                        turn: p["turn"]["id"].as_str().unwrap().into(),
                        status: status.into(),
                        at,
                    }
                }
                _ => Event::Invalidated("invalid-turn-completion".into()),
            },
        ),
        "thread/tokenUsage/updated" => Some(
            if identifier(&p["turnId"])
                && ["total", "last"]
                    .iter()
                    .all(|k| usage_counts(&p["tokenUsage"][*k]).is_ok())
            {
                Event::Usage {
                    turn,
                    usage: p["tokenUsage"].clone(),
                    at: now(),
                }
            } else {
                Event::Invalidated("invalid-native-usage".into())
            },
        ),
        "item/started" if p["item"]["type"] == "contextCompaction" => {
            Some(Event::Invalidated("context-compacted".into()))
        }
        "item/started"
            if !matches!(
                p["item"]["type"].as_str(),
                Some("userMessage" | "agentMessage" | "reasoning" | "plan")
            ) =>
        {
            Some(
                if identifier(&p["turnId"]) && identifier(&p["item"]["type"]) {
                    Event::Tool { turn }
                } else {
                    Event::Invalidated("invalid-native-item".into())
                },
            )
        }
        _ => None,
    }
}
const FIELDS: &[&str] = &[
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
];
fn usage_counts(v: &Value) -> Result<Value> {
    ensure!(
        FIELDS
            .iter()
            .all(|k| v[*k].as_u64().is_some_and(|n| n <= 9007199254740991)),
        "Invalid native token usage."
    );
    ensure!(
        v["totalTokens"].as_u64()
            == Some(v["inputTokens"].as_u64().unwrap() + v["outputTokens"].as_u64().unwrap())
            && v["cachedInputTokens"].as_u64().unwrap()
                + v["cacheWriteInputTokens"].as_u64().unwrap()
                <= v["inputTokens"].as_u64().unwrap()
            && v["reasoningOutputTokens"].as_u64().unwrap() <= v["outputTokens"].as_u64().unwrap(),
        "Inconsistent native token usage."
    );
    Ok(Value::Object(
        FIELDS
            .iter()
            .map(|k| ((*k).into(), v[*k].clone()))
            .collect(),
    ))
}
#[derive(Default)]
pub struct UsageCounter {
    baseline: Option<(Value, Value)>,
    failed: bool,
}
impl UsageCounter {
    pub fn observe(
        &mut self,
        id: &str,
        turn: &str,
        usage: &Value,
        first: bool,
    ) -> Result<Option<(String, Value)>> {
        ensure!(!self.failed, "Native usage continuity was lost.");
        let result = (|| {
            ensure!(!turn.is_empty(), "Native usage identity changed.");
            let total = usage_counts(&usage["total"])?;
            let last = usage_counts(&usage["last"])?;
            if let Some((prior, prior_last)) = &self.baseline {
                if &total == prior {
                    ensure!(
                        &last == prior_last,
                        "Repeated totals changed last-request usage."
                    );
                    return Ok(None);
                }
                ensure!(
                    last["totalTokens"].as_u64().unwrap() > 0
                        && FIELDS.iter().all(|k| total[*k]
                            .as_u64()
                            .unwrap()
                            .checked_sub(prior[*k].as_u64().unwrap())
                            == last[*k].as_u64()),
                    "Native usage is reset, incomplete or not one request."
                );
            } else if first {
                ensure!(
                    last["totalTokens"].as_u64().unwrap() > 0
                        && FIELDS
                            .iter()
                            .all(|k| last[*k].as_u64() <= total[*k].as_u64()),
                    "First native request exceeds cumulative totals."
                );
            }
            let sample = self.baseline.is_some() || first;
            self.baseline = Some((total.clone(), last.clone()));
            Ok(sample.then(|| (digest(&json!([id, turn, total])).unwrap(), last)))
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
#[derive(Clone)]
pub struct Native {
    pub root: PathBuf,
    pub home: PathBuf,
}
impl Native {
    async fn connection(&self) -> Result<(CodexClient, String)> {
        // Cache compatibility is validated independently below, not by sync allowlist.
        let s = shared_codex::connect(&self.root, &self.home, VersionPolicy::Warn, MAX_FRAME_BYTES)
            .await?;
        match version(&s.initialized) {
            Ok(v) => Ok((s.client, v)),
            Err(e) => {
                s.client.close().await?;
                Err(e)
            }
        }
    }
    async fn read(&self, c: &CodexClient, expected: &Value, v: &str) -> Result<Value> {
        let result = c
            .request(
                "thread/read",
                json!({"threadId":expected["sessionId"],"includeTurns":false}),
            )
            .await?;
        let loaded = c.request("thread/loaded/list", json!({})).await?;
        ensure!(
            loaded["data"]
                .as_array()
                .is_some_and(|a| a.contains(&expected["sessionId"])),
            "Thread is not loaded."
        );
        let probe =
            codex_wake::preflight(&self.home, expected["sessionId"].as_str().unwrap(), 5000)
                .await?;
        ensure!(
            probe.handle.is_some() && uuid(&probe.status["ownerClientId"]),
            "Native owner unavailable."
        );
        metadata(
            &result["thread"],
            expected,
            v,
            probe.status["ownerClientId"].as_str().unwrap(),
        )
    }
    pub async fn inspect(&self, input: &Value) -> Result<Value> {
        target(input)?;
        let (c, v) = self.connection().await?;
        let r = self.read(&c, input, &v).await;
        let close = c.close().await;
        close?;
        r
    }
    pub async fn verify_command(&self, input: &Value) -> Result<()> {
        target(input)?;
        ensure!(
            identifier(&input["turnId"]) && path(&input["transcriptPath"]),
            "Native command identity unavailable."
        );
        let (c, v) = self.connection().await?;
        let r=async {
            let state=self.read(&c,input,&v).await?;
            let result=c.request("thread/read",json!({"threadId":input["sessionId"],"includeTurns":false})).await?;
            ensure!(result["thread"]["path"]==input["transcriptPath"]&&state["phase"]=="busy"&&metadata(&result["thread"],input,&v,state["ownerClientId"].as_str().unwrap())?["fingerprint"]==state["fingerprint"],"Command is not from this primary transcript.");
            let page=c.request("thread/turns/list",json!({"threadId":input["sessionId"],"limit":1,"itemsView":"notLoaded","sortDirection":"desc"})).await?;
            ensure!(page["data"].as_array().is_some_and(|a|a.len()==1)&&page["data"][0]["id"]==input["turnId"]&&page["data"][0]["status"]=="inProgress"&&page["data"][0]["itemsView"]=="notLoaded"&&page["data"][0]["items"].as_array().is_some_and(Vec::is_empty),"Command is not the current primary turn.");Ok(())
        }.await;
        c.close().await?;
        r
    }
    pub async fn connect(&self, input: &Value) -> Result<Observer> {
        target(input)?;
        let (c, v) = self.connection().await?;
        let receiver = c.subscribe();
        let result=async {
            let state=self.read(&c,input,&v).await?;let checked=self.read(&c,input,&v).await?;
            ensure!(state["fingerprint"]==checked["fingerprint"],"Native context changed before rejoin.");
            let goal=c.request("thread/goal/get",json!({"threadId":input["sessionId"]})).await?;
            ensure!(goal.get("goal")==Some(&Value::Null),"Active goal unsupported.");
            let resumed=c.request("thread/resume",json!({"threadId":input["sessionId"],"excludeTurns":true})).await?;
            ensure!(metadata(&resumed["thread"],input,&v,state["ownerClientId"].as_str().unwrap())?["fingerprint"]==state["fingerprint"],"Native context changed during rejoin.");
            let security=settings(&resumed,true)?.security;
            ensure!(resumed["cwd"]==input["cwd"]&&resumed["model"]==state["model"]&&(state["effort"]=="native-default"||resumed["reasoningEffort"]==state["effort"])&&(resumed["collaborationMode"].is_null()||resumed["collaborationMode"]["settings"]["model"]==state["model"]),"Native settings changed during rejoin.");
            let page=c.request("thread/turns/list",json!({"threadId":input["sessionId"],"limit":1,"itemsView":"notLoaded","sortDirection":"desc"})).await?;
            let rows=page["data"].as_array().context("Invalid initial turn page.")?;ensure!(rows.len()<=1,"Invalid initial turn page.");
            let initial=if let Some(t)=rows.first(){ensure!(identifier(&t["id"])&&seconds(&t["startedAt"]).is_some()&&matches!(t["status"].as_str(),Some("inProgress"|"completed"|"failed"|"interrupted"))&&t["itemsView"]=="notLoaded"&&t["items"].as_array().is_some_and(Vec::is_empty),"Invalid metadata-only initial turn.");Some(json!({"id":t["id"],"startedAt":seconds(&t["startedAt"]),"status":t["status"]}))}else{None};
            let observed=Observed{security,model:raw_digest(&state["model"])?,cwd:raw_digest(&state["cwd"])?,effort:if state["effort"]=="native-default"{None}else{Some(digest(&state["effort"])?)},full:None,unreported:false};
            Ok((state,initial,observed))
        }.await;
        match result {
            Ok((state, initial, observed)) => {
                let mut o = Observer {
                    native: self.clone(),
                    client: c,
                    version: v,
                    target: input.clone(),
                    state,
                    initial,
                    receiver: Some(receiver),
                    observed: Arc::new(Mutex::new(observed)),
                    invalid: Arc::new(AtomicBool::new(false)),
                    compacting: Arc::new(AtomicBool::new(false)),
                    task: None,
                    buffer: Vec::new(),
                };
                o.drain()?;
                Ok(o)
            }
            Err(e) => {
                c.close().await?;
                Err(e)
            }
        }
    }
}
struct Observed {
    security: String,
    model: String,
    cwd: String,
    effort: Option<String>,
    full: Option<String>,
    unreported: bool,
}
impl Observed {
    fn compare(&mut self, v: &Value) -> Result<()> {
        let h = settings(v, false)?;
        ensure!(
            !self.unreported
                && h.security == self.security
                && h.model.as_deref() == Some(&self.model)
                && h.cwd.as_deref() == Some(&self.cwd)
                && h.collaboration_model.as_deref() == Some(&self.model)
                && self
                    .effort
                    .as_ref()
                    .is_none_or(|e| h.effort.as_ref() == Some(e))
                && self
                    .full
                    .as_ref()
                    .is_none_or(|f| h.full.as_ref() == Some(f)),
            "Native settings changed."
        );
        self.full = h.full;
        Ok(())
    }
}
pub struct Observer {
    native: Native,
    client: CodexClient,
    version: String,
    target: Value,
    pub state: Value,
    pub initial: Option<Value>,
    receiver: Option<broadcast::Receiver<Value>>,
    observed: Arc<Mutex<Observed>>,
    pub invalid: Arc<AtomicBool>,
    compacting: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
    buffer: Vec<Event>,
}
pub struct Envelope {
    pub session: String,
    pub instance: String,
    pub event: Event,
}
fn process(v: Value, id: &str, observed: &Mutex<Observed>, compacting: bool) -> Option<Event> {
    if v["method"] == "thread/settings/updated" && v["params"]["threadId"] == id {
        return observed
            .lock()
            .unwrap()
            .compare(&v["params"]["threadSettings"])
            .err()
            .map(|_| Event::Invalidated("settings-changed".into()));
    }
    notification(&v, id, compacting)
}
impl Observer {
    fn drain(&mut self) -> Result<()> {
        let id = self.target["sessionId"].as_str().unwrap();
        let rx = self.receiver.as_mut().unwrap();
        let mut count = 0;
        loop {
            match rx.try_recv() {
                Ok(v) => {
                    count += 1;
                    ensure!(count <= 128, "Native event buffer overflow.");
                    if let Some(e) = process(v, id, &self.observed, false) {
                        ensure!(
                            !matches!(e, Event::Invalidated(_)),
                            "Native observation invalidated during rejoin."
                        );
                        self.buffer.push(e);
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => break,
                _ => bail!("Native observation unavailable during rejoin."),
            }
        }
        Ok(())
    }
    pub fn listen(&mut self, instance: String, tx: mpsc::Sender<Envelope>) -> Result<()> {
        self.drain()?;
        let session = self.target["sessionId"].as_str().unwrap().to_owned();
        for event in self.buffer.drain(..) {
            tx.try_send(Envelope {
                session: session.clone(),
                instance: instance.clone(),
                event,
            })
            .context("Native event buffer overflow.")?;
        }
        let mut rx = self
            .receiver
            .take()
            .context("Observer already listening.")?;
        let observed = self.observed.clone();
        let invalid = self.invalid.clone();
        let compacting = self.compacting.clone();
        self.task = Some(tokio::spawn(async move {
            loop {
                let event = match rx.recv().await {
                    Ok(v) => process(v, &session, &observed, compacting.load(Ordering::SeqCst)),
                    Err(_) => Some(Event::Invalidated("native-event-stream-unavailable".into())),
                };
                if let Some(event) = event {
                    let failed = matches!(event, Event::Invalidated(_));
                    if failed {
                        invalid.store(true, Ordering::SeqCst);
                    }
                    if tx
                        .try_send(Envelope {
                            session: session.clone(),
                            instance: instance.clone(),
                            event,
                        })
                        .is_err()
                    {
                        invalid.store(true, Ordering::SeqCst);
                        break;
                    }
                    if failed {
                        break;
                    }
                }
            }
        }));
        Ok(())
    }
    pub fn settings_ready(&self) -> bool {
        let s = self.observed.lock().unwrap();
        s.full.is_some() || s.unreported
    }
    pub fn accept_unreported(&self) {
        let mut s = self.observed.lock().unwrap();
        if s.full.is_none() {
            s.unreported = true;
        }
    }
    pub fn expect_compaction(&self) {
        self.compacting.store(true, Ordering::SeqCst);
    }
    pub async fn inspect(&self) -> Result<Value> {
        ensure!(
            !self.invalid.load(Ordering::SeqCst),
            "Observer invalidated."
        );
        let v = self
            .native
            .read(&self.client, &self.target, &self.version)
            .await?;
        ensure!(
            !self.invalid.load(Ordering::SeqCst),
            "Observer invalidated."
        );
        Ok(v)
    }
    pub async fn preflight(&self) -> Result<codex_wake::Handle> {
        ensure!(
            !self.invalid.load(Ordering::SeqCst),
            "Observer invalidated."
        );
        let p = codex_wake::preflight(
            &self.native.home,
            self.target["sessionId"].as_str().unwrap(),
            5000,
        )
        .await?;
        ensure!(
            p.status["ownerClientId"] == self.state["ownerClientId"]
                && !self.invalid.load(Ordering::SeqCst),
            "Native owner changed."
        );
        p.handle.context("Native owner unavailable.")
    }
    pub async fn close(mut self) -> Result<()> {
        self.invalid.store(true, Ordering::SeqCst);
        if let Some(t) = self.task.take() {
            t.abort();
            let _ = t.await;
        }
        self.client.close().await
    }
    pub fn invalidation(&self) -> Arc<AtomicBool> {
        self.invalid.clone()
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.invalid.store(true, Ordering::SeqCst);
        if let Some(t) = &self.task {
            t.abort();
        }
        if !self.client.is_closed() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let client = self.client.clone();
                runtime.spawn(async move {
                    let _ = client.close().await;
                });
            }
        }
    }
}

/// The final owner fence runs after all owner/socket re-proofs and before writing.
#[async_trait]
pub trait Environment: Send + Sync {
    async fn settings(&self) -> Result<crate::warm::WarmSettings>;
    async fn stopped(&self) -> Result<bool>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fingerprints_keep_raw_string_and_canonical_json_contracts_distinct() -> Result<()> {
        let value = json!({"model":"native-model","modelProvider":"openai","cwd":"/private/project",
            "serviceTier":null,"disabledPluginIds":["\u{e000}","𐀀"],"approvalPolicy":"never",
            "approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},
            "activePermissionProfile":null,"effort":"high","collaborationMode":{"mode":"default",
            "settings":{"model":"native-model","reasoning_effort":"high","developer_instructions":"private fixture"}},
            "multiAgentMode":"explicitRequestOnly","summary":null,"personality":null});
        let hashes = settings(&value, false)?;
        assert_eq!(
            hashes.model.as_deref(),
            Some(storage::hash_bytes(b"native-model").as_str())
        );
        assert_eq!(
            hashes.cwd.as_deref(),
            Some(storage::hash_bytes(b"/private/project").as_str())
        );
        assert_eq!(hashes.collaboration_model, hashes.model);
        assert_eq!(
            hashes.effort.as_deref(),
            Some(storage::hash_bytes(br#""high""#).as_str())
        );
        let mut reordered = value.clone();
        reordered["disabledPluginIds"] = json!(["𐀀", "\u{e000}"]);
        assert_eq!(settings(&reordered, false)?.security, hashes.security);
        assert_eq!(
            canonical(&json!({"\u{e000}":1,"𐀀":2}))
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["𐀀", "\u{e000}"]
        );
        Ok(())
    }
}
