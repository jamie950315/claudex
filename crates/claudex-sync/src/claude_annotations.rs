//! Exclude only native image-source sidecars proven against an authenticated
//! adjacent SDK packet. Arbitrary metadata and image-like user text stay data.
use crate::{
    history::{Common, Message, fingerprint},
    owned_history,
};
use anyhow::{Result, ensure};
use claudex_core::version::VersionPolicy;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
pub fn message_key(message: &Message) -> Result<String> {
    let timestamp = message
        .extra
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or("");
    let timestamp = chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| timestamp.into());
    Ok(format!(
        "{timestamp}:{}",
        fingerprint(std::slice::from_ref(message), 1)?
    ))
}
pub fn image_keys(
    rows: &[Value],
    native: &Common,
    root: &Path,
    conversation: &str,
    id: &str,
    key: &[u8],
    policy: VersionPolicy,
) -> Result<HashSet<String>> {
    let by_id = rows
        .iter()
        .filter_map(|r| r["uuid"].as_str().map(|id| (id, r)))
        .collect::<HashMap<_, _>>();
    let mut excluded = HashSet::new();
    let mut keys = None;
    let pattern = regex::Regex::new(
        r"^\[Image: source: (/[^\r\n]+?)(?:, original [1-9]\d*x[1-9]\d*, displayed at [1-9]\d*x[1-9]\d*\. Multiply coordinates by \d+\.\d{2} to map to original image\.)?\]$",
    )?;
    for (index, row) in rows.iter().enumerate() {
        if row["type"] != "user"
            || row["isMeta"] != true
            || row["isSidechain"] == true
            || row["sessionId"] != id
            || !row["version"]
                .as_str()
                .is_some_and(|v| policy.permits(v, Some("2.1.281")))
        {
            continue;
        }
        let Some(parent) = row["parentUuid"]
            .as_str()
            .and_then(|id| by_id.get(id))
            .copied()
        else {
            continue;
        };
        let millis = |r: &Value| {
            r["timestamp"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|d| d.timestamp_millis())
        };
        let same_time = row["timestamp"] == parent["timestamp"]
            || row["queueTranscriptOnly"] == true
                && row["version"] == parent["version"]
                && index > 0
                && &rows[index - 1] == parent
                && millis(row)
                    .zip(millis(parent))
                    .is_some_and(|(a, b)| a - b == 1);
        let Some(paste) = parent["imagePasteIds"].as_array().filter(|a| !a.is_empty()) else {
            continue;
        };
        let paste_ids = paste
            .iter()
            .filter_map(Value::as_u64)
            .collect::<HashSet<_>>();
        if parent["type"] != "user"
            || parent["sessionId"] != id
            || parent["promptSource"] != "sdk"
            || parent["queueTranscriptOnly"] != true
            || !row["promptId"].as_str().is_some_and(|s| !s.is_empty())
            || row["promptId"] != parent["promptId"]
            || !same_time
            || row["cwd"] != parent["cwd"]
            || paste_ids.len() != paste.len()
        {
            continue;
        }
        let Some(content) = parent["message"]["content"].as_array() else {
            continue;
        };
        let Some((_, packet)) = owned_history::decode_packet(root, content, conversation, id, key)?
        else {
            continue;
        };
        if packet["sourceSide"] != "codex" {
            continue;
        }
        let images = content
            .iter()
            .filter(|b| b["type"] == "image")
            .collect::<Vec<_>>();
        let Some(annotation) = row["message"]["content"].as_array().filter(|a| {
            !a.is_empty()
                && a.iter()
                    .all(|b| b["type"] == "text" && b["text"].is_string())
        }) else {
            continue;
        };
        let lines = if annotation.len() == 1 {
            annotation[0]["text"]
                .as_str()
                .unwrap()
                .split('\n')
                .collect::<Vec<_>>()
        } else {
            annotation
                .iter()
                .map(|b| b["text"].as_str().unwrap())
                .collect()
        };
        let Some(cwd) = parent["cwd"].as_str() else {
            continue;
        };
        let project = cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>();
        if images.len() != paste.len() || lines.len() != images.len() {
            continue;
        }
        let valid = lines.iter().enumerate().all(|(i, line)| {
            let Some(captures) = pattern.captures(line) else {
                return false;
            };
            let extensions: &[&str] = match images[i]["source"]["media_type"].as_str() {
                Some("image/png") => &["png"],
                Some("image/jpeg") => &["jpg", "jpeg"],
                Some("image/gif") => &["gif"],
                Some("image/webp") => &["webp"],
                _ => &[],
            };
            extensions.iter().any(|ext| {
                captures[1].ends_with(&format!(
                    "/{project}/{id}/images/{}.{}",
                    paste[i].as_u64().unwrap(),
                    ext
                ))
            })
        });
        if !valid {
            continue;
        }
        let message = Message {
            role: "user".into(),
            content: annotation.clone(),
            extra: row
                .get("timestamp")
                .map(|v| [("timestamp".into(), v.clone())].into_iter().collect())
                .unwrap_or_default(),
        };
        let identity = message_key(&message)?;
        if keys.is_none() {
            let mut counts = HashMap::new();
            for message in &native.messages {
                *counts.entry(message_key(message)?).or_insert(0usize) += 1;
            }
            keys = Some(counts);
        }
        ensure!(
            !excluded.contains(&identity) && keys.as_ref().unwrap().get(&identity) == Some(&1),
            "Native image annotation identity is ambiguous; no metadata was discarded."
        );
        excluded.insert(identity);
    }
    Ok(excluded)
}
