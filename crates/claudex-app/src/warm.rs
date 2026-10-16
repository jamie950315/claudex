//! Durable cache-retention authorization. Observations never survive as dispatch leases.
use crate::platform;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
};
pub const PROMPT: &str = "Cache-retention maintenance only. Reply with exactly OK. Do not call tools, continue previous work, or make any changes.";
const MAX_POLICIES: usize = 64;
const MAX_ATTEMPTS: usize = 2048;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const OUTPUT_RESERVATION: u64 = 128;
const READ_OVERHEAD: u64 = 256;
const PRIME_DISPATCH_MS: u64 = 120000;
const SAFE_INTEGER: u64 = 9007199254740991;
fn word(s: &str) -> bool {
    !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control)
}
fn identity(session: &str, cwd: &str) -> Result<()> {
    ensure!(
        !session.is_empty()
            && session.len() <= 128
            && session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && cwd.len() <= 4096,
        "CACHE_WARM_INVALID: invalid native identity."
    );
    platform::absolute(std::path::Path::new(cwd))
}
fn binding_time(id: &str) -> Option<u64> {
    let rest = id.strip_prefix("warm-")?;
    let (time, nonce) = rest.split_once('-')?;
    if nonce.is_empty()
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    time.parse().ok().filter(|v| *v <= SAFE_INTEGER)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AttemptState {
    Reserved,
    Dispatching,
    Submitted,
    Rejected,
    Uncertain,
    Revoked,
    Verified,
    Failed,
}
impl AttemptState {
    fn live(self) -> bool {
        matches!(self, Self::Reserved | Self::Dispatching | Self::Submitted)
    }
    fn settled(self) -> bool {
        matches!(
            self,
            Self::Rejected | Self::Revoked | Self::Verified | Self::Failed
        )
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AttemptKind {
    Prime,
    Compact,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NativePhase {
    Idle,
    Busy,
    Ended,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub started_at: u64,
    pub completed_at: u64,
    pub model: String,
    pub effort: String,
    pub ttl_ms: u64,
    pub ttl_source: String,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}
impl Sample {
    fn validate(&self, now: u64, provider: &str) -> Result<()> {
        ensure!(
            word(&self.id)
                && word(&self.model)
                && word(&self.effort)
                && word(&self.stop_reason)
                && self.completed_at >= self.started_at
                && self.completed_at <= now
                && self.completed_at - self.started_at < self.ttl_ms
                && if provider == "codex" {
                    self.ttl_ms == 1800000 && self.ttl_source == "configured-window"
                } else {
                    [300000, 3600000].contains(&self.ttl_ms)
                }
                && [
                    "native-setting",
                    "conservative-minimum",
                    "configured-window"
                ]
                .contains(&self.ttl_source.as_str())
                && (self.ttl_source != "conservative-minimum" || self.ttl_ms == 300000)
                && [
                    self.started_at,
                    self.completed_at,
                    self.input_tokens,
                    self.cache_read_tokens,
                    self.cache_write_tokens,
                    self.output_tokens
                ]
                .iter()
                .all(|v| *v <= SAFE_INTEGER)
                && self
                    .cache_read_tokens
                    .saturating_add(self.cache_write_tokens)
                    .saturating_add(READ_OVERHEAD)
                    <= SAFE_INTEGER
                && self.attempt_id.as_deref().is_none_or(word),
            "CACHE_WARM_INVALID: invalid native sample."
        );
        Ok(())
    }
    fn success(&self) -> bool {
        ["end_turn", "stop_sequence"].contains(&self.stop_reason.as_str())
    }
    fn prefix(&self, provider: &str) -> u64 {
        if provider == "codex" {
            self.input_tokens
        } else {
            let cached = self.cache_read_tokens + self.cache_write_tokens;
            if cached > 0 {
                cached
            } else {
                self.input_tokens
            }
        }
    }
    fn expiry(&self, p: &Policy) -> u64 {
        self.started_at
            + if p.ttl_preference.as_deref() == Some("5m") {
                self.ttl_ms.min(300000)
            } else {
                self.ttl_ms
            }
    }
    fn next(&self, p: &Policy) -> u64 {
        if p.provider == "codex" {
            self.started_at + p.refresh_minutes.unwrap_or(25) * 60000
        } else {
            let window = self.expiry(p) - self.started_at;
            self.expiry(p) - if window == 300000 { 60000 } else { 300000 }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub provider: String,
    pub session_id: String,
    pub cwd: String,
    pub enabled: bool,
    pub generation: u64,
    pub max_minutes: u64,
    pub max_refreshes: u64,
    pub max_read_tokens: Option<u64>,
    pub max_output_tokens: u64,
    pub until: u64,
    pub updated_at: u64,
    pub reason: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub ttl_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_preference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_effort: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prime_at: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub instance_id: String,
    pub epoch: u64,
    pub generation: u64,
    pub created_at: u64,
    pub next_at: u64,
    pub expires_at: u64,
    pub sample_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub state: AttemptState,
    pub required_prefix_tokens: u64,
    pub reserved_read_tokens: u64,
    pub reserved_output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<AttemptKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_at: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestReceipt {
    pub request_id: String,
    pub session_id: String,
    pub generation: u64,
    pub payload: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ledger {
    pub version: u32,
    pub policies: Vec<Policy>,
    pub attempts: Vec<Attempt>,
    pub requests: Vec<RequestReceipt>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            policies: vec![],
            attempts: vec![],
            requests: vec![],
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    session_id: String,
    cwd: String,
    instance_id: String,
    sequence: u64,
    epoch: u64,
    phase: NativePhase,
    sample: Option<Sample>,
    attempt_id: Option<String>,
}
#[derive(Clone, Debug)]
struct Binding {
    session_id: String,
    cwd: String,
    instance_id: String,
    sequence: u64,
    epoch: u64,
    phase: NativePhase,
    sample: Option<Sample>,
    evidence_epoch: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    refreshes: u64,
    read_tokens: u64,
    output_tokens: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WarmSettings {
    pub default_warm_limit: String,
    pub cache_ttl_preference: Option<TtlPreference>,
    pub cache_ttl_last_choice: Option<TtlChoice>,
    pub warm_on_user_message: String,
    pub compact_after_warm: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl Default for WarmSettings {
    fn default() -> Self {
        Self {
            default_warm_limit: "for=4h".into(),
            cache_ttl_preference: None,
            cache_ttl_last_choice: None,
            warm_on_user_message: "continue".into(),
            compact_after_warm: true,
            extra: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtlPreference {
    pub version: u32,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtlChoice {
    pub revision: String,
    pub ttl: String,
}
impl TtlPreference {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && ["session", "remember", "default"].contains(&self.mode.as_str())
                && if self.mode == "session" {
                    self.ttl.is_none()
                } else {
                    self.ttl
                        .as_deref()
                        .is_some_and(|v| ["1h", "5m"].contains(&v))
                }
                && if self.mode == "remember" {
                    self.revision.as_deref().is_some_and(|s| {
                        regex::Regex::new(r"^warm-[a-zA-Z0-9-]{1,80}$")
                            .unwrap()
                            .is_match(s)
                    })
                } else {
                    self.revision.is_none()
                },
            "Saved cache TTL preference is invalid; no native setting was changed."
        );
        Ok(())
    }
}
impl WarmSettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["continue", "stop"].contains(&self.warm_on_user_message.as_str()),
            "Invalid cache-warming user-message preference."
        );
        if let Some(p) = &self.cache_ttl_preference {
            p.validate()?;
        }
        if let Some(last) = &self.cache_ttl_last_choice {
            ensure!(
                ["1h", "5m"].contains(&last.ttl.as_str())
                    && self
                        .cache_ttl_preference
                        .as_ref()
                        .is_some_and(|p| p.mode == "remember"
                            && p.revision.as_deref() == Some(&last.revision)),
                "Last TTL choice does not belong to saved preference."
            );
        }
        ensure!(
            self.default_warm_limit.len() <= 32
                && self
                    .default_warm_limit
                    .strip_prefix("until=")
                    .is_none_or(|s| s.matches(':').count() == 1)
                && (parse_limit(&self.default_warm_limit, 55, chrono::Local::now()).is_ok()
                    || parse_limit(&self.default_warm_limit, 4, chrono::Local::now()).is_ok()),
            "Invalid shared cache-warming limit."
        );
        Ok(())
    }
}

pub struct CacheWarmManager {
    root: PathBuf,
    pub provider: String,
    pub state: Ledger,
    bindings: BTreeMap<String, Binding>,
    retired: VecDeque<(String, String, Option<u64>)>,
    retired_before: Option<u64>,
    legacy_retired: bool,
    pub closed: bool,
    failure: Option<(String, String)>,
}
impl CacheWarmManager {
    pub fn open(root: PathBuf, provider: &str) -> Result<Self> {
        platform::absolute(&root)?;
        ensure!(
            ["claude", "codex"].contains(&provider),
            "CACHE_WARM_UNSUPPORTED: unsupported provider."
        );
        let path = root.join(if provider == "codex" {
            "codex-cache-warm.json"
        } else {
            "cache-warm.json"
        });
        let state = if root.exists() {
            platform::directory(&root, true, false)?;
            platform::optional_json(&path, MAX_BYTES, true)?
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default()
        } else {
            Ledger::default()
        };
        let mut this = Self {
            root,
            provider: provider.into(),
            state,
            bindings: BTreeMap::new(),
            retired: VecDeque::new(),
            retired_before: None,
            legacy_retired: false,
            closed: false,
            failure: None,
        };
        this.validate()?;
        let mut changed = false;
        let mut stopped = BTreeSet::new();
        for a in &mut this.state.attempts {
            if a.state.live() {
                a.state = if a.state == AttemptState::Reserved {
                    AttemptState::Revoked
                } else {
                    AttemptState::Uncertain
                };
                a.reason = Some("broker-restarted".into());
                stopped.insert(a.session_id.clone());
                changed = true;
            }
        }
        for p in &mut this.state.policies {
            if stopped.contains(&p.session_id) {
                p.enabled = false;
                p.reason = Some("broker-restarted".into());
            }
        }
        if changed {
            this.save()?;
        }
        Ok(this)
    }
    fn path(&self) -> PathBuf {
        self.root.join(if self.provider == "codex" {
            "codex-cache-warm.json"
        } else {
            "cache-warm.json"
        })
    }
    fn validate(&self) -> Result<()> {
        let s = &self.state;
        ensure!(
            s.version == 1
                && s.policies.len() <= MAX_POLICIES
                && s.attempts.len() <= MAX_ATTEMPTS
                && s.requests.len() <= MAX_ATTEMPTS,
            "CACHE_WARM_INVALID: invalid journal bounds."
        );
        let mut policies = BTreeSet::new();
        let mut attempts = BTreeSet::new();
        let mut requests = BTreeSet::new();
        for p in &s.policies {
            identity(&p.session_id, &p.cwd)?;
            ensure!(
                p.provider == self.provider
                    && policies.insert(&p.session_id)
                    && p.generation >= 1
                    && p.until <= SAFE_INTEGER
                    && p.updated_at <= SAFE_INTEGER
                    && (1..=500).contains(&p.max_refreshes)
                    && p.max_read_tokens
                        .is_none_or(|v| (1..=100000000).contains(&v))
                    && (1..=1000000).contains(&p.max_output_tokens)
                    && (1..=10080).contains(&p.max_minutes)
                    && p.fixed_end.is_none_or(|v| v)
                    && p.model.as_deref().is_none_or(word)
                    && p.effort.as_deref().is_none_or(word)
                    && p.ttl_ms.is_none_or(|v| if self.provider == "codex" {
                        v == 1800000
                    } else {
                        [300000, 3600000].contains(&v)
                    })
                    && if self.provider == "codex" {
                        p.ttl_preference.is_none()
                            && p.refresh_minutes.is_some_and(|v| (1..=25).contains(&v))
                            && p.best_effort.is_some()
                            && (!p.enabled || p.best_effort == Some(true))
                    } else {
                        p.ttl_preference
                            .as_deref()
                            .is_none_or(|v| ["1h", "5m"].contains(&v))
                    },
                "CACHE_WARM_INVALID: invalid policy."
            );
        }
        for a in &s.attempts {
            identity(&a.session_id, &a.cwd)?;
            ensure!(
                word(&a.instance_id)
                    && policies.contains(&a.session_id)
                    && word(&a.id)
                    && attempts.insert(&a.id)
                    && a.generation >= 1
                    && a.expires_at > a.created_at
                    && a.expires_at <= SAFE_INTEGER
                    && a.epoch <= SAFE_INTEGER
                    && a.reserved_read_tokens >= 1
                    && a.reserved_output_tokens >= 1
                    && a.required_prefix_tokens
                        >= if a.kind == Some(AttemptKind::Prime) {
                            0
                        } else {
                            1
                        }
                    && a.reserved_read_tokens >= a.required_prefix_tokens
                    && if a.kind == Some(AttemptKind::Prime) {
                        a.model.is_none() && a.effort.is_none() && a.required_prefix_tokens == 0
                    } else {
                        a.model.as_deref().is_some_and(word)
                            && a.effort.as_deref().is_some_and(word)
                            && a.sample_id.as_deref().is_some_and(word)
                    },
                "CACHE_WARM_INVALID: invalid attempt."
            );
            if let Some(ids) = &a.response_ids {
                ensure!(
                    ids.len() <= 64
                        && ids.iter().all(|id| word(id))
                        && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
                    "CACHE_WARM_INVALID: invalid response identities."
                );
            }
            for verified in [a.cache_verified, a.response_verified] {
                ensure!(
                    verified.is_none()
                        || self.provider == "codex"
                            && (!verified.unwrap()
                                || a.authorized_at.is_some()
                                    && a.actual.is_some()
                                    && a.response_ids.as_ref().is_some_and(|v| !v.is_empty())),
                    "CACHE_WARM_INVALID: invalid response proof."
                );
            }
        }
        for r in &s.requests {
            ensure!(
                word(&r.request_id)
                    && requests.insert(&r.request_id)
                    && policies.contains(&r.session_id)
                    && r.payload.len() <= 8192
                    && r.generation >= 1,
                "CACHE_WARM_INVALID: invalid request receipt."
            );
        }
        Ok(())
    }
    fn save(&mut self) -> Result<()> {
        let result = (|| {
            self.validate()?;
            let value = serde_json::to_value(&self.state)?;
            ensure!(
                serde_json::to_vec(&value)?.len() <= MAX_BYTES,
                "CACHE_WARM_CAPACITY: ledger byte capacity exhausted."
            );
            platform::create_private(&self.root)?;
            platform::write_json(&self.path(), &value)
        })();
        if result.is_err() {
            self.closed = true;
            self.failure = Some(("CACHE_WARM_STORAGE_FAILED".into(), "storage-failed".into()));
            self.stop_policies("storage-failed", 0);
        }
        result
    }
    fn policy_index(&self, id: &str) -> Option<usize> {
        self.state.policies.iter().position(|p| p.session_id == id)
    }
    fn policy(&self, id: &str) -> Option<&Policy> {
        self.state.policies.iter().find(|p| p.session_id == id)
    }
    pub(crate) fn pending(&self, id: &str) -> bool {
        self.state
            .attempts
            .iter()
            .any(|a| a.session_id == id && a.state.live())
    }
    fn totals(&self, p: &Policy) -> Totals {
        let mut totals = Totals::default();
        for a in self.state.attempts.iter().filter(|a| {
            a.session_id == p.session_id
                && a.generation == p.generation
                && a.created_at >= p.restarted_at.unwrap_or(0)
                && a.kind != Some(AttemptKind::Compact)
        }) {
            totals.refreshes += 1;
            let refused = matches!(a.state, AttemptState::Rejected | AttemptState::Revoked);
            totals.read_tokens += a
                .actual
                .as_ref()
                .map(|v| v.cache_read_tokens)
                .unwrap_or(if refused { 0 } else { a.reserved_read_tokens });
            totals.output_tokens += a
                .actual
                .as_ref()
                .map(|v| v.output_tokens)
                .unwrap_or(if refused { 0 } else { a.reserved_output_tokens });
        }
        totals
    }
    fn usable(&self, p: &Policy, b: Option<&Binding>, now: u64) -> bool {
        b.and_then(|b| b.sample.as_ref())
            .is_some_and(|s| s.success() && s.prefix(&self.provider) > 0 && now < s.expiry(p))
    }
    fn needs_prime(&self, p: &Policy, b: Option<&Binding>, now: u64) -> bool {
        p.prime_at.is_some()
            && !self.usable(p, b, now)
            && !self
                .state
                .attempts
                .iter()
                .any(|a| a.session_id == p.session_id && a.generation == p.generation)
    }
    fn reason(&self, p: Option<&Policy>, b: Option<&Binding>, now: u64, due: bool) -> Option<&str> {
        if self.closed {
            return Some("broker-stopping");
        }
        let Some(p) = p else { return Some("disabled") };
        if !p.enabled {
            return Some("disabled");
        }
        if now >= p.until {
            return Some("duration-limit");
        }
        let Some(b) = b.filter(|b| b.cwd == p.cwd) else {
            return Some("awaiting-native-binding");
        };
        if b.phase != NativePhase::Idle {
            return Some(if b.phase == NativePhase::Ended {
                "native-ended"
            } else {
                "busy"
            });
        }
        if self.pending(&p.session_id) {
            return Some("attempt-pending");
        }
        let totals = self.totals(p);
        if totals.refreshes >= p.max_refreshes {
            return Some("refresh-limit");
        }
        if totals.output_tokens + OUTPUT_RESERVATION > p.max_output_tokens {
            return Some("output-budget");
        }
        if self.needs_prime(p, Some(b), now) {
            return if now >= p.prime_at.unwrap() + PRIME_DISPATCH_MS {
                Some("attempt-expired")
            } else {
                None
            };
        }
        let Some(s) = &b.sample else {
            return Some("awaiting-evidence");
        };
        if !s.success() {
            return Some("native-output-not-complete");
        }
        if s.prefix(&self.provider) == 0 {
            return Some("no-cache-prefix");
        }
        if now >= s.expiry(p) {
            return Some("cache-expired");
        }
        if due && now < s.next(p) {
            return Some("not-due");
        }
        None
    }
    fn compaction(
        &self,
        p: &Policy,
        b: Option<&Binding>,
        now: u64,
        settings: &WarmSettings,
    ) -> Option<u64> {
        let b = b?;
        let s = b.sample.as_ref()?;
        if self.closed
            || !p.enabled
            || !p.compact.unwrap_or(settings.compact_after_warm)
            || b.cwd != p.cwd
            || b.phase != NativePhase::Idle
            || !s.success()
            || s.prefix(&self.provider) == 0
            || self.pending(&p.session_id)
        {
            return None;
        }
        let at = s.next(p);
        let ended = now >= p.until || self.totals(p).refreshes >= p.max_refreshes || at >= p.until;
        (ended && now < s.expiry(p)).then_some(at)
    }
    fn presentation(&self, p: &Policy, now: u64, settings: &WarmSettings) -> Value {
        let b = self.bindings.get(&p.session_id);
        let reason = self.reason(Some(p), b, now, false);
        let reason = if !p.enabled {
            p.reason.as_deref().or(reason)
        } else {
            reason
        };
        let mut value = serde_json::to_value(p).unwrap();
        let reads: Vec<_> = self
            .state
            .attempts
            .iter()
            .filter(|a| {
                a.session_id == p.session_id
                    && a.generation == p.generation
                    && a.actual.as_ref().is_some_and(|a| a.cache_read_tokens > 0)
            })
            .collect();
        let times: Option<Vec<_>> = reads.iter().map(|a| a.completed_at).collect();
        let sample = b.and_then(|b| b.sample.as_ref());
        let prime = reason.is_none() && self.needs_prime(p, b, now);
        let fields = json!({"maxReadTokens":null,"status":reason.unwrap_or("scheduled"),"reason":reason.unwrap_or("scheduled"),"bound":b.is_some_and(|b|b.cwd==p.cwd),"cacheResults":{"count":reads.len(),"firstAt":times.as_ref().and_then(|v|v.iter().min()),"lastAt":times.as_ref().and_then(|v|v.iter().max())},"phase":b.map(|b|b.phase),"native":{"phase":b.map(|b|serde_json::to_value(b.phase).unwrap()).unwrap_or(json!("unbound"))},"totals":self.totals(p),"sample":sample,"prime":prime,"nextAt":if reason.is_none(){if prime{p.prime_at}else{sample.map(|s|s.next(p))}}else{None},"compactAtEnd":p.compact.unwrap_or(settings.compact_after_warm),"compactAt":self.compaction(p,b,now,settings),"effectiveTtlMs":sample.map(|s|s.expiry(p)-s.started_at),"budgetKind":"admission-reservation-not-a-native-token-cap"});
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        value
    }
    fn result(&self, id: &str, now: u64, settings: &WarmSettings) -> Value {
        let p = self
            .policy(id)
            .map(|p| self.presentation(p, now, settings))
            .unwrap_or(Value::Null);
        json!({"nextAt":p["nextAt"],"prime":p["prime"].as_bool().unwrap_or(false),"compactAt":p["compactAt"],"reason":p["reason"].as_str().unwrap_or("disabled"),"policy":p})
    }
    fn list(&self, now: u64, settings: &WarmSettings) -> Value {
        let mut value = json!({"providers":{"claude":"native-mod-only","codex":if self.provider=="codex"{"experimental-best-effort"}else{"unsupported"}},"providerStatus":{"provider":self.provider,"closed":self.closed,"reason":self.failure.as_ref().map(|v|v.1.clone()).or_else(||self.closed.then(||"broker-stopped".into())),"code":self.failure.as_ref().map(|v|v.0.clone()),"bindings":self.bindings.len(),"retiredBindings":self.retired.len()},"policies":self.state.policies.iter().map(|p|self.presentation(p,now,settings)).collect::<Vec<_>>(),"attempts":[],"attemptCount":self.state.attempts.len(),"attemptsTruncated":false});
        let mut bytes = serde_json::to_vec(&value).unwrap().len();
        let mut rows = vec![];
        for a in self.state.attempts.iter().rev().take(64) {
            let row = serde_json::to_value(a).unwrap();
            let size = serde_json::to_vec(&row).unwrap().len() + 1;
            if bytes + size > 768 * 1024 {
                break;
            }
            rows.insert(0, row);
            bytes += size;
        }
        value["attemptsTruncated"] = json!(rows.len() < self.state.attempts.len());
        value["attempts"] = json!(rows);
        value
    }
    pub fn dispatch(
        &mut self,
        action: &str,
        input: Value,
        now: u64,
        stopped: bool,
        settings: &WarmSettings,
    ) -> Result<Value> {
        ensure!(now <= SAFE_INTEGER, "CACHE_WARM_INVALID: invalid clock.");
        match action {
            "list" => Ok(self.list(now, settings)),
            "configure" => self.configure(input, now, stopped, settings),
            "observe" => self.observe(input, now, settings),
            "claim" => self.claim(input, now, stopped, settings),
            "check" => self.check(input, now, stopped),
            "receipt" => self.receipt(input, now),
            _ => bail!("CACHE_WARM_UNSUPPORTED: unsupported cache-warming action."),
        }
    }
    fn configure(
        &mut self,
        input: Value,
        now: u64,
        stopped: bool,
        settings: &WarmSettings,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Config {
            provider: String,
            session_id: String,
            cwd: String,
            enabled: bool,
            request_id: Option<String>,
            ttl: Option<String>,
            compact: Option<bool>,
            max_minutes: Option<u64>,
            max_refreshes: Option<u64>,
            #[serde(rename = "maxReadTokens")]
            _max_read_tokens: Option<Value>,
            max_output_tokens: Option<u64>,
            fixed_end: Option<bool>,
            best_effort: Option<bool>,
            refresh_minutes: Option<u64>,
        }
        let read_payload = input.get("maxReadTokens").cloned().unwrap_or(json!(250000));
        let c: Config = serde_json::from_value(input)?;
        identity(&c.session_id, &c.cwd)?;
        ensure!(
            c.provider == self.provider,
            "CACHE_WARM_UNSUPPORTED: provider differs from ledger."
        );
        ensure!(
            !c.enabled || c.request_id.as_deref().is_some_and(word),
            "CACHE_WARM_INVALID: enabling requires unique requestId."
        );
        ensure!(
            c.request_id.as_deref().is_none_or(word)
                && c.ttl.as_deref().is_none_or(|v| ["1h", "5m"].contains(&v))
                && c.fixed_end.is_none_or(|v| v),
            "CACHE_WARM_INVALID: invalid enrollment."
        );
        if self.provider == "codex" {
            ensure!(
                !c.enabled || c.best_effort == Some(true),
                "CACHE_WARM_INVALID: Codex requires explicit bestEffort acceptance."
            );
            ensure!(
                c.ttl.is_none() && (1..=25).contains(&c.refresh_minutes.unwrap_or(25)),
                "CACHE_WARM_INVALID: invalid Codex timing."
            );
        }
        let minutes = c.max_minutes.unwrap_or(60);
        let refreshes = c.max_refreshes.unwrap_or(3);
        let output = c.max_output_tokens.unwrap_or(256);
        let read = read_payload;
        ensure!(
            (1..=10080).contains(&minutes)
                && (1..=500).contains(&refreshes)
                && (1..=1000000).contains(&output)
                && (read.is_null() || read.as_u64().is_some_and(|v| (1..=100000000).contains(&v))),
            "CACHE_WARM_INVALID: invalid enrollment budget."
        );
        let mut payload = json!({"provider":self.provider,"sessionId":c.session_id,"cwd":c.cwd,"enabled":c.enabled,"maxMinutes":minutes,"maxRefreshes":refreshes,"maxReadTokens":read,"maxOutputTokens":output});
        if let Some(v) = &c.ttl {
            payload["ttl"] = json!(v)
        }
        if c.fixed_end == Some(true) {
            payload["fixedEnd"] = json!(true)
        }
        if let Some(v) = c.compact {
            payload["compact"] = json!(v)
        }
        if self.provider == "codex" {
            payload["bestEffort"] = json!(c.best_effort == Some(true));
            payload["refreshMinutes"] = json!(c.refresh_minutes.unwrap_or(25));
        }
        let payload = serde_json::to_string(&payload)?;
        if let Some(saved) = c
            .request_id
            .as_ref()
            .and_then(|id| self.state.requests.iter().find(|r| r.request_id == *id))
        {
            ensure!(
                saved.payload == payload,
                "CACHE_WARM_INVALID: requestId reused with changed parameters."
            );
            let mut result = self.result(&saved.session_id, now, settings);
            result["replayed"] = json!(true);
            return Ok(result);
        }
        ensure!(
            !self.closed || !c.enabled,
            "CACHE_WARM_INVALID: broker stopping."
        );
        ensure!(
            !stopped || !c.enabled,
            "CACHE_WARM_STOPPED: application is stopped or resuming."
        );
        let binding = self.bindings.get(&c.session_id).cloned();
        if c.enabled {
            ensure!(
                binding
                    .as_ref()
                    .is_some_and(|b| b.cwd == c.cwd && b.phase != NativePhase::Ended),
                "CACHE_WARM_NOT_BOUND: enable from a loaded native session."
            );
        }
        if c.enabled
            && (self.state.attempts.len() > MAX_ATTEMPTS / 2
                || self.state.requests.len() > MAX_ATTEMPTS / 2
                || self.state.policies.len() > MAX_POLICIES / 2)
        {
            let mut finished: BTreeSet<_> = self
                .state
                .policies
                .iter()
                .filter(|p| p.session_id != c.session_id && !p.enabled && p.until <= now)
                .map(|p| p.session_id.clone())
                .collect();
            self.state
                .attempts
                .retain(|a| !finished.contains(&a.session_id) || !a.state.settled());
            for a in &self.state.attempts {
                finished.remove(&a.session_id);
            }
            self.state
                .policies
                .retain(|p| !finished.contains(&p.session_id));
            self.state
                .requests
                .retain(|r| !finished.contains(&r.session_id));
        }
        ensure!(
            c.request_id.is_none() || self.state.requests.len() < MAX_ATTEMPTS,
            "CACHE_WARM_CAPACITY: request receipt capacity exhausted."
        );
        let prior = self.policy(&c.session_id).cloned();
        ensure!(
            prior.is_some() || self.state.policies.len() < MAX_POLICIES,
            "CACHE_WARM_CAPACITY: policy capacity exhausted."
        );
        ensure!(
            !c.enabled
                || !self
                    .state
                    .attempts
                    .iter()
                    .any(|a| a.session_id == c.session_id
                        && a.state.live()
                        && a.state != AttemptState::Reserved),
            "CACHE_WARM_PENDING: prior native attempt awaits evidence."
        );
        for a in &mut self.state.attempts {
            if a.session_id == c.session_id && a.state == AttemptState::Reserved {
                a.state = AttemptState::Revoked;
                a.reason = Some("policy-changed".into());
            }
        }
        let sample = binding.as_ref().and_then(|b| b.sample.as_ref());
        let mut p = Policy {
            provider: self.provider.clone(),
            session_id: c.session_id.clone(),
            cwd: c.cwd,
            enabled: c.enabled,
            generation: prior.as_ref().map(|p| p.generation).unwrap_or(0) + 1,
            max_minutes: minutes,
            max_refreshes: refreshes,
            max_read_tokens: None,
            max_output_tokens: output,
            until: now + minutes * 60000,
            updated_at: now,
            reason: (!c.enabled).then(|| "disabled".into()),
            model: sample.map(|s| s.model.clone()),
            effort: sample.map(|s| s.effort.clone()),
            ttl_ms: sample.map(|s| s.ttl_ms),
            ttl_preference: (self.provider == "claude").then(|| c.ttl.unwrap_or("1h".into())),
            best_effort: (self.provider == "codex").then_some(c.best_effort == Some(true)),
            refresh_minutes: (self.provider == "codex").then_some(c.refresh_minutes.unwrap_or(25)),
            fixed_end: c.fixed_end,
            restarted_at: None,
            compact: c.compact,
            prime_at: None,
            extra: BTreeMap::new(),
        };
        if c.enabled && !self.usable(&p, binding.as_ref(), now) {
            p.prime_at = Some(now);
            p.model = None;
            p.effort = None;
            p.ttl_ms = None;
        }
        if c.enabled {
            self.state.attempts.retain(|a| {
                a.session_id != c.session_id || a.generation >= p.generation || !a.state.settled()
            });
        }
        if let Some(i) = self.policy_index(&c.session_id) {
            if !c.enabled {
                let old = &mut self.state.policies[i];
                old.enabled = false;
                old.updated_at = now;
                old.reason = Some("disabled".into());
            } else {
                self.state.policies[i] = p
            }
        } else {
            self.state.policies.push(p)
        }
        if let Some(request_id) = c.request_id {
            self.state.requests.push(RequestReceipt {
                request_id,
                session_id: c.session_id.clone(),
                generation: self.policy(&c.session_id).unwrap().generation,
                payload,
            });
        }
        self.save()?;
        let mut result = self.result(&c.session_id, now, settings);
        result["replayed"] = json!(false);
        Ok(result)
    }
    fn retire(&mut self, b: &Binding) {
        let time = binding_time(&b.instance_id);
        self.retired.retain(|(session, instance, _)| {
            session != &b.session_id || instance != &b.instance_id
        });
        self.retired
            .push_back((b.session_id.clone(), b.instance_id.clone(), time));
        while self.retired.len() > MAX_POLICIES {
            let index = self
                .retired
                .iter()
                .enumerate()
                .min_by_key(|(_, (_, _, t))| t.unwrap_or(0))
                .unwrap()
                .0;
            let (_, _, time) = self.retired.remove(index).unwrap();
            if let Some(t) = time {
                self.retired_before = Some(self.retired_before.unwrap_or(0).max(t))
            } else {
                self.legacy_retired = true
            }
        }
    }
    fn is_retired(&self, session: &str, instance: &str) -> bool {
        self.retired
            .iter()
            .any(|(s, i, _)| s == session && i == instance)
            || match binding_time(instance) {
                Some(t) => self.retired_before.is_some_and(|f| t <= f),
                None => self.legacy_retired,
            }
    }
    fn observe(&mut self, input: Value, now: u64, settings: &WarmSettings) -> Result<Value> {
        let o: Observation = serde_json::from_value(input)?;
        identity(&o.session_id, &o.cwd)?;
        ensure!(
            word(&o.instance_id)
                && o.sequence >= 1
                && o.sequence <= SAFE_INTEGER
                && o.epoch <= SAFE_INTEGER
                && o.attempt_id.as_deref().is_none_or(word),
            "CACHE_WARM_INVALID: invalid observation."
        );
        if let Some(s) = &o.sample {
            s.validate(now, &self.provider)?;
            ensure!(
                o.phase != NativePhase::Ended
                    && o.attempt_id
                        .as_ref()
                        .zip(s.attempt_id.as_ref())
                        .is_none_or(|(a, b)| a == b),
                "CACHE_WARM_INVALID: sample context mismatch."
            );
        }
        if self.closed {
            return Ok(json!({"observed":false,"reason":"broker-stopping"}));
        }
        let old = self.bindings.get(&o.session_id).cloned();
        let replaced = old.as_ref().is_some_and(|b| b.instance_id != o.instance_id);
        if old.as_ref().is_none_or(|b| b.instance_id != o.instance_id)
            && self.is_retired(&o.session_id, &o.instance_id)
            || old.as_ref().is_some_and(|b| {
                b.instance_id == o.instance_id
                    && (o.sequence <= b.sequence || o.epoch < b.epoch || b.cwd != o.cwd)
            })
        {
            return Ok(json!({"observed":false,"reason":"stale-observation"}));
        }
        ensure!(
            old.is_some() || self.bindings.len() < MAX_POLICIES,
            "CACHE_WARM_CAPACITY: native binding capacity exhausted."
        );
        let repeated = o
            .sample
            .as_ref()
            .zip(old.as_ref().and_then(|b| b.sample.as_ref()))
            .is_some_and(|(a, b)| !replaced && a.id == b.id);
        if repeated && o.sample != old.as_ref().and_then(|b| b.sample.clone()) {
            return Ok(json!({"observed":false,"reason":"changed-sample"}));
        }
        if let Some((sample, prior)) = o
            .sample
            .as_ref()
            .zip(old.as_ref().and_then(|b| b.sample.as_ref()))
        {
            if !repeated
                && !replaced
                && (sample.started_at < prior.started_at
                    || sample.completed_at < prior.completed_at
                    || self.provider != "codex" && sample.completed_at == prior.completed_at)
            {
                return Ok(json!({"observed":false,"reason":"stale-sample"}));
            }
        }
        let own_attempt_id = o
            .attempt_id
            .clone()
            .or_else(|| o.sample.as_ref().and_then(|s| s.attempt_id.clone()));
        let b = Binding {
            session_id: o.session_id.clone(),
            cwd: o.cwd.clone(),
            instance_id: o.instance_id.clone(),
            sequence: o.sequence,
            epoch: o.epoch,
            phase: o.phase,
            sample: o.sample.clone().or_else(|| {
                old.as_ref()
                    .filter(|b| !replaced && b.epoch == o.epoch)
                    .and_then(|b| b.sample.clone())
            }),
            evidence_epoch: old
                .as_ref()
                .filter(|_| !replaced)
                .and_then(|b| b.evidence_epoch)
                .or_else(|| o.sample.as_ref().map(|_| o.epoch)),
        };
        let mut changed = false;
        for i in 0..self.state.attempts.len() {
            if self.state.attempts[i].session_id != o.session_id {
                continue;
            }
            let mut stop_reason = None;
            {
                let a = &mut self.state.attempts[i];
                if a.state == AttemptState::Reserved
                    && (replaced
                        || o.phase != NativePhase::Idle
                        || o.epoch != a.epoch
                        || o.sample
                            .as_ref()
                            .is_some_and(|s| Some(&s.id) != a.sample_id.as_ref()))
                {
                    a.state = AttemptState::Revoked;
                    a.reason = Some("native-activity-changed".into());
                    changed = true;
                }
                let own = own_attempt_id.as_ref() == Some(&a.id)
                    && a.instance_id == o.instance_id
                    && a.authorized_at.is_some();
                if matches!(a.state, AttemptState::Dispatching | AttemptState::Submitted)
                    && (replaced
                        || o.phase == NativePhase::Ended
                        || !own
                            && (o.phase == NativePhase::Busy
                                || o.epoch != a.epoch
                                || o.sample.is_some()))
                {
                    a.state = AttemptState::Uncertain;
                    a.reason = Some("native-activity-changed".into());
                    stop_reason = a.reason.clone();
                    changed = true;
                }
                let authorized = if self.provider == "codex" {
                    a.authorized_at.unwrap_or(SAFE_INTEGER) / 1000 * 1000
                } else {
                    a.authorized_at.unwrap_or(SAFE_INTEGER)
                };
                if let Some(s) = o.sample.as_ref().filter(|s| {
                    !repeated
                        && own
                        && matches!(
                            a.state,
                            AttemptState::Dispatching
                                | AttemptState::Submitted
                                | AttemptState::Verified
                                | AttemptState::Failed
                        )
                        && Some(&s.id) != a.sample_id.as_ref()
                        && s.started_at >= authorized
                        && o.epoch > a.epoch
                }) {
                    let ids = a.response_ids.get_or_insert_with(Vec::new);
                    if !ids.contains(&s.id) {
                        if ids.len() >= 64 {
                            a.state = AttemptState::Failed;
                            a.reason = Some("native-response-capacity".into());
                            stop_reason = a.reason.clone();
                            changed = true;
                        } else {
                            ids.push(s.id.clone());
                            let actual = a.actual.get_or_insert_with(Usage::default);
                            actual.input_tokens += s.input_tokens;
                            actual.cache_read_tokens += s.cache_read_tokens;
                            actual.cache_write_tokens += s.cache_write_tokens;
                            actual.output_tokens += s.output_tokens;
                            a.completed_at = Some(s.completed_at);
                            a.response_id = Some(s.id.clone());
                            let covers = s.cache_read_tokens >= a.required_prefix_tokens
                                || self.provider == "claude"
                                    && a.prior_read_tokens.is_some_and(|v| s.cache_read_tokens > v)
                                    && s.prefix(&self.provider) >= a.required_prefix_tokens;
                            let prime = a.kind == Some(AttemptKind::Prime);
                            let verified = a.state != AttemptState::Failed
                                && s.success()
                                && s.prefix(&self.provider) > 0
                                && (prime
                                    || Some(&s.model) == a.model.as_ref()
                                        && Some(&s.effort) == a.effort.as_ref());
                            let outcome = if prime {
                                "native-cache-primed"
                            } else if covers {
                                "native-cache-hit"
                            } else {
                                "native-cache-refreshed"
                            };
                            if self.provider == "codex" && verified {
                                a.response_verified = Some(true);
                                a.cache_verified = Some(!prime && covers);
                                a.reason = Some(format!("{outcome}-pending-completion"));
                            } else {
                                a.state = if verified {
                                    AttemptState::Verified
                                } else {
                                    AttemptState::Failed
                                };
                                a.reason = Some(
                                    if verified {
                                        outcome
                                    } else {
                                        "native-cache-verification-failed"
                                    }
                                    .into(),
                                );
                            }
                            if a.state == AttemptState::Failed {
                                stop_reason = a.reason.clone();
                            }
                            changed = true;
                        }
                    }
                }
                if self.provider == "codex"
                    && own
                    && o.phase == NativePhase::Idle
                    && o.epoch > a.epoch
                    && matches!(a.state, AttemptState::Dispatching | AttemptState::Submitted)
                    && (a.response_verified == Some(true) || a.cache_verified == Some(true))
                    && a.response_ids.as_ref().is_some_and(|v| !v.is_empty())
                {
                    a.state = AttemptState::Verified;
                    a.reason = Some(
                        if a.kind == Some(AttemptKind::Prime) {
                            "native-cache-primed"
                        } else if a.cache_verified == Some(true) {
                            "native-cache-hit"
                        } else {
                            "native-cache-refreshed"
                        }
                        .into(),
                    );
                    changed = true;
                }
            }
            if let Some(p) = self.policy_index(&o.session_id) {
                if self.totals(&self.state.policies[p]).output_tokens
                    > self.state.policies[p].max_output_tokens
                {
                    stop_reason = Some("actual-budget-exceeded".into());
                }
                if let Some(reason) = stop_reason {
                    self.state.policies[p].enabled = false;
                    self.state.policies[p].reason = Some(reason);
                }
            }
        }
        if let Some(i) = self.policy_index(&o.session_id) {
            let mut p = self.state.policies[i].clone();
            if p.prime_at.is_some() && own_attempt_id.is_none() && self.usable(&p, Some(&b), now) {
                p.prime_at = None;
                changed = true;
            }
            if p.enabled && (replaced || o.phase == NativePhase::Ended) {
                p.enabled = false;
                p.reason = Some("native-binding-changed".into());
                changed = true;
            }
            if p.enabled
                && o.sample.is_some()
                && !repeated
                && own_attempt_id.is_none()
                && !replaced
                && old
                    .as_ref()
                    .and_then(|b| b.evidence_epoch)
                    .is_some_and(|epoch| o.epoch > epoch)
            {
                let s = o.sample.as_ref().unwrap();
                if settings.warm_on_user_message == "stop" {
                    p.enabled = false;
                    p.reason = Some("user-message".into());
                    for a in &mut self.state.attempts {
                        if a.session_id == o.session_id && a.state == AttemptState::Reserved {
                            a.state = AttemptState::Revoked;
                            a.reason = Some("user-message".into());
                        }
                    }
                    changed = true;
                } else if s.stop_reason != "tool_use"
                    && s.success()
                    && now < p.until
                    && self.totals(&p).refreshes < p.max_refreshes
                {
                    p.restarted_at = Some(now);
                    p.updated_at = now;
                    if p.fixed_end != Some(true) {
                        p.until = now + p.max_minutes * 60000;
                    }
                    if self.state.attempts.len() > MAX_ATTEMPTS / 2 {
                        self.state.attempts.retain(|a| {
                            a.session_id != o.session_id
                                || a.created_at >= now
                                || !a.state.settled()
                        });
                    }
                    changed = true;
                } else if s.stop_reason != "tool_use"
                    && s.success()
                    && p.compact.unwrap_or(settings.compact_after_warm)
                {
                    p.enabled = false;
                    p.reason = Some(
                        if now >= p.until {
                            "duration-limit"
                        } else {
                            "refresh-limit"
                        }
                        .into(),
                    );
                    changed = true;
                }
            }
            if let Some(s) = &o.sample {
                let ordinary_tool = own_attempt_id.is_none()
                    && o.phase == NativePhase::Busy
                    && s.stop_reason == "tool_use";
                if p.enabled && ((!s.success() && !ordinary_tool) || s.prefix(&self.provider) == 0)
                {
                    p.enabled = false;
                    p.reason = Some(
                        if !s.success() {
                            "native-output-not-complete"
                        } else {
                            "no-cache-prefix"
                        }
                        .into(),
                    );
                    changed = true;
                }
                if p.enabled {
                    if p.model.is_none() {
                        p.model = Some(s.model.clone());
                        p.effort = Some(s.effort.clone());
                        p.ttl_ms = Some(s.ttl_ms);
                        changed = true;
                    } else if p.model.as_ref() != Some(&s.model)
                        || p.effort.as_ref() != Some(&s.effort)
                        || p.ttl_ms != Some(s.ttl_ms)
                    {
                        p.enabled = false;
                        p.reason = Some("native-configuration-changed".into());
                        changed = true;
                    }
                }
            }
            // Persist a completed Codex schedule's limit before its runtime
            // detaches the observer; that owned shutdown is not a binding change.
            if self.provider == "codex"
                && p.enabled
                && o.phase == NativePhase::Idle
                && self.compaction(&p, Some(&b), now, settings).is_none()
            {
                if let Some(reason) = self
                    .reason(Some(&p), Some(&b), now, false)
                    .filter(|reason| {
                        matches!(
                            *reason,
                            "duration-limit" | "refresh-limit" | "output-budget"
                        )
                    })
                    .map(str::to_owned)
                {
                    p.enabled = false;
                    p.reason = Some(reason);
                    changed = true;
                }
            }
            self.state.policies[i] = p;
        }
        if o.phase == NativePhase::Ended {
            self.retire(&b);
            self.bindings.remove(&o.session_id);
        } else {
            self.bindings.insert(o.session_id.clone(), b);
        }
        if replaced {
            self.retire(old.as_ref().unwrap());
        }
        if changed {
            self.save()?;
        }
        let mut result = self.result(&o.session_id, now, settings);
        result["observed"] = json!(true);
        result["bound"] = json!(o.phase != NativePhase::Ended);
        Ok(result)
    }
    fn bound_input(&self, input: &Value) -> Result<(String, String, String, u64)> {
        let session = input["sessionId"]
            .as_str()
            .context("CACHE_WARM_INVALID: sessionId required")?
            .to_string();
        let cwd = input["cwd"]
            .as_str()
            .context("CACHE_WARM_INVALID: cwd required")?
            .to_string();
        let instance = input["instanceId"]
            .as_str()
            .filter(|s| word(s))
            .context("CACHE_WARM_INVALID: instanceId required")?
            .to_string();
        identity(&session, &cwd)?;
        let epoch = input["epoch"]
            .as_u64()
            .filter(|v| *v <= SAFE_INTEGER)
            .context("CACHE_WARM_INVALID: epoch required")?;
        Ok((session, cwd, instance, epoch))
    }
    fn claim(
        &mut self,
        input: Value,
        now: u64,
        stopped: bool,
        settings: &WarmSettings,
    ) -> Result<Value> {
        let (session, cwd, instance, epoch) = self.bound_input(&input)?;
        ensure!(
            input.get("kind").is_none() || input["kind"] == "compact",
            "CACHE_WARM_INVALID: only compact kind may be requested."
        );
        let p = self.policy(&session).cloned();
        let b = self
            .bindings
            .get(&session)
            .filter(|b| b.cwd == cwd && b.instance_id == instance)
            .cloned();
        let bound = !stopped && b.as_ref().is_some_and(|b| b.epoch == epoch);
        let compact = input["kind"] == "compact";
        if compact {
            let at = if bound {
                p.as_ref()
                    .and_then(|p| self.compaction(p, b.as_ref(), now, settings))
            } else {
                None
            };
            if at.is_none() || now < at.unwrap() {
                return Ok(
                    json!({"claimed":false,"reason":if stopped{"app-stopped"}else if at.is_none(){"compact-unavailable"}else{"not-due"}}),
                );
            }
        } else {
            let reason = if stopped {
                Some("app-stopped")
            } else if !bound {
                Some("native-binding-changed")
            } else {
                self.reason(p.as_ref(), b.as_ref(), now, true)
            };
            if let Some(reason) = reason {
                return Ok(
                    json!({"claimed":false,"reason":reason,"nextAt":p.as_ref().map(|p|self.presentation(p,now,settings)["nextAt"].clone()),"compactAt":if bound{p.as_ref().and_then(|p|self.compaction(p,b.as_ref(),now,settings))}else{None}}),
                );
            }
        }
        ensure!(
            self.state.attempts.len() < MAX_ATTEMPTS,
            "CACHE_WARM_CAPACITY: attempt capacity exhausted."
        );
        let p = p.unwrap();
        let b = b.unwrap();
        let prime = !compact && self.needs_prime(&p, Some(&b), now);
        let sample = b.sample.as_ref();
        let prefix = if prime {
            0
        } else {
            sample.unwrap().prefix(&self.provider)
        };
        let next_at = if prime {
            p.prime_at.unwrap()
        } else {
            sample.unwrap().next(&p)
        };
        let expires_at = if compact {
            sample.unwrap().expiry(&p)
        } else {
            (if prime {
                p.prime_at.unwrap() + PRIME_DISPATCH_MS
            } else {
                sample.unwrap().expiry(&p)
            })
            .min(p.until)
        };
        let a = Attempt {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session,
            cwd,
            instance_id: instance,
            epoch,
            generation: p.generation,
            created_at: now,
            next_at,
            expires_at,
            sample_id: sample.map(|s| s.id.clone()),
            model: if prime {
                None
            } else {
                sample.map(|s| s.model.clone())
            },
            effort: if prime {
                None
            } else {
                sample.map(|s| s.effort.clone())
            },
            state: AttemptState::Reserved,
            required_prefix_tokens: prefix,
            reserved_read_tokens: prefix + READ_OVERHEAD,
            reserved_output_tokens: OUTPUT_RESERVATION,
            kind: if compact {
                Some(AttemptKind::Compact)
            } else if prime {
                Some(AttemptKind::Prime)
            } else {
                None
            },
            prior_read_tokens: if prime || compact {
                None
            } else {
                sample.map(|s| s.cache_read_tokens)
            },
            authorized_at: None,
            actual: None,
            response_ids: None,
            cache_verified: None,
            response_verified: None,
            completed_at: None,
            response_id: None,
            reason: None,
            received_at: None,
            extra: BTreeMap::new(),
        };
        let mut result = json!({"claimed":true,"attempt":{"id":a.id,"expiresAt":a.expires_at}});
        if compact || prime {
            result["attempt"]["kind"] = json!(a.kind)
        }
        if !compact {
            result["attempt"]["prompt"] = json!(PROMPT);
            result["attempt"]["nextAt"] = json!(next_at);
        }
        self.state.attempts.push(a);
        self.save()?;
        Ok(result)
    }
    fn check(&mut self, input: Value, now: u64, stopped: bool) -> Result<Value> {
        let (session, cwd, instance, epoch) = self.bound_input(&input)?;
        let id = input["attemptId"]
            .as_str()
            .filter(|s| word(s))
            .context("CACHE_WARM_INVALID: attemptId required")?;
        let Some(i) = self.state.attempts.iter().position(|a| {
            a.id == id && a.session_id == session && a.cwd == cwd && a.instance_id == instance
        }) else {
            return Ok(json!({"ready":false,"reason":"attempt-identity-mismatch"}));
        };
        let a = &self.state.attempts[i];
        if a.state != AttemptState::Reserved {
            return Ok(json!({"ready":false,"reason":"attempt-already-consumed"}));
        }
        let p = self.policy(&session);
        let b = self
            .bindings
            .get(&session)
            .filter(|b| b.cwd == cwd && b.instance_id == instance);
        let reason = if self.closed {
            Some("broker-stopping")
        } else if stopped {
            Some("app-stopped")
        } else if p.is_none_or(|p| !p.enabled || p.generation != a.generation) {
            Some("policy-changed")
        } else if b.is_none_or(|b| {
            b.epoch != a.epoch
                || epoch != a.epoch
                || b.phase != NativePhase::Idle
                || b.sample.as_ref().map(|s| &s.id) != a.sample_id.as_ref()
        }) {
            Some("native-activity-changed")
        } else if now >= a.expires_at
            || a.kind != Some(AttemptKind::Compact) && now >= p.unwrap().until
        {
            Some("attempt-expired")
        } else {
            None
        };
        let a = &mut self.state.attempts[i];
        if let Some(reason) = reason {
            a.state = AttemptState::Revoked;
            a.reason = Some(reason.into());
            self.save()?;
            return Ok(json!({"ready":false,"reason":reason}));
        }
        a.state = AttemptState::Dispatching;
        a.authorized_at = Some(now);
        let result = json!({"ready":true,"attemptId":a.id,"expiresAt":a.expires_at});
        self.save()?;
        Ok(result)
    }
    fn receipt(&mut self, input: Value, now: u64) -> Result<Value> {
        let session = input["sessionId"]
            .as_str()
            .context("CACHE_WARM_INVALID: session required")?;
        let cwd = input["cwd"]
            .as_str()
            .context("CACHE_WARM_INVALID: cwd required")?;
        identity(session, cwd)?;
        let instance = input["instanceId"]
            .as_str()
            .filter(|s| word(s))
            .context("CACHE_WARM_INVALID: instance required")?;
        let id = input["attemptId"]
            .as_str()
            .filter(|s| word(s))
            .context("CACHE_WARM_INVALID: attempt required")?;
        let outcome = input["outcome"]
            .as_str()
            .filter(|s| ["submitted", "compacted", "rejected", "uncertain"].contains(s))
            .context("CACHE_WARM_INVALID: invalid outcome")?;
        let i = self
            .state
            .attempts
            .iter()
            .position(|a| {
                a.id == id && a.session_id == session && a.cwd == cwd && a.instance_id == instance
            })
            .context("CACHE_WARM_INVALID: receipt identity changed")?;
        let a = &mut self.state.attempts[i];
        if matches!(
            a.state,
            AttemptState::Verified
                | AttemptState::Failed
                | AttemptState::Uncertain
                | AttemptState::Revoked
                | AttemptState::Rejected
        ) || a.state == AttemptState::Submitted && outcome == "submitted"
        {
            return Ok(serde_json::to_value(a)?);
        }
        ensure!(
            a.state == AttemptState::Dispatching
                || a.state == AttemptState::Reserved && outcome == "rejected",
            "CACHE_WARM_INVALID: attempt not authorized."
        );
        ensure!(
            (outcome == "compacted") == (a.kind == Some(AttemptKind::Compact))
                || !["submitted", "compacted"].contains(&outcome),
            "CACHE_WARM_INVALID: receipt does not match attempt."
        );
        let compact = a.kind == Some(AttemptKind::Compact);
        a.state = match outcome {
            "compacted" => AttemptState::Verified,
            "submitted" => AttemptState::Submitted,
            "rejected" => AttemptState::Rejected,
            _ => AttemptState::Uncertain,
        };
        a.received_at = Some(now);
        if compact {
            a.reason = Some(if outcome == "compacted" {
                "native-compacted".into()
            } else {
                format!("compact-{outcome}")
            });
        }
        let result = serde_json::to_value(&*a)?;
        if compact || outcome != "submitted" {
            let p = self.policy_index(session).unwrap();
            self.state.policies[p].enabled = false;
            self.state.policies[p].reason = Some(if compact {
                match outcome {
                    "compacted" => "compacted",
                    "rejected" => "compact-skipped",
                    _ => "native-uncertain",
                }
                .into()
            } else {
                format!("native-{outcome}")
            });
        }
        self.save()?;
        Ok(result)
    }
    fn stop_policies(&mut self, reason: &str, now: u64) {
        for p in &mut self.state.policies {
            if p.enabled {
                p.enabled = false;
                p.reason = Some(reason.into());
                p.updated_at = now;
            }
        }
        for a in &mut self.state.attempts {
            if a.state.live() {
                a.state = if a.state == AttemptState::Reserved {
                    AttemptState::Revoked
                } else {
                    AttemptState::Uncertain
                };
                a.reason = Some(reason.into());
            }
        }
    }
    pub fn close(&mut self, now: u64, failure: Option<(String, String)>) -> Result<()> {
        self.closed = true;
        self.failure = failure;
        let changed = self.state.policies.iter().any(|p| p.enabled)
            || self.state.attempts.iter().any(|a| a.state.live());
        let reason = self
            .failure
            .as_ref()
            .map(|v| v.1.clone())
            .unwrap_or("broker-stopped".into());
        self.stop_policies(&reason, now);
        self.bindings.clear();
        if changed {
            self.save()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_minutes: u64,
    pub max_refreshes: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fixed_end: bool,
}
/// One limit only. `until` uses the caller's local calendar, never UTC guessing.
pub fn parse_limit<Tz: chrono::TimeZone>(
    word: &str,
    interval_minutes: u64,
    now: chrono::DateTime<Tz>,
) -> Result<Limits>
where
    Tz::Offset: std::fmt::Display,
{
    use chrono::Datelike;
    ensure!(interval_minutes > 0, "Invalid refresh interval.");
    let maximum = 10080;
    if let Some(n) = word.strip_prefix("rounds=") {
        let n = n.parse::<u64>()?;
        ensure!(
            (1..=500).contains(&n) && n <= maximum / interval_minutes,
            "Rounds must fit within 168 hours."
        );
        return Ok(Limits {
            max_minutes: maximum,
            max_refreshes: n,
            fixed_end: false,
        });
    }
    let (minutes, fixed) = if let Some(duration) = word.strip_prefix("for=") {
        let re = regex::Regex::new(r"^(?:([0-9]{1,3})h)?(?:([0-9]{1,5})m)?$")?;
        let c = re
            .captures(duration)
            .context("Use for=90m, for=3h or for=1h30m.")?;
        ensure!(
            c.get(1).is_some() || c.get(2).is_some(),
            "Duration is empty."
        );
        let hours = c
            .get(1)
            .map(|m| m.as_str().parse::<u64>())
            .transpose()?
            .unwrap_or(0);
        let minutes = c
            .get(2)
            .map(|m| m.as_str().parse::<u64>())
            .transpose()?
            .unwrap_or(0);
        (hours * 60 + minutes, false)
    } else if let Some(time) = word.strip_prefix("until=") {
        let parts = time
            .split(':')
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()?;
        ensure!(
            parts.len() == 2 || parts.len() == 3,
            "Use until=HH:MM or DD:HH:MM."
        );
        let (day, hour, minute) = if parts.len() == 3 {
            (Some(parts[0]), parts[1], parts[2])
        } else {
            (None, parts[0], parts[1])
        };
        ensure!(
            hour < 24 && minute < 60 && day.is_none_or(|d| (1..=31).contains(&d)),
            "Invalid local clock time."
        );
        let mut target = None;
        for offset in 0..=7 {
            let date = now.date_naive() + chrono::Duration::days(offset);
            if day.is_some_and(|d| date.day() != d) {
                continue;
            }
            let naive = date.and_hms_opt(hour, minute, 0).unwrap();
            let candidate = now.timezone().from_local_datetime(&naive).earliest();
            if let Some(c) = candidate.filter(|c| *c > now) {
                target = Some(c);
                break;
            }
        }
        let target = target.context("Clock limit must occur within 168 hours.")?;
        let ms = (target - now).num_milliseconds();
        ensure!(ms > 0, "Clock limit already ended.");
        ((ms as u64).div_ceil(60000), true)
    } else {
        bail!("Choose exactly one of rounds=N, for=DURATION or until=HH:MM|DD:HH:MM.")
    };
    ensure!(
        (1..=maximum).contains(&minutes),
        "Duration must be 1 minute to 168 hours."
    );
    let requests = minutes.div_ceil(interval_minutes);
    ensure!(
        requests <= 500,
        "Chosen limit requires more than 500 requests."
    );
    Ok(Limits {
        max_minutes: minutes,
        max_refreshes: requests,
        fixed_end: fixed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn manager_for(provider: &str) -> (tempfile::TempDir, CacheWarmManager) {
        let t = tempfile::tempdir().unwrap();
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let m = CacheWarmManager::open(std::fs::canonicalize(t.path()).unwrap(), provider).unwrap();
        (t, m)
    }
    fn manager() -> (tempfile::TempDir, CacheWarmManager) {
        manager_for("claude")
    }
    fn binding(epoch: u64, sequence: u64) -> Value {
        json!({"sessionId":"session-a","cwd":"/tmp/project","instanceId":"warm-100-uuid","epoch":epoch,"sequence":sequence,"phase":"idle"})
    }
    fn enable() -> Value {
        json!({"provider":"claude","sessionId":"session-a","cwd":"/tmp/project","enabled":true,"requestId":"request-a","maxRefreshes":3,"maxMinutes":60})
    }
    #[test]
    fn explicit_prime_has_one_durable_dispatch_and_restart_never_replays() {
        let (t, mut m) = manager();
        let settings = WarmSettings::default();
        m.dispatch("observe", binding(1, 1), 1000, false, &settings)
            .unwrap();
        let p = m
            .dispatch("configure", enable(), 1000, false, &settings)
            .unwrap();
        assert_eq!(p["prime"], true);
        let mut input = binding(1, 2);
        let claim = m
            .dispatch("claim", input.clone(), 1000, false, &settings)
            .unwrap();
        let id = claim["attempt"]["id"].clone();
        assert_eq!(claim["attempt"]["kind"], "prime");
        input["attemptId"] = id;
        assert_eq!(
            m.dispatch("check", input.clone(), 1001, false, &settings)
                .unwrap()["ready"],
            true
        );
        assert_eq!(
            m.dispatch("check", input.clone(), 1002, false, &settings)
                .unwrap()["reason"],
            "attempt-already-consumed"
        );
        drop(m);
        let mut m =
            CacheWarmManager::open(std::fs::canonicalize(t.path()).unwrap(), "claude").unwrap();
        assert_eq!(m.state.attempts[0].state, AttemptState::Uncertain);
        assert!(!m.state.policies[0].enabled);
        assert_eq!(
            m.dispatch("check", input, 1003, false, &settings).unwrap()["ready"],
            false
        );
    }
    #[test]
    fn request_replay_keeps_payload_identity_and_explicit_false() {
        let (_t, mut m) = manager();
        let s = WarmSettings::default();
        m.dispatch("observe", binding(1, 1), 1000, false, &s)
            .unwrap();
        m.dispatch("configure", enable(), 1000, false, &s).unwrap();
        assert_eq!(
            m.dispatch("configure", enable(), 1000, false, &s).unwrap()["replayed"],
            true
        );
        let mut changed = enable();
        changed["maxRefreshes"] = json!(4);
        assert!(m.dispatch("configure", changed, 1000, false, &s).is_err());
        let mut off = enable();
        off["enabled"] = json!(false);
        off["requestId"] = json!("off-a");
        m.dispatch("configure", off, 1001, false, &s).unwrap();
        assert!(!m.state.policies[0].enabled);
        assert_eq!(m.state.policies[0].generation, 1);
    }
    #[test]
    fn namespaced_four_hour_limits_match_each_provider() {
        let now = chrono::Utc::now();
        assert_eq!(parse_limit("for=4h", 55, now).unwrap().max_refreshes, 5);
        assert_eq!(parse_limit("for=4h", 4, now).unwrap().max_refreshes, 60);
        assert_eq!(parse_limit("for=4h", 25, now).unwrap().max_refreshes, 10);
        assert!(parse_limit("rounds=501", 4, now).is_err());
        assert!(parse_limit("for=168h", 4, now).is_err());
        assert!(parse_limit("for=1h rounds=3", 4, now).is_err());
        assert_eq!(parse_limit("for=1h30m", 25, now).unwrap().max_minutes, 90);
        assert_eq!(parse_limit("rounds=3", 55, now).unwrap().max_minutes, 10080);
    }

    #[test]
    fn completed_codex_limits_survive_detach_without_ending_due_compaction() {
        for (minutes, refreshes, output, compact, completed, reason) in [
            (60, 1, 256, false, 2000, "refresh-limit"),
            (60, 2, 128, false, 2000, "output-budget"),
            (1, 2, 256, false, 61001, "duration-limit"),
            (60, 1, 256, true, 2000, "refresh-limit"),
        ] {
            let (t, mut m) = manager_for("codex");
            let settings = WarmSettings::default();
            m.dispatch("observe", binding(1, 1), 1000, false, &settings)
                .unwrap();
            let mut config = enable();
            config["provider"] = json!("codex");
            config["bestEffort"] = json!(true);
            config["maxMinutes"] = json!(minutes);
            config["maxRefreshes"] = json!(refreshes);
            config["maxOutputTokens"] = json!(output);
            config["compact"] = json!(compact);
            m.dispatch("configure", config, 1000, false, &settings)
                .unwrap();
            let claim = m
                .dispatch("claim", binding(1, 2), 1000, false, &settings)
                .unwrap();
            let mut input = binding(1, 2);
            input["attemptId"] = claim["attempt"]["id"].clone();
            m.dispatch("check", input.clone(), 1001, false, &settings)
                .unwrap();
            input["outcome"] = json!("submitted");
            m.dispatch("receipt", input.clone(), 1002, false, &settings)
                .unwrap();
            let mut sample = binding(2, 2);
            sample["phase"] = json!("busy");
            sample["attemptId"] = input["attemptId"].clone();
            sample["sample"] = json!({"id":"prime-response","startedAt":1001,"completedAt":completed,"model":"synthetic-model","effort":"medium","ttlMs":1800000,"ttlSource":"configured-window","inputTokens":1000,"cacheReadTokens":0,"cacheWriteTokens":0,"outputTokens":5,"stopReason":"end_turn","attemptId":input["attemptId"]});
            m.dispatch("observe", sample, completed, false, &settings)
                .unwrap();
            let mut idle = binding(2, 3);
            idle["attemptId"] = input["attemptId"].clone();
            let done = m
                .dispatch("observe", idle, completed, false, &settings)
                .unwrap();
            assert_eq!(done["policy"]["reason"], reason);
            assert_eq!(done["policy"]["enabled"], compact);
            if compact {
                assert!(done["compactAt"].is_u64());
                continue;
            }
            let mut ended = binding(2, 4);
            ended["phase"] = json!("ended");
            let detached = m
                .dispatch("observe", ended, completed, false, &settings)
                .unwrap();
            assert_eq!(detached["policy"]["reason"], reason);
            assert_eq!(detached["policy"]["bound"], false);
            assert_eq!(m.state.attempts[0].state, AttemptState::Verified);
            assert_eq!(m.state.attempts[0].cache_verified, Some(false));
            drop(m);
            let mut restored =
                CacheWarmManager::open(std::fs::canonicalize(t.path()).unwrap(), "codex").unwrap();
            let saved = restored
                .dispatch("list", json!({}), completed + 1, false, &settings)
                .unwrap();
            assert_eq!(saved["policies"][0]["enabled"], false);
            assert_eq!(saved["policies"][0]["reason"], reason);
            assert_eq!(saved["attempts"][0]["state"], "verified");
        }
    }

    #[test]
    fn prime_usage_and_one_compaction_match_existing_engine() {
        let (_t, mut rust) = manager();
        let settings = WarmSettings::default();
        let mut configuration = enable();
        configuration["maxRefreshes"] = json!(1);
        configuration["maxReadTokens"] = Value::Null;
        rust.dispatch("observe", binding(1, 1), 1000, false, &settings)
            .unwrap();
        rust.dispatch("configure", configuration, 1000, false, &settings)
            .unwrap();
        let first = rust
            .dispatch("claim", binding(1, 2), 1000, false, &settings)
            .unwrap();
        let mut input = binding(1, 2);
        input["attemptId"] = first["attempt"]["id"].clone();
        rust.dispatch("check", input.clone(), 1001, false, &settings)
            .unwrap();
        input["outcome"] = json!("submitted");
        rust.dispatch("receipt", input.clone(), 1002, false, &settings)
            .unwrap();
        let mut observation = binding(2, 2);
        observation["attemptId"] = input["attemptId"].clone();
        observation["sample"] = json!({"id":"prime-response","startedAt":1001,"completedAt":2000,"model":"sonnet","effort":"medium","ttlMs":3600000,"ttlSource":"native-setting","inputTokens":1000,"cacheReadTokens":0,"cacheWriteTokens":1000,"outputTokens":1,"stopReason":"end_turn","attemptId":input["attemptId"]});
        rust.dispatch("observe", observation, 2000, false, &settings)
            .unwrap();
        let mut compact = binding(2, 3);
        compact["kind"] = json!("compact");
        let claim = rust
            .dispatch("claim", compact.clone(), 3301001, false, &settings)
            .unwrap();
        assert_eq!(claim["claimed"], true);
        compact["attemptId"] = claim["attempt"]["id"].clone();
        rust.dispatch("check", compact.clone(), 3301002, false, &settings)
            .unwrap();
        compact["outcome"] = json!("compacted");
        rust.dispatch("receipt", compact, 3301003, false, &settings)
            .unwrap();
        let mut actual = rust
            .dispatch("list", json!({}), 3301003, false, &settings)
            .unwrap();
        let native = tempfile::tempdir().unwrap();
        std::fs::set_permissions(native.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let native_root = std::fs::canonicalize(native.path()).unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/cache-warm.mjs")
            .canonicalize()
            .unwrap();
        let script = r#"
          const {CacheWarmManager}=await import(process.argv[1]);let now=1000;
          const m=new CacheWarmManager({root:process.argv[2],now:()=>now});await m.initialize();
          const b=(epoch,sequence)=>({sessionId:'session-a',cwd:'/tmp/project',instanceId:'warm-100-uuid',epoch,sequence,phase:'idle'});
          await m.observe(b(1,1));await m.configure({provider:'claude',sessionId:'session-a',cwd:'/tmp/project',enabled:true,requestId:'request-a',maxRefreshes:1,maxMinutes:60,maxReadTokens:null});
          const first=await m.claim(b(1,2));const input={...b(1,2),attemptId:first.attempt.id};now=1001;await m.check(input);now=1002;await m.receipt({...input,outcome:'submitted'});
          now=2000;await m.observe({...b(2,2),attemptId:input.attemptId,sample:{id:'prime-response',startedAt:1001,completedAt:2000,model:'sonnet',effort:'medium',ttlMs:3600000,ttlSource:'native-setting',inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:1000,outputTokens:1,stopReason:'end_turn',attemptId:input.attemptId}});
          now=3301001;const claim=await m.claim({...b(2,3),kind:'compact'});const compact={...b(2,3),attemptId:claim.attempt.id};now=3301002;await m.check(compact);now=3301003;await m.receipt({...compact,outcome:'compacted'});console.log(JSON.stringify(await m.list()));
        "#;
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .arg(source)
            .arg(native_root)
            .output()
            .expect("Node is required only for migration differential tests.");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        fn normalize(v: &mut Value) {
            let ids: Vec<_> = v["attempts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["id"].as_str().unwrap().to_string())
                .collect();
            fn walk(v: &mut Value, ids: &[String]) {
                match v {
                    Value::String(s) => {
                        if let Some(i) = ids.iter().position(|id| id == s) {
                            *s = format!("attempt-{i}")
                        }
                    }
                    Value::Object(o) => {
                        for v in o.values_mut() {
                            walk(v, ids)
                        }
                    }
                    Value::Array(a) => {
                        for v in a {
                            walk(v, ids)
                        }
                    }
                    _ => {}
                }
            }
            walk(v, &ids)
        }
        normalize(&mut actual);
        normalize(&mut expected);
        assert_eq!(actual, expected);
    }
}
