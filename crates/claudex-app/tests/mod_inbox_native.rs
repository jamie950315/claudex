//! Real local process/socket proofs with a synthetic, model-free parent.
//! The fixture parent is named `claude`; no vendor executable is started.
#[cfg(target_os = "macos")]
mod macos {
    use anyhow::{Context, Result, ensure};
    use async_trait::async_trait;
    use claudex_app::{
        mod_inbox::{self, Guard},
        platform::SystemRunner,
    };
    use serde_json::{Value, json};
    use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
    use tokio::{io::AsyncReadExt, net::UnixListener, process::Command};
    const TOKEN: &str = "synthetic-parent-token";
    const TEXT: &str = "Synthetic inbox transport proof; never model input.";
    struct Allowed;
    #[async_trait]
    impl Guard for Allowed {
        async fn before_write(&self) -> Result<bool> {
            Ok(true)
        }
    }
    fn child(executable: PathBuf, test: &str) -> Command {
        let mut command = Command::new(executable);
        command
            .args(["--exact", test, "--ignored", "--nocapture"])
            .kill_on_drop(true);
        command
    }
    #[tokio::test]
    async fn real_parent_and_socket_proofs_admit_only_the_guarded_fixture_write() -> Result<()> {
        let temporary = tempfile::Builder::new()
            .prefix("cldx-inbox-")
            .tempdir_in("/private/tmp")?;
        let root = std::fs::canonicalize(temporary.path())?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        let parent = root.join("claude");
        std::fs::copy(std::env::current_exe()?, &parent)?;
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))?;
        let mut command = child(parent, "macos::parent_fixture");
        command
            .env("CLAUDEX_INBOX_FIXTURE", "parent")
            .env("CLAUDEX_INBOX_ROOT", &root);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await??;
        ensure!(
            output.status.success(),
            "Synthetic parent proof failed: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        Ok(())
    }
    #[tokio::test]
    #[ignore = "Internal model-free fixture, launched by the process/socket integration test."]
    async fn parent_fixture() -> Result<()> {
        if std::env::var("CLAUDEX_INBOX_FIXTURE").as_deref() != Ok("parent") {
            return Ok(());
        }
        let root = PathBuf::from(std::env::var("CLAUDEX_INBOX_ROOT")?);
        let socket = root.join("native.sock");
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let mut command = child(std::env::current_exe()?, "macos::child_fixture");
        command
            .env("CLAUDEX_INBOX_FIXTURE", "child")
            .env("CLAUDE_CODE_MESSAGING_SOCKET", &socket)
            .env("CLAUDE_CODE_MESSAGING_TOKEN", TOKEN);
        let exchange = async {
            let output = async { Ok::<_, anyhow::Error>(command.output().await?) };
            let received = async {
                let (mut stream, _) = listener.accept().await?;
                let mut bytes = vec![];
                stream.read_to_end(&mut bytes).await?;
                Ok::<_, anyhow::Error>(bytes)
            };
            let (output, bytes) = tokio::try_join!(output, received)?;
            ensure!(
                output.status.success(),
                "Synthetic child proof failed: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            let rows = String::from_utf8(bytes)?
                .lines()
                .map(serde_json::from_str)
                .collect::<std::result::Result<Vec<Value>, _>>()?;
            ensure!(
                rows == vec![
                    json!({"type":"auth","token":TOKEN}),
                    json!({"type":"user","message":{"role":"user","content":TEXT}})
                ],
                "Synthetic socket framing differs."
            );
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(25), exchange)
            .await
            .context("Synthetic socket proof timed out.")??;
        Ok(())
    }
    #[tokio::test]
    #[ignore = "Internal model-free fixture, launched by the synthetic parent."]
    async fn child_fixture() -> Result<()> {
        if std::env::var("CLAUDEX_INBOX_FIXTURE").as_deref() != Ok("child") {
            return Ok(());
        }
        assert_eq!(mod_inbox::inspect(&SystemRunner).await?["ready"], true);
        let result =
            mod_inbox::submit(TEXT, &Allowed, &SystemRunner, Duration::from_secs(10)).await;
        assert_eq!(
            result,
            json!({"state":"submitted","reason":"socket-written","automaticReplay":false})
        );
        // Once permissions change, the real no-follow file proof refuses.
        let path = PathBuf::from(std::env::var("CLAUDE_CODE_MESSAGING_SOCKET")?);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))?;
        assert!(mod_inbox::inspect(&SystemRunner).await.is_err());
        Ok(())
    }
}
