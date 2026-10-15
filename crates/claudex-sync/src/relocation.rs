//! Read-only native project-move proofs. A registry mapping never grants a
//! writer lease; the coordinator separately proves the unchanged counterpart.
use crate::{
    bridge::Side,
    codecs,
    desktop::{Reading, Record, Relocation},
    desktop_mapping, owned_history,
};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

fn lexical(path: &str) -> bool {
    Path::new(path).is_absolute()
        && !Path::new(path)
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        && Path::new(path)
            .components()
            .collect::<std::path::PathBuf>()
            .as_os_str()
            == path
}
fn directory(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == storage::uid()
            && fs::canonicalize(path)? == path,
        "Claude relocation needs canonical owned project directories."
    );
    Ok(())
}
fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
    }
}
fn beneath(path: &str, root: &str) -> bool {
    Path::new(path).starts_with(root)
}
pub fn claude(home: &Path, registry: &Path, record: &Record) -> Result<Option<Relocation>> {
    ensure!(
        record.side == Side::Claude
            && !record.managed
            && record.kind == "original"
            && record.verified
            && record.extra.get("importPacket") != Some(&json!(true)),
        "Claude relocation requires a verified native original without imported bootstrap."
    );
    let saved = record.extra.get("relocation");
    if let Some(saved) = saved {
        ensure!(
            saved["version"] == 1
                && saved["originPath"]
                    .as_str()
                    .is_some_and(|p| Path::new(p).is_absolute())
                && saved["originCwd"].as_str().is_some_and(lexical)
                && saved["historicalCwds"].as_array().is_some_and(
                    |a| a.len() <= 16 && a.iter().all(|v| v.as_str().is_some_and(lexical))
                ),
            "Invalid saved Claude project transition."
        );
    }
    let origin_cwd = saved
        .and_then(|s| s["originCwd"].as_str())
        .unwrap_or(&record.cwd);
    let origin_path = saved
        .and_then(|s| s["originPath"].as_str())
        .map(Path::new)
        .unwrap_or(&record.path);
    ensure!(
        lexical(origin_cwd)
            && home.is_absolute()
            && origin_path == codecs::claude_path(home, origin_cwd, &record.native_id)?,
        "Invalid saved original project identity."
    );
    let mut historical = saved
        .and_then(|s| s["historicalCwds"].as_array())
        .cloned()
        .unwrap_or_default();
    if !historical.contains(&json!(record.cwd)) {
        historical.push(json!(record.cwd));
    }
    ensure!(
        historical.len() <= 16,
        "Claude project history exceeds its verified root limit."
    );
    let lookup = || -> Result<Option<Value>> {
        Ok(
            desktop_mapping::mappings(registry, &[record.native_id.clone()])?
                .remove(&record.native_id.to_lowercase()),
        )
    };
    let Some(mapping) = lookup()? else {
        return Ok(None);
    };
    let cwd = mapping["cwd"].as_str().unwrap();
    if cwd == origin_cwd {
        return Ok(None);
    }
    let path = codecs::claude_path(home, cwd, &record.native_id)?;
    ensure!(
        path != origin_path && absent(origin_path)?,
        "Saved transcript still exists or project paths collide; relocation is ambiguous."
    );
    if path != record.path {
        ensure!(
            absent(&record.path)?,
            "Current saved transcript still exists at another location."
        );
    }
    for p in [
        home.to_owned(),
        home.join("projects"),
        path.parent().unwrap().to_owned(),
        Path::new(cwd).to_owned(),
    ] {
        directory(&p)?;
    }
    let raw = storage::snapshot_with_limit(&path, 512 * 1024 * 1024)?;
    ensure!(
        raw.file_identity.uid == storage::uid().to_string()
            && raw.file_identity.nlink == "1"
            && fs::canonicalize(&path)? == path
            && raw.text.ends_with('\n'),
        "Relocated transcript must be a complete bounded canonical owned single-link file."
    );
    let mut roots = historical
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    roots.extend([origin_cwd, cwd]);
    let mut entered = false;
    let mut latest = None;
    for row in &raw.rows {
        ensure!(
            row["sessionId"].is_null() || row["sessionId"] == record.native_id,
            "Relocated transcript native identity changed."
        );
        if let Some(row_cwd) = row["cwd"].as_str() {
            ensure!(
                lexical(row_cwd) && roots.iter().any(|root| beneath(row_cwd, root)),
                "Relocated transcript escaped its verified projects."
            );
        } else {
            ensure!(row["cwd"].is_null(), "Invalid relocated working directory.");
        }
        if row["isSidechain"] != true && matches!(row["type"].as_str(), Some("user" | "assistant"))
        {
            let row_cwd = row["cwd"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Authored relocated row lacks cwd."))?;
            ensure!(
                lexical(row_cwd)
                    && row["sessionId"] == record.native_id
                    && (!entered || beneath(row_cwd, cwd)),
                "Authored relocated history returned to its previous project."
            );
            entered |= row_cwd == cwd;
            latest = Some(row_cwd);
        }
    }
    ensure!(
        entered && latest == Some(cwd),
        "Latest authored project does not match its native registry."
    );
    ensure!(
        lookup()? == Some(mapping.clone())
            && FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == raw.file_identity
            && absent(origin_path)?,
        "Source history changed between complete relocation reads."
    );
    let mut decoded =
        owned_history::completed_claude(&raw.text, home, "", &record.native_id, None)?;
    ensure!(
        record.checkpoint.contains(&decoded.common)?,
        "Relocated history lost its exact synchronized prefix."
    );
    decoded.common.meta.insert("cwd".into(), json!(cwd));
    let mut moved = record.clone();
    moved.cwd = cwd.into();
    moved.path = path.clone();
    moved.extra.insert("relocation".into(),json!({"version":1,"originPath":origin_path,"originCwd":origin_cwd,"historicalCwds":historical}));
    Ok(Some(Relocation {
        record: moved,
        reading: Reading {
            common: decoded.common,
            native_id: record.native_id.clone(),
            path,
            bytes: raw.bytes,
            incomplete_tail: decoded.incomplete_tail,
            extra: Default::default(),
        },
        proof: json!({"hash":raw.hash,"identity":raw.file_identity,"mapping":mapping}),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        desktop::Checkpoint,
        history::{Common, Message},
    };
    use uuid::Uuid;
    struct Fixture {
        _temp: tempfile::TempDir,
        home: std::path::PathBuf,
        registry: std::path::PathBuf,
        record: Record,
        target: std::path::PathBuf,
        rows: Vec<Value>,
        cwd: String,
    }
    fn fixture() -> Result<Fixture> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        let home = storage::private_directory(root.join("claude"))?;
        let registry = storage::private_directory(root.join("registry"))?;
        let old = storage::private_directory(root.join("before"))?;
        let new = storage::private_directory(root.join("after"))?;
        let id = Uuid::new_v4().to_string();
        let common = Common {
            meta: serde_json::Map::from_iter([
                ("cwd".into(), json!(old)),
                ("timestamp".into(), json!("2026-10-15T00:00:00.000Z")),
            ]),
            messages: vec![
                Message::text("user", "request"),
                Message::text("assistant", "answer"),
            ],
            extra: Default::default(),
        };
        let mut rows = codecs::parse_rows(&codecs::encode_claude(&common, &id, None, None, None)?)?;
        let path = codecs::claude_path(&home, &old.to_string_lossy(), &id)?;
        let target = codecs::claude_path(&home, &new.to_string_lossy(), &id)?;
        storage::private_directory(path.parent().unwrap())?;
        storage::private_directory(target.parent().unwrap())?;
        let mut record = Record::source(Side::Claude, &path, &id);
        record.cwd = old.to_string_lossy().into();
        record.verified = true;
        record.checkpoint = Checkpoint::of(
            &owned_history::completed_claude(
                &codecs::serialize_rows(&rows)?,
                &home,
                "",
                &id,
                None,
            )?
            .common,
        )?;
        let mut continuation = common.clone();
        continuation.meta.insert("cwd".into(), json!(new));
        continuation.messages = vec![
            Message::text("user", "new request"),
            Message::text("assistant", "new answer"),
        ];
        let mut added = codecs::parse_rows(&codecs::encode_claude(
            &continuation,
            &id,
            None,
            None,
            None,
        )?)?;
        added[0]["parentUuid"] = rows.last().unwrap()["uuid"].clone();
        rows.extend(added);
        storage::publish_exclusive(&target, codecs::serialize_rows(&rows)?)?;
        let ui = Uuid::new_v4().to_string();
        storage::write_json(
            registry.join(format!("local_{ui}.json")),
            &json!({"sessionId":format!("local_{ui}"),"cliSessionId":id,"cwd":new,"title":"Moved","isArchived":false,"lastActivityAt":1}),
        )?;
        Ok(Fixture {
            _temp: temp,
            home,
            registry,
            record,
            target,
            rows,
            cwd: new.to_string_lossy().into(),
        })
    }
    #[test]
    fn exact_registry_move_retains_checkpoint_and_native_bytes() -> Result<()> {
        let f = fixture()?;
        let before = storage::snapshot(&f.target)?;
        let moved = claude(&f.home, &f.registry, &f.record)?.unwrap();
        assert_eq!(moved.record.cwd, f.cwd);
        assert_eq!(moved.reading.common.messages.len(), 4);
        assert!(f.record.checkpoint.contains(&moved.reading.common)?);
        assert_eq!(
            moved.record.extra["relocation"]["originPath"],
            json!(f.record.path)
        );
        assert_eq!(
            storage::snapshot(&f.target)?.file_identity,
            before.file_identity
        );
        assert_eq!(storage::snapshot(&f.target)?.text, before.text);
        let repeat = claude(&f.home, &f.registry, &moved.record)?.unwrap();
        assert_eq!(repeat.proof, moved.proof);
        Ok(())
    }
    #[test]
    fn relocation_refuses_ambiguous_or_changed_native_proofs() -> Result<()> {
        for failure in ["existing", "prefix", "identity", "cwd", "bootstrap"] {
            let mut f = fixture()?;
            match failure {
                "existing" => {
                    storage::publish_exclusive(&f.record.path, codecs::serialize_rows(&f.rows)?)?;
                }
                "prefix" => {
                    f.rows[0]["message"]["content"][0]["text"] = json!("changed");
                }
                "identity" => {
                    f.rows[1]["sessionId"] = json!(Uuid::new_v4().to_string());
                }
                "cwd" => {
                    f.rows.last_mut().unwrap()["cwd"] = json!(f.record.cwd);
                }
                "bootstrap" => {
                    f.record.extra.insert("importPacket".into(), json!(true));
                }
                _ => unreachable!(),
            };
            if matches!(failure, "prefix" | "identity" | "cwd") {
                fs::write(&f.target, codecs::serialize_rows(&f.rows)?)?;
            }
            assert!(
                claude(&f.home, &f.registry, &f.record).is_err(),
                "{failure}"
            );
        }
        Ok(())
    }
}
