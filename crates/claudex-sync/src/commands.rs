//! Stable synchronization command entry points, with no JavaScript fallback.
use crate::{
    bridge::{Bridge, Side},
    desktop::{DesktopBridge, Record},
    discovery,
    events::{Inbox, Kind, Receipt},
    hooks, native,
    runtime::{Options as RuntimeOptions, Runtime},
};
use anyhow::{Result, bail, ensure};
use async_trait::async_trait;
use claudex_core::storage::{self, FileLock};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

#[derive(Default)]
struct Args {
    positionals: Vec<String>,
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}
impl Args {
    fn parse(raw: &[String]) -> Result<Self> {
        let mut args = Self::default();
        let mut input = raw.iter();
        while let Some(value) = input.next() {
            if let Some(key) = value.strip_prefix("--") {
                if matches!(key, "help" | "watch") {
                    args.flags.insert(key.into());
                    continue;
                }
                let (key, inline) = key
                    .split_once('=')
                    .map(|(k, v)| (k, Some(v)))
                    .unwrap_or((key, None));
                ensure!(
                    [
                        "root",
                        "from",
                        "source",
                        "id",
                        "title",
                        "record-id",
                        "expected-count",
                        "expected-digest",
                        "provider"
                    ]
                    .contains(&key),
                    "Unknown synchronization option: --{key}"
                );
                let value = inline
                    .map(str::to_owned)
                    .or_else(|| input.next().cloned())
                    .ok_or_else(|| anyhow::anyhow!("Option --{key} requires a value."))?;
                ensure!(!value.contains('\0'), "Option contains NUL byte.");
                args.values.insert(key.into(), value);
            } else {
                args.positionals.push(value.clone());
            }
        }
        Ok(args)
    }
    fn value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
    fn required(&self, key: &str) -> Result<&str> {
        self.value(key)
            .ok_or_else(|| anyhow::anyhow!("Missing --{key}."))
    }
    fn id(&self) -> Result<&str> {
        self.positionals
            .get(1)
            .map(String::as_str)
            .ok_or_else(|| anyhow::anyhow!("A conversation ID is required."))
    }
}
fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Home directory is unavailable."))
}
fn root(args: &Args) -> Result<PathBuf> {
    let path = args
        .value("root")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDEX_HOME").map(PathBuf::from))
        .unwrap_or(home()?.join(".local/share/claudex"));
    storage::private_directory(path)
}
fn output(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
fn legacy(root: &Path, config: &Value) -> Result<Bridge> {
    let drivers = native::drivers(native::NativeOptions {
        root: root.into(),
        codex_home: config["codexHome"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing Codex home."))?
            .into(),
        claude_home: config["claudeHome"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing Claude home."))?
            .into(),
        binary: config["binary"].as_str().unwrap_or("codex").into(),
        desktop_registry: Some(
            home()?.join("Library/Application Support/Claude/claude-code-sessions"),
        ),
    });
    let mut bridge = Bridge::new(root, drivers);
    if let Some(policy) = config.get("policy") {
        bridge.policy = serde_json::from_value(policy.clone())?;
    }
    Ok(bridge)
}
#[async_trait]
pub trait WatchLifecycle: Send + Sync {
    async fn start(
        &self,
        source: &crate::event_source::Source,
        root: &Path,
        config: &Value,
    ) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    fn status(&self) -> Value {
        Value::Null
    }
    fn restart(&self) -> Value {
        Value::Null
    }
}
pub async fn run(raw: &[String]) -> Result<()> {
    run_with(raw, None).await
}
pub async fn run_with(raw: &[String], lifecycle: Option<Arc<dyn WatchLifecycle>>) -> Result<()> {
    let args = Args::parse(raw)?;
    let command = args
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or("help");
    if args.flags.contains("help") || command == "help" {
        println!(
            "Claudex synchronization: track, sync, watch, gc, recover, abort, untrack, resume-tracking, split-original, archive-original, hooks install|status"
        );
        return Ok(());
    }
    let root = root(&args)?;
    let config = storage::read_json_or(root.join("config.json"), Value::Null)?;
    ensure!(
        config["version"] == 1,
        "Run claudex init before synchronization."
    );
    if command == "hooks" {
        let options = hooks::Options {
            root: root.clone(),
            codex_home: config["codexHome"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing Codex home."))?
                .into(),
            claude_home: config["claudeHome"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing Claude home."))?
                .into(),
            executable: std::env::current_exe()?,
        };
        return output(&match args.positionals.get(1).map(String::as_str) {
            Some("install") => hooks::install(&options)?,
            Some("status") => hooks::inspect(&options)?,
            _ => bail!("Use hooks install or hooks status."),
        });
    }
    if config["mode"] == "desktop" {
        let runtime = Runtime::new(RuntimeOptions::from_config(&root, &config)?)?;
        let mut bridge = runtime.bridge();
        if let Some(policy) = config.get("policy") {
            bridge.policy = serde_json::from_value(policy.clone())?;
        }
        if command == "watch" {
            return watch_desktop_with(runtime, bridge, &config, lifecycle).await;
        }
        let result = match command {
            "track" => {
                let side: Side = args.required("from")?.parse()?;
                bridge
                    .track(
                        Record::source(
                            side,
                            Path::new(args.required("source")?),
                            args.value("id").unwrap_or(""),
                        ),
                        args.value("title"),
                    )
                    .await
            }
            "sync" => bridge.sync(args.id()?).await,
            "recover" => bridge.recover().await,
            "abort" => bridge.abandon_unapplied().await,
            "gc" => bridge.collect().await,
            "untrack" => bridge.untrack(args.id()?, false).await,
            "resume-tracking" => bridge.resume_tracking(args.id()?).await,
            "split-original" => {
                bridge
                    .split_original(
                        args.id()?,
                        args.required("id")?,
                        args.required("record-id")?,
                        crate::desktop::Checkpoint {
                            count: args.required("expected-count")?.parse()?,
                            digest: Some(args.required("expected-digest")?.into()),
                        },
                    )
                    .await
            }
            "archive-original" => {
                bridge
                    .archive_original(args.id()?, args.required("id")?)
                    .await
            }
            _ => bail!("Unknown synchronization command: {command}"),
        };
        let close = close_runtime(&runtime).await;
        if result.is_ok() {
            close?;
        } else if let Err(error) = close {
            return Err(error.context(format!(
                "Synchronization also failed: {}",
                result.as_ref().unwrap_err()
            )));
        }
        return output(&result?);
    }
    let bridge = legacy(&root, &config)?;
    let result = match command {
        "track" => {
            bridge
                .track(
                    args.required("from")?.parse()?,
                    Path::new(args.required("source")?),
                    args.value("title"),
                )
                .await?
        }
        "sync" => {
            bridge
                .sync(args.id()?, args.required("from")?.parse()?)
                .await?
        }
        "recover" => bridge.recover().await?,
        "abort" => bridge.abort().await?,
        "gc" => bridge.collect().await?,
        "watch" => return watch_legacy(bridge, &config).await,
        "untrack" | "resume-tracking" | "split-original" | "archive-original" => {
            bail!("This enrollment command requires Desktop mode.")
        }
        _ => bail!("Unknown synchronization command: {command}"),
    };
    output(&result)
}
fn discovery_options(config: &Value, only: Option<HashSet<String>>) -> Result<discovery::Options> {
    Ok(discovery::Options {
        codex_home: config["codexHome"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing Codex home."))?
            .into(),
        claude_home: config["claudeHome"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing Claude home."))?
            .into(),
        projects: config["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                p.as_str()
                    .map(PathBuf::from)
                    .ok_or_else(|| anyhow::anyhow!("Invalid project path."))
            })
            .collect::<Result<_>>()?,
        all_projects: config["allProjects"] == true,
        since: config["since"].as_i64().unwrap_or(0),
        exclude_subagents: true,
        only_keys: only,
    })
}
fn desktop_discovery_options(
    config: &Value,
    only: Option<HashSet<String>>,
) -> Result<discovery::Options> {
    let mut options = discovery_options(config, only)?;
    // Desktop's native adapter classifies exact API metadata before history
    // reads. Legacy discovery retains its original header-filter contract.
    options.exclude_subagents = false;
    Ok(options)
}
async fn discover_desktop(
    bridge: &DesktopBridge,
    config: &Value,
    only: Option<HashSet<String>>,
) -> Result<Value> {
    let known = bridge
        .status()?
        .records
        .iter()
        .map(|r| format!("{}:{}", r.side.name(), r.native_id))
        .collect();
    let mut unsupported = vec![];
    let mut absent = vec![];
    let mut enrolled = vec![];
    for source in discovery::discover(&desktop_discovery_options(config, only)?, &known)? {
        if matches!(fs::symlink_metadata(&source.cwd),Err(e)if e.kind()==std::io::ErrorKind::NotFound)
        {
            if absent.len() < 100 {
                absent.push(json!({"side":source.side,"nativeId":source.native_id,"reason":"working-directory-missing"}));
            }
            continue;
        }
        match bridge
            .track(
                Record::source(source.side, &source.path, &source.native_id),
                None,
            )
            .await
        {
            Ok(result) => enrolled.push(result),
            Err(error) if error.is::<discovery::CodexSubagentSource>() => (),
            Err(error) => {
                if unsupported.len() < 100 {
                    unsupported.push(json!({"side":source.side,"nativeId":source.native_id,"reason":format!("{error:#}")}));
                }
            }
        }
    }
    Ok(json!({"enrolled":enrolled,"unsupportedSources":unsupported,"absentSources":absent}))
}
fn diagnostics(root: &Path, value: &Value) -> Result<()> {
    storage::write_diagnostic_json(root.join("watcher-status.json"), value)
}
fn folder_view(map: &Value, renderer: &Value) -> Value {
    if map.is_null() || map["state"] == "error" || !map["deferred"].is_null() {
        return map.clone();
    }
    let mut view = map.clone();
    let resource = renderer["adapters"]["folders"].clone();
    view["resource"] = resource.clone();
    if matches!(renderer["state"].as_str(), Some("checking" | "held")) {
        if map["state"] == "ready" {
            view["state"] = json!("waiting");
        }
    } else if resource["status"] == "skipped" {
        view["state"] = json!("error");
        view["error"] = resource["reason"].clone();
    }
    view
}
fn watch_status(
    blocked: &BTreeMap<String, String>,
    pending: Option<&str>,
    discovery: &Value,
    held: bool,
    lifecycle: Option<&Arc<dyn WatchLifecycle>>,
    remaining: Option<usize>,
    initial_sweep_completed_at: Option<i64>,
) -> Value {
    let at = storage::now_ms();
    let sources = discovery["unsupportedSources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let absent = discovery["absentSources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    json!({"version":1,"pid":std::process::id(),"mode":"desktop","running":true,"scheduler":"completion-events","eventDriven":true,"updatedAt":at,"at":at,"applicationHold":held,
        "synchronization":if pending.is_some(){"blocked"}else if !blocked.is_empty(){"degraded"}else if held{"waiting"}else{"ready"},
        "blocked":pending.map(|reason|json!({"scope":"pending","reason":reason})),"pendingError":pending,
        "blockedConversationCount":blocked.len(),"blockedConversations":blocked.iter().take(20).map(|(id,reason)|json!({"conversationId":id,"reason":reason})).collect::<Vec<_>>(),
        "blockedSourceCount":sources.len(),"blockedSources":sources,"absentSourceCount":absent.len(),"absentSources":absent,
        "waiting":if held{Some("Application synchronization is held while setup or resume completes.")}else{None},
        "discovery":discovery,"rendererAdapters":lifecycle.map(|l|l.status()).unwrap_or(Value::Null),"claudeDesktopRestart":lifecycle.map(|l|l.restart()).unwrap_or(Value::Null),
        "initialSweepRemaining":remaining,"initialSweepCompletedAt":initial_sweep_completed_at,
        "foregroundCompletedAt":remaining.filter(|n|*n==0).map(|_|at)})
}
fn signal() -> Result<tokio::sync::watch::Receiver<bool>> {
    let (send, receive) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let result = async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut interrupt =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
            tokio::select! {_=terminate.recv()=>(),_=interrupt.recv()=>()};
            let _ = send.send(true);
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            let _ = send.send(true);
        }
    });
    Ok(receive)
}
fn merge_discovery(previous: &mut Value, update: Value, only: Option<&HashSet<String>>) {
    for field in ["unsupportedSources", "absentSources"] {
        let mut rows = if let Some(keys) = only {
            previous[field]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| {
                    let key = format!(
                        "{}:{}",
                        row["side"].as_str().unwrap_or(""),
                        row["nativeId"].as_str().unwrap_or("").to_lowercase()
                    );
                    !keys.contains(&key)
                })
                .cloned()
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        rows.extend(update[field].as_array().into_iter().flatten().cloned());
        rows.truncate(100);
        previous[field] = json!(rows);
    }
}
async fn close_runtime(runtime: &Runtime) -> Result<()> {
    loop {
        match runtime.close().await {
            Ok(()) => return Ok(()),
            Err(error) if error.to_string().contains("owner is busy") => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(error) => return Err(error),
        }
    }
}
fn handoff_publication_needed(full: bool, scope: &BTreeSet<String>, revoked: bool) -> bool {
    full || !scope.is_empty() || revoked
}
pub async fn watch_desktop(
    runtime: Arc<Runtime>,
    bridge: DesktopBridge,
    config: &Value,
) -> Result<()> {
    watch_desktop_with(runtime, bridge, config, None).await
}
pub async fn watch_desktop_with(
    runtime: Arc<Runtime>,
    bridge: DesktopBridge,
    config: &Value,
    lifecycle: Option<Arc<dyn WatchLifecycle>>,
) -> Result<()> {
    watch_desktop_control(runtime, bridge, config, lifecycle, None).await
}
async fn watch_desktop_control(
    runtime: Arc<Runtime>,
    bridge: DesktopBridge,
    config: &Value,
    lifecycle: Option<Arc<dyn WatchLifecycle>>,
    control: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<()> {
    let _watch = FileLock::acquire(&bridge.root.join("watch.lock"), true)?;
    let inbox = Inbox::new(&bridge.root)?;
    let listener = inbox.listen().await?;
    let mut source =
        match crate::event_source::Source::start(runtime.clone(), config, inbox.clone()) {
            Ok(source) => source,
            Err(error) => {
                listener.close().await?;
                return Err(error);
            }
        };
    let mut shutdown = match control.map(Ok).unwrap_or_else(signal) {
        Ok(shutdown) => shutdown,
        Err(error) => {
            source.close().await?;
            listener.close().await?;
            return Err(error);
        }
    };
    let scheduler = runtime.cold_scheduler()?;
    let result = async {
        if let Some(lifecycle)=&lifecycle {lifecycle.start(&source,&bridge.root,config).await?;}
        let handoff_enabled = config["desktopLocalHandoff"]["enabled"] == true;
        let desktop_registry = config["desktopHome"].as_str().map(PathBuf::from)
            .unwrap_or(home()?.join("Library/Application Support/Claude/claude-code-sessions"));
        let mut blocked = BTreeMap::<String, String>::new();
        let mut unsupported = json!({"unsupportedSources":[],"absentSources":[]});
        let mut startup = true;
        let mut hooks_refresh=true;
        let mut hook_status=Value::Null;
        let mut candidates = VecDeque::<discovery::Source>::new();
        let mut background = VecDeque::<String>::new();
        let mut followups = BTreeMap::<String, (usize, tokio::time::Instant)>::new();
        let mut unknown = BTreeMap::<String, (Receipt, usize, tokio::time::Instant)>::new();
        let mut handoff_maintenance = tokio::time::Instant::now();
        let mut local_handoff = json!({"state":"waiting","actions":0,"deferred":"initial_verification"});
        let delays = [250, 1000, 3000];
        let mut held=false;
        let mut initial_sweep_completed_at = None;
        loop {
            source.check()?;
            let mut handoff_revoked = false;
            if *shutdown.borrow() { break; }
            if hooks::app_stopped(&bridge.root)? {
                held=true;
                if handoff_enabled {runtime.revoke_handoff_actions()?;}
                let mut status=watch_status(&blocked,None,&unsupported,true,lifecycle.as_ref(),None,initial_sweep_completed_at);status["folderProjection"]=json!({"state":"waiting","deferred":"application-hold"});status["localHandoff"]=json!({"state":"waiting","actions":0,"deferred":"application-hold"});diagnostics(&bridge.root,&status)?;
                tokio::select! {result=listener.wait_hint(Duration::from_secs(30),&mut shutdown)=>result?,_=source.failed()=>source.check()?}
                continue;
            }
            if held {startup=true;initial_sweep_completed_at=None;hooks_refresh=true;handoff_maintenance=tokio::time::Instant::now();held=false;}
            let mut pending_error = None;
            if bridge.status()?.pending.is_some() {
                if handoff_enabled { runtime.revoke_handoff_actions()?; handoff_revoked = true; }
                if let Err(error) = bridge.recover().await { pending_error = Some(format!("{error:#}")); }
            }
            let mut receipts = inbox.list()?;
            let mut work = receipts.clone();
            let mut handoff_scope = BTreeSet::new();
            let handoff_full = startup || tokio::time::Instant::now() >= handoff_maintenance;
            // Revoke old native authority before a newly observed activity or
            // expensive coordinator operation can inspect changing histories.
            // Follow-ups retain their original revision. A fresh native event
            // supersedes them rather than being acknowledged by stale work.
            let now = tokio::time::Instant::now();
            let due_unknown = unknown.iter().filter(|(_, (_, _, when))| *when <= now)
                .map(|(key, (receipt, step, _))| (key.clone(), receipt.clone(), *step)).collect::<Vec<_>>();
            for (key, receipt, step) in due_unknown {
                if !work.iter().any(|r| r.event.key() == key) { work.push(receipt); }
                if step + 1 < delays.len() {
                    unknown.get_mut(&key).unwrap().1 = step + 1;
                    unknown.get_mut(&key).unwrap().2 = now + Duration::from_millis(delays[step + 1]);
                } else { unknown.remove(&key); }
            }
            if handoff_enabled && !work.is_empty() { runtime.revoke_handoff_actions()?; handoff_revoked = true; }
            if pending_error.is_none() {
                if hooks_refresh {hook_status=match runtime.synchronization_hooks().await {Ok(status)=>status,Err(error)=>json!({"ready":false,"reason":format!("{error:#}")})};hooks_refresh=false;}
                let state = bridge.status()?;
                source.observe(&work, &state, &inbox)?;
                if work.iter().any(|r|matches!(r.event.kind,Kind::Reconnect|Kind::Configuration)) {hooks_refresh=true;}
                if work.iter().any(|r|r.event.kind==Kind::Reconnect) {startup=true;initial_sweep_completed_at=None;}
                let mut consumed = vec![];
                for receipt in &work {
                    if *shutdown.borrow() || hooks::app_stopped(&bridge.root)? || bridge.status()?.pending.is_some() { break; }
                    let state = bridge.status()?;
                    let ids = event_conversations(&state, receipt);
                    handoff_scope.extend(ids.iter().cloned());
                    if receipt.event.kind == Kind::Started {
                        for id in &ids { followups.remove(id); background.retain(|queued| queued != id); }
                        unknown.remove(&receipt.event.key());
                        consumed.push(receipt.clone());
                        continue;
                    }
                    if receipt.event.kind == Kind::OwnerWake {
                        // A stale activation hint never takes down synchronization.
                        let _ = runtime.wake_owner(&receipt.event.native_id, receipt.event.remote_id.as_deref().unwrap_or("")).await;
                        consumed.push(receipt.clone());
                        continue;
                    }
                    if matches!(receipt.event.kind, Kind::Configuration | Kind::Reconnect) {
                        consumed.push(receipt.clone());
                        continue;
                    }
                    let managed = state.records.iter().any(|r| r.managed && r.side == receipt.event.side && r.native_id.eq_ignore_ascii_case(&receipt.event.native_id));
                    if receipt.event.kind == Kind::Session && managed {
                        consumed.push(receipt.clone()); continue;
                    }
                    if ids.is_empty() {
                        let only = HashSet::from([receipt.event.key()]);
                        let update = discover_desktop(&bridge, config, Some(only.clone())).await?;
                        merge_discovery(&mut unsupported, update, Some(&only));
                    }
                    let state = bridge.status()?;
                    let ids = event_conversations(&state, receipt);
                    handoff_scope.extend(ids.iter().cloned());
                    if ids.is_empty() && receipt.event.kind != Kind::Session && receipts.iter().any(|r| r.revision == receipt.revision) {
                        let key = receipt.event.key();
                        if unknown.get(&key).is_none_or(|(r, _, _)| r.revision != receipt.revision) {
                            unknown.insert(key, (receipt.clone(), 0, tokio::time::Instant::now() + Duration::from_millis(delays[0])));
                        }
                    } else if !ids.is_empty() { unknown.remove(&receipt.event.key()); }
                    for id in ids {
                        if !state.conversations[&id].tracked() { continue; }
                        background.retain(|queued| queued != &id);
                        let outcome = match bridge.untrack(&id, true).await {
                            Ok(value) if value["tracking"] == "stopped" => {blocked.remove(&id); followups.remove(&id); continue;},
                            Ok(_) => scheduler.sync(&runtime,&bridge,&id).await,
                            Err(error) => Err(error),
                        };
                        let retry = match outcome {
                            Ok(value) => { blocked.remove(&id); value["changed"] == false || value["incompleteTail"] == true },
                            Err(error) => { blocked.insert(id.clone(), format!("{error:#}")); true }
                        };
                        if retry && matches!(receipt.event.kind, Kind::Completed | Kind::Interrupted | Kind::Idle | Kind::Changed) {
                            followups.insert(id, (0, tokio::time::Instant::now() + Duration::from_millis(delays[0])));
                        } else { followups.remove(&id); }
                    }
                    consumed.push(receipt.clone());
                }
                source.observe(&work, &bridge.status()?, &inbox)?;
                inbox.acknowledge(&consumed).await?;
                if bridge.status()?.pending.is_none() && !hooks::app_stopped(&bridge.root)? {
                    let due = followups.iter().filter(|(_, (_, when))| *when <= tokio::time::Instant::now())
                        .map(|(id, (step, _))| (id.clone(), *step)).collect::<Vec<_>>();
                    for (id, step) in due {
                        handoff_scope.insert(id.clone());
                        if *shutdown.borrow() || hooks::app_stopped(&bridge.root)? || bridge.status()?.pending.is_some() { break; }
                        if handoff_enabled {runtime.revoke_handoff_actions()?;handoff_revoked=true;}
                        let retry = match scheduler.sync(&runtime,&bridge,&id).await {
                            Ok(value) => { blocked.remove(&id); value["changed"] == false || value["incompleteTail"] == true },
                            Err(error) => { blocked.insert(id.clone(), format!("{error:#}")); true }
                        };
                        if retry && step + 1 < delays.len() {
                            followups.insert(id, (step + 1, tokio::time::Instant::now() + Duration::from_millis(delays[step + 1])));
                        } else { followups.remove(&id); }
                    }
                    // Only one cold history per pass; native completions get
                    // first service before the next potentially expensive read.
                    if !*shutdown.borrow() && !hooks::app_stopped(&bridge.root)? && inbox.list()?.is_empty() && bridge.status()?.pending.is_none() {
                        if startup {
                            if handoff_enabled && !handoff_revoked {runtime.revoke_handoff_actions()?;handoff_revoked=true;}
                            let state = bridge.status()?;
                            let known = state.records.iter().map(|r| format!("{}:{}", r.side.name(), r.native_id.to_lowercase())).collect();
                            candidates = discovery::discover(&desktop_discovery_options(config, None)?, &known)?.into();
                            background = state.conversations.into_iter().filter(|(_, c)| c.tracked()).map(|(id, _)| id).collect();
                            unsupported = json!({"unsupportedSources":[],"absentSources":[]});
                            startup = false;
                        }
                        if background.is_empty() && candidates.is_empty() {if let Some(id)=scheduler.due(&bridge.status()?){background.push_back(id);}}
                        if let Some(candidate) = candidates.pop_front() {
                            if handoff_enabled && !handoff_revoked {runtime.revoke_handoff_actions()?;handoff_revoked=true;}
                            let key = format!("{}:{}", candidate.side.name(), candidate.native_id.to_lowercase());
                            let update = enroll_candidate(&bridge, candidate).await?;
                            for row in update["enrolled"].as_array().into_iter().flatten() {
                                if let Some(id) = row["conversationId"].as_str() { if !background.iter().any(|queued| queued == id) { background.push_back(id.into()); } }
                            }
                            merge_discovery(&mut unsupported, update, Some(&HashSet::from([key])));
                        } else if let Some(id) = background.pop_front() {
                            if handoff_enabled && !handoff_revoked {runtime.revoke_handoff_actions()?;handoff_revoked=true;}
                            handoff_scope.insert(id.clone());
                            let outcome=match bridge.untrack(&id,true).await {
                                Ok(value) if value["tracking"] == "stopped" => {blocked.remove(&id);continue;},
                                Ok(_)=>scheduler.sync(&runtime,&bridge,&id).await,
                                Err(error)=>Err(error),
                            };
                            {
                                match outcome {
                                    Ok(value) => { blocked.remove(&id); if value["incompleteTail"] == true { followups.insert(id, (0, tokio::time::Instant::now() + Duration::from_millis(delays[0]))); } },
                                    Err(error) => { blocked.insert(id.clone(), format!("{error:#}")); followups.insert(id, (0, tokio::time::Instant::now() + Duration::from_millis(delays[0]))); }
                                }
                            }
                        }
                    }
                }
            }
            if hooks::app_stopped(&bridge.root)? {continue;}
            runtime.close_idle_owners(false).await?;
            let folder_map = if config["folderProjection"]["enabled"] != true {json!({"state":"disabled"})}
                else if pending_error.is_some() {json!({"state":"waiting","deferred":"pending"})}
                else {match runtime.publish_folders().await {
                    Ok(mut map)=>{map["state"]=json!(if map["deferred"].is_null(){"ready"}else{"waiting"});map},
                    Err(error)=>json!({"state":"error","error":format!("{error:#}")}),
                }};
            let renderer=lifecycle.as_ref().map(|l|l.status()).unwrap_or(Value::Null);let folder_projection=folder_view(&folder_map,&renderer);
            if handoff_enabled && handoff_publication_needed(handoff_full, &handoff_scope, handoff_revoked) {
                let value = match runtime.publish_handoffs(&desktop_registry, if handoff_full {None} else {Some(&handoff_scope)}).await {
                    Ok(mut value) => {value["state"]=json!(if value["deferred"].is_null(){"ready"}else{"waiting"});value}, Err(error) => json!({"state":"error","actions":0,"error":format!("{error:#}")})
                };
                if handoff_full { handoff_maintenance = tokio::time::Instant::now() + Duration::from_secs(30); }
                local_handoff = value;
            } else if !handoff_enabled { local_handoff = json!({"state":"disabled","enabled":false}); }
            if !startup && pending_error.is_none() && candidates.is_empty() && background.is_empty() {
                initial_sweep_completed_at.get_or_insert_with(storage::now_ms);
            }
            let mut status=watch_status(&blocked,pending_error.as_deref(),&unsupported,false,lifecycle.as_ref(),if startup{None}else{Some(candidates.len()+background.len())},initial_sweep_completed_at);status["hookStatus"]=hook_status.clone();if pending_error.is_none() && hook_status["ready"] == false {status["synchronization"]=json!("blocked");status["blocked"]=json!({"scope":"hooks","reason":hook_status["reason"]});}status["coldVerificationCache"]=scheduler.cache.diagnostics();status["folderProjection"]=folder_projection;status["localHandoff"]=local_handoff.clone();status["rendererAdapters"]=renderer;diagnostics(&bridge.root,&status)?;
            let mut timeout = followups.values().map(|(_, when)| when.saturating_duration_since(tokio::time::Instant::now()))
                .chain(unknown.values().map(|(_, _, when)| when.saturating_duration_since(tokio::time::Instant::now())))
                .min().unwrap_or(Duration::from_secs(30)).min(Duration::from_secs(30));
            if pending_error.is_some() { timeout = Duration::from_secs(30); }
            else if startup || !candidates.is_empty() || !background.is_empty() { timeout = Duration::ZERO; }
            // A pending failed recovery must sleep rather than spin on its
            // preserved inbox. Source failures and shutdown still wake it.
            if pending_error.is_some() {
                tokio::select! { _=tokio::time::sleep(timeout)=>(), _=shutdown.changed()=>(), _=source.failed()=>source.check()? }
            } else {
                tokio::select! { result=listener.wait(timeout, &mut shutdown)=>{ receipts = result?; let _ = receipts; }, _=source.failed()=>source.check()? }
            }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    let source_result = source.close().await;
    let listener_result = listener.close().await;
    let lifecycle_result = match lifecycle {
        Some(lifecycle) => lifecycle.stop().await,
        None => Ok(()),
    };
    let close_result = close_runtime(&runtime).await;
    let outcome = result.and(source_result).and(listener_result).and(lifecycle_result).and(close_result);
    let mut status = storage::read_json_or(bridge.root.join("watcher-status.json"), json!({}))?;
    status["coldVerificationCache"] = scheduler.cache.diagnostics();
    status["pid"] = json!(std::process::id());
    status["running"] = json!(false);
    status["updatedAt"] = json!(storage::now_ms());
    status["error"] = outcome.as_ref().err().map(|error|json!(format!("{error:#}").chars().take(2000).collect::<String>())).unwrap_or(Value::Null);
    diagnostics(&bridge.root, &status)?;
    outcome
}
fn event_conversations(state: &crate::desktop::State, receipt: &Receipt) -> BTreeSet<String> {
    state
        .records
        .iter()
        .filter(|r| {
            r.side == receipt.event.side
                && r.native_id.eq_ignore_ascii_case(&receipt.event.native_id)
        })
        .map(|r| r.conversation_id.clone())
        .collect()
}
async fn enroll_candidate(bridge: &DesktopBridge, source: discovery::Source) -> Result<Value> {
    if matches!(fs::symlink_metadata(&source.cwd), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(
            json!({"enrolled":[],"unsupportedSources":[],"absentSources":[{"side":source.side,"nativeId":source.native_id,"reason":"working-directory-missing"}]}),
        );
    }
    match bridge
        .track(
            Record::source(source.side, &source.path, &source.native_id),
            None,
        )
        .await
    {
        Ok(value) => Ok(json!({"enrolled":[value],"unsupportedSources":[],"absentSources":[]})),
        Err(error) if error.is::<discovery::CodexSubagentSource>() => {
            Ok(json!({"enrolled":[],"unsupportedSources":[],"absentSources":[]}))
        }
        Err(error) => Ok(
            json!({"enrolled":[],"unsupportedSources":[{"side":source.side,"nativeId":source.native_id,"reason":format!("{error:#}")}],"absentSources":[]}),
        ),
    }
}
async fn watch_legacy(bridge: Bridge, config: &Value) -> Result<()> {
    let _watch = FileLock::acquire(&bridge.root.join("watch.lock"), true)?;
    let inbox = Inbox::new(&bridge.root)?;
    let listener = inbox.listen().await?;
    let mut shutdown = signal()?;
    let mut startup = true;
    loop {
        if *shutdown.borrow() {
            break;
        }
        if bridge.status()?.pending.is_some() {
            bridge.recover().await?;
        }
        let receipts = inbox.list()?;
        if startup || !receipts.is_empty() {
            let known = bridge
                .status()?
                .records
                .iter()
                .map(|r| format!("{}:{}", r.side.name(), r.native_id))
                .collect();
            let only = if startup {
                None
            } else {
                Some(receipts.iter().map(|r| r.event.key()).collect())
            };
            for source in discovery::discover(&discovery_options(config, only)?, &known)? {
                bridge.track(source.side, &source.path, None).await?;
            }
            let state = bridge.status()?;
            for (id, _) in state.conversations {
                if !startup
                    && !state.records.iter().any(|r| {
                        r.conversation_id == id
                            && receipts.iter().any(|receipt| {
                                r.side == receipt.event.side
                                    && r.native_id.eq_ignore_ascii_case(&receipt.event.native_id)
                            })
                    })
                {
                    continue;
                }
                let sides: Vec<_> = state
                    .records
                    .iter()
                    .filter(|r| r.conversation_id == id && r.status == "current")
                    .map(|r| r.side)
                    .collect();
                for side in sides {
                    bridge.sync(&id, side).await?;
                }
            }
            inbox.acknowledge(&receipts).await?;
            startup = false;
        }
        diagnostics(
            &bridge.root,
            &json!({"version":1,"pid":std::process::id(),"eventDriven":true,"at":storage::now_ms()}),
        )?;
        listener
            .wait(Duration::from_secs(30), &mut shutdown)
            .await?;
    }
    listener.close().await
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicBool, Ordering},
    };
    #[test]
    fn idle_pass_does_not_revoke_or_renew_an_unexpired_handoff() {
        let empty = BTreeSet::new();
        assert!(!handoff_publication_needed(false, &empty, false));
        assert!(handoff_publication_needed(true, &empty, false));
        assert!(handoff_publication_needed(false, &empty, true));
        assert!(handoff_publication_needed(
            false,
            &BTreeSet::from(["observed-conversation".into()]),
            false,
        ));
    }
    #[test]
    fn only_desktop_discovery_defers_subagent_classification_to_native_metadata() -> Result<()> {
        let config = json!({"codexHome":"/native/codex","claudeHome":"/native/claude"});
        let keys = HashSet::from(["codex:exact-native-id".into()]);
        assert!(discovery_options(&config, None)?.exclude_subagents);
        let desktop = desktop_discovery_options(&config, Some(keys.clone()))?;
        assert!(!desktop.exclude_subagents);
        assert_eq!(desktop.only_keys, Some(keys));
        Ok(())
    }
    struct PartialStart {
        root: PathBuf,
        stopped: AtomicBool,
    }
    #[async_trait]
    impl WatchLifecycle for PartialStart {
        async fn start(
            &self,
            source: &crate::event_source::Source,
            root: &Path,
            _config: &Value,
        ) -> Result<()> {
            ensure!(
                root.join("watch.lock").try_exists()?,
                "Missing watcher lease during lifecycle start."
            );
            let _hints = source.filesystem_hints();
            source.watch_directory(root)?;
            bail!("Injected partial lifecycle start failure.")
        }
        async fn stop(&self) -> Result<()> {
            ensure!(
                self.root.join("watch.lock").try_exists()?,
                "Watcher lease released before lifecycle drain."
            );
            ensure!(
                !self.root.join("sync-events/listener.json").try_exists()?,
                "Listener was not closed before lifecycle drain."
            );
            self.stopped.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    #[tokio::test]
    async fn partial_start_drains_before_releasing_watcher_and_listener_leases() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let codex = storage::private_directory(root.join("codex"))?;
        let claude = storage::private_directory(root.join("claude"))?;
        let config = json!({"codexHome":codex,"claudeHome":claude});
        let runtime = Runtime::new(RuntimeOptions::from_config(&root, &config)?)?;
        runtime.close_idle_owners(false).await?;
        assert!(runtime.publish_folders().await.is_ok());
        let lifecycle = Arc::new(PartialStart {
            root: root.clone(),
            stopped: AtomicBool::new(false),
        });
        let error = watch_desktop_with(
            runtime.clone(),
            runtime.bridge(),
            &config,
            Some(lifecycle.clone()),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("Injected partial lifecycle"));
        let status = storage::read_json(root.join("watcher-status.json"))?;
        assert_eq!(status["running"], false);
        assert!(status["error"].as_str().is_some_and(|s| s.contains("Injected partial lifecycle")));
        assert!(lifecycle.stopped.load(Ordering::SeqCst));
        assert!(!root.join("watch.lock").exists());
        let inbox = Inbox::new(&root)?;
        let listener = inbox.listen().await?;
        listener.close().await?;
        Ok(())
    }
    struct HeldLifecycle {
        root: PathBuf,
        stopped: AtomicBool,
    }
    #[async_trait]
    impl WatchLifecycle for HeldLifecycle {
        async fn start(
            &self,
            _source: &crate::event_source::Source,
            _root: &Path,
            _config: &Value,
        ) -> Result<()> {
            Ok(())
        }
        async fn stop(&self) -> Result<()> {
            ensure!(
                self.root.join("watch.lock").exists()
                    && !self.root.join("sync-events/listener.json").exists(),
                "Incorrect shutdown order."
            );
            self.stopped.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn status(&self) -> Value {
            json!({"state":"ready","adapters":{"folders":{"status":"installed"}}})
        }
        fn restart(&self) -> Value {
            json!({"requiredSince":123,"notBefore":456})
        }
    }
    async fn until_status(root: &Path, predicate: impl Fn(&Value) -> bool) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = storage::read_json_or(root.join("watcher-status.json"), Value::Null)?;
                if predicate(&value) {
                    return Ok(value);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?
    }
    #[tokio::test]
    async fn configuration_keeps_the_completed_sweep_but_reconnection_reconciles_again() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(temp.path())?;
        let codex = storage::private_directory(root.join("codex"))?;
        let claude = storage::private_directory(root.join("claude"))?;
        let config = json!({"codexHome":codex,"claudeHome":claude});
        let runtime = Runtime::new(RuntimeOptions::from_config(&root, &config)?)?;
        let (shutdown, receiver) = tokio::sync::watch::channel(false);
        let running = tokio::spawn(async move {
            let bridge = runtime.bridge();
            watch_desktop_control(runtime, bridge, &config, None, Some(receiver)).await
        });
        let first = until_status(&root, |v| v["initialSweepCompletedAt"].is_number()).await?;
        let inbox = Inbox::new(&root)?;
        for _ in 0..2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let before = storage::read_json(root.join("watcher-status.json"))?;
            inbox
                .publish(crate::events::Event {
                    side: Side::Codex,
                    native_id: crate::event_source::CONFIG_ID.into(),
                    kind: Kind::Configuration,
                    turn_id: None,
                    remote_id: None,
                })
                .await?;
            let next = until_status(&root, |v| {
                v["updatedAt"].as_i64() > before["updatedAt"].as_i64()
            })
            .await?;
            assert_eq!(next["initialSweepRemaining"], 0);
            assert_eq!(
                next["initialSweepCompletedAt"],
                first["initialSweepCompletedAt"]
            );
        }
        inbox
            .publish(crate::events::Event {
                side: Side::Codex,
                native_id: crate::event_source::RECONNECT_ID.into(),
                kind: Kind::Reconnect,
                turn_id: None,
                remote_id: None,
            })
            .await?;
        until_status(&root, |v| {
            v["initialSweepCompletedAt"].as_i64() > first["initialSweepCompletedAt"].as_i64()
        })
        .await?;
        shutdown.send(true)?;
        tokio::time::timeout(Duration::from_secs(5), running).await???;
        Ok(())
    }
    #[tokio::test]
    async fn stopped_and_resuming_hold_keep_listener_alive_without_history_reads_then_release()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(temp.path())?;
        let codex = storage::private_directory(root.join("codex"))?;
        let claude = storage::private_directory(root.join("claude"))?;
        let config =
            json!({"codexHome":codex,"claudeHome":claude,"folderProjection":{"enabled":true}});
        let runtime = Runtime::new(RuntimeOptions::from_config(&root, &config)?)?;
        // A read of even the ledger during this hold would fail immediately.
        storage::atomic_write(root.join("desktop-state.json"), b"not a ledger")?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        let lifecycle = Arc::new(HeldLifecycle {
            root: root.clone(),
            stopped: AtomicBool::new(false),
        });
        let (shutdown, receiver) = tokio::sync::watch::channel(false);
        let running = tokio::spawn({
            let root_config = config.clone();
            let lifecycle = lifecycle.clone();
            let bridge = runtime.bridge();
            async move {
                watch_desktop_control(
                    runtime,
                    bridge,
                    &root_config,
                    Some(lifecycle),
                    Some(receiver),
                )
                .await
            }
        });
        let status = until_status(&root, |v| v["applicationHold"] == true).await?;
        assert_eq!(status["running"], true);
        assert!(status["blocked"].is_null());
        assert_eq!(status["claudeDesktopRestart"]["requiredSince"], 123);
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":false,"resuming":true}),
        )?;
        let inbox = Inbox::new(&root)?;
        let event = crate::events::Event {
            side: Side::Codex,
            native_id: crate::event_source::CONFIG_ID.into(),
            kind: Kind::Configuration,
            turn_id: None,
            remote_id: None,
        };
        inbox.publish(event.clone()).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!running.is_finished());
        assert_eq!(
            storage::read_json(root.join("watcher-status.json"))?["applicationHold"],
            true
        );
        assert!(!inbox.list()?.is_empty());
        storage::write_json(
            root.join("desktop-state.json"),
            &serde_json::to_value(crate::desktop::State::default())?,
        )?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":false,"resuming":false}),
        )?;
        inbox.publish(event).await?;
        let status = until_status(&root, |v| {
            v["applicationHold"] == false && v["foregroundCompletedAt"].is_number()
        })
        .await?;
        assert_eq!(status["blockedConversationCount"], 0);
        assert_eq!(status["blocked"]["scope"], "hooks");
        assert_eq!(status["hookStatus"]["ready"], false);
        assert_eq!(status["folderProjection"]["state"], "ready");
        assert_eq!(
            status["folderProjection"]["resource"]["status"],
            "installed"
        );
        shutdown.send(true)?;
        tokio::time::timeout(Duration::from_secs(5), running).await???;
        assert!(lifecycle.stopped.load(Ordering::SeqCst));
        assert!(!root.join("watch.lock").exists());
        Ok(())
    }
    #[test]
    fn renderer_resource_overlay_preserves_map_proof_and_independent_health() {
        let ready =
            json!({"state":"ready","updatedAt":123,"entries":2,"proof":"exact","deferred":null});
        let degraded = json!({"state":"degraded","adapters":{"folders":{"status":"installed"},"wake":{"status":"skipped","reason":"wake only"}}});
        let view = folder_view(&ready, &degraded);
        assert_eq!(view["state"], "ready");
        assert_eq!(view["updatedAt"], 123);
        assert_eq!(view["proof"], "exact");
        assert_eq!(
            folder_view(&ready, &json!({"state":"checking"}))["state"],
            "waiting"
        );
        assert_eq!(
            folder_view(&ready, &json!({"state":"held"}))["state"],
            "waiting"
        );
        let skipped = json!({"state":"degraded","adapters":{"folders":{"status":"skipped","reason":"unsupported resource"}}});
        let view = folder_view(&ready, &skipped);
        assert_eq!(view["state"], "error");
        assert_eq!(view["error"], "unsupported resource");
        assert_eq!(view["proof"], "exact");
        let error = json!({"state":"error","error":"actual map failure","updatedAt":90});
        assert_eq!(folder_view(&error, &skipped), error);
        let deferred = json!({"state":"waiting","deferred":"pending","updatedAt":99});
        assert_eq!(folder_view(&deferred, &skipped), deferred);
        let value = watch_status(&BTreeMap::new(), None, &json!({}), false, None, Some(0), Some(123));
        assert_eq!(value["initialSweepCompletedAt"], 123);
        let pending = watch_status(&BTreeMap::new(), None, &json!({}), false, None, Some(5), None);
        assert!(pending.get("initialSweepCompletedAt").is_some_and(Value::is_null));
        assert!(value["blocked"].is_null());
        assert_eq!(value["blockedConversationCount"], 0);
        assert!(value["updatedAt"].is_number());
        assert_eq!(value["running"], true);
    }
}
