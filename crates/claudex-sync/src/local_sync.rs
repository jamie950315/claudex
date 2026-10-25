//! At-most-once no-query delivery through the native Local command handler.
//! Journals authenticate normalization; native histories are never rewritten.
use crate::{
    desktop::{Pending, Record},
    desktop_mapping,
    history::digest_bytes,
    hooks, owner, packet,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
/// Local preserves the user's configured native account and provider. Remote
/// Control remains an explicit alternative and existing remote owners retain it.
pub fn configured_transport(root: &Path) -> Result<String> {
    let c = storage::read_json_or(root.join("config.json"), Value::Null)?;
    let transport = match c.get("claudeDesktopTransport") {
        None => "local-mod",
        Some(value) => value.as_str().ok_or_else(|| {
            anyhow::anyhow!("Claude Desktop transport must be local-mod or remote-control.")
        })?,
    };
    ensure!(
        matches!(transport, "local-mod" | "remote-control"),
        "Unsupported Claude Desktop transport."
    );
    Ok(transport.into())
}
const LIMIT: usize = packet::MAX_PACKET_BYTES + 1024 * 1024;
const CAVEAT: &str = "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";
fn id(v: &Value, key: &str) -> Result<String> {
    let s = v[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing Local synchronization identity: {key}."))?;
    Uuid::parse_str(s)?;
    Ok(s.into())
}
fn read(path: &Path) -> Result<Value> {
    let f = storage::read_stable_with_limit(path, LIMIT)?;
    ensure!(
        f.identity.uid == storage::uid().to_string()
            && f.identity.nlink == "1"
            && f.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Local synchronization metadata must be private, owned and single-link."
    );
    Ok(serde_json::from_slice(&f.bytes)?)
}
fn directory(root: &Path) -> Result<PathBuf> {
    storage::require_private_directory(root)?;
    ensure!(
        fs::canonicalize(root)? == root,
        "Local synchronization root must be canonical."
    );
    let d = root.join("local-sync");
    storage::private_directory(&d)?;
    storage::require_private_directory(&d)?;
    ensure!(
        fs::canonicalize(&d)? == d,
        "Local synchronization directory is aliased."
    );
    Ok(d)
}
fn path(root: &Path, op: &str) -> Result<PathBuf> {
    Uuid::parse_str(op)?;
    let d = directory(root)?.join(op);
    storage::require_private_directory(&d)?;
    ensure!(
        fs::canonicalize(&d)? == d,
        "Local synchronization operation is aliased."
    );
    Ok(d.join("operation.json"))
}
fn journal(root: &Path, op: &str) -> Result<Value> {
    let j = read(&path(root, op)?)?;
    ensure!(
        j["version"] == 1
            && j["opId"] == op
            && matches!(j["kind"].as_str(), Some("adopt" | "append"))
            && j["received"].is_boolean(),
        "Invalid Local synchronization journal."
    );
    for key in [
        "opId",
        "sourceOperationId",
        "conversationId",
        "cliSessionId",
    ] {
        id(&j, key)?;
    }
    let cwd = j["cwd"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing Local working directory."))?;
    ensure!(
        Path::new(cwd).is_absolute()
            && Path::new(cwd).components().all(|c| matches!(
                c,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )),
        "Local working directory is unavailable or aliased."
    );
    let e = &j["entry"];
    ensure!(
        packet::exact_keys(
            e,
            &[
                "opId",
                "conversationId",
                "localSessionId",
                "cliSessionId",
                "cwd",
                "title",
                "command",
                "args",
                "inputUuid",
                "expiresAt",
                "registryPath",
                "images"
            ]
        ) && e["opId"] == j["opId"]
            && e["conversationId"] == j["conversationId"]
            && e["cliSessionId"] == j["cliSessionId"]
            && e["cwd"] == j["cwd"]
            && e["command"] == "claudex-sync"
            && e["args"] == op
            && e["inputUuid"] == owner::append_uuid(j["cliSessionId"].as_str().unwrap(), op)
            && e["localSessionId"]
                .as_str()
                .and_then(|s| s.strip_prefix("local_"))
                .is_some_and(|s| Uuid::parse_str(s).is_ok())
            && e["expiresAt"].is_i64()
            && e["registryPath"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute()),
        "Invalid Local published intent."
    );
    let content = j["content"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing Local packet content."))?;
    let mut images = vec![];
    for block in content {
        if block["type"] == "image" {
            packet::validate_image(block)?;
            images.push(json!({"path":root.join("local-sync").join(op).join(format!("image-{}.json",images.len())),"mimeType":block["source"]["media_type"]}));
        } else {
            ensure!(
                packet::exact_keys(block, &["type", "text"])
                    && block["type"] == "text"
                    && block["text"].is_string(),
                "Invalid Local text block."
            );
        }
    }
    ensure!(
        e["images"] == json!(images) && (j["kind"] != "adopt" || content.is_empty()),
        "Local image manifest differs from exact packet order."
    );
    if !j["claim"].is_null() {
        id(&j["claim"], "id")?;
    }
    if j["received"] == true {
        ensure!(
            !j["claim"].is_null()
                && j["pluginName"].as_str().is_some_and(|s| !s.is_empty()
                    && s.len() < 256
                    && !s.chars().any(char::is_control)),
            "Invalid Local receive receipt."
        );
    }
    if !j["applied"].is_null() {
        ensure!(
            j["received"] == true,
            "Local application lacks receive proof."
        );
        if j["kind"] == "append" {
            id(&j["applied"], "textUuid")?;
        } else {
            ensure!(
                j["applied"]["textUuid"].is_null(),
                "Adoption cannot append content."
            );
        }
    }
    Ok(j)
}
fn owner_path(root: &Path, conversation: &str) -> PathBuf {
    root.join("owners")
        .join(format!("{}.json", digest_bytes(conversation.as_bytes())))
}
fn authority(root: &Path, registry: &Path, j: &Value) -> Result<Value> {
    ensure!(
        !hooks::app_stopped(root)?,
        "Claudex application is stopped."
    );
    let ledger = read(&root.join("desktop-state.json"))?;
    ensure!(
        ledger["version"] == 2
            && ledger["pending"]["operationId"] == j["sourceOperationId"]
            && ledger["pending"]["record"]["nativeId"] == j["cliSessionId"]
            && ledger["pending"]["record"]["conversationId"] == j["conversationId"],
        "Local synchronization is not the current durable transaction."
    );
    let op = owner_path(root, j["conversationId"].as_str().unwrap());
    let o =
        owner::owned_state(&op)?.ok_or_else(|| anyhow::anyhow!("Local owner metadata missing."))?;
    ensure!(
        o["sessionId"] == j["cliSessionId"]
            && o["cwd"] == j["cwd"]
            && o["transport"] == "local-mod"
            && if j["kind"] == "adopt" {
                matches!(
                    o["localPhase"].as_str(),
                    Some("handoff-intent" | "handoff-sent" | "adopted")
                )
            } else {
                o["localPhase"] == "adopted"
            }
            && o["remoteId"].is_null()
            && o["pending"].is_null()
            && o["reset"].is_null()
            && !PathBuf::from(format!("{}.lock", op.display())).try_exists()?,
        "Local native writer ownership is not established."
    );
    let mappings =
        desktop_mapping::mappings(registry, &[j["cliSessionId"].as_str().unwrap().into()])?;
    let m = mappings
        .get(j["cliSessionId"].as_str().unwrap())
        .ok_or_else(|| anyhow::anyhow!("Awaiting native Desktop adoption."))?;
    ensure!(
        m["cwd"] == j["cwd"]
            && m["isArchived"] == false
            && m["sessionId"] == j["entry"]["localSessionId"]
            && m["registryPath"] == j["entry"]["registryPath"],
        "Native Local target identity changed."
    );
    Ok(o)
}
fn publish(root: &Path, entry: &Value) -> Result<()> {
    let p = root.join("local-sync-manifest.json");
    let mut m = match read(&p) {
        Ok(v) => v,
        Err(e) if storage::is_not_found(&e) => json!({"version":1,"entries":[]}),
        Err(e) => return Err(e),
    };
    ensure!(
        packet::exact_keys(&m, &["version", "entries"]) && m["version"] == 1,
        "Invalid Local synchronization manifest."
    );
    let rows = m["entries"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid Local manifest entries."))?;
    if let Some(old) = rows.iter().find(|v| v["opId"] == entry["opId"]) {
        if old != entry {
            let mut previous = old.clone();
            previous["expiresAt"] = entry["expiresAt"].clone();
            let j = journal(
                root,
                entry["opId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing Local operation identity."))?,
            )?;
            ensure!(
                previous == *entry
                    && j["claim"].is_null()
                    && old["expiresAt"]
                        .as_i64()
                        .zip(entry["expiresAt"].as_i64())
                        .is_some_and(|(a, b)| a < b),
                "Published Local intent changed after claim."
            );
            let index = rows
                .iter()
                .position(|v| v["opId"] == entry["opId"])
                .unwrap();
            rows[index] = entry.clone();
        }
    } else {
        ensure!(rows.len() < 64, "Local manifest capacity reached.");
        rows.push(entry.clone());
    }
    storage::write_json(p, &m)
}
/// Prepare once. Adoption uses a separate operation identity and never resends
/// the already persisted seed packet or its images.
pub fn prepare(
    root: &Path,
    registry: &Path,
    r: &Record,
    p: &Pending,
    content: &[Value],
    adoption: bool,
) -> Result<String> {
    let d = directory(root)?;
    let _guard = FileLock::acquire(d.join(".lock"), true)?;
    let op = if adoption {
        owner::append_uuid(&r.native_id, &format!("local-adopt:{}", p.operation_id))
    } else {
        p.operation_id.clone()
    };
    let dir = d.join(&op);
    storage::private_directory(&dir)?;
    storage::require_private_directory(&dir)?;
    let file = dir.join("operation.json");
    if let Ok(mut j) = journal(root, &op) {
        ensure!(
            j["sourceOperationId"] == p.operation_id
                && j["cliSessionId"] == r.native_id
                && j["conversationId"] == r.conversation_id
                && j["cwd"] == r.cwd
                && j["content"] == json!(if adoption { &[][..] } else { content }),
            "Local operation identity reused with different content."
        );
        if j["claim"].is_null()
            && j["entry"]["expiresAt"]
                .as_i64()
                .is_some_and(|n| n <= storage::now_ms())
        {
            j["entry"]["expiresAt"] = json!(storage::now_ms() + 600_000);
            storage::write_json(&file, &j)?;
        }
        publish(root, &j["entry"])?;
        return Ok(op);
    } else if file.try_exists()? {
        anyhow::bail!("Unsafe Local operation metadata.");
    }
    let mappings = desktop_mapping::mappings(registry, &[r.native_id.clone()])?;
    let m = mappings.get(&r.native_id).ok_or_else(|| {
        anyhow::anyhow!("Awaiting native Desktop adoption; saved operation remains pending.")
    })?;
    ensure!(
        m["cwd"] == r.cwd && m["isArchived"] == false,
        "Local adoption identity mismatch."
    );
    let mut images = vec![];
    for b in if adoption { &[][..] } else { content } {
        if b["type"] == "image" {
            packet::validate_image(b)?;
            let image = json!({"mimeType":b["source"]["media_type"],"base64":b["source"]["data"]});
            let bytes = serde_json::to_vec(&image)?;
            ensure!(
                bytes.len() < 4 * 1024 * 1024,
                "Native Local image input exceeds its 4 MiB read bound."
            );
            let path = dir.join(format!("image-{}.json", images.len()));
            match read(&path) {
                Ok(saved) => ensure!(saved == image, "Prepared Local image input changed."),
                Err(e) if storage::is_not_found(&e) => storage::publish_exclusive(&path, &bytes)?,
                Err(e) => return Err(e),
            }
            images.push(json!({"path":path,"mimeType":b["source"]["media_type"]}));
        } else {
            ensure!(
                packet::exact_keys(b, &["type", "text"]) && b["type"] == "text",
                "Unsupported Local packet block."
            );
        }
    }
    let entry = json!({"opId":op,"conversationId":r.conversation_id,"localSessionId":m["sessionId"],"cliSessionId":r.native_id,"cwd":r.cwd,"title":r.extra.get("title").and_then(Value::as_str).unwrap_or("Claudex conversation"),"command":"claudex-sync","args":op,"inputUuid":owner::append_uuid(&r.native_id,&op),"expiresAt":storage::now_ms()+600_000,"registryPath":m["registryPath"],"images":images});
    let j = json!({"version":1,"opId":op,"sourceOperationId":p.operation_id,"conversationId":r.conversation_id,"cliSessionId":r.native_id,"cwd":r.cwd,"kind":if adoption{"adopt"}else{"append"},"entry":entry,"content":if adoption{&[][..]}else{content},"claim":null,"received":false,"applied":null});
    authority(root, registry, &j)?;
    storage::write_json(&file, &j)?;
    publish(root, &entry)?;
    Ok(op)
}
fn identities(j: &Value, p: &Value) -> Result<()> {
    ensure!(
        p["opId"] == j["opId"]
            && p["cliSessionId"] == j["cliSessionId"]
            && p["cwd"] == j["cwd"]
            && p["localSessionId"] == j["entry"]["localSessionId"],
        "Local synchronization request target mismatch."
    );
    Ok(())
}
pub fn claim(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "localSessionId", "cliSessionId", "cwd"]),
        "Invalid Local claim fields."
    );
    let op = id(p, "opId")?;
    let d = directory(root)?;
    let _lock = FileLock::acquire(d.join(".lock"), true)?;
    let file = path(root, &op)?;
    let mut j = journal(root, &op)?;
    identities(&j, p)?;
    if !j["claim"].is_null() {
        return Ok(json!({"ready":false}));
    }
    authority(root, registry, &j)?;
    ensure!(
        j["entry"]["expiresAt"]
            .as_i64()
            .is_some_and(|n| n > storage::now_ms()),
        "Local synchronization intent expired before dispatch."
    );
    let token = Uuid::new_v4().to_string();
    j["claim"] = json!({"id":token,"at":storage::now_ms(),"outcome":null});
    storage::write_json(&file, &j)?;
    Ok(
        json!({"ready":true,"claimId":token,"opId":op,"localSessionId":j["entry"]["localSessionId"],"cliSessionId":j["cliSessionId"],"cwd":j["cwd"],"command":"claudex-sync","args":op,"inputUuid":j["entry"]["inputUuid"],"images":j["entry"]["images"]}),
    )
}
pub fn receipt(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(
            p,
            &[
                "opId",
                "localSessionId",
                "cliSessionId",
                "cwd",
                "claimId",
                "outcome",
                "detail"
            ]
        ),
        "Invalid Local dispatch receipt."
    );
    let op = id(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let file = path(root, &op)?;
    let mut j = journal(root, &op)?;
    identities(&j, p)?;
    ensure!(
        p["claimId"] == j["claim"]["id"] && p["claimId"].is_string(),
        "Local dispatch claim mismatch."
    );
    let detail = match p["outcome"].as_str() {
        Some("submitted") => "native-send-returned",
        Some("unknown") => "native-send-unknown",
        Some("rejected") => "authority-changed",
        _ => anyhow::bail!("Invalid Local dispatch outcome."),
    };
    ensure!(p["detail"] == detail, "Invalid Local dispatch detail.");
    let value = json!({"outcome":p["outcome"],"detail":detail});
    ensure!(
        j["claim"]["outcome"].is_null() || j["claim"]["outcome"] == value,
        "Local dispatch outcome changed."
    );
    j["claim"]["outcome"] = value;
    storage::write_json(file, &j)?;
    Ok(json!({"recorded":true}))
}
/// Called only by the native non-immediate command. Consumes before returning
/// text; a lost helper reply cannot result in a second native append.
pub fn receive(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "claimId", "sessionId", "cwd", "pluginName"]),
        "Invalid Local receive request."
    );
    let op = id(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let file = path(root, &op)?;
    let mut j = journal(root, &op)?;
    ensure!(
        p["claimId"] == j["claim"]["id"]
            && p["claimId"].is_string()
            && p["sessionId"] == j["cliSessionId"]
            && p["cwd"] == j["cwd"]
            && p["pluginName"].as_str().is_some_and(|s| !s.is_empty()
                && s.len() < 256
                && !s.chars().any(char::is_control)),
        "Local receive ownership mismatch."
    );
    authority(root, registry, &j)?;
    ensure!(
        j["received"] == false,
        "Local receive already consumed; uncertain native writes are never replayed."
    );
    j["received"] = json!(true);
    j["pluginName"] = p["pluginName"].clone();
    storage::write_json(file, &j)?;
    let text: Vec<_> = j["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "text")
        .cloned()
        .collect();
    Ok(json!({"ready":true,"kind":j["kind"],"content":text}))
}
pub fn applied(root: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "claimId", "sessionId", "cwd", "textUuid"]),
        "Invalid Local applied receipt."
    );
    let op = id(p, "opId")?;
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let file = path(root, &op)?;
    let mut j = journal(root, &op)?;
    ensure!(
        j["received"] == true
            && p["claimId"] == j["claim"]["id"]
            && p["claimId"].is_string()
            && p["sessionId"] == j["cliSessionId"]
            && p["cwd"] == j["cwd"],
        "Local applied ownership mismatch."
    );
    if j["kind"] == "append" {
        id(p, "textUuid")?;
    } else {
        ensure!(
            p["textUuid"].is_null(),
            "Adoption must not append seed content."
        );
    }
    let v = json!({"textUuid":p["textUuid"]});
    ensure!(
        j["applied"].is_null() || j["applied"] == v,
        "Local native append receipt changed."
    );
    j["applied"] = v;
    storage::write_json(file, &j)?;
    Ok(json!({"recorded":true}))
}
fn one<'a>(rows: &'a [Value], uuid: &Value) -> Result<&'a Value> {
    let found: Vec<_> = rows.iter().filter(|r| &r["uuid"] == uuid).collect();
    ensure!(
        found.len() == 1,
        "Local native write missing or duplicated; preserve pending transaction."
    );
    Ok(found[0])
}
fn verified(j: &Value, rows: &[Value]) -> Result<Vec<String>> {
    ensure!(
        !j["applied"].is_null(),
        "Awaiting native Local command acknowledgement; never replay."
    );
    let command = one(rows, &j["entry"]["inputUuid"])?;
    let args = format!(
        "{} {}",
        j["opId"].as_str().unwrap(),
        j["claim"]["id"].as_str().unwrap()
    );
    let command_text = format!(
        "<command-name>/claudex-sync</command-name>\n            <command-message>claudex-sync</command-message>\n            <command-args>{args}</command-args>"
    );
    let mut expected: Vec<_> = j["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["type"] == "image")
        .cloned()
        .collect();
    expected.push(json!({"type":"text","text":command_text}));
    ensure!(
        command["type"] == "user"
            && command["sessionId"] == j["cliSessionId"]
            && command["cwd"] == j["cwd"]
            && command["message"]["role"] == "user"
            && owner::normalize_content(&command["message"]["content"])? == json!(expected),
        "Native Local command or ordered image input differs from durable intent."
    );
    let caveat = one(rows, &command["parentUuid"])?;
    id(caveat, "uuid")?;
    ensure!(
        caveat["type"] == "user"
            && caveat["isMeta"] == true
            && caveat["sessionId"] == j["cliSessionId"]
            && caveat["message"]["content"] == json!(CAVEAT),
        "Native Local command caveat differs from native proof."
    );
    let stdout: Vec<_> = rows
        .iter()
        .filter(|r| {
            r["parentUuid"] == command["uuid"]
                && r["type"] == "system"
                && r["subtype"] == "local_command"
        })
        .collect();
    ensure!(
        stdout.len() == 1,
        "Local command completion missing or duplicated."
    );
    let out = stdout[0];
    id(out, "uuid")?;
    ensure!(
        out["commandRun"] == json!({"command":"claudex-sync","args":args,"plugin":j["pluginName"]})
            && out["content"]
                == format!(
                    "<local-command-stdout>{}: CLAUDEX_SYNC_APPLIED {}</local-command-stdout>",
                    j["pluginName"].as_str().unwrap(),
                    j["opId"].as_str().unwrap()
                ),
        "Native Local command completion differs from receipt."
    );
    let mut remove = vec![
        command["uuid"].as_str().unwrap().into(),
        caveat["uuid"].as_str().unwrap().into(),
        out["uuid"].as_str().unwrap().into(),
    ];
    if j["kind"] == "append" {
        let text = one(rows, &j["applied"]["textUuid"])?;
        let expected: Vec<_> = j["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|b| b["type"] == "text")
            .cloned()
            .collect();
        ensure!(
            text["type"] == "user"
                && text["message"]["role"] == "user"
                && text["isMeta"] == true
                && text["sessionId"] == j["cliSessionId"]
                && text["cwd"] == j["cwd"]
                && text["origin"]["kind"] == "plugin"
                && text["origin"]["name"] == j["pluginName"]
                && text["message"]["content"] == json!(expected)
                && caveat["parentUuid"] == text["uuid"],
            "Local appended text differs from exact native receipt."
        );
    }
    for row in rows.iter().filter(|r| {
        r["parentUuid"] == out["uuid"] && r["isMeta"] == true && r["turnCompanion"] == true
    }) {
        // This native image cache label is display-only. Images are retained
        // from the exact command input, never inferred from the label.
        let c = owner::normalize_content(&row["message"]["content"])?;
        ensure!(
            row["type"] == "user"
                && row["sessionId"] == j["cliSessionId"]
                && c.as_array().is_some_and(|a| a.len() == 1
                    && a[0]["type"] == "text"
                    && a[0]["text"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("[Image: source: /")
                            && s.ends_with(']')
                            && !s.chars().any(char::is_control))),
            "Unexpected Local command companion content."
        );
        remove.push(
            row["uuid"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Local companion identity missing."))?
                .into(),
        );
    }
    Ok(remove)
}
pub fn is_applied(root: &Path, op: &str, rows: &[Value]) -> Result<bool> {
    let j = journal(root, op)?;
    if j["applied"].is_null() {
        return Ok(false);
    }
    verified(&j, rows)?;
    Ok(true)
}
/// Remove only a natively proven completed dispatch from the renderer inbox.
/// Retain its authenticated journal for future in-memory history restoration.
pub fn settle(root: &Path, op: &str, rows: &[Value]) -> Result<()> {
    let _lock = FileLock::acquire(directory(root)?.join(".lock"), true)?;
    let j = journal(root, op)?;
    verified(&j, rows)?;
    let path = root.join("local-sync-manifest.json");
    let mut manifest = read(&path)?;
    ensure!(
        packet::exact_keys(&manifest, &["version", "entries"]) && manifest["version"] == 1,
        "Invalid Local manifest."
    );
    let entries = manifest["entries"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid Local manifest entries."))?;
    for entry in entries.iter().filter(|e| e["opId"] == op) {
        ensure!(entry == &j["entry"], "Completed Local intent changed.");
    }
    entries.retain(|e| e["opId"] != op);
    storage::write_json(path, &manifest)
}
/// Exact journal-bound restoration of the original packet's block order.
pub fn normalize(root: &Path, session: &str, rows: &[Value]) -> Result<Vec<Value>> {
    let d = root.join("local-sync");
    if !d.try_exists()? {
        return Ok(rows.to_vec());
    }
    directory(root)?;
    let mut result = rows.to_vec();
    for e in fs::read_dir(d)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".lock" {
            continue;
        }
        Uuid::parse_str(&name)?;
        let j = match journal(root, &name) {
            Ok(j) => j,
            Err(e) if storage::is_not_found(&e) => continue,
            Err(e) => return Err(e),
        };
        if j["cliSessionId"] != session || j["applied"].is_null() {
            continue;
        }
        let remove = verified(&j, rows)?;
        result.retain(|r| {
            !r["uuid"]
                .as_str()
                .is_some_and(|s| remove.iter().any(|u| u == s))
        });
        if j["kind"] == "append" {
            let row = result
                .iter_mut()
                .find(|r| r["uuid"] == j["applied"]["textUuid"])
                .unwrap();
            row["message"]["content"] = j["content"].clone();
            row["queueTranscriptOnly"] = json!(true);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        codecs,
        history::{Common, Message},
        owned_history,
    };
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        registry: PathBuf,
        j: Value,
        rows: Vec<Value>,
        key: [u8; 32],
        common: Common,
    }
    fn fixture(adopt: bool) -> Result<Fixture> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        storage::private_directory(&root)?;
        let registry = storage::private_directory(root.join("registry"))?;
        let cwd = storage::private_directory(root.join("project"))?;
        let session = Uuid::new_v4().to_string();
        let conversation = Uuid::new_v4().to_string();
        let op = Uuid::new_v4().to_string();
        let local = format!("local_{}", Uuid::new_v4());
        let registry_path = registry.join(format!("{local}.json"));
        storage::write_json(
            &registry_path,
            &json!({"sessionId":local,"cliSessionId":session,"cwd":cwd,"title":"Fixture","isArchived":false,"lastActivityAt":0}),
        )?;
        storage::private_directory(root.join("owners"))?;
        storage::write_json(
            owner_path(&root, &conversation),
            &json!({"version":1,"sessionId":session,"conversationId":conversation,"cwd":cwd,"transport":"local-mod","localPhase":if adopt{"handoff-sent"}else{"adopted"},"remoteId":null,"pending":null,"reset":null}),
        )?;
        storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":{"operationId":op,"record":{"nativeId":session,"conversationId":conversation}}}),
        )?;
        let image = |data: &str| json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":data}});
        let key = [7; 32];
        let mut common = Common {
            meta: json!({"cwd":cwd,"timestamp":"2026-10-25T00:00:00.000Z"})
                .as_object()
                .unwrap()
                .clone(),
            messages: vec![Message {
                role: "user".into(),
                content: vec![
                    json!({"type":"text","text":format!("START{}END","x".repeat(70000))}),
                    image("aGVsbG8="),
                    json!({"type":"text","text":"between images"}),
                    image("d29ybGQ="),
                ],
                extra: Default::default(),
            }],
            extra: Default::default(),
        };
        common
            .messages
            .push(Message::text("assistant", "Images received."));
        let content = if adopt {
            vec![]
        } else {
            packet::encode_inline(
                &common.messages,
                json!({"conversationId":conversation,"targetSessionId":session,"operationId":op,"sourceSide":"codex","previousDigest":null}),
                &key,
            )?
        };
        let dir = storage::private_directory(directory(&root)?.join(&op))?;
        let images:Vec<_>=content.iter().filter(|b|b["type"]=="image").enumerate().map(|(i,b)|json!({"path":dir.join(format!("image-{i}.json")),"mimeType":b["source"]["media_type"]})).collect();
        let entry = json!({"opId":op,"conversationId":conversation,"cliSessionId":session,"localSessionId":local,"cwd":cwd,"title":"Fixture","command":"claudex-sync","args":op,"inputUuid":owner::append_uuid(&session,&op),"expiresAt":storage::now_ms()+600000,"registryPath":registry_path,"images":images});
        let j = json!({"version":1,"opId":op,"sourceOperationId":op,"conversationId":conversation,"cliSessionId":session,"cwd":cwd,"kind":if adopt{"adopt"}else{"append"},"entry":entry,"content":content,"claim":null,"received":false,"applied":null});
        storage::write_json(dir.join("operation.json"), &j)?;
        publish(&root, &entry)?;
        Ok(Fixture {
            _temp: temp,
            root,
            registry,
            j,
            rows: vec![],
            key,
            common,
        })
    }
    impl Fixture {
        fn params(&self) -> Value {
            json!({"opId":self.j["opId"],"localSessionId":self.j["entry"]["localSessionId"],"cliSessionId":self.j["cliSessionId"],"cwd":self.j["cwd"]})
        }
        fn receive(&mut self) -> Result<Value> {
            let claim = claim(&self.root, &self.registry, &self.params())?;
            assert_eq!(claim["ready"], true);
            let input = json!({"opId":self.j["opId"],"claimId":claim["claimId"],"sessionId":self.j["cliSessionId"],"cwd":self.j["cwd"],"pluginName":"claudex"});
            let received = receive(&self.root, &self.registry, &input)?;
            assert!(receive(&self.root, &self.registry, &input).is_err());
            self.j = read(&path(&self.root, self.j["opId"].as_str().unwrap())?)?;
            Ok(received)
        }
        fn complete(&mut self) -> Result<()> {
            let session = self.j["cliSessionId"].clone();
            let cwd = self.j["cwd"].clone();
            let token = self.j["claim"]["id"].as_str().unwrap();
            let op = self.j["opId"].as_str().unwrap();
            let text = Uuid::new_v4().to_string();
            let caveat = Uuid::new_v4().to_string();
            let stdout = Uuid::new_v4().to_string();
            let args = format!("{op} {token}");
            let texts: Vec<_> = self.j["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["type"] == "text")
                .cloned()
                .collect();
            if self.j["kind"] == "append" {
                self.rows.push(json!({"type":"user","uuid":text,"sessionId":session,"cwd":cwd,"isMeta":true,"origin":{"kind":"plugin","name":"claudex"},"timestamp":"2026-10-25T00:00:00.000Z","version":"2.1.302","message":{"role":"user","content":texts}}));
            }
            self.rows.push(json!({"type":"user","uuid":caveat,"parentUuid":if self.j["kind"]=="append"{json!(text)}else{Value::Null},"sessionId":session,"cwd":cwd,"isMeta":true,"message":{"role":"user","content":CAVEAT}}));
            let ct = format!(
                "<command-name>/claudex-sync</command-name>\n            <command-message>claudex-sync</command-message>\n            <command-args>{args}</command-args>"
            );
            let mut blocks: Vec<_> = self.j["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["type"] == "image")
                .cloned()
                .collect();
            let has_images = !blocks.is_empty();
            blocks.push(json!({"type":"text","text":ct}));
            self.rows.push(json!({"type":"user","uuid":self.j["entry"]["inputUuid"],"parentUuid":caveat,"sessionId":session,"cwd":cwd,"message":{"role":"user","content":if has_images{json!(blocks)}else{json!(ct)}}}));
            self.rows.push(json!({"type":"system","subtype":"local_command","uuid":stdout,"parentUuid":self.j["entry"]["inputUuid"],"sessionId":session,"commandRun":{"command":"claudex-sync","args":args,"plugin":"claudex"},"content":format!("<local-command-stdout>claudex: CLAUDEX_SYNC_APPLIED {op}</local-command-stdout>")}));
            if has_images {
                self.rows.push(json!({"type":"user","uuid":Uuid::new_v4(),"parentUuid":stdout,"sessionId":session,"isMeta":true,"turnCompanion":true,"message":{"role":"user","content":[{"type":"text","text":format!("[Image: source: /tmp/claude-1/project/{}/images/1.png]",session.as_str().unwrap())}]}}));
            }
            applied(
                &self.root,
                &json!({"opId":self.j["opId"],"claimId":self.j["claim"]["id"],"sessionId":session,"cwd":cwd,"textUuid":if self.j["kind"]=="append"{json!(text)}else{Value::Null}}),
            )?;
            Ok(())
        }
    }
    #[test]
    fn long_text_ordered_images_and_signed_packet_survive_local_command() -> Result<()> {
        let mut f = fixture(false)?;
        let received = f.receive()?;
        assert_eq!(received["kind"], "append");
        assert!(received["content"].to_string().len() > 70000);
        assert!(
            received["content"]
                .as_array()
                .unwrap()
                .iter()
                .all(|b| b["type"] == "text")
        );
        f.complete()?;
        assert!(is_applied(&f.root, f.j["opId"].as_str().unwrap(), &f.rows)?);
        let normalized = normalize(&f.root, f.j["cliSessionId"].as_str().unwrap(), &f.rows)?;
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["message"]["content"], f.j["content"]);
        let decoded = owned_history::completed_claude(
            &codecs::serialize_rows(&normalized)?,
            &f.root,
            f.j["conversationId"].as_str().unwrap(),
            f.j["cliSessionId"].as_str().unwrap(),
            Some(&f.key),
        )?;
        assert_eq!(decoded.common.messages, f.common.messages);
        assert!(!decoded.incomplete_tail);
        let manifest = read(&f.root.join("local-sync-manifest.json"))?;
        assert_eq!(manifest["entries"][0], f.j["entry"]);
        assert_eq!(
            claim(&f.root, &f.registry, &f.params())?,
            json!({"ready":false})
        );
        settle(&f.root, f.j["opId"].as_str().unwrap(), &f.rows)?;
        assert!(
            read(&f.root.join("local-sync-manifest.json"))?["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            normalize(&f.root, f.j["cliSessionId"].as_str().unwrap(), &f.rows)?.len(),
            1
        );
        f.rows[2]["message"]["content"]
            .as_array_mut()
            .unwrap()
            .swap(0, 1);
        assert!(normalize(&f.root, f.j["cliSessionId"].as_str().unwrap(), &f.rows).is_err());
        Ok(())
    }
    #[test]
    fn submitted_receipt_is_not_apply_and_adoption_never_replays_seed() -> Result<()> {
        let mut f = fixture(true)?;
        let received = f.receive()?;
        assert_eq!(received["content"], json!([]));
        let mut p = f.params();
        p["claimId"] = f.j["claim"]["id"].clone();
        p["outcome"] = json!("submitted");
        p["detail"] = json!("native-send-returned");
        receipt(&f.root, &p)?;
        assert!(!is_applied(&f.root, f.j["opId"].as_str().unwrap(), &[])?);
        f.complete()?;
        assert!(normalize(&f.root, f.j["cliSessionId"].as_str().unwrap(), &f.rows)?.is_empty());
        Ok(())
    }
    #[test]
    fn unknown_claim_and_owner_changes_are_not_replayed() -> Result<()> {
        let f = fixture(false)?;
        let claim = claim(&f.root, &f.registry, &f.params())?;
        let mut p = f.params();
        p["claimId"] = claim["claimId"].clone();
        p["outcome"] = json!("unknown");
        p["detail"] = json!("native-send-unknown");
        receipt(&f.root, &p)?;
        assert_eq!(claim["ready"], true);
        assert_eq!(
            super::claim(&f.root, &f.registry, &f.params())?["ready"],
            false
        );
        let g = fixture(false)?;
        let mut owner = read(&owner_path(
            &g.root,
            g.j["conversationId"].as_str().unwrap(),
        ))?;
        owner["sessionId"] = json!(Uuid::new_v4());
        storage::write_json(
            owner_path(&g.root, g.j["conversationId"].as_str().unwrap()),
            &owner,
        )?;
        assert!(super::claim(&g.root, &g.registry, &g.params()).is_err());
        Ok(())
    }
    #[test]
    fn historical_journals_do_not_impose_a_global_synchronization_lifetime_limit() -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let f = fixture(true)?;
        let base = directory(&f.root)?;
        for _ in 0..4096 {
            let op = Uuid::new_v4().to_string();
            let dir = base.join(&op);
            fs::create_dir(&dir)?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            let mut j = f.j.clone();
            j["opId"] = json!(op);
            j["sourceOperationId"] = json!(op);
            j["entry"]["opId"] = json!(op);
            j["entry"]["args"] = json!(op);
            j["entry"]["inputUuid"] =
                json!(owner::append_uuid(j["cliSessionId"].as_str().unwrap(), &op));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(dir.join("operation.json"))?;
            file.write_all(&serde_json::to_vec(&j)?)?;
        }
        assert_eq!(
            normalize(&f.root, &Uuid::new_v4().to_string(), &[])?,
            Vec::<Value>::new()
        );
        Ok(())
    }
    #[test]
    fn configuration_preserves_both_routes_and_rejects_invalid_values() -> Result<()> {
        let temp = tempfile::tempdir()?;
        assert_eq!(configured_transport(temp.path())?, "local-mod");
        for value in [json!("local-mod"), json!("remote-control")] {
            storage::write_json(
                temp.path().join("config.json"),
                &json!({"claudeDesktopTransport":value}),
            )?;
            assert_eq!(configured_transport(temp.path())?, value.as_str().unwrap());
        }
        for value in [Value::Null, json!(true), json!("proxy")] {
            storage::write_json(
                temp.path().join("config.json"),
                &json!({"claudeDesktopTransport":value}),
            )?;
            assert!(configured_transport(temp.path()).is_err());
        }
        Ok(())
    }
}
