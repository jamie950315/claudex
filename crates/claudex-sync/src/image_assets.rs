//! Lossless native-preview bindings. Native transcripts remain untouched.
use crate::{history::digest_bytes, owner::normalize_content, packet};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use claudex_core::{
    storage::{self, FileIdentity, FileLock},
    version::VersionPolicy,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
const LIMIT: usize = 64 * 1024 * 1024;
fn private_file(path: &Path) -> Result<Vec<u8>> {
    let data = storage::read_stable_with_limit(path, LIMIT)?;
    ensure!(
        data.identity.uid == storage::uid().to_string()
            && data.identity.nlink == "1"
            && data.identity.mode.parse::<u32>()? & 0o77 == 0,
        "Image asset must be private, owned, regular and single-link."
    );
    Ok(data.bytes)
}
fn directory(path: &Path, private: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == storage::uid()
            && metadata.mode() & (if private { 0o77 } else { 0o22 }) == 0,
        "Image cache directory has unsafe ownership or permissions."
    );
    Ok(())
}
fn asset_directory(root: &Path, create: bool) -> Result<PathBuf> {
    ensure!(root.is_absolute(), "Image asset root must be absolute.");
    storage::require_private_directory(root)?;
    let path = root.join("image-assets");
    if create {
        storage::private_directory(&path)?;
    }
    storage::require_private_directory(&path)?;
    Ok(path)
}
fn store(root: &Path, hash: &str, bytes: &[u8]) -> Result<()> {
    let directory = asset_directory(root, true)?;
    let _lock = FileLock::acquire(directory.join(".write.lock"), true)?;
    let path = directory.join(hash);
    if matches!(fs::symlink_metadata(&path),Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        storage::publish_exclusive(&path, bytes)?;
    }
    ensure!(
        private_file(&path)? == bytes,
        "Original image asset changed or collided."
    );
    Ok(())
}
fn harden_project(path: &Path) -> Result<()> {
    let before = fs::symlink_metadata(path)?;
    let identity = FileIdentity::from_metadata(&before);
    ensure!(
        before.is_dir()
            && !before.file_type().is_symlink()
            && before.uid() == storage::uid()
            && matches!(before.mode() & 0o7777, 0o700 | 0o755),
        "Native image project has unexpected permissions."
    );
    if before.mode() & 0o7777 == 0o700 {
        return Ok(());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)?;
    ensure!(
        FileIdentity::from_metadata(&file.metadata()?) == identity
            && FileIdentity::from_metadata(&fs::symlink_metadata(path)?) == identity,
        "Native image project changed before hardening."
    );
    file.set_permissions(fs::Permissions::from_mode(0o700))?;
    let after = FileIdentity::from_metadata(&file.metadata()?);
    ensure!(
        after.same_inode(&identity)
            && after.mode.parse::<u32>()? & 0o7777 == 0o700
            && after == FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
        "Native image project changed during hardening."
    );
    Ok(())
}
fn original(temp: &Path, cwd: &str, id: &str, paste: u64, media: &str) -> Result<Vec<u8>> {
    ensure!(
        temp.is_absolute() && Path::new(cwd).is_absolute() && uuid::Uuid::parse_str(id).is_ok(),
        "Invalid native image cache identity."
    );
    let project = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    ensure!(
        project.len() <= 200,
        "Native image project key is too long."
    );
    directory(temp, true)?;
    let project = temp.join(project);
    harden_project(&project)?;
    let session = project.join(id);
    let images = session.join("images");
    directory(&session, false)?;
    directory(&images, false)?;
    let extensions: &[&str] = match media {
        "image/png" => &["png"],
        "image/jpeg" => &["jpg", "jpeg"],
        _ => anyhow::bail!("Unsupported native original image type."),
    };
    let mut found = None;
    for extension in extensions {
        let path = images.join(format!("{paste}.{extension}"));
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                ensure!(found.is_none(), "Ambiguous native image cache asset.");
                found = Some(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    private_file(
        &found.ok_or_else(|| anyhow::anyhow!("Original native image cache asset is missing."))?,
    )
}
fn image_bytes(image: &Value) -> Result<Vec<u8>> {
    packet::validate_image(image)?;
    Ok(STANDARD.decode(image["source"]["data"].as_str().unwrap())?)
}
fn png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
}
fn jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 5 && bytes.starts_with(&[255, 216, 255]) && bytes.ends_with(&[255, 217])
}
fn conversion(original: &str, rendered: &str) -> bool {
    original == "image/png" && rendered == "image/jpeg"
}
pub fn capture(
    root: &Path,
    temp: &Path,
    cwd: &str,
    id: &str,
    row: &Value,
    expected: &Value,
    expected_hash: &Value,
    policy: VersionPolicy,
) -> Result<(Value, Value)> {
    let expected = normalize_content(expected)?;
    let rendered = normalize_content(&row["message"]["content"])?;
    ensure!(
        packet::hex_digest(expected_hash)
            && storage::hash_json(&expected)? == expected_hash.as_str().unwrap(),
        "Invalid durable expected image append."
    );
    let expected = expected.as_array().unwrap();
    let rendered = rendered.as_array().unwrap();
    ensure!(
        expected.len() == rendered.len(),
        "Native image append length differs from durable intent."
    );
    if expected == rendered {
        return Ok((row.clone(), json!({})));
    }
    ensure!(
        row["queueTranscriptOnly"] == true
            && row["promptSource"] == "sdk"
            && row["version"]
                .as_str()
                .is_some_and(|v| policy.permits(v, Some("2.1.281"))),
        "Unsupported native image append provenance."
    );
    let images = expected.iter().filter(|b| b["type"] == "image").count();
    let paste = row["imagePasteIds"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing native image paste identities."))?;
    ensure!(
        images > 0
            && paste.len() == images
            && paste
                .iter()
                .all(|v| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
            && paste
                .iter()
                .filter_map(Value::as_u64)
                .collect::<HashSet<_>>()
                .len()
                == images,
        "Native paste identities differ from durable image intent."
    );
    let mut restored = rendered.clone();
    let mut bindings = json!({});
    let mut originals = vec![];
    let mut image = 0;
    for (index, expected) in expected.iter().enumerate() {
        let preview = &rendered[index];
        if expected["type"] != "image" {
            ensure!(
                expected == preview,
                "Native append changed nonimage content."
            );
            continue;
        }
        let media = expected["source"]["media_type"].as_str().unwrap_or("");
        let rendered_media = preview["source"]["media_type"].as_str().unwrap_or("");
        ensure!(
            preview["type"] == "image"
                && preview["source"]["type"] == "base64"
                && (media == rendered_media || conversion(media, rendered_media)),
            "Native image preview type differs from durable intent."
        );
        let preview_bytes = image_bytes(preview)?;
        let paste = paste[image].as_u64().unwrap();
        image += 1;
        if expected == preview {
            continue;
        }
        let bytes = original(temp, cwd, id, paste, media)?;
        ensure!(
            bytes == image_bytes(expected)?,
            "Native original cache differs from durable image intent."
        );
        let converted = media != rendered_media;
        ensure!(
            !converted || png(&bytes) && jpeg(&preview_bytes),
            "Native PNG-to-JPEG signatures differ from durable intent."
        );
        let hash = digest_bytes(&bytes);
        let mut binding =
            json!({"assetHash":hash,"mediaType":media,"renderedHash":storage::hash_json(preview)?});
        if converted {
            binding["renderedMediaType"] = json!(rendered_media);
        }
        bindings[index.to_string()] = binding;
        originals.push((hash, bytes));
        restored[index] = expected.clone();
    }
    ensure!(
        storage::hash_json(&normalize_content(&json!(restored))?)?
            == expected_hash.as_str().unwrap(),
        "Restored native append differs from durable intent."
    );
    for (hash, bytes) in originals {
        store(root, &hash, &bytes)?;
    }
    let mut row = row.clone();
    row["message"]["content"] = json!(restored);
    Ok((row, bindings))
}
pub fn restore(root: &Path, rows: &[Value], bindings: &Value) -> Result<Vec<Value>> {
    let bindings = bindings
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Invalid saved image bindings."))?;
    let mut restored = rows.to_vec();
    for row in &mut restored {
        let Some(bound) = row["uuid"].as_str().and_then(|id| bindings.get(id)) else {
            continue;
        };
        uuid::Uuid::parse_str(row["uuid"].as_str().unwrap())?;
        let content = row["message"]["content"]
            .as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("Bound image row lacks content."))?;
        for (index, binding) in bound
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Invalid saved per-message image bindings."))?
        {
            let position = index.parse::<usize>()?;
            ensure!(
                position.to_string() == *index
                    && position < content.len()
                    && packet::hex_digest(&binding["assetHash"])
                    && packet::hex_digest(&binding["renderedHash"]),
                "Invalid saved image binding identity."
            );
            let media = binding["mediaType"].as_str().unwrap_or("");
            let rendered_media = binding
                .get("renderedMediaType")
                .and_then(Value::as_str)
                .unwrap_or(media);
            ensure!(
                matches!(media, "image/png" | "image/jpeg")
                    && (binding.get("renderedMediaType").is_none()
                        || conversion(media, rendered_media)),
                "Unsupported saved image conversion."
            );
            let preview = normalize_content(&json!([content[position]]))?[0].clone();
            ensure!(
                preview["type"] == "image"
                    && preview["source"]["media_type"] == rendered_media
                    && storage::hash_json(&preview)? == binding["renderedHash"],
                "Bound native image preview changed."
            );
            let bytes = private_file(
                &asset_directory(root, false)?.join(binding["assetHash"].as_str().unwrap()),
            )?;
            ensure!(
                digest_bytes(&bytes) == binding["assetHash"],
                "Saved original image asset hash changed."
            );
            ensure!(
                media == rendered_media || png(&bytes) && jpeg(&image_bytes(&preview)?),
                "Saved PNG-to-JPEG signatures differ."
            );
            content[position] = json!({"type":"image","source":{"type":"base64","media_type":media,"data":STANDARD.encode(bytes)}});
        }
    }
    Ok(restored)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) struct Fixture {
        pub temp: tempfile::TempDir,
        pub root: PathBuf,
        pub cache: PathBuf,
        pub cwd: String,
        pub id: String,
        pub row: Value,
        pub expected: Value,
        pub hash: Value,
        pub original: Vec<u8>,
        pub project: PathBuf,
        pub path: PathBuf,
    }
    pub(crate) fn image(media: &str, bytes: &[u8]) -> Value {
        json!({"type":"image","source":{"type":"base64","media_type":media,"data":STANDARD.encode(bytes)}})
    }
    pub(crate) fn fixture(media: &str, large: bool, converted: bool) -> Result<Fixture> {
        let temp = tempfile::tempdir()?;
        let root = storage::private_directory(&temp.path().join("root"))?;
        let cache = storage::private_directory(&temp.path().join("cache"))?;
        let cwd = storage::private_directory(&temp.path().join("cwd"))?
            .to_string_lossy()
            .into_owned();
        let id = uuid::Uuid::new_v4().to_string();
        let project = cache.join(
            cwd.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>(),
        );
        let images = project.join(&id).join("images");
        storage::private_directory(&images)?;
        // The cache's inner directories have the exact observed native modes,
        // not whatever the process umask happens to produce.
        for dir in [&project, images.parent().unwrap(), &images] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o755))?;
        }
        let mut original = if media == "image/png" {
            vec![137, 80, 78, 71, 13, 10, 26, 10]
        } else {
            vec![255, 216, 255]
        };
        original.resize(if large { 11 * 1024 * 1024 / 2 } else { 128 }, b'x');
        if media == "image/jpeg" {
            original.extend_from_slice(&[255, 217]);
        }
        let preview = if converted || media == "image/jpeg" {
            image("image/jpeg", &[255, 216, 255, 0, 255, 217])
        } else {
            image(media, b"preview bytes")
        };
        let expected =
            json!([{"type":"text","text":"Preserve this exact input"},image(media,&original)]);
        let row = json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"sessionId":id,"cwd":cwd,"version":"2.1.281","queueTranscriptOnly":true,"promptSource":"sdk","imagePasteIds":[1],"message":{"role":"user","content":[expected[0],preview]}});
        let hash = json!(storage::hash_json(&expected)?);
        let path = images.join(if media == "image/png" {
            "1.png"
        } else {
            "1.jpg"
        });
        storage::publish_exclusive(&path, &original)?;
        Ok(Fixture {
            temp,
            root,
            cache,
            cwd,
            id,
            row,
            expected,
            hash,
            original,
            project,
            path,
        })
    }
    fn capture_fixture(f: &Fixture) -> Result<(Value, Value)> {
        capture(
            &f.root,
            &f.cache,
            &f.cwd,
            &f.id,
            &f.row,
            &f.expected,
            &f.hash,
            VersionPolicy::Strict,
        )
    }
    #[test]
    fn large_png_and_jpeg_restore_exact_bytes_and_deduplicate() -> Result<()> {
        for media in ["image/png", "image/jpeg"] {
            let f = fixture(media, true, false)?;
            let before = fs::symlink_metadata(&f.project)?;
            let (row, bound) = capture_fixture(&f)?;
            assert_eq!(row["message"]["content"], f.expected);
            let after = fs::symlink_metadata(&f.project)?;
            assert_eq!(before.ino(), after.ino());
            assert_eq!(after.mode() & 0o7777, 0o700);
            assert_eq!(fs::read(&f.path)?, f.original);
            let hash = digest_bytes(&f.original);
            assert_eq!(
                private_file(&f.root.join("image-assets").join(&hash))?,
                f.original
            );
            let mut other = f.row.clone();
            other["uuid"] = json!(uuid::Uuid::new_v4().to_string());
            let (_, second) = capture(
                &f.root,
                &f.cache,
                &f.cwd,
                &f.id,
                &other,
                &f.expected,
                &f.hash,
                VersionPolicy::Strict,
            )?;
            assert_eq!(bound, second);
            let bindings = json!({f.row["uuid"].as_str().unwrap():bound});
            assert_eq!(restore(&f.root, &[f.row.clone()], &bindings)?, vec![row]);
            assert_eq!(fs::read_dir(f.root.join("image-assets"))?.count(), 1);
            fs::remove_file(&f.path)?;
            assert_eq!(
                restore(&f.root, &[f.row.clone()], &bindings)?[0]["message"]["content"],
                f.expected
            );
        }
        Ok(())
    }
    #[test]
    fn png_to_jpeg_requires_exact_paste_bytes_and_both_signatures() -> Result<()> {
        let f = fixture("image/png", false, true)?;
        let (row, bound) = capture_fixture(&f)?;
        assert_eq!(bound["1"]["renderedMediaType"], "image/jpeg");
        let bindings = json!({f.row["uuid"].as_str().unwrap():bound});
        assert_eq!(restore(&f.root, &[f.row.clone()], &bindings)?, vec![row]);
        let mut bad = f.row.clone();
        bad["message"]["content"][1] = image("image/jpeg", b"not JPEG");
        assert!(
            capture(
                &f.root,
                &f.cache,
                &f.cwd,
                &f.id,
                &bad,
                &f.expected,
                &f.hash,
                VersionPolicy::Strict
            )
            .is_err()
        );
        bad = f.row.clone();
        bad["imagePasteIds"] = json!([2]);
        assert!(
            capture(
                &f.root,
                &f.cache,
                &f.cwd,
                &f.id,
                &bad,
                &f.expected,
                &f.hash,
                VersionPolicy::Strict
            )
            .is_err()
        );
        for media in [
            Value::Null,
            json!(""),
            json!("image/png"),
            json!("image/webp"),
        ] {
            let mut bad = bindings.clone();
            bad[f.row["uuid"].as_str().unwrap()]["1"]["renderedMediaType"] = media;
            assert!(restore(&f.root, &[f.row.clone()], &bad).is_err());
        }
        Ok(())
    }
    #[test]
    fn changed_text_preview_original_and_missing_assets_fail_closed() -> Result<()> {
        let f = fixture("image/png", false, false)?;
        let mut bad = f.row.clone();
        bad["message"]["content"][0]["text"] = json!("Changed");
        assert!(
            capture(
                &f.root,
                &f.cache,
                &f.cwd,
                &f.id,
                &bad,
                &f.expected,
                &f.hash,
                VersionPolicy::Strict
            )
            .is_err()
        );
        fs::write(&f.path, b"wrong original")?;
        assert!(capture_fixture(&f).is_err());
        fs::write(&f.path, &f.original)?;
        let (_, bound) = capture_fixture(&f)?;
        let bindings = json!({f.row["uuid"].as_str().unwrap():bound});
        bad = f.row.clone();
        bad["message"]["content"][1] = image("image/png", b"changed preview");
        assert!(restore(&f.root, &[bad], &bindings).is_err());
        let asset = f.root.join("image-assets").join(digest_bytes(&f.original));
        fs::write(&asset, b"wrong authoritative bytes")?;
        assert!(restore(&f.root, &[f.row.clone()], &bindings).is_err());
        fs::remove_file(&asset)?;
        assert!(restore(&f.root, &[f.row.clone()], &bindings).is_err());
        std::os::unix::fs::symlink(&f.path, &asset)?;
        assert!(restore(&f.root, &[f.row.clone()], &bindings).is_err());
        Ok(())
    }
    #[test]
    fn unsafe_cache_modes_and_aliases_are_not_hardened_or_read() -> Result<()> {
        let f = fixture("image/png", false, false)?;
        fs::set_permissions(&f.cache, fs::Permissions::from_mode(0o755))?;
        assert!(capture_fixture(&f).is_err());
        assert_eq!(fs::symlink_metadata(&f.project)?.mode() & 0o7777, 0o755);
        fs::set_permissions(&f.cache, fs::Permissions::from_mode(0o700))?;
        for mode in [0o750, 0o777] {
            fs::set_permissions(&f.project, fs::Permissions::from_mode(mode))?;
            assert!(capture_fixture(&f).is_err());
            assert_eq!(fs::symlink_metadata(&f.project)?.mode() & 0o7777, mode);
        }
        fs::set_permissions(&f.project, fs::Permissions::from_mode(0o755))?;
        let moved = f.project.with_extension("original");
        fs::rename(&f.project, &moved)?;
        std::os::unix::fs::symlink(&moved, &f.project)?;
        assert!(capture_fixture(&f).is_err());
        Ok(())
    }
}
