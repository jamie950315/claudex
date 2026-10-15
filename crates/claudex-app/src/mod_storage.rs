//! Owner-private durable companion records and exact-inode journal locks.
use crate::{mod_protocol::insist, platform};
use anyhow::{Context, Result};
use claudex_core::storage::{FileIdentity, is_not_found, process_alive};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
pub const LIMIT: usize = 2 * 1024 * 1024;
pub fn directory(path: &Path, create: bool) -> Result<()> {
    platform::absolute(path)?;
    if create {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    platform::directory(path, true, false)?;
    insist(
        fs::symlink_metadata(path)?.mode() & 0o777 == 0o700,
        "UNSAFE_ROOT",
        "Use an existing canonical, owner-private 0700 directory.",
    )
}
pub fn read(path: &Path, optional: bool, max: usize) -> Result<Option<Vec<u8>>> {
    match platform::safe_bytes(path, max, true, false) {
        Ok(bytes) => {
            insist(
                fs::symlink_metadata(path)?.mode() & 0o777 == 0o600,
                "UNSAFE_FILE",
                "Companion storage must be an owner-private regular file with one link.",
            )?;
            std::str::from_utf8(&bytes)?;
            Ok(Some(bytes))
        }
        Err(e) if optional && is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn json(path: &Path, optional: bool, max: usize) -> Result<Option<Value>> {
    read(path, optional, max)?
        .map(|v| {
            serde_json::from_slice(&v)
                .context("Malformed companion state; preserve it for inspection.")
        })
        .transpose()
}
pub fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
pub fn write(path: &Path, value: &Value, exclusive: bool) -> Result<()> {
    let parent = path.parent().context("Missing receipt parent.")?;
    directory(parent, false)?;
    let mut bytes = claudex_core::json::stringify(value)?.into_bytes();
    bytes.push(b'\n');
    insist(
        bytes.len() <= LIMIT,
        "RECEIPT_BOUND",
        "Receipt exceeds its storage bound.",
    )?;
    if exclusive {
        return platform::publish(path, &bytes, 0o600);
    }
    read(path, false, LIMIT)?;
    let temporary = parent.join(format!(".write-{}.tmp", uuid::Uuid::new_v4()));
    platform::publish(&temporary, &bytes, 0o600)?;
    match fs::rename(&temporary, path) {
        Ok(()) => sync_dir(parent),
        Err(e) => {
            let _ = fs::remove_file(&temporary);
            Err(e.into())
        }
    }
}
fn identity(path: &Path) -> Result<FileIdentity> {
    Ok(FileIdentity::from_metadata(&fs::symlink_metadata(path)?))
}
pub struct Lock {
    path: PathBuf,
    inode: FileIdentity,
    _file: File,
}
impl Lock {
    /// Non-recovering action locks return `None` instead of replaying an action.
    pub fn acquire(path: &Path, recover_dead: bool) -> Result<Option<Self>> {
        directory(path.parent().context("Missing lock parent.")?, false)?;
        let open = || {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
        };
        let mut file = match open() {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !recover_dead {
                    return Ok(None);
                }
                recover(path)?;
                open()?
            }
            Err(e) => return Err(e.into()),
        };
        let inode = FileIdentity::from_metadata(&file.metadata()?);
        let data = if recover_dead {
            claudex_core::json::stringify(&json!({"version":1,"pid":std::process::id()}))?
        } else {
            "action-lock\n".into()
        };
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        Ok(Some(Self {
            path: path.into(),
            inode,
            _file: file,
        }))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        if let Ok(m) = fs::symlink_metadata(&self.path) {
            if m.is_file()
                && !m.file_type().is_symlink()
                && m.nlink() == 1
                && self.inode.same_inode(&FileIdentity::from_metadata(&m))
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}
fn recover(path: &Path) -> Result<()> {
    let claim = PathBuf::from(format!("{}.reclaim", path.display()));
    insist(
        !crate::status_app::exists(&claim)?,
        "JOURNAL_BUSY",
        "Receipt storage recovery requires inspection. Preserve its lock.",
    )?;
    let before = match identity(path) {
        Ok(i) => i,
        Err(e) if is_not_found(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    let owner = json(path, false, 256)?.unwrap();
    let pid = owner["pid"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= i32::MAX as u64);
    insist(
        owner["version"] == 1 && pid.is_some(),
        "JOURNAL_BUSY",
        "An unknown receipt-storage lock requires inspection.",
    )?;
    let pid = pid.unwrap() as u32;
    insist(
        !process_alive(pid)?,
        "JOURNAL_BUSY",
        "Another receipt-storage operation is active.",
    )?;
    insist(
        before == identity(path)?,
        "FILE_CHANGED",
        "Receipt lock changed.",
    )?;
    fs::hard_link(path, &claim)?;
    let result = (|| {
        let current = identity(path)?;
        let claimed = identity(&claim)?;
        let same = |v: &FileIdentity| {
            v.dev == before.dev
                && v.ino == before.ino
                && v.size == before.size
                && v.mtime_ns == before.mtime_ns
                && v.mode == before.mode
                && v.uid == before.uid
        };
        insist(
            same(&current)
                && same(&claimed)
                && current.ctime_ns == claimed.ctime_ns
                && current.nlink == "2"
                && claimed.nlink == "2"
                && !process_alive(pid)?,
            "FILE_CHANGED",
            "Receipt lock changed during recovery.",
        )?;
        fs::remove_file(path)?;
        sync_dir(path.parent().unwrap())
    })();
    if identity(&claim).is_ok_and(|i| i.same_inode(&before)) {
        fs::remove_file(&claim)?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_reads_refuse_hardlinks_and_action_lock_never_recovers_unknown_owner() -> Result<()> {
        let t = tempfile::tempdir()?;
        let p = fs::canonicalize(t.path())?;
        let path = p.join("record.json");
        write(&path, &json!({"version":1}), true)?;
        fs::hard_link(&path, p.join("alias"))?;
        assert!(read(&path, false, LIMIT).is_err());
        let lock = Lock::acquire(&p.join("action.lock"), false)?.unwrap();
        assert!(Lock::acquire(&p.join("action.lock"), false)?.is_none());
        assert!(Lock::acquire(&p.join("action.lock"), true).is_err());
        drop(lock);
        assert!(!p.join("action.lock").exists());
        Ok(())
    }
}
