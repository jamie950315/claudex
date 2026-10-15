//! Bounded loaded-code observations and exact native Mod wake claims.
use crate::{Broker, Envelope, Provider, mailbox::peer_context, model::*};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, atomic::Ordering},
};

pub const OBSERVATION_TTL: u64 = 60_000;
#[derive(Default)]
pub struct ModState {
    observations: BTreeMap<String, Value>,
    waiters: usize,
}
fn fields(v: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    if !v.is_object()
        || v.as_object()
            .unwrap()
            .keys()
            .any(|k| !allowed.contains(&k.as_str()))
        || required.iter().any(|k| v.get(*k).is_none())
    {
        bail!("Invalid native Mod request.");
    }
    Ok(())
}
fn identity(v: &Value, uuid: bool) -> Result<&str> {
    let s = text(v, "exact native identity", 128)?;
    if if uuid {
        uuid::Uuid::parse_str(s).is_err() || s.len() != 36
    } else {
        !s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    } {
        bail!("Invalid exact native identity.");
    }
    Ok(s)
}
fn context(v: &Value) -> Result<Value> {
    fields(v, &["sessionId", "cwd"], &["sessionId", "cwd"])?;
    let id = identity(&v["sessionId"], true)?.to_lowercase();
    let cwd = text(&v["cwd"], "cwd", 4096)?;
    if !Path::new(cwd).is_absolute() || cwd.starts_with("//") || cwd.chars().any(|c| c.is_control())
    {
        bail!("An exact absolute native directory is required.");
    }
    Ok(json!({"sessionId":id,"cwd":cwd}))
}
pub fn validate_observation(v: &Value) -> Result<()> {
    fields(
        v,
        &[
            "observerId",
            "sequence",
            "lifecycle",
            "nativeWake",
            "selfWake",
            "inboundPolicy",
            "inboundPolicyEvidence",
            "capabilities",
            "usage",
            "modVersion",
            "modBuild",
        ],
        &[
            "observerId",
            "sequence",
            "lifecycle",
            "nativeWake",
            "selfWake",
            "inboundPolicy",
            "capabilities",
            "usage",
        ],
    )?;
    identity(&v["observerId"], false)?;
    if v["sequence"]
        .as_u64()
        .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
        || !matches!(v["lifecycle"].as_str(), Some("loaded" | "ended"))
        || !v["nativeWake"].is_boolean()
        || !v["selfWake"].is_boolean()
        || !matches!(
            v["inboundPolicy"].as_str(),
            Some("allow" | "hold" | "refuse" | "unknown")
        )
    {
        bail!("Invalid native Mod observation.");
    }
    if let Some(e) = v.get("inboundPolicyEvidence") {
        if !matches!(
            e.as_str(),
            Some("explicit" | "setting-unset" | "read-failed" | "unrecognized")
        ) || (v["inboundPolicy"] != "unknown") != (e == "explicit")
        {
            bail!("Invalid native policy evidence.");
        }
    }
    fields(&v["capabilities"], &["sendMessage"], &["sendMessage"])?;
    if !v["capabilities"]["sendMessage"].is_null() && !v["capabilities"]["sendMessage"].is_boolean()
    {
        bail!("Invalid native capability observation.");
    }
    if !v["usage"].is_null() {
        fields(&v["usage"], &["contextPercent"], &["contextPercent"])?;
        if v["usage"]["contextPercent"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || !(0.0..=100.0).contains(&n))
        {
            bail!("Invalid native usage observation.");
        }
    }
    if let Some(version) = v.get("modVersion") {
        static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$").unwrap()
        });
        if version
            .as_str()
            .is_none_or(|s| s.len() > 48 || !RE.is_match(s))
        {
            bail!("Invalid loaded Mod version.");
        }
    }
    if let Some(build) = v.get("modBuild") {
        if v.get("modVersion").is_none()
            || build.as_str().is_none_or(|s| {
                s.is_empty()
                    || s.len() > 48
                    || !s.as_bytes()[0].is_ascii_lowercase()
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            bail!("Invalid loaded Mod build.");
        }
    }
    Ok(())
}
fn native_default(v: &Value) -> bool {
    v["inboundPolicy"] == "unknown" && v["inboundPolicyEvidence"] == "setting-unset"
}
fn prune(state: &mut ModState) {
    let at = now();
    state
        .observations
        .retain(|_, v| v["expiresAt"].as_u64().unwrap_or(0) > at);
}
fn observe(state: &mut ModState, source: &Value, input: &Value) -> Result<Value> {
    validate_observation(input)?;
    prune(state);
    let key = format!(
        "{}:{}",
        source["sessionId"].as_str().unwrap(),
        input["observerId"].as_str().unwrap()
    );
    if let Some(old) = state.observations.get(&key) {
        if old["context"] != *source
            || input["sequence"].as_u64() <= old["sequence"].as_u64()
            || old["lifecycle"] == "ended"
        {
            return Ok(json!({"observed":false,"reason":"superseded-observation"}));
        }
    } else if state.observations.len() >= 64 {
        return Err(error(
            "MOD_OBSERVATION_CAPACITY",
            "The bounded native observation inventory is full.",
        ));
    }
    let mut value = input.clone();
    let at = now();
    value["context"] = source.clone();
    value["lastSeenAt"] = json!(at);
    value["expiresAt"] = json!(at + OBSERVATION_TTL);
    value["provenance"] = json!("mod-self-reported");
    value["diagnosticOnly"] = json!(true);
    state.observations.insert(key, value);
    Ok(json!({"observed":true,"expiresAt":at+OBSERVATION_TTL,"diagnosticOnly":true}))
}
struct WaitGuard {
    state: Arc<Mutex<ModState>>,
    key: Option<(String, Value)>,
    completed: bool,
}
impl Drop for WaitGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            s.waiters = s.waiters.saturating_sub(1);
            if !self.completed
                && let Some((key, seq)) = &self.key
                && s.observations
                    .get(key)
                    .is_some_and(|v| v["sequence"] == *seq)
            {
                s.observations.remove(key);
            }
        }
    }
}
impl Broker {
    pub(crate) fn mod_status(&self) -> Value {
        let mut s = self.mod_state.lock().unwrap();
        prune(&mut s);
        let live = if self.closed.load(Ordering::Acquire) {
            vec![]
        } else {
            s.observations
                .values()
                .filter(|v| v["lifecycle"] == "loaded")
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut versions = BTreeMap::<String, Value>::new();
        for v in &live {
            if let Some(version) = v["modVersion"].as_str() {
                let key = format!("{version}:{}", v["modBuild"].as_str().unwrap_or(""));
                let e=versions.entry(key).or_insert_with(||json!({"version":version,"build":v["modBuild"],"observers":0,"nativeWakeCount":0,"selfWakeCount":0,"bothEnabledCount":0,"allowCount":0,"holdCount":0,"refuseCount":0,"unknownPolicyCount":0,"enabledAllowCount":0,"enabledDefaultCount":0}));
                for (key, yes) in [
                    ("observers", true),
                    ("nativeWakeCount", v["nativeWake"] == true),
                    ("selfWakeCount", v["selfWake"] == true),
                    (
                        "bothEnabledCount",
                        v["nativeWake"] == true && v["selfWake"] == true,
                    ),
                    ("allowCount", v["inboundPolicy"] == "allow"),
                    ("holdCount", v["inboundPolicy"] == "hold"),
                    ("refuseCount", v["inboundPolicy"] == "refuse"),
                    ("unknownPolicyCount", v["inboundPolicy"] == "unknown"),
                    (
                        "enabledAllowCount",
                        v["nativeWake"] == true
                            && v["selfWake"] == true
                            && v["inboundPolicy"] == "allow",
                    ),
                    (
                        "enabledDefaultCount",
                        v["nativeWake"] == true && v["selfWake"] == true && native_default(v),
                    ),
                ] {
                    if yes {
                        e[key] = json!(e[key].as_u64().unwrap_or(0) + 1);
                    }
                }
            }
        }
        let count = |f: fn(&Value) -> bool| live.iter().filter(|v| f(v)).count();
        json!({"diagnosticOnly":true,"provenance":"mod-self-reported","observedAt":now(),"ttlMs":OBSERVATION_TTL,"maxObservers":64,"liveObserverCount":live.len(),"unknownVersionObservers":count(|v|v.get("modVersion").is_none()),"versions":versions.into_values().collect::<Vec<_>>(),"receiver":{"nativeWake":live.iter().any(|v|v["nativeWake"]==true),"selfWake":live.iter().any(|v|v["selfWake"]==true),"bothEnabledCount":count(|v|v["nativeWake"]==true&&v["selfWake"]==true),"allowCount":count(|v|v["inboundPolicy"]=="allow"),"holdCount":count(|v|v["inboundPolicy"]=="hold"),"refuseCount":count(|v|v["inboundPolicy"]=="refuse"),"unknownPolicyCount":count(|v|v["inboundPolicy"]=="unknown")},"waitingModClients":s.waiters,"brokerStopping":self.closed.load(Ordering::Acquire),"note":"Fresh loaded-observer counts are self-reported diagnostics, not unique sessions, dispatch readiness, delivery, ACK, or work completion."})
    }
    async fn verify_mod_target(&self, target: &Value) -> Result<Value> {
        if !self.integration.supports("mod_target_verify") {
            return Err(error(
                "MOD_TARGET_UNAVAILABLE",
                "The exact recipient metadata is unavailable; no new dispatch is permitted.",
            ));
        }
        let v=self.integration.dispatch("mod_target_verify",Provider::Claude,target.clone()).await.map_err(|_|error("MOD_TARGET_UNAVAILABLE","The exact recipient metadata is unavailable or changed. No new dispatch is permitted."))?;
        if v["cwd"] != target["cwd"] {
            return Err(error(
                "MOD_TARGET_UNAVAILABLE",
                "The exact recipient directory changed. No new dispatch is permitted.",
            ));
        }
        Ok(v)
    }
    pub(crate) async fn mod_diagnosis(&self, message: &Value) -> Result<Value> {
        if message["targetProvider"] != "claude"
            || !matches!(message["wakeRoute"].as_str(), Some("mod" | "mod-self"))
            || message["state"] != "queued"
        {
            return Ok(Value::Null);
        }
        let route = self.state.lock().await["nativeWakeRoute"]
            .as_str()
            .unwrap_or("mod-self")
            .to_owned();
        let chat =
            self.mailbox.list()?.into_iter().find(|c| {
                c["provider"] == "claude" && c["sessionId"] == message["targetSessionId"]
            });
        let target = chat
            .as_ref()
            .map(|c| json!({"sessionId":c["sessionId"],"cwd":c["cwd"]}));
        let mut reason = if self.closed.load(Ordering::Acquire) {
            Some("broker-stopping")
        } else if route != message["wakeRoute"] {
            Some("route-inactive")
        } else {
            None
        };
        if reason.is_none()
            && (target.is_none()
                || self
                    .verify_mod_target(target.as_ref().unwrap())
                    .await
                    .is_err())
        {
            reason = Some("target-unmapped");
        }
        let (observation, senders) = {
            let mut s = self.mod_state.lock().unwrap();
            prune(&mut s);
            let o = s
                .observations
                .values()
                .filter(|v| {
                    v["lifecycle"] == "loaded"
                        && target.as_ref().is_some_and(|t| v["context"] == *t)
                })
                .max_by_key(|v| v["lastSeenAt"].as_u64())
                .cloned();
            let senders = s
                .observations
                .values()
                .filter(|v| {
                    v["lifecycle"] == "loaded"
                        && v["context"]["sessionId"] != message["targetSessionId"]
                        && v["nativeWake"] == true
                })
                .cloned()
                .collect::<Vec<_>>();
            (o, senders)
        };
        if reason.is_none() && chat.as_ref().is_some_and(|c| c["phase"] == "ended") {
            reason = Some("waiting-for-resume");
        }
        let o = observation.as_ref().unwrap_or(&Value::Null);
        if reason.is_none() && route == "mod-self" {
            reason = Some(if observation.is_none() {
                "no-live-receiver"
            } else if o["nativeWake"] != true {
                "native-wake-disabled"
            } else if o["selfWake"] != true {
                "self-delivery-disabled"
            } else if o["inboundPolicy"] == "hold" {
                "native-inbound-hold"
            } else if o["inboundPolicy"] == "refuse" {
                "native-inbound-refuse"
            } else if o["inboundPolicy"] == "unknown" && !native_default(o) {
                match o["inboundPolicyEvidence"].as_str() {
                    Some("read-failed") => "native-policy-unavailable",
                    Some("unrecognized") => "native-policy-unrecognized",
                    _ => "native-policy-unknown",
                }
            } else if native_default(o) {
                "receiver-observed-native-default"
            } else {
                "receiver-observed"
            });
        }
        if reason.is_none() {
            reason = Some(if senders.is_empty() {
                "no-live-receiver"
            } else if senders
                .iter()
                .any(|v| v["capabilities"]["sendMessage"] == true)
            {
                "sender-observed"
            } else if senders
                .iter()
                .any(|v| v["capabilities"]["sendMessage"].is_null())
            {
                "native-tools-unavailable"
            } else {
                "missing-SendMessage"
            });
        }
        let reason = reason.unwrap();
        let mut out = json!({"reason":reason,"observedAt":now(),"receiver":observation,"diagnosticOnly":true,"note":"Observations do not prove dispatch readiness, recipient ACK, or work completion."});
        if reason.starts_with("native-policy-") {
            out["missingEvidence"] = json!(match reason {
                "native-policy-unavailable" =>
                    "The loaded Mod could not read native inbound policy. No native hold, refusal or allow was observed.",
                "native-policy-unrecognized" =>
                    "The loaded Mod read an unrecognized native inbound policy value. Its effective behavior is unverified; the raw value is not retained.",
                _ =>
                    "The loaded Mod reported unknown inbound policy without a reason. An observation distinguishing an unset setting, failed read or unrecognized value is missing.",
            });
            out["nextStep"] = json!(
                "Keep monitoring with claudex_wait and inspect the next normal native policy observation. An earlier ACK does not establish current policy."
            );
        }
        Ok(out)
    }
    pub(crate) async fn mod_dispatch(self: &Arc<Self>, e: &Envelope) -> Result<Value> {
        let p = &e.params;
        let method = e.method.as_str();
        if method == "native_wake" {
            fields(p, &["route"], &[])?;
            let mut s = self.state.lock().await;
            if let Some(route) = p.get("route") {
                if self.closed.load(Ordering::Acquire)
                    || !matches!(route.as_str(), Some("mod" | "mod-self" | "renderer"))
                {
                    bail!("Invalid native wake route or stopping broker.");
                }
                let mut next = s.clone();
                next["nativeWakeRoute"] = route.clone();
                self.commit(&mut s, next)?;
            }
            return Ok(
                json!({"route":s["nativeWakeRoute"].as_str().unwrap_or("mod-self"),"waitingModClients":self.mod_state.lock().unwrap().waiters,"note":"Route changes affect new messages only. Unknown dispatches never fall back or replay."}),
            );
        }
        if method == "mod_wake_status" {
            fields(p, &[], &[])?;
            let mut value = self.mod_status();
            value["route"] = json!(
                self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
            );
            value["chatMailbox"] = self.mailbox.diagnostics()?;
            return Ok(value);
        }
        if e.peer != Provider::Claude {
            bail!("Native Mod endpoint is unavailable.");
        }
        let source = context(&p["source"])?;
        if method == "mod_wake_observe" {
            fields(p, &["source", "observation"], &["source", "observation"])?;
            if self.closed.load(Ordering::Acquire) {
                return Ok(json!({"observed":false,"reason":"broker-stopping"}));
            }
            return observe(
                &mut self.mod_state.lock().unwrap(),
                &source,
                &p["observation"],
            );
        }
        if !self.integration.supports("mod_target_verify") {
            bail!("Native Mod endpoint is unavailable.");
        }
        if method == "mod_wake_wait" {
            fields(
                p,
                &["source", "excludeIds", "timeoutMs", "self", "observation"],
                &["source"],
            )?;
            if p.get("self").is_some_and(|v| !v.is_boolean()) {
                bail!("Invalid self-delivery capability.");
            }
            let excluded = p.get("excludeIds").cloned().unwrap_or(json!([]));
            if !excluded.is_array() || array(&excluded).len() > 64 {
                bail!("Invalid excluded message list.");
            }
            for id in array(&excluded) {
                identity(&id, true)?;
            }
            let timeout = p
                .get("timeoutMs")
                .map(Value::as_u64)
                .unwrap_or(Some(20000))
                .filter(|v| *v <= 20000)
                .ok_or_else(|| error("INVALID_REQUEST", "Invalid Mod wait bounds."))?;
            let mut guard = {
                let mut s = self.mod_state.lock().unwrap();
                if s.waiters >= 64 {
                    bail!("Native Mod waiter capacity reached.");
                }
                if p.get("observation").is_some() && !self.closed.load(Ordering::Acquire) {
                    observe(&mut s, &source, &p["observation"])?;
                }
                s.waiters += 1;
                WaitGuard {
                    state: self.mod_state.clone(),
                    key: p.get("observation").map(|v| {
                        (
                            format!(
                                "{}:{}",
                                source["sessionId"].as_str().unwrap(),
                                v["observerId"].as_str().unwrap()
                            ),
                            v["sequence"].clone(),
                        )
                    }),
                    completed: false,
                }
            };
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout);
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let route = self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    .to_owned();
                let mut out = json!({"state":"waiting","messages":[]});
                if self.closed.load(Ordering::Acquire) {
                    out["state"] = json!("stopping");
                } else if !matches!(route.as_str(), "mod" | "mod-self")
                    || route == "mod-self" && p["self"] != true
                {
                    out["state"] = json!("disabled");
                } else {
                    let chats = self.mailbox.list()?;
                    let messages=self.mailbox.pending_wakes()?.into_iter().filter(|m|m["wakeRoute"]==route&&(if route=="mod-self"{m["targetSessionId"]==source["sessionId"]}else{m["targetSessionId"]!=source["sessionId"]})&&!array(&excluded).contains(&m["messageId"])).take(64).filter_map(|m|chats.iter().find(|c|c["provider"]=="claude"&&c["sessionId"]==m["targetSessionId"]).map(|c|json!({"messageId":m["messageId"],"route":route,"target":{"sessionId":m["targetSessionId"],"cwd":c["cwd"]},"expiresAt":m["expiresAt"]}))).collect::<Vec<_>>();
                    if !messages.is_empty() {
                        out["state"] = json!("pending");
                        out["messages"] = json!(messages);
                    }
                }
                if timeout == 0
                    || out["state"] != "waiting"
                    || tokio::time::Instant::now() >= deadline
                {
                    guard.completed = true;
                    return Ok(out);
                }
                tokio::select! {_=notified=>{},_=tokio::time::sleep_until(deadline)=>{guard.completed=true;return Ok(out);}}
            }
        }
        fields(
            p,
            &[
                "source",
                "target",
                "messageId",
                "claimId",
                "status",
                "reason",
                "route",
            ],
            &["source", "target", "messageId"],
        )?;
        let route = p["route"].as_str().unwrap_or("mod");
        if !matches!(route, "mod" | "mod-self") {
            bail!("Invalid native Mod route.");
        }
        let target = context(&p["target"])?;
        let id = identity(&p["messageId"], true)?;
        let message = self.mailbox.status(id)?;
        if message["wakeRoute"] != route
            || message["targetProvider"] != "claude"
            || message["targetSessionId"] != target["sessionId"]
            || message["wakeRequested"] != true
            || (if route == "mod-self" {
                source != target
            } else {
                source["sessionId"] == target["sessionId"]
            })
        {
            bail!("Native Mod message identity/route mismatch.");
        }
        let active = || !self.closed.load(Ordering::Acquire);
        if method == "mod_wake_claim" {
            if !active()
                || self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    != route
            {
                return Ok(json!({"claimed":false}));
            }
            self.verify_mod_target(&target).await?;
            if !active()
                || self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    != route
            {
                return Ok(json!({"claimed":false}));
            }
            let c = self.mailbox.claim_wake(id, Some(route), Some(source))?;
            self.changed.notify_waiters();
            return Ok(if c.is_null() {
                json!({"claimed":false})
            } else {
                json!({"claimed":true,"messageId":c["messageId"],"claimId":c["wake"]["claimId"],"context":c["context"]})
            });
        }
        let claim = identity(&p["claimId"], true)?;
        if message["wake"]["source"] != source || message["wake"]["claimId"] != claim {
            bail!("Native Mod claim owner changed.");
        }
        if matches!(method, "mod_wake_check" | "mod_wake_receive") {
            if method == "mod_wake_receive" && route != "mod-self" {
                bail!("Self receipt requires its explicit route.");
            }
            let valid = |m: &Value| {
                m["wake"]["state"] == "dispatching"
                    || method == "mod_wake_receive" && m["wake"]["state"] == "submitted"
            };
            if !active()
                || self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    != route
                || !valid(&message)
                || message["expiresAt"].as_u64().unwrap_or(0) <= now()
            {
                bail!("Native Mod dispatch no longer authorized.");
            }
            self.verify_mod_target(&target).await?;
            let m = self.mailbox.status(id)?;
            if !active()
                || self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    != route
                || !valid(&m)
                || m["wake"]["claimId"] != claim
                || m["wake"]["source"] != source
                || m["expiresAt"].as_u64().unwrap_or(0) <= now()
            {
                bail!("Native Mod dispatch no longer authorized.");
            }
            let ctx = if method == "mod_wake_receive" {
                Some(self.mailbox.receive_self_wake(id, claim, &source)?)
            } else if route == "mod-self" {
                Some(peer_context(&m))
            } else {
                None
            };
            if !active()
                || self.state.lock().await["nativeWakeRoute"]
                    .as_str()
                    .unwrap_or("mod-self")
                    != route
            {
                bail!("Native Mod dispatch no longer authorized.");
            }
            let mut out = json!({"ready":true});
            if let Some(ctx) = ctx {
                out["context"] = json!(ctx);
            }
            return Ok(out);
        }
        if method == "mod_wake_receipt" {
            let status = p["status"].as_str().unwrap_or("");
            let reason = p["reason"].as_str().unwrap_or("");
            if !matches!(
                (status, reason),
                ("accepted", "queued")
                    | ("rejected", "native_rejected")
                    | ("submitted", "inbox_written")
                    | (
                        "uncertain",
                        "native_exception" | "context_changed" | "pre_dispatch_stopped"
                    )
            ) || status == "submitted" && route != "mod-self"
            {
                bail!("Invalid native wake outcome.");
            }
            let out=self.mailbox.finish_wake(id,claim,status,&format!("Native Mod: {reason}. Queue acceptance, recipient ACK and work completion are separate."))?;
            self.changed.notify_waiters();
            return Ok(out);
        }
        bail!("Unsupported native Mod operation.")
    }
}
