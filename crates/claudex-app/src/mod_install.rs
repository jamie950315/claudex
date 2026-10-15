//! Staging and exact-payload verification for the native Claude Mod manager.
use crate::{
    cache::hash,
    platform::{self, CommandSpec, Runner, checked},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};
pub const MOD_ID: &str = "claudex@claudex-local";
pub const INLINE_ID: &str = "claudex@inline";
pub const STAGE_FILES: &[&str] = &[
    "plugins/claudex/.claude-plugin/plugin.json",
    "plugins/claudex/hooks/hooks.json",
    "plugins/claudex/hooks/register.mjs",
    "plugins/claudex/hooks/controller.mjs",
    "plugins/claudex/hooks/panel.mjs",
    "plugins/claudex/hooks/localization.mjs",
    "plugins/claudex/hooks/locales.mjs",
    "plugins/claudex/hooks/delivery.mjs",
    "plugins/claudex/hooks/cache-warm.mjs",
    "plugins/claudex/hooks/cache-warm-display.mjs",
    "plugins/claudex/tests/native.test.ts",
    "plugins/claudex/README.md",
    "plugins/claudex/skills/claudex-workflow/SKILL.md",
    "plugins/claudex/skills/warm/SKILL.md",
];
const EXECUTABLE: &str = "runtime/bin/claudex";
const EXECUTABLE_LIMIT: usize = 256 * 1024 * 1024;
fn target(file: &str) -> String {
    file.strip_prefix("plugins/claudex/")
        .map(str::to_string)
        .unwrap_or_else(|| format!("runtime/{file}"))
}
pub fn validate_catalog(source: &str) -> Result<Value> {
    ensure!(
        source.len() <= 1024 * 1024,
        "MOD_LOCALES: catalog exceeds source bound."
    );
    let start = source
        .find("const rows = ")
        .context("MOD_LOCALES: static translation table missing.")?
        + 13;
    let end = source[start..]
        .find(";\n\nconst languages")
        .context("MOD_LOCALES: static table terminator missing.")?
        + start;
    let rows: Value = serde_json::from_str(&source[start..end])
        .context("MOD_LOCALES: invalid static translation table.")?;
    let rows_obj = rows
        .as_object()
        .filter(|o| !o.is_empty())
        .context("MOD_LOCALES: catalog is empty.")?;
    let placeholders = regex::Regex::new(r"\{[A-Za-z][A-Za-z0-9_]*\}")?;
    let tokens = |text: &str| {
        let mut v: Vec<_> = placeholders
            .find_iter(text)
            .map(|m| m.as_str().to_string())
            .collect();
        v.sort();
        v
    };
    for (key, values) in rows_obj {
        let values = values
            .as_array()
            .filter(|v| v.len() == 8)
            .context("MOD_LOCALES: all eight translations are required.")?;
        ensure!(!key.trim().is_empty(), "MOD_LOCALES: empty key.");
        for v in values {
            let text = v
                .as_str()
                .context("MOD_LOCALES: translation is not text.")?;
            ensure!(
                !text.trim().is_empty() && tokens(key) == tokens(text),
                "MOD_LOCALES: translation placeholder mismatch."
            );
        }
    }
    Ok(rows)
}
fn sources(source: &Path, executable: &Path) -> Result<Vec<(String, Vec<u8>)>> {
    platform::directory(source, false, true)?;
    let mut out = vec![];
    for file in STAGE_FILES {
        let mut parent = source.to_path_buf();
        let parts: Vec<_> = file.split('/').collect();
        for p in &parts[..parts.len() - 1] {
            parent.push(p);
            platform::directory(&parent, false, true)?;
        }
        out.push((
            target(file),
            platform::safe_bytes(&source.join(file), platform::PRIVATE_LIMIT, false, true)?,
        ));
    }
    validate_catalog(std::str::from_utf8(&platform::safe_bytes(
        &source.join("plugins/claudex/hooks/locales.mjs"),
        1024 * 1024,
        false,
        true,
    )?)?)?;
    platform::absolute(executable)?;
    let binary = platform::safe_bytes(executable, EXECUTABLE_LIMIT, false, true)?;
    ensure!(
        std::fs::symlink_metadata(executable)?.permissions().mode() & 0o111 != 0,
        "Claudex helper is not executable."
    );
    ensure!(
        binary.len() >= 4
            && [
                b"\xcf\xfa\xed\xfe".as_slice(),
                b"\xce\xfa\xed\xfe".as_slice(),
                b"\xca\xfe\xba\xbe".as_slice(),
                b"\xca\xfe\xba\xbf".as_slice()
            ]
            .contains(&&binary[..4]),
        "The staged helper must be a native Mach-O executable, not a script."
    );
    out.push((EXECUTABLE.into(), binary));
    Ok(out)
}
fn configured_manifest(
    bytes: &[u8],
    root: &Path,
    native: bool,
    self_wake: bool,
) -> Result<(Value, Vec<u8>)> {
    let mut manifest: Value = serde_json::from_slice(bytes)?;
    ensure!(
        manifest["name"] == "claudex"
            && manifest["version"]
                .as_str()
                .is_some_and(|s| regex::Regex::new(r"^\d+\.\d+\.\d+$").unwrap().is_match(s)),
        "Invalid bundled Mod identity or version."
    );
    for (key, value) in [
        ("stateRoot", json!(root)),
        ("nativeWake", json!(native)),
        ("selfWake", json!(self_wake)),
    ] {
        ensure!(
            manifest["userConfig"][key].is_object(),
            "Mod schema is missing a required public setting."
        );
        manifest["userConfig"][key]["default"] = value;
    }
    let mut bytes = serde_json::to_vec_pretty(&manifest)?;
    bytes.push(b'\n');
    Ok((manifest, bytes))
}
pub fn stage(
    source: &Path,
    output: &Path,
    root: &Path,
    executable: &Path,
    native: bool,
    self_wake: bool,
) -> Result<Value> {
    for p in [source, output, root, executable] {
        platform::absolute(p)?;
    }
    ensure!(
        std::fs::canonicalize(output.parent().context("Stage parent missing")?)?
            == output.parent().unwrap(),
        "Use a canonical stage parent."
    );
    platform::directory(root, true, false)?;
    let mut files = sources(source, executable)?;
    let manifest_pos = files
        .iter()
        .position(|(p, _)| p == ".claude-plugin/plugin.json")
        .unwrap();
    let (manifest, bytes) = configured_manifest(&files[manifest_pos].1, root, native, self_wake)?;
    files[manifest_pos].1 = bytes;
    std::fs::DirBuilder::new().mode(0o700).create(output)?;
    let plugin = output.join("plugins/claudex");
    let mut hashes = serde_json::Map::new();
    for (file, bytes) in files {
        let destination = plugin.join(&file);
        platform::create_private(destination.parent().unwrap())?;
        platform::publish(
            &destination,
            &bytes,
            if file == EXECUTABLE { 0o700 } else { 0o600 },
        )?;
        hashes.insert(file, json!(hash(&bytes)));
    }
    platform::create_private(&output.join(".claude-plugin"))?;
    platform::write_json(
        &output.join(".claude-plugin/marketplace.json"),
        &json!({"name":"claudex-local","owner":{"name":"Claudex local installation"},"plugins":[{"name":"claudex","source":"./plugins/claudex","description":manifest["description"],"version":manifest["version"]}]}),
    )?;
    let report = json!({"version":1,"plugin":plugin,"marketplace":output,"stateRoot":root,"runtime":"rust","documentedModBaseline":"2.1.287","versionLoadGate":false,"nativeWake":native,"selfWake":self_wake,"hashes":hashes,"nativeValidation":"required","synchronizationPolicy":"unchanged","automaticInstallation":false});
    platform::write_json(&output.join("stage-report.json"), &report)?;
    Ok(report)
}
pub fn file_tree(root: &Path, hashes: &Value, native_metadata: bool) -> Result<()> {
    platform::directory(root, false, false)?;
    let expected = hashes
        .as_object()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .context("Invalid bounded Mod inventory.")?;
    for (path, h) in expected {
        ensure!(
            !path.starts_with('/')
                && !path.split('/').any(|p| p == ".." || p.is_empty())
                && h.as_str().is_some_and(|s| s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())),
            "Invalid Mod inventory entry."
        );
    }
    let mut found = BTreeSet::new();
    let mut pending = vec![(root.to_path_buf(), String::new(), 0)];
    let mut count = 0;
    while let Some((path, prefix, depth)) = pending.pop() {
        platform::directory(&path, false, false)?;
        ensure!(depth <= 16, "Mod tree depth exceeds limit.");
        for entry in std::fs::read_dir(&path)? {
            let entry = entry?;
            count += 1;
            ensure!(count <= 256, "Mod tree inventory exceeds limit.");
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Invalid file name"))?;
            let relative = format!("{prefix}{name}");
            let m = std::fs::symlink_metadata(entry.path())?;
            ensure!(!m.file_type().is_symlink(), "Mod tree contains symlink.");
            if m.is_dir() {
                pending.push((entry.path(), format!("{relative}/"), depth + 1));
                continue;
            }
            let bytes = platform::safe_bytes(
                &entry.path(),
                if relative == EXECUTABLE {
                    EXECUTABLE_LIMIT
                } else {
                    platform::PRIVATE_LIMIT
                },
                false,
                false,
            )?;
            if relative == EXECUTABLE {
                ensure!(
                    m.permissions().mode() & 0o111 != 0,
                    "Installed Mod helper is not executable."
                );
            }
            if native_metadata && !expected.contains_key(&relative) && generated_metadata(&relative)
            {
                continue;
            }
            ensure!(
                expected.get(&relative).and_then(Value::as_str) == Some(hash(&bytes).as_str()),
                "content-mismatch: installed Mod differs from complete packaged inventory."
            );
            found.insert(relative);
        }
    }
    ensure!(
        found.len() == expected.len(),
        "content-mismatch: Mod installation has missing files."
    );
    Ok(())
}
fn generated_metadata(path: &str) -> bool {
    [
        "tsconfig.json",
        ".orphaned_at",
        ".claude-plugin/types/.gitignore",
        ".claude-plugin/types/tsconfig.json",
    ]
    .contains(&path)
        || regex::Regex::new(r"^\.in_use/[1-9][0-9]{0,9}$")
            .unwrap()
            .is_match(path)
        || regex::Regex::new(r"^\.claude-plugin/types/[a-z0-9][a-z0-9-]{0,63}/index\.d\.ts$")
            .unwrap()
            .is_match(path)
}
#[derive(Clone)]
pub struct InstallOptions {
    pub root: PathBuf,
    pub home: PathBuf,
    pub engine: PathBuf,
    pub executable: PathBuf,
    pub manager: PathBuf,
    pub read_only: bool,
    pub receiver: Option<bool>,
    pub enable: bool,
}
pub struct Installer<'a> {
    pub options: InstallOptions,
    pub runner: &'a dyn Runner,
}
impl Installer<'_> {
    async fn command(
        &self,
        args: Vec<String>,
        input: Option<Value>,
        json_output: bool,
    ) -> Result<Value> {
        let mut spec = CommandSpec::new(&self.options.manager, args);
        spec.cwd = Some(self.options.home.clone());
        spec.env = BTreeMap::from([
            ("HOME".into(), self.options.home.to_string_lossy().into()),
            (
                "PATH".into(),
                format!(
                    "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                    self.options.executable.parent().unwrap().display()
                ),
            ),
            ("LANG".into(), "en_US.UTF-8".into()),
        ]);
        if let Some(v) = input {
            spec.input = serde_json::to_vec(&v)?;
        }
        let reply = checked(self.runner, spec).await?;
        if json_output {
            Ok(serde_json::from_str(&reply.stdout)
                .context("native-response: unsupported Mod manager response.")?)
        } else {
            Ok(Value::Null)
        }
    }
    async fn inventory(&self) -> Result<Value> {
        let plugins = self
            .command(
                vec!["plugin".into(), "list".into(), "--json".into()],
                None,
                true,
            )
            .await?;
        let marketplaces = self
            .command(
                vec![
                    "plugin".into(),
                    "marketplace".into(),
                    "list".into(),
                    "--json".into(),
                ],
                None,
                true,
            )
            .await?;
        let installed: Vec<_> = plugins
            .as_array()
            .context("native-response: plugin inventory is not an array")?
            .iter()
            .filter(|v| v["id"] == MOD_ID)
            .cloned()
            .collect();
        let sources: Vec<_> = marketplaces
            .as_array()
            .context("native-response: marketplace inventory is not an array")?
            .iter()
            .filter(|v| v["name"] == "claudex-local")
            .cloned()
            .collect();
        ensure!(
            installed.len() <= 1
                && sources.len() <= 1
                && installed.iter().all(|v| v["scope"] == "user"),
            "installation-conflict: multiple or non-user Mod installations require review."
        );
        Ok(json!({"installed":installed.first(),"source":sources.first()}))
    }
    fn bundle(&self) -> Result<Value> {
        let mut files = sources(&self.options.engine, &self.options.executable)?;
        let mut version = Value::Null;
        let mut hashes = serde_json::Map::new();
        for (file, bytes) in &mut files {
            if file == ".claude-plugin/plugin.json" {
                let (manifest, b) = configured_manifest(bytes, &self.options.root, true, true)?;
                version = manifest["version"].clone();
                *bytes = b;
            }
            hashes.insert(file.clone(), json!(hash(bytes)));
        }
        let key = format!(
            "{}-{}",
            version.as_str().context("Missing Mod version")?,
            &hash(&serde_json::to_vec(&hashes)?)[..20]
        );
        Ok(json!({"version":version,"hashes":hashes,"key":key}))
    }
    fn source_report(&self, source: &Value) -> Result<Value> {
        ensure!(
            source["source"] == "directory",
            "foreign-marketplace: native marketplace is not a local stage."
        );
        let path = Path::new(
            source["path"]
                .as_str()
                .context("Missing marketplace path")?,
        );
        platform::directory(path, false, false)?;
        let catalog = platform::optional_json(
            &path.join(".claude-plugin/marketplace.json"),
            platform::PRIVATE_LIMIT,
            false,
        )?
        .context("Missing marketplace catalog")?;
        let mut report = platform::optional_json(
            &path.join("stage-report.json"),
            platform::PRIVATE_LIMIT,
            false,
        )?
        .context("Missing stage report")?;
        ensure!(
            catalog["name"] == "claudex-local"
                && catalog["plugins"].as_array().is_some_and(|v| v.len() == 1)
                && catalog["plugins"][0]["name"] == "claudex"
                && catalog["plugins"][0]["source"] == "./plugins/claudex"
                && report["version"] == 1
                && report["stateRoot"] == json!(self.options.root)
                && report["synchronizationPolicy"] == "unchanged",
            "foreign-marketplace: stage does not belong to this root."
        );
        let plugin = path.join("plugins/claudex");
        file_tree(&plugin, &report["hashes"], false)?;
        let manifest = platform::optional_json(
            &plugin.join(".claude-plugin/plugin.json"),
            platform::PRIVATE_LIMIT,
            false,
        )?
        .context("Missing staged manifest")?;
        ensure!(
            manifest["name"] == "claudex"
                && manifest["userConfig"]["stateRoot"]["default"] == json!(self.options.root),
            "foreign-marketplace: Mod belongs to another root."
        );
        report["version"] = manifest["version"].clone();
        report["plugin"] = json!(plugin);
        Ok(report)
    }
    async fn settings(&self, installed: &Value) -> Result<Value> {
        let path = installed["installPath"]
            .as_str()
            .context("Missing Mod path")?;
        platform::directory(Path::new(path), false, false)?;
        let mut result = json!({});
        for (key, id) in [("marketplace", MOD_ID), ("inline", INLINE_ID)] {
            let mut args = vec![];
            if key == "inline" {
                args.push(format!("--plugin-dir={path}"))
            }
            args.extend(["plugin", "configure", id, "--json"].map(str::to_string));
            let data = self.command(args, None, true).await?;
            ensure!(
                data["pluginId"] == id
                    && data["inputs"].is_object()
                    && data["schema"].is_object()
                    && data["configured"].is_array(),
                "native-configuration: unsupported Mod configuration."
            );
            let configured = data["configured"].as_array().unwrap();
            let mut values = json!({"wakeConfigured":{},"configured":true});
            for name in ["stateRoot", "nativeWake", "selfWake"] {
                let wake = name.ends_with("Wake");
                ensure!(
                    data["schema"][name]["type"] == if wake { "boolean" } else { "string" },
                    "native-configuration: unsupported setting type."
                );
                let saved = configured.contains(&json!(name));
                ensure!(
                    !saved || data["inputs"].get(name).is_some(),
                    "native-configuration: saved key has no value."
                );
                let mut value = data["inputs"]
                    .get(name)
                    .cloned()
                    .unwrap_or(data["schema"][name]["default"].clone());
                if wake {
                    value = match value {
                        Value::Bool(v) => json!(v),
                        Value::String(s) if s == "true" => json!(true),
                        Value::String(s) if s == "false" => json!(false),
                        _ => bail!("native-configuration: invalid wake preference"),
                    };
                    values["wakeConfigured"][name] = json!(saved)
                }
                if !saved {
                    values["configured"] = json!(false)
                }
                values[name] = value;
            }
            result[key] = values;
        }
        Ok(result)
    }
    pub async fn inspect(&self) -> Result<Value> {
        let packaged = self.bundle()?;
        self.inspect_bundle(&packaged).await
    }
    async fn inspect_bundle(&self, packaged: &Value) -> Result<Value> {
        let mut current = self.inventory().await?;
        let stage = if current["source"].is_null() {
            Value::Null
        } else {
            self.source_report(&current["source"])?
        };
        current["stage"] = stage.clone();
        let installed = current["installed"].clone();
        let mut report = json!({"state":"missing","reason":"not-installed","bundledVersion":packaged["version"],"installedVersion":installed["version"],"enabled":installed["enabled"].as_bool().unwrap_or(false),"loaded":null,"activation":"new-session"});
        if !installed.is_null() {
            ensure!(
                !stage.is_null(),
                "missing-marketplace: installed Mod has no verified marketplace."
            );
            let version = installed["version"]
                .as_str()
                .context("Missing installed version")?;
            let expected_path = self
                .options
                .home
                .join(".claude/plugins/cache/claudex-local/claudex")
                .join(version);
            ensure!(
                installed["installPath"] == json!(expected_path),
                "foreign-installation: native Mod is outside owned user cache."
            );
            let relative = compare_version(version, packaged["version"].as_str().unwrap())?;
            let hashes = if relative == std::cmp::Ordering::Equal {
                &packaged["hashes"]
            } else if stage["version"] == version {
                &stage["hashes"]
            } else {
                ensure!(
                    relative == std::cmp::Ordering::Less,
                    "unverified-newer-version: newer Mod has no verified source."
                );
                &Value::Null
            };
            if !hashes.is_null() {
                file_tree(&expected_path, hashes, true)?;
            }
            let settings = self.settings(&installed).await?;
            let ready = settings
                .as_object()
                .unwrap()
                .values()
                .all(|v| v["configured"] == true && v["stateRoot"] == json!(self.options.root));
            let (state, reason) = if installed["enabled"] != true {
                ("disabled", "disabled-by-user")
            } else if relative == std::cmp::Ordering::Less {
                ("update-available", "bundled-update")
            } else if !ready {
                ("update-available", "configuration-required")
            } else {
                (
                    "ready",
                    if relative == std::cmp::Ordering::Greater {
                        "newer-installed-preserved"
                    } else {
                        "installed-current"
                    },
                )
            };
            report["state"] = json!(state);
            report["reason"] = json!(reason);
            report["installPath"] = json!(expected_path);
            report["modSettings"] = settings.clone();
            current["modSettings"] = settings;
        }
        current["result"] = report;
        Ok(current)
    }
    pub async fn ensure(&self) -> Result<Value> {
        ensure!(
            !self.options.read_only,
            "Read-only Mod inspection cannot install or configure plugins."
        );
        platform::directory(&self.options.root, true, false)?;
        let packaged = self.bundle()?;
        let base = self.options.root.join("app-mod");
        platform::create_private(&base)?;
        // The shared lock fences stages, native changes and journal publication.
        let _lock = claudex_core::storage::FileLock::acquire(&base.join("install.lock"), true)?;
        let current = self.inspect_bundle(&packaged).await?;
        let installed = &current["installed"];
        if !installed.is_null()
            && compare_version(
                installed["version"].as_str().unwrap(),
                packaged["version"].as_str().unwrap(),
            )? == std::cmp::Ordering::Greater
        {
            ensure!(
                !self.options.enable || installed["enabled"] == true,
                "newer-version-settings-preserved: newer installed Mod was preserved."
            );
            if let Some(receiver) = self.options.receiver {
                ensure!(
                    current["modSettings"]
                        .as_object()
                        .unwrap()
                        .values()
                        .all(|v| v["nativeWake"] == receiver && v["selfWake"] == receiver),
                    "newer-version-settings-preserved: newer Mod settings were preserved."
                );
            }
            return Ok(current["result"].clone());
        }
        if installed["enabled"] == false && !self.options.enable
            || current["result"]["state"] == "ready"
                && self.options.receiver.is_none()
                && !self.options.enable
        {
            return Ok(current["result"].clone());
        }
        let releases = base.join("releases");
        platform::create_private(&releases)?;
        let mut stage_path = releases.join(packaged["key"].as_str().unwrap());
        let journal_path = base.join("install.json");
        let previous = platform::optional_json(&journal_path, platform::PRIVATE_LIMIT, true)?;
        ensure!(
            previous
                .as_ref()
                .is_none_or(|v| v["version"] == 1 && v["owner"] == "claudex-app"),
            "invalid-journal: unknown installation journal preserved."
        );
        if stage_path.exists() && !stage_path.join("stage-report.json").exists() {
            stage_path = releases.join(format!(
                "{}-recovery-{}",
                packaged["key"].as_str().unwrap(),
                uuid::Uuid::new_v4()
            ));
        }
        let staged = if stage_path.exists() {
            self.source_report(&json!({"source":"directory","path":stage_path}))?
        } else {
            stage(
                &self.options.engine,
                &stage_path,
                &self.options.root,
                &self.options.executable,
                true,
                true,
            )?
        };
        let plugin = Path::new(staged["plugin"].as_str().unwrap());
        file_tree(plugin, &packaged["hashes"], false)?;
        let validation = self
            .command(
                vec![
                    "plugin".into(),
                    "validate".into(),
                    plugin.to_string_lossy().into(),
                    "--strict".into(),
                    "--json".into(),
                ],
                None,
                true,
            )
            .await?;
        ensure!(
            validation["success"] == true && validation["strict"] == true,
            "native-validation: strict validation refused."
        );
        file_tree(plugin, &packaged["hashes"], false)?;
        let mut journal = json!({"version":1,"owner":"claudex-app","bundledVersion":packaged["version"],"stagePath":stage_path,"previousSource":previous.as_ref().and_then(|v|v.get("previousSource")).cloned().unwrap_or(current["source"]["path"].clone()),"previousVersion":installed["version"],"hashes":packaged["hashes"],"startedAt":chrono::Utc::now().to_rfc3339()});
        save_phase(&journal_path, &mut journal, "validated")?;
        let before = self.inventory().await?;
        ensure!(
            before["source"] == current["source"] && before["installed"] == current["installed"],
            "installation-changed: native Mod changed during setup."
        );
        if current["source"]["path"] != json!(stage_path) {
            self.command(
                vec![
                    "plugin".into(),
                    "marketplace".into(),
                    "add".into(),
                    stage_path.to_string_lossy().into(),
                    "--scope".into(),
                    "user".into(),
                ],
                None,
                false,
            )
            .await?;
            let check = self.inventory().await?;
            ensure!(
                check["source"]["source"] == "directory"
                    && check["source"]["path"] == json!(stage_path),
                "marketplace-not-applied: native source change not observed."
            );
        }
        save_phase(&journal_path, &mut journal, "marketplace-registered")?;
        let native = self.inventory().await?;
        if native["installed"].is_null() || native["installed"]["version"] != packaged["version"] {
            file_tree(plugin, &packaged["hashes"], false)?;
            let candidate = self
                .options
                .home
                .join(".claude/plugins/cache/claudex-local/claudex")
                .join(packaged["version"].as_str().unwrap());
            if candidate.exists() {
                file_tree(&candidate, &packaged["hashes"], true)?;
            }
            let result = self
                .command(
                    vec![
                        "plugin".into(),
                        if native["installed"].is_null() {
                            "install"
                        } else {
                            "update"
                        }
                        .into(),
                        MOD_ID.into(),
                        "--scope".into(),
                        "user".into(),
                        "--json".into(),
                    ],
                    None,
                    true,
                )
                .await?;
            ensure!(
                result["outcome"] == "ok",
                "native-installation: native manager did not report success."
            );
        }
        let installed = self.inventory().await?["installed"].clone();
        ensure!(
            installed["version"] == packaged["version"],
            "installation-not-applied: bundled version not installed."
        );
        let path = self
            .options
            .home
            .join(".claude/plugins/cache/claudex-local/claudex")
            .join(packaged["version"].as_str().unwrap());
        ensure!(
            installed["installPath"] == json!(path),
            "foreign-installation: unexpected native Mod cache."
        );
        file_tree(&path, &packaged["hashes"], true)?;
        save_phase(&journal_path, &mut journal, "installed")?;
        let existing = self.settings(&installed).await?;
        for (key, id) in [("marketplace", MOD_ID), ("inline", INLINE_ID)] {
            let prior = &existing[key];
            let wake = |name: &str| {
                self.options.receiver.unwrap_or_else(|| {
                    if prior["wakeConfigured"][name] == true {
                        prior[name].as_bool().unwrap()
                    } else {
                        true
                    }
                })
            };
            let values = json!({"stateRoot":self.options.root,"nativeWake":wake("nativeWake").to_string(),"selfWake":wake("selfWake").to_string()});
            if prior["configured"] == true
                && ["stateRoot"].iter().all(|n| prior[*n] == values[*n])
                && prior["nativeWake"] == wake("nativeWake")
                && prior["selfWake"] == wake("selfWake")
            {
                continue;
            }
            let mut args = vec![];
            if key == "inline" {
                args.push(format!("--plugin-dir={}", path.display()))
            }
            args.extend(
                ["plugin", "configure", id, "--values-stdin", "--json"].map(str::to_string),
            );
            self.command(args, Some(values), true).await?;
        }
        if self.options.enable && installed["enabled"] != true {
            self.command(
                ["plugin", "enable", MOD_ID, "--scope", "user", "--json"]
                    .map(str::to_string)
                    .to_vec(),
                None,
                true,
            )
            .await?;
        }
        let mut result = self.inspect_bundle(&packaged).await?["result"].clone();
        ensure!(
            result["state"] == "ready",
            "configuration-not-applied: native Mod configuration incomplete."
        );
        if let Some(receiver) = self.options.receiver {
            ensure!(
                result["modSettings"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|v| v["nativeWake"] == receiver && v["selfWake"] == receiver),
                "configuration-not-applied: receiver preference not observed."
            );
        }
        save_phase(&journal_path, &mut journal, "complete")?;
        result["changed"] = json!(true);
        Ok(result)
    }
}
fn save_phase(path: &Path, journal: &mut Value, phase: &str) -> Result<()> {
    journal["phase"] = json!(phase);
    journal["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
    platform::write_json(path, journal)
}
pub fn compare_version(a: &str, b: &str) -> Result<std::cmp::Ordering> {
    fn parts(s: &str) -> Result<Vec<u64>> {
        let v = s
            .split('.')
            .map(str::parse)
            .collect::<Result<Vec<u64>, _>>()?;
        ensure!(v.len() == 3, "Unsupported version format.");
        Ok(v)
    }
    Ok(parts(a)?.cmp(&parts(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_is_data_not_executable() {
        assert!(validate_catalog("const rows = {\"Hi {name}\":[\"A {name}\",\"B {name}\",\"C {name}\",\"D {name}\",\"E {name}\",\"F {name}\",\"G {name}\",\"H {name}\"]};\n\nconst languages = [];").is_ok());
        assert!(validate_catalog("const rows = eval('bad');\n\nconst languages=[];").is_err());
    }
    #[test]
    fn full_payload_is_checked_even_for_metadata() {
        let t = tempfile::tempdir().unwrap();
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        platform::publish(&t.path().join("file.mjs"), b"safe", 0o600).unwrap();
        let hashes = json!({"file.mjs":hash(b"safe")});
        file_tree(&std::fs::canonicalize(t.path()).unwrap(), &hashes, true).unwrap();
        platform::publish(&t.path().join("extra.mjs"), b"unexpected", 0o600).unwrap();
        assert!(file_tree(&std::fs::canonicalize(t.path()).unwrap(), &hashes, true).is_err());
    }
}
