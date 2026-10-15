//! Next-normal-start Desktop activation with exact owned-runtime migration.
use crate::service::CommandRunner;
use anyhow::{Context, Result, bail};
use claudex_core::{codex_layout::*, storage::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct InstallOptions {
    pub root: PathBuf,
    pub engine: PathBuf,
    pub binary: PathBuf,
    pub node: Option<PathBuf>,
}
pub struct InstalledLauncher {
    pub shim: PathBuf,
    pub binary: PathBuf,
    pub node: PathBuf,
    pub launcher: PathBuf,
    pub engine: Option<PathBuf>,
}
/// Exact generated-file ownership, without touching the launch environment.
pub fn installed_launcher(root: &Path) -> Result<Option<InstalledLauncher>> {
    let Some(state) = load(root)? else {
        return Ok(None);
    };
    if state.pending_runtime.is_some() {
        bail!("Desktop runtime update is pending.");
    }
    checked_shim(&state)?;
    if let Some(expected) = &state.host_hash {
        if hash_bytes(&checked_file(&state.launcher, &[0o600])?.bytes) != *expected {
            bail!("Desktop signed-host ownership changed.");
        }
    }
    Ok(Some(InstalledLauncher {
        shim: state.shim,
        binary: state.binary,
        node: state.node,
        launcher: state.launcher,
        engine: state.engine,
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: u32,
    shim: PathBuf,
    shim_hash: String,
    previous_cli_path: Option<String>,
    node: PathBuf,
    binary: PathBuf,
    launcher: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_runtime: Option<Box<State>>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

fn path_text(path: &Path) -> Result<&str> {
    let text = path.to_str().context("Desktop paths must be UTF-8")?;
    if !path.is_absolute() || text.contains(['\r', '\n', '\0']) {
        bail!("Desktop launcher paths must be absolute single-line paths.");
    }
    Ok(text)
}
fn quote(path: &Path) -> Result<String> {
    Ok(format!("'{}'", path_text(path)?.replace('\'', "'\\''")))
}
fn shim_text(root: &Path, state: &State) -> Result<String> {
    let engine = state
        .engine
        .as_deref()
        .map(quote)
        .transpose()?
        .map(|v| format!(" {v}"))
        .unwrap_or_default();
    Ok(format!(
        "#!/bin/sh\n# Claudex-owned native Desktop transport launcher.\nexport CLAUDEX_HOME={}\nexport CLAUDEX_CODEX_BINARY={}\nexec {} {}{} \"$@\"\n",
        quote(root)?,
        quote(&state.binary)?,
        quote(&state.node)?,
        quote(&state.launcher)?,
        engine
    ))
}
pub fn desktop_shim(
    root: &Path,
    node: &Path,
    host: &Path,
    engine: &Path,
    binary: &Path,
) -> Result<String> {
    let state = State {
        version: 1,
        shim: root.join("codex-launcher"),
        shim_hash: String::new(),
        previous_cli_path: None,
        node: node.into(),
        binary: binary.into(),
        launcher: host.into(),
        engine: Some(engine.into()),
        host_hash: None,
        pending_runtime: None,
        extra: Default::default(),
    };
    shim_text(root, &state)
}
fn manifest(root: &Path) -> PathBuf {
    root.join("desktop-launcher.json")
}
fn load(root: &Path) -> Result<Option<State>> {
    let value = read_json_or(manifest(root), Value::Null)?;
    if value.is_null() {
        return Ok(None);
    }
    let state: State =
        serde_json::from_value(value).context("Invalid Desktop installation ownership record")?;
    validate(root, &state, true)?;
    Ok(Some(state))
}
fn save(root: &Path, state: &State) -> Result<()> {
    write_json(manifest(root), &serde_json::to_value(state)?)
}
fn validate(root: &Path, state: &State, pending: bool) -> Result<()> {
    for path in [&state.shim, &state.node, &state.binary, &state.launcher] {
        path_text(path)?;
    }
    if state.version != 1
        || state.shim != root.join("codex-launcher")
        || state.previous_cli_path.is_some()
        || state.shim_hash != hash_bytes(shim_text(root, state)?)
    {
        bail!("Existing Desktop runtime identity is unproven.");
    }
    match (&state.engine, &state.host_hash) {
        (None, None) => (),
        (Some(engine), Some(digest)) => {
            path_text(engine)?;
            if state.launcher != root.join("codex-host.mjs")
                || digest.len() != 64
                || !digest.bytes().all(|b| b.is_ascii_hexdigit())
            {
                bail!("Invalid Desktop signed-host identity.");
            }
        }
        _ => bail!("Incomplete Desktop signed-host identity."),
    }
    if let Some(next) = state.pending_runtime.as_deref() {
        if !pending {
            bail!("Nested Desktop runtime update intent.");
        }
        validate(root, next, false)?;
        let legacy_migration = state.engine.is_none()
            && next.engine.is_some()
            && state
                .launcher
                .file_name()
                .is_some_and(|s| s == "claudex-codex.mjs");
        if state.shim != next.shim
            || (state.binary != next.binary && !is_bundled_relocation(&state.binary, &next.binary))
            || (state.launcher != next.launcher && !legacy_migration)
        {
            bail!("Invalid Desktop runtime update intent.");
        }
    }
    Ok(())
}
fn checked_file(path: &Path, modes: &[u32]) -> Result<StableFile> {
    let source = read_stable(path)?;
    if source.identity.uid != uid().to_string()
        || source.identity.nlink != "1"
        || !modes.contains(&(source.identity.mode.parse::<u32>()? & 0o777))
        || source.bytes.len() > 1024 * 1024
    {
        bail!("Desktop launcher ownership changed; configuration was not modified.");
    }
    Ok(source)
}
fn checked_shim(state: &State) -> Result<StableFile> {
    let source = checked_file(&state.shim, &[0o700])?;
    if hash_bytes(&source.bytes) != state.shim_hash {
        bail!("Desktop launcher ownership changed; configuration was not modified.");
    }
    Ok(source)
}
fn same_file(path: &Path, source: &StableFile) -> Result<()> {
    let current = read_stable(path)?;
    if current.identity != source.identity || current.bytes != source.bytes {
        bail!("Desktop launcher changed during publication; it was preserved.");
    }
    Ok(())
}
fn executable(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.file_type().is_symlink() || info.permissions().mode() & 0o111 == 0 {
        bail!("Desktop integration requires an executable regular file.");
    }
    Ok(())
}
async fn environment(runner: &dyn CommandRunner) -> Result<String> {
    let output = runner
        .run("launchctl", &["getenv".into(), "CODEX_CLI_PATH".into()])
        .await?;
    // launchctl getenv reports an unset variable with an unsuccessful exit.
    if !output.success && !output.stdout.trim().is_empty() {
        bail!("Could not inspect the Desktop launch environment.");
    }
    Ok(output.stdout.trim().to_owned())
}
async fn command(runner: &dyn CommandRunner, args: Vec<String>) -> Result<()> {
    if !runner.run("launchctl", &args).await?.success {
        bail!("Could not update the next-launch Desktop environment.");
    }
    Ok(())
}
fn check_override(current: &str, shim: &Path) -> Result<()> {
    if !current.is_empty() && current != path_text(shim)? {
        bail!("An existing CODEX_CLI_PATH override is in use; it was not overwritten.");
    }
    Ok(())
}
async fn verify_state(state: &State, verifier: &dyn BinaryVerifier) -> Result<()> {
    executable(&state.node)?;
    executable(&state.binary)?;
    verifier.verify(&state.node, "node").await?;
    if let Some(expected) = bundled_desktop_node(&state.binary) {
        if state.node != expected {
            bail!("Desktop transport requires the original same-bundle OpenAI Node runtime.");
        }
    }
    if let Some(engine) = state.engine.as_deref() {
        executable(engine)?;
    }
    Ok(())
}
fn ensure_host(state: &State, previous: Option<&State>) -> Result<()> {
    let Some(expected) = &state.host_hash else {
        return Ok(());
    };
    let bytes = crate::launcher::SIGNED_HOST_SCRIPT.as_bytes();
    if expected != &hash_bytes(bytes) {
        bail!("The signed-host update payload does not match its durable intent.");
    }
    match checked_file(&state.launcher, &[0o600]) {
        Ok(source) => {
            let digest = hash_bytes(&source.bytes);
            if &digest == expected {
                return Ok(());
            }
            if previous.and_then(|s| s.host_hash.as_ref()) != Some(&digest) {
                bail!("Desktop signed host changed; it was not overwritten.");
            }
            same_file(&state.launcher, &source)?;
            atomic_write(&state.launcher, bytes)?;
        }
        Err(e) if is_not_found(&e) => publish_exclusive(&state.launcher, bytes)?,
        Err(e) => return Err(e),
    }
    if hash_bytes(&checked_file(&state.launcher, &[0o600])?.bytes) != *expected {
        bail!("Desktop signed-host publication could not be verified.");
    }
    Ok(())
}
async fn recover(root: &Path, mut state: State, verifier: &dyn BinaryVerifier) -> Result<State> {
    let Some(next) = state.pending_runtime.take() else {
        return Ok(state);
    };
    validate(root, &next, false)?;
    verify_state(&next, verifier).await?;
    if state.binary != next.binary {
        verifier.verify(&next.binary, "codex").await?;
    }
    let source = checked_file(&state.shim, &[0o600, 0o700])?;
    let actual = hash_bytes(&source.bytes);
    if actual != state.shim_hash && actual != next.shim_hash {
        bail!("Desktop launcher changed during update; it was not replaced.");
    }
    ensure_host(&next, Some(&state))?;
    if actual != next.shim_hash {
        same_file(&state.shim, &source)?;
        atomic_write(&state.shim, shim_text(root, &next)?)?;
    }
    fs::set_permissions(&state.shim, fs::Permissions::from_mode(0o700))?;
    checked_shim(&next)?;
    save(root, &next)?;
    Ok(*next)
}

/// Configure a normal future startup. No native app or existing backend is stopped.
pub async fn install(
    options: &InstallOptions,
    runner: &dyn CommandRunner,
    verifier: &dyn BinaryVerifier,
) -> Result<Value> {
    if !cfg!(target_os = "macos") {
        bail!("Automatic Desktop launcher installation requires macOS.");
    }
    let root = private_directory(&options.root)?;
    require_private_directory(&root)?;
    let binary = resolve_bundled_codex_with(&options.binary, verifier).await?;
    let node = options
        .node
        .clone()
        .or_else(|| bundled_desktop_node(&binary))
        .unwrap_or_else(|| {
            binary
                .parent()
                .unwrap_or(Path::new("/"))
                .join("cua_node/bin/node")
        });
    let mut desired = State {
        version: 1,
        shim: root.join("codex-launcher"),
        shim_hash: String::new(),
        previous_cli_path: None,
        node,
        binary,
        launcher: root.join("codex-host.mjs"),
        engine: Some(options.engine.clone()),
        host_hash: Some(hash_bytes(crate::launcher::SIGNED_HOST_SCRIPT)),
        pending_runtime: None,
        extra: Default::default(),
    };
    desired.extra.insert("phase".into(), json!("prepared"));
    desired.shim_hash = hash_bytes(shim_text(&root, &desired)?);
    verify_state(&desired, verifier).await?;
    let lock = FileLock::acquire(root.join("desktop-install.lock"), true)?;
    check_override(&environment(runner).await?, &desired.shim)?;
    let mut state = if let Some(existing) = load(&root)? {
        let mut existing = recover(&root, existing, verifier).await?;
        if existing.binary != desired.binary
            && !is_bundled_relocation(&existing.binary, &desired.binary)
        {
            bail!("Existing Desktop installation differs; it was not overwritten.");
        }
        if existing.shim_hash != desired.shim_hash || existing.host_hash != desired.host_hash {
            checked_shim(&existing)?;
            desired.extra = existing.extra.clone();
            existing.pending_runtime = Some(Box::new(desired));
            validate(&root, &existing, true)?;
            save(&root, &existing)?;
            recover(&root, existing, verifier).await?
        } else {
            existing
        }
    } else {
        // Persist intent before publishing either executable or changing login.
        save(&root, &desired)?;
        desired
    };
    ensure_host(&state, None)?;
    match fs::symlink_metadata(&state.shim) {
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            publish_exclusive(&state.shim, shim_text(&root, &state)?)?;
            fs::set_permissions(&state.shim, fs::Permissions::from_mode(0o700))?;
        }
        Err(e) => return Err(e.into()),
    }
    if state.extra.get("phase") == Some(&json!("prepared")) {
        let source = checked_file(&state.shim, &[0o600, 0o700])?;
        if hash_bytes(&source.bytes) != state.shim_hash {
            bail!("Prepared Desktop launcher changed; it was preserved.");
        }
        same_file(&state.shim, &source)?;
        fs::set_permissions(&state.shim, fs::Permissions::from_mode(0o700))?;
    }
    checked_shim(&state)?;
    check_override(&environment(runner).await?, &state.shim)?;
    command(
        runner,
        vec![
            "setenv".into(),
            "CODEX_CLI_PATH".into(),
            path_text(&state.shim)?.into(),
        ],
    )
    .await?;
    if environment(runner).await? != path_text(&state.shim)? {
        bail!("The next-launch Codex environment could not be verified.");
    }
    state.pending_runtime = None;
    if state.extra.get("phase") == Some(&json!("prepared")) {
        state.extra.insert("phase".into(), json!("installed"));
        save(&root, &state)?;
    }
    lock.release()?;
    Ok(
        json!({"installed":true,"shim":state.shim,"activation":"next-normal-desktop-start","appRestarted":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::CommandOutput;
    use std::sync::Mutex;
    struct Accept;
    #[async_trait::async_trait]
    impl BinaryVerifier for Accept {
        async fn verify(&self, _: &Path, identifier: &str) -> Result<()> {
            assert!(["node", "codex"].contains(&identifier));
            Ok(())
        }
    }
    #[derive(Default)]
    struct Native {
        value: Mutex<String>,
        calls: Mutex<Vec<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl CommandRunner for Native {
        async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput> {
            assert_eq!(program, "launchctl");
            self.calls.lock().unwrap().push(args.to_vec());
            let mut value = self.value.lock().unwrap();
            match args[0].as_str() {
                "getenv" => (),
                "setenv" => *value = args[2].clone(),
                "unsetenv" => value.clear(),
                _ => bail!("A Desktop install must not restart or stop an app"),
            }
            Ok(CommandOutput {
                success: true,
                stdout: if args[0] == "getenv" {
                    value.clone()
                } else {
                    String::new()
                },
                stderr: String::new(),
            })
        }
    }
    fn fixture(temp: &Path) -> Result<InstallOptions> {
        let root = fs::canonicalize(temp)?.join("private root ' quoted");
        private_directory(&root)?;
        let make = |name: &str| -> Result<PathBuf> {
            let path = temp.join(name);
            fs::write(&path, "#!/bin/sh\nexit 0\n")?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
            Ok(path)
        };
        Ok(InstallOptions {
            root,
            engine: make("engine")?,
            binary: make("codex")?,
            node: Some(make("node")?),
        })
    }
    #[tokio::test]
    async fn install_reapplies_owned_override_and_uninstall_keeps_conversation_data() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let options = fixture(temp.path())?;
        let native = Native::default();
        let first = install(&options, &native, &Accept).await?;
        let before = fs::read(manifest(&options.root))?;
        assert_eq!(install(&options, &native, &Accept).await?, first);
        assert_eq!(fs::read(manifest(&options.root))?, before);
        native.value.lock().unwrap().clear();
        apply(&options.root, &options.engine, &native, &Accept).await?;
        assert_eq!(
            *native.value.lock().unwrap(),
            options.root.join("codex-launcher").to_str().unwrap()
        );
        let history = options.root.join("desktop-state.json");
        fs::write(&history, "kept native mappings")?;
        assert_eq!(
            uninstall(&options.root, &native).await?["conversationDataPreserved"],
            true
        );
        assert_eq!(fs::read_to_string(history)?, "kept native mappings");
        assert!(native.value.lock().unwrap().is_empty());
        assert!(!options.root.join("codex-host.mjs").exists());
        Ok(())
    }
    #[tokio::test]
    async fn foreign_override_and_changed_or_hardlinked_artifacts_are_preserved() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let options = fixture(temp.path())?;
        let native = Native::default();
        *native.value.lock().unwrap() = "/foreign/launcher".into();
        assert!(install(&options, &native, &Accept).await.is_err());
        assert!(!manifest(&options.root).exists());
        native.value.lock().unwrap().clear();
        install(&options, &native, &Accept).await?;
        let state = load(&options.root)?.unwrap();
        let shim = fs::read(&state.shim)?;
        fs::write(&state.shim, "foreign edit")?;
        assert!(install(&options, &native, &Accept).await.is_err());
        assert!(uninstall(&options.root, &native).await.is_err());
        assert_eq!(fs::read_to_string(&state.shim)?, "foreign edit");
        fs::write(&state.shim, shim)?;
        fs::hard_link(&state.launcher, temp.path().join("host-alias"))?;
        assert!(install(&options, &native, &Accept).await.is_err());
        assert!(uninstall(&options.root, &native).await.is_err());
        assert!(state.shim.exists());
        Ok(())
    }
    #[tokio::test]
    async fn exact_legacy_shim_migrates_through_durable_intent_and_changed_pending_shim_blocks()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let options = fixture(temp.path())?;
        let native = Native::default();
        let mut legacy = State {
            version: 1,
            shim: options.root.join("codex-launcher"),
            shim_hash: String::new(),
            previous_cli_path: None,
            node: options.node.clone().unwrap(),
            binary: options.binary.clone(),
            launcher: temp.path().join("old/bin/claudex-codex.mjs"),
            engine: None,
            host_hash: None,
            pending_runtime: None,
            extra: Default::default(),
        };
        let text = shim_text(&options.root, &legacy)?;
        legacy.shim_hash = hash_bytes(&text);
        save(&options.root, &legacy)?;
        publish_exclusive(&legacy.shim, text)?;
        fs::set_permissions(&legacy.shim, fs::Permissions::from_mode(0o700))?;
        install(&options, &native, &Accept).await?;
        let mut current = load(&options.root)?.unwrap();
        assert_eq!(current.engine, Some(options.engine.clone()));
        assert!(fs::read_to_string(&current.shim)?.contains(&quote(&options.engine)?));
        let alternate = temp.path().join("new-engine");
        fs::copy(&options.engine, &alternate)?;
        let mut next = current.clone();
        next.engine = Some(alternate);
        next.shim_hash = hash_bytes(shim_text(&options.root, &next)?);
        current.pending_runtime = Some(Box::new(next));
        save(&options.root, &current)?;
        fs::write(&current.shim, "changed after intent")?;
        assert!(
            apply(&options.root, &options.engine, &native, &Accept)
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(&current.shim)?, "changed after intent");
        assert!(load(&options.root)?.unwrap().pending_runtime.is_some());
        Ok(())
    }
    #[tokio::test]
    async fn initial_publication_recovers_only_exact_prepared_bytes() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let options = fixture(temp.path())?;
        let native = Native::default();
        install(&options, &native, &Accept).await?;
        let mut state = load(&options.root)?.unwrap();
        state.extra.insert("phase".into(), json!("prepared"));
        save(&options.root, &state)?;
        fs::set_permissions(&state.shim, fs::Permissions::from_mode(0o600))?;
        install(&options, &native, &Accept).await?;
        assert_eq!(load(&options.root)?.unwrap().extra["phase"], "installed");
        assert_eq!(
            fs::metadata(&state.shim)?.permissions().mode() & 0o777,
            0o700
        );
        Ok(())
    }
}

/// Reapply only our exact override at login, including observed package moves.
pub async fn apply(
    root: &Path,
    engine: &Path,
    runner: &dyn CommandRunner,
    verifier: &dyn BinaryVerifier,
) -> Result<()> {
    let state = load(root)?.context("Desktop launcher has not been installed.")?;
    install(
        &InstallOptions {
            root: root.into(),
            engine: engine.into(),
            binary: state.binary,
            node: Some(state.node),
        },
        runner,
        verifier,
    )
    .await?;
    Ok(())
}

pub async fn uninstall(root: &Path, runner: &dyn CommandRunner) -> Result<Value> {
    let lock = FileLock::acquire(root.join("desktop-install.lock"), true)?;
    let Some(state) = load(root)? else {
        lock.release()?;
        return Ok(json!({"removed":false}));
    };
    if state.pending_runtime.is_some() {
        bail!("Recover the pending Desktop runtime update before uninstalling.");
    }
    let shim = checked_shim(&state)?;
    let host = state
        .host_hash
        .as_ref()
        .map(|expected| -> Result<StableFile> {
            let source = checked_file(&state.launcher, &[0o600])?;
            if hash_bytes(&source.bytes) != *expected {
                bail!("Desktop signed host changed; it was preserved.");
            }
            Ok(source)
        })
        .transpose()?;
    let current = environment(runner).await?;
    check_override(&current, &state.shim)?;
    if current == path_text(&state.shim)? {
        command(runner, vec!["unsetenv".into(), "CODEX_CLI_PATH".into()]).await?;
        if !environment(runner).await?.is_empty() {
            bail!("Desktop environment changed during removal; installation was preserved.");
        }
    }
    same_file(&state.shim, &shim)?;
    if let Some(host) = host {
        same_file(&state.launcher, &host)?;
        fs::remove_file(&state.launcher)?;
    }
    fs::remove_file(&state.shim)?;
    fs::remove_file(manifest(root))?;
    lock.release()?;
    Ok(json!({"removed":true,"conversationDataPreserved":true,"appRestarted":false}))
}
