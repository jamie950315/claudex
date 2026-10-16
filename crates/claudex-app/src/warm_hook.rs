//! Native UserPromptSubmit interception. Recognized commands block model input,
//! including failed or uncertain operations. No caller-supplied target is used.
use crate::{
    codex_cache_native::Native,
    mod_bridge::Rpc,
    platform::{self, CommandSpec, Runner},
    warm,
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use chrono::{DateTime, Local, TimeZone};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const HELP: &str = "Use /claudex:warm on, off, or status. On enables warming for this chat and accepts its best-effort limits; it may be followed by one of rounds=N (1-500), for=90m|3h|1h30m (up to 168h) or until=HH:MM|DD:HH:MM (local 24-hour time, within 168h); without one it uses the default limit saved in Claudex (4 hours unless changed). compact=on or compact=off decides for this chat whether it is compacted once when the limit is reached. Codex has no configurable 5m/1h TTL. The refresh interval is 25 minutes.";
pub struct Parsed {
    pub action: String,
    pub bounds: Option<warm::Limits>,
    pub compact: Option<bool>,
    pub defaulted: bool,
    pub confirmation: Option<String>,
}
pub fn parse(prompt: &Value, now: DateTime<Local>) -> Result<Option<Parsed>> {
    let Some(prompt) = prompt.as_str() else {
        return Ok(None);
    };
    let text = prompt.trim();
    if text != "/claudex:warm"
        && !text
            .strip_prefix("/claudex:warm")
            .is_some_and(|s| s.starts_with(char::is_whitespace))
    {
        return Ok(None);
    }
    ensure!(
        prompt.encode_utf16().count() <= 1024 && !text.contains(['\r', '\n', '\0']),
        "{HELP}"
    );
    let words = text.split_whitespace().collect::<Vec<_>>();
    let action = words.get(1).copied().unwrap_or("status");
    let rest = words.get(2..).unwrap_or_default();
    let mut result = Parsed {
        action: action.into(),
        bounds: None,
        compact: None,
        defaulted: false,
        confirmation: None,
    };
    match action {
        "off" | "status" if rest.is_empty() => (),
        "on" => {
            let mut limit = None;
            for word in rest {
                if ["rounds=", "for=", "until="]
                    .iter()
                    .any(|p| word.starts_with(p))
                {
                    ensure!(limit.is_none(), "{HELP}");
                    limit = Some(*word);
                } else if matches!(*word, "compact=on" | "compact=off") {
                    ensure!(result.compact.is_none(), "{HELP}");
                    result.compact = Some(*word == "compact=on");
                } else {
                    bail!("{HELP}")
                }
            }
            result.defaulted = limit.is_none();
            result.bounds = Some(warm::parse_limit(limit.unwrap_or("for=4h"), 25, now)?);
        }
        "confirm"
            if rest.len() == 2
                && rest[1] == "accept-best-effort"
                && rest[0].len() == 36
                && uuid::Uuid::parse_str(rest[0]).is_ok() =>
        {
            result.confirmation = Some(rest[0].into())
        }
        _ => bail!("{HELP}"),
    }
    Ok(Some(result))
}
#[async_trait]
pub trait CommandVerifier: Send + Sync {
    async fn verify(&self, context: &Value) -> Result<()>;
}
#[async_trait]
impl CommandVerifier for Native {
    async fn verify(&self, context: &Value) -> Result<()> {
        self.verify_command(context).await
    }
}
fn block(text: String) -> Value {
    json!({"decision":"block","reason":text,"systemMessage":text})
}
fn failure(action: &str, detail: &str) -> String {
    match action {
        "off" => format!(
            "Stop not confirmed: {detail}\nUse /claudex:warm status to check whether warming is stopped."
        ),
        "status" => format!("Status unavailable: {detail}\nNo change was requested."),
        _ => format!(
            "Operation not confirmed: {detail}\nDo not repeat an uncertain enable request. Use /claudex:warm status or /claudex:warm off."
        ),
    }
}
async fn broker_call(rpc: &dyn Rpc, root: &Path, method: &str, params: Value) -> Result<Value> {
    rpc.call(root, method, params, Duration::from_secs(20))
        .await
        .with_context(|| format!("Broker {method} failed in {}", root.display()))
}
pub async fn handle(
    input: &Value,
    root: &Path,
    worker: bool,
    rpc: &dyn Rpc,
    verify: &dyn CommandVerifier,
    language: &str,
) -> Option<Value> {
    if input["hook_event_name"] != "UserPromptSubmit" {
        return None;
    }
    let parsed = match parse(&input["prompt"], Local::now()) {
        Ok(Some(p)) => p,
        Ok(None) => return None,
        Err(e) => return Some(block(e.to_string())),
    };
    let broker_root = root.join("collaboration");
    let result=async{
        ensure!(!worker&&!["agent_id","agentId","agent_type"].iter().any(|k|input.get(*k).is_some_and(|v|!v.is_null()&&v!=false&&v!="")),"Managed workers and subagents cannot use this controller command.");
        let mut params=json!({"sessionId":input["session_id"],"cwd":input["cwd"]});crate::codex_cache_native::target(&params)?;
        ensure!(crate::codex_cache_native::identifier(&input["turn_id"]),"Exact native command turn is unavailable.");
        ensure!(!platform::stopped(root)?,"Claudex is stopped or resuming; no change was requested.");
        let mut context=params.clone();context["turnId"]=input["turn_id"].clone();context["transcriptPath"]=input["transcript_path"].clone();verify.verify(&context).await.context("Cannot verify the current native command")?;
        if matches!(parsed.action.as_str(),"on"|"confirm"){params["bestEffort"]=json!(true);}
        if parsed.action=="on"{
            let limits=if parsed.defaulted{
                let settings=broker_call(rpc,&broker_root,"cache_warm_settings",json!({})).await?;
                let word=settings.get("defaultLimit").filter(|v|!v.is_null()).map(|v|v.as_str().context("Invalid shared warm limit.")).transpose()?.unwrap_or("for=4h");
                let saved=warm::WarmSettings{default_warm_limit:word.into(),..Default::default()};saved.validate()?;
                warm::parse_limit(word,25,Local::now())?
            }else{parsed.bounds.unwrap()};
            params.as_object_mut().unwrap().extend(serde_json::to_value(limits)?.as_object().unwrap().clone());
            if let Some(compact)=parsed.compact{params["compact"]=json!(compact);}
        }
        if let Some(id)=parsed.confirmation{params["confirmationId"]=json!(id);}
        let action=match parsed.action.as_str(){"on"=>"prepare","status"=>"list",other=>other};
        let mut result=broker_call(rpc,&broker_root,&format!("codex_cache_warm_{action}"),params.clone()).await?;
        if parsed.action=="on"{
            ensure!(result["confirmationId"].as_str().is_some_and(|s|s.len()==36&&uuid::Uuid::parse_str(s).is_ok())&&result["sessionId"]==params["sessionId"]&&result["cwd"]==params["cwd"],"Prepared settings did not match this chat; warming was not enabled.");
            verify.verify(&context).await.context("Cannot reverify the current native command before enabling")?;
            result=broker_call(rpc,&broker_root,"codex_cache_warm_confirm",json!({"sessionId":params["sessionId"],"cwd":params["cwd"],"bestEffort":true,"confirmationId":result["confirmationId"]})).await?;
            ensure!(result["policy"]["enabled"]==true,"Warming activation was not verified; inspect status.");result["state"]=json!("enabled");
        }
        Ok::<_,anyhow::Error>(summary(&result,&params,language))
    }.await;
    Some(block(match result {
        Ok(text) => text,
        Err(e) => failure(&parsed.action, &format!("{e:#}")),
    }))
}
fn language(preferred: &[String]) -> &'static str {
    for raw in preferred {
        let tag = raw.replace('_', "-").to_lowercase();
        let p = tag.split('-').collect::<Vec<_>>();
        if p[0] == "zh" {
            return if p.contains(&"hant") {
                "zh-Hant"
            } else if p.contains(&"hans") {
                "zh-Hans"
            } else if p.iter().any(|v| ["tw", "hk", "mo"].contains(v)) {
                "zh-Hant"
            } else {
                "zh-Hans"
            };
        }
        if let Some(id) = ["en", "ja", "ko", "es", "de", "fr", "it"]
            .into_iter()
            .find(|s| *s == p[0])
        {
            return id;
        }
    }
    "en"
}
fn translate(key: &str, lang: &str, params: &[(&str, String)]) -> String {
    static ROWS: OnceLock<Value> = OnceLock::new();
    let rows = ROWS.get_or_init(|| {
        crate::mod_install::validate_catalog(include_str!(
            "../../../plugins/claudex/hooks/locales.mjs"
        ))
        .expect("embedded static locale table must validate")
    });
    let index = ["zh-Hant", "zh-Hans", "ja", "ko", "es", "de", "fr", "it"]
        .iter()
        .position(|s| *s == lang);
    let mut text = index
        .and_then(|i| rows[key][i].as_str())
        .unwrap_or(key)
        .to_owned();
    for (k, v) in params {
        text = text.replace(&format!("{{{k}}}"), v);
    }
    text
}
fn count(v: &Value, lang: &str) -> String {
    if let Some(n) = v.as_u64().filter(|n| *n <= 9007199254740991) {
        let s = n.to_string();
        s.chars()
            .enumerate()
            .flat_map(|(i, c)| {
                if i > 0 && (s.len() - i) % 3 == 0 {
                    vec![',', c]
                } else {
                    vec![c]
                }
            })
            .collect()
    } else {
        translate("Unknown", lang, &[])
    }
}
fn time(v: &Value, lang: &str) -> String {
    v.as_i64()
        .filter(|v| *v > 0)
        .and_then(|v| Local.timestamp_millis_opt(v).single())
        .map(|t| t.format("%m/%d %H:%M UTC%:z").to_string())
        .unwrap_or_else(|| translate("Unknown", lang, &[]))
}
pub fn summary(result: &Value, context: &Value, lang: &str) -> String {
    let matches = |p: &&Value| {
        p["sessionId"] == context["sessionId"]
            && p["cwd"] == context["cwd"]
            && (p["provider"].is_null() || p["provider"] == "codex")
    };
    let policy = result.get("policy").filter(matches).or_else(|| {
        result["policies"]
            .as_array()
            .and_then(|a| a.iter().find(matches))
    });
    let empty = Value::Null;
    let p = policy.unwrap_or(&empty);
    let context_matches = ["sessionId", "cwd"]
        .into_iter()
        .all(|key| result[key].is_null() || result[key] == "" || result[key] == context[key])
        && (result["policy"].is_null() || policy.is_some());
    let local = if context_matches
        && (result["local"]["sessionId"].is_null()
            || result["local"]["sessionId"] == ""
            || result["local"]["sessionId"] == context["sessionId"])
    {
        &result["local"]
    } else {
        &empty
    };
    let suspended = local["suspended"] == true;
    let enabled = p["enabled"] == true && local["enabled"] != false;
    let policy_reason = p["reason"]
        .as_str()
        .or(p["status"].as_str())
        .unwrap_or("disabled");
    let terminal = [
        "duration-limit",
        "refresh-limit",
        "user-message",
        "read-budget",
        "output-budget",
        "actual-budget-exceeded",
        "cache-expired",
        "native-ended",
        "broker-stopping",
        "broker-stopped",
        "broker-restarted",
        "app-stopped",
    ];
    let local_reason = local["phase"]
        .as_str()
        .filter(|phase| !phase.is_empty() && *phase != "idle")
        .map(|phase| {
            if phase == "ended" {
                "native-ended"
            } else {
                "busy"
            }
        })
        .or_else(|| {
            local["reason"]
                .as_str()
                .filter(|reason| !["scheduled", "disabled"].contains(reason))
        });
    let reason = if suspended {
        local["reason"].as_str().unwrap_or("")
    } else if !enabled || terminal.contains(&policy_reason) {
        policy_reason
    } else {
        local_reason
            .or(p["nativeReason"].as_str())
            .unwrap_or(policy_reason)
    };
    let paused = enabled && (suspended || terminal.contains(&reason));
    let state = translate(
        if paused {
            "Paused"
        } else if enabled {
            "Enabled"
        } else {
            "Disabled"
        },
        lang,
        &[],
    );
    let heading = format!(
        "{}: {state} · {} · {}",
        translate("Cache warming", lang, &[]),
        translate(
            "Interval {minutes} min",
            lang,
            &[("minutes", count(&p["refreshMinutes"], lang))]
        ),
        translate("TTL managed by Codex", lang, &[])
    );
    let prefix = p["sample"]["cacheReadTokens"]
        .as_u64()
        .zip(p["sample"]["cacheWriteTokens"].as_u64())
        .and_then(|(a, b)| a.checked_add(b))
        .map(|n| json!(n))
        .unwrap_or(Value::Null);
    let tokens = translate(
        "Tokens: prefix {prefix} · warm reads: {read}/{readLimit} (counted/limit), output {output}/{outputLimit}",
        lang,
        &[
            ("prefix", count(&prefix, lang)),
            ("read", count(&p["totals"]["readTokens"], lang)),
            (
                "readLimit",
                if p.get("maxReadTokens") == Some(&Value::Null) {
                    translate("Unlimited", lang, &[])
                } else {
                    count(&p["maxReadTokens"], lang)
                },
            ),
            ("output", count(&p["totals"]["outputTokens"], lang)),
            ("outputLimit", count(&p["maxOutputTokens"], lang)),
        ],
    );
    let first = if p["cacheResults"]["firstAt"].as_u64().is_some_and(|n| n > 0) {
        time(&p["cacheResults"]["firstAt"], lang)
    } else {
        translate(
            if policy.is_none() || p["cacheResults"]["count"] == 0 {
                "Not yet"
            } else {
                "Unknown"
            },
            lang,
            &[],
        )
    };
    let effective_reason = if !enabled && !suspended && reason == "scheduled" {
        "disabled"
    } else {
        reason
    };
    let reason_text = match effective_reason {
        "disabled" | "broker-stopping" | "broker-stopped" | "broker-restarted" => "Stopped",
        "awaiting-evidence" | "awaiting-native-settings" => "Waiting for a normal reply",
        "awaiting-native-binding" => "Waiting for the native session",
        "busy" => "Waiting for the current turn",
        "attempt-pending" => "Warming in progress",
        "duration-limit" => "Time limit reached",
        "refresh-limit" => "Refresh limit reached",
        "user-message" => "Stopped by your message",
        "read-budget" | "output-budget" | "actual-budget-exceeded" => "Token budget reached",
        "cache-expired" => "Cache evidence expired",
        "no-cache-prefix" => "No cacheable prefix observed",
        "native-output-not-complete" => "Waiting for a completed reply",
        "app-stopped" => "Stopped by app",
        "native-ended" => "Session ended",
        "native-binding-changed" => "Session changed",
        "native-configuration-changed" => "Settings changed",
        "native-activity-changed" => "Activity changed",
        "native-uncertain" | "uncertain" => "Delivery uncertain; stopped",
        "compacted" => "Limit reached; conversation compacted",
        "compact-skipped" => "Limit reached; compaction skipped",
        "compact-unavailable" => "Limit reached; compaction no longer possible",
        _ => "",
    };
    let next = if suspended
        || paused
        || !enabled
        || (!reason.is_empty() && !["scheduled", "not-due"].contains(&reason))
    {
        if !reason_text.is_empty() {
            translate(reason_text, lang, &[])
        } else {
            let mut text = translate("Needs inspection", lang, &[]);
            if regex::Regex::new(r"^[a-z][a-z0-9-]{0,63}$")
                .unwrap()
                .is_match(effective_reason)
            {
                text.push_str(&format!(" ({effective_reason})"));
            }
            text
        }
    } else {
        time(&p["nextAt"], lang)
    };
    let mut lines = vec![
        heading,
        tokens,
        translate("First cache result: {time}", lang, &[("time", first)]),
        translate("Next warm: {next}", lang, &[("next", next)]),
    ];
    if p["maxRefreshes"]
        .as_u64()
        .is_some_and(|value| value <= 9007199254740991)
    {
        lines.push(translate(
            "Limits: {used}/{max} warm requests · until {time}",
            lang,
            &[
                ("used", count(&p["totals"]["refreshes"], lang)),
                ("max", count(&p["maxRefreshes"], lang)),
                ("time", time(&p["until"], lang)),
            ],
        ));
    }
    if let Some(compact) = p["compactAtEnd"].as_bool() {
        lines.push(translate(
            "Compact when warming ends: {state}",
            lang,
            &[(
                "state",
                if p["compactAt"].as_u64().is_some_and(|n| n > 0) {
                    time(&p["compactAt"], lang)
                } else {
                    translate(if compact { "On" } else { "Off" }, lang, &[])
                },
            )],
        ));
    }
    lines.join("\n")
}
async fn system_language(runner: &dyn Runner) -> String {
    let mut spec = CommandSpec::new("/usr/bin/defaults", ["read", "-g", "AppleLanguages"]);
    spec.timeout = Duration::from_secs(2);
    spec.max_bytes = 8192;
    let Ok(reply) = runner.run(spec).await else {
        return "en".into();
    };
    if reply.code != 0 {
        return "en".into();
    }
    let source = reply.stdout.trim();
    let Some(body) = source.strip_prefix('(').and_then(|s| s.strip_suffix(')')) else {
        return "en".into();
    };
    if body.trim().is_empty() {
        return "en".into();
    }
    let tags = body.split(',').map(str::trim).collect::<Vec<_>>();
    let re = regex::Regex::new(
        r#"^(?:"[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*"|[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*)$"#,
    )
    .unwrap();
    if tags.len() > 64 || tags.iter().any(|s| !re.is_match(s)) {
        return "en".into();
    }
    language(
        &tags
            .iter()
            .map(|s| s.trim_matches('"').to_string())
            .collect::<Vec<_>>(),
    )
    .into()
}
pub async fn stdio(args: &[String], rpc: &dyn Rpc) -> Result<()> {
    ensure!(
        args.len() == 2 && args[0] == "--root",
        "Invalid cache command hook configuration."
    );
    let root = PathBuf::from(&args[1]);
    platform::absolute(&root)?;
    let mut input = Vec::new();
    tokio::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut input)
        .await?;
    ensure!(
        input.len() <= 1024 * 1024,
        "Native hook input exceeded its bound."
    );
    let input: Value = serde_json::from_slice(&input)
        .context("Claudex could not inspect the local cache command.")?;
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".codex")
        });
    let native = Native {
        root: root.clone(),
        home,
    };
    let worker = std::env::var("CLAUDEX_COLLABORATION_WORKER").as_deref() == Ok("1")
        || std::env::var_os("CLAUDEX_WORK_TOKEN").is_some();
    let lang = system_language(&platform::SystemRunner).await;
    let action = input["prompt"]
        .as_str()
        .and_then(|s| s.split_whitespace().nth(1))
        .unwrap_or("status");
    let output = tokio::time::timeout(
        Duration::from_secs(25),
        handle(&input, &root, worker, rpc, &native, &lang),
    )
    .await
    .unwrap_or_else(|_| Some(block(failure(action, "Claudex cache command timed out."))));
    if let Some(output) = output {
        let mut bytes = claudex_core::json::stringify(&output)?.into_bytes();
        bytes.push(b'\n');
        tokio::io::stdout().write_all(&bytes).await?;
    }
    Ok(())
}
