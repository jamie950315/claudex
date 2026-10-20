use anyhow::Result;
use claudex_core::{
    rpc::{MAX_FRAME_BYTES, TransportUnavailable},
    shared_codex,
    storage::*,
    version::VersionPolicy,
};
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
async fn missing_endpoint_is_typed_and_identifies_the_failed_admission_step() -> Result<()> {
    let temp = tempfile::tempdir()?;
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
    let root = fs::canonicalize(temp.path())?.join("transport");
    let directory = root.join("codex-shared");
    let manifest = directory.join("owner.json");
    for (operation, path) in [
        ("inspect transport root", &root),
        ("inspect backend directory", &directory),
        ("read backend manifest", &manifest),
    ] {
        let error =
            match shared_codex::connect(&root, &root, VersionPolicy::Warn, MAX_FRAME_BYTES).await {
                Err(error) => error,
                Ok(_) => panic!("Missing endpoint must refuse admission"),
            };
        let unavailable = error.downcast_ref::<TransportUnavailable>().unwrap();
        assert_eq!(unavailable.operation, operation);
        assert_eq!(unavailable.path, *path);
        assert!(is_not_found(&error));
        assert!(error.to_string().contains(&path.display().to_string()));
        // Only the fixture creates directories; the client must not create a
        // replacement backend or leave state behind after a refusal.
        assert!(!path.exists());
        if path != &manifest {
            private_directory(path)?;
        }
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755))?;
    let error = shared_codex::connect(&root, &root, VersionPolicy::Warn, MAX_FRAME_BYTES)
        .await
        .err()
        .unwrap();
    assert!(!error.is::<TransportUnavailable>());
    assert!(error.to_string().contains("owner-only"));
    Ok(())
}

#[tokio::test]
async fn missing_manifest_recovers_only_on_a_new_fully_verified_connection() -> Result<()> {
    let (_temp, root, listener, manifest) = fixture()?;
    let path = root.join("codex-shared/owner.json");
    fs::remove_file(&path)?;
    let error = shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES)
        .await
        .err()
        .unwrap();
    assert!(error.is::<TransportUnavailable>());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    write_json(&path, &manifest)?;
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(request["method"], "initialize");
        ws.send(Message::Text(
            json!({"id":request["id"],"result":{}}).to_string().into(),
        ))
        .await?;
        let initialized: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        assert_eq!(initialized["method"], "initialized");
        Ok::<_, anyhow::Error>(())
    });
    let session =
        shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES).await?;
    assert_eq!(session.manifest, manifest);
    server.await??;
    session.client.close().await?;
    Ok(())
}

#[tokio::test]
async fn missing_native_home_is_not_endpoint_unavailability() -> Result<()> {
    let (_temp, root, listener, _) = fixture()?;
    let missing_home = root.join("absent-native-home");
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        ws.send(Message::Text(
            json!({"id":request["id"],"result":{"codexHome":missing_home}})
                .to_string()
                .into(),
        ))
        .await?;
        // Keep the endpoint alive until admission closes it. A server-side
        // disconnect would test transport failure instead of home validation.
        while let Some(Ok(frame)) = ws.next().await {
            if matches!(frame, Message::Close(_)) {
                break;
            }
        }
        Ok::<_, anyhow::Error>(())
    });
    let error = shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES)
        .await
        .err()
        .unwrap();
    assert!(is_not_found(&error));
    assert!(!error.is::<TransportUnavailable>());
    assert!(error.to_string().contains("Shared backend native home"));
    assert!(error.to_string().contains("absent-native-home"));
    server.await??;
    Ok(())
}

#[tokio::test]
async fn manifest_disappearance_during_initialize_never_reuses_the_old_proof() -> Result<()> {
    let (_temp, root, listener, _) = fixture()?;
    let manifest = root.join("codex-shared/owner.json");
    let removed = manifest.clone();
    let server = tokio::spawn(async move {
        let mut ws = accept_async(listener.accept().await?.0).await?;
        let request: Value = serde_json::from_slice(&ws.next().await.unwrap()?.into_data())?;
        fs::remove_file(&removed)?;
        ws.send(Message::Text(
            json!({"id":request["id"],"result":{}}).to_string().into(),
        ))
        .await?;
        while let Some(Ok(frame)) = ws.next().await {
            if matches!(frame, Message::Close(_)) {
                break;
            }
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        Ok::<_, anyhow::Error>(())
    });
    let error = shared_codex::connect(&root, &root, VersionPolicy::Strict, MAX_FRAME_BYTES)
        .await
        .err()
        .unwrap();
    let unavailable = error.downcast_ref::<TransportUnavailable>().unwrap();
    assert_eq!(unavailable.operation, "read backend manifest");
    assert_eq!(unavailable.path, manifest);
    server.await??;
    Ok(())
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
