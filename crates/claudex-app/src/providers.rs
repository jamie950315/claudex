//! Publisher verification and independent provider discovery.
use crate::platform::{self, CommandSpec, Runner, checked};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Publisher {
    Vendor,
    Local,
}
#[derive(Clone, Debug)]
pub struct AppSpec {
    pub names: &'static [&'static str],
    pub identifier: &'static str,
    pub team: &'static str,
    pub local_resign: bool,
}
pub const CODEX: AppSpec = AppSpec {
    names: &["ChatGPT.app", "Codex.app"],
    identifier: "com.openai.codex",
    team: "2DC432GLL2",
    local_resign: false,
};
pub const CLAUDE: AppSpec = AppSpec {
    names: &["Claude.app"],
    identifier: "com.anthropic.claudefordesktop",
    team: "Q6L2SF6YDW",
    local_resign: true,
};

pub fn publisher(details: &str, spec: &AppSpec) -> Result<Publisher> {
    let lines: Vec<_> = details.lines().collect();
    ensure!(
        lines.contains(&format!("Identifier={}", spec.identifier).as_str()),
        "CLAUDEX_UNEXPECTED_PUBLISHER: unexpected application identifier."
    );
    if lines.contains(&format!("TeamIdentifier={}", spec.team).as_str()) {
        return Ok(Publisher::Vendor);
    }
    ensure!(
        spec.local_resign
            && lines.contains(&"Signature=adhoc")
            && lines.contains(&"TeamIdentifier=not set"),
        "CLAUDEX_UNEXPECTED_PUBLISHER: unexpected application publisher."
    );
    Ok(Publisher::Local)
}
pub async fn verify(path: &Path, spec: &AppSpec, runner: &dyn Runner) -> Result<Publisher> {
    platform::directory(path, false, true)?;
    let identity = crate::signature_cache::bundle_identity(path)?;
    ensure!(
        identity.is_some(),
        "Application signature identity is incomplete."
    );
    checked(
        runner,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", &path.to_string_lossy()],
        ),
    )
    .await?;
    let details = checked(
        runner,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["-d", "--verbose=2", &path.to_string_lossy()],
        ),
    )
    .await?;
    let signature = publisher(&details.stderr, spec)?;
    ensure!(
        identity == crate::signature_cache::bundle_identity(path)?,
        "Application changed during signature verification."
    );
    Ok(signature)
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub app: Option<PathBuf>,
    pub binary: Option<PathBuf>,
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_signature: Option<Publisher>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Providers {
    pub codex: ProviderInfo,
    pub claude: ProviderInfo,
}
pub struct DiscoveryOptions {
    pub root: PathBuf,
    pub home: PathBuf,
    pub runtime: Option<PathBuf>,
    pub applications: PathBuf,
    pub path: String,
}
pub fn native_environment(options: &DiscoveryOptions) -> BTreeMap<String, String> {
    let mut env = BTreeMap::from([
        ("HOME".into(), options.home.display().to_string()),
        (
            "LANG".into(),
            std::env::var("LANG").unwrap_or("C.UTF-8".into()),
        ),
        (
            "PATH".into(),
            format!(
                "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                options.home.join(".local/bin").display()
            ),
        ),
    ]);
    for key in ["USER", "LOGNAME", "TMPDIR"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    env
}
/// Native account status only; no credential files are copied or inspected.
pub async fn authentication(
    provider: &str,
    binary: Option<&Path>,
    options: &DiscoveryOptions,
    runner: &dyn Runner,
) -> crate::setup::Authentication {
    use crate::setup::Authentication;
    let Some(binary) = binary else {
        return Authentication {
            missing: true,
            ..Default::default()
        };
    };
    if !["codex", "claude"].contains(&provider) {
        return Authentication {
            failed: true,
            ..Default::default()
        };
    }
    let mut spec = CommandSpec::new(
        binary,
        if provider == "codex" {
            vec!["login", "status"]
        } else {
            vec!["auth", "status", "--json"]
        },
    );
    spec.env = native_environment(options);
    let Ok(out) = runner.run(spec).await else {
        return Authentication {
            failed: true,
            ..Default::default()
        };
    };
    if provider == "codex" {
        let message = format!("{}\n{}", out.stdout, out.stderr).to_ascii_lowercase();
        if out.code == 0 {
            return Authentication {
                ready: message.contains("logged in using chatgpt"),
                ..Default::default()
            };
        }
        return Authentication {
            failed: !message.contains("not logged in"),
            ..Default::default()
        };
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&out.stdout) else {
        return Authentication {
            failed: true,
            ..Default::default()
        };
    };
    if value["loggedIn"] == false {
        return Authentication::default();
    }
    Authentication {
        ready: out.code == 0
            && value["loggedIn"] == true
            && value["authMethod"] == "claude.ai"
            && value["apiProvider"] == "firstParty",
        failed: out.code != 0,
        ..Default::default()
    }
}
/// Starts only the explicit official account flow. Native output may contain
/// auth URLs, so failure text remains content-free.
pub async fn login(
    provider: &str,
    binary: &Path,
    options: &DiscoveryOptions,
    runner: &dyn Runner,
) -> Result<()> {
    ensure!(
        ["codex", "claude"].contains(&provider),
        "Unknown account provider."
    );
    platform::absolute(binary)?;
    let mut spec = CommandSpec::new(
        binary,
        if provider == "codex" {
            vec!["login"]
        } else {
            vec!["auth", "login", "--claudeai"]
        },
    );
    spec.env = native_environment(options);
    spec.timeout = std::time::Duration::from_secs(600);
    spec.max_bytes = 65536;
    ensure!(
        runner.run(spec).await.is_ok_and(|out| out.code == 0),
        "Official sign-in has not completed. Finish it in the browser, then retry."
    );
    Ok(())
}

async fn find(
    home: &Path,
    applications: &Path,
    spec: &AppSpec,
    runner: &dyn Runner,
    cache: &mut crate::signature_cache::SignatureCache,
    now: u64,
) -> Result<ProviderInfo> {
    for directory in [home.join("Applications"), applications.into()] {
        for name in spec.names {
            let path = directory.join(name);
            match std::fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
                Ok(_) => {}
            }
            platform::directory(&path, false, true)?;
            let identity = crate::signature_cache::bundle_identity(&path)?;
            let reused = cache.lookup(&path, spec, identity.as_deref(), now);
            let verified = if let Some(signature) = reused {
                Ok(signature)
            } else {
                verify(&path, spec, runner).await
            };
            match verified {
                Ok(signature) => {
                    if reused.is_none() {
                        cache.record(&path, spec, signature, identity.as_deref(), now)?;
                    }
                    return Ok(ProviderInfo {
                        app: Some(path),
                        app_signature: (signature == Publisher::Local).then_some(signature),
                        ..Default::default()
                    });
                }
                Err(e) if e.to_string().starts_with("CLAUDEX_UNEXPECTED_PUBLISHER") => {
                    return Ok(ProviderInfo {
                        app_issue: Some(e.to_string()),
                        ..Default::default()
                    });
                }
                Err(e) => return Err(e),
            }
        }
    }
    Ok(ProviderInfo::default())
}
async fn version(
    binary: &Path,
    options: &DiscoveryOptions,
    runner: &dyn Runner,
) -> Result<Option<String>> {
    if platform::absolute(binary).is_err() {
        return Ok(None);
    }
    let Ok(metadata) = std::fs::metadata(binary) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.mode() & 0o111 == 0 {
        return Ok(None);
    }
    let mut spec = CommandSpec::new(binary, ["--version"]);
    spec.env = BTreeMap::from([
        ("HOME".into(), options.home.to_string_lossy().into()),
        ("LANG".into(), "C.UTF-8".into()),
        (
            "PATH".into(),
            options
                .runtime
                .as_ref()
                .map(|p| format!("{}:{}", p.join("bin").display(), options.path))
                .unwrap_or(options.path.clone()),
        ),
    ]);
    let Ok(reply) = runner.run(spec).await else {
        return Ok(None);
    };
    Ok((reply.code == 0)
        .then(|| reply.stdout.trim().chars().take(128).collect::<String>())
        .filter(|v| !v.is_empty()))
}
async fn select(
    candidates: Vec<PathBuf>,
    command: &str,
    options: &DiscoveryOptions,
    runner: &dyn Runner,
) -> Result<(Option<PathBuf>, Option<String>)> {
    for path in candidates.into_iter().chain(
        options
            .path
            .split(':')
            .filter(|v| v.starts_with('/'))
            .map(|v| Path::new(v).join(command)),
    ) {
        if let Some(version) = version(&path, options, runner).await? {
            return Ok((Some(path), Some(version)));
        }
    }
    Ok((None, None))
}
pub async fn discover(options: &DiscoveryOptions, runner: &dyn Runner) -> Result<Providers> {
    discover_cached(options, runner, false, false, 0).await
}
/// Periodic inspection alone may reuse the bounded publisher cache. Setup and
/// sign-in pass `reuse=false`; read-only inspection always passes `persist=false`.
pub async fn discover_cached(
    options: &DiscoveryOptions,
    runner: &dyn Runner,
    reuse: bool,
    persist: bool,
    now: u64,
) -> Result<Providers> {
    platform::absolute(&options.home)?;
    let mut cache =
        crate::signature_cache::SignatureCache::open(options.root.clone(), reuse, persist);
    let mut codex = find(
        &options.home,
        &options.applications,
        &CODEX,
        runner,
        &mut cache,
        now,
    )
    .await?;
    let mut claude = find(
        &options.home,
        &options.applications,
        &CLAUDE,
        runner,
        &mut cache,
        now,
    )
    .await?;
    // This is a disposable optimization, never a prerequisite for inspection.
    let _ = cache.save();
    let mut candidates = vec![];
    if let Some(app) = &codex.app {
        let packaged = app.join("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
        let flat = app.join("Contents/Resources/codex");
        let candidate = if packaged.exists() { packaged } else { flat };
        if candidate.exists() {
            // Parent-chain checks in the native launcher remain mandatory.
            let actual = std::fs::canonicalize(&candidate)
                .context("Bundled Codex target is not canonical.")?;
            checked(
                runner,
                CommandSpec::new(
                    "/usr/bin/codesign",
                    ["--verify", "--strict", &actual.to_string_lossy()],
                ),
            )
            .await?;
            let details = checked(
                runner,
                CommandSpec::new(
                    "/usr/bin/codesign",
                    ["-d", "--verbose=2", &actual.to_string_lossy()],
                ),
            )
            .await?;
            publisher(
                &details.stderr,
                &AppSpec {
                    names: &[],
                    identifier: "codex",
                    team: CODEX.team,
                    local_resign: false,
                },
            )?;
            candidates.push(candidate);
        }
    }
    candidates.push(
        options
            .root
            .join("providers/codex-cli/node_modules/.bin/codex"),
    );
    (codex.binary, codex.version) = select(candidates, "codex", options, runner).await?;
    (claude.binary, claude.version) = select(
        vec![
            options.home.join(".local/bin/claude"),
            options
                .root
                .join("providers/claude-cli/node_modules/.bin/claude"),
        ],
        "claude",
        options,
        runner,
    )
    .await?;
    Ok(Providers { codex, claude })
}

pub const CLAUDE_CLI_VERSION: &str = "2.1.283";
pub const CODEX_CLI_VERSION: &str = "0.158.0-alpha.2.1";
fn arch() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Ok("arm64"),
        "x86_64" => Ok("x64"),
        _ => anyhow::bail!("Official native CLI bootstrap supports macOS arm64 and x64."),
    }
}
fn rename_new(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
        let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
        ensure!(
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) }
                == 0,
            "Private CLI publication refused; existing directories and the verified candidate were preserved: {}",
            std::io::Error::last_os_error()
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, destination);
        anyhow::bail!("Private native CLI publication requires macOS.");
    }
    std::fs::File::open(destination.parent().context("Missing provider parent.")?)?.sync_all()?;
    Ok(())
}
/// Retain an unusable owned prefix as a whole. No credential, package, local
/// configuration or former version inside it is interpreted or removed.
fn publish_cli(
    candidate: &Path,
    prefix: &Path,
    previous: Option<&platform::Identity>,
) -> Result<Option<PathBuf>> {
    platform::directory(candidate, true, false)?;
    let backup = if let Some(previous) = previous {
        platform::directory(prefix, false, false)?;
        ensure!(
            *previous == platform::Identity::of(&std::fs::symlink_metadata(prefix)?),
            "Private CLI prefix changed during installation; the verified candidate was preserved."
        );
        let backup = prefix.with_file_name(format!(
            ".{}-preserved-{}",
            prefix.file_name().unwrap().to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        rename_new(prefix, &backup)?;
        Some(backup)
    } else {
        ensure!(
            !crate::status_app::exists(prefix)?,
            "Another native CLI installation appeared; the verified candidate was preserved."
        );
        None
    };
    rename_new(candidate, prefix)?;
    Ok(backup)
}
async fn install_cli(name: &str, options: &DiscoveryOptions, run: &dyn Runner) -> Result<()> {
    ensure!(
        cfg!(target_os = "macos"),
        "Official native CLI bootstrap requires macOS."
    );
    platform::directory(&options.root, true, false)?;
    let providers = options.root.join("providers");
    platform::create_private(&providers)?;
    let _lock = claudex_core::storage::FileLock::acquire(
        providers.join(format!("{name}-install.lock")),
        true,
    )?;
    let prefix = providers.join(format!("{name}-cli"));
    let previous = if crate::status_app::exists(&prefix)? {
        platform::directory(&prefix, false, false)?;
        let command = prefix.join("node_modules/.bin").join(name);
        if self::version(&command, options, run).await?.is_some() {
            return Ok(());
        }
        Some(platform::Identity::of(&std::fs::symlink_metadata(&prefix)?))
    } else {
        None
    };
    let arch = arch()?;
    let (wrapper, version) = if name == "codex" {
        ("@openai/codex", CODEX_CLI_VERSION)
    } else {
        ("@anthropic-ai/claude-code", CLAUDE_CLI_VERSION)
    };
    let metadata = crate::package::metadata(wrapper, version, None, &options.home, run).await?;
    let key = if name == "codex" {
        format!("@openai/codex-darwin-{arch}")
    } else {
        format!("@anthropic-ai/claude-code-darwin-{arch}")
    };
    let reference = metadata.value["optionalDependencies"][&key]
        .as_str()
        .context("Pinned official CLI has no matching macOS native package.")?;
    let (native_name, native_version) = if let Some(alias) = reference.strip_prefix("npm:") {
        let (name, version) = alias
            .rsplit_once('@')
            .context("Invalid exact native package alias.")?;
        ensure!(
            name == "@openai/codex" && version == format!("{CODEX_CLI_VERSION}-darwin-{arch}"),
            "Official Codex package alias does not match its pinned macOS release."
        );
        (name.to_string(), version.to_string())
    } else {
        ensure!(
            reference == version,
            "Official native package dependency is not pinned to the selected release."
        );
        (key, reference.to_string())
    };
    let native =
        crate::package::metadata(&native_name, &native_version, None, &options.home, run).await?;
    ensure!(
        native.value["os"] == serde_json::json!(["darwin"])
            && native.value["cpu"] == serde_json::json!([arch]),
        "Official CLI native metadata has a different operating system or architecture."
    );
    let candidate = providers.join(format!(".{name}-cli-{}", uuid::Uuid::new_v4()));
    platform::create_private(&candidate)?;
    crate::package::install_package(&native, &candidate, &options.home, run).await?;
    let payload = candidate.join("payload");
    let candidates: Vec<PathBuf> = if name == "claude" {
        vec!["claude".into()]
    } else {
        let triple = if arch == "arm64" {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        vec![
            PathBuf::from(format!("vendor/{triple}/bin/codex")),
            PathBuf::from(format!("vendor/{triple}/codex/codex")),
            "codex".into(),
        ]
    };
    let found: Vec<_> = candidates
        .into_iter()
        .filter(|p| payload.join(p).exists())
        .collect();
    ensure!(
        found.len() == 1,
        "Official native package executable is missing or ambiguous."
    );
    let executable = payload.join(&found[0]);
    platform::safe_bytes(&executable, 512 * 1024 * 1024, true, false)?;
    use std::os::unix::fs::{DirBuilderExt, symlink};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(candidate.join("node_modules/.bin"))?;
    symlink(
        Path::new("../../payload").join(&found[0]),
        candidate.join("node_modules/.bin").join(name),
    )?;
    ensure!(
        self::version(&executable, options, run).await?.is_some(),
        "Official native CLI package did not provide a working binary."
    );
    platform::publish(
        &candidate.join("wrapper-source.json"),
        claudex_core::json::stringify(&metadata.value)?.as_bytes(),
        0o600,
    )?;
    if previous.is_some() {
        ensure!(
            self::version(&prefix.join("node_modules/.bin").join(name), options, run)
                .await?
                .is_none(),
            "The existing private CLI became usable; its prefix and the verified candidate were preserved."
        );
    }
    publish_cli(&candidate, &prefix, previous.as_ref())?;
    Ok(())
}
/// Setup may fill missing CLI components, never desktop bundles or accounts.
pub async fn ensure(
    options: &DiscoveryOptions,
    runner: &dyn Runner,
    now: u64,
) -> Result<Providers> {
    let mut found = discover_cached(options, runner, false, true, now).await?;
    if found.codex.app.is_none() || found.claude.app.is_none() {
        for (name, info) in [("codex", &mut found.codex), ("claude", &mut found.claude)] {
            if info.app.is_none() {
                info.issue=Some(info.app_issue.clone().unwrap_or_else(||format!("{} Desktop app is required; install and sign in to the official app before setup.",if name=="codex"{"ChatGPT/Codex"}else{"Claude"})));
            }
        }
        return Ok(found);
    }
    if found.codex.binary.is_some() && found.claude.binary.is_some() {
        return Ok(found);
    }
    let mut issues = BTreeMap::new();
    for (name, missing) in [
        ("codex", found.codex.binary.is_none()),
        ("claude", found.claude.binary.is_none()),
    ] {
        if missing {
            if let Err(e) = install_cli(name, options, runner).await {
                issues.insert(name, format!("CLI installation failed: {e}"));
            }
        }
    }
    let mut found = discover_cached(options, runner, false, true, now).await?;
    found.codex.issue = issues.remove("codex");
    found.claude.issue = issues.remove("claude");
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_local_is_explicit_but_codex_stays_vendor_only() {
        let s =
            "Identifier=com.anthropic.claudefordesktop\nSignature=adhoc\nTeamIdentifier=not set\n";
        assert_eq!(publisher(s, &CLAUDE).unwrap(), Publisher::Local);
        assert!(publisher(&s.replace(CLAUDE.identifier, CODEX.identifier), &CODEX).is_err());
        assert!(
            publisher(
                &s.replace("Signature=adhoc", "Signature=Developer ID"),
                &CLAUDE
            )
            .is_err()
        );
        assert_eq!(
            publisher(
                "Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n",
                &CODEX
            )
            .unwrap(),
            Publisher::Vendor
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn unusable_owned_prefix_is_preserved_and_foreign_replacements_refuse() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir()?;
        let root = std::fs::canonicalize(temp.path())?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        let prefix = root.join("claude-cli");
        let candidate = root.join("candidate");
        platform::create_private(&prefix)?;
        platform::create_private(&candidate)?;
        platform::publish(&prefix.join("existing-user-config"), b"retained", 0o600)?;
        platform::publish(&candidate.join("native-binary"), b"new", 0o700)?;
        let identity = platform::Identity::of(&std::fs::symlink_metadata(&prefix)?);
        let backup = publish_cli(&candidate, &prefix, Some(&identity))?.unwrap();
        assert_eq!(
            std::fs::read(backup.join("existing-user-config"))?,
            b"retained"
        );
        assert_eq!(std::fs::read(prefix.join("native-binary"))?, b"new");
        let candidate = root.join("next");
        platform::create_private(&candidate)?;
        let identity = platform::Identity::of(&std::fs::symlink_metadata(&prefix)?);
        platform::publish(&prefix.join("changed"), b"another owner", 0o600)?;
        assert!(publish_cli(&candidate, &prefix, Some(&identity)).is_err());
        assert!(candidate.is_dir());
        assert!(prefix.join("changed").is_file());
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&prefix, &alias)?;
        assert!(publish_cli(&candidate, &alias, Some(&identity)).is_err());
        Ok(())
    }
    #[tokio::test]
    #[ignore = "Downloads pinned official native packages into an isolated temporary home; no inference or installed CLI changes."]
    async fn official_native_cli_packages_bootstrap_without_node() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let base = std::fs::canonicalize(temporary.path())?;
        let root = base.join("state");
        let home = base.join("home");
        platform::create_private(&root)?;
        platform::create_private(&home)?;
        let options = DiscoveryOptions {
            root: root.clone(),
            home,
            runtime: None,
            applications: base.join("Applications"),
            path: "/usr/bin:/bin".into(),
        };
        for (name, pinned) in [("claude", CLAUDE_CLI_VERSION), ("codex", CODEX_CLI_VERSION)] {
            install_cli(name, &options, &platform::SystemRunner).await?;
            let binary = root.join(format!("providers/{name}-cli/node_modules/.bin/{name}"));
            let actual = version(&binary, &options, &platform::SystemRunner)
                .await?
                .context("Installed isolated native version is unavailable.")?;
            ensure!(
                actual.contains(pinned),
                "Isolated official native version differs from its pinned package."
            );
            let prefix = root.join(format!("providers/{name}-cli"));
            let before = platform::Identity::of(&std::fs::symlink_metadata(&prefix)?);
            install_cli(name, &options, &platform::SystemRunner).await?;
            assert_eq!(
                before,
                platform::Identity::of(&std::fs::symlink_metadata(&prefix)?)
            );
            println!("{name}: pinned native package/version and idempotent installation passed");
        }
        Ok(())
    }
    #[tokio::test]
    async fn native_auth_keeps_account_namespaces_and_sanitizes_login_failures() -> Result<()> {
        use crate::platform::CommandOutput;
        use async_trait::async_trait;
        struct Native;
        #[async_trait]
        impl Runner for Native {
            async fn run(&self, spec: CommandSpec) -> Result<CommandOutput> {
                assert_eq!(spec.env.get("HOME").unwrap(), "/private/home");
                assert!(!spec.env.contains_key("ANTHROPIC_API_KEY"));
                if spec.args == ["auth", "status", "--json"] {
                    Ok(CommandOutput{stdout:r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}"#.into(),..Default::default()})
                } else if spec.args == ["login", "status"] {
                    Ok(CommandOutput {
                        stdout: "Logged in using ChatGPT".into(),
                        ..Default::default()
                    })
                } else {
                    Ok(CommandOutput {
                        code: 1,
                        stderr: "https://private-auth.example/token?secret=fixture".into(),
                        ..Default::default()
                    })
                }
            }
        }
        let options = DiscoveryOptions {
            root: "/private/state".into(),
            home: "/private/home".into(),
            runtime: None,
            applications: "/Applications".into(),
            path: "/usr/bin:/bin".into(),
        };
        assert!(
            authentication(
                "claude",
                Some(Path::new("/private/claude")),
                &options,
                &Native
            )
            .await
            .ready
        );
        assert!(
            authentication(
                "codex",
                Some(Path::new("/private/codex")),
                &options,
                &Native
            )
            .await
            .ready
        );
        assert!(
            authentication("codex", None, &options, &Native)
                .await
                .missing
        );
        let e = login("claude", Path::new("/private/claude"), &options, &Native)
            .await
            .unwrap_err()
            .to_string();
        assert!(!e.contains("secret"));
        assert!(e.contains("Official sign-in"));
        Ok(())
    }
}
