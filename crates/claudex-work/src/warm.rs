use crate::{Broker, Envelope, Provider, model::*};
use anyhow::{Result, bail};
use serde_json::{Value, json};
fn ttl_preference(v: &Value) -> Result<()> {
    if !v.is_object()
        || v["version"] != 1
        || !matches!(v["mode"].as_str(), Some("session" | "remember" | "default"))
        || v.as_object()
            .unwrap()
            .keys()
            .any(|k| !["version", "mode", "ttl", "revision"].contains(&k.as_str()))
        || if v["mode"] == "session" {
            v.get("ttl").is_some()
        } else {
            !matches!(v["ttl"].as_str(), Some("1h" | "5m"))
        }
        || if v["mode"] == "remember" {
            v["revision"].as_str().is_none_or(|s| {
                !s.starts_with("warm-")
                    || s.len() <= 5
                    || s.len() > 85
                    || !s[5..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        } else {
            v.get("revision").is_some()
        }
    {
        bail!("Saved cache TTL preference is invalid; no native setting was changed.");
    }
    Ok(())
}
pub(crate) fn validate_settings(s: &Value) -> Result<()> {
    if s.get("defaultWarmLimit").is_some_and(|v| !v.is_string())
        || s.get("warmOnUserMessage")
            .is_some_and(|v| !matches!(v.as_str(), Some("continue" | "stop")))
        || s.get("compactAfterWarm").is_some_and(|v| !v.is_boolean())
    {
        bail!("Malformed persisted cache-warm settings.");
    }
    if let Some(v) = s.get("cacheTtlPreference") {
        ttl_preference(v)?;
    }
    Ok(())
}
impl Broker {
    pub(crate) async fn cache_warm(&self, e: &Envelope) -> Result<Value> {
        let p = &e.params;
        let method = e.method.as_str();
        if method == "cache_warm_settings" {
            let allowed = [
                "sessionId",
                "cwd",
                "defaultLimit",
                "ttlPreference",
                "ttlLastChoice",
                "onUserMessage",
                "compactAfterWarm",
            ];
            if p.as_object()
                .unwrap()
                .keys()
                .any(|k| !allowed.contains(&k.as_str()))
            {
                bail!("Unsupported cache-warm fields.");
            }
            let limit = if let Some(v) = p.get("defaultLimit") {
                let s = v.as_str().ok_or_else(|| {
                    error(
                        "INVALID_REQUEST",
                        "Default warming limit must be a limit word.",
                    )
                })?;
                Some(self.integration.validate_warm_limit(s).await?)
            } else {
                None
            };
            if let Some(v) = p.get("ttlPreference") {
                ttl_preference(v)?;
            }
            if p.get("compactAfterWarm").is_some_and(|v| !v.is_boolean())
                || p.get("onUserMessage")
                    .is_some_and(|v| !matches!(v.as_str(), Some("continue" | "stop")))
            {
                bail!("Invalid cache-warm preference.");
            }
            if let Some(v) = p.get("ttlLastChoice") {
                if !v.is_object()
                    || v.as_object().unwrap().len() != 2
                    || !v["revision"].is_string()
                    || !matches!(v["ttl"].as_str(), Some("1h" | "5m"))
                {
                    bail!("Last TTL choice is invalid.");
                }
            }
            let writes = p
                .as_object()
                .unwrap()
                .keys()
                .any(|k| !["sessionId", "cwd"].contains(&k.as_str()));
            let mut s = self.state.lock().await;
            let mut next = s.clone();
            if writes && self.closed.load(std::sync::atomic::Ordering::Acquire) {
                bail!("Broker is stopping; new mutations are refused.");
            }
            if let Some(limit) = limit {
                next["defaultWarmLimit"] = json!(limit);
            }
            for (input, key) in [
                ("onUserMessage", "warmOnUserMessage"),
                ("compactAfterWarm", "compactAfterWarm"),
            ] {
                if let Some(v) = p.get(input) {
                    next[key] = v.clone();
                }
            }
            if let Some(v) = p.get("ttlPreference") {
                next["cacheTtlPreference"] = v.clone();
                if next["cacheTtlLastChoice"]["revision"] != v["revision"] {
                    next.as_object_mut().unwrap().remove("cacheTtlLastChoice");
                }
            }
            if let Some(v) = p.get("ttlLastChoice") {
                if next["cacheTtlPreference"]["mode"] != "remember"
                    || next["cacheTtlPreference"]["revision"] != v["revision"]
                {
                    bail!("Last TTL choice does not belong to the saved preference.");
                }
                next["cacheTtlLastChoice"] = v.clone();
            }
            let result = json!({"defaultLimit":next.get("defaultWarmLimit").cloned().unwrap_or(json!("for=4h")),"saved":next.get("defaultWarmLimit").is_some(),"onUserMessage":next.get("warmOnUserMessage").cloned().unwrap_or(json!("continue")),"compactAfterWarm":next.get("compactAfterWarm").cloned().unwrap_or(json!(true)),"ttlPreference":next["cacheTtlPreference"],"ttlLastChoice":next["cacheTtlLastChoice"]});
            self.commit(&mut s, next)?;
            return Ok(result);
        }
        if let Some(action) = method.strip_prefix("cache_warm_") {
            let allowed: &[&str] = match action {
                "list" => &["sessionId", "cwd"],
                "configure" => &[
                    "provider",
                    "sessionId",
                    "cwd",
                    "instanceId",
                    "enabled",
                    "requestId",
                    "ttl",
                    "maxMinutes",
                    "maxRefreshes",
                    "maxReadTokens",
                    "maxOutputTokens",
                    "fixedEnd",
                    "compact",
                ],
                "observe" => &[
                    "sessionId",
                    "cwd",
                    "instanceId",
                    "sequence",
                    "phase",
                    "epoch",
                    "sample",
                    "attemptId",
                ],
                "claim" => &["sessionId", "cwd", "instanceId", "epoch", "kind"],
                "check" => &["sessionId", "cwd", "instanceId", "epoch", "attemptId"],
                "receipt" => &[
                    "sessionId",
                    "cwd",
                    "instanceId",
                    "epoch",
                    "attemptId",
                    "outcome",
                ],
                _ => bail!("Unsupported cache-warm operation."),
            };
            if p.as_object()
                .unwrap()
                .keys()
                .any(|k| !allowed.contains(&k.as_str()))
            {
                bail!("Unsupported cache-warm fields.");
            }
            if !["list", "configure"].contains(&action) && e.peer != Provider::Claude {
                bail!(
                    "Native cache-warm observations and dispatch require the Claude session companion."
                );
            }
            if self.closed.load(std::sync::atomic::Ordering::Acquire)
                && action != "receipt"
                && !(action == "configure" && p["enabled"] == false)
                && !(action == "observe" && p["phase"] == "ended")
            {
                bail!("Broker is stopping; cache warming is refused.");
            }
        }
        let s = self.state.lock().await;
        let mut settings = json!({});
        for key in [
            "defaultWarmLimit",
            "cacheTtlPreference",
            "cacheTtlLastChoice",
            "warmOnUserMessage",
            "compactAfterWarm",
        ] {
            if let Some(v) = s.get(key) {
                settings[key] = v.clone();
            }
        }
        drop(s);
        self.integration
            .warm_dispatch(
                method,
                e.peer,
                p.clone(),
                settings,
                self.notification_stopped()?,
            )
            .await
    }
}
