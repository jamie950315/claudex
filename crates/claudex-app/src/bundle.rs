//! Explicit, non-replacing macOS bundle construction for the Rust engine.
use crate::{
    mod_install,
    platform::{self, CommandSpec, Runner, checked},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
pub const IDENTIFIER: &str = "dev.0ruka.claudex.app";
pub const LOCALES: &[&str] = &[
    "en", "zh-Hant", "zh-Hans", "ja", "ko", "es", "de", "fr", "it",
];
pub const SWIFT: &[&str] = &[
    "native/ClaudexApp/main.swift",
    "native/ClaudexApp/SetupModel.swift",
    "native/ClaudexApp/StatusController.swift",
    "native/ClaudexApp/Localization.swift",
    "native/ClaudexApp/CacheSettings.swift",
    "native/ClaudexStatus/StatusModel.swift",
];
#[derive(Clone, Debug)]
pub struct Options {
    pub source: PathBuf,
    pub executable: PathBuf,
    pub destination: PathBuf,
    pub identity: String,
    pub architecture: String,
    pub zip: Option<PathBuf>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub app: PathBuf,
    pub zip: Option<PathBuf>,
    pub identity: String,
    pub architecture: String,
    pub notarized: bool,
}
fn absent(path: &Path) -> Result<()> {
    ensure!(
        !crate::status_app::exists(path)?,
        "Destination already exists."
    );
    Ok(())
}
fn directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    platform::directory(path, true, false)
}
fn source(source: &Path, name: &str, limit: usize) -> Result<Vec<u8>> {
    let relative = Path::new(name);
    ensure!(
        relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_))),
        "Invalid bundle source path."
    );
    let mut parent = source.to_owned();
    for component in relative.parent().unwrap().components() {
        parent.push(component);
        platform::directory(&parent, false, true)?;
    }
    platform::safe_bytes(&source.join(relative), limit, false, true)
}
fn copy(source_root: &Path, name: &str, destination: &Path) -> Result<()> {
    let bytes = source(source_root, name, 8 * 1024 * 1024)?;
    directory(destination.parent().context("Missing asset parent.")?)?;
    platform::publish(destination, &bytes, 0o600)
}
pub fn mach_o(bytes: &[u8]) -> bool {
    bytes.get(..4).is_some_and(|v| {
        [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
            [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf],
            [0xbf, 0xba, 0xfe, 0xca],
        ]
        .iter()
        .any(|magic| magic == v)
    })
}
async fn portable(binary: &Path, architecture: &str, runner: &dyn Runner) -> Result<()> {
    let output = checked(
        runner,
        CommandSpec::new(
            "/usr/bin/lipo",
            ["-archs".into(), binary.display().to_string()],
        ),
    )
    .await?;
    ensure!(
        output.stdout.split_whitespace().any(|v| v == architecture),
        "Native executable lacks the requested architecture."
    );
    let output = checked(
        runner,
        CommandSpec::new(
            "/usr/bin/otool",
            ["-L".into(), binary.display().to_string()],
        ),
    )
    .await?;
    for line in output.stdout.lines().skip(1) {
        if let Some(dependency) = line.split_whitespace().next() {
            ensure!(
                dependency.starts_with("/usr/lib/") || dependency.starts_with("/System/Library/"),
                "Native executable depends on a non-system library."
            );
        }
    }
    Ok(())
}
pub fn catalog(base: &Value, value: &Value) -> Result<()> {
    let base = base
        .as_object()
        .context("English UI catalog is not an object.")?;
    let values = value.as_object().context("UI catalog is not an object.")?;
    ensure!(
        !base.is_empty() && base.keys().collect::<BTreeSet<_>>() == values.keys().collect(),
        "Incomplete UI translation catalog."
    );
    for (key, value) in values {
        let text = value
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .context("Empty UI translation.")?;
        ensure!(
            key.matches("%@").count() == text.matches("%@").count()
                && !text.replace("%@", "").contains('%'),
            "Invalid UI translation placeholder."
        );
    }
    Ok(())
}
fn plist(version: &str) -> String {
    crate::status_app::plist(&format!(
        "\n<key>CFBundleIdentifier</key><string>{IDENTIFIER}</string>\n<key>CFBundleExecutable</key><string>ClaudexApp</string>\n<key>CFBundleName</key><string>Claudex</string>\n<key>CFBundleDisplayName</key><string>Claudex</string>\n<key>CFBundleIconFile</key><string>Claudex.icns</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>{}</string>\n<key>CFBundleVersion</key><string>{}</string>\n<key>LSMinimumSystemVersion</key><string>13.0</string>\n<key>NSHighResolutionCapable</key><true/>\n",
        platform::xml(version),
        platform::xml(version)
    ))
}
pub async fn build(options: &Options, runner: &dyn Runner) -> Result<Report> {
    ensure!(
        cfg!(target_os = "macos"),
        "macOS is required to build Claudex.app."
    );
    for path in [&options.source, &options.executable, &options.destination] {
        platform::absolute(path)?;
    }
    if let Some(zip) = &options.zip {
        platform::absolute(zip)?;
        absent(zip)?;
    }
    platform::directory(&options.source, false, true)?;
    ensure!(
        matches!(options.architecture.as_str(), "arm64" | "x86_64")
            && !options.identity.trim().is_empty()
            && !options.identity.chars().any(char::is_control)
            && options.destination.extension().is_some_and(|v| v == "app")
            && !options.destination.starts_with(&options.source),
        "Invalid app architecture, signing identity or destination."
    );
    absent(&options.destination)?;
    let parent = options
        .destination
        .parent()
        .context("App output has no parent.")?;
    platform::directory(parent, false, false)?;
    if let Some(zip) = &options.zip {
        platform::directory(
            zip.parent().context("ZIP output has no parent.")?,
            false,
            false,
        )?;
        ensure!(
            !zip.starts_with(&options.source),
            "ZIP output must be outside the source checkout."
        );
    }
    let engine_bytes = platform::safe_bytes(&options.executable, 256 * 1024 * 1024, false, true)?;
    ensure!(
        mach_o(&engine_bytes)
            && fs::metadata(&options.executable)?.permissions().mode() & 0o111 != 0,
        "App engine must be a complete native Mach-O executable."
    );
    portable(&options.executable, &options.architecture, runner).await?;
    let manifest: Value =
        serde_json::from_slice(&source(&options.source, "package.json", 1024 * 1024)?)?;
    let version = manifest["version"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("App version is missing.")?;
    let stage = parent.join(format!(".claudex-app-{}", uuid::Uuid::new_v4()));
    directory(&stage)?;
    let operation = async {
        let app = stage.join("Claudex.app");
        let contents = app.join("Contents");
        let resources = contents.join("Resources");
        let engine = resources.join("engine");
        let macos = contents.join("MacOS");
        directory(&macos)?;
        directory(&engine.join("bin"))?;
        platform::publish(&engine.join("bin/claudex"), &engine_bytes, 0o700)?;
        // Only host-required Mod JavaScript is shipped. The signed Codex
        // process bootstrap and injected renderer code are embedded in Rust.
        for name in mod_install::STAGE_FILES {
            copy(&options.source, name, &engine.join(name))?;
        }
        for name in [
            "native/ClaudexStatus/main.swift",
            "native/ClaudexStatus/StatusModel.swift",
        ] {
            copy(&options.source, name, &engine.join(name))?;
        }
        mod_install::validate_catalog(std::str::from_utf8(&source(
            &options.source,
            "plugins/claudex/hooks/locales.mjs",
            1024 * 1024,
        )?)?)?;
        let base: Value = serde_json::from_slice(&source(
            &options.source,
            "native/ClaudexApp/Locales/en.json",
            1024 * 1024,
        )?)?;
        for locale in LOCALES {
            let name = format!("native/ClaudexApp/Locales/{locale}.json");
            let bytes = source(&options.source, &name, 1024 * 1024)?;
            catalog(&base, &serde_json::from_slice(&bytes)?)?;
            let output = resources.join(format!("Locales/{locale}.json"));
            directory(output.parent().unwrap())?;
            platform::publish(&output, &bytes, 0o600)?;
        }
        let artwork = source(
            &options.source,
            "native/ClaudexApp/Assets/AppIcon.png",
            16 * 1024 * 1024,
        )?;
        let image = stage.join("AppIcon.png");
        platform::publish(&image, &artwork, 0o600)?;
        let iconset = stage.join("Claudex.iconset");
        directory(&iconset)?;
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = (size * scale).to_string();
                let target = iconset.join(format!(
                    "icon_{size}x{size}{}.png",
                    if scale == 2 { "@2x" } else { "" }
                ));
                checked(
                    runner,
                    CommandSpec::new(
                        "/usr/bin/sips",
                        [
                            "-z".into(),
                            pixels.clone(),
                            pixels,
                            image.display().to_string(),
                            "--out".into(),
                            target.display().to_string(),
                        ],
                    ),
                )
                .await?;
            }
        }
        checked(
            runner,
            CommandSpec::new(
                "/usr/bin/iconutil",
                [
                    "-c".into(),
                    "icns".into(),
                    iconset.display().to_string(),
                    "-o".into(),
                    resources.join("Claudex.icns").display().to_string(),
                ],
            ),
        )
        .await?;
        let icon = platform::safe_bytes(
            &resources.join("Claudex.icns"),
            32 * 1024 * 1024,
            false,
            false,
        )?;
        ensure!(
            icon.len() >= 8
                && &icon[..4] == b"icns"
                && u32::from_be_bytes(icon[4..8].try_into()?) as usize == icon.len(),
            "App icon output is invalid."
        );
        platform::publish(
            &contents.join("Info.plist"),
            plist(version).as_bytes(),
            0o600,
        )?;
        // Compile immutable snapshots, not source paths that could be changed
        // while swiftc runs. Keep the complete source set explicit.
        let swift = stage.join("swift");
        directory(&swift)?;
        let mut args = vec!["swiftc".into()];
        for (i, name) in SWIFT.iter().enumerate() {
            let target = swift.join(format!(
                "{i}-{}",
                Path::new(name).file_name().unwrap().to_string_lossy()
            ));
            let target = if name.ends_with("/main.swift") {
                swift.join("main.swift")
            } else {
                target
            };
            platform::publish(
                &target,
                &source(&options.source, name, 4 * 1024 * 1024)?,
                0o600,
            )?;
            args.push(target.display().to_string());
        }
        args.extend([
            "-framework".into(),
            "Cocoa".into(),
            "-framework".into(),
            "UserNotifications".into(),
            "-target".into(),
            format!("{}-apple-macos13.0", options.architecture),
            "-o".into(),
            macos.join("ClaudexApp").display().to_string(),
        ]);
        let mut compile = CommandSpec::new("/usr/bin/xcrun", args);
        compile.timeout = Duration::from_secs(180);
        checked(runner, compile).await?;
        portable(&macos.join("ClaudexApp"), &options.architecture, runner).await?;
        // Sign native children first. No Node distribution or engine-side npm
        // dependencies exist in the migrated bundle.
        for target in [engine.join("bin/claudex"), app.clone()] {
            checked(
                runner,
                CommandSpec::new(
                    "/usr/bin/codesign",
                    [
                        "--force".into(),
                        "--sign".into(),
                        options.identity.clone(),
                        "--options".into(),
                        "runtime".into(),
                        target.display().to_string(),
                    ],
                ),
            )
            .await?;
        }
        checked(
            runner,
            CommandSpec::new(
                "/usr/bin/codesign",
                [
                    "--verify".into(),
                    "--deep".into(),
                    "--strict".into(),
                    "--verbose=2".into(),
                    app.display().to_string(),
                ],
            ),
        )
        .await?;
        if let Some(zip) = &options.zip {
            // ditto cannot replace an existing archive, even if it appeared
            // after preflight. Publish a newly generated archive exclusively.
            let staged_zip = stage.join("Claudex.zip");
            checked(
                runner,
                CommandSpec::new(
                    "/usr/bin/ditto",
                    [
                        "-c".into(),
                        "-k".into(),
                        "--keepParent".into(),
                        app.display().to_string(),
                        staged_zip.display().to_string(),
                    ],
                ),
            )
            .await?;
            absent(zip)?;
            fs::hard_link(&staged_zip, zip)?;
        }
        absent(&options.destination)?;
        // renamex_np's exclusive flag prevents a raced destination replacement.
        #[cfg(target_os = "macos")]
        {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};
            let from = CString::new(app.as_os_str().as_bytes())?;
            let to = CString::new(options.destination.as_os_str().as_bytes())?;
            ensure!(
                unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0,
                "App publication failed; staging preserved: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok::<_, anyhow::Error>(Report {
            app: options.destination.clone(),
            zip: options.zip.clone(),
            identity: options.identity.clone(),
            architecture: options.architecture.clone(),
            notarized: false,
        })
    }
    .await;
    let report =
        operation.with_context(|| format!("App staging preserved at {}.", stage.display()))?;
    // The published bundle and archive were moved or linked out; the rest of
    // the uniquely named stage is build scratch.
    fs::remove_dir_all(&stage).with_context(|| {
        format!(
            "App published at {}; staging was not removed: {}.",
            report.app.display(),
            stage.display()
        )
    })?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn translations_preserve_the_exact_catalog_and_placeholders() -> Result<()> {
        let base = json!({"Open %@":"Open %@","Ready":"Ready"});
        catalog(&base, &json!({"Open %@":"開啟 %@","Ready":"就緒"}))?;
        for bad in [
            json!({"Ready":"就緒"}),
            json!({"Open %@":"開啟","Ready":"就緒"}),
            json!({"Open %@":"%@ 100%","Ready":"就緒"}),
        ] {
            assert!(catalog(&base, &bad).is_err());
        }
        assert!(!mach_o(b"#!/bin/sh\n"));
        Ok(())
    }
}
