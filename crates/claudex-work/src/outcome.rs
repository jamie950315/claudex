use crate::model::*;
use anyhow::{Result, bail};
use serde_json::{Value, json};

fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    let o = v
        .as_object()
        .ok_or_else(|| error("CLAUDEX_INVALID_OUTCOME", "Invalid structured outcome."))?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        bail!("Invalid structured outcome fields.");
    }
    Ok(())
}
pub fn validate(v: &Value) -> Result<()> {
    let invalid = || error("CLAUDEX_INVALID_OUTCOME", "Invalid structured outcome.");
    keys(
        v,
        &[
            "outcome",
            "summary",
            "remaining",
            "needs",
            "artifacts",
            "stage",
            "next",
            "checks",
            "blocker",
        ],
    )?;
    if !matches!(
        v["outcome"].as_str(),
        Some("done" | "partial" | "blocked" | "needs-input")
    ) {
        return Err(invalid());
    }
    text(&v["summary"], "summary", 4096)?;
    for key in ["stage", "next"] {
        if let Some(v) = v.get(key) {
            text(v, key, 2048)?;
        }
    }
    for (key, max) in [
        ("remaining", 16),
        ("needs", 16),
        ("artifacts", 32),
        ("checks", 32),
    ] {
        if let Some(values) = v.get(key) {
            let a = values.as_array().ok_or_else(invalid)?;
            if a.len() > max {
                return Err(invalid());
            }
            for row in a {
                match key {
                    "remaining" => {
                        text(row, key, 2048)?;
                    }
                    "needs" => {
                        keys(row, &["kind", "description"])?;
                        if !matches!(
                            row["kind"].as_str(),
                            Some(
                                "information"
                                    | "authorization"
                                    | "access"
                                    | "dependency"
                                    | "environment"
                            )
                        ) {
                            return Err(invalid());
                        }
                        text(&row["description"], key, 2048)?;
                    }
                    "artifacts" => {
                        keys(row, &["kind", "reference", "description"])?;
                        if !matches!(
                            row["kind"].as_str(),
                            Some("file" | "url" | "commit" | "other")
                        ) {
                            return Err(invalid());
                        }
                        text(&row["reference"], key, 2048)?;
                        if let Some(s) = row.get("description") {
                            text(s, key, 2048)?;
                        }
                    }
                    _ => {
                        keys(row, &["name", "result", "reference", "at"])?;
                        text(&row["name"], key, 2048)?;
                        if !matches!(
                            row["result"].as_str(),
                            Some("passed" | "failed" | "not-run" | "unverified")
                        ) {
                            return Err(invalid());
                        }
                        if let Some(s) = row.get("reference") {
                            text(s, key, 2048)?;
                        }
                        if row.get("at").is_some_and(|v| {
                            v.as_u64()
                                .is_none_or(|x| x == 0 || x > 9_007_199_254_740_991)
                        }) {
                            return Err(invalid());
                        }
                    }
                }
            }
        }
    }
    if let Some(b) = v.get("blocker") {
        keys(b, &["id", "question", "impact", "needs"])?;
        if let Some(i) = b.get("id") {
            id(i)?;
        }
        for k in ["question", "impact", "needs"] {
            text(&b[k], k, 2048)?;
        }
        if !matches!(v["outcome"].as_str(), Some("blocked" | "needs-input")) {
            return Err(invalid());
        }
    }
    if bytes(v) > 16384 {
        return Err(invalid());
    }
    Ok(())
}
pub fn presentation(t: &Value) -> Value {
    let report = t["active"]
        .get("report")
        .or_else(|| t["lastExecution"].get("report"));
    if let Some(r) = report {
        let mut r = r.clone();
        r["current"] = json!(
            r["generation"] == t["generation"]
                && matches!(
                    t["status"].as_str(),
                    Some("running" | "completed" | "waiting" | "paused")
                )
        );
        r
    } else {
        json!({"provenance":"unreported","outcome":null})
    }
}
