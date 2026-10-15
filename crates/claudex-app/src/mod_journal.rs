//! Bounded active journals; protected and uncertain records are never pruned.
use crate::{
    mod_protocol::{self, insist},
    mod_storage as storage,
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub const LIMIT: usize = 2048;
#[derive(Clone, Copy)]
pub enum Kind {
    Actions,
    SelfDispatch,
    WakeOutbox,
}
impl Kind {
    fn directory(self) -> &'static str {
        match self {
            Self::Actions => "mod-companion",
            Self::SelfDispatch => "mod-self-dispatch",
            Self::WakeOutbox => "mod-wake-receipts",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Actions => "actions",
            Self::SelfDispatch => "selfDispatch",
            Self::WakeOutbox => "wakeOutbox",
        }
    }
}
pub struct Journal {
    root: PathBuf,
    pub directory: PathBuf,
    kind: Kind,
}
impl Journal {
    pub fn new(root: &Path, kind: Kind) -> Self {
        Self {
            root: root.into(),
            directory: root.join(kind.directory()),
            kind,
        }
    }
    pub fn read(&self, name: &str, optional: bool) -> Result<Option<Value>> {
        read(&self.directory, name, optional)
    }
    pub fn transaction(&self) -> Result<storage::Lock> {
        storage::directory(&self.directory, true)?;
        storage::Lock::acquire(&self.directory.join(".journal.lock"), true)?
            .context("Receipt journal is busy.")
    }
    fn id(&self, name: &str) -> Option<String> {
        let suffix = match self.kind {
            Kind::WakeOutbox => {
                if name.ends_with(".done.json") {
                    ".done.json"
                } else {
                    ".pending.json"
                }
            }
            _ => ".json",
        };
        let id = name.strip_suffix(suffix)?;
        let id = uuid::Uuid::parse_str(id)
            .ok()
            .filter(|u| u.hyphenated().to_string() == id)?;
        Some(id.to_string())
    }
    fn names(&self) -> Result<Vec<String>> {
        let mut names = vec![];
        let mut count = 0;
        for e in fs::read_dir(&self.directory)? {
            count += 1;
            insist(
                count <= LIMIT * 4 + 32,
                "JOURNAL_CAPACITY_EXHAUSTED",
                "Receipt storage has too many active entries. Inspect its private journal.",
            )?;
            let name = e?
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Non-UTF-8 receipt journal entry."))?;
            if self.id(&name).is_some() {
                names.push(name);
            }
        }
        insist(
            names.len() <= LIMIT,
            "JOURNAL_CAPACITY_EXHAUSTED",
            "Receipt storage exceeds its active-record bound.",
        )?;
        names.sort();
        Ok(names)
    }
    fn settled(&self, name: &str, value: &Value, now: u64) -> Result<Option<u64>> {
        insist(
            value["version"] == 1,
            "INVALID_RECEIPT",
            "Malformed receipt requires inspection.",
        )?;
        match self.kind {
            Kind::Actions => {
                crate::mod_bridge::validate_receipt(value, name.trim_end_matches(".json"))?;
                let prepared = value["preparedAt"]
                    .as_u64()
                    .context("Invalid preparation time.")?;
                let expiry = value["expiresAt"].as_u64().context("Invalid expiry.")?;
                Ok(if value["state"] == "completed" {
                    Some(value["finishedAt"].as_u64().unwrap_or(prepared))
                } else if value["state"] == "prepared" && expiry <= now {
                    Some(expiry)
                } else {
                    None
                })
            }
            Kind::WakeOutbox => {
                let request = mod_protocol::request(&value["request"])?;
                insist(
                    request["op"] == "wake-receipt"
                        && name
                            == format!(
                                "{}.{}.json",
                                request["claimId"].as_str().unwrap(),
                                if name.ends_with(".done.json") {
                                    "done"
                                } else {
                                    "pending"
                                }
                            ),
                    "INVALID_RECEIPT",
                    "Invalid wake receipt identity.",
                )?;
                Ok(
                    if name.ends_with(".done.json") && request["status"] != "uncertain" {
                        Some(0)
                    } else {
                        None
                    },
                )
            }
            Kind::SelfDispatch => {
                let id = &value["identity"];
                let mut request = id.clone();
                request["version"] = json!(1);
                request["op"] = json!("wake-self-send");
                let request = mod_protocol::request(&request)?;
                insist(
                    name == format!("{}.json", request["claimId"].as_str().unwrap()),
                    "INVALID_RECEIPT",
                    "Invalid self-dispatch identity.",
                )?;
                if value["outcome"]["state"] == "rejected" {
                    return Ok(Some(0));
                }
                if value["outcome"]["state"] != "submitted" {
                    return Ok(None);
                }
                let outbox = self.root.join(Kind::WakeOutbox.directory());
                if !crate::status_app::exists(&outbox)? {
                    return Ok(None);
                }
                let Some(done) = read(
                    &outbox,
                    &format!("{}.done.json", request["claimId"].as_str().unwrap()),
                    true,
                )?
                else {
                    return Ok(None);
                };
                let done_request = mod_protocol::request(&done["request"])?;
                insist(
                    done["version"] == 1
                        && done_request["op"] == "wake-receipt"
                        && ["claimId", "messageId", "route", "context", "target"]
                            .iter()
                            .all(|k| done_request[*k] == request[*k]),
                    "INVALID_RECEIPT",
                    "Self-dispatch receipt does not match its exact native outcome.",
                )?;
                Ok(if done_request["status"] == "submitted" {
                    Some(0)
                } else {
                    None
                })
            }
        }
    }
    /// The journal transaction lock must be held before reserving one new file.
    pub fn reserve(&self, now: u64) -> Result<()> {
        let active = self.names()?;
        if active.len() < LIMIT {
            return Ok(());
        }
        let mut candidates = vec![];
        for name in active {
            let value = storage::json(&self.directory.join(&name), false, storage::LIMIT)?.unwrap();
            if let Some(at) = self.settled(&name, &value, now)? {
                candidates.push((at, name));
            }
        }
        candidates.sort();
        for (_, name) in candidates {
            let id = self.id(&name).unwrap();
            let Some(_lock) =
                storage::Lock::acquire(&self.directory.join(format!("{id}.lock")), false)?
            else {
                continue;
            };
            let Some(value) = storage::json(&self.directory.join(&name), true, storage::LIMIT)?
            else {
                continue;
            };
            if self.settled(&name, &value, now)?.is_some() {
                archive(&self.directory, &name, &value)?;
                return Ok(());
            }
        }
        insist(
            false,
            "JOURNAL_CAPACITY_EXHAUSTED",
            "Receipt storage is full with pending, uncertain or locked records. Preserve them; inspect journal capacity.",
        )
    }
    pub fn inspect(&self, now: u64) -> Result<Value> {
        if !crate::status_app::exists(&self.directory)? {
            return Ok(
                json!({"state":"available","active":0,"limit":LIMIT,"remaining":LIMIT,"settled":0,"protected":0}),
            );
        }
        storage::directory(&self.directory, false)?;
        let names = self.names()?;
        let mut settled = 0;
        for name in &names {
            let v = storage::json(&self.directory.join(name), false, storage::LIMIT)?.unwrap();
            let lock = self
                .directory
                .join(format!("{}.lock", self.id(name).unwrap()));
            if !crate::status_app::exists(&lock)? && self.settled(name, &v, now)?.is_some() {
                settled += 1;
            }
        }
        Ok(
            json!({"state":if names.len()<LIMIT{"available"}else if settled>0{"retention-available"}else{"capacity-exhausted"},"active":names.len(),"limit":LIMIT,"remaining":LIMIT-names.len(),"settled":settled,"protected":names.len()-settled,"archiveLookup":"exact","automaticReplay":false}),
        )
    }
}
pub fn read(directory: &Path, name: &str, optional: bool) -> Result<Option<Value>> {
    storage::directory(directory, false)?;
    if let Some(v) = storage::json(&directory.join(name), true, storage::LIMIT)? {
        return Ok(Some(v));
    }
    let archive = directory.join("archive");
    let saved = if crate::status_app::exists(&archive)? {
        storage::directory(&archive, false)?;
        storage::json(&archive.join(name), true, storage::LIMIT)?
    } else {
        None
    };
    insist(
        optional || saved.is_some(),
        "INVALID_RECEIPT",
        "The exact receipt is unavailable; preserve storage for inspection.",
    )?;
    Ok(saved)
}
fn archive(directory: &Path, name: &str, expected: &Value) -> Result<()> {
    let path = directory.join(name);
    let archive = directory.join("archive");
    storage::directory(&archive, true)?;
    let before = claudex_core::storage::FileIdentity::from_metadata(&fs::symlink_metadata(&path)?);
    let actual = storage::json(&path, false, storage::LIMIT)?.unwrap();
    insist(
        claudex_core::json::stringify(&actual)? == claudex_core::json::stringify(expected)?,
        "FILE_CHANGED",
        "Receipt changed before retention.",
    )?;
    let destination = archive.join(name);
    if let Some(old) = storage::json(&destination, true, storage::LIMIT)? {
        insist(
            claudex_core::json::stringify(&old)? == claudex_core::json::stringify(expected)?,
            "INVALID_RECEIPT",
            "Archived and active receipts disagree. Preserve both.",
        )?;
    } else {
        let temp = archive.join(format!(".archive-{}.tmp", uuid::Uuid::new_v4()));
        storage::write(&temp, expected, true)?;
        fs::rename(&temp, &destination)?;
        storage::sync_dir(&archive)?;
    }
    insist(
        before == claudex_core::storage::FileIdentity::from_metadata(&fs::symlink_metadata(&path)?),
        "FILE_CHANGED",
        "Receipt changed during retention.",
    )?;
    fs::remove_file(&path)?;
    storage::sync_dir(directory)
}
pub fn inspect(root: &Path, now: u64) -> Value {
    let mut out = json!({"diagnosticOnly":true});
    for kind in [Kind::Actions, Kind::SelfDispatch, Kind::WakeOutbox] {
        out[kind.key()]=Journal::new(root,kind).inspect(now).unwrap_or_else(|e|json!({"state":"unavailable","reason":e.downcast_ref::<mod_protocol::ModError>().map(|e|e.code.as_str()).filter(|c|["UNSAFE_ROOT","UNSAFE_FILE","FILE_CHANGED","JOURNAL_CAPACITY_EXHAUSTED"].contains(c)).unwrap_or("INVALID_RECEIPT")}));
    }
    out
}
