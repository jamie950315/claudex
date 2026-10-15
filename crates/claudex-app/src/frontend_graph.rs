//! Read-only discovery of the newest fetched native HTTP-cache module graph.
//! Cache timestamps identify fetch recency, never live renderer activation.
use crate::{
    cache,
    cache_install::{self, Manifest, Phase, Snapshot},
    frontend_ast,
    frontend_bindings::{Index, ModuleGraph},
    platform,
};
use anyhow::{Context, Result, ensure};
use claudex_core::storage::FileIdentity;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub const ASSET_ROOT: &str = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/";
const MAX_MODULES: usize = 2048;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const WINDOWS_EPOCH: i64 = 11644473600000000;

#[derive(Debug)]
pub struct GraphFailure {
    pub code: &'static str,
    pub reason: &'static str,
}
impl std::fmt::Display for GraphFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Claude frontend graph: {}", self.reason)
    }
}
impl std::error::Error for GraphFailure {}
fn fail(code: &'static str, reason: &'static str) -> anyhow::Error {
    GraphFailure { code, reason }.into()
}
pub fn error_code(error: &anyhow::Error) -> Option<&'static str> {
    error
        .chain()
        .find_map(|error| error.downcast_ref::<GraphFailure>().map(|error| error.code))
}
fn changed(reason: &'static str) -> anyhow::Error {
    fail("CLAUDEX_FRONTEND_CACHE_CHANGED", reason)
}
fn native<T>(value: Result<T>) -> Result<T> {
    value.map_err(|error| {
        if cache_install::changed_path(&error).is_some() {
            changed("native cache resource changed during snapshot")
        } else if claudex_core::storage::is_not_found(&error) {
            fail(
                "CLAUDEX_FRONTEND_CACHE_MISSING",
                "native cache resource disappeared",
            )
        } else {
            error
        }
    })
}
fn evidence<T>(value: Result<T>) -> Result<T> {
    value.map_err(|error| {
        if claudex_core::storage::is_not_found(&error) {
            fail(
                "CLAUDEX_FRONTEND_EVIDENCE_MISSING",
                "required resource recovery evidence disappeared",
            )
        } else {
            error
        }
    })
}
pub fn cache_directory(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Claude/Cache/Cache_Data")
}
pub fn asset_url(value: &str) -> bool {
    crate::frontend_bindings::asset_url(value)
}
pub fn resolve_import(base: &str, spec: &str) -> Option<String> {
    let resolved = url::Url::parse(base).ok()?.join(spec).ok()?.to_string();
    asset_url(&resolved).then_some(resolved)
}
pub fn cache_filename(value: &str) -> bool {
    value.len() == 18
        && value.ends_with("_0")
        && value.as_bytes()[..16]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}
fn directory(path: &Path) -> Result<FileIdentity> {
    native((|| {
        platform::directory(path, true, false)?;
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.mode() & 0o7777 == 0o700,
            "Claude frontend graph: cache directory must have mode 0700."
        );
        Ok(FileIdentity::from_metadata(&metadata))
    })())
}
fn identity(path: &Path) -> Result<FileIdentity> {
    native(
        fs::symlink_metadata(path)
            .map(|m| FileIdentity::from_metadata(&m))
            .map_err(Into::into),
    )
}
/// Read the key only, not an unrelated HTTP/image body. The file remains exact
/// through both the descriptor and named path even when it is not JavaScript.
fn key_url(path: &Path) -> Result<Option<String>> {
    native((|| {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.uid() == platform::uid()
                && metadata.nlink() == 1
                && metadata.mode() & 0o7777 == 0o600,
            "Claude frontend graph: cache inventory file must be private, owned, regular and single-linked."
        );
        let before = FileIdentity::from_metadata(&metadata);
        let result = (|| -> Result<Option<String>> {
            let mut header = Vec::with_capacity(24);
            let mut result = None;
            let read = Read::by_ref(&mut file).take(24).read_to_end(&mut header)?;
            if read == 24
                && u64::from_le_bytes(header[..8].try_into()?) == 0xfcfb6d1ba7725c30
                && u32::from_le_bytes(header[8..12].try_into()?) == 5
            {
                let length = u32::from_le_bytes(header[12..16].try_into()?) as usize;
                if (1..=4096).contains(&length) {
                    let mut key = vec![0; length];
                    file.read_exact(&mut key)
                        .context("Claude frontend graph: cache key truncated.")?;
                    if let Ok(key) = std::str::from_utf8(&key) {
                        result = key
                            .strip_prefix("1/0/")
                            .filter(|url| asset_url(url))
                            .map(str::to_owned);
                    }
                }
            }
            Ok(result)
        })();
        if before != FileIdentity::from_metadata(&file.metadata()?) || before != identity(path)? {
            return Err(changed("cache inventory changed while reading"));
        }
        result
    })())
}
fn snapshot(path: &Path, limit: usize) -> Result<Snapshot> {
    native(cache_install::snapshot(path, limit))
}
fn response_time(metadata: &[u8]) -> Result<i64> {
    ensure!(
        metadata.len() >= 40
            && u32::from_le_bytes(metadata[0..4].try_into()?) as usize == metadata.len() - 4
            && u32::from_le_bytes(metadata[4..8].try_into()?) & 255 == 3
            && u32::from_le_bytes(metadata[8..12].try_into()?) == 6,
        "Claude frontend graph: unsupported HTTP response time encoding."
    );
    let request = i64::from_le_bytes(metadata[12..20].try_into()?);
    let response = i64::from_le_bytes(metadata[20..28].try_into()?);
    let original = i64::from_le_bytes(metadata[28..36].try_into()?);
    let upper = WINDOWS_EPOCH + (chrono::Utc::now().timestamp_millis() + 86_400_000) * 1000;
    ensure!(
        request >= WINDOWS_EPOCH
            && response >= request
            && original >= WINDOWS_EPOCH
            && original <= response
            && response <= upper,
        "Claude frontend graph: invalid HTTP response times."
    );
    Ok(response)
}
fn original_entry(
    root: &Path,
    name: &str,
    path: &Path,
    current: &Snapshot,
    url: &str,
) -> Result<(cache::Entry, Vec<u8>)> {
    for adapter in ["ui-folders", "ui-chat-wake", "ui-owner-wake", "ui-commands"] {
        let owner = root.join(adapter).join(name);
        let state = owner.join("ui-folder-compat");
        let manifest_path = state.join("manifest.json");
        match fs::symlink_metadata(&manifest_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            other => {
                other?;
            }
        }
        let receipt = evidence(cache_install::snapshot(&manifest_path, 16 * 1024))?;
        let manifest: Manifest = serde_json::from_slice(&receipt.bytes)?;
        manifest.validate(&owner, path, &manifest.source_hash)?;
        ensure!(
            current.hash == manifest.original_hash
                || current.hash == manifest.patched_hash
                || manifest.phase == Phase::Prepared
                    && manifest.previous_patched_hash.as_ref() == Some(&current.hash),
            "Claude frontend graph: resource journal or cache ownership changed."
        );
        let original = evidence(cache_install::snapshot(
            &state.join("original.cache"),
            cache::MAX_CACHE_BYTES,
        ))?;
        let entry = cache::inspect(&original.bytes, Some(url))?;
        ensure!(
            original.hash == manifest.original_hash && entry.source_hash == manifest.source_hash,
            "Claude frontend graph: resource original changed."
        );
        let latest = evidence(cache_install::snapshot(&manifest_path, 16 * 1024))?;
        ensure!(
            latest.identity == receipt.identity && latest.hash == receipt.hash,
            "Claude frontend graph: resource journal changed during discovery."
        );
        return Ok((entry, original.bytes));
    }
    let entry = cache::inspect(&current.bytes, Some(url))?;
    ensure!(
        !entry.source.contains("[Claudex ") && !entry.source.contains("__cldx"),
        "Claude frontend graph: unowned patched resource."
    );
    Ok((entry, current.bytes.clone()))
}

pub struct Module {
    pub name: String,
    pub path: PathBuf,
    pub url: String,
    pub source: String,
    pub source_hash: String,
    pub current_hash: String,
    pub identity: FileIdentity,
    pub original_bytes: Vec<u8>,
    pub imports: Vec<String>,
    pub eager_imports: Vec<String>,
    pub provenance: Index,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub asset: String,
    pub cache_filename: String,
    pub fetched_at: String,
}
pub struct Graph {
    pub entry: EntrySummary,
    pub entry_url: String,
    pub modules: BTreeMap<String, Module>,
    pub missing: BTreeSet<String>,
}
impl ModuleGraph for Graph {
    fn source(&self, url: &str) -> Option<&str> {
        self.modules.get(url).map(|m| m.source.as_str())
    }
    fn index(&self, url: &str) -> Option<&Index> {
        self.modules.get(url).map(|m| &m.provenance)
    }
}
impl Graph {
    pub fn eager_urls(&self) -> BTreeSet<String> {
        let mut eager = BTreeSet::new();
        let mut pending = vec![self.entry_url.clone()];
        while let Some(url) = pending.pop() {
            let Some(module) = self.modules.get(&url) else {
                continue;
            };
            if !eager.insert(url.clone()) {
                continue;
            }
            pending.extend(
                module
                    .eager_imports
                    .iter()
                    .filter_map(|spec| resolve_import(&url, spec)),
            );
        }
        eager
    }
}
pub fn capture_hints(graph: &Graph) -> BTreeMap<String, FileIdentity> {
    graph
        .modules
        .values()
        .map(|m| (m.name.clone(), m.identity.clone()))
        .collect()
}
pub fn changed_hint(
    home: &Path,
    filename: &str,
    observations: &BTreeMap<String, FileIdentity>,
) -> Result<bool> {
    if !cache_filename(filename) {
        return Ok(false);
    }
    let cache = cache_directory(home);
    directory(&cache)?;
    let path = cache.join(filename);
    let current = match fs::symlink_metadata(&path) {
        Ok(metadata) => FileIdentity::from_metadata(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(observations.contains_key(filename));
        }
        Err(error) => return Err(error.into()),
    };
    if observations.get(filename) == Some(&current) {
        return Ok(false);
    }
    Ok(key_url(&path)?.is_some() || observations.contains_key(filename))
}
pub fn verify(graph: &Graph) -> Result<()> {
    for module in graph.modules.values() {
        if identity(&module.path)? != module.identity {
            return Err(changed("graph changed before publication"));
        }
    }
    Ok(())
}
/// No downloads, vendor evaluation, patch publication, histories or inference.
pub fn discover(root: &Path, home: &Path) -> Result<Graph> {
    let cache = cache_directory(home);
    let before = directory(&cache)?;
    let mut names = Vec::new();
    for entry in native(fs::read_dir(&cache).map_err(Into::into))? {
        let entry = native(entry.map_err(Into::into))?;
        ensure!(
            names.len() < 32768,
            "Claude frontend graph: cache inventory exceeds its bound."
        );
        names.push(entry.file_name());
    }
    let mut inventory = BTreeMap::new();
    for name in names
        .iter()
        .filter_map(|n| n.to_str())
        .filter(|n| cache_filename(n))
    {
        let path = cache.join(name);
        if let Some(url) = key_url(&path)? {
            ensure!(
                inventory.insert(url, (name.to_owned(), path)).is_none(),
                "Claude frontend graph: duplicate resource URLs."
            );
        }
    }
    let mut entries = vec![];
    for (url, (name, path)) in &inventory {
        let asset = url.strip_prefix(ASSET_ROOT).unwrap();
        if asset.starts_with("index-") && asset.len() > 9 {
            let snap = snapshot(path, cache::MAX_CACHE_BYTES)?;
            let entry = cache::inspect(&snap.bytes, Some(url))?;
            ensure!(
                entry.source.contains("document.getElementById(\"root\")"),
                "Claude frontend graph: entry bootstrap anchor changed."
            );
            entries.push((
                response_time(&entry.metadata)?,
                url.clone(),
                name.clone(),
                path.clone(),
                snap.identity,
            ));
        }
    }
    let newest = entries
        .iter()
        .map(|entry| entry.0)
        .max()
        .ok_or_else(|| fail("CLAUDEX_FRONTEND_CACHE_MISSING", "entry is not cached"))?;
    entries.retain(|entry| entry.0 == newest);
    ensure!(
        entries.len() == 1,
        "Claude frontend graph: latest fetched entry missing or ambiguous."
    );
    let (_, entry_url, entry_name, entry_path, entry_identity) = entries.pop().unwrap();
    let mut modules = BTreeMap::new();
    let mut missing = BTreeSet::new();
    let mut pending = vec![entry_url.clone()];
    let mut bytes = 0usize;
    while let Some(url) = pending.pop() {
        if modules.contains_key(&url) || missing.contains(&url) {
            continue;
        }
        let Some((name, path)) = inventory.get(&url) else {
            missing.insert(url);
            ensure!(
                missing.len() <= MAX_MODULES,
                "Claude frontend graph: missing imports exceed their bound."
            );
            continue;
        };
        ensure!(
            modules.len() < MAX_MODULES,
            "Claude frontend graph: import graph exceeds its bound."
        );
        let current = snapshot(path, cache::MAX_CACHE_BYTES)?;
        bytes += current.bytes.len();
        ensure!(
            bytes <= MAX_BYTES,
            "Claude frontend graph: graph bytes exceed their bound."
        );
        let (entry, original_bytes) = original_entry(root, name, path, &current, &url)?;
        let ast = frontend_ast::syntax(&entry.source)?;
        let imports = frontend_ast::imports(&ast, false);
        let eager_imports = frontend_ast::imports(&ast, true);
        let provenance = Index::compact(&ast);
        drop(ast);
        pending.extend(imports.iter().filter_map(|spec| resolve_import(&url, spec)));
        modules.insert(
            url.clone(),
            Module {
                name: name.clone(),
                path: path.clone(),
                url,
                source: entry.source,
                source_hash: entry.source_hash,
                current_hash: current.hash,
                identity: current.identity,
                original_bytes,
                imports,
                eager_imports,
                provenance,
            },
        );
    }
    let after = directory(&cache)?;
    if before.dev != after.dev || before.ino != after.ino {
        return Err(changed("cache directory identity changed"));
    }
    let fetched_at = chrono::DateTime::from_timestamp_millis((newest - WINDOWS_EPOCH) / 1000)
        .context("Invalid frontend fetch timestamp.")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let graph = Graph {
        entry: EntrySummary {
            asset: entry_url.strip_prefix(ASSET_ROOT).unwrap().into(),
            cache_filename: entry_name,
            fetched_at,
        },
        entry_url,
        modules,
        missing,
    };
    verify(&graph)?;
    if identity(&entry_path)? != entry_identity {
        return Err(changed("entry changed during discovery"));
    }
    Ok(graph)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cache_install::{Action, InstallOptions, Transform},
        frontend_bindings::Resolver,
    };
    use sha2::{Digest, Sha256};
    use std::{
        os::unix::fs::PermissionsExt,
        time::{Duration, SystemTime},
    };

    const FETCH_TIME: i64 = WINDOWS_EPOCH + 1_700_000_000_000_000;
    const BOOT: &str = "document.getElementById(\"root\");";

    #[test]
    fn only_native_snapshot_races_receive_transient_classification() {
        let path = PathBuf::from("/synthetic/native-cache");
        let error =
            native::<()>(Err(cache_install::ChangedResource(path.clone()).into())).unwrap_err();
        assert_eq!(error_code(&error), Some("CLAUDEX_FRONTEND_CACHE_CHANGED"));
        let evidence_error =
            evidence::<()>(Err(cache_install::ChangedResource(path).into())).unwrap_err();
        assert_eq!(error_code(&evidence_error), None);
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        root: PathBuf,
        cache: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let home = fs::canonicalize(temp.path()).unwrap();
            let root = home.join("state");
            let cache = cache_directory(&home);
            platform::create_private(&root).unwrap();
            platform::create_private(&cache).unwrap();
            Self {
                _temp: temp,
                home,
                root,
                cache,
            }
        }
        fn put(&self, number: usize, asset: &str, source: &str, time: i64) -> PathBuf {
            let path = self.cache.join(format!("{number:016x}_0"));
            platform::publish(&path, &container(asset, source, time), 0o600).unwrap();
            path
        }
        fn discover(&self) -> Result<Graph> {
            discover(&self.root, &self.home)
        }
    }

    /// Retain the production codec's opaque response tail, rebinding only the
    /// synthetic URL and HTTP times with their required native checksums.
    fn container(asset: &str, source: &str, time: i64) -> Vec<u8> {
        let bytes = cache::tests::fixture(source);
        let entry = cache::inspect(&bytes, None).unwrap();
        let key = format!("1/0/{ASSET_ROOT}{asset}").into_bytes();
        let mut result = bytes[..24].to_vec();
        result[12..16].copy_from_slice(&(key.len() as u32).to_le_bytes());
        result.extend(&key);
        result.extend(&bytes[entry.start..entry.body_end + 24]);
        let mut metadata = entry.metadata;
        for offset in [12, 20, 28] {
            metadata[offset..offset + 8].copy_from_slice(&time.to_le_bytes());
        }
        result.extend(&metadata);
        result.extend(Sha256::digest(&key));
        let mut footer = bytes[bytes.len() - 24..].to_vec();
        footer[12..16].copy_from_slice(&cache::crc32(&metadata).to_le_bytes());
        result.extend(footer);
        cache::inspect(&result, Some(&format!("{ASSET_ROOT}{asset}"))).unwrap();
        result
    }

    #[test]
    fn newest_response_not_mtime_and_static_closure_has_compact_provenance() {
        let fixture = Fixture::new();
        let old = fixture.put(1, "index-old.js", BOOT, FETCH_TIME);
        let new = fixture.put(2, "index-new.js", &format!("import {{L}} from './reexport.js'; import('./dialog.js'); import('./missing.js'); {BOOT}"), FETCH_TIME + 1_000_000);
        fixture.put(
            3,
            "reexport.js",
            "export {N as L} from './native.js';",
            FETCH_TIME,
        );
        fixture.put(
            4,
            "native.js",
            "const N=globalThis[\"claude.web\"]?.LocalSessions; export {N};",
            FETCH_TIME,
        );
        fixture.put(5, "dialog.js", "export const label='forkSession reopenClosed amber_tributary_lantern_overview_toggle';", FETCH_TIME);
        fs::File::open(&old)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_900_000_000)),
            )
            .unwrap();
        fs::File::open(&new)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000)),
            )
            .unwrap();

        let graph = fixture.discover().unwrap();
        assert_eq!(graph.entry.asset, "index-new.js");
        assert_eq!(graph.entry.fetched_at, "2023-11-14T22:13:21.000Z");
        assert_eq!(graph.modules.len(), 4);
        assert_eq!(
            graph.missing,
            BTreeSet::from([format!("{ASSET_ROOT}missing.js")])
        );
        let eager = graph.eager_urls();
        assert_eq!(eager.len(), 3);
        assert!(!eager.contains(&format!("{ASSET_ROOT}dialog.js")));
        let entry = &graph.modules[&graph.entry_url];
        let resolver = Resolver::new(&entry.source, &entry.url, &graph).unwrap();
        let native = resolver.local("L").unwrap().unwrap();
        assert_eq!(native.module, format!("{ASSET_ROOT}native.js"));
        assert_eq!(native.local, "N");
        assert_eq!(
            crate::frontend_ast::kind(&resolver.definition(&native).unwrap()),
            "VariableDeclarator"
        );
        verify(&graph).unwrap();
    }

    #[test]
    fn hints_detect_exact_replacement_eviction_and_ignore_unrelated_keys() {
        let fixture = Fixture::new();
        let path = fixture.put(1, "index-test.js", BOOT, FETCH_TIME);
        let graph = fixture.discover().unwrap();
        let hints = capture_hints(&graph);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(!changed_hint(&fixture.home, name, &hints).unwrap());
        assert!(!changed_hint(&fixture.home, "index", &hints).unwrap());
        let unrelated = fixture.cache.join("0000000000000002_0");
        platform::publish(&unrelated, b"unrelated", 0o600).unwrap();
        assert!(!changed_hint(&fixture.home, "0000000000000002_0", &hints).unwrap());
        let replacement = fixture.cache.join("replacement");
        platform::publish(&replacement, &fs::read(&path).unwrap(), 0o600).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert!(changed_hint(&fixture.home, name, &hints).unwrap());
        assert_eq!(
            error_code(&verify(&graph).unwrap_err()),
            Some("CLAUDEX_FRONTEND_CACHE_CHANGED")
        );
        fs::remove_file(&path).unwrap();
        assert!(changed_hint(&fixture.home, name, &hints).unwrap());
        assert_eq!(
            error_code(&verify(&graph).unwrap_err()),
            Some("CLAUDEX_FRONTEND_CACHE_MISSING")
        );
        assert!(!changed_hint(&fixture.home, "0000000000000003_0", &hints).unwrap());
    }

    struct Adapter;
    impl Transform for Adapter {
        fn build(&self, source: &str) -> Result<String> {
            Ok(format!("{source}\n// [Claudex test]"))
        }
        fn publication_fence(&self) -> Result<()> {
            Ok(())
        }
    }
    #[test]
    fn journal_owned_patch_uses_immutable_vendor_original_and_evidence_loss_is_explicit() {
        let fixture = Fixture::new();
        let path = fixture.put(1, "index-test.js", BOOT, FETCH_TIME);
        let source_hash = cache::inspect(&fs::read(&path).unwrap(), None)
            .unwrap()
            .source_hash;
        let owner = fixture.root.join("ui-folders/0000000000000001_0");
        platform::create_private(&owner).unwrap();
        let options = InstallOptions {
            root: owner.clone(),
            cache_path: path.clone(),
            source_hash,
            target_url: format!("{ASSET_ROOT}index-test.js"),
        };
        cache_install::operate(Action::Install, &options, &Adapter).unwrap();
        assert!(
            cache::inspect(&fs::read(&path).unwrap(), None)
                .unwrap()
                .source
                .contains("[Claudex test]")
        );
        let graph = fixture.discover().unwrap();
        let module = &graph.modules[&graph.entry_url];
        assert_eq!(module.source, BOOT);
        assert_eq!(
            module.original_bytes,
            fs::read(owner.join("ui-folder-compat/original.cache")).unwrap()
        );
        fs::remove_file(owner.join("ui-folder-compat/original.cache")).unwrap();
        let error = fixture.discover().err().unwrap();
        assert_eq!(
            error_code(&error),
            Some("CLAUDEX_FRONTEND_EVIDENCE_MISSING")
        );
    }

    #[test]
    fn ambiguous_entries_unowned_patches_and_unsafe_inventory_refuse() {
        let fixture = Fixture::new();
        let path = fixture.put(1, "index-one.js", BOOT, FETCH_TIME);
        let other = fixture.put(2, "index-two.js", BOOT, FETCH_TIME);
        assert!(
            fixture
                .discover()
                .err()
                .unwrap()
                .to_string()
                .contains("ambiguous")
        );
        fs::remove_file(other).unwrap();
        fs::write(
            &path,
            container(
                "index-one.js",
                &format!("{BOOT}// [Claudex foreign]"),
                FETCH_TIME,
            ),
        )
        .unwrap();
        assert!(
            fixture
                .discover()
                .err()
                .unwrap()
                .to_string()
                .contains("unowned patched")
        );
        fs::write(&path, container("index-one.js", BOOT, FETCH_TIME)).unwrap();
        fs::hard_link(&path, fixture.cache.join("alias")).unwrap();
        assert!(
            fixture
                .discover()
                .err()
                .unwrap()
                .to_string()
                .contains("single-linked")
        );
        assert!(
            resolve_import(
                &format!("{ASSET_ROOT}index.js"),
                "https://foreign.invalid/a.js"
            )
            .is_none()
        );
        assert!(resolve_import(&format!("{ASSET_ROOT}index.js"), "../a.js").is_none());
        assert!(resolve_import(&format!("{ASSET_ROOT}index.js"), "./a.js?source=other").is_none());
        assert_eq!(
            resolve_import(&format!("{ASSET_ROOT}index.js"), "./a.js"),
            Some(format!("{ASSET_ROOT}a.js"))
        );
    }

    #[test]
    fn missing_import_bound_is_enforced_without_fetching_or_choosing_an_older_graph() {
        let fixture = Fixture::new();
        fixture.put(1, "index-old.js", BOOT, FETCH_TIME);
        let source = (0..=MAX_MODULES)
            .map(|n| format!("import('./missing-{n}.js');"))
            .collect::<String>();
        fixture.put(
            2,
            "index-new.js",
            &format!("{BOOT}{source}"),
            FETCH_TIME + 1,
        );
        assert!(
            fixture
                .discover()
                .err()
                .unwrap()
                .to_string()
                .contains("missing imports exceed")
        );
        assert_eq!(fs::read_dir(&fixture.cache).unwrap().count(), 2);
    }
}
