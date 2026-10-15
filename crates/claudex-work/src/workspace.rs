use crate::model::{Permission, array, text};
use anyhow::{Result, bail};
use claudex_core::storage;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub fn contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}
fn overlaps(a: &Path, b: &Path) -> bool {
    contains(a, b) || contains(b, a)
}
fn compact(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots.sort();
    roots.dedup();
    let all = roots.clone();
    roots.retain(|r| !all.iter().any(|o| o != r && contains(o, r)));
    roots
}
fn directory(v: &Value, label: &str) -> Result<PathBuf> {
    let s = text(v, label, 4096)?;
    let p = Path::new(s);
    if !p.is_absolute() {
        bail!("{label} must be an absolute directory path.");
    }
    let p = p.canonicalize()?;
    if !p.is_dir() {
        bail!("{label} must be an existing directory.");
    }
    Ok(p)
}
fn dirs(v: &Value, label: &str) -> Result<Vec<PathBuf>> {
    let a = v
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("{label} must be an array."))?;
    if a.len() > 16 {
        bail!("{label} must contain at most 16 directories.");
    }
    compact(
        a.iter()
            .map(|v| directory(v, label))
            .collect::<Result<_>>()?,
    )
    .pipe(Ok)
}
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}
fn git_root(cwd: &Path) -> Result<PathBuf> {
    for cursor in cwd.ancestors() {
        let marker = cursor.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
            Ok(m) => {
                if !m.is_dir() && !m.is_file() {
                    bail!("Project Git marker must be a regular file or directory.");
                }
                if m.is_file() {
                    let snap = storage::read_stable(&marker)?;
                    if snap.bytes.len() > 8192 {
                        bail!("Project Git marker exceeds the size limit.");
                    }
                    let content = std::str::from_utf8(&snap.bytes)?;
                    let target = content
                        .trim_end_matches(['\r', '\n'])
                        .strip_prefix("gitdir: ")
                        .ok_or_else(|| {
                            anyhow::anyhow!("Project Git marker has an unsupported format.")
                        })?;
                    if target.contains(['\r', '\n', '\0'])
                        || !cursor.join(target).canonicalize()?.is_dir()
                    {
                        bail!("Invalid Git metadata directory.");
                    }
                }
                let home = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .and_then(|p| p.canonicalize().ok());
                return Ok(
                    if cursor.parent().is_none() || home.as_deref() == Some(cursor) {
                        cwd.into()
                    } else {
                        cursor.into()
                    },
                );
            }
        }
    }
    Ok(cwd.into())
}
pub fn access(t: &Value) -> (Vec<PathBuf>, Vec<PathBuf>) {
    if t["permission"] == "full-access" {
        return (vec!["/".into()], vec!["/".into()]);
    }
    let primary = PathBuf::from(
        t["projectRoot"]
            .as_str()
            .or(t["cwd"].as_str())
            .unwrap_or(""),
    );
    let mut reads = vec![primary.clone()];
    reads.extend(
        array(&t["readOnlyDirs"])
            .iter()
            .filter_map(|v| v.as_str().map(PathBuf::from)),
    );
    let mut writes = vec![];
    if t["permission"] == "workspace-write" {
        writes.push(primary);
        writes.extend(
            array(&t["writableDirs"])
                .iter()
                .filter_map(|v| v.as_str().map(PathBuf::from)),
        );
    }
    reads.extend(writes.clone());
    (compact(reads), compact(writes))
}
pub fn conflicts(a: &Value, b: &Value) -> bool {
    let (ar, aw) = access(a);
    let (br, bw) = access(b);
    aw.iter().any(|r| br.iter().any(|x| overlaps(r, x)))
        || bw.iter().any(|r| ar.iter().any(|x| overlaps(r, x)))
}
pub fn resolve(params: &Value, permission: Permission, parent: Option<&Value>) -> Result<Value> {
    if let Some(p) = parent {
        revalidate(p)?;
    }
    let requested = directory(
        params
            .get("cwd")
            .or_else(|| parent.map(|p| &p["cwd"]))
            .unwrap_or(&Value::Null),
        "cwd",
    )?;
    let primary = if let Some(p) = params.get("projectRoot") {
        directory(p, "projectRoot")?
    } else if let Some(p) = parent {
        if requested == Path::new(p["cwd"].as_str().unwrap_or("")) {
            PathBuf::from(
                p["projectRoot"]
                    .as_str()
                    .or(p["cwd"].as_str())
                    .unwrap_or(""),
            )
        } else {
            requested.clone()
        }
    } else {
        git_root(&requested)?
    };
    if !contains(&primary, &requested) {
        bail!("projectRoot must contain cwd.");
    }
    let parent_access = parent.map(access);
    if let Some((read, write)) = &parent_access {
        if !read.iter().any(|p| contains(p, &primary))
            || permission != Permission::ReadOnly && !write.iter().any(|p| contains(p, &primary))
        {
            bail!("Child projectRoot exceeds parent directory access.");
        }
    }
    let mut inherited_reads = parent
        .map(|p| array(&p["readOnlyDirs"]))
        .unwrap_or_default();
    let inherited_writes = parent
        .map(|p| array(&p["writableDirs"]))
        .unwrap_or_default();
    if permission == Permission::ReadOnly {
        inherited_reads.extend(inherited_writes.clone());
    }
    let mut reads = dirs(
        params
            .get("readOnlyDirs")
            .unwrap_or(&json!(inherited_reads)),
        "readOnlyDirs",
    )?;
    let extra_writes = dirs(
        params
            .get("writableDirs")
            .unwrap_or(&json!(if permission == Permission::ReadOnly {
                vec![]
            } else {
                inherited_writes
            })),
        "writableDirs",
    )?;
    if permission == Permission::ReadOnly && !extra_writes.is_empty() {
        bail!("read-only work cannot request writableDirs.");
    }
    if permission == Permission::FullAccess && !reads.is_empty() {
        bail!(
            "full-access work cannot enforce readOnlyDirs; use workspace-write for reference directories."
        );
    }
    let writes = if permission != Permission::ReadOnly {
        compact([vec![primary.clone()], extra_writes.clone()].concat())
    } else {
        vec![]
    };
    if [vec![primary.clone()], reads.clone(), extra_writes.clone()]
        .concat()
        .iter()
        .any(|p| p.parent().is_none())
    {
        bail!("Filesystem root cannot be a workspace access grant.");
    }
    if permission == Permission::WorkspaceWrite {
        if let Some(h) = std::env::var_os("HOME") {
            let h = PathBuf::from(h).canonicalize()?;
            if writes.iter().any(|p| contains(p, &h)) {
                bail!("Workspace write access must not cover the entire home directory.");
            }
        }
    }
    if reads.iter().any(|r| writes.iter().any(|w| overlaps(r, w))) {
        bail!("readOnlyDirs must not overlap a writable workspace directory.");
    }
    if let Some((pr, pw)) = parent_access {
        if reads.iter().any(|r| !pr.iter().any(|p| contains(p, r)))
            || extra_writes
                .iter()
                .any(|r| !pw.iter().any(|p| contains(p, r)))
        {
            bail!("Child directories exceed parent directory access.");
        }
    }
    if permission == Permission::ReadOnly {
        reads.retain(|r| !contains(&primary, r));
    }
    Ok(
        json!({"cwd":primary,"projectRoot":primary,"readOnlyDirs":reads,"writableDirs":extra_writes.into_iter().filter(|r|!contains(&primary,r)).collect::<Vec<_>>()}),
    )
}
pub fn revalidate(t: &Value) -> Result<()> {
    let p = Permission::parse(t["permission"].as_str().unwrap_or(""))?;
    if t.get("projectRoot").is_some() && t["projectRoot"] != t["cwd"] {
        bail!("Saved projectRoot must match the effective working directory.");
    }
    for key in ["readOnlyDirs", "writableDirs"] {
        if let Some(v) = t.get(key) {
            if !v.is_array() || v.as_array().unwrap().len() > 16 {
                bail!("Invalid saved directory grants.");
            }
        }
    }
    if p == Permission::ReadOnly && !array(&t["writableDirs"]).is_empty()
        || p == Permission::FullAccess && !array(&t["readOnlyDirs"]).is_empty()
    {
        bail!("Saved workspace permission cannot enforce its grants.");
    }
    let all = [
        vec![t["cwd"].clone()],
        array(&t["readOnlyDirs"]),
        array(&t["writableDirs"]),
    ]
    .concat();
    for v in all {
        let canonical = directory(&v, "Saved workspace directory")?;
        if Some(canonical.as_path()) != v.as_str().map(Path::new) {
            bail!("Saved workspace directory changed its canonical identity.");
        }
    }
    let (_, writes) = access(t);
    if p != Permission::FullAccess
        && array(&t["readOnlyDirs"]).iter().any(|r| {
            writes
                .iter()
                .any(|w| overlaps(Path::new(r.as_str().unwrap_or("")), w))
        })
    {
        bail!("Saved read-only directories overlap writable access.");
    }
    Ok(())
}
