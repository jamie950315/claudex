//! Capability discovery and isolated, integrity-pinned native Mod management.
use crate::{
    package,
    platform::{self, CommandSpec, Runner, checked},
};
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
pub const VERSION: &str = "2.1.287";
const WRAPPER: &str = "@anthropic-ai/claude-code";
const WRAPPER_INTEGRITY: &str = "sha512-V5WRpA+p41siSlf/Ujxjm//RtYvySxH/p9/rh6zRxNoHeBzqTgSDw3nP8PgtACM/KcVx/g5TFUNdVkq51dfg0g==";
const ARM_INTEGRITY: &str = "sha512-ZQLmkEpiWd8sxUYRpQr1yZ39DyVBhrl8MUtbxe33E+z4jFPtUy+CrJXmeRRyyM+FEfvGe/2ab+E59GiSKkprRw==";
const X64_INTEGRITY: &str = "sha512-B5TXBZxGKqglEj5DUp0EjZRBypee4hLSfgkTJIPHdLNB4PAtt6hBkNZVxytny0jUjk0ReWUNtVSb0PTldKRW7Q==";
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Runtime {
    Ready {
        binary: PathBuf,
        version: String,
        source: String,
    },
    Missing {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}
impl Runtime {
    pub fn binary(&self) -> Option<&Path> {
        if let Self::Ready { binary, .. } = self {
            Some(binary)
        } else {
            None
        }
    }
}
pub struct Options<'a> {
    pub root: &'a Path,
    pub home: &'a Path,
    pub claude_binary: Option<&'a Path>,
    pub arch: Option<&'a str>,
}
fn native(o: &Options<'_>) -> Result<(String, &'static str, &'static str)> {
    ensure!(
        cfg!(target_os = "macos"),
        "Separate Mod manager bootstrap supports only macOS arm64 and x64."
    );
    let arch = o.arch.unwrap_or(if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else if std::env::consts::ARCH == "x86_64" {
        "x64"
    } else {
        "unsupported"
    });
    let (arch, integrity) = match arch {
        "arm64" => ("arm64", ARM_INTEGRITY),
        "x64" => ("x64", X64_INTEGRITY),
        _ => bail!("Separate Mod manager bootstrap supports only macOS arm64 and x64."),
    };
    Ok((format!("{WRAPPER}-darwin-{arch}"), integrity, arch))
}
fn protected_json(p: &Path) -> Result<Value> {
    ensure!(
        fs::canonicalize(p)? == p,
        "Mod manager metadata contains an unexpected symbolic-link alias."
    );
    serde_json::from_slice(&platform::safe_bytes(p, 1024 * 1024, false, false)?)
        .context("Malformed private Mod manager metadata.")
}
fn file(p: &Path, executable: bool, allow_root: bool) -> Result<platform::Identity> {
    ensure!(
        fs::canonicalize(p)? == p,
        "Mod manager file is not canonical."
    );
    let m = fs::symlink_metadata(p)?;
    ensure!(
        m.is_file()
            && !m.file_type().is_symlink()
            && (m.uid() == platform::uid() || allow_root && m.uid() == 0)
            && m.nlink() == 1
            && m.mode() & 0o022 == 0
            && (!executable || m.mode() & 0o111 != 0),
        "Mod manager file is not canonical, owned, and protected from foreign writes."
    );
    Ok(platform::Identity::of(&m))
}
async fn probe(
    binary: &Path,
    args: Vec<String>,
    o: &Options<'_>,
    run: &dyn Runner,
) -> Result<crate::platform::CommandOutput> {
    let help = args.iter().any(|v| v == "--help");
    let mut spec = CommandSpec::new(binary, args);
    spec.env = package::environment(o.home);
    spec.timeout = Duration::from_secs(10);
    spec.max_bytes = 64 * 1024;
    let result=run.run(spec).await.context("The selected native Mod manager failed its bounded capability probe; no alternate runtime was started.")?;
    if result.code != 0 {
        let message = format!("{}\n{}", result.stdout, result.stderr);
        if help&&regex::Regex::new(r#"(?i)(?:unknown command|unrecognized (?:command|argument))\s+['"]?(?:configure|validate)['"]?"#)?.is_match(&message){return Ok(Default::default());}
        bail!(
            "The selected native Mod manager failed its bounded capability probe; no alternate runtime was started."
        );
    }
    Ok(result)
}
async fn capability(
    binary: &Path,
    o: &Options<'_>,
    source: &str,
    run: &dyn Runner,
) -> Result<Option<Runtime>> {
    let canonical = fs::canonicalize(binary)?;
    let before = file(&canonical, true, source == "provided-native-cli")?;
    let reply = probe(&canonical, vec!["--version".into()], o, run).await?;
    let re = regex::Regex::new(r"^(\d+\.\d+\.\d+)(?:\s|$)")?;
    let version = re
        .captures(reply.stdout.trim())
        .map(|c| c[1].to_string())
        .context("The selected Mod manager did not report an unambiguous native version.")?;
    ensure!(
        semver(&version).is_some(),
        "The selected Mod manager did not report an unambiguous native version."
    );
    for method in ["configure", "validate"] {
        let reply = probe(
            &canonical,
            vec!["plugin".into(), method.into(), "--help".into()],
            o,
            run,
        )
        .await?;
        if !regex::Regex::new(&format!(r"(?m)^Usage: claude plugin {method}(?:\s|$)"))?
            .is_match(&reply.stdout)
        {
            return Ok(None);
        }
    }
    ensure!(
        file(&canonical, true, source == "provided-native-cli")? == before,
        "The Mod manager executable changed during capability inspection."
    );
    Ok(Some(Runtime::Ready {
        binary: canonical,
        version,
        source: source.into(),
    }))
}
fn semver(s: &str) -> Option<(u64, u64, u64)> {
    let p: Vec<_> = s.split('.').collect();
    if p.len() != 3
        || p.iter()
            .any(|p| p.is_empty() || p.len() > 1 && p.starts_with('0'))
    {
        return None;
    }
    Some((p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?))
}
fn entries(path: &Path, max: usize) -> Result<Vec<fs::DirEntry>> {
    let mut out = vec![];
    for entry in fs::read_dir(path)? {
        ensure!(
            out.len() < max,
            "Native Mod manager cache inventory exceeds its bounded inspection limit."
        );
        out.push(entry?);
    }
    Ok(out)
}
async fn desktop(o: &Options<'_>, run: &dyn Runner) -> Result<Option<Runtime>> {
    let cache = o
        .home
        .join("Library/Application Support/Claude/claude-code");
    if !crate::status_app::exists(&cache)? {
        return Ok(None);
    }
    let mut current = o.home.to_path_buf();
    for n in ["Library", "Application Support", "Claude", "claude-code"] {
        current.push(n);
        platform::directory(&current, false, false)?;
    }
    let mut versions: Vec<_> = entries(&cache, 64)?
        .into_iter()
        .filter_map(|e| semver(e.file_name().to_str()?).map(|v| (v, e.path())))
        .collect();
    versions.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
    let mut inspected = 0;
    for (_, version_path) in versions {
        platform::directory(&version_path, false, false)?;
        let mut builds: Vec<_> = entries(&version_path, 32)?
            .into_iter()
            .filter(|e| {
                e.file_name().to_str().is_some_and(|s| {
                    (8..=64).contains(&s.len())
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            })
            .map(|e| e.path())
            .collect();
        builds.sort();
        for build in builds {
            inspected += 1;
            ensure!(
                inspected <= 128,
                "Native Mod manager cache inventory exceeds its candidate limit."
            );
            platform::directory(&build, false, false)?;
            let app = build.join("claude.app");
            if !crate::status_app::exists(&app)? {
                continue;
            }
            for relative in ["", "Contents", "Contents/MacOS", "Contents/_CodeSignature"] {
                platform::directory(&app.join(relative), false, false)?;
            }
            let binary = app.join("Contents/MacOS/claude");
            for p in [
                app.join("Contents/Info.plist"),
                app.join("Contents/_CodeSignature/CodeResources"),
                binary.clone(),
            ] {
                file(&p, false, false)?;
            }
            let proof_paths = [
                app.clone(),
                app.join("Contents"),
                app.join("Contents/MacOS"),
                app.join("Contents/Info.plist"),
                app.join("Contents/_CodeSignature"),
                app.join("Contents/_CodeSignature/CodeResources"),
                binary.clone(),
            ];
            let identities = proof_paths
                .iter()
                .map(|p| Ok(platform::Identity::of(&fs::symlink_metadata(p)?)))
                .collect::<Result<Vec<_>>>()?;
            let stable = || -> Result<()> {
                for (path, identity) in proof_paths.iter().zip(&identities) {
                    ensure!(
                        *identity == platform::Identity::of(&fs::symlink_metadata(path)?),
                        "Desktop Mod manager bundle changed during signature or capability verification."
                    );
                }
                Ok(())
            };
            let signature = async {
                let mut spec = CommandSpec::new(
                    "/usr/bin/codesign",
                    ["--verify", "--deep", "--strict", &app.to_string_lossy()],
                );
                spec.env = package::environment(o.home);
                spec.timeout = Duration::from_secs(15);
                spec.max_bytes = 64 * 1024;
                checked(run, spec).await?;
                let mut spec = CommandSpec::new(
                    "/usr/bin/codesign",
                    ["-d", "--verbose=2", &app.to_string_lossy()],
                );
                spec.env = package::environment(o.home);
                spec.timeout = Duration::from_secs(10);
                spec.max_bytes = 64 * 1024;
                let details = checked(run, spec).await?;
                ensure!(
                    details
                        .stderr
                        .lines()
                        .any(|v| v == "Identifier=com.anthropic.claude-code")
                        && details
                            .stderr
                            .lines()
                            .any(|v| v == "TeamIdentifier=Q6L2SF6YDW"),
                    "publisher"
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            ensure!(
                signature.is_ok(),
                "Desktop Mod manager signature or publisher verification failed; no alternate runtime was selected."
            );
            stable()?;
            let selected = capability(&binary, o, "desktop-cache", run).await?;
            stable()?;
            if selected.is_some() {
                return Ok(selected);
            }
        }
    }
    Ok(None)
}
async fn private(prefix: &Path, o: &Options<'_>, run: &dyn Runner) -> Result<Runtime> {
    crate::mod_storage::directory(prefix, false)?;
    let (name, integrity, arch) = native(o)?;
    let new_source = prefix.join("source.json");
    let binary;
    if crate::status_app::exists(&new_source)? {
        let source = protected_json(&new_source)?;
        ensure!(
            source["version"] == 1
                && source["name"] == name
                && source["packageVersion"] == VERSION
                && source["integrity"] == integrity
                && source["tarball"]
                    == format!(
                        "https://registry.npmjs.org/{name}/-/claude-code-darwin-{arch}-{VERSION}.tgz"
                    ),
            "Private Mod manager source does not match the pinned official native package."
        );
        let payload = prefix.join("payload");
        crate::mod_storage::directory(&payload, false)?;
        let manifest = protected_json(&payload.join("package.json"))?;
        ensure!(
            manifest["name"] == name
                && manifest["version"] == VERSION
                && manifest["os"] == serde_json::json!(["darwin"])
                && manifest["cpu"] == serde_json::json!([arch]),
            "Private native Mod manager metadata does not match the selected macOS architecture."
        );
        binary = payload.join("claude");
    } else {
        let lock = protected_json(&prefix.join("package-lock.json"))?;
        let wrapper_path = "node_modules/@anthropic-ai/claude-code";
        let native_path = format!("node_modules/{name}");
        ensure!(
            [serde_json::json!(2), serde_json::json!(3)].contains(&lock["lockfileVersion"])
                && lock["packages"][""]["dependencies"][WRAPPER] == VERSION
                && lock["packages"][wrapper_path]["version"] == VERSION
                && lock["packages"][wrapper_path]["integrity"] == WRAPPER_INTEGRITY
                && lock["packages"][wrapper_path]["resolved"]
                    == format!("https://registry.npmjs.org/{WRAPPER}/-/claude-code-{VERSION}.tgz")
                && lock["packages"][&native_path]["version"] == VERSION
                && lock["packages"][&native_path]["integrity"] == integrity
                && lock["packages"][&native_path]["resolved"]
                    == format!(
                        "https://registry.npmjs.org/{name}/-/claude-code-darwin-{arch}-{VERSION}.tgz"
                    ),
            "Private Mod manager package-lock does not match the pinned official wrapper, native package, and integrity."
        );
        let mut current = prefix.to_path_buf();
        for p in wrapper_path.split('/') {
            current.push(p);
            platform::directory(&current, false, false)?;
        }
        let manifest = protected_json(&current.join("package.json"))?;
        ensure!(
            manifest["name"] == WRAPPER
                && manifest["version"] == VERSION
                && manifest["bin"]["claude"] == "bin/claude.exe"
                && manifest["optionalDependencies"][&name] == VERSION,
            "Private Mod manager package metadata does not match the pinned executable."
        );
        let native = prefix.join(native_path);
        platform::directory(&native, false, false)?;
        let manifest = protected_json(&native.join("package.json"))?;
        ensure!(
            manifest["name"] == name
                && manifest["version"] == VERSION
                && manifest["os"] == serde_json::json!(["darwin"])
                && manifest["cpu"] == serde_json::json!([arch]),
            "Private native Mod manager metadata does not match the selected macOS architecture."
        );
        binary = native.join("claude");
    }
    let selected = capability(&binary, o, "private-mod-manager", run)
        .await?
        .context("The pinned private Mod manager does not provide its required capabilities.")?;
    ensure!(
        matches!(&selected,Runtime::Ready{version,..} if version==VERSION),
        "The pinned private Mod manager does not provide its required native version."
    );
    Ok(selected)
}
async fn find_inner(o: &Options<'_>, run: &dyn Runner) -> Result<Runtime> {
    for path in [Some(o.root), Some(o.home), o.claude_binary]
        .into_iter()
        .flatten()
    {
        platform::absolute(path)?;
    }
    platform::directory(o.home, false, false)?;
    if crate::status_app::exists(o.root)? {
        crate::mod_storage::directory(o.root, false)?;
    }
    if let Some(binary) = o.claude_binary.filter(|p| p.exists()) {
        if let Some(selected) = capability(binary, o, "provided-native-cli", run).await? {
            return Ok(selected);
        }
    }
    if let Some(selected) = desktop(o, run).await? {
        return Ok(selected);
    }
    let providers = o.root.join("providers");
    if crate::status_app::exists(&providers)? {
        crate::mod_storage::directory(&providers, false)?;
    }
    let prefix = providers.join("claude-mod-cli");
    if crate::status_app::exists(&prefix)? {
        private(&prefix, o, run).await
    } else {
        Ok(Runtime::Missing {
            reason: "No installed Mod manager advertises both configure and validate support."
                .into(),
        })
    }
}
pub async fn find(o: &Options<'_>, run: &dyn Runner) -> Runtime {
    find_inner(o, run)
        .await
        .unwrap_or_else(|e| Runtime::Blocked {
            reason: e.to_string(),
        })
}
pub async fn ensure(o: &Options<'_>, run: &dyn Runner) -> Runtime {
    let found = find(o, run).await;
    if !matches!(found, Runtime::Missing { .. }) {
        return found;
    }
    let result=async{let (name,integrity,_)=native(o)?;crate::mod_storage::directory(o.root,false)?;let providers=o.root.join("providers");crate::mod_storage::directory(&providers,true)?;let _lock=claudex_core::storage::FileLock::acquire(providers.join("claude-mod-bootstrap.lock"),true)?;let prefix=providers.join("claude-mod-cli");if crate::status_app::exists(&prefix)?{return private(&prefix,o,run).await;}let candidate=providers.join(format!(".claude-mod-cli-{}",uuid::Uuid::new_v4()));crate::mod_storage::directory(&candidate,true)?;let metadata=package::metadata(&name,VERSION,Some(integrity),o.home,run).await?;package::install_package(&metadata,&candidate,o.home,run).await?;private(&candidate,o,run).await?;ensure!(!crate::status_app::exists(&prefix)?,"Another Mod manager installation appeared; the verified candidate was preserved without replacing it.");fs::rename(&candidate,&prefix)?;private(&prefix,o,run).await}.await;
    result.unwrap_or_else(|e: anyhow::Error| Runtime::Blocked {
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::CommandOutput;
    use async_trait::async_trait;
    use serde_json::json;
    use std::{
        os::unix::fs::{DirBuilderExt, PermissionsExt},
        sync::Mutex,
    };
    struct Probe {
        calls: Mutex<Vec<CommandSpec>>,
        failure: bool,
        missing_capability: bool,
    }
    #[async_trait]
    impl Runner for Probe {
        async fn run(&self, spec: CommandSpec) -> Result<CommandOutput> {
            self.calls.lock().unwrap().push(spec.clone());
            ensure!(
                spec.env.get("PATH").unwrap() == "/usr/bin:/bin:/usr/sbin:/sbin",
                "Native probe must not inherit credentials/configuration."
            );
            if self.failure {
                return Ok(CommandOutput {
                    code: 1,
                    stderr: "synthetic failure".into(),
                    ..Default::default()
                });
            }
            if spec.args == ["--version"] {
                return Ok(CommandOutput {
                    stdout: format!("{VERSION} (Claude Code)\n"),
                    ..Default::default()
                });
            }
            if self.missing_capability {
                return Ok(CommandOutput {
                    code: 1,
                    stderr: "unknown command 'configure'".into(),
                    ..Default::default()
                });
            }
            Ok(CommandOutput {
                stdout: format!("Usage: claude plugin {} [options]\n", spec.args[1]),
                ..Default::default()
            })
        }
    }
    fn file_at(p: &Path, value: &Value) -> Result<()> {
        platform::publish(p, claudex_core::json::stringify(value)?.as_bytes(), 0o600)
    }
    #[tokio::test]
    async fn provided_manager_requires_both_capabilities_and_never_falls_back_on_failure()
    -> Result<()> {
        let t = tempfile::tempdir()?;
        let root = fs::canonicalize(t.path())?;
        let binary = root.join("claude");
        platform::publish(&binary, b"synthetic", 0o700)?;
        let o = Options {
            root: &root,
            home: &root,
            claude_binary: Some(&binary),
            arch: Some("arm64"),
        };
        let run = Probe {
            calls: Mutex::new(vec![]),
            failure: false,
            missing_capability: false,
        };
        assert!(
            matches!(find(&o,&run).await,Runtime::Ready{source,..}if source=="provided-native-cli")
        );
        assert_eq!(run.calls.lock().unwrap().len(), 3);
        let run = Probe {
            calls: Mutex::new(vec![]),
            failure: true,
            missing_capability: false,
        };
        assert!(matches!(find(&o, &run).await, Runtime::Blocked { .. }));
        assert_eq!(run.calls.lock().unwrap().len(), 1);
        let run = Probe {
            calls: Mutex::new(vec![]),
            failure: false,
            missing_capability: true,
        };
        assert!(matches!(find(&o, &run).await, Runtime::Missing { .. }));
        assert_eq!(run.calls.lock().unwrap().len(), 2);
        Ok(())
    }
    #[tokio::test]
    async fn native_private_manager_preserves_pinned_integrity_and_single_link_proofs() -> Result<()>
    {
        let t = tempfile::tempdir()?;
        let root = fs::canonicalize(t.path())?;
        let prefix = root.join("providers/claude-mod-cli");
        let payload = prefix.join("payload");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&payload)?;
        let name = format!("{WRAPPER}-darwin-arm64");
        file_at(
            &prefix.join("source.json"),
            &json!({"version":1,"name":name,"packageVersion":VERSION,"tarball":format!("https://registry.npmjs.org/{name}/-/claude-code-darwin-arm64-{VERSION}.tgz"),"integrity":ARM_INTEGRITY}),
        )?;
        file_at(
            &payload.join("package.json"),
            &json!({"name":name,"version":VERSION,"os":["darwin"],"cpu":["arm64"]}),
        )?;
        platform::publish(&payload.join("claude"), b"synthetic", 0o700)?;
        let o = Options {
            root: &root,
            home: &root,
            claude_binary: None,
            arch: Some("arm64"),
        };
        let run = Probe {
            calls: Mutex::new(vec![]),
            failure: false,
            missing_capability: false,
        };
        assert!(
            matches!(find(&o,&run).await,Runtime::Ready{source,..}if source=="private-mod-manager")
        );
        fs::hard_link(payload.join("claude"), root.join("alias"))?;
        assert!(matches!(find(&o, &run).await, Runtime::Blocked { .. }));
        assert_eq!(run.calls.lock().unwrap().len(), 3);
        fs::set_permissions(root.join("providers"), fs::Permissions::from_mode(0o755))?;
        assert!(matches!(find(&o, &run).await, Runtime::Blocked { .. }));
        Ok(())
    }
}
