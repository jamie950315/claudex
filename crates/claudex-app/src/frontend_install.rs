//! Serial, journal-owned publication of structurally proved renderer resources.
use crate::{
    cache,
    cache_install::{self, Action, InstallOptions, Manifest, Phase, Transform},
    frontend_adapters::{self, Adapter, Bindings, PreparedSource, Selection, Selections},
    frontend_ast,
    frontend_graph::{self, Graph},
    platform,
};
use anyhow::{Context, Result, ensure};
use claudex_core::storage::FileIdentity;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureCode {
    CacheMissing,
    CacheChanged,
    EvidenceMissing,
    RequiredFileMissing,
    AccessDenied,
    Stopped,
    Held,
    ValidationRefused,
}
impl FailureCode {
    pub fn name(self) -> &'static str {
        match self {
            Self::CacheMissing => "cache-entry-missing",
            Self::CacheChanged => "cache-changed",
            Self::EvidenceMissing => "recovery-evidence-missing",
            Self::RequiredFileMissing => "required-file-missing",
            Self::AccessDenied => "access-denied",
            Self::Stopped => "stopped",
            Self::Held => "held",
            Self::ValidationRefused => "validation-refused",
        }
    }
    pub fn transient(self) -> bool {
        matches!(self, Self::CacheMissing | Self::CacheChanged)
    }
}
#[derive(Debug)]
pub struct Failure(pub FailureCode);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Renderer adapter refused [{}]", self.0.name())
    }
}
impl std::error::Error for Failure {}
/// Completed resources remain observable when a later lifecycle fence holds
/// the pass. This carries write metadata only, never a replay instruction.
#[derive(Debug)]
pub struct InterruptedPass {
    pub code: FailureCode,
    pub summary: Value,
}
impl std::fmt::Display for InterruptedPass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Renderer maintenance interrupted [{}]", self.code.name())
    }
}
impl std::error::Error for InterruptedPass {}
pub fn interrupted_summary(error: &anyhow::Error) -> Option<&Value> {
    error.chain().find_map(|error| {
        error
            .downcast_ref::<InterruptedPass>()
            .map(|error| &error.summary)
    })
}
pub fn failure_code(error: &anyhow::Error) -> FailureCode {
    if let Some(error) = error
        .chain()
        .find_map(|error| error.downcast_ref::<InterruptedPass>())
    {
        return error.code;
    }
    if let Some(code) = error.chain().find_map(|e| e.downcast_ref::<Failure>()) {
        return code.0;
    }
    match frontend_graph::error_code(error) {
        Some("CLAUDEX_FRONTEND_CACHE_MISSING") => return FailureCode::CacheMissing,
        Some("CLAUDEX_FRONTEND_CACHE_CHANGED") => return FailureCode::CacheChanged,
        Some("CLAUDEX_FRONTEND_EVIDENCE_MISSING") => return FailureCode::EvidenceMissing,
        _ => {}
    }
    if let Some(error) = error
        .chain()
        .find_map(|e| e.downcast_ref::<std::io::Error>())
    {
        return match error.kind() {
            std::io::ErrorKind::PermissionDenied => FailureCode::AccessDenied,
            std::io::ErrorKind::NotFound => FailureCode::RequiredFileMissing,
            _ => FailureCode::ValidationRefused,
        };
    }
    FailureCode::ValidationRefused
}
fn native_snapshot(path: &Path) -> Result<cache_install::Snapshot> {
    cache_install::snapshot(path, cache::MAX_CACHE_BYTES).map_err(|e| {
        if claudex_core::storage::is_not_found(&e) {
            Failure(FailureCode::CacheMissing).into()
        } else if cache_install::changed_path(&e) == Some(path) {
            Failure(FailureCode::CacheChanged).into()
        } else {
            e
        }
    })
}
fn evidence_snapshot(path: &Path, limit: usize) -> Result<cache_install::Snapshot> {
    cache_install::snapshot(path, limit).map_err(|e| {
        if claudex_core::storage::is_not_found(&e) {
            Failure(FailureCode::EvidenceMissing).into()
        } else {
            e
        }
    })
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn owner(root: &Path, adapter: Adapter, name: &str) -> Result<PathBuf> {
    ensure!(
        frontend_graph::cache_filename(name),
        "Invalid renderer cache filename."
    );
    Ok(root.join(adapter.directory()).join(name))
}
fn asset(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or("")
}
fn check_hold(root: &Path, fence: &dyn Fn() -> Result<()>) -> Result<()> {
    fence()?;
    if platform::stopped(root)? {
        return Err(Failure(FailureCode::Held).into());
    }
    Ok(())
}
pub struct Pass {
    pub summary: Value,
    pub observations: BTreeMap<String, FileIdentity>,
}
/// Discover and prepare one exact graph. No download, vendor execution or reload.
pub fn ensure(
    root: &Path,
    home: &Path,
    folders: bool,
    fence: &dyn Fn() -> Result<()>,
) -> Result<Pass> {
    platform::absolute(root)?;
    platform::absolute(home)?;
    check_hold(root, fence)?;
    let mut graph = frontend_graph::discover(root, home)?;
    let selections = frontend_adapters::resolve(&graph);
    ensure_graph(root, home, folders, &mut graph, &selections, fence)
}
pub fn ensure_graph(
    root: &Path,
    home: &Path,
    folders: bool,
    graph: &mut Graph,
    selections: &Selections,
    fence: &dyn Fn() -> Result<()>,
) -> Result<Pass> {
    let mut adapters = json!({});
    for adapter in Adapter::ALL {
        if adapter == Adapter::Folders && !folders {
            adapters[adapter.name()] = json!({"status":"disabled"});
            continue;
        }
        if selections.shared_folder_chat && folders && adapter == Adapter::ChatWake {
            adapters[adapter.name()] = adapters[Adapter::Folders.name()].clone();
            continue;
        }
        let Some(selection) = selections.adapters.get(&adapter) else {
            anyhow::bail!("Missing renderer adapter selection.")
        };
        let Selection::Matched(target) = selection else {
            // Anchor diagnostics can contain vendor identifiers. Public maintenance
            // reports keep a fixed reason; detailed proof stays with the resolver.
            adapters[adapter.name()] = json!({"status":"skipped","reason":"Structural adapter proof is unavailable","failure":{"code":"validation-refused"}});
            continue;
        };
        let shared = selections.shared_folder_chat
            && matches!(adapter, Adapter::Folders | Adapter::ChatWake);
        let result = (|| {
            check_hold(root, fence)?;
            frontend_graph::verify(graph)?;
            if shared {
                release_independent_chat(root, home, graph, &target.url, fence)?;
            }
            let chat = if shared && folders {
                selections.adapters[&Adapter::ChatWake].target()
            } else {
                None
            };
            let prepared =
                frontend_adapters::prepare_sources(root, home, graph, target, adapter, chat)?;
            let journal_adapter = if shared { Adapter::Folders } else { adapter };
            let outcomes = publish_sources(root, graph, journal_adapter, &prepared, fence)?;
            let first = outcomes.first().context("Adapter prepared no resources")?;
            let changed = outcomes.iter().any(|v| v["changed"] == true);
            let mut row = first.clone();
            row["status"] = json!("installed");
            row["changed"] = json!(changed);
            row["activation"] = json!(if changed {
                "restart-required"
            } else {
                "load-not-verified"
            });
            if outcomes.len() > 1 {
                row["consumer"] =
                    json!({"asset":outcomes[1]["asset"],"changed":outcomes[1]["changed"]});
            }
            if shared {
                row["sharedResource"] = json!(true);
                row["journalAdapter"] = json!("folders");
            }
            if let Bindings::Owner(anchor) = &target.bindings {
                row["search"] = json!({"method":"bounded-semantic-bindings","componentCandidates":anchor.component_candidates,"provenComponents":anchor.proven_components});
            }
            Ok::<_, anyhow::Error>(row)
        })();
        adapters[adapter.name()] = match result {
            Ok(value) => value,
            Err(error) => {
                let code = failure_code(&error);
                if matches!(code, FailureCode::Held | FailureCode::Stopped) {
                    for remaining in Adapter::ALL {
                        if adapters.get(remaining.name()).is_none() {
                            adapters[remaining.name()] = json!({"status":"held"});
                        }
                    }
                    return Err(InterruptedPass { code, summary: json!({"entry":graph.entry,"missingChunks":graph.missing,"adapters":adapters}) }.into());
                }
                json!({"status":"skipped","reason":"Cache publication or recovery refused; original and journal preserved","failure":{"code":code.name()}})
            }
        };
    }
    Ok(Pass {
        summary: json!({"entry":graph.entry,"missingChunks":graph.missing,"adapters":adapters}),
        observations: frontend_graph::capture_hints(graph),
    })
}
struct Prepared<'a> {
    vendor: &'a str,
    source: &'a str,
    graph: &'a Graph,
    root: &'a Path,
    fence: &'a dyn Fn() -> Result<()>,
}
impl Transform for Prepared<'_> {
    fn build(&self, source: &str) -> Result<String> {
        ensure!(
            source == self.vendor,
            "Renderer vendor original changed after structural proof."
        );
        Ok(self.source.to_string())
    }
    fn publication_fence(&self) -> Result<()> {
        check_hold(self.root, self.fence)?;
        frontend_graph::verify(self.graph)
    }
}
fn validate_recovery(owner: &Path, path: &Path, source_hash: &str) -> Result<()> {
    let journal = owner.join("ui-folder-compat/manifest.json");
    if exists(&journal)? {
        let snapshot = evidence_snapshot(&journal, 16 * 1024)?;
        let m: Manifest = serde_json::from_slice(&snapshot.bytes)?;
        m.validate(owner, path, source_hash)?;
        let original = evidence_snapshot(
            &owner.join("ui-folder-compat/original.cache"),
            cache::MAX_CACHE_BYTES,
        )?;
        ensure!(
            original.hash == m.original_hash,
            "Renderer original does not match its journal."
        );
    }
    Ok(())
}
fn publish_sources(
    root: &Path,
    graph: &mut Graph,
    adapter: Adapter,
    prepared: &[PreparedSource],
    fence: &dyn Fn() -> Result<()>,
) -> Result<Vec<Value>> {
    ensure!(
        !prepared.is_empty() && prepared.len() <= 2,
        "Renderer resource set is invalid."
    );
    let mut urls = BTreeSet::new();
    // Preflight every complete candidate before publishing the pure helper. A
    // failed consumer can never turn an incomplete pair into an installed row.
    for part in prepared {
        ensure!(
            urls.insert(&part.url),
            "Renderer resource set contains duplicate modules."
        );
        let module = graph
            .modules
            .get(&part.url)
            .context("Prepared renderer target is unavailable")?;
        ensure!(
            cache::inspect(&module.original_bytes, Some(&module.url))?.source_hash
                == module.source_hash,
            "Renderer original source binding changed."
        );
        frontend_ast::syntax(&part.source)?;
        cache::replace_source(&module.original_bytes, &part.source, Some(&module.url))?;
        let state = owner(root, adapter, &module.name)?;
        validate_recovery(&state, &module.path, &module.source_hash)?;
    }
    frontend_graph::verify(graph)?;
    check_hold(root, fence)?;
    let mut outcomes = vec![];
    for part in prepared {
        let module = &graph.modules[&part.url];
        let state = owner(root, adapter, &module.name)?;
        let current = native_snapshot(&module.path)?;
        if current.hash != module.current_hash || current.identity != module.identity {
            return Err(Failure(FailureCode::CacheChanged).into());
        }
        platform::create_private(&state)?;
        let options = InstallOptions {
            root: state,
            cache_path: module.path.clone(),
            source_hash: module.source_hash.clone(),
            target_url: module.url.clone(),
        };
        let result = cache_install::operate(
            Action::Install,
            &options,
            &Prepared {
                vendor: &module.source,
                source: &part.source,
                graph,
                root,
                fence,
            },
        )
        .map_err(|e| classify_publication(e, &module.path))?;
        let installed = native_snapshot(&module.path)?;
        if installed.hash != result.cache_hash {
            return Err(Failure(FailureCode::CacheChanged).into());
        }
        let row = json!({"status":result.status,"changed":result.changed,"recovered":result.recovered,"cacheHash":result.cache_hash,"originalHash":result.original_hash,"cachePath":module.path,"asset":asset(&module.url)});
        let module = graph.modules.get_mut(&part.url).unwrap();
        module.current_hash = installed.hash;
        module.identity = installed.identity;
        outcomes.push(row);
    }
    Ok(outcomes)
}
fn classify_publication(error: anyhow::Error, path: &Path) -> anyhow::Error {
    if cache_install::changed_path(&error) == Some(path) {
        Failure(FailureCode::CacheChanged).into()
    } else if claudex_core::storage::is_not_found(&error)
        && (!path.exists() || path.parent().is_none_or(|p| !p.exists()))
    {
        Failure(FailureCode::CacheMissing).into()
    } else {
        error
    }
}
struct Restore<'a>(&'a dyn Fn() -> Result<()>);
impl Transform for Restore<'_> {
    fn build(&self, _: &str) -> Result<String> {
        anyhow::bail!("Restore never builds a renderer patch")
    }
    fn publication_fence(&self) -> Result<()> {
        (self.0)()
    }
}
fn restore_owned(state: &Path, path: &Path, fence: &dyn Fn() -> Result<()>) -> Result<Value> {
    let receipt = evidence_snapshot(&state.join("ui-folder-compat/manifest.json"), 16 * 1024)?;
    let m: Manifest = serde_json::from_slice(&receipt.bytes)?;
    let original = evidence_snapshot(
        &state.join("ui-folder-compat/original.cache"),
        cache::MAX_CACHE_BYTES,
    )?;
    let entry = cache::inspect(&original.bytes, None)?;
    m.validate(state, path, &entry.source_hash)?;
    ensure!(
        m.original_hash == original.hash,
        "Renderer immutable original changed."
    );
    native_snapshot(path)?;
    let result = cache_install::operate(
        Action::Restore,
        &InstallOptions {
            root: state.into(),
            cache_path: path.into(),
            source_hash: entry.source_hash,
            target_url: entry.url,
        },
        &Restore(fence),
    )
    .map_err(|e| classify_publication(e, path))?;
    Ok(serde_json::to_value(result)?)
}
fn release_independent_chat(
    root: &Path,
    _home: &Path,
    graph: &mut Graph,
    url: &str,
    fence: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let module = graph
        .modules
        .get(url)
        .context("Shared renderer target is unavailable")?;
    let state = owner(root, Adapter::ChatWake, &module.name)?;
    let receipt = state.join("ui-folder-compat/manifest.json");
    if !exists(&receipt)? {
        return Ok(());
    }
    let journal = evidence_snapshot(&receipt, 16 * 1024)?;
    let m: Manifest = serde_json::from_slice(&journal.bytes)?;
    m.validate(&state, &module.path, &module.source_hash)?;
    let current = native_snapshot(&module.path)?;
    if current.hash != module.current_hash || current.identity != module.identity {
        return Err(Failure(FailureCode::CacheChanged).into());
    }
    if m.phase != Phase::Installed || m.action != Action::Install || m.patched_hash != current.hash
    {
        return Ok(());
    }
    check_hold(root, fence)?;
    frontend_graph::verify(graph)?;
    let path = module.path.clone();
    restore_owned(&state, &path, &|| {
        check_hold(root, fence)?;
        frontend_graph::verify(graph)
    })?;
    let restored = native_snapshot(&path)?;
    ensure!(
        restored.hash == m.original_hash,
        "Shared resource restoration changed."
    );
    let module = graph.modules.get_mut(url).unwrap();
    module.current_hash = restored.hash;
    module.identity = restored.identity;
    Ok(())
}
fn resource_path(home: &Path, path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("Invalid renderer cache filename")?;
    ensure!(
        frontend_graph::cache_filename(name)
            && path.parent() == Some(frontend_graph::cache_directory(home).as_path()),
        "Renderer restore target differs from its native cache directory."
    );
    Ok(name.into())
}
/// Restore only the owning journal; dependent consumers are restored first.
pub fn restore_adapter(
    root: &Path,
    home: &Path,
    path: &Path,
    adapter: Adapter,
    fence: &dyn Fn() -> Result<()>,
) -> Result<Value> {
    platform::absolute(root)?;
    platform::absolute(home)?;
    restore_recursive(root, home, path, adapter, fence, &mut BTreeSet::new())
}
fn restore_recursive(
    root: &Path,
    home: &Path,
    path: &Path,
    adapter: Adapter,
    fence: &dyn Fn() -> Result<()>,
    visiting: &mut BTreeSet<PathBuf>,
) -> Result<Value> {
    let name = resource_path(home, path)?;
    ensure!(
        visiting.insert(path.into()),
        "Renderer restore dependency cycle."
    );
    let mut state = owner(root, adapter, &name)?;
    let mut folder_owner = adapter == Adapter::Folders;
    if adapter == Adapter::ChatWake {
        let owned = if exists(&state.join("ui-folder-compat/manifest.json"))? {
            let m: Manifest = serde_json::from_slice(
                &evidence_snapshot(&state.join("ui-folder-compat/manifest.json"), 16 * 1024)?.bytes,
            )?;
            m.validate(&state, path, &m.source_hash)?;
            m.action == Action::Install && m.patched_hash == native_snapshot(path)?.hash
        } else {
            false
        };
        if !owned {
            let shared = owner(root, Adapter::Folders, &name)?;
            if exists(&shared.join("ui-folder-compat/manifest.json"))? {
                let original = evidence_snapshot(
                    &shared.join("ui-folder-compat/original.cache"),
                    cache::MAX_CACHE_BYTES,
                )?;
                ensure!(
                    cache::inspect(&original.bytes, None)?
                        .source
                        .contains("forkSession"),
                    "Resource has no shared chat proof."
                );
                state = shared;
                folder_owner = true;
            }
        }
    }
    let current = native_snapshot(path)?;
    let entry = cache::inspect(&current.bytes, None)?;
    if folder_owner && entry.source.contains("__cldxFolderStore") {
        for name in generation_names(root, Adapter::Folders)? {
            let other = frontend_graph::cache_directory(home).join(name);
            if other == path {
                continue;
            }
            if !exists(&other)? {
                continue;
            }
            let candidate = cache::inspect(&native_snapshot(&other)?.bytes, None)?;
            if !candidate.source.contains("__cldxFolderStore") {
                continue;
            }
            let ast = frontend_ast::syntax(&candidate.source)?;
            let dependent = frontend_ast::array(&ast["body"]).iter().any(|node| {
                frontend_ast::kind(node) == "ImportDeclaration"
                    && frontend_ast::array(&node["specifiers"])
                        .iter()
                        .any(|s| frontend_ast::id(&s["imported"]) == Some("__cldxFolderStore"))
                    && node["source"]["value"]
                        .as_str()
                        .and_then(|s| frontend_graph::resolve_import(&candidate.url, s))
                        .as_deref()
                        == Some(entry.url.as_str())
            });
            if dependent {
                restore_recursive(root, home, &other, Adapter::Folders, fence, visiting)?;
            }
        }
    }
    let result = restore_owned(&state, path, fence)?;
    visiting.remove(path);
    Ok(result)
}
fn generation_names(root: &Path, adapter: Adapter) -> Result<Vec<String>> {
    let directory = root.join(adapter.directory());
    if !exists(&directory)? {
        return Ok(vec![]);
    }
    platform::directory(&directory, true, false)?;
    let mut names = vec![];
    let mut count = 0;
    for entry in fs::read_dir(directory)? {
        count += 1;
        ensure!(
            count <= 32768,
            "Renderer generation inventory exceeds its bound."
        );
        let name = entry?.file_name();
        if let Some(name) = name.to_str().filter(|n| frontend_graph::cache_filename(n)) {
            names.push(name.into());
        }
    }
    names.sort();
    Ok(names)
}
pub fn restore_folder_generations(
    root: &Path,
    home: &Path,
    fence: &dyn Fn() -> Result<()>,
) -> Result<Value> {
    platform::absolute(root)?;
    platform::absolute(home)?;
    let mut legacy = None;
    let legacy_path = frontend_graph::cache_directory(home).join("15bc54146dcdb4ce_0");
    let legacy_manifest = root.join("ui-folder-compat/manifest.json");
    if exists(&legacy_manifest)? && exists(&legacy_path)? {
        let receipt = evidence_snapshot(&legacy_manifest, 16 * 1024)?;
        let manifest: Manifest = serde_json::from_slice(&receipt.bytes)?;
        manifest.validate(
            root,
            &legacy_path,
            "01bc6cf8d85b25edda8a396f00e664872a03288f6c06aff03d1aa0f2fa466ebf",
        )?;
        let original = evidence_snapshot(
            &root.join("ui-folder-compat/original.cache"),
            cache::MAX_CACHE_BYTES,
        )?;
        let entry = cache::inspect(
            &original.bytes,
            Some("https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-23-Db0dcGkF.js"),
        )?;
        ensure!(
            entry.source_hash == manifest.source_hash && original.hash == manifest.original_hash,
            "Legacy renderer resource binding changed."
        );
        legacy = Some(restore_owned(root, &legacy_path, fence)?);
    }
    let mut results = vec![];
    for name in generation_names(root, Adapter::Folders)? {
        let path = frontend_graph::cache_directory(home).join(name);
        if !exists(&path)? {
            continue;
        }
        results.push(restore_adapter(root, home, &path, Adapter::Folders, fence)?);
    }
    let mut value = json!({"status":"restored","changed":results.iter().any(|r|r["changed"]==true)||legacy.as_ref().is_some_and(|r|r["changed"]==true),"generations":results.len()});
    if let Some(legacy) = legacy {
        value["legacy"] = legacy;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        frontend_adapters::{Bindings, Target},
        frontend_anchors::ChatAnchor,
        frontend_bindings::Index,
        frontend_graph::{ASSET_ROOT, EntrySummary, Module},
    };
    use sha2::{Digest, Sha256};
    use std::{cell::Cell, os::unix::fs::PermissionsExt};

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let home = fs::canonicalize(temp.path()).unwrap();
            let root = home.join("state");
            platform::create_private(&root).unwrap();
            platform::create_private(&frontend_graph::cache_directory(&home)).unwrap();
            Self {
                _temp: temp,
                home,
                root,
            }
        }
        fn graph(&self, sources: &[(&str, &str)]) -> Graph {
            let modules = sources
                .iter()
                .enumerate()
                .map(|(number, (asset, source))| {
                    let url = format!("{ASSET_ROOT}{asset}");
                    let name = format!("{number:016x}_0");
                    let path = frontend_graph::cache_directory(&self.home).join(&name);
                    let bytes = container(asset, source);
                    platform::publish(&path, &bytes, 0o600).unwrap();
                    let entry = cache::inspect(&bytes, Some(&url)).unwrap();
                    let snap = native_snapshot(&path).unwrap();
                    let ast = frontend_ast::syntax(source).unwrap();
                    (
                        url.clone(),
                        Module {
                            name,
                            path,
                            url,
                            source: source.to_string(),
                            source_hash: entry.source_hash,
                            current_hash: snap.hash,
                            identity: snap.identity,
                            original_bytes: bytes,
                            imports: frontend_ast::imports(&ast, false),
                            eager_imports: frontend_ast::imports(&ast, true),
                            provenance: Index::compact(&ast),
                        },
                    )
                })
                .collect();
            Graph {
                entry: EntrySummary {
                    asset: sources[0].0.into(),
                    cache_filename: "0000000000000000_0".into(),
                    fetched_at: "2023-11-14T22:13:20.000Z".into(),
                },
                entry_url: format!("{ASSET_ROOT}{}", sources[0].0),
                modules,
                missing: BTreeSet::new(),
            }
        }
    }
    fn container(asset: &str, source: &str) -> Vec<u8> {
        let bytes = cache::tests::fixture(source);
        let entry = cache::inspect(&bytes, None).unwrap();
        let key = format!("1/0/{ASSET_ROOT}{asset}").into_bytes();
        let mut result = bytes[..24].to_vec();
        result[12..16].copy_from_slice(&(key.len() as u32).to_le_bytes());
        result.extend(&key);
        result.extend(&bytes[entry.start..entry.body_end + 24]);
        result.extend(&entry.metadata);
        result.extend(Sha256::digest(&key));
        result.extend(&bytes[bytes.len() - 24..]);
        cache::inspect(&result, None).unwrap();
        result
    }
    fn part(asset: &str, source: &str) -> PreparedSource {
        PreparedSource {
            url: format!("{ASSET_ROOT}{asset}"),
            source: source.into(),
        }
    }
    fn source(path: &Path) -> String {
        cache::inspect(&fs::read(path).unwrap(), None)
            .unwrap()
            .source
    }

    #[test]
    fn complete_pair_preflight_precedes_any_publication() {
        let f = Fixture::new();
        let mut graph = f.graph(&[
            ("helper.js", "export const a=1;"),
            ("consumer.js", "export const b=2;"),
        ]);
        let prepared = [
            part("helper.js", "export const a=3;"),
            part("consumer.js", "export const b=;"),
        ];
        assert!(
            publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &|| Ok(())).is_err()
        );
        assert_eq!(
            source(&graph.modules[&prepared[0].url].path),
            "export const a=1;"
        );
        assert!(!f.root.join("ui-folders").exists());
    }
    #[test]
    fn helper_installs_before_consumer_and_restores_after_it() {
        let f = Fixture::new();
        let mut graph = f.graph(&[
            ("helper.js", "export const a=1;"),
            ("consumer.js", "export const b=2;"),
        ]);
        let prepared = [
            part(
                "helper.js",
                "export const a=1; const __cldx={}; export{__cldx as __cldxFolderStore};",
            ),
            part(
                "consumer.js",
                "import{__cldxFolderStore as s}from'./helper.js'; export const b=s;",
            ),
        ];
        let helper = graph.modules[&prepared[0].url].path.clone();
        let consumer = graph.modules[&prepared[1].url].path.clone();
        let fence = || {
            if source(&consumer).contains("__cldxFolderStore") {
                ensure!(source(&helper).contains("__cldxFolderStore"));
            }
            Ok(())
        };
        let first =
            publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &fence).unwrap();
        assert!(first.iter().all(|row| row["changed"] == true));
        let original = f
            .root
            .join("ui-folders/0000000000000000_0/ui-folder-compat/original.cache");
        let before = evidence_snapshot(&original, cache::MAX_CACHE_BYTES).unwrap();
        assert!(
            publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &fence)
                .unwrap()
                .iter()
                .all(|row| row["changed"] == false)
        );
        assert!(
            restore_adapter(&f.root, &f.home, &helper, Adapter::Folders, &fence).unwrap()["changed"]
                == true
        );
        assert_eq!(source(&helper), "export const a=1;");
        assert_eq!(source(&consumer), "export const b=2;");
        assert_eq!(
            evidence_snapshot(&original, cache::MAX_CACHE_BYTES)
                .unwrap()
                .identity,
            before.identity
        );
    }
    #[test]
    fn independent_chat_handover_and_disabled_folders_keep_one_owner() {
        let f = Fixture::new();
        let mut graph = f.graph(&[(
            "chat.js",
            "const n={};const supported=n?.forkSession!==void 0;",
        )]);
        let url = graph.entry_url.clone();
        let path = graph.modules[&url].path.clone();
        publish_sources(
            &f.root,
            &mut graph,
            Adapter::ChatWake,
            &[part(
                "chat.js",
                "const n={};const supported=n?.forkSession!==void 0;// independent",
            )],
            &|| Ok(()),
        )
        .unwrap();
        let target = Target {
            url: url.clone(),
            bindings: Bindings::Chat(ChatAnchor {
                native: "n".into(),
                fork_action: false,
            }),
            consumer: None,
        };
        let adapters = Adapter::ALL
            .into_iter()
            .map(|adapter| {
                (
                    adapter,
                    if matches!(adapter, Adapter::ChatWake | Adapter::Folders) {
                        Selection::Matched(target.clone())
                    } else {
                        Selection::Skipped {
                            reason: "Unavailable".into(),
                        }
                    },
                )
            })
            .collect();
        let pass = ensure_graph(
            &f.root,
            &f.home,
            false,
            &mut graph,
            &Selections {
                adapters,
                shared_folder_chat: true,
            },
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(pass.summary["adapters"]["folders"]["status"], "disabled");
        assert_eq!(pass.summary["adapters"]["chatWake"]["status"], "installed");
        assert_eq!(
            pass.summary["adapters"]["chatWake"]["journalAdapter"],
            "folders"
        );
        assert!(!source(&path).contains("// independent"));
        let independent = f
            .root
            .join("ui-chat-wake/0000000000000000_0/ui-folder-compat/manifest.json");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&independent).unwrap()).unwrap()["action"],
            "restore"
        );
        // The old, inactive journal is not the recovery evidence used by the
        // shared owner's restore proof.
        fs::remove_file(independent.with_file_name("original.cache")).unwrap();
        assert!(
            restore_adapter(&f.root, &f.home, &path, Adapter::ChatWake, &|| Ok(())).unwrap()["changed"]
                == true
        );
        assert_eq!(
            source(&path),
            "const n={};const supported=n?.forkSession!==void 0;"
        );
        assert!(independent.exists());
    }
    #[test]
    fn lifecycle_interruption_carries_completed_writes_without_claiming_readiness() {
        let f = Fixture::new();
        let mut graph = f.graph(&[(
            "chat.js",
            "const n={};const supported=n?.forkSession!==void 0;",
        )]);
        let target = Target {
            url: graph.entry_url.clone(),
            bindings: Bindings::Chat(ChatAnchor {
                native: "n".into(),
                fork_action: false,
            }),
            consumer: None,
        };
        let path = graph.modules[&graph.entry_url].path.clone();
        let selections = Selections {
            shared_folder_chat: false,
            adapters: Adapter::ALL
                .into_iter()
                .map(|adapter| {
                    (
                        adapter,
                        if matches!(adapter, Adapter::ChatWake | Adapter::OwnerWake) {
                            Selection::Matched(target.clone())
                        } else {
                            Selection::Skipped {
                                reason: "Unavailable".into(),
                            }
                        },
                    )
                })
                .collect(),
        };
        let fence = || {
            if source(&path).contains("[Claudex chat wake]") {
                platform::write_json(
                    &f.root.join("app-stop.json"),
                    &json!({"version":1,"stopped":true}),
                )?;
            }
            Ok(())
        };
        let error = ensure_graph(&f.root, &f.home, false, &mut graph, &selections, &fence)
            .err()
            .unwrap();
        assert_eq!(failure_code(&error), FailureCode::Held);
        let partial = interrupted_summary(&error).unwrap();
        assert_eq!(partial["adapters"]["chatWake"]["changed"], true);
        assert_eq!(partial["adapters"]["ownerWake"]["status"], "held");
        assert!(partial["adapters"]["ownerWake"].get("failure").is_none());
    }
    #[test]
    fn final_stop_and_graph_fences_preserve_native_bytes_and_recover_prepared() {
        let f = Fixture::new();
        let mut graph = f.graph(&[("helper.js", "export const a=1;")]);
        let prepared = [part("helper.js", "export const a=2;")];
        let path = graph.modules[&prepared[0].url].path.clone();
        let calls = Cell::new(0);
        let fence = || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                platform::write_json(
                    &f.root.join("app-stop.json"),
                    &json!({"version":1,"stopped":true}),
                )?;
            }
            Ok(())
        };
        assert_eq!(
            failure_code(
                &publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &fence)
                    .unwrap_err()
            ),
            FailureCode::Held
        );
        assert_eq!(source(&path), "export const a=1;");
        platform::write_json(
            &f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )
        .unwrap();
        let recovered =
            publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &|| Ok(())).unwrap();
        assert_eq!(recovered[0]["recovered"], true);

        let f = Fixture::new();
        let mut graph = f.graph(&[
            ("helper.js", "export const a=1;"),
            ("other.js", "export const b=1;"),
        ]);
        let other = graph.modules[&format!("{ASSET_ROOT}other.js")].path.clone();
        let path = graph.modules[&prepared[0].url].path.clone();
        let calls = Cell::new(0);
        let fence = || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                fs::write(&other, container("other.js", "export const b=99;"))?;
            }
            Ok(())
        };
        assert_eq!(
            failure_code(
                &publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &fence)
                    .unwrap_err()
            ),
            FailureCode::CacheChanged
        );
        assert_eq!(source(&path), "export const a=1;");
        assert_eq!(source(&other), "export const b=99;");
    }
    #[test]
    fn foreign_resource_and_recovery_loss_are_never_cache_eviction() {
        let f = Fixture::new();
        let mut graph = f.graph(&[("helper.js", "export const a=1;")]);
        let prepared = [part("helper.js", "export const a=2;")];
        publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &|| Ok(())).unwrap();
        let path = graph.modules[&prepared[0].url].path.clone();
        fs::write(&path, container("helper.js", "export const foreign=1;")).unwrap();
        let error =
            restore_adapter(&f.root, &f.home, &path, Adapter::Folders, &|| Ok(())).unwrap_err();
        assert_eq!(failure_code(&error), FailureCode::ValidationRefused);
        assert_eq!(source(&path), "export const foreign=1;");
        fs::remove_file(
            f.root
                .join("ui-folders/0000000000000000_0/ui-folder-compat/original.cache"),
        )
        .unwrap();
        assert_eq!(
            failure_code(&restore_folder_generations(&f.root, &f.home, &|| Ok(())).unwrap_err()),
            FailureCode::EvidenceMissing
        );
        let change = cache_install::ChangedResource(path.clone());
        assert_eq!(
            failure_code(&classify_publication(change.into(), &path)),
            FailureCode::CacheChanged
        );
        let change = cache_install::ChangedResource(f.root.join("manifest.json"));
        assert_eq!(
            failure_code(&classify_publication(change.into(), &path)),
            FailureCode::ValidationRefused
        );
    }
    #[test]
    fn evicted_generations_retain_journals_and_legacy_binding_is_exact() {
        let f = Fixture::new();
        let mut graph = f.graph(&[("helper.js", "export const a=1;")]);
        let prepared = [part("helper.js", "export const a=2;")];
        publish_sources(&f.root, &mut graph, Adapter::Folders, &prepared, &|| Ok(())).unwrap();
        let path = graph.modules[&prepared[0].url].path.clone();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            restore_folder_generations(&f.root, &f.home, &|| Ok(())).unwrap()["generations"],
            0
        );
        assert!(
            f.root
                .join("ui-folders/0000000000000000_0/ui-folder-compat/original.cache")
                .exists()
        );
        let path = frontend_graph::cache_directory(&f.home).join("15bc54146dcdb4ce_0");
        let bytes = container("shared-23-Db0dcGkF.js", "export const a=1;");
        platform::publish(&path, &bytes, 0o600).unwrap();
        let entry = cache::inspect(&bytes, None).unwrap();
        let options = InstallOptions {
            root: f.root.clone(),
            cache_path: path.clone(),
            source_hash: entry.source_hash,
            target_url: entry.url,
        };
        struct Patch;
        impl Transform for Patch {
            fn build(&self, s: &str) -> Result<String> {
                Ok(format!("{s}// patch"))
            }
            fn publication_fence(&self) -> Result<()> {
                Ok(())
            }
        }
        cache_install::operate(Action::Install, &options, &Patch).unwrap();
        assert!(restore_folder_generations(&f.root, &f.home, &|| Ok(())).is_err());
        assert!(source(&path).contains("// patch"));
        assert!(f.root.join("ui-folder-compat/manifest.json").exists());
    }
}
