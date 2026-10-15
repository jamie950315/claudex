//! Exact immutable originals and recoverable publication for renderer cache resources.
use crate::{cache, platform};
use anyhow::{Context, Result, ensure};
use claudex_core::storage::{FileIdentity, FileLock};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
#[derive(Clone)]
pub struct Snapshot {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub identity: FileIdentity,
}
#[derive(Debug)]
pub struct ChangedResource(pub std::path::PathBuf);
impl std::fmt::Display for ChangedResource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Cache resource changed; external contents were preserved."
        )
    }
}
impl std::error::Error for ChangedResource {}
pub fn changed_path(error: &anyhow::Error) -> Option<&Path> {
    error.chain().find_map(|error| {
        error
            .downcast_ref::<ChangedResource>()
            .map(|error| error.0.as_path())
    })
}
pub fn snapshot(path: &Path, limit: usize) -> Result<Snapshot> {
    platform::directory(path.parent().context("Missing cache parent")?, true, false)?;
    let before = FileIdentity::from_metadata(&fs::symlink_metadata(path)?);
    let bytes = platform::safe_bytes(path, limit, true, false)?;
    ensure!(!bytes.is_empty(), "Cache resource is empty.");
    if before != FileIdentity::from_metadata(&fs::symlink_metadata(path)?) {
        return Err(ChangedResource(path.into()).into());
    }
    let mode = before.mode.parse::<u32>()?;
    ensure!(mode & 0o7777 == 0o600, "Cache file must have mode 0600.");
    Ok(Snapshot {
        hash: cache::hash(&bytes),
        bytes,
        identity: before,
    })
}
fn optional(path: &Path, limit: usize) -> Result<Option<Snapshot>> {
    match snapshot(path, limit) {
        Ok(s) => Ok(Some(s)),
        Err(e) if claudex_core::storage::is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
fn unchanged(path: &Path, expected: Option<&Snapshot>, limit: usize) -> Result<()> {
    let actual = optional(path, limit)?;
    if !match (expected, actual) {
        (None, None) => true,
        (Some(a), Some(b)) => a.hash == b.hash && a.identity == b.identity,
        _ => false,
    } {
        return Err(ChangedResource(path.into()).into());
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Install,
    Restore,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Prepared,
    Installed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub root: PathBuf,
    pub cache_path: PathBuf,
    pub source_hash: String,
    pub original_hash: String,
    pub patched_hash: String,
    pub previous_patched_hash: Option<String>,
    pub phase: Phase,
    pub action: Action,
    pub staging_name: Option<String>,
}
impl Manifest {
    pub fn validate(&self, root: &Path, cache: &Path, source: &str) -> Result<()> {
        let digest = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        ensure!(
            self.version == 1
                && self.root == root
                && self.cache_path == cache
                && self.source_hash == source
                && digest(&self.source_hash)
                && digest(&self.original_hash)
                && digest(&self.patched_hash)
                && self.original_hash != self.patched_hash
                && self.previous_patched_hash.as_deref().is_none_or(digest)
                && match self.phase {
                    Phase::Prepared =>
                        self.staging_name
                            .as_deref()
                            .is_some_and(|s| regex::Regex::new(
                                r"^\.claudex-folder-[a-f0-9-]{36}\.tmp$"
                            )
                            .unwrap()
                            .is_match(s)),
                    Phase::Installed =>
                        self.staging_name.is_none() && self.previous_patched_hash.is_none(),
                }
                && (self.action != Action::Restore || self.previous_patched_hash.is_none()),
            "Invalid or differently bound cache manifest."
        );
        Ok(())
    }
    fn owns(&self, hash: &str) -> bool {
        hash == self.original_hash
            || hash == self.patched_hash
            || self.phase == Phase::Prepared && self.previous_patched_hash.as_deref() == Some(hash)
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: &'static str,
    pub changed: bool,
    pub recovered: bool,
    pub cache_hash: String,
    pub original_hash: String,
}
pub struct InstallOptions {
    pub root: PathBuf,
    pub cache_path: PathBuf,
    pub source_hash: String,
    pub target_url: String,
}
/// Caller must supply a complete structural/syntax-proved transform. It is never
/// inferred from a hash or runtime feature flags by this publication layer.
pub trait Transform {
    fn build(&self, original_source: &str) -> Result<String>;
    fn publication_fence(&self) -> Result<()>;
}
fn save_manifest(path: &Path, value: &Manifest, expected: Option<&Snapshot>) -> Result<Snapshot> {
    let temporary = path.with_file_name(format!(".manifest-{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    platform::publish(&temporary, &bytes, 0o600)?;
    let staged = snapshot(&temporary, 16 * 1024)?;
    unchanged(path, expected, 16 * 1024)?;
    if expected.is_none() {
        fs::hard_link(&temporary, path)?;
        fs::remove_file(&temporary)?;
    } else {
        fs::rename(&temporary, path)?;
    }
    fs::File::open(path.parent().unwrap())?.sync_all()?;
    let written = snapshot(path, 16 * 1024)?;
    ensure!(
        written.hash == staged.hash,
        "Manifest changed after publication."
    );
    Ok(written)
}
fn original(path: &Path, bytes: &[u8]) -> Result<Snapshot> {
    let temporary = path.with_file_name(format!(".original-{}.tmp", uuid::Uuid::new_v4()));
    platform::publish(&temporary, bytes, 0o600)?;
    let staged = snapshot(&temporary, cache::MAX_CACHE_BYTES)?;
    fs::hard_link(&temporary, path)?;
    let current = FileIdentity::from_metadata(&fs::symlink_metadata(&temporary)?);
    ensure!(
        current.same_inode(&staged.identity),
        "Original staging identity changed."
    );
    fs::remove_file(&temporary)?;
    fs::File::open(path.parent().unwrap())?.sync_all()?;
    snapshot(path, cache::MAX_CACHE_BYTES)
}
pub fn operate(
    action: Action,
    options: &InstallOptions,
    transform: &dyn Transform,
) -> Result<Outcome> {
    let root = &options.root;
    let path = &options.cache_path;
    platform::directory(root, true, false)?;
    platform::absolute(path)?;
    ensure!(
        options.source_hash.len() == 64,
        "Invalid expected source hash."
    );
    let private = root.join("ui-folder-compat");
    ensure!(
        !path.starts_with(&private),
        "Cache target must not be installer state."
    );
    platform::create_private(&private)?;
    let parent = path.parent().context("Missing cache parent")?;
    platform::directory(parent, true, false)?;
    let roots = [root.as_path(), private.as_path(), parent];
    let identities: Vec<_> = roots
        .iter()
        .map(|p| fs::symlink_metadata(p).map(|m| (m.dev(), m.ino())))
        .collect::<std::io::Result<_>>()?;
    let directories = || -> Result<()> {
        for (p, (dev, ino)) in roots.iter().zip(&identities) {
            platform::directory(p, true, false)?;
            let m = fs::symlink_metadata(p)?;
            ensure!(
                m.dev() == *dev && m.ino() == *ino,
                "Directory identity changed."
            );
        }
        Ok(())
    };
    let _lock = FileLock::acquire(&private.join("install.lock"), true)?;
    directories()?;
    for entry in fs::read_dir(&private)? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        ensure!(
            !(name.starts_with(".manifest-") || name.starts_with(".original-"))
                || !name.ends_with(".tmp"),
            "Interrupted private publication needs inspection; staging was preserved."
        );
    }
    let manifest_path = private.join("manifest.json");
    let backup_path = private.join("original.cache");
    let mut manifest_snapshot = optional(&manifest_path, 16 * 1024)?;
    let manifest = manifest_snapshot
        .as_ref()
        .map(|s| serde_json::from_slice::<Manifest>(&s.bytes))
        .transpose()?;
    if let Some(m) = &manifest {
        m.validate(root, path, &options.source_hash)?;
    }
    let current = snapshot(path, cache::MAX_CACHE_BYTES)?;
    let entry = cache::inspect(&current.bytes, Some(&options.target_url))?;
    let mut backup = optional(&backup_path, cache::MAX_CACHE_BYTES)?;
    if let Some(m) = &manifest {
        ensure!(
            backup.as_ref().is_some_and(|s| s.hash == m.original_hash),
            "Original backup is missing or changed."
        );
        ensure!(
            m.owns(&current.hash),
            "Cache changed outside this installer; nothing was overwritten."
        );
    } else {
        ensure!(
            action != Action::Restore,
            "No installation manifest exists."
        );
        ensure!(
            entry.source_hash == options.source_hash,
            "Unvalidated frontend source; nothing was overwritten."
        );
        ensure!(
            backup.as_ref().is_none_or(|b| b.hash == current.hash),
            "Unjournaled backup does not match current original."
        );
    }
    if let Some(b) = &backup {
        ensure!(
            cache::inspect(&b.bytes, Some(&options.target_url))?.source_hash == options.source_hash,
            "Original source binding changed."
        );
    }
    let original_bytes = backup
        .as_ref()
        .map(|s| s.bytes.as_slice())
        .unwrap_or(&current.bytes);
    let candidate = if action == Action::Install {
        let source = cache::inspect(original_bytes, Some(&options.target_url))?.source;
        let patched = transform.build(&source)?;
        let candidate = cache::replace_source(original_bytes, &patched, Some(&options.target_url))?;
        ensure!(
            cache::hash(&candidate)
                != backup
                    .as_ref()
                    .map(|s| s.hash.as_str())
                    .unwrap_or(&current.hash),
            "Candidate did not change original resource."
        );
        candidate
    } else {
        backup.as_ref().unwrap().bytes.clone()
    };
    let candidate_hash = cache::hash(&candidate);
    directories()?;
    unchanged(path, Some(&current), cache::MAX_CACHE_BYTES)?;
    unchanged(&manifest_path, manifest_snapshot.as_ref(), 16 * 1024)?;
    if let Some(b) = &backup {
        unchanged(&backup_path, Some(b), cache::MAX_CACHE_BYTES)?;
    }
    if let Some(m) = manifest.as_ref().filter(|m| m.phase == Phase::Prepared) {
        let old_path = parent.join(m.staging_name.as_ref().unwrap());
        if let Some(old) = optional(&old_path, cache::MAX_CACHE_BYTES)? {
            cache::inspect(&old.bytes, Some(&options.target_url))?;
            ensure!(
                old.hash
                    == if m.action == Action::Restore {
                        &m.original_hash
                    } else {
                        &m.patched_hash
                    }
                    .as_str(),
                "Prepared staging contents changed; staging was preserved."
            );
            unchanged(&old_path, Some(&old), cache::MAX_CACHE_BYTES)?;
            fs::remove_file(old_path)?;
        }
    }
    if backup.is_none() {
        backup = Some(original(&backup_path, &current.bytes)?);
    }
    let backup = backup.unwrap();
    let mut next = Manifest {
        version: 1,
        root: root.clone(),
        cache_path: path.clone(),
        source_hash: options.source_hash.clone(),
        original_hash: backup.hash.clone(),
        patched_hash: if action == Action::Install {
            candidate_hash.clone()
        } else if current.hash == backup.hash {
            manifest
                .as_ref()
                .context("Restore needs manifest")?
                .patched_hash
                .clone()
        } else {
            current.hash.clone()
        },
        previous_patched_hash: None,
        phase: Phase::Installed,
        action,
        staging_name: None,
    };
    let outcome = |changed| Outcome {
        status: if action == Action::Restore {
            "restored"
        } else {
            "installed"
        },
        changed,
        recovered: manifest
            .as_ref()
            .is_some_and(|m| m.phase == Phase::Prepared),
        cache_hash: candidate_hash.clone(),
        original_hash: backup.hash.clone(),
    };
    if current.hash == candidate_hash {
        transform.publication_fence()?;
        next.validate(root, path, &options.source_hash)?;
        save_manifest(&manifest_path, &next, manifest_snapshot.as_ref())?;
        return Ok(outcome(false));
    }
    next.phase = Phase::Prepared;
    next.staging_name = Some(format!(".claudex-folder-{}.tmp", uuid::Uuid::new_v4()));
    if action == Action::Install && current.hash != backup.hash {
        next.previous_patched_hash = Some(current.hash.clone());
    }
    next.validate(root, path, &options.source_hash)?;
    manifest_snapshot = Some(save_manifest(
        &manifest_path,
        &next,
        manifest_snapshot.as_ref(),
    )?);
    let staging_path = parent.join(next.staging_name.as_ref().unwrap());
    platform::publish(&staging_path, &candidate, 0o600)?;
    let staged = snapshot(&staging_path, cache::MAX_CACHE_BYTES)?;
    transform.publication_fence()?;
    directories()?;
    unchanged(path, Some(&current), cache::MAX_CACHE_BYTES)?;
    unchanged(&manifest_path, manifest_snapshot.as_ref(), 16 * 1024)?;
    unchanged(&backup_path, Some(&backup), cache::MAX_CACHE_BYTES)?;
    unchanged(&staging_path, Some(&staged), cache::MAX_CACHE_BYTES)?;
    transform.publication_fence()?;
    fs::rename(&staging_path, path)?;
    fs::File::open(parent)?.sync_all()?;
    let published = snapshot(path, cache::MAX_CACHE_BYTES)?;
    cache::inspect(&published.bytes, Some(&options.target_url))?;
    if published.hash != candidate_hash || !published.identity.same_inode(&staged.identity) {
        return Err(ChangedResource(path.into()).into());
    }
    directories()?;
    unchanged(path, Some(&published), cache::MAX_CACHE_BYTES)?;
    next.phase = Phase::Installed;
    next.previous_patched_hash = None;
    next.staging_name = None;
    next.validate(root, path, &options.source_hash)?;
    save_manifest(&manifest_path, &next, manifest_snapshot.as_ref())?;
    Ok(outcome(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    struct Append;
    impl Transform for Append {
        fn build(&self, source: &str) -> Result<String> {
            Ok(format!("{source}\n// proved adapter"))
        }
        fn publication_fence(&self) -> Result<()> {
            Ok(())
        }
    }
    fn setup() -> (tempfile::TempDir, InstallOptions, Vec<u8>) {
        let t = tempfile::tempdir().unwrap();
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        let root = base.join("state");
        let parent = base.join("cache");
        platform::create_private(&root).unwrap();
        platform::create_private(&parent).unwrap();
        let bytes = cache::tests::fixture("export const a=1;");
        let cache_path = parent.join("0123456789abcdef_0");
        platform::publish(&cache_path, &bytes, 0o600).unwrap();
        let entry = cache::inspect(&bytes, None).unwrap();
        (
            t,
            InstallOptions {
                root,
                cache_path,
                source_hash: entry.source_hash,
                target_url: entry.url,
            },
            bytes,
        )
    }
    #[test]
    fn install_reinstall_restore_preserves_immutable_original() {
        let (_t, o, original) = setup();
        assert!(operate(Action::Install, &o, &Append).unwrap().changed);
        let backup = o.root.join("ui-folder-compat/original.cache");
        assert_eq!(fs::read(&backup).unwrap(), original);
        let inode = FileIdentity::from_metadata(&fs::metadata(&backup).unwrap());
        assert!(!operate(Action::Install, &o, &Append).unwrap().changed);
        assert!(operate(Action::Restore, &o, &Append).unwrap().changed);
        assert_eq!(fs::read(&o.cache_path).unwrap(), original);
        assert_eq!(
            FileIdentity::from_metadata(&fs::metadata(&backup).unwrap()),
            inode
        );
        assert!(operate(Action::Install, &o, &Append).unwrap().changed);
    }
    #[test]
    fn foreign_writes_and_hardlink_aliases_refuse_without_replacement() {
        let (_t, o, _) = setup();
        operate(Action::Install, &o, &Append).unwrap();
        let bytes = cache::tests::fixture("export const foreign=1;");
        fs::write(&o.cache_path, &bytes).unwrap();
        assert!(operate(Action::Restore, &o, &Append).is_err());
        assert_eq!(fs::read(&o.cache_path).unwrap(), bytes);
        let alias = o.cache_path.with_file_name("alias");
        fs::hard_link(&o.cache_path, alias).unwrap();
        assert!(snapshot(&o.cache_path, cache::MAX_CACHE_BYTES).is_err());
    }
}
