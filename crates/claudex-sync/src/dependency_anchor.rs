//! Whole decompressed rollout proofs tolerate only observed header ordering and
//! provider-label rewrites. Every byte after the header remains authenticated.
use crate::{desktop::Record, history::digest_bytes, native, rollout_header};
use anyhow::{Result, ensure};
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::{fs, io::Read};

pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub fn raw(record: &Record, logical: &std::path::Path) -> Result<Value> {
    let path = native::physical_rollout(logical)?;
    ensure!(
        fs::canonicalize(&path)? == path,
        "Dependency anchor path is not canonical."
    );
    let stored = storage::read_stable_with_limit(&path, MAX_BYTES)?;
    ensure!(
        stored.identity.uid == storage::uid().to_string() && stored.identity.nlink == "1",
        "Dependency anchor is not an owned single-link file."
    );
    let bytes = if path.as_os_str().to_string_lossy().ends_with(".jsonl.zst") {
        let decoder = zstd::stream::read::Decoder::new(stored.bytes.as_slice())?;
        let mut bytes = vec![];
        decoder
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        bytes
    } else {
        stored.bytes
    };
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES && bytes.last() == Some(&b'\n'),
        "Dependency anchor has incomplete or oversized raw history."
    );
    let newline = bytes.iter().position(|b| *b == b'\n').unwrap();
    let header = std::str::from_utf8(&bytes[..newline])?;
    let row: Value = serde_json::from_str(header)?;
    ensure!(
        row["type"] == "session_meta"
            && row["payload"]["id"] == record.native_id
            && row["payload"]["cwd"] == record.cwd,
        "Dependency anchor raw identity or cwd changed."
    );
    ensure!(
        FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == stored.identity,
        "Dependency anchor changed during raw proof."
    );
    let mut proof = json!({"path":logical,"hash":digest_bytes(&bytes),"bytes":bytes.len()});
    if let Some(original) = rollout_header::original_projection(header)? {
        let mut alternative = original.into_bytes();
        alternative.extend_from_slice(&bytes[newline..]);
        proof["originalSerializationHash"] = json!(digest_bytes(&alternative));
    }
    if let Some(label_free) = rollout_header::label_free(header)? {
        let mut alternative = label_free.into_bytes();
        alternative.extend_from_slice(&bytes[newline..]);
        proof["labelFree"] = json!({"hash":digest_bytes(&alternative),"bytes":alternative.len()});
    }
    Ok(proof)
}
pub fn compare(record: &Record, proof: &Value, aggregate: u64) -> Result<Option<Value>> {
    let anchor = &record.extra["dependencyAnchor"];
    let saved = &anchor["raw"];
    let dependencies = anchor["dependencies"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing anchor dependency edges."))?;
    let ids = record.extra["dependencyIds"]
        .as_array()
        .filter(|a| a.len() == dependencies.len())
        .ok_or_else(|| anyhow::anyhow!("Malformed anchor dependency identities."))?;
    ensure!(
        anchor["version"] == 1
            && saved["path"] == json!(record.path)
            && crate::packet::hex_digest(&saved["hash"])
            && saved["bytes"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= MAX_BYTES as u64),
        "Malformed saved dependency anchor proof."
    );
    let mut previous = "";
    for (index, edge) in dependencies.iter().enumerate() {
        let id = edge["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing anchor edge identity."))?;
        ensure!(
            uuid::Uuid::parse_str(id).is_ok()
                && id != record.native_id
                && edge["parentId"] == record.native_id
                && matches!(edge["kind"].as_str(), Some("spawn" | "fork"))
                && (previous.is_empty() || previous < id)
                && ids[index] == id,
            "Malformed anchor edge parent, kind or order."
        );
        previous = id;
    }
    let label = saved.get("labelFree");
    if let Some(label) = label {
        ensure!(
            crate::packet::hex_digest(&label["hash"])
                && label["bytes"].as_u64().is_some_and(|n| n > 0),
            "Malformed saved label-free anchor proof."
        );
    }
    let exact = saved["bytes"] == proof["bytes"]
        && (saved["hash"] == proof["hash"] || saved["hash"] == proof["originalSerializationHash"]);
    let relabeled = !exact && label.is_some_and(|label| proof.get("labelFree") == Some(label));
    ensure!(
        saved["path"] == proof["path"] && (exact || relabeled),
        "Dependency anchor saved transcript bytes changed."
    );
    let difference = if relabeled {
        i128::from(proof["bytes"].as_u64().unwrap()) - i128::from(saved["bytes"].as_u64().unwrap())
    } else {
        0
    };
    ensure!(
        i128::from(aggregate) - i128::from(record.bytes) == difference,
        "Dependency anchor aggregate storage changed."
    );
    Ok(if exact && label.is_none() {
        proof.get("labelFree").cloned()
    } else {
        None
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Side;
    #[test]
    fn relabeling_preserves_body_and_aggregate_contracts_and_legacy_extends_only_exact_bytes()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = fs::canonicalize(temp.path())?.join("rollout.jsonl");
        let mut record = Record::source(Side::Codex, &path, &uuid::Uuid::new_v4().to_string());
        record.cwd = "/tmp".into();
        let header = json!({"timestamp":"t","type":"session_meta","payload":{"id":record.native_id,"cwd":"/tmp","model_provider":"old"},"ordinal":0});
        let text = format!(
            "{}\n{{\"body\":\"unchanged\"}}\n",
            claudex_core::json::stringify(&header)?
        );
        fs::write(&path, &text)?;
        let saved = raw(&record, &path)?;
        record.bytes = text.len() as u64;
        let child = uuid::Uuid::new_v4().to_string();
        record.extra.insert("dependencyIds".into(), json!([child]));
        record.extra.insert("dependencyAnchor".into(),json!({"version":1,"dependencies":[{"id":child,"parentId":record.native_id,"kind":"fork"}],"raw":saved}));
        assert!(compare(&record, &saved, record.bytes)?.is_none());
        fs::write(&path, text.replace("old", "different-provider"))?;
        let relabeled = raw(&record, &path)?;
        assert!(compare(&record, &relabeled, relabeled["bytes"].as_u64().unwrap())?.is_none());
        assert!(compare(&record, &relabeled, record.bytes).is_err());
        record.extra.get_mut("dependencyAnchor").unwrap()["raw"]
            .as_object_mut()
            .unwrap()
            .remove("labelFree");
        assert!(compare(&record, &relabeled, relabeled["bytes"].as_u64().unwrap()).is_err());
        fs::write(&path, &text)?;
        assert_eq!(
            compare(&record, &raw(&record, &path)?, record.bytes)?,
            saved.get("labelFree").cloned()
        );
        fs::write(&path, text.replace("unchanged", "different"))?;
        assert!(compare(&record, &raw(&record, &path)?, fs::metadata(&path)?.len()).is_err());
        Ok(())
    }
    #[test]
    fn native_sorted_projection_header_authenticates_original_whole_file_and_compression()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = fs::canonicalize(temp.path())?.join("rollout.jsonl");
        let mut record = Record::source(Side::Codex, &path, &uuid::Uuid::new_v4().to_string());
        record.cwd = "/tmp".into();
        let row = json!({"timestamp":"t","type":"session_meta","payload":{"cwd":"/tmp","id":record.native_id,"originator":"claudex","source":"appServer","history_mode":"paginated"},"ordinal":0});
        let original = format!("{}\n{{\"body\":1}}\n", claudex_core::json::stringify(&row)?);
        let sorted = format!(
            "{}\n{{\"body\":1}}\n",
            claudex_core::json::canonical_stringify(&row)?
        );
        fs::write(&path, &sorted)?;
        let proof = raw(&record, &path)?;
        assert_eq!(
            proof["originalSerializationHash"],
            digest_bytes(original.as_bytes())
        );
        let compressed = path.with_extension("jsonl.zst");
        fs::write(&compressed, zstd::stream::encode_all(sorted.as_bytes(), 1)?)?;
        fs::remove_file(&path)?;
        let compressed_proof = raw(&record, &path)?;
        assert_eq!(compressed_proof, proof);
        assert_eq!(compressed_proof["bytes"], sorted.len());
        Ok(())
    }
    #[test]
    fn saved_edge_parent_kind_order_and_ids_are_part_of_the_contract() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = fs::canonicalize(temp.path())?.join("rollout.jsonl");
        let mut record = Record::source(Side::Codex, &path, &uuid::Uuid::new_v4().to_string());
        record.cwd = "/tmp".into();
        fs::write(
            &path,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":record.native_id,"cwd":"/tmp"}})
            ),
        )?;
        let proof = raw(&record, &path)?;
        record.bytes = proof["bytes"].as_u64().unwrap();
        let child = uuid::Uuid::new_v4().to_string();
        record.extra.insert("dependencyIds".into(), json!([child]));
        record.extra.insert("dependencyAnchor".into(),json!({"version":1,"dependencies":[{"id":child,"parentId":record.native_id,"kind":"spawn"}],"raw":proof}));
        assert!(compare(&record, &proof, record.bytes).is_ok());
        record.extra.get_mut("dependencyAnchor").unwrap()["dependencies"][0]["parentId"] =
            json!(uuid::Uuid::new_v4());
        assert!(compare(&record, &proof, record.bytes).is_err());
        Ok(())
    }
}
