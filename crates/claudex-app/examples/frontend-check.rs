//! Developer-only static acceptance. Uses the production Rust proof and writer.
//! Vendor modules are never evaluated; mutations require an isolated sandbox.
use anyhow::{Context, Result, ensure};
use claudex_app::{
    cache,
    cache_install::{self, Manifest, Snapshot},
    frontend_adapters::{self, Adapter, Bindings, Selection},
    frontend_ast,
    frontend_bindings::Index,
    frontend_graph::{self, Graph, Module},
    frontend_install, frontend_maintenance, platform,
};
use claudex_core::storage::{self, FileIdentity};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

fn bindings(value: &Bindings) -> Value {
    match value {
        Bindings::Chat(a) => json!({"native":a.native}),
        Bindings::Commands(a) => json!({"fn":a.function,"session":a.session,"native":a.native}),
        Bindings::Owner(a) => json!({"componentBinding":a.component_binding,"effect":a.effect,
            "client":{"path":a.client.path,"exported":a.client.exported},
            "variants":a.variants.iter().map(|v|json!({"ref":v.reference,"read":v.read})).collect::<Vec<_>>()}),
        Bindings::Folders(a) => {
            let variants = a
                .variants
                .iter()
                .map(|v| {
                    json!({"key":v.key,"grouping":v.grouping,
                "label":v.label,"rows":v.rows,"row":v.row,"pure":v.pure,"plainMemo":v.plain_memo,
                "cache":v.cache,"size":v.size})
                })
                .collect::<Vec<_>>();
            json!({"key":a.first().key,"groupingBinding":a.grouping_binding,"subscribe":a.subscribe,
                "native":a.native,"variants":variants})
        }
    }
}
fn consumer(a: &claudex_app::frontend_folders::Consumer) -> Value {
    json!({"component":a.component,"guards":a.guards,"rows":a.rows,"cache":a.cache,"size":a.size,
        "importedPath":a.imported_path,"subscription":{"path":a.subscription.path,"exported":a.subscription.exported}})
}
fn check(graph: &Graph, root: &Path, home: &Path, output: &Path) -> Result<Value> {
    let selections = frontend_adapters::resolve(graph);
    let mut adapters = BTreeMap::new();
    for adapter in Adapter::ALL {
        let result = match &selections.adapters[&adapter] {
            Selection::Skipped { reason } => json!({"status":"skipped","reason":reason}),
            Selection::Matched(target) => {
                match frontend_adapters::prepare_sources(root, home, graph, target, adapter, None) {
                    Err(error) => {
                        json!({"status":"failed","url":target.url,"reason":error.to_string()})
                    }
                    Ok(sources) => {
                        let mut rows = vec![];
                        for (index, source) in sources.into_iter().enumerate() {
                            let path = output.join(format!("{}-{index}.mjs", adapter.name()));
                            platform::publish(&path, source.source.as_bytes(), 0o600)?;
                            let original =
                                output.join(format!("{}-{index}-original.mjs", adapter.name()));
                            let module = &graph.modules[&source.url];
                            platform::publish(&original, module.source.as_bytes(), 0o600)?;
                            let proof = if index == 0 {
                                bindings(&target.bindings)
                            } else {
                                consumer(
                                    &target
                                        .consumer
                                        .as_ref()
                                        .context("Missing consumer")?
                                        .bindings,
                                )
                            };
                            rows.push(json!({"url":source.url,"path":path,"original":original,
                            "sourceSHA256":module.source_hash,"bindings":proof}));
                        }
                        json!({"status":"matched","url":target.url,"sources":rows})
                    }
                }
            }
        };
        adapters.insert(adapter.name(), result);
    }
    frontend_graph::verify(graph).context("Static graph changed during verification.")?;
    Ok(json!({"entry":graph.entry,"missing":graph.missing,"adapters":adapters}))
}
fn published(manifest: &Path, entry: &str) -> Result<Graph> {
    let rows: Vec<Value> =
        serde_json::from_slice(&storage::read_stable_with_limit(manifest, 4 * 1024 * 1024)?.bytes)?;
    ensure!(rows.len() <= 8192, "Published graph module bound exceeded");
    let mut modules = BTreeMap::new();
    let mut total = 0;
    for row in rows {
        let url = row["url"]
            .as_str()
            .context("Missing module URL")?
            .to_owned();
        ensure!(
            frontend_graph::asset_url(&url),
            "Unexpected published module URL"
        );
        let path = PathBuf::from(row["path"].as_str().context("Missing source path")?);
        let snapshot = storage::read_stable_with_limit(&path, cache::MAX_SOURCE_BYTES)?;
        total += snapshot.bytes.len();
        ensure!(
            total <= 512 * 1024 * 1024,
            "Published graph byte bound exceeded"
        );
        let source = String::from_utf8(snapshot.bytes.clone())?;
        let ast = frontend_ast::syntax(&source)?;
        let module = Module {
            name: url.rsplit('/').next().unwrap().into(),
            path,
            url: url.clone(),
            source,
            source_hash: cache::hash(&snapshot.bytes),
            current_hash: cache::hash(&snapshot.bytes),
            identity: snapshot.identity,
            original_bytes: vec![],
            imports: frontend_ast::imports(&ast, false),
            eager_imports: frontend_ast::imports(&ast, true),
            provenance: Index::compact(&ast),
        };
        ensure!(
            modules.insert(url, module).is_none(),
            "Duplicate published URL"
        );
    }
    let entry_url = format!("{}{entry}", frontend_graph::ASSET_ROOT);
    let first = modules
        .get(&entry_url)
        .context("Published entry is missing")?;
    ensure!(
        entry.starts_with("index-") && first.source.contains("document.getElementById(\"root\")"),
        "Frontend bootstrap anchor absent"
    );
    let mut found = BTreeSet::new();
    let mut missing = BTreeSet::new();
    let mut pending = vec![entry_url.clone()];
    while let Some(url) = pending.pop() {
        if found.contains(&url) || missing.contains(&url) {
            continue;
        }
        let Some(module) = modules.get(&url) else {
            missing.insert(url);
            continue;
        };
        found.insert(url.clone());
        pending.extend(
            module
                .imports
                .iter()
                .filter_map(|s| frontend_graph::resolve_import(&url, s)),
        );
    }
    ensure!(
        missing.is_empty(),
        "Published graph has unavailable imports"
    );
    modules.retain(|url, _| found.contains(url));
    Ok(Graph {
        entry: frontend_graph::EntrySummary {
            asset: entry.into(),
            cache_filename: String::new(),
            fetched_at: String::new(),
        },
        entry_url,
        modules,
        missing,
    })
}
fn optional_names(path: &Path) -> Result<Vec<String>> {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|e| {
                Ok(e?
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Non-UTF8 cache name"))?)
            })
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}
// Inventory keys without decoding unrelated HTTP/image bodies. Descriptor and
// named identities are exact on both sides of the read.
fn cache_url(path: &Path) -> Result<Option<String>> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.uid() == platform::uid() && m.nlink() == 1 && m.mode() & 0o7777 == 0o600,
        "Unsafe cache inventory resource"
    );
    let identity = FileIdentity::from_metadata(&m);
    let mut header = [0; 24];
    let mut url = None;
    if file.read(&mut header)? == 24
        && u64::from_le_bytes(header[..8].try_into()?) == 0xfcfb6d1ba7725c30
        && u32::from_le_bytes(header[8..12].try_into()?) == 5
    {
        let length = u32::from_le_bytes(header[12..16].try_into()?) as usize;
        if (1..=4096).contains(&length) {
            let mut key = vec![0; length];
            file.read_exact(&mut key)?;
            url = std::str::from_utf8(&key)?
                .strip_prefix("1/0/")
                .filter(|s| frontend_graph::asset_url(s))
                .map(str::to_owned);
        }
    }
    ensure!(
        identity == FileIdentity::from_metadata(&file.metadata()?)
            && identity == FileIdentity::from_metadata(&fs::symlink_metadata(path)?),
        "Cache inventory changed"
    );
    Ok(url)
}
fn inventory(root: &Path, home: &Path, output: &Path) -> Result<Value> {
    let mut observed: BTreeMap<PathBuf, Snapshot> = BTreeMap::new();
    let mut journals = vec![];
    let mut originals: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut read_journal = |adapter: Adapter, path: PathBuf| -> Result<()> {
        if !platform_exists(&path.join("manifest.json"))? {
            return Ok(());
        }
        let receipt = cache_install::snapshot(&path.join("manifest.json"), 16384)?;
        let m: Manifest = serde_json::from_slice(&receipt.bytes)?;
        m.validate(
            path.parent().context("Journal parent missing")?,
            &m.cache_path,
            &m.source_hash,
        )?;
        let original =
            cache_install::snapshot(&path.join("original.cache"), cache::MAX_CACHE_BYTES)?;
        ensure!(
            original.hash == m.original_hash,
            "Immutable original hash mismatch"
        );
        let entry = cache::inspect(&original.bytes, None)?;
        ensure!(
            entry.source_hash == m.source_hash,
            "Journal source mismatch"
        );
        if let Some(old) = originals.insert(entry.url.clone(), original.bytes.clone()) {
            ensure!(old == original.bytes, "Conflicting journal originals");
        }
        journals.push(json!({"adapter":adapter.name(),"asset":entry.url.rsplit('/').next(),"url":entry.url,"cacheFilename":m.cache_path.file_name(),"status":"validated","manifest":m}));
        observed.insert(path.join("manifest.json"), receipt);
        observed.insert(path.join("original.cache"), original);
        Ok(())
    };
    for adapter in Adapter::ALL {
        let directory = root.join(adapter.directory());
        for name in optional_names(&directory)? {
            if frontend_graph::cache_filename(&name) {
                read_journal(adapter, directory.join(name).join("ui-folder-compat"))?;
            } else if name == "ui-folder-compat" {
                read_journal(adapter, directory.join(name))?;
            }
        }
    }
    read_journal(Adapter::Folders, root.join("ui-folder-compat"))?;
    let directory = frontend_graph::cache_directory(home);
    platform::directory(&directory, true, false)?;
    let names = optional_names(&directory)?;
    ensure!(names.len() <= 32768, "Cache inventory bound exceeded");
    let mut modules = BTreeMap::new();
    for name in names
        .into_iter()
        .filter(|n| frontend_graph::cache_filename(n))
    {
        let path = directory.join(&name);
        let Some(url) = cache_url(&path)? else {
            continue;
        };
        let current = cache_install::snapshot(&path, cache::MAX_CACHE_BYTES)?;
        let bytes = if let Some(original) = originals.get(&url) {
            ensure!(
                journals
                    .iter()
                    .filter(|j| j["url"] == url)
                    .any(|j| j["manifest"]["originalHash"] == current.hash
                        || j["manifest"]["patchedHash"] == current.hash
                        || j["manifest"]["previousPatchedHash"] == current.hash),
                "Foreign cache change"
            );
            original.clone()
        } else {
            current.bytes.clone()
        };
        ensure!(
            modules.insert(url, (name, bytes)).is_none(),
            "Duplicate native cache URL"
        );
        observed.insert(path, current);
    }
    for (url, bytes) in originals {
        modules.entry(url.clone()).or_insert_with(|| {
            let name = journals.iter().find(|j| j["url"] == url).unwrap()["cacheFilename"]
                .as_str()
                .unwrap()
                .to_owned();
            (name, bytes)
        });
    }
    let mut rows = vec![];
    for (index, (url, (name, bytes))) in modules.into_iter().enumerate() {
        let entry = cache::inspect(&bytes, Some(&url))?;
        ensure!(
            !entry.source.contains("__cldx") && !entry.source.contains("[Claudex "),
            "Unjournaled frontend patch"
        );
        let path = output.join(format!("{index}.cache"));
        let source = output.join(format!("{index}.mjs"));
        platform::publish(&path, &bytes, 0o600)?;
        platform::publish(&source, entry.source.as_bytes(), 0o600)?;
        let fetched = if entry.metadata.len() >= 28 {
            i64::from_le_bytes(entry.metadata[20..28].try_into()?) - 11644473600000000
        } else {
            anyhow::bail!("Missing cache response timestamp")
        };
        rows.push(json!({"url":url,"name":name,"bytesPath":path,"sourcePath":source,"sourceHash":entry.source_hash,"fetchedAtMicros":fetched}));
    }
    for (path, saved) in observed {
        let actual = cache_install::snapshot(
            &path,
            if path.ends_with("manifest.json") {
                16384
            } else {
                cache::MAX_CACHE_BYTES
            },
        )?;
        ensure!(
            actual.identity == saved.identity && actual.bytes == saved.bytes,
            "Live source changed during inventory"
        );
    }
    Ok(json!({"modules":rows,"journals":journals,"liveSourcesUnchanged":true}))
}
fn platform_exists(path: &Path) -> Result<bool> {
    claudex_app::status_app::exists(path)
}
fn sandbox(root: &Path, home: &Path, base: &Path) -> Result<()> {
    let base = fs::canonicalize(base)?;
    ensure!(
        storage::read_stable_with_limit(base.join(".frontend-check-sandbox"), 64)
            .context("Missing .frontend-check-sandbox marker")?
            .bytes
            == b"claudex-static-frontend\n",
        "Not an isolated frontend sandbox"
    );
    for path in [root, home] {
        ensure!(
            fs::canonicalize(path)? == path && path.starts_with(&base) && path != base,
            "Mutation target must be inside the isolated sandbox"
        );
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let options = platform::Options::parse(&args)?;
    ensure!(
        options.positions.is_empty()
            && options.values.keys().all(|key| [
                "root",
                "home",
                "output",
                "operation",
                "published",
                "entry",
                "sandbox",
                "cache-path",
                "adapter"
            ]
            .contains(&key.as_str())),
        "Usage: frontend-check --root PRIVATE_STATE --home COPIED_HOME --output NEW_DIRECTORY [--published MANIFEST --entry index-NAME.js] [--operation inventory|install|restore|watch --sandbox TEMP_DIRECTORY]"
    );
    let root = options.required_path("root")?;
    let home = options.required_path("home")?;
    let operation = options
        .values
        .get("operation")
        .map(String::as_str)
        .unwrap_or("check");
    if matches!(operation, "install" | "restore" | "watch") {
        sandbox(&root, &home, &options.required_path("sandbox")?)?;
        if operation == "watch" {
            let mut config = frontend_maintenance::Config::new(root, home, true);
            config.settle = std::time::Duration::from_millis(50);
            let runtime = frontend_maintenance::NativeRuntime {
                after_pass: None,
                on_status: Some(Arc::new(|s| {
                    println!("{}", json!({"status":s}));
                    let _ = std::io::stdout().flush();
                })),
            };
            let maintenance = frontend_maintenance::Maintenance::new(config, Arc::new(runtime))?;
            maintenance.start().await?;
            let (send, mut receive) = tokio::sync::mpsc::channel(64);
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    if send.blocking_send(line).is_err() {
                        break;
                    }
                }
            });
            while let Some(line) = receive.recv().await {
                let v: Value = serde_json::from_str(&line?)?;
                maintenance.notify(v["filename"].as_str().map(str::to_owned));
            }
            maintenance.close().await;
            return Ok(());
        }
        let result = if operation == "install" {
            let output = options.required_path("output")?;
            ensure!(
                !platform_exists(&output)? && output.starts_with(options.required_path("sandbox")?),
                "Installed output must be new and isolated"
            );
            platform::create_private(&output)?;
            let mut summary = frontend_install::ensure(&root, &home, true, &|| Ok(()))?.summary;
            let graph = frontend_graph::discover(&root, &home)?;
            let selections = frontend_adapters::resolve(&graph);
            let mut urls = BTreeSet::new();
            for selection in selections.adapters.values() {
                if let Some(target) = selection.target() {
                    urls.insert(target.url.clone());
                    if let Some(c) = &target.consumer {
                        urls.insert(c.url.clone());
                    }
                }
            }
            let mut sources = vec![];
            for (i, url) in urls.into_iter().enumerate() {
                let module = &graph.modules[&url];
                let snapshot = cache_install::snapshot(&module.path, cache::MAX_CACHE_BYTES)?;
                let entry = cache::inspect(&snapshot.bytes, Some(&url))?;
                let path = output.join(format!("{i}.mjs"));
                platform::publish(&path, entry.source.as_bytes(), 0o600)?;
                sources.push(json!({"url":url,"path":path}));
            }
            summary["installedSources"] = json!(sources);
            summary
        } else {
            let adapter = Adapter::ALL
                .into_iter()
                .find(|a| Some(a.name()) == options.values.get("adapter").map(String::as_str))
                .context("Unknown adapter")?;
            frontend_install::restore_adapter(
                &root,
                &home,
                &options.required_path("cache-path")?,
                adapter,
                &|| Ok(()),
            )?
        };
        println!("{}", result);
        return Ok(());
    }
    ensure!(
        matches!(operation, "check" | "inventory"),
        "Unknown frontend check operation"
    );
    let output = options.required_path("output")?;
    ensure!(
        !platform_exists(&output)?
            && !output.starts_with(&root)
            && !output.starts_with(home.join("Library/Application Support/Claude")),
        "Output must be new and outside live state/cache"
    );
    platform::create_private(&output)?;
    let result = if operation == "inventory" {
        inventory(&root, &home, &output)?
    } else {
        let graph = if let Some(manifest) = options.values.get("published") {
            published(
                Path::new(manifest),
                options
                    .values
                    .get("entry")
                    .context("Published entry missing")?,
            )?
        } else {
            frontend_graph::discover(&root, &home)?
        };
        check(&graph, &root, &home, &output)?
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
