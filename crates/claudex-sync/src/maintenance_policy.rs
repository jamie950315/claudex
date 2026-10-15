//! Read-only cold-maintenance policy proof for the pinned macOS namespace.
//! Policy values stay local to resolution; callers retain only source proofs.
#[path = "maintenance_settings.rs"]
mod settings;
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    ffi::CStr,
    fs,
    io::{Read, Write},
    os::unix::ffi::OsStrExt,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MANAGED_LIMIT: usize = 2 * 1024 * 1024;
const REMOTE_LIMIT: usize = 8 * 1024 * 1024;
const MAX_DROP_INS: usize = 256;
const PREFIX: &str = "Cold maintenance policy preflight failed";

fn failure(reason: &str) -> anyhow::Error {
    anyhow::anyhow!("{PREFIX}: {reason}.")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshot {
    pub version: u32,
    pub platform: String,
    pub sources: Vec<PolicySource>,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicySource {
    pub path: PathBuf,
    pub kind: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<FileIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    // Ordinary directory timestamps change with unrelated native runtime files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ino: Option<String>,
}

#[derive(Clone)]
struct PolicyPaths {
    managed: PathBuf,
    user_plist: PathBuf,
    device_plist: PathBuf,
}
struct Observation {
    source: PolicySource,
    directory: bool,
    enumerate: bool,
}

fn namespace(path: &Path) -> bool {
    path.is_absolute() && !path.to_string_lossy().contains(['\0', '\r', '\n'])
}
fn username() -> Result<String> {
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut result = std::ptr::null_mut();
    // getpwuid_r writes its record and strings into the provided live buffers.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            record.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    ensure!(
        status == 0 && !result.is_null(),
        "{PREFIX}: the policy namespace is invalid."
    );
    // A successful lookup returns a NUL-terminated name within the buffer.
    let name = unsafe { CStr::from_ptr((*result).pw_name) }
        .to_str()
        .map_err(|_| failure("the policy namespace is invalid"))?;
    ensure!(
        !name.is_empty() && !name.contains(['/', '\\', '\0', '\r', '\n']),
        "{PREFIX}: the policy namespace is invalid."
    );
    Ok(name.to_owned())
}

fn inspect(path: &Path, directory: bool) -> Result<Option<fs::Metadata>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("a policy source could not be inspected")),
    };
    ensure!(
        !metadata.file_type().is_symlink()
            && if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            },
        "{PREFIX}: policy sources must be regular files and directories without symbolic links."
    );
    Ok(Some(metadata))
}
fn source(
    path: &Path,
    kind: &str,
    metadata: Option<&fs::Metadata>,
    enumerate: bool,
) -> PolicySource {
    let identity = metadata.map(FileIdentity::from_metadata);
    let directory = kind == "directory";
    PolicySource {
        path: path.into(),
        kind: kind.into(),
        exists: metadata.is_some(),
        dev: directory
            .then(|| identity.as_ref().map(|i| i.dev.clone()))
            .flatten(),
        ino: directory
            .then(|| identity.as_ref().map(|i| i.ino.clone()))
            .flatten(),
        identity: if directory && !enumerate {
            None
        } else {
            identity
        },
        sha256: None,
    }
}
fn directory(path: &Path, enumerate: bool, observations: &mut Vec<Observation>) -> Result<bool> {
    let info = inspect(path, true)?;
    observations.push(Observation {
        source: source(path, "directory", info.as_ref(), enumerate),
        directory: true,
        enumerate,
    });
    Ok(info.is_some())
}
fn parent_directories(
    path: &Path,
    seen: &mut BTreeSet<PathBuf>,
    observations: &mut Vec<Observation>,
) -> Result<()> {
    let mut parents = path.ancestors().skip(1).collect::<Vec<_>>();
    parents.reverse();
    for parent in parents {
        if seen.insert(parent.into()) {
            directory(parent, false, observations)?;
        }
    }
    Ok(())
}
fn bytes(path: &Path, initial: &fs::Metadata, limit: usize) -> Result<Vec<u8>> {
    ensure!(
        initial.len() <= limit as u64,
        "{PREFIX}: a policy source exceeds its pinned size limit."
    );
    let read = || -> Result<Vec<u8>> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let identity = FileIdentity::from_metadata(initial);
        ensure!(
            identity == FileIdentity::from_metadata(&file.metadata()?),
            "Policy source changed before read."
        );
        let mut output = Vec::new();
        Read::by_ref(&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut output)?;
        ensure!(output.len() <= limit, "Policy source exceeds bound.");
        ensure!(
            identity == FileIdentity::from_metadata(&file.metadata()?)
                && identity == FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
            "Policy source changed during read."
        );
        Ok(output)
    };
    read().map_err(|_| {
        failure("a policy source could not be read safely within its pinned size limit")
    })
}
fn object(bytes: &[u8]) -> Result<Value> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| failure("a policy source is not a valid strict JSON object"))?;
    ensure!(
        value.is_object(),
        "{PREFIX}: a policy source is not a valid strict JSON object."
    );
    Ok(value)
}

/// plutil receives the exact stable bytes on stdin, not a reopenable source path.
fn plist(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut child = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "--", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failure("a managed preferences source could not be decoded"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let input = bytes.to_vec();
    let writer = thread::spawn(move || stdin.write_all(&input));
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        stdout
            .by_ref()
            .take(MANAGED_LIMIT as u64 + 1)
            .read_to_end(&mut out)
            .map(|_| out)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let written = writer.join().ok().and_then(std::result::Result::ok);
    let output = reader
        .join()
        .ok()
        .and_then(std::result::Result::ok)
        .ok_or_else(|| failure("a managed preferences source could not be decoded"))?;
    ensure!(
        output.len() <= MANAGED_LIMIT,
        "{PREFIX}: decoded managed preferences exceed the pinned size limit."
    );
    ensure!(
        status.is_some_and(|s| s.success()) && written.is_some(),
        "{PREFIX}: a managed preferences source could not be decoded."
    );
    Ok(output)
}
fn file(
    path: &Path,
    kind: &str,
    limit: usize,
    observations: &mut Vec<Observation>,
    decode: &mut impl FnMut(&[u8]) -> Result<Vec<u8>>,
) -> Result<Option<Value>> {
    let info = inspect(path, false)?;
    let mut proof = source(path, kind, info.as_ref(), false);
    let value = if let Some(info) = info {
        let input = bytes(path, &info, limit)?;
        let mut value = if kind == "plist" {
            let output = decode(&input)
                .map_err(|_| failure("a managed preferences source could not be decoded"))?;
            ensure!(
                output.len() <= MANAGED_LIMIT,
                "{PREFIX}: decoded managed preferences exceed the pinned size limit."
            );
            object(&output)?
        } else {
            object(&input)?
        };
        if kind == "remote-json" {
            value
                .as_object_mut()
                .unwrap()
                .retain(|key, _| !key.starts_with('$') || key == "$schema");
        }
        let value = settings::normalize(value)?;
        proof.sha256 = Some(storage::hash_bytes(&input));
        Some(value)
    } else {
        None
    };
    observations.push(Observation {
        source: proof,
        directory: false,
        enumerate: false,
    });
    Ok(value)
}

// The pinned SDK's file/drop-in merge unions arrays in source order; managed
// tier merging prepends higher arrays. Policy helpers belong to the top tier.
fn merge(target: &mut Value, incoming: &Value, high_first: bool) {
    match (target, incoming) {
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                if let Some(old) = target.get_mut(key) {
                    if key == "fallbackModel" || key == "modelPicker" {
                        *old = value.clone();
                    } else {
                        merge(old, value, high_first);
                    }
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        (Value::Array(target), Value::Array(incoming)) => {
            let old = std::mem::take(target);
            let values = if high_first {
                incoming.iter().chain(old.iter())
            } else {
                old.iter().chain(incoming.iter())
            };
            for value in values {
                // SDK uniq uses reference identity for compound values. Equal
                // object/array nodes parsed from separate JSON rows stay whole.
                if value.is_object() || value.is_array() || !target.contains(value) {
                    target.push(value.clone());
                }
            }
        }
        (target, incoming) => *target = incoming.clone(),
    }
}
fn active(value: &Value) -> bool {
    value.as_object().is_some_and(|v| {
        v.keys().any(|key| {
            !matches!(
                key.as_str(),
                "managedSourcesBehavior" | "wslInheritsWindowsSettings"
            )
        })
    })
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn hook_count_positive(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_some_and(|n| n > 0.0),
        Value::Bool(b) => *b,
        Value::String(_) | Value::Array(_) => {
            // Preserve the resolver guard's JavaScript `value > 0` coercion,
            // including a singleton JSON array or a radix-prefixed string.
            let text = settings::js_string(value);
            let text = text.trim_matches(|c: char| {
                matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
                    | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
                    | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
            });
            if matches!(text, "Infinity" | "+Infinity") {
                return true;
            }
            for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
                if text.to_ascii_lowercase().starts_with(prefix) {
                    let digits = &text[2..];
                    return !digits.is_empty()
                        && digits.chars().all(|c| c.is_digit(radix))
                        && digits.chars().any(|c| c != '0');
                }
            }
            regex::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
                .unwrap()
                .is_match(text)
                && text.parse::<f64>().is_ok_and(|n| n > 0.0)
        }
        _ => false,
    }
}
fn resolve(
    remote: Option<Value>,
    user: Option<Value>,
    device: Option<Value>,
    files: Value,
) -> Result<Value> {
    let remote = remote.map(|mut value| {
        value
            .as_object_mut()
            .unwrap()
            .retain(|k, _| !k.starts_with('$') || k == "$schema");
        value
    });
    let mdm = user.filter(active).or_else(|| device.filter(active));
    let raw = [remote, mdm, Some(files)];
    let mode = raw
        .iter()
        .flatten()
        .find(|v| v.get("managedSourcesBehavior").is_some() || active(v))
        .and_then(|v| v["managedSourcesBehavior"].as_str());
    let tiers = raw
        .iter()
        .flatten()
        .filter(|v| active(v))
        .collect::<Vec<_>>();
    let mut effective = tiers
        .first()
        .map(|v| (*v).clone())
        .unwrap_or_else(|| json!({}));
    if mode == Some("merge") && tiers.len() > 1 {
        effective = json!({});
        for (index, tier) in tiers.iter().enumerate().rev() {
            let mut tier = (*tier).clone();
            if index != 0 {
                for key in [
                    "apiKeyHelper",
                    "awsAuthRefresh",
                    "awsCredentialExport",
                    "gcpAuthRefresh",
                    "otelHeadersHelper",
                    "proxyAuthHelper",
                    "forceLoginOrgUUID",
                    "forceLoginMethod",
                    "forceLoginGatewayUrl",
                    "gatewayInternalNetworks",
                    "parentSettingsBehavior",
                    "env",
                    "modelPicker",
                    "policyHelper",
                    "policyHelpers",
                    "managedSourcesBehavior",
                    "wslInheritsWindowsSettings",
                ] {
                    tier.as_object_mut().unwrap().remove(key);
                }
                if let Some(p) = tier["permissions"].as_object_mut() {
                    p.remove("defaultMode");
                }
            }
            merge(&mut effective, &tier, true);
        }
    }
    effective
        .as_object_mut()
        .unwrap()
        .remove("managedSourcesBehavior");
    ensure!(
        !truthy(&effective["policyHelper"])
            && !truthy(&effective["policyHelpers"])
            && !truthy(&effective["policyUnreadable"])
            && !hook_count_positive(&effective["policyHookCount"]),
        "Cold maintenance cannot establish hook-free managed policy."
    );
    let hooks = &effective["hooks"];
    let configured = match hooks {
        Value::Object(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::String(v) => !v.is_empty(),
        _ => false,
    };
    ensure!(
        !configured,
        "Cold maintenance refuses configured managed hooks; organizational policy is not overridden."
    );
    // settingSources:[] exposes only the resolved managed source (flag is empty).
    let sources = if effective.as_object().unwrap().is_empty() {
        json!([])
    } else {
        json!([{"source":"managed","settings":effective}])
    };
    Ok(json!({"effective":effective,"sources":sources}))
}

fn read_paths(
    home: &Path,
    cwd: &Path,
    paths: &PolicyPaths,
    mut decode: impl FnMut(&[u8]) -> Result<Vec<u8>>,
) -> Result<PolicySnapshot> {
    ensure!(
        [
            home,
            cwd,
            &paths.managed,
            &paths.user_plist,
            &paths.device_plist
        ]
        .into_iter()
        .all(namespace),
        "{PREFIX}: the policy namespace is invalid."
    );
    let mut observations = vec![];
    let mut seen = BTreeSet::new();
    for path in [
        &paths.managed,
        &paths.user_plist,
        &paths.device_plist,
        &home.join("remote-settings.json"),
    ] {
        parent_directories(path, &mut seen, &mut observations)?;
    }
    directory(&paths.managed, false, &mut observations)?;
    let mut files = file(
        &paths.managed.join("managed-settings.json"),
        "json",
        MANAGED_LIMIT,
        &mut observations,
        &mut decode,
    )?
    .unwrap_or_else(|| json!({}));
    let dropins = paths.managed.join("managed-settings.d");
    if directory(&dropins, true, &mut observations)? {
        let mut entries = vec![];
        for entry in fs::read_dir(&dropins)
            .map_err(|_| failure("the managed policy drop-in directory could not be listed"))?
        {
            let entry = entry
                .map_err(|_| failure("the managed policy drop-in directory could not be listed"))?;
            let name = entry.file_name();
            if name.as_bytes().starts_with(b".") || !name.as_bytes().ends_with(b".json") {
                continue;
            }
            ensure!(
                name.to_str().is_some(),
                "{PREFIX}: a managed policy drop-in name is not valid UTF-8."
            );
            entries.push(entry);
            ensure!(
                entries.len() <= MAX_DROP_INS,
                "{PREFIX}: there are too many managed policy drop-ins."
            );
        }
        entries.sort_by(|a, b| {
            a.file_name()
                .to_string_lossy()
                .encode_utf16()
                .cmp(b.file_name().to_string_lossy().encode_utf16())
        });
        for entry in entries {
            let value = file(
                &entry.path(),
                "json",
                MANAGED_LIMIT,
                &mut observations,
                &mut decode,
            )?
            .ok_or_else(|| failure("policy sources changed during the read-only preflight"))?;
            merge(&mut files, &value, false);
        }
    }
    let user = file(
        &paths.user_plist,
        "plist",
        MANAGED_LIMIT,
        &mut observations,
        &mut decode,
    )?;
    let device = file(
        &paths.device_plist,
        "plist",
        MANAGED_LIMIT,
        &mut observations,
        &mut decode,
    )?;
    let remote = file(
        &home.join("remote-settings.json"),
        "remote-json",
        REMOTE_LIMIT,
        &mut observations,
        &mut decode,
    )?;
    let resolved = resolve(remote, user, device, files)?;
    for observation in &observations {
        let info = inspect(&observation.source.path, observation.directory)?;
        let current = source(
            &observation.source.path,
            &observation.source.kind,
            info.as_ref(),
            observation.enumerate,
        );
        let old = &observation.source;
        ensure!(
            old.exists == current.exists
                && old.identity == current.identity
                && old.dev == current.dev
                && old.ino == current.ino,
            "{PREFIX}: policy sources changed during the read-only preflight."
        );
    }
    let sources = observations
        .into_iter()
        .map(|o| o.source)
        .collect::<Vec<_>>();
    let digest=storage::hash_json(&json!({"snapshot":{"version":1,"platform":"darwin","sources":sources},"effective":resolved["effective"],"sources":resolved["sources"]}))
        .map_err(|_|failure("the policy source snapshot could not be authenticated"))?;
    Ok(PolicySnapshot {
        version: 1,
        platform: "darwin".into(),
        sources,
        digest,
    })
}

/// Read every pinned source safely, resolve only managed settings and refuse
/// managed hooks/dynamic helpers. User and project settings are never consulted.
pub fn read(claude_home: &Path, cwd: &Path) -> Result<PolicySnapshot> {
    ensure!(
        cfg!(target_os = "macos"),
        "{PREFIX}: this pinned policy preflight supports macOS only."
    );
    let username = username()?;
    let paths = PolicyPaths {
        managed: "/Library/Application Support/ClaudeCode".into(),
        user_plist: PathBuf::from(format!(
            "/Library/Managed Preferences/{username}/com.anthropic.claudecode.plist"
        )),
        device_plist: "/Library/Managed Preferences/com.anthropic.claudecode.plist".into(),
    };
    read_paths(claude_home, cwd, &paths, plist)
}

/// Compare startup and freshly read proofs before reset; never accept a changed
/// source merely because its currently resolved policy would also be hook-free.
pub fn verify(previous: &PolicySnapshot, current: &PolicySnapshot) -> Result<()> {
    ensure!(
        previous.version == 1
            && current.version == 1
            && previous.platform == "darwin"
            && current.platform == "darwin"
            && crate::packet::hex_digest(&json!(previous.digest))
            && previous == current,
        "Cold maintenance policy changed after startup; context reset is refused."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        cwd: PathBuf,
        paths: PolicyPaths,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let root = fs::canonicalize(temp.path())?;
            let home = root.join("claude");
            let cwd = root.join("project");
            let paths = PolicyPaths {
                managed: root.join("managed"),
                user_plist: root.join("mdm-user/policy.plist"),
                device_plist: root.join("mdm-device/policy.plist"),
            };
            for dir in [
                &home,
                &cwd,
                &paths.managed,
                paths.user_plist.parent().unwrap(),
                paths.device_plist.parent().unwrap(),
            ] {
                fs::create_dir(dir)?;
            }
            Ok(Self {
                _temp: temp,
                home,
                cwd,
                paths,
            })
        }
        fn read(&self) -> Result<PolicySnapshot> {
            read_paths(&self.home, &self.cwd, &self.paths, |input| {
                Ok(input.to_vec())
            })
        }
        fn managed(&self, value: Value) -> Result<()> {
            fs::write(
                self.paths.managed.join("managed-settings.json"),
                serde_json::to_vec(&value)?,
            )?;
            Ok(())
        }
        fn remote(&self, value: Value) -> Result<()> {
            fs::write(
                self.home.join("remote-settings.json"),
                serde_json::to_vec(&value)?,
            )?;
            Ok(())
        }
    }
    fn hooks() -> Value {
        json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"private-hook"}]}]}})
    }

    #[test]
    fn absence_and_unrelated_runtime_writes_keep_the_same_metadata_only_proof() -> Result<()> {
        let f = Fixture::new()?;
        let before = f.read()?;
        assert_eq!(before.version, 1);
        assert!(
            before
                .sources
                .iter()
                .any(|s| s.kind == "remote-json" && !s.exists)
        );
        fs::write(
            f.home.join("unrelated-runtime.json"),
            "native runtime activity",
        )?;
        let after = f.read()?;
        verify(&before, &after)?;
        assert_eq!(before, after);
        Ok(())
    }
    #[test]
    fn strict_objects_bom_sorted_dropins_and_raw_hashes_never_expose_values() -> Result<()> {
        let f = Fixture::new()?;
        let text = b"\xef\xbb\xbf{\"privateValue\":\"DO_NOT_RETURN_POLICY\"}";
        fs::write(f.paths.managed.join("managed-settings.json"), text)?;
        let dropins = f.paths.managed.join("managed-settings.d");
        fs::create_dir(&dropins)?;
        for name in ["b.json", "a.json"] {
            fs::write(dropins.join(name), "{}")?;
        }
        for name in [".ignored.json", "ignored.txt"] {
            fs::write(dropins.join(name), "not JSON")?;
        }
        let snapshot = f.read()?;
        let encoded = serde_json::to_string(&snapshot)?;
        assert!(!encoded.contains("DO_NOT_RETURN_POLICY"));
        assert_eq!(
            snapshot
                .sources
                .iter()
                .find(|s| s.path.ends_with("managed-settings.json"))
                .unwrap()
                .sha256,
            Some(storage::hash_bytes(text))
        );
        let names = snapshot
            .sources
            .iter()
            .filter(|s| s.path.starts_with(&dropins) && s.kind == "json")
            .map(|s| s.path.file_name().unwrap().to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["a.json", "b.json"]);
        for invalid in ["[]", "null", "", "// JSONC\n{}", "{\"DO_NOT_LEAK\":"] {
            fs::write(f.home.join("remote-settings.json"), invalid)?;
            let error = f.read().unwrap_err().to_string();
            assert!(error.contains("strict JSON object"));
            assert!(!error.contains("DO_NOT_LEAK"));
        }
        Ok(())
    }
    #[test]
    fn source_limits_and_dropin_inventory_are_bounded() -> Result<()> {
        let f = Fixture::new()?;
        fs::write(
            f.paths.managed.join("managed-settings.json"),
            vec![b' '; MANAGED_LIMIT + 1],
        )?;
        assert!(
            f.read()
                .unwrap_err()
                .to_string()
                .contains("pinned size limit")
        );
        f.managed(json!({}))?;
        fs::write(
            f.home.join("remote-settings.json"),
            vec![b' '; REMOTE_LIMIT + 1],
        )?;
        assert!(
            f.read()
                .unwrap_err()
                .to_string()
                .contains("pinned size limit")
        );
        f.remote(json!({}))?;
        let dropins = f.paths.managed.join("managed-settings.d");
        fs::create_dir(&dropins)?;
        for index in 0..=MAX_DROP_INS {
            fs::write(dropins.join(format!("{index:03}.json")), "{}")?;
        }
        assert!(f.read().unwrap_err().to_string().contains("too many"));
        Ok(())
    }
    #[test]
    fn symlinks_and_nonregular_sources_are_not_policy_absence() -> Result<()> {
        let f = Fixture::new()?;
        let target = f.home.join("target.json");
        fs::write(&target, "{}")?;
        symlink(&target, f.paths.managed.join("managed-settings.json"))?;
        assert!(
            f.read()
                .unwrap_err()
                .to_string()
                .contains("without symbolic links")
        );
        let f = Fixture::new()?;
        let dropins = f.paths.managed.join("managed-settings.d");
        fs::create_dir(&dropins)?;
        fs::create_dir(dropins.join("directory.json"))?;
        assert!(f.read().unwrap_err().to_string().contains("regular files"));
        let f = Fixture::new()?;
        let alias = f.home.join("managed-alias");
        symlink(&f.paths.managed, &alias)?;
        let mut paths = f.paths.clone();
        paths.managed = alias;
        assert!(read_paths(&f.home, &f.cwd, &paths, |_| unreachable!()).is_err());
        Ok(())
    }
    #[test]
    fn remote_and_mdm_priority_do_not_reject_shadowed_lower_hooks() -> Result<()> {
        let f = Fixture::new()?;
        f.managed(hooks())?;
        assert!(f.read().is_err());
        fs::write(&f.paths.device_plist, "{\"model\":\"device\"}")?;
        f.read()?;
        fs::write(&f.paths.user_plist, serde_json::to_vec(&hooks())?)?;
        assert!(f.read().is_err());
        f.remote(json!({"model":"remote"}))?;
        f.read()?;
        // MDM is one selected slot: an active per-user source replaces device,
        // even when that per-user source opts to merge with the file tier.
        f.managed(json!({"model":"file"}))?;
        fs::write(&f.paths.device_plist, serde_json::to_vec(&hooks())?)?;
        fs::write(
            &f.paths.user_plist,
            "{\"model\":\"user\",\"managedSourcesBehavior\":\"merge\"}",
        )?;
        f.remote(json!({}))?;
        f.read()?;
        Ok(())
    }
    #[test]
    fn invalid_high_tier_fields_cannot_hide_effective_lower_hooks() -> Result<()> {
        let f = Fixture::new()?;
        f.managed(hooks())?;
        for remote in [
            json!({"model":42}),
            json!({"hooks":null}),
            json!({"model":42,"hooks":null,"managedSourcesBehavior":"invalid"}),
        ] {
            f.remote(remote)?;
            assert!(
                f.read()
                    .unwrap_err()
                    .to_string()
                    .contains("refuses configured managed hooks")
            );
        }
        f.remote(json!({"model":"valid-remote"}))?;
        f.read()?;
        fs::write(&f.paths.user_plist, "{\"model\":42,\"hooks\":null}")?;
        f.remote(json!({}))?;
        assert!(f.read().is_err());
        Ok(())
    }
    #[test]
    fn merge_unions_lower_hooks_but_only_the_highest_policy_helper_is_effective() -> Result<()> {
        let f = Fixture::new()?;
        f.managed(hooks())?;
        f.remote(json!({"model":"remote","managedSourcesBehavior":"merge"}))?;
        assert!(
            f.read()
                .unwrap_err()
                .to_string()
                .contains("refuses configured managed hooks")
        );
        f.managed(json!({"policyHelper":{"path":"DO_NOT_EXECUTE"}}))?;
        f.read()?;
        for (key, value) in [
            ("policyHelper", json!({"path":"/DO_NOT_LEAK"})),
            ("policyHelpers", json!({"default":{"model":"DO_NOT_LEAK"}})),
            ("policyUnreadable", json!("DO_NOT_LEAK")),
        ] {
            f.remote(json!({key:value}))?;
            let error = f.read().unwrap_err().to_string();
            assert!(error.contains("hook-free managed policy"));
            assert!(!error.contains("DO_NOT_LEAK"));
        }
        for count in [
            json!("2"),
            json!(["2"]),
            json!("0x2"),
            json!("\u{feff}2"),
            json!(true),
        ] {
            f.remote(json!({"policyHookCount":count}))?;
            assert!(f.read().is_err());
        }
        for count in [json!([0]), json!([]), json!({}), json!(null), json!([true])] {
            f.remote(json!({"policyHookCount":count}))?;
            f.read()?;
        }
        f.managed(json!({"policyHelper":{"path":"/DO_NOT_EXECUTE"}}))?;
        f.remote(json!({"managedSourcesBehavior":"merge"}))?;
        assert!(f.read().is_err());
        Ok(())
    }
    #[test]
    fn remote_cache_is_the_raw_object_not_a_settings_envelope_and_ignores_reserved_metadata()
    -> Result<()> {
        let f = Fixture::new()?;
        f.managed(hooks())?;
        f.remote(json!({"$managed":{"hooks":{}},"$private":"DO_NOT_RETURN"}))?;
        assert!(f.read().is_err());
        f.managed(json!({"model":"file"}))?;
        f.remote(json!({"settings":hooks()}))?;
        f.read()?;
        f.remote(hooks())?;
        assert!(f.read().is_err());
        f.remote(json!({"$schema":"schema","$private":"DO_NOT_RETURN"}))?;
        assert!(!serde_json::to_string(&f.read()?)?.contains("DO_NOT_RETURN"));
        Ok(())
    }
    #[test]
    fn every_lower_source_remains_safely_readable_and_bound_to_startup() -> Result<()> {
        let f = Fixture::new()?;
        f.managed(json!({"private":"lower-one"}))?;
        f.remote(json!({"model":"highest"}))?;
        let before = f.read()?;
        f.managed(json!({"private":"lower-two"}))?;
        assert!(verify(&before, &f.read()?).is_err());
        fs::write(
            f.paths.managed.join("managed-settings.json"),
            "invalid lower source",
        )?;
        assert!(
            f.read()
                .unwrap_err()
                .to_string()
                .contains("strict JSON object")
        );
        Ok(())
    }
    #[test]
    fn conversion_and_enumerated_directory_changes_cannot_escape_the_snapshot() -> Result<()> {
        let f = Fixture::new()?;
        f.managed(json!({"model":"initial"}))?;
        let dropins = f.paths.managed.join("managed-settings.d");
        fs::create_dir(&dropins)?;
        fs::write(&f.paths.user_plist, "{}")?;
        let result = read_paths(&f.home, &f.cwd, &f.paths, |_| {
            fs::write(dropins.join("new.json"), "{}")?;
            Ok(b"{}".to_vec())
        });
        assert!(result.unwrap_err().to_string().contains("changed during"));
        let result = read_paths(&f.home, &f.cwd, &f.paths, |_| {
            f.managed(json!({"model":"changed"}))?;
            Ok(b"{}".to_vec())
        });
        assert!(result.unwrap_err().to_string().contains("changed during"));
        let result = read_paths(&f.home, &f.cwd, &f.paths, |_| {
            Err(anyhow::anyhow!("DO_NOT_LEAK stderr or paths"))
        });
        let error = result.unwrap_err().to_string();
        assert!(error.contains("could not be decoded"));
        assert!(!error.contains("DO_NOT_LEAK"));
        let result = read_paths(&f.home, &f.cwd, &f.paths, |_| {
            Ok(vec![b' '; MANAGED_LIMIT + 1])
        });
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("decoded managed preferences exceed")
        );
        Ok(())
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn real_plutil_decodes_exact_in_memory_bytes_as_direct_settings() -> Result<()> {
        let f = Fixture::new()?;
        let xml=br#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>model</key><string>synthetic</string></dict></plist>"#;
        fs::write(&f.paths.user_plist, xml)?;
        let snapshot = read_paths(&f.home, &f.cwd, &f.paths, plist)?;
        assert!(
            snapshot
                .sources
                .iter()
                .any(|s| s.kind == "plist" && s.sha256 == Some(storage::hash_bytes(xml)))
        );
        assert!(!serde_json::to_string(&snapshot)?.contains("synthetic"));
        assert!(plist(b"DO_NOT_LEAK malformed plist").is_err());
        Ok(())
    }
}
