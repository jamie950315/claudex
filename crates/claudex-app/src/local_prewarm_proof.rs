//! Read-only certification of one historically shipped prewrite IPC rejection.
//! No vendor JavaScript is executed and no native session is invoked.
use anyhow::{Context, Result, ensure};
use chrono::{Local, NaiveDateTime, TimeZone};
use claudex_core::storage::{self, FileIdentity, StableFile};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const LEGACY: &str = include_str!("../host/renderer/local-start-v1-proof.txt");
const SCHEMA: &str = include_str!("../host/renderer/local-prewarm-schema-v1.txt");
const VALIDATE: &str = "function wSe(e,t,n,r,i){let a=Array(r.length);for(let o=0;o<r.length;o++){let s=i[o];if(!r[o][1](s))throw bSe(e,t,n,r[o][0],o);a[o]=s}return a}";
const DISPATCH: &str = "setImplementation:r=>{let l=r,u=(e,t)=>l[e](...t);for(let[r,a,o,c]of i){let i=s+r,l=async(e,...i)=>{if(!n(e))throw ySe(t,e,r);let s=await u(r,wSe(t,\"method\",r,a,i));";
const TABLE: &str = "=go(Sy,\"LocalSessions\",Ay,{methods:";
const PREWARM: &str = "[\"prewarmFolderless\",[[\"info\",lLt]],jPt]";
const START: &str = "[\"start\",[[\"info\",lLt]],kNt]";
const MOVE: &str = "[\"changeCwd\",[[\"sessionId\",F],[\"cwd\",F],[\"trustAccepted\",L(I)],[\"trustedDirectory\",L(F)]],vFt]";
const BRIDGE: &str =
    "prewarmFolderless(e){return t.ipcRenderer.invoke(Y+\"LocalSessions_$_prewarmFolderless\",e)}";
const WRAPPER: &str =
    "async prewarmFolderless(e){return t.ert.info(\"LocalSessions.prewarmFolderless\"),Z(e)}";
const NO_INPUT: &str =
    "let e=await p.startSession({...o,message:void 0},{prewarmHidden:{signature:c}});";

fn once(source: &str, expected: &str) -> Result<()> {
    ensure!(
        source.match_indices(expected).count() == 1,
        "Native prewarm proof no longer matches the shipped IPC contract."
    );
    Ok(())
}
fn safe_file(path: &Path, limit: usize) -> Result<StableFile> {
    let file = storage::read_stable_with_limit(path, limit)?;
    ensure!(
        ["0", &storage::uid().to_string()].contains(&file.identity.uid.as_str())
            && file.identity.nlink == "1"
            && file.identity.mode.parse::<u32>()? & 0o022 == 0,
        "Prewarm proof artifact ownership or permissions changed."
    );
    Ok(file)
}
fn before(identity: &FileIdentity, boundary_ms: i64) -> Result<()> {
    let boundary = i128::from(boundary_ms) * 1_000_000;
    ensure!(
        identity.mtime_ns.parse::<i128>()? <= boundary
            && identity.ctime_ns.parse::<i128>()? <= boundary,
        "Prewarm proof artifact changed after the native process started."
    );
    Ok(())
}
fn member<'a>(bytes: &'a [u8], header: &Value, base: usize, name: &str) -> Result<&'a str> {
    let v = &header["files"][".vite"]["files"]["build"]["files"][name];
    ensure!(
        v["unpacked"].is_null() && v["link"].is_null(),
        "Native proof module is not packed."
    );
    let offset: usize = v["offset"]
        .as_str()
        .context("Native proof module missing")?
        .parse()?;
    let size = usize::try_from(v["size"].as_u64().context("Native proof size missing")?)?;
    let start = base
        .checked_add(offset)
        .context("Native proof offset overflow")?;
    let end = start
        .checked_add(size)
        .context("Native proof size overflow")?;
    Ok(std::str::from_utf8(
        bytes
            .get(start..end)
            .context("Native proof module truncated")?,
    )?)
}
fn ipc_proof(bytes: &[u8]) -> Result<Value> {
    ensure!(bytes.len() >= 16, "Native ASAR header truncated.");
    let word = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
    let header_len = word(12);
    ensure!(
        word(0) == 4 && header_len <= 1024 * 1024,
        "Native ASAR header unsupported."
    );
    let header: Value = serde_json::from_slice(
        bytes
            .get(16..16 + header_len)
            .context("Native ASAR header truncated")?,
    )?;
    let base = 8usize
        .checked_add(word(4))
        .context("Native ASAR offset overflow")?;
    // Exact recognition authorizes supersession of a consumed native action;
    // it is deliberately stricter than ordinary tolerant history reading.
    let schema_name = "index.chunk-jPKPzV-P.js";
    let implementation_name = "index.chunk-DVWJXMwL.js";
    let schema = member(bytes, &header, base, schema_name)?;
    for expected in [SCHEMA, VALIDATE, DISPATCH, TABLE, PREWARM, START, MOVE] {
        once(schema, expected)?;
    }
    let table = schema.find(TABLE).unwrap();
    let end = schema[table..]
        .find("});")
        .map(|n| table + n)
        .context("Native IPC table boundary missing")?;
    ensure!(
        [PREWARM, START, MOVE]
            .iter()
            .all(|s| schema[table..end].contains(s)),
        "Native IPC method wiring changed."
    );
    let implementation = member(bytes, &header, base, implementation_name)?;
    for expected in [WRAPPER, NO_INPUT] {
        once(implementation, expected)?;
    }
    once(member(bytes, &header, base, "mainView.js")?, BRIDGE)?;
    Ok(
        json!({"schemaModule":schema_name,"implementationModule":implementation_name,
        "requiredMessage":true,"validationBeforeImplementation":true,"prewarmOverridesMessage":true,
        "startSchemaReviewed":true,"changeCwdSchemaReviewed":true}),
    )
}
#[derive(Debug, PartialEq, Eq)]
struct Process {
    pid: u32,
    started: i64,
    executable: PathBuf,
}
fn process(app: &Path) -> Result<Process> {
    let executable = app.join("Contents/MacOS/Claude");
    let out = Command::new("/bin/ps")
        .env("LC_ALL", "C")
        .args(["-ww", "-axo", "pid=,lstart=,comm="])
        .output()?;
    ensure!(
        out.status.success(),
        "Could not inspect the running native process."
    );
    let mut matches = vec![];
    for row in std::str::from_utf8(&out.stdout)?.lines() {
        let words: Vec<_> = row.split_whitespace().collect();
        if words.len() < 7 || words[6..].join(" ") != executable.to_string_lossy() {
            continue;
        }
        let text = words[1..6].join(" ");
        let time = NaiveDateTime::parse_from_str(&text, "%a %b %e %T %Y")?;
        let started = Local
            .from_local_datetime(&time)
            .single()
            .context("Ambiguous native start time")?
            .timestamp_millis();
        matches.push(Process {
            pid: words[0].parse()?,
            started,
            executable: executable.clone(),
        });
    }
    ensure!(
        matches.len() == 1,
        "Keep the original single Claude process running for prewarm certification."
    );
    Ok(matches.remove(0))
}
fn renderer(
    root: &Path,
    started: i64,
    loaded_asset: &str,
) -> Result<(Value, Vec<(PathBuf, FileIdentity)>)> {
    let directory = root.join("ui-owner-wake");
    let mut proofs = vec![];
    for (i, entry) in fs::read_dir(&directory)?.enumerate() {
        ensure!(
            i < 256,
            "Too many renderer generations for prewarm certification."
        );
        let path = entry?.path().join("ui-folder-compat/manifest.json");
        if !path.try_exists()? {
            continue;
        }
        let manifest = safe_file(&path, 1024 * 1024)?;
        let value: Value = serde_json::from_slice(&manifest.bytes)?;
        if value["version"] != 1 || value["phase"] != "installed" || value["action"] != "install" {
            continue;
        }
        let cache_path = PathBuf::from(
            value["cachePath"]
                .as_str()
                .context("Renderer cache path missing")?,
        );
        // Native Chromium evicts old generations without deleting Claudex's
        // retained install journals. A missing historical payload is not a
        // candidate; the loaded asset still needs exactly one complete proof.
        if matches!(fs::symlink_metadata(&cache_path), Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            continue;
        }
        ensure!(
            cache_path.is_absolute() && fs::canonicalize(&cache_path)? == cache_path,
            "Renderer cache path is aliased."
        );
        let cache_file = safe_file(&cache_path, crate::cache::MAX_CACHE_BYTES)?;
        let cache = crate::cache::inspect(&cache_file.bytes, None)?;
        let url = url::Url::parse(&cache.url)?;
        if url.path_segments().and_then(|mut s| s.next_back()) != Some(loaded_asset) {
            continue;
        }
        ensure!(
            cache.source.contains(LEGACY),
            "The loaded renderer is not the complete v1 prewarm contract."
        );
        once(&cache.source, LEGACY)?;
        ensure!(
            value["patchedHash"] == cache.source_hash,
            "Installed renderer integrity changed."
        );
        before(&cache_file.identity, started)?;
        // Maintenance may republish this app-owned pointer after the call.
        // The native cache payload itself must predate the process.
        let proof = json!({"manifestPath":path,"manifestIdentity":manifest.identity,
            "cachePath":cache_path,"cacheIdentity":cache_file.identity,"url":cache.url,
            "contract":"complete-local-start-v1","proof":{},"options":{"cwd":"","useWorktree":false}});
        proofs.push((
            proof,
            vec![(path, manifest.identity), (cache_path, cache_file.identity)],
        ));
    }
    ensure!(
        proofs.len() == 1,
        "Exactly one retained v1 renderer must prove the consumed prewarm options."
    );
    Ok(proofs.remove(0))
}
/// Call after publisher verification while the original process remains alive.
/// The saved receipt survives restart; a new certification requires that process.
pub fn certify(root: &Path, app: &Path, log: &Path, claim_at: i64) -> Result<Value> {
    ensure!(
        app.is_absolute() && fs::canonicalize(app)? == app,
        "Native app path is aliased."
    );
    let first = process(app)?;
    // ps exposes whole seconds: use its lower bound for artifact age, and upper
    // bound for the claimed call, never round nanosecond file identities.
    ensure!(
        first.started + 1000 <= claim_at && claim_at <= storage::now_ms(),
        "The running native process does not predate the consumed prewarm claim."
    );
    let asar_path = app.join("Contents/Resources/app.asar");
    let asar = safe_file(&asar_path, 64 * 1024 * 1024)?;
    before(&asar.identity, first.started)?;
    let ipc = ipc_proof(&asar.bytes)?;
    let loaded = loaded_renderer(log, first.started, claim_at)?;
    let (renderer, files) = renderer(root, first.started, loaded["asset"].as_str().unwrap())?;
    ensure!(
        first == process(app)?,
        "Native process changed during prewarm certification."
    );
    for (path, identity) in files
        .into_iter()
        .chain([(asar_path.clone(), asar.identity.clone())])
    {
        ensure!(
            identity == storage::FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
            "Prewarm proof artifact changed during certification."
        );
    }
    Ok(json!({"reason":"v1-missing-message-ipc-prewrite-rejection",
        "options":{"cwd":"","useWorktree":false},"nativeApp":app,"asarPath":asar_path,
        "asarIdentity":asar.identity,"process":{"pid":first.pid,"startedAt":first.started,
            "executable":first.executable},"ipc":ipc,"renderer":renderer,"loaded":loaded,
        "certifiedAt":storage::now_ms()}))
}
fn loaded_renderer(log: &Path, started: i64, claim_at: i64) -> Result<Value> {
    let snapshot = safe_file(log, 32 * 1024 * 1024)?;
    let mut loaded = vec![];
    let mut claimed = vec![];
    let mut unknown = vec![];
    for line in std::str::from_utf8(&snapshot.bytes)?.lines() {
        let (Some(date), Some(message)) = (line.get(..19), line.get(20..)) else {
            continue;
        };
        if !message.starts_with("[warn] [Claudex ") {
            continue;
        }
        let time = NaiveDateTime::parse_from_str(date, "%Y-%m-%d %H:%M:%S")?;
        let at = Local
            .from_local_datetime(&time)
            .single()
            .context("Ambiguous renderer log time")?
            .timestamp_millis();
        if at < started || at > claim_at + 5000 {
            continue;
        }
        if message.starts_with("[warn] [Claudex owner wake] loaded ") && at <= claim_at {
            let asset = message
                .strip_prefix("[warn] [Claudex owner wake] loaded ")
                .unwrap();
            ensure!(
                !asset.is_empty()
                    && asset.ends_with(".js")
                    && !asset.contains('/')
                    && !asset.chars().any(char::is_whitespace),
                "Invalid loaded renderer asset."
            );
            loaded.push((at, asset.to_owned()));
        }
        if at >= claim_at / 1000 * 1000 {
            if message == "[warn] [Claudex local start] prewarm-claimed" {
                claimed.push(at);
            }
            if message == "[warn] [Claudex local start] prewarm-unknown" {
                unknown.push(at);
            }
        }
    }
    ensure!(
        loaded.len() == 1 && claimed.len() == 1 && unknown.len() == 1 && claimed[0] <= unknown[0],
        "The native log does not uniquely bind the loaded renderer to the consumed prewarm."
    );
    Ok(
        json!({"path":log,"identity":snapshot.identity,"asset":loaded[0].1,
        "loadedAt":loaded[0].0,"claimedAt":claimed[0],"unknownAt":unknown[0]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_age_uses_exact_nanoseconds_and_both_change_clocks() -> Result<()> {
        let mut id = FileIdentity {
            dev: "1".into(),
            ino: "2".into(),
            size: "3".into(),
            mtime_ns: "1000000000".into(),
            ctime_ns: "1000000000".into(),
            uid: "1".into(),
            mode: "33188".into(),
            nlink: "1".into(),
        };
        before(&id, 1000)?;
        id.ctime_ns = "1000000001".into();
        assert!(before(&id, 1000).is_err());
        id.ctime_ns = "1".into();
        id.mtime_ns = "1000000001".into();
        assert!(before(&id, 1000).is_err());
        Ok(())
    }
    #[test]
    fn contract_recognition_is_unique_and_never_executes_vendor_code() -> Result<()> {
        once(VALIDATE, VALIDATE)?;
        assert!(once(&format!("{VALIDATE}{VALIDATE}"), VALIDATE).is_err());
        assert!(once(&VALIDATE.replace("throw bSe", "void bSe"), VALIDATE).is_err());
        assert!(LEGACY.contains("native.prewarmFolderless({ cwd: '', useWorktree: false })"));
        assert!(!LEGACY.contains("message: ''"));
        Ok(())
    }
    #[test]
    fn loaded_log_binds_one_exact_asset_and_consumed_call() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("native.log");
        let at = storage::now_ms() / 1000 * 1000;
        let date = Local
            .timestamp_millis_opt(at)
            .single()
            .unwrap()
            .format("%Y-%m-%d %H:%M:%S");
        let rows = format!(
            "{date} [warn] [Claudex owner wake] loaded fixture.js\n{date} [warn] [Claudex local start] prewarm-claimed\n{date} [warn] [Claudex local start] prewarm-unknown\n"
        );
        storage::atomic_write(&path, &rows)?;
        assert_eq!(
            loaded_renderer(&path, at - 1000, at + 100)?["asset"],
            "fixture.js"
        );
        storage::atomic_write(
            &path,
            format!("{rows}{date} [warn] [Claudex owner wake] loaded other.js\n"),
        )?;
        assert!(loaded_renderer(&path, at - 1000, at + 100).is_err());
        storage::atomic_write(
            &path,
            format!("{rows}{date} [warn] [Claudex local start] prewarm-claimed\n"),
        )?;
        assert!(loaded_renderer(&path, at - 1000, at + 100).is_err());
        Ok(())
    }
    #[test]
    fn renderer_proof_ignores_evicted_history_but_requires_one_loaded_asset() -> Result<()> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        let directory = storage::private_directory(root.join("ui-owner-wake"))?;
        let cache = root.join("native-cache");
        let payload = crate::cache::tests::fixture(LEGACY);
        let inspected = crate::cache::inspect(&payload, None)?;
        storage::atomic_write(&cache, &payload)?;
        for (name, path) in [
            ("evicted", root.join("missing-cache")),
            ("loaded", cache.clone()),
        ] {
            let generation = storage::private_directory(directory.join(name))?;
            let journal = storage::private_directory(generation.join("ui-folder-compat"))?;
            storage::write_json(
                journal.join("manifest.json"),
                &json!({"version":1,
                "phase":"installed","action":"install","cachePath":path,"patchedHash":inspected.source_hash}),
            )?;
        }
        let started = storage::now_ms() + 1000;
        assert_eq!(
            renderer(&root, started, "index-test.js")?.0["cachePath"],
            json!(cache)
        );
        assert!(renderer(&root, started, "other.js").is_err());
        let duplicate = storage::private_directory(directory.join("duplicate"))?;
        let journal = storage::private_directory(duplicate.join("ui-folder-compat"))?;
        storage::write_json(
            journal.join("manifest.json"),
            &json!({"version":1,
            "phase":"installed","action":"install","cachePath":cache,"patchedHash":inspected.source_hash}),
        )?;
        assert!(renderer(&root, started, "index-test.js").is_err());
        Ok(())
    }
}
