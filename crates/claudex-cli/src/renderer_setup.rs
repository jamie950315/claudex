//! Persist graphical presentation intent independently of cache availability.
use anyhow::{Context, Result, ensure};
use claudex_app::{frontend_graph, frontend_install, platform};
use claudex_core::storage;
use serde_json::{Value, json};
use std::path::Path;

pub(crate) fn private_snapshot(path: &Path, limit: usize) -> Result<storage::StableFile> {
    let snapshot = storage::read_stable_with_limit(path, limit)?;
    ensure!(
        snapshot.identity.uid == storage::uid().to_string()
            && snapshot.identity.nlink == "1"
            && snapshot.identity.mode.parse::<u32>()? & 0o7777 == 0o600,
        "Application state must be private, owned and single-link."
    );
    Ok(snapshot)
}

#[derive(Debug)]
struct ConfigurationChanged;
impl std::fmt::Display for ConfigurationChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Synchronization configuration changed during folder setup; existing settings were preserved.")
    }
}
impl std::error::Error for ConfigurationChanged {}

fn setting(config: &mut Value, section: &str, key: &str, value: Value) -> Result<()> {
    ensure!(
        config.get(section).is_none_or(Value::is_object),
        "Unsupported {section} configuration; existing settings were preserved."
    );
    if config.get(section).is_none() {
        config[section] = json!({});
    }
    config[section][key] = value;
    Ok(())
}
fn save(root: &Path, state: &str, reason: &str) -> Result<Value> {
    let status = json!({"version":1,"state":state,"reason":reason,"updatedAt":storage::now_ms()});
    platform::write_json(&root.join("app-folder-setup-status.json"), &status)?;
    Ok(status)
}
fn failure(error: &anyhow::Error) -> (&'static str, &'static str) {
    if error
        .chain()
        .any(|cause| cause.is::<ConfigurationChanged>())
    {
        return ("refused", "configuration-changed");
    }
    let code = frontend_install::failure_code(error);
    match code {
        frontend_install::FailureCode::CacheMissing
        | frontend_install::FailureCode::CacheChanged => ("waiting", code.name()),
        frontend_install::FailureCode::Held | frontend_install::FailureCode::Stopped => {
            ("waiting", "application-stopped")
        }
        _ => ("refused", code.name()),
    }
}

/// A cache refusal is an attempt result, not permission to disable subsequent
/// watcher validation or prevent installation of the synchronization service.
pub fn configure(
    root: &Path,
    install: impl FnOnce(&dyn Fn() -> Result<()>) -> Result<Value>,
) -> Result<Value> {
    let path = root.join("config.json");
    let before = private_snapshot(&path, 1024 * 1024)?;
    let config: Value = serde_json::from_slice(&before.bytes)?;
    ensure!(
        config["version"] == 1 && config["mode"] == "desktop",
        "Folder setup requires a Desktop configuration."
    );
    let disabled = config["folderProjection"]["enabled"] == false;
    let mut next = config.clone();
    setting(
        &mut next,
        "rendererAdapters",
        "enabled",
        json!(config["rendererAdapters"]["enabled"] != false),
    )?;
    if !disabled {
        setting(&mut next, "folderProjection", "enabled", json!(true))?;
        if config.get("desktopLocalHandoff").is_none() {
            next["desktopLocalHandoff"] = json!({"enabled":true});
        }
    }
    ensure!(
        private_snapshot(&path, 1024 * 1024)?.identity == before.identity,
        ConfigurationChanged
    );
    if next != config {
        platform::write_json(&path, &next)?;
    }
    let intent = private_snapshot(&path, 1024 * 1024)?;
    ensure!(
        serde_json::from_slice::<Value>(&intent.bytes)? == next,
        ConfigurationChanged
    );
    if disabled {
        return save(root, "disabled", "disabled-by-user");
    }
    save(root, "waiting", "installation-pending")?;
    // Resume's release event, rather than a setup retry, will run the watcher.
    if claudex_sync::hooks::app_stopped(root)? {
        return save(root, "waiting", "application-stopped");
    }
    let fence = || -> Result<()> {
        ensure!(
            private_snapshot(&path, 1024 * 1024)?.identity == intent.identity,
            ConfigurationChanged
        );
        ensure!(
            !claudex_sync::hooks::app_stopped(root)?,
            "Application stopped during renderer setup."
        );
        Ok(())
    };
    let installed = (|| -> Result<&'static str> {
        let pass = install(&fence)?;
        fence()?;
        let resource = &pass["adapters"]["folders"];
        if resource["status"] != "installed" {
            let code = match resource["failure"]["code"].as_str() {
                Some("cache-entry-missing") => frontend_install::FailureCode::CacheMissing,
                Some("cache-changed") => frontend_install::FailureCode::CacheChanged,
                Some("recovery-evidence-missing") => frontend_install::FailureCode::EvidenceMissing,
                Some("required-file-missing") => frontend_install::FailureCode::RequiredFileMissing,
                Some("access-denied") => frontend_install::FailureCode::AccessDenied,
                _ => frontend_install::FailureCode::ValidationRefused,
            };
            return Err(frontend_install::Failure(code).into());
        }
        let cache = resource["cachePath"]
            .as_str()
            .context("Installed folder resource omitted its native cache identity.")?;
        let cache_path = Path::new(cache);
        platform::absolute(cache_path)?;
        ensure!(
            cache_path
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(frontend_graph::cache_filename),
            "Installed folder resource has an invalid native cache identity."
        );
        if next["folderProjection"]["cachePath"] != cache {
            setting(&mut next, "folderProjection", "cachePath", json!(cache))?;
            fence()?;
            platform::write_json(&path, &next)?;
        }
        Ok(if resource["activation"] == "restart-required" {
            "restart-required"
        } else {
            "load-not-verified"
        })
    })();
    match installed {
        Ok(reason) => save(root, "installed", reason),
        Err(error) => {
            if claudex_sync::hooks::app_stopped(root)? {
                return save(root, "waiting", "application-stopped");
            }
            let (state, reason) = failure(&error);
            save(root, state, reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(config: Value) -> Result<(tempfile::TempDir, std::path::PathBuf)> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = storage::private_directory(temp.path().canonicalize()?)?;
        storage::write_json(root.join("config.json"), &config)?;
        Ok((temp, root))
    }
    #[test]
    fn intent_precedes_install_and_missing_cache_keeps_it_for_the_watcher() -> Result<()> {
        let (_temp, root) = profile(
            json!({"version":1,"mode":"desktop","rendererAdapters":{"relaunchAfterUpdate":false},"opaque":1}),
        )?;
        let outcome = configure(&root, |fence| {
            fence()?;
            let intent = storage::read_json(root.join("config.json"))?;
            assert_eq!(intent["folderProjection"]["enabled"], true);
            assert_eq!(intent["desktopLocalHandoff"]["enabled"], true);
            assert_eq!(intent["rendererAdapters"]["relaunchAfterUpdate"], false);
            assert_eq!(intent["opaque"], 1);
            Err(frontend_graph::GraphFailure {
                code: "CLAUDEX_FRONTEND_CACHE_MISSING",
                reason: "synthetic missing cache",
            }
            .into())
        })?;
        assert_eq!(outcome["state"], "waiting");
        assert_eq!(outcome["reason"], "cache-entry-missing");
        assert_eq!(
            storage::read_json(root.join("config.json"))?["folderProjection"]["enabled"],
            true
        );
        assert!(!outcome.to_string().contains("synthetic"));
        Ok(())
    }
    #[test]
    fn disabled_choices_and_app_stop_do_not_run_an_installer() -> Result<()> {
        let (_temp, root) = profile(
            json!({"version":1,"mode":"desktop","folderProjection":{"enabled":false},"rendererAdapters":{"enabled":false}}),
        )?;
        assert_eq!(
            configure(&root, |_| panic!("Disabled choice must not install"))?["state"],
            "disabled"
        );
        assert_eq!(
            storage::read_json(root.join("config.json"))?["rendererAdapters"]["enabled"],
            false
        );
        storage::write_json(
            root.join("config.json"),
            &json!({"version":1,"mode":"desktop"}),
        )?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        assert_eq!(
            configure(&root, |_| panic!("Hold must not install"))?["reason"],
            "application-stopped"
        );
        Ok(())
    }
    #[test]
    fn completed_install_tracks_resource_without_claiming_live_activation_and_refuses_config_race()
    -> Result<()> {
        let (_temp, root) =
            profile(json!({"version":1,"mode":"desktop","desktopLocalHandoff":{"enabled":false}}))?;
        let pass = json!({"adapters":{"folders":{"status":"installed","cachePath":"/synthetic/Cache_Data/0123456789abcdef_0","activation":"load-not-verified"}}});
        assert_eq!(
            configure(&root, |_| Ok(pass.clone()))?["reason"],
            "load-not-verified"
        );
        assert_eq!(
            storage::read_json(root.join("config.json"))?["desktopLocalHandoff"]["enabled"],
            false
        );
        let external = json!({"version":1,"mode":"desktop","opaque":"external change"});
        let status = configure(&root, |_| {
            storage::write_json(root.join("config.json"), &external)?;
            Ok(pass)
        })?;
        assert_eq!(status["reason"], "configuration-changed");
        assert_eq!(storage::read_json(root.join("config.json"))?, external);
        Ok(())
    }
}
