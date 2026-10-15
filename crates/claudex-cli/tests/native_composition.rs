use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_cli::{
    integration::NativeIntegration,
    native_clients::{Homes, NativeClient, verify_origin},
};
use claudex_core::storage;
use claudex_work::{Integration, Provider, notifications::NativeDispatchGuard};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
const SESSION: &str = "11111111-1111-4111-8111-111111111111";
fn fixture() -> Result<(tempfile::TempDir, PathBuf, Homes)> {
    let temp = tempfile::tempdir_in("/tmp")?;
    let root = fs::canonicalize(temp.path())?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let homes = Homes {
        codex: root.join("c"),
        claude: root.join("a"),
        desktop_registry: root.join("r"),
    };
    storage::private_directory(&homes.codex)?;
    storage::private_directory(&homes.claude)?;
    Ok((temp, root, homes))
}
fn listener(path: &std::path::Path) -> Result<UnixListener> {
    storage::private_directory(path.parent().unwrap())?;
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}
#[tokio::test]
async fn actual_origin_adapter_initializes_reads_exact_call_and_closes_without_inference()
-> Result<()> {
    let (_temp, root, homes) = fixture()?;
    let listener = listener(
        &homes
            .codex
            .join("app-server-control/app-server-control.sock"),
    )?;
    let arguments = json!({"requestId":"request","instruction":"synthetic task"});
    let receipt =
        json!({"taskId":"22222222-2222-4222-8222-222222222222","originChallenge":"a".repeat(64)});
    let input = json!({"provider":"codex","sessionId":SESSION,"cwd":"/synthetic/project","toolUseId":"tool-one","turnId":"turn-one","expectedFingerprint":storage::hash_json(&json!({"method":"start","params":arguments}))?,"expectedReceipt":receipt});
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let mut methods = vec![];
        while let Some(message) = ws.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text)?;
            let method = request["method"].as_str().unwrap();
            methods.push(method.to_string());
            let result = match method {
                "initialize" => json!({}),
                "initialized" => continue,
                "thread/read" => {
                    json!({"thread":{"id":SESSION,"sessionId":SESSION,"cwd":"/synthetic/project","parentThreadId":null,"ephemeral":false,"threadSource":"user","source":"exec"}})
                }
                "thread/items/list" => {
                    json!({"data":[{"turnId":"turn-one","item":{"id":"tool-one","type":"mcpToolCall","server":"claudex-work","tool":"claudex_start","status":"completed","error":null,"arguments":arguments,"result":{"content":[{"type":"text","text":receipt.to_string()}],"structuredContent":receipt}}}],"nextCursor":null})
                }
                _ => panic!("Origin adapter attempted non-read operation: {method}"),
            };
            ws.send(Message::Text(
                json!({"id":request["id"],"result":result})
                    .to_string()
                    .into(),
            ))
            .await?;
        }
        assert_eq!(
            methods,
            [
                "initialize",
                "initialized",
                "thread/read",
                "thread/items/list",
                "thread/read"
            ]
        );
        Ok::<_, anyhow::Error>(())
    });
    let result = verify_origin(&root, &homes, &input).await?;
    assert_eq!(result["source"], "codex-native-mcp-result");
    server.await??;
    assert!(!root.join("packet-key").exists());
    Ok(())
}
#[tokio::test]
async fn invalid_configured_launcher_never_connects_an_alternate_endpoint() -> Result<()> {
    let (_temp, root, homes) = fixture()?;
    let listener = listener(
        &homes
            .codex
            .join("app-server-control/app-server-control.sock"),
    )?;
    storage::write_json(
        root.join("desktop-launcher.json"),
        &json!({"version":1,"shim":"/foreign"}),
    )?;
    assert!(NativeClient::connect(&root, &homes.codex).await.is_err());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    Ok(())
}
struct Deny(Arc<AtomicUsize>);
#[async_trait]
impl NativeDispatchGuard for Deny {
    async fn check(&self) -> Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        ensure!(false, "Superseded notification.");
        Ok(())
    }
}
#[tokio::test]
async fn root_native_wake_consumes_preparation_and_checks_the_final_notification_fence()
-> Result<()> {
    let (_temp, root, homes) = fixture()?;
    let listener = listener(&homes.codex.join("ipc/ipc.sock"))?;
    let writes = Arc::new(AtomicUsize::new(0));
    let count = writes.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await?;
        loop {
            let mut header = [0; 4];
            if stream.read_exact(&mut header).await.is_err() {
                break;
            }
            let mut bytes = vec![0; u32::from_le_bytes(header) as usize];
            stream.read_exact(&mut bytes).await?;
            let request: Value = serde_json::from_slice(&bytes)?;
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({"clientId":"33333333-3333-4333-8333-333333333333"}),
                "thread-owner-discovery" => json!({"supportsUntrustedAppInput":true}),
                _ => {
                    count.fetch_add(1, Ordering::SeqCst);
                    panic!("A rejected notification wrote a native turn")
                }
            };
            let response = json!({"type":"response","requestId":request["requestId"],"resultType":"success","method":request["method"],"handledByClientId":"44444444-4444-4444-8444-444444444444","result":result});
            let bytes = serde_json::to_vec(&response)?;
            stream
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .await?;
            stream.write_all(&bytes).await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let integration = NativeIntegration::new(root, homes);
    let prepared = integration
        .dispatch(
            "native_chat_wake",
            Provider::Codex,
            json!({"action":"prepare","provider":"codex","sessionId":SESSION}),
        )
        .await?;
    assert_eq!(prepared["status"], "ready");
    let params = json!({"action":"dispatch","provider":"codex","sessionId":SESSION,"messageId":"one","context":"synthetic peer notification","prepared":prepared});
    let fences = Arc::new(AtomicUsize::new(0));
    let result = integration
        .dispatch_fenced(
            "native_chat_wake",
            Provider::Codex,
            params.clone(),
            Arc::new(Deny(fences.clone())),
        )
        .await?;
    assert_eq!(result["status"], "rejected");
    assert_eq!(fences.load(Ordering::SeqCst), 1);
    assert!(
        integration
            .dispatch("native_chat_wake", Provider::Codex, params)
            .await
            .is_err()
    );
    server.await??;
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    integration.close().await?;
    Ok(())
}

#[tokio::test]
async fn cache_runtime_is_lazy_and_uses_the_actual_collaboration_root() -> Result<()> {
    let (_temp, root, homes) = fixture()?;
    let work = storage::private_directory(root.join("custom-broker"))?;
    let integration = NativeIntegration::with_work_root(root.clone(), work.clone(), homes);
    assert!(
        integration
            .warm_dispatch(
                "cache_warm_list",
                Provider::Claude,
                json!({}),
                json!({}),
                false
            )
            .await
            .is_err()
    );
    assert!(!root.join("collaboration").exists());
    assert!(!work.join("cache-warm.json").exists());
    integration.start().await?;
    let list = integration
        .warm_dispatch(
            "cache_warm_list",
            Provider::Claude,
            json!({}),
            json!({"defaultWarmLimit":"rounds=2"}),
            false,
        )
        .await?;
    assert_eq!(list["policies"], json!([]));
    assert!(!root.join("collaboration").exists());
    assert!(integration.validate_warm_limit("until=15:30").await.is_ok());
    assert!(
        integration
            .validate_warm_limit("until=23:15:30")
            .await
            .is_err()
    );
    integration.close().await?;
    integration.close().await?;
    assert!(
        integration
            .warm_dispatch(
                "cache_warm_list",
                Provider::Claude,
                json!({}),
                json!({}),
                false
            )
            .await
            .is_err()
    );
    Ok(())
}
