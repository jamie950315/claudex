//! Test-only JSON-lines bridge to the real policy ledger; no broker or native work.
use anyhow::{Context, Result, ensure};
use claudex_app::warm::{CacheWarmManager, WarmSettings};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    action: String,
    params: Value,
    now: u64,
    compact_after_warm: bool,
}

fn main() -> Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    ensure!(
        args.len() == 1,
        "Usage: warm-contract /absolute/private/root"
    );
    let mut manager = CacheWarmManager::open(PathBuf::from(&args[0]), "claude")?;
    let mut output = io::stdout().lock();
    writeln!(output, "{{\"ready\":true}}")?;
    output.flush()?;
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?).context("Invalid contract request.")?;
        let settings = WarmSettings {
            compact_after_warm: request.compact_after_warm,
            ..WarmSettings::default()
        };
        let response = match manager.dispatch(
            &request.action,
            request.params,
            request.now,
            false,
            &settings,
        ) {
            Ok(value) => json!({"id":request.id,"result":value}),
            Err(error) => json!({"id":request.id,"error":format!("{error:#}")}),
        };
        serde_json::to_writer(&mut output, &response)?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}
