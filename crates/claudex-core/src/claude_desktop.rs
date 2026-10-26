//! Native deployment selection. First-party and Gateway stores stay separate.
use crate::storage::{self, FileIdentity};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub user_data: PathBuf,
    home: PathBuf,
    configuration: Option<FileIdentity>,
}
impl Selection {
    pub fn read(home: &Path) -> Result<Self> {
        ensure!(home.is_absolute(), "Claude Desktop home must be absolute.");
        let config = configuration_path(home);
        // Do not follow an ancestor alias, including when its final file is absent.
        let mut ancestor = home.to_path_buf();
        for part in ["Library", "Application Support", "Claude-3p"] {
            ancestor.push(part);
            match fs::symlink_metadata(&ancestor) {
                Ok(m) => ensure!(
                    m.is_dir()
                        && !m.file_type().is_symlink()
                        && m.uid() == storage::uid()
                        && m.mode() & 0o022 == 0,
                    "Claude Desktop configuration ancestors must be owned directories without foreign writers or aliases."
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.into()),
            }
        }
        let (third_party, configuration) = match storage::read_stable_with_limit(
            &config,
            1024 * 1024,
        ) {
            Ok(file) => {
                ensure!(
                    file.identity.uid == storage::uid().to_string()
                        && file.identity.nlink == "1"
                        && file.identity.mode.parse::<u32>()? & 0o022 == 0,
                    "Claude Desktop configuration must be owned, single-linked and not writable by others."
                );
                let value: Value = serde_json::from_slice(&file.bytes)?;
                ensure!(
                    value.is_object(),
                    "Claude Desktop configuration must be an object."
                );
                let third_party = match value.get("deploymentMode") {
                    None => false,
                    Some(Value::String(mode)) if mode == "1p" => false,
                    Some(Value::String(mode)) if mode == "3p" => true,
                    _ => anyhow::bail!(
                        "Claude Desktop deployment mode is unavailable or unsupported."
                    ),
                };
                (third_party, Some(file.identity))
            }
            Err(e) if storage::is_not_found(&e) => (false, None),
            Err(e) => return Err(e),
        };
        Ok(Self {
            user_data: home
                .join("Library/Application Support")
                .join(if third_party { "Claude-3p" } else { "Claude" }),
            home: home.into(),
            configuration,
        })
    }
    pub fn registry(&self) -> PathBuf {
        self.user_data.join("claude-code-sessions")
    }
    pub fn cache(&self) -> PathBuf {
        self.user_data.join("Cache/Cache_Data")
    }
    pub fn cli_cache(&self) -> PathBuf {
        self.user_data.join("claude-code")
    }
    /// A saved setting selects a store, not an active renderer or writer lease.
    pub fn verify(&self) -> Result<()> {
        ensure!(
            *self == Self::read(&self.home)?,
            "Claude Desktop deployment changed during the operation."
        );
        Ok(())
    }
}
pub fn configuration_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Claude-3p/claude_desktop_config.json")
}
pub fn registry(home: &Path, explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        let path = PathBuf::from(path);
        ensure!(
            path.is_absolute(),
            "Native Desktop registry must be absolute."
        );
        return Ok(path);
    }
    Ok(Selection::read(home)?.registry())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn configuration(home: &Path, value: &str) -> PathBuf {
        let path = configuration_path(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, value).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    #[test]
    fn selects_native_namespaces_without_combining_stores() {
        let home = tempfile::tempdir().unwrap();
        let first = Selection::read(home.path()).unwrap();
        assert!(first.registry().ends_with("Claude/claude-code-sessions"));
        configuration(
            home.path(),
            r#"{"deploymentMode":"3p","extra":"preserved"}"#,
        );
        let third = Selection::read(home.path()).unwrap();
        assert!(third.cache().ends_with("Claude-3p/Cache/Cache_Data"));
        assert!(third.cli_cache().ends_with("Claude-3p/claude-code"));
        assert!(first.verify().is_err());
        third.verify().unwrap();
        configuration(home.path(), r#"{"deploymentMode":"1p"}"#);
        assert!(third.verify().is_err());
        assert_eq!(
            Selection::read(home.path()).unwrap().user_data,
            first.user_data
        );
    }
    #[test]
    fn rejects_unsafe_or_ambiguous_configuration_but_preserves_explicit_registry() {
        let home = tempfile::tempdir().unwrap();
        let path = configuration(home.path(), r#"{"deploymentMode":"future"}"#);
        assert!(Selection::read(home.path()).is_err());
        assert_eq!(
            registry(home.path(), Some("/fixture/registry")).unwrap(),
            Path::new("/fixture/registry")
        );
        assert!(registry(home.path(), Some("relative")).is_err());
        configuration(home.path(), "{");
        assert!(Selection::read(home.path()).is_err());
        configuration(home.path(), "{}");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(Selection::read(home.path()).is_err());
        fs::remove_file(&path).unwrap();
        symlink(home.path().join("absent"), &path).unwrap();
        assert!(Selection::read(home.path()).is_err());
        fs::remove_file(&path).unwrap();
        configuration(home.path(), "{}");
        fs::hard_link(&path, home.path().join("configuration-alias")).unwrap();
        assert!(Selection::read(home.path()).is_err());
    }
    #[test]
    fn missing_optional_mode_uses_first_party_and_exact_config_changes_fence_passes() {
        let home = tempfile::tempdir().unwrap();
        configuration(home.path(), "{}");
        let selected = Selection::read(home.path()).unwrap();
        assert!(selected.user_data.ends_with("Claude"));
        configuration(home.path(), r#"{"other":true}"#);
        assert!(selected.verify().is_err());
    }
}
