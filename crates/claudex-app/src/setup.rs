//! Graphical application orchestration. Native effects are injected at their
//! domain boundary, while setup/status/shutdown authorization stays here.
use crate::{platform, providers::Providers};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::FileLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Ready,
    Missing,
    LoginRequired,
    Waiting,
    Blocked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Component {
    pub id: String,
    pub label: String,
    pub state: State,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}
fn row(
    id: &str,
    label: &str,
    state: State,
    detail: impl Into<String>,
    action: Option<&str>,
) -> Component {
    Component {
        id: id.into(),
        label: label.into(),
        state,
        detail: detail.into(),
        action: action.map(str::to_string),
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub phase: String,
    pub all_projects: bool,
    pub allow_write: bool,
    pub components: Vec<Component>,
    pub message: String,
    pub mod_settings: Value,
    pub mod_info: Value,
    pub completion_delivery: Value,
    pub folder_setup: Value,
}
#[derive(Clone, Debug, Default)]
pub struct Authentication {
    pub ready: bool,
    pub missing: bool,
    pub failed: bool,
}
#[async_trait]
pub trait AppRuntime: Send + Sync {
    async fn providers(&self, install: bool, reuse_signatures: bool) -> Result<Providers>;
    async fn authentication(
        &self,
        provider: &str,
        binary: Option<&std::path::Path>,
    ) -> Authentication;
    async fn mod_status(
        &self,
        providers: &Providers,
        install: bool,
        receiver: Option<bool>,
        enable: bool,
    ) -> Result<Value>;
    async fn broker_request(&self, method: &str, params: Value) -> Result<Value>;
    /// This verifies the live launchd path/program/arguments, not just its plist.
    async fn service(&self, provider: &str, action: &str) -> Result<Value>;
    async fn ownership(&self) -> Result<Value>;
    async fn install_interface(&self) -> Result<()>;
    async fn install_collaboration(&self, providers: &Providers) -> Result<()>;
    async fn configure_synchronization(&self, providers: &Providers) -> Result<()>;
    async fn login(&self, provider: &str, binary: &std::path::Path) -> Result<()>;
}
pub struct AppSetup<'a> {
    pub root: PathBuf,
    pub read_only: bool,
    pub runtime: &'a dyn AppRuntime,
}
impl AppSetup<'_> {
    pub fn writable(&self) -> Result<()> {
        ensure!(
            !self.read_only,
            "Read-only application inspection cannot change setup, accounts or services."
        );
        Ok(())
    }
    fn read(&self, name: &str) -> Result<Option<Value>> {
        platform::optional_json(&self.root.join(name), 1024 * 1024, true)
    }
    fn save(&self, name: &str, value: &Value) -> Result<()> {
        self.writable()?;
        platform::write_json(&self.root.join(name), value)
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if self.read_only {
            let read = [
                "list",
                "models",
                "mod_wake_status",
                "cache_warm_settings",
                "cache_warm_list",
                "codex_cache_warm_list",
            ]
            .contains(&method);
            ensure!(
                read && (!["cache_warm_settings", "models"].contains(&method)
                    || params.as_object().is_some_and(|v| v.is_empty())),
                "Read-only inspection cannot mutate broker settings."
            );
        }
        self.runtime.broker_request(method, params).await
    }
    pub async fn inspect(&self) -> Result<Report> {
        let providers = self.runtime.providers(false, true).await?;
        let m = self
            .runtime
            .mod_status(&providers, false, None, false)
            .await
            .unwrap_or(json!({"runtime":{"state":"blocked"},"installation":{"state":"blocked"}}));
        self.report(&providers, &m, &Default::default()).await
    }
    async fn report(
        &self,
        providers: &Providers,
        mod_status: &Value,
        notes: &std::collections::BTreeMap<String, String>,
    ) -> Result<Report> {
        let mut rows = vec![row(
            "projects",
            "Project access",
            State::Ready,
            "All projects are available by default. Agents work only on the task you assign; macOS permissions still apply.",
            None,
        )];
        if let Some(note) = notes.get("lifecycle") {
            rows.push(row(
                "lifecycle",
                "Claudex application",
                State::Blocked,
                note,
                Some("diagnostics"),
            ));
        }
        if let Some(note) = notes.get("interface").cloned().or_else(|| {
            self.read("app-interface-status.json")
                .ok()
                .flatten()
                .and_then(|v| v["error"].as_str().map(str::to_string))
        }) {
            rows.push(row(
                "interface",
                "Claudex application",
                State::Blocked,
                note,
                Some("retry"),
            ));
        }
        rows.push(row(
            "runtime",
            "Bundled runtime",
            State::Ready,
            "The native Rust setup engine is included in this app.",
            None,
        ));
        for (name, p) in [("codex", &providers.codex), ("claude", &providers.claude)] {
            let codex = name == "codex";
            rows.push(row(
                &format!("{name}-cli"),
                if codex { "Codex" } else { "Claude Code" },
                if p.binary.is_some() {
                    State::Ready
                } else {
                    State::Missing
                },
                p.version
                    .as_ref()
                    .map(|v| format!("Available: {v}"))
                    .unwrap_or("The official tool will be installed during setup.".into()),
                Some("retry"),
            ));
            let auth = self.runtime.authentication(name, p.binary.as_deref()).await;
            let state = if auth.ready {
                State::Ready
            } else if auth.missing {
                State::Missing
            } else if auth.failed {
                State::Blocked
            } else {
                State::LoginRequired
            };
            rows.push(row(
                &format!("{name}-login"),
                if codex {
                    "ChatGPT sign-in"
                } else {
                    "Claude sign-in"
                },
                state,
                if auth.ready {
                    "Native account sign-in is available. Credentials are not copied."
                } else if auth.missing {
                    "Install the native tool before signing in."
                } else if auth.failed {
                    "Native account status could not be verified. Use the official sign-in flow."
                } else {
                    "Sign in through the official provider in your browser."
                },
                Some(&format!("login-{name}")),
            ));
            rows.push(row(&format!("{name}-desktop"),if codex{"Codex Desktop integration"}else{"Claude Desktop integration"},if p.app.is_some(){State::Ready}else if p.app_issue.is_some(){State::Blocked}else{State::Missing},if p.app.is_some(){if p.app_signature==Some(crate::providers::Publisher::Local){"The installed app is a locally re-signed build of the official app.".into()}else{"The installed app has the expected vendor signature.".into()}}else{p.app_issue.clone().unwrap_or("Claudex expects this desktop app to be installed already. It will not download or replace it.".into())},Some(if p.app_issue.is_some(){"retry"}else if codex{"open-codex"}else{"open-claude"})));
        }
        let installation = &mod_status["installation"];
        let runtime = &mod_status["runtime"];
        let inline = &installation["modSettings"]["inline"];
        let mod_settings = if inline["nativeWake"].is_boolean() && inline["selfWake"].is_boolean() {
            json!({"nativeWake":inline["nativeWake"],"selfWake":inline["selfWake"]})
        } else {
            Value::Null
        };
        let mut mod_info = json!({"bundledVersion":installation["bundledVersion"],"installedVersion":installation["installedVersion"],"managerVersion":runtime["version"],"loadedVersion":null,"reason":installation["reason"].as_str().unwrap_or("unverified"),"route":null});
        let state = installation["state"].as_str().unwrap_or("blocked");
        let (state, detail, action) = match state {
            "ready" => (
                State::Ready,
                if installation["reason"] == "newer-installed-preserved" {
                    "A newer Claude Mod is installed. It was preserved instead of being downgraded."
                } else {
                    "The bundled Claude Mod is installed, enabled and verified."
                },
                "mod-setup",
            ),
            "disabled" => (
                State::Waiting,
                "Claude Mod is disabled. Your preference was preserved.",
                "mod-enable",
            ),
            "missing" => (
                State::Missing,
                "The Claude Mod and its management runtime will be installed automatically.",
                "mod-setup",
            ),
            "update-available" => (
                State::Missing,
                "A bundled Claude Mod update is available and will be installed automatically.",
                "mod-setup",
            ),
            _ => (
                State::Blocked,
                "Claude Mod installation needs attention. Use Install or update Claude Mod to retry; existing data is preserved.",
                "mod-setup",
            ),
        };
        rows.push(row("claude-mod", "Claude Mod", state, detail, Some(action)));
        if state == State::Ready {
            let observation = self.request("mod_wake_status", json!({})).await.ok();
            let current = observation
                .as_ref()
                .filter(|o| {
                    o["diagnosticOnly"] == true
                        && o["provenance"] == "mod-self-reported"
                        && o["brokerStopping"] != true
                })
                .and_then(|o| o["versions"].as_array())
                .and_then(|versions| {
                    versions.iter().find(|v| {
                        v["version"] == installation["installedVersion"]
                            && v["build"] == "observer-v1"
                            && v["observers"].as_u64().is_some_and(|v| v > 0)
                    })
                });
            let matching = current
                .and_then(|v| {
                    let total = v["observers"].as_i64()?;
                    let native = v["nativeWakeCount"].as_i64()?;
                    let self_wake = v["selfWakeCount"].as_i64()?;
                    let both = v["bothEnabledCount"].as_i64()?;
                    Some(
                        match (
                            mod_settings["nativeWake"].as_bool()?,
                            mod_settings["selfWake"].as_bool()?,
                        ) {
                            (true, true) => both,
                            (true, false) => native - both,
                            (false, true) => self_wake - both,
                            (false, false) => total - native - self_wake + both,
                        },
                    )
                })
                .is_some_and(|n| n > 0);
            if matching {
                mod_info["loadedVersion"] = installation["installedVersion"].clone();
            }
            if let Some(o) = &observation {
                if o["route"]
                    .as_str()
                    .is_some_and(|s| ["mod-self", "mod", "renderer"].contains(&s))
                {
                    mod_info["route"] = o["route"].clone();
                }
            }
            rows.push(row("claude-mod-activation","Claude Mod activation",if matching{State::Ready}else{State::Waiting},if matching{"The current Mod version is observed in a native Claude session. This is not proof of message delivery."}else{"Open a new Claude Code session and run /claudex to load the installed Mod. Existing sessions are not restarted."},if matching{None}else{Some("open-claude")}));
        }
        let broker = self.request("list", json!({})).await.ok();
        let broker_ready = broker.as_ref().is_some_and(|b| {
            b["limits"]["allowWrite"] == true
                && b["limits"]["defaultPermission"]
                    .as_str()
                    .is_some_and(|s| ["workspace-write", "full-access"].contains(&s))
        });
        let blocked = broker
            .as_ref()
            .is_some_and(|b| b["blockedByUncertainWork"] == true);
        rows.push(row("collaboration","Cross-model collaboration",if broker.is_none(){State::Missing}else if blocked{State::Blocked}else if broker_ready{State::Ready}else{State::Waiting},if blocked{"Some collaboration tasks could not be confirmed stopped. Only related work waits; other work continues."}else if broker_ready{"All projects are available for task-scoped file editing and handoff."}else{"The background broker and MCP connections will be configured automatically."},Some(if blocked{"resolve-uncertain"}else{"retry"})));
        let completion=broker.as_ref().and_then(|b|b.get("completionDelivery")).cloned().unwrap_or(json!({"diagnosticOnly":true,"deliveryGuaranteed":false,"selectedRoute":{"claude":null,"codex":"native-owner"},"originHooks":{"state":"unknown","codex":{"state":"unknown"},"claude":{"state":"unknown"}},"recipientReadiness":{"claude":{"state":"unknown","reason":"broker-unobserved"},"codex":{"state":"unknown","reason":"broker-unobserved"}},"nextStep":"Completion delivery capability is unavailable. Start or update the collaboration broker, then refresh status."}));
        let ready = completion_ready(&completion);
        rows.push(row("completion-delivery","Completion delivery",if ready{State::Ready}else{State::Waiting},if ready{"Origin hooks and the selected recipient routes report ready. Each message still requires native receipt."}else{completion["nextStep"].as_str().unwrap_or("Check the exact task notification status for origin hook trust, the selected route and recipient readiness.")},Some("diagnostics")));
        let config = self.read("config.json")?.unwrap_or(Value::Null);
        let folder_setup = self
            .read("app-folder-setup-status.json")?
            .unwrap_or(Value::Null);
        let watcher = self.read("watcher-status.json")?.unwrap_or(Value::Null);
        let now = chrono::Utc::now().timestamp_millis();
        let live = watcher["pid"].as_i64().is_some_and(alive)
            && watcher["running"] == true
            && watcher["updatedAt"]
                .as_i64()
                .is_some_and(|t| t <= now + 5000 && now - t < 90000);
        let policy = claudex_core::version::VersionPolicy::parse(Some(
            config["versionPolicy"].as_str().unwrap_or("warn"),
        ))?;
        let compatible = providers
            .codex
            .version
            .as_deref()
            .is_some_and(|v| policy.allows_codex(v))
            && (policy == claudex_core::version::VersionPolicy::Warn
                || providers
                    .claude
                    .version
                    .as_deref()
                    .and_then(|v| v.split_whitespace().next())
                    == Some("2.1.281"));
        let held = live
            && (watcher["synchronization"] == "blocked"
                || watcher["synchronization"] == "degraded"
                || truthy(&watcher["blocked"])
                || truthy(&watcher["blockedConversationCount"])
                || truthy(&watcher["blockedSourceCount"]));
        let initial = if watcher.get("checkingConversationCount").is_some() {
            &watcher["initialSweepCompletedAt"]
        } else {
            &watcher["foregroundCompletedAt"]
        };
        let sync = live
            && initial.is_number()
            && watcher["synchronization"] == "ready"
            && !truthy(&watcher["waiting"])
            && !held;
        rows.push(row("synchronization","Conversation synchronization",if config.is_null(){State::Missing}else if !compatible||held{State::Blocked}else if config["mode"]=="desktop"&&config["allProjects"]==true&&sync{State::Ready}else{State::Waiting},if !compatible{"This native runtime is outside the synchronization policy. Collaboration can still be set up independently."}else if held{watcher["blocked"]["reason"].as_str().unwrap_or("The running watcher has paused synchronization for history or ownership checks. Existing work is preserved; no input is resent.")}else if sync{"The watcher reports ready and is running for all projects."}else{"Waiting for a current ready watcher and shared Desktop backend. Do not restart active native work."},Some(if held{"diagnostics"}else{"retry"})));
        let checking = live
            && watcher["rendererAdapters"]["state"]
                .as_str()
                .is_some_and(|s| ["checking", "held"].contains(&s));
        let attempt = config["folderProjection"]["enabled"] == true
            && folder_setup["state"]
                .as_str()
                .is_some_and(|s| ["waiting", "refused"].contains(&s))
            && !(live
                && watcher["rendererAdapters"]["updatedAt"]
                    .as_i64()
                    .zip(folder_setup["updatedAt"].as_i64())
                    .is_some_and(|(a, b)| a >= b));
        let folder_error = watcher["folderProjection"]["state"] == "error"
            || attempt && folder_setup["state"] == "refused";
        rows.push(row("folders","Native project folders",if folder_error{State::Blocked}else if checking||attempt{State::Waiting}else if config["folderProjection"]["enabled"]==true&&live&&watcher["folderProjection"]["state"]=="ready"{State::Ready}else{State::Waiting},if folder_error{"Folder installation or mapping was refused. Review diagnostics; saved preferences and originals are preserved."}else if checking{"Desktop integration is waiting for Claudex to resume and finish checking. No action is required."}else{"The folder adapter is configured. Running-watcher verification and a normal idle Claude restart may still be required."},Some(if folder_error||checking||attempt{"diagnostics"}else{"retry"})));
        let handoff_error = watcher["localHandoff"]["state"] == "error";
        rows.push(row("handoffs","Native predecessor archival",if handoff_error{State::Blocked}else if config["desktopLocalHandoff"]["enabled"]==true&&live&&watcher["localHandoff"]["state"]=="ready"{State::Ready}else{State::Waiting},if handoff_error{"The native handoff coordinator reports an unresolved guard. Original histories are preserved."}else{"Each archival requires verified history and native lifecycle checks. Original conversations remain preserved."},Some(if handoff_error{"diagnostics"}else{"retry"})));
        for r in &mut rows {
            if let Some(note) = notes.get(&r.id) {
                r.state = State::Blocked;
                r.detail = note.clone();
                r.action = Some("retry".into());
            }
        }
        let phase = if rows.iter().all(|r| r.state == State::Ready) {
            "ready"
        } else if rows.iter().any(|r| r.state == State::Blocked) {
            "blocked"
        } else if rows
            .iter()
            .any(|r| matches!(r.state, State::Missing | State::LoginRequired))
        {
            "needs-action"
        } else {
            "waiting"
        };
        Ok(Report {
            version: 1,
            phase: phase.into(),
            all_projects: true,
            allow_write: true,
            components: rows,
            message: if phase == "ready" {
                "Claudex is configured for all projects."
            } else if phase == "waiting" {
                "Some integrations are waiting. Review the reported reasons and next steps."
            } else {
                "Independent features stay available while the remaining requirements are resolved."
            }
            .into(),
            mod_settings,
            mod_info,
            completion_delivery: completion,
            folder_setup,
        })
    }
    pub async fn setup(&self) -> Result<Report> {
        self.writable()?;
        platform::create_private(&self.root)?;
        let _lock = FileLock::acquire(&self.root.join("app-setup.lock"), true)?;
        let mut notes = std::collections::BTreeMap::new();
        if self.runtime.install_interface().await.is_err() {
            notes.insert("interface".into(),"Application login integration could not be verified. Existing entries were preserved.".into());
        }
        let providers = self.runtime.providers(true, false).await?;
        let m = self
            .runtime
            .mod_status(&providers, true, None, false)
            .await?;
        if providers.codex.app.is_some() && providers.claude.app.is_some() {
            let a = self
                .runtime
                .authentication("codex", providers.codex.binary.as_deref())
                .await;
            let b = self
                .runtime
                .authentication("claude", providers.claude.binary.as_deref())
                .await;
            if a.ready && b.ready {
                if self
                    .runtime
                    .install_collaboration(&providers)
                    .await
                    .is_err()
                {
                    notes.insert("collaboration".into(),"Collaboration setup could not complete. Existing native settings and work were preserved.".into());
                }
                if self
                    .runtime
                    .configure_synchronization(&providers)
                    .await
                    .is_err()
                {
                    notes.insert("synchronization".into(),"Synchronization setup could not complete. Existing ownership and histories were preserved.".into());
                }
            }
        }
        let report = self.report(&providers, &m, &notes).await?;
        let mut value = serde_json::to_value(&report)?;
        value["updatedAt"] = json!(chrono::Utc::now().timestamp_millis());
        self.save("app-setup-status.json", &value)?;
        Ok(report)
    }
    pub async fn mod_setup(&self, receiver: Option<bool>, enable: bool) -> Result<Report> {
        self.writable()?;
        platform::create_private(&self.root)?;
        let _lock = FileLock::acquire(&self.root.join("app-setup.lock"), true)?;
        let providers = self.runtime.providers(false, false).await?;
        let m = self
            .runtime
            .mod_status(&providers, true, receiver, enable)
            .await?;
        let report = self.report(&providers, &m, &Default::default()).await?;
        let mut value = serde_json::to_value(&report)?;
        value["updatedAt"] = json!(chrono::Utc::now().timestamp_millis());
        self.save("app-setup-status.json", &value)?;
        Ok(report)
    }
    pub async fn stop_status(&self) -> Result<Value> {
        let sync = self.runtime.service("synchronization", "status").await?;
        let collaboration = self.runtime.service("collaboration", "status").await?;
        let owners = self.runtime.ownership().await?;
        let blockers = owners["blockers"].as_array().cloned().unwrap_or_default();
        ensure!(
            blockers.iter().all(|b| b["code"].as_str().is_some_and(|c| [
                "live-owner",
                "live-native-child"
            ]
            .contains(&c))),
            "Cannot verify synchronization shutdown. Existing ownership evidence was preserved."
        );
        let stopped = sync["loaded"] == false
            && collaboration["stopped"] == true
            && owners["allowed"] == true;
        Ok(
            json!({"stopped":stopped,"detail":if stopped{"All Claudex services have stopped."}else{"Waiting for Claudex services and their native work to exit safely."},"synchronization":{"loaded":sync["loaded"],"ownerBlockerCount":owners["blockerCount"].as_u64().unwrap_or(blockers.len()as u64)},"collaboration":{"loaded":collaboration["loaded"],"stopped":collaboration["stopped"]}}),
        )
    }
    pub async fn stop(&self) -> Result<Value> {
        self.writable()?;
        platform::create_private(&self.root)?;
        let _lock = FileLock::acquire(&self.root.join("app-setup.lock"), true)?;
        let previous = platform::stop_state(&self.root)?;
        self.save("app-stop.json",&json!({"version":1,"stopped":true,"requestedAt":previous.as_ref().filter(|v|v["stopped"]==true).and_then(|v|v.get("requestedAt")).cloned().unwrap_or(json!(chrono::Utc::now().timestamp_millis()))}))?;
        let mut failures = vec![];
        for service in ["synchronization", "collaboration"] {
            if let Err(e) = self.runtime.service(service, "stop").await {
                failures.push(e.to_string());
            }
        }
        ensure!(
            failures.is_empty(),
            "Services could not stop safely; the application hold and ownership evidence were preserved."
        );
        self.stop_status().await
    }
    pub async fn resume(&self) -> Result<()> {
        self.writable()?;
        if !platform::stop_state(&self.root)?.is_some_and(|s| s["stopped"] == true) {
            return Ok(());
        }
        let _lock = FileLock::acquire(&self.root.join("app-setup.lock"), true)?;
        let Some(mut state) = platform::stop_state(&self.root)?.filter(|s| s["stopped"] == true)
        else {
            return Ok(());
        };
        if state["resuming"] != true {
            let status = self.stop_status().await?;
            ensure!(
                !(status["synchronization"]["loaded"] == false
                    && truthy(&status["synchronization"]["ownerBlockerCount"])
                    || status["collaboration"]["loaded"] == false
                        && status["collaboration"]["stopped"] != true),
                "Previous shutdown is still draining native work."
            );
            state["resuming"] = json!(true);
            self.save("app-stop.json", &state)?;
        }
        if self.read("service-install.json")?.is_some() {
            self.runtime.service("synchronization", "start").await?;
        }
        let collaboration = self.runtime.service("collaboration", "status").await?;
        if collaboration["installed"] == true {
            self.runtime.service("collaboration", "start").await?;
        }
        self.save(
            "app-stop.json",
            &json!({"version":1,"stopped":false,"resumedAt":chrono::Utc::now().timestamp_millis()}),
        )
    }
    pub async fn startup(&self) -> Result<Report> {
        self.writable()?;
        platform::create_private(&self.root)?;
        let mut notes = std::collections::BTreeMap::new();
        if self.resume().await.is_err() {
            notes.insert("lifecycle".into(),"Previous shutdown is still draining native work. Existing services were preserved.".into());
        }
        if self.runtime.install_interface().await.is_err() {
            notes.insert(
                "interface".into(),
                "Application login integration could not be verified.".into(),
            );
        }
        let providers = self.runtime.providers(false, false).await?;
        let _lock = FileLock::acquire(&self.root.join("app-setup.lock"), true)?;
        let m=self.runtime.mod_status(&providers,true,None,false).await.unwrap_or(json!({"runtime":{"state":"blocked"},"installation":{"state":"blocked","reason":"startup-mod-maintenance"}}));
        self.report(&providers, &m, &notes).await
    }
    pub async fn login(&self, provider: &str) -> Result<Report> {
        self.writable()?;
        ensure!(
            ["claude", "codex"].contains(&provider),
            "Unknown account provider."
        );
        let providers = self.runtime.providers(false, false).await?;
        let binary = if provider == "codex" {
            providers.codex.binary.as_deref()
        } else {
            providers.claude.binary.as_deref()
        };
        if let Some(binary) = binary {
            self.runtime.login(provider, binary).await?;
            self.setup().await
        } else {
            self.inspect().await
        }
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn alive(pid: i64) -> bool {
    pid > 0
        && pid <= i32::MAX as i64
        && (unsafe { libc::kill(pid as i32, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}
pub fn completion_ready(v: &Value) -> bool {
    v["diagnosticOnly"] == true
        && v["deliveryGuaranteed"] == false
        && v["originHooks"]["state"] == "ready"
        && ["codex", "claude"]
            .iter()
            .all(|p| v["originHooks"][*p]["state"] == "ready")
        && v["recipientReadiness"]["claude"]["state"]
            .as_str()
            .is_some_and(|s| ["observed", "ready"].contains(&s))
        && v["recipientReadiness"]["codex"]["state"] != "waiting"
}

impl AppSetup<'_> {
    pub async fn warm_settings(&self, params: Value) -> Result<Value> {
        ensure!(params.is_object(), "Cache settings must be an object.");
        let settings = self.request("cache_warm_settings", params).await?;
        let preference = &settings["ttlPreference"];
        let last = &settings["ttlLastChoice"];
        let startup = if preference.is_null() || preference["mode"] == "session" {
            Value::Null
        } else if preference["mode"] == "remember" && last["revision"] == preference["revision"] {
            last["ttl"].clone()
        } else {
            preference["ttl"].clone()
        };
        let now = chrono::Utc::now().timestamp_millis();
        let mut warming = vec![];
        let mut active = json!({});
        for (provider, method) in [
            ("claude", "cache_warm_list"),
            ("codex", "codex_cache_warm_list"),
        ] {
            match self.request(method, json!({})).await {
                Ok(list) => {
                    let policies = list["policies"]
                        .as_array()
                        .context("Unsupported warming enrollment response.")?;
                    let running: Vec<_> = policies
                        .iter()
                        .filter(|p| {
                            p["enabled"] == true && p["until"].as_i64().is_some_and(|v| v > now)
                        })
                        .collect();
                    active[provider] = json!(running.len());
                    for p in running.into_iter().take(32) {
                        warming.push(json!({"provider":provider,"sessionId":p["sessionId"],"cwd":p["cwd"],"ttl":if provider=="claude"{p["ttlPreference"].clone()}else{Value::Null},"used":p["totals"]["refreshes"].as_u64().unwrap_or(0),"max":p["maxRefreshes"],"until":p["until"],"nextAt":p["nextAt"]}));
                    }
                }
                Err(_) => active[provider] = Value::Null,
            }
        }
        Ok(
            json!({"defaultLimit":settings["defaultLimit"],"saved":settings["saved"],"onUserMessage":settings["onUserMessage"].as_str().unwrap_or("continue"),"compactAfterWarm":settings["compactAfterWarm"]!=false,"ttlMode":preference["mode"],"startupTtl":startup,"active":active,"warming":warming}),
        )
    }
    pub async fn warm_stop(&self, provider: &str, session: &str, cwd: &str) -> Result<Value> {
        self.writable()?;
        ensure!(
            ["claude", "codex"].contains(&provider),
            "Unknown cache-warming provider."
        );
        let params = if provider == "codex" {
            json!({"sessionId":session,"cwd":cwd})
        } else {
            json!({"provider":provider,"sessionId":session,"cwd":cwd,"enabled":false,"requestId":format!("app-cache-warm:{}",uuid::Uuid::new_v4())})
        };
        self.request(
            if provider == "codex" {
                "codex_cache_warm_off"
            } else {
                "cache_warm_configure"
            },
            params,
        )
        .await?;
        self.warm_settings(json!({})).await
    }
    pub async fn resolve_uncertain(&self) -> Result<Value> {
        self.writable()?;
        let broker = self.request("list", json!({})).await?;
        let mut resolved = 0;
        let mut failed = vec![];
        for summary in broker["uncertainTasks"].as_array().into_iter().flatten() {
            let id = summary["id"].clone();
            let operation=async{let task=self.request("status",json!({"taskId":id})).await?;if task["status"]!="uncertain"{return Ok::<_,anyhow::Error>(false)}let execution=task.get("active").filter(|v|!v.is_null()).unwrap_or(&task["lastExecution"]);let attestation="The user confirmed in the Claudex app that no worker from this task is still running.";let mut params=json!({"taskId":task["id"],"revision":task["revision"],"outcome":"failed","requestId":format!("app-resolve-{}-{}",task["id"].as_str().unwrap_or(""),task["revision"]),"reason":"Closed from the Claudex app after an unknown native outcome. Nothing was rerun."});if task["permission"]!="read-only"{params["workspaceReconciled"]=json!(true);params["reconciliationNotes"]=json!(format!("{attestation} Any file changes it made were kept for review."));}if truthy(&execution["processInventoryError"]){params["processInventoryReconciled"]=json!(true);params["processInventoryNotes"]=json!(attestation);}self.request("resolve",params).await?;Ok(true)}.await;
            match operation{Ok(true)=>resolved+=1,Ok(false)=>{},Err(_)=>failed.push(json!({"taskId":id,"error":"The native operation did not complete. Existing settings and histories were preserved."}))}
        }
        Ok(json!({"resolved":resolved,"failed":failed}))
    }
}

pub async fn dispatch(args: &[String], runtime: &dyn AppRuntime) -> Result<Value> {
    let options = platform::Options::parse(args)?;
    let root = options.path("root").unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share/claudex")
    });
    let app = AppSetup {
        root,
        read_only: options.flag("read-only"),
        runtime,
    };
    Ok(match options.action() {
        "" | "inspect" => serde_json::to_value(app.inspect().await?)?,
        "setup" => serde_json::to_value(app.setup().await?)?,
        "startup" => serde_json::to_value(app.startup().await?)?,
        "stop" => app.stop().await?,
        "stop-status" => app.stop_status().await?,
        "mod-setup" => {
            let receiver = options
                .values
                .get("receiver")
                .map(|v| match v.as_str() {
                    "enabled" => Ok(true),
                    "disabled" => Ok(false),
                    _ => bail!("Invalid Mod receiver choice."),
                })
                .transpose()?;
            serde_json::to_value(app.mod_setup(receiver, options.flag("enable")).await?)?
        }
        "login" => serde_json::to_value(
            app.login(
                options
                    .values
                    .get("provider")
                    .context("--provider is required.")?,
            )
            .await?,
        )?,
        "resolve-uncertain" => app.resolve_uncertain().await?,
        "warm-stop" => {
            app.warm_stop(
                options
                    .values
                    .get("provider")
                    .context("--provider is required.")?,
                options
                    .values
                    .get("session")
                    .context("--session is required.")?,
                options.values.get("cwd").context("--cwd is required.")?,
            )
            .await?
        }
        "warm-settings" => {
            let mut params = json!({});
            for (flag, key) in [
                ("default-limit", "defaultLimit"),
                ("on-message", "onUserMessage"),
            ] {
                if let Some(v) = options.values.get(flag) {
                    params[key] = json!(v);
                }
            }
            if let Some(v) = options.values.get("compact-after") {
                params["compactAfterWarm"] = json!(match v.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => bail!("Compaction after warming is on or off."),
                });
            }
            if let Some(mode) = options.values.get("ttl-mode") {
                let ttl = options.values.get("ttl");
                let mut p = json!({"version":1,"mode":mode});
                if let Some(ttl) = ttl {
                    p["ttl"] = json!(ttl);
                }
                if mode == "remember" {
                    p["revision"] = json!(format!("warm-{}", uuid::Uuid::new_v4()));
                }
                let preference: crate::warm::TtlPreference = serde_json::from_value(p.clone())?;
                preference.validate()?;
                params["ttlPreference"] = p;
            } else {
                ensure!(
                    !options.values.contains_key("ttl"),
                    "A TTL needs its startup mode."
                );
            }
            app.warm_settings(params).await?
        }
        "models" => {
            let mut params = json!({});
            for (flag, key) in [("model", "defaultModels"), ("effort", "defaultEfforts")] {
                let codex = options.values.get(&format!("codex-{flag}"));
                let claude = options.values.get(&format!("claude-{flag}"));
                ensure!(
                    codex.is_some() == claude.is_some(),
                    "Both provider {flag} settings are required."
                );
                if let (Some(codex), Some(claude)) = (codex, claude) {
                    let setting = |v: &str| {
                        if v.trim().is_empty() {
                            Value::Null
                        } else {
                            json!(v.trim())
                        }
                    };
                    params[key] = json!({"codex":setting(codex),"claude":setting(claude)});
                }
            }
            if let Some(permission) = options.values.get("default-permission") {
                params["defaultPermission"] = json!(permission);
            }
            app.request("models", params).await?
        }
        _ => bail!("Unsupported application action."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, sync::Mutex};
    struct Runtime {
        root: PathBuf,
        calls: Mutex<Vec<String>>,
        fail_sync: bool,
    }
    #[async_trait]
    impl AppRuntime for Runtime {
        async fn providers(&self, _: bool, _: bool) -> Result<Providers> {
            Ok(Providers {
                codex: Default::default(),
                claude: Default::default(),
            })
        }
        async fn authentication(&self, _: &str, _: Option<&std::path::Path>) -> Authentication {
            Authentication {
                missing: true,
                ..Default::default()
            }
        }
        async fn mod_status(
            &self,
            _: &Providers,
            _: bool,
            _: Option<bool>,
            _: bool,
        ) -> Result<Value> {
            Ok(json!({"installation":{"state":"missing"}}))
        }
        async fn broker_request(&self, method: &str, _: Value) -> Result<Value> {
            self.calls.lock().unwrap().push(method.into());
            Ok(json!({}))
        }
        async fn service(&self, provider: &str, action: &str) -> Result<Value> {
            if action == "stop" {
                assert!(platform::stopped(&self.root)?);
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{provider}:{action}"));
                if provider == "synchronization" && self.fail_sync {
                    bail!("busy owner")
                }
            }
            Ok(json!({"loaded":false,"stopped":true,"installed":false}))
        }
        async fn ownership(&self) -> Result<Value> {
            Ok(json!({"allowed":true,"blockers":[]}))
        }
        async fn install_interface(&self) -> Result<()> {
            bail!("not called")
        }
        async fn install_collaboration(&self, _: &Providers) -> Result<()> {
            bail!("not called")
        }
        async fn configure_synchronization(&self, _: &Providers) -> Result<()> {
            bail!("not called")
        }
        async fn login(&self, _: &str, _: &std::path::Path) -> Result<()> {
            bail!("not called")
        }
    }
    #[tokio::test]
    async fn app_stop_hold_precedes_both_service_stops_even_if_one_refuses() {
        let t = tempfile::tempdir().unwrap();
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = std::fs::canonicalize(t.path()).unwrap();
        let runtime = Runtime {
            root: root.clone(),
            calls: Mutex::default(),
            fail_sync: true,
        };
        let app = AppSetup {
            root: root.clone(),
            read_only: false,
            runtime: &runtime,
        };
        assert!(app.stop().await.is_err());
        assert!(platform::stopped(&root).unwrap());
        assert_eq!(
            *runtime.calls.lock().unwrap(),
            vec!["synchronization:stop", "collaboration:stop"]
        );
    }
    #[tokio::test]
    async fn read_only_refuses_mutations_before_native_calls() {
        let t = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            root: t.path().into(),
            calls: Mutex::default(),
            fail_sync: false,
        };
        let app = AppSetup {
            root: t.path().into(),
            read_only: true,
            runtime: &runtime,
        };
        assert!(app.setup().await.is_err());
        assert!(app.stop().await.is_err());
        assert!(
            app.request("models", json!({"defaultPermission":"workspace-write"}))
                .await
                .is_err()
        );
        assert!(runtime.calls.lock().unwrap().is_empty());
        assert!(!t.path().join("app-stop.json").exists());
    }
    #[test]
    fn completion_global_readiness_requires_hooks_and_claude_receiver_not_codex_task() {
        let mut v = json!({"diagnosticOnly":true,"deliveryGuaranteed":false,"originHooks":{"state":"ready","codex":{"state":"ready"},"claude":{"state":"ready"}},"recipientReadiness":{"claude":{"state":"observed"},"codex":{"state":"unknown"}}});
        assert!(completion_ready(&v));
        v["recipientReadiness"]["codex"]["state"] = json!("waiting");
        assert!(!completion_ready(&v));
        v["recipientReadiness"]["codex"]["state"] = json!("unknown");
        v["originHooks"]["claude"]["state"] = json!("unknown");
        assert!(!completion_ready(&v));
    }
}
