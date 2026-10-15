use crate::model::*;
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

pub fn encode(v: &Value) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap())
}
pub fn decode(s: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(s)?)?)
}
pub fn initialize(t: &mut Value) {
    if t.get("workEvents").is_none() {
        t["workEvents"] = json!({"version":1,"public":t["observability"]["timeline"]=="public","nextSequence":1,"events":[],"seen":[],"bytes":2,"dropped":0,"paused":false});
    }
}
pub fn validate(t: &Value) -> Result<()> {
    let Some(s) = t.get("workEvents") else {
        return Ok(());
    };
    if s["version"] != 1
        || !s["public"].is_boolean()
        || !s["paused"].is_boolean()
        || !s["nextSequence"].as_u64().is_some_and(|n| n > 0)
        || !s["dropped"].is_u64()
        || !s["events"].is_array()
        || array(&s["events"]).len() > 256
        || !s["seen"].is_array()
        || array(&s["seen"]).len() > 2048
        || s["bytes"] != bytes(&s["events"])
        || bytes(&s["events"]) > 512 * 1024
        || array(&s["seen"]).iter().any(|v| {
            !v.as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        })
        || array(&s["seen"])
            .iter()
            .map(Value::to_string)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != array(&s["seen"]).len()
    {
        bail!("Malformed persisted work event collection.");
    }
    let mut previous = 0;
    for e in array(&s["events"]) {
        let projected = project(&e);
        if projected.is_none()
            || e["taskId"] != t["id"]
            || !e["at"].is_u64()
            || !e["generation"]
                .as_u64()
                .is_some_and(|g| g <= t["generation"].as_u64().unwrap_or(0))
            || !e["sequence"].as_u64().is_some_and(|s| {
                s > previous && s < t["workEvents"]["nextSequence"].as_u64().unwrap_or(0)
            })
            || e.as_object().unwrap().keys().any(|k| {
                !["taskId", "sequence", "at"].contains(&k.as_str())
                    && !projected
                        .as_ref()
                        .unwrap()
                        .as_object()
                        .unwrap()
                        .contains_key(k)
            })
            || projected
                .as_ref()
                .unwrap()
                .as_object()
                .unwrap()
                .iter()
                .any(|(k, v)| e.get(k) != Some(v))
        {
            bail!("Malformed persisted work event.");
        }
        previous = e["sequence"].as_u64().unwrap();
    }
    Ok(())
}
fn project(v: &Value) -> Option<Value> {
    let kind = v["kind"].as_str()?;
    if fields(kind).is_empty()
        || !v["generation"]
            .as_u64()
            .is_some_and(|n| n <= 9_007_199_254_740_991)
        || !matches!(
            v["source"].as_str(),
            Some(
                "native:codex"
                    | "native:claude"
                    | "worker-self-report"
                    | "worker-self-reported"
                    | "controller-self-report"
                    | "controller-self-reported"
                    | "broker"
            )
        )
    {
        return None;
    }
    let mut e = json!({"generation":v["generation"],"kind":kind,"source":v["source"]});
    if let Some(id) = v["nativeId"].as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:/+-".contains(&b))
    }) {
        e["nativeId"] = json!(id);
    }
    if matches!(
        v["granularity"].as_str(),
        Some("message" | "item" | "tool" | "invocation" | "structured")
    ) {
        e["granularity"] = v["granularity"].clone();
    }
    for k in fields(kind) {
        let x = &v[*k];
        if *k == "exitCode" {
            if x.as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
            {
                e[*k] = x.clone();
            }
        } else if let Some(s) = x.as_str().filter(|s| !s.is_empty() && !s.contains('\0')) {
            if s.len() > 8192 {
                e["omitted"] = json!({"reason":"field-size-limit","field":k,"bytes":s.len()});
            } else {
                e[*k] = json!(redact(s));
            }
        }
    }
    if v["omitted"]["reason"] == "field-size-limit"
        && v["omitted"]["field"]
            .as_str()
            .is_some_and(|k| fields(kind).contains(&k))
        && v["omitted"]["bytes"]
            .as_u64()
            .is_some_and(|n| n > 8192 && n <= 9_007_199_254_740_991)
    {
        e["omitted"] = json!({"reason":"field-size-limit","field":v["omitted"]["field"],"bytes":v["omitted"]["bytes"]});
    }
    Some(e)
}
fn fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "assistant-message" => &["text"],
        "tool-start" => &["toolKind", "toolName", "status"],
        "tool-end" => &["toolKind", "toolName", "status", "exitCode"],
        "report" => &["reportId", "phase", "summary", "nextStep", "outcome"],
        "blocker" => &[
            "blockerId",
            "status",
            "question",
            "impact",
            "requestedAction",
        ],
        "instruction" => &["instructionId", "status", "summary"],
        "control" => &["status", "summary"],
        "termination" => &["status"],
        _ => &[],
    }
}
fn redact(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let s = RE
        .get_or_init(|| {
            regex::Regex::new(
                r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b",
            )
            .unwrap()
        })
        .replace_all(s, "[redacted credential]")
        .into_owned();
    static ASSIGN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)(?:Bearer\s+)?(?:\[redacted credential\]|[^\s,;]+)").unwrap()
    });
    ASSIGN
        .replace_all(&s, "${1}[redacted credential]")
        .into_owned()
}
pub fn append(t: &mut Value, v: Value) -> bool {
    let Some(mut e) = project(&v) else {
        return false;
    };
    let kind = e["kind"].as_str().unwrap();
    if e["generation"] != t["generation"]
        || t["workEvents"].is_null()
        || t["workEvents"]["paused"] == true
    {
        return false;
    }
    if matches!(kind, "assistant-message" | "tool-start" | "tool-end")
        && t["workEvents"]["public"] != true
    {
        return false;
    }
    let key = hash_value(&json!([
        e["generation"],
        e["source"],
        e["kind"],
        e.get("nativeId").or(v.get("eventId")).unwrap_or(&e)
    ]));
    let task_id = t["id"].clone();
    let state = &mut t["workEvents"];
    if array(&state["seen"]).iter().any(|v| v == &key) {
        return false;
    }
    if array(&state["seen"]).len() >= 2048 {
        state["paused"] = json!(true);
        return true;
    }
    push(&mut state["seen"], json!(key));
    e["taskId"] = task_id;
    e["sequence"] = state["nextSequence"].clone();
    state["nextSequence"] = json!(state["nextSequence"].as_u64().unwrap() + 1);
    e["at"] = json!(
        v["at"]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .unwrap_or_else(now)
    );
    push(&mut state["events"], e);
    while array(&state["events"]).len() > 256 || bytes(&state["events"]) > 512 * 1024 {
        state["events"].as_array_mut().unwrap().remove(0);
        state["dropped"] = json!(state["dropped"].as_u64().unwrap_or(0) + 1);
    }
    state["bytes"] = json!(bytes(&state["events"]));
    true
}
pub fn query(t: &Value, p: &Value) -> Result<Value> {
    let generation = p["generation"].as_u64().ok_or_else(|| {
        error(
            "CLAUDEX_WORK_EVENTS_INVALID",
            "Work events require an exact generation.",
        )
    })?;
    if generation > t["generation"].as_u64().unwrap_or(0) {
        bail!("Work events require an existing generation.");
    }
    let limit = p["limit"].as_u64().unwrap_or(32);
    if limit == 0 || limit > 64 {
        bail!("Invalid event limit.");
    }
    let recent = p["recent"] == true;
    let mut after = 0;
    let s = &t["workEvents"];
    if let Some(c) = p["cursor"].as_str() {
        let v = decode(c)?;
        if c.len() > 1024
            || recent
            || v["version"] != 1
            || v["taskId"] != t["id"]
            || v["generation"] != generation
            || v.as_object().is_none_or(|v| v.len() != 4)
        {
            bail!("Work event cursor belongs to another task or generation.");
        }
        after = v["after"]
            .as_u64()
            .ok_or_else(|| error("CLAUDEX_INVALID_CURSOR", "Invalid event cursor."))?;
        if after >= s["nextSequence"].as_u64().unwrap_or(u64::MAX) {
            bail!("Work event cursor is ahead of the ledger.");
        }
    }
    let all: Vec<Value> = array(&s["events"])
        .into_iter()
        .filter(|e| e["generation"] == generation && e["sequence"].as_u64().unwrap_or(0) > after)
        .collect();
    let mut page = if recent {
        all.iter()
            .rev()
            .take(limit as usize)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
    } else {
        all.iter().take(limit as usize).cloned().collect::<Vec<_>>()
    };
    while page.len() > 1 && bytes(&json!(serde_json::to_string(&page)?)) > 192 * 1024 {
        if recent {
            page.remove(0);
        } else {
            page.pop();
        }
    }
    let last = page
        .last()
        .and_then(|e| e["sequence"].as_u64())
        .unwrap_or(after);
    let first = s["events"][0]["sequence"]
        .as_u64()
        .unwrap_or(s["nextSequence"].as_u64().unwrap_or(1));
    Ok(
        json!({"taskId":t["id"],"generation":generation,"events":page,"cursor":encode(&json!({"version":1,"taskId":t["id"],"generation":generation,"after":last})),"hasMore":!recent&&all.len()>page.len(),"collection":{"public":if s.is_null(){"not-collected"}else if s["public"]==true{"enabled"}else{"off"},"status":if s.is_null(){"not-collected"}else if s["paused"]==true{"paused-capacity"}else{"collecting"},"limits":{"events":256,"bytes":524288,"seen":2048,"page":64,"pageBytes":196608,"textBytes":8192}},"gap":if s["dropped"].as_u64().unwrap_or(0)>0{json!({"dropped":s["dropped"],"beforeSequence":first,"affectsCursor":after<first.saturating_sub(1)})}else{Value::Null}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Value {
        let mut t =
            json!({"id":"fixture-task","generation":1,"observability":{"timeline":"public"}});
        initialize(&mut t);
        t
    }
    #[test]
    fn persisted_events_revalidate_public_projection_not_only_shape() -> Result<()> {
        let mut t = task();
        assert!(append(
            &mut t,
            json!({"generation":1,"kind":"assistant-message","source":"native:codex","nativeId":"message-1","granularity":"message","text":"Public synthetic answer","reasoning":"Never public","toolPayload":{"secret":"Never public"}})
        ));
        validate(&t)?;
        assert!(t["workEvents"]["events"][0].get("reasoning").is_none());
        for (field, value) in [
            ("source", json!("native:reasoning")),
            ("nativeId", json!("invalid native identity")),
            ("granularity", json!("reasoning")),
            ("text", json!("access_token=synthetic-sensitive-value")),
            ("toolPayload", json!({"content":"Never public"})),
        ] {
            let mut corrupt = t.clone();
            corrupt["workEvents"]["events"][0][field] = value;
            corrupt["workEvents"]["bytes"] = json!(bytes(&corrupt["workEvents"]["events"]));
            assert!(validate(&corrupt).is_err(), "{field}");
        }
        let mut duplicate = t.clone();
        let seen = duplicate["workEvents"]["seen"][0].clone();
        push(&mut duplicate["workEvents"]["seen"], seen);
        assert!(validate(&duplicate).is_err());
        Ok(())
    }
    #[test]
    fn omission_markers_and_redaction_survive_restart_validation() -> Result<()> {
        let mut t = task();
        assert!(append(
            &mut t,
            json!({"generation":1,"kind":"assistant-message","source":"native:claude","nativeId":"large-message","text":"x".repeat(8193)})
        ));
        assert!(append(
            &mut t,
            json!({"generation":1,"kind":"assistant-message","source":"native:claude","nativeId":"redacted-message","text":"access_token=synthetic-placeholder"})
        ));
        validate(&t)?;
        assert_eq!(t["workEvents"]["events"][0]["omitted"]["bytes"], 8193);
        assert_eq!(
            t["workEvents"]["events"][1]["text"],
            "access_token=[redacted credential]"
        );
        let restored: Value = serde_json::from_str(&t.to_string())?;
        validate(&restored)?;
        Ok(())
    }
}
