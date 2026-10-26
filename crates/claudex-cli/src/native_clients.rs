//! Existing native metadata connections. A configured Desktop writer is never
//! replaced with a new backend or an alternate endpoint after refusal.
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use claudex_core::{rpc::CodexClient, version::VersionPolicy};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Homes {
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub desktop_registry: PathBuf,
    /// Reselect the native deployment per action; None pins an explicit registry.
    pub selection_home: Option<PathBuf>,
}
impl Homes {
    pub fn read(root: &Path, home: &Path) -> Result<Self> {
        let config = claudex_work::archive::optional(&root.join("config.json"), 1024 * 1024)?;
        if let Some(config) = &config {
            ensure!(
                config["version"] == 1,
                "Unsupported synchronization configuration version."
            );
        }
        let value = config.unwrap_or(Value::Null);
        let codex = value["codexHome"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
            .unwrap_or_else(|| home.join(".codex"));
        let claude = value["claudeHome"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        ensure!(
            codex.is_absolute() && claude.is_absolute(),
            "Native homes must be absolute."
        );
        let desktop_registry =
            claudex_core::claude_desktop::registry(home, value["desktopHome"].as_str())?;
        Ok(Self {
            codex,
            claude,
            desktop_registry,
            selection_home: value["desktopHome"].as_str().is_none().then(|| home.into()),
        })
    }
    pub fn desktop_registry(&self) -> Result<PathBuf> {
        match &self.selection_home {
            Some(home) => claudex_core::claude_desktop::registry(home, None),
            None => Ok(self.desktop_registry.clone()),
        }
    }
}

#[cfg(test)]
mod home_tests {
    use super::*;
    #[test]
    fn deployment_is_reselected_for_each_native_action_and_explicit_registry_is_preserved()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = claudex_core::storage::private_directory(temp.path())?;
        let home = root.join("home");
        std::fs::create_dir(&home)?;
        let homes = Homes::read(&root, &home)?;
        assert!(
            homes
                .desktop_registry()?
                .ends_with("Claude/claude-code-sessions")
        );
        let config = claudex_core::claude_desktop::configuration_path(&home);
        std::fs::create_dir_all(config.parent().unwrap())?;
        claudex_core::storage::write_json(&config, &serde_json::json!({"deploymentMode":"3p"}))?;
        assert!(
            homes
                .desktop_registry()?
                .ends_with("Claude-3p/claude-code-sessions")
        );
        claudex_core::storage::write_json(
            root.join("config.json"),
            &serde_json::json!({"version":1,"desktopHome":root.join("registry")}),
        )?;
        let explicit = Homes::read(&root, &home)?;
        claudex_core::storage::write_json(
            &config,
            &serde_json::json!({"deploymentMode":"unsupported"}),
        )?;
        assert_eq!(explicit.desktop_registry()?, root.join("registry"));
        assert!(homes.desktop_registry().is_err());
        Ok(())
    }
}

pub struct NativeClient(pub CodexClient);
impl NativeClient {
    pub async fn connect(root: &Path, codex_home: &Path) -> Result<Self> {
        if crate::desktop::installed_launcher(root)?.is_some() {
            let session = claudex_core::shared_codex::connect(
                root,
                codex_home,
                VersionPolicy::read(root)?,
                claudex_core::rpc::MAX_FRAME_BYTES,
            )
            .await?;
            return Ok(Self(session.client));
        }
        let client =
            CodexClient::connect(&codex_home.join("app-server-control/app-server-control.sock"))
                .await?;
        let admitted = async {
            let initialized = client.initialize().await?;
            if let Some(native_home) = initialized.get("codexHome") {
                let native_home = native_home
                    .as_str()
                    .context("Invalid native metadata home.")?;
                ensure!(
                    std::fs::canonicalize(native_home)? == std::fs::canonicalize(codex_home)?,
                    "Native metadata home differs from configured home."
                );
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = admitted {
            client.close().await?;
            return Err(error);
        }
        Ok(Self(client))
    }
    pub async fn close(&self) -> Result<()> {
        self.0.close().await
    }
}
#[async_trait]
impl claudex_work::origin::OriginClient for NativeClient {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        ensure!(
            ["thread/read", "thread/items/list"].contains(&method),
            "Origin verification only accepts read-only native metadata operations."
        );
        self.0.request(method, params).await
    }
}
#[async_trait]
impl claudex_sync::native_history::Rpc for NativeClient {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.0.request(method, params).await
    }
}

pub async fn verify_origin(root: &Path, homes: &Homes, input: &Value) -> Result<Value> {
    let proof = async {
        if input["provider"] == "claude" {
            return claudex_work::origin::verify_origin(input, &homes.claude, None).await;
        }
        ensure!(
            input["provider"] == "codex",
            "Invalid native origin provider."
        );
        let client = NativeClient::connect(root, &homes.codex).await?;
        let result = claudex_work::origin::verify_origin(input, &homes.claude, Some(&client)).await;
        client.close().await?;
        result
    };
    match tokio::time::timeout(std::time::Duration::from_millis(1800), proof).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error))
            if error
                .downcast_ref::<claudex_work::model::ProtocolError>()
                .is_some() =>
        {
            Err(error)
        }
        _ => Err(claudex_work::model::error(
            "ORIGIN_PROOF_UNAVAILABLE",
            "Exact native origin evidence is unavailable; no notification is authorized.",
        )),
    }
}
