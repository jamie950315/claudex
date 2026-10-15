//! Native chat metadata and exact title proofs; never scans authored messages,
//! resumes a task, or enrolls an identity from its title alone.
use crate::{desktop_mapping, native_history::Rpc};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use uuid::Uuid;
const SOURCES: &[&str] = &["cli", "vscode", "exec"];
fn valid_title(title: &str) -> bool {
    !title.trim().is_empty()
        && title.encode_utf16().count() <= 4096
        && !title.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
pub async fn discover_codex(
    client: &dyn Rpc,
    query: Option<&str>,
    session_id: Option<&str>,
) -> Result<Vec<Value>> {
    if let Some(query) = query {
        ensure!(
            !query.trim().is_empty() && query.len() <= 4096 && !query.contains('\0'),
            "Invalid native title query."
        );
    }
    let mut target_name = None;
    if let Some(id) = session_id {
        Uuid::parse_str(id)?;
        let result = client
            .request("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        let target = &result["thread"];
        if target["id"] != id
            || !target["name"].as_str().is_some_and(valid_title)
            || !target["source"]
                .as_str()
                .is_some_and(|s| SOURCES.contains(&s))
        {
            return Ok(vec![]);
        }
        target_name = target["name"].as_str().map(str::to_owned);
    }
    let mut params =
        json!({"limit":100,"archived":false,"useStateDbOnly":true,"sourceKinds":SOURCES});
    if let Some(search) = target_name.as_deref().or(query) {
        params["searchTerm"] = json!(search);
    }
    let result = client.request("thread/list", params).await?;
    ensure!(
        result["nextCursor"].is_null(),
        "NATIVE_CHAT_DISCOVERY_INCOMPLETE: Native chat discovery is incomplete; use a longer, more specific title query before sending."
    );
    let rows = result["data"]
        .as_array()
        .filter(|rows| rows.len() <= 100)
        .ok_or_else(|| anyhow::anyhow!("Malformed native chat metadata inventory."))?;
    Ok(rows.iter().filter(|t|t.is_object()&&t["id"].as_str().is_some_and(|id|Uuid::parse_str(id).is_ok()&&session_id.is_none_or(|target|id==target))
        &&t["name"].as_str().is_some_and(valid_title)&&t["cwd"].as_str().is_some_and(|s|Path::new(s).is_absolute())
        &&t["archived"]!=true&&t["source"].as_str().is_some_and(|s|SOURCES.contains(&s)))
        .map(|t|json!({"provider":"codex","nativeId":t["id"],"sessionId":t["id"],"chatId":format!("codex:{}",t["id"].as_str().unwrap()),
            "cwd":t["cwd"],"title":t["name"],"titleSource":"codex-native-metadata","phase":"unregistered","registeredByHook":false})).collect())
}
struct Title {
    title: String,
    time: i64,
    ambiguous: bool,
}
fn codex_titles(home: &Path, wanted: &BTreeSet<String>) -> Result<BTreeMap<String, Title>> {
    ensure!(
        home.is_absolute() && fs::canonicalize(home)? == home,
        "Codex metadata root must be canonical."
    );
    let before = fs::symlink_metadata(home)?;
    ensure!(
        before.is_dir() && !before.file_type().is_symlink() && before.uid() == storage::uid(),
        "Codex metadata root is not an owned directory."
    );
    let data = storage::read_stable_with_limit(home.join("session_index.jsonl"), 32 * 1024 * 1024)?;
    ensure!(
        data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && FileIdentity::from_metadata(&before)
                == FileIdentity::from_metadata(&fs::symlink_metadata(home)?)
            && fs::canonicalize(home)? == home,
        "Codex title metadata changed or has unsafe ownership."
    );
    let content = String::from_utf8_lossy(&data.bytes);
    let lines = content
        .trim_end_matches('\n')
        .split('\n')
        .collect::<Vec<_>>();
    ensure!(
        lines.len() <= 100_000,
        "Codex session index exceeds its line limit."
    );
    let mut result = BTreeMap::<String, Title>::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line)?;
        let Some(id) = row["id"]
            .as_str()
            .map(str::to_lowercase)
            .filter(|id| wanted.contains(id))
        else {
            continue;
        };
        let title = row["thread_name"]
            .as_str()
            .filter(|s| valid_title(s))
            .ok_or_else(|| anyhow::anyhow!("Codex session index lacks a valid title."))?;
        let time = chrono::DateTime::parse_from_rfc3339(row["updated_at"].as_str().unwrap_or(""))?
            .timestamp_millis();
        match result.get_mut(&id) {
            Some(previous) if time == previous.time && title != previous.title => {
                previous.ambiguous = true
            }
            Some(previous) if time <= previous.time => (),
            _ => {
                result.insert(
                    id,
                    Title {
                        title: title.into(),
                        time,
                        ambiguous: false,
                    },
                );
            }
        }
    }
    Ok(result)
}
pub fn enrich_titles(
    chats: &[Value],
    codex_home: &Path,
    desktop_registry: &Path,
) -> Result<Vec<Value>> {
    ensure!(
        chats.iter().all(Value::is_object),
        "Native chat metadata must be objects."
    );
    ensure!(chats.len() <= 4096, "Native title identity bound exceeded.");
    let mut result = chats
        .iter()
        .map(|chat| {
            let mut value = chat.clone();
            value["title"] = Value::Null;
            value["titleSource"] = Value::Null;
            if let Some(map) = value.as_object_mut() {
                map.remove("titleError");
                map.remove("archived");
            }
            if !chat["nativeId"].is_null()
                && !chat["sessionId"].is_null()
                && chat["nativeId"] != chat["sessionId"]
            {
                value["titleError"] = json!("Registered chat identities disagree.");
            }
            value
        })
        .collect::<Vec<_>>();
    for provider in ["codex", "claude"] {
        let selected = result
            .iter()
            .enumerate()
            .filter_map(|(index, chat)| {
                let id = chat
                    .get("nativeId")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&chat["sessionId"])
                    .as_str()?;
                (chat["provider"] == provider
                    && chat["titleError"].is_null()
                    && Uuid::parse_str(id).is_ok())
                .then_some((index, id.to_lowercase()))
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }
        let wanted = selected
            .iter()
            .map(|(_, id)| id.clone())
            .collect::<BTreeSet<_>>();
        let metadata = (|| -> Result<BTreeMap<String, Value>> {
            if provider == "codex" {
                return Ok(codex_titles(codex_home, &wanted)?
                    .into_iter()
                    .map(|(id, t)| (id, json!({"title":t.title,"ambiguous":t.ambiguous})))
                    .collect());
            }
            desktop_mapping::mappings(desktop_registry, &wanted.into_iter().collect::<Vec<_>>())
        })();
        let metadata = match metadata {
            Ok(metadata) => metadata,
            Err(e) => {
                for (index, _) in selected {
                    result[index]["titleError"] = json!(if storage::is_not_found(&e) {
                        format!("{provider} title metadata is unavailable.")
                    } else {
                        e.to_string()
                    });
                }
                continue;
            }
        };
        for (index, id) in selected {
            let chat = &mut result[index];
            let Some(entry) = metadata.get(&id) else {
                chat["titleError"] = json!(format!(
                    "{provider} title metadata has no matching native session."
                ));
                continue;
            };
            if !entry["error"].is_null() {
                chat["titleError"] = entry["error"].clone();
                continue;
            }
            if entry["ambiguous"] == true {
                chat["titleError"] =
                    json!("Conflicting Codex titles have the same update timestamp.");
                continue;
            }
            chat["title"] = entry["title"].clone();
            chat["titleSource"] = json!(if provider == "codex" {
                "codex-session-index"
            } else {
                "claude-desktop-registry"
            });
            if provider == "claude" {
                chat["archived"] = entry["isArchived"].clone();
                if entry["cwd"] != chat["cwd"] {
                    chat["titleError"] = json!(
                        "Desktop project differs from registered chat; refresh native hook registration."
                    );
                }
            }
        }
    }
    Ok(result)
}
