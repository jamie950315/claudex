use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
}
impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => bail!("Provider must be codex or claude."),
        }
    }
    pub fn efforts(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &[
                "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
            ],
            Self::Claude => &["low", "medium", "high", "xhigh", "max"],
        }
    }
    pub fn validate_effort(self, v: &Value) -> Result<()> {
        if !v.is_null() && !v.as_str().is_some_and(|s| self.efforts().contains(&s)) {
            bail!("Unsupported reasoning effort for {}.", self.as_str());
        }
        Ok(())
    }
}
impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}
impl Permission {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            "full-access" => Ok(Self::FullAccess),
            _ => bail!("Unsupported permission."),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::FullAccess => "full-access",
        }
    }
    pub fn capabilities(self, p: Option<Provider>) -> Value {
        json!({"network":self == Self::FullAccess,"userConfig":self == Self::FullAccess,"shell":match p { Some(p)=>json!(p==Provider::Codex||self==Self::FullAccess),None=>json!({"codex":true,"claude":self==Self::FullAccess}) }})
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Ready,
    Running,
    Waiting,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Uncertain,
}
impl TaskStatus {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Uncertain
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub peer: Provider,
    pub token: String,
    pub method: String,
    #[serde(default = "empty_object")]
    pub params: Value,
}
fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Clone)]
pub struct Config {
    pub allow_write: bool,
    pub allow_full_access: bool,
    pub default_permission: Permission,
    pub max_workers: usize,
    pub max_depth: u64,
    pub max_steps: u64,
    pub max_tasks: usize,
    pub max_requests: usize,
    pub max_state_bytes: usize,
    pub executable: PathBuf,
    pub codex_binary: PathBuf,
    pub claude_binary: PathBuf,
    pub environment_path: Option<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            allow_write: false,
            allow_full_access: false,
            default_permission: Permission::ReadOnly,
            max_workers: 64,
            max_depth: 3,
            max_steps: 12,
            max_tasks: 1000,
            max_requests: 10000,
            max_state_bytes: 32 * 1024 * 1024,
            executable: std::env::current_exe().unwrap_or_else(|_| "claudex".into()),
            codex_binary: "codex".into(),
            claude_binary: "claude".into(),
            environment_path: None,
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.max_workers == 0
            || self.max_workers > 64
            || self.max_depth == 0
            || self.max_depth > 8
            || self.max_steps == 0
            || self.max_steps > 100
            || self.max_tasks == 0
            || self.max_tasks > 10000
            || self.max_requests == 0
            || self.max_requests > 100000
            || self.max_state_bytes == 0
            || self.max_state_bytes > 128 * 1024 * 1024
        {
            bail!("Invalid collaboration limits.");
        }
        let ceiling = if self.allow_full_access {
            Permission::FullAccess
        } else if self.allow_write {
            Permission::WorkspaceWrite
        } else {
            Permission::ReadOnly
        };
        if self.default_permission > ceiling {
            bail!("Default permission exceeds broker authorization.");
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub capacity: Option<(&'static str, usize, usize)>,
}
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ProtocolError {}
pub fn error(code: impl Into<String>, message: impl Into<String>) -> anyhow::Error {
    ProtocolError {
        code: code.into(),
        message: message.into(),
        capacity: None,
    }
    .into()
}
pub fn wire_error(e: &anyhow::Error) -> Value {
    if let Some(e) = e.downcast_ref::<ProtocolError>() {
        let mut v = json!({"code":e.code,"message":e.message});
        if let Some((r, u, l)) = e.capacity {
            v["resource"] = json!(r);
            v["used"] = json!(u);
            v["limit"] = json!(l);
        }
        v
    } else {
        json!({"code":null,"message":e.to_string()})
    }
}
pub const SANDBOX_DESCRIPTION: &str = "read-only and workspace-write run in an isolated sandbox with NO network access and do not load the user's Codex/Claude config, plugins, MCP servers or hooks (Claude: no Bash or web tools).";
pub const DEFAULT_WAIT_MS: u64 = 300_000;
pub const MAX_WAIT_MS: u64 = 1_800_000;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn text<'a>(v: &'a Value, label: &str, max: usize) -> Result<&'a str> {
    let s = v.as_str().ok_or_else(|| {
        error(
            "CLAUDEX_INVALID_ARGUMENTS",
            format!("{label} must be text."),
        )
    })?;
    if s.trim().is_empty() || s.contains('\0') || s.len() > max {
        bail!("{label} must be nonempty text of at most {max} bytes.");
    }
    Ok(s)
}
pub fn id(v: &Value) -> Result<&str> {
    let s = text(v, "requestId", 128)?;
    if !s
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
    {
        bail!("A stable requestId is required.");
    }
    Ok(s)
}
pub fn terminal(v: &Value) -> bool {
    matches!(
        v.as_str(),
        Some("completed" | "failed" | "cancelled" | "uncertain")
    )
}
pub fn settled(v: &Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("completed" | "failed" | "cancelled")
    ) && v["active"].is_null()
        && v["pendingHandoff"].is_null()
        && !matches!(
            v["pause"]["state"].as_str(),
            Some("requested" | "checkpoint")
        )
}
pub fn hash(s: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s.as_ref()))
}
pub fn hash_value(v: &Value) -> String {
    claudex_core::storage::hash_json(v).expect("JSON serializable")
}
pub fn bytes(v: &Value) -> usize {
    serde_json::to_vec(v).expect("JSON serializable").len()
}
pub fn bump(t: &mut Value) {
    t["revision"] = json!(t["revision"].as_u64().unwrap_or(0) + 1);
    t["updatedAt"] = json!(now());
}
pub fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
pub fn push(v: &mut Value, item: Value) {
    if !v.is_array() {
        *v = json!([]);
    }
    v.as_array_mut().expect("array").push(item);
}
pub fn model(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let s = text(v, "model", 200)?;
    if s.trim() != s || s.chars().any(char::is_control) {
        bail!("model must not contain control characters or surrounding whitespace.");
    }
    Ok(v.clone())
}
