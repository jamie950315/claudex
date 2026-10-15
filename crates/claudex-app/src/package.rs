//! Pinned official native packages without npm, install scripts, or credentials.
use crate::platform::{self, CommandSpec, Runner, checked};
use anyhow::{Context, Result, ensure};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Component, Path},
    time::Duration,
};
const ARCHIVE_LIMIT: usize = 256 * 1024 * 1024;
pub struct Metadata {
    pub value: Value,
    pub name: String,
    pub version: String,
    pub tarball: String,
    pub integrity: String,
}
fn package_name(name: &str) -> bool {
    let rest = name.strip_prefix('@').unwrap_or(name);
    !rest.is_empty()
        && rest
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/-_.".contains(&c))
        && (!name.starts_with('@') || rest.split('/').count() == 2)
}
fn version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
}
pub async fn metadata(
    name: &str,
    pinned: &str,
    integrity: Option<&str>,
    home: &Path,
    run: &dyn Runner,
) -> Result<Metadata> {
    ensure!(
        package_name(name) && version(pinned),
        "Invalid exact official package reference."
    );
    let url = format!(
        "https://registry.npmjs.org/{}/{}",
        name.replace('/', "%2F"),
        pinned
    );
    let mut spec = CommandSpec::new(
        "/usr/bin/curl",
        [
            "--disable",
            "--proto",
            "=https",
            "--tlsv1.2",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "60",
            "--max-filesize",
            "4194304",
            &url,
        ],
    );
    spec.timeout = Duration::from_secs(65);
    spec.max_bytes = 4 * 1024 * 1024;
    spec.env = environment(home);
    let out = checked(run, spec).await?;
    let value: Value = serde_json::from_str(&out.stdout)?;
    ensure!(
        value["name"] == name && value["version"] == pinned,
        "Official package metadata does not match its exact pinned identity."
    );
    let tarball = value["dist"]["tarball"]
        .as_str()
        .context("Official package tarball is missing.")?
        .to_string();
    let sri = value["dist"]["integrity"]
        .as_str()
        .context("Official package integrity is missing.")?
        .to_string();
    let slug = name.rsplit('/').next().unwrap();
    ensure!(
        tarball == format!("https://registry.npmjs.org/{name}/-/{slug}-{pinned}.tgz")
            && sri.starts_with("sha512-")
            && base64::engine::general_purpose::STANDARD
                .decode(sri.trim_start_matches("sha512-"))
                .is_ok_and(|b| b.len() == 64)
            && integrity.is_none_or(|expected| expected == sri),
        "Official package tarball or integrity does not match the pinned source."
    );
    Ok(Metadata {
        value,
        name: name.into(),
        version: pinned.into(),
        tarball,
        integrity: sri,
    })
}
pub fn environment(home: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.display().to_string()),
        ("LANG".into(), "C.UTF-8".into()),
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
    ])
}
/// Extract only bounded regular files and directories under the package root.
/// Links, duplicate entries and path traversal are never materialized.
fn extract(bytes: &[u8], destination: &Path) -> Result<()> {
    platform::directory(destination, true, false)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut total = 0u64;
    let mut count = 0;
    for entry in archive.entries()? {
        let mut entry = entry?;
        count += 1;
        ensure!(count <= 10000, "Official package exceeds its entry bound.");
        let path = entry.path()?.into_owned();
        ensure!(
            !path.is_absolute()
                && path.components().all(|c| matches!(c, Component::Normal(_)))
                && path
                    .components()
                    .next()
                    .is_some_and(|c| c.as_os_str() == "package")
                && !path.to_string_lossy().chars().any(char::is_control),
            "Unsafe official package entry."
        );
        let target = destination.join(path.strip_prefix("package")?);
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_dir() || kind.is_file(),
            "Official native package contains a link or unsupported archive entry."
        );
        if kind.is_dir() {
            create(&target)?;
            continue;
        }
        let parent = target.parent().context("Missing package entry parent.")?;
        create(parent)?;
        let expected = entry.header().size()?;
        ensure!(
            expected <= 512 * 1024 * 1024 && total.saturating_add(expected) <= 768 * 1024 * 1024,
            "Official package exceeds its expanded byte bound."
        );
        let mode = if entry.header().mode()? & 0o111 != 0 {
            0o700
        } else {
            0o600
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&target)?;
        let written = std::io::copy(&mut Read::by_ref(&mut entry).take(expected + 1), &mut file)?;
        ensure!(written == expected, "Official package entry was truncated.");
        file.flush()?;
        file.sync_all()?;
        total += written;
    }
    ensure!(count > 0, "Official native package archive is empty.");
    Ok(())
}
fn create(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    platform::directory(path, true, false)
}
pub async fn install_package(
    meta: &Metadata,
    destination: &Path,
    home: &Path,
    run: &dyn Runner,
) -> Result<()> {
    platform::directory(destination, true, false)?;
    let archive = destination.join(format!(".download-{}.tgz", uuid::Uuid::new_v4()));
    // curl creates only this random, absent pathname; no inherited npm config,
    // shell environment, authentication file or provider directory is used.
    let mut spec = CommandSpec::new(
        "/usr/bin/curl",
        [
            "--disable",
            "--proto",
            "=https",
            "--tlsv1.2",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "120",
            "--max-filesize",
            "268435456",
            "--no-clobber",
            "--output",
            &archive.to_string_lossy(),
            &meta.tarball,
        ],
    );
    spec.env = environment(home);
    spec.timeout = Duration::from_secs(125);
    checked(run, spec).await?;
    let bytes = platform::safe_bytes(&archive, ARCHIVE_LIMIT, false, false)?;
    let calculated = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes))
    );
    ensure!(
        calculated == meta.integrity,
        "Official native package transfer integrity failed; candidate preserved."
    );
    // The archive name is not part of the package payload. Extract into a new
    // child so an archive cannot overwrite metadata or another staged package.
    let payload = destination.join("payload");
    ensure!(
        !crate::status_app::exists(&payload)?,
        "Native package candidate payload already exists."
    );
    create(&payload)?;
    extract(&bytes, &payload)?;
    let manifest: Value = serde_json::from_slice(&platform::safe_bytes(
        &payload.join("package.json"),
        1024 * 1024,
        true,
        false,
    )?)?;
    ensure!(
        manifest["name"] == meta.name && manifest["version"] == meta.version,
        "Extracted native package metadata does not match its pinned source."
    );
    for key in ["os", "cpu"] {
        if let Some(expected) = meta.value.get(key) {
            ensure!(
                &manifest[key] == expected,
                "Extracted native package platform metadata contradicts the registry."
            );
        }
    }
    platform::publish(&destination.join("source.json"),claudex_core::json::stringify(&json!({"version":1,"name":meta.name,"packageVersion":meta.version,"tarball":meta.tarball,"integrity":meta.integrity}))?.as_bytes(),0o600)?;
    // This exact verified download is generated temporary data, not native state.
    fs::remove_file(&archive)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_refuses_links_and_preserves_regular_executable_modes() -> Result<()> {
        let t = tempfile::tempdir()?;
        let base = fs::canonicalize(t.path())?;
        let build = |link: bool| -> Result<Vec<u8>> {
            let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut tar = tar::Builder::new(encoder);
            let mut h = tar::Header::new_gnu();
            h.set_mode(0o755);
            if link {
                h.set_entry_type(tar::EntryType::Symlink);
                h.set_size(0);
                h.set_link_name("/private/preserved")?;
            } else {
                h.set_size(6);
            }
            h.set_cksum();
            tar.append_data(
                &mut h,
                "package/native",
                if link { &b""[..] } else { &b"native"[..] },
            )?;
            Ok(tar.into_inner()?.finish()?)
        };
        let good = base.join("good");
        create(&good)?;
        extract(&build(false)?, &good)?;
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(good.join("native"))?.permissions().mode() & 0o777,
            0o700
        );
        let bad = base.join("bad");
        create(&bad)?;
        assert!(extract(&build(true)?, &bad).is_err());
        assert!(!bad.join("native").exists());
        Ok(())
    }
}
