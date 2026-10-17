//! Durable state and exact, no-follow native file proofs.
use anyhow::{Context, Result, bail};
use chrono::{NaiveDateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}
pub fn uid() -> u32 {
    // Reading the process identity has no memory preconditions.
    unsafe { libc::getuid() }
}
pub fn hash_bytes(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
pub fn hash_json(value: &Value) -> Result<String> {
    Ok(hash_bytes(crate::json::stringify(value)?))
}

/// Decimal strings preserve the exact durable JavaScript bigint representation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub dev: String,
    pub ino: String,
    pub size: String,
    pub mtime_ns: String,
    pub ctime_ns: String,
    pub uid: String,
    pub mode: String,
    pub nlink: String,
}
impl FileIdentity {
    pub fn from_metadata(m: &Metadata) -> Self {
        Self {
            dev: m.dev().to_string(),
            ino: m.ino().to_string(),
            size: m.size().to_string(),
            mtime_ns: (i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()))
                .to_string(),
            ctime_ns: (i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()))
                .to_string(),
            uid: m.uid().to_string(),
            mode: m.mode().to_string(),
            nlink: m.nlink().to_string(),
        }
    }
    pub fn same_inode(&self, other: &Self) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

#[derive(Debug)]
pub struct StableFile {
    pub bytes: Vec<u8>,
    pub identity: FileIdentity,
}

/// The named file and opened descriptor must agree before and after the read.
pub fn read_stable(path: impl AsRef<Path>) -> Result<StableFile> {
    read_stable_with_limit(path, usize::MAX)
}
pub fn read_stable_with_limit(path: impl AsRef<Path>, limit: usize) -> Result<StableFile> {
    let path = path.as_ref();
    let named = fs::symlink_metadata(path)?;
    if !named.is_file() || named.file_type().is_symlink() {
        bail!("Transcript must be a regular file, never a symlink.");
    }
    if named.len() > limit as u64 {
        bail!("File exceeds its read size limit.");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let before = file.metadata()?;
    let identity = FileIdentity::from_metadata(&before);
    if !before.is_file() || identity != FileIdentity::from_metadata(&named) {
        bail!("Transcript changed while being read.");
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        bail!("File exceeds its read size limit.");
    }
    let after = file.metadata()?;
    let current = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            bail!("Transcript changed while being read.")
        }
        Err(e) => return Err(e.into()),
    };
    if identity != FileIdentity::from_metadata(&after)
        || identity != FileIdentity::from_metadata(&current)
    {
        bail!("Transcript changed while being read.");
    }
    Ok(StableFile { bytes, identity })
}

pub fn read_json(path: impl AsRef<Path>) -> Result<Value> {
    let data = read_stable(path)?;
    serde_json::from_slice(&data.bytes)
        .context("Malformed JSON state; inspect the local file before continuing.")
}
pub fn read_json_or(path: impl AsRef<Path>, fallback: Value) -> Result<Value> {
    match read_json(path) {
        Ok(v) => Ok(v),
        Err(e) if is_not_found(&e) => Ok(fallback),
        Err(e) => Err(e),
    }
}
pub fn is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    })
}

pub fn private_directory(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => bail!("Private directory must not be a symlink."),
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir() || m.file_type().is_symlink() {
        bail!("Private directory must not be a symlink.");
    }
    Ok(fs::canonicalize(path)?)
}
pub fn require_private_directory(path: impl AsRef<Path>) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir() || m.file_type().is_symlink() || m.uid() != uid() || m.mode() & 0o777 != 0o700 {
        bail!("Directory must be owner-only and not a symlink.");
    }
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .context("An absolute state file path is required.")
}
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
fn write_temporary(path: &Path, value: &[u8], durable: bool) -> Result<()> {
    // Do not use truncate(true): validate the opened inode before truncating.
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.uid() != uid() || opened.nlink() != 1 {
        bail!("Staging file must be an owned regular file with one link.");
    }
    let named = fs::symlink_metadata(path)?;
    if !named.is_file()
        || named.file_type().is_symlink()
        || opened.dev() != named.dev()
        || opened.ino() != named.ino()
    {
        bail!("Staging file changed before write.");
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.set_len(0)?;
    file.write_all(value)?;
    if durable {
        file.sync_all()?;
    }
    Ok(())
}
pub fn atomic_write(path: impl AsRef<Path>, value: impl AsRef<[u8]>) -> Result<()> {
    atomic_write_inner(path.as_ref(), value.as_ref(), true)
}
fn atomic_write_inner(path: &Path, value: &[u8], durable: bool) -> Result<()> {
    private_directory(parent(path)?)?;
    let temporary = sibling(path, ".next");
    write_temporary(&temporary, value, durable)?;
    fs::rename(&temporary, path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    if durable {
        sync_directory(parent(path)?)?;
    }
    Ok(())
}
pub fn publish_exclusive(path: impl AsRef<Path>, value: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    private_directory(parent(path)?)?;
    let temporary = sibling(path, ".claudex-next");
    write_temporary(&temporary, value.as_ref(), true)?;
    let published = fs::hard_link(&temporary, path).and_then(|_| {
        File::open(parent(path).map_err(std::io::Error::other)?).and_then(|f| f.sync_all())
    });
    let cleanup = fs::remove_file(&temporary);
    published?;
    cleanup?;
    Ok(())
}
fn json_bytes(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}
pub fn write_json(path: impl AsRef<Path>, value: &Value) -> Result<()> {
    atomic_write(path, json_bytes(value)?)
}
/// Disposable diagnostics only. Never use this for work-authorizing state.
pub fn write_diagnostic_json(path: impl AsRef<Path>, value: &Value) -> Result<()> {
    atomic_write_inner(path.as_ref(), &json_bytes(value)?, false)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub text: String,
    pub rows: Vec<Value>,
    pub hash: String,
    pub bytes: u64,
    pub mtime_ms: f64,
    pub file_identity: FileIdentity,
}
pub fn snapshot(path: impl AsRef<Path>) -> Result<Snapshot> {
    snapshot_with_limit(path, usize::MAX)
}
pub fn compressed_rollout_bytes(path: impl AsRef<Path>, max_bytes: usize) -> Result<u64> {
    let stored = read_stable(path.as_ref())?;
    let decoder = zstd::stream::read::Decoder::new(stored.bytes.as_slice())
        .context("Compressed Codex rollout is not a complete zstd stream.")?;
    let mut bytes = Vec::new();
    decoder
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .context("Compressed Codex rollout is not a complete zstd stream.")?;
    if bytes.len() > max_bytes {
        bail!("Compressed Codex rollout exceeds its byte limit.");
    }
    let (len, valid_end) = match std::str::from_utf8(&bytes) {
        Ok(text) => (text.len(), text.is_empty() || text.ends_with('\n')),
        Err(_) => {
            let text = String::from_utf8_lossy(&bytes);
            (text.len(), text.is_empty() || text.ends_with('\n'))
        }
    };
    if !valid_end {
        bail!("Transcript has an incomplete final line.");
    }
    Ok(len as u64)
}
pub fn snapshot_with_limit(path: impl AsRef<Path>, max_bytes: usize) -> Result<Snapshot> {
    let path = path.as_ref();
    let stored = read_stable(path)?;
    let compressed = path.as_os_str().to_string_lossy().ends_with(".jsonl.zst");
    let bytes = if compressed {
        let decoder = zstd::stream::read::Decoder::new(stored.bytes.as_slice())
            .context("Compressed Codex rollout is not a complete zstd stream.")?;
        let mut bytes = Vec::new();
        decoder
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .context("Compressed Codex rollout is not a complete zstd stream.")?;
        if bytes.len() > max_bytes {
            bail!("Compressed Codex rollout exceeds its byte limit.");
        }
        bytes
    } else {
        stored.bytes
    };
    if bytes.len() > max_bytes {
        bail!("Transcript exceeds its byte limit.");
    }
    // Native Node readers decode invalid UTF-8 using replacement characters.
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let hash = hash_bytes(text.as_bytes());
    let logical_bytes = if compressed { text.len() } else { bytes.len() };
    if !text.is_empty() && !text.ends_with('\n') {
        bail!("Transcript has an incomplete final line.");
    }
    let rows = text
        .split('\n')
        .filter(|line| !line.is_empty())
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str(line).with_context(|| {
                format!(
                    "Malformed transcript record at line {}; source left unchanged.",
                    index + 1
                )
            })
        })
        .collect::<Result<Vec<Value>>>()?;
    let mtime_ns: i128 = stored.identity.mtime_ns.parse()?;
    Ok(Snapshot {
        text,
        rows,
        hash,
        bytes: logical_bytes as u64,
        mtime_ms: mtime_ns as f64 / 1e6,
        file_identity: stored.identity,
    })
}

pub fn process_alive(pid: u32) -> Result<bool> {
    if pid == 0 || pid > i32::MAX as u32 {
        bail!("Invalid service process identity.");
    }
    // Signal zero checks existence/permission without sending a signal.
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error.into()),
    }
}
pub fn process_started_at(pid: u32) -> Option<i64> {
    let mut child = Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    NaiveDateTime::parse_from_str(output.trim(), "%a %b %e %H:%M:%S %Y")
        .ok()
        .map(|t| t.and_utc().timestamp_millis())
}
pub fn lock_holder_alive(pid: u32, written_at_ms: i64) -> Result<bool> {
    if !process_alive(pid)? {
        return Ok(false);
    }
    Ok(!process_started_at(pid).is_some_and(|born| born > written_at_ms.saturating_add(2000)))
}

/// Exclusive lock ownership is tied to its inode, not just its pathname.
pub struct FileLock {
    path: PathBuf,
    identity: FileIdentity,
    file: Option<File>,
}
impl FileLock {
    pub fn acquire(path: impl AsRef<Path>, recover_dead: bool) -> Result<Self> {
        let path = path.as_ref();
        private_directory(parent(path)?)?;
        let create = || {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
        };
        let mut file = match create() {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !recover_dead {
                    bail!(
                        "Another bridge operation holds the lock. Inspect status before retrying."
                    );
                }
                reclaim_dead_lock(path, now_ms())?;
                create().context(
                    "Another bridge operation holds the lock. Inspect status before retrying.",
                )?
            }
            Err(e) => return Err(e.into()),
        };
        let identity = FileIdentity::from_metadata(&file.metadata()?);
        let mut guard = Self {
            path: path.to_owned(),
            identity,
            file: None,
        };
        let record = json!({"pid":std::process::id(),"started":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)});
        if let Err(error) = file.write_all(&serde_json::to_vec(&record)?) {
            let _ = guard.remove_same();
            return Err(error.into());
        }
        guard.file = Some(file);
        Ok(guard)
    }
    fn remove_same(&self) -> Result<()> {
        match fs::symlink_metadata(&self.path) {
            Ok(m) => {
                if m.uid() != uid()
                    || m.file_type().is_symlink()
                    || !self.identity.same_inode(&FileIdentity::from_metadata(&m))
                {
                    bail!("Lock identity changed; lock was preserved.");
                }
                fs::remove_file(&self.path)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }
    pub fn release(mut self) -> Result<()> {
        self.file.take();
        self.remove_same()
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = self.remove_same();
    }
}

fn modified_ms(m: &Metadata) -> i64 {
    m.mtime().saturating_mul(1000) + m.mtime_nsec() / 1_000_000
}
fn changed_ms(m: &Metadata) -> i64 {
    m.ctime().saturating_mul(1000) + m.ctime_nsec() / 1_000_000
}
fn reclaim_dead_lock(path: &Path, now: i64) -> Result<()> {
    require_private_directory(parent(path)?)?;
    let claim = sibling(path, ".reclaim");
    match fs::symlink_metadata(&claim) {
        Ok(m)
            if m.is_file()
                && !m.file_type().is_symlink()
                && m.uid() == uid()
                && now - changed_ms(&m) >= 60_000 =>
        {
            fs::remove_file(&claim)?
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    let original = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if original.nlink() == 0 {
        return Ok(());
    }
    if !original.is_file()
        || original.file_type().is_symlink()
        || original.uid() != uid()
        || original.mode() & 0o777 != 0o600
        || original.nlink() != 1
    {
        bail!("Lock is not a private owned regular file; stale lock was preserved.");
    }
    let stable = match read_stable(path) {
        Ok(v) => v,
        Err(e) if is_not_found(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    if stable.identity != FileIdentity::from_metadata(&original) {
        bail!("Lock identity changed; stale lock was preserved.");
    }
    let owner = if stable.bytes.is_empty() {
        if now - modified_ms(&original) < 60_000 {
            bail!("Another bridge operation holds the lock; lock owner publication is pending.");
        }
        None
    } else {
        let value: Value = serde_json::from_slice(&stable.bytes)
            .context("Malformed lock owner; stale lock was preserved.")?;
        let pid = value["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
            .context("Malformed lock owner; stale lock was preserved.")? as u32;
        let started = chrono::DateTime::parse_from_rfc3339(
            value["started"]
                .as_str()
                .context("Malformed lock owner; stale lock was preserved.")?,
        )
        .context("Malformed lock owner; stale lock was preserved.")?
        .timestamp_millis();
        Some((pid, started))
    };
    let held = || -> Result<bool> {
        owner
            .map(|(pid, started)| lock_holder_alive(pid, started))
            .unwrap_or(Ok(false))
    };
    if held()? {
        bail!("Another bridge operation holds the lock. Inspect status before retrying.");
    }
    match fs::hard_link(path, &claim) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!("Another stale-lock recovery is in progress; lock was preserved.")
        }
        Err(e) => return Err(e.into()),
    }
    let result = (|| {
        let claimed = fs::symlink_metadata(&claim)?;
        let current = fs::symlink_metadata(path)?;
        let id = &stable.identity;
        if !id.same_inode(&FileIdentity::from_metadata(&claimed))
            || !id.same_inode(&FileIdentity::from_metadata(&current))
            || claimed.nlink() != 2
            || current.nlink() != 2
            || fs::read(&claim)? != stable.bytes
            || held()?
        {
            bail!("Lock changed during stale recovery; lock was preserved.");
        }
        fs::remove_file(path)?;
        Ok(())
    })();
    match fs::symlink_metadata(&claim) {
        Ok(m) if stable.identity.same_inode(&FileIdentity::from_metadata(&m)) => {
            fs::remove_file(&claim)?;
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    result
}

pub fn epoch_ms(time: SystemTime) -> Result<i64> {
    Ok(time.duration_since(UNIX_EPOCH)?.as_millis().try_into()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_backend_keeps_standard_digest_bytes() {
        for (input, expected) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ] {
            assert_eq!(hash_bytes(input), expected);
        }
        assert_eq!(
            hash_bytes(vec![b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
