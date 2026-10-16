use anyhow::Result;
use async_trait::async_trait;
use claudex_work::{
    Broker, Config, Envelope, Invocation, NativeFailure, NativeResult, NativeRunner, Permission,
    Provider,
    mailbox::ChatMailbox,
    native::{self, Decoder},
    transport,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use tokio::sync::{mpsc, oneshot};

struct Pending {
    invocation: Invocation,
    complete: oneshot::Sender<std::result::Result<NativeResult, NativeFailure>>,
}
struct ControlledRunner(mpsc::UnboundedSender<Pending>);
#[async_trait]
impl NativeRunner for ControlledRunner {
    async fn run(
        &self,
        invocation: Invocation,
        _events: mpsc::Sender<Value>,
    ) -> std::result::Result<NativeResult, NativeFailure> {
        let (complete, reply) = oneshot::channel();
        let mut cancellation = invocation.cancellation.clone();
        self.0
            .send(Pending {
                invocation,
                complete,
            })
            .unwrap();
        tokio::select! {v=reply=>v.unwrap_or_else(|_|Err(NativeFailure::uncertain("Synthetic control disappeared."))),_=cancellation.changed()=>Err(NativeFailure::before("Synthetic cancellation completed."))}
    }
}
fn successful(text: &str) -> NativeResult {
    NativeResult {
        text: text.into(),
        session_id: Some("synthetic".into()),
        usage: None,
        activity: None,
    }
}
fn worker(inv: &Invocation, method: &str, params: Value) -> Envelope {
    Envelope {
        peer: Provider::parse(inv.task["owner"].as_str().unwrap()).unwrap(),
        token: inv.mcp["env"]["CLAUDEX_WORK_TOKEN"]
            .as_str()
            .unwrap()
            .into(),
        method: method.into(),
        params,
    }
}
async fn pending(rx: &mut mpsc::UnboundedReceiver<Pending>) -> Pending {
    tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

struct SyntheticRunner;
#[async_trait]
impl NativeRunner for SyntheticRunner {
    async fn run(
        &self,
        i: Invocation,
        _events: mpsc::Sender<Value>,
    ) -> std::result::Result<NativeResult, NativeFailure> {
        Ok(NativeResult {
            text: format!("synthetic {} result", i.task["owner"].as_str().unwrap()),
            session_id: Some("synthetic-native-id".into()),
            usage: Some(
                json!({"inputTokens":100,"cacheReadInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":10}),
            ),
            activity: None,
        })
    }
}
fn request(b: &Broker, method: &str, params: Value) -> Envelope {
    Envelope {
        peer: Provider::Codex,
        token: b.controller_token().into(),
        method: method.into(),
        params,
    }
}
async fn setup() -> (tempfile::TempDir, Arc<Broker>) {
    let dir = tempfile::tempdir().unwrap();
    let b = Broker::open(
        dir.path().join("work"),
        Config::default(),
        Arc::new(SyntheticRunner),
    )
    .await
    .unwrap();
    (dir, b)
}
async fn start(b: &Arc<Broker>, cwd: &Path, id: &str) -> Value {
    b.dispatch(request(b,"start",json!({"provider":"claude","cwd":cwd,"prompt":"Inspect synthetic fixture only.","requestId":id}))).await.unwrap()
}
async fn finish(b: &Arc<Broker>, id: &Value) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let result = b
                .dispatch(request(
                    b,
                    "wait",
                    json!({"taskId":id,"timeoutMs":1000,"view":"summary"}),
                ))
                .await
                .unwrap();
            if result["terminal"] == true {
                return result;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn native_graph_completes_and_preserves_idempotency() -> Result<()> {
    let (dir, b) = setup().await;
    let p = json!({"provider":"claude","cwd":dir.path(),"prompt":"Inspect synthetic fixture only.","requestId":"root-1"});
    let first = b.dispatch(request(&b, "start", p.clone())).await?;
    let replay = b.dispatch(request(&b, "start", p.clone())).await?;
    assert_eq!(replay["taskId"], first["taskId"]);
    assert_eq!(replay["replayed"], true);
    let mut changed = p;
    changed["prompt"] = json!("Changed request");
    assert!(
        b.dispatch(request(&b, "start", changed))
            .await
            .unwrap_err()
            .to_string()
            .contains("reused")
    );
    let done = finish(&b, &first["taskId"]).await;
    assert_eq!(done["status"], "completed");
    assert_eq!(done["resultFinal"], true);
    assert_eq!(done["result"]["text"], "synthetic claude result");
    assert_eq!(done["usageTotals"]["claude"]["inputTokens"], 100);
    b.close().await?;
    Ok(())
}

#[tokio::test]
async fn unix_rpc_preserves_exact_broker_receipts() -> Result<()> {
    let (dir, b) = setup().await;
    let server = transport::serve(b.clone()).await?;
    let result=transport::call(&b.root,Provider::Codex,b.controller_token(),"models",json!({"defaultModels":{"codex":null,"claude":"example-model"},"defaultEfforts":{"codex":"medium","claude":"high"}})).await?;
    assert_eq!(result["defaultModels"]["claude"], "example-model");
    let started = start(&b, dir.path(), "rpc-root").await;
    let done = finish(&b, &started["taskId"]).await;
    assert_eq!(done["effort"], "high");
    assert_eq!(done["model"], "example-model");
    assert!(
        transport::call(&b.root, Provider::Codex, &"0".repeat(64), "list", json!({}))
            .await
            .is_err()
    );
    b.close().await?;
    server.close().await?;
    Ok(())
}

struct ModMetadata;
#[async_trait]
impl claudex_work::Integration for ModMetadata {
    fn supports(&self, method: &str) -> bool {
        method == "mod_target_verify"
    }
    async fn dispatch(&self, _method: &str, _peer: Provider, p: Value) -> Result<Value> {
        Ok(p)
    }
}

#[tokio::test]
async fn unix_mod_wait_disconnect_invalidates_only_its_exact_observer_and_not_work() -> Result<()> {
    use tokio::{io::AsyncWriteExt, net::UnixStream};
    let dir = tempfile::tempdir()?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let b = Broker::open_with_integration(
        dir.path().join("work"),
        Config::default(),
        Arc::new(ControlledRunner(tx)),
        Arc::new(ModMetadata),
    )
    .await?;
    let server = transport::serve(b.clone()).await?;
    let task = start(&b, dir.path(), "disconnect-root").await;
    let active = pending(&mut rx).await;
    let source = json!({"sessionId":"22222222-2222-4222-8222-222222222222","cwd":dir.path()});
    let observation = |observer: &str, sequence: u64| json!({"observerId":observer,"sequence":sequence,"lifecycle":"loaded","nativeWake":true,"selfWake":true,"inboundPolicy":"allow","capabilities":{"sendMessage":true},"usage":null});
    let envelope = |method: &str, params: Value| Envelope {
        peer: Provider::Claude,
        token: b.controller_token().into(),
        method: method.into(),
        params,
    };
    b.dispatch(envelope(
        "mod_wake_observe",
        json!({"source":source,"observation":observation("independent",1)}),
    ))
    .await?;
    for sequence in [1, 3] {
        let mut stream = UnixStream::connect(&server.path).await?;
        let mut bytes = serde_json::to_vec(&envelope(
            "mod_wake_wait",
            json!({"source":source,"self":true,"timeoutMs":20000,"observation":observation("waiting",sequence)}),
        ))?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let status = b
                    .dispatch(request(&b, "mod_wake_status", json!({})))
                    .await
                    .unwrap();
                if status["waitingModClients"] == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await?;
        if sequence == 1 {
            b.dispatch(envelope(
                "mod_wake_observe",
                json!({"source":source,"observation":observation("waiting",2)}),
            ))
            .await?;
        }
        drop(stream);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let status = b
                    .dispatch(request(&b, "mod_wake_status", json!({})))
                    .await
                    .unwrap();
                if status["waitingModClients"] == 0 {
                    assert_eq!(
                        status["liveObserverCount"],
                        if sequence == 1 { 2 } else { 1 }
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await?;
    }
    assert!(!*active.invocation.cancellation.borrow());
    active
        .complete
        .send(Ok(successful("Work survives disconnected Mod diagnostics")))
        .unwrap();
    assert_eq!(finish(&b, &task["taskId"]).await["status"], "completed");
    b.close().await?;
    server.close().await?;
    Ok(())
}

struct ControlledOrigin {
    reads: std::sync::atomic::AtomicU64,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}
#[async_trait]
impl claudex_work::Integration for ControlledOrigin {
    fn origin_available(&self) -> bool {
        true
    }
    async fn origin_verify(&self, p: &Value) -> Result<Value> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        self.entered.add_permits(1);
        self.release.acquire().await?.forget();
        let mut proof = p.clone();
        proof["source"] = json!("synthetic-exact-proof");
        proof["verifiedAt"] = json!(claudex_core::storage::now_ms());
        Ok(proof)
    }
}
#[tokio::test]
async fn exact_origin_checks_coalesce_and_conflicting_identity_does_not_spend_another_read()
-> Result<()> {
    let dir = tempfile::tempdir()?;
    let integration = Arc::new(ControlledOrigin {
        reads: std::sync::atomic::AtomicU64::new(0),
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    let b = Broker::open_with_integration(
        dir.path().join("work"),
        Config::default(),
        Arc::new(SyntheticRunner),
        integration.clone(),
    )
    .await?;
    let started=b.dispatch(request(&b,"start",json!({"provider":"claude","cwd":dir.path(),"prompt":"Synthetic origin proof fixture.","requestId":"origin-coalescing"}))).await?;
    finish(&b, &started["taskId"]).await;
    let params = json!({"taskId":started["taskId"],"sessionId":"22222222-2222-4222-8222-222222222222","cwd":dir.path(),"toolUseId":"exact-call","turnId":"exact-turn"});
    let first = tokio::spawn({
        let b = b.clone();
        let p = params.clone();
        async move { b.dispatch(request(&b, "origin_bind", p)).await }
    });
    integration.entered.acquire().await?.forget();
    let second = tokio::spawn({
        let b = b.clone();
        let p = params.clone();
        async move { b.dispatch(request(&b, "origin_bind", p)).await }
    });
    tokio::task::yield_now().await;
    let mut conflict = params;
    conflict["toolUseId"] = json!("another-call");
    let err = b
        .dispatch(request(&b, "origin_bind", conflict))
        .await
        .unwrap_err();
    assert_eq!(
        err.downcast_ref::<claudex_work::model::ProtocolError>()
            .unwrap()
            .code,
        "CLAUDEX_ORIGIN_CONFLICT"
    );
    assert_eq!(
        integration.reads.load(std::sync::atomic::Ordering::Acquire),
        1
    );
    integration.release.add_permits(1);
    let a = first.await??;
    let c = second.await??;
    assert_eq!(a, c);
    assert_eq!(a["bound"], true);
    b.close().await?;
    Ok(())
}

#[tokio::test]
async fn capacity_archives_settled_trees_without_losing_replay() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let b = Broker::open(
        dir.path().join("work"),
        Config {
            max_tasks: 1,
            max_requests: 2,
            ..Config::default()
        },
        Arc::new(SyntheticRunner),
    )
    .await?;
    let first = start(&b, dir.path(), "archive-1").await;
    finish(&b, &first["taskId"]).await;
    let second = start(&b, dir.path(), "archive-2").await;
    finish(&b, &second["taskId"]).await;
    let list = b.dispatch(request(&b, "list", json!({}))).await?;
    assert_eq!(list["totalCount"], 1);
    assert_eq!(list["archivedTaskCount"], 1);
    let old = b
        .dispatch(request(&b, "status", json!({"taskId":first["taskId"]})))
        .await?;
    assert_eq!(old["archived"], true);
    assert_eq!(old["result"]["text"], "synthetic claude result");
    let replay = start(&b, dir.path(), "archive-1").await;
    assert_eq!(replay["taskId"], first["taskId"]);
    assert_eq!(replay["replayed"], true);
    b.close().await?;
    Ok(())
}

#[test]
fn mailbox_offers_once_and_requires_exact_ack() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mailbox = ChatMailbox::new(dir.path().join("mailbox"));
    let path = dir.path();
    mailbox.hook(
        Provider::Claude,
        "native-session",
        path,
        "SessionStart",
        false,
        "",
    )?;
    let params = json!({"fromProvider":"codex","targetProvider":"claude","targetSessionId":"native-session","message":"Quoted peer text only.","requestId":"send-1","wakeRequested":false});
    let sent = mailbox.send(&params, None)?;
    let replay = mailbox.send(&params, None)?;
    assert_eq!(sent["messageId"], replay["messageId"]);
    let offered = mailbox.hook(Provider::Claude, "native-session", path, "Stop", false, "")?;
    assert_eq!(offered["message"]["state"], "offered");
    let again = mailbox.hook(Provider::Claude, "native-session", path, "Stop", false, "")?;
    assert!(again.get("message").is_none());
    let wrong = mailbox.hook(
        Provider::Claude,
        "native-session",
        path,
        "Stop",
        true,
        "CLAUDEX_ACK:not-the-message",
    )?;
    assert!(wrong["acknowledgedIds"].as_array().unwrap().is_empty());
    let ack = format!("CLAUDEX_ACK:{}", sent["messageId"].as_str().unwrap());
    mailbox.hook(Provider::Claude, "native-session", path, "Stop", true, &ack)?;
    assert_eq!(
        mailbox.status(sent["messageId"].as_str().unwrap())?["state"],
        "acknowledged"
    );
    Ok(())
}

#[test]
fn ended_chats_wait_for_real_resumption_and_self_inbox_never_uses_hook() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mailbox = ChatMailbox::new(dir.path().join("mailbox"));
    mailbox.hook(
        Provider::Claude,
        "native",
        dir.path(),
        "SessionStart",
        false,
        "",
    )?;
    mailbox.hook(
        Provider::Claude,
        "native",
        dir.path(),
        "SessionEnd",
        false,
        "",
    )?;
    let sent=mailbox.send(&json!({"fromProvider":"codex","targetProvider":"claude","targetSessionId":"native","message":"hello","requestId":"wake","wakeRequested":true,"wakeRoute":"mod-self"}),None)?;
    assert_eq!(sent["deliveryStatus"], "waiting-for-resume");
    let late = mailbox.hook(Provider::Claude, "native", dir.path(), "Stop", false, "")?;
    assert_eq!(late["chat"]["phase"], "ended");
    let resumed = mailbox.hook(
        Provider::Claude,
        "native",
        dir.path(),
        "SessionStart",
        false,
        "",
    )?;
    assert!(resumed.get("message").is_none());
    let source = json!({"sessionId":"native","cwd":dir.path()});
    let claim = mailbox.claim_wake(
        sent["messageId"].as_str().unwrap(),
        Some("mod-self"),
        Some(source.clone()),
    )?;
    assert!(!claim.is_null());
    assert!(
        mailbox
            .claim_wake(sent["messageId"].as_str().unwrap(), Some("mod-self"), None)?
            .is_null()
    );
    let id = sent["messageId"].as_str().unwrap();
    let cap = claim["wake"]["claimId"].as_str().unwrap();
    assert!(
        mailbox
            .receive_self_wake(id, cap, &source)?
            .contains("peer-originated")
    );
    assert!(mailbox.receive_self_wake(id, cap, &source).is_err());
    Ok(())
}

#[test]
fn native_profiles_preserve_sandbox_and_full_access_boundaries() -> Result<()> {
    let sandbox = json!({"owner":"codex","permission":"workspace-write","model":null,"effort":"high","readOnlyDirs":["/reference"],"writableDirs":["/write"]});
    let args = native::launch_args(
        &sandbox,
        &json!({"command":"/claudex","args":["collaboration","mcp"],"env":{"CLAUDEX_WORK_TOKEN":"private"}}),
        false,
    )?;
    assert!(args.contains(&"--ignore-user-config".into()));
    assert!(args.contains(&"sandbox_workspace_write.exclude_slash_tmp=true".into()));
    assert!(!args.iter().any(|a| a.contains("private")));
    let mut full = sandbox;
    full["permission"] = json!("full-access");
    full["readOnlyDirs"] = json!([]);
    let args = native::launch_args(&full, &Value::Null, true)?;
    assert!(!args.contains(&"--ignore-user-config".into()));
    assert!(args.contains(&"danger-full-access".into()));
    assert!(args.contains(&"mcp_servers.claudex-work.enabled=false".into()));
    assert_eq!(
        Permission::ReadOnly.capabilities(Some(Provider::Claude))["shell"],
        false
    );
    Ok(())
}

#[test]
fn terminal_failure_detail_usage_and_conflicts_are_separate() {
    let mut decoder = Decoder::default();
    decoder.observe(
        Provider::Codex,
        &json!({"type":"turn.failed","error":{"message":"Usage limit reached.\nTry later."}}),
    );
    assert_eq!(decoder.failure, "Usage limit reached. Try later.");
    assert_eq!(decoder.terminal, Some(false));
    decoder.observe(Provider::Codex, &json!({"type":"turn.completed"}));
    assert!(decoder.conflicting);
    let mut decoder = Decoder::default();
    decoder.observe(
        Provider::Claude,
        &json!({"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}),
    );
    assert!(decoder.terminal.is_none());
    decoder.observe(Provider::Claude,&json!({"type":"result","is_error":true,"errors":["Quota exceeded"],"result":"private partial output"}));
    assert_eq!(decoder.failure, "Quota exceeded");
    let usage=native::normalize_usage(Provider::Claude,&json!({"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":8}),None).unwrap();
    assert_eq!(usage["inputTokens"], 35);
    assert!(
        native::normalize_usage(
            Provider::Codex,
            &json!({"input_tokens":1,"cached_input_tokens":2,"output_tokens":8}),
            None
        )
        .is_none()
    );
}

#[test]
fn mcp_schemas_retain_public_surface_and_reject_broadening() -> Result<()> {
    let tools = transport::tools(false);
    assert_eq!(tools.as_array().unwrap().len(), 15);
    transport::validate_tool(
        "claudex_start",
        &json!({"provider":"claude","cwd":"/fixture","prompt":"inspect","requestId":"r","effort":"max"}),
        false,
    )?;
    assert!(transport::validate_tool("claudex_start",&json!({"provider":"claude","cwd":"/fixture","prompt":"inspect","requestId":"r","permission":"full-access"}),false).is_err());
    assert!(
        transport::validate_tool(
            "claudex_wait",
            &json!({"taskId":"t","targets":[{"taskId":"t"}]}),
            false
        )
        .is_err()
    );
    assert!(
        transport::validate_tool(
            "claudex_wait",
            &json!({"targets":[{"taskId":"t"},{"taskId":"t"}]}),
            false
        )
        .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn handoff_retains_one_owner_until_successful_boundary_and_fences_old_capability()
-> Result<()> {
    let dir = tempfile::tempdir()?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let b = Broker::open(
        dir.path().join("work"),
        Config::default(),
        Arc::new(ControlledRunner(tx)),
    )
    .await?;
    let started = start(&b, dir.path(), "handoff-start").await;
    let first = pending(&mut rx).await;
    let id = started["taskId"].as_str().unwrap();
    let revision = b.snapshot().await["tasks"][id]["revision"].clone();
    let receipt=b.dispatch(worker(&first.invocation,"handoff",json!({"taskId":id,"provider":"codex","revision":revision,"message":"Continue from the synthetic checkpoint.","requestId":"handoff"}))).await?;
    assert_eq!(receipt["nextAction"], "end-turn");
    assert_eq!(b.snapshot().await["tasks"][id]["owner"], "claude");
    assert!(rx.try_recv().is_err());
    assert!(
        b.dispatch(worker(
            &first.invocation,
            "report",
            json!({"taskId":id,"report":{},"requestId":"after-relinquish"})
        ))
        .await
        .is_err()
    );
    let stale = worker(&first.invocation, "status", json!({"taskId":id}));
    first
        .complete
        .send(Ok(successful("CLAUDEX_HANDOFF")))
        .unwrap();
    let second = pending(&mut rx).await;
    assert_eq!(second.invocation.task["owner"], "codex");
    assert_eq!(second.invocation.task["generation"], 2);
    assert!(b.dispatch(stale).await.is_err());
    second
        .complete
        .send(Ok(successful("Done after the handoff.")))
        .unwrap();
    assert_eq!(
        finish(&b, &started["taskId"]).await["result"]["text"],
        "Done after the handoff."
    );
    b.close().await?;
    Ok(())
}

#[tokio::test]
async fn cooperative_pause_requires_worker_checkpoint_and_successful_completion() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let b = Broker::open(
        dir.path().join("work"),
        Config::default(),
        Arc::new(ControlledRunner(tx)),
    )
    .await?;
    let started = start(&b, dir.path(), "pause-start").await;
    let first = pending(&mut rx).await;
    let id = &started["taskId"];
    let generation = first.invocation.task["generation"].clone();
    b.dispatch(request(
        &b,
        "work_control",
        json!({"taskId":id,"generation":generation,"action":"request-pause","requestId":"pause"}),
    ))
    .await?;
    assert_eq!(
        b.snapshot().await["tasks"][id.as_str().unwrap()]["pause"]["state"],
        "requested"
    );
    let checked = b
        .dispatch(worker(
            &first.invocation,
            "worker_check_in",
            json!({"requestId":"check-in"}),
        ))
        .await?;
    assert_eq!(checked["pause"]["state"], "requested");
    b.dispatch(worker(&first.invocation,"work_control",json!({"taskId":id,"generation":generation,"action":"checkpoint","text":"No unfinished native writes.","requestId":"checkpoint"}))).await?;
    assert_eq!(
        b.snapshot().await["tasks"][id.as_str().unwrap()]["status"],
        "running"
    );
    assert!(rx.try_recv().is_err());
    first
        .complete
        .send(Ok(successful("CLAUDEX_PAUSE")))
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if b.snapshot().await["tasks"][id.as_str().unwrap()]["status"] == "paused" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?;
    b.dispatch(request(
        &b,
        "work_control",
        json!({"taskId":id,"generation":generation,"action":"resume","requestId":"resume"}),
    ))
    .await?;
    let second = pending(&mut rx).await;
    assert_eq!(second.invocation.task["generation"], 2);
    second
        .complete
        .send(Ok(successful("Resumed exactly once.")))
        .unwrap();
    finish(&b, id).await;
    b.close().await?;
    Ok(())
}

#[tokio::test]
async fn child_results_are_acknowledged_only_when_returned_not_by_observability() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let b = Broker::open(
        dir.path().join("work"),
        Config::default(),
        Arc::new(ControlledRunner(tx)),
    )
    .await?;
    let started = start(&b, dir.path(), "parent").await;
    let parent = pending(&mut rx).await;
    let child=b.dispatch(worker(&parent.invocation,"start",json!({"provider":"codex","cwd":dir.path(),"prompt":"Independent synthetic child.","requestId":"child"}))).await?;
    let child_run = pending(&mut rx).await;
    child_run
        .complete
        .send(Ok(successful("Child outcome.")))
        .unwrap();
    let child_done = finish(&b, &child["taskId"]).await;
    let child_id = child["taskId"].as_str().unwrap();
    let parent_id = started["taskId"].as_str().unwrap();
    b.dispatch(worker(
        &parent.invocation,
        "work_events",
        json!({"taskId":child_id,"generation":1}),
    ))
    .await?;
    assert!(b.snapshot().await["tasks"][parent_id]["active"]["seenChildren"][child_id].is_null());
    let seen=b.dispatch(worker(&parent.invocation,"wait",json!({"targets":[{"taskId":child_id,"afterRevision":child_done["revision"]}],"timeoutMs":0,"view":"summary"}))).await?;
    assert_eq!(seen["tasks"][0]["result"]["text"], "Child outcome.");
    assert_eq!(
        b.snapshot().await["tasks"][parent_id]["active"]["seenChildren"][child_id],
        child_done["revision"]
    );
    let caught = b
        .dispatch(worker(
            &parent.invocation,
            "status",
            json!({"taskId":child_id,"afterRevision":child_done["revision"],"view":"summary"}),
        ))
        .await?;
    assert!(caught.get("result").is_none());
    parent
        .complete
        .send(Ok(successful("Integrated the returned child outcome.")))
        .unwrap();
    finish(&b, &started["taskId"]).await;
    b.close().await?;
    Ok(())
}

fn settled_legacy_ledger(cwd: &Path) -> Value {
    let id = "11111111-1111-4111-8111-111111111111";
    json!({"version":1,"defaultModels":{"codex":null,"claude":null},"defaultEfforts":{"codex":null,"claude":null},"tasks":{id:{"id":id,"parentId":null,"returnTo":"codex","owner":"claude","permission":"read-only","model":null,"effort":null,"cwd":cwd,"depth":0,"generation":1,"status":"completed","revision":3,"createdAt":1,"updatedAt":2,"active":null,"pendingHandoff":null,"messages":[{"from":"codex","kind":"request","text":"Synthetic settled legacy request.","at":1}],"result":{"text":"Synthetic retained result.","provider":"claude","generation":1}}},"requests":{"a".repeat(64):{"fingerprint":"b".repeat(64),"result":{"taskId":id,"revision":1}}}})
}

#[tokio::test]
async fn restart_keeps_notifications_off_without_inserting_optional_fields() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let root = claudex_core::storage::private_directory(dir.path().join("work"))?;
    let original = settled_legacy_ledger(dir.path());
    claudex_core::storage::write_json(root.join("work.json"), &original)?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    for _ in 0..2 {
        let b = Broker::open(
            root.clone(),
            Config::default(),
            Arc::new(ControlledRunner(tx.clone())),
        )
        .await?;
        assert_eq!(b.snapshot().await, original);
        b.schedule();
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        b.close().await?;
        assert_eq!(
            claudex_core::storage::read_json(root.join("work.json"))?,
            original
        );
    }
    Ok(())
}

#[tokio::test]
async fn restart_recovers_only_empty_notification_placeholders_with_exact_backup() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let root = claudex_core::storage::private_directory(dir.path().join("work"))?;
    let id = "11111111-1111-4111-8111-111111111111";
    let notified_id = "22222222-2222-4222-8222-222222222222";
    let mut expected = settled_legacy_ledger(dir.path());
    let mut notified = expected["tasks"][id].clone();
    notified["id"] = json!(notified_id);
    notified["notification"] = json!({"policy":{"mode":"wake","expiresInMs":1000},"requestKey":"c".repeat(64),"challenge":"d".repeat(64),"challengeExpiresAt":10,"origin":{"provider":"codex","sessionId":"33333333-3333-4333-8333-333333333333","cwd":dir.path(),"toolUseId":"synthetic-call","source":"synthetic-proof","verifiedAt":1},"deliveries":[{"revision":3,"state":"uncertain","createdAt":2,"expiresAt":1002,"requestId":"synthetic-notification","reason":"notification-outcome-unknown"}],"suppressedRevision":null});
    expected["tasks"][notified_id] = notified;
    expected["requests"]["c".repeat(64)] = json!({"fingerprint":"e".repeat(64),"result":{"taskId":notified_id,"originChallenge":"d".repeat(64),"originChallengeExpiresAt":10,"notificationMode":"wake"}});
    let mut corrupt = expected.clone();
    corrupt["tasks"][id]["notification"] = json!({"deliveries":null});
    let original = format!("{}\n", serde_json::to_string_pretty(&corrupt)?);
    claudex_core::storage::atomic_write(root.join("work.json"), &original)?;
    let backup = root.join("work-notification-placeholders-v1.json");
    let (tx, mut rx) = mpsc::unbounded_channel();
    for attempt in 0..3 {
        if attempt == 1 {
            // An interrupted publication retries only against the exact same backup.
            claudex_core::storage::atomic_write(root.join("work.json"), &original)?;
        }
        let b = Broker::open(
            root.clone(),
            Config::default(),
            Arc::new(ControlledRunner(tx.clone())),
        )
        .await?;
        assert_eq!(b.snapshot().await, expected);
        assert_eq!(std::fs::read_to_string(&backup)?, original);
        b.schedule();
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        b.close().await?;
        assert_eq!(
            claudex_core::storage::read_json(root.join("work.json"))?,
            expected
        );
    }
    Ok(())
}

#[tokio::test]
async fn notification_placeholder_recovery_refuses_ambiguous_evidence_without_writes() -> Result<()>
{
    let id = "11111111-1111-4111-8111-111111111111";
    for (notification, linked_receipt, conflicting_backup) in [
        (json!({"deliveries":[]}), false, false),
        (json!({"deliveries":null,"origin":null}), false, false),
        (json!({"deliveries":null}), true, false),
        (json!({"deliveries":null}), false, true),
    ] {
        let dir = tempfile::tempdir()?;
        let root = claudex_core::storage::private_directory(dir.path().join("work"))?;
        let mut ledger = settled_legacy_ledger(dir.path());
        ledger["tasks"][id]["notification"] = notification;
        if linked_receipt {
            ledger["requests"]["a".repeat(64)]["result"]["originChallenge"] = json!("f".repeat(64));
        }
        let original = format!("{}\n", serde_json::to_string_pretty(&ledger)?);
        claudex_core::storage::atomic_write(root.join("work.json"), &original)?;
        let backup = root.join("work-notification-placeholders-v1.json");
        if conflicting_backup {
            claudex_core::storage::publish_exclusive(&backup, "{}\n")?;
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = Broker::open(
            root.clone(),
            Config::default(),
            Arc::new(ControlledRunner(tx)),
        )
        .await;
        assert!(result.is_err());
        assert!(rx.try_recv().is_err());
        assert_eq!(std::fs::read_to_string(root.join("work.json"))?, original);
        if conflicting_backup {
            assert_eq!(std::fs::read_to_string(&backup)?, "{}\n");
        } else {
            assert!(!backup.exists());
        }
    }
    Ok(())
}

#[tokio::test]
async fn restart_marks_inflight_uncertain_and_never_replays_it() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("work");
    let b = Broker::open(root.clone(), Config::default(), Arc::new(SyntheticRunner)).await?;
    let started = start(&b, dir.path(), "restart").await;
    finish(&b, &started["taskId"]).await;
    b.close().await?;
    let path = root.join("work.json");
    let mut state = claudex_core::storage::read_json(&path)?;
    state["tasks"][started["taskId"].as_str().unwrap()]["status"] = json!("running");
    state["tasks"][started["taskId"].as_str().unwrap()]["active"] = json!({"generation":1,"tokenHash":"0".repeat(64),"processInventoryRequired":true,"processInventoryError":true,"messageCount":0});
    claudex_core::storage::write_json(path, &state)?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let restarted = Broker::open(root, Config::default(), Arc::new(ControlledRunner(tx))).await?;
    restarted.schedule();
    tokio::task::yield_now().await;
    let status = restarted
        .dispatch(request(
            &restarted,
            "status",
            json!({"taskId":started["taskId"]}),
        ))
        .await?;
    assert_eq!(status["status"], "uncertain");
    assert_eq!(status["generation"], 1);
    assert!(rx.try_recv().is_err());
    assert!(restarted.dispatch(request(&restarted,"send",json!({"taskId":started["taskId"],"message":"Do not replay uncertain work.","requestId":"replay"}))).await.is_err());
    restarted.close().await?;
    Ok(())
}

#[tokio::test]
async fn native_executable_smoke_uses_synthetic_json_without_model_inference() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir()?;
    let script = dir.path().join("synthetic-native");
    std::fs::write(
        &script,
        "#!/bin/sh\n/bin/cat >/dev/null\n/bin/sleep 0.3\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"synthetic\"}' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"synthetic executable result\"}}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"cached_input_tokens\":0,\"output_tokens\":3}}'\n",
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let runner = claudex_work::NativeCliRunner {
        codex: script.clone(),
        claude: script,
    };
    let (cancel, cancellation) = tokio::sync::watch::channel(false);
    let (tx, mut rx) = mpsc::channel(128);
    let drain = tokio::spawn(async move {
        let mut events = vec![];
        while let Some(v) = rx.recv().await {
            events.push(v);
        }
        events
    });
    let result=runner.run(Invocation{task:json!({"id":"synthetic","owner":"codex","cwd":dir.path().canonicalize()?,"projectRoot":dir.path().canonicalize()?,"permission":"read-only","model":null,"effort":null,"readOnlyDirs":[],"writableDirs":[]}),prompt:"Only synthetic script stdin.".into(),mcp:Value::Null,cancellation},tx).await.map_err(|e|anyhow::anyhow!(e.message))?;
    drop(cancel);
    assert_eq!(result.text, "synthetic executable result");
    assert!(drain.await?.iter().any(|e| e["type"] == "processes"));
    Ok(())
}

#[test]
fn cli_parser_and_loaded_service_require_exact_arguments() -> Result<()> {
    use claudex_work::{cli, install};
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        cli::command_and_root(&args(&["--root=/fixture", "serve"]))?,
        ("serve".into(), Some("/fixture".into()))
    );
    assert_eq!(cli::command_and_root(&args(&["serve", "-h"]))?.0, "help");
    assert!(cli::command_and_root(&args(&["serve", "--root=/a", "--root", "/b"])).is_err());
    assert!(cli::command_and_root(&args(&["serve", "--unknown=1"])).is_err());
    assert!(cli::command_and_root(&args(&["--root", "--allow-write", "serve"])).is_err());
    let d = install::definition(
        Path::new("/fixture/work"),
        Path::new("/fixture/home"),
        &Config {
            executable: "/fixture/claudex".into(),
            ..Config::default()
        },
    )?;
    let output = format!(
        "path = {}\nprogram = {}\narguments = {{\n{}\n}}\n",
        d.path.display(),
        d.args[0],
        d.args.join("\n")
    );
    install::validate_loaded(&output, &d)?;
    assert!(
        install::validate_loaded(
            &output.replace("/fixture/claudex", "/fixture/claudex-extra"),
            &d
        )
        .is_err()
    );
    assert!(
        install::validate_loaded(&output.replace("serve\n", "serve\n--unexpected\n"), &d).is_err()
    );
    Ok(())
}
