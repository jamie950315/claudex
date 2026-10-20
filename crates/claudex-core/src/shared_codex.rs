//! Read-only admission to the existing Desktop writer. Never starts a backend.
use crate::{
    rpc::{self, CodexClient, SocketEndpoint},
    storage::{self, StableFile},
    version::VersionPolicy,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct SharedSession {
    pub client: CodexClient,
    pub initialized: Value,
    pub manifest: Value,
}
struct Proof {
    source: StableFile,
    manifest: Value,
    listener: PathBuf,
    endpoint: SocketEndpoint,
}
fn pair(value: &Value, identity: &storage::FileIdentity) -> bool {
    value["dev"].as_u64().map(|v| v.to_string()).as_ref() == Some(&identity.dev)
        && value["ino"].as_u64().map(|v| v.to_string()).as_ref() == Some(&identity.ino)
}
fn inspect(root: &Path, policy: VersionPolicy) -> Result<Proof> {
    rpc::endpoint_result(
        storage::require_private_directory(root),
        "inspect transport root",
        root,
    )?;
    let directory = root.join("codex-shared");
    rpc::endpoint_result(
        storage::require_private_directory(&directory),
        "inspect backend directory",
        &directory,
    )?;
    let manifest_path = directory.join("owner.json");
    let source = rpc::endpoint_result(
        storage::read_stable_with_limit(&manifest_path, 4096),
        "read backend manifest",
        &manifest_path,
    )?;
    ensure!(
        source.identity.uid == storage::uid().to_string()
            && source.identity.mode.parse::<u32>()? & 0o7777 == 0o600
            && source.identity.nlink == "1",
        "Shared Codex backend manifest is unsafe."
    );
    let manifest: Value = serde_json::from_slice(&source.bytes)?;
    ensure!(
        manifest["version"] == 1,
        "Shared Codex backend ownership version is invalid."
    );
    for key in ["pid", "childPid"] {
        let pid = manifest[key]
            .as_u64()
            .filter(|v| *v > 0 && *v <= i32::MAX as u64)
            .context("Shared Codex backend has an invalid process identity.")?
            as u32;
        ensure!(
            storage::process_alive(pid)?,
            "Shared Codex Desktop backend is not ready."
        );
    }
    if manifest["transportMode"] == "native" {
        bail!(
            "Desktop is using original native transport; synchronization awaits version validation."
        );
    }
    ensure!(
        manifest.get("transportMode").is_none(),
        "Unknown shared Codex backend transport mode."
    );
    let version = manifest["cliVersion"]
        .as_str()
        .context("Shared backend native version is missing.")?;
    ensure!(
        policy.allows_codex(version),
        "Shared Codex version is not validated under strict policy."
    );
    let listener = directory.join("app.sock");
    ensure!(
        manifest["listenerPath"].as_str() == listener.to_str(),
        "Shared Codex listener path does not match its owned root."
    );
    let endpoint = rpc::inspect_codex_socket(&listener)?;
    ensure!(
        manifest["socketPath"].as_str() == endpoint.socket_path.to_str()
            && pair(&manifest["listenerIdentity"], &endpoint.listener_identity)
            && pair(&manifest["socketIdentity"], &endpoint.socket_identity),
        "Shared Codex socket identity changed."
    );
    Ok(Proof {
        source,
        manifest,
        listener,
        endpoint,
    })
}
pub async fn connect(
    root: &Path,
    codex_home: &Path,
    policy: VersionPolicy,
    max_payload: usize,
) -> Result<SharedSession> {
    let proof = inspect(root, policy)?;
    let client = CodexClient::connect_with_limit(&proof.listener, max_payload).await?;
    let result = async {
        let initialized = client.initialize().await?;
        if let Some(home) = initialized.get("codexHome") {
            ensure!(
                home.as_str().is_some_and(|v| !v.is_empty()),
                "Shared backend native home is invalid."
            );
            ensure!(
                std::fs::canonicalize(home.as_str().unwrap()).with_context(|| {
                    format!(
                        "Shared backend native home cannot be resolved at {}",
                        home.as_str().unwrap()
                    )
                })? == std::fs::canonicalize(codex_home).with_context(|| {
                    format!(
                        "Configured Codex home cannot be resolved at {}",
                        codex_home.display()
                    )
                })?,
                "Shared backend uses a different Codex home."
            );
        }
        let fresh = inspect(root, policy)?;
        ensure!(
            proof.source.identity == fresh.source.identity
                && proof.source.bytes == fresh.source.bytes
                && proof.endpoint.listener_identity == fresh.endpoint.listener_identity
                && proof.endpoint.socket_identity == fresh.endpoint.socket_identity
                && proof.endpoint.socket_path == fresh.endpoint.socket_path,
            "Shared Codex backend changed during initialization."
        );
        Ok::<_, anyhow::Error>(initialized)
    }
    .await;
    match result {
        Ok(initialized) => Ok(SharedSession {
            client,
            initialized,
            manifest: proof.manifest,
        }),
        Err(error) => {
            client.close().await?;
            Err(error)
        }
    }
}
