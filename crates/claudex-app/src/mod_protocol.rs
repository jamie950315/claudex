//! The companion's intentionally smaller controller surface.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{error::Error, fmt};

pub const MAX_REQUEST_BYTES: usize = 96 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const READ_METHODS: &[&str] = &[
    "list",
    "status",
    "work_events",
    "work_reports",
    "artifact_read",
    "chat_list",
    "chat_status",
    "models",
];
pub const WRITE_METHODS: &[&str] = &[
    "start",
    "send",
    "cancel",
    "work_control",
    "chat_send",
    "models",
];
#[derive(Debug)]
pub struct ModError {
    pub code: String,
    pub message: String,
}
impl fmt::Display for ModError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl Error for ModError {}
pub fn insist(ok: bool, code: &str, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(ModError {
            code: code.into(),
            message: message.into(),
        }
        .into())
    }
}
fn valid(ok: bool) -> Result<()> {
    insist(ok, "INVALID_REQUEST", "Invalid companion request.")
}
pub fn fields(v: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    valid(v.as_object().is_some_and(|o| {
        o.keys().all(|k| allowed.contains(&k.as_str()))
            && required.iter().all(|k| o.contains_key(*k))
    }))
}
pub fn text(v: &Value, max: usize, empty: bool) -> Result<()> {
    valid(v.as_str().is_some_and(|s| {
        (empty || !s.trim().is_empty())
            && s.len() <= max
            && !s
                .chars()
                .any(|c| matches!(c as u32,0..=8|11..=12|14..=31|127..=159))
    }))
}
pub fn absolute(v: &Value) -> Result<()> {
    text(v, 4096, false)?;
    let s = v.as_str().unwrap();
    insist(
        s.starts_with('/') && !s.starts_with("//"),
        "INVALID_PATH",
        "An absolute local POSIX path is required.",
    )
}
pub fn identity(v: &Value, uuid: bool) -> Result<()> {
    let good = v.as_str().is_some_and(|s| {
        if uuid {
            regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
                .unwrap()
                .is_match(s)
        } else {
            s.len() >= 1
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
    });
    insist(good, "INVALID_ID", "Invalid exact identity.")
}
fn one(v: &Value, values: &[&str]) -> Result<()> {
    valid(v.as_str().is_some_and(|v| values.contains(&v)))
}
fn integer(v: &Value, min: u64, max: u64) -> Result<()> {
    valid(
        v.as_f64().is_some_and(|v| {
            v.is_finite() && v.fract() == 0.0 && v >= min as f64 && v <= max as f64
        }),
    )
}
fn provider(v: &Value) -> Result<()> {
    one(v, &["claude", "codex"])
}
fn model(v: &Value) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    text(v, 200, false)?;
    let s = v.as_str().unwrap();
    valid(s == s.trim() && !s.contains(['\r', '\n', '\t']))
}
fn effort(side: &str, v: &Value) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    one(
        v,
        if side == "claude" {
            &["low", "medium", "high", "xhigh", "max"]
        } else {
            &[
                "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
            ]
        },
    )
}
fn optional(v: &Value, key: &str, check: impl FnOnce(&Value) -> Result<()>) -> Result<()> {
    if let Some(value) = v.get(key) {
        check(value)?;
    }
    Ok(())
}
fn dirs(v: &Value) -> Result<()> {
    valid(v.as_array().is_some_and(|a| a.len() <= 16))?;
    for v in v.as_array().unwrap() {
        absolute(v)?;
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub session_id: String,
    pub cwd: String,
}
pub fn context(v: &Value) -> Result<Context> {
    fields(v, &["sessionId", "cwd"], &["sessionId", "cwd"])?;
    identity(&v["sessionId"], true)?;
    absolute(&v["cwd"])?;
    Ok(Context {
        session_id: v["sessionId"].as_str().unwrap().to_ascii_lowercase(),
        cwd: v["cwd"].as_str().unwrap().into(),
    })
}
pub fn params(method: &str, input: &Value, mutation: bool) -> Result<Value> {
    insist(
        (if mutation {
            WRITE_METHODS
        } else {
            READ_METHODS
        })
        .contains(&method),
        "UNSUPPORTED_METHOD",
        "This companion keeps worker handoff, resolution, and native lifecycle changes in the existing agent/operator workflows.",
    )?;
    valid(input.is_object())?;
    let mut p = input.clone();
    match method {
        "list" => {
            fields(&p, &["parentId", "limit", "cursor", "order"], &[])?;
            optional(&p, "order", |v| one(v, &["id", "recent"]))?;
            if p.get("parentId").is_some_and(|v| !v.is_null()) {
                identity(&p["parentId"], false)?;
            }
            optional(&p, "limit", |v| integer(v, 1, 100))?;
            optional(&p, "cursor", |v| text(v, 8192, false))?;
        }
        "status" => {
            fields(&p, &["taskId", "view"], &["taskId"])?;
            identity(&p["taskId"], false)?;
            optional(&p, "view", |v| one(v, &["summary", "full"]))?;
            p.as_object_mut()
                .unwrap()
                .entry("view")
                .or_insert(json!("summary"));
        }
        "chat_list" => {
            fields(&p, &["limit", "cursor", "query", "provider", "match"], &[])?;
            optional(&p, "limit", |v| integer(v, 1, 100))?;
            optional(&p, "cursor", |v| {
                valid(v.as_str().is_some_and(|s| {
                    !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit())
                }))
            })?;
            optional(&p, "query", |v| text(v, 4096, false))?;
            optional(&p, "provider", provider)?;
            optional(&p, "match", |v| one(v, &["exact", "contains"]))?;
        }
        "chat_status" => {
            fields(&p, &["messageId"], &["messageId"])?;
            identity(&p["messageId"], false)?;
        }
        "work_events" | "work_reports" => {
            fields(
                &p,
                &["taskId", "generation", "cursor", "limit", "recent"],
                &["taskId", "generation"],
            )?;
            identity(&p["taskId"], false)?;
            integer(&p["generation"], 1, 9007199254740991)?;
            optional(&p, "cursor", |v| text(v, 8192, false))?;
            optional(&p, "limit", |v| {
                integer(v, 1, if method == "work_events" { 64 } else { 16 })
            })?;
            optional(&p, "recent", |v| valid(v.is_boolean()))?;
        }
        "artifact_read" => {
            fields(
                &p,
                &["taskId", "generation", "reference", "maxBytes", "view"],
                &["taskId", "generation", "reference"],
            )?;
            identity(&p["taskId"], false)?;
            integer(&p["generation"], 1, 9007199254740991)?;
            text(&p["reference"], 2048, false)?;
            optional(&p, "maxBytes", |v| integer(v, 1, 65536))?;
            optional(&p, "view", |v| one(v, &["content", "diff"]))?;
        }
        "work_control" => {
            fields(
                &p,
                &[
                    "taskId",
                    "generation",
                    "action",
                    "blockerId",
                    "text",
                    "decision",
                ],
                &["taskId", "generation", "action"],
            )?;
            identity(&p["taskId"], false)?;
            integer(&p["generation"], 1, 9007199254740991)?;
            one(
                &p["action"],
                &[
                    "respond-blocker",
                    "resolve-blocker",
                    "request-pause",
                    "resume",
                    "review-result",
                ],
            )?;
            let blocker = |v: &Value| {
                valid(v.as_str().is_some_and(|s| {
                    s.len() >= 1
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                }))
            };
            optional(&p, "blockerId", blocker)?;
            optional(&p, "text", |v| text(v, 4096, false))?;
            if ["respond-blocker", "resolve-blocker"].contains(&p["action"].as_str().unwrap()) {
                blocker(&p["blockerId"])?;
                text(&p["text"], 4096, false)?;
            }
            if p["action"] == "review-result" {
                one(&p["decision"], &["reviewed", "integrated"])?;
            } else {
                valid(p.get("decision").is_none())?;
            }
        }
        "start" => {
            fields(
                &p,
                &[
                    "provider",
                    "cwd",
                    "prompt",
                    "permission",
                    "model",
                    "effort",
                    "projectRoot",
                    "readOnlyDirs",
                    "writableDirs",
                    "observability",
                ],
                &["provider", "cwd", "prompt"],
            )?;
            provider(&p["provider"])?;
            absolute(&p["cwd"])?;
            text(&p["prompt"], 16384, false)?;
            p.as_object_mut()
                .unwrap()
                .entry("permission")
                .or_insert(json!("read-only"));
            if p["permission"].is_null() {
                p["permission"] = json!("read-only");
            }
            insist(
                p["permission"]
                    .as_str()
                    .is_some_and(|v| ["read-only", "workspace-write"].contains(&v)),
                "PERMISSION_BOUND",
                "Select read-only or workspace-write explicitly.",
            )?;
            optional(&p, "model", model)?;
            optional(&p, "effort", |v| effort(p["provider"].as_str().unwrap(), v))?;
            optional(&p, "projectRoot", absolute)?;
            optional(&p, "readOnlyDirs", dirs)?;
            optional(&p, "writableDirs", dirs)?;
            optional(&p, "observability", |v| {
                fields(v, &["timeline", "reports", "blockerNotifications"], &[])?;
                optional(v, "timeline", |v| one(v, &["off", "public"]))?;
                optional(v, "reports", |v| one(v, &["off", "milestones"]))?;
                optional(v, "blockerNotifications", |v| valid(v.is_boolean()))
            })?;
        }
        "send" => {
            fields(&p, &["taskId", "message"], &["taskId", "message"])?;
            identity(&p["taskId"], false)?;
            text(&p["message"], 16384, false)?;
        }
        "cancel" => {
            fields(&p, &["taskId"], &["taskId"])?;
            identity(&p["taskId"], false)?;
        }
        "chat_send" => {
            fields(
                &p,
                &[
                    "title",
                    "provider",
                    "sessionId",
                    "expectedTitle",
                    "message",
                    "wake",
                    "expiresInMs",
                ],
                &["message"],
            )?;
            text(&p["message"], 1500, false)?;
            p.as_object_mut()
                .unwrap()
                .entry("wake")
                .or_insert(json!(false));
            if p["wake"].is_null() {
                p["wake"] = json!(false);
            }
            valid(p["wake"].is_boolean())?;
            optional(&p, "provider", provider)?;
            if p.get("title").is_some() {
                text(&p["title"], 4096, false)?;
                valid(p.get("sessionId").is_none() && p.get("expectedTitle").is_none())?;
            } else {
                provider(&p["provider"])?;
                identity(&p["sessionId"], false)?;
                text(&p["expectedTitle"], 4096, false)?;
            }
            optional(&p, "expiresInMs", |v| integer(v, 1000, 3600000))?;
        }
        "models" => {
            fields(
                &p,
                if mutation {
                    &["defaultModels", "defaultEfforts", "defaultPermission"]
                } else {
                    &[]
                },
                &[],
            )?;
            if mutation {
                valid(!p.as_object().unwrap().is_empty())?;
            }
            optional(&p, "defaultModels", |v| {
                fields(v, &["claude", "codex"], &["claude", "codex"])?;
                model(&v["claude"])?;
                model(&v["codex"])
            })?;
            optional(&p, "defaultEfforts", |v| {
                fields(v, &["claude", "codex"], &["claude", "codex"])?;
                effort("claude", &v["claude"])?;
                effort("codex", &v["codex"])
            })?;
            optional(&p, "defaultPermission", |v| {
                one(v, &["read-only", "workspace-write"])
            })?;
        }
        _ => unreachable!(),
    }
    Ok(p)
}
pub fn observation(v: &Value) -> Result<Value> {
    fields(
        v,
        &[
            "observerId",
            "sequence",
            "lifecycle",
            "nativeWake",
            "selfWake",
            "inboundPolicy",
            "inboundPolicyEvidence",
            "capabilities",
            "usage",
            "modVersion",
            "modBuild",
        ],
        &[
            "observerId",
            "sequence",
            "lifecycle",
            "nativeWake",
            "selfWake",
            "inboundPolicy",
            "capabilities",
            "usage",
        ],
    )?;
    identity(&v["observerId"], false)?;
    integer(&v["sequence"], 1, 9007199254740991)?;
    optional(v, "modVersion", |v| {
        valid(v.as_str().is_some_and(|s|s.len()<=48&&regex::Regex::new(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$").unwrap().is_match(s)))
    })?;
    optional(v, "modBuild", |b| {
        valid(
            v.get("modVersion").is_some()
                && b.as_str().is_some_and(|s| {
                    regex::Regex::new(r"^[a-z][a-z0-9-]{0,47}$")
                        .unwrap()
                        .is_match(s)
                }),
        )
    })?;
    one(&v["lifecycle"], &["loaded", "ended"])?;
    valid(v["nativeWake"].is_boolean() && v["selfWake"].is_boolean())?;
    one(&v["inboundPolicy"], &["allow", "hold", "refuse", "unknown"])?;
    optional(v, "inboundPolicyEvidence", |e| {
        one(
            e,
            &["explicit", "setting-unset", "read-failed", "unrecognized"],
        )?;
        valid((v["inboundPolicy"] != "unknown") == (*e == "explicit"))
    })?;
    fields(&v["capabilities"], &["sendMessage"], &["sendMessage"])?;
    valid(
        v["capabilities"]["sendMessage"].is_null() || v["capabilities"]["sendMessage"].is_boolean(),
    )?;
    if !v["usage"].is_null() {
        fields(&v["usage"], &["contextPercent"], &["contextPercent"])?;
        valid(
            v["usage"]["contextPercent"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=100.0).contains(&v)),
        )?;
    }
    Ok(v.clone())
}
pub fn wake_outcome(status: &Value, reason: &Value) -> Result<()> {
    insist(
        matches!(
            (status.as_str(), reason.as_str()),
            (Some("accepted"), Some("queued"))
                | (Some("rejected"), Some("native_rejected"))
                | (Some("submitted"), Some("inbox_written"))
                | (
                    Some("uncertain"),
                    Some("native_exception" | "context_changed" | "pre_dispatch_stopped")
                )
        ),
        "INVALID_RECEIPT",
        "Invalid native wake outcome.",
    )
}
pub fn request(v: &Value) -> Result<Value> {
    valid(v.is_object() && v["version"] == 1)?;
    let op = v["op"].as_str().unwrap_or("");
    let extras: &[&str] = match op {
        "doctor" => &[],
        "read" | "prepare" => &["method", "params"],
        "commit" | "receipt" => &["id"],
        "wake-peek" => &["target"],
        "wake-claim" => &["messageId", "target"],
        "wake-receipt" => &["messageId", "claimId", "status", "target", "reason"],
        "wake-next" => &["excludeIds", "observation"],
        "wake-observe" => &["observation"],
        "wake-check" | "wake-self-send" | "wake-self-receive" => {
            &["messageId", "claimId", "target"]
        }
        "cache-warm" => &["action", "params"],
        _ => {
            insist(
                false,
                "UNSUPPORTED_OPERATION",
                "Unsupported companion operation.",
            )?;
            unreachable!()
        }
    };
    let mut allowed = vec!["version", "op", "context"];
    allowed.extend(extras);
    if op.starts_with("wake-") {
        allowed.push("route");
    }
    let required: Vec<_> = allowed
        .iter()
        .copied()
        .filter(|k| {
            !["params", "target", "excludeIds", "reason", "route"].contains(k)
                && !(*k == "observation" && op == "wake-next")
        })
        .collect();
    fields(v, &allowed, &required)?;
    let mut out = v.clone();
    out["context"] = serde_json::to_value(context(&v["context"])?)?;
    if op == "cache-warm" {
        insist(
            v["action"].as_str().is_some_and(|v| {
                [
                    "list",
                    "configure",
                    "observe",
                    "claim",
                    "check",
                    "receipt",
                    "settings",
                ]
                .contains(&v)
            }),
            "UNSUPPORTED_OPERATION",
            "Unsupported companion operation.",
        )?;
        let p = v
            .get("params")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!({}));
        insist(
            p.is_object() && claudex_core::json::stringify(&p)?.len() <= 16384,
            "INVALID_PARAMS",
            "Invalid cache-warm parameters.",
        )?;
        for k in ["sessionId", "cwd"] {
            if let Some(value) = p.get(k) {
                insist(
                    *value == out["context"][k],
                    "CONTEXT_CHANGED",
                    "Session or directory changed.",
                )?;
            }
        }
        if let Some(value) = p.get("provider") {
            insist(
                *value == "claude",
                "INVALID_PROVIDER",
                "The companion controls Claude cache warming only.",
            )?;
        }
        out["params"] = p;
    }
    if op.starts_with("wake-") {
        out["target"] = serde_json::to_value(context(
            v.get("target")
                .filter(|v| !v.is_null())
                .unwrap_or(&v["context"]),
        )?)?;
        optional(v, "route", |v| one(v, &["mod", "mod-self"]))?;
    }
    if ["read", "prepare"].contains(&op) {
        let p = v
            .get("params")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!({}));
        out["params"] = params(v["method"].as_str().unwrap_or(""), &p, op == "prepare")?;
    }
    for k in ["id", "messageId", "claimId"] {
        optional(v, k, |v| identity(v, true))?;
    }
    if let Some(value) = v.get("observation") {
        out["observation"] = observation(value)?;
    }
    if op == "wake-receipt" {
        out.as_object_mut()
            .unwrap()
            .entry("reason")
            .or_insert(if v["status"] == "accepted" {
                json!("queued")
            } else {
                json!("native_exception")
            });
        if out["reason"].is_null() {
            out["reason"] = if v["status"] == "accepted" {
                json!("queued")
            } else {
                json!("native_exception")
            };
        }
        wake_outcome(&v["status"], &out["reason"])?;
    }
    if op == "wake-next" {
        out.as_object_mut()
            .unwrap()
            .entry("excludeIds")
            .or_insert(json!([]));
        if out["excludeIds"].is_null() {
            out["excludeIds"] = json!([]);
        }
        valid(out["excludeIds"].as_array().is_some_and(|a| a.len() <= 64))?;
        for id in out["excludeIds"].as_array().unwrap() {
            identity(id, true)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn companion_defaults_and_bounds_preserve_read_only_contract() -> Result<()> {
        let p = params(
            "start",
            &json!({"provider":"codex","cwd":"/private/project","prompt":"review"}),
            true,
        )?;
        assert_eq!(p["permission"], "read-only");
        assert!(params("start",&json!({"provider":"codex","cwd":"/private/project","prompt":"review","permission":"full-access"}),true).is_err());
        assert!(
            params(
                "artifact_read",
                &json!({"taskId":"t","generation":1,"reference":"a","maxBytes":65537}),
                false
            )
            .is_err()
        );
        assert!(params("handoff", &json!({}), true).is_err());
        Ok(())
    }
    #[test]
    fn diagnostic_observations_never_accept_unenumerated_capabilities() -> Result<()> {
        let v = json!({"observerId":"obs","sequence":1,"lifecycle":"loaded","nativeWake":true,"selfWake":true,"inboundPolicy":"unknown","inboundPolicyEvidence":"setting-unset","capabilities":{"sendMessage":null},"usage":null,"modVersion":"0.8.31","modBuild":"native-same-session-own-inbox-v1"});
        observation(&v)?;
        let mut bad = v.clone();
        bad["capabilities"]["controller"] = json!(true);
        assert!(observation(&bad).is_err());
        bad = v;
        bad["inboundPolicy"] = json!("allow");
        assert!(observation(&bad).is_err());
        Ok(())
    }
    #[test]
    fn request_context_is_normalized_and_wake_receipts_are_exact() -> Result<()> {
        let context =
            json!({"sessionId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","cwd":"/private/project"});
        let v = request(
            &json!({"version":1,"op":"wake-receipt","context":context,"messageId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","claimId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","status":"accepted"}),
        )?;
        assert_eq!(
            v["context"]["sessionId"],
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        );
        assert_eq!(v["target"], v["context"]);
        assert_eq!(v["reason"], "queued");
        assert!(wake_outcome(&json!("submitted"), &json!("queued")).is_err());
        Ok(())
    }
}
