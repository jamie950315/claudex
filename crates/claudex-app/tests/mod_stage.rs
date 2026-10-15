//! Explicit source-migration acceptance, without native installation or inference.
use anyhow::{Context, Result, ensure};
use claudex_app::{
    mod_install,
    platform::{self, CommandSpec, Runner, SystemRunner},
};
use claudex_work::{Broker, Config, NativeCliRunner, transport};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
fn candidate() -> Result<(tempfile::TempDir, PathBuf, PathBuf)> {
    let temp = tempfile::tempdir_in("/tmp")?;
    let root = fs::canonicalize(temp.path())?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    let executable = PathBuf::from(
        std::env::var_os("CLAUDEX_TEST_EXECUTABLE")
            .context("Set CLAUDEX_TEST_EXECUTABLE to the built Rust CLI.")?,
    );
    let copy = root.join("source-helper");
    fs::copy(executable, &copy)?;
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o700))?;
    let stage = root.join("stage");
    mod_install::stage(&source, &stage, &root, &copy, true, true)?;
    fs::remove_file(copy)?;
    Ok((temp, root, stage))
}
#[tokio::test]
#[ignore = "requires the built Rust CLI; uses only isolated broker state"]
async fn staged_helper_reads_real_broker_after_source_copy_is_removed() -> Result<()> {
    let (_temp, root, stage) = candidate()?;
    let report: Value = serde_json::from_slice(&fs::read(stage.join("stage-report.json"))?)?;
    mod_install::file_tree(&stage.join("plugins/claudex"), &report["hashes"], false)?;
    assert!(!stage.join("plugins/claudex/runtime/src").exists());
    let broker = Broker::open(
        root.join("collaboration"),
        Config::default(),
        Arc::new(NativeCliRunner::default()),
    )
    .await?;
    let server = transport::serve(broker.clone()).await?;
    let binary = stage.join("plugins/claudex/runtime/bin/claudex");
    let mut command = CommandSpec::new(
        binary,
        [
            "mod-bridge".into(),
            "--root".into(),
            root.to_string_lossy().into_owned(),
        ],
    );
    command.input = serde_json::to_vec(
        &json!({"version":1,"op":"read","method":"list","context":{"sessionId":"00000000-0000-4000-8000-000000000001","cwd":"/synthetic-project"},"params":{}}),
    )?;
    command.timeout = Duration::from_secs(10);
    let result = SystemRunner.run(command).await?;
    let output: Value = serde_json::from_str(&result.stdout)?;
    ensure!(
        result.code == 0
            && output["ok"] == true
            && output["result"]["tasks"]
                .as_array()
                .is_some_and(Vec::is_empty),
        "Staged helper did not reach the real Unix RPC broker: {output}"
    );
    server.close().await?;
    broker.close().await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires explicitly selected official native Mod manager and built Rust CLI"]
async fn staged_rust_companion_passes_official_strict_validation_and_complete_kit() -> Result<()> {
    let (_temp, root, stage) = candidate()?;
    let manager = PathBuf::from(
        std::env::var_os("CLAUDEX_TEST_MOD_MANAGER")
            .context("Set CLAUDEX_TEST_MOD_MANAGER to the official native manager.")?,
    );
    let home = root.join("isolated-home");
    platform::create_private(&home)?;
    for args in [vec!["plugin", "validate"], vec!["plugin", "test"]] {
        let validation = args[1] == "validate";
        let mut words = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        words.push(stage.join("plugins/claudex").to_string_lossy().into());
        if validation {
            words.extend(["--strict".into(), "--json".into()]);
        }
        let mut command = CommandSpec::new(&manager, words);
        command.env = std::collections::BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into()),
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
        ]);
        command.timeout = Duration::from_secs(120);
        command.max_bytes = 2 * 1024 * 1024;
        let reply = SystemRunner.run(command).await?;
        ensure!(
            reply.code == 0,
            "Official native validation failed: {} {}",
            reply.stdout,
            reply.stderr
        );
        if validation {
            let v: Value = serde_json::from_str(&reply.stdout)?;
            ensure!(
                v["success"] == true && v["strict"] == true,
                "Strict native validation was not confirmed."
            );
        }
    }
    Ok(())
}
