//! Durable write-ahead notification intents, independent quotas and absolute fences.
use crate::{Broker, Provider, hooks, model::*};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Weak, atomic::Ordering};

#[async_trait]
pub trait NativeDispatchGuard: Send + Sync {
    async fn check(&self) -> Result<()>;
}
struct Fence {
    broker: Weak<Broker>,
    intent: Value,
}
#[async_trait]
impl NativeDispatchGuard for Fence {
    async fn check(&self) -> Result<()> {
        let b = self.broker.upgrade().ok_or_else(|| {
            error(
                "CLAUDEX_NOTIFICATION_STOPPED",
                "Notification broker stopped.",
            )
        })?;
        b.notification_fence(&self.intent).await
    }
}

pub(crate) fn target(t: &Value) -> Option<Value> {
    let n = &t["notification"];
    if !n["origin"].is_object() {
        return None;
    }
    if terminal(&t["status"]) {
        if n["suppressedRevision"] == t["revision"]
            || array(&n["deliveries"]).iter().any(|d| {
                d["kind"].as_str().unwrap_or("terminal") == "terminal"
                    && d["revision"] == t["revision"]
            })
        {
            return None;
        }
        return Some(
            json!({"kind":"terminal","revision":t["revision"],"generation":t["generation"],"at":t["updatedAt"]}),
        );
    }
    if t["observability"]["blockerNotifications"] != true || !t["parentId"].is_null() {
        return None;
    }
    array(&t["blockers"]).into_iter().find(|b|b["state"]=="open"&&b["generation"]==t["generation"]
        &&n["suppressedBlockers"][format!("{}:{}",b["generation"],b["id"].as_str().unwrap_or(""))]!=b["revision"]
        &&!array(&n["deliveries"]).iter().any(|d|d["kind"]=="blocker"&&d["blockerId"]==b["id"]&&d["generation"]==b["generation"]&&d["blockerRevision"]==b["revision"]))
        .map(|b|json!({"kind":"blocker","revision":t["revision"],"generation":b["generation"],"blockerId":b["id"],"blockerRevision":b["revision"],"at":b["updatedAt"]}))
}
pub(crate) fn quota(s: &Value, n: &Value, at: u64, kind: &str) -> Option<Value> {
    let in_window = |d: &&Value| {
        d["kind"].as_str().unwrap_or("terminal") == kind
            && d["createdAt"].as_u64().unwrap_or(0) > at.saturating_sub(60000)
    };
    let own = array(&n["deliveries"]);
    let own = own.iter().filter(in_window).collect::<Vec<_>>();
    let all = s["tasks"]
        .as_object()
        .unwrap()
        .values()
        .filter(|t| {
            t["notification"]["origin"]["provider"] == n["origin"]["provider"]
                && t["notification"]["origin"]["sessionId"] == n["origin"]["sessionId"]
        })
        .flat_map(|t| array(&t["notification"]["deliveries"]))
        .collect::<Vec<_>>();
    let all = all.iter().filter(in_window).collect::<Vec<_>>();
    let (reason, values) = if own.len() >= 16 {
        ("task-notification-limit", own)
    } else if all.len() >= 16 {
        ("origin-rate-limit", all)
    } else {
        return None;
    };
    let mut times = values
        .iter()
        .filter_map(|d| d["createdAt"].as_u64())
        .collect::<Vec<_>>();
    times.sort_unstable();
    Some(json!({"reason":reason,"retryAt":times[times.len()-16]+60000}))
}
fn same_origin(a: &Value, b: &Value) -> bool {
    ["provider", "sessionId", "cwd", "toolUseId", "turnId"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
/// Undo only the empty object inserted by the old startup IndexMut lookup.
/// A notification-bearing creation receipt contradicts that provenance and must
/// keep failing validation. The caller validates the complete corrected ledger
/// and preserves its original bytes before publishing any recovery.
pub(crate) fn recover_empty_placeholders(s: &mut Value) -> bool {
    let notified = s["requests"]
        .as_object()
        .into_iter()
        .flat_map(|requests| requests.values())
        .filter_map(|r| {
            let result = &r["result"];
            [
                "originChallenge",
                "originChallengeExpiresAt",
                "notificationMode",
            ]
            .iter()
            .any(|k| result.get(*k).is_some())
            .then(|| result["taskId"].as_str().map(str::to_owned))
            .flatten()
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut recovered = false;
    if let Some(tasks) = s.get_mut("tasks").and_then(Value::as_object_mut) {
        for (id, task) in tasks {
            if !notified.contains(id)
                && task
                    .get("notification")
                    .and_then(Value::as_object)
                    .is_some_and(|n| {
                        n.len() == 1 && n.get("deliveries").is_some_and(Value::is_null)
                    })
            {
                task.as_object_mut().unwrap().remove("notification");
                recovered = true;
            }
        }
    }
    recovered
}
pub(crate) fn validate_task(t: &Value, requests: &Value) -> Result<()> {
    let Some(n) = t.get("notification") else {
        return Ok(());
    };
    let invalid = || {
        error(
            "CLAUDEX_NOTIFICATION_STORAGE",
            "Malformed notification evidence was preserved.",
        )
    };
    let uuid = |v: &Value| {
        v.as_str()
            .is_some_and(|s| s.len() == 36 && uuid::Uuid::parse_str(s).is_ok())
    };
    let origin = |v: &Value| {
        uuid(&v["sessionId"])
            && matches!(v["provider"].as_str(), Some("codex" | "claude"))
            && v["cwd"]
                .as_str()
                .is_some_and(|s| std::path::Path::new(s).is_absolute())
            && v["toolUseId"].is_string()
    };
    let policy = &n["policy"];
    if !n.is_object()
        || !t["parentId"].is_null()
        || !matches!(policy["mode"].as_str(), Some("queue" | "wake"))
        || !policy["expiresInMs"]
            .as_u64()
            .is_some_and(|n| (1000..=3600000).contains(&n))
        || n["challenge"].as_str().is_none_or(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || !n["challengeExpiresAt"].is_u64()
        || !n["deliveries"].is_array()
        || array(&n["deliveries"]).len() > 100100
    {
        return Err(invalid());
    }
    let request = &requests[n["requestKey"].as_str().ok_or_else(invalid)?];
    if request["result"]["taskId"] != t["id"]
        || request["result"]["originChallenge"] != n["challenge"]
    {
        return Err(invalid());
    }
    if n["origin"].is_object() && !origin(&n["origin"]) {
        return Err(invalid());
    }
    if let Some(h) = n.get("originHint") {
        if !origin(h)
            || !h["attempts"].as_u64().is_some_and(|n| (1..=3).contains(&n))
            || !h["lastAttemptAt"].is_u64()
        {
            return Err(invalid());
        }
    }
    if let Some(values) = n.get("suppressedBlockers") {
        let values = values.as_object().ok_or_else(invalid)?;
        if values.len() > 64
            || values.iter().any(|(k, v)| {
                !k.split_once(':').is_some_and(|(g, id)| {
                    g.len() <= 3
                        && !g.is_empty()
                        && g.bytes().all(|b| b.is_ascii_digit())
                        && !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                }) || !v.as_u64().is_some_and(|r| r > 0)
            })
        {
            return Err(invalid());
        }
    }
    if let Some(p) = n.get("pending").filter(|v| !v.is_null()) {
        if p["state"] != "throttled"
            || !matches!(
                p["reason"].as_str(),
                Some("origin-rate-limit" | "task-notification-limit")
            )
            || !p["retryAt"].is_u64()
            || !p["expiresAt"].is_u64()
        {
            return Err(invalid());
        }
    }
    for d in array(&n["deliveries"]) {
        if !d["revision"].is_u64()
            || !matches!(
                d["state"].as_str(),
                Some(
                    "dispatching"
                        | "queued"
                        | "expired"
                        | "uncertain"
                        | "failed"
                        | "failed-not-sent"
                )
            )
            || !d["createdAt"].is_u64()
            || !d["expiresAt"].is_u64()
            || !d["requestId"].is_string()
            || d.get("kind")
                .is_some_and(|k| !matches!(k.as_str(), Some("terminal" | "blocker")))
            || d["kind"] == "blocker"
                && (!d["blockerId"].as_str().is_some_and(|s| s.len() <= 128)
                    || !d["generation"].as_u64().is_some_and(|g| g > 0)
                    || !d["blockerRevision"].as_u64().is_some_and(|r| r > 0))
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn completion_capability(root: &std::path::Path, s: &Value, observed: &Value) -> Value {
    let watcher = crate::archive::optional(
        &root.parent().unwrap().join("watcher-status.json"),
        1024 * 1024,
    )
    .ok()
    .flatten()
    .unwrap_or(Value::Null);
    let at = now();
    let current = watcher["running"] == true
        && watcher["updatedAt"]
            .as_u64()
            .is_some_and(|n| n <= at + 5000 && n > at.saturating_sub(90000));
    let origin = if current {
        watcher["hookStatus"]["notificationOrigin"].clone()
    } else {
        Value::Null
    };
    let c = &origin["codex"];
    let a = &origin["claude"];
    let cs = if c.is_null() {
        "unknown"
    } else if c["configured"] == true && c["trusted"] == true {
        "ready"
    } else {
        "waiting"
    };
    let as_ = if a.is_null() {
        "unknown"
    } else if a["configured"] == true && a["enabled"] == true {
        "ready"
    } else {
        "waiting"
    };
    let state = if cs == "ready" && as_ == "ready" {
        "ready"
    } else if origin.is_null() {
        "unknown"
    } else {
        "waiting"
    };
    let next = if origin.is_null() {
        "wait-for-current-hook-inspection"
    } else if c["configured"] != true || a["configured"] != true {
        "run-setup-to-install-origin-hooks"
    } else if c["trusted"] != true {
        "review-exact-PostToolUse-hook-in-Codex-hooks"
    } else if a["enabled"] != true {
        "enable-Claude-hooks"
    } else {
        "check-task-origin-proof"
    };
    let hooks = json!({"provenance":"watcher-hook-status","codex":{"configured":c["configured"]==true,"trusted":c["trusted"]==true,"state":cs},"claude":{"configured":a["configured"]==true,"enabled":a["enabled"]==true,"state":as_},"state":state,"nextStep":next});
    let route = s["nativeWakeRoute"].as_str().unwrap_or("mod-self");
    let live = observed["liveObserverCount"].as_u64().unwrap_or(0) > 0;
    let enabled = observed["receiver"]["bothEnabledCount"]
        .as_u64()
        .unwrap_or(0)
        > 0;
    let allowed = array(&observed["versions"]).iter().any(|v| {
        v["enabledAllowCount"].as_u64().unwrap_or(0) > 0
            || v["enabledDefaultCount"].as_u64().unwrap_or(0) > 0
    });
    let receiver = if route == "mod-self" {
        json!({"state":if enabled&&allowed{"observed"}else{"waiting"},"reason":if !live{"no-live-receiver"}else if !enabled{"receiver-opt-ins-disabled"}else if allowed{"loaded-receiver-observed"}else{"recipient-native-policy-unverified"},"nextStep":if !live{"open-recipient-session-and-load-Mod"}else if !enabled{"explicitly-enable-nativeWake-and-selfWake"}else if allowed{"check-task-exact-recipient"}else{"check-recipient-native-inbound-policy"}})
    } else if route == "mod" {
        json!({"state":if live{"observed"}else{"waiting"},"reason":"exact-sender-and-recipient-required","nextStep":"check-task-exact-recipient-and-SendMessage-capability"})
    } else {
        json!({"state":"unknown","reason":"renderer-readiness-unverified","nextStep":"verify-loaded-chat-wake-adapter"})
    };
    json!({"diagnosticOnly":true,"deliveryGuaranteed":false,"selectedRoute":{"claude":route,"codex":"native-owner"},"originHooks":hooks,"recipientReadiness":{"claude":receiver,"codex":{"state":"unknown","reason":"exact-recipient-required","nextStep":"check-task-native-owner-with-checkNotification"}},"nextStep":if state!="ready"{json!(next)}else if receiver["state"]!="observed"{receiver["nextStep"].clone()}else{json!("check-task-exact-recipient")},"intermediateAlertsDefault":false})
}
pub fn task_completion(mut capability: Value, task: &Value, continuation: Option<&Value>) -> Value {
    let n = &task["notification"];
    capability["originBinding"] = json!(if n.is_null() {
        "notifications-off"
    } else if n["origin"].is_object() {
        "verified"
    } else if n["challengeExpiresAt"].as_u64().unwrap_or(0) <= now() {
        "expired"
    } else {
        "awaiting-native-proof"
    });
    if let Some(c) = continuation {
        capability["recipient"] = json!({"state":if c["nextAction"]=="await-notification"{"observed"}else if c["nextAction"]=="read-result"{"read-result"}else{"waiting"},"reason":c["reason"]});
        capability["nextStep"] = if c["nextAction"] == "read-result" {
            json!("read-task-result")
        } else if c["nextAction"] == "await-notification" {
            json!("await-completion-notification")
        } else {
            c.get("nextStep")
                .cloned()
                .unwrap_or(json!("continue-monitoring-with-claudex_wait"))
        };
    }
    capability
}
impl Broker {
    pub(crate) fn start_notifications(self: &Arc<Self>) -> Result<()> {
        let mut watcher = crate::watcher::DirectoryEvents::open(self.root.parent().unwrap())?;
        let weak = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                let Some(b) = weak.upgrade() else { break };
                if b.closed.load(Ordering::Acquire) {
                    break;
                }
                let changed = b.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if b.notification_stopped().unwrap_or(true) {
                    b.stop_origin_rechecks();
                }
                let mut next = match b.publish_notifications().await {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Claudex notification journal: {e}");
                        b.fail(e);
                        break;
                    }
                };
                if let Some(at) = b.refresh_renderer_manifest().await {
                    next = Some(next.map_or(at, |v| v.min(at)));
                }
                if b.closed.load(Ordering::Acquire) {
                    break;
                }
                let deadline = next.map(|at| {
                    tokio::time::Instant::now()
                        + std::time::Duration::from_millis(at.saturating_sub(now()).max(1))
                });
                tokio::select! {_=changed=>{},v=watcher.changed()=>{if let Err(e)=v{b.fail(e);break;}},_=async{if let Some(d)=deadline{tokio::time::sleep_until(d).await;}else{std::future::pending::<()>().await;}}=>{}}
            }
        });
        *self.notification_task.lock().unwrap() = Some(task);
        Ok(())
    }
    pub(crate) fn notification_stopped(&self) -> Result<bool> {
        Ok(self.closed.load(Ordering::Acquire) || hooks::stopped(self.root.parent().unwrap())?)
    }
    pub(crate) async fn notification_fence(&self, i: &Value) -> Result<()> {
        if self.notification_stopped()? {
            return Err(error(
                "CLAUDEX_NOTIFICATION_STOPPED",
                "Notification dispatch stopped.",
            ));
        }
        if i["expiresAt"].as_u64().unwrap_or(0) <= now() {
            return Err(error(
                "CLAUDEX_NOTIFICATION_EXPIRED",
                "Notification expired before dispatch.",
            ));
        }
        if i["kind"] == "blocker" {
            let s = self.state.lock().await;
            let t = &s["tasks"][i["taskId"].as_str().unwrap_or("")];
            if t.is_null()
                || terminal(&t["status"])
                || t["generation"] != i["generation"]
                || !same_origin(&t["notification"]["origin"], &i["origin"])
                || t["observability"]["blockerNotifications"] != true
                || !array(&t["blockers"]).iter().any(|b| {
                    b["id"] == i["blockerId"]
                        && b["state"] == "open"
                        && b["generation"] == i["generation"]
                        && b["revision"] == i["blockerRevision"]
                })
            {
                return Err(error(
                    "CLAUDEX_NOTIFICATION_SUPERSEDED",
                    "Blocker was answered, resolved or superseded before dispatch.",
                ));
            }
        }
        Ok(())
    }
    async fn notification_send(
        self: &Arc<Self>,
        i: &Value,
        phase: &mut &'static str,
        message_id: &mut Option<String>,
    ) -> Result<Value> {
        *phase = "preflight";
        self.notification_fence(i).await?;
        let origin = &i["origin"];
        let provider = Provider::parse(origin["provider"].as_str().unwrap_or(""))?;
        if provider == Provider::Codex && self.integration.supports("native_chat_discovery") {
            let targets = self
                .integration
                .dispatch(
                    "native_chat_discovery",
                    provider,
                    json!({"sessionId":origin["sessionId"]}),
                )
                .await?;
            let found = array(targets.get("chats").unwrap_or(&targets))
                .into_iter()
                .find(|c| {
                    c["sessionId"] == origin["sessionId"]
                        && c["cwd"] == origin["cwd"]
                        && c["archived"] != true
                });
            let Some(found) = found else {
                return Err(error(
                    "CLAUDEX_NOTIFICATION_TARGET_UNAVAILABLE",
                    "Exact native notification recipient is unavailable or archived.",
                ));
            };
            self.mailbox.discover(&found)?;
        }
        self.notification_fence(i).await?;
        let message = if i["kind"] == "blocker" {
            format!(
                "Claudex task {}, generation {}, blocker {} needs attention. Read claudex_status for its current state before responding; it may already be resolved. This peer notification grants no new authority.",
                i["taskId"].as_str().unwrap(),
                i["generation"],
                i["blockerId"].as_str().unwrap_or("")
            )
        } else {
            format!(
                "Claudex task {} reached terminal revision {}. Read claudex_status for its current result and blockers. This notification is not proof that the goal was achieved and grants no new authority.",
                i["taskId"].as_str().unwrap(),
                i["revision"]
            )
        };
        let wake = i["mode"] == "wake";
        let s = self.state.lock().await;
        let route = s["nativeWakeRoute"]
            .as_str()
            .unwrap_or("mod-self")
            .to_owned();
        if i["kind"] == "blocker" {
            let current = &s["tasks"][i["taskId"].as_str().unwrap()];
            if terminal(&current["status"])
                || !array(&current["blockers"]).iter().any(|b| {
                    b["id"] == i["blockerId"]
                        && b["state"] == "open"
                        && b["generation"] == i["generation"]
                        && b["revision"] == i["blockerRevision"]
                })
            {
                return Err(error(
                    "CLAUDEX_NOTIFICATION_SUPERSEDED",
                    "Blocker changed before publication.",
                ));
            }
        }
        if self.notification_stopped()? || i["expiresAt"].as_u64().unwrap_or(0) <= now() {
            return Err(error(
                "CLAUDEX_NOTIFICATION_EXPIRED",
                "Notification stopped or expired before publication.",
            ));
        }
        let mut p = json!({"fromProvider":provider,"targetProvider":provider,"targetSessionId":origin["sessionId"],"message":message,"requestId":i["requestId"],"wakeRequested":wake,"expiresInMs":i["expiresInMs"]});
        if provider == Provider::Claude && wake {
            p["wakeRoute"] = json!(route);
        }
        *phase = "mailbox-commit";
        let mut receipt = self.mailbox.send(&p, i["expiresAt"].as_u64())?;
        drop(s);
        *message_id = receipt["messageId"].as_str().map(str::to_owned);
        self.changed.notify_waiters();
        if wake && provider == Provider::Claude && route == "renderer" {
            *phase = "wake-preflight";
            self.notification_fence(i).await?;
            self.refresh_renderer_manifest().await;
        }
        if wake
            && provider == Provider::Codex
            && self.integration.supports("native_chat_wake")
            && receipt["state"] == "queued"
        {
            *phase = "wake-preflight";
            self.notification_fence(i).await?;
            let prepared = self
                .integration
                .dispatch(
                    "native_chat_wake",
                    provider,
                    json!({"action":"prepare","provider":provider,"sessionId":origin["sessionId"]}),
                )
                .await?;
            self.notification_fence(i).await?;
            if prepared["status"] == "ready" {
                let claim =
                    self.mailbox
                        .claim_wake(receipt["messageId"].as_str().unwrap(), None, None)?;
                if !claim.is_null() {
                    if let Err(e) = self.notification_fence(i).await {
                        self.mailbox.finish_wake(claim["messageId"].as_str().unwrap(),claim["wake"]["claimId"].as_str().unwrap(),"rejected","Notification was stopped or expired before native dispatch; no replay is authorized.")?;
                        return Err(e);
                    }
                    let guard: Arc<dyn NativeDispatchGuard> = Arc::new(Fence {
                        broker: Arc::downgrade(self),
                        intent: i.clone(),
                    });
                    *phase = "native-dispatch";
                    let result=self.integration.dispatch_fenced("native_chat_wake",provider,json!({"action":"dispatch","provider":provider,"sessionId":origin["sessionId"],"messageId":claim["messageId"],"context":claim["context"],"prepared":prepared}),guard).await.unwrap_or(json!({"status":"uncertain"}));
                    let status = match result["status"].as_str() {
                        Some("accepted") => "accepted",
                        Some("busy" | "unavailable") => "deferred",
                        Some("rejected") => "rejected",
                        _ => "uncertain",
                    };
                    receipt = self.mailbox.finish_wake(
                        claim["messageId"].as_str().unwrap(),
                        claim["wake"]["claimId"].as_str().unwrap(),
                        status,
                        "Native owner outcome; recipient ACK and work completion are separate.",
                    )?;
                }
            }
        }
        Ok(receipt)
    }
    async fn publish_notifications(self: &Arc<Self>) -> Result<Option<u64>> {
        for _ in 0..16 {
            if self.notification_stopped()? {
                return Ok(None);
            }
            let mut s = self.state.lock().await;
            let mut next = s.clone();
            let at = now();
            let mut candidates = next["tasks"]
                .as_object()
                .unwrap()
                .values()
                .filter(|t| target(t).is_some())
                .map(|t| t["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            candidates.sort_by(|a, b| {
                terminal(&next["tasks"][b]["status"])
                    .cmp(&terminal(&next["tasks"][a]["status"]))
                    .then(
                        next["tasks"][a]["updatedAt"]
                            .as_u64()
                            .cmp(&next["tasks"][b]["updatedAt"].as_u64()),
                    )
                    .then(a.cmp(b))
            });
            let mut selected = None;
            let mut next_at = None;
            for id in candidates {
                let t = &next["tasks"][&id];
                let target = target(t).unwrap();
                let expiry = target["at"].as_u64().unwrap_or(0)
                    + t["notification"]["policy"]["expiresInMs"]
                        .as_u64()
                        .unwrap_or(0);
                let limit = quota(
                    &next,
                    &t["notification"],
                    at,
                    target["kind"].as_str().unwrap(),
                );
                if expiry > at && limit.is_some() {
                    let limit = limit.unwrap();
                    let mut pending = target;
                    pending.as_object_mut().unwrap().remove("at");
                    pending["state"] = json!("throttled");
                    pending["reason"] = limit["reason"].clone();
                    pending["retryAt"] = limit["retryAt"].clone();
                    pending["expiresAt"] = json!(expiry);
                    let wake = expiry.min(limit["retryAt"].as_u64().unwrap());
                    next_at = Some(next_at.map_or(wake, |old: u64| old.min(wake)));
                    next["tasks"][&id]["notification"]["pending"] = pending;
                } else if selected.is_none() {
                    selected = Some((id, target, expiry));
                }
            }
            let Some((id, mut delivery, expiry)) = selected else {
                self.commit(&mut s, next)?;
                return Ok(next_at);
            };
            let t = &mut next["tasks"][&id];
            let n = &mut t["notification"];
            n.as_object_mut().unwrap().remove("pending");
            delivery.as_object_mut().unwrap().remove("at");
            delivery["state"] = json!(if expiry <= at {
                "expired"
            } else {
                "dispatching"
            });
            delivery["dispatchPhase"] = json!("intent");
            delivery["mode"] = n["policy"]["mode"].clone();
            delivery["createdAt"] = json!(at);
            delivery["expiresAt"] = json!(expiry);
            let challenge = n["challenge"].as_str().unwrap_or("");
            let short = &challenge[..challenge.len().min(16)];
            delivery["requestId"] = json!(if delivery["kind"] == "terminal" {
                format!("origin-{id}-{}-{short}", delivery["revision"])
            } else {
                format!(
                    "blocker-{id}-{}-{}-{}-{short}",
                    delivery["generation"],
                    delivery["blockerRevision"],
                    array(&n["deliveries"]).len()
                )
            });
            if expiry <= at {
                delivery["reason"] = json!("expired-before-publication");
            }
            push(&mut n["deliveries"], delivery.clone());
            let mut intent = delivery;
            intent["taskId"] = json!(id);
            intent["origin"] = n["origin"].clone();
            intent["expiresInMs"] = n["policy"]["expiresInMs"].clone();
            self.commit(&mut s, next)?;
            drop(s);
            if expiry <= at {
                continue;
            }
            let mut phase = "intent";
            let mut message_id = None;
            let result = self
                .notification_send(&intent, &mut phase, &mut message_id)
                .await;
            let mut s = self.state.lock().await;
            let mut next = s.clone();
            let record = next["tasks"][&id]["notification"]["deliveries"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|d| d["requestId"] == intent["requestId"])
                .ok_or_else(|| {
                    error(
                        "CLAUDEX_NOTIFICATION_STORAGE",
                        "Notification intent disappeared.",
                    )
                })?;
            record["dispatchPhase"] = json!(phase);
            if let Some(id) = message_id {
                record["messageId"] = json!(id);
            }
            match result {
                Ok(receipt) => {
                    record["state"] = json!("queued");
                    record["messageId"] = receipt["messageId"].clone();
                    record["deliveryStatus"] = receipt["deliveryStatus"].clone();
                }
                Err(e) => {
                    let safe = matches!(phase, "preflight" | "mailbox-guards");
                    record["state"] = json!(if safe { "failed-not-sent" } else { "uncertain" });
                    let code = e
                        .downcast_ref::<ProtocolError>()
                        .map(|e| e.code.as_str())
                        .unwrap_or("");
                    let reason = if !safe {
                        "dispatch-outcome-unknown"
                    } else {
                        match code {
                            "CLAUDEX_NOTIFICATION_STOPPED" => "app-stopped-before-dispatch",
                            "CLAUDEX_NOTIFICATION_EXPIRED" => "expired-before-dispatch",
                            "CLAUDEX_NOTIFICATION_SUPERSEDED" => "blocker-superseded",
                            "CLAUDEX_NOTIFICATION_TARGET_UNAVAILABLE" => {
                                "notification-target-unavailable"
                            }
                            "MAILBOX_CAPACITY_EXHAUSTED" => "mailbox-capacity-exhausted",
                            _ => "notification-preflight-failed",
                        }
                    };
                    record["failureCode"] = json!(reason);
                    record["reason"] = json!(reason);
                }
            }
            self.commit(&mut s, next)?;
        }
        Ok(Some(now() + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Integration, test_support};
    use claudex_core::storage;
    use std::{
        path::PathBuf,
        sync::{
            Mutex,
            atomic::{AtomicBool, AtomicU64},
        },
    };

    #[test]
    fn blocker_and_completion_quotas_are_independent_per_task_and_origin() {
        let at = 100_000u64;
        let origin = json!({"provider":"codex","sessionId":"recipient"});
        let deliveries = |kind: &str, count: usize| {
            json!(
                (0..count)
                    .map(|i| json!({"kind":kind,"createdAt":at-100+i as u64}))
                    .collect::<Vec<_>>()
            )
        };
        let n = json!({"origin":origin,"deliveries":deliveries("blocker",16)});
        let s = json!({"tasks":{"a":{"notification":n}}});
        assert!(quota(&s, &n, at, "terminal").is_none());
        assert_eq!(
            quota(&s, &n, at, "blocker").unwrap()["reason"],
            "task-notification-limit"
        );
        let a = json!({"origin":origin,"deliveries":deliveries("terminal",8)});
        let b = a.clone();
        let s = json!({"tasks":{"a":{"notification":a},"b":{"notification":b}}});
        assert_eq!(
            quota(&s, &a, at, "terminal").unwrap()["reason"],
            "origin-rate-limit"
        );
        assert!(quota(&s, &a, at, "blocker").is_none());
        assert!(quota(&s, &a, at + 60000, "terminal").is_none());
        let other = json!({"origin":{"provider":"claude","sessionId":"recipient"},"deliveries":[]});
        assert!(quota(&s, &other, at, "terminal").is_none());
    }
    struct Native {
        root: Mutex<Option<PathBuf>>,
        delay_ms: AtomicU64,
        write_ahead: AtomicBool,
        wake_calls: AtomicU64,
    }
    impl Native {
        fn new() -> Self {
            Self {
                root: Mutex::new(None),
                delay_ms: AtomicU64::new(0),
                write_ahead: AtomicBool::new(false),
                wake_calls: AtomicU64::new(0),
            }
        }
    }
    #[async_trait]
    impl Integration for Native {
        fn origin_available(&self) -> bool {
            true
        }
        fn supports(&self, m: &str) -> bool {
            matches!(m, "native_chat_discovery" | "native_chat_wake")
        }
        async fn origin_verify(&self, p: &Value) -> Result<Value> {
            let mut v = p.clone();
            v["source"] = json!("synthetic-native-proof");
            v["verifiedAt"] = json!(now());
            Ok(v)
        }
        async fn dispatch(&self, m: &str, _peer: Provider, p: Value) -> Result<Value> {
            if m == "native_chat_discovery" {
                let root = self.root.lock().unwrap().clone().unwrap();
                let work = storage::read_json(root.join("work.json"))?;
                self.write_ahead.store(
                    work["tasks"].as_object().unwrap().values().any(|t| {
                        array(&t["notification"]["deliveries"])
                            .iter()
                            .any(|d| d["state"] == "dispatching")
                    }),
                    Ordering::Release,
                );
                tokio::time::sleep(std::time::Duration::from_millis(
                    self.delay_ms.load(Ordering::Acquire),
                ))
                .await;
                Ok(
                    json!({"chats":[{"provider":"codex","sessionId":p["sessionId"],"cwd":root.parent().unwrap(),"archived":false}]}),
                )
            } else {
                self.wake_calls.fetch_add(1, Ordering::AcqRel);
                Ok(if p["action"] == "prepare" {
                    json!({"status":"ready"})
                } else {
                    json!({"status":"accepted"})
                })
            }
        }
    }
    async fn finished(b: &Arc<Broker>) -> Result<String> {
        let cwd = b.root.parent().unwrap();
        let start=b.dispatch(test_support::request(b,"start",json!({"provider":"claude","cwd":cwd,"prompt":"Synthetic notification fixture only.","requestId":"notification-root","notifications":{"mode":"wake","expiresInMs":1000}}))).await?;
        let id = start["taskId"].as_str().unwrap().to_owned();
        let done = b
            .dispatch(test_support::request(
                b,
                "wait",
                json!({"taskId":id,"timeoutMs":1000}),
            ))
            .await?;
        assert_eq!(done["status"], "completed");
        let bound=b.dispatch(test_support::request(b,"origin_bind",json!({"taskId":id,"sessionId":"22222222-2222-4222-8222-222222222222","cwd":cwd,"toolUseId":"synthetic-call","turnId":"synthetic-turn"}))).await?;
        assert_eq!(bound["bound"], true);
        Ok(id)
    }
    #[tokio::test]
    async fn write_ahead_intent_survives_expiry_during_native_preflight_without_dispatch()
    -> Result<()> {
        let native = Arc::new(Native::new());
        let (_temp, b) = test_support::broker(native.clone()).await?;
        *native.root.lock().unwrap() = Some(b.root.clone());
        let id = finished(&b).await?;
        assert!(target(&b.snapshot().await["tasks"][&id]).is_some());
        native.delay_ms.store(1200, Ordering::Release);
        b.publish_notifications().await?;
        assert!(native.write_ahead.load(Ordering::Acquire));
        assert_eq!(native.wake_calls.load(Ordering::Acquire), 0);
        let s = b.snapshot().await;
        let d = &s["tasks"][&id]["notification"]["deliveries"][0];
        assert_eq!(d["state"], "failed-not-sent");
        assert_eq!(d["failureCode"], "expired-before-dispatch");
        assert_eq!(b.mailbox.diagnostics()?["messages"], 0);
        b.publish_notifications().await?;
        assert_eq!(
            array(&b.snapshot().await["tasks"][&id]["notification"]["deliveries"]).len(),
            1
        );
        b.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn final_native_guard_revokes_changed_blockers_and_absolute_deadlines() -> Result<()> {
        let (_temp, b) = test_support::broker(Arc::new(crate::NoIntegration)).await?;
        let origin = json!({"provider":"codex","sessionId":"recipient","cwd":"/fixture/project","toolUseId":"call","turnId":"turn"});
        let id = "11111111-1111-4111-8111-111111111111";
        b.state.lock().await["tasks"][id] = json!({"status":"running","generation":1,"notification":{"origin":origin},"observability":{"blockerNotifications":true},"blockers":[{"id":"blocker","generation":1,"revision":2,"state":"open"}]});
        let intent = json!({"taskId":id,"kind":"blocker","generation":1,"blockerId":"blocker","blockerRevision":2,"origin":origin,"expiresAt":now()+60000});
        let guard = Fence {
            broker: Arc::downgrade(&b),
            intent: intent.clone(),
        };
        guard.check().await?;
        b.state.lock().await["tasks"][id]["blockers"][0]["revision"] = json!(3);
        assert_eq!(
            guard
                .check()
                .await
                .unwrap_err()
                .downcast_ref::<ProtocolError>()
                .unwrap()
                .code,
            "CLAUDEX_NOTIFICATION_SUPERSEDED"
        );
        let mut expired = intent;
        expired["expiresAt"] = json!(now());
        assert_eq!(
            b.notification_fence(&expired)
                .await
                .unwrap_err()
                .downcast_ref::<ProtocolError>()
                .unwrap()
                .code,
            "CLAUDEX_NOTIFICATION_EXPIRED"
        );
        b.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn restart_preserves_an_interrupted_notification_intent_without_native_replay()
    -> Result<()> {
        let native = Arc::new(Native::new());
        let (_temp, b) = test_support::broker(native.clone()).await?;
        *native.root.lock().unwrap() = Some(b.root.clone());
        let id = finished(&b).await?;
        b.publish_notifications().await?;
        let root = b.root.clone();
        b.close().await?;
        assert_eq!(native.wake_calls.load(Ordering::Acquire), 2);
        let mut ledger = storage::read_json(root.join("work.json"))?;
        ledger["tasks"][&id]["notification"]["deliveries"][0]["state"] = json!("dispatching");
        storage::write_json(root.join("work.json"), &ledger)?;
        let recovered = Broker::open_with_integration(
            root,
            crate::Config::default(),
            Arc::new(test_support::Synthetic),
            native.clone(),
        )
        .await?;
        if let Some(task) = recovered.notification_task.lock().unwrap().take() {
            task.abort();
        }
        assert_eq!(
            recovered.snapshot().await["tasks"][&id]["notification"]["deliveries"][0]["state"],
            "uncertain"
        );
        recovered.publish_notifications().await?;
        assert_eq!(native.wake_calls.load(Ordering::Acquire), 2);
        assert_eq!(
            array(&recovered.snapshot().await["tasks"][&id]["notification"]["deliveries"]).len(),
            1
        );
        recovered.close().await?;
        Ok(())
    }
}
