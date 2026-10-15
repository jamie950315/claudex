//! The host Mod's narrow companion uses the ordinary authenticated Rust broker.
use anyhow::Result;
use async_trait::async_trait;
use claudex_app::mod_protocol::ModError;
use claudex_work::{Provider, model::ProtocolError};
use serde_json::Value;
use std::{path::Path, time::Duration};
pub struct BrokerRpc;
pub struct CodexRpc;
fn mod_error(error: anyhow::Error) -> anyhow::Error {
    if let Some(protocol) = error.downcast_ref::<ProtocolError>() {
        return ModError {
            code: protocol.code.clone(),
            message: protocol.message.clone(),
        }
        .into();
    }
    error
}
#[async_trait]
impl claudex_app::mod_bridge::Rpc for BrokerRpc {
    async fn call(
        &self,
        root: &Path,
        method: &str,
        params: Value,
        duration: Duration,
    ) -> Result<Value> {
        call(root, Provider::Claude, method, params, duration).await
    }
}
#[async_trait]
impl claudex_app::mod_bridge::Rpc for CodexRpc {
    async fn call(
        &self,
        root: &Path,
        method: &str,
        params: Value,
        duration: Duration,
    ) -> Result<Value> {
        call(root, Provider::Codex, method, params, duration).await
    }
}
async fn call(
    root: &Path,
    peer: Provider,
    method: &str,
    params: Value,
    duration: Duration,
) -> Result<Value> {
    let token = claudex_work::cli::controller_token(root)?;
    let operation = claudex_work::transport::call(root, peer, &token, method, params);
    match tokio::time::timeout(duration,operation).await {
            Ok(result)=>result.map_err(mod_error),
            Err(_)=>Err(ModError{code:"COMPANION_UNAVAILABLE".into(),message:"The broker response deadline expired. Preserve the action receipt; do not replay uncertain work.".into()}.into()),
        }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_domain_refusals_survive_the_companion_boundary() {
        for code in [
            "MOD_TARGET_UNAVAILABLE",
            "NATIVE_CHAT_DISCOVERY_INCOMPLETE",
            "ARTIFACT_UNAVAILABLE",
        ] {
            let error = mod_error(claudex_work::model::error(code, "Exact target refused."));
            let error = error.downcast_ref::<ModError>().unwrap();
            assert_eq!(error.code, code);
            assert_eq!(error.message, "Exact target refused.");
        }
    }
}
