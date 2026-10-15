//! Native hook coordination. Identity hints never replace independent origin proof.
use crate::{Provider, archive, cli, mailbox::ChatMailbox, model::wire_error, transport};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::path::Path;

#[derive(Debug, Default)]
pub struct HookResult {
    pub output: Option<Value>,
    pub kind_override: Option<&'static str>,
    pub warnings: Vec<Value>,
    pub completed_phases: Vec<&'static str>,
}

pub fn stopped(root: &Path) -> Result<bool> {
    let Some(value) = archive::optional(&root.join("app-stop.json"), 4096)? else {
        return Ok(false);
    };
    if value["version"] != 1
        || !value["stopped"].is_boolean()
        || value.get("resuming").is_some_and(|v| !v.is_boolean())
    {
        bail!("Invalid application stop state.");
    }
    Ok(value["stopped"] == true || value["resuming"] == true)
}
fn identifier(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
    })
}
fn source_hint(input: &Value) -> bool {
    identifier(&input["session_id"])
        && input["cwd"].as_str().is_some_and(|s| {
            Path::new(s).is_absolute() && s.len() <= 4096 && !s.contains(['\0', '\r', '\n'])
        })
}
fn bind_params(provider: Provider, input: &Value) -> Option<Value> {
    if !matches!(
        input["tool_name"].as_str(),
        Some("mcp__claudex-work__claudex_start" | "mcp__claudex_work__claudex_start")
    ) || !source_hint(input)
        || !identifier(&input["tool_use_id"])
        || input.get("turn_id").is_some_and(|v| !identifier(v))
        || provider == Provider::Codex && !identifier(&input["turn_id"])
    {
        return None;
    }
    let response = if let Some(s) = input["tool_response"].as_str() {
        serde_json::from_str(s).ok()?
    } else {
        input["tool_response"].clone()
    };
    if response["isError"] == true {
        return None;
    }
    let content = if provider == Provider::Claude && response.is_array() {
        &response
    } else {
        &response["content"]
    };
    let content = content.as_array()?;
    if content.len() != 1 || content[0]["type"] != "text" {
        return None;
    }
    let receipt: Value = serde_json::from_str(content[0]["text"].as_str()?).ok()?;
    if receipt["replayed"] == true
        || receipt["isError"] == true
        || !identifier(&receipt["taskId"])
        || !receipt["originChallenge"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return None;
    }
    let mut params = json!({"taskId":receipt["taskId"],"sessionId":input["session_id"],"cwd":input["cwd"],"toolUseId":input["tool_use_id"]});
    if let Some(turn) = input.get("turn_id") {
        params["turnId"] = turn.clone();
    }
    Some(params)
}
async fn rpc(root: &Path, provider: Provider, method: &str, params: Value) -> Result<bool> {
    if stopped(root)? {
        return Ok(false);
    }
    let work = root.join("collaboration");
    let token = cli::controller_token(&work)?;
    tokio::time::timeout(
        std::time::Duration::from_millis(2500),
        transport::call(&work, provider, &token, method, params),
    )
    .await??;
    Ok(true)
}

/// `root` is the application root. Callers record returned phase diagnostics and
/// publish their ordinary synchronization hint even when coordination failed.
pub async fn native_hook(root: &Path, provider: &str, input: &Value) -> Result<HookResult> {
    let provider = Provider::parse(provider)?;
    let mut result = HookResult::default();
    if stopped(root)? {
        return Ok(result);
    }
    let event = input["hook_event_name"].as_str().unwrap_or("");
    if event == "PostToolUse" {
        if let Some(params) = bind_params(provider, input) {
            match rpc(root, provider, "origin_bind", params).await {
                Ok(true) => result.completed_phases.push("origin_bind"),
                Ok(false) => {}
                Err(e) => result
                    .warnings
                    .push(json!({"phase":"origin_bind","error":wire_error(&e)})),
            }
        }
        return Ok(result);
    }
    if ["SessionStart", "UserPromptSubmit", "Stop"].contains(&event) && source_hint(input) {
        match rpc(
            root,
            provider,
            "origin_recheck",
            json!({"sessionId":input["session_id"],"cwd":input["cwd"],"event":event}),
        )
        .await
        {
            Ok(true) => result.completed_phases.push("origin_recheck"),
            Ok(false) => {}
            Err(e) => result
                .warnings
                .push(json!({"phase":"origin_recheck","error":wire_error(&e)})),
        }
    }
    if stopped(root)? {
        return Ok(result);
    }
    if ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].contains(&event)
        && let Some(cwd) = input["cwd"].as_str().filter(|s| Path::new(s).is_absolute())
    {
        let receipt = ChatMailbox::new(root.join("collaboration/chat-mailbox")).hook(
            provider,
            input["session_id"].as_str().unwrap_or(""),
            Path::new(cwd),
            event,
            input["stop_hook_active"] == true,
            input["last_assistant_message"].as_str().unwrap_or(""),
        );
        match receipt {
            Ok(receipt) => {
                result.completed_phases.push("mailbox");
                if let Some(context) = receipt["context"].as_str() {
                    if event == "Stop" {
                        result.kind_override = Some("started");
                    }
                    result.output = Some(if provider == Provider::Codex && event == "Stop" {
                        json!({"decision":"block","reason":context})
                    } else {
                        json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":context}})
                    });
                }
            }
            Err(e) => result
                .warnings
                .push(json!({"phase":"mailbox","error":wire_error(&e)})),
        }
    }
    Ok(result)
}
