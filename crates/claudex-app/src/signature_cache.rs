//! Bounded scheduling optimization for successful deep publisher verification.
use crate::{
    platform,
    providers::{AppSpec, Publisher},
};
use anyhow::{Result, ensure};
use claudex_core::storage::FileIdentity;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub const MAX_AGE_MS: u64 = 3600000;
pub fn bundle_identity(app: &Path) -> Result<Option<String>> {
    let mut parts = vec![];
    for relative in [
        "",
        "Contents",
        "Contents/Info.plist",
        "Contents/MacOS",
        "Contents/_CodeSignature",
        "Contents/_CodeSignature/CodeResources",
    ] {
        let p = app.join(relative);
        let m = match std::fs::symlink_metadata(p) {
            Ok(m) => m,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if m.file_type().is_symlink() {
            return Ok(None);
        }
        let i = FileIdentity::from_metadata(&m);
        parts.push(format!(
            "{relative}:{}:{}:{}:{}:{}:{}",
            i.dev, i.ino, i.mode, i.size, i.mtime_ns, i.ctime_ns
        ));
    }
    Ok(Some(parts.join("|")))
}
fn spec_key(spec: &AppSpec) -> String {
    serde_json::to_string(&(spec.identifier, spec.team, spec.local_resign)).unwrap()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    spec: String,
    identity: String,
    verified_at: u64,
    signature: Publisher,
}
pub struct SignatureCache {
    root: PathBuf,
    reuse: bool,
    persist: bool,
    entries: BTreeMap<String, Entry>,
    dirty: bool,
}
impl SignatureCache {
    pub fn open(root: PathBuf, reuse: bool, persist: bool) -> Self {
        let entries = platform::optional_json(&root.join("app-signatures.json"), 64 * 1024, true)
            .ok()
            .flatten()
            .filter(|v| v["version"] == 1)
            .and_then(|v| serde_json::from_value(v["entries"].clone()).ok())
            .unwrap_or_default();
        Self {
            root,
            reuse,
            persist,
            entries,
            dirty: false,
        }
    }
    pub fn lookup(
        &self,
        app: &Path,
        spec: &AppSpec,
        identity: Option<&str>,
        now: u64,
    ) -> Option<Publisher> {
        if !self.reuse {
            return None;
        }
        let identity = identity?;
        let entry = self.entries.get(app.to_str()?)?;
        (entry.spec == spec_key(spec)
            && entry.identity == identity
            && now >= entry.verified_at
            && now - entry.verified_at < MAX_AGE_MS)
            .then_some(entry.signature)
    }
    pub fn record(
        &mut self,
        app: &Path,
        spec: &AppSpec,
        signature: Publisher,
        identity: Option<&str>,
        now: u64,
    ) -> Result<()> {
        if !self.persist {
            return Ok(());
        }
        let Some(identity) = identity else {
            return Ok(());
        };
        if bundle_identity(app)?.as_deref() != Some(identity) {
            return Ok(());
        }
        self.entries.insert(
            app.to_string_lossy().into(),
            Entry {
                spec: spec_key(spec),
                identity: identity.into(),
                verified_at: now,
                signature,
            },
        );
        self.dirty = true;
        Ok(())
    }
    pub fn save(&mut self) -> Result<()> {
        if !self.persist || !self.dirty {
            return Ok(());
        }
        self.dirty = false;
        // This disposable cache never creates a root or weakens its permissions.
        if platform::directory(&self.root, true, false).is_err() {
            return Ok(());
        }
        let mut entries: Vec<_> = self.entries.iter().collect();
        entries.sort_by_key(|(_, e)| std::cmp::Reverse(e.verified_at));
        let entries: BTreeMap<_, _> = entries.into_iter().take(16).collect();
        let value = serde_json::json!({"version":1,"entries":entries});
        ensure!(
            serde_json::to_vec(&value)?.len() <= 64 * 1024,
            "Signature cache exceeds its bound."
        );
        platform::write_json(&self.root.join("app-signatures.json"), &value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bundle_identity_expiry_and_read_only_cache_contract() -> Result<()> {
        let t = tempfile::tempdir()?;
        let base = std::fs::canonicalize(t.path())?;
        let root = base.join("state");
        platform::create_private(&root)?;
        let app = base.join("App.app");
        std::fs::create_dir_all(app.join("Contents/MacOS"))?;
        std::fs::create_dir_all(app.join("Contents/_CodeSignature"))?;
        std::fs::write(app.join("Contents/Info.plist"), "info")?;
        std::fs::write(app.join("Contents/_CodeSignature/CodeResources"), "seal")?;
        let identity = bundle_identity(&app)?;
        let mut cache = SignatureCache::open(root.clone(), true, true);
        cache.record(
            &app,
            &crate::providers::CLAUDE,
            Publisher::Local,
            identity.as_deref(),
            100,
        )?;
        cache.save()?;
        let readonly = SignatureCache::open(root.clone(), true, false);
        assert_eq!(
            readonly.lookup(
                &app,
                &crate::providers::CLAUDE,
                identity.as_deref(),
                100 + MAX_AGE_MS - 1
            ),
            Some(Publisher::Local)
        );
        assert_eq!(
            readonly.lookup(
                &app,
                &crate::providers::CLAUDE,
                identity.as_deref(),
                100 + MAX_AGE_MS
            ),
            None
        );
        assert_eq!(
            readonly.lookup(&app, &crate::providers::CODEX, identity.as_deref(), 101),
            None
        );
        let before = std::fs::read(root.join("app-signatures.json"))?;
        let mut readonly = readonly;
        readonly.record(
            &app,
            &crate::providers::CLAUDE,
            Publisher::Vendor,
            identity.as_deref(),
            200,
        )?;
        readonly.save()?;
        assert_eq!(std::fs::read(root.join("app-signatures.json"))?, before);
        std::fs::write(
            app.join("Contents/_CodeSignature/CodeResources"),
            "replaced seal",
        )?;
        assert_eq!(
            readonly.lookup(
                &app,
                &crate::providers::CLAUDE,
                bundle_identity(&app)?.as_deref(),
                101
            ),
            None
        );
        let absent = base.join("absent");
        let mut readonly = SignatureCache::open(absent.clone(), true, false);
        readonly.record(
            &app,
            &crate::providers::CLAUDE,
            Publisher::Local,
            bundle_identity(&app)?.as_deref(),
            300,
        )?;
        readonly.save()?;
        assert!(!absent.exists());
        Ok(())
    }
}
