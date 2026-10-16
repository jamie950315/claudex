use anyhow::{Result, bail};
use async_trait::async_trait;
use claudex_app::{
    mod_bridge::Rpc,
    warm_hook::{self, CommandVerifier},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const SESSION: &str = "10000000-0000-4000-8000-000000000001";
const CONFIRMATION: &str = "10000000-0000-4000-8000-000000000002";
fn input(prompt: &str) -> Value {
    json!({"hook_event_name":"UserPromptSubmit","prompt":prompt,
    "session_id":SESSION,"turn_id":"native-turn","cwd":"/private/project","transcript_path":"/private/native.jsonl"})
}
struct Verify {
    calls: AtomicUsize,
    fail_at: usize,
}
#[async_trait]
impl CommandVerifier for Verify {
    async fn verify(&self, context: &Value) -> Result<()> {
        assert_eq!(context["sessionId"], SESSION);
        assert_eq!(context["turnId"], "native-turn");
        assert_eq!(context["transcriptPath"], "/private/native.jsonl");
        if self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_at {
            bail!("Primary native turn changed.")
        }
        Ok(())
    }
}
#[derive(Default)]
struct Broker {
    calls: Mutex<Vec<(String, Value)>>,
    uncertain: bool,
    root: Option<PathBuf>,
    unavailable: bool,
}
#[async_trait]
impl Rpc for Broker {
    async fn call(
        &self,
        root: &Path,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value> {
        if let Some(expected) = &self.root {
            assert_eq!(
                root, expected,
                "RPC must use the collaboration root, not the synchronization root"
            );
        }
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        if self.unavailable {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound).into());
        }
        Ok(match method {
            "cache_warm_settings" => json!({"defaultLimit":"for=3h"}),
            "codex_cache_warm_prepare" => {
                json!({"sessionId":params["sessionId"],"cwd":params["cwd"],"confirmationId":CONFIRMATION})
            }
            "codex_cache_warm_confirm" => {
                if self.uncertain {
                    bail!("Native reply was lost.");
                }
                json!({"policy":{"provider":"codex","sessionId":SESSION,"cwd":"/private/project","enabled":true,"refreshMinutes":25}})
            }
            "codex_cache_warm_list" => json!({"policies":[]}),
            "codex_cache_warm_off" => {
                json!({"policy":{"provider":"codex","sessionId":SESSION,"cwd":"/private/project","enabled":false,"reason":"disabled"}})
            }
            other => panic!("Unexpected broker method {other}"),
        })
    }
}
#[tokio::test]
async fn on_uses_saved_limit_and_a_fresh_primary_context_before_one_confirmation() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    let broker = Broker {
        root: Some(root.join("collaboration")),
        ..Default::default()
    };
    let verify = Verify {
        calls: AtomicUsize::new(0),
        fail_at: usize::MAX,
    };
    let result = warm_hook::handle(
        &input("/claudex:warm on compact=off"),
        &root,
        false,
        &broker,
        &verify,
        "zh-Hant",
    )
    .await
    .unwrap();
    assert_eq!(result["decision"], "block");
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .starts_with("快取保溫: 已啟用")
    );
    assert_eq!(verify.calls.load(Ordering::SeqCst), 2);
    let calls = broker.calls.lock().unwrap();
    assert_eq!(
        calls.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        vec![
            "cache_warm_settings",
            "codex_cache_warm_prepare",
            "codex_cache_warm_confirm"
        ]
    );
    assert_eq!(calls[1].1["maxMinutes"], 180);
    assert_eq!(calls[1].1["maxRefreshes"], 8);
    assert_eq!(calls[1].1["compact"], false);
    assert_eq!(
        calls[2].1,
        json!({"sessionId":SESSION,"cwd":"/private/project","bestEffort":true,"confirmationId":CONFIRMATION})
    );
    Ok(())
}
#[tokio::test]
async fn changed_context_and_lost_confirmation_always_block_without_replay() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    for (fail_at, uncertain, confirms) in [(2, false, 0), (usize::MAX, true, 1)] {
        let broker = Broker {
            uncertain,
            root: Some(root.join("collaboration")),
            ..Default::default()
        };
        let verify = Verify {
            calls: AtomicUsize::new(0),
            fail_at,
        };
        let result = warm_hook::handle(
            &input("/claudex:warm on rounds=2"),
            &root,
            false,
            &broker,
            &verify,
            "en",
        )
        .await
        .unwrap();
        assert_eq!(result["decision"], "block");
        assert!(
            result["reason"]
                .as_str()
                .unwrap()
                .contains("Do not repeat an uncertain enable request")
        );
        assert_eq!(
            broker
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "codex_cache_warm_confirm")
                .count(),
            confirms
        );
    }
    Ok(())
}
#[tokio::test]
async fn status_and_off_use_the_nested_broker_without_enabling_or_replaying() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    let broker = Broker {
        root: Some(root.join("collaboration")),
        ..Default::default()
    };
    let verify = Verify {
        calls: AtomicUsize::new(0),
        fail_at: usize::MAX,
    };
    for action in ["status", "off"] {
        let result = warm_hook::handle(
            &input(&format!("/claudex:warm {action}")),
            &root,
            false,
            &broker,
            &verify,
            "en",
        )
        .await
        .unwrap();
        assert_eq!(result["decision"], "block");
        assert!(
            result["reason"]
                .as_str()
                .unwrap()
                .starts_with("Cache warming: Disabled")
        );
    }
    assert_eq!(verify.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        broker
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.as_str())
            .collect::<Vec<_>>(),
        vec!["codex_cache_warm_list", "codex_cache_warm_off"]
    );
    Ok(())
}

#[tokio::test]
async fn failed_stop_and_status_do_not_advise_an_enable_request() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    let broker = Broker::default();
    for (action, instruction) in [
        (
            "off",
            "Use /claudex:warm status to check whether warming is stopped.",
        ),
        ("status", "No change was requested."),
    ] {
        let verify = Verify {
            calls: AtomicUsize::new(0),
            fail_at: 1,
        };
        let result = warm_hook::handle(
            &input(&format!("/claudex:warm {action}")),
            &root,
            false,
            &broker,
            &verify,
            "en",
        )
        .await
        .unwrap();
        let reason = result["reason"].as_str().unwrap();
        assert!(reason.contains("Primary native turn changed."));
        assert!(reason.contains(instruction));
        assert!(!reason.contains("enable request"));
        assert_eq!(result["decision"], "block");
    }
    assert!(broker.calls.lock().unwrap().is_empty());
    Ok(())
}
#[tokio::test]
async fn broker_failures_keep_method_root_and_io_cause_without_retrying() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    for (action, method) in [
        ("off", "codex_cache_warm_off"),
        ("status", "codex_cache_warm_list"),
    ] {
        let broker = Broker {
            root: Some(root.join("collaboration")),
            unavailable: true,
            ..Default::default()
        };
        let verify = Verify {
            calls: AtomicUsize::new(0),
            fail_at: usize::MAX,
        };
        let result = warm_hook::handle(
            &input(&format!("/claudex:warm {action}")),
            &root,
            false,
            &broker,
            &verify,
            "en",
        )
        .await
        .unwrap();
        let reason = result["reason"].as_str().unwrap();
        assert!(reason.contains(method));
        assert!(reason.contains(root.join("collaboration").to_str().unwrap()));
        assert!(reason.contains("entity not found"));
        assert!(!reason.contains("enable request"));
        assert_eq!(broker.calls.lock().unwrap().len(), 1);
        assert_eq!(verify.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}
#[tokio::test]
async fn controller_boundary_and_unrecognized_input_never_reach_native_dispatch() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temporary.path())?;
    let broker = Broker::default();
    let verify = Verify {
        calls: AtomicUsize::new(0),
        fail_at: usize::MAX,
    };
    assert!(
        warm_hook::handle(
            &input("ordinary prompt"),
            &root,
            false,
            &broker,
            &verify,
            "en"
        )
        .await
        .is_none()
    );
    for (value, worker) in [
        (input("/claudex:warm status"), true),
        (
            {
                let mut v = input("/claudex:warm off");
                v["agent_id"] = json!("child");
                v
            },
            false,
        ),
        (input("/claudex:warm on rounds=2 for=1h"), false),
    ] {
        assert_eq!(
            warm_hook::handle(&value, &root, worker, &broker, &verify, "en")
                .await
                .unwrap()["decision"],
            "block"
        );
    }
    assert!(broker.calls.lock().unwrap().is_empty());
    assert_eq!(verify.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn display_keeps_session_scoping_local_suspension_and_native_reason() -> Result<()> {
    let context = json!({"sessionId":SESSION,"cwd":"/private/project"});
    let result = json!({"policy":{"provider":"codex","sessionId":SESSION,"cwd":"/private/project","enabled":true,"reason":"scheduled","refreshMinutes":25,
        "sample":{"cacheReadTokens":1000,"cacheWriteTokens":2000},"totals":{"readTokens":5000,"outputTokens":10},"maxReadTokens":null,"maxOutputTokens":100,
        "cacheResults":{"count":0}},"local":{"sessionId":SESSION,"suspended":true,"reason":"user-message"}});
    let summary = warm_hook::summary(&result, &context, "en");
    assert!(summary.starts_with("Cache warming: Paused · Interval 25 min · TTL managed by Codex"));
    assert!(summary.contains("prefix 3,000 · warm reads: 5,000/Unlimited"));
    assert!(summary.ends_with("Next warm: Stopped by your message"));
    let foreign = json!({"policy":result["policy"],"sessionId":"other","local":result["local"]});
    assert!(warm_hook::summary(&foreign, &context, "en").starts_with("Cache warming: Enabled"));
    let disabled = json!({"policy":{"sessionId":SESSION,"cwd":"/private/project","enabled":false,"reason":"scheduled"}});
    assert!(warm_hook::summary(&disabled, &context, "en").ends_with("Next warm: Stopped"));
    let wrong = json!({"policies":[{"sessionId":"other","cwd":"/private/project","enabled":true}]});
    assert!(warm_hook::summary(&wrong, &context, "en").starts_with("Cache warming: Disabled"));
    Ok(())
}
