//! Native transcript codecs. Unknown native data is retained as inert labeled
//! JSON; external assets, missing parents and conflicting identities remain errors.
use crate::{
    history::{
        Common, Message, assert_complete, canonical, digest_bytes, inert, portable_messages,
    },
    packet,
};
use anyhow::{Result, bail, ensure};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn parse_rows(text: &str) -> Result<Vec<Value>> {
    text.lines()
        .filter(|line| !line.is_empty())
        .enumerate()
        .map(|(i, line)| {
            serde_json::from_str(line).map_err(|_| {
                anyhow::anyhow!("Malformed native transcript record at line {}.", i + 1)
            })
        })
        .collect()
}
pub fn project_directory(home: &Path, cwd: &str) -> PathBuf {
    home.join("projects").join(
        cwd.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>(),
    )
}
pub fn claude_path(home: &Path, cwd: &str, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id)?;
    ensure!(
        Path::new(cwd).is_absolute(),
        "Claude project must be absolute."
    );
    Ok(project_directory(home, cwd).join(format!("{id}.jsonl")))
}
fn timestamp(row: &Value, default: &Value) -> Value {
    row.get("timestamp").unwrap_or(default).clone()
}
fn content_native(block: &Value) -> Result<Value> {
    match block["type"].as_str() {
        Some("tool_use") => {
            let tool = &block["tool"];
            let name = tool["name"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing portable tool name."))?;
            let (name, input) = if name == "Raw" {
                (
                    tool["tool_name"].as_str().unwrap_or("Raw").to_owned(),
                    tool["input"].clone(),
                )
            } else {
                let mut input = tool.as_object().cloned().unwrap_or_default();
                input.remove("name");
                (name.to_owned(), Value::Object(input))
            };
            Ok(json!({"type":"tool_use","id":block["id"],"name":name,"input":input}))
        }
        Some("thinking") => {
            bail!("Unsigned reasoning must be made portable before native encoding.")
        }
        _ => Ok(block.clone()),
    }
}
/// Canonical tool schemas match the existing txcript 0.14.4 wire contract.
/// Unmodeled keys keep the entire input in Raw rather than losing data.
fn portable_tool(name: &str, input: &Value) -> Value {
    let raw = || json!({"name":"Raw","tool_name":name,"input":input});
    let Some(object) = input.as_object() else {
        return raw();
    };
    let (required, optional, booleans): (&[&str], &[(&str, &str)], &[&str]) = match name {
        "Read" => (
            &["file_path"],
            &[("offset", "integer"), ("limit", "integer")],
            &[],
        ),
        "Write" => (&["file_path", "content"], &[], &[]),
        "Edit" => (
            &["file_path", "old_string", "new_string"],
            &[],
            &["replace_all"],
        ),
        "MultiEdit" => (&["file_path"], &[("edits", "edits")], &[]),
        "Bash" => (
            &["command"],
            &[
                ("workdir", "string"),
                ("timeout_ms", "integer"),
                ("description", "string"),
            ],
            &["run_in_background"],
        ),
        name if name.starts_with('/') => (&[], &[("args", "string")], &[]),
        _ => return raw(),
    };
    if object.keys().any(|key| {
        !required.contains(&key.as_str())
            && !optional.iter().any(|(field, _)| field == key)
            && !booleans.contains(&key.as_str())
    }) || required.iter().any(|key| !input[*key].is_string())
    {
        return raw();
    }
    let mut out = json!({"name":name});
    for field in required {
        out[*field] = input[*field].clone();
    }
    for (field, kind) in optional {
        let Some(value) = input.get(*field).filter(|v| !v.is_null()) else {
            if *kind == "edits" {
                return raw();
            }
            continue;
        };
        let valid = match *kind {
            "string" => value.is_string(),
            "integer" => value.as_u64().is_some(),
            "edits" => value.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    v.as_object().is_some_and(|o| {
                        o.keys().all(|k| {
                            matches!(k.as_str(), "old_string" | "new_string" | "replace_all")
                        })
                    }) && v["old_string"].is_string()
                        && v["new_string"].is_string()
                        && v.get("replace_all").is_none_or(Value::is_boolean)
                })
            }),
            _ => false,
        };
        if !valid {
            return raw();
        }
        out[*field] = value.clone();
    }
    for field in booleans {
        if let Some(value) = input.get(*field) {
            if !value.is_boolean() {
                return raw();
            }
            if value == true {
                out[*field] = json!(true);
            }
        }
    }
    if name == "MultiEdit" {
        for edit in out["edits"].as_array_mut().unwrap() {
            if edit["replace_all"] != true {
                edit.as_object_mut().unwrap().remove("replace_all");
            }
        }
    }
    if name.starts_with('/') {
        out["name"] = json!("Command");
        out["command"] = json!(name);
    }
    out
}
fn content_portable(block: &Value) -> Result<Value> {
    match block["type"].as_str() {
        Some("text") => Ok(json!({"type":"text","text":block["text"]})),
        Some("thinking") => {
            let mut thinking = json!({"type":"thinking","text":block.get("thinking").or_else(||block.get("text")).unwrap_or(&Value::Null)});
            if let Some(signature) = block.get("signature") {
                thinking["signature"] = signature.clone();
            }
            Ok(thinking)
        }
        Some("tool_use") => {
            let name = block["name"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing native tool name."))?;
            let input = block.get("input").cloned().unwrap_or(json!({}));
            let tool = portable_tool(name, &input);
            Ok(json!({"type":"tool_use","id":block["id"],"tool":tool}))
        }
        Some("tool_result") => {
            let mut result = json!({"type":"tool_result","tool_use_id":block["tool_use_id"],"content":block.get("content").cloned().unwrap_or(json!(""))});
            if block["is_error"] == true {
                result["is_error"] = json!(true);
            }
            Ok(result)
        }
        Some("image") => {
            packet::validate_image(block)?;
            Ok(block.clone())
        }
        Some("artifact" | "document" | "image_url" | "input_image") => {
            bail!("Native content depends on an external asset.")
        }
        _ => inert("Claude content block", block),
    }
}
pub fn encode_claude(
    common: &Common,
    id: &str,
    parent: Option<&str>,
    title: Option<&str>,
    owner: Option<&str>,
) -> Result<String> {
    Uuid::parse_str(id)?;
    let cwd = common.cwd()?;
    let mut rows = vec![];
    let mut parent = parent.map(str::to_owned);
    for message in portable_messages(&common.messages) {
        let uuid = Uuid::new_v4().to_string();
        let content = message
            .content
            .iter()
            .map(content_native)
            .collect::<Result<Vec<_>>>()?;
        let mut native = json!({"role":message.role,"content":content});
        if message.role == "assistant" {
            native["id"] = json!(format!("msg_{}", Uuid::new_v4().simple()));
            native["type"] = json!("message");
            native["stop_reason"] =
                json!(if message.content.iter().any(|b| b["type"] == "tool_use") {
                    "tool_use"
                } else {
                    "end_turn"
                });
            native["stop_sequence"] = Value::Null;
            native["usage"] = json!({"input_tokens":0,"output_tokens":0});
        }
        let stamp = message
            .extra
            .get("timestamp")
            .or_else(|| common.meta.get("timestamp"))
            .ok_or_else(|| anyhow::anyhow!("Native projection requires timestamp."))?;
        rows.push(json!({"type":message.role,"cwd":cwd,"sessionId":id,"uuid":uuid,"parentUuid":parent,"timestamp":stamp,"message":native,"isSidechain":false,"userType":"external","version":"2.1.210"}));
        parent = Some(uuid);
    }
    if let Some(title) = title {
        rows.push(json!({"type":"custom-title","customTitle":title,"sessionId":id}));
    }
    if let Some(owner) = owner {
        rows.push(json!({"type":"claudex-owner","sessionId":id,"owner":owner}));
    }
    serialize_rows(&rows)
}
pub fn serialize_rows(rows: &[Value]) -> Result<String> {
    let mut text = String::new();
    for row in rows {
        text.push_str(&claudex_core::json::stringify(row)?);
        text.push('\n');
    }
    Ok(text)
}
fn stable_row(row: &Value) -> Value {
    let mut row = row.clone();
    if let Some(object) = row.as_object_mut() {
        for field in ["parentUuid", "promptId", "slug", "toolUseResult"] {
            object.remove(field);
        }
        if let Some(message) = object.get_mut("message").and_then(Value::as_object_mut) {
            message.remove("usage");
        }
    }
    row
}
fn prompt(row: &Value) -> bool {
    row["type"] == "user"
        && row["isMeta"] != true
        && (row["message"]["content"].is_string()
            || row["message"]["content"]
                .as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|b| b["type"] != "tool_result")))
}
fn response(row: &Value) -> Option<&str> {
    if row["type"] == "assistant" {
        row["message"]["id"]
            .as_str()
            .or_else(|| row["requestId"].as_str())
    } else {
        None
    }
}
fn active_rows(rows: &[Value]) -> Result<HashSet<usize>> {
    let virtual_parents = crate::claude_parallel::parents(rows);
    let parent = |row: &Value| {
        row["uuid"]
            .as_str()
            .and_then(|id| virtual_parents.get(id).cloned())
            .or_else(|| row["parentUuid"].as_str().map(str::to_owned))
    };
    let authored = |r: &Value| matches!(r["type"].as_str(), Some("user" | "assistant"));
    let mut by_id = HashMap::new();
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(id) = row["uuid"].as_str() {
            ensure!(
                by_id.insert(id.to_owned(), i).is_none(),
                "Ambiguous native Claude record identity."
            );
        }
    }
    for (i, row) in rows.iter().enumerate().filter(|(_, r)| authored(r)) {
        if let Some(parent) = parent(row) {
            ensure!(
                by_id.contains_key(&parent),
                "Dependent Claude history is missing its parent."
            );
            children.entry(parent).or_default().push(i);
        }
    }
    let Some(leaf) = rows
        .iter()
        .rposition(|r| authored(r) && r["uuid"].is_string())
    else {
        return Ok((0..rows.len()).collect());
    };
    let ancestors = |start: usize| -> Result<HashSet<usize>> {
        let mut set = HashSet::new();
        let mut index = Some(start);
        while let Some(i) = index {
            ensure!(set.insert(i), "Native Claude parent cycle.");
            index = parent(&rows[i])
                .as_deref()
                .and_then(|p| by_id.get(p))
                .copied();
        }
        Ok(set)
    };
    let active = ancestors(leaf)?;
    let responses: HashSet<_> = active.iter().filter_map(|i| response(&rows[*i])).collect();
    let mut replaced = HashSet::new();
    for siblings in children.values().filter(|v| v.len() > 1) {
        let kept: Vec<_> = siblings.iter().filter(|i| active.contains(i)).collect();
        let rewound = kept.len() == 1 && prompt(&rows[*kept[0]]);
        for i in siblings {
            let same_wave = if rows[*i]["type"] == "user" {
                !prompt(&rows[*i])
            } else {
                response(&rows[*i]).is_some_and(|id| responses.contains(id))
            };
            if !active.contains(i) && (rewound || !same_wave) {
                replaced.insert(*i);
            }
        }
    }
    let mut selected = HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        if !authored(row)
            || active.contains(&i)
            || !ancestors(i)?.iter().any(|i| replaced.contains(i))
        {
            selected.insert(i);
        }
    }
    Ok(selected)
}
fn local_tags(text: &str) -> Option<Vec<(&str, &str)>> {
    let mut rest = text.trim();
    let mut tags = vec![];
    while !rest.is_empty() {
        let end = rest.find('>')?;
        let name = rest.strip_prefix('<')?.get(..end - 1)?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            return None;
        }
        let tail = &rest[end + 1..];
        let close = format!("</{name}>");
        let size = tail.find(&close)?;
        tags.push((name, &tail[..size]));
        rest = tail[size + close.len()..].trim_start();
    }
    (!tags.is_empty()).then_some(tags)
}
fn local_unescape(text: &str) -> String {
    static ESCAPED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    ESCAPED.get_or_init(||regex::Regex::new(r"<(\\+)/((?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>)").unwrap()).replace_all(text,|cap:&regex::Captures<'_>|format!("<{}/{}",&cap[1][1..],&cap[2])).into_owned()
}
fn local_command(text: &str) -> Option<(String, String)> {
    let tags = local_tags(text)?;
    if !tags
        .iter()
        .all(|(tag, _)| matches!(*tag, "command-name" | "command-message" | "command-args"))
    {
        return None;
    }
    let name = local_unescape(
        tags.iter()
            .find(|(tag, _)| *tag == "command-name")?
            .1
            .trim(),
    );
    if name.is_empty() {
        return None;
    }
    let name = if name.starts_with('/') {
        name
    } else {
        format!("/{name}")
    };
    let args = tags
        .iter()
        .find(|(tag, _)| *tag == "command-args")
        .map(|(_, body)| local_unescape(body.trim()))
        .unwrap_or_default();
    Some((name, args))
}
fn local_stdout(text: &str) -> Option<String> {
    let tags = local_tags(text)?;
    if tags.len() != 1 || tags[0].0 != "local-command-stdout" {
        return None;
    }
    let body = local_unescape(tags[0].1);
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => while chars.next().is_some_and(|c| !('@'..='~').contains(&c)) {},
            Some(']') => {
                let mut previous = '\0';
                for c in chars.by_ref() {
                    if c == '\u{7}' || previous == '\u{1b}' && c == '\\' {
                        break;
                    }
                    previous = c;
                }
            }
            _ => (),
        }
    }
    Some(out)
}
fn local_caveat(text: &str) -> bool {
    local_tags(text).is_some_and(|tags| tags.len() == 1 && tags[0].0 == "local-command-caveat")
}
fn local_body(row: &Value) -> Option<&str> {
    if row["type"] == "system" {
        return row["content"].as_str();
    }
    let value = &row["message"]["content"];
    value.as_str().or_else(|| {
        value
            .as_array()
            .filter(|a| a.len() == 1 && a[0]["type"] == "text")?
            .first()?["text"]
            .as_str()
    })
}
pub fn decode_claude(text: &str, preserve_compaction: bool, owned: bool) -> Result<Common> {
    decode_claude_authenticated(text, preserve_compaction, owned, None)
}
pub fn decode_claude_authenticated(
    text: &str,
    preserve_compaction: bool,
    owned: bool,
    authenticate: Option<&dyn Fn(&Value) -> Result<bool>>,
) -> Result<Common> {
    let mut rows: Vec<_> = parse_rows(text)?
        .into_iter()
        .filter(|r| r["isSidechain"] != true)
        .collect();
    let mut first = HashMap::new();
    for row in &mut rows {
        if let Some(id) = row["uuid"].as_str().map(str::to_owned) {
            if let Some(old) = first.get(&id) {
                ensure!(
                    !owned && stable_row(old) == stable_row(row),
                    "Ambiguous repeated Claude record identity."
                );
                *row = json!({"type":"claudex-repersisted-record"});
            } else {
                first.insert(id, row.clone());
            }
        }
    }
    let boundaries: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r["type"] == "system" && r["subtype"] == "compact_boundary")
        .map(|(i, _)| i)
        .collect();
    let mut compaction = None;
    let mut preserved_packets = 0;
    for (generation, index) in boundaries.iter().enumerate() {
        let end = boundaries
            .get(generation + 1)
            .copied()
            .unwrap_or(rows.len());
        let summary = (index + 1..end)
            .find(|i| rows[*i]["isCompactSummary"] == true)
            .ok_or_else(|| anyhow::anyhow!("Claude compaction summary missing."))?;
        let native = &rows[summary]["message"]["content"];
        let readable = if let Some(s) = native.as_str() {
            s.to_owned()
        } else if let Some(a) = native.as_array() {
            ensure!(
                a.iter()
                    .all(|b| b["type"] == "text" && b["text"].is_string()),
                "Opaque Claude compaction summary."
            );
            a.iter()
                .map(|b| b["text"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            bail!("Opaque Claude compaction summary.")
        };
        ensure!(
            !readable.trim().is_empty(),
            "Empty Claude compaction summary."
        );
        let boundary = &rows[*index];
        ensure!(
            boundary["uuid"].as_str().is_some_and(|s| !s.is_empty()),
            "Claude compaction identity missing."
        );
        if preserve_compaction {
            ensure!(
                *index > 0
                    && rows[..*index]
                        .iter()
                        .rev()
                        .find(|r| r["uuid"].is_string())
                        .is_some_and(|previous| boundary["sessionId"] == previous["sessionId"]
                            && boundary["cwd"] == previous["cwd"])
                    && rows[summary]["uuid"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                    && rows[summary]["sessionId"] == boundary["sessionId"]
                    && rows[summary]["cwd"] == boundary["cwd"],
                "Claude compaction does not retain complete native prefix."
            );
            let logical = boundary["logicalParentUuid"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Claude compaction exact link missing."))?;
            if first.contains_key(logical) {
                ensure!(
                    rows[..*index]
                        .iter()
                        .rev()
                        .find(|r| r["uuid"].is_string())
                        .is_some_and(|previous| previous["uuid"] == logical),
                    "Claude compaction has missing earlier history."
                );
            }
            if owned && rows[summary]["queueTranscriptOnly"] == true {
                ensure!(
                    authenticate.is_some()
                        && boundary["parentUuid"].is_null()
                        && rows[summary]["type"] == "user"
                        && rows[summary]["parentUuid"] == boundary["uuid"]
                        && rows[summary]["isVisibleInTranscriptOnly"] == true
                        && rows[*index + 1..end]
                            .iter()
                            .filter(|r| r["isCompactSummary"] == true)
                            .count()
                            == 1,
                    "Owned queued compaction lacks its exact native link."
                );
                let previous = rows[..*index]
                    .iter()
                    .rev()
                    .find(|r| r["uuid"].is_string())
                    .unwrap();
                ensure!(
                    previous["uuid"] == logical,
                    "Owned queued compaction changed its exact prefix boundary."
                );
                if boundary["compactMetadata"]
                    .get("preservedSegment")
                    .is_some()
                    || boundary["compactMetadata"]
                        .get("preservedMessages")
                        .is_some()
                {
                    let segment = &boundary["compactMetadata"]["preservedSegment"];
                    let messages = &boundary["compactMetadata"]["preservedMessages"];
                    let id = &messages["uuids"][0];
                    ensure!(
                        packet::exact_keys(segment, &["anchorUuid", "headUuid", "tailUuid"])
                            && packet::exact_keys(messages, &["allUuids", "anchorUuid", "uuids"])
                            && messages["uuids"].as_array().is_some_and(|v| v.len() == 1)
                            && messages["allUuids"]
                                .as_array()
                                .is_some_and(|v| v.len() == 1)
                            && messages["allUuids"][0] == *id
                            && id.as_str().is_some_and(|s| !s.is_empty())
                            && segment["headUuid"] == *id
                            && segment["tailUuid"] == *id
                            && boundary["logicalParentUuid"] == *id
                            && segment["anchorUuid"] == rows[summary]["uuid"]
                            && messages["anchorUuid"] == rows[summary]["uuid"],
                        "Unsupported owned preserved-segment dependency."
                    );
                    let candidates = rows[..*index]
                        .iter()
                        .filter(|r| r["uuid"] == *id)
                        .collect::<Vec<_>>();
                    ensure!(
                        candidates.len() == 1
                            && candidates[0]["type"] == "user"
                            && candidates[0]["promptSource"] == "sdk"
                            && candidates[0]["queueTranscriptOnly"] == true
                            && candidates[0]["isMeta"] != true
                            && candidates[0]["isSynthetic"] != true
                            && authenticate.unwrap()(candidates[0])?,
                        "Owned preserved packet is missing or unauthenticated."
                    );
                    preserved_packets += 1;
                }
            }
        } else {
            ensure!(
                boundary["compactMetadata"]
                    .get("preservedSegment")
                    .is_none()
                    && boundary["compactMetadata"]
                        .get("preservedMessages")
                        .is_none(),
                "Claude compaction preserved-segment dependencies need retained-prefix proof."
            );
            ensure!(
                rows[summary]["type"] == "user" && rows[summary]["parentUuid"] == boundary["uuid"],
                "Claude compaction requires explicitly linked summary."
            );
        }
        let offset = text
            .lines()
            .take(*index)
            .map(|line| line.len() + 1)
            .sum::<usize>();
        compaction = Some(
            json!({"id":digest_bytes(&canonical(&json!({"source":"claude","offset":offset,"row":rows[*index]}))?),"offset":offset,"source":"claude"}),
        );
        rows[summary]["message"]["content"] = json!(format!(
            "[Imported native compaction summary; {}]\n{readable}",
            if preserve_compaction {
                "complete earlier verified history is retained."
            } else {
                "earlier verbatim history is not included."
            }
        ));
    }
    if preserve_compaction && !boundaries.is_empty() {
        let mut known = HashSet::new();
        for row in &rows {
            if let Some(id) = row["uuid"].as_str() {
                ensure!(known.insert(id), "Ambiguous compaction record identity.");
                if let Some(parent) = row["parentUuid"].as_str() {
                    ensure!(
                        known.contains(parent),
                        "Compaction has a missing or forward native parent."
                    );
                }
            }
        }
    }
    if !preserve_compaction {
        if let Some(index) = boundaries.last() {
            rows = rows[*index..].to_vec();
        }
    }
    let selected = active_rows(&rows)?;
    let rows = rows
        .into_iter()
        .enumerate()
        .filter(|(i, _)| selected.contains(i))
        .map(|(_, r)| r)
        .collect::<Vec<_>>();
    let order = crate::claude_parallel::results_after_calls(&rows);
    let commands = rows
        .iter()
        .filter(|r| r["type"] == "system" || r["type"] == "user" && r["message"]["role"] == "user")
        .filter_map(|r| Some((r["uuid"].as_str()?, local_command(local_body(r)?)?)))
        .collect::<HashMap<_, _>>();
    let mut paired = HashSet::new();
    let mut output_ids = HashMap::new();
    let mut open = None;
    for index in &order {
        let row = &rows[*index];
        if let Some(id) = row["uuid"].as_str() {
            if commands.contains_key(id) {
                open = Some(id);
            } else if local_body(row).and_then(local_stdout).is_some() {
                let parent = row["parentUuid"].as_str().filter(|p| Some(*p) == open);
                if let Some(parent) = parent {
                    paired.insert(parent);
                }
                output_ids.insert(id, parent.unwrap_or(id));
                open = None;
            }
        }
    }
    // A response stopped by a refusal never ran its tool calls; the native
    // transcript keeps them without a result.
    let answered: HashSet<&str> = rows
        .iter()
        .filter_map(|row| row["message"]["content"].as_array())
        .flatten()
        .filter(|block| block["type"] == "tool_result")
        .filter_map(|block| block["tool_use_id"].as_str())
        .collect();
    let mut messages = vec![];
    let mut meta = Map::new();
    for i in order {
        let row = &rows[i];
        for (native, key) in [
            ("sessionId", "id"),
            ("cwd", "cwd"),
            ("timestamp", "timestamp"),
        ] {
            if !meta.contains_key(key) {
                if let Some(value) = row.get(native) {
                    meta.insert(key.into(), value.clone());
                }
            }
        }
        if row["type"] == "custom-title" {
            meta.insert("title".into(), row["customTitle"].clone());
            continue;
        }
        let system_envelope = row["type"] == "system"
            && local_body(row).is_some_and(|s| {
                local_command(s).is_some() || local_stdout(s).is_some() || local_caveat(s)
            });
        if matches!(row["type"].as_str(), Some("user" | "assistant")) || system_envelope {
            let role = if system_envelope {
                "user"
            } else {
                row["message"]["role"]
                    .as_str()
                    .or_else(|| row["type"].as_str())
                    .unwrap()
            };
            let native = if system_envelope {
                &row["content"]
            } else {
                &row["message"]["content"]
            };
            let envelope = local_body(row).filter(|s| {
                local_command(s).is_some() || local_stdout(s).is_some() || local_caveat(s)
            });
            let content = if let Some(s) = envelope.or_else(|| native.as_str()) {
                if role == "user" && (s.is_empty() || local_caveat(s)) {
                    vec![]
                } else if role == "user" && (system_envelope || row["message"]["role"] == "user") {
                    if let Some((command, args)) = commands.get(row["uuid"].as_str().unwrap_or(""))
                    {
                        if paired.contains(row["uuid"].as_str().unwrap_or("")) {
                            let mut tool = json!({"name":"Command","command":command});
                            if !args.is_empty() {
                                tool["args"] = json!(args);
                            }
                            vec![json!({"type":"tool_use","id":row["uuid"],"tool":tool})]
                        } else {
                            vec![
                                json!({"type":"text","text":format!("[Native local command]\n{s}")}),
                            ]
                        }
                    } else if let Some(output) = local_stdout(s) {
                        let id = output_ids
                            .get(row["uuid"].as_str().unwrap_or(""))
                            .copied()
                            .ok_or_else(|| {
                                anyhow::anyhow!("Local command output lacks native identity.")
                            })?;
                        vec![json!({"type":"tool_result","tool_use_id":id,"content":output})]
                    } else {
                        vec![json!({"type":"text","text":s})]
                    }
                } else {
                    vec![json!({"type":"text","text":s})]
                }
            } else if let Some(blocks) = native.as_array() {
                let refused = row["message"]["stop_reason"] == "refusal";
                blocks
                    .iter()
                    .map(|block| {
                        let unrun = refused
                            && block["type"] == "tool_use"
                            && !block["id"].as_str().is_some_and(|id| answered.contains(id));
                        if unrun {
                            inert("Claude tool call withheld by a refusal; it did not run", block)
                        } else {
                            content_portable(block)
                        }
                    })
                    .collect::<Result<_>>()?
            } else {
                vec![inert("Claude message", row)?]
            };
            if !content.is_empty() {
                let mut extra = Map::new();
                if let Some(stamp) = row.get("timestamp") {
                    extra.insert("timestamp".into(), stamp.clone());
                }
                for field in ["model", "stop_reason", "usage"] {
                    if let Some(value) = row["message"].get(field) {
                        extra.insert(field.into(), value.clone());
                    }
                }
                messages.push(Message {
                    role: role.into(),
                    content,
                    extra,
                });
            }
        } else if !matches!(
            row["type"].as_str(),
            Some(
                "system"
                    | "progress"
                    | "file-history-snapshot"
                    | "queue-operation"
                    | "custom-title"
                    | "summary"
                    | "last-prompt"
                    | "pr-link"
                    | "claudex-owner"
                    | "bridge-session"
                    | "session-state"
                    | "claudex-repersisted-record"
                    | "mode"
                    | "permission-mode"
                    | "attachment"
                    | "cost-state"
                    | "atis-latch"
                    | "agent-name"
                    | "relocated"
                    | "ai-title"
                    | "file-history-delta"
            )
        ) {
            messages.push(Message {
                role: "assistant".into(),
                content: vec![inert("Claude native record", row)?],
                extra: Map::new(),
            });
        }
    }
    if let Some(mut compaction) = compaction {
        if preserve_compaction {
            compaction["retainedHistory"] = json!(true);
            compaction["boundaries"] = json!(boundaries.len());
            compaction["preservedAuthenticatedPackets"] = json!(preserved_packets);
        }
        meta.insert("compaction".into(), compaction);
    }
    Ok(Common {
        meta,
        messages,
        extra: Map::new(),
    })
}

pub fn codex_projection_path(home: &Path, common: &Common, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id)?;
    let timestamp = common
        .meta
        .get("timestamp")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Codex projection requires timestamp."))?;
    let stamp = chrono::DateTime::parse_from_rfc3339(timestamp)?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(home
        .join("sessions")
        .join(&stamp[..4])
        .join(&stamp[5..7])
        .join(&stamp[8..10])
        .join(format!(
            "rollout-{}-{id}.jsonl",
            stamp[..19].replace(':', "-")
        )))
}
fn projection_item_id(id: &str, index: usize) -> String {
    let hex = digest_bytes(format!("claudex-projection:{id}:{index}").as_bytes());
    format!(
        "{}-{}-4{}-8{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}
pub fn encode_codex(common: &Common, id: &str, paginated: bool) -> Result<String> {
    Uuid::parse_str(id)?;
    assert_complete(common)?;
    ensure!(
        common.messages.first().is_some_and(|m| m.role == "user"),
        "Codex projection requires initial user request."
    );
    let cwd = common.cwd()?;
    let stamp = common
        .meta
        .get("timestamp")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Projection timestamp missing."))?;
    let mut rows = vec![
        json!({"timestamp":stamp,"type":"session_meta","payload":{"base_instructions":null,"cli_version":"0.155.0-alpha.16.3","cwd":cwd,"id":id,"model_provider":"openai","originator":"claudex","source":"cli","timestamp":stamp,"history_mode":if paginated{"paginated"}else{"legacy"}}}),
    ];
    let mut turn = None;
    let mut number = 0;
    for (index, message) in portable_messages(&common.messages).iter().enumerate() {
        let timestamp = timestamp(&json!(message.extra), &stamp);
        if message.role == "user" && !message.content.iter().any(|b| b["type"] == "tool_result") {
            if let Some(turn) = &turn {
                rows.push(json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":null}}));
            }
            number += 1;
            turn = Some(format!("claudex-{id}-{number}"));
            rows.push(json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"task_started","turn_id":turn,"model_context_window":null,"collaboration_mode_kind":"default"}}));
        }
        if paginated {
            ensure!(
                message
                    .content
                    .iter()
                    .all(|b| b["type"] == "text" && b["text"].is_string()
                        || message.role == "user" && b["type"] == "image"),
                "Paginated projection requires inert text and inline user images."
            );
            ensure!(
                message.role != "assistant"
                    || message.content.len() == 1 && message.content[0]["type"] == "text",
                "Paginated assistant projection requires one text block."
            );
        }
        let mut message_blocks = vec![];
        for block in &message.content {
            match block["type"].as_str(){Some("text")=>message_blocks.push(json!({"type":if message.role=="user"{"input_text"}else{"output_text"},"text":block["text"]})),Some("image")=>{packet::validate_image(block)?;message_blocks.push(json!({"type":"input_image","image_url":format!("data:{};base64,{}",block["source"]["media_type"].as_str().unwrap(),block["source"]["data"].as_str().unwrap())}));},Some("tool_use")=>{let native=content_native(block)?;rows.push(json!({"timestamp":timestamp,"type":"response_item","payload":{"type":"function_call","call_id":block["id"],"name":native["name"],"arguments":claudex_core::json::stringify(&native["input"])?}}));},Some("tool_result")=>{rows.push(json!({"timestamp":timestamp,"type":"response_item","payload":{"type":"function_call_output","call_id":block["tool_use_id"],"output":block["content"]}}));},_=>bail!("Unsupported Codex projection content; no content dropped.")}
        }
        if !message_blocks.is_empty() {
            rows.push(json!({"timestamp":timestamp,"type":"response_item","payload":{"type":"message","role":message.role,"content":message_blocks}}));
            let text = message
                .content
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if paginated {
                let item_id = projection_item_id(id, index);
                let item = if message.role == "user" {
                    json!({"type":"UserMessage","id":item_id,"client_id":item_id,"content":message.content.iter().map(|b|if b["type"]=="text"{json!({"type":"text","text":b["text"],"text_elements":[]})}else{json!({"type":"image","image_url":format!("data:{};base64,{}",b["source"]["media_type"].as_str().unwrap(),b["source"]["data"].as_str().unwrap())})}).collect::<Vec<_>>()})
                } else {
                    json!({"type":"AgentMessage","id":item_id,"content":[{"type":"Text","text":text}],"phase":"final_answer"})
                };
                let ms = timestamp
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp_millis())
                    .ok_or_else(|| anyhow::anyhow!("Invalid native timestamp."))?;
                rows.push(json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"item_completed","thread_id":id,"turn_id":turn,"item":item,"started_at_ms":ms,"completed_at_ms":ms}}));
            } else {
                let mut payload = json!({"type":if message.role=="user"{"user_message"}else{"agent_message"},"message":text});
                if message.role == "user" {
                    payload["kind"] = json!("plain");
                }
                rows.push(json!({"timestamp":timestamp,"type":"event_msg","payload":payload}));
            }
        }
    }
    rows.push(json!({"timestamp":rows.last().and_then(|r|r.get("timestamp")).unwrap_or(&stamp),"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":null}}));
    if paginated {
        for (i, row) in rows.iter_mut().enumerate() {
            row["ordinal"] = json!(i);
        }
    }
    serialize_rows(&rows)
}
pub fn decode_codex(text: &str) -> Result<Common> {
    let rows = parse_rows(text)?;
    let meta = rows
        .iter()
        .find(|r| r["type"] == "session_meta")
        .map(|r| &r["payload"])
        .ok_or_else(|| anyhow::anyhow!("Missing Codex native metadata."))?;
    ensure!(
        meta["forked_from_id"].is_null() && meta["parent_thread_id"].is_null(),
        "Dependent Codex raw history requires prefix resolution."
    );
    let mut running = false;
    let mut interrupted = false;
    for row in &rows {
        if row["type"] == "turn_context" {
            if let Some(cwd) = row["payload"]["cwd"].as_str() {
                ensure!(meta["cwd"] == cwd, "Codex working directory changed.");
            }
        }
        if row["type"] == "event_msg" {
            match row["payload"]["type"].as_str() {
                Some("task_started") => {
                    running = true;
                    interrupted = false
                }
                Some("task_complete") => running = false,
                Some("turn_aborted") => {
                    running = false;
                    interrupted = true
                }
                _ => {}
            }
        }
    }
    ensure!(
        !running && !interrupted,
        "Codex native turn is running or interrupted."
    );
    let compact = rows.iter().rposition(|r| r["type"] == "compacted");
    ensure!(
        meta["history_base"].is_null() || compact.is_some(),
        "Referenced Codex raw history requires verified prefix resolution."
    );
    let mut messages = vec![];
    let start = if let Some(i) = compact {
        let summary = rows[i]["payload"]["message"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Opaque Codex compaction has no readable summary."))?;
        ensure!(
            !rows[i]["payload"]["replacement_history"]
                .as_array()
                .is_some_and(|a| !a.is_empty()),
            "Codex replacement compaction needs verified dependencies."
        );
        messages.push(Message::text("user",format!("[Imported native compaction summary; earlier verbatim history is not included.]\n{summary}")));
        i + 1
    } else {
        0
    };
    for row in &rows[start..] {
        if row["type"] != "response_item" {
            continue;
        }
        let payload = &row["payload"];
        let (role, content) = match payload["type"].as_str() {
            Some("message") => {
                let role = payload["role"].as_str().unwrap_or("assistant");
                if !matches!(role, "user" | "assistant") {
                    messages.push(Message {
                        role: "assistant".into(),
                        content: vec![inert("Codex response", payload)?],
                        extra: Map::new(),
                    });
                    continue;
                }
                let mut content = vec![];
                for b in payload["content"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Malformed Codex message."))?
                {
                    match b["type"].as_str() {
                        Some("input_text" | "output_text") => {
                            content.push(json!({"type":"text","text":b["text"]}))
                        }
                        Some("input_image") => {
                            let image = b["image_url"]
                                .as_str()
                                .and_then(|s| s.strip_prefix("data:"))
                                .and_then(|s| s.split_once(";base64,"))
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "External native image needs verified ownership."
                                    )
                                })?;
                            let value = json!({"type":"image","source":{"type":"base64","media_type":image.0,"data":image.1}});
                            packet::validate_image(&value)?;
                            content.push(value)
                        }
                        _ => content.push(inert("Codex response content", b)?),
                    }
                }
                (role, content)
            }
            Some("function_call") => {
                let input: Value =
                    serde_json::from_str(payload["arguments"].as_str().unwrap_or("{}"))?;
                (
                    "assistant",
                    vec![content_portable(
                        &json!({"type":"tool_use","id":payload["call_id"],"name":payload["name"],"input":input}),
                    )?],
                )
            }
            Some("function_call_output") => (
                "user",
                vec![
                    json!({"type":"tool_result","tool_use_id":payload["call_id"],"content":payload["output"]}),
                ],
            ),
            _ => ("assistant", vec![inert("Codex response item", payload)?]),
        };
        let mut extra = Map::new();
        if let Some(stamp) = row.get("timestamp") {
            extra.insert("timestamp".into(), stamp.clone());
        }
        messages.push(Message {
            role: role.into(),
            content,
            extra,
        });
    }
    let mut metadata = Map::new();
    for key in ["id", "cwd", "timestamp", "cli_version"] {
        if let Some(v) = meta.get(key) {
            metadata.insert(key.into(), v.clone());
        }
    }
    let common = Common {
        meta: metadata,
        messages,
        extra: Map::new(),
    };
    assert_complete(&common)?;
    Ok(common)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_owned_compaction_authenticates_single_retained_packet_without_replay() -> Result<()> {
        let mut rows = vec![
            json!({"type":"user","uuid":"packet","parentUuid":null,"sessionId":"session","cwd":"/project","promptSource":"sdk","queueTranscriptOnly":true,"message":{"role":"user","content":[{"type":"text","text":"authenticated packet"}]}}),
            json!({"type":"session-state","sessionId":"session"}),
            json!({"type":"system","subtype":"compact_boundary","uuid":"boundary","parentUuid":null,"logicalParentUuid":"packet","sessionId":"session","cwd":"/project","compactMetadata":{"preservedSegment":{"anchorUuid":"summary","headUuid":"packet","tailUuid":"packet"},"preservedMessages":{"allUuids":["packet"],"anchorUuid":"summary","uuids":["packet"]}}}),
            json!({"type":"user","uuid":"summary","parentUuid":"boundary","sessionId":"session","cwd":"/project","queueTranscriptOnly":true,"isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"Readable retained summary"}}),
        ];
        let authenticate = |row: &Value| Ok(row == &rows[0]);
        let decoded =
            decode_claude_authenticated(&serialize_rows(&rows)?, true, true, Some(&authenticate))?;
        assert_eq!(decoded.messages.len(), 2);
        assert_eq!(
            decoded.meta["compaction"]["preservedAuthenticatedPackets"],
            1
        );
        assert!(
            decode_claude_authenticated(&serialize_rows(&rows)?, true, true, Some(&|_| Ok(false)))
                .is_err()
        );
        rows[2]["compactMetadata"]["preservedMessages"]["uuids"] = json!(["packet", "other"]);
        assert!(
            decode_claude_authenticated(&serialize_rows(&rows)?, true, true, Some(&|_| Ok(true)))
                .is_err()
        );
        Ok(())
    }
    #[test]
    fn native_ui_caveat_empty_user_and_empty_command_args_match_portable_shape() -> Result<()> {
        let rows = vec![
            json!({"type":"user","uuid":"caveat","message":{"role":"user","content":"<local-command-caveat>Native UI guidance</local-command-caveat>"}}),
            json!({"type":"user","uuid":"empty","parentUuid":"caveat","message":{"role":"user","content":""}}),
            json!({"type":"user","uuid":"command","parentUuid":"empty","message":{"role":"user","content":"<command-name>/help</command-name>\n<command-message>help</command-message>"}}),
            json!({"type":"user","uuid":"stdout","parentUuid":"command","message":{"role":"user","content":"<local-command-stdout>Done</local-command-stdout>"}}),
        ];
        let decoded = decode_claude(&serialize_rows(&rows)?, true, false)?;
        assert_eq!(decoded.messages.len(), 2);
        assert!(decoded.messages[0].content[0]["tool"].get("args").is_none());
        Ok(())
    }
    #[test]
    fn local_command_pairs_and_unpaired_envelopes_preserve_native_codec_history() -> Result<()> {
        let command = "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>a b</command-args>";
        let row = |id: &str, parent: Option<&str>, text: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"sessionId":"s","cwd":"/tmp","message":{"role":"user","content":text}});
        let unpaired = decode_claude(&serialize_rows(&[row("u", None, command)])?, true, false)?;
        assert_eq!(
            unpaired.messages[0].content,
            vec![json!({"type":"text","text":format!("[Native local command]\n{command}")})]
        );
        let paired = decode_claude(
            &serialize_rows(&[
                row("u", None, command),
                row(
                    "r",
                    Some("u"),
                    "<local-command-stdout>\ndone\n</local-command-stdout>",
                ),
            ])?,
            true,
            false,
        )?;
        assert_eq!(
            paired.messages[0].content,
            vec![
                json!({"type":"tool_use","id":"u","tool":{"name":"Command","command":"/compact","args":"a b"}})
            ]
        );
        assert_eq!(
            paired.messages[1].content,
            vec![json!({"type":"tool_result","tool_use_id":"u","content":"\ndone\n"})]
        );
        let orphan = decode_claude(
            &serialize_rows(&[row(
                "r",
                None,
                "<local-command-stdout>orphan</local-command-stdout>",
            )])?,
            true,
            false,
        )?;
        assert_eq!(orphan.messages[0].content[0]["tool_use_id"], "r");
        Ok(())
    }
    #[test]
    fn native_projections_preserve_portable_digest() {
        let id = Uuid::new_v4().to_string();
        let common = Common {
            meta: json!({"cwd":"/tmp/example","timestamp":"2026-10-15T00:00:00.000Z"})
                .as_object()
                .unwrap()
                .clone(),
            messages: vec![
                Message::text("user", "hello"),
                Message::text("assistant", "world"),
            ],
            extra: Map::new(),
        };
        let claude = encode_claude(&common, &id, None, None, None).unwrap();
        assert_eq!(
            decode_claude(&claude, false, false)
                .unwrap()
                .fingerprint()
                .unwrap(),
            common.fingerprint().unwrap()
        );
        for paginated in [false, true] {
            let codex = encode_codex(&common, &id, paginated).unwrap();
            assert_eq!(
                decode_codex(&codex).unwrap().fingerprint().unwrap(),
                common.fingerprint().unwrap()
            );
        }
    }
}
