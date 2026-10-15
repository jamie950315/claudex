use anyhow::Result;
use claudex_core::storage::*;
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};

#[test]
fn atomic_and_exclusive_publication_preserve_originals_and_bound_staging() -> Result<()> {
    let root = tempfile::tempdir()?;
    let state = root.path().join("state.json");
    fs::write(root.path().join("state.json.next"), "interrupted")?;
    for n in 0..5 {
        write_json(&state, &json!({"n":n}))?;
    }
    assert_eq!(read_json(&state)?, json!({"n":4}));
    assert_eq!(fs::read_dir(root.path())?.count(), 1);
    let original = root.path().join("original.jsonl");
    publish_exclusive(&original, b"{\"original\":true}\n")?;
    assert!(publish_exclusive(&original, b"replacement").is_err());
    assert_eq!(fs::read(&original)?, b"{\"original\":true}\n");
    assert!(!root.path().join("original.jsonl.claudex-next").exists());
    Ok(())
}

#[test]
fn every_staging_path_rejects_hardlinks_symlinks_and_fifos() -> Result<()> {
    for kind in ["state", "diagnostic", "native"] {
        for alias in ["hardlink", "symlink", "fifo"] {
            let root = tempfile::tempdir()?;
            let original = root.path().join("original");
            fs::write(&original, b"preserve exact original")?;
            let target = root.path().join("candidate");
            let stage = root.path().join(if kind == "native" {
                "candidate.claudex-next"
            } else {
                "candidate.next"
            });
            match alias {
                "hardlink" => fs::hard_link(&original, &stage)?,
                "symlink" => symlink(&original, &stage)?,
                "fifo" => assert!(
                    Command::new("mkfifo")
                        .args(["-m", "600"])
                        .arg(&stage)
                        .status()?
                        .success()
                ),
                _ => unreachable!(),
            }
            let result = match kind {
                "state" => write_json(&target, &json!({"replacement":true})),
                "diagnostic" => write_diagnostic_json(&target, &json!({"replacement":true})),
                _ => publish_exclusive(&target, b"replacement"),
            };
            assert!(result.is_err(), "{kind} accepted {alias}");
            assert_eq!(fs::read(&original)?, b"preserve exact original");
            assert!(!target.exists());
        }
    }
    Ok(())
}

#[test]
fn snapshot_preserves_unknown_rows_exact_identity_and_compressed_logical_bytes() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("rollout-test.jsonl");
    let bytes = b"{\"type\":\"future-native-record\",\"optional\":{\"x\":42}}\n";
    fs::write(&path, bytes)?;
    let data = snapshot(&path)?;
    assert_eq!(data.rows[0]["type"], "future-native-record");
    assert_eq!(data.hash, hash_bytes(bytes));
    assert_eq!(
        data.file_identity,
        FileIdentity::from_metadata(&fs::symlink_metadata(&path)?)
    );
    let compressed = root.path().join("rollout-test.jsonl.zst");
    fs::write(&compressed, zstd::encode_all(bytes.as_slice(), 1)?)?;
    let packed = snapshot(&compressed)?;
    assert_eq!(packed.text, data.text);
    assert_eq!(packed.hash, data.hash);
    assert_eq!(packed.bytes, bytes.len() as u64);
    assert!(snapshot_with_limit(&compressed, bytes.len() - 1).is_err());
    fs::write(&path, b"{\"partial\":true}")?;
    assert!(snapshot(&path).is_err());
    fs::write(&path, b"not-json\n")?;
    assert!(snapshot(&path).is_err());
    let alias = root.path().join("alias.jsonl");
    symlink(&compressed, &alias)?;
    assert!(snapshot(&alias).is_err());
    assert!(private_directory(&alias).is_err());
    Ok(())
}

#[test]
fn missing_json_is_distinct_from_malformed_or_aliased_state() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("state.json");
    assert_eq!(read_json_or(&path, json!(null))?, json!(null));
    fs::write(&path, "{")?;
    assert!(read_json_or(&path, json!(null)).is_err());
    let alias = root.path().join("alias.json");
    symlink(&path, &alias)?;
    assert!(read_json_or(&alias, json!(null)).is_err());
    Ok(())
}

#[test]
fn live_and_replaced_locks_are_preserved_and_dead_private_locks_recover() -> Result<()> {
    let root = tempfile::tempdir()?;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))?;
    let path = root.path().join("watch.lock");
    let lock = FileLock::acquire(&path, false)?;
    assert!(FileLock::acquire(&path, true).is_err());
    fs::rename(&path, root.path().join("previous.lock"))?;
    let replacement = b"{\"doNotRemove\":true}";
    fs::write(&path, replacement)?;
    assert!(lock.release().is_err());
    assert_eq!(fs::read(&path)?, replacement);
    fs::remove_file(&path)?;
    let mut child = Command::new("/bin/sh").args(["-c", "exit 0"]).spawn()?;
    let pid = child.id();
    child.wait()?;
    write_json(
        &path,
        &json!({"pid":pid,"started":chrono::Utc::now().to_rfc3339()}),
    )?;
    let lock = FileLock::acquire(&path, true)?;
    lock.release()?;
    assert!(!path.exists());
    write_json(&path, &json!({"pid":0}))?;
    assert!(FileLock::acquire(&path, true).is_err());
    assert!(path.exists());
    Ok(())
}

#[test]
fn process_birth_prevents_reused_pid_from_holding_old_locks() -> Result<()> {
    let born = process_started_at(std::process::id()).expect("ps must report this test process");
    assert!(lock_holder_alive(std::process::id(), now_ms())?);
    assert!(!lock_holder_alive(std::process::id(), born - 86_400_000)?);
    Ok(())
}
