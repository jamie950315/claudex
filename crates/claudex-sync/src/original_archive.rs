//! Native preservation proof for the exact direct spawned-agent archive tree.
//! Ordinary forks are read-only witnesses; no transcript writer lease is granted.
use crate::{dependencies, history::digest_bytes, native, native_history::Rpc};
use anyhow::{Result, ensure};
use claudex_core::{
    json::stringify,
    storage::{self, FileIdentity},
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, io::Read, path::Path};
use uuid::Uuid;
const MAX_BYTES: usize = 512 * 1024 * 1024;
const KINDS: &[&str] = &[
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
];
#[derive(Default)]
struct Budget {
    bytes: usize,
    api_bytes: usize,
}
pub fn archived(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str() == "archived_sessions")
}
fn hash(value: &Value) -> Result<String> {
    Ok(digest_bytes(stringify(value)?.as_bytes()))
}
fn file_proof(path: &Path, id: &str, budget: &mut Budget) -> Result<Value> {
    let physical = native::physical_rollout(path)?;
    let stored = storage::read_stable_with_limit(&physical, MAX_BYTES)?;
    ensure!(
        stored.identity.uid == storage::uid().to_string()
            && stored.identity.nlink == "1"
            && stored.identity.mode.parse::<u32>()? & 0o22 == 0,
        "Preserved archive transcript must be an owned single-link regular file without foreign writers."
    );
    let bytes = if physical.to_string_lossy().ends_with(".jsonl.zst") {
        let mut bytes = vec![];
        zstd::stream::read::Decoder::new(stored.bytes.as_slice())?
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        bytes
    } else {
        stored.bytes
    };
    budget.bytes = budget
        .bytes
        .checked_add(bytes.len())
        .ok_or_else(|| anyhow::anyhow!("Archive tree byte limit overflow."))?;
    ensure!(
        bytes.len() <= MAX_BYTES && budget.bytes <= MAX_BYTES && bytes.last() == Some(&b'\n'),
        "Preserved archive tree exceeds its byte limit or has incomplete native bytes."
    );
    let end = bytes.iter().position(|b| *b == b'\n').unwrap();
    ensure!(
        end <= 64 * 1024 * 1024,
        "Preserved archive header exceeds its byte limit."
    );
    let header: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes[..end]))?;
    ensure!(
        header["type"] == "session_meta" && header["payload"]["id"] == id,
        "Preserved archive transcript identity changed."
    );
    ensure!(
        FileIdentity::from_metadata(&fs::symlink_metadata(&physical)?) == stored.identity,
        "Preserved archive transcript changed during verification."
    );
    Ok(json!({"hash":digest_bytes(&bytes),"bytes":bytes.len()}))
}
async fn history_proof(
    client: &dyn Rpc,
    id: &str,
    budget: &mut Budget,
    completed_agents: bool,
) -> Result<Value> {
    let mut cursor = None;
    let mut cursors = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut digests = vec![];
    for index in 0..=256 {
        ensure!(
            index < 256,
            "Preserved archive native history exceeds its page limit."
        );
        let mut params =
            json!({"threadId":id,"itemsView":"full","sortDirection":"asc","limit":100});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = client.request("thread/turns/list", params).await?;
        budget.api_bytes += stringify(&page)?.len();
        ensure!(
            budget.api_bytes <= 64 * 1024 * 1024,
            "Preserved archive native history exceeds its byte limit."
        );
        let rows = page["data"]
            .as_array()
            .filter(|r| r.len() <= 100)
            .ok_or_else(|| {
                anyhow::anyhow!("Preserved archive full native history is unavailable.")
            })?;
        for turn in rows {
            let turn_id = turn["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!("Preserved archive native turn identity is malformed.")
                })?;
            let items = turn["items"]
                .as_array()
                .filter(|r| !r.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!("Preserved archive native history is incomplete.")
                })?;
            ensure!(
                ids.insert(turn_id.to_owned())
                    && matches!(
                        turn["status"].as_str(),
                        Some("completed" | "interrupted" | "failed")
                    )
                    && (!completed_agents
                        || turn["status"] == "completed" && turn["error"].is_null())
                    && turn["itemsView"] == "full"
                    && items.iter().all(|item| item["status"] != "inProgress"),
                "Preserved archive dependent history is incomplete or changed."
            );
            if completed_agents {
                let answer = items
                    .iter()
                    .rev()
                    .find(|item| item["type"] == "agentMessage");
                ensure!(
                    answer.is_some_and(|a| a["phase"] == "final_answer"
                        && a["text"].as_str().is_some_and(|s| !s.trim().is_empty())),
                    "Preserved archive spawned child lacks a completed final response."
                );
            }
            digests.push(json!(hash(turn)?));
            ensure!(
                ids.len() <= 25_000,
                "Preserved archive native history exceeds its turn limit."
            );
        }
        cursor = match page.get("nextCursor").filter(|v| !v.is_null()) {
            None => None,
            Some(next) => {
                let next = next
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or_else(|| {
                        anyhow::anyhow!("Preserved archive native cursor is malformed.")
                    })?;
                ensure!(
                    !rows.is_empty() && cursors.insert(next.to_owned()),
                    "Preserved archive native pagination repeated."
                );
                Some(next.to_owned())
            }
        };
        if cursor.is_none() {
            break;
        }
    }
    ensure!(
        !ids.is_empty(),
        "Preserved archive dependent history is empty."
    );
    Ok(json!({"historyDigest":hash(&json!(digests))?,"turnCount":ids.len()}))
}
pub async fn snapshot(client: &dyn Rpc, home: &Path, parent_id: &str, cwd: &str) -> Result<Value> {
    Uuid::parse_str(parent_id)?;
    let inventory = dependencies::metadata_for_parents(
        client,
        &[parent_id.into()],
        &dependencies::Direct(client),
    )
    .await?;
    let all = inventory.threads;
    let parent = all.get(parent_id).ok_or_else(|| {
        anyhow::anyhow!("Preserved original is absent from the native inventory.")
    })?;
    let children = all
        .values()
        .filter(|t| t["source"]["subAgent"]["thread_spawn"]["parent_thread_id"] == parent_id)
        .collect::<Vec<_>>();
    ensure!(
        children.len() <= 64,
        "Preserved archive spawned tree exceeds its identity limit."
    );
    for child in &children {
        for state in [false, true] {
            let page = client.request("thread/list", json!({"ancestorThreadId":child["id"],"archived":state,"sourceKinds":KINDS,"limit":1})).await?;
            ensure!(
                page["data"].as_array().is_some_and(|r| r.is_empty())
                    && page["nextCursor"].is_null(),
                "Nested spawned dependencies require separate verification."
            );
        }
    }
    let affected = std::iter::once(parent_id)
        .chain(children.iter().filter_map(|c| c["id"].as_str()))
        .collect::<BTreeSet<_>>();
    let mut forks = vec![];
    for thread in all.values() {
        let spawn = &thread["source"]["subAgent"]["thread_spawn"];
        if thread["id"] != parent_id
            && spawn["parent_thread_id"]
                .as_str()
                .is_some_and(|id| affected.contains(id) && id != parent_id)
        {
            anyhow::bail!("Nested spawned dependencies require separate verification.");
        }
        if thread["forkedFromId"]
            .as_str()
            .is_some_and(|id| affected.contains(id))
            && !(spawn["parent_thread_id"] == parent_id && thread["forkedFromId"] == parent_id)
        {
            ensure!(
                matches!(
                    thread["source"].as_str(),
                    Some("cli" | "vscode" | "exec" | "appServer")
                ),
                "A preserved dependent fork has unknown native ancestry."
            );
            forks.push(thread);
        }
    }
    ensure!(
        forks.len() <= 64,
        "Protected fork inventory exceeds its identity limit."
    );
    let preserved = forks
        .iter()
        .filter_map(|t| t["id"].as_str())
        .collect::<BTreeSet<_>>();
    let mut ordered = vec![parent];
    let mut children = children;
    children.sort_by_key(|t| t["id"].as_str());
    forks.sort_by_key(|t| t["id"].as_str());
    ordered.extend(children);
    ordered.extend(forks);
    let mut budget = Budget::default();
    let mut members = vec![];
    for thread in ordered {
        let id = thread["id"].as_str().unwrap();
        let keep = preserved.contains(id);
        ensure!(
            thread["status"]["type"] == "notLoaded",
            "The original and every dependent witness must be unloaded for preserved archival."
        );
        if !keep {
            ensure!(
                thread["cwd"] == cwd,
                "A spawned working directory differs from its preserved original."
            );
            if id != parent_id {
                let spawn = &thread["source"]["subAgent"]["thread_spawn"];
                ensure!(
                    spawn["parent_thread_id"] == parent_id
                        && spawn["depth"] == 1
                        && spawn["agent_path"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("/root/"))
                        && thread["forkedFromId"] == parent_id,
                    "An affected task is not a verified direct spawned child."
                );
            }
            ensure!(
                matches!(fs::symlink_metadata(home.join("sessions").join(id)), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
                "Auxiliary native data requires separate verification."
            );
        }
        let path = Path::new(
            thread["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Native archive path is missing."))?,
        );
        let physical = native::physical_rollout(path)?;
        native::safe_native_path(&physical, home)?;
        let raw = file_proof(path, id, &mut budget)?;
        let history = if id == parent_id {
            json!({})
        } else {
            history_proof(client, id, &mut budget, !keep).await?
        };
        let latest = client
            .request("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        ensure!(
            latest["thread"] == *thread,
            "Native archive metadata changed during verification."
        );
        ensure!(
            file_proof(path, id, &mut Budget::default())? == raw,
            "Native archive bytes changed during verification."
        );
        let mut member = json!({"id":id,"disposition":if keep {"preserve"} else {"archive"},"path":path,"cwd":thread["cwd"],"title":thread.get("name").unwrap_or(&Value::Null),"source":thread["source"],"forkedFromId":thread.get("forkedFromId").unwrap_or(&Value::Null),"archived":archived(path)});
        member
            .as_object_mut()
            .unwrap()
            .extend(raw.as_object().unwrap().clone());
        member
            .as_object_mut()
            .unwrap()
            .extend(history.as_object().unwrap().clone());
        members.push(member);
    }
    Ok(json!({"version":1,"parentId":parent_id,"members":members}))
}
pub fn compare(before: &Value, after: &Value, archived_outcome: bool) -> Result<()> {
    let old = before["members"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Preserved archive planned tree is malformed."))?;
    let current = after["members"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Preserved archive current tree is malformed."))?;
    ensure!(
        before["version"] == 1
            && after["version"] == 1
            && before["parentId"] == after["parentId"]
            && old.len() == current.len()
            && !old.is_empty(),
        "The exact planned archive tree changed."
    );
    for (a, b) in old.iter().zip(current) {
        let mut a_fields = a.clone();
        let mut b_fields = b.clone();
        a_fields["path"] = Value::Null;
        a_fields["archived"] = Value::Null;
        b_fields["path"] = Value::Null;
        b_fields["archived"] = Value::Null;
        ensure!(
            a_fields == b_fields,
            "An original or descendant changed; archive evidence was preserved."
        );
        if archived_outcome && a["disposition"] == "archive" {
            ensure!(
                b["archived"] == true,
                "Native archival is incomplete; do not resend automatically."
            );
        } else {
            ensure!(
                a["path"] == b["path"] && a["archived"] == b["archived"],
                "A native archive path or protected fork changed."
            );
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_archive_preserves_forks_and_every_history_proof() {
        let before = json!({"version":1,"parentId":"p","members":[{"id":"p","disposition":"archive","path":"/sessions/p","archived":false,"hash":"bytes"},{"id":"f","disposition":"preserve","path":"/sessions/f","archived":false,"historyDigest":"history"}]});
        let mut after = before.clone();
        after["members"][0]["path"] = json!("/archived_sessions/p");
        after["members"][0]["archived"] = json!(true);
        compare(&before, &after, true).unwrap();
        assert!(compare(&before, &after, false).is_err());
        after["members"][1]["archived"] = json!(true);
        assert!(compare(&before, &after, true).is_err());
    }
    #[test]
    fn byte_proof_requires_exact_native_identity_and_complete_owned_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("p.jsonl");
        let bytes = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"p\"}}\n";
        fs::write(&p, bytes).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            file_proof(&p, "p", &mut Budget::default()).unwrap()["hash"],
            digest_bytes(bytes)
        );
        assert!(file_proof(&p, "other", &mut Budget::default()).is_err());
        fs::hard_link(&p, t.path().join("alias")).unwrap();
        assert!(file_proof(&p, "p", &mut Budget::default()).is_err());
    }
}
