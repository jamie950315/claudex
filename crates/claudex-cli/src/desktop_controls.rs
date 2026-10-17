//! Presentation preferences revoke native archive authority before changing it.
use anyhow::{Context, Result, ensure};
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::path::Path;

/// The native renderer installer is injected so preference ordering and map
/// revocation can be exercised without changing a real application's cache.
pub trait FolderResources {
    fn install(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value>;
    fn restore(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value>;
}
pub struct NativeFolderResources<'a> {
    pub root: &'a Path,
    pub home: &'a Path,
}
impl FolderResources for NativeFolderResources<'_> {
    fn install(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value> {
        Ok(claudex_app::frontend_install::ensure(self.root, self.home, true, fence)?.summary)
    }
    fn restore(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value> {
        claudex_app::frontend_install::restore_folder_generations(self.root, self.home, fence)
    }
}

pub fn folder_status(root: &Path, config: &Value) -> Result<Value> {
    let installation = if let Some(path) = config["folderProjection"]["cachePath"].as_str() {
        let filename = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .context("Claude folder presentation cache path is invalid.")?;
        let manifest = if filename == "15bc54146dcdb4ce_0" {
            root.join("ui-folder-compat/manifest.json")
        } else {
            ensure!(
                claudex_app::frontend_graph::cache_filename(filename),
                "Claude folder presentation cache path does not match its native resource."
            );
            root.join("ui-folders")
                .join(filename)
                .join("ui-folder-compat/manifest.json")
        };
        claudex_app::platform::optional_json(&manifest, 16 * 1024, true)?.unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let maintenance = claudex_app::platform::optional_json(
        &root.join("renderer-adapters-status.json"),
        1024 * 1024,
        true,
    )?
    .unwrap_or(Value::Null);
    let watcher =
        claudex_app::platform::optional_json(&root.join("watcher-status.json"), 1024 * 1024, true)?
            .unwrap_or(Value::Null);
    Ok(
        json!({"enabled":config["folderProjection"]["enabled"]==true,
        "installation":installation,"maintenance":maintenance,"watcher":watcher["folderProjection"]}),
    )
}

pub fn folders(
    root: &Path,
    config: &Value,
    action: &str,
    resources: &dyn FolderResources,
) -> Result<Value> {
    if action == "status" {
        return folder_status(root, config);
    }
    ensure!(
        ["enable", "disable"].contains(&action),
        "Use desktop folders enable, disable, or status."
    );
    ensure!(
        cfg!(target_os = "macos") && config["mode"] == "desktop",
        "Claude folder presentation requires macOS Desktop mode."
    );
    let _lock = FileLock::acquire(root.join("desktop-operation.lock"), true)?;
    watcher_stopped(root)?;
    let before = configuration(root, config)?;
    let unchanged = || -> Result<()> {
        watcher_stopped(root)?;
        ensure!(
            crate::renderer_setup::private_snapshot(&root.join("config.json"), 1024 * 1024)?
                .identity
                == before.identity,
            "Synchronization configuration changed during folder setup; existing settings were preserved."
        );
        Ok(())
    };
    let mut next = config.clone();
    if action == "enable" {
        let state = claudex_sync::desktop::DesktopBridge::new(root, Default::default()).status()?;
        let map = claudex_sync::owner_wake::publish_folders(root, &state)?;
        ensure!(
            map["deferred"].is_null(),
            "Complete the pending native operation before enabling folder presentation."
        );
        let pass = resources.install(&unchanged)?;
        let resource = &pass["adapters"]["folders"];
        ensure!(
            resource["status"] == "installed",
            "Claude folder presentation could not be structurally verified."
        );
        let cache_path = resource["cachePath"]
            .as_str()
            .context("Installed folder resource omitted its native cache identity.")?;
        set_preference(&mut next, "rendererAdapters", "enabled", json!(true))?;
        set_preference(&mut next, "folderProjection", "enabled", json!(true))?;
        set_preference(
            &mut next,
            "folderProjection",
            "cachePath",
            json!(cache_path),
        )?;
        unchanged()?;
        storage::write_json(root.join("config.json"), &next)?;
        Ok(json!({"enabled":true,"map":map,"resource":resource,
            "note":"The watcher follows cached frontend deployments automatically. Restart Claude only when idle to load each newly installed frontend graph; map changes need no reload."}))
    } else {
        revoke_intents(root)?;
        let map = claudex_sync::owner_wake::publish_folders(root, &Default::default())?;
        set_preference(&mut next, "folderProjection", "enabled", json!(false))?;
        set_preference(&mut next, "desktopLocalHandoff", "enabled", json!(false))?;
        unchanged()?;
        storage::write_json(root.join("config.json"), &next)?;
        let disabled = configuration(root, &next)?;
        let disabled_fence = || -> Result<()> {
            watcher_stopped(root)?;
            ensure!(
                crate::renderer_setup::private_snapshot(&root.join("config.json"), 1024 * 1024)?
                    .identity
                    == disabled.identity,
                "Synchronization configuration changed during folder restoration; existing settings were preserved."
            );
            Ok(())
        };
        let resource = resources.restore(&disabled_fence)?;
        Ok(json!({"enabled":false,"map":map,"resource":resource,
            "note":"Map cleared and original cache resources restored; restart Claude only when idle to fully unload the presentation adapter."}))
    }
}

fn set_preference(config: &mut Value, section: &str, key: &str, value: Value) -> Result<()> {
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
fn watcher_stopped(root: &Path) -> Result<()> {
    ensure!(
        matches!(std::fs::symlink_metadata(root.join("watch.lock")), Err(e) if e.kind()==std::io::ErrorKind::NotFound),
        "Stop the bridge watcher safely before changing Desktop installation."
    );
    Ok(())
}
fn configuration(root: &Path, config: &Value) -> Result<storage::StableFile> {
    let before = crate::renderer_setup::private_snapshot(&root.join("config.json"), 1024 * 1024)?;
    ensure!(
        serde_json::from_slice::<Value>(&before.bytes)? == *config,
        "Synchronization configuration changed; existing settings were preserved."
    );
    Ok(before)
}

pub fn handoffs(root: &Path, config: &Value, action: &str) -> Result<Value> {
    if action == "status" {
        let watcher = claudex_app::platform::optional_json(
            &root.join("watcher-status.json"),
            1024 * 1024,
            true,
        )?
        .unwrap_or(Value::Null);
        return Ok(
            json!({"enabled":config["desktopLocalHandoff"]["enabled"]==true,"watcher":watcher["localHandoff"]}),
        );
    }
    ensure!(
        ["enable", "disable"].contains(&action),
        "Use desktop handoffs enable, disable, or status."
    );
    ensure!(
        cfg!(target_os = "macos")
            && config["mode"] == "desktop"
            && config["folderProjection"]["enabled"] == true,
        "Native Local handoffs require the verified macOS Claude folder adapter."
    );
    let _lock = FileLock::acquire(root.join("desktop-operation.lock"), true)?;
    watcher_stopped(root)?;
    let before = configuration(root, config)?;
    revoke_intents(root)?;
    let mut next = config.clone();
    let enabled = action == "enable";
    set_preference(&mut next, "desktopLocalHandoff", "enabled", json!(enabled))?;
    ensure!(
        crate::renderer_setup::private_snapshot(&root.join("config.json"), 1024 * 1024)?.identity
            == before.identity,
        "Synchronization configuration changed during handoff setup; existing settings were preserved."
    );
    storage::write_json(root.join("config.json"), &next)?;
    Ok(
        json!({"enabled":enabled,"note":"The next watcher verifies complete replacements before publishing expiring native archive intents. Original transcripts and worktrees are retained."}),
    )
}
pub fn revoke_intents(root: &Path) -> Result<()> {
    let previous = claudex_app::platform::optional_json(
        &root.join("desktop-handoff.json"),
        1024 * 1024,
        true,
    )?
    .unwrap_or(Value::Null);
    ensure!(
        previous.is_null()
            || previous["version"] == 1
                && previous["kind"] == "claude-local-archive"
                && previous.get("anchors").is_none_or(Value::is_array),
        "Unsupported native handoff evidence; it was preserved."
    );
    storage::write_json(
        root.join("desktop-handoff.json"),
        &json!({"version":1,"kind":"claude-local-archive",
        "generatedAt":null,"expiresAt":null,"anchorsUpdatedAt":storage::now_ms(),"actions":[],
        "anchors":previous.get("anchors").cloned().unwrap_or(json!([]))}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Resources<'a> {
        root: &'a Path,
        installed: bool,
        fail_restore: bool,
    }
    impl FolderResources for Resources<'_> {
        fn install(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value> {
            fence()?;
            // The real map is published before any resource installation.
            assert_eq!(
                storage::read_json(self.root.join("folder-map.json"))?["entries"],
                json!([])
            );
            Ok(
                json!({"adapters":{"folders":{"status":if self.installed {"installed"} else {"skipped"},
                "cachePath":"/synthetic/Cache_Data/0123456789abcdef_0","activation":"restart-required"}}}),
            )
        }
        fn restore(&self, fence: &dyn Fn() -> Result<()>) -> Result<Value> {
            fence()?;
            let config = storage::read_json(self.root.join("config.json"))?;
            assert_eq!(config["folderProjection"]["enabled"], false);
            assert_eq!(config["desktopLocalHandoff"]["enabled"], false);
            assert_eq!(
                storage::read_json(self.root.join("folder-map.json"))?["entries"],
                json!([])
            );
            assert_eq!(
                storage::read_json(self.root.join("desktop-handoff.json"))?["actions"],
                json!([])
            );
            ensure!(
                !self.fail_restore,
                "Synthetic restoration refusal; original evidence preserved."
            );
            Ok(json!({"status":"restored","changed":true,"generations":1}))
        }
    }

    #[test]
    fn folder_controls_publish_map_preserve_choices_and_revoke_before_restore() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir_in("/tmp")?;
        std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(fixture.path().canonicalize()?)?;
        let config = json!({"version":1,"mode":"desktop","folderProjection":{"enabled":false,"opaque":"preserved"},
            "rendererAdapters":{"relaunchAfterUpdate":false},"desktopLocalHandoff":{"enabled":true,"opaque":1}});
        storage::write_json(root.join("config.json"), &config)?;
        let resources = Resources {
            root: &root,
            installed: true,
            fail_restore: false,
        };
        let enabled = folders(&root, &config, "enable", &resources)?;
        assert_eq!(enabled["resource"]["activation"], "restart-required");
        let next = storage::read_json(root.join("config.json"))?;
        assert_eq!(next["folderProjection"]["opaque"], "preserved");
        assert_eq!(next["rendererAdapters"]["relaunchAfterUpdate"], false);
        assert_eq!(next["rendererAdapters"]["enabled"], true);
        let anchors = json!([{"identity":"preserved"}]);
        storage::write_json(
            root.join("desktop-handoff.json"),
            &json!({"version":1,"kind":"claude-local-archive","anchors":anchors,"actions":[{}]}),
        )?;
        folders(&root, &next, "disable", &resources)?;
        let disabled = storage::read_json(root.join("config.json"))?;
        assert_eq!(disabled["desktopLocalHandoff"]["opaque"], 1);
        assert_eq!(
            disabled["folderProjection"]["cachePath"],
            next["folderProjection"]["cachePath"]
        );
        assert_eq!(
            storage::read_json(root.join("desktop-handoff.json"))?["anchors"],
            anchors
        );
        let report = folder_status(&root, &disabled)?;
        assert_eq!(report["enabled"], false);
        assert_eq!(report["maintenance"], Value::Null);
        assert_eq!(report["installation"], Value::Null);
        Ok(())
    }

    #[test]
    fn folder_refusal_never_reports_ready_and_failed_restore_keeps_revocation() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir_in("/tmp")?;
        std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(fixture.path().canonicalize()?)?;
        let config = json!({"version":1,"mode":"desktop"});
        storage::write_json(root.join("config.json"), &config)?;
        let refused = Resources {
            root: &root,
            installed: false,
            fail_restore: true,
        };
        assert!(folders(&root, &config, "enable", &refused).is_err());
        assert_eq!(storage::read_json(root.join("config.json"))?, config);
        assert!(folders(&root, &config, "disable", &refused).is_err());
        let disabled = storage::read_json(root.join("config.json"))?;
        assert_eq!(disabled["folderProjection"]["enabled"], false);
        assert_eq!(disabled["desktopLocalHandoff"]["enabled"], false);
        let _watch = FileLock::acquire(root.join("watch.lock"), true)?;
        assert!(folders(&root, &disabled, "enable", &refused).is_err());
        assert_eq!(storage::read_json(root.join("config.json"))?, disabled);
        Ok(())
    }
    #[test]
    fn preference_change_revokes_commands_but_preserves_anchors_and_foreign_settings() -> Result<()>
    {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir_in("/tmp")?;
        std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o700))?;
        let root = storage::private_directory(fixture.path().canonicalize()?)?;
        let config =
            json!({"version":1,"mode":"desktop","folderProjection":{"enabled":true},"opaque":true});
        storage::write_json(root.join("config.json"), &config)?;
        let anchors = json!([{"sessionId":"synthetic","opaque":"preserved"}]);
        storage::write_json(
            root.join("desktop-handoff.json"),
            &json!({"version":1,"kind":"claude-local-archive","actions":[{"id":"old"}],"anchors":anchors}),
        )?;
        handoffs(&root, &config, "enable")?;
        let intents = storage::read_json(root.join("desktop-handoff.json"))?;
        assert_eq!(intents["anchors"], anchors);
        assert_eq!(intents["actions"], json!([]));
        assert_eq!(intents["expiresAt"], Value::Null);
        let next = storage::read_json(root.join("config.json"))?;
        assert_eq!(next["opaque"], true);
        assert_eq!(next["desktopLocalHandoff"]["enabled"], true);
        let _watch = FileLock::acquire(root.join("watch.lock"), true)?;
        assert!(handoffs(&root, &next, "disable").is_err());
        assert_eq!(storage::read_json(root.join("config.json"))?, next);
        Ok(())
    }
}
