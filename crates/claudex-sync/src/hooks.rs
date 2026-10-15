//! Journaled native hook configuration merge. Configuration presence never
//! grants Codex trust, and third-party handlers retain their exact content.
use crate::{
    bridge::Side,
    events::{Event, Inbox, Kind},
};
use anyhow::{Result, bail, ensure};
use claudex_core::storage::{self, FileIdentity, FileLock};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MARKER: &str = "Notify Claudex of a native conversation boundary";
const ORIGIN_MARKER: &str = "Verify the native origin of an opted-in Claudex task";
const WARM_MARKER: &str = "Handle explicit Claudex cache commands in this Codex chat";
const ORIGIN_MATCHER: &str = "^mcp__claudex[-_]work__claudex_start$";
const MAX_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
    pub executable: PathBuf,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command(values: &[&str]) -> String {
    values
        .iter()
        .map(|s| quote(s))
        .collect::<Vec<_>>()
        .join(" ")
}
fn parents(path: &Path) -> Result<()> {
    let mut parent = path.parent();
    while let Some(p) = parent {
        match fs::symlink_metadata(p) {
            Ok(m) => ensure!(
                m.is_dir() && !m.file_type().is_symlink(),
                "Native hook configuration parent is not a real directory."
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        parent = p.parent();
    }
    Ok(())
}
fn identity(i: &FileIdentity) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        i.dev, i.ino, i.size, i.mtime_ns, i.ctime_ns, i.uid, i.mode, i.nlink
    )
}
#[derive(Clone)]
struct Snapshot {
    text: Option<String>,
    digest: Option<String>,
    identity: Option<String>,
}
fn read(path: &Path) -> Result<Snapshot> {
    parents(path)?;
    let data = match storage::read_stable_with_limit(path, MAX_BYTES) {
        Ok(d) => d,
        Err(e) if storage::is_not_found(&e) => {
            return Ok(Snapshot {
                text: None,
                digest: None,
                identity: None,
            });
        }
        Err(e) => return Err(e),
    };
    ensure!(
        data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && data.bytes.len() <= MAX_BYTES,
        "Native hook file must be bounded, owned and single-link."
    );
    let text = String::from_utf8(data.bytes)?;
    Ok(Snapshot {
        digest: Some(storage::hash_bytes(&text)),
        identity: Some(identity(&data.identity)),
        text: Some(text),
    })
}
fn decode(snapshot: &Snapshot) -> Result<Value> {
    let value = match &snapshot.text {
        None => json!({}),
        Some(s) => serde_json::from_str(s)?,
    };
    ensure!(
        value.is_object() && value.get("hooks").is_none_or(Value::is_object),
        "Unsupported native hook configuration shape; user configuration preserved."
    );
    Ok(value)
}
fn json_text(value: &Value) -> Result<String> {
    Ok(format!("{}\n", serde_json::to_string_pretty(value)?))
}
fn checked_write(path: &Path, text: &str, expected: &Snapshot) -> Result<()> {
    ensure!(
        text.len() <= MAX_BYTES,
        "Hook configuration exceeds byte bound."
    );
    parents(path)?;
    let temporary = PathBuf::from(format!("{}.claudex-{}", path.display(), Uuid::new_v4()));
    storage::publish_exclusive(&temporary, text)?;
    let temporary_identity = FileIdentity::from_metadata(&fs::symlink_metadata(&temporary)?);
    let result = (|| -> Result<()> {
        let current = read(path)?;
        ensure!(
            current.digest == expected.digest && current.identity == expected.identity,
            "Native configuration changed; user edits preserved."
        );
        ensure!(
            FileIdentity::from_metadata(&fs::symlink_metadata(&temporary)?) == temporary_identity,
            "Hook staging identity changed before publication."
        );
        fs::rename(&temporary, path)?;
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    if result.is_err()
        && fs::symlink_metadata(&temporary)
            .is_ok_and(|info| FileIdentity::from_metadata(&info).same_inode(&temporary_identity))
    {
        fs::remove_file(&temporary)?;
    }
    result
}
fn definitions(options: &Options) -> Result<Value> {
    for path in [
        &options.root,
        &options.codex_home,
        &options.claude_home,
        &options.executable,
    ] {
        ensure!(
            path.is_absolute() && !path.to_string_lossy().contains(['\0', '\r', '\n']),
            "Hook paths must be absolute single-line paths."
        );
    }
    let exe = options
        .executable
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid executable path encoding."))?;
    let root = options.root.to_str().unwrap();
    let mut out = Map::new();
    for side in [Side::Codex, Side::Claude] {
        let events = if side == Side::Codex {
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "Interrupt",
                "SessionEnd",
            ]
        } else {
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "StopFailure",
                "SessionEnd",
            ]
        };
        let cmd = command(&[exe, "sync-hook", "--root", root, "--provider", side.name()]);
        let path = if side == Side::Codex {
            options.codex_home.join("hooks.json")
        } else {
            options.claude_home.join("settings.json")
        };
        let mut def = json!({"provider":side,"path":path,"events":events,"group":{"hooks":[{"type":"command","command":cmd,"timeout":3,"statusMessage":MARKER}]},"originGroup":{"matcher":ORIGIN_MATCHER,"hooks":[{"type":"command","command":cmd,"timeout":5,"statusMessage":ORIGIN_MARKER}]}});
        if side == Side::Codex {
            def["warmGroup"] = json!({"hooks":[{"type":"command","command":command(&[exe,"warm-hook","--root",root]),"timeout":30,"statusMessage":WARM_MARKER}]});
        }
        out.insert(side.name().into(), def);
    }
    Ok(Value::Object(out))
}
fn groups(def: &Value, event: &str) -> Vec<Value> {
    let mut out = vec![];
    if def["events"]
        .as_array()
        .is_some_and(|a| a.iter().any(|e| e == event))
    {
        out.push(def["group"].clone());
    }
    if event == "PostToolUse" && !def["originGroup"].is_null() {
        out.push(def["originGroup"].clone());
    }
    if event == "UserPromptSubmit" && !def["warmGroup"].is_null() {
        out.push(def["warmGroup"].clone());
    }
    out
}
fn shape(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(m) = value.as_object_mut() {
        m.remove("hooks");
    }
    value
}
fn holds(owned: &Value, group: &Value, handler: &Value) -> bool {
    shape(owned) == shape(group) && owned["hooks"][0] == *handler
}
fn owns(def: &Value, event: &str, group: &Value, handler: &Value) -> bool {
    groups(def, event).iter().any(|o| holds(o, group, handler))
}
fn present(config: &Value, event: &str, owned: &Value) -> bool {
    config["hooks"][event].as_array().is_some_and(|a| {
        a.iter().any(|g| {
            g["hooks"]
                .as_array()
                .is_some_and(|a| a.iter().any(|h| holds(owned, g, h)))
        })
    })
}
fn merge(before: &Snapshot, def: &Value, prior: &Value) -> Result<Value> {
    let mut config = decode(before)?;
    let mut hooks = config.get("hooks").cloned().unwrap_or_else(|| json!({}));
    for (event, groups) in hooks.as_object().unwrap() {
        let groups = groups
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Unsupported native hook matcher groups."))?;
        for g in groups {
            ensure!(
                g.is_object() && g["hooks"].is_array(),
                "Unsupported native hook matcher group."
            );
            for h in g["hooks"].as_array().unwrap() {
                if let Some(cmd) = h["command"].as_str() {
                    if (cmd.contains("claudex-sync-hook.mjs")
                        || cmd.contains("claudex-codex-warm-hook.mjs")
                        || h["statusMessage"] == MARKER
                        || h["statusMessage"] == ORIGIN_MARKER
                        || h["statusMessage"] == WARM_MARKER)
                        && !owns(def, event, g, h)
                        && !owns(prior, event, g, h)
                    {
                        bail!(
                            "An unrecognized Claudex hook exists; review it before installing another."
                        );
                    }
                }
            }
        }
    }
    let mut events: BTreeSet<String> = ["PostToolUse".into(), "UserPromptSubmit".into()]
        .into_iter()
        .collect();
    for d in [def, prior] {
        if let Some(a) = d["events"].as_array() {
            for e in a {
                events.insert(
                    e.as_str()
                        .ok_or_else(|| anyhow::anyhow!("Invalid saved event definition."))?
                        .into(),
                );
            }
        }
    }
    for event in events {
        let wanted = groups(def, &event);
        let mut kept = BTreeSet::new();
        let mut retained = vec![];
        for g in hooks[&event].as_array().into_iter().flatten() {
            let handlers = g["hooks"].as_array().unwrap();
            if groups(def, &event)
                .iter()
                .chain(groups(prior, &event).iter())
                .any(|owned| owned == g)
            {
                continue;
            }
            let filtered: Vec<_> = handlers
                .iter()
                .filter(|h| {
                    if let Some(index) = wanted.iter().position(|o| holds(o, g, h)) {
                        kept.insert(index)
                    } else {
                        !owns(prior, &event, g, h)
                    }
                })
                .cloned()
                .collect();
            if filtered.len() == handlers.len() {
                retained.push(g.clone());
            } else if !filtered.is_empty() {
                let mut g = g.clone();
                g["hooks"] = json!(filtered);
                retained.push(g);
            }
        }
        for (i, g) in wanted.into_iter().enumerate() {
            if !kept.contains(&i) {
                retained.push(g);
            }
        }
        hooks[&event] = json!(retained);
    }
    config["hooks"] = hooks;
    Ok(config)
}
fn validate_journal(journal: &Value, defs: &Value, dir: &Path) -> Result<()> {
    ensure!(
        journal["version"] == 1
            && matches!(journal["status"].as_str(), Some("prepared" | "complete"))
            && journal["plans"].as_array().is_some_and(|a| a.len() <= 2)
            && journal["definitions"].is_object(),
        "Invalid hook installation journal."
    );
    for p in journal["plans"].as_array().unwrap() {
        let provider = p["provider"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid journal provider."))?;
        let id = p["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid journal operation ID."))?;
        Uuid::parse_str(id)?;
        ensure!(
            defs.get(provider).is_some()
                && p["path"] == defs[provider]["path"]
                && p["beforePath"] == json!(dir.join(format!("{id}.before.json")))
                && p["afterPath"] == json!(dir.join(format!("{id}.after.json")))
                && packet_digest(&p["afterDigest"])
                && (p["beforeDigest"].is_null() || packet_digest(&p["beforeDigest"])),
            "Hook recovery targets changed."
        );
    }
    for (provider, def) in journal["definitions"].as_object().unwrap() {
        ensure!(
            defs.get(provider).is_some()
                && def["provider"] == *provider
                && def["path"] == defs[provider]["path"]
                && def["events"].as_array().is_some_and(|a| a
                    .iter()
                    .all(|e| defs[provider]["events"].as_array().unwrap().contains(e))),
            "Invalid saved hook definition."
        );
        ensure!(
            def.get("group").is_some(),
            "Saved lifecycle hook ownership is missing."
        );
        for (name, marker, timeout) in [
            ("group", MARKER, 3),
            ("originGroup", ORIGIN_MARKER, 5),
            ("warmGroup", WARM_MARKER, 30),
        ] {
            if let Some(group) = def.get(name) {
                ensure!(
                    crate::packet::exact_keys(
                        group,
                        if name == "originGroup" {
                            &["hooks", "matcher"]
                        } else {
                            &["hooks"]
                        }
                    ) && (name != "originGroup" || group["matcher"] == ORIGIN_MATCHER)
                        && (name != "warmGroup" || provider == "codex")
                        && group["hooks"].as_array().is_some_and(|a| a.len() == 1)
                        && crate::packet::exact_keys(
                            &group["hooks"][0],
                            &["type", "command", "timeout", "statusMessage"]
                        )
                        && group["hooks"][0]["type"] == "command"
                        && group["hooks"][0]["command"]
                            .as_str()
                            .is_some_and(|command| !command.is_empty()
                                && !command.contains(['\0', '\r', '\n']))
                        && group["hooks"][0]["timeout"] == timeout
                        && group["hooks"][0]["statusMessage"] == marker,
                    "Invalid saved hook ownership marker."
                );
            }
        }
    }
    Ok(())
}
fn packet_digest(v: &Value) -> bool {
    crate::packet::hex_digest(v)
}
pub fn inspect(options: &Options) -> Result<Value> {
    let defs = definitions(options)?;
    let mut providers = Map::new();
    for (provider, def) in defs.as_object().unwrap() {
        let config = decode(&read(Path::new(def["path"].as_str().unwrap()))?)?;
        let configured = def["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| present(&config, e.as_str().unwrap(), &def["group"]));
        let mut status = json!({"configured":configured,"lifecycleConfigured":configured,"originConfigured":present(&config,"PostToolUse",&def["originGroup"]),"path":def["path"],"events":def["events"]});
        if provider == "codex" {
            status["warmCommandConfigured"] =
                json!(present(&config, "UserPromptSubmit", &def["warmGroup"]));
            status["trust"] = json!("not-inspected");
            status["requiresTrustReview"] = json!(true);
        }
        providers.insert(provider.clone(), status);
    }
    Ok(
        json!({"configured":providers.values().all(|p|p["configured"]==true),"originConfigured":providers.values().all(|p|p["originConfigured"]==true),"providers":providers}),
    )
}

/// Inspect native approval without granting trust or mutating native settings.
/// Transport errors retain their original type and are never retried here.
pub async fn inspect_native_trust(
    options: &Options,
    client: &claudex_core::rpc::CodexClient,
) -> Result<Value> {
    let response = client
        .request("hooks/list", json!({"cwds":[options.root]}))
        .await?;
    inspect_native_inventory(options, &response)
}

/// Project only the fields used by the trust proof. Unknown native inventory
/// fields and unrelated hook kinds do not invalidate an exact approval.
pub fn inspect_native_inventory(options: &Options, response: &Value) -> Result<Value> {
    let defs = definitions(options)?;
    let disk = inspect(options)?;
    let claude_settings = decode(&read(Path::new(defs["claude"]["path"].as_str().unwrap()))?)?;
    let claude = json!({"configured":disk["providers"]["claude"]["configured"],
        "enabled":claude_settings["disableAllHooks"] != true});
    let inventories = response["data"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native Codex hook inventory has an invalid shape."))?
        .iter()
        .filter(|item| item["cwd"] == json!(options.root))
        .collect::<Vec<_>>();
    ensure!(
        inventories.len() == 1,
        "Native Codex hook inventory is missing or ambiguous."
    );
    let inventory = inventories[0];
    let hooks = inventory["hooks"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native Codex hook inventory is missing or ambiguous."))?;
    let errors = inventory["errors"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native Codex hook inventory is missing or ambiguous."))?;
    let expected = &defs["codex"];
    let inspect_event = |event: &str, group: &Value| -> Value {
        let native_event = format!("{}{}", event[..1].to_ascii_lowercase(), &event[1..]);
        let found = hooks
            .iter()
            .filter(|hook| {
                hook["eventName"] == native_event
                    && hook["command"] == group["hooks"][0]["command"]
                    && hook["sourcePath"] == expected["path"]
                    && (event != "PostToolUse" || hook["matcher"] == group["matcher"])
            })
            .collect::<Vec<_>>();
        let hook = if found.len() == 1 {
            found[0]
        } else {
            &Value::Null
        };
        let enabled = hook["enabled"] == true;
        let trusted = enabled
            && hook["currentHash"]
                .as_str()
                .is_some_and(|hash| !hash.is_empty())
            && matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed"));
        let status = match hook["trustStatus"].as_str() {
            Some(value @ ("trusted" | "managed" | "untrusted" | "modified")) => value,
            _ => "unknown",
        };
        json!({"event":event,"loaded":found.len()==1,"enabled":enabled,
            "trusted":trusted,"trustStatus":status})
    };
    let events = expected["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| inspect_event(event.as_str().unwrap(), &expected["group"]))
        .collect::<Vec<_>>();
    let mut warm = inspect_event("UserPromptSubmit", &expected["warmGroup"]);
    warm["configured"] = disk["providers"]["codex"]["warmCommandConfigured"].clone();
    warm["ready"] =
        json!(warm["configured"] == true && warm["trusted"] == true && errors.is_empty());
    let mut origin = inspect_event("PostToolUse", &expected["originGroup"]);
    origin["configured"] = disk["providers"]["codex"]["originConfigured"].clone();
    let notification = json!({"ready":origin["configured"]==true && origin["trusted"]==true
            && disk["providers"]["claude"]["originConfigured"]==true
            && claude["enabled"]==true && errors.is_empty(),
        "codex":origin,"claude":{"configured":disk["providers"]["claude"]["originConfigured"],
            "enabled":claude["enabled"]}});
    let codex = json!({"configured":disk["providers"]["codex"]["configured"],
        "loaded":events.iter().all(|e|e["loaded"]==true),
        "trusted":events.iter().all(|e|e["trusted"]==true),"events":events});
    let reason = if codex["configured"] != true || claude["configured"] != true {
        Some("Conversation completion hooks are not configured. Run Claudex setup to install them.")
    } else if claude["enabled"] != true {
        Some(
            "Claude hooks are disabled. Enable hooks in Claude settings to resume event-driven synchronization.",
        )
    } else if !errors.is_empty() {
        Some(
            "Codex reported hook configuration errors. Review the native hooks configuration before synchronizing.",
        )
    } else if codex["loaded"] != true {
        Some(
            "Codex has not loaded all Claudex completion hooks. Open /hooks in Codex and review the configured hooks.",
        )
    } else if events.iter().any(|e| e["enabled"] != true) {
        Some(
            "Claudex completion hooks are disabled in Codex. Open /hooks to review and enable them.",
        )
    } else if codex["trusted"] != true {
        Some(
            "Claudex completion hooks need native Codex approval. Open /hooks and trust the exact Claudex hook definitions.",
        )
    } else {
        None
    };
    let mut result = json!({"ready":reason.is_none(),"codex":codex,"claude":claude,
        "notificationOrigin":notification,"warmCommand":warm});
    if let Some(reason) = reason {
        result["reason"] = json!(reason);
    }
    Ok(result)
}

pub fn install(options: &Options) -> Result<Value> {
    let defs = definitions(options)?;
    let dir = options.root.join("sync-hooks");
    parents(&dir.join("installation.json"))?;
    storage::private_directory(&dir)?;
    storage::require_private_directory(&dir)?;
    let _lock = FileLock::acquire(&dir.join("install.lock"), true)?;
    let journal_path = dir.join("installation.json");
    let journal_snapshot = read(&journal_path)?;
    let mut journal = journal_snapshot
        .text
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .unwrap_or(Value::Null);
    if !journal.is_null() {
        validate_journal(&journal, &defs, &dir)?;
        if journal["status"] == "prepared" {
            for p in journal["plans"].as_array().unwrap() {
                let path = Path::new(p["path"].as_str().unwrap());
                let current = read(path)?;
                if json!(current.digest) == p["afterDigest"] {
                    continue;
                }
                ensure!(
                    json!(current.digest) == p["beforeDigest"]
                        && json!(current.identity) == p["beforeIdentity"],
                    "Native configuration changed during recovery; no edits overwritten."
                );
                let saved = read(Path::new(p["afterPath"].as_str().unwrap()))?;
                ensure!(
                    json!(saved.digest) == p["afterDigest"],
                    "Hook recovery payload changed."
                );
                if !p["beforeDigest"].is_null() {
                    ensure!(
                        json!(read(Path::new(p["beforePath"].as_str().unwrap()))?.digest)
                            == p["beforeDigest"],
                        "Hook backup changed."
                    );
                }
                checked_write(path, saved.text.as_deref().unwrap(), &current)?;
            }
            journal["status"] = json!("complete");
            storage::write_json(&journal_path, &journal)?;
        }
    }
    let mut plans = vec![];
    let mut payloads = BTreeMap::new();
    for (provider, def) in defs.as_object().unwrap() {
        let path = PathBuf::from(def["path"].as_str().unwrap());
        let before = read(&path)?;
        let after = merge(&before, def, &journal["definitions"][provider])?;
        if decode(&before)? == after {
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let after = json_text(&after)?;
        let plan = json!({"provider":provider,"path":path,"id":id,"beforeDigest":before.digest,"beforeIdentity":before.identity,"afterDigest":storage::hash_bytes(&after),"beforePath":dir.join(format!("{id}.before.json")),"afterPath":dir.join(format!("{id}.after.json"))});
        payloads.insert(id, (before, after));
        plans.push(plan);
    }
    if !plans.is_empty() {
        let count = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.ends_with(".before.json") || n.ends_with(".after.json")
            })
            .count();
        ensure!(
            count + plans.len() * 2 <= 128,
            "Hook recovery storage limit reached; preserve and review backups."
        );
        for p in &plans {
            let (before, after) = &payloads[p["id"].as_str().unwrap()];
            if let Some(text) = &before.text {
                storage::publish_exclusive(Path::new(p["beforePath"].as_str().unwrap()), text)?;
            }
            storage::publish_exclusive(Path::new(p["afterPath"].as_str().unwrap()), after)?;
        }
        journal = json!({"version":1,"status":"prepared","definitions":defs,"plans":plans});
        storage::write_json(&journal_path, &journal)?;
        for p in &plans {
            let (before, after) = &payloads[p["id"].as_str().unwrap()];
            checked_write(Path::new(p["path"].as_str().unwrap()), after, before)?;
        }
        journal["status"] = json!("complete");
        storage::write_json(&journal_path, &journal)?;
    }
    let mut result = inspect(options)?;
    result["changed"] = json!(!plans.is_empty());
    result["journalPath"] = json!(journal_path);
    Ok(result)
}
/// The CLI combines this identity-only publisher with collaboration's native
/// hook before returning any mailbox context. Hook prompts are never persisted.
pub async fn hook_event(root: &Path, provider: &str, input: &Value) -> Result<Option<Value>> {
    hook_event_with_kind(root, provider, input, None).await
}
pub fn app_stopped(root: &Path) -> Result<bool> {
    let data = match storage::read_stable(root.join("app-stop.json")) {
        Ok(data) => data,
        Err(e) if storage::is_not_found(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    ensure!(
        data.bytes.len() <= 4096
            && data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && data.identity.mode.parse::<u32>()? & 0o077 == 0,
        "Unverified application stop state."
    );
    let value: Value = serde_json::from_slice(&data.bytes)?;
    ensure!(
        value["version"] == 1
            && value["stopped"].is_boolean()
            && value.get("resuming").is_none_or(Value::is_boolean),
        "Invalid application stop state."
    );
    Ok(value["stopped"] == true || value["resuming"] == true)
}
pub async fn hook_event_with_kind(
    root: &Path,
    provider: &str,
    input: &Value,
    kind_override: Option<&str>,
) -> Result<Option<Value>> {
    let side: Side = provider.parse()?;
    if std::env::var("CLAUDEX_COLLABORATION_WORKER").as_deref() == Ok("1")
        || ["agent_id", "agentId", "agent_type"]
            .iter()
            .any(|k| input.get(*k).is_some_and(|v| !v.is_null()))
        || input["hook_event_name"] == "SubagentStop"
    {
        return Ok(None);
    }
    if app_stopped(root)? {
        return Ok(None);
    }
    let kind = match input["hook_event_name"].as_str() {
        Some("Stop") => Kind::Completed,
        Some("UserPromptSubmit") => Kind::Started,
        Some("SessionStart") => Kind::Session,
        Some("Interrupt" | "StopFailure" | "SessionEnd") => Kind::Interrupted,
        _ => return Ok(None),
    };
    let kind = match kind_override {
        None => kind,
        Some("started") => Kind::Started,
        Some(_) => bail!("Unsupported hook kind override."),
    };
    let id = input["session_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Hook native session ID missing."))?;
    let receipt = Inbox::new(root)?
        .publish(Event {
            side,
            native_id: id.into(),
            kind,
            turn_id: input["turn_id"].as_str().map(str::to_owned),
            remote_id: None,
        })
        .await?;
    Ok(Some(json!({"revision":receipt.revision,"published":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Result<(tempfile::TempDir, Options)> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        let options = Options {
            root: root.join("state"),
            codex_home: root.join("codex"),
            claude_home: root.join("claude"),
            executable: root.join("bin/claudex"),
        };
        Ok((temp, options))
    }
    fn legacy_definitions(options: &Options) -> Result<Value> {
        let mut defs = definitions(options)?;
        let root = options.root.to_str().unwrap();
        for provider in ["codex", "claude"] {
            let cmd = command(&[
                "/legacy/Node Runtime/bin/node",
                "/legacy/Claudex/bin/claudex-sync-hook.mjs",
                "--root",
                root,
                "--provider",
                provider,
            ]);
            defs[provider]["group"]["hooks"][0]["command"] = json!(cmd);
            defs[provider]["originGroup"]["hooks"][0]["command"] = json!(cmd);
            if provider == "codex" {
                defs[provider]["warmGroup"]["hooks"][0]["command"] = json!(command(&[
                    "/legacy/Node Runtime/bin/node",
                    "/legacy/Claudex/bin/claudex-codex-warm-hook.mjs",
                    "--root",
                    root
                ]));
            }
        }
        Ok(defs)
    }
    fn legacy_config(def: &Value) -> Value {
        let mut hooks = Map::new();
        for event in def["events"].as_array().unwrap() {
            hooks.insert(
                event.as_str().unwrap().into(),
                json!(groups(def, event.as_str().unwrap())),
            );
        }
        hooks.insert("PostToolUse".into(), json!(groups(def, "PostToolUse")));
        json!({"hooks":hooks,"independentPreference":"keep"})
    }
    #[test]
    fn installation_preserves_third_party_shared_handlers_and_never_grants_trust() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        let options = Options {
            root: root.join("state"),
            codex_home: root.join("codex"),
            claude_home: root.join("claude"),
            executable: root.join("bin/claudex"),
        };
        let first = install(&options)?;
        assert_eq!(first["changed"], true);
        let path = options.codex_home.join("hooks.json");
        let mut config = storage::read_json(&path)?;
        let foreign = json!({"type":"command","command":"echo foreign","timeout":2});
        config["hooks"]["Stop"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(foreign.clone());
        storage::write_json(&path, &config)?;
        let result = install(&options)?;
        assert_eq!(result["changed"], false);
        assert_eq!(result["providers"]["codex"]["trust"], "not-inspected");
        assert!(
            storage::read_json(path)?["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .contains(&foreign)
        );
        Ok(())
    }
    #[test]
    fn normal_install_migrates_exact_journaled_node_handlers_without_duplication() -> Result<()> {
        let (_temp, options) = fixture()?;
        let defs = legacy_definitions(&options)?;
        let directory = storage::private_directory(options.root.join("sync-hooks"))?;
        let foreign = json!({"type":"command","command":"echo third-party","timeout":2});
        for provider in ["codex", "claude"] {
            let mut config = legacy_config(&defs[provider]);
            config["hooks"]["Stop"][0]["hooks"]
                .as_array_mut()
                .unwrap()
                .push(foreign.clone());
            storage::write_json(Path::new(defs[provider]["path"].as_str().unwrap()), &config)?;
        }
        storage::write_json(
            directory.join("installation.json"),
            &json!({"version":1,"status":"complete","definitions":defs,"plans":[]}),
        )?;
        let result = install(&options)?;
        assert_eq!(result["changed"], true);
        assert_eq!(result["providers"]["codex"]["trust"], "not-inspected");
        for provider in ["codex", "claude"] {
            let config = storage::read_json(Path::new(defs[provider]["path"].as_str().unwrap()))?;
            assert_eq!(config["independentPreference"], "keep");
            assert!(
                config["hooks"]["Stop"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|g| g["hooks"].as_array().unwrap().contains(&foreign))
            );
            let text = serde_json::to_string(&config)?;
            assert!(!text.contains("claudex-sync-hook.mjs"));
            assert!(!text.contains("claudex-codex-warm-hook.mjs"));
            let wanted = definitions(&options)?;
            for event in wanted[provider]["events"].as_array().unwrap() {
                let groups = config["hooks"][event.as_str().unwrap()].as_array().unwrap();
                let count = groups
                    .iter()
                    .flat_map(|g| g["hooks"].as_array().unwrap())
                    .filter(|h| **h == wanted[provider]["group"]["hooks"][0])
                    .count();
                assert_eq!(count, 1);
            }
        }
        assert_eq!(install(&options)?["changed"], false);
        Ok(())
    }
    #[test]
    fn prepared_legacy_install_recovers_its_exact_payload_then_upgrades_to_rust() -> Result<()> {
        let (_temp, options) = fixture()?;
        let defs = legacy_definitions(&options)?;
        let directory = storage::private_directory(options.root.join("sync-hooks"))?;
        let path = options.codex_home.join("hooks.json");
        storage::write_json(&path, &json!({"hooks":{},"keep":true}))?;
        let before = read(&path)?;
        let after = json_text(&legacy_config(&defs["codex"]))?;
        let id = Uuid::new_v4().to_string();
        let before_path = directory.join(format!("{id}.before.json"));
        let after_path = directory.join(format!("{id}.after.json"));
        storage::publish_exclusive(&before_path, before.text.as_ref().unwrap())?;
        storage::publish_exclusive(&after_path, &after)?;
        let journal = json!({"version":1,"status":"prepared","definitions":defs,"plans":[{"provider":"codex","path":path,"id":id,"beforeDigest":before.digest,"beforeIdentity":before.identity,"afterDigest":storage::hash_bytes(&after),"beforePath":before_path,"afterPath":after_path}]});
        storage::write_json(directory.join("installation.json"), &journal)?;
        install(&options)?;
        assert!(
            !serde_json::to_string(&storage::read_json(&path)?)?.contains("claudex-sync-hook.mjs")
        );
        assert_eq!(fs::read_to_string(&after_path)?, after);
        assert_eq!(
            storage::read_json(directory.join("installation.json"))?["status"],
            "complete"
        );
        Ok(())
    }
    fn native_fixture() -> Result<(tempfile::TempDir, Options, Value)> {
        let (temp, options) = fixture()?;
        install(&options)?;
        let defs = definitions(&options)?;
        let def = &defs["codex"];
        let hooks = def["events"].as_array().unwrap().iter()
            .chain(std::iter::once(&json!("PostToolUse")))
            .map(|event| {
                let event = event.as_str().unwrap();
                let mut hook = json!({"eventName":format!("{}{}",event[..1].to_ascii_lowercase(),&event[1..]),
                    "command":def["group"]["hooks"][0]["command"],"enabled":true,
                    "currentHash":"native-definition-hash","trustStatus":"trusted","sourcePath":def["path"],
                    "futureNativeField":{"kept":"irrelevant"}});
                if event == "PostToolUse" { hook["matcher"] = def["originGroup"]["matcher"].clone(); }
                hook
            }).collect::<Vec<_>>();
        let response =
            json!({"data":[{"cwd":options.root,"hooks":hooks,"errors":[],"future":"context"}]});
        Ok((temp, options, response))
    }
    #[test]
    fn native_approval_is_read_only_and_distinct_from_installation() -> Result<()> {
        let (_temp, options, mut response) = native_fixture()?;
        response["data"][0]["hooks"][0]["trustStatus"] = json!("managed");
        response["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"eventName":"futureLifecycle","unexpected":"context"}));
        let path = options.codex_home.join("hooks.json");
        let before = storage::read_stable(&path)?;
        let result = inspect_native_inventory(&options, &response)?;
        assert_eq!(result["ready"], true);
        assert_eq!(result["codex"]["events"].as_array().unwrap().len(), 5);
        assert_eq!(result["notificationOrigin"]["ready"], true);
        assert_eq!(result["warmCommand"]["ready"], false);
        assert_eq!(
            inspect(&options)?["providers"]["codex"]["trust"],
            "not-inspected"
        );
        assert_eq!(storage::read_stable(&path)?.identity, before.identity);
        assert_eq!(fs::read(&path)?, before.bytes);
        Ok(())
    }
    #[test]
    fn native_approval_requires_one_exact_enabled_current_definition() -> Result<()> {
        let (_temp, options, response) = native_fixture()?;
        for (field, value, expected) in [
            ("sourcePath", json!("/foreign/hooks.json"), "not loaded"),
            ("command", json!("modified command"), "not loaded"),
            ("enabled", json!(false), "disabled in Codex"),
            ("trustStatus", json!("untrusted"), "approval"),
            ("trustStatus", json!("modified"), "approval"),
            ("trustStatus", json!("future-native-state"), "approval"),
            ("currentHash", json!(""), "approval"),
        ] {
            let mut changed = response.clone();
            changed["data"][0]["hooks"][0][field] = value;
            let result = inspect_native_inventory(&options, &changed)?;
            assert_eq!(result["ready"], false);
            assert!(result["reason"].as_str().unwrap().contains(expected));
        }
        let mut duplicate = response.clone();
        duplicate["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(response["data"][0]["hooks"][0].clone());
        assert!(
            inspect_native_inventory(&options, &duplicate)?["reason"]
                .as_str()
                .unwrap()
                .contains("not loaded")
        );
        Ok(())
    }
    #[test]
    fn optional_origin_and_warm_approval_never_block_lifecycle_synchronization() -> Result<()> {
        let (_temp, options, response) = native_fixture()?;
        let index = response["data"][0]["hooks"].as_array().unwrap().len() - 1;
        for (field, value) in [
            ("matcher", json!(".*")),
            ("enabled", json!(false)),
            ("trustStatus", json!("untrusted")),
        ] {
            let mut changed = response.clone();
            changed["data"][0]["hooks"][index][field] = value;
            let result = inspect_native_inventory(&options, &changed)?;
            assert_eq!(result["ready"], true);
            assert_eq!(result["notificationOrigin"]["ready"], false);
        }
        let defs = definitions(&options)?;
        let mut changed = response.clone();
        let warm = json!({"eventName":"userPromptSubmit","command":defs["codex"]["warmGroup"]["hooks"][0]["command"],
            "enabled":true,"currentHash":"native-warm-hash","trustStatus":"trusted","sourcePath":defs["codex"]["path"]});
        changed["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(warm);
        assert_eq!(
            inspect_native_inventory(&options, &changed)?["warmCommand"]["ready"],
            true
        );
        for provider in ["codex", "claude"] {
            let path = Path::new(defs[provider]["path"].as_str().unwrap());
            let mut config = storage::read_json(path)?;
            config["hooks"]
                .as_object_mut()
                .unwrap()
                .remove("PostToolUse");
            storage::write_json(path, &config)?;
        }
        let result = inspect_native_inventory(&options, &changed)?;
        assert_eq!(result["ready"], true);
        assert_eq!(result["notificationOrigin"]["ready"], false);
        assert_eq!(result["notificationOrigin"]["codex"]["configured"], false);
        Ok(())
    }
    #[test]
    fn disabled_or_missing_disk_hooks_and_inventory_errors_remain_explicit() -> Result<()> {
        let (_temp, options, response) = native_fixture()?;
        let path = options.claude_home.join("settings.json");
        let mut config = storage::read_json(&path)?;
        config["disableAllHooks"] = json!(true);
        storage::write_json(&path, &config)?;
        let result = inspect_native_inventory(&options, &response)?;
        assert!(
            result["reason"]
                .as_str()
                .unwrap()
                .contains("Claude hooks are disabled")
        );
        storage::write_json(&path, &json!({}))?;
        assert!(
            inspect_native_inventory(&options, &response)?["reason"]
                .as_str()
                .unwrap()
                .contains("not configured")
        );
        install(&options)?;
        let mut errors = response.clone();
        errors["data"][0]["errors"] = json!([{"message":"native parser error"}]);
        assert!(
            inspect_native_inventory(&options, &errors)?["reason"]
                .as_str()
                .unwrap()
                .contains("configuration errors")
        );
        for bad in [
            json!({}),
            json!({"data":[]}),
            json!({"data":[response["data"][0],response["data"][0]]}),
            json!({"data":[{"cwd":options.root,"hooks":[]} ]}),
        ] {
            assert!(inspect_native_inventory(&options, &bad).is_err());
        }
        Ok(())
    }
}
