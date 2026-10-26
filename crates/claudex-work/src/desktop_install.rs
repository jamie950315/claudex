//! Entry-scoped Desktop connector installation with exact prepared-state recovery.
use crate::model::*;
use anyhow::{Context, Result, bail};
use claudex_core::{
    claude_desktop::{self, Selection},
    storage::{self, FileIdentity, FileLock},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const NAME: &str = "claudex-desktop-wake";
const LIMIT: usize = 16 * 1024 * 1024;
struct Deployment<'a> {
    home: &'a Path,
    selection: Selection,
}
impl Deployment<'_> {
    fn verify(&self) -> Result<()> {
        self.selection.verify()
    }
    fn verify_published(&self, path: &Path, result: &Option<Read>) -> Result<()> {
        if path != claude_desktop::configuration_path(self.home) {
            return self.verify();
        }
        // Gateway's configuration is also the selection source. Its expected
        // publication changes that file's identity, not the selected profile.
        let fresh = Selection::read(self.home)?;
        if fresh.user_data != self.selection.user_data || !same(&read(path, false)?, result) {
            bail!("Desktop deployment changed during connector publication.");
        }
        fresh.verify()
    }
}
struct Read {
    value: Value,
    bytes: Vec<u8>,
    identity: FileIdentity,
}
fn directory(path: &Path, private: bool) -> Result<FileIdentity> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != storage::uid()
        || m.mode() & if private { 0o077 } else { 0o022 } != 0
        || path.canonicalize()? != path
    {
        bail!("Desktop connector directory must be canonical, owned and non-writable by others.");
    }
    Ok(FileIdentity::from_metadata(&m))
}
fn read(path: &Path, private: bool) -> Result<Option<Read>> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != storage::uid()
        || m.nlink() != 1
        || m.mode() & if private { 0o077 } else { 0o022 } != 0
        || m.len() > LIMIT as u64
    {
        bail!("Desktop connector evidence must be bounded, owned, regular and single-link.");
    }
    let data = storage::read_stable_with_limit(path, LIMIT)?;
    if data.identity != FileIdentity::from_metadata(&m) {
        bail!("Desktop connector evidence changed while opening.");
    }
    let value: Value = serde_json::from_slice(&data.bytes)
        .context("Desktop configuration is malformed; existing contents were preserved")?;
    if !value.is_object() {
        bail!("Desktop configuration must be a JSON object.");
    }
    Ok(Some(Read {
        value,
        bytes: data.bytes,
        identity: data.identity,
    }))
}
fn entry(value: &Value) -> Result<Value> {
    if let Some(v) = value.get("mcpServers") {
        if !v.is_object() {
            bail!("Desktop mcpServers must be an object.");
        }
    }
    match value["mcpServers"].get(NAME) {
        None => Ok(Value::Null),
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => bail!("Desktop MCP name has an invalid existing registration."),
    }
}
fn recognized(v: &Value, root: &Path) -> bool {
    let Some(command) = v["command"].as_str() else {
        return false;
    };
    let Some(args) = v["args"].as_array() else {
        return false;
    };
    if !Path::new(command).is_absolute()
        || v.as_object().is_none_or(|o| o.len() != 2)
        || args.len() != 6
    {
        return false;
    }
    let route = args[0] == "collaboration"
        || args[0].as_str().is_some_and(|p| {
            Path::new(p).is_absolute()
                && Path::new(p)
                    .file_name()
                    .is_some_and(|p| p == "claudex-collaboration.mjs")
                && Path::new(p)
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|p| p == "bin")
        });
    route
        && args[1..]
            == [
                json!("desktop-wake-mcp"),
                json!("--root"),
                json!(root),
                json!("--peer"),
                json!("claude"),
            ]
}
fn bytes(config: &Value, new: &Value) -> Result<Vec<u8>> {
    let mut value = config.clone();
    if value.get("mcpServers").is_none() {
        value["mcpServers"] = json!({});
    }
    value["mcpServers"][NAME] = new.clone();
    let mut bytes = serde_json::to_vec_pretty(&value)?;
    bytes.push(b'\n');
    if bytes.len() > LIMIT {
        bail!("Prepared Desktop configuration exceeds its bound.");
    }
    Ok(bytes)
}
fn digest(read: &Option<Read>) -> Value {
    read.as_ref()
        .map(|r| json!(hash(&r.bytes)))
        .unwrap_or(Value::Null)
}
fn same(a: &Option<Read>, b: &Option<Read>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.identity == b.identity && a.bytes == b.bytes,
        _ => false,
    }
}
fn publish(
    path: &Path,
    bytes: &[u8],
    expected: &Option<Read>,
    deployment: Option<&Deployment<'_>>,
) -> Result<()> {
    let temp = path.with_file_name(format!(
        "{}.claudex-{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if !same(&read(path, false)?, expected) {
            bail!("Desktop configuration changed before publication.");
        }
        if let Some(deployment) = deployment {
            deployment.verify()?;
        }
        if expected.is_some() {
            fs::rename(&temp, path)?;
        } else {
            fs::hard_link(&temp, path)?;
        }
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    drop(file);
    let cleanup = fs::remove_file(&temp);
    if result.is_ok() {
        if let Err(e) = cleanup {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    result
}
/// Add or migrate only the journal-owned connector, without restarting Desktop.
pub fn desktop_wake(root: &Path, home: &Path, exe: &Path) -> Result<Value> {
    desktop_wake_profile(root, home, exe, Selection::read(home)?)
}
fn desktop_wake_profile(
    root: &Path,
    home: &Path,
    exe: &Path,
    selection: Selection,
) -> Result<Value> {
    let first_party = selection.user_data == home.join("Library/Application Support/Claude");
    let path = selection.user_data.join("claude_desktop_config.json");
    let deployment = Deployment { home, selection };
    desktop_wake_install(
        root,
        &path,
        exe,
        if first_party {
            "claude-desktop-wake-install"
        } else {
            "claude-desktop-wake-install-3p"
        },
        Some(&deployment),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
    };

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        config: PathBuf,
        exe: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("work");
            storage::private_directory(&root).unwrap();
            let parent = base.join("Claude");
            fs::create_dir(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
            Self {
                _temp: temp,
                root,
                config: parent.join("claude_desktop_config.json"),
                exe: base.join("claudex"),
            }
        }
        fn install(&self) -> Result<Value> {
            desktop_wake_at(&self.root, &self.config, &self.exe)
        }
        fn journal(&self) -> PathBuf {
            self.root.join("claude-desktop-wake-install.json")
        }
        fn desired(&self) -> Value {
            json!({"command":self.exe,"args":["collaboration","desktop-wake-mcp","--root",self.root,"--peer","claude"]})
        }
    }
    fn profiles() -> Result<(Fixture, PathBuf, PathBuf)> {
        let mut f = Fixture::new();
        let home = storage::private_directory(f.root.parent().unwrap().join("home"))?;
        let first = storage::private_directory(home.join("Library/Application Support/Claude"))?;
        let third = storage::private_directory(home.join("Library/Application Support/Claude-3p"))?;
        f.config = first.join("claude_desktop_config.json");
        Ok((f, home, third.join("claude_desktop_config.json")))
    }
    fn mode(path: &Path, mode: &str) -> Result<()> {
        let mut config = read(path, false)?.map(|r| r.value).unwrap_or(json!({}));
        config["deploymentMode"] = json!(mode);
        storage::write_json(path, &config)
    }
    #[test]
    fn native_profile_switches_isolate_journals_and_preserve_each_configuration() -> Result<()> {
        let (f, home, third) = profiles()?;
        storage::write_json(
            &f.config,
            &json!({"firstOnly":"fixture-account","preferences":{"scale":1.25}}),
        )?;
        storage::write_json(
            &third,
            &json!({"deploymentMode":"1p","thirdOnly":"fixture-gateway","mcpServers":{"other":{"command":"/usr/bin/true"}}}),
        )?;
        assert_eq!(
            desktop_wake(&f.root, &home, &f.exe)?["configPath"],
            json!(f.config)
        );
        let first_config = read(&f.config, false)?.unwrap();
        let first_journal = storage::read_stable(f.journal())?;
        mode(&third, "3p")?;
        let third_before = read(&third, false)?.unwrap().value;
        assert_eq!(desktop_wake(&f.root, &home, &f.exe)?["changed"], true);
        let installed = read(&third, false)?.unwrap();
        assert_eq!(entry(&installed.value)?, f.desired());
        assert_eq!(installed.value["thirdOnly"], third_before["thirdOnly"]);
        assert_eq!(
            installed.value["mcpServers"]["other"],
            third_before["mcpServers"]["other"]
        );
        assert!(installed.value.get("firstOnly").is_none());
        assert_eq!(
            read(&f.config, false)?.unwrap().identity,
            first_config.identity
        );
        assert_eq!(
            storage::read_stable(f.journal())?.identity,
            first_journal.identity
        );
        let third_journal = f.root.join("claude-desktop-wake-install-3p.json");
        let saved_third_journal = storage::read_stable(&third_journal)?;
        assert_eq!(
            storage::read_json(&third_journal)?["configPath"],
            json!(third)
        );
        assert_eq!(desktop_wake(&f.root, &home, &f.exe)?["changed"], false);
        mode(&third, "1p")?;
        let third_return = read(&third, false)?.unwrap();
        assert_eq!(desktop_wake(&f.root, &home, &f.exe)?["changed"], false);
        assert_eq!(
            read(&f.config, false)?.unwrap().identity,
            first_config.identity
        );
        assert_eq!(
            read(&third, false)?.unwrap().identity,
            third_return.identity
        );
        assert_eq!(
            storage::read_stable(&third_journal)?.bytes,
            saved_third_journal.bytes
        );
        Ok(())
    }
    #[test]
    fn native_profile_prepared_recovery_and_foreign_edits_keep_their_own_journal() -> Result<()> {
        for profile in ["1p", "3p"] {
            for published in [false, true] {
                let (f, home, third) = profiles()?;
                mode(&third, profile)?;
                let path = if profile == "1p" { &f.config } else { &third };
                if profile == "1p" {
                    storage::write_json(path, &json!({"preserve":true}))?;
                }
                let current = read(path, false)?;
                let after = bytes(&current.as_ref().unwrap().value, &f.desired())?;
                let name = if profile == "1p" {
                    "claude-desktop-wake-install.json"
                } else {
                    "claude-desktop-wake-install-3p.json"
                };
                let journal = f.root.join(name);
                storage::write_json(
                    &journal,
                    &json!({"version":1,"name":NAME,"configPath":path,"phase":"prepared","previousEntry":null,"installedEntry":f.desired(),"beforeHash":digest(&current),"afterHash":hash(&after)}),
                )?;
                if published {
                    storage::atomic_write(path, &after)?;
                }
                let result = desktop_wake(&f.root, &home, &f.exe)?;
                assert_eq!(result["changed"], !published);
                assert_eq!(read(path, false)?.unwrap().bytes, after);
                assert_eq!(storage::read_json(&journal)?["phase"], "installed");
                let mut foreign = read(path, false)?.unwrap().value;
                foreign["mcpServers"][NAME]["command"] = json!("/foreign/connector");
                storage::write_json(path, &foreign)?;
                let unchanged = read(path, false)?.unwrap();
                let retained = storage::read_stable(&journal)?;
                assert!(desktop_wake(&f.root, &home, &f.exe).is_err());
                assert_eq!(read(path, false)?.unwrap().identity, unchanged.identity);
                assert_eq!(storage::read_stable(&journal)?.identity, retained.identity);
            }
        }
        Ok(())
    }
    #[test]
    fn profile_switch_fences_publication_and_preserves_the_prepared_install() -> Result<()> {
        for profile in ["1p", "3p"] {
            let (f, home, third) = profiles()?;
            storage::write_json(&f.config, &json!({"preserve":true}))?;
            mode(&third, profile)?;
            let selection = Selection::read(&home)?;
            mode(&third, if profile == "1p" { "3p" } else { "1p" })?;
            let first = read(&f.config, false)?.unwrap();
            let gateway = read(&third, false)?.unwrap();
            assert!(desktop_wake_profile(&f.root, &home, &f.exe, selection).is_err());
            assert_eq!(read(&f.config, false)?.unwrap().identity, first.identity);
            assert_eq!(read(&third, false)?.unwrap().identity, gateway.identity);
            let journal = f.root.join(if profile == "1p" {
                "claude-desktop-wake-install.json"
            } else {
                "claude-desktop-wake-install-3p.json"
            });
            assert_eq!(storage::read_json(&journal)?["phase"], "prepared");
        }
        Ok(())
    }
    #[test]
    fn gateway_post_publication_proof_rejects_foreign_bytes_and_mode_changes() -> Result<()> {
        for change in ["unrelated", "mode"] {
            let (f, home, third) = profiles()?;
            mode(&third, "3p")?;
            let deployment = Deployment {
                home: &home,
                selection: Selection::read(&home)?,
            };
            desktop_wake(&f.root, &home, &f.exe)?;
            let expected = read(&third, false)?;
            deployment.verify_published(&third, &expected)?;
            let mut changed = expected.as_ref().unwrap().value.clone();
            changed[if change == "mode" {
                "deploymentMode"
            } else {
                "unrelated"
            }] = json!("1p");
            storage::write_json(&third, &changed)?;
            assert!(deployment.verify_published(&third, &expected).is_err());
        }
        Ok(())
    }
    #[test]
    fn profile_recovery_refuses_changed_preparation_and_another_profiles_journal() -> Result<()> {
        for profile in ["1p", "3p"] {
            for change in ["configuration", "journal-profile"] {
                let (f, home, third) = profiles()?;
                storage::write_json(&f.config, &json!({"preserve":true}))?;
                mode(&third, profile)?;
                let (path, other, journal) = if profile == "1p" {
                    (&f.config, &third, f.journal())
                } else {
                    (
                        &third,
                        &f.config,
                        f.root.join("claude-desktop-wake-install-3p.json"),
                    )
                };
                let current = read(path, false)?;
                let after = bytes(&current.as_ref().unwrap().value, &f.desired())?;
                storage::write_json(
                    &journal,
                    &json!({"version":1,"name":NAME,"configPath":if change == "journal-profile" { other } else { path },"phase":"prepared","previousEntry":null,"installedEntry":f.desired(),"beforeHash":digest(&current),"afterHash":hash(&after)}),
                )?;
                if change == "configuration" {
                    let mut changed = current.unwrap().value;
                    changed["foreign"] = json!(true);
                    storage::write_json(path, &changed)?;
                }
                let unchanged = read(path, false)?.unwrap();
                let retained = storage::read_stable(&journal)?;
                assert!(desktop_wake(&f.root, &home, &f.exe).is_err());
                assert_eq!(read(path, false)?.unwrap().identity, unchanged.identity);
                assert_eq!(storage::read_stable(&journal)?.identity, retained.identity);
            }
        }
        Ok(())
    }
    #[test]
    fn install_is_entry_scoped_and_idempotent() -> Result<()> {
        let f = Fixture::new();
        let unrelated = json!({"preferences":{"scale":1.25},"mcpServers":{"other":{"command":"/usr/bin/true","args":[]}}});
        storage::write_json(&f.config, &unrelated)?;
        let result = f.install()?;
        assert_eq!(result["changed"], true);
        assert_eq!(result["restartRequired"], true);
        let installed = read(&f.config, false)?.unwrap();
        assert_eq!(installed.value["preferences"], unrelated["preferences"]);
        assert_eq!(
            installed.value["mcpServers"]["other"],
            unrelated["mcpServers"]["other"]
        );
        assert_eq!(entry(&installed.value)?, f.desired());
        assert_eq!(f.install()?["changed"], false);
        assert_eq!(
            read(&f.config, false)?.unwrap().identity,
            installed.identity
        );
        Ok(())
    }
    #[test]
    fn legacy_owned_entry_migrates_without_touching_other_connectors() -> Result<()> {
        let f = Fixture::new();
        let legacy = json!({"command":"/fixture/node","args":["/fixture/engine/bin/claudex-collaboration.mjs","desktop-wake-mcp","--root",f.root,"--peer","claude"]});
        let config = json!({"mcpServers":{NAME:legacy,"other":{"command":"/usr/bin/true"}}});
        storage::write_json(&f.config, &config)?;
        let current = read(&f.config, false)?;
        let journal = json!({"version":1,"name":NAME,"configPath":f.config,"phase":"installed","previousEntry":null,"installedEntry":legacy,"beforeHash":null,"afterHash":digest(&current)});
        storage::write_json(f.journal(), &journal)?;
        assert_eq!(f.install()?["changed"], true);
        let installed = read(&f.config, false)?.unwrap();
        assert_eq!(entry(&installed.value)?, f.desired());
        assert_eq!(
            installed.value["mcpServers"]["other"],
            config["mcpServers"]["other"]
        );
        assert_eq!(storage::read_json(f.journal())?["previousInstall"], journal);
        Ok(())
    }
    #[test]
    fn prepared_install_recovers_before_and_after_config_publication() -> Result<()> {
        for published in [false, true] {
            let f = Fixture::new();
            let config = json!({"preferences":{"preserve":true}});
            storage::write_json(&f.config, &config)?;
            let before = read(&f.config, false)?;
            let after = bytes(&config, &f.desired())?;
            let journal = json!({"version":1,"name":NAME,"configPath":f.config,"phase":"prepared","previousEntry":null,"installedEntry":f.desired(),"beforeHash":digest(&before),"afterHash":hash(&after)});
            storage::write_json(f.journal(), &journal)?;
            if published {
                storage::atomic_write(&f.config, &after)?;
            }
            let result = f.install()?;
            assert_eq!(result["changed"], !published);
            if published {
                assert_eq!(result["recovered"], true);
            }
            assert_eq!(storage::read_json(f.journal())?["phase"], "installed");
            assert_eq!(read(&f.config, false)?.unwrap().bytes, after);
        }
        Ok(())
    }
    #[test]
    fn foreign_and_changed_entries_remain_untouched() -> Result<()> {
        let f = Fixture::new();
        storage::write_json(
            &f.config,
            &json!({"mcpServers":{NAME:{"command":"/foreign/connector","args":[]}}}),
        )?;
        let original = read(&f.config, false)?.unwrap();
        assert!(f.install().is_err());
        assert_eq!(read(&f.config, false)?.unwrap().identity, original.identity);
        assert!(!f.journal().exists());
        fs::remove_file(&f.config)?;
        f.install()?;
        let mut changed = storage::read_json(&f.config)?;
        changed["mcpServers"][NAME]["command"] = json!("/foreign/replacement");
        storage::write_json(&f.config, &changed)?;
        let replaced = read(&f.config, false)?.unwrap();
        assert!(f.install().is_err());
        assert_eq!(read(&f.config, false)?.unwrap().identity, replaced.identity);
        Ok(())
    }
    #[test]
    fn unsafe_configuration_and_missing_vendor_directory_are_not_adopted() -> Result<()> {
        let f = Fixture::new();
        let original = f.config.with_file_name("original.json");
        storage::write_json(&original, &json!({"preserve":true}))?;
        symlink(&original, &f.config)?;
        assert!(f.install().is_err());
        fs::remove_file(&f.config)?;
        fs::hard_link(&original, &f.config)?;
        assert!(f.install().is_err());
        fs::remove_file(&f.config)?;
        storage::write_json(&f.config, &json!({}))?;
        fs::set_permissions(&f.config, fs::Permissions::from_mode(0o666))?;
        assert!(f.install().is_err());
        assert_eq!(storage::read_json(&original)?, json!({"preserve":true}));
        let absent = f.config.parent().unwrap().join("missing/config.json");
        assert!(desktop_wake_at(&f.root, &absent, &f.exe).is_err());
        assert!(!absent.parent().unwrap().exists());
        Ok(())
    }
}
#[cfg(test)]
fn desktop_wake_at(root: &Path, path: &Path, exe: &Path) -> Result<Value> {
    desktop_wake_install(root, path, exe, "claude-desktop-wake-install", None)
}
fn desktop_wake_install(
    root: &Path,
    path: &Path,
    exe: &Path,
    journal_name: &str,
    deployment: Option<&Deployment<'_>>,
) -> Result<Value> {
    if !root.is_absolute() || !path.is_absolute() || !exe.is_absolute() {
        bail!("Desktop connector paths must be absolute.");
    }
    let parent = directory(path.parent().unwrap(), false)?;
    storage::private_directory(root)?;
    directory(root, true)?;
    let _lock = FileLock::acquire(root.join(format!("{journal_name}.lock")), true)?;
    let journal_path = root.join(format!("{journal_name}.json"));
    let current = read(path, false)?;
    let config = current
        .as_ref()
        .map(|r| r.value.clone())
        .unwrap_or(json!({}));
    let existing = entry(&config)?;
    let desired = json!({"command":exe,"args":["collaboration","desktop-wake-mcp","--root",root,"--peer","claude"]});
    let mut journal = read(&journal_path, true)?.map(|r| r.value);
    let mut recovered = false;
    if let Some(j) = &journal {
        if j["version"] != 1
            || j["name"] != NAME
            || j["configPath"] != json!(path)
            || !matches!(j["phase"].as_str(), Some("prepared" | "installed"))
            || !recognized(&j["installedEntry"], root)
            || !(j["previousEntry"].is_null() || recognized(&j["previousEntry"], root))
            || !(j["beforeHash"].is_null()
                || j["beforeHash"].as_str().is_some_and(|s| {
                    s.len() == 64
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }))
            || !j["afterHash"].as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            bail!("Desktop connector installation journal is invalid.");
        }
        if j["phase"] == "prepared" {
            if digest(&current) == j["afterHash"] && existing == j["installedEntry"] {
                recovered = true;
            } else if digest(&current) != j["beforeHash"] || existing != j["previousEntry"] {
                bail!(
                    "Desktop configuration changed after preparation; no configuration was changed."
                );
            }
        } else if existing != j["installedEntry"] {
            bail!("Installed Desktop entry changed outside Claudex; no configuration was changed.");
        }
        if j["installedEntry"] == desired && (j["phase"] == "installed" || recovered) {
            if let Some(deployment) = deployment {
                deployment.verify()?;
            }
            let mut j = j.clone();
            j["phase"] = json!("installed");
            storage::write_json(&journal_path, &j)?;
            if let Some(deployment) = deployment {
                deployment.verify()?;
            }
            return Ok(
                json!({"installed":true,"changed":false,"recovered":recovered,"name":NAME,"configPath":path,"restartRequired":true}),
            );
        }
        if j["installedEntry"] != desired && j["phase"] == "prepared" && !recovered {
            bail!(
                "Finish the prepared Desktop connector installation before selecting another executable."
            );
        }
    } else if !existing.is_null() && existing != desired {
        bail!("Desktop MCP name belongs to a different registration.");
    }
    let after = if existing == desired {
        current
            .as_ref()
            .context("Missing Desktop configuration")?
            .bytes
            .clone()
    } else {
        bytes(&config, &desired)?
    };
    if journal
        .as_ref()
        .is_none_or(|j| j["phase"] == "installed" || j["installedEntry"] != desired || recovered)
    {
        journal = Some(
            json!({"version":1,"name":NAME,"configPath":path,"phase":"prepared","previousEntry":existing,"installedEntry":desired,"beforeHash":digest(&current),"afterHash":hash(&after),"previousInstall":journal}),
        );
        if serde_json::to_vec(journal.as_ref().unwrap())?.len() > LIMIT {
            bail!("Desktop connector installation history exceeds its bound.");
        }
        storage::write_json(&journal_path, journal.as_ref().unwrap())?;
    }
    let mut journal = journal.unwrap();
    if journal["afterHash"] != hash(&after) {
        bail!("Prepared Desktop output no longer matches its journal.");
    }
    let check = directory(path.parent().unwrap(), false)?;
    if check.dev != parent.dev || check.ino != parent.ino {
        bail!("Desktop configuration directory changed.");
    }
    if !same(&read(path, false)?, &current) {
        bail!("Desktop configuration changed before publication.");
    }
    let changed = digest(&current) != journal["afterHash"];
    if changed {
        publish(path, &after, &current, deployment)?;
    } else if let Some(deployment) = deployment {
        deployment.verify()?;
    }
    let result = read(path, false)?;
    if digest(&result) != journal["afterHash"]
        || result.as_ref().is_none_or(|result| result.bytes != after)
        || entry(
            &result
                .as_ref()
                .context("Desktop configuration missing after publication")?
                .value,
        )? != desired
    {
        bail!("Desktop configuration did not retain the exact prepared registration.");
    }
    if let Some(deployment) = deployment {
        deployment.verify_published(path, &result)?;
    }
    journal["phase"] = json!("installed");
    storage::write_json(&journal_path, &journal)?;
    Ok(
        json!({"installed":true,"changed":changed,"name":NAME,"configPath":path,"restartRequired":true}),
    )
}
