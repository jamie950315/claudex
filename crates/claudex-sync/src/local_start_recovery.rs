//! Independent own-context observation after a completed, blocked bootstrap.
//! This never repairs/replays the bootstrap or acquires a native writer lease.
use super::*;
pub(super) const COMMAND: &str = "claudex-witness";
const BLOCKED: &str = "CLAUDEX_LOCAL_BLOCKED: Preserve the receipt; do not resend this command.";

fn context(j: &Value) -> &Value {
    &j["identityRecovery"]["context"]
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Independent witness metadata is incomplete."))
}
fn snapshot_metadata(value: &Value) -> Result<()> {
    let _: storage::FileIdentity = serde_json::from_value(value["identity"].clone())?;
    ensure!(
        string(value, "text")?.ends_with('\n'),
        "Retained witness snapshot is incomplete."
    );
    Ok(())
}
pub(super) fn validate(j: &Value) -> Result<()> {
    if j["identityRecovery"].is_null() {
        ensure!(
            j["witness"].is_null()
                && j["witnessReceipt"].is_null()
                && j["recoveryCertificate"].is_null(),
            "Independent witness enrollment is missing."
        );
        return Ok(());
    }
    let c = context(j);
    let cli = id(c, "sessionId")?;
    let m = &j["identityRecovery"]["mapping"];
    let plugin = string(c, "pluginName")?;
    ensure!(
        j["identityRecovery"]["version"] == 1
            && j["bootstrap"].is_null()
            && c["cwd"] == j["prewarm"]["result"]["cwd"]
            && !plugin.is_empty()
            && plugin.len() < 256
            && !plugin.chars().any(char::is_control)
            && m.is_object()
            && m["nativeId"] == cli
            && m["cwd"] == c["cwd"]
            && m["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && m["title"] == j["originalOwner"]["displayTitle"]
            && m["isArchived"] == false
            && m["lastActivityAt"].is_u64()
            && Path::new(string(m, "registryPath")?).starts_with(string(j, "registryRoot")?)
            && string(m, "registryPath")?.ends_with(&format!("/{}.json", string(m, "sessionId")?))
            && j["identityRecovery"]["inputUuid"]
                == owner::append_uuid(&cli, &format!("local-witness:{}", string(j, "opId")?)),
        "Independent witness identity binding changed."
    );
    snapshot_metadata(&j["identityRecovery"]["snapshot"])?;
    if !j["witness"].is_null() {
        let w = &j["witness"];
        id(w, "id")?;
        ensure!(
            w["at"].is_i64()
                && w["proof"]
                    == json!({"sessionId":m["sessionId"],"cliSessionId":cli,
                "cwd":m["cwd"],"lastActivityAt":m["lastActivityAt"],"command":COMMAND,"unique":true})
                && (w["outcome"].is_null()
                    || matches!(
                        w["outcome"].as_str(),
                        Some("returned" | "unknown" | "rejected" | "needs_trust")
                    ))
                && if w["outcome"] == "returned" {
                    w["result"] == json!({"sessionId":m["sessionId"]})
                } else {
                    w["result"].is_null()
                },
            "Independent witness claim or outcome changed."
        );
    }
    if !j["witnessReceipt"].is_null() {
        let r = &j["witnessReceipt"];
        ensure!(
            packet::exact_keys(r, &["opId", "claimId", "sessionId", "cwd", "pluginName"])
                && !j["witness"].is_null()
                && r["opId"] == j["opId"]
                && r["claimId"] == j["witness"]["id"]
                && r["sessionId"] == c["sessionId"]
                && r["cwd"] == c["cwd"]
                && r["pluginName"] == c["pluginName"],
            "Independent witness receipt binding changed."
        );
    }
    if !j["recoveryCertificate"].is_null() {
        let cert = &j["recoveryCertificate"];
        ensure!(
            cert["version"] == 1
                && !j["witnessReceipt"].is_null()
                && cert["receipt"] == j["witnessReceipt"]
                && cert["graphs"].as_array().is_some_and(|a| a.len() == 9),
            "Independent witness certificate changed."
        );
        let mut ids = std::collections::HashSet::new();
        for value in cert["graphs"].as_array().unwrap() {
            let value = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid certified witness graph identity."))?;
            Uuid::parse_str(value)?;
            ensure!(
                ids.insert(value),
                "Duplicate certified witness graph identity."
            );
        }
        snapshot_metadata(&cert["snapshot"])?;
    }
    Ok(())
}
fn eligible(j: &Value) -> Result<()> {
    ensure!(
        j["bootstrap"].is_null()
            && j["prewarm"]["outcome"] == "returned"
            && j["start"]["outcome"] == "returned"
            && j["start"]["result"] == json!({"sessionId":j["prewarm"]["result"]["sessionId"]})
            && ["move", "resolved", "newOwner", "targetProof"]
                .iter()
                .all(|k| j[*k].is_null()),
        "Independent witness requires the same returned Local start, with no bootstrap or later action."
    );
    id(&j["prewarm"], "id")?;
    id(&j["start"], "id")?;
    ensure!(
        j["prewarm"]["proof"] == prewarm_proof()
            && j["start"]["proof"]
                == json!({"sessionId":j["prewarm"]["result"]["sessionId"],
            "cwd":j["prewarm"]["result"]["cwd"],"command":super::COMMAND,"unique":true}),
        "Witness retained initialization proofs changed."
    );
    local(&j["prewarm"]["result"])
}
struct Observation {
    text: String,
    rows: Vec<Value>,
    file_identity: storage::FileIdentity,
}
fn snapshot(j: &Value, cwd: &str, cli: &str) -> Result<Observation> {
    let home = Path::new(j["originalOwner"]["claudeHome"].as_str().unwrap());
    let p = codecs::claude_path(home, cwd, cli)?;
    ensure!(
        fs::canonicalize(&p)? == p,
        "Witness transcript path is aliased."
    );
    let f = storage::read_stable_with_limit(&p, LIMIT)?;
    ensure!(
        f.identity.uid == storage::uid().to_string()
            && f.identity.nlink == "1"
            && f.identity.mode.parse::<u32>()? & 0o077 == 0,
        "Witness transcript must be private, owned and single-link."
    );
    // Keep exact UTF-8 native bytes, not a lossy display projection.
    let text = String::from_utf8(f.bytes)?;
    ensure!(
        text.ends_with('\n'),
        "Witness transcript has an incomplete final line."
    );
    let rows = codecs::parse_rows(&text)?;
    ensure!(
        rows.iter()
            .all(|r| r["sessionId"].is_null() || r["sessionId"] == cli),
        "Witness transcript identity changed."
    );
    Ok(Observation {
        text,
        rows,
        file_identity: f.identity,
    })
}
fn mapping_fields(m: &Value) -> Result<Value> {
    let mut m = m.clone();
    // The dispatch proof names activity and identity, not historical mtime.
    // Retain the observed identity, but allow later stable metadata rewrites.
    m.as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Witness registry proof missing."))?
        .remove("registryIdentity");
    Ok(m)
}

fn command(
    j: &Value,
    rows: &[Value],
    name: &str,
    claim: &Value,
    output: &str,
) -> Result<Vec<String>> {
    let args = format!(
        "{} {}",
        j["opId"].as_str().unwrap(),
        claim
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Witness claim missing."))?
    );
    let texts = ["", args.as_str()]
        .map(|args| json!([{"type":"text","text":crate::local_sync::command_text(name,args)}]));
    let found: Vec<_> = rows
        .iter()
        .filter(|r| {
            r["type"] == "user"
                && owner::normalize_content(&r["message"]["content"])
                    .ok()
                    .is_some_and(|v| texts.contains(&v))
        })
        .collect();
    ensure!(
        found.len() == 1,
        "Witness transport command missing or duplicated."
    );
    if name == COMMAND {
        ensure!(
            found[0]["uuid"] == j["identityRecovery"]["inputUuid"],
            "Witness native input identity differs from intent."
        );
    }
    let c = context(j);
    let proof = json!({"opId":j["opId"],"claim":{"id":claim},"entry":{"inputUuid":found[0]["uuid"]},
        "content":[],"cwd":c["cwd"],"cliSessionId":c["sessionId"],"pluginName":c["pluginName"],"kind":"adopt","applied":{}});
    let ids = crate::local_sync::verified_command_output(&proof, rows, name, output)?;
    ensure!(
        ids.len() == 3,
        "An identity-only command cannot carry image companions."
    );
    Ok(ids)
}
fn old_graphs(j: &Value, rows: &[Value]) -> Result<Vec<String>> {
    let plugin = string(context(j), "pluginName")?;
    let outputs: Vec<_> = rows
        .iter()
        .filter(|r| r["commandRun"]["command"] == super::COMMAND)
        .collect();
    ensure!(
        outputs.len() == 1,
        "Original blocked bootstrap completion missing or duplicated."
    );
    let expected = format!("<local-command-stdout>{plugin}: {BLOCKED}</local-command-stdout>");
    let content = outputs[0]["content"].as_str().unwrap_or("");
    ensure!(content == expected || ["worker","envelope","context","lifecycle","helper","receipt","recheck"].iter().any(|phase|
        content == format!("<local-command-stdout>{plugin}: CLAUDEX_LOCAL_BLOCKED: {phase}. Preserve the receipt; do not resend this command.</local-command-stdout>")),
        "Original bootstrap is not a fixed, locally consumed blocked command.");
    let mut ids = command(j, rows, super::COMMAND, &j["start"]["id"], content)?;
    let pane = command(
        j,
        rows,
        "claudex",
        &j["start"]["id"],
        &format!("<local-command-stdout>{plugin}: Claudex</local-command-stdout>"),
    )?;
    let caveat = rows.iter().find(|r| r["uuid"] == pane[1]).unwrap();
    let out = rows.iter().find(|r| r["uuid"] == pane[2]).unwrap();
    ensure!(
        caveat["parentUuid"] == ids[2] && out["commandRun"]["args"] == "",
        "Witness diagnostic must be the exact direct no-query pane command."
    );
    ids.extend(pane);
    Ok(ids)
}
fn no_dialogue(rows: &[Value], ids: &[String]) -> Result<()> {
    let clean = crate::local_sync::without_transport_rows(rows, ids)?;
    ensure!(
        !clean
            .iter()
            .any(|r| matches!(r["type"].as_str(), Some("user" | "assistant"))),
        "Independent native content prevents witness recovery."
    );
    Ok(())
}
fn retained_rows(j: &Value, rows: &[Value]) -> Result<()> {
    let text = j["identityRecovery"]["snapshot"]["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Witness retained bytes missing."))?;
    for (index, line) in text.lines().filter(|l| !l.is_empty()).enumerate() {
        let expected: Value = serde_json::from_str(line)?;
        // Appends/relocation legitimately change timestamps, not these rows.
        ensure!(
            rows.get(index) == Some(&expected),
            "Witness retained transcript prefix changed."
        );
    }
    Ok(())
}
pub(super) fn verify_bytes(j: &Value, text: &str) -> Result<()> {
    if j["identityRecovery"].is_null() {
        return Ok(());
    }
    let retained = j["identityRecovery"]["snapshot"]["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Witness retained transcript bytes missing."))?;
    ensure!(
        text.starts_with(retained),
        "Witness retained native bytes changed."
    );
    if let Some(certified) = j["recoveryCertificate"]["snapshot"]["text"].as_str() {
        ensure!(
            text.starts_with(certified),
            "Witness certified native bytes changed."
        );
    }
    Ok(())
}
/// Explicit stopped-service enrollment. This allocates observation authority only;
/// it does not assert which old bootstrap phase failed or alter its old claims.
pub fn recover_bootstrap(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "sessionId"]),
        "Invalid witness recovery request."
    );
    let op = id(p, "opId")?;
    let cli = id(p, "sessionId")?;
    let _coordinator = FileLock::acquire(root.join("desktop-operation.lock"), true)?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let stop = read(&root.join("app-stop.json"))?;
    ensure!(
        stop["stopped"] == true && stop["resuming"] != true,
        "Stop and drain Claudex before enrolling an identity witness."
    );
    let mut j = journal(root, &op)?;
    authority_mode(root, &j, true)?;
    original_native_clear(root, registry, &j)?;
    ensure!(
        j["registryRoot"] == json!(registry),
        "Witness recovery belongs to another deployment."
    );
    eligible(&j)?;
    if !j["identityRecovery"].is_null() {
        ensure!(
            context(&j)["sessionId"] == cli,
            "Witness recovery identity changed."
        );
        let s = snapshot(&j, string(context(&j), "cwd")?, &cli)?;
        verify_bytes(&j, &s.text)?;
        old_graphs(&j, &s.rows)?;
        // Never clear a consumed witness, even when its receipt was lost.
        return Ok(json!({"enrolled":true,"opId":op,"alreadyEnrolled":true}));
    }
    let m = desktop_mapping::mappings(registry, &[cli.clone()])?;
    let m = m
        .get(&cli)
        .ok_or_else(|| anyhow::anyhow!("Witness Local registry mapping missing."))?;
    ensure!(
        m["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && m["cwd"] == j["prewarm"]["result"]["cwd"]
            && m["isArchived"] == false
            && m["title"] == j["originalOwner"]["displayTitle"],
        "Witness must observe the original unchanged scratch Local."
    );
    let s = snapshot(&j, m["cwd"].as_str().unwrap(), &cli)?;
    let outputs: Vec<_> = s
        .rows
        .iter()
        .filter(|r| r["commandRun"]["command"] == super::COMMAND)
        .collect();
    ensure!(
        outputs.len() == 1,
        "Original blocked bootstrap completion missing or duplicated."
    );
    let plugin = outputs[0]["commandRun"]["plugin"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 256 && !s.chars().any(char::is_control))
        .ok_or_else(|| anyhow::anyhow!("Original bootstrap plugin missing."))?;
    j["identityRecovery"] = json!({"version":1,"context":{"sessionId":cli,"cwd":m["cwd"],"pluginName":plugin},
        "mapping":m,"inputUuid":owner::append_uuid(&cli,&format!("local-witness:{op}")),
        "snapshot":{"identity":s.file_identity,"text":s.text}});
    let graphs = old_graphs(&j, &s.rows)?;
    no_dialogue(&s.rows, &graphs)?;
    // Fence the entire native snapshot before publishing the new observation.
    let current = snapshot(&j, m["cwd"].as_str().unwrap(), &cli)?;
    ensure!(
        current.file_identity == s.file_identity,
        "Native witness source changed during enrollment."
    );
    authority_mode(root, &j, true)?;
    original_native_clear(root, registry, &j)?;
    let latest = desktop_mapping::mappings(registry, &[cli.clone()])?;
    ensure!(
        latest.get(&cli) == Some(m),
        "Witness registry changed during enrollment."
    );
    j["status"] = json!("witness-pending");
    storage::write_json(path(root, &op)?, &j)?;
    // Stopped applications publish nothing actionable until normal prepare.
    Ok(json!({"enrolled":true,"opId":op,"alreadyEnrolled":false}))
}
pub(super) fn claim_proof(_root: &Path, registry: &Path, j: &Value, proof: &Value) -> Result<()> {
    eligible(j)?;
    ensure!(
        !j["identityRecovery"].is_null() && j["recoveryCertificate"].is_null(),
        "Witness enrollment missing or already certified."
    );
    let cli = id(context(j), "sessionId")?;
    let maps = desktop_mapping::mappings(registry, &[cli.clone()])?;
    let m = maps
        .get(&cli)
        .ok_or_else(|| anyhow::anyhow!("Witness mapping missing."))?;
    ensure!(
        mapping_fields(m)? == mapping_fields(&j["identityRecovery"]["mapping"])?
            && *proof
                == json!({"sessionId":m["sessionId"],"cliSessionId":cli,
        "cwd":m["cwd"],"lastActivityAt":m["lastActivityAt"],"command":COMMAND,"unique":true}),
        "Witness catalogue or identity proof changed."
    );
    let s = snapshot(j, string(context(j), "cwd")?, &cli)?;
    verify_bytes(j, &s.text)?;
    no_dialogue(&s.rows, &old_graphs(j, &s.rows)?)
}
/// Called only by the registered, non-immediate own-context command. No packet,
/// bootstrap, append, native creation or model operation occurs here.
pub fn witness(root: &Path, registry: &Path, p: &Value) -> Result<Value> {
    ensure!(
        packet::exact_keys(p, &["opId", "claimId", "sessionId", "cwd", "pluginName"]),
        "Invalid native witness receipt."
    );
    let op = id(p, "opId")?;
    id(p, "sessionId")?;
    let _guard = FileLock::acquire(dir(root)?.join(".lock"), true)?;
    let mut j = journal(root, &op)?;
    authority(root, &j)?;
    original_native_clear(root, registry, &j)?;
    eligible(&j)?;
    ensure!(
        j["registryRoot"] == json!(registry)
            && !j["witness"].is_null()
            && p["claimId"] == j["witness"]["id"]
            && p["sessionId"] == context(&j)["sessionId"]
            && p["cwd"] == context(&j)["cwd"]
            && p["pluginName"] == context(&j)["pluginName"]
            && !matches!(
                j["witness"]["outcome"].as_str(),
                Some("rejected" | "needs_trust")
            ),
        "Native witness context or claim changed."
    );
    let cli = id(p, "sessionId")?;
    let maps = desktop_mapping::mappings(registry, &[cli.clone()])?;
    let m = maps
        .get(&cli)
        .ok_or_else(|| anyhow::anyhow!("Witness registry unavailable."))?;
    ensure!(
        m["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && m["cwd"] == p["cwd"]
            && m["isArchived"] == false
            && m["title"] == j["originalOwner"]["displayTitle"],
        "Witness native identity changed."
    );
    ensure!(
        j["witnessReceipt"].is_null() || j["witnessReceipt"] == *p,
        "Native witness receipt changed."
    );
    j["witnessReceipt"] = p.clone();
    j["status"] = json!("witness-received-awaiting-completion");
    storage::write_json(path(root, &op)?, &j)?;
    Ok(json!({"recorded":true}))
}
pub(super) fn certify(root: &Path, registry: &Path, j: &mut Value) -> Result<()> {
    if j["identityRecovery"].is_null()
        || !j["recoveryCertificate"].is_null()
        || j["witnessReceipt"].is_null()
    {
        return Ok(());
    }
    eligible(j)?;
    ensure!(
        j["witnessReceipt"]["opId"] == j["opId"]
            && j["witnessReceipt"]["claimId"] == j["witness"]["id"]
            && j["witnessReceipt"]["sessionId"] == context(j)["sessionId"]
            && j["witnessReceipt"]["cwd"] == context(j)["cwd"]
            && j["witnessReceipt"]["pluginName"] == context(j)["pluginName"]
            && !matches!(
                j["witness"]["outcome"].as_str(),
                Some("rejected" | "needs_trust")
            ),
        "Witness receipt no longer matches its independent claim and context."
    );
    let cli = id(context(j), "sessionId")?;
    let s = snapshot(j, string(context(j), "cwd")?, &cli)?;
    verify_bytes(j, &s.text)?;
    let complete = s.rows.iter().any(|r| r["commandRun"]["command"] == COMMAND);
    if !complete {
        return Ok(());
    }
    let mut ids = old_graphs(j, &s.rows)?;
    let plugin = string(context(j), "pluginName")?;
    let fresh = command(
        j,
        &s.rows,
        COMMAND,
        &j["witness"]["id"],
        &format!(
            "<local-command-stdout>{plugin}: CLAUDEX_LOCAL_WITNESSED {}</local-command-stdout>",
            j["opId"].as_str().unwrap()
        ),
    )?;
    let caveat = s.rows.iter().find(|r| r["uuid"] == fresh[1]).unwrap();
    ensure!(
        caveat["parentUuid"] == *ids.last().unwrap(),
        "Witness must follow the exact retained diagnostic completion."
    );
    ids.extend(fresh);
    no_dialogue(&s.rows, &ids)?;
    retained_rows(j, &s.rows)?;
    let maps = desktop_mapping::mappings(registry, &[cli.clone()])?;
    let m = maps
        .get(&cli)
        .ok_or_else(|| anyhow::anyhow!("Witness registry missing before certification."))?;
    ensure!(
        m["sessionId"] == j["prewarm"]["result"]["sessionId"]
            && m["cwd"] == context(j)["cwd"]
            && m["isArchived"] == false
            && m["title"] == j["originalOwner"]["displayTitle"],
        "Witness identity changed before certification."
    );
    let current = snapshot(j, string(context(j), "cwd")?, &cli)?;
    ensure!(
        current.file_identity == s.file_identity,
        "Witness completion changed during certification."
    );
    authority(root, j)?;
    original_native_clear(root, registry, j)?;
    let latest = desktop_mapping::mappings(registry, &[cli.clone()])?;
    ensure!(
        latest.get(&cli) == Some(m),
        "Witness registry changed during certification."
    );
    j["recoveryCertificate"] = json!({"version":1,"receipt":j["witnessReceipt"],"graphs":ids,
        "snapshot":{"identity":s.file_identity,"text":s.text}});
    storage::write_json(path(root, j["opId"].as_str().unwrap())?, j)
}
pub(super) fn verified_graphs(j: &Value, rows: &[Value]) -> Result<Vec<String>> {
    ensure!(
        j["recoveryCertificate"]["version"] == 1
            && j["recoveryCertificate"]["receipt"] == j["witnessReceipt"]
            && j["witnessReceipt"]["claimId"] == j["witness"]["id"],
        "Independent witness certificate missing or changed."
    );
    retained_rows(j, rows)?;
    let mut ids = old_graphs(j, rows)?;
    let plugin = string(context(j), "pluginName")?;
    ids.extend(command(
        j,
        rows,
        COMMAND,
        &j["witness"]["id"],
        &format!(
            "<local-command-stdout>{plugin}: CLAUDEX_LOCAL_WITNESSED {}</local-command-stdout>",
            j["opId"].as_str().unwrap()
        ),
    )?);
    ensure!(
        json!(ids) == j["recoveryCertificate"]["graphs"],
        "Certified witness graph identities changed."
    );
    // Retain every field of each certified graph row. Raw byte prefixes are
    // checked separately before moves and target migration writes.
    let text = string(&j["recoveryCertificate"]["snapshot"], "text")?;
    for line in text.lines().filter(|s| !s.is_empty()) {
        let expected: Value = serde_json::from_str(line)?;
        if ids.iter().any(|id| expected["uuid"] == *id) {
            ensure!(
                rows.iter().filter(|r| **r == expected).count() == 1,
                "Certified witness graph bytes changed."
            );
        }
    }
    Ok(ids)
}
pub(super) fn verify_before_move(j: &Value) -> Result<()> {
    if j["identityRecovery"].is_null() {
        return Ok(());
    }
    ensure!(
        !j["recoveryCertificate"].is_null(),
        "Witness completion must be certified before a native move."
    );
    let cli = id(identity(j), "sessionId")?;
    let s = snapshot(j, identity(j)["cwd"].as_str().unwrap(), &cli)?;
    verify_bytes(j, &s.text)?;
    no_dialogue(&s.rows, &verified_graphs(j, &s.rows)?)
}
