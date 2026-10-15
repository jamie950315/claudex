//! The observed same-bundle Codex layouts and original publisher identities.
use crate::storage::read_stable;
use anyhow::{Context, Result, bail};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

const FLAT: &str = "/Contents/Resources/codex";
const PACKAGED: &str = "/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const SHELL: &str = "/Contents/Resources/codex-cli/bin/codex";
pub fn codex_app_bundle(binary: &Path) -> Option<PathBuf> {
    let value = binary.to_str()?;
    if !binary.is_absolute()
        || value.contains("//")
        || binary
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || value.contains("/./")
    {
        return None;
    }
    for suffix in [PACKAGED, SHELL, FLAT] {
        if let Some(app) = value.strip_suffix(suffix) {
            if app.ends_with(".app") {
                return Some(PathBuf::from(app));
            }
        }
    }
    None
}
pub fn is_bundled_relocation(previous: &Path, next: &Path) -> bool {
    let Some(app) = codex_app_bundle(previous) else {
        return false;
    };
    codex_app_bundle(next).as_ref() == Some(&app)
        && previous != next
        && [
            PathBuf::from(format!("{}{FLAT}", app.display())),
            PathBuf::from(format!("{}{SHELL}", app.display())),
        ]
        .contains(&previous.to_owned())
        && next == Path::new(&format!("{}{PACKAGED}", app.display()))
}
pub fn bundled_desktop_node(binary: &Path) -> Option<PathBuf> {
    codex_app_bundle(binary).map(|app| app.join("Contents/Resources/cua_node/bin/node"))
}

#[async_trait::async_trait]
pub trait BinaryVerifier: Send + Sync {
    async fn verify(&self, path: &Path, identifier: &str) -> Result<()>;
}
pub struct OpenAiVerifier;
#[async_trait::async_trait]
impl BinaryVerifier for OpenAiVerifier {
    async fn verify(&self, path: &Path, identifier: &str) -> Result<()> {
        let verified = timeout(
            Duration::from_secs(15),
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict"])
                .arg(path)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        if !verified.status.success() {
            bail!("Desktop integration requires the original OpenAI-signed executable.");
        }
        let identity = timeout(
            Duration::from_secs(15),
            Command::new("/usr/bin/codesign")
                .args(["-d", "--verbose=2"])
                .arg(path)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        if !identity.status.success() || identity.stderr.len() > 65536 {
            bail!("Desktop executable signing identity is unavailable.");
        }
        let identity = String::from_utf8(identity.stderr)?;
        if !identity
            .lines()
            .any(|s| s == format!("Identifier={identifier}"))
            || !identity.lines().any(|s| s == "TeamIdentifier=2DC432GLL2")
        {
            bail!("Desktop integration requires the original OpenAI-signed executable.");
        }
        Ok(())
    }
}
pub async fn verify_bundled_codex(path: &Path) -> Result<()> {
    OpenAiVerifier.verify(path, "codex").await
}
pub async fn verify_desktop_node(path: &Path) -> Result<()> {
    OpenAiVerifier.verify(path, "node").await
}
pub async fn resolve_bundled_codex(binary: &Path) -> Result<PathBuf> {
    resolve_bundled_codex_with(binary, &OpenAiVerifier).await
}
pub async fn resolve_bundled_codex_with(
    binary: &Path,
    verifier: &dyn BinaryVerifier,
) -> Result<PathBuf> {
    let Some(app) = codex_app_bundle(binary) else {
        return Ok(binary.to_owned());
    };
    let package = app.join("Contents/Resources/codex-cli");
    let info = match fs::symlink_metadata(&package) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(binary.to_owned()),
        Err(e) => return Err(e.into()),
    };
    if !info.is_dir() || info.file_type().is_symlink() || fs::canonicalize(&package)? != package {
        bail!("Bundled Codex package directory has an unverified identity.");
    }
    let metadata = package.join("codex-package.json");
    let source = read_stable(&metadata)?;
    if source.bytes.len() > 4096 {
        bail!("Bundled Codex package metadata is invalid.");
    }
    let manifest: serde_json::Value = serde_json::from_slice(&source.bytes)?;
    if manifest["layoutVersion"] != 1
        || manifest["variant"] != "codex"
        || manifest["entrypoint"] != "bin/codex"
        || manifest["resourcesDir"] != "codex-resources"
        || manifest["pathDir"] != "codex-path"
    {
        bail!("Bundled Codex package layout is not supported.");
    }
    let next = PathBuf::from(format!("{}{PACKAGED}", app.display()));
    let info = fs::symlink_metadata(&next)?;
    if !info.is_file()
        || info.file_type().is_symlink()
        || fs::canonicalize(&next)? != next
        || info.permissions().mode() & 0o111 == 0
    {
        bail!("Bundled Codex executable has an unverified identity.");
    }
    verifier
        .verify(&next, "codex")
        .await
        .context("Desktop CLI relocation requires the original OpenAI-signed Codex executable.")?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Accept;
    #[async_trait::async_trait]
    impl BinaryVerifier for Accept {
        async fn verify(&self, _: &Path, identifier: &str) -> Result<()> {
            assert_eq!(identifier, "codex");
            Ok(())
        }
    }
    #[test]
    fn only_observed_same_bundle_relocations_are_accepted() {
        let flat = Path::new("/Applications/ChatGPT.app/Contents/Resources/codex");
        let next = Path::new(
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        );
        assert!(is_bundled_relocation(flat, next));
        assert!(!is_bundled_relocation(next, flat));
        assert!(!is_bundled_relocation(
            flat,
            Path::new(
                "/other/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
            )
        ));
        assert_eq!(
            bundled_desktop_node(flat),
            Some(PathBuf::from(
                "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
            ))
        );
    }
    #[tokio::test]
    async fn packaged_layout_is_verified_and_unknown_metadata_never_falls_back() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let app = fs::canonicalize(temp.path())?.join("Example.app");
        let flat = app.join("Contents/Resources/codex");
        let package = app.join("Contents/Resources/codex-cli");
        fs::create_dir_all(&package)?;
        let metadata = package.join("codex-package.json");
        let manifest = json!({"layoutVersion":1,"variant":"codex","entrypoint":"bin/codex","resourcesDir":"codex-resources","pathDir":"codex-path"});
        fs::write(&metadata, serde_json::to_vec(&manifest)?)?;
        let next = package.join("CodexCLI.app/Contents/MacOS/codex");
        fs::create_dir_all(next.parent().unwrap())?;
        fs::write(&next, "synthetic executable")?;
        fs::set_permissions(&next, fs::Permissions::from_mode(0o700))?;
        assert_eq!(resolve_bundled_codex_with(&flat, &Accept).await?, next);
        fs::write(&metadata, r#"{"layoutVersion":2}"#)?;
        assert!(resolve_bundled_codex_with(&flat, &Accept).await.is_err());
        Ok(())
    }
}
