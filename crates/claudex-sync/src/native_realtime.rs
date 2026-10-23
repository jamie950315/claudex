//! Read-only reconstruction of persisted realtime transcripts. API turns stay
//! untouched: a proven transcript flush is a historical control boundary, not
//! a fabricated assistant reply or a native writer/retirement proof.
use crate::{history::digest_json, packet};
use anyhow::{Result, ensure};
use claudex_core::storage::Snapshot;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const POLICY_KEY: &str = "realtimeHistory";
pub(crate) const POLICY_VERSION: &str = "transcript-v1";

pub(crate) fn enabled(extra: &serde_json::Map<String, Value>) -> Result<bool> {
    let Some(value) = extra.get(POLICY_KEY) else {
        return Ok(false);
    };
    ensure!(
        value == POLICY_VERSION,
        "Unsupported realtime history policy."
    );
    Ok(true)
}
pub(crate) fn enroll(extra: &mut serde_json::Map<String, Value>) {
    extra.insert(POLICY_KEY.into(), json!(POLICY_VERSION));
}
pub(crate) fn inherit(
    source: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
) {
    if let Some(value) = source.get(POLICY_KEY) {
        target.insert(POLICY_KEY.into(), value.clone());
    } else {
        target.remove(POLICY_KEY);
    }
}

pub fn has_handoff(turns: &[Value]) -> bool {
    turns.iter().any(|t| {
        t["items"].as_array().into_iter().flatten().any(|i| {
            i["type"] == "userMessage"
                && text(i).is_some_and(|s| s.starts_with("<realtime_delegation"))
        })
    })
}
fn text(item: &Value) -> Option<&str> {
    let blocks = item["content"].as_array()?;
    (blocks.len() == 1 && blocks[0]["type"] == "text").then(|| blocks[0]["text"].as_str())?
}
fn delta(value: &str) -> Option<&str> {
    let (head, tail) = value.split_once("<transcript_delta>")?;
    (head.starts_with("<realtime_delegation")
        && head.contains("<source>transcript_tail_flush</source>"))
    .then_some(())?;
    let (transcript, suffix) = tail.rsplit_once("</transcript_delta>")?;
    suffix
        .trim_end()
        .ends_with("</realtime_delegation>")
        .then_some(transcript)
}
fn present(value: &Value, expected: &Value) -> bool {
    value.is_null() || value == expected
}
#[derive(Default)]
struct Session {
    rows: Vec<usize>,
    started: bool,
    closed: Option<usize>,
    transcript: Vec<String>,
}
fn user_item_matches(raw: &Value, api: &Value) -> bool {
    raw["type"] == "UserMessage"
        && api["type"] == "userMessage"
        && raw["id"] == api["id"]
        && raw["content"] == api["content"]
        && raw.get("clientId").is_none()
        && raw.get("client_id").unwrap_or(&Value::Null) == &api["clientId"]
}
fn validate_flush(
    rows: &[Value],
    id: &str,
    turn: &Value,
    item: &Value,
) -> Result<(usize, usize, usize)> {
    let starts = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            r["type"] == "event_msg"
                && r["payload"]["type"] == "task_started"
                && r["payload"]["turn_id"] == turn["id"]
        })
        .collect::<Vec<_>>();
    ensure!(
        starts.len() == 1,
        "Realtime handoff lacks one exact native start."
    );
    let start = starts[0].0;
    let end = rows
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, r)| r["type"] == "event_msg" && r["payload"]["type"] == "task_started")
        .map(|(i, _)| i)
        .unwrap_or(rows.len());
    let mut response = None;
    let mut completed = None;
    let mut boundary = None;
    for (index, row) in rows.iter().enumerate().take(end).skip(start) {
        let p = &row["payload"];
        for field in ["thread_id", "threadId"] {
            ensure!(
                present(&p[field], &json!(id)),
                "Realtime handoff contradicts native thread identity."
            );
        }
        for field in ["turn_id", "turnId", "root_turn_id", "rootTurnId"] {
            ensure!(
                present(&p[field], &turn["id"]),
                "Realtime handoff contradicts native turn identity."
            );
        }
        if row["type"] == "response_item" {
            if p["type"] == "message" && p["role"] == "developer" {
                continue;
            }
            if p["type"] == "message" && p["role"] == "user" {
                ensure!(
                    response.is_none()
                        && row["metadata"]["client_authored"] != true
                        && p["content"].as_array().is_some_and(|a| a.len() == 1
                            && a[0]["type"] == "input_text"
                            && a[0]["text"] == item["content"][0]["text"])
                        && p["internal_chat_message_metadata_passthrough"]["turn_id"] == turn["id"],
                    "Realtime handoff has unmatched persisted input."
                );
                response = Some(index);
            } else {
                ensure!(
                    !matches!(p["role"].as_str(), Some("assistant" | "tool"))
                        && !matches!(
                            p["type"].as_str(),
                            Some(
                                "reasoning"
                                    | "function_call"
                                    | "function_call_output"
                                    | "custom_tool_call"
                                    | "custom_tool_call_output"
                                    | "web_search_call"
                                    | "local_shell_call"
                                    | "computer_call"
                                    | "computer_call_output"
                                    | "image_generation_call"
                            )
                        ),
                    "Realtime handoff has unrepresented model/tool activity."
                );
            }
        }
        if row["type"] == "event_msg" {
            match p["type"].as_str() {
                Some("task_started") => ensure!(
                    present(&p["started_at"], &turn["startedAt"]),
                    "Realtime handoff start time differs from API."
                ),
                Some("item_completed") => {
                    ensure!(
                        completed.is_none()
                            && response.is_some()
                            && boundary.is_none()
                            && p["thread_id"] == id
                            && p["turn_id"] == turn["id"]
                            && user_item_matches(&p["item"], item),
                        "Realtime handoff completed item contradicts full API input."
                    );
                    completed = Some(index);
                }
                Some("item_started") => ensure!(
                    boundary.is_none()
                        && p["item"]["type"] == "UserMessage"
                        && p["item"]["id"] == item["id"],
                    "Realtime handoff has an unrepresented native item start."
                ),
                Some("task_complete") => {
                    ensure!(
                        boundary.is_none()
                            && completed.is_some()
                            && p["last_agent_message"].is_null()
                            && p["error"].is_null()
                            && present(&p["started_at"], &turn["startedAt"])
                            && present(&p["completed_at"], &turn["completedAt"])
                            && present(&p["duration_ms"], &turn["durationMs"]),
                        "Realtime handoff completion contradicts full API boundary."
                    );
                    boundary = Some(index);
                }
                Some(kind) => ensure!(
                    ![
                        "turn_aborted",
                        "error",
                        "stream_error",
                        "token_count",
                        "agent_",
                        "exec_",
                        "mcp_",
                        "patch_",
                        "web_search"
                    ]
                    .iter()
                    .any(|s| kind.starts_with(s)),
                    "Realtime handoff has unrepresented native activity or failure."
                ),
                None => {}
            }
        }
        ensure!(
            !matches!(
                row["type"].as_str(),
                Some("token_usage_record" | "compacted")
            ),
            "Realtime handoff has unrepresented native activity."
        );
    }
    Ok((
        response.ok_or_else(|| anyhow::anyhow!("Realtime handoff lacks persisted input."))?,
        completed
            .ok_or_else(|| anyhow::anyhow!("Realtime handoff lacks persisted item completion."))?,
        boundary.ok_or_else(|| anyhow::anyhow!("Realtime handoff lacks native completion."))?,
    ))
}

pub(crate) fn prove(data: &Snapshot, id: &str, turns: &[Value]) -> Result<Option<Value>> {
    let rows = &data.rows;
    if !rows.iter().any(|r| r["type"] == "realtime_item") {
        return Ok(None);
    }
    let mut sessions = BTreeMap::<String, Session>::new();
    let mut ids = BTreeSet::new();
    let mut global = vec![];
    for (index, row) in rows.iter().enumerate() {
        if row["type"] != "realtime_item" {
            continue;
        }
        let p = &row["payload"];
        ensure!(p.is_object(), "Malformed persisted realtime event.");
        for field in ["thread_id", "threadId"] {
            ensure!(
                present(&p[field], &json!(id)),
                "Realtime event contradicts native thread identity."
            );
        }
        if let Some(event_id) = p["id"].as_str() {
            ensure!(
                !event_id.is_empty() && ids.insert(event_id.to_owned()),
                "Repeated realtime event identity."
            );
        }
        let Some(session_id) = p["realtime_session_id"].as_str() else {
            ensure!(
                !matches!(
                    p["type"].as_str(),
                    Some(
                        "realtime_session_started"
                            | "realtime_session_closed"
                            | "transcript_segment"
                    )
                ),
                "Realtime transcript lacks session identity."
            );
            global.push(index);
            continue;
        };
        ensure!(!session_id.is_empty(), "Empty realtime session identity.");
        let session = sessions.entry(session_id.into()).or_default();
        session.rows.push(index);
        match p["type"].as_str() {
            Some("realtime_session_started") => {
                ensure!(
                    !session.started && session.closed.is_none(),
                    "Realtime session has contradictory start boundaries."
                );
                session.started = true;
            }
            Some("realtime_session_closed") => {
                ensure!(
                    session.started && session.closed.is_none(),
                    "Realtime session has contradictory close boundaries."
                );
                session.closed = Some(index);
            }
            Some("transcript_segment") => {
                ensure!(
                    session.started
                        && session.closed.is_none()
                        && p["text"].is_string()
                        && p["role"].is_string(),
                    "Realtime transcript is incomplete or outside its session."
                );
                // Unknown speaker labels remain whole inert records, not a
                // made-up user/assistant role. Known speakers keep exact text.
                session.transcript.push(format!(
                    "{}: {}",
                    p["role"].as_str().unwrap(),
                    p["text"].as_str().unwrap()
                ));
            }
            _ => {}
        }
    }
    let mut controls = BTreeSet::new();
    let mut selected_sessions = BTreeSet::new();
    let mut extra_rows = BTreeSet::new();
    for turn in turns {
        let Some(items) = turn["items"].as_array() else {
            continue;
        };
        if turn["status"] != "completed"
            || !turn["error"].is_null()
            || turn["itemsView"] != "full"
            || items.len() != 1
            || items[0]["type"] != "userMessage"
        {
            continue;
        }
        let Some(transcript) = text(&items[0]).and_then(delta) else {
            continue;
        };
        let matches = sessions
            .iter()
            .filter(|(_, s)| {
                s.closed.is_some()
                    && !s.transcript.is_empty()
                    && s.transcript.join("\n") == transcript
            })
            .collect::<Vec<_>>();
        // A repeated identical voice exchange is distinguished by the native
        // handoff's position, not by selecting a matching transcript arbitrarily.
        let (response, completed, boundary) = validate_flush(rows, id, turn, &items[0])?;
        let matches = matches
            .into_iter()
            .filter(|(_, s)| {
                s.rows[0] < response
                    && s.rows
                        .iter()
                        .filter(|i| rows[**i]["payload"]["type"] == "transcript_segment")
                        .all(|i| *i < response)
                    && !rows[s.rows[0] + 1..response].iter().any(|r| {
                        r["type"] == "realtime_item"
                            && r["payload"]["type"] == "realtime_session_started"
                    })
            })
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "Realtime handoff lacks one complete matching transcript session."
        );
        selected_sessions.insert(matches[0].0.clone());
        controls.insert(
            turn["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Realtime handoff turn identity missing."))?
                .to_owned(),
        );
        extra_rows.insert(response);
        extra_rows.insert(completed);
        extra_rows.insert(boundary);
        let start = rows[..response]
            .iter()
            .rposition(|r| r["type"] == "event_msg" && r["payload"]["type"] == "task_started")
            .unwrap();
        extra_rows.extend((start..=boundary).filter(|index| {
            let row = &rows[*index];
            row["type"] != "turn_context"
                && !(row["type"] == "response_item"
                    && row["payload"]["type"] == "message"
                    && row["payload"]["role"] == "developer")
        }));
    }
    let last = turns.iter().rposition(|t| {
        t["status"] == "completed"
            && (controls.contains(t["id"].as_str().unwrap_or(""))
                || t["items"].as_array().is_some_and(|a| {
                    a.iter()
                        .any(|i| i["type"] == "agentMessage" && i["phase"] != "commentary")
                }))
    });
    let Some(last) = last else {
        return Ok(None);
    };
    let exported = &turns[..=last];
    let boundary = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            r["type"] == "event_msg"
                && r["payload"]["type"] == "task_complete"
                && r["payload"]["turn_id"] == turns[last]["id"]
        })
        .map(|(i, _)| i)
        .last()
        .ok_or_else(|| anyhow::anyhow!("Realtime history lacks the exported native boundary."))?;
    let mut selected = extra_rows;
    let mut incomplete = false;
    for (session_id, session) in &sessions {
        if session.closed.is_some_and(|closed| closed <= boundary)
            || selected_sessions.contains(session_id)
        {
            selected.extend(&session.rows);
        } else {
            incomplete = true;
        }
    }
    let end = selected.iter().next_back().copied().unwrap_or(boundary);
    incomplete |= global.iter().any(|i| *i > end);
    selected.extend(global.into_iter().filter(|i| *i <= end));
    let api_items = exported
        .iter()
        .flat_map(|t| {
            t["items"].as_array().into_iter().flatten().map(move |i| {
                (
                    (t["id"].as_str().unwrap(), i["id"].as_str().unwrap_or("")),
                    i,
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    let mut anchors = vec![];
    let mut seen = BTreeSet::new();
    for (index, row) in rows.iter().enumerate() {
        if row["type"] != "event_msg" || row["payload"]["type"] != "item_completed" {
            continue;
        }
        let p = &row["payload"];
        let key = (
            p["turn_id"].as_str().unwrap_or(""),
            p["item"]["id"].as_str().unwrap_or(""),
        );
        if api_items.contains_key(&key) {
            ensure!(
                p["thread_id"] == id && seen.insert(key),
                "Realtime ordering has contradictory item identity."
            );
            anchors.push((index, key));
        }
    }
    let mut records = vec![];
    let lines = data.text.lines().collect::<Vec<_>>();
    for index in selected {
        let row = &rows[index];
        ensure!(
            lines.get(index).is_some_and(
                |line| claudex_core::json::stringify(row).ok().as_deref() == Some(*line)
            ),
            "Realtime source record serialization is ambiguous."
        );
        let mut record = json!({"row":row});
        if let Some((_, (turn, item))) = anchors.iter().find(|(i, _)| *i > index) {
            record["beforeTurnId"] = json!(turn);
            record["beforeItemId"] = json!(item);
        } else {
            record["afterTurnId"] = turns[last]["id"].clone();
        }
        records.push(record);
    }
    let identity = &data.file_identity;
    // Cold scheduling must invalidate this read when the realtime-only raw
    // tail changes even if the native API turn inventory stays unchanged.
    let evidence = json!({"controlTurnIds":controls,"records":records,"incompleteTail":incomplete});
    Ok(Some(
        json!({"controlTurnIds":evidence["controlTurnIds"],"records":evidence["records"],"incompleteTail":incomplete,
        "sourceIdentity":{"dev":identity.dev,"ino":identity.ino,"uid":identity.uid,"mode":identity.mode,"nlink":identity.nlink},
        "evidenceDigest":digest_json(&evidence)?}),
    ))
}

pub(crate) fn control(proof: Option<&Value>, id: &str) -> bool {
    proof.is_some_and(|p| {
        p["controlTurnIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|i| i == id))
    })
}
pub(crate) fn validate(proof: &Value) -> Result<()> {
    ensure!(
        proof["sourceIdentity"].is_object()
            && packet::hex_digest(&proof["evidenceDigest"])
            && proof["records"].is_array()
            && proof["controlTurnIds"].is_array()
            && proof["incompleteTail"].is_boolean()
            && digest_json(
                &json!({"controlTurnIds":proof["controlTurnIds"],"records":proof["records"],"incompleteTail":proof["incompleteTail"]})
            )? == proof["evidenceDigest"],
        "Invalid native realtime provenance."
    );
    Ok(())
}

/// A real speaker's transcript is plain text; the complete original row,
/// including new fields, remains alongside it as explicitly inert metadata.
pub(crate) fn message(row: &Value) -> Result<crate::history::Message> {
    let p = &row["payload"];
    let transcript = row["type"] == "realtime_item"
        && p["type"] == "transcript_segment"
        && matches!(p["role"].as_str(), Some("user" | "assistant"));
    let mut message = crate::history::Message::text(
        if transcript {
            p["role"].as_str().unwrap()
        } else {
            "assistant"
        },
        "",
    );
    message.content.clear();
    if transcript {
        ensure!(p["text"].is_string(), "Malformed realtime transcript text.");
        message
            .content
            .push(json!({"type":"text","text":p["text"]}));
    }
    message.content.push(crate::history::inert(
        "Codex realtime historical event",
        row,
    )?);
    if let Some(stamp) = row.get("timestamp") {
        message.extra.insert("timestamp".into(), stamp.clone());
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        codecs,
        history::Common,
        native_history::{self, Limits, Rpc},
        native_proofs::RolloutProofs,
    };
    use async_trait::async_trait;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    const THREAD: &str = "00000000-0000-0000-0000-000000000001";
    const TURN: &str = "00000000-0000-0000-0000-000000000002";
    const NEXT: &str = "00000000-0000-0000-0000-000000000003";
    #[test]
    fn enrollment_policy_keeps_absent_legacy_state_and_rejects_unknown_versions() -> Result<()> {
        let legacy = serde_json::Map::new();
        assert!(!enabled(&legacy)?);
        let mut current = legacy.clone();
        enroll(&mut current);
        assert!(enabled(&current)?);
        inherit(&legacy, &mut current);
        assert!(current.is_empty());
        enroll(&mut current);
        let mut target = legacy;
        inherit(&current, &mut target);
        assert_eq!(target, current);
        target.insert(POLICY_KEY.into(), json!("future"));
        assert!(enabled(&target).is_err());
        Ok(())
    }
    struct Api(Vec<Value>);
    #[async_trait]
    impl Rpc for Api {
        async fn request(&self, method: &str, _: Value) -> Result<Value> {
            ensure!(method == "thread/turns/list", "Unexpected audit operation.");
            Ok(json!({"data":self.0,"nextCursor":null}))
        }
    }
    struct Fixture {
        _tmp: tempfile::TempDir,
        proof: RolloutProofs,
        rows: Vec<Value>,
        turns: Vec<Value>,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let tmp = tempfile::tempdir()?;
            let cwd = fs::canonicalize(tmp.path())?;
            let proof = RolloutProofs::new(
                cwd.join("rollout.jsonl"),
                THREAD.into(),
                cwd.clone(),
                1024 * 1024,
            );
            let handoff = "<realtime_delegation>\n  <source>transcript_tail_flush</source>\n  <input>Native transcript tail.</input>\n  <transcript_delta>user: Hello\nassistant: Hi</transcript_delta>\n</realtime_delegation>";
            let item = json!({"id":"user-1","type":"userMessage","clientId":null,"content":[{"type":"text","text":handoff,"text_elements":[]}],"futureApiMetadata":{"preserve":true}});
            let turns = vec![
                json!({"id":TURN,"status":"completed","error":null,"itemsView":"full","startedAt":100,"completedAt":100,"durationMs":0,"items":[item]}),
            ];
            let rows = vec![
                json!({"type":"session_meta","payload":{"id":THREAD,"cwd":cwd,"thread_source":"voice_chat"}}),
                json!({"type":"realtime_item","timestamp":"1970-01-01T00:01:35Z","payload":{"id":"start","type":"realtime_session_started","realtime_session_id":"session-1","future":{"value":1}}}),
                json!({"type":"realtime_item","payload":{"id":"segment-user","type":"transcript_segment","realtime_session_id":"session-1","role":"user","text":"Hello"}}),
                json!({"type":"realtime_item","payload":{"id":"segment-agent","type":"transcript_segment","realtime_session_id":"session-1","role":"assistant","text":"Hi","newMetadata":{"retain":"exact"}}}),
                json!({"type":"realtime_item","payload":{"id":"future","type":"future_voice_event","realtime_session_id":"session-1","newField":[1,2,3]}}),
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":TURN,"root_turn_id":TURN,"started_at":100}}),
                json!({"type":"response_item","payload":{"type":"message","id":"raw-user","role":"user","content":[{"type":"input_text","text":handoff}],"internal_chat_message_metadata_passthrough":{"turn_id":TURN,"future":true}},"metadata":{"unknown":"preserved"}}),
                json!({"type":"event_msg","payload":{"type":"item_completed","thread_id":THREAD,"turn_id":TURN,"item":{"id":"user-1","type":"UserMessage","content":[{"type":"text","text":handoff,"text_elements":[]}]},"future":17}}),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":TURN,"root_turn_id":TURN,"last_agent_message":null,"started_at":100,"completed_at":100,"duration_ms":0}}),
                json!({"type":"realtime_item","payload":{"id":"close","type":"realtime_session_closed","realtime_session_id":"session-1","outcome":"ended","newCloseField":true}}),
            ];
            let f = Self {
                _tmp: tmp,
                proof,
                rows,
                turns,
            };
            f.write()?;
            Ok(f)
        }
        fn write(&self) -> Result<()> {
            fs::write(&self.proof.path, codecs::serialize_rows(&self.rows)?)?;
            fs::set_permissions(&self.proof.path, fs::Permissions::from_mode(0o600))?;
            Ok(())
        }
        async fn read(&self) -> Result<native_history::Snapshot> {
            native_history::read_stable(
                &Api(self.turns.clone()),
                THREAD,
                &Limits::default(),
                true,
                false,
                &self.proof,
            )
            .await
        }
        fn common(&self, snapshot: &native_history::Snapshot) -> Result<Common> {
            native_history::convert(
                snapshot,
                THREAD,
                self.proof.cwd.to_str().unwrap(),
                None,
                false,
            )
        }
        fn continuation(&mut self) {
            self.turns.push(json!({"id":NEXT,"status":"completed","error":null,"itemsView":"full","startedAt":110,"completedAt":111,"items":[
                {"id":"normal-user","type":"userMessage","content":[{"type":"text","text":"Continue normally"}]},
                {"id":"normal-agent","type":"agentMessage","text":"Normal answer","phase":"final_answer"}]}));
            self.rows.extend([
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":NEXT,"started_at":110}}),
                json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":NEXT,"thread_id":THREAD,"item":{"id":"normal-user","type":"UserMessage"}}}),
                json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":NEXT,"thread_id":THREAD,"item":{"id":"normal-agent","type":"AgentMessage"}}}),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":NEXT,"started_at":110,"completed_at":111,"last_agent_message":"Normal answer"}}),
            ]);
        }
    }
    #[tokio::test]
    async fn closed_realtime_reconstructs_speakers_and_all_metadata_without_api_rewrite()
    -> Result<()> {
        let f = Fixture::new()?;
        let snapshot = f.read().await?;
        assert_eq!(snapshot.turns, f.turns);
        assert!(!snapshot.incomplete_tail);
        let common = f.common(&snapshot)?;
        let texts = common
            .messages
            .iter()
            .filter_map(|m| {
                m.content
                    .first()
                    .and_then(|c| c["text"].as_str())
                    .filter(|s| !s.starts_with("[Imported"))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec!["Hello", "Hi", text(&f.turns[0]["items"][0]).unwrap()]
        );
        let segments = common
            .messages
            .iter()
            .filter(|m| {
                m.content
                    .first()
                    .is_some_and(|c| c["text"] == "Hello" || c["text"] == "Hi")
            })
            .map(|m| m.role.as_str())
            .collect::<Vec<_>>();
        assert_eq!(segments, vec!["user", "assistant"]);
        let portable = serde_json::to_string(&common.portable())?;
        for preserved in [
            "future_voice_event",
            "newMetadata",
            "newCloseField",
            "futureApiMetadata",
            "unknown",
            "preserved",
        ] {
            assert!(portable.contains(preserved));
        }
        assert_eq!(common.messages.last().unwrap().role, "assistant");
        assert!(
            common.messages.last().unwrap().content[0]["text"]
                .as_str()
                .unwrap()
                .contains("realtime_session_closed")
        );
        assert!(
            !snapshot.turns[0]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["type"] == "agentMessage")
        );
        Ok(())
    }
    #[tokio::test]
    async fn ordinary_continuation_keeps_the_complete_realtime_checkpoint() -> Result<()> {
        let mut f = Fixture::new()?;
        let first = f.common(&f.read().await?)?;
        let checkpoint = crate::desktop::Checkpoint::of(&first)?;
        f.continuation();
        f.write()?;
        let second = f.common(&f.read().await?)?;
        assert!(checkpoint.contains(&second)?);
        assert_eq!(second.messages.len(), first.messages.len() + 2);
        assert_eq!(
            second.messages.last().unwrap().content[0]["text"],
            "Normal answer"
        );
        Ok(())
    }
    #[tokio::test]
    async fn identical_sessions_are_bound_by_native_position_not_transcript_guessing() -> Result<()>
    {
        let mut f = Fixture::new()?;
        let mut next = f.turns[0].clone();
        next["id"] = json!(NEXT);
        next["startedAt"] = json!(110);
        next["completedAt"] = json!(110);
        next["items"][0]["id"] = json!("user-2");
        f.turns.push(next);
        let mut second = f.rows[1..].to_vec();
        for row in &mut second {
            let p = &mut row["payload"];
            if let Some(id) = p["id"].as_str() {
                p["id"] = json!(format!("second-{id}"));
            }
            if p.get("realtime_session_id").is_some() {
                p["realtime_session_id"] = json!("session-2");
            }
            for k in ["turn_id", "root_turn_id"] {
                if p.get(k).is_some() {
                    p[k] = json!(NEXT);
                }
            }
            if p.get("started_at").is_some() {
                p["started_at"] = json!(110);
            }
            if p.get("completed_at").is_some() {
                p["completed_at"] = json!(110);
            }
            if p.get("internal_chat_message_metadata_passthrough")
                .is_some()
            {
                p["internal_chat_message_metadata_passthrough"]["turn_id"] = json!(NEXT);
            }
            if p.get("item").is_some() {
                p["item"]["id"] = json!("user-2");
            }
        }
        f.rows.extend(second);
        f.write()?;
        let snapshot = f.read().await?;
        assert_eq!(snapshot.turns, f.turns);
        assert_eq!(
            snapshot.realtime.as_ref().unwrap()["controlTurnIds"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            f.common(&snapshot)?
                .messages
                .iter()
                .filter(|m| m.content[0]["text"] == "Hello")
                .count(),
            2
        );
        Ok(())
    }
    #[tokio::test]
    async fn an_active_realtime_tail_is_withheld_without_changing_the_saved_prefix() -> Result<()> {
        let mut f = Fixture::new()?;
        let first = f.common(&f.read().await?)?;
        f.rows.push(json!({"type":"realtime_item","payload":{"id":"next-start","type":"realtime_session_started","realtime_session_id":"session-2"}}));
        f.rows.push(json!({"type":"realtime_item","payload":{"id":"next-input","type":"transcript_segment","realtime_session_id":"session-2","role":"user","text":"Not closed yet"}}));
        f.write()?;
        let snapshot = f.read().await?;
        assert!(snapshot.incomplete_tail);
        assert_eq!(
            first.portable().messages,
            f.common(&snapshot)?.portable().messages
        );
        Ok(())
    }
    #[tokio::test]
    async fn user_only_is_not_a_boundary_without_the_closed_matching_raw_session() -> Result<()> {
        let f = Fixture::new()?;
        assert!(
            native_history::read_stable(
                &Api(f.turns.clone()),
                THREAD,
                &Limits::default(),
                true,
                false,
                &native_history::NoProofs
            )
            .await
            .is_err()
        );
        for mutation in 0..9 {
            let mut f = Fixture::new()?;
            match mutation {
                0 => {
                    f.rows.pop();
                }
                1 => {
                    f.rows[3]["payload"]["text"] = json!("Changed transcript");
                }
                2 => {
                    f.rows[7]["payload"]["item"]["content"][0]["text"] = json!("Changed input");
                }
                3 => {
                    f.rows[7]["payload"]["thread_id"] = json!(NEXT);
                }
                4 => {
                    f.rows[8]["payload"]["completed_at"] = json!(101);
                }
                5 => {
                    f.rows.insert(8,json!({"type":"response_item","payload":{"type":"function_call","call_id":"tool","name":"Bash","arguments":"{}"}}));
                }
                6 => {
                    f.turns[0]["error"] = json!({"message":"failed"});
                }
                7 => {
                    f.turns[0]["itemsView"] = json!("summary");
                }
                _ => {
                    f.rows[6]["metadata"]["client_authored"] = json!(true);
                }
            }
            f.write()?;
            assert!(
                f.read().await.is_err(),
                "mutation {mutation} must not authorize a completed handoff"
            );
        }
        Ok(())
    }
    #[tokio::test]
    async fn missing_raw_input_and_foreign_writes_never_fall_back_to_api_text() -> Result<()> {
        let mut f = Fixture::new()?;
        f.rows.remove(6);
        f.write()?;
        assert!(f.read().await.is_err());
        let f = Fixture::new()?;
        fs::set_permissions(&f.proof.path, fs::Permissions::from_mode(0o666))?;
        assert!(f.read().await.is_err());
        Ok(())
    }
    #[tokio::test]
    async fn native_item_starts_must_match_the_full_api_user_not_hidden_work() -> Result<()> {
        for item in [
            json!({"type":"AgentMessage","id":"unreported"}),
            json!({"type":"CommandExecution","id":"tool"}),
            json!({"type":"UserMessage","id":"different"}),
        ] {
            let mut f = Fixture::new()?;
            f.rows.insert(8,json!({"type":"event_msg","payload":{"type":"item_started","thread_id":THREAD,"turn_id":TURN,"item":item}}));
            f.write()?;
            assert!(
                f.read()
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("unrepresented native item start")
            );
        }
        let mut f = Fixture::new()?;
        f.rows.insert(7,json!({"type":"event_msg","payload":{"type":"item_started","thread_id":THREAD,"turn_id":TURN,"item":{"type":"UserMessage","id":"user-1"},"extra":"retained"}}));
        f.write()?;
        assert!(serde_json::to_string(&f.common(&f.read().await?)?)?.contains("retained"));
        Ok(())
    }
    #[tokio::test]
    async fn unknown_handoff_context_stays_inert_without_becoming_model_activity() -> Result<()> {
        let mut f = Fixture::new()?;
        f.rows.insert(7,json!({"type":"response_item","payload":{"type":"future_native_context","value":{"instructions":"historical only"},"newField":123}}));
        f.rows.insert(8,json!({"type":"event_msg","payload":{"type":"future_handoff_context","unknownState":"kept"}}));
        f.write()?;
        let snapshot = f.read().await?;
        let common = f.common(&snapshot)?;
        assert_eq!(snapshot.turns, f.turns);
        let portable = serde_json::to_string(&common.portable())?;
        assert!(
            portable.contains("future_native_context")
                && portable.contains("historical only")
                && portable.contains("future_handoff_context")
                && portable.contains("unknownState")
        );
        Ok(())
    }
    #[tokio::test]
    async fn tool_role_messages_cannot_be_hidden_as_unknown_handoff_context() -> Result<()> {
        let mut f = Fixture::new()?;
        f.rows.insert(7,json!({"type":"response_item","payload":{"type":"message","role":"tool","content":[{"type":"text","text":"Tool result"}]}}));
        f.write()?;
        assert!(
            f.read()
                .await
                .unwrap_err()
                .to_string()
                .contains("unrepresented model/tool activity")
        );
        Ok(())
    }
    #[test]
    fn handoff_proof_uses_transcript_and_source_not_unrelated_envelope_fields() {
        let envelope = "<realtime_delegation new=\"kept\">\n<source>transcript_tail_flush</source>\n<future>context</future><transcript_delta>user: Hello</transcript_delta><future_after>kept</future_after>\n</realtime_delegation>";
        assert_eq!(delta(envelope), Some("user: Hello"));
    }
    struct ReplacedApi {
        turns: Vec<Value>,
        path: PathBuf,
        rows: Vec<Value>,
        pass: AtomicUsize,
    }
    #[async_trait]
    impl Rpc for ReplacedApi {
        async fn request(&self, _: &str, _: Value) -> Result<Value> {
            if self.pass.fetch_add(1, Ordering::SeqCst) == 1 {
                let replacement = self.path.with_extension("replacement");
                fs::write(&replacement, codecs::serialize_rows(&self.rows)?)?;
                fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600))?;
                fs::rename(replacement, &self.path)?;
            }
            Ok(json!({"data":self.turns,"nextCursor":null}))
        }
    }
    #[tokio::test]
    async fn raw_inode_replacement_between_api_passes_is_not_a_stable_read() -> Result<()> {
        let f = Fixture::new()?;
        let api = ReplacedApi {
            turns: f.turns.clone(),
            path: f.proof.path.clone(),
            rows: f.rows.clone(),
            pass: AtomicUsize::new(0),
        };
        assert!(
            native_history::read_stable(&api, THREAD, &Limits::default(), true, false, &f.proof)
                .await
                .unwrap_err()
                .to_string()
                .contains("changed between complete reads")
        );
        Ok(())
    }
    #[tokio::test]
    async fn realtime_projection_obeys_the_existing_byte_and_item_budgets() -> Result<()> {
        let f = Fixture::new()?;
        let limits = Limits {
            max_bytes: 1024,
            ..Limits::default()
        };
        assert!(
            native_history::read_stable(
                &Api(f.turns.clone()),
                THREAD,
                &limits,
                true,
                false,
                &f.proof
            )
            .await
            .is_err()
        );
        let limits = Limits {
            max_items: 2,
            ..Limits::default()
        };
        assert!(
            native_history::read_stable(
                &Api(f.turns.clone()),
                THREAD,
                &limits,
                true,
                false,
                &f.proof
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("item limit")
        );
        Ok(())
    }
}
