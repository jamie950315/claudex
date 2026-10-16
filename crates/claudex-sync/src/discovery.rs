//! Bounded, read-only enrollment discovery. Native metadata decides whether a
//! Codex source is a subagent; filenames never stand in for parent identity.
use crate::{bridge::Side, codecs, native, packet};
use anyhow::{Result, ensure};
use claudex_core::storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const HEADER_BYTES: usize = 4 * 1024 * 1024;
const TRANSCRIPT_BYTES: usize = 480 * 1024 * 1024;

/// Discovery classifies candidates; it neither loads nor authenticates history.
/// Keep only one row in memory and recheck the same exact no-follow descriptor.
fn scan(path: &Path, limit: usize, mut visit: impl FnMut(&[u8]) -> Result<bool>) -> Result<()> {
    let named = fs::symlink_metadata(path)?;
    ensure!(
        named.is_file() && !named.file_type().is_symlink(),
        "Discovery source must be a regular file, never a symlink."
    );
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let identity = storage::FileIdentity::from_metadata(&file.metadata()?);
    ensure!(
        identity == storage::FileIdentity::from_metadata(&named),
        "Discovery source changed while opening."
    );
    let mut reader: Box<dyn BufRead + '_> = if path.extension().is_some_and(|e| e == "zst") {
        Box::new(BufReader::new(zstd::stream::read::Decoder::new(&file)?))
    } else {
        Box::new(BufReader::new(&file))
    };
    let mut total = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read =
            Read::take(&mut reader, (limit - total) as u64 + 1).read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        total += read;
        ensure!(
            total <= limit,
            "Discovery metadata scan exceeds its byte bound."
        );
        if !visit(&line)? {
            break;
        }
    }
    drop(reader);
    ensure!(
        identity == storage::FileIdentity::from_metadata(&file.metadata()?)
            && identity == storage::FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
        "Discovery source changed during inspection."
    );
    Ok(())
}

fn header(logical: &Path) -> Result<Option<Value>> {
    let physical = match native::physical_rollout(logical) {
        Ok(path) => path,
        Err(error) if storage::is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut row = None;
    match scan(&physical, HEADER_BYTES, |line| {
        row = serde_json::from_slice(line).ok();
        Ok(false)
    }) {
        Err(error) if storage::is_not_found(&error) => Ok(None),
        Err(error) => Err(error),
        Ok(()) => Ok(row),
    }
}

pub fn codex_session_id(logical: &Path) -> Result<String> {
    let row = header(logical)?.unwrap_or(Value::Null);
    ensure!(
        row["type"] == "session_meta",
        "Missing Codex session metadata."
    );
    row["payload"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("Missing Codex session metadata."))
}

fn imported_packet(row: &Value) -> Result<bool> {
    if row["type"] != "user" {
        return Ok(false);
    }
    let Some(content) = row["message"]["content"].as_array() else {
        return Ok(false);
    };
    let Some(first) = content.first().and_then(|b| b["text"].as_str()) else {
        return Ok(false);
    };
    let version = if first.starts_with("[Claudex imported history v1]\n") {
        1
    } else if first.starts_with("[Claudex imported history v2]\n") {
        2
    } else {
        return Ok(false);
    };
    let footer = format!("[Claudex context packet v{version}]\n");
    let Some(text) = content
        .last()
        .and_then(|b| b["text"].as_str())
        .and_then(|s| s.strip_prefix(&footer))
    else {
        return Ok(false);
    };
    let marker: Value = serde_json::from_str(text)?;
    Ok(marker["version"] == version
        && marker["targetSessionId"] == row["sessionId"]
        && marker["sourceSide"] == "codex"
        && packet::hex_digest(&marker["signature"]))
}

fn claude_cwd(path: &Path) -> Result<Option<String>> {
    let mut cwd = Value::Null;
    let mut excluded = false;
    match scan(path, TRANSCRIPT_BYTES, |line| {
        let row = match serde_json::from_slice::<Value>(line) {
            Ok(row) => row,
            Err(_) => {
                excluded = true;
                return Ok(false);
            }
        };
        match imported_packet(&row) {
            Ok(false) if row["type"] != "claudex-owner" => {}
            _ => {
                excluded = true;
                return Ok(false);
            }
        }
        if cwd.is_null() {
            cwd = row["cwd"].clone();
        }
        Ok(true)
    }) {
        Err(error) if storage::is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
        Ok(()) => {}
    }
    Ok((!excluded)
        .then(|| cwd.as_str().map(str::to_owned))
        .flatten())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub side: Side,
    pub path: PathBuf,
    pub native_id: String,
    pub cwd: String,
}
/// A normal enrollment exclusion, proven by exact native API metadata rather
/// than inferred from a rollout's historical source label or parent rows.
#[derive(Debug)]
pub struct CodexSubagentSource;
impl std::fmt::Display for CodexSubagentSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Native Codex subagent is not an independent conversation source.")
    }
}
impl std::error::Error for CodexSubagentSource {}
#[derive(Clone, Debug)]
pub struct Options {
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
    pub projects: Vec<PathBuf>,
    pub all_projects: bool,
    pub since: i64,
    pub exclude_subagents: bool,
    pub only_keys: Option<HashSet<String>>,
}
fn entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(entries.collect::<std::io::Result<_>>()?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}
fn codex_files(path: &Path, result: &mut BTreeSet<PathBuf>) -> Result<()> {
    for entry in entries(path)? {
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            codex_files(&entry.path(), result)?;
        } else if metadata.is_file() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".jsonl") || name.ends_with(".jsonl.zst") {
                result.insert(if name.ends_with(".zst") {
                    path.with_extension("")
                } else {
                    path
                });
            }
        }
    }
    Ok(())
}
fn recent(path: &Path, since: i64) -> Result<bool> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let time = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(time >= since.max(0) as u128)
}
fn safe_candidate(path: &Path, root: &Path) -> Result<bool> {
    match native::safe_native_path(path, root) {
        Ok(()) => Ok(true),
        // A native app can remove a transient untracked source between listing
        // and opening. Only its exact absence excuses a metadata-read failure.
        Err(error)
            if storage::is_not_found(&error)
                && matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}
pub fn codex_subagent(source: &Value) -> bool {
    source.as_object().is_some_and(|m| {
        m.get("subAgent").is_some_and(|v| match v {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64() != Some(0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        })
    }) || source
        .as_str()
        .is_some_and(|s| s.to_lowercase().starts_with("subagent"))
}
pub fn discover(options: &Options, known: &HashSet<String>) -> Result<Vec<Source>> {
    let eligible = |cwd: &str| {
        Path::new(cwd).is_absolute()
            && (options.all_projects || options.projects.iter().any(|p| p == Path::new(cwd)))
    };
    let wanted = |side: Side, id: &str| {
        !known.contains(&format!("{}:{id}", side.name()))
            && options
                .only_keys
                .as_ref()
                .is_none_or(|set| set.contains(&format!("{}:{}", side.name(), id.to_lowercase())))
    };
    let mut files = BTreeSet::new();
    codex_files(&options.codex_home.join("sessions"), &mut files)?;
    let mut sources = vec![];
    for logical in files {
        let physical = match native::physical_rollout(&logical) {
            Ok(p) => p,
            Err(e) if storage::is_not_found(&e) => continue,
            Err(e) => return Err(e),
        };
        if !recent(&physical, options.since)? {
            continue;
        }
        if !safe_candidate(&physical, &options.codex_home)? {
            continue;
        }
        let row = header(&logical)?.unwrap_or(Value::Null);
        let Some(meta) = (row["type"] == "session_meta").then_some(&row["payload"]) else {
            continue;
        };
        if meta["originator"] == "claudex" {
            continue;
        }
        let (Some(id), Some(cwd)) = (meta["id"].as_str(), meta["cwd"].as_str()) else {
            continue;
        };
        if !eligible(cwd)
            || !wanted(Side::Codex, id)
            || options.exclude_subagents
                && codex_subagent(
                    meta.get("source")
                        .filter(|value| !value.is_null())
                        .or_else(|| meta.get("sourceKind"))
                        .unwrap_or(&Value::Null),
                )
        {
            continue;
        }
        sources.push(Source {
            side: Side::Codex,
            path: logical,
            native_id: id.into(),
            cwd: cwd.into(),
        });
    }
    let directories = if options.all_projects {
        entries(&options.claude_home.join("projects"))?
            .into_iter()
            .filter_map(|e| e.file_type().ok().filter(|t| t.is_dir()).map(|_| e.path()))
            .collect::<BTreeSet<_>>()
    } else {
        options
            .projects
            .iter()
            .map(|p| codecs::project_directory(&options.claude_home, &p.to_string_lossy()))
            .collect()
    };
    for directory in directories {
        for entry in entries(&directory)? {
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name
                .strip_suffix(".jsonl")
                .filter(|id| Uuid::parse_str(id).is_ok())
            else {
                continue;
            };
            if !wanted(Side::Claude, id) || !recent(&entry.path(), options.since)? {
                continue;
            }
            if !safe_candidate(&entry.path(), &options.claude_home)? {
                continue;
            }
            let Some(cwd) = claude_cwd(&entry.path())?.filter(|cwd| eligible(cwd)) else {
                continue;
            };
            sources.push(Source {
                side: Side::Claude,
                path: entry.path(),
                native_id: id.into(),
                cwd,
            });
        }
    }
    ensure!(
        sources.len() <= 100_000,
        "Native discovery source bound exceeded."
    );
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::Write,
        os::unix::fs::{PermissionsExt, symlink},
    };

    fn fixture() -> Result<(tempfile::TempDir, Options)> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        let options = Options {
            codex_home: root.join("codex"),
            claude_home: root.join("claude"),
            projects: vec![root.join("project")],
            all_projects: true,
            since: 0,
            exclude_subagents: true,
            only_keys: None,
        };
        fs::create_dir_all(options.codex_home.join("sessions"))?;
        fs::create_dir_all(options.claude_home.join("projects/native-key"))?;
        fs::create_dir(&options.projects[0])?;
        Ok((temp, options))
    }
    fn codex(options: &Options, name: &str, payload: Value) -> Result<PathBuf> {
        let path = options
            .codex_home
            .join("sessions")
            .join(format!("rollout-{name}.jsonl"));
        fs::write(
            &path,
            format!("{}\n", json!({"type":"session_meta","payload":payload})),
        )?;
        Ok(path)
    }
    fn claude(options: &Options, id: &str, rows: &[Value]) -> Result<PathBuf> {
        let path = options
            .claude_home
            .join("projects/native-key")
            .join(format!("{id}.jsonl"));
        fs::write(&path, codecs::serialize_rows(rows)?)?;
        Ok(path)
    }
    #[test]
    fn codex_discovery_reads_only_bounded_header_even_for_large_or_incomplete_tails() -> Result<()>
    {
        let (_temp, options) = fixture()?;
        let id = Uuid::new_v4().to_string();
        let path = codex(
            &options,
            "large",
            json!({"id":id,"cwd":options.projects[0],"future":{"unknown":"context"}}),
        )?;
        fs::OpenOptions::new()
            .write(true)
            .open(&path)?
            .set_len(TRANSCRIPT_BYTES as u64 + 1024)?;
        let result = discover(&options, &HashSet::new())?;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].native_id, id);
        assert_eq!(result[0].path, path);
        assert_eq!(codex_session_id(&path)?, id);
        let compressed = codex(
            &options,
            "compressed",
            json!({"id":"future-native-identity","cwd":options.projects[0]}),
        )?;
        let mut text = fs::read(&compressed)?;
        text.extend_from_slice(b"incomplete native tail, not discovery metadata");
        fs::write(
            format!("{}.zst", compressed.display()),
            zstd::stream::encode_all(text.as_slice(), 1)?,
        )?;
        fs::remove_file(&compressed)?;
        let result = discover(&options, &HashSet::new())?;
        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .any(|s| s.path == compressed && s.native_id == "future-native-identity")
        );
        Ok(())
    }
    #[test]
    fn codex_scope_filters_subagents_known_sources_and_exact_event_keys() -> Result<()> {
        let (_temp, mut options) = fixture()?;
        let own = Uuid::new_v4().to_string();
        let other = Uuid::new_v4().to_string();
        codex(
            &options,
            "chosen",
            json!({"id":own,"cwd":options.projects[0],"source":{"future":"context"}}),
        )?;
        codex(
            &options,
            "worker",
            json!({"id":other,"cwd":options.projects[0],"source":null,"sourceKind":"subAgentFuture"}),
        )?;
        codex(
            &options,
            "owned",
            json!({"id":Uuid::new_v4(),"cwd":options.projects[0],"originator":"claudex"}),
        )?;
        codex(
            &options,
            "relative",
            json!({"id":Uuid::new_v4(),"cwd":"relative/project"}),
        )?;
        assert_eq!(discover(&options, &HashSet::new())?.len(), 1);
        options.only_keys = Some(
            [format!("codex:{}", own.to_lowercase())]
                .into_iter()
                .collect(),
        );
        assert_eq!(discover(&options, &HashSet::new())?[0].native_id, own);
        assert!(discover(&options, &[format!("codex:{own}")].into_iter().collect())?.is_empty());
        options.only_keys = Some([format!("codex:{other}")].into_iter().collect());
        assert!(discover(&options, &HashSet::new())?.is_empty());
        options.exclude_subagents = false;
        assert_eq!(discover(&options, &HashSet::new())?[0].native_id, other);
        for value in [Value::Null, json!(false), json!(0), json!(0.0), json!("")] {
            assert!(!codex_subagent(&json!({"subAgent":value})));
        }
        assert!(codex_subagent(&json!({"subAgent":{"new":"metadata"}})));
        Ok(())
    }
    #[test]
    fn only_exact_discovered_absence_excuses_metadata_errors() -> Result<()> {
        let (_temp, options) = fixture()?;
        let path = codex(
            &options,
            "transient",
            json!({"id":Uuid::new_v4(),"cwd":options.projects[0]}),
        )?;
        assert!(safe_candidate(&path, &options.codex_home)?);
        assert!(safe_candidate(&path, &options.codex_home.join("missing-root")).is_err());
        let alias = path.with_file_name("rollout-alias.jsonl");
        symlink(&path, &alias)?;
        assert!(safe_candidate(&alias, &options.codex_home).is_err());
        fs::remove_file(&path)?;
        assert!(!safe_candidate(&path, &options.codex_home)?);
        // A dangling native alias is present but unsafe, not an absent source.
        assert!(safe_candidate(&alias, &options.codex_home).is_err());
        assert!(!recent(&path, 0)?);
        assert!(header(&path)?.is_none());
        assert!(discover(&options, &HashSet::new())?.is_empty());
        Ok(())
    }
    #[test]
    fn claude_streaming_classification_preserves_scope_and_excludes_owned_imports() -> Result<()> {
        let (_temp, mut options) = fixture()?;
        let chosen = Uuid::new_v4().to_string();
        let imported = Uuid::new_v4().to_string();
        let quoted = Uuid::new_v4().to_string();
        let cwd = options.projects[0].to_string_lossy().to_string();
        let path = claude(
            &options,
            &chosen,
            &[json!({"type":"future-native-record","optional":1,"cwd":cwd})],
        )?;
        claude(
            &options,
            &Uuid::new_v4().to_string(),
            &[json!({"cwd":cwd}), json!({"type":"claudex-owner"})],
        )?;
        let packet = json!({"version":2,"sourceSide":"codex","targetSessionId":imported,"signature":"a".repeat(64)});
        let row = json!({"type":"user","cwd":cwd,"sessionId":imported,"message":{"content":[
            {"type":"text","text":"[Claudex imported history v2]\nOriginal messages"},
            {"type":"text","text":format!("[Claudex context packet v2]\n{packet}")}]}});
        claude(&options, &imported, &[row.clone()])?;
        let mut quote = row;
        quote["sessionId"] = json!(quoted);
        claude(&options, &quoted, &[quote])?;
        assert_eq!(discover(&options, &HashSet::new())?.len(), 2);
        options.only_keys = Some(
            [format!("claude:{}", chosen.to_lowercase())]
                .into_iter()
                .collect(),
        );
        let result = discover(&options, &HashSet::new())?;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, path);
        options.only_keys = None;
        options.all_projects = false;
        // A different project may encode to the same native directory. Its first
        // recorded cwd, not a later convenient one, determines discovery scope.
        let collision = codecs::project_directory(&options.claude_home, &cwd);
        fs::create_dir_all(&collision)?;
        fs::write(
            collision.join(format!("{}.jsonl", Uuid::new_v4())),
            codecs::serialize_rows(&[json!({"cwd":"/another/project"}), json!({"cwd":cwd})])?,
        )?;
        assert!(discover(&options, &HashSet::new())?.is_empty());
        Ok(())
    }
    #[test]
    fn malformed_unselected_claude_sources_are_not_read_and_discovery_never_follows_links()
    -> Result<()> {
        let (_temp, mut options) = fixture()?;
        let chosen = Uuid::new_v4().to_string();
        let ignored = Uuid::new_v4().to_string();
        let path = claude(&options, &chosen, &[json!({"cwd":options.projects[0]})])?;
        let skipped = claude(&options, &ignored, &[json!({"cwd":options.projects[0]})])?;
        fs::OpenOptions::new()
            .write(true)
            .open(&skipped)?
            .set_len(TRANSCRIPT_BYTES as u64 + 1)?;
        options.only_keys = Some([format!("claude:{chosen}")].into_iter().collect());
        symlink(
            &path,
            path.with_file_name(format!("{}.jsonl", Uuid::new_v4())),
        )?;
        symlink(
            path.parent().unwrap(),
            options.claude_home.join("projects/linked-project"),
        )?;
        assert_eq!(discover(&options, &HashSet::new())?.len(), 1);
        assert!(scan(&path.with_file_name("missing.jsonl"), 16, |_| Ok(false)).is_err());
        let alias = path.with_file_name("alias.jsonl");
        symlink(&path, &alias)?;
        assert!(scan(&alias, 16, |_| Ok(false)).is_err());
        Ok(())
    }
    #[test]
    fn metadata_scans_bind_exact_inode_times_and_mode_but_allow_native_hardlinks() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("header.jsonl");
        fs::write(&path, b"{\"future\":1}\n")?;
        fs::hard_link(&path, temp.path().join("native-reader-link"))?;
        let mut count = 0;
        scan(&path, 32, |_| {
            count += 1;
            Ok(false)
        })?;
        assert_eq!(count, 1);
        let m = fs::metadata(&path)?;
        assert!(
            scan(&path, 32, |_| {
                let replacement = temp.path().join("replacement");
                fs::write(&replacement, b"{\"future\":1}\n")?;
                fs::File::open(&replacement)?
                    .set_times(fs::FileTimes::new().set_modified(m.modified()?))?;
                fs::rename(&replacement, &path)?;
                Ok(false)
            })
            .is_err()
        );
        assert!(
            scan(&path, 32, |_| {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400))?;
                Ok(false)
            })
            .is_err()
        );
        Ok(())
    }
    #[test]
    fn malformed_first_rows_are_ignored_and_metadata_work_is_byte_bounded() -> Result<()> {
        let (_temp, options) = fixture()?;
        let path = options.codex_home.join("sessions/rollout-malformed.jsonl");
        fs::write(&path, b"incomplete first row\n")?;
        claude(
            &options,
            &Uuid::new_v4().to_string(),
            &[json!({"cwd":42}), json!({"cwd":options.projects[0]})],
        )?;
        assert!(discover(&options, &HashSet::new())?.is_empty());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)?;
        file.write_all(&[b'x'; 128])?;
        drop(file);
        assert!(
            scan(&path, 16, |_| panic!(
                "An oversized line must not reach the classifier"
            ))
            .is_err()
        );
        Ok(())
    }
}
