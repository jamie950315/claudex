//! Exact read-only native-to-Desktop mapping. This grants no transcript lease.
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use uuid::Uuid;

#[derive(Debug)]
struct Changing;
impl std::fmt::Display for Changing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Desktop registry changed during the bounded scan.")
    }
}
impl std::error::Error for Changing {}
fn unchanged(path: &Path, identity: &FileIdentity) -> Result<()> {
    if &FileIdentity::from_metadata(&fs::symlink_metadata(path)?) != identity {
        return Err(Changing.into());
    }
    Ok(())
}
pub fn mappings(root: &Path, ids: &[String]) -> Result<BTreeMap<String, Value>> {
    ensure!(
        root.is_absolute() && ids.len() <= 4096,
        "Invalid Desktop mapping root or identity count."
    );
    for id in ids {
        Uuid::parse_str(id)?;
    }
    let wanted: BTreeSet<_> = ids.iter().map(|id| id.to_lowercase()).collect();
    fn visit(
        path: &Path,
        depth: usize,
        wanted: &BTreeSet<String>,
        count: &mut usize,
        result: &mut BTreeMap<String, Value>,
    ) -> Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && depth == 0 => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let identity = FileIdentity::from_metadata(&metadata);
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && identity.uid == storage::uid().to_string()
                && fs::canonicalize(path)? == path,
            "Desktop registry must be a canonical owned directory."
        );
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            *count += 1;
            ensure!(*count <= 16_384, "Desktop registry scan exceeded bound.");
            let metadata = fs::symlink_metadata(entry.path())?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "Symlinked Desktop registry refused."
            );
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(ui) = name
                .strip_prefix("local_")
                .and_then(|s| s.strip_suffix(".json"))
            {
                Uuid::parse_str(ui)?;
                let before = FileIdentity::from_metadata(&metadata);
                ensure!(
                    metadata.is_file()
                        && before.uid == storage::uid().to_string()
                        && before.nlink == "1"
                        && before.mode.parse::<u32>()? & 0o022 == 0
                        && metadata.len() <= 8 * 1024 * 1024,
                    "Desktop record must be bounded, owned, regular and non-writable by others."
                );
                let data = storage::read_stable(entry.path())?;
                if data.identity != before {
                    return Err(Changing.into());
                }
                let record: Value = serde_json::from_slice(&data.bytes)?;
                ensure!(
                    record.is_object() && record["sessionId"] == format!("local_{ui}"),
                    "Desktop record identity mismatch."
                );
                if record["cliSessionId"].is_null() {
                    continue;
                }
                let native = record["cliSessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Ambiguous Desktop native identity."))?;
                Uuid::parse_str(native)?;
                let native = native.to_lowercase();
                if !wanted.contains(&native) {
                    continue;
                }
                ensure!(
                    !result.contains_key(&native),
                    "Multiple Desktop records map to one native identity."
                );
                let cwd = record["cwd"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Desktop cwd missing."))?;
                let title = record["title"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Desktop title missing."))?;
                ensure!(
                    Path::new(cwd).is_absolute()
                        && lexical_absolute(Path::new(cwd))? == Path::new(cwd)
                        && !title.trim().is_empty()
                        && title.encode_utf16().count() <= 4096
                        && !title.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                        && record["isArchived"].is_boolean()
                        && record["lastActivityAt"].is_u64(),
                    "Desktop mapping lacks exact cwd, title, activity or archive metadata."
                );
                result.insert(native,json!({"sessionId":record["sessionId"],"nativeId":record["cliSessionId"],"cwd":cwd,"title":title,"isArchived":record["isArchived"],"lastActivityAt":record["lastActivityAt"],"registryPath":entry.path(),"registryIdentity":data.identity}));
            } else if metadata.is_dir() && depth < 2 {
                visit(&entry.path(), depth + 1, wanted, count, result)?;
            }
        }
        unchanged(path, &identity)
    }
    for attempt in 0..3 {
        let mut result = BTreeMap::new();
        match visit(root, 0, &wanted, &mut 0, &mut result) {
            Ok(()) => return Ok(result),
            Err(e) if attempt < 2 && e.downcast_ref::<Changing>().is_some() => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}
fn lexical_absolute(path: &Path) -> Result<std::path::PathBuf> {
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}
pub fn verify_claude_target(registry: &Path, id: &str, cwd: Option<&str>) -> Result<Value> {
    let records = mappings(registry, &[id.into()])?;
    let record = records
        .get(&id.to_lowercase())
        .ok_or_else(|| anyhow::anyhow!("Exact Claude Desktop chat unavailable."))?;
    ensure!(
        record["isArchived"] == false,
        "Exact Claude Desktop chat is archived."
    );
    if let Some(cwd) = cwd {
        ensure!(
            record["cwd"] == cwd,
            "Exact native target working directory changed."
        );
    }
    Ok(
        json!({"localSessionId":record["sessionId"],"cwd":record["cwd"],"title":record["title"],"registryPath":record["registryPath"]}),
    )
}
