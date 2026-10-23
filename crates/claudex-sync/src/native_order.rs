//! Portable display ordering bound to exact native arrival proofs. Native turn
//! items remain intact; saved checkpoints alone select historical placement.
use crate::{codex_provenance::ImagePosition, native_history::Snapshot, packet};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug)]
pub struct Entry {
    pub turn_id: String,
    pub item: Option<Value>,
    pub status: Option<Value>,
    pub realtime: Option<Value>,
}
fn key(turn: &str, item: &str) -> (String, String) {
    (turn.into(), item.into())
}
pub fn entries(snapshot: &Snapshot) -> Result<Vec<Entry>> {
    let mut turns = BTreeMap::new();
    let mut items = BTreeMap::new();
    for (index, t) in snapshot.turns.iter().enumerate() {
        let id = t["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Native turn identity missing."))?;
        ensure!(
            turns.insert(id, (index, t)).is_none(),
            "Ambiguous native turn identity."
        );
        for item in t["items"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Native turn items missing."))?
        {
            let item_id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Native item identity missing."))?;
            ensure!(
                items.insert(key(id, item_id), item).is_none()
                    || snapshot.late_item_evidence.is_none(),
                "Ambiguous native item identity."
            );
        }
    }
    let mut moved = BTreeSet::new();
    let mut after = BTreeMap::<String, Vec<Entry>>::new();
    let mut placed = BTreeSet::new();
    if let Some(proof) = &snapshot.late_item_evidence {
        let placements = proof["placements"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid late item placements."))?;
        let withheld = proof
            .get("withheld")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut keys = vec!["placements", "sourceIdentity", "evidenceDigest"];
        if proof.get("withheld").is_some() {
            keys.push("withheld");
            ensure!(!withheld.is_empty(), "Empty late withheld proof.");
        }
        ensure!(
            packet::exact_keys(proof, &keys)
                && proof["sourceIdentity"].is_object()
                && packet::hex_digest(&proof["evidenceDigest"])
                && (!placements.is_empty() || !withheld.is_empty()),
            "Invalid late native provenance."
        );
        let count = placements.len() + withheld.len();
        ensure!(count <= items.len(), "Too many native late placements.");
        let native = if snapshot.native_item_order.as_deref() == Some("legacy") {
            count
        } else {
            snapshot.late_item_native
        };
        ensure!(
            native <= count
                && snapshot
                    .native_item_order
                    .as_deref()
                    .is_none_or(|s| matches!(s, "legacy" | "arrival")),
            "Invalid native late item representation."
        );
        let mut previous = 0;
        for (position, p) in placements.iter().chain(&withheld).enumerate() {
            ensure!(
                packet::exact_keys(p, &["turnId", "itemId", "afterTurnId", "itemDigest"]),
                "Invalid late item placement shape."
            );
            let turn = p["turnId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Late parent missing."))?;
            let item_id = p["itemId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Late item missing."))?;
            let parent = turns
                .get(turn)
                .ok_or_else(|| anyhow::anyhow!("Late native parent absent."))?;
            let boundary = p["afterTurnId"].as_str().and_then(|s| turns.get(s));
            let exported = position < placements.len();
            let identity = key(turn, item_id);
            let item = items
                .get(&identity)
                .ok_or_else(|| anyhow::anyhow!("Late item not in API."))?;
            ensure!(
                exported == boundary.is_some()
                    && boundary.is_none_or(|(index, t)| *index >= parent.0
                        && *index >= previous
                        && matches!(
                            t["status"].as_str(),
                            Some("completed" | "interrupted" | "failed")
                        ))
                    && (item["type"] == "subAgentActivity"
                        || item["type"] == "commandExecution"
                            && matches!(item["status"].as_str(), Some("completed" | "failed")))
                    && placed.insert(identity.clone())
                    // Placements locate their item by identity; itemDigest is
                    // kept as evidence, not compared with the current payload.
                    && packet::hex_digest(&p["itemDigest"]),
                "Late native identity or closed boundary contradicts API."
            );
            if let Some((index, _)) = boundary {
                previous = *index;
            }
            if position < native {
                continue;
            }
            moved.insert(identity);
            if exported {
                after
                    .entry(p["afterTurnId"].as_str().unwrap().into())
                    .or_default()
                    .push(Entry {
                        turn_id: turn.into(),
                        item: Some((*item).clone()),
                        status: None,
                        realtime: None,
                    });
            }
        }
    }
    let mut entries = vec![];
    for t in &snapshot.turns {
        let turn = t["id"].as_str().unwrap();
        for item in t["items"].as_array().unwrap() {
            if !moved.contains(&key(turn, item["id"].as_str().unwrap())) {
                entries.push(Entry {
                    turn_id: turn.into(),
                    item: Some(item.clone()),
                    status: None,
                    realtime: None,
                });
            }
        }
        if matches!(t["status"].as_str(), Some("failed" | "interrupted")) {
            let mut status = json!({"turnId":turn,"status":t["status"]});
            if let Some(error) = t.get("error") {
                status["error"] = error.clone();
            }
            entries.push(Entry {
                turn_id: turn.into(),
                item: None,
                status: Some(status),
                realtime: None,
            });
        }
        entries.extend(after.remove(turn).unwrap_or_default());
    }
    if let Some(proof) = &snapshot.realtime {
        crate::native_realtime::validate(proof)?;
        let mut additions = BTreeMap::<usize, Vec<Entry>>::new();
        let mut previous = 0;
        for record in proof["records"].as_array().unwrap() {
            let (position, turn_id) = if let Some(turn) = record["beforeTurnId"].as_str() {
                let item = record["beforeItemId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Realtime item anchor missing."))?;
                let position = entries
                    .iter()
                    .position(|e| {
                        e.turn_id == turn && e.item.as_ref().is_some_and(|i| i["id"] == item)
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!("Realtime anchor is absent from exported API history.")
                    })?;
                (position, turn)
            } else {
                let turn = record["afterTurnId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Realtime turn anchor missing."))?;
                let position =
                    entries
                        .iter()
                        .rposition(|e| e.turn_id == turn)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "Realtime boundary is absent from exported API history."
                            )
                        })?
                        + 1;
                (position, turn)
            };
            ensure!(
                position >= previous && record["row"].is_object(),
                "Realtime record ordering contradicts API history."
            );
            previous = position;
            additions.entry(position).or_default().push(Entry {
                turn_id: turn_id.into(),
                item: None,
                status: None,
                realtime: Some(record["row"].clone()),
            });
        }
        let end = entries.len();
        let mut merged = vec![];
        for (position, entry) in entries.into_iter().enumerate() {
            merged.extend(additions.remove(&position).unwrap_or_default());
            merged.push(entry);
        }
        merged.extend(additions.remove(&end).unwrap_or_default());
        ensure!(additions.is_empty(), "Unplaced realtime historical event.");
        entries = merged;
    }
    Ok(entries)
}
pub fn representations(snapshot: &Snapshot) -> Result<Vec<Snapshot>> {
    let Some(proof) = &snapshot.late_item_evidence else {
        return Ok(vec![snapshot.clone()]);
    };
    let count = proof["placements"].as_array().map(Vec::len).unwrap_or(0)
        + proof["withheld"].as_array().map(Vec::len).unwrap_or(0);
    ensure!(
        count <= 256,
        "Too many late items to authenticate against checkpoint."
    );
    let mut out = vec![];
    for native in std::iter::once(count).chain(0..count) {
        let mut s = snapshot.clone();
        s.native_item_order = Some(if native == count { "legacy" } else { "arrival" }.into());
        s.late_item_native = if native == count { 0 } else { native };
        out.push(s);
    }
    Ok(out)
}
pub fn image_positions(snapshot: &Snapshot) -> Result<Vec<ImagePosition>> {
    Ok(entries(snapshot)?
        .iter()
        .enumerate()
        .filter_map(|(message_index, e)| {
            let item = e.item.as_ref()?;
            if item["type"] != "userMessage"
                || !item["content"]
                    .as_array()?
                    .iter()
                    .any(|b| b["type"] == "localImage" || b.get("nativeLocalImage").is_some())
            {
                return None;
            }
            Some(ImagePosition {
                turn_id: e.turn_id.clone(),
                item_id: item["id"].as_str()?.into(),
                message_index,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_arrival_order_is_exact_and_legacy_checkpoint_representation_is_available() -> Result<()>
    {
        let late = json!({"type":"commandExecution","id":"command","status":"completed","command":"echo fixture","aggregatedOutput":"fixture"});
        let digest = crate::history::digest_bytes(
            claudex_core::json::canonical_stringify(&late)?.as_bytes(),
        );
        let mut snapshot: Snapshot = serde_json::from_value(
            json!({"turns":[{"id":"first","status":"completed","items":[{"type":"userMessage","id":"request","content":[]},late]},{"id":"second","status":"completed","items":[{"type":"agentMessage","id":"reply","text":"Answer"}]}],"digest":"fixture","itemCount":4,"bytes":100,"pages":1,"completedPrefix":true,"incompleteTail":false,"incompleteTailCount":0,"closedTail":false,"lateItemEvidence":{"placements":[{"turnId":"first","itemId":"command","afterTurnId":"second","itemDigest":digest}],"sourceIdentity":{},"evidenceDigest":"a".repeat(64)}}),
        )?;
        assert_eq!(
            entries(&snapshot)?
                .iter()
                .filter_map(|e| e.item.as_ref())
                .map(|i| i["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["request", "reply", "command"]
        );
        let representations = representations(&snapshot)?;
        assert_eq!(representations.len(), 2);
        assert_eq!(
            entries(&representations[0])?[1].item.as_ref().unwrap()["id"],
            "command"
        );
        assert_eq!(
            entries(&representations[1])?[1].item.as_ref().unwrap()["id"],
            "reply"
        );
        // A placement locates its item by identity, whatever the payload now holds.
        snapshot.turns[0]["items"][1]["aggregatedOutput"] = json!("reformatted");
        assert_eq!(entries(&snapshot)?.len(), 3);
        snapshot.late_item_evidence.as_mut().unwrap()["placements"][0]["itemDigest"] =
            json!("not a digest");
        assert!(entries(&snapshot).is_err());
        snapshot.late_item_evidence.as_mut().unwrap()["placements"][0]["itemDigest"] =
            json!(digest);
        snapshot.late_item_evidence.as_mut().unwrap()["placements"][0]["itemId"] = json!("other");
        assert!(entries(&snapshot).is_err());
        Ok(())
    }
}
