//! Native application integration. No operation dispatches the legacy engine.
pub mod bundle;
pub mod cache;
pub mod cache_install;
pub mod codex_cache_native;
pub mod frontend_adapters;
pub mod frontend_anchors;
pub mod frontend_ast;
pub mod frontend_bindings;
pub mod frontend_folders;
pub mod frontend_graph;
pub mod frontend_install;
pub mod frontend_maintenance;
pub mod frontend_owner;
pub mod frontend_runtime;
pub mod frontend_scope;
pub mod login;
pub mod mod_bridge;
pub mod mod_inbox;
pub mod mod_install;
pub mod mod_journal;
pub mod mod_protocol;
pub mod mod_runtime;
pub mod mod_storage;
pub mod package;
pub mod platform;
pub mod providers;
pub mod setup;
pub mod signature_cache;
pub mod status_app;
pub mod warm;
pub mod warm_hook;
pub mod warm_runtime;

use anyhow::{Result, bail};
use std::path::PathBuf;

const MOD_HELP: &str = "Claudex native Mod staging (no installation or service changes)

Usage: claudex mod stage --root /absolute/claudex-root --output /new/stage-directory
  [--source-root /absolute/checkout] [--executable /absolute/claudex]
  [--native-wake | --no-native-wake] [--self-wake | --no-self-wake]

Receiver defaults are enabled; explicit --no-native-wake/--no-self-wake opt out.
The companion must be a native Rust executable. The obsolete --node option is not supported.
";

fn validate_mod_options(options: &platform::Options) -> Result<()> {
    anyhow::ensure!(
        !options.values.contains_key("node"),
        "--node is no longer supported. Use --executable /absolute/claudex for the native Rust companion."
    );
    anyhow::ensure!(
        (options.positions == ["stage"] || options.positions.is_empty() && options.flag("help"))
            && options.values.keys().all(|key| [
                "root",
                "output",
                "source-root",
                "executable",
                "native-wake",
                "no-native-wake",
                "self-wake",
                "no-self-wake",
                "help"
            ]
            .contains(&key.as_str())),
        "Invalid Mod staging arguments. Run claudex mod stage --help."
    );
    for name in ["native-wake", "self-wake"] {
        anyhow::ensure!(
            !(options.flag(name) && options.flag(&format!("no-{name}"))),
            "Conflicting --{name} and --no-{name} options."
        );
    }
    Ok(())
}

pub async fn run(args: &[String]) -> Result<()> {
    let action = args.first().map(String::as_str).unwrap_or("app");
    let options = platform::Options::parse(args.get(1..).unwrap_or_default())?;
    if action == "mod" {
        validate_mod_options(&options)?;
        if options.flag("help") {
            println!("{MOD_HELP}");
            return Ok(());
        }
    }
    if action == "build" && options.flag("help") {
        println!(
            "Usage: claudex app build --source-root /absolute/checkout --executable /absolute/claudex --output /absolute/Claudex.app --identity SIGNING_IDENTITY [--arch arm64|x86_64] [--zip /absolute/Claudex.zip]"
        );
        return Ok(());
    }
    let root = options.path("root").unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share/claudex")
    });
    let value = match action {
        "build" => {
            anyhow::ensure!(
                options.positions.is_empty()
                    && options.values.keys().all(|key| [
                        "source-root",
                        "executable",
                        "output",
                        "identity",
                        "arch",
                        "zip"
                    ]
                    .contains(&key.as_str())),
                "Invalid app build arguments. Run claudex app build --help."
            );
            let identity = options
                .values
                .get("identity")
                .cloned()
                .or_else(|| std::env::var("CLAUDEX_SIGNING_IDENTITY").ok())
                .ok_or_else(|| {
                    anyhow::anyhow!("--identity or CLAUDEX_SIGNING_IDENTITY is required.")
                })?;
            serde_json::to_value(
                bundle::build(
                    &bundle::Options {
                        source: options.required_path("source-root")?,
                        executable: options
                            .path("executable")
                            .unwrap_or(std::env::current_exe()?),
                        destination: options.required_path("output")?,
                        identity,
                        architecture: options.values.get("arch").cloned().unwrap_or_else(|| {
                            if cfg!(target_arch = "aarch64") {
                                "arm64"
                            } else {
                                "x86_64"
                            }
                            .into()
                        }),
                        zip: options.path("zip"),
                    },
                    &platform::SystemRunner,
                )
                .await?,
            )?
        }
        "mod" if options.action() == "stage" => {
            let output = options.required_path("output")?;
            let source = options
                .path("source-root")
                .unwrap_or(std::env::current_dir()?);
            let executable = options
                .path("executable")
                .unwrap_or(std::env::current_exe()?);
            mod_install::stage(
                &source,
                &output,
                &root,
                &executable,
                !options.flag("no-native-wake"),
                !options.flag("no-self-wake"),
            )?
        }
        "providers" => {
            let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
            let runner = platform::SystemRunner;
            serde_json::to_value(
                providers::discover(
                    &providers::DiscoveryOptions {
                        root,
                        home,
                        runtime: options.path("runtime-directory"),
                        applications: "/Applications".into(),
                        path: std::env::var("PATH").unwrap_or_default(),
                    },
                    &runner,
                )
                .await?,
            )?
        }
        _ => bail!("Unknown application action: {action} {}.", options.action()),
    };
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

/// Root composition injects the synchronization/service/broker domains directly.
pub async fn run_with_runtime(args: &[String], runtime: &dyn setup::AppRuntime) -> Result<()> {
    let value = setup::dispatch(args, runtime).await?;
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

#[cfg(test)]
mod command_tests {
    use super::*;

    fn options(args: &[&str]) -> platform::Options {
        platform::Options::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[tokio::test]
    async fn mod_stage_rejects_obsolete_runtime_and_unknown_arguments_before_staging() {
        for flag in ["--node", "--runtime-directory", "--engine", "--unknown"] {
            let error = run(&["mod", "stage", flag, "/obsolete/runtime"].map(str::to_owned))
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(if flag == "--node" {
                "--executable"
            } else {
                "Invalid Mod staging arguments"
            }));
        }
        assert!(validate_mod_options(&options(&["stage", "extra"])).is_err());
    }

    #[test]
    fn mod_stage_preserves_wake_defaults_and_explicit_opt_outs() {
        let defaults = options(&["stage"]);
        validate_mod_options(&defaults).unwrap();
        assert!(!defaults.flag("no-native-wake") && !defaults.flag("no-self-wake"));
        let disabled = options(&["stage", "--no-native-wake", "--no-self-wake"]);
        validate_mod_options(&disabled).unwrap();
        assert!(disabled.flag("no-native-wake") && disabled.flag("no-self-wake"));
        validate_mod_options(&options(&["stage", "--native-wake", "--self-wake"])).unwrap();
        for args in [
            vec!["stage", "--native-wake", "--no-native-wake"],
            vec!["stage", "--self-wake", "--no-self-wake"],
        ] {
            assert!(validate_mod_options(&options(&args)).is_err());
        }
    }
}
