//! Read-only differential audit input/output. Private native bytes stay in the
//! caller's pipe; this executable does not discover, write or enroll histories.
use claudex_sync::{codecs, history::Common};
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
            let (common, legacy): (Common, Option<Common>) = match input["side"].as_str() {
                Some("claude") => (
                    codecs::decode_claude(text, true, false)?,
                    Some(codecs::decode_claude_with(
                        text,
                        true,
                        false,
                        None,
                        codecs::ClaudeMetadata::Legacy,
                    )?),
                ),
                Some("codex") => (codecs::decode_codex(text)?, None),
                _ => anyhow::bail!("Unknown native side."),
            };
            let common = common.portable();
            // The earlier reading kept unlisted session metadata as inert messages.
            let legacy_count = legacy.map(|l| l.portable().messages.len());
            Ok(
                json!({"ok":true,"count":common.messages.len(),"legacyCount":legacy_count,"fingerprint":common.fingerprint()?,"messages":common.messages.iter().map(|m|json!({"role":m.role,"content":m.content})).collect::<Vec<_>>()}),
            )
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
