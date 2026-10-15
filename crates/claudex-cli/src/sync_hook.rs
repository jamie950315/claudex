//! One native-hook boundary for collaboration and synchronization. Private hook
//! input is transient; diagnostics retain only allowlisted phase/error codes.
use crate::args::Args;
use anyhow::{Result, bail, ensure};
use claudex_sync::{hook_health, hooks};
use serde_json::Value;
use std::path::Path;
use tokio::io::AsyncReadExt;

fn health(root: &Path, provider: &str, phase: &str, code: Option<&str>) {
    if hook_health::record(root, provider, phase, code).is_err() {
        eprintln!("Claudex hook health could not be recorded; diagnostics are incomplete.");
    }
}
fn warning(root: &Path, provider: &str, phase: &str, code: Option<&str>) {
    let code = hook_health::code(phase, code);
    health(root, provider, phase, Some(code));
    match (phase, code) {
        ("mailbox", "MAILBOX_CAPACITY_EXHAUSTED") => eprintln!(
            "Claudex chat mailbox capacity exhausted; registration or delivery is unavailable. Inspect collaboration status."
        ),
        ("origin_bind", _) => eprintln!("Claudex origin binding was not confirmed ({code})."),
        ("origin_recheck", _) => (),
        _ => eprintln!(
            "Claudex native-chat coordination could not be verified; inspect the message receipt before retrying."
        ),
    }
}

pub async fn handle(root: &Path, provider: &str, input: &Value) -> Result<Option<Value>> {
    ensure!(input.is_object(), "Invalid hook input.");
    if ["agent_id", "agentId", "agent_type"]
        .iter()
        .any(|k| input.get(*k).is_some_and(|v| !v.is_null()))
        || input["hook_event_name"] == "SubagentStop"
    {
        return Ok(None);
    }
    health(root, provider, "input", None);
    // Collaboration owns its mailbox/origin phases. A coordination failure
    // never suppresses the independent synchronization publication below.
    let work = match claudex_work::hooks::native_hook(root, provider, input).await {
        Ok(work) => work,
        Err(_) => {
            warning(root, provider, "mailbox", None);
            Default::default()
        }
    };
    for phase in &work.completed_phases {
        health(root, provider, phase, None);
    }
    for error in &work.warnings {
        if let Some(phase @ ("origin_bind" | "origin_recheck" | "mailbox")) =
            error["phase"].as_str()
        {
            warning(root, provider, phase, error["error"]["code"].as_str());
        }
    }
    match hooks::hook_event_with_kind(root, provider, input, work.kind_override).await {
        Ok(Some(_)) => health(root, provider, "sync", None),
        Ok(None) => (),
        Err(_) => {
            health(root, provider, "sync", Some("SYNC_EVENT_UNRECORDED"));
            bail!("Claudex could not record the synchronization wake event.");
        }
    }
    Ok(work.output)
}

pub async fn run(raw: &[String]) -> Result<()> {
    let args = Args::parse(raw, &["root", "provider"], &[])?;
    ensure!(args.positionals == ["sync-hook"], "Invalid hook arguments.");
    ensure!(
        args.values.values().all(|v| v.len() == 1),
        "Duplicate hook arguments."
    );
    let provider = args.value("provider").unwrap_or("");
    ensure!(
        ["codex", "claude"].contains(&provider),
        "Invalid hook provider."
    );
    // Full-access workers inherit user hooks, but must neither enroll nor
    // consume ordinary native-chat messages. Drain without retaining content.
    if std::env::var("CLAUDEX_COLLABORATION_WORKER").as_deref() == Ok("1") {
        tokio::io::copy(&mut tokio::io::stdin(), &mut tokio::io::sink()).await?;
        return Ok(());
    }
    let root = args.value("root").map(Path::new);
    ensure!(root.is_some_and(Path::is_absolute), "Invalid hook root.");
    let root = root.unwrap();
    let input = async {
        let mut data = Vec::new();
        tokio::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut data)
            .await?;
        ensure!(data.len() <= 1024 * 1024, "Hook input exceeds its bound.");
        let input: Value = serde_json::from_slice(&data)?;
        ensure!(input.is_object(), "Invalid hook input.");
        Ok::<_, anyhow::Error>(input)
    }
    .await;
    let input = match input {
        Ok(input) => input,
        Err(_) => {
            health(root, provider, "input", Some("INPUT_INVALID"));
            bail!("Claudex could not read the bounded synchronization hook input.");
        }
    };
    if let Some(output) = handle(root, provider, &input).await? {
        println!("{}", serde_json::to_string(&output)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudex_core::storage;
    use claudex_sync::events::{Inbox, Kind};
    use claudex_work::{Provider, mailbox::ChatMailbox};
    use serde_json::json;
    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    #[tokio::test]
    async fn broker_failure_keeps_sync_hint_and_content_free_diagnostics() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = std::fs::canonicalize(temp.path())?;
        let input = json!({"hook_event_name":"Stop","session_id":SESSION,"cwd":"/synthetic/project","prompt":"private hook input"});
        assert!(handle(&root, "codex", &input).await?.is_none());
        let inbox = Inbox::new(&root)?.list()?;
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].event.kind, Kind::Completed);
        let health = hook_health::read(&root);
        assert_eq!(
            health["codex"]["phases"]["origin_recheck"]["lastError"]["code"],
            "ORIGIN_UNVERIFIED"
        );
        let diagnostic = serde_json::to_string(&health)?;
        assert!(!diagnostic.contains(SESSION));
        assert!(!diagnostic.contains("/synthetic/project"));
        assert!(!diagnostic.contains("private hook input"));
        Ok(())
    }

    #[tokio::test]
    async fn mailbox_stop_continuation_publishes_started_not_completed() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = std::fs::canonicalize(temp.path())?;
        storage::private_directory(&root)?;
        let mailbox = ChatMailbox::new(root.join("collaboration/chat-mailbox"));
        mailbox.hook(
            Provider::Codex,
            SESSION,
            Path::new("/synthetic/project"),
            "SessionStart",
            false,
            "",
        )?;
        mailbox.send(&json!({"fromProvider":"claude","targetProvider":"codex","targetSessionId":SESSION,"message":"synthetic peer context","requestId":"one"}), None)?;
        let output = handle(
            &root,
            "codex",
            &json!({"hook_event_name":"Stop","session_id":SESSION,"cwd":"/synthetic/project"}),
        )
        .await?
        .unwrap();
        assert_eq!(output["decision"], "block");
        assert!(
            output["reason"]
                .as_str()
                .unwrap()
                .contains("synthetic peer context")
        );
        assert_eq!(Inbox::new(&root)?.list()?[0].event.kind, Kind::Started);
        Ok(())
    }

    #[tokio::test]
    async fn stopped_and_subagent_hooks_neither_register_nor_publish() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = std::fs::canonicalize(temp.path())?;
        storage::write_json(
            root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        assert!(
            handle(
                &root,
                "claude",
                &json!({"hook_event_name":"Stop","session_id":SESSION,"cwd":"/synthetic/project"})
            )
            .await?
            .is_none()
        );
        std::fs::remove_file(root.join("app-stop.json"))?;
        assert!(handle(&root,"claude",&json!({"hook_event_name":"SubagentStop","session_id":SESSION,"cwd":"/synthetic/project"})).await?.is_none());
        assert!(!root.join("collaboration").exists());
        assert!(!root.join("sync-events").exists());
        Ok(())
    }
}
