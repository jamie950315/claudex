//! Read-only native image and append-arrival proofs. API attachment paths are
//! inert descriptors: only the authoritative rollout, saved origins and exact
//! history_base segment references are opened.
use crate::{
    desktop::Checkpoint,
    history::{self, Common},
    native, packet,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use claudex_core::{
    json as js,
    storage::{self, FileIdentity},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

const MAX_BYTES: usize = 512 * 1024 * 1024;
const ROW_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
const MAX_ITEMS: usize = 25_000;
fn text(v: &Value) -> Result<&str> {
    v.as_str()
        .context("Native provenance identity must be text.")
}
fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty())
}
fn integer(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= 9_007_199_254_740_991)
}
fn valid_uuid(v: &str) -> bool {
    v.len() == 36 && Uuid::parse_str(v).is_ok()
}
fn absolute(p: &Path) -> bool {
    p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        && !p
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\n'))
}
fn needs(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| keys.iter().all(|k| o.contains_key(*k)))
}
fn key(turn: &str, item: &str) -> String {
    serde_json::to_string(&[turn, item]).unwrap()
}
fn inline(v: &Value) -> bool {
    let Some(value) = v.as_str() else {
        return false;
    };
    let Some(comma) = value.find(',') else {
        return false;
    };
    let (metadata, data) = value.split_at(comma);
    let Some(split) = metadata.len().checked_sub(7) else {
        return false;
    };
    if !metadata
        .get(split..)
        .is_some_and(|s| s.eq_ignore_ascii_case(";base64"))
    {
        return false;
    }
    let head = &metadata[..split];
    let data = &data[1..];
    head.get(..11)
        .is_some_and(|s| s.eq_ignore_ascii_case("data:image/"))
        && head[11..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
        && head.len() > 11
        && !data.is_empty()
        && STANDARD
            .decode(data)
            .is_ok_and(|bytes| STANDARD.encode(bytes) == data)
}

#[derive(Clone, Debug)]
pub struct Provenance {
    pub path: PathBuf,
    pub thread_id: String,
    pub cwd: PathBuf,
    pub codex_home: PathBuf,
    /// Raw proof byte bound (at most 480 MiB for late-item proofs).
    pub max_bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Prefix {
    pub start_ordinal: usize,
    pub end_ordinal: usize,
    pub end_byte: usize,
}
#[derive(Clone, Debug)]
pub struct HistoryLink {
    pub path: PathBuf,
    pub thread_id: String,
    pub prefix: Prefix,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImagePosition {
    pub turn_id: String,
    pub item_id: String,
    pub message_index: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Origin {
    path: PathBuf,
    requests: Vec<ImagePosition>,
}
#[derive(Clone, Debug)]
struct Guard {
    logical: PathBuf,
    physical: PathBuf,
    identity: FileIdentity,
    prefix: Option<(usize, String)>,
}
impl Guard {
    fn verify(&self) -> Result<()> {
        ensure!(
            native::physical_rollout(&self.logical)? == self.physical,
            "Native provenance physical rollout representation changed."
        );
        let m = fs::symlink_metadata(&self.physical)?;
        let now = FileIdentity::from_metadata(&m);
        ensure!(
            m.is_file() && !m.file_type().is_symlink() && m.uid() == storage::uid(),
            "Native provenance source is no longer an owned regular file."
        );
        if let Some((len, digest)) = &self.prefix {
            ensure!(
                now.same_inode(&self.identity)
                    && now.uid == self.identity.uid
                    && now.mode == self.identity.mode
                    && now.nlink == self.identity.nlink
                    && m.len() >= *len as u64,
                "Native provenance linked prefix identity changed."
            );
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&self.physical)?;
            ensure!(
                FileIdentity::from_metadata(&file.metadata()?).same_inode(&now),
                "Native provenance linked source changed while opening."
            );
            let mut bytes = vec![0; *len];
            file.read_exact(&mut bytes)?;
            ensure!(
                history::digest_bytes(&bytes) == *digest
                    && FileIdentity::from_metadata(&file.metadata()?).same_inode(&now)
                    && FileIdentity::from_metadata(&fs::symlink_metadata(&self.physical)?)
                        .same_inode(&now),
                "Native provenance linked prefix changed."
            );
        } else {
            ensure!(
                now == self.identity,
                "Native provenance source changed during verification."
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
struct Document {
    rows: Vec<Value>,
    lines: Vec<String>,
    guard: Guard,
    scanned: usize,
    digest: String,
}
impl Provenance {
    fn validate(&self) -> Result<()> {
        ensure!(
            absolute(&self.path)
                && absolute(&self.cwd)
                && absolute(&self.codex_home)
                && valid_uuid(&self.thread_id)
                && (1..=MAX_BYTES).contains(&self.max_bytes),
            "Native provenance requires exact absolute source, thread and byte bounds."
        );
        Ok(())
    }
    fn safe(&self, path: &Path) -> Result<PathBuf> {
        ensure!(
            absolute(path),
            "Native provenance rollout path is not canonical and absolute."
        );
        let parent = path.parent().context("Missing native rollout parent.")?;
        ensure!(
            fs::canonicalize(parent)? == parent,
            "Native provenance rollout parent is not canonical."
        );
        let physical = native::physical_rollout(path)?;
        native::safe_native_path(&physical, &self.codex_home)?;
        Ok(physical)
    }
    fn read(
        &self,
        path: &Path,
        prefix: Option<&Prefix>,
        limit: usize,
        protected: bool,
    ) -> Result<Document> {
        ensure!(
            limit > 0 && limit <= MAX_BYTES,
            "Native provenance aggregate scan byte limit exceeded."
        );
        let physical = self.safe(path)?;
        let named = fs::symlink_metadata(&physical)?;
        let identity = FileIdentity::from_metadata(&named);
        ensure!(
            named.is_file()
                && !named.file_type().is_symlink()
                && named.uid() == storage::uid()
                && (!protected || named.mode() & 0o022 == 0),
            "Native provenance source must be owned, regular and protected for this proof."
        );
        let compressed = physical.to_string_lossy().ends_with(".jsonl.zst");
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&physical)?;
        ensure!(
            FileIdentity::from_metadata(&file.metadata()?) == identity,
            "Native provenance source changed before reading."
        );
        let mut reader: Box<dyn BufRead> = if compressed {
            Box::new(BufReader::new(zstd::stream::read::Decoder::new(
                file.try_clone()?,
            )?))
        } else {
            Box::new(BufReader::new(file.try_clone()?))
        };
        let mut rows = vec![];
        let mut lines = vec![];
        let mut bytes = vec![];
        let mut previous = 0;
        let mut stopped = false;
        loop {
            let start = bytes.len();
            let mut row = vec![];
            let count = reader
                .by_ref()
                .take((ROW_BYTES + 1) as u64)
                .read_until(b'\n', &mut row)?;
            if count == 0 {
                break;
            }
            ensure!(
                count <= ROW_BYTES && row.last() == Some(&b'\n'),
                "Native provenance row is oversized or incomplete."
            );
            ensure!(
                start + count <= limit,
                "Native provenance aggregate scan byte limit exceeded."
            );
            let line = std::str::from_utf8(&row[..count - 1])
                .context("Native provenance row has invalid UTF-8.")?
                .to_owned();
            let parsed: Value =
                serde_json::from_str(&line).context("Malformed native provenance rollout row.")?;
            ensure!(
                parsed.is_object() && nonempty(&parsed["type"]),
                "Malformed native provenance rollout row."
            );
            bytes.extend_from_slice(&row);
            if let Some(prefix) = prefix {
                ensure!(
                    parsed["ordinal"] == json!(prefix.start_ordinal + rows.len()),
                    "Native history_base rows lack contiguous native ordinals."
                );
                if prefix.start_ordinal + rows.len() == prefix.end_ordinal {
                    ensure!(
                        prefix.end_byte >= previous && prefix.end_byte <= start + count - 1,
                        "Native history_base byte offset differs from its ordinal boundary."
                    );
                    stopped = true;
                    break;
                }
                previous = start;
            }
            rows.push(parsed);
            lines.push(line);
        }
        if let Some(prefix) = prefix {
            ensure!(
                stopped
                    || (prefix.start_ordinal + rows.len() == prefix.end_ordinal
                        && prefix.end_byte >= previous
                        && prefix.end_byte <= bytes.len()),
                "Native history_base does not cover its exact referenced prefix."
            );
        }
        let after = FileIdentity::from_metadata(&file.metadata()?);
        let current = FileIdentity::from_metadata(&fs::symlink_metadata(&physical)?);
        let prefix_guard = prefix.is_some() && !compressed;
        ensure!(
            if prefix_guard {
                [&after, &current].iter().all(|now| {
                    now.same_inode(&identity)
                        && now.uid == identity.uid
                        && now.mode == identity.mode
                        && now.nlink == identity.nlink
                        && now.size.parse::<usize>().is_ok_and(|n| n >= bytes.len())
                })
            } else {
                after == identity && current == identity
            },
            "Native provenance rollout changed during reading."
        );
        let guard = Guard {
            logical: path.into(),
            physical,
            identity,
            prefix: prefix_guard.then(|| (bytes.len(), history::digest_bytes(&bytes))),
        };
        guard.verify()?;
        Ok(Document {
            rows,
            lines,
            scanned: bytes.len(),
            digest: history::digest_json(&json!(std::str::from_utf8(&bytes)?))?,
            guard,
        })
    }
    fn header(&self, path: &Path) -> Result<(Value, usize)> {
        let physical = self.safe(path)?;
        let m = fs::symlink_metadata(&physical)?;
        ensure!(
            m.is_file() && !m.file_type().is_symlink() && m.uid() == storage::uid(),
            "Native history_base header is not an owned regular file."
        );
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&physical)?;
        let initial = FileIdentity::from_metadata(&m);
        ensure!(
            FileIdentity::from_metadata(&file.metadata()?) == initial,
            "Native history_base header changed while opening."
        );
        let compressed = physical.to_string_lossy().ends_with(".jsonl.zst");
        let mut reader: Box<dyn BufRead> = if compressed {
            Box::new(BufReader::new(zstd::stream::read::Decoder::new(
                file.try_clone()?,
            )?))
        } else {
            Box::new(BufReader::new(file.try_clone()?))
        };
        let mut row = vec![];
        reader
            .by_ref()
            .take((ROW_BYTES + 1) as u64)
            .read_until(b'\n', &mut row)?;
        ensure!(
            row.len() <= ROW_BYTES && row.last() == Some(&b'\n'),
            "Native history_base metadata row is incomplete or oversized."
        );
        let value: Value = serde_json::from_slice(&row)?;
        ensure!(
            value["type"] == "session_meta" && nonempty(&value["payload"]["id"]),
            "Malformed native history_base metadata."
        );
        ensure!(
            FileIdentity::from_metadata(&file.metadata()?) == initial
                && FileIdentity::from_metadata(&fs::symlink_metadata(&physical)?) == initial,
            "Native history_base header changed while reading."
        );
        let size = if compressed {
            let mut rest = vec![];
            reader
                .take((MAX_BYTES + 1 - row.len()) as u64)
                .read_to_end(&mut rest)?;
            ensure!(
                row.len() + rest.len() <= MAX_BYTES,
                "Native history_base decompressed byte limit exceeded."
            );
            row.len() + rest.len()
        } else {
            usize::try_from(m.len())?
        };
        Ok((value["payload"].clone(), size))
    }
    fn locate(&self, segment: &str) -> Result<PathBuf> {
        ensure!(
            valid_uuid(segment) && segment == segment.to_ascii_lowercase(),
            "Invalid exact native history_base segment identity."
        );
        fn walk(
            dir: &Path,
            depth: usize,
            segment: &str,
            out: &mut BTreeSet<PathBuf>,
        ) -> Result<()> {
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            ensure!(
                fs::canonicalize(dir)? == dir
                    && !fs::symlink_metadata(dir)?.file_type().is_symlink(),
                "Unsafe native history_base layout directory."
            );
            for entry in entries {
                let entry = entry?;
                let kind = entry.file_type()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if depth > 0
                    && kind.is_dir()
                    && !name.is_empty()
                    && name.bytes().all(|b| b.is_ascii_digit())
                {
                    walk(&entry.path(), depth - 1, segment, out)?;
                } else if depth == 0 && kind.is_file() && name.starts_with("rollout-") {
                    let logical = name.strip_suffix(".zst").unwrap_or(&name);
                    if logical.ends_with(&format!("-{segment}.jsonl"))
                        || logical.ends_with(&format!("_{segment}.jsonl"))
                    {
                        out.insert(entry.path().with_file_name(logical));
                    }
                }
            }
            Ok(())
        }
        let mut found = BTreeSet::new();
        walk(&self.codex_home.join("sessions"), 3, segment, &mut found)?;
        walk(
            &self.codex_home.join("archived_sessions"),
            0,
            segment,
            &mut found,
        )?;
        ensure!(
            found.len() == 1,
            "Native history_base exact segment is missing or ambiguous."
        );
        Ok(found.into_iter().next().unwrap())
    }
    pub fn resolve_history_base(&self) -> Result<Vec<HistoryLink>> {
        self.validate()?;
        let (mut meta, _) = self.header(&self.path)?;
        ensure!(
            meta["id"] == self.thread_id,
            "Native rollout metadata belongs to another thread."
        );
        let mut chain = vec![];
        let mut seen = BTreeSet::from([self.path.clone()]);
        let mut owner = self.thread_id.clone();
        let mut ordinal = usize::MAX;
        while !meta["history_base"].is_null() {
            let base = &meta["history_base"];
            let segment = text(&base["thread_id"])?;
            let end_byte = integer(&base["end_byte_offset"])
                .context("Invalid native history_base byte boundary.")?
                as usize;
            let end_ordinal = integer(&base["end_ordinal_exclusive"])
                .context("Invalid native history_base ordinal.")?
                as usize;
            ensure!(
                chain.len() < 64
                    && packet::exact_keys(
                        base,
                        &["thread_id", "end_byte_offset", "end_ordinal_exclusive"]
                    )
                    && valid_uuid(segment)
                    && end_byte > 0
                    && end_ordinal > 0
                    && end_ordinal < ordinal,
                "Invalid or overlong native history_base reference."
            );
            let expected = if !meta["forked_from_id"].is_null() {
                ensure!(
                    meta["forked_from_ordinal_exclusive"] == base["end_ordinal_exclusive"],
                    "Native fork ordinal contradicts its history_base."
                );
                text(&meta["forked_from_id"])?.to_owned()
            } else {
                owner.clone()
            };
            let path = self.locate(segment)?;
            ensure!(
                seen.insert(path.clone()),
                "Native history_base chain repeats a rollout."
            );
            let (next, size) = self.header(&path)?;
            let id = text(&next["id"])?;
            let name = path.file_name().unwrap().to_string_lossy();
            let named = if id == segment {
                name.ends_with(&format!("-{segment}.jsonl"))
            } else {
                name.ends_with(&format!("-{id}_{segment}.jsonl"))
            };
            ensure!(
                id == expected && named && size >= end_byte,
                "Native history_base segment identity or byte coverage differs."
            );
            let start = if next["history_base"].is_null() {
                0
            } else {
                integer(&next["history_base"]["end_ordinal_exclusive"])
                    .context("Invalid predecessor native ordinal.")? as usize
            };
            ensure!(
                start < end_ordinal,
                "Invalid native history_base ordinal range."
            );
            chain.push(HistoryLink {
                path,
                thread_id: id.into(),
                prefix: Prefix {
                    start_ordinal: start,
                    end_ordinal,
                    end_byte,
                },
            });
            owner = id.into();
            ordinal = end_ordinal;
            meta = next;
        }
        Ok(chain)
    }
}

fn native_quote(value: &str) -> Result<String> {
    ensure!(
        !value.contains('\0'),
        "Native command argv is not losslessly representable."
    );
    if value.is_empty() {
        return Ok("''".into());
    }
    let rest = value.chars().collect::<Vec<_>>();
    let mut position = 0;
    let mut output = String::new();
    while position < rest.len() {
        let mut allowed = if rest[position] == '^' { 2u8 } else { 7 };
        let mut end = position + usize::from(rest[position] == '^');
        while end < rest.len() {
            let c = rest[end];
            let mut next = allowed;
            if !(c.is_ascii_alphanumeric() || "+./:@]_-".contains(c)) {
                next &= !1;
            }
            if ['\'', '^', '\\'].contains(&c) {
                next &= !2;
            }
            if [char::from(96), '$', '!', '^'].contains(&c) {
                next &= !4;
            }
            if next == 0 {
                break;
            }
            allowed = next;
            end += 1;
        }
        ensure!(
            end > position,
            "Native argv quote cannot preserve its characters."
        );
        let chunk = rest[position..end].iter().collect::<String>();
        position = end;
        if allowed & 1 != 0 {
            output.push_str(&chunk);
        } else if allowed & 2 != 0 {
            output.push('\'');
            output.push_str(&chunk);
            output.push('\'');
        } else {
            output.push('"');
            for c in chunk.chars() {
                if [char::from(96), '$', '"', '\\'].contains(&c) {
                    output.push('\\');
                }
                output.push(c);
            }
            output.push('"');
        }
    }
    Ok(output)
}
fn project_command(item: &Value) -> Result<Value> {
    let uri = text(&item["cwd"])?;
    let parsed = url::Url::parse(uri).context("Native command cwd is not an exact file URI.")?;
    let path = parsed
        .to_file_path()
        .map_err(|_| anyhow::anyhow!("Native command cwd is not a local file URI."))?;
    ensure!(
        uri.starts_with("file:///")
            && path.is_absolute()
            && url::Url::from_file_path(&path)
                .ok()
                .is_some_and(|u| u.as_str() == uri),
        "Native command cwd file URI is not canonical."
    );
    let command = item["command"]
        .as_array()
        .context("Native command argv is missing.")?;
    let actions = item["parsed_cmd"]
        .as_array()
        .context("Native command actions are missing.")?;
    let secs = integer(&item["duration"]["secs"]).context("Native command duration is invalid.")?;
    let nanos =
        integer(&item["duration"]["nanos"]).context("Native command duration is invalid.")?;
    let duration = secs
        .checked_mul(1000)
        .and_then(|n| n.checked_add(nanos / 1_000_000))
        .filter(|n| *n <= 9_007_199_254_740_991);
    let source = text(&item["source"])?;
    ensure!(
        item["type"] == "CommandExecution"
            && nonempty(&item["id"])
            && regex::Regex::new(r"^[a-z]+(?:_[a-z]+)*$")?.is_match(source)
            && matches!(item["status"].as_str(), Some("completed" | "failed"))
            && !command.is_empty()
            && command.iter().all(Value::is_string)
            && text(&item["process_id"])
                .is_ok_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            && item["exit_code"]
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
            && packet::exact_keys(&item["duration"], &["secs", "nanos"])
            && nanos < 1_000_000_000
            && duration.is_some()
            && item["aggregated_output"].is_string()
            && item
                .get("stdout")
                .is_none_or(|v| v == &item["aggregated_output"])
            && item.get("stderr").is_none_or(|v| v == "")
            && item
                .get("formatted_output")
                .is_none_or(|v| v == &item["aggregated_output"])
            && !actions.is_empty()
            && actions
                .iter()
                .all(|a| packet::exact_keys(a, &["type", "cmd"])
                    && a["type"] == "unknown"
                    && a["cmd"].is_string()),
        "Late native command has a lossy or contradictory schema."
    );
    let mut camel = String::new();
    let mut uppercase = false;
    for c in source.chars() {
        if c == '_' {
            uppercase = true;
        } else {
            camel.push(if uppercase { c.to_ascii_uppercase() } else { c });
            uppercase = false;
        }
    }
    Ok(
        json!({"type":"commandExecution","id":item["id"],"pluginId":null,"scriptPath":null,
        "command":command.iter().map(|v|native_quote(v.as_str().unwrap())).collect::<Result<Vec<_>>>()?.join(" "),
        "cwd":path,"processId":item["process_id"],"source":camel,"status":item["status"],
        "commandActions":actions.iter().map(|a|json!({"type":"unknown","command":a["cmd"]})).collect::<Vec<_>>(),
        "aggregatedOutput":item["aggregated_output"],"exitCode":item["exit_code"],"durationMs":duration.unwrap()}),
    )
}
fn project_agent(item: &Value) -> Result<Value> {
    ensure!(
        item.is_object()
            && nonempty(&item["id"])
            && nonempty(&item["kind"])
            && nonempty(&item["agent_thread_id"])
            && item["agent_path"].is_string(),
        "Late native sub-agent activity lacks complete identity."
    );
    Ok(
        json!({"type":"subAgentActivity","id":item["id"],"kind":item["kind"],
        "agentThreadId":item["agent_thread_id"],"agentPath":item["agent_path"]}),
    )
}
fn time(row: &Value) -> Result<i64> {
    let value = text(&row["timestamp"])?;
    let parsed = chrono::DateTime::parse_from_rfc3339(value)?;
    ensure!(
        parsed
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            == value,
        "Native proof timestamp is not an exact millisecond UTC time."
    );
    Ok(parsed.timestamp_millis())
}
fn exact_frame(row: &Value, line: &str) -> Result<()> {
    ensure!(
        needs(row, &["timestamp", "ordinal", "type", "payload"])
            && time(row).is_ok()
            && js::stringify(row)? == line,
        "Native proof frame is incomplete or ambiguously serialized."
    );
    Ok(())
}
#[derive(Clone, Debug)]
struct Lifecycle {
    start: usize,
    stop: Option<usize>,
    contexts: Vec<usize>,
}
#[derive(Clone, Debug)]
struct LateCandidate {
    row: usize,
    active: Option<String>,
    latest: Option<String>,
    closed: usize,
    prior: usize,
}
struct NativeHistory {
    rows: Vec<Value>,
    lines: Vec<String>,
    starts: BTreeSet<usize>,
    guards: Vec<Guard>,
    source_identity: Value,
    digest: String,
}
impl Provenance {
    fn read_history(&self) -> Result<NativeHistory> {
        self.validate()?;
        ensure!(
            self.max_bytes <= 480 * 1024 * 1024,
            "Native late-item raw proof exceeds its 480 MiB bound."
        );
        let current = self.read(&self.path, None, self.max_bytes, true)?;
        let mut history = NativeHistory {
            rows: vec![],
            lines: vec![],
            starts: BTreeSet::new(),
            guards: vec![],
            source_identity: serde_json::to_value(&current.guard.identity)?,
            digest: current.digest.clone(),
        };
        if !current
            .rows
            .first()
            .context("Native late-item source is empty.")?["payload"]["history_base"]
            .is_null()
        {
            let chain = self.resolve_history_base()?;
            let mut budget = self.max_bytes.saturating_sub(current.scanned);
            let mut inherited = vec![];
            for link in chain.iter().rev() {
                ensure!(
                    link.thread_id == self.thread_id,
                    "Late native items cannot inherit another thread's forked lifecycle."
                );
                let segment = self.read(&link.path, Some(&link.prefix), budget, true)?;
                let count = link.prefix.end_ordinal - link.prefix.start_ordinal;
                ensure!(
                    history.rows.len() == link.prefix.start_ordinal && segment.rows.len() == count,
                    "Native history_base does not cover the referenced lifecycle rows."
                );
                budget = budget
                    .checked_sub(segment.scanned)
                    .context("Combined native late-item sources exceed their byte limit.")?;
                history.starts.insert(history.rows.len());
                history.rows.extend(segment.rows);
                history.lines.extend(segment.lines);
                inherited.push(json!({"sourceDigest":segment.digest,"sourceIdentity":segment.guard.identity,
                    "startOrdinal":link.prefix.start_ordinal,"endOrdinal":link.prefix.end_ordinal,"endByte":link.prefix.end_byte}));
                history.guards.push(segment.guard);
            }
            ensure!(
                current.rows[0]["ordinal"] == json!(history.rows.len()),
                "Native rollover does not continue its referenced lifecycle."
            );
            history.digest = history::digest_json(
                &json!({"sourceDigest":current.digest,"inherited":inherited}),
            )?;
        }
        history.starts.insert(history.rows.len());
        history.rows.extend(current.rows);
        history.lines.extend(current.lines);
        history.guards.push(current.guard);
        Ok(history)
    }
    fn same_directory(&self, value: &Value) -> bool {
        value.as_str().is_some_and(|s| {
            Path::new(s) == self.cwd
                || absolute(Path::new(s))
                    && fs::canonicalize(s)
                        .ok()
                        .zip(fs::canonicalize(&self.cwd).ok())
                        .is_some_and(|(a, b)| a == b)
        })
    }
    fn boundary(
        &self,
        state: &Lifecycle,
        api: &Value,
        source: &NativeHistory,
        ran_command: bool,
    ) -> Result<()> {
        let stop = state
            .stop
            .context("Late native item lacks a closed parent turn.")?;
        let start = &source.rows[state.start];
        let stop = &source.rows[stop];
        let done = &stop["payload"];
        let status = if done["type"] == "turn_aborted" {
            "interrupted"
        } else if done.get("error").is_none() {
            "completed"
        } else {
            "failed"
        };
        let begun = integer(&api["startedAt"]);
        let ended = integer(&api["completedAt"]);
        ensure!(
            api["status"] == status
                && (!api["error"].is_null()) == (status == "failed")
                && api["itemsView"] == "full"
                && begun.is_some()
                && ended.is_some()
                && ended >= begun
                && (!ran_command || !state.contexts.is_empty()),
            "Late native item lacks a unique full API closed boundary."
        );
        for index in std::iter::once(state.start)
            .chain(std::iter::once(state.stop.unwrap()))
            .chain(state.contexts.iter().copied())
        {
            exact_frame(&source.rows[index], &source.lines[index])?;
        }
        let required = if status == "interrupted" {
            vec!["type", "turn_id", "reason"]
        } else {
            vec![
                "type",
                "turn_id",
                "started_at",
                "completed_at",
                "duration_ms",
                "last_agent_message",
            ]
        };
        ensure!(
            needs(
                &start["payload"],
                &[
                    "type",
                    "turn_id",
                    "started_at",
                    "model_context_window",
                    "collaboration_mode_kind"
                ]
            ) && needs(done, &required)
                && start["payload"]["turn_id"] == api["id"]
                && std::iter::once(&start["payload"])
                    .chain(std::iter::once(done))
                    .chain(state.contexts.iter().map(|i| &source.rows[*i]["payload"]))
                    .all(|p| p.is_object()
                        && p.get("root_turn_id").is_none_or(|id| id == &api["id"]))
                && [&start["payload"], done]
                    .iter()
                    .all(|p| p.get("started_at").is_none_or(|t| t == &api["startedAt"]))
                && done
                    .get("completed_at")
                    .is_none_or(|t| t == &api["completedAt"])
                && time(start)?.div_euclid(1000) == begun.unwrap() as i64
                && time(stop)?.div_euclid(1000) == ended.unwrap() as i64
                && done.get("duration_ms").is_none_or(|v| integer(v).is_some())
                && done
                    .get("time_to_first_token_ms")
                    .is_none_or(|v| integer(v).is_some()),
            "Native late-item boundary contradicts API identity or timing."
        );
        for index in &state.contexts {
            let context = &source.rows[*index];
            ensure!(
                self.same_directory(&context["payload"]["cwd"])
                    && *index > state.start
                    && *index < state.stop.unwrap()
                    && time(context)? >= time(start)?
                    && time(context)? <= time(stop)?,
                "Native late-item context contradicts its closed boundary."
            );
        }
        if status == "completed" {
            let items = api["items"]
                .as_array()
                .context("Native late-item API items missing.")?;
            let user = items
                .iter()
                .rposition(|i| i["type"] == "userMessage")
                .map(|n| n as isize)
                .unwrap_or(-1);
            let agent = items.iter().rposition(|i| i["type"] == "agentMessage");
            let reply = &done["last_agent_message"];
            ensure!(
                if reply.is_null() {
                    !items.iter().enumerate().any(|(i, item)| {
                        i as isize > user
                            && item["type"] == "agentMessage"
                            && item["phase"] != "commentary"
                    })
                } else {
                    agent.is_some_and(|i| {
                        i as isize > user
                            && items[i]["phase"] != "commentary"
                            && items[i]["text"]
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty())
                            && items[i]["text"] == *reply
                    })
                },
                "Native late-item boundary lacks its exact final assistant reply."
            );
        }
        Ok(())
    }
    /// Invoke on each complete API pass after completed-prefix slicing, before
    /// comparing pass evidence. Never move or delete native turn items here.
    pub fn late_items(
        &self,
        turns: &[Value],
        empty_turn_ids: &BTreeSet<String>,
    ) -> Result<Option<Value>> {
        if !turns.iter().any(|t| {
            t["items"].as_array().is_some_and(|a| {
                a.iter().any(|i| {
                    matches!(
                        i["type"].as_str(),
                        Some("commandExecution" | "subAgentActivity")
                    )
                })
            })
        }) {
            return Ok(None);
        }
        let source = self.read_history()?;
        let rows = &source.rows;
        let mut states: BTreeMap<String, Lifecycle> = BTreeMap::new();
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        let mut candidates = vec![];
        let mut closed: Vec<String> = vec![];
        let mut active: Option<String> = None;
        let mut latest: Option<String> = None;
        let mut invalid = false;
        for (index, row) in rows.iter().enumerate() {
            let p = &row["payload"];
            if row["type"] == "event_msg" && p["type"] == "task_started" {
                let Some(id) = p["turn_id"].as_str().filter(|s| valid_uuid(s)) else {
                    invalid = true;
                    continue;
                };
                if states.contains_key(id) {
                    invalid = true;
                    continue;
                }
                states.insert(
                    id.into(),
                    Lifecycle {
                        start: index,
                        stop: None,
                        contexts: vec![],
                    },
                );
                active = Some(id.into());
            } else if row["type"] == "turn_context" {
                if let Some(state) = p["turn_id"].as_str().and_then(|id| states.get_mut(id)) {
                    state.contexts.push(index);
                }
            } else if row["type"] == "event_msg"
                && (p["type"] == "task_complete"
                    || p["type"] == "turn_aborted" && p["reason"] == "interrupted")
            {
                let id = p["turn_id"].as_str().unwrap_or("");
                if active.as_deref() != Some(id) || states.get(id).is_none_or(|s| s.stop.is_some())
                {
                    invalid = true;
                    continue;
                }
                states.get_mut(id).unwrap().stop = Some(index);
                active = None;
                latest = Some(id.into());
                closed.push(id.into());
            } else if row["type"] == "event_msg"
                && matches!(p["type"].as_str(), Some("item_started" | "item_completed"))
            {
                let id = js::stringify(&p["item"]["id"])?;
                let prior = *seen.get(&id).unwrap_or(&0);
                if p["type"] == "item_completed"
                    && (p["turn_id"]
                        .as_str()
                        .and_then(|id| states.get(id))
                        .is_some_and(|s| s.stop.is_some())
                        || latest.is_some() && active.as_deref() != p["turn_id"].as_str())
                {
                    candidates.push(LateCandidate {
                        row: index,
                        active: active.clone(),
                        latest: latest.clone(),
                        closed: closed.len(),
                        prior,
                    });
                }
                seen.insert(id, prior + 1);
            }
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        ensure!(
            !invalid,
            "Native lifecycle contains repeated, invalid or unmatched boundaries."
        );
        for index in &source.starts {
            exact_frame(&rows[*index], &source.lines[*index])?;
        }
        for (index, row) in rows.iter().enumerate() {
            ensure!(
                row["ordinal"] == json!(index)
                    && (row["type"] == "session_meta") == source.starts.contains(&index)
                    && (!source.starts.contains(&index)
                        || (row["payload"]["id"] == self.thread_id
                            && row["payload"]["session_id"] == self.thread_id
                            && row["payload"]["history_mode"] == "paginated"
                            && self.same_directory(&row["payload"]["cwd"]))),
                "Native late-item source identity differs at row {index} (ordinal={}, header={}, thread={}, session={}, mode={}, cwd={}).",
                row["ordinal"] == json!(index),
                (row["type"] == "session_meta") == source.starts.contains(&index),
                row["payload"]["id"] == self.thread_id,
                row["payload"]["session_id"] == self.thread_id,
                row["payload"]["history_mode"] == "paginated",
                self.same_directory(&row["payload"]["cwd"])
            );
        }
        let mut api = BTreeMap::new();
        for turn in turns {
            let id = text(&turn["id"])?;
            ensure!(
                valid_uuid(id) && turn["items"].is_array() && api.insert(id, turn).is_none(),
                "Native API late-item turn identity is ambiguous."
            );
        }
        let exported_end = turns
            .last()
            .and_then(|t| t["id"].as_str())
            .and_then(|id| states.get(id))
            .and_then(|s| s.stop);
        let mut placements = vec![];
        let mut withheld = vec![];
        let mut selected = BTreeSet::new();
        let mut previous = 0;
        for candidate in candidates {
            let row = &rows[candidate.row];
            let p = &row["payload"];
            exact_frame(row, &source.lines[candidate.row])?;
            let parent_id = text(&p["turn_id"])?;
            let state = states.get(parent_id);
            let parent = api.get(parent_id);
            if parent.is_none()
                && state.is_some_and(|s| {
                    s.stop.is_some() && exported_end.is_some_and(|end| s.start > end)
                })
            {
                continue;
            }
            let mut position = candidate.closed;
            while position > 1 && empty_turn_ids.contains(&closed[position - 1]) {
                position -= 1;
            }
            let boundary_id = closed
                .get(
                    position
                        .checked_sub(1)
                        .context("Late item has no closed arrival boundary.")?,
                )
                .context("Missing late arrival boundary.")?;
            let boundary = states
                .get(boundary_id)
                .context("Missing late arrival lifecycle.")?;
            let after = api.get(boundary_id.as_str());
            let state = state.context("Late item parent lifecycle is missing.")?;
            let parent = parent.context("Late item parent API turn is missing.")?;
            let newest = candidate
                .latest
                .as_ref()
                .and_then(|id| states.get(id))
                .context("Late item has no newest closed boundary.")?;
            let parent_stop = state.stop.context("Late item parent did not close.")?;
            let boundary_stop = boundary
                .stop
                .context("Late item arrival boundary did not close.")?;
            let newest_stop = newest
                .stop
                .context("Newest native boundary did not close.")?;
            let running = candidate
                .active
                .as_ref()
                .map(|id| states.get(id).context("Late item running turn is missing."))
                .transpose()?;
            let subagent = p["item"]["type"] == "SubAgentActivity";
            ensure!(
                candidate.prior == 0
                    && boundary_stop >= parent_stop
                    && boundary_stop >= previous
                    && candidate.row > parent_stop
                    && (after.is_some() || exported_end.is_some_and(|end| boundary.start > end))
                    && running.is_none_or(|s| s.stop.is_none_or(|stop| stop > candidate.row)
                        && candidate.active.as_deref() != Some(parent_id)
                        && s.start > newest_stop
                        && s.start < candidate.row)
                    && needs(
                        p,
                        &["type", "thread_id", "turn_id", "item", "completed_at_ms"]
                    )
                    && p["thread_id"] == self.thread_id,
                "Late native arrival has an ambiguous parent, active turn or completion order."
            );
            let completed =
                integer(&p["completed_at_ms"]).context("Late completion time is invalid.")? as i64;
            if let Some(started) = p.get("started_at_ms") {
                let started =
                    integer(started).context("Late command start time is invalid.")? as i64;
                ensure!(
                    if subagent {
                        started <= completed
                    } else {
                        started >= time(&rows[state.start])? && started <= time(&rows[parent_stop])?
                    },
                    "Late command start lies outside its parent turn."
                );
            }
            ensure!(
                completed <= time(row)?
                    && completed > time(&rows[parent_stop])?
                    && completed >= time(&rows[newest_stop])?,
                "Late arrival timing contradicts its native boundary."
            );
            if let Some(running) = running {
                exact_frame(&rows[running.start], &source.lines[running.start])?;
            }
            let idle_end = running.map(|s| s.start).unwrap_or(candidate.row);
            let gap = &rows[newest_stop + 1..idle_end];
            let mut settled = gap.len();
            while running.is_some()
                && settled > 0
                && gap[settled - 1]["type"] == "event_msg"
                && gap[settled - 1]["payload"]["type"] == "thread_settings_applied"
            {
                settled -= 1;
            }
            // Unknown records are inert context. Only positive native activity
            // invalidates the idle interval; added labels alone never do.
            ensure!(
                !gap[..settled].iter().any(late_gap_activity),
                "Late native arrival is separated from its boundary by new native activity."
            );
            self.boundary(state, parent, &source, true)?;
            if let Some(after) = after {
                self.boundary(boundary, after, &source, false)?;
            }
            let mut projected = if subagent {
                project_agent(&p["item"])?
            } else {
                project_command(&p["item"])?
            };
            let matches = parent["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|i| i["id"] == projected["id"])
                .collect::<Vec<_>>();
            if projected["aggregatedOutput"] == ""
                && matches
                    .first()
                    .is_some_and(|i| i["aggregatedOutput"].is_null())
            {
                projected["aggregatedOutput"] = Value::Null;
            }
            ensure!(
                matches.len() == 1
                    && turns.iter().all(|t| t["id"] == parent["id"]
                        || !t["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|i| i["id"] == projected["id"]))
                    && selected.insert(text(&projected["id"])?.to_owned())
                    && projected == *matches[0],
                "Complete native late item differs from the full API item."
            );
            previous = boundary_stop;
            let placement = json!({"turnId":parent["id"],"itemId":projected["id"],"afterTurnId":boundary_id,"itemDigest":history::digest_json(matches[0])?});
            if after.is_some() {
                placements.push(placement)
            } else {
                withheld.push(placement)
            }
        }
        for guard in &source.guards {
            guard.verify()?;
        }
        if placements.is_empty() && withheld.is_empty() {
            return Ok(None);
        }
        let mut evidence = json!({"placements":placements,"sourceIdentity":source.source_identity});
        if !withheld.is_empty() {
            evidence["withheld"] = json!(withheld);
        }
        let mut proof = json!({"sourceDigest":source.digest,"placements":placements});
        if !withheld.is_empty() {
            proof["withheld"] = json!(withheld);
        }
        evidence["evidenceDigest"] = json!(history::digest_json(&proof)?);
        Ok(Some(evidence))
    }
}
fn late_gap_activity(row: &Value) -> bool {
    let p = &row["payload"];
    if row["type"] == "event_msg"
        && p["type"] == "item_completed"
        && matches!(
            p["item"]["type"].as_str(),
            Some("CommandExecution" | "SubAgentActivity")
        )
    {
        return false;
    }
    if row["type"] == "response_item" {
        return true;
    }
    if row["type"] == "turn_context" || row["type"] == "compacted" || row["type"] == "realtime_item"
    {
        return true;
    }
    row["type"] == "event_msg"
        && matches!(
            p["type"].as_str(),
            Some(
                "task_started"
                    | "task_complete"
                    | "turn_aborted"
                    | "item_started"
                    | "item_completed"
                    | "user_message"
                    | "agent_message"
                    | "agent_message_delta"
                    | "agent_reasoning"
                    | "agent_reasoning_delta"
                    | "agent_reasoning_raw_content"
                    | "agent_reasoning_raw_content_delta"
                    | "exec_command_begin"
                    | "exec_command_end"
                    | "exec_command_output_delta"
                    | "mcp_tool_call_begin"
                    | "mcp_tool_call_end"
                    | "patch_apply_begin"
                    | "patch_apply_end"
                    | "web_search_begin"
                    | "web_search_end"
                    | "thread_goal_updated"
                    | "thread_goal_cleared"
                    | "error"
                    | "stream_error"
            )
        )
}

#[derive(Clone, Debug)]
struct Request {
    turn: String,
    item: Value,
}
impl Request {
    fn key(&self) -> String {
        key(&self.turn, self.item["id"].as_str().unwrap())
    }
}
#[derive(Clone, Debug)]
pub struct ImageEvidence {
    requests: Vec<Request>,
    found: BTreeMap<String, Vec<Value>>,
    origins: BTreeMap<String, PathBuf>,
    guards: Vec<Guard>,
    source: Provenance,
    retained_path: bool,
    inherited: BTreeSet<String>,
    /// Count before conversion, including closed-turn status entries.
    pub native_message_count: usize,
}
impl ImageEvidence {
    pub fn verify(&self) -> Result<()> {
        for guard in &self.guards {
            guard.verify()?;
        }
        Ok(())
    }
    /// Final positions come from the selected native arrival representation,
    /// not from the raw API item ordinal. offset accounts for an owned packet
    /// expanding its two native items into an authenticated canonical prefix.
    pub fn promote(
        &self,
        common: &Common,
        positions: &[ImagePosition],
        offset: isize,
        checkpoint: Option<&Checkpoint>,
        retained: &[Value],
    ) -> Result<Value> {
        self.verify()?;
        ensure!(
            common.messages.len() as isize - self.native_message_count as isize == offset,
            "Native image provenance has an invalid canonical message offset."
        );
        let saved = parse_origins(retained)?;
        if self.requests.is_empty() {
            ensure!(
                saved.is_empty(),
                "Retained native image disappeared from complete API history."
            );
            return Ok(json!([]));
        }
        let pos = positions
            .iter()
            .map(|p| (key(&p.turn_id, &p.item_id), p.message_index))
            .collect::<BTreeMap<_, _>>();
        ensure!(
            pos.len() == positions.len(),
            "Native image canonical positions are ambiguous."
        );
        let mut absolute = BTreeMap::new();
        for request in &self.requests {
            let index = *pos
                .get(&request.key())
                .context("Native image is missing its canonical item position.")?;
            let canonical = index as isize + offset;
            ensure!(
                canonical >= 0 && (canonical as usize) < common.messages.len(),
                "Native image canonical position lies outside history."
            );
            absolute.insert(request.key(), canonical as usize);
        }
        if !saved.is_empty()
            || self.retained_path
            || self.origins.values().any(|p| p != &self.source.path)
        {
            // Declared history_base sources can prove new inherited messages;
            // only saved ledger origins require an earlier canonical checkpoint.
            let retained_requests = self
                .requests
                .iter()
                .filter(|r| {
                    let path = &self.origins[&r.key()];
                    path != &self.source.path && !self.inherited.contains(&r.key())
                })
                .collect::<Vec<_>>();
            if !saved.is_empty() || self.retained_path || !retained_requests.is_empty() {
                let cp = checkpoint.context(
                    "Retained native image evidence requires a verified canonical checkpoint.",
                )?;
                cp.validate()?;
                ensure!(
                    cp.contains(common)?,
                    "Retained native images contradict their complete canonical checkpoint."
                );
                for origin in &saved {
                    for request in &origin.requests {
                        ensure!(
                            request.message_index < cp.count
                                && absolute.get(&key(&request.turn_id, &request.item_id))
                                    == Some(&request.message_index),
                            "Retained native image moved or disappeared from its canonical identity."
                        );
                    }
                }
                for request in retained_requests {
                    if absolute[&request.key()] >= cp.count {
                        let path = &self.origins[&request.key()];
                        let inherited = self.source.resolve_history_base()?;
                        let link=inherited.iter().find(|l|&l.path==path).context("Retained native image cannot supply a new message beyond its checkpoint.")?;
                        let (scan, _) = self.source.scan_images(
                            link.path.as_path(),
                            &[(*request).clone()],
                            Some(link),
                            MAX_BYTES,
                            true,
                            usize::MAX,
                        )?;
                        ensure!(
                            scan.get(&request.key()) == self.found.get(&request.key()),
                            "Native history_base does not prove the new image."
                        );
                    }
                }
            }
        }
        let mut origins: BTreeMap<PathBuf, Vec<ImagePosition>> = BTreeMap::new();
        for request in &self.requests {
            origins
                .entry(self.origins[&request.key()].clone())
                .or_default()
                .push(ImagePosition {
                    turn_id: request.turn.clone(),
                    item_id: text(&request.item["id"])?.into(),
                    message_index: absolute[&request.key()],
                });
        }
        Ok(serde_json::to_value(
            origins
                .into_iter()
                .map(|(path, requests)| Origin { path, requests })
                .collect::<Vec<_>>(),
        )?)
    }
}
fn parse_origins(values: &[Value]) -> Result<Vec<Origin>> {
    ensure!(
        values.len() <= MAX_FILES,
        "Native image retained file count exceeds its bound."
    );
    let mut paths = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut out = vec![];
    for value in values {
        let origin: Origin = serde_json::from_value(value.clone())
            .context("Invalid retained native image origin schema.")?;
        ensure!(
            absolute(&origin.path)
                && paths.insert(origin.path.clone())
                && !origin.requests.is_empty()
                && origin.requests.len() <= MAX_ITEMS,
            "Invalid or ambiguous retained native image origin."
        );
        for r in &origin.requests {
            ensure!(
                !r.turn_id.is_empty()
                    && !r.item_id.is_empty()
                    && r.message_index <= 9_007_199_254_740_991usize
                    && ids.insert(key(&r.turn_id, &r.item_id))
                    && ids.len() <= MAX_ITEMS,
                "Invalid or conflicting retained native image identity."
            );
        }
        out.push(origin);
    }
    Ok(out)
}
fn translate(item: &Value) -> Result<Value> {
    ensure!(
        item["type"] == "UserMessage"
            && item["content"].is_array()
            && item.get("clientId").is_none(),
        "Native completed user item has contradictory identity aliases."
    );
    let mut out = item.clone();
    out["type"] = json!("userMessage");
    out["clientId"] = item.get("client_id").cloned().unwrap_or(Value::Null);
    out.as_object_mut().unwrap().remove("client_id");
    for input in out["content"].as_array_mut().unwrap() {
        if input["type"] == "local_image" {
            input["type"] = json!("localImage");
            if input.get("detail").is_none() {
                input["detail"] = Value::Null;
            }
        } else if input["type"] == "image" {
            ensure!(
                input.get("url").is_none() && input["image_url"].is_string(),
                "Native completed image has contradictory URL aliases."
            );
            input["url"] = input["image_url"].clone();
            input.as_object_mut().unwrap().remove("image_url");
            if input.get("detail").is_none() {
                input["detail"] = Value::Null;
            }
        }
    }
    Ok(out)
}
fn candidate(
    payload: &Value,
    request: &Request,
    active: &Option<String>,
    context: &Option<String>,
) -> Result<Option<Vec<Value>>> {
    let Some(content) = payload["content"].as_array() else {
        return Ok(None);
    };
    if !content.iter().any(|b| b["type"] == "input_image")
        || content.first().is_none_or(|b| {
            b["type"] != "input_text" || b["text"] != request.item["content"][0]["text"]
        })
    {
        return Ok(None);
    }
    let meta = &payload["internal_chat_message_metadata_passthrough"];
    ensure!(
        (packet::exact_keys(
            payload,
            &[
                "type",
                "id",
                "role",
                "content",
                "internal_chat_message_metadata_passthrough"
            ]
        ) || packet::exact_keys(
            payload,
            &[
                "type",
                "role",
                "content",
                "internal_chat_message_metadata_passthrough"
            ]
        )) && payload["type"] == "message"
            && payload["role"] == "user"
            && (payload.get("id").is_none() || nonempty(&payload["id"]))
            && (packet::exact_keys(meta, &["turn_id"])
                || packet::exact_keys(meta, &["turn_id", "create_time"])
                || packet::exact_keys(meta, &["turn_id", "create_time", "content_item_kinds"]))
            && meta["turn_id"] == request.turn
            && active.as_deref() == Some(&request.turn)
            && context.as_deref() == Some(&request.turn)
            && (meta.get("create_time").is_none()
                || meta["create_time"].as_f64().is_some_and(f64::is_finite))
            && packet::exact_keys(&content[0], &["type", "text"]),
        "Native image response provenance contradicts its API turn."
    );
    let inputs = request.item["content"].as_array().unwrap();
    let mut kinds = vec![json!("user.text")];
    let mut images = vec![];
    ensure!(
        content.len()
            == 1 + inputs
                .iter()
                .skip(1)
                .map(|i| if i["type"] == "localImage" { 3 } else { 1 })
                .sum::<usize>(),
        "Native image response count differs from its complete API item."
    );
    let mut cursor = 1;
    for (index, input) in inputs.iter().skip(1).enumerate() {
        if input["type"] == "image" {
            let image = &content[cursor];
            cursor += 1;
            ensure!(
                packet::exact_keys(image, &["type", "image_url", "detail"])
                    && image["type"] == "input_image"
                    && matches!(image["detail"].as_str(), Some("high" | "original"))
                    && inline(&image["image_url"]),
                "Native inline image model input is invalid."
            );
            kinds.push(json!("user.image"));
            continue;
        }
        let start = &content[cursor];
        let image = &content[cursor + 1];
        let end = &content[cursor + 2];
        cursor += 3;
        ensure!(
            packet::exact_keys(start, &["type", "text"])
                && start["type"] == "input_text"
                && start["text"]
                    == format!(
                        "<image name=[Image #{}] path=\"{}\">",
                        index + 1,
                        text(&input["path"])?
                    )
                && packet::exact_keys(image, &["type", "image_url", "detail"])
                && image["type"] == "input_image"
                && matches!(image["detail"].as_str(), Some("high" | "original"))
                && inline(&image["image_url"])
                && packet::exact_keys(end, &["type", "text"])
                && end["type"] == "input_text"
                && end["text"] == "</image>",
            "Native local image wrapper path, number, order or inline bytes differ."
        );
        images.push(json!({"url":image["image_url"],"detail":image["detail"]}));
        kinds.extend([json!("user.text"), json!("user.image"), json!("user.text")]);
    }
    ensure!(
        meta.get("content_item_kinds").is_none() || meta["content_item_kinds"] == json!(kinds),
        "Native image content-kind provenance differs."
    );
    Ok(Some(images))
}
#[derive(Default)]
struct ImageState {
    started: bool,
    closed: bool,
    completion: bool,
    candidate: Option<(usize, Vec<Value>)>,
    last: Option<usize>,
}
impl Provenance {
    fn scan_images(
        &self,
        path: &Path,
        requests: &[Request],
        link: Option<&HistoryLink>,
        limit: usize,
        allow_absent: bool,
        budget: usize,
    ) -> Result<(BTreeMap<String, Vec<Value>>, Document)> {
        let document = self.read(path, link.map(|l| &l.prefix), limit, false)?;
        let owner = link
            .map(|l| l.thread_id.as_str())
            .unwrap_or(&self.thread_id);
        ensure!(
            document
                .rows
                .first()
                .is_some_and(|r| r["type"] == "session_meta" && r["payload"]["id"] == owner),
            "Native image rollout metadata belongs to another thread."
        );
        let mut states: Vec<ImageState> =
            (0..requests.len()).map(|_| ImageState::default()).collect();
        let (mut active, mut context): (Option<String>, Option<String>) = (None, None);
        let mut found = BTreeMap::new();
        let mut bytes = 0;
        for (index, row) in document.rows.iter().enumerate().skip(1) {
            ensure!(
                row["type"] != "session_meta",
                "Native image rollout contains multiple metadata rows."
            );
            let p = &row["payload"];
            if row["type"] == "event_msg" && p["type"] == "task_started" {
                ensure!(
                    !requests
                        .iter()
                        .zip(&states)
                        .any(|(r, s)| Some(&r.turn) == active.as_ref() && !s.closed),
                    "Native image turn did not close before the next native turn."
                );
                active = p["turn_id"].as_str().map(str::to_owned);
                context = None;
                for (r, s) in requests.iter().zip(&mut states) {
                    if Some(&r.turn) == active.as_ref() {
                        ensure!(!s.started, "Native image turn started more than once.");
                        s.started = true;
                    }
                }
            } else if row["type"] == "turn_context" {
                context = p["turn_id"].as_str().map(str::to_owned);
                ensure!(
                    !requests.iter().any(|r| Some(&r.turn) == active.as_ref()) || context == active,
                    "Native image turn context changed."
                );
            } else if row["type"] == "response_item"
                && p["type"] == "message"
                && p["role"] == "user"
            {
                let mut candidates = vec![];
                for (i, r) in requests.iter().enumerate() {
                    if Some(&r.turn) == active.as_ref() {
                        if let Some(images) = candidate(p, r, &active, &context)? {
                            candidates.push((i, images));
                        }
                    }
                }
                ensure!(
                    candidates.len() <= 1,
                    "Native image response matches multiple API user items."
                );
                for (i, images) in candidates {
                    ensure!(
                        states[i].candidate.is_none(),
                        "Multiple native image responses match one API item."
                    );
                    bytes += images
                        .iter()
                        .map(|i| i["url"].as_str().unwrap().len())
                        .sum::<usize>();
                    ensure!(
                        bytes <= budget,
                        "Recovered native image output byte budget exceeded."
                    );
                    states[i].candidate = Some((index, images));
                }
            } else if row["type"] == "event_msg"
                && p["type"] == "item_completed"
                && p["item"]["type"] == "UserMessage"
            {
                for (r, s) in requests.iter().zip(&mut states) {
                    if p["item"]["id"] == r.item["id"] {
                        ensure!(
                            !s.completion
                                && p["thread_id"] == owner
                                && p["turn_id"] == r.turn
                                && active.as_deref() == Some(&r.turn)
                                && context.as_deref() == Some(&r.turn)
                                && translate(&p["item"])? == r.item,
                            "Native completed user item differs from complete API identity and content."
                        );
                        let (ordinal, images) = s
                            .candidate
                            .as_ref()
                            .context("Native image response is missing before completion.")?;
                        ensure!(
                            *ordinal < index && s.last.is_none_or(|last| *ordinal > last),
                            "Native image response is separated from its user completion."
                        );
                        s.completion = true;
                        found.insert(r.key(), images.clone());
                    }
                    if Some(&r.turn) == active.as_ref() {
                        s.last = Some(index);
                    }
                }
            } else if row["type"] == "event_msg"
                && (p["type"] == "task_complete"
                    || p["type"] == "turn_aborted" && p["reason"] == "interrupted")
            {
                if requests.iter().any(|r| Some(&r.turn) == active.as_ref()) {
                    ensure!(
                        p["turn_id"].as_str() == active.as_deref(),
                        "Native image closing turn identity changed."
                    );
                    for (r, s) in requests.iter().zip(&mut states) {
                        if Some(&r.turn) == active.as_ref() {
                            s.closed = true;
                        }
                    }
                }
                active = None;
                context = None;
            }
        }
        ensure!(
            (allow_absent || found.len() == requests.len())
                && states.iter().all(|s| (allow_absent
                    && !s.started
                    && !s.closed
                    && !s.completion
                    && s.candidate.is_none())
                    || (s.started && s.closed && s.completion)),
            "Native rollout lacks complete unambiguous image provenance."
        );
        Ok((found, document))
    }
    /// Call after the stable complete API read and authenticated owned bootstrap
    /// validation, before converting user blocks into portable image content.
    pub fn hydrate(
        &self,
        turns: &mut [Value],
        retained: &[Value],
        retained_path: Option<&Path>,
        image_budget: usize,
    ) -> Result<ImageEvidence> {
        self.validate()?;
        ensure!(
            image_budget > 0,
            "Native image output budget must be positive."
        );
        let saved = parse_origins(retained)?;
        if let Some(path) = retained_path {
            ensure!(absolute(path), "Invalid saved native image rollout path.");
        }
        let mut requests = vec![];
        let mut count = 0;
        let mut item_ids = BTreeSet::new();
        for turn in turns.iter() {
            for item in turn["items"]
                .as_array()
                .context("Native API items are incomplete.")?
            {
                if item["type"] == "userMessage"
                    && item["content"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|b| b["type"] == "localImage"))
                {
                    ensure!(
                        nonempty(&turn["id"])
                            && nonempty(&item["id"])
                            && item_ids.insert(text(&item["id"])?.to_owned())
                            && item["content"].as_array().is_some_and(|a| a.len() >= 2
                                && a[0]["type"] == "text"
                                && a[0]["text"].is_string()
                                && a.iter().skip(1).all(|b| if b["type"] == "localImage" {
                                    b["path"].as_str().is_some_and(|s| {
                                        !s.is_empty() && !s.contains(['"', '\r', '\n'])
                                    })
                                } else {
                                    b["type"] == "image" && inline(&b["url"])
                                })),
                        "Unsupported or ambiguous native local image request shape."
                    );
                    requests.push(Request {
                        turn: text(&turn["id"])?.into(),
                        item: item.clone(),
                    });
                }
                count += 1;
            }
            if matches!(turn["status"].as_str(), Some("failed" | "interrupted")) {
                count += 1;
            }
        }
        let requested = requests.iter().map(Request::key).collect::<BTreeSet<_>>();
        ensure!(
            saved
                .iter()
                .flat_map(|o| &o.requests)
                .all(|r| requested.contains(&key(&r.turn_id, &r.item_id))),
            "Retained native image disappeared from complete API history."
        );
        let mut evidence = ImageEvidence {
            requests: requests.clone(),
            found: BTreeMap::new(),
            origins: BTreeMap::new(),
            guards: vec![],
            source: self.clone(),
            retained_path: retained_path.is_some_and(|p| p != self.path),
            inherited: BTreeSet::new(),
            native_message_count: count,
        };
        if requests.is_empty() {
            return Ok(evidence);
        }
        let mut sources = vec![(self.path.clone(), None::<BTreeSet<String>>, false)];
        for origin in &saved {
            if origin.path != self.path {
                sources.push((
                    origin.path.clone(),
                    Some(
                        origin
                            .requests
                            .iter()
                            .map(|r| key(&r.turn_id, &r.item_id))
                            .collect(),
                    ),
                    true,
                ));
            }
        }
        if let Some(path) = retained_path {
            if path != self.path && !sources.iter().any(|(p, _, _)| p == path) {
                sources.push((path.into(), None, false));
            }
        }
        ensure!(
            sources.len() <= MAX_FILES,
            "Native image source count exceeds its bound."
        );
        let mut links: Option<Vec<HistoryLink>> = None;
        let mut expanded = false;
        let mut index = 0;
        let mut scanned = 0;
        let mut identities = BTreeSet::new();
        loop {
            if index == sources.len() {
                if expanded || evidence.found.len() == requests.len() {
                    break;
                }
                expanded = true;
                let chain = self.resolve_history_base()?;
                ensure!(
                    sources.len() + chain.len() <= MAX_FILES,
                    "Native image history_base file bound exceeded."
                );
                for link in &chain {
                    if !sources.iter().any(|(p, _, _)| p == &link.path) {
                        sources.push((
                            link.path.clone(),
                            Some(
                                requests
                                    .iter()
                                    .filter(|r| !evidence.found.contains_key(&r.key()))
                                    .map(Request::key)
                                    .collect(),
                            ),
                            false,
                        ));
                    }
                }
                links = Some(chain);
                if index == sources.len() {
                    break;
                }
            }
            let (path, selected, required) = &sources[index];
            index += 1;
            let selected = requests
                .iter()
                .filter(|r| selected.as_ref().is_none_or(|ids| ids.contains(&r.key())))
                .cloned()
                .collect::<Vec<_>>();
            if selected.is_empty() {
                continue;
            }
            if let Err(error) = self.safe(path) {
                if storage::is_not_found(&error)
                    && path != &self.path
                    && selected
                        .iter()
                        .all(|r| evidence.found.contains_key(&r.key()))
                {
                    continue;
                }
                return Err(error.context("Explicit native image origin is missing or unsafe."));
            }
            let link = if path == &self.path {
                None
            } else {
                let (owner, _) = self.header(path)?;
                if owner["id"] != self.thread_id
                    || links
                        .as_ref()
                        .is_some_and(|ls| ls.iter().any(|l| &l.path == path))
                {
                    if links.is_none() {
                        links = Some(self.resolve_history_base()?);
                    }
                    Some(links.as_ref().unwrap().iter().find(|l|&l.path==path).context("Retained native image belongs to an unrelated history_base thread.")?)
                } else {
                    None
                }
            };
            let (found, document) = self.scan_images(
                path,
                &selected,
                link,
                self.max_bytes.saturating_sub(scanned),
                !*required,
                image_budget,
            )?;
            let identity = (
                document.guard.identity.dev.clone(),
                document.guard.identity.ino.clone(),
            );
            ensure!(
                identities.insert(identity),
                "Native image rollout paths alias the same file."
            );
            scanned += document.scanned;
            evidence.guards.push(document.guard);
            for (k, images) in found {
                if let Some(previous) = evidence.found.get(&k) {
                    ensure!(
                        previous == &images,
                        "Current and retained native image proofs conflict."
                    );
                } else {
                    if link.is_some() {
                        evidence.inherited.insert(k.clone());
                    }
                    evidence.origins.insert(k.clone(), path.clone());
                    evidence.found.insert(k, images);
                }
            }
        }
        ensure!(
            evidence.found.len() == requests.len(),
            "Explicit native image evidence lacks complete provenance."
        );
        ensure!(
            evidence
                .found
                .values()
                .flatten()
                .map(|v| v["url"].as_str().unwrap().len())
                .sum::<usize>()
                <= image_budget,
            "Recovered native image output byte budget exceeded."
        );
        evidence.verify()?;
        for turn in turns {
            let turn_id = text(&turn["id"])?.to_owned();
            for item in turn["items"].as_array_mut().unwrap() {
                let k = key(&turn_id, item["id"].as_str().unwrap_or(""));
                if let Some(images) = evidence.found.get(&k) {
                    let mut images = images.iter();
                    for input in item["content"].as_array_mut().unwrap() {
                        if input["type"] == "localImage" {
                            let image = images.next().context("Native image count differs.")?;
                            *input = json!({"type":"image","url":image["url"],"nativeLocalImage":input,"nativePersistedImageDetail":image["detail"]});
                        }
                    }
                    ensure!(images.next().is_none(), "Native image count differs.");
                }
            }
        }
        Ok(evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::Message;
    use std::{
        io::Write,
        os::unix::fs::{PermissionsExt, symlink},
        process::{Command, Stdio},
    };
    const THREAD: &str = "00000000-0000-4000-8000-000000000001";
    const TURN: &str = "00000000-0000-4000-8000-000000000002";
    const AFTER: &str = "00000000-0000-4000-8000-000000000003";
    const SEGMENT: &str = "00000000-0000-4000-8000-000000000004";
    struct Fixture {
        _tmp: tempfile::TempDir,
        source: Provenance,
        rows: Vec<Value>,
        turns: Vec<Value>,
    }
    fn write(path: &Path, rows: &[Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let text = rows
            .iter()
            .map(|r| js::stringify(r).unwrap() + "\n")
            .collect::<String>();
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(home.join("sessions/2026/10/16")).unwrap();
        fs::create_dir(home.join("project")).unwrap();
        let source = Provenance {
            path: home.join(format!("sessions/2026/10/16/rollout-{THREAD}.jsonl")),
            cwd: home.join("project"),
            codex_home: home,
            max_bytes: MAX_BYTES,
            thread_id: THREAD.into(),
        };
        let item = json!({"type":"userMessage","id":"image-item","clientId":null,"content":[
            {"type":"text","text":"historical 中文 request","text_elements":[]},
            {"type":"localImage","path":"/never-read/source image.png","detail":null},
            {"type":"image","url":"data:image/png;base64,b3JpZ2luYWw=","detail":null}]});
        let response = json!({"type":"message","role":"user","content":[
            {"type":"input_text","text":item["content"][0]["text"]},
            {"type":"input_text","text":"<image name=[Image #1] path=\"/never-read/source image.png\">"},
            {"type":"input_image","image_url":"data:image/png;base64,bmF0aXZl","detail":"original"},
            {"type":"input_text","text":"</image>"},
            {"type":"input_image","image_url":"data:image/png;base64,cmVzaXplZA==","detail":"high"}],
            "internal_chat_message_metadata_passthrough":{"turn_id":TURN,"create_time":100.5,
                "content_item_kinds":["user.text","user.text","user.image","user.text","user.image"]}});
        let raw = json!({"type":"UserMessage","id":"image-item","content":[item["content"][0].clone(),
            {"type":"local_image","path":"/never-read/source image.png"},
            {"type":"image","image_url":"data:image/png;base64,b3JpZ2luYWw="}]});
        let rows = vec![
            json!({"type":"session_meta","payload":{"id":THREAD,"cwd":source.cwd}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":TURN}}),
            json!({"type":"turn_context","payload":{"turn_id":TURN,"cwd":source.cwd}}),
            json!({"type":"future_inert_context","payload":{"unfamiliar":"kept whole"}}),
            json!({"type":"response_item","payload":response}),
            json!({"type":"event_msg","payload":{"type":"item_completed","thread_id":THREAD,"turn_id":TURN,"item":raw}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":TURN,"last_agent_message":"Done"}}),
        ];
        let turns = vec![
            json!({"id":TURN,"status":"completed","itemsView":"full","startedAt":100,"completedAt":101,
            "items":[item,{"id":"answer","type":"agentMessage","text":"Done","phase":"final_answer"}]}),
        ];
        write(&source.path, &rows);
        Fixture {
            _tmp: tmp,
            source,
            rows,
            turns,
        }
    }
    fn positions(index: usize) -> Vec<ImagePosition> {
        vec![ImagePosition {
            turn_id: TURN.into(),
            item_id: "image-item".into(),
            message_index: index,
        }]
    }
    fn first_difference(left: &Value, right: &Value, path: &str) -> Option<String> {
        if left == right {
            return None;
        }
        match (left, right) {
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
                .iter()
                .zip(b)
                .enumerate()
                .find_map(|(i, (a, b))| first_difference(a, b, &format!("{path}/{i}"))),
            (Value::Object(a), Value::Object(b))
                if a.keys().collect::<BTreeSet<_>>() == b.keys().collect() =>
            {
                a.iter()
                    .find_map(|(k, a)| first_difference(a, &b[k], &format!("{path}/{k}")))
            }
            _ => Some(path.into()),
        }
    }
    fn common(count: usize) -> Common {
        Common {
            meta: serde_json::Map::new(),
            messages: (0..count)
                .map(|i| {
                    Message::text(
                        if i % 2 == 0 { "user" } else { "assistant" },
                        format!("Message {i}"),
                    )
                })
                .collect(),
            extra: serde_json::Map::new(),
        }
    }
    fn js_reference(
        source: &Provenance,
        turns: &[Value],
        operation: &str,
        retained: &[Value],
        retained_path: Option<&Path>,
    ) -> Value {
        js_reference_result(source, turns, operation, retained, retained_path).unwrap()
    }
    fn js_reference_result(
        source: &Provenance,
        turns: &[Value],
        operation: &str,
        retained: &[Value],
        retained_path: Option<&Path>,
    ) -> Result<Value> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let script = r#"
import {createCodexLocalImageResolver,createCodexRolloutLocator,hydrateNativeLocalImages} from './src/native-local-images.mjs';
import {createNativeLateItemResolver} from './src/native-late-items.mjs';
let s='';for await(const chunk of process.stdin)s+=chunk;
const r=JSON.parse(s),locateRollout=createCodexRolloutLocator(r.codexHome);
if(r.retainedPath===null)delete r.retainedPath;
let result;
if(r.operation==='images'){
 const resolveLocalImages=createCodexLocalImageResolver({...r,retainedRollouts:r.retained,locateRollout});
 result=(await hydrateNativeLocalImages({turns:r.turns,threadId:r.threadId},resolveLocalImages,268435456)).turns;
}else result=await createNativeLateItemResolver({...r,locateRollout,maxBytes:480*1024*1024})({turns:r.turns},{threadId:r.threadId});
process.stdout.write(JSON.stringify(result));
"#;
        let mut child = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child.stdin.take().unwrap().write_all(serde_json::to_string(&json!({"path":source.path,"threadId":source.thread_id,"cwd":source.cwd,
            "codexHome":source.codex_home,"turns":turns,"retained":retained,"retainedPath":retained_path,"operation":operation}))?.as_bytes())?;
        let out = child.wait_with_output()?;
        ensure!(
            out.status.success(),
            "JS reference failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(serde_json::from_slice(&out.stdout)?)
    }
    #[test]
    fn images_match_exact_native_completion_and_js_without_reading_attachment_paths() {
        assert!(!inline(&json!("data:😀😀fo,AAAA")));
        let f = fixture();
        let mut turns = f.turns.clone();
        let evidence = f.source.hydrate(&mut turns, &[], None, 1_048_576).unwrap();
        assert_eq!(
            json!(turns),
            js_reference(&f.source, &f.turns, "images", &[], None)
        );
        assert_eq!(
            turns[0]["items"][0]["content"][1]["url"],
            "data:image/png;base64,bmF0aXZl"
        );
        assert_eq!(
            turns[0]["items"][0]["content"][2]["url"],
            "data:image/png;base64,b3JpZ2luYWw="
        );
        assert_eq!(
            evidence
                .promote(&common(2), &positions(0), 0, None, &[])
                .unwrap()[0]["requests"][0]["messageIndex"],
            0
        );
        for mutate in 0..5 {
            let mut bad = f.rows.clone();
            match mutate {
                0 => bad[5]["payload"]["item"]["client_id"] = json!("foreign"),
                1 => {
                    bad[4]["payload"]["content"][1]["text"] =
                        json!("<image name=[Image #2] path=\"/never-read/source image.png\">")
                }
                2 => bad[5]["payload"]["turn_id"] = json!(AFTER),
                3 => {
                    bad[4]["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"] =
                        json!(["wrong"])
                }
                _ => bad[6]["payload"]["turn_id"] = json!(AFTER),
            }
            write(&f.source.path, &bad);
            assert!(
                f.source
                    .hydrate(&mut f.turns.clone(), &[], None, 1_048_576)
                    .is_err(),
                "mutation {mutate}"
            );
        }
    }
    #[test]
    fn interrupted_optional_native_metadata_and_compressed_representation_preserve_images() {
        let mut f = fixture();
        f.rows[4]["payload"]["internal_chat_message_metadata_passthrough"] =
            json!({"turn_id":TURN});
        f.rows[6]["payload"] = json!({"type":"turn_aborted","reason":"interrupted","turn_id":TURN});
        f.turns[0]["status"] = json!("interrupted");
        write(&f.source.path, &f.rows);
        let reference = js_reference(&f.source, &f.turns, "images", &[], None);
        let bytes = fs::read(&f.source.path).unwrap();
        fs::write(
            format!("{}.zst", f.source.path.display()),
            zstd::encode_all(bytes.as_slice(), 1).unwrap(),
        )
        .unwrap();
        fs::remove_file(&f.source.path).unwrap();
        let mut turns = f.turns.clone();
        let evidence = f.source.hydrate(&mut turns, &[], None, 1_048_576).unwrap();
        assert_eq!(json!(turns), reference);
        assert_eq!(evidence.native_message_count, 3);
        fs::write(&f.source.path, bytes).unwrap();
        assert!(evidence.verify().is_err());
    }
    fn rollover(f: &mut Fixture, remove_image: bool) -> PathBuf {
        let old = f.source.path.clone();
        f.source.path = f
            .source
            .path
            .with_file_name(format!("rollout-{THREAD}_{SEGMENT}.jsonl"));
        let rows = if remove_image {
            vec![json!({"type":"session_meta","payload":{"id":THREAD,"cwd":f.source.cwd}})]
        } else {
            f.rows.clone()
        };
        write(&f.source.path, &rows);
        old
    }
    #[test]
    fn retained_origins_need_complete_checkpoint_and_stable_canonical_identity() {
        let mut f = fixture();
        let initial = f
            .source
            .hydrate(&mut f.turns.clone(), &[], None, 1_048_576)
            .unwrap();
        let canonical = common(2);
        let saved = initial
            .promote(&canonical, &positions(0), 0, None, &[])
            .unwrap();
        let saved = saved.as_array().unwrap();
        let old = rollover(&mut f, true);
        let mut turns = f.turns.clone();
        let proof = f
            .source
            .hydrate(&mut turns, saved, Some(&old), 1_048_576)
            .unwrap();
        assert_eq!(
            json!(turns),
            js_reference(&f.source, &f.turns, "images", saved, Some(&old))
        );
        let cp = Checkpoint::of(&canonical).unwrap();
        assert!(
            proof
                .promote(&canonical, &positions(0), 0, None, saved)
                .is_err()
        );
        assert!(
            proof
                .promote(&canonical, &positions(1), 0, Some(&cp), saved)
                .is_err()
        );
        assert!(
            proof
                .promote(&canonical, &positions(0), 0, Some(&cp), saved)
                .is_ok()
        );
        let cp = Checkpoint::of(&common(1)).unwrap();
        assert!(
            proof
                .promote(&canonical, &positions(1), 0, Some(&cp), saved)
                .is_err()
        );
        let mut conflicting = f.rows.clone();
        conflicting[4]["payload"]["content"][2]["image_url"] =
            json!("data:image/png;base64,ZGlmZmVyZW50");
        write(&f.source.path, &conflicting);
        assert!(
            f.source
                .hydrate(&mut f.turns.clone(), saved, Some(&old), 1_048_576)
                .is_err()
        );
    }
    #[test]
    fn missing_old_origin_is_optional_only_when_current_fully_proves_saved_images() {
        let mut f = fixture();
        let proof = f
            .source
            .hydrate(&mut f.turns.clone(), &[], None, 1_048_576)
            .unwrap();
        let canonical = common(2);
        let cp = Checkpoint::of(&canonical).unwrap();
        let saved = proof
            .promote(&canonical, &positions(0), 0, None, &[])
            .unwrap();
        let old = rollover(&mut f, false);
        fs::remove_file(&old).unwrap();
        let proof = f
            .source
            .hydrate(
                &mut f.turns.clone(),
                saved.as_array().unwrap(),
                Some(&old),
                1_048_576,
            )
            .unwrap();
        assert_eq!(
            proof
                .promote(
                    &canonical,
                    &positions(0),
                    0,
                    Some(&cp),
                    saved.as_array().unwrap()
                )
                .unwrap()[0]["path"],
            json!(f.source.path)
        );
        // Only an unavailable old origin can be redundant. An existing
        // retained file which lost its bound image is contradictory evidence.
        write(&old, &[f.rows[0].clone()]);
        assert!(
            f.source
                .hydrate(
                    &mut f.turns.clone(),
                    saved.as_array().unwrap(),
                    Some(&old),
                    1_048_576
                )
                .is_err()
        );
        fs::remove_file(&old).unwrap();
        write(&f.source.path, &[f.rows[0].clone()]);
        assert!(
            f.source
                .hydrate(
                    &mut f.turns.clone(),
                    saved.as_array().unwrap(),
                    Some(&old),
                    1_048_576
                )
                .is_err()
        );
    }
    #[test]
    fn image_free_history_does_not_open_obsolete_sources_or_require_their_checkpoint() {
        let mut f = fixture();
        f.turns[0]["items"][0]["content"] = json!([{"type":"text","text":"No attachment"}]);
        let obsolete = f.source.path.with_file_name("missing-old-origin.jsonl");
        fs::remove_file(&f.source.path).unwrap();
        let proof = f
            .source
            .hydrate(&mut f.turns, &[], Some(&obsolete), 1_048_576)
            .unwrap();
        assert_eq!(
            proof.promote(&common(2), &[], 0, None, &[]).unwrap(),
            json!([])
        );
    }
    #[test]
    fn history_base_exact_prefix_and_fork_parent_prove_inherited_images() {
        for fork in [false, true] {
            let mut f = fixture();
            for (i, row) in f.rows.iter_mut().enumerate() {
                row["ordinal"] = json!(i);
            }
            write(&f.source.path, &f.rows);
            let old = f.source.path.clone();
            let length = fs::metadata(&old).unwrap().len();
            let original = THREAD;
            if fork {
                f.source.thread_id = SEGMENT.into();
            }
            f.source.path = f
                .source
                .path
                .with_file_name(format!("rollout-{}_{}.jsonl", f.source.thread_id, AFTER));
            let mut meta = json!({"type":"session_meta","ordinal":7,"payload":{"id":f.source.thread_id,"cwd":f.source.cwd,
                "history_base":{"thread_id":original,"end_byte_offset":length,"end_ordinal_exclusive":7}}});
            if fork {
                meta["payload"]["forked_from_id"] = json!(THREAD);
                meta["payload"]["forked_from_ordinal_exclusive"] = json!(7);
            }
            write(&f.source.path, &[meta]);
            let mut turns = f.turns.clone();
            let proof = f.source.hydrate(&mut turns, &[], None, 1_048_576).unwrap();
            assert_eq!(
                json!(turns),
                js_reference(&f.source, &f.turns, "images", &[], None)
            );
            assert!(
                proof
                    .promote(&common(2), &positions(0), 0, None, &[])
                    .is_ok()
            );
            let mut file = OpenOptions::new().append(true).open(&old).unwrap();
            writeln!(
                file,
                "{}",
                js::stringify(&json!({"type":"future_data","ordinal":7,"payload":{}})).unwrap()
            )
            .unwrap();
            proof.verify().unwrap();
            let changed = fs::read_to_string(&old)
                .unwrap()
                .replace("historical 中文 request", "changed historical request");
            fs::write(&old, changed).unwrap();
            assert!(proof.verify().is_err());
        }
    }
    #[test]
    fn image_aliases_ambiguous_segments_and_uncommitted_retained_images_are_refused() {
        let mut f = fixture();
        let proof = f
            .source
            .hydrate(&mut f.turns.clone(), &[], None, 1_048_576)
            .unwrap();
        let canonical = common(2);
        let saved = proof
            .promote(&canonical, &positions(0), 0, None, &[])
            .unwrap();
        let alias = f.source.path.with_file_name("alias.jsonl");
        fs::hard_link(&f.source.path, &alias).unwrap();
        let extra = json!([{"path":alias,"requests":[{"turnId":TURN,"itemId":"image-item","messageIndex":0}]}]);
        assert!(
            f.source
                .hydrate(
                    &mut f.turns.clone(),
                    extra.as_array().unwrap(),
                    None,
                    1_048_576
                )
                .is_err()
        );
        assert!(
            f.source
                .hydrate(&mut vec![], saved.as_array().unwrap(), None, 1_048_576)
                .is_err()
        );
        let symlink_path = f.source.path.with_file_name("symlink.jsonl");
        symlink(&f.source.path, &symlink_path).unwrap();
        f.source.path = symlink_path;
        assert!(
            f.source
                .hydrate(&mut f.turns.clone(), &[], None, 1_048_576)
                .is_err()
        );
    }
    #[test]
    fn legacy_saved_path_can_supply_a_new_image_only_inside_declared_history_base_prefix() {
        for inherited in [false, true] {
            let mut f = fixture();
            for (i, row) in f.rows.iter_mut().enumerate() {
                row["ordinal"] = json!(i);
            }
            write(&f.source.path, &f.rows);
            let old = f.source.path.clone();
            let size = fs::metadata(&old).unwrap().len();
            rollover(&mut f, true);
            if inherited {
                write(
                    &f.source.path,
                    &[
                        json!({"type":"session_meta","ordinal":7,"payload":{"id":THREAD,"cwd":f.source.cwd,
                    "history_base":{"thread_id":THREAD,"end_byte_offset":size,"end_ordinal_exclusive":7}}}),
                    ],
                );
            }
            f.turns[0]["items"].as_array_mut().unwrap().insert(
                0,
                json!({"type":"functionCallOutput","id":"earlier-context","output":"inert"}),
            );
            let evidence = f
                .source
                .hydrate(&mut f.turns.clone(), &[], Some(&old), 1_048_576)
                .unwrap();
            let canonical = common(3);
            let checkpoint = Checkpoint::of(&common(1)).unwrap();
            let result = evidence.promote(&canonical, &positions(1), 0, Some(&checkpoint), &[]);
            assert_eq!(result.is_ok(), inherited);
            if inherited {
                let bad = json!({"type":"session_meta","ordinal":4,"payload":{"id":THREAD,"cwd":f.source.cwd,
                    "history_base":{"thread_id":THREAD,"end_byte_offset":size,"end_ordinal_exclusive":4}}});
                write(&f.source.path, &[bad]);
                assert!(
                    evidence
                        .promote(&canonical, &positions(1), 0, Some(&checkpoint), &[])
                        .is_err()
                );
            }
        }
    }
    fn framed(type_: &str, payload: Value, ms: i64, ordinal: usize) -> Value {
        json!({"timestamp":chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
            "type":type_,"payload":payload,"ordinal":ordinal})
    }
    fn late_fixture() -> Fixture {
        let mut f = fixture();
        let mut rows = vec![framed(
            "session_meta",
            json!({"id":THREAD,"cwd":f.source.cwd,"session_id":THREAD,"history_mode":"paginated"}),
            99_000,
            0,
        )];
        let mut turns = vec![];
        for (id, start, n) in [(TURN, 100, 1usize), (AFTER, 200, 4usize)] {
            rows.extend([
                framed("event_msg",json!({"type":"task_started","turn_id":id,"root_turn_id":id,"started_at":start,
                    "model_context_window":100000,"collaboration_mode_kind":"default"}),start*1000+100,n),
                framed("turn_context",json!({"turn_id":id,"cwd":f.source.cwd,"unknown_native_field":true}),start*1000+200,n+1),
                framed("event_msg",json!({"type":"task_complete","turn_id":id,"started_at":start,"completed_at":start+1,"duration_ms":900,"last_agent_message":"Done"}),(start+1)*1000,n+2)]);
            turns.push(json!({"id":id,"status":"completed","error":null,"itemsView":"full","startedAt":start,"completedAt":start+1,
                "items":[{"type":"userMessage","id":format!("user-{id}"),"content":[{"type":"text","text":"Ask"}]},
                    {"type":"agentMessage","id":format!("answer-{id}"),"text":"Done","phase":"final_answer"}]}));
        }
        let raw = json!({"type":"CommandExecution","id":"late-command","cwd":url::Url::from_directory_path(&f.source.cwd).unwrap().as_str().trim_end_matches('/'),
            "command":["/bin/zsh","-lc","printf '%s' \"synthetic\""],"process_id":"12345","source":"unified_exec_startup","status":"failed",
            "parsed_cmd":[{"type":"unknown","cmd":"printf '%s' \"synthetic\""}],"aggregated_output":"Result\n","stdout":"Result\n","stderr":"",
            "formatted_output":"Result\n","exit_code":-1,"duration":{"secs":101,"nanos":499999999}});
        turns[0]["items"]
            .as_array_mut()
            .unwrap()
            .push(project_command(&raw).unwrap());
        rows.push(framed(
            "event_msg",
            json!({"type":"item_completed","thread_id":THREAD,"turn_id":TURN,"item":raw,
            "started_at_ms":100500,"completed_at_ms":202000}),
            202014,
            7,
        ));
        f.source.max_bytes = 480 * 1024 * 1024;
        f.rows = rows;
        f.turns = turns;
        write(&f.source.path, &f.rows);
        f
    }
    #[test]
    fn late_command_and_subagent_proofs_match_exact_js_arrival_evidence() {
        let mut f = late_fixture();
        let proof = f
            .source
            .late_items(&f.turns, &BTreeSet::new())
            .unwrap()
            .unwrap();
        assert_eq!(proof, js_reference(&f.source, &f.turns, "late", &[], None));
        assert_eq!(proof["placements"][0]["afterTurnId"], AFTER);
        f.rows[7]["payload"]["item"] = json!({"type":"SubAgentActivity","id":"late-agent","kind":"completed",
            "agent_thread_id":SEGMENT,"agent_path":"/root/child"});
        f.turns[0]["items"][2] = project_agent(&f.rows[7]["payload"]["item"]).unwrap();
        write(&f.source.path, &f.rows);
        assert_eq!(
            f.source
                .late_items(&f.turns, &BTreeSet::new())
                .unwrap()
                .unwrap(),
            js_reference(&f.source, &f.turns, "late", &[], None)
        );
    }
    #[test]
    fn late_arrivals_reject_changed_api_prior_dispatch_and_activity_but_keep_unknown_context() {
        let mut f = late_fixture();
        f.turns[0]["items"][2]["aggregatedOutput"] = json!("changed");
        assert!(f.source.late_items(&f.turns, &BTreeSet::new()).is_err());
        f = late_fixture();
        f.rows.insert(
            7,
            framed("future_metadata", json!({"novel":true}), 201500, 7),
        );
        f.rows[8]["ordinal"] = json!(8);
        write(&f.source.path, &f.rows);
        assert!(
            f.source
                .late_items(&f.turns, &BTreeSet::new())
                .unwrap()
                .is_some()
        );
        f.rows[7] = framed(
            "event_msg",
            json!({"type":"agent_future_metadata","novel":true}),
            201500,
            7,
        );
        write(&f.source.path, &f.rows);
        assert!(
            f.source
                .late_items(&f.turns, &BTreeSet::new())
                .unwrap()
                .is_some()
        );
        f.rows[7] = framed(
            "event_msg",
            json!({"type":"user_message","message":"new activity"}),
            201500,
            7,
        );
        write(&f.source.path, &f.rows);
        assert!(f.source.late_items(&f.turns, &BTreeSet::new()).is_err());
        f = late_fixture();
        let mut start = f.rows[7].clone();
        start["ordinal"] = json!(3);
        start["payload"]["type"] = json!("item_started");
        f.rows.insert(3, start);
        for (i, row) in f.rows.iter_mut().enumerate() {
            row["ordinal"] = json!(i);
        }
        write(&f.source.path, &f.rows);
        assert!(f.source.late_items(&f.turns, &BTreeSet::new()).is_err());
    }
    #[test]
    fn shell_quotes_and_file_uri_projection_are_lossless_data() {
        assert_eq!(
            [
                "safe",
                "two words",
                "can't",
                "$literal",
                "a\\b",
                "^caret",
                "",
                "非 ASCII"
            ]
            .iter()
            .map(|s| native_quote(s).unwrap())
            .collect::<Vec<_>>()
            .join(" "),
            "safe 'two words' \"can't\" '$literal' \"a\\\\b\" '^caret' '' '非 ASCII'"
        );
        assert!(native_quote("a\0b").is_err());
        let mut f = late_fixture();
        f.rows[7]["payload"]
            .as_object_mut()
            .unwrap()
            .remove("started_at_ms");
        f.rows[7]["payload"]["item"]["aggregated_output"] = json!("");
        f.rows[7]["payload"]["item"]
            .as_object_mut()
            .unwrap()
            .remove("stdout");
        f.rows[7]["payload"]["item"]
            .as_object_mut()
            .unwrap()
            .remove("formatted_output");
        f.turns[0]["items"][2]["aggregatedOutput"] = Value::Null;
        write(&f.source.path, &f.rows);
        assert_eq!(
            f.source
                .late_items(&f.turns, &BTreeSet::new())
                .unwrap()
                .unwrap(),
            js_reference(&f.source, &f.turns, "late", &[], None)
        );
    }
    #[test]
    fn late_rollover_preserves_cross_segment_lifecycle_and_withholds_unexported_boundary() {
        let mut f = late_fixture();
        let tail = f.rows.split_off(7);
        write(&f.source.path, &f.rows);
        let size = fs::metadata(&f.source.path).unwrap().len();
        f.source.path = f
            .source
            .path
            .with_file_name(format!("rollout-{THREAD}_{SEGMENT}.jsonl"));
        let mut rows = vec![framed(
            "session_meta",
            json!({"id":THREAD,"cwd":f.source.cwd,"session_id":THREAD,"history_mode":"paginated",
            "history_base":{"thread_id":THREAD,"end_byte_offset":size,"end_ordinal_exclusive":7}}),
            201500,
            7,
        )];
        rows.extend(tail.into_iter().map(|mut row| {
            row["ordinal"] = json!(8);
            row
        }));
        write(&f.source.path, &rows);
        let proof = f
            .source
            .late_items(&f.turns, &BTreeSet::new())
            .unwrap()
            .unwrap();
        assert_eq!(proof["placements"][0]["afterTurnId"], AFTER);
        f.turns.pop();
        let proof = f
            .source
            .late_items(&f.turns, &BTreeSet::new())
            .unwrap()
            .unwrap();
        assert_eq!(proof["placements"], json!([]));
        assert_eq!(proof["withheld"][0]["afterTurnId"], AFTER);
        let proof = f
            .source
            .late_items(&f.turns, &BTreeSet::from([AFTER.into()]))
            .unwrap()
            .unwrap();
        assert_eq!(proof["placements"][0]["afterTurnId"], TURN);
    }
    #[tokio::test]
    #[ignore = "explicit read-only audit of saved local histories and the already-running shared backend; no model calls"]
    async fn real_local_image_and_late_provenance_audit() -> Result<()> {
        let root = PathBuf::from(
            std::env::var_os("CLAUDEX_PROVENANCE_AUDIT_ROOT")
                .context("Set the existing live state root explicitly.")?,
        );
        let state = storage::read_json(root.join("desktop-state.json"))?;
        let manifest = storage::read_json(root.join("codex-shared/owner.json"))?;
        let client = claudex_core::rpc::CodexClient::connect_with_limit(
            Path::new(text(&manifest["socketPath"])?),
            268435456,
        )
        .await?;
        let initialized = client.initialize().await?;
        let home = fs::canonicalize(text(&initialized["codexHome"])?)?;
        let mut seen = BTreeSet::new();
        let (mut attempted, mut accepted, mut images, mut unavailable, mut no_longer_images) =
            (0, 0, 0, 0, 0);
        let mut late_with_commands = 0;
        let mut late_accepted = 0;
        let mut late_refused = 0;
        for record in state["records"]
            .as_array()
            .context("Missing local records.")?
            .iter()
            .rev()
        {
            if record["side"] != "codex"
                || record["localImageRollouts"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
                || !seen.insert(text(&record["nativeId"])?.to_owned())
            {
                continue;
            }
            attempted += 1;
            let id = text(&record["nativeId"])?;
            let metadata = match client
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await
            {
                Ok(v) => v["thread"].clone(),
                Err(_) => {
                    unavailable += 1;
                    continue;
                }
            };
            if !matches!(
                metadata["status"]["type"].as_str(),
                Some("idle" | "notLoaded")
            ) {
                unavailable += 1;
                continue;
            }
            let source = Provenance {
                path: PathBuf::from(text(&metadata["path"])?),
                thread_id: id.into(),
                cwd: fs::canonicalize(text(&metadata["cwd"])?)?,
                codex_home: home.clone(),
                max_bytes: MAX_BYTES,
            };
            let mut turns = vec![];
            let mut cursor = Value::Null;
            for _ in 0..256 {
                let mut request =
                    json!({"threadId":id,"limit":100,"itemsView":"full","sortDirection":"asc"});
                if !cursor.is_null() {
                    request["cursor"] = cursor.clone();
                }
                let page = client.request("thread/turns/list", request).await?;
                turns.extend(
                    page["data"]
                        .as_array()
                        .context("Invalid full API page.")?
                        .iter()
                        .cloned(),
                );
                cursor = page["nextCursor"].clone();
                if cursor.is_null() {
                    break;
                }
            }
            ensure!(
                cursor.is_null(),
                "Real audit API pagination exceeds its bound."
            );
            if !turns.iter().any(|t| {
                t["items"].as_array().is_some_and(|a| {
                    a.iter().any(|i| {
                        i["content"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|b| b["type"] == "localImage"))
                    })
                })
            }) {
                no_longer_images += 1;
                continue;
            }
            let retained = record["localImageRollouts"].as_array().unwrap();
            let old = record["path"]
                .as_str()
                .map(Path::new)
                .filter(|p| *p != source.path);
            let mut hydrated = turns.clone();
            let evidence = source.hydrate(&mut hydrated, retained, old, 268435456)?;
            let reference = js_reference(&source, &turns, "images", retained, old);
            // Compare only recovered user content; unrelated tool bodies can
            // contain numbers beyond JavaScript's exact integer range.
            for request in &evidence.requests {
                let find = |values: &[Value]| {
                    values.iter().find(|t| t["id"] == request.turn).unwrap()["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|i| i["id"] == request.item["id"])
                        .unwrap()["content"]
                        .clone()
                };
                let expected = find(reference.as_array().context("Missing JS hydrated turns.")?);
                let actual = find(&hydrated);
                ensure!(
                    actual == expected,
                    "Real native image differential mismatch at {}.",
                    first_difference(&actual, &expected, "content").unwrap_or_default()
                );
            }
            images += evidence.requests.len();
            evidence.verify()?;
            accepted += 1;
            if turns.iter().any(|t| {
                t["items"].as_array().is_some_and(|a| {
                    a.iter().any(|i| {
                        matches!(
                            i["type"].as_str(),
                            Some("commandExecution" | "subAgentActivity")
                        )
                    })
                })
            }) {
                late_with_commands += 1;
                let mut late_source = source.clone();
                late_source.max_bytes = 480 * 1024 * 1024;
                let rust = late_source.late_items(&turns, &BTreeSet::new());
                let reference = js_reference_result(&late_source, &turns, "late", &[], None);
                match (rust, reference) {
                    (Ok(rust), Ok(reference)) => {
                        let actual = rust.clone().unwrap_or(Value::Null);
                        ensure!(
                            actual == reference,
                            "Real late-item differential mismatch at {}.",
                            first_difference(&actual, &reference, "proof").unwrap_or_default()
                        );
                        if rust.is_some() {
                            late_accepted += 1;
                        }
                    }
                    (Err(rust), Err(reference)) => {
                        // A moved history's old header can contradict its
                        // current API cwd. Both readers must retain this
                        // exact ownership refusal; it is not a new label.
                        ensure!(
                            rust.to_string().contains("source identity differs")
                                && reference
                                    .to_string()
                                    .contains("source header or ordinal chain differs"),
                            "Real late-item readers refused different proof conditions."
                        );
                        late_refused += 1;
                    }
                    _ => anyhow::bail!("Real late-item Rust/JS acceptance differs."),
                }
            }
            if accepted >= 6 {
                break;
            }
        }
        client.close().await?;
        ensure!(
            accepted > 0,
            "Real local image audit found no eligible stable image source."
        );
        eprintln!(
            "{}",
            json!({"readOnly":true,"modelRequests":0,"attempted":attempted,"accepted":accepted,
            "imageItems":images,"unavailable":unavailable,"noLongerImages":no_longer_images,
            "historiesWithCommands":late_with_commands,"lateProofs":late_accepted,"matchingLateRefusals":late_refused})
        );
        Ok(())
    }
}
