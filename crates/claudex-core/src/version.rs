//! Runtime compatibility never replaces protocol, history or ownership checks.
use crate::storage::read_json_or;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

pub const SUPPORTED_CODEX_VERSIONS: &[&str] = &[
    "codex-cli 0.155.0-alpha.16.3",
    "codex-cli 0.155.0-alpha.16.4",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionPolicy {
    #[default]
    Strict,
    Warn,
}
impl VersionPolicy {
    pub fn parse(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("strict") {
            "strict" => Ok(Self::Strict),
            "warn" => Ok(Self::Warn),
            _ => bail!("versionPolicy must be strict or warn."),
        }
    }
    pub fn read(root: &Path) -> Result<Self> {
        let config = read_json_or(root.join("config.json"), Value::Null)?;
        Self::parse(
            config
                .get("versionPolicy")
                .map(|v| v.as_str().unwrap_or("")),
        )
    }
    pub fn permits(self, actual: &str, known: Option<&str>) -> bool {
        !actual.is_empty()
            && actual.len() <= 160
            && !actual.contains(['\r', '\n', '\0'])
            && (self == Self::Warn || Some(actual) == known)
    }
    pub fn allows_codex(self, actual: &str) -> bool {
        self.permits(actual, is_supported_codex_version(actual).then_some(actual))
    }
}
pub fn is_supported_codex_version(version: &str) -> bool {
    SUPPORTED_CODEX_VERSIONS.contains(&version)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_versions_do_not_relax_structural_response_validation() {
        assert!(!VersionPolicy::Strict.allows_codex("codex-cli 0.160.0"));
        assert!(VersionPolicy::Warn.allows_codex("codex-cli 0.160.0"));
        for invalid in ["", "codex-cli 0.160.0\n", "bad\0version"] {
            assert!(!VersionPolicy::Warn.allows_codex(invalid));
        }
        assert!(VersionPolicy::parse(Some("anything")).is_err());
        for version in SUPPORTED_CODEX_VERSIONS {
            assert!(VersionPolicy::Strict.allows_codex(version));
        }
    }
}
