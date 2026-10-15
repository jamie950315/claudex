//! Exact serialization alternatives for native metadata-only header rewrites.
use anyhow::Result;
use claudex_core::json::{canonical_stringify, stringify};
use serde_json::{Map, Value, json};
fn ordered(value: &Value, names: &[&str]) -> Option<Value> {
    let source = value.as_object()?;
    if source.keys().any(|key| !names.contains(&key.as_str())) {
        return None;
    }
    let mut fields = Map::new();
    for name in names {
        if let Some(value) = source.get(*name) {
            fields.insert((*name).into(), value.clone());
        }
    }
    Some(Value::Object(fields))
}
pub fn goal_serializations(line: &str) -> Result<Vec<String>> {
    let row: Value = serde_json::from_str(line)?;
    let Some(mut header) = ordered(&row, &["timestamp", "ordinal", "type", "payload"]) else {
        return Ok(vec![]);
    };
    let Some(mut payload) = ordered(
        &row["payload"],
        &[
            "creator_user_id",
            "creator_account_id",
            "session_id",
            "id",
            "timestamp",
            "cwd",
            "runtime_workspace_roots",
            "originator",
            "cli_version",
            "source",
            "thread_source",
            "model_provider",
            "base_instructions",
            "history_mode",
            "context_window",
            "git",
        ],
    ) else {
        return Ok(vec![]);
    };
    if row["ordinal"] != 0
        || row["type"] != "session_meta"
        || payload["history_mode"] != "paginated"
    {
        return Ok(vec![]);
    }
    for (key, names) in [
        ("base_instructions", &["text", "provenance"][..]),
        ("git", &["commit_hash", "branch", "repository_url"][..]),
    ] {
        if !payload[key].is_null() {
            let Some(value) = ordered(&payload[key], names) else {
                return Ok(vec![]);
            };
            payload[key] = value;
        }
    }
    if !payload["base_instructions"]["provenance"].is_null() {
        let Some(value) = ordered(
            &payload["base_instructions"]["provenance"],
            &["type", "model"],
        ) else {
            return Ok(vec![]);
        };
        payload["base_instructions"]["provenance"] = value;
    }
    header["payload"] = payload;
    let mut forms = vec![stringify(&header)?, canonical_stringify(&header)?];
    if !forms.iter().any(|form| form == line) {
        return Ok(vec![]);
    }
    forms.dedup();
    Ok(forms)
}
pub fn original_projection(line: &str) -> Result<Option<String>> {
    let row: Value = serde_json::from_str(line)?;
    if row["type"] != "session_meta"
        || row["ordinal"] != 0
        || row["payload"]["originator"] != "claudex"
        || row["payload"]["history_mode"] != "paginated"
        || !crate::packet::exact_keys(&row, &["ordinal", "payload", "timestamp", "type"])
        || canonical_stringify(&row)? != line
    {
        return Ok(None);
    }
    let mut payload = row["payload"].as_object().cloned().unwrap();
    let mode = payload.shift_remove("history_mode").unwrap();
    payload.insert("history_mode".into(), mode);
    Ok(Some(stringify(
        &json!({"timestamp":row["timestamp"],"type":row["type"],"payload":payload,"ordinal":row["ordinal"]}),
    )?))
}
pub fn label_free(line: &str) -> Result<Option<String>> {
    let mut row: Value = serde_json::from_str(line)?;
    if !row.is_object()
        || row["type"] != "session_meta"
        || !row["payload"].is_object()
        || stringify(&row)? != line && canonical_stringify(&row)? != line
    {
        return Ok(None);
    }
    if row["payload"]
        .get("model_provider")
        .is_some_and(|v| !v.is_string())
    {
        return Ok(None);
    }
    row["payload"]
        .as_object_mut()
        .unwrap()
        .remove("model_provider");
    Ok(Some(canonical_stringify(&row)?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_labels_are_ignored_without_weakening_body_or_duplicate_key_proofs() {
        let line = r#"{"timestamp":"t","type":"session_meta","payload":{"id":"a","model_provider":"first"},"ordinal":0}"#;
        assert_eq!(
            label_free(line).unwrap(),
            label_free(&line.replace("first", "other")).unwrap()
        );
        assert!(
            label_free(&line.replace("\"id\":\"a\"", "\"id\":\"a\",\"id\":\"a\""))
                .unwrap()
                .is_none()
        );
        assert_ne!(
            label_free(line).unwrap(),
            label_free(&line.replace("\"a\"", "\"b\"")).unwrap()
        );
    }
}
