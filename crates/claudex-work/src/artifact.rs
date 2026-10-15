use crate::model::*;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use tokio::io::AsyncReadExt;
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(part),
        }
    }
    out
}
fn directory(path: &Path) -> Result<(u64, u64, u32, u32)> {
    let m = std::fs::symlink_metadata(path)?;
    if !m.is_dir() || m.file_type().is_symlink() {
        bail!("Artifact directory chain must not contain symbolic links.");
    }
    Ok((m.dev(), m.ino(), m.uid(), m.mode()))
}
pub async fn read(task: &Value, p: &Value) -> Result<Value> {
    let result = read_inner(task, p).await;
    result.map_err(|e| error("CLAUDEX_ARTIFACT_REFUSED", e.to_string()))
}
async fn read_inner(task: &Value, p: &Value) -> Result<Value> {
    let generation = p["generation"]
        .as_u64()
        .filter(|g| *g <= task["generation"].as_u64().unwrap_or(0))
        .context("Artifact requires an exact existing generation")?;
    let reference = text(&p["reference"], "artifact reference", 2048)?;
    let max = p
        .get("maxBytes")
        .map(Value::as_u64)
        .unwrap_or(Some(65536))
        .filter(|m| *m > 0 && *m <= 65536)
        .context("Invalid artifact byte limit")? as usize;
    let view = p["view"].as_str().unwrap_or("content");
    if !matches!(view, "content" | "diff") {
        bail!("Invalid artifact view.");
    }
    let mut reports = vec![
        task["active"]["report"].clone(),
        task["lastExecution"]["report"].clone(),
    ];
    for k in ["reports", "reportHistory"] {
        reports.extend(array(&task[k]));
    }
    reports.extend(array(&task["progress"]["reports"]));
    let declaration = reports
        .iter()
        .find(|r| {
            r["generation"] == generation
                && array(r.get("artifacts").unwrap_or(&r["outcome"]["artifacts"]))
                    .iter()
                    .any(|a| a["kind"] == "file" && a["reference"] == reference)
        })
        .context("Artifact is not a declared file for this generation")?;
    let cwd = Path::new(task["cwd"].as_str().context("Missing artifact directory")?);
    let path = normalize(&cwd.join(reference));
    let mut roots = vec![PathBuf::from(
        task["projectRoot"]
            .as_str()
            .unwrap_or(cwd.to_str().unwrap()),
    )];
    for k in ["readOnlyDirs", "writableDirs"] {
        for root in array(&task[k]) {
            roots.push(root.as_str().context("Invalid artifact root")?.into());
        }
    }
    if roots.iter().any(|r| {
        !r.is_absolute() || r.parent().is_none() || r.canonicalize().ok().as_ref() != Some(r)
    }) || !roots.iter().any(|r| path.starts_with(r))
    {
        bail!("Artifact is outside canonical task directory grants.");
    }
    let mut chain = vec![];
    let mut cursor = PathBuf::new();
    for c in path
        .parent()
        .context("Artifact parent missing")?
        .components()
    {
        cursor.push(c);
        chain.push((cursor.clone(), directory(&cursor)?));
    }
    let before = std::fs::symlink_metadata(&path)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.uid() != claudex_core::storage::uid()
        || before.len() > max as u64
        || path.canonicalize()? != path
    {
        bail!("Artifact must be a canonical, bounded, owned single-link regular file.");
    }
    let identity = claudex_core::storage::FileIdentity::from_metadata(&before);
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)?;
    if claudex_core::storage::FileIdentity::from_metadata(&file.metadata()?) != identity {
        bail!("Artifact changed before inspection.");
    }
    let mut bytes = vec![];
    file.by_ref().take(max as u64 + 1).read_to_end(&mut bytes)?;
    let unchanged = || -> Result<()> {
        if claudex_core::storage::FileIdentity::from_metadata(&std::fs::symlink_metadata(&path)?)
            != identity
            || path.canonicalize()? != path
        {
            bail!("Artifact changed during inspection.");
        }
        for (path, id) in &chain {
            if directory(path)? != *id {
                bail!("Artifact directory changed during inspection.");
            }
        }
        Ok(())
    };
    if bytes.len() > max
        || bytes.len() as u64 != before.len()
        || claudex_core::storage::FileIdentity::from_metadata(&file.metadata()?) != identity
    {
        bail!("Artifact changed during inspection or exceeded its bound.");
    }
    unchanged()?;
    let mut content = String::from_utf8(bytes.clone())?;
    if content.contains('\0') {
        bail!("Binary artifacts are not supported by this text reader.");
    }
    if view == "diff" {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotePath=true",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
        ])
        .arg(&path)
        .current_dir(path.parent().unwrap())
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or("/usr/bin:/bin".into()),
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut output = vec![];
        let mut errors = vec![];
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut stdout = stdout.take(max as u64 + 1);
            let mut stderr = stderr.take(4097);
            let (out, err) = tokio::join!(
                stdout.read_to_end(&mut output),
                stderr.read_to_end(&mut errors)
            );
            out?;
            err?;
            if output.len() > max || errors.len() > 4096 {
                bail!("Artifact diff exceeded its output bound.");
            }
            if !child.wait().await?.success() {
                bail!("Bounded artifact diff is unavailable; the file must be in a Git worktree.");
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        unchanged()?;
        content = String::from_utf8(output)?;
    }
    let mut result = json!({"taskId":task["id"],"generation":generation,"reference":reference,"path":path,"view":view,"content":content,"encoding":"utf8","bytes":bytes.len(),"sha256":hash(&bytes),"observedAt":now(),"identity":identity,"provenance":"file-observed","attribution":"unknown","declaration":{"generation":generation,"provenance":declaration.get("provenance").cloned().unwrap_or(json!("worker-self-reported"))}});
    if view == "diff" {
        result["comparison"] = json!("working-tree-versus-index");
        result["diffBytes"] = json!(content.len());
        result["limitation"] = json!(
            "An empty diff is not evidence of an unchanged or tracked file. Shared checkout changes have unknown authorship."
        );
    }
    Ok(result)
}
