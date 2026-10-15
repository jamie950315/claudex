//! Fresh metadata-only native dependency inventories. An inventory preserves
//! anchors; it never grants a transcript writer lease or archival authority.
use crate::native_history::Rpc;
use anyhow::{Result, ensure};
use async_trait::async_trait;
use claudex_core::storage::FileIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::{fs, path::Path};
use uuid::Uuid;

const MAX_PAGES: usize = 100;
const MAX_IDS: usize = 10_000;
const KINDS: &[&str] = &[
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
];

fn valid_id(id: &str) -> bool {
    id.len() == 36 && Uuid::parse_str(id).is_ok()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub parent_id: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    pub parent_ids: Vec<String>,
    pub transient_candidate: bool,
}
#[derive(Debug)]
pub struct SourceFailure {
    pub native_id: String,
    pub options: ReadOptions,
    pub error: anyhow::Error,
}
impl std::fmt::Display for SourceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Codex dependency source {}: {}",
            self.native_id, self.error
        )
    }
}
impl std::error::Error for SourceFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.error.as_ref())
    }
}
#[async_trait]
pub trait Metadata: Send + Sync {
    /// None requires an independently proven disappearance, not a not-found
    /// error string. It is accepted only for an untracked loaded-only hint.
    async fn read(&self, id: &str, options: &ReadOptions) -> Result<Option<Value>>;
}
pub struct Direct<'a>(pub &'a dyn Rpc);
#[async_trait]
impl Metadata for Direct<'_> {
    async fn read(&self, id: &str, _options: &ReadOptions) -> Result<Option<Value>> {
        Ok(Some(
            self.0
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await?,
        ))
    }
}
#[derive(Clone)]
enum Mode {
    Loaded,
    Stored {
        archived: bool,
        ancestor: Option<String>,
    },
}
impl Mode {
    fn params(&self, cursor: Option<&str>) -> (&'static str, Value) {
        let (method, mut params) = match self {
            Self::Loaded => ("thread/loaded/list", json!({"limit":100})),
            Self::Stored { archived, ancestor } => {
                let mut params = json!({"limit":100,"archived":archived,"sourceKinds":KINDS});
                if let Some(id) = ancestor {
                    params["ancestorThreadId"] = json!(id);
                }
                ("thread/list", params)
            }
        };
        if let Some(c) = cursor {
            params["cursor"] = json!(c);
        }
        (method, params)
    }
    fn id<'a>(&self, row: &'a Value) -> Result<&'a str> {
        let id = match self {
            Self::Loaded => row.as_str(),
            _ => row["id"].as_str(),
        };
        let id = id.filter(|s| valid_id(s)).ok_or_else(|| {
            anyhow::anyhow!("Codex dependency inventory: malformed native identity.")
        })?;
        Ok(id)
    }
}
fn modes(parents: &[String]) -> Vec<Mode> {
    let mut modes = vec![
        Mode::Loaded,
        Mode::Stored {
            archived: false,
            ancestor: None,
        },
        Mode::Stored {
            archived: true,
            ancestor: None,
        },
    ];
    for parent in parents {
        for archived in [false, true] {
            modes.push(Mode::Stored {
                archived,
                ancestor: Some(parent.clone()),
            });
        }
    }
    modes
}
fn next_cursor(page: &Value, seen: &mut BTreeSet<String>) -> Result<Option<String>> {
    let Some(next) = page.get("nextCursor").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let next = next
        .as_str()
        .filter(|c| !c.is_empty() && c.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("Codex dependency inventory: malformed cursor."))?;
    ensure!(
        seen.insert(next.into()),
        "Codex dependency inventory: repeated cursor."
    );
    Ok(Some(next.into()))
}
pub async fn inventory_contains(client: &dyn Rpc, id: &str, parents: &[String]) -> Result<bool> {
    ensure!(
        valid_id(id) && parents.len() <= MAX_IDS && parents.iter().all(|s| valid_id(s)),
        "Codex dependency inventory: malformed parent or source identity."
    );
    for mode in modes(parents) {
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        for page_index in 0..=MAX_PAGES {
            ensure!(
                page_index < MAX_PAGES,
                "Codex dependency inventory: page limit exceeded."
            );
            let (method, params) = mode.params(cursor.as_deref());
            let page = client.request(method, params).await?;
            let rows = page["data"]
                .as_array()
                .filter(|r| r.len() <= 100)
                .ok_or_else(|| anyhow::anyhow!("Codex dependency inventory: malformed page."))?;
            for row in rows {
                if mode.id(row)?.eq_ignore_ascii_case(id) {
                    return Ok(true);
                }
            }
            cursor = next_cursor(&page, &mut seen)?;
            if cursor.is_none() {
                break;
            }
        }
    }
    Ok(false)
}
/// Names-only absence proof for one native thread, including compressed and
/// rollover representations. An unsafe alias never establishes absence.
pub fn rollout_absent(home: &Path, id: &str) -> Result<bool> {
    ensure!(
        home.is_absolute() && valid_id(id),
        "Exact Codex home and thread identity are required for rollout absence."
    );
    let uuid = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
    let name = regex::Regex::new(&format!(
        r"(?i)^(?:rollout-(?:.*-)?)?{}(?:_{uuid})?\.jsonl(?:\.zst)?$",
        regex::escape(id)
    ))?;
    fn visit(path: &Path, depth: usize, name: &regex::Regex) -> Result<bool> {
        let before = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(e.into()),
        };
        ensure!(
            before.is_dir() && !before.file_type().is_symlink() && fs::canonicalize(path)? == path,
            "Unsafe Codex rollout directory; absence is unverified."
        );
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            if name.is_match(&filename) {
                return Ok(false);
            }
            if depth > 0
                && !filename.is_empty()
                && filename.bytes().all(|b| b.is_ascii_digit())
                && !entry.file_type()?.is_file()
                && !visit(&entry.path(), depth - 1, name)?
            {
                return Ok(false);
            }
        }
        ensure!(
            FileIdentity::from_metadata(&before)
                == FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
            "Codex rollout directory changed; absence is unverified."
        );
        Ok(true)
    }
    Ok(visit(&home.join("sessions"), 3, &name)?
        && visit(&home.join("archived_sessions"), 0, &name)?)
}
fn relationship(thread: &Value) -> Result<Option<(String, String)>> {
    let spawn = &thread["source"]["subAgent"]["thread_spawn"];
    let spawn = if spawn.is_null() {
        None
    } else {
        ensure!(
            spawn.is_object(),
            "Codex dependency inventory: malformed spawn metadata."
        );
        Some(
            spawn["parent_thread_id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or_else(|| {
                    anyhow::anyhow!("Codex dependency inventory: malformed spawn identity.")
                })?,
        )
    };
    let fork = if thread["forkedFromId"].is_null() {
        None
    } else {
        Some(
            thread["forkedFromId"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or_else(|| {
                    anyhow::anyhow!("Codex dependency inventory: malformed fork identity.")
                })?,
        )
    };
    ensure!(
        spawn.is_none() || fork.is_none() || spawn == fork,
        "Codex dependency inventory: ambiguous parent identity."
    );
    Ok(spawn
        .map(|s| (s.into(), "spawn".into()))
        .or_else(|| fork.map(|s| (s.into(), "fork".into()))))
}
struct Inventory<'a> {
    reader: &'a dyn Metadata,
    parents: Vec<String>,
    ids: BTreeSet<String>,
    ancestors: BTreeMap<String, BTreeSet<String>>,
    witnesses: BTreeMap<String, Vec<Value>>,
    metadata: BTreeMap<String, Option<(String, String)>>,
    threads: BTreeMap<String, Value>,
}
impl Inventory<'_> {
    async fn read(&mut self, id: &str) -> Result<Option<(String, String)>> {
        if let Some(edge) = self.metadata.get(id) {
            return Ok(edge.clone());
        }
        let inventoried = self.ids.contains(id);
        self.ids.insert(id.into());
        ensure!(
            self.ids.len() <= MAX_IDS,
            "Codex dependency inventory: identity limit exceeded."
        );
        let mut options = ReadOptions {
            parent_ids: self.parents.clone(),
            transient_candidate: inventoried
                && !self.parents.iter().any(|p| p == id)
                && !self.witnesses.contains_key(id)
                && !self.ancestors.values().any(|ids| ids.contains(id)),
        };
        let result = self
            .reader
            .read(id, &options)
            .await
            .map_err(|error| SourceFailure {
                native_id: id.into(),
                options: options.clone(),
                error,
            })?;
        if result.is_none() && options.transient_candidate {
            self.metadata.insert(id.into(), None);
            return Ok(None);
        }
        // A malformed response or a contradictory witness never becomes an
        // eligible transient failure, even if the source was loaded-only.
        options.transient_candidate = false;
        let proof = (|| -> Result<_> {
            let result = result
                .ok_or_else(|| anyhow::anyhow!("Stored or ancestral native source disappeared."))?;
            let thread = &result["thread"];
            ensure!(
                thread.is_object() && thread["id"] == id,
                "Codex dependency inventory: native identity changed."
            );
            let edge = relationship(thread)?;
            for row in self.witnesses.get(id).into_iter().flatten() {
                ensure!(
                    row["forkedFromId"].is_null() || row["forkedFromId"] == thread["forkedFromId"],
                    "Codex dependency inventory: listed fork identity changed."
                );
                if !row["source"]["subAgent"]["thread_spawn"].is_null() {
                    ensure!(
                        relationship(row)?.as_ref().map(|e| &e.0) == edge.as_ref().map(|e| &e.0),
                        "Codex dependency inventory: listed spawn identity changed."
                    );
                }
            }
            Ok((edge, thread.clone()))
        })()
        .map_err(|error| SourceFailure {
            native_id: id.into(),
            options,
            error,
        })?;
        self.threads.insert(id.into(), proof.1);
        self.metadata.insert(id.into(), proof.0.clone());
        Ok(proof.0)
    }
}
pub struct InventorySnapshot {
    pub edges: BTreeMap<String, Vec<Edge>>,
    pub threads: BTreeMap<String, Value>,
}
pub async fn read_for_parents(
    client: &dyn Rpc,
    parents: &[String],
    reader: &dyn Metadata,
) -> Result<BTreeMap<String, Vec<Edge>>> {
    Ok(metadata_for_parents(client, parents, reader).await?.edges)
}
pub async fn metadata_for_parents(
    client: &dyn Rpc,
    parents: &[String],
    reader: &dyn Metadata,
) -> Result<InventorySnapshot> {
    ensure!(
        parents.len() <= MAX_IDS && parents.iter().all(|s| valid_id(s)),
        "Codex dependency inventory: malformed parent identity."
    );
    let parents = parents
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if parents.is_empty() {
        return Ok(InventorySnapshot {
            edges: BTreeMap::new(),
            threads: BTreeMap::new(),
        });
    }
    let mut inventory = Inventory {
        reader,
        ancestors: parents
            .iter()
            .map(|p| (p.clone(), BTreeSet::new()))
            .collect(),
        parents: parents.clone(),
        ids: BTreeSet::new(),
        witnesses: BTreeMap::new(),
        metadata: BTreeMap::new(),
        threads: BTreeMap::new(),
    };
    for mode in modes(&parents) {
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        for page_index in 0..=MAX_PAGES {
            ensure!(
                page_index < MAX_PAGES,
                "Codex dependency inventory: page limit exceeded."
            );
            let (method, params) = mode.params(cursor.as_deref());
            let page = client.request(method, params).await?;
            let rows = page["data"]
                .as_array()
                .filter(|r| r.len() <= 100)
                .ok_or_else(|| anyhow::anyhow!("Codex dependency inventory: malformed page."))?;
            for row in rows {
                let id = mode.id(row)?;
                inventory.ids.insert(id.into());
                ensure!(
                    inventory.ids.len() <= MAX_IDS,
                    "Codex dependency inventory: identity limit exceeded."
                );
                if let Mode::Stored {
                    ancestor: Some(parent),
                    ..
                } = &mode
                {
                    inventory
                        .ancestors
                        .get_mut(parent)
                        .unwrap()
                        .insert(id.into());
                }
                if !matches!(mode, Mode::Loaded) {
                    inventory
                        .witnesses
                        .entry(id.into())
                        .or_default()
                        .push(row.clone());
                }
            }
            cursor = next_cursor(&page, &mut seen)?;
            if cursor.is_none() {
                break;
            }
        }
    }
    for id in inventory.ids.clone() {
        inventory.read(&id).await?;
    }
    for (parent, ids) in inventory.ancestors.clone() {
        for id in ids {
            let mut current = id;
            let mut seen = BTreeSet::from([parent.clone()]);
            while current != parent {
                ensure!(
                    seen.insert(current.clone()),
                    "Codex dependency inventory: ancestry cycle detected."
                );
                ensure!(
                    seen.len() <= 100,
                    "Codex dependency inventory: ancestry depth limit exceeded."
                );
                current=inventory.read(&current).await?.ok_or_else(||anyhow::anyhow!("Codex dependency inventory: ancestor query returned an unrelated identity."))?.0;
            }
        }
    }
    let edges = parents
        .into_iter()
        .map(|parent| {
            let edges = inventory
                .metadata
                .iter()
                .filter_map(|(id, edge)| {
                    edge.as_ref()
                        .filter(|e| id != &parent && e.0 == parent)
                        .map(|(parent_id, kind)| Edge {
                            id: id.clone(),
                            parent_id: parent_id.clone(),
                            kind: kind.clone(),
                        })
                })
                .collect();
            (parent, edges)
        })
        .collect();
    Ok(InventorySnapshot {
        edges,
        threads: inventory.threads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    const P: &str = "00000000-0000-0000-0000-000000000001";
    const A: &str = "00000000-0000-0000-0000-000000000002";
    const B: &str = "00000000-0000-0000-0000-000000000003";
    struct Fake {
        rows: Vec<Value>,
        loaded: Vec<Value>,
        ancestors: Vec<Value>,
        metadata: BTreeMap<String, Value>,
        repeat: bool,
        calls: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl Rpc for Fake {
        async fn request(&self, method: &str, params: Value) -> Result<Value> {
            self.calls
                .lock()
                .unwrap()
                .push(json!({"method":method,"params":params}));
            Ok(match method {
                "thread/loaded/list" => {
                    json!({"data":self.loaded,"nextCursor":if self.repeat {json!("repeat")}else{Value::Null}})
                }
                "thread/list" => {
                    json!({"data":if !params["ancestorThreadId"].is_null(){self.ancestors.clone()}else if params["archived"]==false{self.rows.clone()}else{vec![]}})
                }
                "thread/read" => {
                    json!({"thread":self.metadata.get(params["threadId"].as_str().unwrap()).cloned().unwrap_or(Value::Null)})
                }
                _ => unreachable!(),
            })
        }
    }
    fn fake() -> Fake {
        Fake {
            rows: vec![],
            loaded: vec![],
            ancestors: vec![],
            metadata: BTreeMap::new(),
            repeat: false,
            calls: Mutex::new(vec![]),
        }
    }
    #[tokio::test]
    async fn loaded_fork_and_nested_spawn_have_independent_parent_proofs() {
        let mut client = fake();
        client.loaded = vec![json!(A)];
        client.ancestors = vec![json!({"id":B})];
        client
            .metadata
            .insert(A.into(), json!({"id":A,"forkedFromId":P}));
        client.metadata.insert(
            B.into(),
            json!({"id":B,"source":{"subAgent":{"thread_spawn":{"parent_thread_id":A}}}}),
        );
        let proof = read_for_parents(&client, &[P.into()], &Direct(&client))
            .await
            .unwrap();
        assert_eq!(
            proof[P],
            vec![Edge {
                id: A.into(),
                parent_id: P.into(),
                kind: "fork".into()
            }]
        );
        assert!(
            client
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|r| r["method"] == "thread/loaded/list")
        );
    }
    #[tokio::test]
    async fn contradictory_list_witness_is_not_transient() {
        let mut client = fake();
        client.rows = vec![json!({"id":A,"forkedFromId":P})];
        client
            .metadata
            .insert(A.into(), json!({"id":A,"forkedFromId":B}));
        let error = read_for_parents(&client, &[P.into()], &Direct(&client))
            .await
            .unwrap_err();
        assert!(
            !error
                .downcast_ref::<SourceFailure>()
                .unwrap()
                .options
                .transient_candidate
        );
        assert!(error.to_string().contains("listed fork"));
    }
    #[tokio::test]
    async fn repeated_cursor_and_unrelated_ancestor_are_rejected() {
        let mut client = fake();
        client.repeat = true;
        assert!(
            read_for_parents(&client, &[P.into()], &Direct(&client))
                .await
                .unwrap_err()
                .to_string()
                .contains("repeated cursor")
        );
        client.repeat = false;
        client.ancestors = vec![json!({"id":A})];
        client.metadata.insert(A.into(), json!({"id":A}));
        assert!(
            read_for_parents(&client, &[P.into()], &Direct(&client))
                .await
                .unwrap_err()
                .to_string()
                .contains("unrelated")
        );
    }
    struct Disappeared;
    #[async_trait]
    impl Metadata for Disappeared {
        async fn read(&self, _id: &str, _options: &ReadOptions) -> Result<Option<Value>> {
            Ok(None)
        }
    }
    #[tokio::test]
    async fn proven_absence_only_exempts_loaded_only_untracked_hints() {
        let mut client = fake();
        client.loaded = vec![json!(A)];
        assert!(
            read_for_parents(&client, &[P.into()], &Disappeared)
                .await
                .unwrap()[P]
                .is_empty()
        );
        client.rows = vec![json!({"id":A})];
        assert!(
            read_for_parents(&client, &[P.into()], &Disappeared)
                .await
                .is_err()
        );
    }
}
