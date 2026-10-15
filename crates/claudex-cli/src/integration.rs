//! Native domain composition for the independent collaboration broker.
use crate::native_clients::{Homes, NativeClient};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use claudex_app::{
    warm::WarmSettings,
    warm_runtime::{CacheEnvironment, CacheRuntime},
};
use claudex_sync::codex_wake;
use claudex_work::{Integration, Provider, notifications::NativeDispatchGuard};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Mutex, OnceCell};

const WARM_SETTINGS_KEYS: [&str; 5] = [
    "defaultWarmLimit",
    "cacheTtlPreference",
    "cacheTtlLastChoice",
    "warmOnUserMessage",
    "compactAfterWarm",
];
fn warm_settings(value: &Value) -> Result<WarmSettings> {
    ensure!(value.is_object(), "Cache settings must be an object.");
    let mut settings = json!({});
    for key in WARM_SETTINGS_KEYS {
        if let Some(value) = value.get(key) {
            settings[key] = value.clone();
        }
    }
    let settings: WarmSettings = serde_json::from_value(settings)?;
    settings.validate()?;
    Ok(settings)
}
struct BrokerEnvironment {
    sync_root: PathBuf,
    work_root: PathBuf,
}
#[async_trait]
impl CacheEnvironment for BrokerEnvironment {
    async fn settings(&self) -> Result<WarmSettings> {
        claudex_app::platform::directory(&self.work_root, true, false)?;
        let value = claudex_app::platform::optional_json(
            &self.work_root.join("work.json"),
            32 * 1024 * 1024,
            true,
        )?
        .unwrap_or_else(|| json!({}));
        warm_settings(&value)
    }
    async fn stopped(&self) -> Result<bool> {
        claudex_sync::hooks::app_stopped(&self.sync_root)
    }
}

struct PreparedWake {
    session: String,
    created: Instant,
    handle: codex_wake::Handle,
}
pub struct NativeIntegration {
    pub root: PathBuf,
    pub homes: Homes,
    prepared: Arc<Mutex<BTreeMap<String, PreparedWake>>>,
    closed: AtomicBool,
    owner_wake: claudex_sync::owner_wake::Publisher,
    work_root: PathBuf,
    cache: OnceCell<CacheRuntime>,
}
impl NativeIntegration {
    pub fn new(root: PathBuf, homes: Homes) -> Self {
        let work_root = root.join("collaboration");
        Self::with_work_root(root, work_root, homes)
    }
    pub fn with_work_root(root: PathBuf, work_root: PathBuf, homes: Homes) -> Self {
        Self {
            owner_wake: claudex_sync::owner_wake::Publisher::new(root.clone()),
            root,
            homes,
            prepared: Default::default(),
            closed: AtomicBool::new(false),
            work_root,
            cache: OnceCell::new(),
        }
    }
    async fn discover(&self, params: &Value) -> Result<Vec<Value>> {
        let client = NativeClient::connect(&self.root, &self.homes.codex).await?;
        let result = claudex_sync::native_chat::discover_codex(
            &client,
            params["query"].as_str(),
            params["sessionId"].as_str(),
        )
        .await;
        client.close().await?;
        result.map_err(|error| {
            if error.to_string().starts_with("NATIVE_CHAT_DISCOVERY_INCOMPLETE:") {
                claudex_work::model::error("NATIVE_CHAT_DISCOVERY_INCOMPLETE","Native chat discovery is incomplete; use a longer, more specific title query before sending.")
            }else{error}
        })
    }
    fn admission(&self) -> Result<()> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "Native integration is stopping."
        );
        ensure!(
            !claudex_sync::hooks::app_stopped(&self.root)?,
            "Claudex application is stopped."
        );
        Ok(())
    }
    async fn wake(
        &self,
        params: Value,
        guard: Option<Arc<dyn NativeDispatchGuard>>,
    ) -> Result<Value> {
        self.admission()?;
        if params["provider"] != "codex" {
            return Ok(json!({"status":"unavailable","reason":"claude-renderer-claim-required"}));
        }
        let session = params["sessionId"]
            .as_str()
            .context("An exact native recipient is required.")?;
        match params["action"].as_str() {
            Some("prepare") => {
                // Reserve capacity before opening IPC or navigating an existing
                // conversation. Handles are one-use and expire independently.
                let mut prepared = self.prepared.lock().await;
                prepared.retain(|_, value| {
                    value.created.elapsed() < std::time::Duration::from_secs(30)
                });
                ensure!(
                    prepared.len() < 16,
                    "Native wake preparation capacity exhausted."
                );
                let probe = codex_wake::prepare(&self.homes.codex, session, 1500).await?;
                self.admission()?;
                let Some(handle) = probe.handle else {
                    return Ok(probe.status);
                };
                let token = uuid::Uuid::new_v4().to_string();
                prepared.insert(
                    token.clone(),
                    PreparedWake {
                        session: session.into(),
                        created: Instant::now(),
                        handle,
                    },
                );
                drop(prepared);
                let entries = Arc::downgrade(&self.prepared);
                let expiry = token.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    if let Some(entries) = entries.upgrade() {
                        entries.lock().await.remove(&expiry);
                    }
                });
                let mut result = probe.status;
                result["preparedToken"] = json!(token);
                Ok(result)
            }
            Some("dispatch") => {
                let token = params["prepared"]["preparedToken"]
                    .as_str()
                    .context("Native wake preparation is missing.")?;
                let prepared = self
                    .prepared
                    .lock()
                    .await
                    .remove(token)
                    .context("Native wake preparation was consumed or expired.")?;
                ensure!(
                    prepared.session == session
                        && prepared.created.elapsed() < std::time::Duration::from_secs(30),
                    "Native wake preparation identity changed or expired."
                );
                let message = params["messageId"]
                    .as_str()
                    .context("Native wake message identity missing.")?;
                let context = params["context"]
                    .as_str()
                    .context("Native wake context missing.")?;
                let fence = DispatchFence {
                    root: self.root.clone(),
                    upstream: guard,
                };
                Ok(prepared
                    .handle
                    .dispatch(message, context, Some(&fence))
                    .await)
            }
            _ => bail!("Unsupported native wake action."),
        }
    }
}
struct DispatchFence {
    root: PathBuf,
    upstream: Option<Arc<dyn NativeDispatchGuard>>,
}
#[async_trait]
impl codex_wake::DispatchGuard for DispatchFence {
    async fn check(&self) -> Result<()> {
        ensure!(
            !claudex_sync::hooks::app_stopped(&self.root)?,
            "Claudex application is stopped."
        );
        if let Some(upstream) = &self.upstream {
            upstream.check().await?;
        }
        // app-stop is synchronous and rechecked after the awaited upstream
        // task/revision/expiry fence, immediately before the native IPC write.
        ensure!(
            !claudex_sync::hooks::app_stopped(&self.root)?,
            "Claudex application stopped during native preflight."
        );
        Ok(())
    }
}
#[async_trait]
impl Integration for NativeIntegration {
    async fn start(&self) -> Result<()> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "Native integration is stopping."
        );
        self.cache
            .get_or_try_init(|| {
                CacheRuntime::open_with_root(
                    self.root.clone(),
                    self.work_root.clone(),
                    self.homes.codex.clone(),
                    Arc::new(BrokerEnvironment {
                        sync_root: self.root.clone(),
                        work_root: self.work_root.clone(),
                    }),
                )
            })
            .await?;
        Ok(())
    }
    fn supports(&self, method: &str) -> bool {
        CacheRuntime::supports(method)
            || [
                "native_chat_discovery",
                "chat_titles",
                "mod_target_verify",
                "desktop_wake_verify",
                "desktop_owner_wake",
                "native_chat_wake",
                "notification_preflight",
            ]
            .contains(&method)
    }
    fn origin_available(&self) -> bool {
        true
    }
    async fn origin_verify(&self, params: &Value) -> Result<Value> {
        crate::native_clients::verify_origin(&self.root, &self.homes, params).await
    }
    async fn dispatch(&self, method: &str, _peer: Provider, params: Value) -> Result<Value> {
        match method {
            "desktop_owner_wake" => self.owner_wake.publish(&params).await,
            "native_chat_discovery" => Ok(json!({"chats":self.discover(&params).await?})),
            "chat_titles" => {
                let chats = params["chats"]
                    .as_array()
                    .context("Native chat inventory missing.")?;
                Ok(json!(claudex_sync::native_chat::enrich_titles(
                    chats,
                    &self.homes.codex,
                    &self.homes.desktop_registry
                )?))
            }
            "mod_target_verify" | "desktop_wake_verify" => {
                let id = params["sessionId"]
                    .as_str()
                    .context("Exact Mod target missing.")?;
                claudex_sync::desktop_mapping::verify_claude_target(
                    &self.homes.desktop_registry,
                    id,
                    params["cwd"].as_str(),
                )
            }
            "native_chat_wake" => self.wake(params, None).await,
            "notification_preflight" => {
                let result = |action: &str, reason: &str| json!({"nextAction":action,"reason":reason,"evidence":if action=="await-notification"{json!("native-owner")}else{Value::Null},"route":"native-owner","checkedAt":claudex_core::storage::now_ms(),"diagnosticOnly":true,"deliveryGuaranteed":false});
                let origin = &params["origin"];
                ensure!(
                    origin["provider"] == "codex",
                    "Native owner probe requires a Codex origin."
                );
                let targets = self
                    .discover(&json!({"sessionId":origin["sessionId"]}))
                    .await?;
                if !targets.iter().any(|target| {
                    target["sessionId"] == origin["sessionId"]
                        && target["cwd"] == origin["cwd"]
                        && target["archived"] != true
                }) {
                    return Ok(result("wait", "native-target-unavailable"));
                }
                let id = origin["sessionId"]
                    .as_str()
                    .context("Exact origin missing.")?;
                let probe = codex_wake::preflight(&self.homes.codex, id, 1500).await?;
                if let Some(handle) = probe.handle {
                    handle.close();
                }
                Ok(if probe.status["status"] == "ready" {
                    result("await-notification", "native-owner-observed")
                } else {
                    result("wait", "native-owner-unavailable")
                })
            }
            _ => bail!("Unsupported native integration operation."),
        }
    }
    async fn dispatch_fenced(
        &self,
        method: &str,
        peer: Provider,
        params: Value,
        guard: Arc<dyn NativeDispatchGuard>,
    ) -> Result<Value> {
        if method == "native_chat_wake" {
            self.wake(params, Some(guard)).await
        } else {
            guard.check().await?;
            self.dispatch(method, peer, params).await
        }
    }
    async fn validate_warm_limit(&self, limit: &str) -> Result<String> {
        let settings = WarmSettings {
            default_warm_limit: limit.into(),
            ..Default::default()
        };
        settings.validate()?;
        Ok(settings.default_warm_limit)
    }
    async fn warm_dispatch(
        &self,
        method: &str,
        peer: Provider,
        params: Value,
        settings: Value,
        stopped: bool,
    ) -> Result<Value> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "Native integration is stopping."
        );
        self.cache
            .get()
            .context("Cache-warming service has not started.")?
            .dispatch(
                method,
                peer.as_str(),
                params,
                warm_settings(&settings)?,
                stopped,
            )
            .await
    }
    async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.prepared.lock().await.clear();
        if let Some(cache) = self.cache.get() {
            cache.close().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn scheduler_settings_reload_the_owned_broker_record_without_copying_work_content()
    -> Result<()> {
        let fixture = tempfile::tempdir_in("/tmp")?;
        let root = fixture.path().canonicalize()?;
        let work = claudex_core::storage::private_directory(root.join("custom"))?;
        let environment = BrokerEnvironment {
            sync_root: root,
            work_root: work.clone(),
        };
        claudex_core::storage::write_json(
            work.join("work.json"),
            &json!({
                "defaultWarmLimit":"rounds=2", "warmOnUserMessage":"stop", "compactAfterWarm":false,
                "tasks":{"private":"not cache settings"}, "unknownFutureField":true,
            }),
        )?;
        let settings = environment.settings().await?;
        assert_eq!(settings.default_warm_limit, "rounds=2");
        assert_eq!(settings.warm_on_user_message, "stop");
        assert!(!settings.compact_after_warm);
        assert!(settings.extra.is_empty());
        claudex_core::storage::write_json(
            work.join("work.json"),
            &json!({"defaultWarmLimit":"for=2h"}),
        )?;
        assert_eq!(environment.settings().await?.default_warm_limit, "for=2h");
        std::fs::hard_link(work.join("work.json"), work.join("alias"))?;
        assert!(environment.settings().await.is_err());
        Ok(())
    }
}
