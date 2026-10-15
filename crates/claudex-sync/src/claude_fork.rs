//! Byte-exact native copied-prefix evidence for a Claude Desktop fork.
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;
const REJECTED: &str =
    "Forked Claude history belongs to another native session; it was not enrolled.";
fn lines(text: &str) -> Vec<&str> {
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}
pub fn parent(text: &str, native: &str) -> Result<Option<String>> {
    if Uuid::parse_str(native).is_err() {
        return Ok(None);
    }
    let mut sessions = BTreeSet::new();
    for line in lines(text) {
        let row: Value = serde_json::from_str(line)?;
        if let Some(id) = row["sessionId"].as_str().filter(|id| *id != native) {
            sessions.insert(id.to_owned());
        }
    }
    if sessions.is_empty() {
        return Ok(None);
    }
    ensure!(
        sessions.len() == 1 && sessions.iter().all(|id| Uuid::parse_str(id).is_ok()),
        "{REJECTED}"
    );
    Ok(sessions.into_iter().next())
}
pub fn verify(
    text: &str,
    native: &str,
    parent_id: &str,
    parent_text: &str,
    completed: &str,
) -> Result<Value> {
    let own = lines(text);
    let parent = lines(parent_text);
    let rows = own
        .iter()
        .map(|line| serde_json::from_str::<Value>(line))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let boundary = rows
        .iter()
        .position(|row| row["sessionId"] == native)
        .unwrap_or(rows.len());
    ensure!(
        rows[..boundary]
            .iter()
            .any(|row| row["sessionId"] == parent_id)
            && rows[boundary..]
                .iter()
                .all(|row| row.get("sessionId").is_none_or(|id| id == native)),
        "{REJECTED}"
    );
    let shared = own
        .iter()
        .take(boundary)
        .zip(&parent)
        .take_while(|(left, right)| left == right)
        .count();
    ensure!(
        shared > 0
            && rows[shared..boundary]
                .iter()
                .all(|row| row.get("uuid").is_none()
                    && !matches!(
                        row["type"].as_str(),
                        Some("user" | "assistant" | "system" | "attachment")
                    )
                    && row.get("message").is_none()
                    && row.get("sessionId").is_none_or(|id| id == parent_id)),
        "{REJECTED}"
    );
    ensure!(
        crate::codecs::parse_rows(completed)?
            .iter()
            .any(|row| row["type"] == "assistant"
                && row["sessionId"] == native
                && row["isSidechain"] != true),
        "Wait for a complete assistant turn."
    );
    Ok(json!({"parentId":parent_id,"sharedLines":shared,"ownRows":rows.len()-boundary}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_prefix_uses_native_bytes_and_requires_completed_own_reply() -> Result<()> {
        let parent_id = Uuid::new_v4().to_string();
        let native = Uuid::new_v4().to_string();
        let parent_text = crate::codecs::serialize_rows(&[
            json!({"type":"user","sessionId":parent_id,"uuid":"request","message":{"role":"user","content":"Parent"}}),
            json!({"type":"assistant","sessionId":parent_id,"uuid":"reply","message":{"role":"assistant","content":"Answer","stop_reason":"end_turn"}}),
        ])?;
        let own = crate::codecs::serialize_rows(&[
            json!({"type":"user","sessionId":native,"uuid":"own","parentUuid":"reply","message":{"role":"user","content":"Fork"}}),
            json!({"type":"assistant","sessionId":native,"uuid":"done","parentUuid":"own","message":{"role":"assistant","content":"Fork answer","stop_reason":"end_turn"}}),
        ])?;
        let text = format!("{parent_text}{own}");
        assert_eq!(parent(&text, &native)?, Some(parent_id.clone()));
        assert_eq!(
            verify(&text, &native, &parent_id, &parent_text, &text)?["sharedLines"],
            2
        );
        assert!(verify(&text, &native, &parent_id, &parent_text, &parent_text).is_err());
        assert!(
            verify(
                &text,
                &native,
                &parent_id,
                &parent_text.replace("Parent", "Changed"),
                &text
            )
            .is_err()
        );
        let mut rows = crate::codecs::parse_rows(&text)?;
        rows[2]["sessionId"] = json!(Uuid::new_v4().to_string());
        assert!(parent(&crate::codecs::serialize_rows(&rows)?, &native).is_err());
        Ok(())
    }
}
