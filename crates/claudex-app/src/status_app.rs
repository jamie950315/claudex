//! Signed, recoverable installation of the independent read-only status UI.
use crate::platform::{self, CommandSpec, Runner, checked};
use anyhow::{Context, Result, bail, ensure};
use claudex_core::storage::{FileLock, hash_bytes, is_not_found};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const SOURCE_NAMES: [&str; 2] = ["StatusModel.swift", "main.swift"];
const MANIFEST_LIMIT: usize = 256 * 1024;
const BUNDLE_LIMIT: usize = 128 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Paths {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub app: PathBuf,
    pub executable: PathBuf,
    pub previous: PathBuf,
    pub journal: PathBuf,
    pub artifacts: PathBuf,
    pub lock: PathBuf,
    pub label: String,
    pub launch_agent: PathBuf,
}
impl Paths {
    pub fn new(root: &Path, home: &Path) -> Result<Self> {
        platform::absolute(root)?;
        platform::absolute(home)?;
        let label = format!(
            "dev.0ruka.claudex.status.{}",
            &hash_bytes(root.to_string_lossy().as_bytes())[..12]
        );
        let directory = root.join("status-ui");
        let app = directory.join("Claudex Status.app");
        Ok(Self {
            root: root.into(),
            executable: app.join("Contents/MacOS/ClaudexStatus"),
            app,
            previous: directory.join("previous.app"),
            journal: directory.join("install.json"),
            artifacts: directory.join("artifacts"),
            lock: directory.join("install.lock"),
            launch_agent: home
                .join("Library/LaunchAgents")
                .join(format!("{label}.plist")),
            label,
            directory,
        })
    }
    pub fn definition(&self) -> LaunchDefinition {
        let x = |v: &Path| platform::xml(&v.to_string_lossy());
        LaunchDefinition {
            label: self.label.clone(),
            path: self.launch_agent.clone(),
            executable: self.executable.clone(),
            args: vec![
                self.executable.display().to_string(),
                "--root".into(),
                self.root.display().to_string(),
            ],
            plist: plist(&format!(
                "\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>--root</string><string>{}</string></array>\n<key>WorkingDirectory</key><string>{}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ProcessType</key><string>Interactive</string>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>\n",
                platform::xml(&self.label),
                x(&self.executable),
                x(&self.root),
                x(&self.root)
            )),
        }
    }
}
#[derive(Clone, Debug)]
pub struct LaunchDefinition {
    pub label: String,
    pub path: PathBuf,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub plist: String,
}
pub fn plist(body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>{body}</dict></plist>\n"
    )
}
pub fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn owned(path: &Path, limit: usize, mode: Option<u32>) -> Result<Vec<u8>> {
    let bytes = platform::safe_bytes(path, limit, true, false)?;
    if let Some(mode) = mode {
        ensure!(
            fs::symlink_metadata(path)?.permissions().mode() & 0o777 == mode,
            "Status application file mode changed."
        );
    }
    Ok(bytes)
}
pub fn owned_text(path: &Path) -> Result<Option<String>> {
    match owned(path, MANIFEST_LIMIT, Some(0o600)) {
        Ok(b) => Ok(Some(String::from_utf8(b)?)),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
fn state(path: &Path) -> Result<Option<Value>> {
    owned_text(path)?
        .map(|v| serde_json::from_str(&v).context("Malformed status application journal."))
        .transpose()
}
fn create(path: &Path) -> Result<()> {
    platform::create_private(path)
}
pub fn canonical_root(root: &Path, make: bool) -> Result<PathBuf> {
    platform::absolute(root)?;
    if make && !exists(root)? {
        create(root)?;
    }
    platform::directory(root, true, false)?;
    Ok(fs::canonicalize(root)?)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Source {
    name: String,
    sha256: String,
}
fn sources(path: &Path) -> Result<Vec<Source>> {
    SOURCE_NAMES
        .iter()
        .map(|name| {
            Ok(Source {
                name: (*name).into(),
                sha256: hash_bytes(platform::safe_bytes(
                    &path.join(name),
                    2 * 1024 * 1024,
                    false,
                    true,
                )?),
            })
        })
        .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeFile {
    path: String,
    sha256: String,
    mode: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tree {
    directories: Vec<String>,
    files: Vec<TreeFile>,
}
fn tree(app: &Path) -> Result<Tree> {
    fn visit(app: &Path, relative: &str, out: &mut Tree, bytes: &mut usize) -> Result<()> {
        let path = app.join(relative);
        platform::directory(&path, true, false)?;
        out.directories.push(relative.into());
        let mut entries = fs::read_dir(&path)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|v| v.file_name());
        for entry in entries {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Non-UTF-8 status application resource."))?;
            let next = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let full = app.join(&next);
            let m = fs::symlink_metadata(&full)?;
            if m.is_dir() && !m.file_type().is_symlink() {
                visit(app, &next, out, bytes)?;
            } else {
                let content = owned(&full, BUNDLE_LIMIT, None)?;
                *bytes += content.len();
                out.files.push(TreeFile {
                    path: next,
                    sha256: hash_bytes(content),
                    mode: m.permissions().mode() & 0o777,
                });
            }
            ensure!(
                out.files.len() + out.directories.len() <= 64 && *bytes <= BUNDLE_LIMIT,
                "Status application exceeds its artifact bound."
            );
        }
        Ok(())
    }
    let mut out = Tree {
        directories: vec![],
        files: vec![],
    };
    visit(app, "", &mut out, &mut 0)?;
    Ok(out)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    version: u8,
    root: PathBuf,
    bundle_id: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    sources: Option<Vec<Source>>,
    tree: Tree,
}
fn digest_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn artifact(paths: &Paths, id: &str) -> Result<Artifact> {
    ensure!(
        digest_id(id),
        "Invalid status application artifact identity."
    );
    let bytes = owned(
        &paths.artifacts.join(format!("{id}.json")),
        MANIFEST_LIMIT,
        Some(0o600),
    )?;
    ensure!(
        hash_bytes(&bytes) == id,
        "Status application artifact manifest changed."
    );
    let value: Artifact = serde_json::from_slice(&bytes)?;
    ensure!(
        value.version == 1 && value.root == paths.root && value.bundle_id == paths.label,
        "Status application artifact belongs to another installation."
    );
    Ok(value)
}
async fn verify_bundle(app: &Path, artifact: &Artifact, run: &dyn Runner) -> Result<()> {
    ensure!(
        tree(app)? == artifact.tree,
        "Status application bundle ownership changed; it was not replaced."
    );
    checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", &app.to_string_lossy()],
        ),
    )
    .await?;
    Ok(())
}
pub async fn signing_identity(identity: Option<&str>, run: &dyn Runner) -> Result<String> {
    let output = checked(
        run,
        CommandSpec::new(
            "/usr/bin/security",
            ["find-identity", "-v", "-p", "codesigning"],
        ),
    )
    .await?;
    let regex =
        regex::Regex::new(r#"(?m)^\s*\d+\) ([A-F0-9]{40}) "Apple Development: [^"\r\n]+"\s*$"#)?;
    let values: Vec<_> = regex
        .captures_iter(&output.stdout)
        .map(|c| c[1].to_string())
        .collect();
    if let Some(identity) = identity {
        ensure!(
            values.iter().any(|v| v == identity),
            "Requested valid Apple Development signing identity was not found."
        );
        return Ok(identity.into());
    }
    ensure!(
        values.len() == 1,
        "Specify one valid Apple Development signing identity for the status application."
    );
    Ok(values[0].clone())
}
pub fn verify_development_details(details: &str, identifier: &str) -> Result<()> {
    ensure!(
        details
            .lines()
            .any(|v| v == format!("Identifier={identifier}"))
            && details
                .lines()
                .any(|v| v.starts_with("Authority=Apple Development: "))
            && regex::Regex::new(r"(?m)^TeamIdentifier=[A-Z0-9]{10}$")?.is_match(details),
        "Application signing identity could not be verified."
    );
    Ok(())
}
pub async fn build(
    root: &Path,
    app: &Path,
    source: &Path,
    identity: Option<&str>,
    run: &dyn Runner,
) -> Result<Artifact> {
    ensure!(
        cfg!(target_os = "macos"),
        "The status application requires macOS."
    );
    platform::absolute(app)?;
    platform::directory(app.parent().context("Missing app parent.")?, true, false)?;
    ensure!(
        !exists(app)?,
        "Status application build destination already exists."
    );
    let input = sources(source)?;
    let signer = signing_identity(identity, run).await?;
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let paths = Paths::new(root, &home)?;
    for p in [app.into(), app.join("Contents"), app.join("Contents/MacOS")] {
        create(&p)?;
    }
    let metadata = plist(&format!(
        "\n<key>CFBundleIdentifier</key><string>{}</string>\n<key>CFBundleExecutable</key><string>ClaudexStatus</string>\n<key>CFBundleName</key><string>Claudex Status</string>\n<key>CFBundleDisplayName</key><string>Claudex Status</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>1.0.3</string><key>CFBundleVersion</key><string>1.0.3</string>\n<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/>\n<key>NSHighResolutionCapable</key><true/><key>ClaudexRoot</key><string>{}</string>\n",
        platform::xml(&paths.label),
        platform::xml(&root.to_string_lossy())
    ));
    platform::publish(&app.join("Contents/Info.plist"), metadata.as_bytes(), 0o600)?;
    let executable = app.join("Contents/MacOS/ClaudexStatus");
    let mut args = vec!["swiftc".into()];
    args.extend(SOURCE_NAMES.map(|n| source.join(n).display().to_string()));
    args.extend([
        "-O".into(),
        "-framework".into(),
        "Cocoa".into(),
        "-framework".into(),
        "UserNotifications".into(),
        "-o".into(),
        executable.display().to_string(),
    ]);
    let mut compile = CommandSpec::new("/usr/bin/xcrun", args);
    compile.timeout = std::time::Duration::from_secs(180);
    checked(run, compile).await?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
    ensure!(
        sources(source)? == input,
        "Status application sources changed during the build."
    );
    checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            [
                "--force",
                "--sign",
                &signer,
                "--options",
                "runtime",
                "--timestamp=none",
                &app.to_string_lossy(),
            ],
        ),
    )
    .await?;
    let signature = app.join("Contents/_CodeSignature");
    if exists(&signature)? {
        platform::directory(&signature, false, false)?;
        fs::set_permissions(&signature, fs::Permissions::from_mode(0o700))?;
        platform::directory(&signature, true, false)?;
        for entry in fs::read_dir(&signature)? {
            let path = entry?.path();
            platform::safe_bytes(&path, MANIFEST_LIMIT, false, false)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", &app.to_string_lossy()],
        ),
    )
    .await?;
    let details = checked(
        run,
        CommandSpec::new(
            "/usr/bin/codesign",
            ["-d", "--verbose=2", &app.to_string_lossy()],
        ),
    )
    .await?;
    verify_development_details(&details.stderr, &paths.label)?;
    Ok(Artifact {
        version: 1,
        root: root.into(),
        bundle_id: paths.label,
        identity: Some(signer),
        sources: Some(input),
        tree: tree(app)?,
    })
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Job {
    pub loaded: bool,
    pub running: bool,
}
pub async fn loaded_job(definition: &LaunchDefinition, run: &dyn Runner) -> Result<Job> {
    let out = run
        .run(CommandSpec::new(
            "/bin/launchctl",
            [
                "print",
                &format!("gui/{}/{}", platform::uid(), definition.label),
            ],
        ))
        .await?;
    if out.code != 0 {
        if regex::Regex::new("(?i)Could not find|No such process|No such file|service not found")?
            .is_match(&out.stderr)
        {
            return Ok(Job {
                loaded: false,
                running: false,
            });
        }
        bail!("launchctl print failed: {}", out.stderr.trim());
    }
    let field = |key: &str| -> Option<String> {
        out.stdout.lines().find_map(|line| {
            line.trim()
                .strip_prefix(&format!("{key} = "))
                .map(str::to_owned)
        })
    };
    let block = regex::Regex::new(r"(?m)^\s*arguments = \{\n([\s\S]*?)^\s*\}")?;
    let args = block.captures(&out.stdout).map(|c| {
        c[1].lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    ensure!(
        field("path").as_deref() == definition.path.to_str()
            && field("program").as_deref() == definition.executable.to_str()
            && args.as_ref() == Some(&definition.args),
        "Loaded application LaunchAgent ownership differs; it was preserved."
    );
    Ok(Job {
        loaded: true,
        running: regex::Regex::new(r"\bstate = running\b")?.is_match(&out.stdout),
    })
}
pub async fn assert_exited(paths: &Paths, run: &dyn Runner) -> Result<()> {
    ensure!(
        !loaded_job(&paths.definition(), run).await?.running,
        "Quit Claudex Status before upgrading it; synchronization does not need to stop."
    );
    if !exists(&paths.executable)? {
        return Ok(());
    }
    let out = run
        .run(CommandSpec::new(
            "/usr/sbin/lsof",
            ["-t", &paths.executable.to_string_lossy()],
        ))
        .await?;
    ensure!(
        matches!(out.code, 0 | 1) && out.stdout.trim().is_empty() && out.stderr.trim().is_empty(),
        "Quit Claudex Status before upgrading it; its executable is still in use."
    );
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    stage: String,
    artifact: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u8,
    root: PathBuf,
    app: PathBuf,
    label: String,
    launch_agent: PathBuf,
    current: Option<String>,
    previous: Option<String>,
    pending: Option<Pending>,
}
fn validate(paths: &Paths, j: &Journal) -> Result<()> {
    ensure!(
        j.version == 1
            && j.root == paths.root
            && j.app == paths.app
            && j.label == paths.label
            && j.launch_agent == paths.launch_agent
            && j.current.as_ref().is_none_or(|v| digest_id(v))
            && j.previous.as_ref().is_none_or(|v| digest_id(v)),
        "Unverified status application installation journal."
    );
    if let Some(p) = &j.pending {
        ensure!(
            uuid::Uuid::parse_str(&p.stage).is_ok_and(|u| u.hyphenated().to_string() == p.stage)
                && digest_id(&p.artifact),
            "Unverified status application upgrade intent."
        );
    }
    Ok(())
}
async fn recover(paths: &Paths, j: Journal, run: &dyn Runner) -> Result<Journal> {
    let Some(p) = &j.pending else {
        return Ok(j);
    };
    assert_exited(paths, run).await?;
    let candidate = artifact(paths, &p.artifact)?;
    let stage_root = paths.directory.join(format!("stage-{}", p.stage));
    let stage = stage_root.join("Claudex Status.app");
    let current = j
        .current
        .as_deref()
        .map(|id| artifact(paths, id))
        .transpose()?;
    if exists(&stage)? {
        platform::directory(&stage_root, true, false)?;
        verify_bundle(&stage, &candidate, run).await?;
        if exists(&paths.app)? {
            verify_bundle(
                &paths.app,
                current
                    .as_ref()
                    .context("An unowned status application occupies the installation path.")?,
                run,
            )
            .await?;
            if exists(&paths.previous)? {
                let previous = artifact(
                    paths,
                    j.previous
                        .as_deref()
                        .context("Unowned previous status application was preserved.")?,
                )?;
                verify_bundle(&paths.previous, &previous, run).await?;
                fs::remove_dir_all(&paths.previous)?;
            }
            assert_exited(paths, run).await?;
            fs::rename(&paths.app, &paths.previous)?;
        } else if let Some(current) = &current {
            verify_bundle(&paths.previous, current, run).await?;
        }
        fs::rename(&stage, &paths.app)?;
    }
    verify_bundle(&paths.app, &candidate, run).await?;
    if let Some(current) = &current {
        verify_bundle(&paths.previous, current, run).await?;
    }
    let complete = Journal {
        previous: j.current.clone(),
        current: Some(p.artifact.clone()),
        pending: None,
        ..j
    };
    platform::write_json(&paths.journal, &serde_json::to_value(&complete)?)?;
    if exists(&stage_root)? {
        platform::directory(&stage_root, true, false)?;
        if fs::read_dir(&stage_root)?.next().is_none() {
            fs::remove_dir(&stage_root)?;
        }
    }
    Ok(complete)
}
fn discard_failed(stage: &Path) -> Result<()> {
    fn check(base: &Path, rel: &str) -> Result<()> {
        let p = base.join(rel);
        let m = fs::symlink_metadata(&p)?;
        use std::os::unix::fs::MetadataExt;
        ensure!(
            !m.file_type().is_symlink() && m.uid() == platform::uid() && m.mode() & 0o022 == 0,
            "Failed status build contains unverified files and was preserved."
        );
        if m.is_dir()
            && [
                "",
                "Claudex Status.app",
                "Claudex Status.app/Contents",
                "Claudex Status.app/Contents/MacOS",
                "Claudex Status.app/Contents/_CodeSignature",
            ]
            .contains(&rel)
        {
            for e in fs::read_dir(&p)? {
                let name = e?
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Unverified failed build entry."))?;
                check(
                    base,
                    &if rel.is_empty() {
                        name
                    } else {
                        format!("{rel}/{name}")
                    },
                )?;
            }
        } else {
            ensure!(
                m.is_file()
                    && m.nlink() == 1
                    && [
                        "Claudex Status.app/Contents/Info.plist",
                        "Claudex Status.app/Contents/MacOS/ClaudexStatus",
                        "Claudex Status.app/Contents/_CodeSignature/CodeResources"
                    ]
                    .contains(&rel),
                "Failed status build contains unverified files and was preserved."
            );
        }
        Ok(())
    }
    check(stage, "")?;
    fs::remove_dir_all(stage)?;
    Ok(())
}
pub async fn status(root: &Path, home: &Path, run: &dyn Runner) -> Result<Value> {
    ensure!(
        cfg!(target_os = "macos"),
        "The status application requires macOS."
    );
    let root = canonical_root(root, false)?;
    let p = Paths::new(&root, home)?;
    if !exists(&p.directory)? {
        return Ok(json!({"installed":false,"root":root}));
    }
    platform::directory(&p.directory, true, false)?;
    platform::directory(&p.artifacts, true, false)?;
    let Some(value) = state(&p.journal)? else {
        return Ok(json!({"installed":false,"root":root}));
    };
    let j: Journal = serde_json::from_value(value)?;
    validate(&p, &j)?;
    if j.pending.is_some() {
        return Ok(json!({"installed":false,"root":root,"recoveryRequired":true}));
    }
    verify_bundle(
        &p.app,
        &artifact(
            &p,
            j.current
                .as_deref()
                .context("Status application artifact is absent.")?,
        )?,
        run,
    )
    .await?;
    let job = loaded_job(&p.definition(), run).await?;
    Ok(
        json!({"installed":true,"root":root,"app":p.app,"label":p.label,"launchAgent":p.launch_agent,"loginStart":owned_text(&p.launch_agent)?.as_deref()==Some(&p.definition().plist),"loaded":job.loaded,"running":job.running,"synchronizationRestarted":false}),
    )
}
pub struct InstallOptions<'a> {
    pub root: &'a Path,
    pub home: &'a Path,
    pub source: &'a Path,
    pub identity: Option<&'a str>,
    pub start: bool,
}
pub async fn install(o: &InstallOptions<'_>, run: &dyn Runner) -> Result<Value> {
    ensure!(
        cfg!(target_os = "macos"),
        "The status application requires macOS."
    );
    let root = canonical_root(o.root, true)?;
    let _login = FileLock::acquire(root.join("app-login.lock"), true)?;
    if let Some(unified) = state(&root.join("app-login.json"))? {
        ensure!(
            !(unified["version"] == 1
                && unified["root"] == root.display().to_string()
                && unified["loginStart"] == true),
            "The unified Claudex app already provides status and login startup. Open Claudex to manage it."
        );
    }
    let p = Paths::new(&root, o.home)?;
    create(&p.directory)?;
    create(&p.artifacts)?;
    let d = p.definition();
    let id;
    {
        let _lock = FileLock::acquire(&p.lock, true)?;
        let mut j = if let Some(value) = state(&p.journal)? {
            let j: Journal = serde_json::from_value(value)?;
            validate(&p, &j)?;
            recover(&p, j, run).await?
        } else {
            ensure!(
                !exists(&p.app)? && !exists(&p.previous)?,
                "An unowned status application occupies the installation path."
            );
            Journal {
                version: 1,
                root: root.clone(),
                app: p.app.clone(),
                label: p.label.clone(),
                launch_agent: p.launch_agent.clone(),
                current: None,
                previous: None,
                pending: None,
            }
        };
        ensure!(
            owned_text(&d.path)?.is_none_or(|v| v == d.plist),
            "Existing status LaunchAgent differs; it was not overwritten."
        );
        // A foreign loaded job must be refused before compiling or publishing.
        loaded_job(&d, run).await?;
        let input = sources(o.source)?;
        let current = j.current.as_deref().map(|v| artifact(&p, v)).transpose()?;
        if let Some(c) = &current {
            verify_bundle(&p.app, c, run).await?;
        }
        if current.as_ref().is_none_or(|c| {
            c.sources.as_ref() != Some(&input)
                || o.identity
                    .is_some_and(|id| c.identity.as_deref() != Some(id))
        }) {
            assert_exited(&p, run).await?;
            ensure!(!fs::read_dir(&p.directory)?.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().starts_with("stage-"))), "An interrupted status application build remains; inspect the preserved staging directory before another build.");
            let stage_id = uuid::Uuid::new_v4().to_string();
            let stage = p.directory.join(format!("stage-{stage_id}"));
            create(&stage)?;
            let built = match build(
                &root,
                &stage.join("Claudex Status.app"),
                o.source,
                o.identity,
                run,
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    discard_failed(&stage)?;
                    return Err(e);
                }
            };
            let mut bytes = serde_json::to_vec_pretty(&built)?;
            bytes.push(b'\n');
            let artifact_id = hash_bytes(&bytes);
            let path = p.artifacts.join(format!("{artifact_id}.json"));
            if exists(&path)? {
                ensure!(
                    owned(&path, MANIFEST_LIMIT, Some(0o600))? == bytes,
                    "Existing status artifact manifest changed."
                );
            } else {
                platform::publish(&path, &bytes, 0o600)?;
            }
            j.pending = Some(Pending {
                stage: stage_id,
                artifact: artifact_id,
            });
            platform::write_json(&p.journal, &serde_json::to_value(&j)?)?;
            j = recover(&p, j, run).await?;
        }
        let parent = d.path.parent().unwrap();
        if !exists(parent)? {
            fs::create_dir_all(parent)?;
        }
        platform::directory(parent, false, false)?;
        if owned_text(&d.path)?.is_none() {
            platform::publish(&d.path, d.plist.as_bytes(), 0o600)?;
        }
        ensure!(
            owned_text(&d.path)?.as_deref() == Some(&d.plist),
            "Status LaunchAgent changed during installation."
        );
        checked(
            run,
            CommandSpec::new("/usr/bin/plutil", ["-lint", &d.path.to_string_lossy()]),
        )
        .await?;
        id = j.current;
    }
    if o.start {
        let job = loaded_job(&d, run).await?;
        if !job.loaded {
            checked(
                run,
                CommandSpec::new(
                    "/bin/launchctl",
                    [
                        "bootstrap",
                        &format!("gui/{}", platform::uid()),
                        &d.path.to_string_lossy(),
                    ],
                ),
            )
            .await?;
        } else if !job.running {
            checked(
                run,
                CommandSpec::new(
                    "/bin/launchctl",
                    ["kickstart", &format!("gui/{}/{}", platform::uid(), d.label)],
                ),
            )
            .await?;
        }
    }
    let job = loaded_job(&d, run).await?;
    Ok(
        json!({"installed":true,"root":root,"app":p.app,"label":p.label,"launchAgent":p.launch_agent,"artifact":id,"loaded":job.loaded,"running":job.running,"synchronizationRestarted":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::CommandOutput;
    use async_trait::async_trait;
    use std::{
        os::unix::fs::{DirBuilderExt, symlink},
        sync::Mutex,
    };
    const ID: &str = "1111111111111111111111111111111111111111";
    #[derive(Default)]
    struct Native {
        loaded: bool,
        running: bool,
        open: bool,
        foreign: bool,
        builds: u32,
        fail_publish: bool,
        refuse_quit: bool,
        calls: Vec<CommandSpec>,
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
        source: PathBuf,
        state: Mutex<Native>,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let temp = tempfile::tempdir()?;
            let base = fs::canonicalize(temp.path())?;
            let root = base.join("root");
            let home = base.join("home");
            let source = base.join("sources");
            for p in [&root, &home, &source] {
                fs::DirBuilder::new().mode(0o700).create(p)?;
            }
            for n in SOURCE_NAMES {
                platform::publish(&source.join(n), format!("// {n}\n").as_bytes(), 0o600)?;
            }
            Ok(Self {
                _temp: temp,
                root,
                home,
                source,
                state: Mutex::new(Native::default()),
            })
        }
        fn options(&self) -> InstallOptions<'_> {
            InstallOptions {
                root: &self.root,
                home: &self.home,
                source: &self.source,
                identity: Some(ID),
                start: true,
            }
        }
    }
    #[async_trait]
    impl Runner for Fixture {
        async fn run(&self, spec: CommandSpec) -> Result<CommandOutput> {
            let mut s = self.state.lock().unwrap();
            s.calls.push(spec.clone());
            let p = Paths::new(&self.root, &self.home)?;
            let mut out = CommandOutput::default();
            match spec.program.to_str().unwrap() {
                "/usr/bin/security" => {
                    out.stdout = format!("  1) {ID} \"Apple Development: Fixture (TESTUSER00)\"\n")
                }
                "/usr/bin/xcrun" => {
                    s.builds += 1;
                    fs::write(
                        spec.args.last().unwrap(),
                        format!("synthetic executable {}", s.builds),
                    )?;
                }
                "/usr/bin/codesign" => {
                    let app = PathBuf::from(spec.args.last().unwrap());
                    if spec.args[0] == "--force" {
                        let d = app.join("Contents/_CodeSignature");
                        fs::create_dir(&d)?;
                        fs::write(d.join("CodeResources"), "synthetic signature")?;
                    }
                    if spec.args[0] == "-d" {
                        let id = if app.file_name().unwrap() == "Claudex.app" {
                            crate::login::IDENTIFIER
                        } else {
                            &p.label
                        };
                        out.stderr = format!(
                            "Identifier={id}\nAuthority=Apple Development: Fixture\nTeamIdentifier=TESTTEAM00\n"
                        );
                    }
                    if spec.args[0] == "--verify"
                        && app == p.app
                        && s.fail_publish
                        && fs::read_to_string(&p.executable)?.ends_with('2')
                    {
                        s.fail_publish = false;
                        bail!("Simulated publication interruption.");
                    }
                }
                "/bin/launchctl" => {
                    if spec.args[0] == "print" {
                        if !s.loaded || !spec.args[1].ends_with(&p.label) {
                            out.code = 113;
                            out.stderr = "Could not find service".into();
                        } else {
                            out.stdout = format!(
                                "path = {}\nprogram = {}\narguments = {{\n{}\n--root\n{}\n}}\nstate = {}",
                                p.launch_agent.display(),
                                if s.foreign {
                                    "/foreign/app".into()
                                } else {
                                    p.executable.display().to_string()
                                },
                                p.executable.display(),
                                self.root.display(),
                                if s.running { "running" } else { "not running" }
                            );
                        }
                    } else if spec.args[0] == "bootout" {
                        ensure!(!s.running, "Display must exit before unload.");
                        s.loaded = false;
                    } else {
                        ensure!(
                            !exists(&p.lock)?,
                            "Install lock must be released before launch."
                        );
                        ensure!(
                            ["bootstrap", "kickstart"].contains(&spec.args[0].as_str()),
                            "Unexpected service command."
                        );
                        s.loaded = true;
                        s.running = true;
                    }
                }
                "/usr/sbin/lsof" => {
                    if s.open {
                        out.stdout = "12345\n".into();
                    } else {
                        out.code = 1;
                    }
                }
                "/usr/bin/osascript" => {
                    ensure!(!s.refuse_quit, "Legacy display is still running.");
                    ensure!(
                        spec.args.last().unwrap().contains("Number(apps.count)"),
                        "JXA count conversion is required."
                    );
                    s.running = false;
                }
                "/usr/bin/plutil" => {}
                other => bail!("Unexpected synthetic command: {other}"),
            }
            Ok(out)
        }
    }
    #[tokio::test]
    async fn signed_install_is_idempotent_and_recovers_published_upgrade() -> Result<()> {
        let f = Fixture::new()?;
        let first = install(&f.options(), &f).await?;
        assert_eq!(first["running"], true);
        assert_eq!(status(&f.root, &f.home, &f).await?["loginStart"], true);
        assert_eq!(
            install(&f.options(), &f).await?["artifact"],
            first["artifact"]
        );
        assert_eq!(f.state.lock().unwrap().builds, 1);
        fs::write(f.source.join("main.swift"), "// updated\n")?;
        assert!(install(&f.options(), &f).await.is_err());
        {
            let mut s = f.state.lock().unwrap();
            s.running = false;
            s.fail_publish = true;
        }
        assert!(
            install(&f.options(), &f)
                .await
                .unwrap_err()
                .to_string()
                .contains("publication")
        );
        assert_eq!(
            status(&f.root, &f.home, &f).await?["recoveryRequired"],
            true
        );
        let next = install(&f.options(), &f).await?;
        assert_ne!(next["artifact"], first["artifact"]);
        assert_eq!(f.state.lock().unwrap().builds, 2);
        let p = Paths::new(&f.root, &f.home)?;
        assert_eq!(
            fs::read_to_string(p.previous.join("Contents/MacOS/ClaudexStatus"))?,
            "synthetic executable 1"
        );
        Ok(())
    }
    #[tokio::test]
    async fn foreign_job_and_hardlink_bundle_are_preserved() -> Result<()> {
        let f = Fixture::new()?;
        {
            let mut s = f.state.lock().unwrap();
            s.loaded = true;
            s.foreign = true;
        }
        assert!(
            install(&f.options(), &f)
                .await
                .unwrap_err()
                .to_string()
                .contains("ownership differs")
        );
        assert_eq!(f.state.lock().unwrap().builds, 0);
        {
            let mut s = f.state.lock().unwrap();
            s.loaded = false;
            s.foreign = false;
        }
        install(&f.options(), &f).await?;
        let p = Paths::new(&f.root, &f.home)?;
        fs::hard_link(&p.executable, f.root.join("preserved"))?;
        assert!(status(&f.root, &f.home, &f).await.is_err());
        assert_eq!(f.state.lock().unwrap().builds, 1);
        Ok(())
    }
    #[tokio::test]
    async fn initial_prepared_install_recovers_without_compiling_again() -> Result<()> {
        let f = Fixture::new()?;
        install(&f.options(), &f).await?;
        f.state.lock().unwrap().running = false;
        let p = Paths::new(&f.root, &f.home)?;
        let mut j: Journal = serde_json::from_value(state(&p.journal)?.unwrap())?;
        let stage_id = uuid::Uuid::new_v4().to_string();
        let stage = p.directory.join(format!("stage-{stage_id}"));
        create(&stage)?;
        fs::rename(&p.app, stage.join("Claudex Status.app"))?;
        j.pending = Some(Pending {
            stage: stage_id,
            artifact: j.current.take().unwrap(),
        });
        platform::write_json(&p.journal, &serde_json::to_value(j)?)?;
        assert_eq!(
            status(&f.root, &f.home, &f).await?["recoveryRequired"],
            true
        );
        assert_eq!(install(&f.options(), &f).await?["installed"], true);
        assert_eq!(f.state.lock().unwrap().builds, 1);
        Ok(())
    }
    #[tokio::test]
    async fn unified_login_migrates_only_the_verified_legacy_display() -> Result<()> {
        let f = Fixture::new()?;
        install(&f.options(), &f).await?;
        let p = Paths::new(&f.root, &f.home)?;
        let before = fs::read(&p.executable)?;
        let app = f.root.parent().unwrap().join("Claudex.app");
        fs::create_dir_all(app.join("Contents/MacOS"))?;
        fs::write(
            app.join("Contents/MacOS/ClaudexApp"),
            "synthetic unified app",
        )?;
        let result = crate::login::install(&f.root, &f.home, &app, &f).await?;
        assert_eq!(result["legacyDisplayDisabled"], true);
        assert_eq!(result["synchronizationRestarted"], false);
        assert_eq!(fs::read(&p.executable)?, before);
        assert!(!exists(&p.launch_agent)?);
        assert_eq!(
            owned_text(&p.directory.join("login-disabled.plist"))?.unwrap(),
            p.definition().plist
        );
        crate::login::install(&f.root, &f.home, &app, &f).await?;
        assert!(
            install(&f.options(), &f)
                .await
                .unwrap_err()
                .to_string()
                .contains("unified")
        );
        let s = f.state.lock().unwrap();
        assert!(!s.running && !s.loaded);
        assert!(!s.calls.iter().any(|c| c.args.iter().any(|v| v == "kill")));
        Ok(())
    }
    #[tokio::test]
    async fn unsafe_bundle_and_refused_display_quit_leave_recoverable_state() -> Result<()> {
        let f = Fixture::new()?;
        let app = f.root.parent().unwrap().join("Claudex.app");
        fs::create_dir_all(app.join("Contents/MacOS"))?;
        fs::write(app.join("Contents/MacOS/ClaudexApp"), "synthetic")?;
        let target = app.join("Contents/MacOS/original");
        fs::rename(app.join("Contents/MacOS/ClaudexApp"), &target)?;
        symlink(&target, app.join("Contents/MacOS/ClaudexApp"))?;
        assert!(
            crate::login::install(&f.root, &f.home, &app, &f)
                .await
                .is_err()
        );
        assert!(f.state.lock().unwrap().calls.is_empty());
        fs::remove_file(app.join("Contents/MacOS/ClaudexApp"))?;
        fs::rename(target, app.join("Contents/MacOS/ClaudexApp"))?;
        install(&f.options(), &f).await?;
        f.state.lock().unwrap().refuse_quit = true;
        assert!(
            crate::login::install(&f.root, &f.home, &app, &f)
                .await
                .is_err()
        );
        let p = Paths::new(&f.root, &f.home)?;
        assert!(exists(&p.launch_agent)?);
        let s = f.state.lock().unwrap();
        assert!(s.loaded && s.running);
        assert!(
            !s.calls
                .iter()
                .any(|c| c.args.first().is_some_and(|v| v == "bootout"))
        );
        Ok(())
    }
}
