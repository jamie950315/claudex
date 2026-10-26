//! Explicit, offline installation for the Gateway's signed app:// resources.
//! Never used to mutate a bundle from setup, inspection or a watcher.
use crate::{
    cache,
    frontend_adapters::{self, Adapter, Selection as AdapterSelection},
    frontend_ast,
    frontend_bindings::Index,
    frontend_graph::{self, Graph, Module},
    platform::{self, CommandSpec, Runner},
    providers,
};
use anyhow::{Context, Result, bail, ensure};
use claudex_core::{
    claude_desktop::Selection,
    storage::{self, FileIdentity, FileLock},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};

const LIMIT: usize = 32 * 1024 * 1024;
const RESOURCE: &str = "Contents/Resources/ion-dist";
const MAX_FILES: usize = 100_000;
const MAX_TREE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
fn recipe() -> String {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../plugins/claudex/.claude-plugin/plugin.json"
    ))
    .expect("The authoritative Mod manifest must be valid JSON.");
    format!(
        "bundle-v1/mod-{}",
        manifest["version"]
            .as_str()
            .expect("The Mod version is required.")
    )
}

pub const HELP: &str = "Usage: claudex app renderer-bundle install|restore|recover|status|check --app /absolute/Claude.app [--root /absolute/state] [--home /absolute/home] [--allow-bundle-modification yes]\n\nInstall, restore and recover require explicit opt-in, stopped Claudex services, and a closed Claude Desktop. Install patches only structurally proved ion-dist resources in a complete copy, ad-hoc signs it, then atomically exchanges bundles. The entire original and every journal are retained. Status and check are read-only. No command starts an app or model.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    identity: FileIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<PathBuf>,
}
type Tree = BTreeMap<PathBuf, Node>;

/// Hashing here proves complete app-copy transfer integrity, not a readback
/// ornament. Subsequent checks reuse exact inode/nanosecond identities.
fn inventory(app: &Path, contents: bool) -> Result<Tree> {
    platform::directory(app, false, true)?;
    let mut pending = vec![PathBuf::new()];
    let mut tree = BTreeMap::new();
    let mut bytes = 0u64;
    while let Some(relative) = pending.pop() {
        ensure!(
            tree.len() < MAX_FILES,
            "Claude bundle inventory exceeds its bound."
        );
        let path = app.join(&relative);
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            (metadata.uid() == platform::uid() || metadata.uid() == 0)
                && (metadata.file_type().is_symlink() || metadata.mode() & 0o022 == 0),
            "Claude bundle contains a foreign-owned or writable resource."
        );
        let identity = FileIdentity::from_metadata(&metadata);
        let mut node = Node {
            identity: identity.clone(),
            digest: None,
            link: None,
        };
        if metadata.is_dir() {
            for entry in fs::read_dir(&path)? {
                pending.push(relative.join(entry?.file_name()));
            }
        } else if metadata.file_type().is_symlink() {
            let link = fs::read_link(&path)?;
            ensure!(
                !link.is_absolute() && fs::canonicalize(&path)?.starts_with(app),
                "Claude bundle symlink escapes the bundle."
            );
            node.link = Some(link);
        } else {
            ensure!(
                metadata.is_file() && metadata.nlink() == 1,
                "Claude bundle resources must be regular and single-linked."
            );
            bytes = bytes
                .checked_add(metadata.len())
                .context("Claude bundle size overflow.")?;
            ensure!(
                bytes <= MAX_TREE_BYTES && metadata.len() <= 2 * 1024 * 1024 * 1024,
                "Claude bundle bytes exceed their bound."
            );
            if contents {
                let snapshot = storage::read_stable_with_limit(&path, 2 * 1024 * 1024 * 1024)?;
                ensure!(
                    snapshot.identity == identity,
                    "Claude bundle changed while reading."
                );
                node.digest = Some(storage::hash_bytes(&snapshot.bytes));
            }
        }
        ensure!(
            FileIdentity::from_metadata(&fs::symlink_metadata(&path)?) == identity,
            "Claude bundle changed during inventory."
        );
        tree.insert(relative, node);
    }
    // Directory entry additions and replacements are covered by the second pass.
    if contents {
        verify_tree(app, &tree, false)?;
    }
    Ok(tree)
}

fn verify_tree(app: &Path, expected: &Tree, relocated: bool) -> Result<Tree> {
    let mut current = inventory(app, false)?;
    ensure!(
        current.len() == expected.len(),
        "Claude bundle inventory changed; all artifacts were preserved."
    );
    for (path, node) in &mut current {
        let before = expected
            .get(path)
            .context("Claude bundle resource set changed.")?;
        let mut old = before.identity.clone();
        // renamex_np changes only each exchanged root directory's ctime. This
        // exception is restricted to resolving our durable swap intent; every
        // child, inode, mode, link and all other nanosecond fields remain exact.
        if relocated && path.as_os_str().is_empty() {
            old.ctime_ns = node.identity.ctime_ns.clone();
        }
        ensure!(
            node.identity == old && node.link == before.link,
            "Claude bundle changed; no foreign resource was overwritten."
        );
        node.digest = before.digest.clone();
    }
    Ok(current)
}

/// macOS may attach its MACL after publication, changing ctime on the app root
/// and outer seal. Re-establish their exact current identities from unchanged
/// objects and authenticated seal bytes; never accept a resource/inode change.
fn verify_installed_tree(app: &Path, expected: &Tree) -> Result<Tree> {
    let mut current = inventory(app, false)?;
    ensure!(
        current.len() == expected.len(),
        "Claude bundle inventory changed."
    );
    for (path, node) in &mut current {
        let before = expected
            .get(path)
            .context("Claude bundle resource set changed.")?;
        let mut identity = before.identity.clone();
        let metadata_boundary = path.as_os_str().is_empty()
            || path == Path::new("Contents/_CodeSignature/CodeResources");
        if metadata_boundary && node.identity.ctime_ns != identity.ctime_ns {
            identity.ctime_ns = node.identity.ctime_ns.clone();
            ensure!(
                node.identity == identity && node.link == before.link,
                "Claude bundle object changed; all artifacts were preserved."
            );
            if !path.as_os_str().is_empty() {
                let bytes = storage::read_stable_with_limit(app.join(path), LIMIT)?;
                ensure!(
                    bytes.identity == node.identity
                        && Some(storage::hash_bytes(&bytes.bytes)) == before.digest,
                    "Claude outer seal bytes changed; all artifacts were preserved."
                );
            }
        }
        ensure!(
            node.identity == identity && node.link == before.link,
            "Claude bundle changed; no foreign resource was overwritten."
        );
        node.digest = before.digest.clone();
    }
    verify_tree(app, &current, false)
}

fn copy_matches(original: &Tree, copy: &Tree) -> Result<()> {
    ensure!(
        original.len() == copy.len(),
        "Claude bundle copy is incomplete."
    );
    for (path, before) in original {
        let after = copy
            .get(path)
            .context("Claude bundle copy is incomplete.")?;
        ensure!(
            before.digest == after.digest
                && before.link == after.link
                && before.identity.mode == after.identity.mode,
            "Claude bundle copy differs from its complete original."
        );
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Building,
    Prepared,
    Publishing,
    Installed,
    Restoring,
    Restored,
    Abandoned,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    generation: String,
    phase: Phase,
    root: PathBuf,
    home: PathBuf,
    app: PathBuf,
    slot: PathBuf,
    original: Tree,
    patched: Option<Tree>,
    summary: Value,
    #[serde(default)]
    recipe: String,
    #[serde(default)]
    proof_refusals: BTreeMap<String, String>,
}
fn directory(root: &Path) -> PathBuf {
    root.join("renderer-profiles/claude-3p/bundle")
}
fn journal_path(root: &Path, generation: &str) -> Result<PathBuf> {
    ensure!(
        uuid::Uuid::parse_str(generation).is_ok_and(|id| id.to_string() == generation),
        "Invalid bundle generation."
    );
    Ok(directory(root)
        .join("generations")
        .join(generation)
        .join("journal.json"))
}
fn load(root: &Path) -> Result<Option<(Journal, storage::StableFile)>> {
    let pointer = directory(root).join("current.json");
    let Some(value) = platform::optional_json(&pointer, 4096, true)? else {
        return Ok(None);
    };
    ensure!(value["version"] == 1, "Invalid renderer bundle pointer.");
    let generation = value["generation"]
        .as_str()
        .context("Bundle generation is absent.")?;
    let path = journal_path(root, generation)?;
    platform::directory(path.parent().unwrap(), true, false)?;
    let bytes = storage::read_stable_with_limit(&path, LIMIT)?;
    platform::safe_bytes(&path, LIMIT, true, false)?;
    let journal: Journal = serde_json::from_slice(&bytes.bytes)?;
    ensure!(
        journal.version == 1 && journal.root == root && journal.generation == generation,
        "Renderer bundle journal identity changed."
    );
    platform::absolute(&journal.home)?;
    platform::absolute(&journal.app)?;
    let parent = journal
        .app
        .parent()
        .context("Claude app parent is missing.")?;
    ensure!(
        journal.slot
            == parent
                .join(format!(".claudex-renderer-{generation}"))
                .join("Claude.app")
            && !journal.original.is_empty()
            && journal.original.len() <= MAX_FILES,
        "Renderer bundle recovery path is invalid."
    );
    platform::directory(journal.slot.parent().unwrap(), true, false)?;
    let latest = platform::optional_json(&pointer, 4096, true)?;
    ensure!(
        latest.as_ref() == Some(&value),
        "Renderer bundle pointer changed during inspection."
    );
    Ok(Some((journal, bytes)))
}
fn save(journal: &Journal, expected: &mut storage::StableFile) -> Result<()> {
    let path = journal_path(&journal.root, &journal.generation)?;
    let current = storage::read_stable_with_limit(&path, LIMIT)
        .with_context(|| format!("Read renderer bundle journal {}", path.display()))?;
    ensure!(
        current.identity.uid == storage::uid().to_string()
            && current.identity.nlink == "1"
            && current.identity.mode.parse::<u32>()? & 0o077 == 0,
        "Renderer bundle journal must be owned, private and single-linked: {}",
        path.display()
    );
    ensure!(
        current.identity == expected.identity && current.bytes == expected.bytes,
        "Renderer bundle journal changed; no native operation was repeated."
    );
    let bytes = serde_json::to_vec(journal)?;
    ensure!(
        bytes.len() <= LIMIT,
        "Renderer bundle journal exceeds its bound."
    );
    storage::atomic_write(&path, &bytes)
        .with_context(|| format!("Save renderer bundle journal {}", path.display()))?;
    *expected = storage::read_stable_with_limit(&path, LIMIT)?;
    Ok(())
}

struct Fence {
    root: PathBuf,
    selection: Selection,
    stop: FileIdentity,
    _locks: Vec<FileLock>,
}
impl Fence {
    fn new(root: &Path, home: &Path) -> Result<Self> {
        Self::selected(root, home, true)
    }
    fn selected(root: &Path, home: &Path, require_gateway: bool) -> Result<Self> {
        platform::directory(root, true, false)?;
        let selection = Selection::read(home)?;
        ensure!(
            !require_gateway || frontend_graph::profile(&selection)? == "3p",
            "Renderer bundle installation requires the Gateway profile."
        );
        let stop = storage::read_stable_with_limit(&root.join("app-stop.json"), 32768)?;
        let value: Value = serde_json::from_slice(&stop.bytes)?;
        ensure!(
            value["stopped"] == true && value["resuming"] != true,
            "Stop Claudex and finish draining its owners before modifying Claude.app."
        );
        let mut locks = vec![];
        for name in ["watch.lock", "operation.lock", "desktop-operation.lock"] {
            locks.push(FileLock::acquire(root.join(name), true)?);
        }
        let fence = Self {
            root: root.into(),
            selection,
            stop: stop.identity,
            _locks: locks,
        };
        fence.check()?;
        Ok(fence)
    }
    fn check(&self) -> Result<()> {
        self.selection.verify()?;
        let stop = storage::read_stable_with_limit(&self.root.join("app-stop.json"), 32768)?;
        ensure!(
            stop.identity == self.stop,
            "Claudex stop state changed during bundle maintenance."
        );
        Ok(())
    }
    async fn closed(&self, app: &Path, runner: &dyn Runner) -> Result<()> {
        self.check()?;
        let output =
            platform::checked(runner, CommandSpec::new("/bin/ps", ["-axo", "comm="])).await?;
        let prefix = format!("{}/Contents/", app.display());
        ensure!(
            !output.stdout.lines().any(|line| {
                let line = line.trim();
                line.starts_with(&prefix)
                    || line.contains("/Claude.app/Contents/")
                    || line == "Claude"
            }),
            "Quit Claude Desktop normally before modifying its bundle; no app was stopped."
        );
        self.check()
    }
}

/// Logical HTTPS keys are used only by the existing structural resolver. They
/// are never HTTP-cache paths or a claim that app:// fetched these URLs.
fn graph(app: &Path, home: &Path) -> Result<Graph> {
    let selection = Selection::read(home)?;
    ensure!(
        frontend_graph::profile(&selection)? == "3p",
        "Gateway frontend profile changed."
    );
    let ion = app.join(RESOURCE);
    platform::directory(&ion, false, true)?;
    let index = storage::read_stable_with_limit(&ion.join("index.html"), cache::MAX_SOURCE_BYTES)?;
    platform::safe_bytes(
        &ion.join("index.html"),
        cache::MAX_SOURCE_BYTES,
        false,
        true,
    )?;
    let html = String::from_utf8(index.bytes)?;
    let mut entries = vec![];
    for tag in html
        .split('<')
        .filter_map(|part| part.split_once('>').map(|(tag, _)| tag))
    {
        if !tag.starts_with("script ") {
            continue;
        }
        for quote in ['\'', '"'] {
            let key = format!("src={quote}/assets/v1/");
            for (_, tail) in tag
                .match_indices(&key)
                .map(|(at, _)| (at, &tag[at + key.len()..]))
            {
                let name = tail.split(quote).next().unwrap_or("");
                if name.starts_with("index-")
                    && frontend_graph::asset_url(&format!("{}{name}", frontend_graph::ASSET_ROOT))
                {
                    entries.push(name.to_owned());
                }
            }
        }
    }
    ensure!(
        entries.len() == 1,
        "Claude bundle entry is missing or ambiguous."
    );
    let entry = entries.pop().unwrap();
    let entry_url = format!("{}{entry}", frontend_graph::ASSET_ROOT);
    let assets = ion.join("assets/v1");
    platform::directory(&assets, false, true)?;
    let mut modules = BTreeMap::new();
    let mut pending = vec![entry_url.clone()];
    let mut missing = BTreeSet::new();
    let mut total = 0usize;
    while let Some(url) = pending.pop() {
        if modules.contains_key(&url) || missing.contains(&url) {
            continue;
        }
        ensure!(
            modules.len() + missing.len() < 8192,
            "Claude bundle graph exceeds its module bound."
        );
        let name = url
            .strip_prefix(frontend_graph::ASSET_ROOT)
            .context("Unexpected bundle module identity.")?;
        ensure!(
            !name.contains('/') && !name.contains('\\'),
            "Claude bundle module is not a direct asset."
        );
        let path = assets.join(name);
        let snapshot = match storage::read_stable_with_limit(&path, cache::MAX_SOURCE_BYTES) {
            Ok(snapshot) => snapshot,
            Err(error) if storage::is_not_found(&error) => {
                missing.insert(url);
                continue;
            }
            Err(error) => return Err(error),
        };
        ensure!(
            (snapshot.identity.uid == storage::uid().to_string() || snapshot.identity.uid == "0")
                && snapshot.identity.nlink == "1"
                && snapshot.identity.mode.parse::<u32>()? & 0o022 == 0,
            "Claude bundle source is not an owned protected regular file."
        );
        total += snapshot.bytes.len();
        ensure!(
            total <= 512 * 1024 * 1024,
            "Claude bundle graph exceeds its byte bound."
        );
        let source = String::from_utf8(snapshot.bytes.clone())?;
        ensure!(
            !source.contains("[Claudex ") && !source.contains("__cldx"),
            "Claude bundle contains an unowned frontend patch."
        );
        let ast = frontend_ast::syntax(&source)?;
        let imports = frontend_ast::imports(&ast, false);
        let source_hash = storage::hash_bytes(&snapshot.bytes);
        pending.extend(
            imports
                .iter()
                .filter_map(|spec| frontend_graph::resolve_import(&url, spec)),
        );
        let module = Module {
            name: name.into(),
            path,
            url: url.clone(),
            source_hash: source_hash.clone(),
            current_hash: source_hash,
            identity: snapshot.identity,
            original_bytes: snapshot.bytes,
            source,
            imports,
            eager_imports: frontend_ast::imports(&ast, true),
            provenance: Index::compact(&ast),
        };
        modules.insert(url, module);
    }
    ensure!(
        missing.is_empty(),
        "Claude bundle import graph is incomplete."
    );
    ensure!(
        modules
            .get(&entry_url)
            .is_some_and(|module| module.source.contains("document.getElementById(\"root\")")),
        "Claude bundle bootstrap anchor changed."
    );
    let graph = Graph {
        selection,
        entry: frontend_graph::EntrySummary {
            asset: entry.clone(),
            cache_filename: entry,
            fetched_at: String::new(),
        },
        entry_url,
        modules,
        missing,
    };
    frontend_graph::verify(&graph)?;
    ensure!(
        FileIdentity::from_metadata(&fs::symlink_metadata(ion.join("index.html"))?)
            == index.identity,
        "Claude bundle entry changed during discovery."
    );
    Ok(graph)
}

fn prepare(
    root: &Path,
    home: &Path,
    graph: &Graph,
) -> Result<(BTreeMap<PathBuf, String>, Value, BTreeMap<String, String>)> {
    let selections = frontend_adapters::resolve(graph);
    let mut patches = BTreeMap::new();
    let mut adapters = json!({});
    let mut refusals = BTreeMap::new();
    for adapter in Adapter::ALL {
        if adapter == Adapter::ChatWake
            && selections.shared_folder_chat
            && adapters["folders"]["status"] == "installed"
        {
            adapters[adapter.name()] = adapters["folders"].clone();
            continue;
        }
        let Some(AdapterSelection::Matched(target)) = selections.adapters.get(&adapter) else {
            if let Some(AdapterSelection::Skipped { reason }) = selections.adapters.get(&adapter) {
                refusals.insert(adapter.name().into(), reason.clone());
            }
            adapters[adapter.name()] = json!({"status":"skipped","reason":"Structural adapter proof is unavailable","failure":{"code":"validation-refused"}});
            continue;
        };
        let combined = adapter == Adapter::Folders && selections.shared_folder_chat;
        let chat = combined
            .then(|| selections.adapters[&Adapter::ChatWake].target())
            .flatten();
        let prepared =
            frontend_adapters::prepare_sources(root, home, graph, target, adapter, chat)?;
        for part in prepared {
            frontend_ast::syntax(&part.source)?;
            let module = graph
                .modules
                .get(&part.url)
                .context("Prepared bundle module is absent.")?;
            ensure!(
                patches
                    .insert(PathBuf::from(&module.name), part.source)
                    .is_none(),
                "Gateway adapters require conflicting writes to one bundle module."
            );
        }
        adapters[adapter.name()] = json!({"status":"installed","asset":graph.modules[&target.url].name,"changed":false,"activation":"load-not-verified"});
        if combined {
            adapters[adapter.name()]["sharedResource"] = json!(true);
        }
    }
    ensure!(
        adapters["chatWake"]["status"] == "installed"
            && adapters["ownerWake"]["status"] == "installed"
            && adapters["commands"]["status"] == "installed",
        "Gateway bundle requires complete chat-wake, owner-wake and commands proofs; no bundle was published."
    );
    Ok((
        patches,
        json!({"source":"signed-bundle","nativeProfile":"3p","entry":graph.entry,"missingChunks":[],"adapters":adapters}),
        refusals,
    ))
}

fn exchange(app: &Path, slot: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let a = CString::new(app.as_os_str().as_bytes())?;
        let b = CString::new(slot.as_os_str().as_bytes())?;
        ensure!(
            unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0,
            "Atomic Claude bundle exchange failed: {}",
            std::io::Error::last_os_error()
        );
        fs::File::open(app.parent().unwrap())?.sync_all()?;
        fs::File::open(slot.parent().unwrap())?.sync_all()?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, slot);
        bail!("Signed Claude bundle installation requires macOS.")
    }
}

fn result(journal: &Journal) -> Value {
    json!({"version":1,"phase":journal.phase,"recipe":journal.recipe,"generation":journal.generation,"app":journal.app,
        "preservedBundle":journal.slot,"journal":journal_path(&journal.root, &journal.generation).ok(),"rendererAdapters":journal.summary})
}

/// Read-only recognition used by the ordinary watcher. Foreign updates refuse;
/// no cache fallback, signing, repair or startup occurs here.
pub fn installed(root: &Path, home: &Path) -> Result<Option<Value>> {
    let selection = Selection::read(home)?;
    if frontend_graph::profile(&selection)? != "3p" {
        return Ok(None);
    }
    let Some((journal, snapshot)) = load(root)? else {
        return Ok(None);
    };
    ensure!(
        journal.home == home,
        "Renderer bundle belongs to a different native home."
    );
    if matches!(journal.phase, Phase::Restored | Phase::Abandoned) {
        return Ok(None);
    }
    ensure!(
        journal.phase == Phase::Installed,
        "Renderer bundle operation is unfinished; run renderer-bundle recover while both apps are stopped."
    );
    ensure!(
        journal.recipe == recipe(),
        "Renderer bundle upgrade required. Stop both apps, then explicitly restore and install the current renderer bundle."
    );
    verify_installed_tree(
        &journal.app,
        journal
            .patched
            .as_ref()
            .context("Installed bundle proof is absent.")?,
    )?;
    verify_installed_tree(&journal.slot, &journal.original)?;
    selection.verify()?;
    let current =
        storage::read_stable_with_limit(&journal_path(root, &journal.generation)?, LIMIT)?;
    ensure!(
        current.identity == snapshot.identity,
        "Renderer bundle journal changed during inspection."
    );
    ensure!(
        platform::optional_json(&directory(root).join("current.json"), 4096, true)?
            .is_some_and(|v| v["generation"] == journal.generation),
        "Renderer bundle generation changed during inspection."
    );
    Ok(Some(journal.summary))
}

/// Only the sealed resource/code directories used by an installed generation.
/// The shared OS source watches these alongside caches; it never mutates them.
pub fn notification_directories(root: &Path) -> Result<Vec<PathBuf>> {
    let Some((journal, _)) = load(root)? else {
        return Ok(vec![]);
    };
    if journal.phase != Phase::Installed {
        return Ok(vec![]);
    }
    Ok([
        "",
        "Contents",
        "Contents/Resources",
        RESOURCE,
        "Contents/Resources/ion-dist/assets",
        "Contents/Resources/ion-dist/assets/v1",
        "Contents/MacOS",
        "Contents/_CodeSignature",
    ]
    .map(|path| journal.app.join(path))
    .to_vec())
}

pub async fn run(options: &platform::Options, root: &Path, runner: &dyn Runner) -> Result<Value> {
    ensure!(
        options.positions.len() == 1
            && options.values.keys().all(|key| [
                "root",
                "home",
                "app",
                "allow-bundle-modification",
                "help"
            ]
            .contains(&key.as_str())),
        "{HELP}"
    );
    let action = options.action();
    ensure!(
        ["status", "check", "install", "restore", "recover"].contains(&action),
        "{HELP}"
    );
    let home = options
        .path("home")
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()));
    let app = options.required_path("app")?;
    platform::absolute(root)?;
    platform::absolute(&home)?;
    platform::absolute(&app)?;
    if action == "check" {
        providers::verify(&app, &providers::CLAUDE, runner).await?;
        let graph = graph(&app, &home)?;
        let (patches, summary, refusals) = prepare(root, &home, &graph)?;
        frontend_graph::verify(&graph)?;
        return Ok(
            json!({"version":1,"phase":"source-checked","recipe":recipe(),"moduleCount":graph.modules.len(),"patchCount":patches.len(),"proofRefusals":refusals,"rendererAdapters":summary}),
        );
    }
    if action == "status" {
        let Some((journal, _)) = load(root)? else {
            return Ok(json!({"version":1,"phase":"not-installed"}));
        };
        ensure!(
            journal.app == app && journal.home == home,
            "Bundle journal does not belong to this app and home."
        );
        let mut value = result(&journal);
        value["upgradeRequired"] =
            json!(journal.phase == Phase::Installed && journal.recipe != recipe());
        value["recoveryRequired"] = json!(matches!(
            journal.phase,
            Phase::Building | Phase::Prepared | Phase::Publishing | Phase::Restoring
        ));
        value["verifiedInstalled"] = json!(
            journal.phase == Phase::Installed
                && journal.recipe == recipe()
                && installed(root, &home)?.is_some()
        );
        return Ok(value);
    }
    ensure!(
        options
            .values
            .get("allow-bundle-modification")
            .is_some_and(|v| v == "yes"),
        "Bundle modification requires --allow-bundle-modification yes. {HELP}"
    );
    let fence = if action == "install" {
        Fence::new(root, &home)?
    } else {
        Fence::selected(root, &home, false)?
    };
    platform::create_private(&directory(root))?;
    let _exclusive = FileLock::acquire(directory(root).join("installer.lock"), true)?;
    fence.closed(&app, runner).await?;
    let existing = load(root)?;
    if let Some((mut journal, mut snapshot)) = existing {
        ensure!(
            journal.app == app && journal.home == home,
            "Bundle journal does not belong to this app and home."
        );
        if action == "recover" {
            recover(&mut journal, &mut snapshot)?;
            fence.closed(&app, runner).await?;
            return Ok(result(&journal));
        }
        if action == "restore" {
            if journal.phase == Phase::Installed {
                // Explicit offline recovery binds fresh exact metadata before
                // recording any swap intent. Nothing native is changed here.
                let patched = verify_installed_tree(
                    &app,
                    journal
                        .patched
                        .as_ref()
                        .context("Patched proof is absent.")?,
                )?;
                let original = verify_installed_tree(&journal.slot, &journal.original)?;
                if journal.patched.as_ref() != Some(&patched) || journal.original != original {
                    providers::verify(&app, &providers::CLAUDE, runner).await?;
                    providers::verify(&journal.slot, &providers::CLAUDE, runner).await?;
                    journal.patched = Some(patched);
                    journal.original = original;
                    save(&journal, &mut snapshot)?;
                }
            }
            recover(&mut journal, &mut snapshot)?;
            if journal.phase == Phase::Prepared {
                verify_tree(&app, &journal.original, false)?;
                journal.phase = Phase::Abandoned;
                save(&journal, &mut snapshot)?;
            } else if journal.phase == Phase::Installed {
                fence.closed(&app, runner).await?;
                verify_tree(
                    &app,
                    journal
                        .patched
                        .as_ref()
                        .context("Patched bundle proof is absent.")?,
                    false,
                )?;
                verify_tree(&journal.slot, &journal.original, false)?;
                journal.phase = Phase::Restoring;
                save(&journal, &mut snapshot)?;
                fence.closed(&app, runner).await?;
                verify_tree(&app, journal.patched.as_ref().unwrap(), false)?;
                verify_tree(&journal.slot, &journal.original, false)?;
                exchange(&app, &journal.slot)?;
                recover(&mut journal, &mut snapshot)?;
            }
            return Ok(result(&journal));
        }
        if journal.phase == Phase::Installed {
            installed(root, &home)?;
            return Ok(result(&journal));
        }
        if journal.phase == Phase::Prepared {
            publish_prepared(&mut journal, &mut snapshot, runner, &fence).await?;
            return Ok(result(&journal));
        }
        ensure!(
            matches!(journal.phase, Phase::Restored | Phase::Abandoned),
            "Previous bundle installation is unfinished. Run renderer-bundle recover first."
        );
    } else {
        ensure!(
            action == "install",
            "No renderer bundle installation exists."
        );
    }
    install(root, &home, &app, runner, &fence).await
}

fn recover(journal: &mut Journal, snapshot: &mut storage::StableFile) -> Result<()> {
    match journal.phase {
        Phase::Building => {
            verify_tree(&journal.app, &journal.original, false)?;
            journal.phase = Phase::Abandoned;
        }
        Phase::Publishing | Phase::Restoring => {
            let patched = journal
                .patched
                .as_ref()
                .context("Prepared bundle proof is absent.")?;
            // Resolve the at-most-once swap by complete exact object placement.
            // Never issue another swap from this recovery function.
            if let (Ok(p), Ok(o)) = (
                verify_tree(&journal.app, patched, true),
                verify_tree(&journal.slot, &journal.original, true),
            ) {
                journal.patched = Some(p);
                journal.original = o;
                journal.phase = Phase::Installed;
            } else if let (Ok(o), Ok(p)) = (
                verify_tree(&journal.app, &journal.original, true),
                verify_tree(&journal.slot, patched, true),
            ) {
                journal.original = o;
                journal.patched = Some(p);
                journal.phase = if journal.phase == Phase::Restoring {
                    Phase::Restored
                } else {
                    Phase::Prepared
                };
            } else {
                bail!(
                    "Bundle exchange outcome is uncertain or foreign-modified; both bundles and the pending journal were preserved."
                );
            }
        }
        Phase::Installed => {
            verify_tree(
                &journal.app,
                journal
                    .patched
                    .as_ref()
                    .context("Patched proof is absent.")?,
                false,
            )?;
            verify_tree(&journal.slot, &journal.original, false)?;
            return Ok(());
        }
        Phase::Prepared => {
            verify_tree(&journal.app, &journal.original, false)?;
            verify_tree(
                &journal.slot,
                journal
                    .patched
                    .as_ref()
                    .context("Prepared proof is absent.")?,
                false,
            )?;
            return Ok(());
        }
        Phase::Restored | Phase::Abandoned => {
            verify_tree(&journal.app, &journal.original, false)?;
            return Ok(());
        }
    }
    save(journal, snapshot)
}

async fn install(
    root: &Path,
    home: &Path,
    app: &Path,
    runner: &dyn Runner,
    fence: &Fence,
) -> Result<Value> {
    providers::verify(app, &providers::CLAUDE, runner).await?;
    fence.closed(app, runner).await?;
    let original = inventory(app, true)?;
    let graph = graph(app, home)?;
    let (patches, summary, proof_refusals) = prepare(root, home, &graph)?;
    let generation = uuid::Uuid::new_v4().to_string();
    let container = app
        .parent()
        .context("Claude app has no parent.")?
        .join(format!(".claudex-renderer-{generation}"));
    platform::create_private(&container)?;
    let slot = container.join("Claude.app");
    let mut journal = Journal {
        version: 1,
        generation: generation.clone(),
        phase: Phase::Building,
        root: root.into(),
        home: home.into(),
        app: app.into(),
        slot: slot.clone(),
        original,
        patched: None,
        summary,
        recipe: recipe(),
        proof_refusals,
    };
    let path = journal_path(root, &generation)?;
    platform::create_private(path.parent().unwrap())?;
    let bytes = serde_json::to_vec(&journal)?;
    ensure!(
        bytes.len() <= LIMIT,
        "Renderer bundle journal exceeds its bound."
    );
    platform::publish(&path, &bytes, 0o600)?;
    platform::write_json(
        &directory(root).join("current.json"),
        &json!({"version":1,"generation":generation}),
    )?;
    let mut expected = storage::read_stable_with_limit(&path, LIMIT)?;
    let mut copy = CommandSpec::new(
        "/usr/bin/ditto",
        [
            "--rsrc",
            "--extattr",
            "--acl",
            &app.to_string_lossy(),
            &slot.to_string_lossy(),
        ],
    );
    copy.timeout = Duration::from_secs(300);
    platform::checked(runner, copy).await?;
    fence.closed(app, runner).await?;
    verify_tree(app, &journal.original, false)?;
    let mut candidate = inventory(&slot, true)?;
    copy_matches(&journal.original, &candidate)?;
    frontend_graph::verify(&graph)?;
    for (name, source) in patches {
        let path = slot.join(RESOURCE).join("assets/v1").join(name);
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 1 && metadata.uid() == platform::uid(),
            "Candidate resource ownership changed."
        );
        let replacement = path.with_extension(format!("claudex-{}", uuid::Uuid::new_v4()));
        platform::publish(&replacement, source.as_bytes(), metadata.mode() & 0o777)?;
        ensure!(
            FileIdentity::from_metadata(&fs::symlink_metadata(&path)?)
                == FileIdentity::from_metadata(&metadata),
            "Candidate resource changed."
        );
        fs::rename(&replacement, &path)?;
        candidate.insert(
            path.strip_prefix(&slot)?.to_path_buf(),
            Node {
                identity: FileIdentity::from_metadata(&fs::symlink_metadata(&path)?),
                digest: Some(storage::hash_bytes(source.as_bytes())),
                link: None,
            },
        );
        // Replacing a resource changes only its parent directory's timestamps.
        let parent = path.parent().unwrap().strip_prefix(&slot)?.to_path_buf();
        let node = candidate
            .get_mut(&parent)
            .context("Candidate asset directory is absent.")?;
        let identity = FileIdentity::from_metadata(&fs::symlink_metadata(slot.join(&parent))?);
        ensure!(
            node.identity.same_inode(&identity) && node.identity.mode == identity.mode,
            "Candidate asset directory changed."
        );
        node.identity = identity;
    }
    verify_tree(&slot, &candidate, false)?;
    fence.closed(app, runner).await?;
    sign_local(&slot, &container, runner).await?;
    ensure!(
        providers::verify(&slot, &providers::CLAUDE, runner).await? == providers::Publisher::Local,
        "Claude bundle candidate is not an ad-hoc local build."
    );
    fence.closed(app, runner).await?;
    verify_tree(app, &journal.original, false)?;
    let patched = inventory(&slot, true)?;
    signed_changes(&candidate, &patched)?;
    // Flush the complete copied generation before recording swap authority.
    for (path, node) in &patched {
        if node.link.is_none() {
            fs::File::open(slot.join(path))?.sync_all()?;
        }
    }
    journal.patched = Some(patched);
    journal.phase = Phase::Prepared;
    save(&journal, &mut expected)?;
    publish_prepared(&mut journal, &mut expected, runner, fence).await?;
    Ok(result(&journal))
}

async fn entitlements(app: &Path, runner: &dyn Runner) -> Result<Value> {
    let output = platform::checked(
        runner,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["-d", "--entitlements", "-", "--xml", &app.to_string_lossy()],
        ),
    )
    .await?;
    if output.stdout.trim().is_empty() {
        return Ok(json!({}));
    }
    let mut convert = CommandSpec::new("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"]);
    convert.input = output.stdout.into_bytes();
    let parsed: Value = serde_json::from_str(&platform::checked(runner, convert).await?.stdout)?;
    ensure!(
        parsed.is_object(),
        "Native entitlements must be a dictionary."
    );
    Ok(parsed)
}

async fn sign_local(app: &Path, container: &Path, runner: &dyn Runner) -> Result<()> {
    let mut local = entitlements(app, runner).await?;
    // These claims require the vendor's signing identity. Preserving them in an
    // ad-hoc seal passes codesign verification but AMFI refuses process launch.
    // Runtime/device permissions remain unchanged; never invent a new identity
    // or claim access to the vendor's protected Keychain groups.
    for key in [
        "com.apple.application-identifier",
        "com.apple.developer.team-identifier",
        "keychain-access-groups",
    ] {
        local.as_object_mut().unwrap().remove(key);
    }
    let mut convert = CommandSpec::new("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"]);
    convert.input = serde_json::to_vec(&local)?;
    let xml = platform::checked(runner, convert).await?.stdout;
    let path = container.join("local-entitlements.plist");
    platform::publish(&path, xml.as_bytes(), 0o600)?;
    let mut sign = CommandSpec::new(
        "/usr/bin/codesign",
        [
            "--force",
            "--sign",
            "-",
            "--preserve-metadata=identifier,flags,runtime",
            "--entitlements",
            &path.to_string_lossy(),
            "--timestamp=none",
            &app.to_string_lossy(),
        ],
    );
    sign.timeout = Duration::from_secs(180);
    platform::checked(runner, sign).await?;
    ensure!(
        entitlements(app, runner).await? == local,
        "Local signing did not preserve the exact permitted entitlements."
    );
    Ok(())
}

async fn publish_prepared(
    journal: &mut Journal,
    expected: &mut storage::StableFile,
    runner: &dyn Runner,
    fence: &Fence,
) -> Result<()> {
    ensure!(
        journal.phase == Phase::Prepared && journal.recipe == recipe(),
        "Only a current, proven-unswapped prepared bundle may be published."
    );
    let patched = journal
        .patched
        .as_ref()
        .context("Prepared bundle proof is absent.")?;
    fence.closed(&journal.app, runner).await?;
    verify_tree(&journal.app, &journal.original, false)?;
    verify_tree(&journal.slot, patched, false)?;
    journal.phase = Phase::Publishing;
    save(journal, expected)?;
    fence.closed(&journal.app, runner).await?;
    verify_tree(&journal.app, &journal.original, false)?;
    verify_tree(&journal.slot, journal.patched.as_ref().unwrap(), false)?;
    exchange(&journal.app, &journal.slot)?;
    recover(journal, expected)?;
    ensure!(
        journal.phase == Phase::Installed,
        "Bundle publication was not confirmed."
    );
    Ok(())
}

fn signed_changes(before: &Tree, after: &Tree) -> Result<()> {
    ensure!(
        before.len() == after.len(),
        "Signing changed the Claude bundle resource set."
    );
    for (path, node) in after {
        let old = before
            .get(path)
            .context("Signing added an unexpected bundle resource.")?;
        if [
            "Contents/MacOS/Claude",
            "Contents/_CodeSignature/CodeResources",
        ]
        .iter()
        .any(|p| path == Path::new(p))
        {
            ensure!(
                node.link.is_none()
                    && old.link.is_none()
                    && old.identity.mode == node.identity.mode,
                "Signing changed executable or seal permissions."
            );
        } else if ["Contents/_CodeSignature", "Contents/MacOS"]
            .iter()
            .any(|p| path == Path::new(p))
        {
            ensure!(
                old.identity.same_inode(&node.identity) && old.identity.mode == node.identity.mode,
                "Signing replaced the signature directory."
            );
        } else {
            ensure!(
                node == old,
                "Signing changed an unrelated Claude resource; candidate preserved."
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Fixture {
        _temp: tempfile::TempDir,
        base: PathBuf,
        home: PathBuf,
        root: PathBuf,
        app: PathBuf,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let base = fs::canonicalize(temp.path())?;
            fs::set_permissions(&base, fs::Permissions::from_mode(0o700))?;
            let home = base.join("home");
            let root = base.join("state");
            let app = base.join("Claude.app");
            for path in [&home, &root, &app] {
                platform::create_private(path)?;
            }
            let config = claudex_core::claude_desktop::configuration_path(&home);
            platform::create_private(config.parent().unwrap())?;
            platform::publish(&config, br#"{"deploymentMode":"3p"}"#, 0o600)?;
            platform::write_json(
                &root.join("app-stop.json"),
                &json!({"version":1,"stopped":true}),
            )?;
            platform::publish(&app.join("retained"), b"complete original", 0o644)?;
            Ok(Self {
                _temp: temp,
                base,
                home,
                root,
                app,
            })
        }
        fn journal(&self, phase: Phase) -> Result<(Journal, storage::StableFile)> {
            let generation = uuid::Uuid::new_v4().to_string();
            let container = self.base.join(format!(".claudex-renderer-{generation}"));
            platform::create_private(&container)?;
            let slot = container.join("Claude.app");
            platform::create_private(&slot)?;
            platform::publish(&slot.join("retained"), b"complete patched", 0o644)?;
            let journal = Journal {
                version: 1,
                generation: generation.clone(),
                phase,
                root: self.root.clone(),
                home: self.home.clone(),
                app: self.app.clone(),
                slot: slot.clone(),
                original: inventory(&self.app, true)?,
                patched: Some(inventory(&slot, true)?),
                summary: json!({"nativeProfile":"3p","source":"signed-bundle","adapters":{"folders":{"status":"skipped"},"chatWake":{"status":"installed","activation":"load-not-verified"}}}),
                recipe: recipe(),
                proof_refusals: BTreeMap::new(),
            };
            let path = journal_path(&self.root, &generation)?;
            platform::create_private(path.parent().unwrap())?;
            platform::publish(&path, &serde_json::to_vec(&journal)?, 0o600)?;
            platform::write_json(
                &directory(&self.root).join("current.json"),
                &json!({"version":1,"generation":generation}),
            )?;
            let snapshot = storage::read_stable_with_limit(path, LIMIT)?;
            Ok((journal, snapshot))
        }
    }
    struct Processes {
        output: &'static str,
    }

    #[test]
    fn installed_metadata_revalidation_keeps_exact_objects_and_seal_bytes() -> Result<()> {
        let f = Fixture::new()?;
        let seal = f.app.join("Contents/_CodeSignature/CodeResources");
        platform::create_private(seal.parent().unwrap())?;
        platform::publish(&seal, b"sealed bytes", 0o644)?;
        let expected = inventory(&f.app, true)?;
        // A same-mode metadata update changes ctime like a native xattr update.
        fs::set_permissions(&f.app, fs::metadata(&f.app)?.permissions())?;
        fs::set_permissions(&seal, fs::metadata(&seal)?.permissions())?;
        assert!(verify_tree(&f.app, &expected, false).is_err());
        let current = verify_installed_tree(&f.app, &expected)?;
        verify_tree(&f.app, &current, false)?;
        let modified = fs::metadata(&seal)?.modified()?;
        fs::write(&seal, b"forged bytes")?;
        fs::File::open(&seal)?.set_times(fs::FileTimes::new().set_modified(modified))?;
        assert!(verify_installed_tree(&f.app, &expected).is_err());
        fs::write(&seal, b"sealed bytes")?;
        fs::File::open(&seal)?.set_times(fs::FileTimes::new().set_modified(modified))?;
        verify_installed_tree(&f.app, &expected)?;
        fs::set_permissions(f.app.join("retained"), fs::Permissions::from_mode(0o600))?;
        assert!(verify_installed_tree(&f.app, &expected).is_err());
        Ok(())
    }
    #[async_trait]
    impl Runner for Processes {
        async fn run(&self, spec: CommandSpec) -> Result<platform::CommandOutput> {
            ensure!(spec.program == Path::new("/bin/ps") && spec.args == ["-axo", "comm="]);
            Ok(platform::CommandOutput {
                stdout: self.output.into(),
                ..Default::default()
            })
        }
    }
    fn options(action: &str, fixture: &Fixture, consent: bool) -> platform::Options {
        let mut args = vec![
            action.to_string(),
            "--app".into(),
            fixture.app.display().to_string(),
            "--home".into(),
            fixture.home.display().to_string(),
        ];
        if consent {
            args.extend(["--allow-bundle-modification".into(), "yes".into()]);
        }
        platform::Options::parse(&args).unwrap()
    }

    #[test]
    fn large_prepared_journal_keeps_its_own_bound_and_exact_private_write_fence() -> Result<()> {
        let f = Fixture::new()?;
        let (mut journal, mut expected) = f.journal(Phase::Prepared)?;
        journal.summary["fixture"] = json!("x".repeat(2 * 1024 * 1024));
        save(&journal, &mut expected)?;
        assert!(expected.bytes.len() > 2 * 1024 * 1024);
        journal.phase = Phase::Publishing;
        save(&journal, &mut expected)?;
        let path = journal_path(&f.root, &journal.generation)?;
        assert_eq!(load(&f.root)?.unwrap().0.phase, Phase::Publishing);
        platform::safe_bytes(&path, LIMIT, true, false)?;
        let unchanged_identity = expected.identity.clone();
        let unchanged_bytes = expected.bytes.clone();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        assert!(save(&journal, &mut expected).is_err());
        assert_eq!(expected.identity, unchanged_identity);
        assert_eq!(fs::read(&path)?, unchanged_bytes);
        Ok(())
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn explicit_install_publishes_prepared_once_but_never_replays_a_swap_intent() -> Result<()>
    {
        let f = Fixture::new()?;
        let (journal, _) = f.journal(Phase::Prepared)?;
        let result = run(
            &options("install", &f, true),
            &f.root,
            &Processes { output: "" },
        )
        .await?;
        assert_eq!(result["phase"], "installed");
        assert_eq!(result["generation"], journal.generation);
        assert_eq!(
            fs::read(journal.slot.join("retained"))?,
            b"complete original"
        );
        let installed = inventory(&f.app, false)?;
        run(
            &options("install", &f, true),
            &f.root,
            &Processes { output: "" },
        )
        .await?;
        verify_tree(&f.app, &installed, false)?;

        let f = Fixture::new()?;
        let (journal, _) = f.journal(Phase::Publishing)?;
        let original = inventory(&f.app, false)?;
        let before = fs::read(journal_path(&f.root, &journal.generation)?)?;
        assert!(
            run(
                &options("install", &f, true),
                &f.root,
                &Processes { output: "" }
            )
            .await
            .is_err()
        );
        verify_tree(&f.app, &original, false)?;
        assert_eq!(
            fs::read(journal_path(&f.root, &journal.generation)?)?,
            before
        );
        Ok(())
    }

    #[test]
    fn inventory_preserves_internal_links_and_rejects_hardlinks_escape_and_foreign_writes()
    -> Result<()> {
        let f = Fixture::new()?;
        symlink("retained", f.app.join("alias"))?;
        let tree = inventory(&f.app, true)?;
        assert_eq!(
            tree[Path::new("alias")].link,
            Some(PathBuf::from("retained"))
        );
        verify_tree(&f.app, &tree, false)?;
        fs::hard_link(f.app.join("retained"), f.base.join("hardlink"))?;
        assert!(inventory(&f.app, true).is_err());
        fs::remove_file(f.base.join("hardlink"))?;
        fs::remove_file(f.app.join("alias"))?;
        symlink("../home", f.app.join("alias"))?;
        assert!(inventory(&f.app, true).is_err());
        fs::remove_file(f.app.join("alias"))?;
        fs::set_permissions(f.app.join("retained"), fs::Permissions::from_mode(0o666))?;
        assert!(inventory(&f.app, true).is_err());
        Ok(())
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn interrupted_publish_and_restore_resolve_exact_placement_without_replaying() -> Result<()> {
        let f = Fixture::new()?;
        let (mut journal, mut snapshot) = f.journal(Phase::Publishing)?;
        // Proven no swap: recovery records Prepared, without exchanging anything.
        recover(&mut journal, &mut snapshot)?;
        assert_eq!(journal.phase, Phase::Prepared);
        journal.phase = Phase::Publishing;
        save(&journal, &mut snapshot)?;
        exchange(&journal.app, &journal.slot)?;
        recover(&mut journal, &mut snapshot)?;
        assert_eq!(journal.phase, Phase::Installed);
        assert_eq!(
            fs::read(journal.slot.join("retained"))?,
            b"complete original"
        );
        assert!(installed(&f.root, &f.home)?.is_some());
        journal.phase = Phase::Restoring;
        save(&journal, &mut snapshot)?;
        recover(&mut journal, &mut snapshot)?;
        assert_eq!(journal.phase, Phase::Installed); // restore never happened
        journal.phase = Phase::Restoring;
        save(&journal, &mut snapshot)?;
        exchange(&journal.app, &journal.slot)?;
        recover(&mut journal, &mut snapshot)?;
        assert_eq!(journal.phase, Phase::Restored);
        assert_eq!(
            fs::read(journal.app.join("retained"))?,
            b"complete original"
        );
        assert_eq!(
            fs::read(journal.slot.join("retained"))?,
            b"complete patched"
        );
        assert!(installed(&f.root, &f.home)?.is_none());
        Ok(())
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn foreign_replacement_or_mode_change_keeps_the_pending_intent() -> Result<()> {
        let f = Fixture::new()?;
        let (mut journal, mut snapshot) = f.journal(Phase::Publishing)?;
        exchange(&journal.app, &journal.slot)?;
        fs::write(journal.app.join("retained"), b"foreign update")?;
        let before = fs::read(journal_path(&f.root, &journal.generation)?)?;
        assert!(recover(&mut journal, &mut snapshot).is_err());
        assert_eq!(
            fs::read(journal_path(&f.root, &journal.generation)?)?,
            before
        );
        assert_eq!(
            fs::read(journal.slot.join("retained"))?,
            b"complete original"
        );
        let f = Fixture::new()?;
        let (mut journal, mut snapshot) = f.journal(Phase::Publishing)?;
        exchange(&journal.app, &journal.slot)?;
        fs::set_permissions(&journal.app, fs::Permissions::from_mode(0o755))?;
        assert!(recover(&mut journal, &mut snapshot).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn consent_stop_locks_profile_and_closed_native_app_are_required() -> Result<()> {
        let f = Fixture::new()?;
        assert!(
            run(
                &options("install", &f, false),
                &f.root,
                &Processes { output: "" }
            )
            .await
            .is_err()
        );
        let fence = Fence::new(&f.root, &f.home)?;
        assert!(Fence::new(&f.root, &f.home).is_err());
        fence
            .closed(
                &f.app,
                &Processes {
                    output: "/usr/bin/other\n",
                },
            )
            .await?;
        assert!(
            fence
                .closed(
                    &f.app,
                    &Processes {
                        output: "/Applications/Claude.app/Contents/MacOS/Claude\n"
                    }
                )
                .await
                .is_err()
        );
        let config = claudex_core::claude_desktop::configuration_path(&f.home);
        platform::write_json(&config, &json!({"deploymentMode":"1p"}))?;
        assert!(fence.check().is_err());
        drop(fence);
        assert!(Fence::new(&f.root, &f.home).is_err());
        platform::write_json(&config, &json!({"deploymentMode":"3p"}))?;
        let fence = Fence::new(&f.root, &f.home)?;
        platform::write_json(
            &f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )?;
        assert!(fence.check().is_err());
        drop(fence);
        assert!(Fence::new(&f.root, &f.home).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn unfinished_copy_is_abandoned_without_touching_original_and_status_is_read_only()
    -> Result<()> {
        let f = Fixture::new()?;
        let (journal, _) = f.journal(Phase::Building)?;
        let original = inventory(&f.app, true)?;
        let before = fs::read(journal_path(&f.root, &journal.generation)?)?;
        // An unfinished install is not reported as installed, nor auto-repaired.
        assert_eq!(
            run(
                &options("status", &f, false),
                &f.root,
                &Processes { output: "" }
            )
            .await?["recoveryRequired"],
            true
        );
        assert_eq!(
            fs::read(journal_path(&f.root, &journal.generation)?)?,
            before
        );
        let result = run(
            &options("recover", &f, true),
            &f.root,
            &Processes { output: "" },
        )
        .await?;
        assert_eq!(result["phase"], "abandoned");
        verify_tree(&f.app, &original, false)?;
        assert!(journal.slot.exists());
        Ok(())
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn old_recipe_requires_explicit_upgrade_and_restore_is_available_after_native_profile_switch()
    -> Result<()> {
        let f = Fixture::new()?;
        let (mut journal, mut snapshot) = f.journal(Phase::Publishing)?;
        exchange(&journal.app, &journal.slot)?;
        recover(&mut journal, &mut snapshot)?;
        journal.recipe = "bundle-v1/mod-older".into();
        save(&journal, &mut snapshot)?;
        assert!(
            installed(&f.root, &f.home)
                .unwrap_err()
                .to_string()
                .contains("upgrade required")
        );
        let status = run(
            &options("status", &f, false),
            &f.root,
            &Processes { output: "" },
        )
        .await?;
        assert_eq!(status["upgradeRequired"], true);
        assert_eq!(status["verifiedInstalled"], false);
        platform::write_json(
            &claudex_core::claude_desktop::configuration_path(&f.home),
            &json!({"deploymentMode":"1p"}),
        )?;
        let restored = run(
            &options("restore", &f, true),
            &f.root,
            &Processes { output: "" },
        )
        .await?;
        assert_eq!(restored["phase"], "restored");
        assert_eq!(fs::read(f.app.join("retained"))?, b"complete original");
        Ok(())
    }

    #[test]
    fn raw_bundle_graph_has_scoped_identity_and_never_uses_an_http_cache() -> Result<()> {
        let f = Fixture::new()?;
        let assets = f.app.join(RESOURCE).join("assets/v1");
        platform::create_private(&assets)?;
        platform::publish(
            &f.app.join(RESOURCE).join("index.html"),
            br#"<script type="module" src="/assets/v1/index-fixture.js"></script>"#,
            0o644,
        )?;
        platform::publish(
            &assets.join("index-fixture.js"),
            b"import './dependency.js'; document.getElementById(\"root\");",
            0o644,
        )?;
        platform::publish(&assets.join("dependency.js"), b"export const n=1;", 0o644)?;
        let graph = graph(&f.app, &f.home)?;
        assert_eq!(graph.modules.len(), 2);
        assert!(
            graph
                .modules
                .values()
                .all(|module| module.path.starts_with(&assets))
        );
        assert!(!frontend_graph::cache_directory(&f.home)?.exists());
        let original = inventory(&f.app, true)?;
        assert!(prepare(&f.root, &f.home, &graph).is_err()); // no structural capability
        verify_tree(&f.app, &original, false)?;
        fs::remove_file(assets.join("dependency.js"))?;
        assert!(super::graph(&f.app, &f.home).is_err());
        Ok(())
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn synthetic_adhoc_signing_preserves_runtime_permissions_and_can_launch() -> Result<()> {
        let f = Fixture::new()?;
        platform::create_private(&f.app.join("Contents/MacOS"))?;
        platform::create_private(&f.app.join("Contents/Resources"))?;
        fs::rename(
            f.app.join("retained"),
            f.app.join("Contents/Resources/retained"),
        )?;
        fs::copy("/usr/bin/true", f.app.join("Contents/MacOS/Claude"))?;
        fs::set_permissions(
            f.app.join("Contents/MacOS/Claude"),
            fs::Permissions::from_mode(0o755),
        )?;
        platform::publish(&f.app.join("Contents/Info.plist"), br#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>Claude</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#, 0o644)?;
        let vendor_entitlements = f.base.join("vendor-entitlements.plist");
        platform::publish(&vendor_entitlements, br#"<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.application-identifier</key><string>VENDOR.com.anthropic.claudefordesktop</string><key>com.apple.developer.team-identifier</key><string>VENDOR</string><key>keychain-access-groups</key><array><string>VENDOR.protected</string></array><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>"#, 0o600)?;
        platform::checked(
            &platform::SystemRunner,
            CommandSpec::new(
                "/usr/bin/codesign",
                [
                    "--force",
                    "--sign",
                    "-",
                    "--entitlements",
                    &vendor_entitlements.to_string_lossy(),
                    &f.app.to_string_lossy(),
                ],
            ),
        )
        .await?;
        let before = inventory(&f.app, true)?;
        sign_local(&f.app, &f.base, &platform::SystemRunner).await?;
        assert_eq!(
            entitlements(&f.app, &platform::SystemRunner).await?,
            json!({
                "com.apple.security.cs.allow-jit":true,
                "com.apple.security.device.audio-input":true
            })
        );
        signed_changes(&before, &inventory(&f.app, true)?)?;
        assert_eq!(
            providers::verify(&f.app, &providers::CLAUDE, &platform::SystemRunner).await?,
            providers::Publisher::Local
        );
        // Disk verification alone cannot catch AMFI's restricted-entitlement
        // refusal. Execute the isolated system true fixture, never Claude.
        platform::checked(
            &platform::SystemRunner,
            CommandSpec::new(f.app.join("Contents/MacOS/Claude"), [] as [&str; 0]),
        )
        .await?;
        Ok(())
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn normal_install_idempotence_readonly_maintenance_and_restore_use_complete_bundles()
    -> Result<()> {
        struct Offline;
        #[async_trait]
        impl Runner for Offline {
            async fn run(&self, spec: CommandSpec) -> Result<platform::CommandOutput> {
                if spec.program == Path::new("/bin/ps") {
                    return Ok(platform::CommandOutput::default()); // isolated native process data
                }
                platform::SystemRunner.run(spec).await
            }
        }
        let f = Fixture::new()?;
        platform::create_private(&f.app.join("Contents/MacOS"))?;
        let assets = f.app.join(RESOURCE).join("assets/v1");
        platform::create_private(&assets)?;
        fs::rename(
            f.app.join("retained"),
            f.app.join("Contents/Resources/retained"),
        )?;
        fs::copy("/usr/bin/true", f.app.join("Contents/MacOS/Claude"))?;
        fs::set_permissions(
            f.app.join("Contents/MacOS/Claude"),
            fs::Permissions::from_mode(0o755),
        )?;
        platform::publish(&f.app.join("Contents/Info.plist"), br#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>Claude</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#, 0o644)?;
        platform::publish(
            &f.app.join(RESOURCE).join("index.html"),
            br#"<script type="module" src="/assets/v1/index-fixture.js"></script>"#,
            0o644,
        )?;
        let sources = [
            (
                "index-fixture.js",
                "import './chat.js';import './owner.js';import './commands.js';document.getElementById(\"root\");",
            ),
            (
                "native.js",
                "var N=globalThis[\"claude.web\"]?.LocalSessions;export{N};",
            ),
            (
                "react.js",
                "var R={};var E=R.useEffect;var getters={useEffect:()=>E};export{E};",
            ),
            (
                "client.js",
                "var M={};function lookup(e){let s=M.getState();for(let[,{uuid:u,client:c}]of Object.entries(s.localClients))if(u===e)return c}export{lookup};",
            ),
            (
                "chat.js",
                "import{N}from'./native.js';function actions(){let enabled=N?.forkSession!==void 0;shortcut('amber_tributary_lantern_overview_toggle');return enabled?'reopenClosed':null}",
            ),
            (
                "owner.js",
                "import{E as effect}from'./react.js';import{lookup}from'./client.js';function view(e){let{initialSessionId:s,sessionType:type}=e;let ref=s?{id:s,type}:null,id=ref?.id??null,reader;reader=()=>ref;let current=event(reader),send;send=async(text,options)=>{if(options?.blocked)return 'blocked';await images.waitForImagesReady();let selected=current();return nativeSend(text,options,selected)};let dispatch=event(send);return{submitMessage:e=>void dispatch(e),getComposerSnapshot:()=>({}),dispatch}}",
            ),
            (
                "commands.js",
                "import{N}from'./native.js';async function commands(cwd,session){return N?.getSupportedCommands?N.getSupportedCommands({cwd:session?void 0:cwd??void 0,sessionId:session??void 0}):[]}function selected(e){return e.trustedSelectedFolder}const cold='empty slash-command list (cold CLI bridge)';",
            ),
        ];
        for (name, source) in sources {
            platform::publish(&assets.join(name), source.as_bytes(), 0o644)?;
        }
        platform::checked(
            &Offline,
            CommandSpec::new(
                "/usr/bin/codesign",
                ["--force", "--sign", "-", &f.app.to_string_lossy()],
            ),
        )
        .await?;
        let original = inventory(&f.app, true)?;
        let first = run(&options("install", &f, true), &f.root, &Offline).await?;
        assert_eq!(first["phase"], "installed");
        assert_eq!(
            first["rendererAdapters"]["adapters"]["folders"]["status"],
            "skipped"
        );
        let (journal, snapshot) = load(&f.root)?.unwrap();
        let saved_original = inventory(&journal.slot, true)?;
        copy_matches(&original, &saved_original)?;
        let second = run(&options("install", &f, true), &f.root, &Offline).await?;
        assert_eq!(first, second);
        assert_eq!(snapshot.identity, load(&f.root)?.unwrap().1.identity);
        let status = run(&options("status", &f, false), &f.root, &Offline).await?;
        assert_eq!(status["verifiedInstalled"], true);
        assert_eq!(
            installed(&f.root, &f.home)?.unwrap()["source"],
            "signed-bundle"
        );
        assert!(!frontend_graph::cache_directory(&f.home)?.exists());
        platform::write_json(
            &f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":false}),
        )?;
        let pass = crate::frontend_install::ensure(&f.root, &f.home, true, &|| Ok(()))?;
        assert_eq!(pass.summary["source"], "signed-bundle");
        assert_eq!(snapshot.identity, load(&f.root)?.unwrap().1.identity);
        platform::write_json(
            &f.root.join("app-stop.json"),
            &json!({"version":1,"stopped":true}),
        )?;
        let result = run(&options("restore", &f, true), &f.root, &Offline).await?;
        assert_eq!(result["phase"], "restored");
        copy_matches(&original, &inventory(&f.app, true)?)?;
        assert!(journal.slot.exists());
        assert!(installed(&f.root, &f.home)?.is_none());
        Ok(())
    }
}
