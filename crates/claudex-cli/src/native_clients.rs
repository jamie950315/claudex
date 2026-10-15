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
        Ok(Self {
            codex,
            claude,
            desktop_registry: home.join("Library/Application Support/Claude/claude-code-sessions"),
        })
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
