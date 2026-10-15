use crate::model::*;
use anyhow::{Result, bail};
use claudex_core::storage;
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn private_read(path: &Path, max: usize) -> Result<Value> {
    Ok(serde_json::from_str(&private_read_text(path, max)?)?)
}
pub fn private_read_text(path: &Path, max: usize) -> Result<String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let m = std::fs::symlink_metadata(path)?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != storage::uid()
        || m.nlink() != 1
        || m.mode() & 0o077 != 0
        || m.len() > max as u64
    {
        bail!("Private storage must be owned, bounded, regular and single-link.");
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let identity = storage::FileIdentity::from_metadata(&m);
    if storage::FileIdentity::from_metadata(&file.metadata()?) != identity {
        bail!("Private storage changed before inspection.");
    }
    let mut bytes = Vec::new();
    file.by_ref().take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max
        || storage::FileIdentity::from_metadata(&file.metadata()?) != identity
        || storage::FileIdentity::from_metadata(&std::fs::symlink_metadata(path)?) != identity
    {
        bail!("Private storage changed during inspection or exceeded its bound.");
    }
    Ok(String::from_utf8(bytes)?)
}
pub fn optional(path: &Path, max: usize) -> Result<Option<Value>> {
    match private_read(path, max) {
        Ok(v) => Ok(Some(v)),
        Err(e) if storage::is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn capacity(c: &Config, s: &Value) -> Value {
    let resources = [
        (
            "tasks",
            s["tasks"].as_object().map_or(0, |v| v.len()),
            c.max_tasks,
        ),
        (
            "requests",
            s["requests"].as_object().map_or(0, |v| v.len()),
            c.max_requests,
        ),
        ("bytes", bytes(s), c.max_state_bytes),
    ];
    let mut v = json!({"available":resources.iter().all(|(_,u,l)|u<=l),"refusalCode":"CLAUDEX_WORK_CAPACITY_EXHAUSTED"});
    for (k, u, l) in resources {
        v[k] = json!({"used":u,"limit":l,"remaining":l.saturating_sub(u),"exhausted":u>=l});
    }
    v
}
pub struct WorkArchive {
    root: PathBuf,
}
impl WorkArchive {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join("work-archive"),
        }
    }
    fn dir(&self, kind: &str, create: bool) -> Result<Option<PathBuf>> {
        match std::fs::symlink_metadata(&self.root) {
            Ok(_) => storage::require_private_directory(&self.root)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
            }
            Err(e) => return Err(e.into()),
        }
        let path = self.root.join(kind);
        if match std::fs::symlink_metadata(&path) {
            Ok(_) => false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(e.into()),
        } {
            if !create {
                return Ok(None);
            }
            storage::private_directory(&path)?;
        }
        storage::require_private_directory(&self.root)?;
        storage::require_private_directory(&path)?;
        Ok(Some(path))
    }
    pub fn request(&self, key: &str) -> Result<Option<Value>> {
        if key.len() != 64
            || !key
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            bail!("Malformed work archive key.");
        }
        let Some(dir) = self.dir("requests", false)? else {
            return Ok(None);
        };
        let Some(v) = optional(&dir.join(format!("{key}.json")), 1024 * 1024)? else {
            return Ok(None);
        };
        if v["version"] != 1
            || v["key"] != key
            || !v["receipt"]["result"].is_object()
            || v["receipt"]["fingerprint"]
                .as_str()
                .is_none_or(|s| s.len() != 64)
        {
            bail!("Work archive receipt is invalid; evidence preserved.");
        }
        Ok(Some(v["receipt"].clone()))
    }
    pub fn save_request(&self, key: &str, r: &Value) -> Result<()> {
        if let Some(existing) = self.request(key)? {
            if existing != *r {
                bail!("Work archive receipt conflict.");
            }
            return Ok(());
        }
        let path = self
            .dir("requests", true)?
            .unwrap()
            .join(format!("{key}.json"));
        storage::publish_exclusive(
            path,
            format!("{}\n", json!({"version":1,"key":key,"receipt":r})),
        )?;
        Ok(())
    }
    pub fn tree(&self, id: &str) -> Result<Option<Value>> {
        if Uuid::parse_str(id).is_err() {
            return Ok(None);
        }
        let Some(dir) = self.dir("tasks", false)? else {
            return Ok(None);
        };
        let Some(locator) = optional(&dir.join(format!("{id}.json")), 1024)? else {
            return Ok(None);
        };
        let snapshot = locator["snapshot"].as_str().ok_or_else(|| {
            error(
                "CLAUDEX_WORK_ARCHIVE_UNSAFE",
                "Malformed work archive locator.",
            )
        })?;
        if locator["version"] != 1 || locator["taskId"] != id || Uuid::parse_str(snapshot).is_err()
        {
            bail!("Malformed work archive locator.");
        }
        let dir = self
            .dir("trees", false)?
            .ok_or_else(|| error("CLAUDEX_WORK_ARCHIVE_UNSAFE", "Missing work archive tree."))?;
        let tree = private_read(&dir.join(format!("{snapshot}.json")), 128 * 1024 * 1024)?;
        let tasks = tree["tasks"].as_object().ok_or_else(|| {
            error(
                "CLAUDEX_WORK_ARCHIVE_UNSAFE",
                "Malformed work archive tree.",
            )
        })?;
        if tree["version"] != 1
            || tree["rootId"] != locator["rootId"]
            || tasks.len() > 10000
            || !tasks.contains_key(id)
            || !tree["tasks"][tree["rootId"].as_str().unwrap_or("")]["parentId"].is_null()
        {
            bail!("Malformed work archive tree.");
        }
        for (k, t) in tasks {
            if t["id"] != k.as_str()
                || Uuid::parse_str(k).is_err()
                || !settled(t)
                || !t["messages"].is_array()
                || t["revision"].as_u64().is_none_or(|r| r == 0)
                || !t["generation"].is_u64()
            {
                bail!("Malformed archived task.");
            }
        }
        Ok(Some(tree))
    }
    pub fn task(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.tree(id)?.map(|t| t["tasks"][id].clone()))
    }
    pub fn restore(&self, s: &mut Value, id: &str) -> Result<()> {
        let Some(tree) = self.tree(id)? else {
            return Ok(());
        };
        for key in tree["tasks"].as_object().unwrap().keys() {
            if s["tasks"].get(key).is_some() {
                bail!("Archived work restore conflicts with active state.");
            }
        }
        let count = tree["tasks"].as_object().unwrap().len();
        for (k, t) in tree["tasks"].as_object().unwrap() {
            s["tasks"][k] = t.clone();
            if let Some(key) = t["notification"]["requestKey"].as_str() {
                if s["requests"].get(key).is_none() {
                    s["requests"][key] = self.request(key)?.ok_or_else(|| {
                        error(
                            "CLAUDEX_WORK_ARCHIVE_UNSAFE",
                            "Missing archived creation receipt.",
                        )
                    })?;
                    ensure_inventory(s);
                    s["archive"]["requests"] = json!(
                        s["archive"]["requests"]
                            .as_u64()
                            .unwrap_or(0)
                            .saturating_sub(1)
                    );
                }
            }
        }
        ensure_inventory(s);
        s["archive"]["tasks"] = json!(
            s["archive"]["tasks"]
                .as_u64()
                .unwrap_or(0)
                .saturating_sub(count as u64)
        );
        Ok(())
    }
    fn save_tree(&self, tasks: &Value, root: &str) -> Result<()> {
        let snapshot = Uuid::new_v4().to_string();
        let value = json!({"version":1,"rootId":root,"tasks":tasks});
        if bytes(&value) > 128 * 1024 * 1024 {
            bail!("Archive tree exceeds its bound.");
        }
        let path = self
            .dir("trees", true)?
            .unwrap()
            .join(format!("{snapshot}.json"));
        storage::publish_exclusive(path, format!("{value}\n"))?;
        let dir = self.dir("tasks", true)?.unwrap();
        for id in tasks.as_object().unwrap().keys() {
            self.task(id)?;
            storage::atomic_write(
                dir.join(format!("{id}.json")),
                format!(
                    "{}\n",
                    json!({"version":1,"taskId":id,"rootId":root,"snapshot":snapshot})
                ),
            )?;
        }
        Ok(())
    }
    pub fn make_room(&self, c: &Config, old: &Value, s: &mut Value) -> Result<()> {
        ensure_inventory(s);
        self.archive_requests(c, old, s)?;
        let mut roots = s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter(|t| t["parentId"].is_null())
            .cloned()
            .collect::<Vec<_>>();
        roots.sort_by(|a, b| {
            a["updatedAt"]
                .as_u64()
                .cmp(&b["updatedAt"].as_u64())
                .then(a["id"].as_str().cmp(&b["id"].as_str()))
        });
        for root in roots {
            if capacity(c, s)["available"] == true {
                return Ok(());
            }
            let root_id = root["id"].as_str().unwrap();
            let mut ids = std::collections::BTreeSet::from([root_id.to_string()]);
            loop {
                let before = ids.len();
                for (k, t) in s["tasks"].as_object().unwrap() {
                    if t["parentId"].as_str().is_some_and(|id| ids.contains(id)) {
                        ids.insert(k.clone());
                    }
                }
                if ids.len() == before {
                    break;
                }
            }
            let tasks = json!(
                ids.iter()
                    .map(|id| (id.clone(), s["tasks"][id].clone()))
                    .collect::<serde_json::Map<_, _>>()
            );
            let mut pinned = false;
            for (id, t) in tasks.as_object().unwrap() {
                if !settled(t)
                    || old["tasks"].get(id) != Some(t)
                    || !notification_settled(
                        t,
                        now(),
                        &self.root.parent().unwrap().join("chat-mailbox"),
                    )?
                {
                    pinned = true;
                    break;
                }
            }
            if pinned {
                continue;
            }
            for t in tasks.as_object().unwrap().values() {
                if let Some(key) = t["notification"]["requestKey"].as_str() {
                    let r = s["requests"]
                        .get(key)
                        .cloned()
                        .or(self.request(key)?)
                        .ok_or_else(|| {
                            error("CLAUDEX_WORK_ARCHIVE_UNSAFE", "Missing creation receipt.")
                        })?;
                    self.save_request(key, &r)?;
                }
            }
            self.save_tree(&tasks, root_id)?;
            for id in &ids {
                s["tasks"].as_object_mut().unwrap().remove(id);
            }
            s["archive"]["tasks"] =
                json!(s["archive"]["tasks"].as_u64().unwrap_or(0) + ids.len() as u64);
            self.archive_requests(c, old, s)?;
        }
        let cap = capacity(c, s);
        for resource in ["tasks", "requests", "bytes"] {
            let used = cap[resource]["used"].as_u64().unwrap() as usize;
            let limit = cap[resource]["limit"].as_u64().unwrap() as usize;
            if used > limit {
                return Err(ProtocolError{code:"CLAUDEX_WORK_CAPACITY_EXHAUSTED".into(),message:format!("Work ledger capacity reached ({resource}); no safely settled history can be archived."),capacity:Some((resource,used,limit))}.into());
            }
        }
        Ok(())
    }
    fn archive_requests(&self, c: &Config, old: &Value, s: &mut Value) -> Result<()> {
        let pinned = s["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(|t| t["notification"]["requestKey"].as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let keys = s["requests"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            let cap = capacity(c, s);
            if cap["requests"]["used"].as_u64().unwrap() <= c.max_requests as u64
                && cap["bytes"]["used"].as_u64().unwrap() <= c.max_state_bytes as u64
            {
                break;
            }
            if pinned.contains(&key) || old["requests"].get(&key) != s["requests"].get(&key) {
                continue;
            }
            self.save_request(&key, &s["requests"][&key])?;
            s["requests"].as_object_mut().unwrap().remove(&key);
            s["archive"]["requests"] = json!(s["archive"]["requests"].as_u64().unwrap_or(0) + 1);
        }
        Ok(())
    }
}
fn ensure_inventory(s: &mut Value) {
    if !s["archive"].is_object() {
        s["archive"] = json!({"tasks":0,"requests":0});
    }
}
fn notification_settled(t: &Value, now: u64, mailbox: &Path) -> Result<bool> {
    let n = &t["notification"];
    if n.is_null() {
        return Ok(true);
    }
    if n["origin"].is_null() && n["challengeExpiresAt"].as_u64().unwrap_or(0) > now {
        return Ok(false);
    }
    if !n["origin"].is_null()
        && n["suppressedRevision"] != t["revision"]
        && t["updatedAt"].as_u64().unwrap_or(0) + n["policy"]["expiresInMs"].as_u64().unwrap_or(0)
            > now
        && !array(&n["deliveries"])
            .iter()
            .any(|d| d["revision"] == t["revision"])
    {
        return Ok(false);
    }
    for d in array(&n["deliveries"]) {
        if matches!(d["state"].as_str(), Some("dispatching" | "uncertain"))
            || d["createdAt"].as_u64().unwrap_or(0) > now.saturating_sub(60000)
        {
            return Ok(false);
        }
        if let Some(id) = d["messageId"].as_str() {
            let receipt = crate::mailbox::ChatMailbox::new(mailbox.into()).status(id)?;
            if !matches!(receipt["state"].as_str(), Some("acknowledged" | "expired"))
                || matches!(
                    receipt["wake"]["state"].as_str(),
                    Some("dispatching" | "uncertain")
                )
            {
                return Ok(false);
            }
        } else if d["state"] == "queued" {
            return Ok(false);
        }
    }
    Ok(true)
}
