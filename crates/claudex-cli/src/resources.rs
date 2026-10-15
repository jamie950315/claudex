//! Resolve bundled or source assets independently of the caller's directory.
use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub struct Resources {
    pub engine: PathBuf,
    pub app: Option<PathBuf>,
}
fn source(root: &Path) -> bool {
    root.join("Cargo.toml").is_file()
        && root
            .join("plugins/claudex/.claude-plugin/plugin.json")
            .is_file()
        && root.join("native/ClaudexApp").is_dir()
}
pub fn locate(executable: &Path, source_root: Option<&Path>) -> Result<Resources> {
    ensure!(
        executable.is_absolute(),
        "Native executable path must be absolute."
    );
    let engine = executable
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "bin"))
        .and_then(Path::parent)
        .filter(|p| p.file_name().is_some_and(|n| n == "engine"));
    if let Some(engine) = engine {
        if let Some(app) = engine
            .parent()
            .filter(|p| p.file_name().is_some_and(|n| n == "Resources"))
            .and_then(Path::parent)
            .filter(|p| p.file_name().is_some_and(|n| n == "Contents"))
            .and_then(Path::parent)
        {
            ensure!(
                source_root.is_none(),
                "A packaged application uses only its bundled engine resources."
            );
            return Ok(Resources {
                engine: engine.into(),
                app: Some(app.into()),
            });
        }
    }
    if let Some(root) = source_root {
        let root = crate::args::absolute(root)?;
        ensure!(
            source(&root),
            "--source-root must name a complete Claudex source checkout."
        );
        return Ok(Resources {
            engine: root,
            app: None,
        });
    }
    let root = executable.ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "target"))
        .and_then(Path::parent)
        .filter(|root| source(root))
        .context("Native source assets were not found. Use --source-root /absolute/claudex-checkout for an out-of-tree executable.")?;
    Ok(Resources {
        engine: root.into(),
        app: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn source_debug_release_and_bundle_resources_do_not_depend_on_cwd() -> Result<()> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        fs::create_dir_all(root.join("plugins/claudex/.claude-plugin"))?;
        fs::create_dir_all(root.join("native/ClaudexApp"))?;
        fs::write(root.join("Cargo.toml"), "[workspace]\n")?;
        fs::write(
            root.join("plugins/claudex/.claude-plugin/plugin.json"),
            "{}",
        )?;
        for relative in [
            "target/debug/claudex",
            "target/release/claudex",
            "target/aarch64-apple-darwin/release/claudex",
        ] {
            assert_eq!(
                locate(&root.join(relative), None)?,
                Resources {
                    engine: root.clone(),
                    app: None
                }
            );
        }
        let external = root.join("external/bin/claudex");
        assert!(locate(&external, None).is_err());
        assert_eq!(locate(&external, Some(&root))?.engine, root);
        let app = root.join("Claudex.app");
        let executable = app.join("Contents/Resources/engine/bin/claudex");
        assert_eq!(
            locate(&executable, None)?,
            Resources {
                engine: app.join("Contents/Resources/engine"),
                app: Some(app)
            }
        );
        assert!(locate(&executable, Some(&root)).is_err());
        Ok(())
    }
}
