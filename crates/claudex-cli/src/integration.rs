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
                "local_start_claim",
                "local_start_receipt",
                "local_activation_claim",
                "local_activation_receipt",
                "local_adoption_claim",
                "local_adoption_receipt",
                "local_sync_claim",
                "local_sync_receipt",
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
    async fn dispatch(&self, method: &str, peer: Provider, params: Value) -> Result<Value> {
        match method {
            "local_start_claim" | "local_start_receipt" => {
                ensure!(
                    peer == Provider::Claude && !self.closed.load(Ordering::Acquire),
                    "Native Local creation requires the active Claude peer."
                );
                if method == "local_start_claim" {
                    claudex_sync::local_start::claim(
                        &self.root,
                        &self.homes.desktop_registry,
                        &params,
                    )
                } else {
                    claudex_sync::local_start::receipt(&self.root, &params)
                }
            }
            "local_activation_claim" | "local_activation_receipt" => {
                ensure!(
                    peer == Provider::Claude && !self.closed.load(Ordering::SeqCst),
                    "Native activation requires the active Claude peer."
                );
                if method == "local_activation_claim" {
                    claudex_sync::local_adoption::activation_claim(
                        &self.root,
                        &self.homes.desktop_registry,
                        &params,
                    )
                } else {
                    claudex_sync::local_adoption::activation_receipt(&self.root, &params)
                }
            }
            "local_adoption_claim" | "local_adoption_receipt" => {
                ensure!(
                    peer == Provider::Claude && !self.closed.load(Ordering::Acquire),
                    "Native Local adoption endpoint unavailable."
                );
                if method == "local_adoption_claim" {
                    claudex_sync::local_adoption::claim(
                        &self.root,
                        &self.homes.desktop_registry,
                        &params,
                    )
                } else {
                    claudex_sync::local_adoption::receipt(&self.root, &params)
                }
            }
            "local_sync_claim" | "local_sync_receipt" => {
                ensure!(
                    peer == Provider::Claude && !self.closed.load(Ordering::Acquire),
                    "Native Local synchronization endpoint unavailable."
                );
                if method == "local_sync_claim" {
                    claudex_sync::local_sync::claim(
                        &self.root,
                        &self.homes.desktop_registry,
                        &params,
                    )
                } else {
                    claudex_sync::local_sync::receipt(&self.root, &params)
                }
            }
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
    #[tokio::test]
    async fn local_sync_claim_and_receipt_cross_actual_unix_rpc_once() -> Result<()> {
        use claudex_work::{
            Broker, Config, Invocation, NativeFailure, NativeResult, NativeRunner, transport,
        };
        struct NoQuery;
        #[async_trait]
        impl NativeRunner for NoQuery {
            async fn run(
                &self,
                _: Invocation,
                _: tokio::sync::mpsc::Sender<Value>,
            ) -> std::result::Result<NativeResult, NativeFailure> {
                panic!("Local synchronization must not invoke a model")
            }
        }
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = temp.path().canonicalize()?;
        claudex_core::storage::private_directory(&root)?;
        let codex = claudex_core::storage::private_directory(root.join("codex"))?;
        let claude = claudex_core::storage::private_directory(root.join("claude"))?;
        let registry = claudex_core::storage::private_directory(root.join("registry"))?;
        let cwd = claudex_core::storage::private_directory(root.join("project"))?;
        let session = uuid::Uuid::new_v4().to_string();
        let op = uuid::Uuid::new_v4().to_string();
        let conversation = uuid::Uuid::new_v4().to_string();
        let local = format!("local_{}", uuid::Uuid::new_v4());
        let registry_file = registry.join(format!("{local}.json"));
        claudex_core::storage::write_json(
            &registry_file,
            &json!({"sessionId":local,"cliSessionId":session,"cwd":cwd,"title":"Fixture","isArchived":false,"lastActivityAt":0}),
        )?;
        claudex_core::storage::private_directory(root.join("owners"))?;
        claudex_core::storage::write_json(
            root.join("owners").join(format!(
                "{}.json",
                claudex_sync::history::digest_bytes(conversation.as_bytes())
            )),
            &json!({"sessionId":session,"conversationId":conversation,"cwd":cwd,"transport":"local-mod","localPhase":"handoff-sent","remoteId":null,"pending":null,"reset":null}),
        )?;
        claudex_core::storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":{"operationId":op,"record":{"nativeId":session,"conversationId":conversation}}}),
        )?;
        let dir = claudex_core::storage::private_directory(root.join("local-sync").join(&op))?;
        let entry = json!({"opId":op,"conversationId":conversation,"localSessionId":local,"cliSessionId":session,"cwd":cwd,"title":"Fixture","command":"claudex-sync","args":op,"inputUuid":claudex_sync::owner::append_uuid(&session,&op),"expiresAt":claudex_core::storage::now_ms()+600000,"registryPath":registry_file,"images":[]});
        claudex_core::storage::write_json(
            dir.join("operation.json"),
            &json!({"version":1,"opId":op,"sourceOperationId":op,"conversationId":conversation,"cliSessionId":session,"cwd":cwd,"kind":"adopt","entry":entry,"content":[],"claim":null,"received":false,"applied":null}),
        )?;
        let integration = Arc::new(NativeIntegration::new(
            root.clone(),
            Homes {
                codex,
                claude,
                desktop_registry: registry,
            },
        ));
        let b = Broker::open_with_integration(
            root.join("collaboration"),
            Config::default(),
            Arc::new(NoQuery),
            integration,
        )
        .await?;
        let server = transport::serve(b.clone()).await?;
        let params = json!({"opId":op,"localSessionId":local,"cliSessionId":session,"cwd":cwd});
        assert_eq!(
            transport::validate_tool("claudex_local_sync_claim", &params, true)?,
            "local_sync_claim"
        );
        assert!(transport::validate_tool("claudex_local_sync_claim", &params, false).is_err());
        assert!(
            transport::call(
                &b.root,
                Provider::Codex,
                b.controller_token(),
                "local_sync_claim",
                params.clone()
            )
            .await
            .is_err()
        );
        let claim = transport::call(
            &b.root,
            Provider::Claude,
            b.controller_token(),
            "local_sync_claim",
            params.clone(),
        )
        .await?;
        assert_eq!(claim["ready"], true);
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_sync_claim",
                params.clone()
            )
            .await?["ready"],
            false
        );
        let mut receipt = params;
        receipt["claimId"] = claim["claimId"].clone();
        receipt["outcome"] = json!("unknown");
        receipt["detail"] = json!("native-send-unknown");
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_sync_receipt",
                receipt
            )
            .await?["recorded"],
            true
        );
        // The unowned seed uses the attached Claude peer, not a borrowed Local
        // session. The actual broker socket preserves its one-use journal.
        let session2 = uuid::Uuid::new_v4().to_string();
        let source_op = uuid::Uuid::new_v4().to_string();
        let resume_op =
            claudex_sync::owner::append_uuid(&session2, &format!("native-resume:{source_op}"));
        let seed_id = claudex_sync::owner::append_uuid(&session2, &source_op);
        let content = json!([{"type":"text","text":"Synthetic resume seed"}]);
        let transcript = root.join("seed.jsonl");
        claudex_core::storage::atomic_write(
            &transcript,
            format!(
                "{}\n",
                serde_json::to_string(
                    &json!({"uuid":seed_id,"type":"user","sessionId":session2,"queueTranscriptOnly":true,"message":{"role":"user","content":content}})
                )?
            ),
        )?;
        claudex_core::storage::write_json(
            root.join("owners").join(format!(
                "{}.json",
                claudex_sync::history::digest_bytes(conversation.as_bytes())
            )),
            &json!({"sessionId":session2,"conversationId":conversation,"cwd":cwd,"transport":"local-mod","localPhase":"handoff-intent","remoteId":null,"pending":null,"reset":null,"lastAppend":{"operationId":source_op,"uuid":seed_id,"contentHash":claudex_core::storage::hash_json(&content)?,"content":content}}),
        )?;
        claudex_core::storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":{"operationId":source_op,"record":{"nativeId":session2,"conversationId":conversation,"cwd":cwd,"path":transcript}}}),
        )?;
        let adoption = claudex_core::storage::private_directory(root.join("local-adoption"))?;
        claudex_core::storage::write_json(
            adoption.join(format!("{resume_op}.json")),
            &json!({"version":1,"entry":{"opId":resume_op,"sourceOperationId":source_op,"conversationId":conversation,"cliSessionId":session2,"cwd":cwd,"seedUuid":seed_id,"seedContentDigest":claudex_core::storage::hash_json(&content)?,"expiresAt":claudex_core::storage::now_ms()+600000},"seedIdentity":claudex_core::storage::snapshot(&transcript)?.file_identity,"seedOwnerHash":claudex_core::storage::hash_json(&content)?,"claim":null,"activation":null}),
        )?;
        let p = json!({"opId":resume_op,"handle":uuid::Uuid::new_v4().to_string(),"cwd":cwd,"seedUuid":seed_id,"seedContentDigest":claudex_core::storage::hash_json(&content)?,"resumable":true});
        assert_eq!(
            transport::validate_tool("claudex_local_adoption_claim", &p, true)?,
            "local_adoption_claim"
        );
        assert!(transport::validate_tool("claudex_local_adoption_claim", &p, false).is_err());
        let claim = transport::call(
            &b.root,
            Provider::Claude,
            b.controller_token(),
            "local_adoption_claim",
            p.clone(),
        )
        .await?;
        assert_eq!(claim["ready"], true);
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_adoption_claim",
                p
            )
            .await?["ready"],
            false
        );
        assert_eq!(transport::call(&b.root,Provider::Claude,b.controller_token(),"local_adoption_receipt",json!({"opId":resume_op,"claimId":claim["claimId"],"outcome":"unknown","localSessionId":null,"reason":null})).await?["recorded"],true);
        let local2 = format!("local_{session2}");
        let registry2 = root.join("registry").join(format!("{local2}.json"));
        claudex_core::storage::write_json(
            &registry2,
            &json!({"sessionId":local2,"cliSessionId":session2,"cwd":cwd,"title":"Resume fixture","isArchived":false,"lastActivityAt":1}),
        )?;
        let activation = json!({"opId":resume_op,"sourceOperationId":source_op,"conversationId":conversation,"cliSessionId":session2,"seedUuid":seed_id,"seedContentDigest":claudex_core::storage::hash_json(&content)?,"action":"activate","localSessionId":local2,"cwd":cwd,"title":"Resume fixture","registryPath":registry2,"lastActivityAt":1,"expiresAt":claudex_core::storage::now_ms()+600000});
        claudex_core::storage::write_json(
            root.join("local-adoption-manifest.json"),
            &json!({"version":1,"entries":[activation]}),
        )?;
        let p = json!({"opId":resume_op,"localSessionId":local2,"lastActivityAt":1});
        assert_eq!(
            transport::validate_tool("claudex_local_activation_claim", &p, true)?,
            "local_activation_claim"
        );
        let claim = transport::call(
            &b.root,
            Provider::Claude,
            b.controller_token(),
            "local_activation_claim",
            p.clone(),
        )
        .await?;
        assert_eq!(claim["ready"], true);
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_activation_claim",
                p
            )
            .await?["ready"],
            false
        );
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_activation_receipt",
                json!({"opId":resume_op,"claimId":claim["claimId"],"outcome":"unknown"})
            )
            .await?["recorded"],
            true
        );
        // Fresh native Local creation uses the same actual socket, never a
        // model invocation or another Local session's client.
        let fresh_op = uuid::Uuid::new_v4().to_string();
        let fresh_session = uuid::Uuid::new_v4().to_string();
        let fresh_owner = json!({"version":1,"sessionId":fresh_session,"conversationId":conversation,"claudeHome":root.join("claude"),"cwd":cwd,"transport":"local-mod","localPhase":"native-start","pending":null,"remoteId":null,"reset":null,"lastAppend":null,"displayTitle":"Fixture"});
        let mut fresh_record = claudex_sync::desktop::Record::source(
            claudex_sync::bridge::Side::Claude,
            &root.join("absent.jsonl"),
            &fresh_session,
        );
        fresh_record.conversation_id = conversation.clone();
        fresh_record.cwd = cwd.to_string_lossy().into();
        fresh_record.managed = true;
        fresh_record.kind = "owner".into();
        let fresh_pending = claudex_sync::desktop::Pending {
            phase: claudex_sync::desktop::Phase::Prepared,
            operation_id: fresh_op.clone(),
            record: fresh_record.clone(),
            source_id: uuid::Uuid::new_v4().to_string(),
            target_id: None,
            archive_original_id: None,
            reuse: false,
            common: claudex_sync::history::Common {
                meta: Default::default(),
                messages: vec![],
                extra: Default::default(),
            },
            checkpoint: Default::default(),
            previous: Default::default(),
            extra: Default::default(),
        };
        claudex_core::storage::write_json(
            root.join("owners").join(format!(
                "{}.json",
                claudex_sync::history::digest_bytes(conversation.as_bytes())
            )),
            &fresh_owner,
        )?;
        claudex_core::storage::write_json(
            root.join("desktop-state.json"),
            &json!({"version":2,"pending":fresh_pending}),
        )?;
        assert!(
            claudex_sync::local_start::prepare(
                &root,
                &root.join("registry"),
                &fresh_owner,
                &fresh_record,
                &fresh_pending
            )?
            .is_none()
        );
        let before = claudex_core::storage::read_json(root.join("local-start-manifest.json"))?;
        let p = json!({"opId":fresh_op,"stage":"prewarm","proof":{}});
        assert_eq!(
            transport::validate_tool("claudex_local_start_claim", &p, true)?,
            "local_start_claim"
        );
        assert!(transport::validate_tool("claudex_local_start_claim", &p, false).is_err());
        assert!(
            transport::call(
                &b.root,
                Provider::Codex,
                b.controller_token(),
                "local_start_claim",
                p.clone()
            )
            .await
            .is_err()
        );
        let c = transport::call(
            &b.root,
            Provider::Claude,
            b.controller_token(),
            "local_start_claim",
            p.clone(),
        )
        .await?;
        assert_eq!(c["ready"], true);
        assert_eq!(
            before,
            claudex_core::storage::read_json(root.join("local-start-manifest.json"))?
        );
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_start_claim",
                p
            )
            .await?["ready"],
            false
        );
        let receipt = json!({"opId":fresh_op,"stage":"prewarm","claimId":c["claimId"],"outcome":"unknown","result":null});
        assert_eq!(
            transport::validate_tool("claudex_local_start_receipt", &receipt, true)?,
            "local_start_receipt"
        );
        assert_eq!(
            transport::call(
                &b.root,
                Provider::Claude,
                b.controller_token(),
                "local_start_receipt",
                receipt
            )
            .await?["recorded"],
            true
        );
        assert_eq!(
            claudex_core::storage::read_json(root.join("local-start-manifest.json"))?["entries"],
            json!([])
        );
        b.close().await?;
        server.close().await?;
        Ok(())
    }
}
