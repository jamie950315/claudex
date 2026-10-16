use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_app::{
    codex_cache_native::{UsageCounter, version},
    warm::WarmSettings,
    warm_runtime::{CacheEnvironment, CacheRuntime},
};
use claudex_core::storage::{self, FileIdentity};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    sync::broadcast,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
const ID: &str = "00000000-0000-4000-8000-000000000001";
const OWNER: &str = "00000000-0000-4000-8000-000000000002";
const TURN: &str = "00000000-0000-4000-8000-000000000003";
fn settings() -> Value {
    json!({"model":"synthetic-model","modelProvider":"openai","cwd":"/synthetic-project","serviceTier":null,"disabledPluginIds":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":"medium","collaborationMode":{"mode":"default","settings":{"model":"synthetic-model","reasoning_effort":"medium","developer_instructions":null}},"multiAgentMode":"explicitRequestOnly"})
}
fn usage(n: u64) -> Value {
    json!({"totalTokens":n+5,"inputTokens":n,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":5,"reasoningOutputTokens":0})
}
struct Env;
#[async_trait]
impl CacheEnvironment for Env {
    async fn settings(&self) -> Result<WarmSettings> {
        Ok(WarmSettings::default())
    }
    async fn stopped(&self) -> Result<bool> {
        Ok(false)
    }
}
#[test]
fn exact_usage_deltas_do_not_turn_duplicates_or_resets_into_evidence() -> Result<()> {
    let mut counter = UsageCounter::default();
    let u = usage(100);
    assert!(
        counter
            .observe(ID, TURN, &json!({"total":u,"last":u}), false)?
            .is_none()
    );
    assert!(
        counter
            .observe(ID, TURN, &json!({"total":u,"last":u}), false)?
            .is_none()
    );
    let mut total = usage(200);
    total["outputTokens"] = json!(10);
    total["totalTokens"] = json!(210);
    assert!(
        counter
            .observe(ID, TURN, &json!({"total":total,"last":u}), false)?
            .is_some()
    );
    assert!(
        counter
            .observe(ID, TURN, &json!({"total":u,"last":u}), false)
            .is_err()
    );
    assert!(
        counter
            .observe(ID, TURN, &json!({"total":total,"last":u}), false)
            .is_err()
    );
    let mut prime = UsageCounter::default();
    assert!(
        prime
            .observe(ID, TURN, &json!({"total":u,"last":u}), true)?
            .is_some()
    );
    for v in ["codex/0.160.0", "codex/0.162.0-alpha.17.2", "codex/1.0.0"] {
        version(&json!({"userAgent":v}))?;
    }
    for v in ["codex/0.159.9", "codex/0.160.0-alpha.1", "unknown"] {
        assert!(version(&json!({"userAgent":v})).is_err());
    }
    Ok(())
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    sends: Arc<AtomicUsize>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
impl Fixture {
    fn new(uncertain: bool) -> Result<Self> {
        let temp = tempfile::tempdir_in("/tmp")?;
        let root = fs::canonicalize(temp.path())?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        storage::private_directory(root.join("custom-work"))?;
        storage::private_directory(root.join("codex-shared"))?;
        let home = root.join("home");
        storage::private_directory(&home)?;
        storage::private_directory(home.join("ipc"))?;
        let socket = root.join("codex-shared/app.sock");
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let i = FileIdentity::from_metadata(&fs::symlink_metadata(&socket)?);
        let pair = json!({"dev":i.dev.parse::<u64>()?,"ino":i.ino.parse::<u64>()?});
        storage::write_json(
            root.join("codex-shared/owner.json"),
            &json!({"version":1,"pid":std::process::id(),"childPid":std::process::id(),"cliVersion":"codex-cli 0.162.0","listenerPath":socket,"socketPath":socket,"listenerIdentity":pair,"socketIdentity":pair}),
        )?;
        let ipc = home.join("ipc/ipc.sock");
        let owner = UnixListener::bind(&ipc)?;
        fs::set_permissions(&ipc, fs::Permissions::from_mode(0o600))?;
        let (events, _) = broadcast::channel::<Value>(128);
        let active = Arc::new(AtomicBool::new(false));
        let sends = Arc::new(AtomicUsize::new(0));
        let backend_home = home.clone();
        let backend_events = events.clone();
        let backend_active = active.clone();
        let backend = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let home = backend_home.clone();
                let events = backend_events.clone();
                let active = backend_active.clone();
                tokio::spawn(async move {
                    let mut ws = accept_async(stream).await.unwrap();
                    let mut rx = events.subscribe();
                    loop {
                        tokio::select! {
                            message=ws.next()=>{let Some(Ok(Message::Text(text)))=message else{break};let request:Value=serde_json::from_str(&text).unwrap();if request.get("id").is_none(){continue}
                                let thread=json!({"id":ID,"cwd":"/synthetic-project","model":"synthetic-model","reasoningEffort":"medium","status":{"type":if active.load(Ordering::SeqCst){"active"}else{"idle"}},"ephemeral":false,"parentThreadId":null,"forkedFromId":null,"source":"exec","path":"/synthetic-transcript"});
                                let result=match request["method"].as_str().unwrap(){"initialize"=>json!({"userAgent":"codex/0.162.0","codexHome":home}),"thread/read"=>json!({"thread":thread}),"thread/loaded/list"=>json!({"data":[ID]}),"thread/goal/get"=>json!({"goal":null}),"thread/resume"=>{let mut s=settings();s["thread"]=thread;s},"thread/turns/list"=>json!({"data":[]}),m=>panic!("Unexpected native method {m}")};
                                if ws.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.is_err(){break}
                            },
                            event=rx.recv()=>{let Ok(event)=event else{break};if ws.send(Message::Text(event.to_string().into())).await.is_err(){break}}
                        }
                    }
                });
            }
        });
        let owner_sends = sends.clone();
        let ipc_task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = owner.accept().await else {
                    break;
                };
                let events = events.clone();
                let active = active.clone();
                let sends = owner_sends.clone();
                tokio::spawn(async move {
                    loop {
                        let mut header = [0; 4];
                        if stream.read_exact(&mut header).await.is_err() {
                            break;
                        }
                        let n = u32::from_le_bytes(header) as usize;
                        assert!(n < 1024 * 1024);
                        let mut bytes = vec![0; n];
                        stream.read_exact(&mut bytes).await.unwrap();
                        let request: Value = serde_json::from_slice(&bytes).unwrap();
                        let method = request["method"].as_str().unwrap();
                        let result = match method {
                            "initialize" => {
                                json!({"clientId":"00000000-0000-4000-8000-000000000004"})
                            }
                            "thread-owner-discovery" => json!({"supportsUntrustedAppInput":true}),
                            "thread-follower-start-turn" => {
                                assert_eq!(request["version"], 2);
                                assert_eq!(
                                    request["params"]["turnStart"]["context"]["inheritThreadSettings"],
                                    true
                                );
                                assert_eq!(
                                    request["params"]["turnStart"]["request"]["threadId"],
                                    ID
                                );
                                sends.fetch_add(1, Ordering::SeqCst);
                                if uncertain {
                                    break;
                                }
                                active.store(true, Ordering::SeqCst);
                                let active = active.clone();
                                let events = events.clone();
                                tokio::spawn(async move {
                                    tokio::time::sleep(Duration::from_millis(20)).await;
                                    let at = claudex_app::codex_cache_native::now() / 1000;
                                    let _=events.send(json!({"method":"turn/started","params":{"threadId":ID,"turn":{"id":TURN,"startedAt":at}}}));
                                    let u = usage(100);
                                    let _=events.send(json!({"method":"thread/tokenUsage/updated","params":{"threadId":ID,"turnId":TURN,"tokenUsage":{"total":u,"last":u}}}));
                                    active.store(false, Ordering::SeqCst);
                                    let _=events.send(json!({"method":"turn/completed","params":{"threadId":ID,"turn":{"id":TURN,"completedAt":at+1,"status":"completed"}}}));
                                });
                                json!({"result":{"turn":{"id":TURN}}})
                            }
                            m => panic!("Unexpected owner method {m}"),
                        };
                        let response = json!({"type":"response","requestId":request["requestId"],"method":method,"resultType":"success","handledByClientId":OWNER,"result":result});
                        let bytes = response.to_string().into_bytes();
                        if stream
                            .write_all(&(bytes.len() as u32).to_le_bytes())
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if stream.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        Ok(Self {
            _temp: temp,
            root,
            home,
            sends,
            tasks: vec![backend, ipc_task],
        })
    }
}
#[tokio::test]
async fn native_prime_runs_once_through_existing_owner_and_accounts_actual_usage() -> Result<()> {
    let f = Fixture::new(false)?;
    let runtime = CacheRuntime::open_with_root(
        f.root.clone(),
        f.root.join("custom-work"),
        f.home.clone(),
        Arc::new(Env),
    )
    .await?;
    let settings = WarmSettings::default();
    let p = json!({"sessionId":ID,"cwd":"/synthetic-project","bestEffort":true,"maxRefreshes":1,"compact":false});
    let preview = runtime
        .dispatch(
            "codex_cache_warm_prepare",
            "codex",
            p,
            settings.clone(),
            false,
        )
        .await?;
    let result = runtime
        .dispatch(
            "codex_cache_warm_confirm",
            "codex",
            json!({"confirmationId":preview["confirmationId"],"bestEffort":true}),
            settings.clone(),
            false,
        )
        .await?;
    assert_eq!(result["policy"]["enabled"], true);
    let done = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let v = runtime
                .dispatch(
                    "codex_cache_warm_list",
                    "codex",
                    json!({}),
                    settings.clone(),
                    false,
                )
                .await?;
            if v["attempts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["state"] == "verified")
            {
                break Ok::<_, anyhow::Error>(v);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await??;
    assert_eq!(done["attempts"][0]["kind"], "prime");
    assert_eq!(done["attempts"][0]["actual"]["inputTokens"], 100);
    assert_eq!(done["policies"][0]["enabled"], false);
    assert_eq!(done["policies"][0]["reason"], "refresh-limit");
    assert_eq!(done["policies"][0]["nativeReason"], "refresh-limit");
    assert_eq!(done["providerStatus"]["bindings"], 0);
    assert_eq!(f.sends.load(Ordering::SeqCst), 1);
    assert!(!CacheRuntime::supports("codex_cache_warm_claim"));
    assert!(!f.root.join("collaboration").exists());
    runtime.close().await?;
    Ok(())
}
#[tokio::test]
async fn unknown_native_dispatch_is_not_replayed_after_restart() -> Result<()> {
    let f = Fixture::new(true)?;
    let work = f.root.join("custom-work");
    let settings = WarmSettings::default();
    let runtime =
        CacheRuntime::open_with_root(f.root.clone(), work.clone(), f.home.clone(), Arc::new(Env))
            .await?;
    let preview = runtime
        .dispatch(
            "codex_cache_warm_prepare",
            "codex",
            json!({"sessionId":ID,"cwd":"/synthetic-project","bestEffort":true}),
            settings.clone(),
            false,
        )
        .await?;
    runtime
        .dispatch(
            "codex_cache_warm_confirm",
            "codex",
            json!({"confirmationId":preview["confirmationId"],"bestEffort":true}),
            settings.clone(),
            false,
        )
        .await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let v = runtime
                .dispatch(
                    "codex_cache_warm_list",
                    "codex",
                    json!({}),
                    settings.clone(),
                    false,
                )
                .await?;
            if v["attempts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["state"] == "uncertain")
            {
                break Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await??;
    runtime.close().await?;
    let restarted =
        CacheRuntime::open_with_root(f.root.clone(), work, f.home.clone(), Arc::new(Env)).await?;
    let status = restarted
        .dispatch("codex_cache_warm_list", "codex", json!({}), settings, false)
        .await?;
    ensure!(
        status["policies"][0]["enabled"] == false,
        "Restart must not resume native input."
    );
    assert_eq!(f.sends.load(Ordering::SeqCst), 1);
    restarted.close().await?;
    Ok(())
}
