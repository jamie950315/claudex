use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_DEPENDENCY_ANCHORS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub previous_per_side: usize,
    pub max_age_ms: u64,
    pub max_backup_bytes: u64,
    pub max_audit_entries: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            previous_per_side: 1,
            max_age_ms: 7 * 86_400_000,
            max_backup_bytes: 512 * 1024 * 1024,
            max_audit_entries: 50,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedRecord {
    pub id: String,
    pub conversation_id: String,
    pub side: String,
    pub status: String,
    pub managed: bool,
    pub verified: bool,
    pub bytes: u64,
    pub created_at: u64,
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub frozen: bool,
    #[serde(default)]
    pub dependent_ids: Vec<String>,
    #[serde(default)]
    pub dependency_ids: Vec<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPlan {
    pub keep: Vec<String>,
    pub remove: Vec<String>,
    pub blocked: Vec<Block>,
    pub backup_bytes: u64,
}
#[derive(Debug, Serialize)]
pub struct Block {
    pub id: String,
    pub reason: String,
}

pub fn plan(records: &[RetainedRecord], now: u64, policy: &Policy) -> Result<RetentionPlan> {
    let mut ids = BTreeSet::new();
    let mut bytes = 0_u64;
    for r in records {
        ensure!(
            !r.id.trim().is_empty() && ids.insert(r.id.clone()),
            "Missing or duplicate retention record identity."
        );
        ensure!(
            !r.conversation_id.trim().is_empty() && matches!(r.side.as_str(), "codex" | "claude"),
            "Invalid retention conversation or side."
        );
        ensure!(
            matches!(
                r.status.as_str(),
                "current" | "previous" | "dependency-anchor"
            ),
            "Invalid retention record status."
        );
        ensure!(
            r.created_at <= 8_640_000_000_000_000,
            "Invalid retention timestamp."
        );
        for list in [&r.dependent_ids, &r.dependency_ids] {
            ensure!(
                list.iter().all(|v| !v.trim().is_empty())
                    && list.iter().collect::<BTreeSet<_>>().len() == list.len(),
                "Invalid dependency identities."
            );
        }
        if r.status == "dependency-anchor" {
            ensure!(
                r.side == "codex"
                    && r.kind.as_deref() == Some("snapshot")
                    && r.managed
                    && r.verified
                    && !r.dependency_ids.is_empty(),
                "Dependency anchors require verified managed Codex snapshots and saved dependencies."
            );
        }
        if r.status != "current" {
            bytes = bytes
                .checked_add(r.bytes)
                .ok_or_else(|| anyhow::anyhow!("Total backup bytes overflow."))?;
        }
    }
    let mut previous: Vec<_> = records.iter().filter(|r| r.status == "previous").collect();
    previous.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    let mut groups: BTreeMap<(&str, &str), Vec<&RetainedRecord>> = BTreeMap::new();
    let mut candidates = BTreeSet::new();
    for r in &previous {
        groups
            .entry((&r.conversation_id, &r.side))
            .or_default()
            .push(r);
        if now.saturating_sub(r.created_at) >= policy.max_age_ms {
            candidates.insert(r.id.clone());
        }
    }
    for group in groups.values() {
        for r in group
            .iter()
            .take(group.len().saturating_sub(policy.previous_per_side))
        {
            candidates.insert(r.id.clone());
        }
    }
    let anchors: Vec<_> = records
        .iter()
        .filter(|r| r.status == "dependency-anchor")
        .collect();
    let mut blocked = BTreeMap::new();
    let mut remove = BTreeSet::new();
    if anchors.len() > MAX_DEPENDENCY_ANCHORS {
        for r in &anchors {
            blocked.insert(r.id.clone(), "dependency-anchor-limit".to_string());
        }
    }
    let evict = |r: &RetainedRecord,
                 remove: &mut BTreeSet<String>,
                 blocked: &mut BTreeMap<String, String>,
                 bytes: &mut u64| {
        if r.frozen {
            return;
        }
        let reason = if !r.managed {
            Some("unmanaged")
        } else if !r.verified {
            Some("unverified")
        } else if r.busy {
            Some("busy")
        } else if !r.dependent_ids.is_empty() {
            Some("dependent-records")
        } else {
            None
        };
        if let Some(reason) = reason {
            blocked.insert(r.id.clone(), reason.into());
        } else if remove.insert(r.id.clone()) {
            *bytes -= r.bytes;
        }
    };
    for r in &previous {
        if candidates.contains(&r.id) {
            evict(r, &mut remove, &mut blocked, &mut bytes);
        }
    }
    for r in &previous {
        if bytes <= policy.max_backup_bytes {
            break;
        }
        if !remove.contains(&r.id) {
            evict(r, &mut remove, &mut blocked, &mut bytes);
        }
    }
    if bytes > policy.max_backup_bytes {
        for r in &anchors {
            blocked
                .entry(r.id.clone())
                .or_insert("dependency-anchor-quota".into());
        }
        for r in &previous {
            if r.frozen {
                blocked.entry(r.id.clone()).or_insert("frozen-quota".into());
            }
        }
    }
    Ok(RetentionPlan {
        keep: records
            .iter()
            .filter(|r| !remove.contains(&r.id))
            .map(|r| r.id.clone())
            .collect(),
        remove: previous
            .iter()
            .filter(|r| remove.contains(&r.id))
            .map(|r| r.id.clone())
            .collect(),
        blocked: blocked
            .into_iter()
            .map(|(id, reason)| Block { id, reason })
            .collect(),
        backup_bytes: bytes,
    })
}
