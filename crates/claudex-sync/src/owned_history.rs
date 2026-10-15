//! Authenticate transport packets before interpreting native display metadata.
//! Transport receipts close a native turn but never become authored answers.
use crate::{
    archive, codecs,
    history::{Common, Message, assert_complete, fingerprint},
    native_history, packet,
};
use anyhow::{Result, bail, ensure};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, path::Path};

pub const RECEIPT_LABEL: &str = "[Claudex import receipt — not an AI response]";
pub fn receipt(digest: &str) -> String {
    format!(
        "{RECEIPT_LABEL}\nImported conversation checkpoint: {digest}\nThis is a transport receipt only. No model was called and no assistant answer was generated."
    )
}
pub fn decode_packet(
    root: &Path,
    content: &[Value],
    conversation: &str,
    id: &str,
    key: &[u8],
) -> Result<Option<(Vec<Message>, Value)>> {
    if let Some(packet) = packet::decode_inline(content, conversation, id, key)? {
        return Ok(Some(packet));
    }
    archive::decode(root, content, conversation, id, key)
}
pub fn build_codex(common: &Common, content: Vec<Value>, id: &str) -> Result<Common> {
    assert_complete(common)?;
    let digest = common.fingerprint()?;
    let mut out = common.clone();
    out.meta.insert("id".into(), json!(id));
    out.messages = vec![
        Message {
            role: "user".into(),
            content,
            extra: Map::new(),
        },
        Message::text("assistant", receipt(&digest)),
    ];
    Ok(out)
}
#[derive(Debug)]
pub struct Decoded {
    pub common: Common,
    pub metadata: Value,
    pub incomplete_tail: bool,
}
fn continuation(
    root: &Path,
    messages: &[Message],
    conversation: &str,
    id: &str,
    key: &[u8],
) -> Result<()> {
    for m in messages {
        ensure!(
            decode_packet(root, &m.content, conversation, id, key)?.is_none(),
            "Unexpected additional owned Codex checkpoint packet."
        );
        ensure!(
            !(m.role == "assistant"
                && m.content.iter().any(|b| b["text"]
                    .as_str()
                    .is_some_and(|s| s.starts_with(RECEIPT_LABEL)))),
            "Unexpected additional transport receipt."
        );
    }
    Ok(())
}
fn validate_bootstrap(metadata: &Value) -> Result<()> {
    ensure!(
        metadata["sourceSide"] == "claude"
            && metadata["previousDigest"].is_null()
            && metadata.get("historyPrefixCount").is_none(),
        "Owned Codex checkpoint has invalid source or prefix."
    );
    Ok(())
}
pub fn decode_codex(
    root: &Path,
    text: &str,
    conversation: &str,
    id: &str,
    key: &[u8],
) -> Result<Decoded> {
    let rows = codecs::parse_rows(text)?;
    let native = codecs::decode_codex(text)?;
    ensure!(
        native.meta.get("id") == Some(&json!(id))
            && rows.iter().any(|r| r["type"] == "session_meta"
                && r["payload"]["id"] == id
                && r["payload"]["originator"] == "claudex"),
        "Owned Codex native identity or ownership marker differs."
    );
    let bootstrap = native
        .messages
        .first()
        .filter(|m| m.role == "user")
        .ok_or_else(|| anyhow::anyhow!("Missing initial owned checkpoint."))?;
    let (messages, metadata) = decode_packet(root, &bootstrap.content, conversation, id, key)?
        .ok_or_else(|| anyhow::anyhow!("Missing authenticated owned checkpoint."))?;
    validate_bootstrap(&metadata)?;
    let ack = native
        .messages
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("Missing transport receipt."))?;
    ensure!(
        ack.role == "assistant"
            && ack.content
                == vec![
                    json!({"type":"text","text":receipt(metadata["digest"].as_str().unwrap())})
                ],
        "Modified owned transport receipt."
    );
    continuation(root, &native.messages[2..], conversation, id, key)?;
    let mut common = native;
    common.messages = messages
        .into_iter()
        .chain(common.messages.into_iter().skip(2))
        .collect();
    assert_complete(&common)?;
    Ok(Decoded {
        common,
        metadata,
        incomplete_tail: false,
    })
}
fn permitted_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}
fn bootstrap_content(item: &Value) -> Result<Vec<Value>> {
    ensure!(
        permitted_keys(item, &["type", "id", "clientId", "content"])
            && item["type"] == "userMessage"
            && item["id"].as_str().is_some_and(|s| !s.is_empty())
            && item
                .get("clientId")
                .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| !s.is_empty())),
        "Owned checkpoint user metadata changed."
    );
    item["content"].as_array().filter(|a|!a.is_empty()).ok_or_else(||anyhow::anyhow!("Empty bootstrap user content."))?.iter().map(|block|{
        if block["type"]=="text" {ensure!(permitted_keys(block,&["type","text","text_elements"])&&block["text"].is_string()&&block["text_elements"].as_array().is_some_and(Vec::is_empty),"Owned bootstrap text metadata changed.");Ok(json!({"type":"text","text":block["text"]}))}
        else if block["type"]=="image" {ensure!(permitted_keys(block,&["type","url","detail"])&&block["detail"].is_null(),"Owned bootstrap image metadata changed.");let (media,data)=block["url"].as_str().and_then(|s|s.strip_prefix("data:")).and_then(|s|s.split_once(";base64,")).ok_or_else(||anyhow::anyhow!("Owned bootstrap image bytes missing."))?;let image=json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}});packet::validate_image(&image)?;Ok(image)}
        else {bail!("Unsupported owned bootstrap input; no content discarded.")}
    }).collect()
}
pub fn validate_codex_native_bootstrap(
    root: &Path,
    snapshot: &native_history::Snapshot,
    conversation: &str,
    id: &str,
    key: &[u8],
) -> Result<()> {
    let first = snapshot
        .turns
        .first()
        .ok_or_else(|| anyhow::anyhow!("Missing owned bootstrap turn."))?;
    let item = first["items"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| anyhow::anyhow!("Missing owned bootstrap item."))?;
    let content = bootstrap_content(item)?;
    let (_, metadata) = decode_packet(root, &content, conversation, id, key)?
        .ok_or_else(|| anyhow::anyhow!("Missing authenticated owned bootstrap."))?;
    validate_bootstrap(&metadata)?;
    if let Some(proof) = &snapshot.late_item_evidence {
        ensure!(
            !proof["placements"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(proof["withheld"].as_array().into_iter().flatten())
                .any(|p| p["turnId"] == first["id"]),
            "Owned bootstrap cannot hold a late native item."
        );
    }
    Ok(())
}
pub fn decode_codex_native(
    root: &Path,
    snapshot: &native_history::Snapshot,
    conversation: &str,
    id: &str,
    cwd: &str,
    key: &[u8],
) -> Result<Decoded> {
    let display = native_history::convert(snapshot, id, cwd, None, false)?;
    let items = snapshot
        .turns
        .first()
        .and_then(|t| t["items"].as_array())
        .filter(|a| a.len() == 2)
        .ok_or_else(|| {
            anyhow::anyhow!("Bootstrap turn must contain exactly packet and receipt.")
        })?;
    let content = bootstrap_content(&items[0])?;
    let (messages, metadata) = decode_packet(root, &content, conversation, id, key)?
        .ok_or_else(|| anyhow::anyhow!("Missing authenticated bootstrap packet."))?;
    validate_bootstrap(&metadata)?;
    let ack = &items[1];
    ensure!(
        permitted_keys(
            ack,
            &[
                "type",
                "id",
                "text",
                "phase",
                "memoryCitation",
                "delivery",
                "questions"
            ]
        ) && ack["type"] == "agentMessage"
            && ack["phase"] == "final_answer"
            && ack["text"] == receipt(metadata["digest"].as_str().unwrap())
            && ["memoryCitation", "delivery", "questions"]
                .iter()
                .all(|k| ack[*k].is_null()),
        "Modified owned bootstrap receipt metadata."
    );
    continuation(root, &display.messages[2..], conversation, id, key)?;
    let mut common = display;
    common.messages = messages
        .into_iter()
        .chain(common.messages.into_iter().skip(2))
        .collect();
    assert_complete(&common)?;
    Ok(Decoded {
        common,
        metadata,
        incomplete_tail: snapshot.incomplete_tail,
    })
}
/// Complete native prefixes are selected on the raw rows. The whole selected
/// graph is decoded before packet expansion; unknown records stay inert data.
pub fn completed_claude(
    text: &str,
    root: &Path,
    conversation: &str,
    id: &str,
    key: Option<&[u8]>,
) -> Result<Decoded> {
    completed_claude_with_policy(
        text,
        root,
        conversation,
        id,
        key,
        claudex_core::version::VersionPolicy::Strict,
    )
}
pub fn completed_claude_with_policy(
    text: &str,
    root: &Path,
    conversation: &str,
    id: &str,
    key: Option<&[u8]>,
    policy: claudex_core::version::VersionPolicy,
) -> Result<Decoded> {
    let rows = codecs::parse_rows(text)?;
    let mut cutoff = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line)?;
        if row["isSidechain"] == true {
            continue;
        }
        if row["type"] == "assistant"
            && matches!(
                row["message"]["stop_reason"].as_str(),
                Some("end_turn" | "stop_sequence")
            )
        {
            cutoff = offset;
        }
        if let Some(key) = key {
            if row["type"] == "user" {
                if let Some(content) = row["message"]["content"].as_array() {
                    if decode_packet(root, content, conversation, id, key)?.is_some() {
                        cutoff = offset;
                    }
                }
            }
        }
    }
    ensure!(
        cutoff > 0,
        "Wait for a complete assistant turn or authenticated synchronized checkpoint."
    );
    let tail = codecs::parse_rows(&text[cutoff..])?;
    let authored_tail = tail
        .iter()
        .filter(|r| {
            r["isSidechain"] != true && matches!(r["type"].as_str(), Some("user" | "assistant"))
        })
        .collect::<Vec<_>>();
    let mut incomplete = !authored_tail.is_empty()
        && !(key.is_none()
            && (task_tail(&tail, &authored_tail, cutoff, text)
                || local_command_tail(&tail, &authored_tail)));
    if let Some(key) = key {
        if authored_tail.len() == 1
            && authored_tail[0]["type"] == "user"
            && authored_tail[0]["isMeta"] == true
        {
            let all = codecs::decode_claude(text, true, true)?;
            let annotations = crate::claude_annotations::image_keys(
                &rows,
                &all,
                root,
                conversation,
                id,
                key,
                policy,
            )?;
            let candidate = Message {
                role: "user".into(),
                content: authored_tail[0]["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                extra: authored_tail[0]
                    .get("timestamp")
                    .map(|v| [("timestamp".into(), v.clone())].into_iter().collect())
                    .unwrap_or_default(),
            };
            if annotations.contains(&crate::claude_annotations::message_key(&candidate)?) {
                cutoff = text.len();
                incomplete = false;
            }
        }
    }
    let authenticate = |row: &Value| -> Result<bool> {
        let Some(key) = key else { return Ok(false) };
        let Some(content) = row["message"]["content"].as_array() else {
            return Ok(false);
        };
        Ok(decode_packet(root, content, conversation, id, key)?.is_some())
    };
    let native = codecs::decode_claude_authenticated(
        &text[..cutoff],
        true,
        key.is_some(),
        key.map(|_| &authenticate as &dyn Fn(&Value) -> Result<bool>),
    )?;
    ensure!(
        id.is_empty() || native.meta.get("id") == Some(&json!(id)),
        "Native Claude session identity changed."
    );
    let Some(key) = key else {
        assert_complete(&native)?;
        return Ok(Decoded {
            common: native,
            metadata: json!({}),
            incomplete_tail: incomplete,
        });
    };
    let selected_rows = codecs::parse_rows(&text[..cutoff])?;
    if let Some(boundary) = selected_rows.iter().position(|r| {
        r["isSidechain"] != true && r["type"] == "system" && r["subtype"] == "compact_boundary"
    }) {
        let mut authenticated = false;
        for row in &selected_rows[..boundary] {
            if row["isSidechain"] != true && row["type"] == "user" {
                if let Some(content) = row["message"]["content"].as_array() {
                    if decode_packet(root, content, conversation, id, key)?.is_some() {
                        authenticated = true;
                        break;
                    }
                }
            }
        }
        ensure!(
            authenticated,
            "Owned Claude compaction requires its authenticated earlier checkpoint."
        );
    }
    let annotations = crate::claude_annotations::image_keys(
        &selected_rows,
        &native,
        root,
        conversation,
        id,
        key,
        policy,
    )?;
    let mut messages = vec![];
    let mut operations = HashSet::new();
    let mut following = false;
    let mut imported = 0;
    for m in native.messages {
        if !annotations.is_empty()
            && annotations.contains(&crate::claude_annotations::message_key(&m)?)
        {
            continue;
        }
        let decoded = if m.role == "user" {
            decode_packet(root, &m.content, conversation, id, key)?
        } else {
            None
        };
        if let Some((packet_messages, metadata)) = decoded {
            ensure!(
                metadata["sourceSide"] == "codex",
                "Owned Claude packet came from wrong source."
            );
            let operation = metadata["operationId"].as_str().unwrap();
            ensure!(
                operations.insert(operation.to_owned()),
                "Repeated synchronization operation in owned Claude history."
            );
            let previous = if messages.is_empty() {
                Value::Null
            } else {
                json!(fingerprint(&messages, messages.len())?)
            };
            ensure!(
                metadata["previousDigest"] == previous,
                "Owned Claude history does not match synchronized prefix."
            );
            let prefix = metadata
                .get("historyPrefixCount")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if metadata.get("historyPrefixCount").is_some() {
                ensure!(
                    prefix == messages.len()
                        && prefix <= packet_messages.len()
                        && json!(fingerprint(&packet_messages, prefix)?) == previous,
                    "Owned Claude refresh does not match full prefix."
                );
            }
            messages.extend(packet_messages.into_iter().skip(prefix));
            following = true;
            imported += 1;
        } else {
            let receipt = following
                && m.role == "assistant"
                && m.content == vec![json!({"type":"text","text":"No response requested."})]
                && m.extra.get("model") == Some(&json!("<synthetic>"))
                && m.extra.get("stop_reason") == Some(&json!("stop_sequence"))
                && m.extra
                    .get("usage")
                    .and_then(Value::as_object)
                    .is_some_and(|u| {
                        u.get("input_tokens") == Some(&json!(0))
                            && u.get("output_tokens") == Some(&json!(0))
                            && u.values().all(|v| v == &json!(0))
                    });
            following = false;
            if !receipt {
                messages.extend(crate::history::portable_messages(&[m]));
            }
        }
    }
    ensure!(
        imported > 0,
        "Owned Claude history is missing its authenticated bootstrap."
    );
    let common = Common { messages, ..native };
    assert_complete(&common)?;
    Ok(Decoded {
        common,
        metadata: json!({"importedPackets":imported}),
        incomplete_tail: incomplete,
    })
}
fn task_tail(after: &[Value], tail: &[&Value], cutoff: usize, text: &str) -> bool {
    if tail.is_empty()
        || !tail.iter().all(|row| {
            row["type"] == "user"
                && row["message"]["role"] == "user"
                && row["origin"]["kind"] == "task-notification"
                && row["promptSource"] == "system"
                && row["queueTranscriptOnly"] == true
                && row["queueSkipAttachments"] == true
                && row["userType"] == "external"
                && row["message"]["content"].as_str().is_some_and(|s| {
                    s.starts_with("<task-notification>\n") && s.ends_with("</task-notification>")
                })
        })
    {
        return false;
    }
    let Ok(before) = codecs::parse_rows(&text[..cutoff]) else {
        return false;
    };
    let Some(boundary) = before.last().filter(|r| {
        r["type"] == "assistant" && r["uuid"].is_string() && r["sessionId"].is_string()
    }) else {
        return false;
    };
    let mut ids = before
        .iter()
        .filter_map(|r| r["uuid"].as_str())
        .collect::<HashSet<_>>();
    let mut parent = &boundary["uuid"];
    let mut queued = None;
    let mut dequeued = false;
    let mut seen = 0;
    for row in after.iter().filter(|r| r["isSidechain"] != true) {
        if row["type"] == "queue-operation" {
            if row["sessionId"] != boundary["sessionId"] {
                return false;
            }
            if row["operation"] == "enqueue" && queued.is_none() {
                queued = Some(&row["content"]);
                dequeued = false;
            } else if row["operation"] == "dequeue" && queued.is_some() && !dequeued {
                dequeued = true;
            } else {
                return false;
            }
        } else if let Some(id) = row["uuid"].as_str() {
            if !ids.insert(id)
                || row["sessionId"] != boundary["sessionId"]
                || &row["parentUuid"] != parent
            {
                return false;
            }
            if row["type"] == "system" && row["subtype"] == "stop_hook_summary" {
                parent = &row["uuid"];
            } else if row["type"] == "user" && tail.iter().any(|t| t["uuid"] == id) {
                if !dequeued
                    || queued != Some(&row["message"]["content"])
                    || row["cwd"] != boundary["cwd"]
                {
                    return false;
                }
                queued = None;
                dequeued = false;
                parent = &row["uuid"];
                seen += 1;
            } else {
                return false;
            }
        }
    }
    seen == tail.len() && queued.is_none()
}
fn local_command_tail(after: &[Value], tail: &[&Value]) -> bool {
    let main = after
        .iter()
        .filter(|r| r["isSidechain"] != true)
        .collect::<Vec<_>>();
    if main.iter().any(|r| {
        r["type"] == "system"
            && !matches!(
                r["subtype"].as_str(),
                Some("stop_hook_summary" | "compact_boundary" | "local_command")
            )
    }) {
        return false;
    }
    let boundaries = main
        .iter()
        .filter(|r| r["type"] == "system" && r["subtype"] == "compact_boundary")
        .map(|r| &r["uuid"])
        .collect::<Vec<_>>();
    let wrapped = |r: &Value, tag: &str| {
        r["message"]["content"].as_str().is_some_and(|s| {
            s.starts_with(&format!("<{tag}>")) && s.trim_end().ends_with(&format!("</{tag}>"))
        })
    };
    let mut caveat = None;
    let mut commands = 0;
    let mut summaries = 0;
    for row in tail {
        if row["type"] != "user" || row["message"]["role"] != "user" {
            return false;
        }
        if row["isCompactSummary"] == true {
            if caveat.is_some() || !boundaries.contains(&&row["parentUuid"]) {
                return false;
            }
            summaries += 1;
        } else if row["isMeta"] == true {
            if caveat.is_some() || !wrapped(row, "local-command-caveat") {
                return false;
            }
            caveat = Some(*row);
        } else if row["message"]["content"]
            .as_str()
            .is_some_and(|s| s.starts_with("<command-name>"))
        {
            if !caveat.is_some_and(|c| c["promptId"] == row["promptId"]) {
                return false;
            }
            caveat = None;
            commands += 1;
        } else if wrapped(row, "local-command-stdout") || wrapped(row, "local-command-stderr") {
            if caveat.is_some() || commands == 0 {
                return false;
            }
        } else {
            return false;
        }
    }
    caveat.is_none() && commands + summaries > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_ancillary_task_tail_requires_exact_queue_and_parent_evidence() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let base = json!({"type":"assistant","uuid":"a","sessionId":id,"cwd":"/tmp","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}});
        let notification = "<task-notification>\nfinished\n</task-notification>";
        let mut rows = vec![
            base,
            json!({"type":"queue-operation","operation":"enqueue","sessionId":id,"content":notification}),
            json!({"type":"queue-operation","operation":"dequeue","sessionId":id}),
            json!({"type":"user","uuid":"n","parentUuid":"a","sessionId":id,"cwd":"/tmp","origin":{"kind":"task-notification"},"promptSource":"system","queueTranscriptOnly":true,"queueSkipAttachments":true,"userType":"external","message":{"role":"user","content":notification}}),
        ];
        let exact = codecs::serialize_rows(&rows)?;
        assert!(!completed_claude(&exact, temp.path(), "c", &id, None)?.incomplete_tail);
        rows[1]["content"] = json!("different");
        assert!(
            completed_claude(&codecs::serialize_rows(&rows)?, temp.path(), "c", &id, None)?
                .incomplete_tail
        );
        Ok(())
    }
    #[test]
    fn native_local_command_tail_requires_its_own_caveat() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let rows = vec![
            json!({"type":"assistant","uuid":"a","sessionId":id,"cwd":"/tmp","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}),
            json!({"type":"user","uuid":"c","parentUuid":"a","sessionId":id,"cwd":"/tmp","promptId":"p","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>native command</local-command-caveat>"}}),
            json!({"type":"user","uuid":"m","parentUuid":"c","sessionId":id,"cwd":"/tmp","promptId":"p","message":{"role":"user","content":"<command-name>/model</command-name>"}}),
        ];
        assert!(
            !completed_claude(&codecs::serialize_rows(&rows)?, temp.path(), "c", &id, None)?
                .incomplete_tail
        );
        assert!(
            completed_claude(
                &codecs::serialize_rows(&[rows[0].clone(), rows[2].clone()])?,
                temp.path(),
                "c",
                &id,
                None
            )?
            .incomplete_tail
        );
        Ok(())
    }
    #[test]
    fn authenticated_image_annotation_is_inert_at_exact_and_adjacent_one_ms_times() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = std::fs::canonicalize(temp.path())?;
        let id = uuid::Uuid::new_v4().to_string();
        let key = [7u8; 32];
        let common = Common {
            meta: json!({"cwd":"/tmp","timestamp":"2026-10-15T00:00:00.000Z"})
                .as_object()
                .unwrap()
                .clone(),
            messages: vec![
                Message {
                    role: "user".into(),
                    content: vec![
                        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}),
                    ],
                    extra: Map::new(),
                },
                Message::text("assistant", "seen"),
            ],
            extra: Map::new(),
        };
        let content = packet::encode_inline(
            &common.messages,
            json!({"conversationId":"c","targetSessionId":id,"operationId":"op","sourceSide":"codex","previousDigest":null}),
            &key,
        )?;
        let input = Common {
            messages: vec![Message {
                role: "user".into(),
                content,
                extra: Map::new(),
            }],
            ..common.clone()
        };
        let mut rows = codecs::parse_rows(&codecs::encode_claude(&input, &id, None, None, None)?)?;
        rows[0]["promptSource"] = json!("sdk");
        rows[0]["queueTranscriptOnly"] = json!(true);
        rows[0]["version"] = json!("2.1.281");
        rows[0]["promptId"] = json!("p");
        rows[0]["imagePasteIds"] = json!([0]);
        rows.push(json!({"type":"user","uuid":uuid::Uuid::new_v4(),"parentUuid":rows[0]["uuid"],"sessionId":id,"cwd":"/tmp","isMeta":true,"queueTranscriptOnly":true,"version":"2.1.281","promptId":"p","timestamp":"2026-10-15T00:00:00.001Z","message":{"role":"user","content":[{"type":"text","text":format!("[Image: source: /private/tmp/claude-1/-tmp/{id}/images/0.png]")}]}}));
        let decoded =
            completed_claude(&codecs::serialize_rows(&rows)?, &root, "c", &id, Some(&key))?;
        assert!(!decoded.incomplete_tail);
        assert_eq!(decoded.common.fingerprint()?, common.fingerprint()?);
        rows[1]["timestamp"] = rows[0]["timestamp"].clone();
        assert!(
            !completed_claude(&codecs::serialize_rows(&rows)?, &root, "c", &id, Some(&key))?
                .incomplete_tail
        );
        rows[1]["timestamp"] = json!("2026-10-15T00:00:00.002Z");
        assert!(
            completed_claude(&codecs::serialize_rows(&rows)?, &root, "c", &id, Some(&key))?
                .incomplete_tail
        );
        Ok(())
    }
    #[test]
    fn owned_codex_expands_exact_packet_and_removes_only_receipt() -> Result<()> {
        let root = tempfile::tempdir()?;
        claudex_core::storage::private_directory(root.path())?;
        let root = std::fs::canonicalize(root.path())?;
        let id = uuid::Uuid::new_v4().to_string();
        let key = [7u8; 32];
        let common = Common {
            meta: json!({"cwd":"/tmp","timestamp":"2026-10-15T00:00:00Z"})
                .as_object()
                .unwrap()
                .clone(),
            messages: vec![
                Message::text("user", "question"),
                Message::text("assistant", "answer"),
            ],
            extra: Map::new(),
        };
        let content = packet::encode_inline(
            &common.messages,
            json!({"conversationId":"c","targetSessionId":id,"operationId":"o","sourceSide":"claude","previousDigest":null}),
            &key,
        )?;
        let native = build_codex(&common, content, &id)?;
        let text = codecs::encode_codex(&native, &id, true)?;
        let decoded = decode_codex(&root, &text, "c", &id, &key)?;
        assert_eq!(decoded.common.fingerprint()?, common.fingerprint()?);
        let altered = text.replace("No model was called", "A model was called");
        assert!(decode_codex(&root, &altered, "c", &id, &key).is_err());
        Ok(())
    }
}
