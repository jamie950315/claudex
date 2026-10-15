//! Start native maintenance only inside the exclusive Desktop watcher lease.
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_sync::{commands::WatchLifecycle, event_source::Source};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
};

struct Monitor {
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}
pub struct DesktopWatch {
    renderer: crate::renderer::Renderer,
    monitor: Mutex<Option<Monitor>>,
}
impl DesktopWatch {
    pub fn new(home: PathBuf) -> Result<Self> {
        Ok(Self {
            renderer: crate::renderer::Renderer::new(home)?,
            monitor: Mutex::new(None),
        })
    }
}
#[async_trait]
impl WatchLifecycle for DesktopWatch {
    async fn start(&self, source: &Source, root: &Path, config: &Value) -> Result<()> {
        let mut monitor = self.monitor.lock().await;
        ensure!(
            monitor.is_none(),
            "Desktop watch lifecycle has already started."
        );
        crate::desktop::apply(
            root,
            &std::env::current_exe()?,
            &crate::service::NativeCommands,
            &claudex_core::codex_layout::OpenAiVerifier,
        )
        .await?;
        self.renderer.start(source, root, config).await?;
        let codex_home = config["codexHome"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing native Codex home."))?;
        let (stop, receive) = watch::channel(false);
        let task = tokio::spawn(crate::relaunch::monitor(
            crate::relaunch::Options::new(root.into(), codex_home.into()),
            receive,
        ));
        *monitor = Some(Monitor { stop, task });
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        let monitor = self.monitor.lock().await.take();
        if let Some(monitor) = &monitor {
            let _ = monitor.stop.send(true);
        }
        let renderer = self.renderer.stop().await;
        // Drain both even if one maintenance component failed to close.
        let native = match monitor {
            Some(monitor) => monitor.task.await?,
            None => Ok(()),
        };
        renderer?;
        native
    }
    fn status(&self) -> Value {
        self.renderer.status()
    }
    fn restart(&self) -> Value {
        self.renderer.restart()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudex_core::storage::{FileLock, private_directory, write_json};
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn competing_watcher_never_starts_native_maintenance() -> Result<()> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let base = temp.path().canonicalize()?;
        let root = private_directory(base.join("state"))?;
        let codex = private_directory(base.join("codex"))?;
        let claude = private_directory(base.join("claude"))?;
        write_json(
            root.join("config.json"),
            &json!({"version":1,"mode":"desktop",
            "codexHome":codex,"claudeHome":claude,"binary":"/no-native-command",
            "claudeBinary":"/no-native-command"}),
        )?;
        let _owner = FileLock::acquire(&root.join("watch.lock"), true)?;
        let lifecycle = Arc::new(DesktopWatch::new(base)?);
        let result = claudex_sync::commands::run_with(
            &[
                "watch".into(),
                "--root".into(),
                root.to_str().unwrap().into(),
            ],
            Some(lifecycle.clone()),
        )
        .await;
        assert!(result.is_err());
        assert!(lifecycle.monitor.lock().await.is_none());
        assert!(lifecycle.status().is_null());
        assert!(!root.join("desktop-relaunch-status.json").exists());
        lifecycle.stop().await?;
        Ok(())
    }
}
