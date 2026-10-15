//! Independent, read-only proof of one native MCP start call and its exact receipt.
use crate::{archive, model::*};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

const MAX_RESULT: usize = 256 * 1024;
#[async_trait]
pub trait OriginClient: Send + Sync {
    /// Read-only native RPC. The caller owns initialization and connection closure.
    async fn request(&self, method: &str, params: Value) -> Result<Value>;
}
fn fail(code: &str) -> anyhow::Error {
    error(
        code,
        match code {
            "ORIGIN_PROOF_INVALID" => {
                "Native origin evidence does not match the original task request and receipt."
            }
            "ORIGIN_PROOF_BOUND_EXCEEDED" => "Native origin inspection exceeded its bounded scope.",
            _ => "Exact native origin evidence is unavailable; no notification is authorized.",
        },
    )
}
fn insist(yes: bool, code: &str) -> Result<()> {
    if yes { Ok(()) } else { Err(fail(code)) }
}
fn valid_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    })
}
fn uuid(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 36 && uuid::Uuid::parse_str(s).is_ok())
}
fn hex(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn null(v: &Value, key: &str) -> bool {
    v.get(key) == Some(&Value::Null)
}
fn bounded(v: &Value, max: usize) -> Result<()> {
    insist(
        claudex_core::json::stringify(v)?.len() <= max,
        "ORIGIN_PROOF_BOUND_EXCEEDED",
    )
}
fn normalized(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(c),
        }
    }
    out == path
        && path.to_str().is_some_and(|s| {
            !s.contains(['\0', '\r', '\n']) && !s.contains("//") && !s.ends_with('/') || s == "/"
        })
}
fn receipt(content: &Value) -> Result<Value> {
    let list = content
        .as_array()
        .ok_or_else(|| fail("ORIGIN_PROOF_INVALID"))?;
    insist(
        list.len() == 1 && list[0]["type"] == "text",
        "ORIGIN_PROOF_INVALID",
    )?;
    let text = list[0]["text"]
        .as_str()
        .ok_or_else(|| fail("ORIGIN_PROOF_INVALID"))?;
    insist(text.len() <= MAX_RESULT, "ORIGIN_PROOF_BOUND_EXCEEDED")?;
    serde_json::from_str(text).map_err(|_| fail("ORIGIN_PROOF_INVALID"))
}
fn verify_call(input: &Value, receipt: &Value, expected: &Value) -> Result<()> {
    insist(
        input.is_object()
            && receipt.is_object()
            && receipt["replayed"] != true
            && receipt["isError"] != true,
        "ORIGIN_PROOF_INVALID",
    )?;
    let call = json!({"method":"start","params":input});
    bounded(&call, MAX_RESULT)?;
    insist(
        hash_value(&call) == expected["expectedFingerprint"]
            && receipt == &expected["expectedReceipt"],
        "ORIGIN_PROOF_INVALID",
    )
}
fn desktop_primary(t: &Value) -> bool {
    null(t, "threadSource")
        && t["cliVersion"] == "0.160.0"
        && t["originator"] == "Codex Desktop"
        && t["source"] == "vscode"
        && t["canAcceptDirectInput"] == true
        && null(t, "forkedFromId")
        && null(t, "agentNickname")
        && null(t, "agentRole")
}
async fn metadata(client: &dyn OriginClient, input: &Value) -> Result<()> {
    let value = client
        .request(
            "thread/read",
            json!({"threadId":input["sessionId"],"includeTurns":false}),
        )
        .await?;
    let t = &value["thread"];
    insist(
        t["id"] == input["sessionId"]
            && t["sessionId"] == input["sessionId"]
            && t["cwd"] == input["cwd"]
            && null(t, "parentThreadId")
            && t["ephemeral"] == false
            && (t["threadSource"] == "user" || desktop_primary(t))
            && matches!(t["source"].as_str(), Some("cli" | "vscode" | "exec")),
        "ORIGIN_PROOF_UNAVAILABLE",
    )
}
async fn codex_proof(client: &dyn OriginClient, input: &Value) -> Result<()> {
    insist(valid_id(&input["turnId"]), "ORIGIN_PROOF_UNAVAILABLE")?;
    metadata(client, input).await?;
    let mut cursor = None;
    let mut cursors = BTreeSet::new();
    let mut found = false;
    let mut finished = false;
    for _ in 0..4 {
        let mut p = json!({"threadId":input["sessionId"],"turnId":input["turnId"],"limit":100,"sortDirection":"desc"});
        if let Some(c) = cursor {
            p["cursor"] = json!(c);
        }
        let page = client.request("thread/items/list", p).await?;
        bounded(&page, 4 * 1024 * 1024)?;
        let data = page["data"]
            .as_array()
            .ok_or_else(|| fail("ORIGIN_PROOF_INVALID"))?;
        insist(data.len() <= 100, "ORIGIN_PROOF_INVALID")?;
        for entry in data {
            insist(
                entry["turnId"] == input["turnId"] && entry["item"].is_object(),
                "ORIGIN_PROOF_INVALID",
            )?;
            let item = &entry["item"];
            if item["id"] != input["toolUseId"] {
                continue;
            }
            insist(
                !found
                    && item["type"] == "mcpToolCall"
                    && item["server"] == "claudex-work"
                    && item["tool"] == "claudex_start",
                "ORIGIN_PROOF_INVALID",
            )?;
            insist(item["status"] != "inProgress", "ORIGIN_PROOF_UNAVAILABLE")?;
            insist(
                item["status"] == "completed" && null(item, "error"),
                "ORIGIN_PROOF_INVALID",
            )?;
            insist(!item["result"].is_null(), "ORIGIN_PROOF_UNAVAILABLE")?;
            insist(
                item["result"].is_object() && item["result"]["isError"] != true,
                "ORIGIN_PROOF_INVALID",
            )?;
            let r = receipt(&item["result"]["content"])?;
            if !item["result"]["structuredContent"].is_null() {
                insist(
                    item["result"]["structuredContent"] == r,
                    "ORIGIN_PROOF_INVALID",
                )?;
            }
            verify_call(&item["arguments"], &r, input)?;
            found = true;
        }
        if null(&page, "nextCursor") {
            finished = true;
            break;
        }
        let next = page["nextCursor"]
            .as_str()
            .filter(|s| s.len() <= 4096)
            .ok_or_else(|| fail("ORIGIN_PROOF_INVALID"))?;
        insist(cursors.insert(next.to_owned()), "ORIGIN_PROOF_INVALID")?;
        cursor = Some(next.to_owned());
    }
    insist(finished, "ORIGIN_PROOF_BOUND_EXCEEDED")?;
    insist(found, "ORIGIN_PROOF_UNAVAILABLE")?;
    metadata(client, input).await
}
fn directory(path: &Path) -> Result<(u64, u64, u32, u32)> {
    let m = std::fs::symlink_metadata(path)?;
    insist(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == claudex_core::storage::uid()
            && m.mode() & 0o022 == 0
            && path.canonicalize()? == path,
        "ORIGIN_PROOF_UNAVAILABLE",
    )?;
    Ok((m.dev(), m.ino(), m.uid(), m.mode()))
}
fn claude_proof(home: &Path, input: &Value) -> Result<()> {
    insist(normalized(home), "ORIGIN_PROOF_UNAVAILABLE")?;
    let cwd = input["cwd"].as_str().unwrap();
    let project = cwd
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_string()
            } else {
                "-".repeat(c.len_utf16())
            }
        })
        .collect::<Vec<_>>()
        .concat();
    let parent = home.join("projects").join(project);
    let path = parent.join(format!("{}.jsonl", input["sessionId"].as_str().unwrap()));
    let dirs = [home.to_path_buf(), home.join("projects"), parent];
    let before = dirs
        .iter()
        .map(|d| directory(d))
        .collect::<Result<Vec<_>>>()?;
    insist(path.canonicalize()? == path, "ORIGIN_PROOF_UNAVAILABLE")?;
    let source = archive::private_read_text(&path, 16 * 1024 * 1024)?;
    for (d, b) in dirs.iter().zip(before) {
        insist(directory(d)? == b, "ORIGIN_PROOF_UNAVAILABLE")?;
    }
    insist(source.ends_with('\n'), "ORIGIN_PROOF_UNAVAILABLE")?;
    let rows = source
        .lines()
        .filter(|l| !l.is_empty())
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let projection = rows.iter().rposition(|r| r["type"] == "claudex-owner");
    let mut calls = vec![];
    let mut results = vec![];
    let mut by_id = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        insist(row.is_object(), "ORIGIN_PROOF_INVALID")?;
        if let Some(id) = row["uuid"].as_str() {
            insist(by_id.insert(id, row).is_none(), "ORIGIN_PROOF_INVALID")?;
        }
        for block in array(&row["message"]["content"]) {
            if block["type"] == "tool_use" && block["id"] == input["toolUseId"] {
                calls.push((index, row, block));
            } else if block["type"] == "tool_result" && block["tool_use_id"] == input["toolUseId"] {
                results.push((index, row, block));
            }
        }
    }
    insist(
        calls.len() == 1 && results.len() == 1,
        "ORIGIN_PROOF_UNAVAILABLE",
    )?;
    let call = &calls[0];
    let result = &results[0];
    insist(
        projection.is_none_or(|p| call.0 > p) && result.0 > call.0,
        "ORIGIN_PROOF_INVALID",
    )?;
    let primary = |r: &Value| {
        r["sessionId"] == input["sessionId"]
            && r["cwd"] == input["cwd"]
            && r["isSidechain"] == false
            && r["agentId"].as_str().is_none_or(str::is_empty)
    };
    insist(
        primary(call.1)
            && primary(result.1)
            && call.1["uuid"].is_string()
            && result.1["uuid"].is_string(),
        "ORIGIN_PROOF_INVALID",
    )?;
    insist(
        call.1["type"] == "assistant"
            && call.1["message"]["role"] == "assistant"
            && call.2["name"] == "mcp__claudex-work__claudex_start"
            && result.1["type"] == "user"
            && result.1["message"]["role"] == "user"
            && result.2["is_error"] != true
            && result.1["sourceToolAssistantUUID"] == call.1["uuid"],
        "ORIGIN_PROOF_INVALID",
    )?;
    let mut parent = result.1["parentUuid"].as_str();
    let mut linked = false;
    let mut seen = BTreeSet::new();
    for _ in 0..128 {
        let Some(p) = parent else { break };
        insist(seen.insert(p), "ORIGIN_PROOF_INVALID")?;
        if Some(p) == call.1["uuid"].as_str() {
            linked = true;
            break;
        }
        let row = by_id.get(p).ok_or_else(|| fail("ORIGIN_PROOF_INVALID"))?;
        insist(primary(row), "ORIGIN_PROOF_INVALID")?;
        parent = row["parentUuid"].as_str();
    }
    insist(linked, "ORIGIN_PROOF_INVALID")?;
    verify_call(&call.2["input"], &receipt(&result.2["content"])?, input)
}
pub async fn verify_origin(
    input: &Value,
    claude_home: &Path,
    codex: Option<&dyn OriginClient>,
) -> Result<Value> {
    let result=tokio::time::timeout(std::time::Duration::from_millis(1800),async{
        insist(input.is_object()&&matches!(input["provider"].as_str(),Some("codex"|"claude"))&&uuid(&input["sessionId"])
            &&input["cwd"].as_str().is_some_and(|s|normalized(Path::new(s)))&&valid_id(&input["toolUseId"])
            &&hex(&input["expectedFingerprint"])&&input["expectedReceipt"].is_object()&&uuid(&input["expectedReceipt"]["taskId"])
            &&hex(&input["expectedReceipt"]["originChallenge"])&&input["expectedReceipt"]["replayed"]!=true&&input["expectedReceipt"]["isError"]!=true,"ORIGIN_PROOF_INVALID")?;
        bounded(&input["expectedReceipt"],MAX_RESULT)?;
        if input["provider"]=="codex"{codex_proof(codex.ok_or_else(||fail("ORIGIN_PROOF_UNAVAILABLE"))?,input).await?;}else{claude_proof(claude_home,input)?;}
        let mut proof=json!({"provider":input["provider"],"sessionId":input["sessionId"],"cwd":input["cwd"],"toolUseId":input["toolUseId"],"source":if input["provider"]=="codex"{"codex-native-mcp-result"}else{"claude-native-mcp-result"},"verifiedAt":now()});if input["provider"]=="codex"{proof["turnId"]=input["turnId"].clone();}Ok::<_,anyhow::Error>(proof)
    }).await;
    match result {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e))
            if e.downcast_ref::<ProtocolError>().is_some_and(|e| {
                matches!(
                    e.code.as_str(),
                    "ORIGIN_PROOF_INVALID"
                        | "ORIGIN_PROOF_UNAVAILABLE"
                        | "ORIGIN_PROOF_BOUND_EXCEEDED"
                )
            }) =>
        {
            Err(e)
        }
        _ => Err(fail("ORIGIN_PROOF_UNAVAILABLE")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudex_core::storage;
    use std::{fs, os::unix::fs::PermissionsExt, sync::Mutex};

    fn input(provider: &str, cwd: &Path) -> (Value, Value, Value) {
        let args = json!({"provider":"claude","cwd":cwd,"prompt":"Inspect only the synthetic fixture.","requestId":"proof-fixture"});
        let receipt = json!({"taskId":"11111111-1111-4111-8111-111111111111","originChallenge":"a".repeat(64),"replayed":false});
        let input = json!({"provider":provider,"sessionId":"22222222-2222-4222-8222-222222222222","cwd":cwd,"toolUseId":"call-proof","turnId":"turn-proof","expectedFingerprint":hash_value(&json!({"method":"start","params":args})),"expectedReceipt":receipt});
        (input, args, receipt)
    }
    fn code(err: anyhow::Error) -> String {
        err.downcast_ref::<ProtocolError>()
            .map(|e| e.code.clone())
            .unwrap_or_else(|| err.to_string())
    }
    struct Codex {
        metadata: Value,
        page: Value,
        reads: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl OriginClient for Codex {
        async fn request(&self, method: &str, _params: Value) -> Result<Value> {
            self.reads.lock().unwrap().push(method.into());
            match method {
                "thread/read" => Ok(self.metadata.clone()),
                "thread/items/list" => Ok(self.page.clone()),
                _ => anyhow::bail!("Unexpected synthetic RPC"),
            }
        }
    }
    fn codex(input: &Value, args: &Value, receipt: &Value) -> Codex {
        Codex {
            metadata: json!({"thread":{"id":input["sessionId"],"sessionId":input["sessionId"],"cwd":input["cwd"],"parentThreadId":null,"ephemeral":false,"threadSource":"user","source":"exec"}}),
            page: json!({"data":[{"turnId":input["turnId"],"item":{"id":"unrelated","type":"future-native-kind"}},{"turnId":input["turnId"],"item":{"id":input["toolUseId"],"type":"mcpToolCall","server":"claudex-work","tool":"claudex_start","status":"completed","error":null,"arguments":args,"result":{"content":[{"type":"text","text":receipt.to_string()}],"structuredContent":receipt}}}],"nextCursor":null}),
            reads: Mutex::new(vec![]),
        }
    }
    #[tokio::test]
    async fn codex_exact_primary_call_requires_native_receipt_and_excludes_auxiliary_sources()
    -> Result<()> {
        let (i, args, receipt) = input("codex", Path::new("/fixture/project"));
        let client = codex(&i, &args, &receipt);
        let proof = verify_origin(&i, Path::new("/unused"), Some(&client)).await?;
        assert_eq!(proof["source"], "codex-native-mcp-result");
        assert_eq!(
            *client.reads.lock().unwrap(),
            vec!["thread/read", "thread/items/list", "thread/read"]
        );
        for kind in [
            "forged-arguments",
            "missing-result",
            "wrong-turn",
            "subagent",
            "ephemeral",
            "wrong-source",
            "result-contradiction",
        ] {
            let mut client = codex(&i, &args, &receipt);
            let expected = match kind {
                "forged-arguments" => {
                    client.page["data"][1]["item"]["arguments"]["prompt"] = json!("Forged prompt");
                    "ORIGIN_PROOF_INVALID"
                }
                "missing-result" => {
                    client.page["data"][1]["item"]["result"] = Value::Null;
                    "ORIGIN_PROOF_UNAVAILABLE"
                }
                "wrong-turn" => {
                    client.page["data"][1]["turnId"] = json!("ancestor-turn");
                    "ORIGIN_PROOF_INVALID"
                }
                "subagent" => {
                    client.metadata["thread"]["threadSource"] = json!("subAgent");
                    "ORIGIN_PROOF_UNAVAILABLE"
                }
                "ephemeral" => {
                    client.metadata["thread"]["ephemeral"] = json!(true);
                    "ORIGIN_PROOF_UNAVAILABLE"
                }
                "wrong-source" => {
                    client.metadata["thread"]["source"] = json!("unknown");
                    "ORIGIN_PROOF_UNAVAILABLE"
                }
                _ => {
                    client.page["data"][1]["item"]["result"]["structuredContent"]["taskId"] =
                        json!("33333333-3333-4333-8333-333333333333");
                    "ORIGIN_PROOF_INVALID"
                }
            };
            assert_eq!(
                code(
                    verify_origin(&i, Path::new("/unused"), Some(&client))
                        .await
                        .unwrap_err()
                ),
                expected,
                "{kind}"
            );
        }
        Ok(())
    }
    fn claude_rows(i: &Value, args: &Value, r: &Value) -> Vec<Value> {
        vec![
            json!({"type":"assistant","uuid":"call-row","parentUuid":null,"sessionId":i["sessionId"],"cwd":i["cwd"],"isSidechain":false,"message":{"role":"assistant","content":[{"type":"tool_use","id":i["toolUseId"],"name":"mcp__claudex-work__claudex_start","input":args}]}}),
            json!({"type":"user","uuid":"result-row","parentUuid":"call-row","sourceToolAssistantUUID":"call-row","sessionId":i["sessionId"],"cwd":i["cwd"],"isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":i["toolUseId"],"content":[{"type":"text","text":r.to_string()}]}]}}),
        ]
    }
    #[tokio::test]
    async fn claude_exact_local_proof_preserves_primary_and_import_boundaries() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let base = temp.path().canonicalize()?;
        let home = base.join("claude");
        let project = home.join("projects/-fixture-project");
        fs::create_dir_all(&project)?;
        for d in [&home, &home.join("projects"), &project] {
            fs::set_permissions(d, fs::Permissions::from_mode(0o755))?;
        }
        let (i, args, r) = input("claude", Path::new("/fixture/project"));
        let path = project.join(format!("{}.jsonl", i["sessionId"].as_str().unwrap()));
        let write = |rows: &[Value]| -> Result<()> {
            storage::atomic_write(
                &path,
                format!(
                    "{}\n",
                    rows.iter()
                        .map(Value::to_string)
                        .collect::<Vec<_>>()
                        .join("\n")
                ),
            )
        };
        let rows = claude_rows(&i, &args, &r);
        write(&rows)?;
        assert_eq!(
            verify_origin(&i, &home, None).await?["source"],
            "claude-native-mcp-result"
        );
        for kind in [
            "missing",
            "forged",
            "imported",
            "agent",
            "parent",
            "provenance",
        ] {
            let mut rows = claude_rows(&i, &args, &r);
            let expected = match kind {
                "missing" => {
                    rows.pop();
                    "ORIGIN_PROOF_UNAVAILABLE"
                }
                "forged" => {
                    rows[0]["message"]["content"][0]["input"]["requestId"] = json!("forged");
                    "ORIGIN_PROOF_INVALID"
                }
                "imported" => {
                    rows.push(json!({"type":"claudex-owner","generation":1}));
                    "ORIGIN_PROOF_INVALID"
                }
                "agent" => {
                    rows[0]["isSidechain"] = json!(true);
                    "ORIGIN_PROOF_INVALID"
                }
                "parent" => {
                    rows[1]["parentUuid"] = json!("absent-row");
                    "ORIGIN_PROOF_INVALID"
                }
                _ => {
                    rows[1]["sourceToolAssistantUUID"] = json!("copied-call");
                    "ORIGIN_PROOF_INVALID"
                }
            };
            write(&rows)?;
            assert_eq!(
                code(verify_origin(&i, &home, None).await.unwrap_err()),
                expected,
                "{kind}"
            );
        }
        let mut rows = claude_rows(&i, &args, &r);
        rows.insert(0, json!({"type":"claudex-owner","generation":1}));
        write(&rows)?;
        assert!(
            verify_origin(&i, &home, None).await.is_ok(),
            "A fresh primary call after bootstrap remains eligible"
        );
        fs::set_permissions(&project, fs::Permissions::from_mode(0o777))?;
        assert_eq!(
            code(verify_origin(&i, &home, None).await.unwrap_err()),
            "ORIGIN_PROOF_UNAVAILABLE"
        );
        Ok(())
    }
}
