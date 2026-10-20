//! Read-only differential audit input/output. Private native bytes stay in the
//! caller's pipe; this executable does not discover, write or enroll histories.
use claudex_sync::{codecs, history::Common, owned_history};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
fn main() -> anyhow::Result<()> {
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let result = (|| -> anyhow::Result<Value> {
            let input: Value = serde_json::from_str(&line?)?;
            let text = input["text"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing native text."))?;
            let completed = input["completed"] == true;
            let mut incomplete = None;
            let common: Common = match input["side"].as_str() {
                Some("claude") if completed => {
                    let decoded = owned_history::completed_claude_with_policy(
                        text,
                        std::path::Path::new("/"),
                        "",
                        input["id"].as_str().unwrap_or(""),
                        None,
                        claudex_core::version::VersionPolicy::Warn,
                    )?;
                    incomplete = Some(decoded.incomplete_tail);
                    decoded.common
                }
                Some("claude") => codecs::decode_claude(text, true, false)?,
                Some("codex") => codecs::decode_codex(text)?,
                _ => anyhow::bail!("Unknown native side."),
            };
            let common = common.portable();
            let mut output = json!({"ok":true,"count":common.messages.len(),"fingerprint":common.fingerprint()?,"messages":common.messages.iter().map(|m|json!({"role":m.role,"content":m.content})).collect::<Vec<_>>()});
            if let Some(incomplete) = incomplete {
                output["incompleteTail"] = json!(incomplete);
            }
            Ok(output)
        })();
        let output = match result {
            Ok(v) => v,
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
        writeln!(stdout, "{}", serde_json::to_string(&output)?)?;
        stdout.flush()?;
    }
    Ok(())
}
