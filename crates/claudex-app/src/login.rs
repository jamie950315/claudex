//! The unified app owns one login entry; migration never stops native work.
use crate::{
    platform::{self, CommandSpec, Runner, checked},
    status_app::{self, LaunchDefinition},
};
use anyhow::{Context, Result, ensure};
use claudex_core::storage::{FileLock, hash_bytes};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub const IDENTIFIER: &str = "dev.0ruka.claudex.app";
pub fn definition(root: &Path, home: &Path, app: &Path) -> Result<LaunchDefinition> {
    for path in [root, home, app] {
        platform::absolute(path)?;
    }
    let label = format!(
        "{IDENTIFIER}.{}",
        &hash_bytes(root.to_string_lossy().as_bytes())[..12]
    );
    let executable = app.join("Contents/MacOS/ClaudexApp");
    let args = vec![
        executable.display().to_string(),
        "--background".into(),
        "--root".into(),
        root.display().to_string(),
    ];
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array>{}</array>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n",
        platform::xml(&label),
        args.iter()
            .map(|v| format!("<string>{}</string>", platform::xml(v)))
            .collect::<String>()
    );
    Ok(LaunchDefinition {
        path: home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist")),
        label,
        executable,
        args,
        plist,
    })
}
pub async fn verify_app(app: &Path, run: &dyn Runner) -> Result<()> {
    platform::directory(app, false, true)?;
    let executable = app.join("Contents/MacOS/ClaudexApp");
    platform::safe_bytes(&executable, 128 * 1024 * 1024, false, true)?;
    let before = platform::Identity::of(&fs::symlink_metadata(app)?);
    let file = platform::Identity::of(&fs::symlink_metadata(&executable)?);
    checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", &app.to_string_lossy()],
        ),
    )
    .await?;
    let details = checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["-d", "--verbose=2", &app.to_string_lossy()],
        ),
    )
    .await?;
    status_app::verify_development_details(&details.stderr, IDENTIFIER)?;
    ensure!(
        before == platform::Identity::of(&fs::symlink_metadata(app)?)
            && file == platform::Identity::of(&fs::symlink_metadata(&executable)?),
        "The unified application changed during verification."
    );
    Ok(())
}
async fn quit_legacy(p: &status_app::Paths, run: &dyn Runner) -> Result<()> {
    let id = serde_json::to_string(&p.label)?;
    let app = serde_json::to_string(&p.app.display().to_string())?;
    let script = format!(
        "ObjC.import('Cocoa');\nconst apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier({id});\nfor (let i = 0; i < Number(apps.count); i++) {{\n  const app = apps.objectAtIndex(i);\n  if (ObjC.unwrap(app.bundleURL.path) !== {app}) throw Error('Legacy display bundle path differs.');\n}}\nfor (let i = 0; i < Number(apps.count); i++) if (!apps.objectAtIndex(i).terminate) throw Error('Legacy display refused to quit.');\nfor (let attempt = 0; attempt < 30; attempt++) {{\n  if (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier({id}).count) === 0) break;\n  delay(0.1);\n}}\nif (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier({id}).count) !== 0) throw Error('Legacy display is still running.');"
    );
    checked(
        run,
        CommandSpec::new("/usr/bin/osascript", ["-l", "JavaScript", "-e", &script]),
    )
    .await?;
    let output = run
        .run(CommandSpec::new(
            "/usr/sbin/lsof",
            ["-t", &p.executable.to_string_lossy()],
        ))
        .await?;
    ensure!(
        matches!(output.code, 0 | 1)
            && output.stdout.trim().is_empty()
            && output.stderr.trim().is_empty(),
        "The legacy display executable is still in use."
    );
    Ok(())
}
pub async fn install(root: &Path, home: &Path, app: &Path, run: &dyn Runner) -> Result<Value> {
    ensure!(
        cfg!(target_os = "macos"),
        "The unified application requires macOS."
    );
    let root = status_app::canonical_root(root, false)?;
    let d = definition(&root, home, app)?;
    let _lock = FileLock::acquire(root.join("app-login.lock"), true)?;
    verify_app(app, run).await?;
    let previous = status_app::owned_text(&d.path)?;
    ensure!(
        previous.as_ref().is_none_or(|v| v == &d.plist),
        "Existing application LaunchAgent differs; it was preserved."
    );
    status_app::loaded_job(&d, run).await?;
    let legacy_paths = status_app::Paths::new(&root, home)?;
    let legacy_definition = legacy_paths.definition();
    let legacy_plist = status_app::owned_text(&legacy_paths.launch_agent)?;
    ensure!(
        legacy_plist
            .as_ref()
            .is_none_or(|v| v == &legacy_definition.plist),
        "Existing legacy display LaunchAgent differs; it was preserved."
    );
    let legacy = status_app::status(&root, home, run).await?;
    ensure!(
        legacy["recoveryRequired"] != true,
        "Legacy display upgrade requires recovery before integration."
    );
    ensure!(
        legacy_plist.is_none() || legacy["installed"] == true,
        "Legacy display installation could not be verified."
    );
    let backup = legacy_paths.directory.join("login-disabled.plist");
    if legacy["installed"] == true {
        ensure!(
            status_app::owned_text(&backup)?
                .as_ref()
                .is_none_or(|v| v == &legacy_definition.plist),
            "Legacy login backup differs; it was preserved."
        );
    }
    let parent = d.path.parent().context("Missing LaunchAgents parent.")?;
    if !status_app::exists(parent)? {
        fs::create_dir_all(parent)?;
    }
    platform::directory(parent, false, false)?;
    if previous.is_none() {
        platform::publish(&d.path, d.plist.as_bytes(), 0o600)?;
    }
    ensure!(
        status_app::owned_text(&d.path)?.as_deref() == Some(&d.plist),
        "Application LaunchAgent changed during integration."
    );
    checked(
        run,
        CommandSpec::new("/usr/bin/plutil", ["-lint", &d.path.to_string_lossy()]),
    )
    .await?;
    if legacy["installed"] == true {
        quit_legacy(&legacy_paths, run).await?;
        let current = status_app::status(&root, home, run).await?;
        ensure!(
            current["running"] != true,
            "Legacy display is still running; integration is incomplete."
        );
        if current["loaded"] == true {
            checked(
                run,
                CommandSpec::new(
                    "/bin/launchctl",
                    [
                        "bootout",
                        &format!("gui/{}/{}", platform::uid(), legacy_paths.label),
                    ],
                ),
            )
            .await?;
        }
        ensure!(
            status_app::status(&root, home, run).await?["loaded"] != true,
            "Legacy display login job is still loaded."
        );
        if legacy_plist.is_some() {
            ensure!(
                status_app::owned_text(&legacy_paths.launch_agent)?.as_deref()
                    == Some(&legacy_definition.plist),
                "Legacy display LaunchAgent changed during integration."
            );
            ensure!(
                status_app::owned_text(&backup)?.is_none(),
                "Legacy login backup already exists; the current entry was preserved."
            );
            fs::rename(&legacy_paths.launch_agent, &backup)?;
        }
    }
    let result = json!({"version":1,"root":root,"app":app,"label":d.label,"launchAgent":d.path,"loginStart":true,"legacyDisplayDisabled":legacy["installed"]==true,"synchronizationRestarted":false});
    platform::write_json(&root.join("app-login.json"), &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_definition_matches_existing_host_contract() -> Result<()> {
        let d = definition(
            Path::new("/private/test & status"),
            Path::new("/private/user"),
            Path::new("/Applications/Claudex.app"),
        )?;
        assert!(d.plist.contains("test &amp; status"));
        assert!(d.plist.contains("--background"));
        assert!(!d.plist.contains("KeepAlive"));
        assert_eq!(d.args.len(), 4);
        let old = status_app::Paths::new(
            Path::new("/private/test & status"),
            Path::new("/private/user"),
        )?
        .definition();
        assert!(old.plist.contains("<key>KeepAlive</key>"));
        assert_ne!(old.label, d.label);
        Ok(())
    }
}
