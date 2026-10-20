use crate::model::{error, now};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub uid: u32,
    pub started_at: String,
}
impl ProcessIdentity {
    fn same_birth(&self, other: &Self) -> bool {
        self.pid == other.pid && self.uid == other.uid && self.started_at == other.started_at
    }
    pub fn same(&self, other: &Self) -> Result<bool> {
        if self.same_birth(other) && self.pgid != other.pgid {
            bail!(
                "Owned native process changed its process group; its exit cannot be established."
            );
        }
        Ok(self.same_birth(other))
    }
}
pub async fn table() -> Result<Vec<ProcessIdentity>> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart="])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .output(),
    )
    .await??;
    if !out.status.success() || out.stdout.len() > 1024 * 1024 {
        bail!("Native process inventory exceeded its bound or could not be read.");
    }
    let text = std::str::from_utf8(&out.stdout)?;
    let mut rows = vec![];
    for line in text.lines().filter(|s| !s.trim().is_empty()) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 10 || rows.len() >= 16384 {
            bail!("Native process inventory contains malformed metadata.");
        }
        static START: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-5][0-9] [0-9]{4}$").unwrap()
        });
        if !START.is_match(&parts[5..].join(" ")) {
            bail!("Native process start identity is malformed.");
        }
        // A zombie has exited and holds no resources; only its table entry
        // remains until its parent reaps it, which may never happen.
        if parts[4].starts_with('Z') {
            continue;
        }
        rows.push(ProcessIdentity {
            pid: parts[0].parse()?,
            ppid: parts[1].parse()?,
            pgid: parts[2].parse()?,
            uid: parts[3].parse()?,
            started_at: parts[5..].join(" "),
        });
    }
    Ok(rows)
}
/// Workers share one demand-driven sample per cadence, rather than spawning ps
/// once per worker. Signals and shutdown proofs always use a fresh table.
pub async fn sampled_table() -> Result<Vec<ProcessIdentity>> {
    static SAMPLE: std::sync::LazyLock<
        tokio::sync::Mutex<Option<(std::time::Instant, Vec<ProcessIdentity>)>>,
    > = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
    let mut saved = SAMPLE.lock().await;
    if let Some((at, rows)) = &*saved
        && at.elapsed() < std::time::Duration::from_millis(200)
    {
        return Ok(rows.clone());
    }
    let rows = table().await?;
    *saved = Some((std::time::Instant::now(), rows.clone()));
    Ok(rows)
}
pub fn validate(records: &[ProcessIdentity]) -> Result<()> {
    if records.is_empty() || records.len() > 256 {
        bail!("Recorded native process identities are missing or exceed their bound.");
    }
    let mut pids = BTreeSet::new();
    for row in records {
        if row.pid <= 1
            || row.pgid < 1
            || row.uid != unsafe { libc::getuid() }
            || chrono::NaiveDateTime::parse_from_str(&row.started_at, "%a %b %e %H:%M:%S %Y")
                .is_err()
            || !pids.insert(row.pid)
        {
            bail!("Recorded native process identities are unsafe.");
        }
    }
    Ok(())
}
pub async fn inspect(records: &[ProcessIdentity]) -> Result<Value> {
    validate(records)?;
    let rows = table().await?;
    let by_pid = rows.iter().map(|r| (r.pid, r)).collect::<BTreeMap<_, _>>();
    let mut inspected = vec![];
    for r in records {
        let current = by_pid.get(&r.pid);
        let absent = match current {
            Some(x) => !r.same(x)?,
            None => true,
        };
        let mut value = serde_json::to_value(r)?;
        value["absent"] = json!(absent);
        if r.pid == r.pgid {
            value["groupAbsent"] = json!(
                !rows.iter().any(|x| x.pgid == r.pgid) || current.is_some_and(|x| !r.same_birth(x))
            );
        }
        inspected.push(value);
    }
    Ok(json!({"inspectedAt":now(),"processes":inspected}))
}
pub async fn signal(records: &[ProcessIdentity], signal: i32) -> Result<()> {
    validate(records)?;
    for saved in records.iter().rev() {
        let table = table().await?;
        if let Some(current) = table.iter().find(|r| r.pid == saved.pid) {
            if saved.same(current)? {
                let result = unsafe { libc::kill(saved.pid as i32, signal) };
                if result != 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
    }
    Ok(())
}
pub fn refresh(
    records: &mut Vec<ProcessIdentity>,
    pid: u32,
    table: &[ProcessIdentity],
) -> Result<bool> {
    let previous = records.clone();
    let current = table.iter().map(|r| (r.pid, r)).collect::<BTreeMap<_, _>>();
    if let Some(saved) = records.first()
        && let Some(now) = current.get(&pid)
        && !saved.same_birth(now)
    {
        bail!("Native leader PID was reused during active ownership tracking.");
    }
    if records.is_empty() {
        let root = current.get(&pid).ok_or_else(|| {
            error(
                "CLAUDEX_PROCESS_IDENTITY_UNAVAILABLE",
                "Native leader identity could not be verified.",
            )
        })?;
        if root.uid != unsafe { libc::getuid() } || root.pgid != pid {
            bail!("Native leader identity could not be verified.");
        }
        records.push((*root).clone());
    }
    let mut live = BTreeSet::new();
    for r in records.iter() {
        if let Some(current) = current.get(&r.pid) {
            if r.same(current)? {
                live.insert(r.pid);
            }
        }
    }
    let mut index = 0;
    records.retain(|r| {
        let retain = index == 0 || live.contains(&r.pid);
        index += 1;
        retain
    });
    loop {
        let mut changed = false;
        for r in table {
            if !live.contains(&r.pid)
                && r.uid == unsafe { libc::getuid() }
                && live.contains(&r.ppid)
            {
                if records.iter().any(|s| s.pid == r.pid) || records.len() >= 256 {
                    bail!("Owned native process inventory changed or exceeded its bound.");
                }
                records.push(r.clone());
                live.insert(r.pid);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Ok(previous != *records)
}
