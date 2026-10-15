//! Exact observed parallel/streamed tool waves. Only graph-validation parents
//! change; native rows, physical order and tool contents remain untouched.
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn authored(row: &Value) -> bool {
    matches!(row["type"].as_str(), Some("user" | "assistant"))
}
fn same_session(row: &Value, first: &Value, tool: bool) -> bool {
    row["sessionId"] == first["sessionId"]
        && row["version"] == first["version"]
        && row["isSidechain"] != true
        && row["isMeta"] != true
        && row["isSynthetic"] != true
        && if tool {
            row["cwd"].as_str().is_some_and(|s| s.starts_with('/'))
        } else {
            row["cwd"] == first["cwd"]
        }
}
pub fn parents(rows: &[Value]) -> HashMap<String, String> {
    let mut by_id = HashMap::new();
    let mut duplicates = HashSet::new();
    let mut children: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut responses: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut uses: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut results: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(id) = row["uuid"].as_str() {
            if by_id.insert(id, i).is_some() {
                duplicates.insert(id);
            }
        }
        if authored(row) {
            if let (Some(parent), Some(id)) = (row["parentUuid"].as_str(), row["uuid"].as_str()) {
                children.entry(parent).or_default().insert(id);
            }
        }
        if row["type"] == "assistant" && nonempty(&row["message"]["id"]) {
            responses
                .entry(row["message"]["id"].as_str().unwrap())
                .or_default()
                .push(i);
        }
        for block in row["message"]["content"].as_array().into_iter().flatten() {
            let target = if row["type"] == "assistant" && block["type"] == "tool_use" {
                Some((&mut uses, &block["id"]))
            } else if row["type"] == "user" && block["type"] == "tool_result" {
                Some((&mut results, &block["tool_use_id"]))
            } else {
                None
            };
            if let Some((map, id)) = target {
                if let Some(id) = id.as_str() {
                    map.entry(id).or_default().push(i);
                }
            }
        }
    }
    let candidates = children
        .iter()
        .filter(|(_, children)| children.len() > 1)
        .filter_map(|(parent, _)| by_id.get(parent))
        .filter_map(|i| rows[*i]["message"]["id"].as_str())
        .collect::<HashSet<_>>();
    let mut parents = HashMap::new();
    'group: for id in candidates {
        let Some(group) = responses.get(id).filter(|g| g.len() >= 2) else {
            continue;
        };
        let first = &rows[group[0]];
        if ["requestId", "sessionId", "cwd", "version"]
            .iter()
            .any(|k| !nonempty(&first[*k]))
            || !nonempty(&first["message"]["model"])
        {
            continue;
        }
        let Some(anchor_id) = first["parentUuid"].as_str() else {
            continue;
        };
        let Some(anchor) = by_id.get(anchor_id).copied() else {
            continue;
        };
        if duplicates.contains(anchor_id)
            || anchor >= group[0]
            || rows[anchor]["sessionId"] != first["sessionId"]
            || rows[anchor]["cwd"] != first["cwd"]
        {
            continue;
        }
        for (block_index, index) in group.iter().enumerate() {
            let row = &rows[*index];
            if !nonempty(&row["uuid"])
                || duplicates.contains(row["uuid"].as_str().unwrap())
                || !same_session(row, first, false)
                || row["requestId"] != first["requestId"]
                || row["apiBlockIndex"].as_u64() != Some(block_index as u64)
                || row["message"]["role"] != "assistant"
                || row["message"]["model"] != first["message"]["model"]
                || row["isApiErrorMessage"] == true
                || row["message"]["stop_reason"] != "tool_use"
                || !row["message"]["content"].as_array().is_some_and(|a| {
                    a.len() == 1
                        && matches!(
                            a[0]["type"].as_str(),
                            Some("text" | "thinking" | "tool_use")
                        )
                })
            {
                continue 'group;
            }
        }
        let calls = group
            .iter()
            .copied()
            .filter(|i| rows[*i]["message"]["content"][0]["type"] == "tool_use")
            .collect::<Vec<_>>();
        if calls.len() < 2 {
            continue;
        }
        let mut matched = vec![];
        for call in &calls {
            let block = &rows[*call]["message"]["content"][0];
            let Some(id) = block["id"].as_str().filter(|s| !s.is_empty()) else {
                continue 'group;
            };
            let Some(result) = results.get(id).filter(|r| r.len() == 1).map(|r| r[0]) else {
                continue 'group;
            };
            let row = &rows[result];
            if uses.get(id).map(Vec::len) != Some(1)
                || !nonempty(&row["uuid"])
                || duplicates.contains(row["uuid"].as_str().unwrap())
                || !same_session(row, first, true)
                || !nonempty(&row["promptId"])
                || row["message"]["role"] != "user"
                || row["sourceToolAssistantUUID"] != rows[*call]["uuid"]
                || row["parentUuid"] != rows[*call]["uuid"]
                || !row["message"]["content"].as_array().is_some_and(|a| {
                    a.len() == 1 && a[0]["type"] == "tool_result" && a[0]["tool_use_id"] == id
                })
                || result <= *call
            {
                continue 'group;
            }
            matched.push(result);
        }
        matched.sort_unstable();
        if matched
            .iter()
            .any(|i| rows[*i]["promptId"] != rows[matched[0]]["promptId"])
        {
            continue;
        }
        let members = group
            .iter()
            .chain(&matched)
            .copied()
            .collect::<HashSet<_>>();
        let start = group[0];
        let end = *matched.last().unwrap();
        for i in start..=end {
            let row = &rows[i];
            if !authored(row) && row.get("uuid").is_none() || members.contains(&i) {
                continue;
            }
            let hook = &row["attachment"];
            let parent = row["parentUuid"]
                .as_str()
                .and_then(|id| by_id.get(id))
                .copied();
            if row["type"] != "attachment"
                || !nonempty(&row["uuid"])
                || duplicates.contains(row["uuid"].as_str().unwrap())
                || row.get("message").is_some()
                || !same_session(row, first, true)
                || !parent.is_some_and(|p| members.contains(&p) && p < i)
                || hook["type"] != "hook_success"
                || hook["hookEvent"] != "PreToolUse"
                || hook["exitCode"] != 0
                || hook["content"] != ""
                || hook["stderr"] != ""
                || !hook["stdout"].is_string()
                || !nonempty(&hook["command"])
                || !hook["durationMs"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.)
            {
                continue 'group;
            }
            let Some(call) = calls
                .iter()
                .copied()
                .find(|c| rows[*c]["message"]["content"][0]["id"] == hook["toolUseID"])
            else {
                continue 'group;
            };
            let Some(result) = matched
                .iter()
                .copied()
                .find(|r| rows[*r]["sourceToolAssistantUUID"] == rows[call]["uuid"])
            else {
                continue 'group;
            };
            if hook["hookName"]
                != format!(
                    "PreToolUse:{}",
                    rows[call]["message"]["content"][0]["name"]
                        .as_str()
                        .unwrap_or("")
                )
                || call >= i
                || i >= result
            {
                continue 'group;
            }
        }
        let mut wave = HashMap::new();
        let mut outstanding = HashSet::new();
        let mut previous = anchor_id;
        for i in start..=end {
            if !members.contains(&i) {
                continue;
            }
            let row = &rows[i];
            let block = &row["message"]["content"][0];
            if row["type"] == "assistant" {
                if row["parentUuid"] != previous {
                    continue 'group;
                }
                if block["type"] == "tool_use" {
                    outstanding.insert(block["id"].as_str().unwrap());
                }
            } else {
                if !outstanding.remove(block["tool_use_id"].as_str().unwrap()) {
                    continue 'group;
                }
                wave.insert(
                    row["uuid"].as_str().unwrap().to_owned(),
                    previous.to_owned(),
                );
            }
            previous = row["uuid"].as_str().unwrap();
        }
        if !outstanding.is_empty()
            || previous != rows[end]["uuid"].as_str().unwrap()
            || *group.last().unwrap() > end
        {
            continue;
        }
        let mut exits = 0;
        for (i, row) in rows
            .iter()
            .enumerate()
            .filter(|(i, r)| authored(r) && !members.contains(i))
        {
            let mut parent = row["parentUuid"].as_str();
            let mut seen = HashSet::new();
            while let Some((id, index)) = parent
                .and_then(|id| by_id.get(id).map(|i| (id, *i)))
                .filter(|(_, i)| !authored(&rows[*i]))
            {
                if !seen.insert(id) || duplicates.contains(id) {
                    continue 'group;
                }
                parent = rows[index]["parentUuid"].as_str();
            }
            if let Some(index) = parent.and_then(|p| by_id.get(p)) {
                if members.contains(index) {
                    exits += 1;
                    if *index != end || exits > 1 {
                        continue 'group;
                    }
                }
            }
            let _ = i;
        }
        parents.extend(wave);
    }
    parents
}
/// The observed native race persists a result just before the assistant row
/// that issued it. Move only that exact result behind its named call.
pub fn results_after_calls(rows: &[Value]) -> Vec<usize> {
    let by_id = rows
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r["uuid"].as_str().map(|id| (id, i)))
        .collect::<HashMap<_, _>>();
    let mut late: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut moved = HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        let Some(call) = row["parentUuid"]
            .as_str()
            .and_then(|id| by_id.get(id))
            .copied()
        else {
            continue;
        };
        let Some(content) = row["message"]["content"].as_array() else {
            continue;
        };
        let parent = &rows[call];
        if row["type"] != "user"
            || !nonempty(&row["uuid"])
            || parent["type"] != "assistant"
            || call < i
            || row["sourceToolAssistantUUID"] != parent["uuid"]
        {
            continue;
        }
        let calls = parent["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .filter_map(|b| b["id"].as_str())
            .collect::<HashSet<_>>();
        let results = content
            .iter()
            .filter(|b| b["type"] == "tool_result")
            .collect::<Vec<_>>();
        if results.is_empty()
            || !results.iter().all(|r| {
                r["tool_use_id"]
                    .as_str()
                    .is_some_and(|id| calls.contains(id))
            })
        {
            continue;
        }
        late.entry(call).or_default().push(i);
        moved.insert(i);
    }
    let mut order = vec![];
    for i in 0..rows.len() {
        if !moved.contains(&i) {
            order.push(i);
            if let Some(results) = late.get(&i) {
                order.extend(results);
            }
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{codecs, history::assert_complete};
    use anyhow::Result;
    use serde_json::json;
    fn row(id: &str, parent: Option<&str>, kind: &str, content: Value) -> Value {
        json!({"uuid":id,"parentUuid":parent,"type":kind,"sessionId":"session","cwd":"/tmp/wave","version":"2.1.281","timestamp":"2026-10-16T00:00:00.000Z","message":{"role":kind,"content":content,"id":format!("response-{id}"),"model":"fixture","stop_reason":"end_turn"}})
    }
    fn fixture() -> Vec<Value> {
        let mut rows = vec![row("user", None, "user", json!("Run both"))];
        for (i, block) in [
            json!({"type":"thinking","thinking":"Visible reasoning","signature":"inert"}),
            json!({"type":"tool_use","id":"a","name":"Bash","input":{"command":"inert A"}}),
            json!({"type":"tool_use","id":"b","name":"Bash","input":{"command":"inert B"}}),
        ]
        .into_iter()
        .enumerate()
        {
            let mut r = row(
                &format!("s{i}"),
                Some(if i == 0 {
                    "user"
                } else if i == 1 {
                    "s0"
                } else {
                    "s1"
                }),
                "assistant",
                json!([block]),
            );
            r["requestId"] = json!("request");
            r["apiBlockIndex"] = json!(i);
            r["message"]["id"] = json!("response");
            r["message"]["stop_reason"] = json!("tool_use");
            rows.push(r);
        }
        for (id, parent, tool) in [("ra", "s1", "a"), ("rb", "s2", "b")] {
            let mut r = row(
                id,
                Some(parent),
                "user",
                json!([{"type":"tool_result","tool_use_id":tool,"content":format!("Result {tool}")} ]),
            );
            r["sourceToolAssistantUUID"] = json!(parent);
            r["promptId"] = json!("prompt");
            rows.push(r);
        }
        rows.push(row(
            "final",
            Some("rb"),
            "assistant",
            json!([{"type":"text","text":"Done"}]),
        ));
        rows
    }
    #[test]
    fn split_response_graph_preserves_both_results_and_physical_bytes() -> Result<()> {
        let rows = fixture();
        let before = codecs::serialize_rows(&rows)?;
        let common = codecs::decode_claude(&before, true, false)?;
        assert_complete(&common)?;
        let graph = parents(&rows);
        assert_eq!(graph.get("ra").map(String::as_str), Some("s2"));
        assert_eq!(graph.get("rb").map(String::as_str), Some("ra"));
        let mut linear = rows.clone();
        linear[4]["parentUuid"] = json!("s2");
        linear[5]["parentUuid"] = json!("ra");
        assert_eq!(
            common.fingerprint()?,
            codecs::decode_claude(&codecs::serialize_rows(&linear)?, true, false)?.fingerprint()?
        );
        assert_eq!(codecs::serialize_rows(&rows)?, before);
        Ok(())
    }
    #[test]
    fn streamed_wave_and_changed_cwd_hook_validate_without_dropping_contents() -> Result<()> {
        let mut rows = fixture();
        let mut call = row(
            "s3",
            Some("ra"),
            "assistant",
            json!([{"type":"tool_use","id":"c","name":"Bash","input":{"command":"inert C"}}]),
        );
        call["requestId"] = json!("request");
        call["apiBlockIndex"] = json!(3);
        call["message"]["id"] = json!("response");
        call["message"]["stop_reason"] = json!("tool_use");
        rows.insert(5, call);
        let mut result = row(
            "rc",
            Some("s3"),
            "user",
            json!([{"type":"tool_result","tool_use_id":"c","content":"Result c"}]),
        );
        result["promptId"] = json!("prompt");
        result["sourceToolAssistantUUID"] = json!("s3");
        rows.insert(7, result);
        rows[8]["parentUuid"] = json!("rc");
        let hook = json!({"uuid":"hook","parentUuid":"s2","type":"attachment","sessionId":"session","cwd":"/tmp/wave/changed","version":"2.1.281","attachment":{"type":"hook_success","hookEvent":"PreToolUse","hookName":"PreToolUse:Bash","toolUseID":"a","content":"","stdout":"inert","stderr":"","exitCode":0,"command":"/fixture/hook","durationMs":1}});
        rows.insert(4, hook);
        rows[5]["cwd"] = json!("/tmp/wave/changed");
        assert_eq!(parents(&rows).len(), 3);
        let common = codecs::decode_claude(&codecs::serialize_rows(&rows)?, true, false)?;
        assert_complete(&common)?;
        assert_eq!(
            common
                .messages
                .iter()
                .flat_map(|m| &m.content)
                .filter(|b| b["type"] == "tool_result")
                .count(),
            3
        );
        rows[4]["attachment"]["content"] = json!("authored");
        assert!(parents(&rows).is_empty());
        Ok(())
    }
    #[test]
    fn exact_result_written_before_its_call_is_decoded_after_call() -> Result<()> {
        let mut rows = fixture();
        rows[4]["parentUuid"] = json!("s2");
        rows[4]["sourceToolAssistantUUID"] = json!("s2");
        rows[4]["message"]["content"][0]["tool_use_id"] = json!("b");
        rows[5]["parentUuid"] = json!("ra");
        rows[5]["sourceToolAssistantUUID"] = json!("s1");
        rows[5]["message"]["content"][0]["tool_use_id"] = json!("a");
        let logical = codecs::decode_claude(&codecs::serialize_rows(&rows)?, true, false)?;
        let call = rows.remove(3);
        rows.insert(4, call);
        let actual = codecs::decode_claude(&codecs::serialize_rows(&rows)?, true, false)?;
        assert_complete(&actual)?;
        assert_eq!(actual.fingerprint()?, logical.fingerprint()?);
        rows[3]["message"]["content"][0]["tool_use_id"] = json!("missing");
        assert!(
            assert_complete(&codecs::decode_claude(
                &codecs::serialize_rows(&rows)?,
                true,
                false
            )?)
            .is_err()
        );
        Ok(())
    }
}
