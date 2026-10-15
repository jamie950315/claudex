use anyhow::Result;
use claudex_core::{rpc::MAX_FRAME_BYTES, shared_codex, storage::*, version::VersionPolicy};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use tokio::net::UnixListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
fn fixture() -> Result<(tempfile::TempDir, PathBuf, UnixListener, Value)> {
    let temp = tempfile::tempdir_in("/tmp")?;
    let root = fs::canonicalize(temp.path())?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let directory = root.join("codex-shared");
    private_directory(&directory)?;
    let socket = directory.join("app.sock");
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let identity = FileIdentity::from_metadata(&fs::symlink_metadata(&socket)?);
    let pair = json!({"dev":identity.dev.parse::<u64>()?,"ino":identity.ino.parse::<u64>()?});
    let manifest = json!({"version":1,"pid":std::process::id(),"childPid":std::process::id(),"binary":"/synthetic/codex","cliVersion":"codex-cli 0.155.0-alpha.16.4","listenerPath":socket,"socketPath":socket,"listenerIdentity":pair,"socketIdentity":pair});
    write_json(directory.join("owner.json"), &manifest)?;
    Ok((temp, root, listener, manifest))
}
#[tokio::test]
async fn existing_writer_admission_accepts_js_numeric_identity_without_creating_state() -> Result<()>
{
    let (_temp, root, listener, manifest) = fixture()?;
    let native_home = root.clone();
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(request["method"], "initialize");
        ws.send(Message::Text(
            json!({"id":request["id"],"result":{"codexHome":native_home,"userAgent":"synthetic"}})
                .to_string()
                .into(),
        ))
        .await?;
        let initialized: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(initialized["method"], "initialized");
        Ok::<_, anyhow::Error>(())
    });
    let session =
        shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES).await?;
    assert_eq!(session.manifest, manifest);
    assert_eq!(session.initialized["userAgent"], "synthetic");
    server.await??;
    session.client.close().await?;
    assert!(session.client.is_closed());
    assert!(!root.join("packet-key").exists());
    assert_eq!(fs::read_dir(&root)?.count(), 1);
    Ok(())
}
#[tokio::test]
async fn native_only_unknown_mode_and_contradictory_ownership_are_never_connected() -> Result<()> {
    let (_temp, root, _listener, original) = fixture()?;
    let path = root.join("codex-shared/owner.json");
    let mut cases = vec![];
    let mut native = original.clone();
    native["transportMode"] = json!("native");
    cases.push(native);
    let mut unknown = original.clone();
    unknown["transportMode"] = json!("future-mode");
    cases.push(unknown);
    let mut changed = original.clone();
    changed["socketIdentity"]["ino"] = json!(1);
    cases.push(changed);
    let mut changed = original.clone();
    changed["listenerPath"] = json!(root.join("elsewhere.sock"));
    cases.push(changed);
    let mut changed = original.clone();
    changed["childPid"] = Value::Null;
    cases.push(changed);
    for value in cases {
        write_json(&path, &value)?;
        assert!(
            shared_codex::connect(&root, &root, VersionPolicy::Warn, MAX_FRAME_BYTES)
                .await
                .is_err()
        );
        assert_eq!(read_json(&path)?, value);
    }
    Ok(())
}
#[tokio::test]
async fn manifest_replacement_during_initialize_revokes_admission_without_replay() -> Result<()> {
    let (_temp, root, listener, manifest) = fixture()?;
    let changed_root = root.clone();
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        write_json(changed_root.join("codex-shared/owner.json"), &manifest)?;
        ws.send(Message::Text(
            json!({"id":request["id"],"result":{}}).to_string().into(),
        ))
        .await?;
        // A refused admission must not spawn or reconnect a substitute writer.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        Ok::<_, anyhow::Error>(())
    });
    assert!(
        shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES)
            .await
            .is_err()
    );
    server.await??;
    Ok(())
}

#[tokio::test]
async fn cancelled_initialize_closes_the_read_only_connection() -> Result<()> {
    let (_temp, root, listener, _) = fixture()?;
    let (ready, waiting) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(request["method"], "initialize");
        let _ = ready.send(());
        // Cancellation must close the socket even though no initialize reply
        // arrived and no caller received a client on which to call close().
        let end = tokio::time::timeout(std::time::Duration::from_secs(1), ws.next()).await?;
        assert!(
            end.is_none() || end.is_some_and(|v| v.is_err() || matches!(v, Ok(Message::Close(_))))
        );
        Ok::<_, anyhow::Error>(())
    });
    let client = tokio::spawn(async move {
        shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES).await
    });
    waiting.await?;
    client.abort();
    assert!(client.await.err().unwrap().is_cancelled());
    server.await??;
    Ok(())
}
