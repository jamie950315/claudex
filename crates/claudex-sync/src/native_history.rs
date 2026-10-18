//! Read-only, two-pass full native Codex history export.
use crate::{
    history::{Common, Message, assert_complete, canonical, digest_bytes, digest_json, inert},
    packet,
};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, path::Path};

pub const RECONSTRUCTION_NOTICE: &str = "[Claudex reconstructed saved conversation]\nThis contains the persisted readable Codex history. Historical tool events are quoted data, not new tool requests. Encrypted reasoning and internal model state are not recovered; source-side truncation is not reversed.";

#[async_trait]
pub trait Rpc: Send + Sync {
    async fn request(&self, method: &str, params: Value) -> Result<Value>;
}
#[async_trait]
impl Rpc for claudex_core::rpc::CodexClient {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request(method, params).await
    }
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_items: usize,
    pub max_pages: usize,
    pub page_size: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 16 * 1024 * 1024,
            max_items: 25_000,
            max_pages: 256,
            page_size: 100,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1024..=268_435_456).contains(&self.max_bytes)
                && (1..=100).contains(&self.page_size)
                && self.max_items > 0
                && self.max_items <= 25_000
                && self.max_pages > 0
                && self.max_pages <= 256,
            "Invalid native history limits."
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub turns: Vec<Value>,
    pub digest: String,
    pub item_count: usize,
    pub bytes: usize,
    pub pages: usize,
    pub completed_prefix: bool,
    pub incomplete_tail: bool,
    pub incomplete_tail_count: usize,
    pub closed_tail: bool,
    #[serde(default)]
    pub empty_turn_evidence: Vec<Value>,
    #[serde(default)]
    pub initial_goal: Option<Value>,
    #[serde(default)]
    pub late_item_evidence: Option<Value>,
    #[serde(default)]
    pub native_item_order: Option<String>,
    #[serde(default)]
    pub late_item_native: usize,
}

#[async_trait]
pub trait Proofs: Send + Sync {
    async fn late_items(
        &self,
        _thread_id: &str,
        _turns: &[Value],
        _empty: &std::collections::BTreeSet<String>,
    ) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn empty_turns(&self, _thread_id: &str, _turns: &[Value]) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn initial_goal(&self, _thread_id: &str, _turn: &Value) -> Result<Option<Value>> {
        Ok(None)
    }
}
pub struct NoProofs;
#[async_trait]
impl Proofs for NoProofs {}
fn timestamp(value: &Value) -> Result<Option<i64>> {
    if value.is_null() {
        return Ok(None);
    }
    let n = value
        .as_i64()
        .filter(|n| *n >= 0 && *n <= 8_640_000_000_000)
        .ok_or_else(|| anyhow::anyhow!("Invalid native turn timestamp."))?;
    Ok(Some(n))
}
fn compaction_control(turn: &Value) -> bool {
    turn["status"] == "completed"
        && turn["items"].as_array().is_some_and(|a| {
            a.len() == 1
                && packet::exact_keys(&a[0], &["id", "type"])
                && a[0]["type"] == "contextCompaction"
                && a[0]["id"].as_str().is_some_and(|s| !s.is_empty())
        })
}
fn response_boundary(turn: &Value) -> bool {
    turn["status"] == "completed" && !compaction_control(turn)
}
fn superseded_interrupted_turn(turn: &Value) -> bool {
    turn["status"] == "inProgress"
        && turn.get("error").is_some_and(Value::is_null)
        && turn.get("completedAt").is_some_and(Value::is_null)
        && turn.get("durationMs").is_none_or(Value::is_null)
        && turn["itemsView"] == "full"
        && turn["items"]
            .as_array()
            .is_some_and(|items| items.iter().all(|item| item["status"] != "inProgress"))
}
pub fn initial_delegation(item: &Value) -> bool {
    if item["type"] != "functionCallOutput"
        || item["namespace"] != "codex_app"
        || item["name"] != "create_thread"
        || !item["id"].as_str().is_some_and(|s| !s.is_empty())
    {
        return false;
    }
    let Some(output) = item["output"].as_str() else {
        return false;
    };
    let pattern=regex::Regex::new(r"(?s)^<codex_delegation>\n  <source_thread_id>([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})</source_thread_id>\n  <input>(.+)</input>\n</codex_delegation>$").unwrap();
    pattern
        .captures(output)
        .is_some_and(|c| !c[2].trim().is_empty())
}
fn validate_turn(
    turn: &Value,
    previous: Option<i64>,
    completed_prefix: bool,
    prior_request: bool,
    allow_delegation: bool,
    empty_control: bool,
) -> Result<Option<i64>> {
    ensure!(
        turn.is_object()
            && turn["id"].as_str().is_some_and(|s| !s.is_empty())
            && turn["items"].is_array(),
        "Malformed native turn."
    );
    let status = turn["status"].as_str().unwrap_or("");
    ensure!(
        status == "completed"
            || completed_prefix && matches!(status, "inProgress" | "failed" | "interrupted"),
        "Wait for a completed native turn."
    );
    ensure!(
        status != "completed" || turn["error"].is_null(),
        "Native completed turn has an error."
    );
    ensure!(
        turn["itemsView"] == "full",
        "Native API did not return full turn items."
    );
    let started = timestamp(&turn["startedAt"])?;
    let completed = timestamp(&turn["completedAt"])?;
    if let (Some(s), Some(c)) = (started, completed) {
        ensure!(c >= s, "Native completion precedes start.");
    }
    if let (Some(s), Some(p)) = (started, previous) {
        ensure!(s >= p, "Native turns are not ascending.");
    }
    let items = turn["items"].as_array().unwrap();
    if status == "completed" && items.is_empty() {
        ensure!(
            empty_control,
            "Completed native turn has no independently proven persisted items."
        );
        return Ok(started.or(previous));
    }
    let mut last_user = if allow_delegation && items.first().is_some_and(initial_delegation) {
        Some(0)
    } else {
        None
    };
    let mut last_agent = None;
    for (i, item) in items.iter().enumerate() {
        ensure!(
            item.is_object()
                && item["id"].as_str().is_some_and(|s| !s.is_empty())
                && item["type"].as_str().is_some_and(|s| !s.is_empty()),
            "Malformed native history item."
        );
        ensure!(
            status != "completed" || item["status"] != "inProgress",
            "Persisted item is still in progress."
        );
        if item["type"] == "userMessage" {
            last_user = Some(i);
        }
        if item["type"] == "agentMessage" {
            ensure!(
                last_user.is_some() || prior_request,
                "Assistant message precedes request context."
            );
            last_agent = Some(i);
        }
    }
    if prior_request && compaction_control(turn) {
        return Ok(started.or(previous));
    }
    if status == "completed" {
        let agent = last_agent
            .ok_or_else(|| anyhow::anyhow!("Completed native turn lacks final response."))?;
        // Quiet native turns may close with an intentionally empty final
        // message. Completion is not a rendered-text requirement.
        ensure!(
            (prior_request || last_user.is_some())
                && last_user.is_none_or(|u| agent > u)
                && items[agent]["phase"] != "commentary"
                && items[agent]["text"].is_string(),
            "Completed native turn lacks final assistant response."
        );
    }
    Ok(started.or(previous))
}
pub fn omit_display_screenshots(turns: &mut [Value]) {
    for turn in turns {
        if let Some(items) = turn["items"].as_array_mut() {
            for item in items {
                if item["type"] != "mcpToolCall" {
                    continue;
                }
                let pointer = "/result/_meta/codex~1toolSurface/screenshot";
                let Some(screenshot) = item.pointer_mut(pointer) else {
                    continue;
                };
                let Some(url) = screenshot["url"].as_str().map(str::to_owned) else {
                    continue;
                };
                let Some(mime) = url
                    .strip_prefix("data:")
                    .and_then(|s| s.split_once(";base64,"))
                    .map(|(m, _)| m.to_owned())
                    .filter(|m| {
                        matches!(
                            m.as_str(),
                            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                        )
                    })
                else {
                    continue;
                };
                screenshot["url"] = Value::Null;
                screenshot["omitted"] = json!({"reason":"display-only tool surface screenshot","mimeType":mime,"bytes":url.len(),"sha256":digest_bytes(url.as_bytes())});
            }
        }
    }
}
async fn read_pass(
    client: &dyn Rpc,
    id: &str,
    limits: &Limits,
    completed_prefix: bool,
    omit: bool,
    proofs: &dyn Proofs,
) -> Result<Snapshot> {
    let (mut turns, mut ids, mut cursors, mut evidence) =
        (vec![], HashSet::new(), HashSet::new(), vec![]);
    let (mut pages, mut bytes, mut items) = (0, 0, 0);
    let (mut previous, mut prior_request, mut cursor, mut goal) =
        (None, false, None::<String>, None);
    loop {
        ensure!(
            pages < limits.max_pages,
            "Native history page limit exceeded; no partial export returned."
        );
        let mut params = json!({"threadId":id,"limit":limits.page_size,"itemsView":"full","sortDirection":"asc"});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let mut response = client
            .request("thread/turns/list", params)
            .await
            .map_err(|_| anyhow::anyhow!("Native thread/turns/list failed; no export produced."))?;
        ensure!(
            response.is_object() && response["data"].is_array(),
            "Malformed native pagination response."
        );
        if omit {
            omit_display_screenshots(response["data"].as_array_mut().unwrap());
        }
        bytes += canonical(&response)?.len();
        ensure!(
            bytes <= limits.max_bytes,
            "Native history byte limit exceeded; no partial export returned."
        );
        pages += 1;
        let next = response
            .get("nextCursor")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("Invalid native cursor."))
            })
            .transpose()?;
        let data = response["data"].as_array().unwrap();
        ensure!(
            next.is_none() || !data.is_empty(),
            "Empty native page has continuation cursor."
        );
        let empty: Vec<_> = data
            .iter()
            .filter(|t| {
                t["status"] == "completed"
                    && t["error"].is_null()
                    && t["itemsView"] == "full"
                    && t["items"].as_array().is_some_and(Vec::is_empty)
            })
            .cloned()
            .collect();
        let mut controls = HashSet::new();
        if !empty.is_empty() {
            if let Some(proof) = proofs.empty_turns(id, &empty).await? {
                let turn_ids = proof["turnIds"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid empty-turn proof."))?;
                ensure!(
                    proof["sourceIdentity"].is_object()
                        && packet::hex_digest(&proof["evidenceDigest"])
                        && turn_ids.len() == empty.len()
                        && turn_ids.iter().zip(&empty).all(|(id, t)| *id == t["id"]),
                    "Invalid empty-turn provenance."
                );
                for value in turn_ids {
                    controls.insert(
                        value
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("Invalid empty-turn identity."))?
                            .to_owned(),
                    );
                }
                evidence.push(json!({"apiDigest":digest_json(&json!(empty))?,"proof":proof}));
            }
        }
        for turn in data {
            if turns.is_empty()
                && turn["status"] == "completed"
                && turn["items"].as_array().is_some_and(|a| {
                    a.iter().any(|i| i["type"] == "agentMessage")
                        && !a.iter().any(|i| i["type"] == "userMessage")
                        && !a.first().is_some_and(initial_delegation)
                })
            {
                goal = proofs.initial_goal(id, turn).await?;
                prior_request = goal.is_some();
            }
            let control = turn["id"].as_str().is_some_and(|id| controls.contains(id));
            previous = validate_turn(
                turn,
                previous,
                completed_prefix,
                prior_request,
                turns.is_empty(),
                control,
            )?;
            let native_id = turn["id"].as_str().unwrap();
            ensure!(
                ids.insert(native_id.to_owned()),
                "Duplicate native turn identity across pages."
            );
            let native_items = turn["items"].as_array().unwrap();
            items += native_items.len();
            ensure!(
                items <= limits.max_items,
                "Native history item limit exceeded."
            );
            prior_request |= native_items.iter().any(|i| i["type"] == "userMessage")
                || turns.is_empty() && native_items.first().is_some_and(initial_delegation);
            if !control {
                turns.push(turn.clone());
            }
        }
        match next {
            None => break,
            Some(next) => {
                ensure!(cursors.insert(next.clone()), "Native pagination cycle.");
                cursor = Some(next);
            }
        }
    }
    let last = turns.iter().rposition(response_boundary).ok_or_else(|| {
        anyhow::anyhow!("No completed persisted native history; wait for complete turn.")
    })?;
    ensure!(
        completed_prefix || last == turns.len() - 1,
        "Trailing native control needs completed continuation."
    );
    let tail = turns.len() - last - 1;
    let closed = tail > 0
        && turns[last + 1..]
            .iter()
            .all(|t| t["status"] != "inProgress");
    if completed_prefix && tail > 0 && !closed {
        // While a later tail turn is active, Codex thread/turns/list projects
        // earlier rollout turns that lacked a closing event as inProgress even
        // though the idle thread reports them as interrupted.
        for turn in &mut turns[..last] {
            if superseded_interrupted_turn(turn) {
                turn["status"] = json!("interrupted");
            }
        }
    }
    ensure!(
        !completed_prefix || !turns[..last].iter().any(|t| t["status"] == "inProgress"),
        "In-progress turn precedes completed prefix."
    );
    if completed_prefix {
        turns.truncate(last + 1);
    }
    let item_count = turns
        .iter()
        .map(|t| t["items"].as_array().unwrap().len())
        .sum();
    let digest = if let Some(goal) = &goal {
        digest_json(&json!({"turns":turns,"initialGoal":goal["request"]}))?
    } else {
        digest_json(&json!(turns))?
    };
    let empty = evidence
        .iter()
        .flat_map(|e| e["proof"]["turnIds"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let late_item_evidence = proofs.late_items(id, &turns, &empty).await?;
    let snapshot = Snapshot {
        turns,
        digest,
        item_count,
        bytes,
        pages,
        completed_prefix,
        incomplete_tail: tail > 0,
        incomplete_tail_count: tail,
        closed_tail: closed,
        empty_turn_evidence: evidence,
        initial_goal: goal,
        late_item_evidence,
        native_item_order: None,
        late_item_native: 0,
    };
    crate::native_order::entries(&snapshot)?;
    Ok(snapshot)
}
pub async fn read_stable(
    client: &dyn Rpc,
    id: &str,
    limits: &Limits,
    completed_prefix: bool,
    omit: bool,
    proofs: &dyn Proofs,
) -> Result<Snapshot> {
    limits.validate()?;
    ensure!(!id.is_empty(), "Native thread identity required.");
    let first = read_pass(client, id, limits, completed_prefix, omit, proofs).await?;
    let second = read_pass(client, id, limits, completed_prefix, omit, proofs).await?;
    ensure!(
        first.digest == second.digest
            && first.empty_turn_evidence == second.empty_turn_evidence
            && first.initial_goal == second.initial_goal
            && first.late_item_evidence == second.late_item_evidence,
        "Native source history changed between complete reads."
    );
    Ok(Snapshot {
        closed_tail: first.closed_tail && second.closed_tail,
        ..first
    })
}
fn auxiliary(value: &Value, excluded: &[&str]) -> Value {
    Value::Object(
        value
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
            .filter(|(k, v)| !excluded.contains(&k.as_str()) && !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}
fn image(input: &Value) -> Result<Value> {
    ensure!(
        input.get("fileId").is_none(),
        "External image requires verified asset ownership."
    );
    let uri = input["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Image requires verified inline bytes."))?;
    let (mime, data) = uri
        .strip_prefix("data:")
        .and_then(|s| s.split_once(";base64,"))
        .ok_or_else(|| anyhow::anyhow!("Image requires inline base64 bytes."))?;
    let bytes = STANDARD.decode(data)?;
    ensure!(
        !data.is_empty() && STANDARD.encode(bytes) == data && mime.starts_with("image/"),
        "Malformed inline image."
    );
    Ok(
        json!({"type":"image","source":{"type":"base64","media_type":mime.to_lowercase(),"data":data}}),
    )
}
fn user_content(item: &Value) -> Result<Vec<Value>> {
    let input = item["content"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Empty or malformed native user input."))?;
    let mut content = vec![];
    for block in input {
        ensure!(block.is_object(), "Malformed native user input block.");
        let mut extra;
        match block["type"].as_str() {
            Some("text") => {
                ensure!(block["text"].is_string(), "Malformed user text.");
                content.push(json!({"type":"text","text":block["text"]}));
                extra = auxiliary(block, &["type", "text"]);
                if extra["text_elements"].as_array().is_some_and(Vec::is_empty) {
                    extra.as_object_mut().unwrap().remove("text_elements");
                }
            }
            Some("image") => {
                content.push(image(block)?);
                extra = auxiliary(block, &["type", "url"]);
            }
            _ => {
                ensure!(
                    !["path", "url", "fileId", "file_id"]
                        .iter()
                        .any(|k| block.get(*k).is_some()),
                    "Unknown input references an external asset; nothing omitted."
                );
                content.push(inert("Codex user input", block)?);
                extra = json!({});
            }
        }
        if extra.as_object().is_some_and(|m| !m.is_empty()) {
            content.push(inert("Codex user input metadata", &extra)?);
        }
    }
    let extra = auxiliary(item, &["type", "id", "content"]);
    if extra.as_object().is_some_and(|m| !m.is_empty()) {
        content.push(inert("Codex user message metadata", &extra)?);
    }
    Ok(content)
}
pub fn convert(
    snapshot: &Snapshot,
    id: &str,
    cwd: &str,
    timestamp: Option<&str>,
    notice: bool,
) -> Result<Common> {
    ensure!(
        !id.is_empty() && Path::new(cwd).is_absolute(),
        "Native source identity and absolute working directory required."
    );
    ensure!(
        snapshot.turns.last().is_some_and(response_boundary),
        "Native snapshot does not end in completed response."
    );
    let mut messages = vec![];
    if let Some(goal) = &snapshot.initial_goal {
        let mut message = Message {
            role: "assistant".into(),
            content: vec![inert("Codex historical event", &goal["request"])?],
            extra: Map::new(),
        };
        if let Some(created) = goal["request"]["goal"]["createdAt"]
            .as_i64()
            .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
        {
            message.extra.insert(
                "timestamp".into(),
                json!(created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
        }
        messages.push(message);
    }
    for entry in crate::native_order::entries(snapshot)? {
        let turn = snapshot
            .turns
            .iter()
            .find(|t| t["id"] == entry.turn_id)
            .unwrap();
        let stamp = turn["startedAt"]
            .as_i64()
            .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .or_else(|| timestamp.map(str::to_owned));
        if let Some(item) = entry.item.as_ref() {
            let (role, content) = match item["type"].as_str() {
                Some("userMessage") => ("user", user_content(item)?),
                Some("agentMessage") => {
                    ensure!(item["text"].is_string(), "Malformed native assistant text.");
                    let mut content = vec![json!({"type":"text","text":item["text"]})];
                    let extra = auxiliary(item, &["type", "id", "text"]);
                    if extra.as_object().is_some_and(|m| !m.is_empty()) {
                        content.push(inert("Codex assistant message metadata", &extra)?);
                    }
                    ("assistant", content)
                }
                _ => ("assistant", vec![inert("Codex historical event", item)?]),
            };
            let mut message = Message {
                role: role.into(),
                content,
                extra: Map::new(),
            };
            if let Some(stamp) = &stamp {
                message.extra.insert("timestamp".into(), json!(stamp));
            }
            messages.push(message);
        } else if let Some(status) = entry.status {
            let mut message = Message {
                role: "assistant".into(),
                content: vec![inert("Codex closed turn status", &status)?],
                extra: Map::new(),
            };
            if let Some(stamp) = &stamp {
                message.extra.insert("timestamp".into(), json!(stamp));
            }
            messages.push(message);
        }
    }
    if notice {
        let first = messages
            .first_mut()
            .ok_or_else(|| anyhow::anyhow!("No native messages."))?;
        first
            .content
            .insert(0, json!({"type":"text","text":RECONSTRUCTION_NOTICE}));
    }
    let first_stamp = timestamp.map(str::to_owned).or_else(|| {
        snapshot
            .turns
            .first()
            .and_then(|t| t["startedAt"].as_i64())
            .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    });
    let mut meta = json!({"id":id,"cwd":cwd,"nativeHistory":{"source":"codex","method":"thread/turns/list","itemsView":"full","representation":"native-persisted-display-history","encryptedReasoningRecovered":false,"toolsReplayed":false,"notice":"Persisted native display history, including historical events as inert data. Encrypted reasoning and internal model context are not reconstructed.","digest":snapshot.digest,"turnCount":snapshot.turns.len(),"itemCount":snapshot.item_count}});
    if let Some(stamp) = first_stamp {
        meta["timestamp"] = json!(stamp);
    }
    if snapshot.initial_goal.is_some() {
        meta["nativeHistory"]["initialRequest"] = json!("verified-native-rollout-goal");
    }
    let common = Common {
        meta: meta.as_object().unwrap().clone(),
        messages,
        extra: Map::new(),
    };
    assert_complete(&common)?;
    Ok(common)
}

/// Fields Codex later added, always null, to item types it already exported.
/// Checkpoints saved before then serialize those items without them.
/// subAgentActivity gained model and reasoningEffort in Codex 0.163.
const VENDOR_ADDED_NULL_FIELDS: &[(&str, &[&str])] =
    &[("subAgentActivity", &["model", "reasoningEffort"])];

/// The item without the vendor-added fields it carries as null, if any.
pub(crate) fn without_vendor_added_null_fields(item: &Value) -> Option<Value> {
    let (_, fields) = VENDOR_ADDED_NULL_FIELDS
        .iter()
        .find(|(kind, _)| item["type"] == *kind)?;
    let map = item.as_object()?;
    fields
        .iter()
        .any(|field| map.get(*field).is_some_and(Value::is_null))
        .then(|| {
            Value::Object(
                map.iter()
                    .filter(|(key, value)| !(fields.contains(&key.as_str()) && value.is_null()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        })
}

pub(crate) fn without_vendor_added_nulls(snapshot: &Snapshot) -> Option<Snapshot> {
    let mut selected = snapshot.clone();
    let mut changed = false;
    for item in selected
        .turns
        .iter_mut()
        .filter_map(|turn| turn["items"].as_array_mut())
        .flatten()
    {
        if let Some(stripped) = without_vendor_added_null_fields(item) {
            *item = stripped;
            changed = true;
        }
    }
    changed.then_some(selected)
}

/// A serialization alternative is usable only when the entire existing saved
/// canonical prefix authenticates its exact bytes. It never selects a new
/// checkpoint. Without one, the ordinary conversion is returned and the caller
/// accepts it when the saved dialogue matches.
pub fn convert_checkpoint(
    snapshot: &Snapshot,
    id: &str,
    cwd: &str,
    checkpoint: &crate::desktop::Checkpoint,
) -> Result<Common> {
    let original = convert(snapshot, id, cwd, None, true)?;
    if checkpoint.count == 0 || checkpoint.contains(&original)? {
        return Ok(original);
    }
    if let Some(candidate) = goal_alternative(snapshot, id, cwd, checkpoint)? {
        return Ok(candidate);
    }
    if let Some(selected) = without_vendor_added_nulls(snapshot) {
        let candidate = convert(&selected, id, cwd, None, true)?;
        if checkpoint.contains(&candidate)? {
            return Ok(candidate);
        }
        if let Some(candidate) = goal_alternative(&selected, id, cwd, checkpoint)? {
            return Ok(candidate);
        }
    }
    Ok(original)
}

fn goal_alternative(
    snapshot: &Snapshot,
    id: &str,
    cwd: &str,
    checkpoint: &crate::desktop::Checkpoint,
) -> Result<Option<Common>> {
    let Some(goal) = &snapshot.initial_goal else {
        return Ok(None);
    };
    let Some(alternatives) = goal["prefixHashAlternatives"]
        .as_array()
        .filter(|a| a.len() <= 2 && a.iter().all(packet::hex_digest))
    else {
        return Ok(None);
    };
    for alternative in alternatives {
        let mut selected = snapshot.clone();
        selected.initial_goal.as_mut().unwrap()["request"]["prefixHash"] = alternative.clone();
        let candidate = convert(&selected, id, cwd, None, true)?;
        if checkpoint.contains(&candidate)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// Raw arrival proof is only needed to recover an existing checkpoint whose
/// complete prefix the ordinary full API export no longer preserves. First
/// enrollment and exact normal matches retain their normal export contract.
pub fn needs_late_item_proof(
    verified: bool,
    checkpoint: &crate::desktop::Checkpoint,
    common: &Common,
) -> Result<bool> {
    Ok(verified && checkpoint.count > 0 && !checkpoint.contains_dialogue(common)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct QuietTurnRpc(Value);
    #[async_trait]
    impl Rpc for QuietTurnRpc {
        async fn request(&self, method: &str, _: Value) -> Result<Value> {
            assert_eq!(method, "thread/turns/list");
            Ok(json!({"data":[self.0.clone()],"nextCursor":null}))
        }
    }
    #[tokio::test]
    async fn completed_quiet_turn_retains_empty_final_and_all_activity() -> Result<()> {
        let turn = json!({"id":"quiet","status":"completed","error":null,
            "itemsView":"full","startedAt":100,"completedAt":101,"items":[
                {"id":"request","type":"userMessage","content":[{"type":"text","text":"Report only when attention is needed."}]},
                {"id":"inspection","type":"commandExecution","status":"completed","aggregatedOutput":"Progressing normally."},
                {"id":"final","type":"agentMessage","phase":"final_answer","text":""}]});
        let snapshot = read_stable(&QuietTurnRpc(turn.clone()), "thread", &Limits::default(), true, false, &NoProofs).await?;
        assert_eq!(snapshot.turns, vec![turn.clone()]);
        assert_eq!(snapshot.item_count, 3);
        assert!(!snapshot.incomplete_tail);
        let common = convert(&snapshot, "thread", "/tmp", None, false)?;
        assert_eq!(common.messages.len(), 3);
        assert_eq!(common.messages[2].content[0], json!({"type":"text","text":""}));
        assert!(common.messages[1].content[0]["text"].as_str().unwrap().contains("Progressing normally."));
        assert!(common.messages[2].content[1]["text"].as_str().unwrap().contains("final_answer"));
        for (pointer, replacement) in [
            ("/items/2/text", Value::Null),
            ("/items/2/phase", json!("commentary")),
            ("/items/1/status", json!("inProgress")),
            ("/error", json!({"message":"Native failure"})),
        ] {
            let mut invalid = turn.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(read_stable(&QuietTurnRpc(invalid), "thread", &Limits::default(), true, false, &NoProofs).await.is_err());
        }
        let mut active = turn;
        active["status"] = json!("inProgress");
        active["completedAt"] = Value::Null;
        assert!(read_stable(&QuietTurnRpc(active), "thread", &Limits::default(), true, false, &NoProofs).await.is_err());
        Ok(())
    }
    #[test]
    fn arrival_proof_is_requested_only_after_the_whole_verified_prefix_mismatches() {
        let original = Common {
            meta: Map::new(),
            messages: vec![
                crate::history::Message::text("user", "Ask"),
                crate::history::Message::text("assistant", "Done"),
            ],
            extra: Map::new(),
        };
        let checkpoint = crate::desktop::Checkpoint::of(&original).unwrap();
        assert!(!needs_late_item_proof(true, &checkpoint, &original).unwrap());
        let mut appended = original.clone();
        appended
            .messages
            .push(crate::history::Message::text("user", "Continue"));
        assert!(!needs_late_item_proof(true, &checkpoint, &appended).unwrap());
        let mut changed = original.clone();
        changed.messages[0] = crate::history::Message::text("user", "Changed");
        assert!(needs_late_item_proof(true, &checkpoint, &changed).unwrap());
        assert!(!needs_late_item_proof(false, &checkpoint, &changed).unwrap());
        assert!(
            needs_late_item_proof(
                true,
                &checkpoint,
                &Common {
                    messages: vec![],
                    ..original.clone()
                }
            )
            .unwrap()
        );
        assert!(
            !needs_late_item_proof(true, &crate::desktop::Checkpoint::empty(), &changed).unwrap()
        );
    }
    #[test]
    fn initial_goal_serialization_is_selected_only_by_the_whole_saved_checkpoint() {
        let mut snapshot = Snapshot {
            turns: vec![
                json!({"id":"t","status":"completed","items":[{"id":"a","type":"agentMessage","text":"done"}]}),
            ],
            digest: "d".into(),
            item_count: 1,
            bytes: 0,
            pages: 1,
            completed_prefix: false,
            incomplete_tail: false,
            incomplete_tail_count: 0,
            closed_tail: false,
            empty_turn_evidence: vec![],
            late_item_evidence: None,
            native_item_order: None,
            late_item_native: 0,
            initial_goal: Some(
                json!({"request":{"type":"nativeInitialGoalRequest","prefixHash":"a".repeat(64)},"prefixHashAlternatives":["b".repeat(64)]}),
            ),
        };
        let ordinary = convert(&snapshot, "id", "/tmp", None, true).unwrap();
        snapshot.initial_goal.as_mut().unwrap()["request"]["prefixHash"] = json!("b".repeat(64));
        let previous = convert(&snapshot, "id", "/tmp", None, true).unwrap();
        let checkpoint = crate::desktop::Checkpoint::of(&previous).unwrap();
        snapshot.initial_goal.as_mut().unwrap()["request"]["prefixHash"] = json!("a".repeat(64));
        assert_eq!(
            convert_checkpoint(&snapshot, "id", "/tmp", &checkpoint).unwrap(),
            previous
        );
        let different = crate::desktop::Checkpoint {
            count: checkpoint.count,
            digest: Some("c".repeat(64)),
            dialogue: None,
        };
        assert_eq!(
            convert_checkpoint(&snapshot, "id", "/tmp", &different).unwrap(),
            ordinary
        );
    }
    #[test]
    fn unknown_native_items_are_inert_and_external_assets_fail() {
        let snapshot = Snapshot {
            turns: vec![
                json!({"id":"t","status":"completed","items":[{"id":"u","type":"userMessage","content":[{"type":"future","body":"keep"}]},{"id":"x","type":"futureEvent","data":{"danger":"command"}},{"id":"a","type":"agentMessage","text":"done"}]}),
            ],
            digest: "d".into(),
            item_count: 3,
            bytes: 0,
            pages: 1,
            completed_prefix: false,
            incomplete_tail: false,
            incomplete_tail_count: 0,
            closed_tail: false,
            empty_turn_evidence: vec![],
            initial_goal: None,
            late_item_evidence: None,
            native_item_order: None,
            late_item_native: 0,
        };
        let common = convert(&snapshot, "id", "/tmp", None, true).unwrap();
        assert!(
            common.messages[1].content[0]["text"]
                .as_str()
                .unwrap()
                .contains("futureEvent")
        );
        assert!(
            user_content(
                &json!({"type":"userMessage","content":[{"type":"newAttachment","path":"/secret"}]})
            )
            .is_err()
        );
    }
    #[test]
    fn closed_status_keeps_the_native_turn_timestamp() {
        let snapshot = Snapshot {
            turns: vec![
                json!({"id":"interrupted","status":"interrupted","startedAt":100,"items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"Ask"}]}]}),
                json!({"id":"completed","status":"completed","startedAt":200,"items":[{"id":"a","type":"agentMessage","text":"Done"}]}),
            ],
            digest: "d".into(),
            item_count: 2,
            bytes: 0,
            pages: 1,
            completed_prefix: true,
            incomplete_tail: false,
            incomplete_tail_count: 0,
            closed_tail: false,
            empty_turn_evidence: vec![],
            initial_goal: None,
            late_item_evidence: None,
            native_item_order: None,
            late_item_native: 0,
        };
        let common = convert(&snapshot, "id", "/tmp", None, true).unwrap();
        assert_eq!(
            common.messages[1].extra["timestamp"],
            "1970-01-01T00:01:40.000Z"
        );
        assert_eq!(
            common.messages[0].extra["timestamp"],
            common.messages[1].extra["timestamp"]
        );
    }
    struct TurnsRpc(Vec<Value>);
    #[async_trait]
    impl Rpc for TurnsRpc {
        async fn request(&self, method: &str, _: Value) -> Result<Value> {
            assert_eq!(method, "thread/turns/list");
            Ok(json!({"data":self.0.clone(),"nextCursor":null}))
        }
    }
    #[tokio::test]
    async fn vendor_added_null_fields_keep_checkpoints_saved_without_them() -> Result<()> {
        let turn = |activity: Value| {
            json!({"id":"turn","status":"completed","error":null,"itemsView":"full","startedAt":100,"completedAt":105,"durationMs":5000,
                "items":[{"id":"u1","type":"userMessage","content":[{"type":"text","text":"Review"}]},activity,
                    {"id":"a1","type":"agentMessage","phase":"final_answer","text":"Done"}]})
        };
        let read = |activity: Value| async move {
            read_stable(&TurnsRpc(vec![turn(activity)]), "thread", &Limits::default(), true, false, &NoProofs).await
        };
        let before = json!({"id":"call","type":"subAgentActivity","kind":"started","agentThreadId":"child","agentPath":"/root/review"});
        let mut after = before.clone();
        after["model"] = Value::Null;
        after["reasoningEffort"] = Value::Null;
        let saved = convert(&read(before.clone()).await?, "thread", "/tmp", None, true)?;
        let checkpoint = crate::desktop::Checkpoint::of(&saved)?;
        let current = read(after.clone()).await?;
        assert!(!checkpoint.contains(&convert(&current, "thread", "/tmp", None, true)?)?);
        assert_eq!(
            convert_checkpoint(&current, "thread", "/tmp", &checkpoint)?.messages,
            saved.messages
        );
        // New enrollments and checkpoints made with the fields keep them.
        let with_fields = convert(&current, "thread", "/tmp", None, true)?;
        assert_eq!(
            convert_checkpoint(&current, "thread", "/tmp", &crate::desktop::Checkpoint::empty())?,
            with_fields
        );
        assert_eq!(
            convert_checkpoint(&current, "thread", "/tmp", &crate::desktop::Checkpoint::of(&with_fields)?)?,
            with_fields
        );
        // A non-null value is real content and is never dropped.
        let mut model = after;
        model["model"] = json!("gpt-6");
        let current = read(model).await?;
        assert!(!checkpoint.contains(&convert_checkpoint(&current, "thread", "/tmp", &checkpoint)?)?);
        Ok(())
    }
    #[tokio::test]
    async fn superseded_unclosed_turn_matches_idle_interrupted_export_during_active_tail()
    -> Result<()> {
        let earlier_idle = json!({"id":"earlier","status":"interrupted","error":null,"itemsView":"full","startedAt":100,"completedAt":null,"durationMs":null,
            "items":[{"id":"u1","type":"userMessage","content":[{"type":"text","text":"First"}]},{"id":"cmd","type":"commandExecution","status":"completed","aggregatedOutput":"ok"}]});
        let completed = json!({"id":"completed","status":"completed","error":null,"itemsView":"full","startedAt":200,"completedAt":205,"durationMs":5000,
            "items":[{"id":"u2","type":"userMessage","content":[{"type":"text","text":"Second"}]},{"id":"a2","type":"agentMessage","phase":"final_answer","text":"Done"}]});
        let active_tail = json!({"id":"tail","status":"inProgress","error":null,"itemsView":"full","startedAt":300,"completedAt":null,"durationMs":null,
            "items":[{"id":"u3","type":"userMessage","content":[{"type":"text","text":"Third"}]}]});
        let mut earlier_active = earlier_idle.clone();
        earlier_active["status"] = json!("inProgress");
        let idle = read_stable(
            &TurnsRpc(vec![earlier_idle.clone(), completed.clone()]),
            "thread",
            &Limits::default(),
            true,
            false,
            &NoProofs,
        )
        .await?;
        let active = read_stable(
            &TurnsRpc(vec![
                earlier_active.clone(),
                completed.clone(),
                active_tail.clone(),
            ]),
            "thread",
            &Limits::default(),
            true,
            false,
            &NoProofs,
        )
        .await?;
        assert_eq!(active.turns, idle.turns);
        assert_eq!(active.digest, idle.digest);
        assert!(active.incomplete_tail);
        assert!(!active.closed_tail);
        assert_eq!(
            convert(&active, "thread", "/tmp", None, true)?,
            convert(&idle, "thread", "/tmp", None, true)?
        );
        assert!(
            read_stable(
                &TurnsRpc(vec![earlier_active.clone(), completed.clone()]),
                "thread",
                &Limits::default(),
                true,
                false,
                &NoProofs,
            )
            .await
            .is_err()
        );
        for (pointer, replacement) in [
            ("/items/1/status", json!("inProgress")),
            ("/error", json!({"message":"failure"})),
            ("/completedAt", json!(101)),
            ("/durationMs", json!(1000)),
        ] {
            let mut invalid = earlier_active.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                read_stable(
                    &TurnsRpc(vec![invalid, completed.clone(), active_tail.clone()]),
                    "thread",
                    &Limits::default(),
                    true,
                    false,
                    &NoProofs,
                )
                .await
                .is_err()
            );
        }
        Ok(())
    }
}
