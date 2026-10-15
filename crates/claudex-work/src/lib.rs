//! Native collaboration broker, private MCP transport and account-backed workers.
pub mod activity;
pub mod archive;
pub mod artifact;
pub mod broker;
pub mod cli;
mod desktop_install;
pub mod events;
pub mod hooks;
pub mod install;
pub mod mailbox;
pub mod mod_wake;
pub mod model;
pub mod native;
pub mod notifications;
pub mod origin;
pub mod outcome;
pub mod processes;
pub mod progress;
pub mod transport;
mod wake_manifest;
mod warm;
mod watcher;
pub mod workspace;

pub use broker::{Broker, Integration, NoIntegration};
pub use cli::{run, run_with_integration};
pub use model::{Config, Envelope, Permission, Provider};
pub use native::{Invocation, NativeCliRunner, NativeFailure, NativeResult, NativeRunner};
pub use transport::call;

#[cfg(test)]
mod test_support {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    pub struct Synthetic;
    #[async_trait]
    impl NativeRunner for Synthetic {
        async fn run(
            &self,
            _invocation: Invocation,
            _events: mpsc::Sender<Value>,
        ) -> std::result::Result<NativeResult, NativeFailure> {
            Ok(NativeResult {
                text: "Synthetic result".into(),
                session_id: Some("synthetic".into()),
                usage: None,
                activity: None,
            })
        }
    }
    pub async fn broker(
        integration: Arc<dyn Integration>,
    ) -> Result<(tempfile::TempDir, Arc<Broker>)> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().canonicalize()?.join("work");
        let broker = Broker::open_with_integration(
            root,
            Config::default(),
            Arc::new(Synthetic),
            integration,
        )
        .await?;
        // Tests explicitly drive the publisher and do not depend on timer ordering.
        if let Some(task) = broker.notification_task.lock().unwrap().take() {
            task.abort();
        }
        Ok((temp, broker))
    }
    pub fn request(b: &Broker, method: &str, params: Value) -> Envelope {
        Envelope {
            peer: Provider::Codex,
            token: b.controller_token().into(),
            method: method.into(),
            params,
        }
    }
}
