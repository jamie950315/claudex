use anyhow::Result;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output},
};

fn cli(root: &Path, args: &[&str]) -> Result<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_claudex"))
        .args(args)
        .arg("--root")
        .arg(root)
        .output()?)
}

#[test]
fn edited_source_command_routes_explicit_preview_and_requires_commit_selection() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = claudex_core::storage::private_directory(temp.path())?;
    let codex = claudex_core::storage::private_directory(root.join("codex"))?;
    let claude = claudex_core::storage::private_directory(root.join("claude"))?;
    claudex_core::storage::write_json(
        root.join("config.json"),
        &json!({"version":1,"mode":"desktop","codexHome":codex,"claudeHome":claude}),
    )?;
    let id = "00000000-0000-4000-8000-000000000001";
    let rejected = cli(
        &root,
        &[
            "resolve-edited-source",
            id,
            "--id",
            id,
            "--operation-id",
            id,
            "--inspect",
            "--expected-count",
            "2",
        ],
    )?;
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("inspection never commits"));
    let missing = cli(
        &root,
        &[
            "resolve-edited-source",
            id,
            "--id",
            id,
            "--operation-id",
            id,
        ],
    )?;
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("Missing --expected-count"));
    let preview = cli(
        &root,
        &[
            "resolve-edited-source",
            id,
            "--id",
            id,
            "--operation-id",
            id,
            "--inspect",
        ],
    )?;
    assert!(!preview.status.success());
    assert!(String::from_utf8_lossy(&preview.stderr).contains("Exact prepared Desktop handoff"));
    assert!(!root.join("edited-source-resolutions").exists());
    Ok(())
}

#[test]
fn supervisor_entry_preserves_an_explicit_worker_executable() -> Result<()> {
    let temp = tempfile::tempdir_in("/tmp")?;
    let base = temp.path().canonicalize()?;
    let root = base.join("state");
    claudex_core::storage::private_directory(&root)?;
    claudex_core::storage::write_json(root.join("config.json"), &json!({"version":1}))?;
    let worker = base.join("synthetic-worker");
    fs::write(
        &worker,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CLAUDEX_TEST_ARGS\"\n",
    )?;
    fs::set_permissions(&worker, fs::Permissions::from_mode(0o700))?;
    let arguments = base.join("arguments");
    let output = Command::new(env!("CARGO_BIN_EXE_claudex"))
        .args(["service-supervise", "--root"])
        .arg(&root)
        .arg("--cli")
        .arg(&worker)
        .env("CLAUDEX_TEST_ARGS", &arguments)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(arguments)?,
        format!("watch\n--root\n{}\n", root.display())
    );
    assert!(!root.join("service-supervisor.lock").exists());
    Ok(())
}
fn value(output: Output) -> Result<Value> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
#[test]
fn fresh_rust_cli_initializes_inspects_and_preserves_existing_configuration() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("private");
    let codex = temp.path().join("codex");
    let claude = temp.path().join("claude");
    fs::create_dir(&codex)?;
    fs::create_dir(&claude)?;
    let args = [
        "init",
        "--codex-home",
        codex.to_str().unwrap(),
        "--claude-home",
        claude.to_str().unwrap(),
        "--all-projects",
    ];
    let initialized = value(cli(&root, &args)?)?;
    assert_eq!(initialized["allProjects"], true);
    assert_eq!(initialized["watching"], false);
    let before = fs::read(root.join("config.json"))?;
    let duplicate = cli(&root, &args)?;
    assert!(!duplicate.status.success());
    assert_eq!(fs::read(root.join("config.json"))?, before);
    let status = value(cli(&root, &["status"])?)?;
    assert_eq!(status["mode"], "legacy");
    assert_eq!(status["versionPolicy"], "strict");
    assert_eq!(status["conversations"], json!([]));
    assert_eq!(status["pending"], Value::Null);
    assert_eq!(
        value(cli(&root, &["version-policy", "warn"])?)?["versionPolicy"],
        "warn"
    );
    assert_eq!(value(cli(&root, &["status"])?)?["versionPolicy"], "warn");
    Ok(())
}

#[test]
fn command_status_selects_desktop_ledger_without_exposing_transcripts() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    fs::write(
        root.join("config.json"),
        r#"{"version":1,"mode":"desktop"}"#,
    )?;
    fs::write(
        root.join("desktop-state.json"),
        r#"{"version":2,"conversations":{"example":{"id":"example","title":"Placeholder"}},"records":[],"pending":{"phase":"prepared","record":{"nativeId":"native-placeholder","side":"codex"}},"audit":[]}"#,
    )?;
    let state = value(cli(root, &["status"])?)?;
    assert_eq!(state["mode"], "desktop");
    assert_eq!(state["conversations"][0]["id"], "example");
    assert_eq!(
        state["pending"],
        json!({"phase":"prepared","nativeId":"native-placeholder","side":"codex"})
    );
    assert!(!state.to_string().contains("messages"));
    Ok(())
}

#[test]
fn help_and_version_do_not_create_state_or_run_native_providers() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("absent");
    let result = cli(&root, &["--help"])?;
    assert!(result.status.success());
    assert!(!root.exists());
    let version = Command::new(env!("CARGO_BIN_EXE_claudex"))
        .arg("--version")
        .output()?;
    assert!(version.status.success());
    assert_eq!(String::from_utf8(version.stdout)?.trim(), "claudex 2.0.11");
    for arguments in [
        &["app", "--help"][..],
        &["app", "build", "--help"][..],
        &["collaboration", "help"][..],
        &["watch", "--help"][..],
        &["hooks", "--help"][..],
    ] {
        let result = cli(&root, arguments)?;
        assert!(
            result.status.success(),
            "{arguments:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!result.stdout.is_empty());
        assert!(!root.exists(), "{arguments:?} created state during help");
    }
    assert!(!root.exists());
    Ok(())
}

#[test]
fn unknown_commands_fail_without_creating_state() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("absent");
    let result = cli(&root, &["stauts"])?;
    assert!(!result.status.success());
    assert!(String::from_utf8(result.stderr)?.contains("Unknown command: stauts"));
    assert!(!root.exists());
    Ok(())
}
