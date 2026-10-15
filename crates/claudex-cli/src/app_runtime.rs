//! Composition of the graphical setup engine with the native runtime domains.
use crate::{args, desktop, service};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use claudex_app::{
    mod_install::{InstallOptions, Installer},
    mod_runtime,
    platform::{self, Runner, SystemRunner},
    providers::{self, DiscoveryOptions, Providers},
    setup::{AppRuntime, Authentication},
};
use claudex_core::{storage, version::VersionPolicy};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub const HELP: &str = "Claudex native application setup

  claudex app inspect [--read-only]   Inspect prerequisites without installing
  claudex app setup                  Configure the bundled application
  claudex app startup                Resume the installed application
  claudex app login --provider codex|claude
  claudex app mod-setup [--receiver enabled|disabled] [--enable]
  claudex app stop|stop-status        Drain owned services or inspect shutdown
  claudex app models                 Read model and permission preferences
    [--codex-model MODEL --claude-model MODEL]
    [--codex-effort EFFORT --claude-effort EFFORT]
    [--default-permission read-only|workspace-write|full-access]
  claudex app warm-settings          Read or update cache-warming preferences
    [--default-limit LIMIT] [--ttl-mode session|default|remember] [--ttl 5m|1h]
    [--on-message continue|stop] [--compact-after on|off]
  claudex app warm-stop --provider codex|claude --session ID --cwd PATH
  claudex app resolve-uncertain      Resolve work after the user's attestation
  claudex app build --help           Show signed-bundle build options

Options: --root PATH, --runtime-directory PATH, --read-only.
Source builds outside the checkout: --source-root /absolute/claudex-checkout.
Inspection does not install components or start model inference.
";

pub struct NativeApp {
    pub root: PathBuf,
    pub home: PathBuf,
    pub executable: PathBuf,
    pub engine: PathBuf,
    pub app: Option<PathBuf>,
    pub read_only: bool,
    pub discovery: DiscoveryOptions,
    pub runner: Arc<dyn Runner>,
}
impl NativeApp {
    pub fn from_args(raw: &[String]) -> Result<Self> {
        let options = platform::Options::parse(raw)?;
        let home = args::home()?;
        let root = args::absolute(&options.path("root").unwrap_or_else(|| {
            std::env::var_os("CLAUDEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share/claudex"))
        }))?;
        let executable = std::env::current_exe()?;
        let resources =
            crate::resources::locate(&executable, options.path("source-root").as_deref())?;
        let engine = resources.engine;
        let app = resources.app;
        let discovery = DiscoveryOptions {
            root: root.clone(),
            home: home.clone(),
            runtime: options.path("runtime-directory"),
            applications: "/Applications".into(),
            path: std::env::var("PATH").unwrap_or_default(),
        };
        Ok(Self {
            root,
            home,
            executable,
            engine,
            app,
            read_only: options.flag("read-only"),
            discovery,
            runner: Arc::new(SystemRunner),
        })
    }
    fn writable(&self) -> Result<()> {
        ensure!(
            !self.read_only,
            "Read-only setup cannot mutate native services or configuration."
        );
        Ok(())
    }
    fn environment_path(&self) -> String {
        format!(
            "{}:{}:/usr/bin:/bin:/usr/sbin:/sbin",
            self.executable.parent().unwrap().display(),
            self.home.join(".local/bin").display()
        )
    }
    fn service_options(&self) -> service::ServiceOptions {
        service::ServiceOptions {
            root: self.root.clone(),
            cli: self.executable.clone(),
            home: self.home.clone(),
            environment_path: self.environment_path(),
        }
    }
    fn work_config(&self, providers: Option<&Providers>) -> claudex_work::Config {
        let mut config = claudex_work::Config {
            executable: self.executable.clone(),
            allow_write: true,
            default_permission: claudex_work::Permission::WorkspaceWrite,
            environment_path: Some(self.environment_path()),
            ..Default::default()
        };
        if let Some(providers) = providers {
            if let Some(binary) = &providers.codex.binary {
                config.codex_binary = binary.clone();
            }
            if let Some(binary) = &providers.claude.binary {
                config.claude_binary = binary.clone();
            }
        }
        config
    }
    fn config(&self) -> Result<Option<Value>> {
        platform::optional_json(&self.root.join("config.json"), 1024 * 1024, true)
    }
    fn hooks(&self, config: &Value) -> Result<Value> {
        claudex_sync::hooks::install(&claudex_sync::hooks::Options {
            root: self.root.clone(),
            executable: self.executable.clone(),
            codex_home: config["codexHome"]
                .as_str()
                .context("Missing Codex home.")?
                .into(),
            claude_home: config["claudeHome"]
                .as_str()
                .context("Missing Claude home.")?
                .into(),
        })
    }
    fn configure_folder_presentation(&self) -> Result<Value> {
        self.writable()?;
        crate::renderer_setup::configure(&self.root, |fence| {
            Ok(claudex_app::frontend_install::ensure(&self.root, &self.home, true, fence)?.summary)
        })
    }
}

/// Preserve existing native roots, opaque settings and durable history contracts.
pub fn synchronization_config(
    previous: Option<&Value>,
    providers: &Providers,
    home: &Path,
) -> Result<Value> {
    if let Some(previous) = previous {
        ensure!(
            previous.is_object()
                && previous["version"] == 1
                && previous
                    .get("mode")
                    .is_none_or(|v| v == "legacy" || v == "desktop"),
            "Unsupported existing synchronization configuration."
        );
    }
    let mut next = previous.cloned().unwrap_or_else(|| {
        json!({
            "version":1,"since":storage::now_ms(),"codexHome":home.join(".codex"),
            "claudeHome":home.join(".claude"),
        })
    });
    let policy = VersionPolicy::parse(next["versionPolicy"].as_str().or(Some("warn")))?;
    next["mode"] = json!("desktop");
    next["allProjects"] = json!(true);
    next["projects"] = json!([]);
    next["contextMode"] = next.get("contextMode").cloned().unwrap_or(json!("archive"));
    next["versionPolicy"] = serde_json::to_value(policy)?;
    next["binary"] = json!(
        providers
            .codex
            .binary
            .as_ref()
            .context("Codex CLI is missing.")?
    );
    next["claudeBinary"] = json!(
        providers
            .claude
            .binary
            .as_ref()
            .context("Claude CLI is missing.")?
    );
    for key in ["codexHome", "claudeHome"] {
        platform::absolute(Path::new(
            next[key].as_str().context("Native home must be a path.")?,
        ))?;
    }
    Ok(next)
}

#[async_trait]
impl AppRuntime for NativeApp {
    async fn providers(&self, install: bool, reuse_signatures: bool) -> Result<Providers> {
        if install {
            self.writable()?;
            providers::ensure(
                &self.discovery,
                self.runner.as_ref(),
                storage::now_ms() as u64,
            )
            .await
        } else {
            providers::discover_cached(
                &self.discovery,
                self.runner.as_ref(),
                reuse_signatures,
                !self.read_only,
                storage::now_ms() as u64,
            )
            .await
        }
    }
    async fn authentication(&self, provider: &str, binary: Option<&Path>) -> Authentication {
        providers::authentication(provider, binary, &self.discovery, self.runner.as_ref()).await
    }
    async fn mod_status(
        &self,
        providers: &Providers,
        install: bool,
        receiver: Option<bool>,
        enable: bool,
    ) -> Result<Value> {
        if install {
            self.writable()?;
        }
        let options = mod_runtime::Options {
            root: &self.root,
            home: &self.home,
            claude_binary: providers.claude.binary.as_deref(),
            arch: None,
        };
        let runtime = if install {
            mod_runtime::ensure(&options, self.runner.as_ref()).await
        } else {
            mod_runtime::find(&options, self.runner.as_ref()).await
        };
        let installation = if let Some(manager) = runtime.binary() {
            let installer = Installer {
                options: InstallOptions {
                    root: self.root.clone(),
                    home: self.home.clone(),
                    engine: self.engine.clone(),
                    executable: self.executable.clone(),
                    manager: manager.into(),
                    read_only: self.read_only,
                    receiver,
                    enable,
                },
                runner: self.runner.as_ref(),
            };
            if install {
                installer.ensure().await?
            } else {
                installer.inspect().await?["result"].clone()
            }
        } else {
            json!({"state":match runtime {mod_runtime::Runtime::Blocked{..}=>"blocked",_=>"missing"},
                "reason":"management-runtime-unavailable","installedVersion":null,"loaded":null})
        };
        Ok(json!({"runtime":runtime,"installation":installation}))
    }
    async fn broker_request(&self, method: &str, params: Value) -> Result<Value> {
        if self.read_only {
            ensure!(
                [
                    "list",
                    "models",
                    "mod_wake_status",
                    "cache_warm_settings",
                    "cache_warm_list",
                    "codex_cache_warm_list"
                ]
                .contains(&method)
                    && (!["models", "cache_warm_settings"].contains(&method)
                        || params.as_object().is_some_and(|v| v.is_empty())),
                "Read-only setup cannot mutate the collaboration broker."
            );
        }
        let root = self.root.join("collaboration");
        let token = claudex_work::cli::controller_token(&root)?;
        tokio::time::timeout(
            Duration::from_secs(20),
            claudex_work::transport::call(
                &root,
                claudex_work::Provider::Claude,
                &token,
                method,
                params,
            ),
        )
        .await
        .context("Broker response was not confirmed; do not replay uncertain work.")?
    }
    async fn service(&self, provider: &str, action: &str) -> Result<Value> {
        if action != "status" {
            self.writable()?;
        }
        if provider == "collaboration" {
            return claudex_work::install::control(
                action,
                &self.root.join("collaboration"),
                &self.home,
                &self.work_config(None),
            )
            .await;
        }
        ensure!(
            provider == "synchronization",
            "Unknown application service."
        );
        let options = self.service_options();
        // A fresh app has nothing to stop, and no owned definition to remove.
        if action == "stop" {
            let status = service::control(
                "status",
                &options,
                &service::NativeCommands,
                &service::NativeProcesses,
            )
            .await?;
            if status["loaded"] == false {
                return Ok(status);
            }
        }
        service::control(
            action,
            &options,
            &service::NativeCommands,
            &service::NativeProcesses,
        )
        .await
    }
    async fn ownership(&self) -> Result<Value> {
        Ok(serde_json::to_value(service::inspect_start(
            &self.root,
            true,
            &service::NativeProcesses,
            storage::now_ms(),
        )?)?)
    }
    async fn install_interface(&self) -> Result<()> {
        self.writable()?;
        let result = async {
            claudex_app::login::install(
                &self.root,
                &self.home,
                self.app
                    .as_deref()
                    .context("The unified application must run from its packaged bundle.")?,
                self.runner.as_ref(),
            )
            .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        platform::write_json(
            &self.root.join("app-interface-status.json"),
            &json!({
                "version":1,"updatedAt":storage::now_ms(),
                "error":if result.is_ok(){Value::Null}else{json!("Application login integration could not be verified.")},
            }),
        )?;
        result
    }
    async fn install_collaboration(&self, providers: &Providers) -> Result<()> {
        self.writable()?;
        claudex_work::install::install(
            &self.root.join("collaboration"),
            &self.home,
            &self.work_config(Some(providers)),
        )
        .await?;
        claudex_work::install::desktop_wake(
            &self.root.join("collaboration"),
            &self.home,
            &self.executable,
        )?;
        let path = self.root.join("config.json");
        let before = match crate::renderer_setup::private_snapshot(&path, 1024 * 1024) {
            Ok(value) => Some(value),
            Err(error) if storage::is_not_found(&error) => None,
            Err(error) => return Err(error),
        };
        let config = before
            .as_ref()
            .map(|value| serde_json::from_slice::<Value>(&value.bytes))
            .transpose()?
            .unwrap_or(Value::Null);
        let folders = config["folderProjection"]["enabled"] != false;
        let fence = || -> Result<()> {
            match &before {
                Some(value) => ensure!(
                    crate::renderer_setup::private_snapshot(&path, 1024 * 1024)?.identity
                        == value.identity,
                    "Synchronization configuration changed during renderer setup; existing settings were preserved."
                ),
                None => ensure!(
                    matches!(std::fs::symlink_metadata(&path),Err(e) if e.kind()==std::io::ErrorKind::NotFound),
                    "Synchronization configuration changed during renderer setup; existing settings were preserved."
                ),
            }
            Ok(())
        };
        let pass = claudex_app::frontend_install::ensure(&self.root, &self.home, folders, &fence)?;
        ensure!(
            ["chatWake", "ownerWake", "commands"]
                .into_iter()
                .all(|adapter| pass.summary["adapters"][adapter]["status"] == "installed"),
            "Some renderer adapters could not be verified. The watcher will revalidate when native cache resources change."
        );
        Ok(())
    }
    async fn configure_synchronization(&self, providers: &Providers) -> Result<()> {
        self.writable()?;
        let original = self.config()?;
        let next = synchronization_config(original.as_ref(), providers, &self.home)?;
        let launcher = desktop::installed_launcher(&self.root)?;
        let installed =
            platform::optional_json(&self.root.join("service-install.json"), 1024 * 1024, true)?;
        if original.as_ref() == Some(&next)
            && launcher
                .as_ref()
                .is_some_and(|v| v.engine.as_ref() == Some(&self.executable))
            && installed
                .as_ref()
                .is_some_and(|v| v["cli"] == json!(self.executable))
        {
            self.hooks(&next)?;
            if next["folderProjection"]["enabled"] == true {
                self.configure_folder_presentation()?;
            }
            return Ok(());
        }
        ensure!(
            service::inspect_start(
                &self.root,
                true,
                &service::NativeProcesses,
                storage::now_ms()
            )?
            .allowed,
            "An existing synchronization owner is active. Its settings and native work were preserved."
        );
        if original.as_ref().is_none_or(|v| v["mode"] != "desktop") {
            let previous =
                platform::optional_json(&self.root.join("state.json"), 32 * 1024 * 1024, true)?;
            ensure!(
                previous
                    .as_ref()
                    .is_none_or(|v| v.get("pending").is_none_or(Value::is_null)
                        && v["records"].as_array().is_some_and(Vec::is_empty)),
                "Existing CLI-only history requires an explicit migration; it was preserved."
            );
        }
        for key in ["codexHome", "claudeHome"] {
            let path = Path::new(next[key].as_str().unwrap());
            if !path.exists() {
                storage::private_directory(path)?;
            }
            ensure!(
                std::fs::canonicalize(path)? == path,
                "Native home is not canonical."
            );
        }
        desktop::install(
            &desktop::InstallOptions {
                root: self.root.clone(),
                engine: self.executable.clone(),
                node: None,
                binary: providers
                    .codex
                    .binary
                    .clone()
                    .context("Codex CLI is missing.")?,
            },
            &service::NativeCommands,
            &claudex_core::codex_layout::OpenAiVerifier,
        )
        .await?;
        ensure!(
            self.config()? == original,
            "Synchronization configuration changed during setup; it was preserved."
        );
        platform::write_json(&self.root.join("config.json"), &next)?;
        self.hooks(&next)?;
        self.configure_folder_presentation()?;
        service::install(
            &self.service_options(),
            &service::NativeCommands,
            &service::NativeProcesses,
        )
        .await?;
        Ok(())
    }
    async fn login(&self, provider: &str, binary: &Path) -> Result<()> {
        self.writable()?;
        providers::login(provider, binary, &self.discovery, self.runner.as_ref()).await
    }
}

pub async fn run(args: &[String]) -> Result<()> {
    if crate::commands::command_index(args).is_some_and(|i| args[i] == "build") {
        let mut domain = args.to_vec();
        let index = crate::commands::command_index(args).unwrap();
        let command = domain.remove(index);
        domain.insert(0, command);
        return claudex_app::run(&domain).await;
    }
    let args = normalized_args(args)?;
    let args = args.as_slice();
    let options = platform::Options::parse(args)?;
    if options.flag("help") || options.action() == "help" {
        print!("{HELP}");
        return Ok(());
    }
    let runtime = NativeApp::from_args(args)?;
    match claudex_app::setup::dispatch(args, &runtime).await {
        Ok(value) => crate::commands::output(&value),
        Err(error) => {
            let options = platform::Options::parse(args)?;
            if [
                "models",
                "warm-settings",
                "warm-stop",
                "stop",
                "stop-status",
                "resolve-uncertain",
            ]
            .contains(&options.action())
            {
                crate::commands::output(&json!({"error":display_failure(&error)}))?;
                Err(error)
            } else {
                crate::commands::output(
                    &json!({"version":1,"phase":"blocked","allProjects":true,"allowWrite":true,
                    "components":[{"id":"setup","label":"Application setup","state":"blocked",
                    "detail":"Setup could not be verified. Existing native work and account data were preserved.","action":"retry"}]}),
                )
            }
        }
    }
}

fn display_failure(error: &anyhow::Error) -> String {
    error
        .to_string()
        .lines()
        .next()
        .unwrap_or("Setup could not be verified.")
        .chars()
        .take(400)
        .collect()
}

fn normalized_args(raw: &[String]) -> Result<Vec<String>> {
    let options = args::Args::parse(
        raw,
        &[
            "root",
            "provider",
            "runtime-directory",
            "source-root",
            "receiver",
            "session",
            "cwd",
            "codex-model",
            "claude-model",
            "codex-effort",
            "claude-effort",
            "default-permission",
            "default-limit",
            "ttl-mode",
            "on-message",
            "compact-after",
            "ttl",
        ],
        &["read-only", "enable", "help"],
    )?;
    ensure!(
        options.positionals.len() <= 1,
        "Unexpected application argument."
    );
    let root = options.root()?;
    let mut result = options.positionals;
    for (key, values) in options.values {
        ensure!(values.len() == 1, "Duplicate application option --{key}.");
        if key != "root" {
            result.extend([format!("--{key}"), values[0].clone()]);
        }
    }
    for flag in &options.flags {
        result.push(format!("--{flag}"));
    }
    result.extend([
        "--root".into(),
        root.to_str()
            .context("Application root must be UTF-8.")?
            .into(),
    ]);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NoCommands;
    #[async_trait]
    impl Runner for NoCommands {
        async fn run(&self, _: platform::CommandSpec) -> Result<platform::CommandOutput> {
            anyhow::bail!("No native command is allowed in this isolated profile.")
        }
    }
    fn providers() -> Providers {
        let mut codex = providers::ProviderInfo::default();
        codex.binary = Some("/native/codex".into());
        let mut claude = providers::ProviderInfo::default();
        claude.binary = Some("/native/claude".into());
        Providers { codex, claude }
    }
    #[test]
    fn configuration_keeps_native_roots_and_explicit_choices() -> Result<()> {
        let original = json!({"version":1,"mode":"desktop","since":10,"codexHome":"/native/c","claudeHome":"/native/a","versionPolicy":"strict","contextMode":"inline","folderProjection":{"enabled":false},"rendererAdapters":{"enabled":false},"opaque":{"future":true}});
        let actual = synchronization_config(Some(&original), &providers(), Path::new("/home"))?;
        for key in [
            "since",
            "codexHome",
            "claudeHome",
            "versionPolicy",
            "contextMode",
            "folderProjection",
            "rendererAdapters",
            "opaque",
        ] {
            assert_eq!(actual[key], original[key]);
        }
        assert_eq!(actual["allProjects"], true);
        assert_eq!(actual["binary"], "/native/codex");
        assert!(
            synchronization_config(
                Some(&json!({"version":2})),
                &providers(),
                Path::new("/home")
            )
            .is_err()
        );
        let fresh = synchronization_config(None, &providers(), Path::new("/home"))?;
        assert_eq!(fresh["versionPolicy"], "warn");
        assert_eq!(fresh["contextMode"], "archive");
        Ok(())
    }
    #[test]
    fn app_options_preserve_values_and_normalize_only_the_root() -> Result<()> {
        let actual = normalized_args(
            &[
                "models",
                "--root=/tmp/a/../b",
                "--codex-model",
                "serve",
                "--claude-model=help",
                "--read-only",
            ]
            .map(str::to_owned),
        )?;
        let parsed = platform::Options::parse(&actual)?;
        assert_eq!(parsed.action(), "models");
        assert_eq!(parsed.path("root"), Some("/tmp/b".into()));
        assert_eq!(parsed.values["codex-model"], "serve");
        assert_eq!(parsed.values["claude-model"], "help");
        assert!(parsed.flag("read-only"));
        let help = normalized_args(&["--help".to_owned()])?;
        assert!(platform::Options::parse(&help)?.flag("help"));
        assert_eq!(
            display_failure(&anyhow::anyhow!("Choose a model.\nExtra native detail")),
            "Choose a model."
        );
        assert!(normalized_args(&["inspect", "--unknown", "x"].map(str::to_owned)).is_err());
        assert!(
            normalized_args(&["inspect", "--root", "/a", "--root", "/b"].map(str::to_owned))
                .is_err()
        );
        Ok(())
    }
    #[tokio::test]
    async fn clean_profile_read_only_inspection_uses_real_composition_without_installing()
    -> Result<()> {
        let fixture = tempfile::tempdir_in("/tmp")?;
        let base = fixture.path().canonicalize()?;
        let home = storage::private_directory(base.join("home"))?;
        let root = storage::private_directory(base.join("state"))?;
        let applications = storage::private_directory(base.join("Applications"))?;
        let runtime = NativeApp {
            root: root.clone(),
            home: home.clone(),
            executable: base.join("engine/bin/claudex"),
            engine: base.join("engine"),
            app: None,
            read_only: true,
            discovery: DiscoveryOptions {
                root: root.clone(),
                home,
                runtime: None,
                applications,
                path: String::new(),
            },
            runner: Arc::new(NoCommands),
        };
        let report = claudex_app::setup::AppSetup {
            root: root.clone(),
            read_only: true,
            runtime: &runtime,
        }
        .inspect()
        .await?;
        assert!(
            report
                .components
                .iter()
                .any(|c| c.id == "codex-cli" && c.state == claudex_app::setup::State::Missing)
        );
        assert!(
            report
                .components
                .iter()
                .any(|c| c.id == "claude-mod" && c.state == claudex_app::setup::State::Missing)
        );
        assert!(std::fs::read_dir(&root)?.next().is_none());
        assert!(runtime.providers(true, false).await.is_err());
        assert!(runtime.install_interface().await.is_err());
        assert!(runtime.install_collaboration(&providers()).await.is_err());
        assert!(
            runtime
                .configure_synchronization(&providers())
                .await
                .is_err()
        );
        assert!(runtime.service("synchronization", "start").await.is_err());
        assert!(
            runtime
                .broker_request("models", json!({"defaultPermission":"full-access"}))
                .await
                .is_err()
        );
        assert!(std::fs::read_dir(&root)?.next().is_none());
        Ok(())
    }
}
