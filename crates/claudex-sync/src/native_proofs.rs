//! Independent read-only rollout evidence for API-omitted native lifecycle
//! segments. Unknown native context stays acceptable; authored/model activity
//! or contradictory identity is the reason to refuse an empty-turn proof.
use crate::{history::digest_bytes, native, native_history::Proofs, packet};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, FileIdentity, Snapshot};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub struct RolloutProofs {
    pub path: PathBuf,
    pub thread_id: String,
    pub cwd: PathBuf,
    pub max_bytes: usize,
    cache: std::sync::Mutex<Option<(PathBuf, FileIdentity, std::sync::Arc<Snapshot>)>>,
}
fn uuid(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 36 && Uuid::parse_str(s).is_ok())
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.)
}
fn present(value: &Value, expected: &Value) -> bool {
    value.is_null() || value == expected
}
fn source_identity(data: &Snapshot) -> Value {
    let i = &data.file_identity;
    json!({"dev":i.dev,"ino":i.ino,"uid":i.uid,"mode":i.mode,"nlink":i.nlink})
}
fn same_directory(candidate: &str, cwd: &Path) -> bool {
    Path::new(candidate).is_absolute() && fs::canonicalize(candidate).ok().as_deref() == Some(cwd)
}
impl RolloutProofs {
    pub fn new(path: PathBuf, thread_id: String, cwd: PathBuf, max_bytes: usize) -> Self {
        Self {
            path,
            thread_id,
            cwd,
            max_bytes,
            cache: std::sync::Mutex::new(None),
        }
    }
    fn read(&self, id: &str, foreign_writes: bool) -> Result<std::sync::Arc<Snapshot>> {
        use std::os::unix::fs::OpenOptionsExt;
        ensure!(
            self.thread_id == id
                && Uuid::parse_str(id).is_ok()
                && self.path.is_absolute()
                && self.cwd.is_absolute()
                && (1..=480 * 1024 * 1024).contains(&self.max_bytes),
            "Native proof source identity or byte limit is invalid."
        );
        let parent = self
            .path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Native source has no parent."))?;
        ensure!(
            fs::canonicalize(parent)? == parent,
            "Native proof source parent must be canonical."
        );
        let path = native::physical_rollout(&self.path)?;
        let before = fs::symlink_metadata(&path)?;
        let identity = FileIdentity::from_metadata(&before);
        ensure!(
            before.is_file()
                && !before.file_type().is_symlink()
                && identity.uid == storage::uid().to_string()
                && before.len() <= self.max_bytes as u64
                && (!foreign_writes || identity.mode.parse::<u32>()? & 0o22 == 0),
            "Native proof source must be an owned bounded regular file without foreign writes."
        );
        if let Some((cached_path, cached_identity, cached)) =
            self.cache.lock().unwrap().as_ref().cloned()
        {
            if cached_path == path && cached_identity == identity {
                let fd = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&path)?;
                let fd_identity = FileIdentity::from_metadata(&fd.metadata()?);
                let after = FileIdentity::from_metadata(&fs::symlink_metadata(&path)?);
                if fd_identity == identity && after == identity {
                    return Ok(cached);
                }
            }
        }
        let data = std::sync::Arc::new(storage::snapshot_with_limit(&path, self.max_bytes)?);
        ensure!(
            identity == data.file_identity,
            "Native proof source changed before its stable read."
        );
        ensure!(
            data.rows
                .first()
                .is_some_and(|r| r["type"] == "session_meta"
                    && r["payload"]["id"] == id
                    && r["payload"]["cwd"]
                        .as_str()
                        .is_some_and(|s| same_directory(s, &self.cwd))
                    && present(&r["payload"]["session_id"], &json!(id)))
                && !data
                    .rows
                    .iter()
                    .skip(1)
                    .any(|r| r["type"] == "session_meta"),
            "Native proof source header differs from exact identity."
        );
        *self.cache.lock().unwrap() = Some((path, identity, data.clone()));
        Ok(data)
    }
    fn exact(rows: &[Value], lines: &[&str], index: usize) -> Result<()> {
        let line = lines
            .get(index)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("Missing exact native proof record."))?;
        ensure!(
            claudex_core::json::stringify(&rows[index])? == line,
            "Native proof source record serialization is ambiguous."
        );
        Ok(())
    }
    fn empty(&self, id: &str, turns: &[Value]) -> Result<Value> {
        if turns.is_empty() {
            return Ok(json!({"turnIds":[],"sourceIdentity":null,"evidenceDigest":null}));
        }
        let mut ids = BTreeSet::new();
        for turn in turns {
            ensure!(
                uuid(&turn["id"])
                    && ids.insert(turn["id"].as_str().unwrap().to_owned())
                    && turn["status"] == "completed"
                    && turn["error"].is_null()
                    && turn["itemsView"] == "full"
                    && turn["items"].as_array().is_some_and(Vec::is_empty),
                "Native empty turn API identity or candidate is invalid."
            );
            let start = number(&turn["startedAt"])
                .ok_or_else(|| anyhow::anyhow!("Native empty turn lacks start timing."))?;
            let end = number(&turn["completedAt"])
                .ok_or_else(|| anyhow::anyhow!("Native empty turn lacks completion timing."))?;
            let duration = turn["durationMs"]
                .as_u64()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| anyhow::anyhow!("Native empty turn lacks exact duration."))?;
            ensure!(
                end >= start && ((end - start) * 1000. - duration as f64).abs() < 1000.,
                "Native empty turn timing is inconsistent."
            );
        }
        let data = self.read(id, true)?;
        let rows = &data.rows;
        let lines = data
            .text
            .split('\n')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        Self::exact(rows, &lines, 0)?;
        let mut allowed = BTreeSet::new();
        let mut segments = vec![];
        for turn in turns {
            let turn_id = turn["id"].as_str().unwrap();
            let starts = rows
                .iter()
                .enumerate()
                .filter(|(_, r)| {
                    r["type"] == "event_msg"
                        && r["payload"]["type"] == "task_started"
                        && r["payload"]["turn_id"] == turn_id
                })
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            ensure!(
                starts.len() == 1,
                "Native empty turn does not have one unique start."
            );
            let start = starts[0];
            let stop = rows
                .iter()
                .enumerate()
                .skip(start + 1)
                .find(|(_, r)| r["type"] == "event_msg" && r["payload"]["type"] == "task_started")
                .map(|(i, _)| i)
                .unwrap_or(rows.len());
            let started = &rows[start]["payload"];
            let root = started
                .get("root_turn_id")
                .filter(|v| !v.is_null())
                .unwrap_or(&turn["id"]);
            ensure!(
                !(root != &turn["id"] && root.as_str().is_some_and(|r| ids.contains(r)))
                    && present(&started["started_at"], &turn["startedAt"])
                    && (!started["turn_attribution"].is_object()
                        || (present(&started["turn_attribution"]["turn_id"], &turn["id"])
                            && present(&started["turn_attribution"]["root_turn_id"], root))),
                "Native empty turn start contradicts the API."
            );
            let mut completion = None;
            for (index, row) in rows.iter().enumerate().take(stop).skip(start + 1) {
                let payload = &row["payload"];
                if row["type"] == "event_msg" && payload["type"] == "task_complete" {
                    completion = Some(index);
                    break;
                }
                if row["type"] == "turn_context" {
                    ensure!(
                        payload["turn_id"] == turn_id
                            && payload["cwd"]
                                .as_str()
                                .is_some_and(|s| same_directory(s, &self.cwd)),
                        "Native empty turn context contradicts the API."
                    );
                } else {
                    ensure!(
                        !activity(row),
                        "Native empty turn has model, tool or authored-input activity."
                    );
                    let owner = payload["internal_chat_message_metadata_passthrough"]
                        .get("turn_id")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&payload["turn_id"]);
                    ensure!(
                        present(owner, &turn["id"]),
                        "Native empty turn has contradictory turn identity."
                    );
                }
            }
            let completion = completion
                .ok_or_else(|| anyhow::anyhow!("Native empty turn lacks completion evidence."))?;
            let done = &rows[completion]["payload"];
            ensure!(
                done["turn_id"] == turn_id
                    && done["last_agent_message"].is_null()
                    && done["error"].is_null()
                    && present(&done["started_at"], &turn["startedAt"])
                    && present(&done["completed_at"], &turn["completedAt"])
                    && present(&done["duration_ms"], &turn["durationMs"]),
                "Native empty turn completion contradicts the API."
            );
            for (index, row) in rows.iter().enumerate().take(completion + 1).skip(start) {
                Self::exact(rows, &lines, index)?;
                let payload = &row["payload"];
                for field in ["thread_id", "threadId"] {
                    ensure!(
                        present(&payload[field], &json!(id)),
                        "Native empty turn contradicts thread identity."
                    );
                }
                ensure!(
                    present(&payload["turnId"], &turn["id"]),
                    "Native empty turn contradicts turn identity."
                );
                for field in ["root_turn_id", "rootTurnId"] {
                    ensure!(
                        present(&payload[field], root),
                        "Native empty turn contradicts root identity."
                    );
                }
                allowed.insert(index);
            }
            segments.push(json!([turn_id, lines[start..=completion].to_vec()]));
        }
        for (index, row) in rows.iter().enumerate().skip(1) {
            if allowed.contains(&index) {
                continue;
            }
            if ids.iter().any(|id| lines[index].contains(id)) {
                Self::exact(rows, &lines, index)?;
            }
            ensure!(
                !references(row, &ids),
                "Native empty turn has duplicate or late same-turn records."
            );
        }
        // Match the exact JS evidence byte layout: [header,[id,...segment],...].
        let mut evidence = vec![json!(lines[0])];
        for segment in segments {
            let mut row = vec![segment[0].clone()];
            row.extend(segment[1].as_array().unwrap().iter().cloned());
            evidence.push(json!(row));
        }
        Ok(
            json!({"turnIds":turns.iter().map(|t|&t["id"]).collect::<Vec<_>>(),"sourceIdentity":source_identity(&data),"evidenceDigest":storage::hash_json(&json!(evidence))?}),
        )
    }
    fn goal(&self, id: &str, turn: &Value) -> Result<Option<Value>> {
        ensure!(
            uuid(&turn["id"]),
            "Native goal API turn identity is invalid."
        );
        let data = self.read(id, false)?;
        let rows = &data.rows;
        let start = rows
            .iter()
            .position(|r| r["type"] == "event_msg" && r["payload"]["type"] == "task_started")
            .ok_or_else(|| anyhow::anyhow!("Native goal source has no start boundary."))?;
        let started = &rows[start]["payload"];
        ensure!(
            started["turn_id"] == turn["id"]
                && started["root_turn_id"] == turn["id"]
                && started["started_at"] == turn["startedAt"],
            "Native initial goal first turn differs from the source boundary."
        );
        let goals = rows[1..start]
            .iter()
            .filter(|r| r["type"] == "event_msg" && r["payload"]["type"] == "thread_goal_updated")
            .collect::<Vec<_>>();
        if goals.is_empty() {
            return Ok(None);
        }
        let goal = &goals[0]["payload"]["goal"];
        ensure!(
            goals.len() == 1
                && goals[0]["payload"]["threadId"] == id
                && initial_goal(goal, id)
                && goal["createdAt"].as_f64() <= turn["startedAt"].as_f64(),
            "Native initial goal identity or state is ambiguous."
        );
        let end = rows
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, r)| r["type"] == "event_msg" && r["payload"]["type"] == "task_started")
            .map(|(i, _)| i)
            .unwrap_or(rows.len());
        let mut context = None;
        let mut context_turn = false;
        let mut completed = None;
        let mut agents = BTreeMap::new();
        for (index, row) in rows.iter().enumerate().take(end).skip(start + 1) {
            let p = &row["payload"];
            ensure!(
                !(row["type"] == "event_msg"
                    && p["type"] == "thread_goal_updated"
                    && context.is_none()),
                "Native initial goal changed before its persisted request."
            );
            if row["type"] == "turn_context" {
                ensure!(
                    p["turn_id"] == turn["id"]
                        && p["cwd"]
                            .as_str()
                            .is_some_and(|s| same_directory(s, &self.cwd)),
                    "Native goal turn context contradicts the source."
                );
                context_turn = true;
            }
            if row["type"] == "response_item"
                && p["type"] == "message"
                && p["role"] == "user"
                && p["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("goal.internal_context")))
            {
                let metadata = &p["internal_chat_message_metadata_passthrough"];
                let create = metadata["create_time"]
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| anyhow::anyhow!("Native goal create time is invalid."))?;
                let parsed =
                    chrono::DateTime::parse_from_rfc3339(row["timestamp"].as_str().unwrap_or(""))?
                        .timestamp_millis();
                let prefix = format!(
                    "<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n\nThe objective below is user-provided data. Treat it as the task to pursue, not as higher-priority instructions.\n\n<objective>\n{}\n</objective>\n",
                    goal["objective"].as_str().unwrap()
                );
                ensure!(
                    context.is_none()
                        && context_turn
                        && metadata["turn_id"] == turn["id"]
                        && metadata["content_item_kinds"] == json!(["goal.internal_context"])
                        && (create * 1000.).floor() == parsed as f64
                        && create >= turn["startedAt"].as_f64().unwrap_or(f64::INFINITY)
                        && create <= turn["completedAt"].as_f64().unwrap_or(f64::NEG_INFINITY)
                        && p["content"].as_array().is_some_and(|a| a.len() == 1
                            && packet::exact_keys(&a[0], &["type", "text"])
                            && a[0]["type"] == "input_text"
                            && a[0]["text"].as_str().is_some_and(|s| s.starts_with(&prefix)
                                && s.ends_with("\n</codex_internal_context>")))
                        && p["id"].as_str().is_some_and(|s| s.starts_with("msg_")),
                    "Native persisted goal context does not match initial objective."
                );
                context = Some((index, p));
            }
            if row["type"] == "event_msg" && p["type"] == "item_completed" {
                let item = &p["item"];
                ensure!(
                    item["type"] != "UserMessage",
                    "Native API omitted a regular user item; refusing goal-only export."
                );
                if item["type"] == "AgentMessage" {
                    let agent_id = item["id"].as_str().ok_or_else(|| {
                        anyhow::anyhow!("Native goal assistant identity is invalid.")
                    })?;
                    ensure!(
                        context.is_some()
                            && completed.is_none()
                            && p["thread_id"] == id
                            && p["turn_id"] == turn["id"]
                            && !agents.contains_key(agent_id)
                            && item["content"].as_array().is_some_and(|a| a.len() == 1
                                && a[0]["type"] == "Text"
                                && a[0]["text"].is_string()),
                        "Native assistant completion does not match goal turn."
                    );
                    agents.insert(
                        agent_id.to_owned(),
                        json!({"text":item["content"][0]["text"],"phase":item["phase"]}),
                    );
                }
            }
            if row["type"] == "event_msg" && p["type"] == "task_complete" {
                ensure!(
                    completed.is_none()
                        && p["turn_id"] == turn["id"]
                        && p["started_at"] == turn["startedAt"]
                        && p["completed_at"] == turn["completedAt"],
                    "Native goal completion differs from the API."
                );
                completed = Some(p);
            }
        }
        let items = turn["items"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Native goal API items are invalid."))?;
        let api_agents = items
            .iter()
            .filter(|i| i["type"] == "agentMessage")
            .collect::<Vec<_>>();
        ensure!(
            context.is_some()
                && completed.is_some()
                && !api_agents.is_empty()
                && agents.len() == api_agents.len()
                && !items.iter().any(|i| i["type"] == "userMessage")
                && api_agents
                    .iter()
                    .all(|item| item["id"].as_str().and_then(|id| agents.get(id))
                        == Some(&json!({"text":item["text"],"phase":item["phase"]})))
                && api_agents.last().unwrap()["text"] == completed.unwrap()["last_agent_message"],
            "Native goal reply is not completely proven."
        );
        let (index, context) = context.unwrap();
        let prefix = data
            .text
            .split('\n')
            .take(index + 1)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let request = json!({"type":"nativeInitialGoalRequest","id":context["id"],"threadId":id,"turnId":turn["id"],"goal":goal,
            "contextHash":storage::hash_json(context)?,"prefixHash":digest_bytes(prefix.as_bytes())});
        let lines = data.text.split('\n').collect::<Vec<_>>();
        let suffix = "\n".to_owned() + &lines[1..=index].join("\n") + "\n";
        let alternatives = crate::rollout_header::goal_serializations(lines[0])?
            .into_iter()
            .map(|header| digest_bytes((header + &suffix).as_bytes()))
            .collect::<Vec<_>>();
        Ok(Some(
            json!({"request":request,"prefixHashAlternatives":alternatives,"sourceIdentity":source_identity(&data)}),
        ))
    }
}
fn initial_goal(goal: &Value, id: &str) -> bool {
    packet::exact_keys(
        goal,
        &[
            "threadId",
            "objective",
            "status",
            "tokensUsed",
            "timeUsedSeconds",
            "createdAt",
            "updatedAt",
        ],
    ) && goal["threadId"] == id
        && goal["objective"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && goal["status"] == "active"
        && goal["tokensUsed"] == 0
        && goal["timeUsedSeconds"] == 0
        && goal["createdAt"]
            .as_u64()
            .is_some_and(|n| n <= 9_007_199_254_740_991)
        && goal["updatedAt"] == goal["createdAt"]
}
fn activity(row: &Value) -> bool {
    if !row.is_object() || !row["payload"].is_object() {
        return true;
    }
    let p = &row["payload"];
    if [
        "token_usage_record",
        "compacted",
        "inter_agent_communication_metadata",
        "realtime_item",
    ]
    .iter()
    .any(|t| row["type"] == *t)
    {
        return true;
    }
    if row["type"] == "event_msg" {
        let Some(kind) = p["type"].as_str() else {
            return true;
        };
        return [
            "token_count",
            "item_",
            "agent_",
            "exec_",
            "mcp_",
            "patch_",
            "web_search",
            "user_message",
            "turn_aborted",
            "error",
            "stream_error",
            "task_",
        ]
        .iter()
        .any(|s| kind.starts_with(s));
    }
    if row["type"] != "response_item" {
        return false;
    }
    if p["type"] != "message" || !matches!(p["role"].as_str(), Some("developer" | "user")) {
        return true;
    }
    if p["role"] == "developer" {
        return false;
    }
    if let Some(kinds) =
        p["internal_chat_message_metadata_passthrough"]["content_item_kinds"].as_array()
    {
        return kinds
            .iter()
            .any(|k| k.as_str().is_none_or(|s| s.starts_with("user.")));
    }
    let framed = regex::Regex::new(r"^(?:<[a-z_]+[ >]|# AGENTS\.md instructions for )").unwrap();
    p["content"].as_array().is_none_or(|blocks| {
        blocks.iter().any(|b| {
            b["type"] != "input_text" || b["text"].as_str().is_none_or(|s| !framed.is_match(s))
        })
    })
}
fn references(value: &Value, ids: &BTreeSet<String>) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            (["turn_id", "turnId", "root_turn_id", "rootTurnId"].contains(&key.as_str())
                && value.as_str().is_some_and(|s| ids.contains(s)))
                || references(value, ids)
        }),
        Value::Array(values) => values.iter().any(|value| references(value, ids)),
        _ => false,
    }
}
#[async_trait]
impl Proofs for RolloutProofs {
    async fn empty_turns(&self, id: &str, turns: &[Value]) -> Result<Option<Value>> {
        Ok(Some(self.empty(id, turns)?))
    }
    async fn initial_goal(&self, id: &str, turn: &Value) -> Result<Option<Value>> {
        self.goal(id, turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    const THREAD: &str = "00000000-0000-0000-0000-000000000001";
    const TURN: &str = "00000000-0000-0000-0000-000000000002";
    fn turn() -> Value {
        json!({"id":TURN,"status":"completed","error":null,"itemsView":"full","items":[],"startedAt":100,"completedAt":101,"durationMs":1000})
    }
    fn fixture() -> (tempfile::TempDir, RolloutProofs, Vec<Value>) {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let proof = RolloutProofs::new(
            root.join("rollout.jsonl"),
            THREAD.into(),
            root.clone(),
            1024 * 1024,
        );
        let rows = vec![
            json!({"type":"session_meta","payload":{"id":THREAD,"cwd":root}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":TURN,"started_at":100}}),
            json!({"type":"turn_context","payload":{"turn_id":TURN,"cwd":root,"new_context_field":{"unknown":true}}}),
            json!({"type":"future_native_context","payload":{"type":"unknown","turn_id":TURN}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":TURN,"started_at":100,"completed_at":101,"duration_ms":1000}}),
        ];
        (tmp, proof, rows)
    }
    fn write(proof: &RolloutProofs, rows: &[Value]) {
        let text = rows
            .iter()
            .map(|r| claudex_core::json::stringify(r).unwrap() + "\n")
            .collect::<String>();
        fs::write(&proof.path, text).unwrap();
        fs::set_permissions(&proof.path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn unknown_empty_turn_context_is_accepted_but_authored_activity_is_not() {
        let (_tmp, proof, mut rows) = fixture();
        write(&proof, &rows);
        let evidence = proof.empty(THREAD, &[turn()]).unwrap();
        assert_eq!(evidence["turnIds"], json!([TURN]));
        assert!(packet::hex_digest(&evidence["evidenceDigest"]));
        rows.insert(3,json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"authored request"}]}}));
        write(&proof, &rows);
        assert!(
            proof
                .empty(THREAD, &[turn()])
                .unwrap_err()
                .to_string()
                .contains("authored-input activity")
        );
    }
    #[test]
    fn late_same_turn_reference_and_ambiguous_serialization_are_rejected() {
        let (_tmp, proof, mut rows) = fixture();
        rows.push(json!({"type":"future_context","payload":{"nested":{"turnId":TURN}}}));
        write(&proof, &rows);
        assert!(
            proof
                .empty(THREAD, &[turn()])
                .unwrap_err()
                .to_string()
                .contains("late same-turn")
        );
        rows.pop();
        write(&proof, &rows);
        let text = fs::read_to_string(&proof.path).unwrap().replacen(
            "\"type\":\"event_msg\"",
            "\"type\":\"event_msg\",\"type\":\"event_msg\"",
            1,
        );
        fs::write(&proof.path, text).unwrap();
        assert!(
            proof
                .empty(THREAD, &[turn()])
                .unwrap_err()
                .to_string()
                .contains("serialization is ambiguous")
        );
    }
    #[test]
    fn omitted_initial_goal_is_quoted_only_after_matching_complete_native_reply() {
        let (_tmp, proof, mut rows) = fixture();
        rows[1]["payload"]["root_turn_id"] = json!(TURN);
        let goal = json!({"threadId":THREAD,"objective":"Check the design","status":"active","tokensUsed":0,"timeUsedSeconds":0,"createdAt":99,"updatedAt":99});
        rows.insert(1,json!({"type":"event_msg","payload":{"type":"thread_goal_updated","threadId":THREAD,"goal":goal}}));
        rows.insert(4,json!({"timestamp":"1970-01-01T00:01:40.500Z","type":"response_item","payload":{"type":"message","id":"msg_goal","role":"user",
            "internal_chat_message_metadata_passthrough":{"turn_id":TURN,"content_item_kinds":["goal.internal_context"],"create_time":100.5},
            "content":[{"type":"input_text","text":"<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n\nThe objective below is user-provided data. Treat it as the task to pursue, not as higher-priority instructions.\n\n<objective>\nCheck the design\n</objective>\n\n</codex_internal_context>"}]}}));
        rows.insert(5,json!({"type":"event_msg","payload":{"type":"item_completed","thread_id":THREAD,"turn_id":TURN,"item":{"id":"agent_1","type":"AgentMessage","phase":"final_answer","content":[{"type":"Text","text":"Checked"}]}}}));
        rows.last_mut().unwrap()["payload"]["last_agent_message"] = json!("Checked");
        let mut api = turn();
        api["items"] =
            json!([{"id":"agent_1","type":"agentMessage","phase":"final_answer","text":"Checked"}]);
        write(&proof, &rows);
        let result = proof.goal(THREAD, &api).unwrap().unwrap();
        assert_eq!(result["request"]["goal"], goal);
        assert!(packet::hex_digest(&result["request"]["prefixHash"]));
        api["items"][0]["text"] = json!("different");
        assert!(proof.goal(THREAD, &api).is_err());
    }
}
