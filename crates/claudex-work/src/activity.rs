//! Content-free native activity and response-model evidence, never progress proof.
use crate::model::{array, now};
use serde_json::{Value, json};
fn model_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:/+-".contains(&b))
    })
}
fn evidence(v: &Value) -> Option<Value> {
    if !model_id(&v["model"])
        || !v["observedAt"].is_u64()
        || !matches!(
            v["source"].as_str(),
            Some(
                "claude:system.init"
                    | "claude:assistant.message.model"
                    | "claude:stream_event.message_start.model"
                    | "claude:result.modelUsage"
            )
        )
    {
        return None;
    }
    Some(json!({"model":v["model"],"source":v["source"],"observedAt":v["observedAt"]}))
}
pub fn sanitize(v: &Value) -> Value {
    if !matches!(v["provider"].as_str(), Some("codex" | "claude")) {
        return Value::Null;
    }
    let claude = v["provider"] == "claude";
    let recent = array(&v["recent"])
        .into_iter()
        .rev()
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter(|e| {
            matches!(
                e["kind"].as_str(),
                Some(
                    "session"
                        | "turn-start"
                        | "message"
                        | "tool-start"
                        | "tool-end"
                        | "native-event"
                        | "completion"
                )
            ) && matches!(e["scope"].as_str(), Some("main" | "auxiliary"))
                && e["at"].is_u64()
        })
        .map(|e| {
            let mut v = json!({"kind":e["kind"],"scope":e["scope"],"at":e["at"]});
            if matches!(
                e["toolKind"].as_str(),
                Some("command" | "mcp" | "file-change" | "web-search" | "native-tool")
            ) {
                v["toolKind"] = e["toolKind"].clone();
            }
            v
        })
        .collect::<Vec<_>>();
    let models = |key: &str| {
        if claude {
            array(&v["models"][key])
                .into_iter()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .filter_map(|e| evidence(&e))
                .filter(|e| match key {
                    "main" => {
                        e["source"] != "claude:system.init"
                            && e["source"] != "claude:result.modelUsage"
                    }
                    "unclassified" => e["source"] == "claude:result.modelUsage",
                    _ => true,
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        }
    };
    let main = models("main");
    let completion = &v["completion"];
    let source = completion["source"].as_str().unwrap_or("");
    let completion = if completion["observedAt"].is_u64()
        && matches!(
            source,
            "codex:turn.completed" | "codex:turn.failed" | "claude:result"
        )
        && source.starts_with(v["provider"].as_str().unwrap())
        && matches!(completion["outcome"].as_str(), Some("success" | "failed"))
    {
        json!({"source":source,"outcome":completion["outcome"],"observedAt":completion["observedAt"]})
    } else {
        Value::Null
    };
    json!({"provider":v["provider"],"lastNativeEventAt":v["lastNativeEventAt"].as_u64(),"eventCount":v["eventCount"].as_u64().unwrap_or(0),"recent":recent,"completion":completion,"models":{"status":if main.is_empty(){"not-reported"}else{"native-reported"},"configuration":if claude&&v["models"]["configuration"]["source"]=="claude:system.init"{evidence(&v["models"]["configuration"])}else{None},"main":main,"auxiliary":models("auxiliary"),"unclassified":models("unclassified")}})
}
fn add(s: &mut Value, kind: &str, scope: &str, at: u64, tool: Option<&str>) {
    let mut recent = array(&s["recent"]);
    if let Some(last) = recent.last_mut()
        && last["kind"] == kind
        && last["scope"] == scope
        && last["toolKind"].as_str() == tool
        && matches!(kind, "native-event" | "message")
    {
        last["at"] = json!(at);
    } else {
        let mut e = json!({"kind":kind,"scope":scope,"at":at});
        if let Some(tool) = tool {
            e["toolKind"] = json!(tool);
        }
        recent.push(e);
        if recent.len() > 16 {
            recent.remove(0);
        }
    }
    s["recent"] = json!(recent);
}
fn add_model(s: &mut Value, target: &str, model: &Value, source: &str, at: u64) {
    if !model_id(model) {
        return;
    }
    let e = json!({"model":model,"source":source,"observedAt":at});
    if target == "configuration" {
        s["models"][target] = e;
    } else {
        let mut list = array(&s["models"][target]);
        list.retain(|v| v["model"] != *model || v["source"] != source);
        list.push(e);
        if list.len() > 4 {
            list.remove(0);
        }
        s["models"][target] = json!(list);
    }
}
pub fn observe(previous: &Value, provider: &str, e: &Value) -> Value {
    if !e["type"].is_string()
        || matches!(
            e["type"].as_str(),
            Some("spawn" | "session" | "processes" | "process-inspection-failed")
        )
    {
        return sanitize(previous);
    }
    let mut s = if previous["provider"] == provider {
        sanitize(previous)
    } else {
        json!({"provider":provider,"eventCount":0,"recent":[],"completion":null,"models":{"configuration":null,"main":[],"auxiliary":[],"unclassified":[]}})
    };
    let at = now();
    s["lastNativeEventAt"] = json!(at);
    s["eventCount"] = json!((s["eventCount"].as_u64().unwrap_or(0) + 1).min(9_007_199_254_740_991));
    let scope = if !e["parent_tool_use_id"].is_null()
        || e["isSidechain"] == true
        || e["is_sidechain"] == true
    {
        "auxiliary"
    } else {
        "main"
    };
    let mut kind = "native-event";
    let mut tool = None;
    if provider == "codex" {
        if e["type"] == "thread.started" {
            kind = "session";
        }
        if e["type"] == "turn.started" {
            kind = "turn-start";
        }
        let native_tool = match e["item"]["type"].as_str() {
            Some("command_execution") => Some("command"),
            Some("mcp_tool_call") => Some("mcp"),
            Some("file_change") => Some("file-change"),
            Some("web_search") => Some("web-search"),
            _ => None,
        };
        if native_tool.is_some()
            && matches!(e["type"].as_str(), Some("item.started" | "item.completed"))
        {
            kind = if e["type"] == "item.started" {
                "tool-start"
            } else {
                "tool-end"
            };
            tool = native_tool;
        } else if e["item"]["type"] == "agent_message" {
            kind = "message";
        }
        if scope == "main" && matches!(e["type"].as_str(), Some("turn.completed" | "turn.failed")) {
            kind = "completion";
            s["completion"] = json!({"source":format!("codex:{}",e["type"].as_str().unwrap()),"outcome":if e["type"]=="turn.completed"{"success"}else{"failed"},"observedAt":at});
        }
    } else {
        if e["type"] == "system" && e["subtype"] == "init" {
            kind = "session";
            add_model(
                &mut s,
                if scope == "main" {
                    "configuration"
                } else {
                    "auxiliary"
                },
                &e["model"],
                "claude:system.init",
                at,
            );
        }
        if e["type"] == "assistant" {
            kind = "message";
            add_model(
                &mut s,
                scope,
                &e["message"]["model"],
                "claude:assistant.message.model",
                at,
            );
        }
        if e["type"] == "stream_event" && e["event"]["type"] == "message_start" {
            kind = "message";
            add_model(
                &mut s,
                scope,
                &e["event"]["message"]["model"],
                "claude:stream_event.message_start.model",
                at,
            );
        }
        for block in array(&e["message"]["content"]) {
            if e["type"] == "assistant" && block["type"] == "tool_use" {
                add(&mut s, "tool-start", scope, at, Some("native-tool"));
            }
            if e["type"] == "user" && block["type"] == "tool_result" {
                add(&mut s, "tool-end", scope, at, Some("native-tool"));
            }
        }
        if e["type"] == "result" {
            if scope == "main" && e["is_error"].is_boolean() {
                kind = "completion";
                s["completion"] = json!({"source":"claude:result","outcome":if e["is_error"]==true{"failed"}else{"success"},"observedAt":at});
            }
            if let Some(models) = e["modelUsage"].as_object() {
                for model in models.keys().take(4) {
                    add_model(
                        &mut s,
                        "unclassified",
                        &json!(model),
                        "claude:result.modelUsage",
                        at,
                    );
                }
            }
        }
    }
    add(&mut s, kind, scope, at, tool);
    sanitize(&s)
}
