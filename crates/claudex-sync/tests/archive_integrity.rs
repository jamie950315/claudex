use claudex_core::storage::{self, FileIdentity};
use claudex_sync::{
    archive::{self, PacketOptions, Reference},
    history::{Message, canonical, digest_bytes, fingerprint},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

fn private_root() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = storage::private_directory(temp.path().join("state")).unwrap();
    chmod(&root, 0o700);
    (temp, root)
}

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn messages(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| {
            Message::text(
                if index % 2 == 0 { "user" } else { "assistant" },
                format!("Message {index:03}: literal \"quote\", backslash \\, 你好 🌙\n"),
            )
        })
        .collect()
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

// Spell out the established wire field order instead of using the archive codec
// or its canonical serializer to construct the compatibility expectation.
fn message_json(message: &Message) -> String {
    format!(
        "{{\"content\":[{{\"text\":{},\"type\":\"text\"}}],\"role\":{}}}",
        quote(message.content[0]["text"].as_str().unwrap()),
        quote(&message.role)
    )
}

fn chunk_reference(hash: &str, bytes: usize) -> String {
    format!("{{\"bytes\":{bytes},\"hash\":{}}}", quote(hash))
}

fn expected_archive(messages: &[Message], version: u8) -> (Reference, BTreeMap<String, Vec<u8>>) {
    let serialized = messages.iter().map(message_json).collect::<Vec<_>>();
    let digest = digest_bytes(format!("[{}]", serialized.join(",")).as_bytes());
    let mut assets = BTreeMap::new();
    let mut references = vec![];
    for message in serialized {
        let bytes =
            format!("{{\"message\":{message},\"type\":\"claudex-history-message\",\"version\":1}}")
                .into_bytes();
        let hash = digest_bytes(&bytes);
        references.push(chunk_reference(&hash, bytes.len()));
        assets.insert(hash, bytes);
    }
    let manifest = if version == 1 {
        format!(
            "{{\"digest\":{},\"messages\":[{}],\"type\":\"claudex-history-archive\",\"version\":1}}",
            quote(&digest),
            references.join(",")
        )
    } else {
        let mut previous = "null".to_string();
        for (page, batch) in references.chunks(64).enumerate() {
            let start = page * 64;
            let bytes = format!(
                "{{\"messages\":[{}],\"previous\":{previous},\"start\":{start},\"type\":\"claudex-history-page\",\"version\":2}}",
                batch.join(",")
            )
            .into_bytes();
            let hash = digest_bytes(&bytes);
            previous = format!(
                "{{\"bytes\":{},\"count\":{},\"hash\":{},\"start\":{start}}}",
                bytes.len(),
                batch.len(),
                quote(&hash)
            );
            assets.insert(hash, bytes);
        }
        format!(
            "{{\"digest\":{},\"messageCount\":{},\"tail\":{previous},\"type\":\"claudex-history-archive\",\"version\":2}}",
            quote(&digest),
            messages.len()
        )
    }
    .into_bytes();
    let reference = Reference {
        version,
        hash: digest_bytes(&manifest),
        bytes: manifest.len(),
        message_count: messages.len(),
        digest,
    };
    assets.insert(reference.hash.clone(), manifest);
    (reference, assets)
}

#[derive(Debug, PartialEq)]
struct Entry {
    identity: FileIdentity,
    bytes: Option<Vec<u8>>,
    symlink: Option<PathBuf>,
}

// Include names, exact identities, modes, link counts and contents. Reads may
// change atime, which is deliberately not part of the persisted file identity.
fn tree(root: &Path) -> BTreeMap<PathBuf, Entry> {
    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        entries.insert(
            path.strip_prefix(root).unwrap().to_path_buf(),
            Entry {
                identity: FileIdentity::from_metadata(&metadata),
                bytes: metadata.is_file().then(|| fs::read(path).unwrap()),
                symlink: metadata
                    .file_type()
                    .is_symlink()
                    .then(|| fs::read_link(path).unwrap()),
            },
        );
        if metadata.is_dir() {
            for child in fs::read_dir(path).unwrap() {
                visit(root, &child.unwrap().path(), entries);
            }
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn rejected_without_writes(root: &Path, archive: &Reference, reason: &str) {
    let before = tree(root);
    let error = archive::load(root, archive).unwrap_err();
    assert!(
        format!("{error:#}").contains(reason),
        "expected {reason:?}, got {error:#}"
    );
    assert_eq!(tree(root), before, "failed load must not modify the root");
}

fn loaded_without_writes(root: &Path, archive: &Reference, expected: &[Message]) {
    let before = tree(root);
    assert_eq!(archive::load(root, archive).unwrap(), expected);
    assert_eq!(tree(root), before, "successful load must remain read-only");
}

fn read_json(root: &Path, hash: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join("history-assets").join(hash)).unwrap()).unwrap()
}

fn write_asset(root: &Path, bytes: &[u8]) -> Value {
    let hash = digest_bytes(bytes);
    let path = root.join("history-assets").join(&hash);
    fs::write(&path, bytes).unwrap();
    chmod(&path, 0o600);
    json!({"hash": hash, "bytes": bytes.len()})
}

fn replace_manifest(root: &Path, archive: &Reference, manifest: &Value) -> Reference {
    let asset = write_asset(root, &canonical(manifest).unwrap());
    Reference {
        hash: asset["hash"].as_str().unwrap().into(),
        bytes: asset["bytes"].as_u64().unwrap() as usize,
        ..archive.clone()
    }
}

fn single_chunk_archive(root: &Path, chunk: &[u8], digest: &str) -> Reference {
    let chunk = write_asset(root, chunk);
    let manifest = json!({"type":"claudex-history-archive", "version":1,
        "digest":digest, "messages":[chunk]});
    let asset = write_asset(root, &canonical(&manifest).unwrap());
    Reference {
        version: 1,
        hash: asset["hash"].as_str().unwrap().into(),
        bytes: asset["bytes"].as_u64().unwrap() as usize,
        message_count: 1,
        digest: digest.into(),
    }
}

fn message_path(root: &Path, archive: &Reference, index: usize) -> PathBuf {
    let manifest = read_json(root, &archive.hash);
    let references = if archive.version == 1 {
        manifest["messages"].as_array().unwrap().clone()
    } else {
        let mut reference = manifest["tail"].clone();
        let mut pages = vec![];
        while !reference.is_null() {
            let page = read_json(root, reference["hash"].as_str().unwrap());
            pages.push(page["messages"].as_array().unwrap().clone());
            reference = page["previous"].clone();
        }
        pages.into_iter().rev().flatten().collect()
    };
    root.join("history-assets")
        .join(references[index]["hash"].as_str().unwrap())
}

#[test]
fn v1_and_three_page_v2_keep_exact_wire_bytes_digests_and_order() {
    let (_temp, root) = private_root();
    let messages = messages(130);
    let key = [7; 32];
    for version in [1, 2] {
        let (expected, assets) = expected_archive(&messages, version);
        assert_eq!(
            expected.digest,
            fingerprint(&messages, messages.len()).unwrap()
        );
        assert_eq!(
            archive::persist(&root, &messages, version).unwrap(),
            expected
        );
        for (hash, bytes) in assets {
            assert_eq!(
                fs::read(root.join("history-assets").join(hash)).unwrap(),
                bytes
            );
        }
        loaded_without_writes(&root, &expected, &messages);
        let options = PacketOptions {
            archive_version: version,
            image_projection_version: 0,
            ..PacketOptions::default()
        };
        let metadata = json!({"conversationId":"conversation-1", "sourceSide":"codex",
            "targetSessionId":"session-1", "operationId":"operation-1", "previousDigest":null});
        let content = archive::encode(&root, &messages, metadata.clone(), &key, &options).unwrap();
        assert_eq!(
            archive::encode(&root, &messages, metadata, &key, &options).unwrap(),
            content
        );
        let before = tree(&root);
        let (decoded, envelope) =
            archive::decode(&root, &content, "conversation-1", "session-1", &key)
                .unwrap()
                .unwrap();
        assert_eq!(decoded, messages);
        assert_eq!(envelope["archive"], serde_json::to_value(expected).unwrap());
        assert_eq!(tree(&root), before, "packet decode must remain read-only");
    }
}

#[test]
fn hash_correct_but_noncanonical_chunk_is_rejected() {
    let (_temp, root) = private_root();
    let messages = messages(1);
    let original = archive::persist(&root, &messages, 1).unwrap();
    let mut noncanonical = fs::read(message_path(&root, &original, 0)).unwrap();
    noncanonical.push(b'\n');
    let forged = single_chunk_archive(&root, &noncanonical, &original.digest);
    rejected_without_writes(&root, &forged, "Noncanonical history archive asset");
    loaded_without_writes(&root, &original, &messages);
}

#[test]
fn valid_hashes_cannot_replace_message_shape_or_semantic_digest() {
    let (_temp, root) = private_root();
    let messages = messages(1);
    let original = archive::persist(&root, &messages, 1).unwrap();
    let wrong_count = Reference {
        message_count: 2,
        ..original.clone()
    };
    rejected_without_writes(&root, &wrong_count, "message coverage mismatch");
    let mut chunk = read_json(
        &root,
        message_path(&root, &original, 0)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
    );
    chunk["message"]["timestamp"] = json!("2026-01-01T00:00:00Z");
    let malformed = single_chunk_archive(&root, &canonical(&chunk).unwrap(), &original.digest);
    rejected_without_writes(&root, &malformed, "Invalid history archive message");

    chunk["message"]
        .as_object_mut()
        .unwrap()
        .remove("timestamp");
    chunk["message"]["content"][0]["text"] = json!("Different valid message");
    let substituted = single_chunk_archive(&root, &canonical(&chunk).unwrap(), &original.digest);
    rejected_without_writes(&root, &substituted, "semantic binding mismatch");
    loaded_without_writes(&root, &original, &messages);
}

#[test]
fn hash_correct_v2_page_still_requires_exact_predecessor_coverage() {
    let (_temp, root) = private_root();
    let messages = messages(130);
    let original = archive::persist(&root, &messages, 2).unwrap();
    let mut manifest = read_json(&root, &original.hash);
    let mut tail = read_json(&root, manifest["tail"]["hash"].as_str().unwrap());
    tail["previous"]["count"] = json!(63);
    let asset = write_asset(&root, &canonical(&tail).unwrap());
    manifest["tail"]["hash"] = asset["hash"].clone();
    manifest["tail"]["bytes"] = asset["bytes"].clone();
    let forged = replace_manifest(&root, &original, &manifest);
    rejected_without_writes(&root, &forged, "page chain coverage mismatch");
    loaded_without_writes(&root, &original, &messages);
}

#[test]
fn private_file_permissions_links_and_symlinks_are_rechecked_after_repair() {
    let (_temp, root) = private_root();
    let messages = messages(70);
    let archive = archive::persist(&root, &messages, 2).unwrap();
    let path = message_path(&root, &archive, 65);

    chmod(&path, 0o644);
    rejected_without_writes(&root, &archive, "private owned single-link file");
    chmod(&path, 0o600);
    loaded_without_writes(&root, &archive, &messages);

    let alias = root.join("hardlink-alias");
    fs::hard_link(&path, &alias).unwrap();
    rejected_without_writes(&root, &archive, "private owned single-link file");
    fs::remove_file(&alias).unwrap();
    loaded_without_writes(&root, &archive, &messages);

    let saved = root.join("saved-chunk");
    fs::rename(&path, &saved).unwrap();
    symlink(&saved, &path).unwrap();
    rejected_without_writes(&root, &archive, "symlink");
    fs::remove_file(&path).unwrap();
    fs::rename(&saved, &path).unwrap();
    loaded_without_writes(&root, &archive, &messages);
}

#[test]
fn private_directory_permissions_and_symlinks_are_rechecked_after_repair() {
    let (_temp, root) = private_root();
    let messages = messages(2);
    let archive = archive::persist(&root, &messages, 2).unwrap();
    let assets = root.join("history-assets");

    chmod(&root, 0o755);
    rejected_without_writes(&root, &archive, "owner-only");
    chmod(&root, 0o700);
    loaded_without_writes(&root, &archive, &messages);

    chmod(&assets, 0o755);
    rejected_without_writes(&root, &archive, "owner-only");
    chmod(&assets, 0o700);
    loaded_without_writes(&root, &archive, &messages);

    let saved = root.join("saved-assets");
    fs::rename(&assets, &saved).unwrap();
    symlink(&saved, &assets).unwrap();
    rejected_without_writes(&root, &archive, "symlink");
    fs::remove_file(&assets).unwrap();
    fs::rename(&saved, &assets).unwrap();
    loaded_without_writes(&root, &archive, &messages);
}

#[test]
fn changed_or_missing_chunks_fail_read_only_and_recover_on_the_same_root() {
    let (_temp, root) = private_root();
    let messages = messages(70);
    let archive = archive::persist(&root, &messages, 2).unwrap();
    let path = message_path(&root, &archive, 65);
    let original = fs::read(&path).unwrap();
    let mut changed = original.clone();
    // Keep the byte count identical so a missing digest check cannot pass.
    let position = changed.windows(7).position(|w| w == b"Message").unwrap();
    changed[position] = b'm';
    fs::write(&path, changed).unwrap();
    chmod(&path, 0o600);
    rejected_without_writes(&root, &archive, "content changed");
    fs::write(&path, &original).unwrap();
    chmod(&path, 0o600);
    loaded_without_writes(&root, &archive, &messages);

    let saved = root.join("temporarily-missing-chunk");
    fs::rename(&path, &saved).unwrap();
    let before = tree(&root);
    assert!(archive::load(&root, &archive).is_err());
    assert_eq!(tree(&root), before, "missing chunk must not be regenerated");
    fs::rename(&saved, &path).unwrap();
    loaded_without_writes(&root, &archive, &messages);
}
