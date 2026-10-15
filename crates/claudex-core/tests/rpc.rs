use anyhow::Result;
use claudex_core::rpc::{CodexClient, RpcError, inspect_codex_socket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use tokio::net::UnixListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn shared_rpc_preserves_notifications_rejects_interactive_requests_and_keeps_error_codes()
-> Result<()> {
    let root = tempfile::tempdir()?;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))?;
    let path = root.path().join("app.sock");
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut ws = accept_async(stream).await?;
        let first: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(first["method"], "initialize");
        ws.send(Message::Text(
            json!({"id":first["id"],"result":{"native":"synthetic"}})
                .to_string()
                .into(),
        ))
        .await?;
        let ack: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(ack["method"], "initialized");
        ws.send(Message::Text(
            json!({"method":"future-native-notification","params":{"extra":true}})
                .to_string()
                .into(),
        ))
        .await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        ws.send(Message::Text(
            json!({"id":"interactive","method":"approval/request","params":{}})
                .to_string()
                .into(),
        ))
        .await?;
        let refusal: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(refusal["id"], "interactive");
        assert_eq!(refusal["error"]["code"], -32601);
        ws.send(Message::Text(
            json!({"id":request["id"],"error":{"code":-32001,"message":"synthetic guard"}})
                .to_string()
                .into(),
        ))
        .await?;
        Ok::<_, anyhow::Error>(())
    });
    let client = CodexClient::connect(&path).await?;
    let mut events = client.subscribe();
    assert_eq!(client.initialize().await?, json!({"native":"synthetic"}));
    let error = client
        .request("thread/read", json!({"threadId":"placeholder"}))
        .await
        .unwrap_err();
    let error = error
        .downcast_ref::<RpcError>()
        .expect("RPC error must retain typed native code");
    assert_eq!(error.code, Some(json!(-32001)));
    assert!(!error.execution_uncertain);
    assert_eq!(events.recv().await?["method"], "future-native-notification");
    client.close().await?;
    server.await??;
    Ok(())
}

#[tokio::test]
async fn disconnected_write_is_uncertain_and_is_never_replayed() -> Result<()> {
    let root = tempfile::tempdir()?;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))?;
    let path = root.path().join("app.sock");
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut ws = accept_async(stream).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(request["method"], "thread/inject_items");
        ws.close(None).await?;
        // A dropped connection does not authorize a replacement connection.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        Ok::<_, anyhow::Error>(())
    });
    let client = CodexClient::connect(&path).await?;
    let error = client
        .request("thread/inject_items", json!({"items":[]}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("completion is unknown"));
    assert!(client.request("thread/read", json!({})).await.is_err());
    client.close().await?;
    server.await??;
    Ok(())
}

#[tokio::test]
async fn socket_aliases_and_permissions_do_not_bypass_native_endpoint_guards() -> Result<()> {
    let root = tempfile::tempdir()?;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))?;
    let path = root.path().join("app.sock");
    let _listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    assert_eq!(inspect_codex_socket(&path)?.socket_path, path);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666))?;
    assert!(inspect_codex_socket(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let alias = root.path().join("alias.sock");
    symlink(&path, &alias)?;
    assert!(inspect_codex_socket(&alias).is_err());
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755))?;
    assert!(inspect_codex_socket(&path).is_err());
    Ok(())
}
