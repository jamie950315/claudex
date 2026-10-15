//! Broker-owned renderer metadata. Publication never invokes a native sender.
use crate::{Broker, Provider, model::*};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::atomic::Ordering};

const MAX_MESSAGES: usize = 64;
const MAX_BYTES: usize = 240 * 1024;
const ROTATION_MS: u64 = 5000;

#[derive(Default)]
pub(crate) struct Publication {
    source: Option<Vec<Value>>,
    next_message: Option<String>,
    next_at: Option<u64>,
}
fn renderer_message(m: &Value) -> bool {
    m["targetProvider"] == "claude"
        && m["state"] == "queued"
        && m["wakeRequested"] == true
        && !matches!(m["wakeRoute"].as_str(), Some("mod" | "mod-self"))
}
fn serialized(v: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(v)?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn descriptor(v: Value) -> Result<Value> {
    text(&v["localSessionId"], "Desktop local session ID", 256)?;
    text(&v["title"], "Desktop title", 64 * 1024)?;
    for k in ["cwd", "registryPath"] {
        if !Path::new(text(&v[k], k, 16 * 1024)?).is_absolute() {
            bail!("Desktop renderer metadata requires exact absolute paths.");
        }
    }
    if v["archived"] == true || v["isArchived"] == true {
        bail!("Exact Claude Desktop chat is archived.");
    }
    Ok(
        json!({"localSessionId":v["localSessionId"],"cwd":v["cwd"],"title":v["title"],"registryPath":v["registryPath"]}),
    )
}
impl Broker {
    pub(crate) fn renderer_manifest(&self) -> Value {
        self.wake_diagnostics.lock().unwrap().clone()
    }
    pub(crate) fn suspend_renderer_manifest(&self) {
        self.wake_epoch.fetch_add(1, Ordering::AcqRel);
        if self.integration.supports("desktop_wake_verify") {
            *self.wake_diagnostics.lock().unwrap() = json!({"state":"held","reason":"app-stopped-or-publication-stale","code":"CLAUDEX_WAKE_PUBLICATION_HELD"});
        }
    }
    pub(crate) async fn refresh_renderer_manifest(&self) -> Option<u64> {
        if !self.integration.supports("desktop_wake_verify") {
            return None;
        }
        let mut publication = self.wake_manifest.lock().await;
        if self.notification_stopped().unwrap_or(true) {
            publication.source = None;
            publication.next_at = None;
            self.suspend_renderer_manifest();
            return None;
        }
        let epoch = self.wake_epoch.load(Ordering::Acquire);
        let outcome = async {
            let pending = self.mailbox.pending_wakes()?.into_iter()
                .filter(renderer_message).collect::<Vec<_>>();
            let source = pending.iter().map(|m| json!({"messageId":m["messageId"],"sessionId":m["targetSessionId"],"expiresAt":m["expiresAt"]})).collect::<Vec<_>>();
            if publication.source.as_ref() == Some(&source)
                && publication.next_at.is_none_or(|at| at > now()) {
                return Ok::<_, anyhow::Error>(publication.next_at);
            }
            let mut native = BTreeMap::new();
            for m in &pending {
                let id = text(&m["targetSessionId"], "native session ID", 128)?;
                if !native.contains_key(id) {
                    let value = self.integration.dispatch("desktop_wake_verify", Provider::Claude,
                        json!({"sessionId":id})).await?;
                    // A verifier can explicitly report an absent/archived mapping;
                    // malformed or unsafe metadata remains a publication failure.
                    if value["available"] == false {
                        native.insert(id.to_string(), None);
                    } else {
                        native.insert(id.to_string(), Some(descriptor(value)?));
                    }
                }
            }
            let result = self.mailbox.transaction(true, |state, at| {
                let queued = array(&state["messages"]).into_iter()
                    .filter(|m| renderer_message(m) && m["expiresAt"].as_u64().unwrap_or(0) > at)
                    .collect::<Vec<_>>();
                let current = pending.iter().filter_map(|m| {
                    let exact = queued.iter().any(|q| q["messageId"] == m["messageId"]
                        && q["targetSessionId"] == m["targetSessionId"] && q["expiresAt"] == m["expiresAt"]);
                    if !exact { return None; }
                    let d = native.get(m["targetSessionId"].as_str()?)?.as_ref()?;
                    let mut v = d.clone();
                    for (k, from) in [("messageId", "messageId"),("sessionId", "targetSessionId"),("expiresAt", "expiresAt")] { v[k] = m[from].clone(); }
                    Some(v)
                }).collect::<Vec<_>>();
                let total = queued.len();
                let eligible = current.len();
                let expiry = queued.iter().filter_map(|m| m["expiresAt"].as_u64()).min();
                let metadata = |count: usize| json!({"count":count,"total":total,"eligible":eligible,"omitted":total-count,"unavailable":total-eligible,"byteLimit":MAX_BYTES,
                    "nextPublicationAt":expiry.map(|expiry| if total>count {expiry.min(at+ROTATION_MS)}else{expiry})});
                let snapshot = |messages: &Vec<Value>| { let mut v=metadata(messages.len());v["version"]=json!(1);v["messages"]=json!(messages);v };
                let start = publication.next_message.as_ref().and_then(|id| current.iter().position(|m| m["messageId"] == *id)).unwrap_or(0);
                let mut messages = vec![];
                let mut deferred = None;
                for candidate in current[start..].iter().chain(current[..start].iter()) {
                    if messages.len() >= MAX_MESSAGES { deferred.get_or_insert_with(|| candidate["messageId"].as_str().unwrap().to_string());break; }
                    let mut projected = messages.clone();projected.push(candidate.clone());
                    if serialized(&snapshot(&projected))?.len() <= MAX_BYTES { messages.push(candidate.clone()); }
                    else if serialized(&snapshot(&vec![candidate.clone()]))?.len() <= MAX_BYTES { deferred.get_or_insert_with(|| candidate["messageId"].as_str().unwrap().to_string()); }
                }
                // Retention, queue claims and this final epoch/stop fence share
                // the mailbox lock after every awaited native metadata read.
                if self.notification_stopped()? || epoch != self.wake_epoch.load(Ordering::Acquire) {
                    return Err(error("CLAUDEX_WAKE_PUBLICATION_HELD", "Renderer wake publication is held."));
                }
                let bytes = serialized(&snapshot(&messages))?;
                claudex_core::storage::atomic_write(self.mailbox.root.join("wake-manifest.json"), &bytes)?;
                publication.next_message = deferred;
                let mut diagnostic = metadata(messages.len());
                diagnostic["bytes"]=json!(bytes.len());diagnostic["state"]=json!("published");
                Ok(diagnostic)
            })?;
            publication.source=Some(source);
            publication.next_at=result["nextPublicationAt"].as_u64();
            *self.wake_diagnostics.lock().unwrap()=result;
            Ok(publication.next_at)
        }.await;
        match outcome {
            Ok(next) => next,
            Err(e) => {
                let held = e
                    .downcast_ref::<ProtocolError>()
                    .is_some_and(|e| e.code == "CLAUDEX_WAKE_PUBLICATION_HELD");
                *self.wake_diagnostics.lock().unwrap() = json!({"state":if held{"held"}else{"unavailable"},"reason":if held{"app-stopped-or-publication-stale"}else{"manifest-publication-failed"},"code":if held{"CLAUDEX_WAKE_PUBLICATION_HELD"}else{"CLAUDEX_WAKE_PUBLICATION_FAILED"}});
                publication.source = None;
                publication.next_at = None;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Integration, test_support};
    use async_trait::async_trait;
    use claudex_core::storage;
    use std::{
        collections::BTreeSet,
        sync::{Arc, atomic::AtomicBool},
    };
    use tokio::sync::Semaphore;
    struct Metadata {
        pause: AtomicBool,
        entered: Semaphore,
        release: Semaphore,
        title: String,
    }
    impl Metadata {
        fn new() -> Self {
            Self {
                pause: AtomicBool::new(false),
                entered: Semaphore::new(0),
                release: Semaphore::new(0),
                title: "Synthetic native title".into(),
            }
        }
    }
    #[async_trait]
    impl Integration for Metadata {
        fn supports(&self, method: &str) -> bool {
            method == "desktop_wake_verify"
        }
        async fn dispatch(&self, method: &str, _peer: Provider, p: Value) -> Result<Value> {
            assert_eq!(method, "desktop_wake_verify");
            if self.pause.load(Ordering::Acquire) {
                self.entered.add_permits(1);
                self.release.acquire().await?.forget();
            }
            Ok(
                json!({"localSessionId":format!("local-{}",p["sessionId"].as_str().unwrap()),"cwd":"/fixture/project","registryPath":"/fixture/registry","title":self.title}),
            )
        }
    }
    fn enqueue(b: &Broker, index: usize) -> Result<Value> {
        let session = format!("native-{index}");
        b.mailbox.hook(
            Provider::Claude,
            &session,
            Path::new("/fixture/project"),
            "SessionStart",
            false,
            "",
        )?;
        b.mailbox.send(&json!({"fromProvider":"codex","targetProvider":"claude","targetSessionId":session,"message":"Synthetic peer message","requestId":format!("request-{index}"),"wakeRequested":true,"wakeRoute":"renderer"}),None)
    }
    fn manifest(b: &Broker) -> Result<Value> {
        storage::read_json(b.mailbox.root.join("wake-manifest.json"))
    }
    #[tokio::test]
    async fn bounded_renderer_publication_rotates_every_omitted_recipient() -> Result<()> {
        let (_temp, b) = test_support::broker(Arc::new(Metadata::new())).await?;
        let mut expected = BTreeSet::new();
        for i in 0..65 {
            expected.insert(enqueue(&b, i)?["messageId"].as_str().unwrap().to_owned());
        }
        assert!(b.refresh_renderer_manifest().await.is_some());
        let first = manifest(&b)?;
        assert_eq!(first["count"], 64);
        assert_eq!(first["omitted"], 1);
        assert_eq!(first["eligible"], 65);
        let mut seen = array(&first["messages"])
            .iter()
            .map(|m| m["messageId"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        b.wake_manifest.lock().await.next_at = Some(0);
        b.refresh_renderer_manifest().await;
        let second = manifest(&b)?;
        seen.extend(
            array(&second["messages"])
                .iter()
                .map(|m| m["messageId"].as_str().unwrap().to_owned()),
        );
        assert_eq!(seen, expected);
        assert!(b.renderer_manifest()["bytes"].as_u64().unwrap() <= MAX_BYTES as u64);
        b.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn serialized_byte_capacity_still_rotates_large_native_metadata() -> Result<()> {
        let mut metadata = Metadata::new();
        metadata.title = "x".repeat(64 * 1024);
        let (_temp, b) = test_support::broker(Arc::new(metadata)).await?;
        let mut expected = BTreeSet::new();
        for i in 0..5 {
            expected.insert(enqueue(&b, i)?["messageId"].as_str().unwrap().to_owned());
        }
        let mut seen = BTreeSet::new();
        for _ in 0..2 {
            b.wake_manifest.lock().await.next_at = Some(0);
            b.refresh_renderer_manifest().await;
            let v = manifest(&b)?;
            assert!(serialized(&v)?.len() <= MAX_BYTES);
            assert!(v["count"].as_u64().unwrap() < 5);
            seen.extend(
                array(&v["messages"])
                    .iter()
                    .map(|m| m["messageId"].as_str().unwrap().to_owned()),
            );
        }
        assert_eq!(seen, expected);
        b.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn awaited_metadata_cannot_republish_an_acknowledged_message() -> Result<()> {
        let integration = Arc::new(Metadata::new());
        integration.pause.store(true, Ordering::Release);
        let (_temp, b) = test_support::broker(integration.clone()).await?;
        let sent = enqueue(&b, 0)?;
        let publish = tokio::spawn({
            let b = b.clone();
            async move { b.refresh_renderer_manifest().await }
        });
        integration.entered.acquire().await?.forget();
        b.mailbox.hook(
            Provider::Claude,
            "native-0",
            Path::new("/fixture/project"),
            "Stop",
            false,
            "",
        )?;
        b.mailbox.hook(
            Provider::Claude,
            "native-0",
            Path::new("/fixture/project"),
            "Stop",
            true,
            &format!("CLAUDEX_ACK:{}", sent["messageId"].as_str().unwrap()),
        )?;
        integration.release.add_permits(1);
        publish.await?;
        assert_eq!(manifest(&b)?["count"], 0);
        assert_eq!(
            b.mailbox.status(sent["messageId"].as_str().unwrap())?["state"],
            "acknowledged"
        );
        b.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn app_stop_fences_publication_after_awaited_metadata() -> Result<()> {
        let integration = Arc::new(Metadata::new());
        integration.pause.store(true, Ordering::Release);
        let (_temp, b) = test_support::broker(integration.clone()).await?;
        enqueue(&b, 0)?;
        let publish = tokio::spawn({
            let b = b.clone();
            async move { b.refresh_renderer_manifest().await }
        });
        integration.entered.acquire().await?.forget();
        storage::write_json(
            b.root.parent().unwrap().join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        integration.release.add_permits(1);
        assert_eq!(publish.await?, None);
        assert_eq!(b.renderer_manifest()["state"], "held");
        assert!(!b.mailbox.root.join("wake-manifest.json").exists());
        b.close().await?;
        Ok(())
    }
}
