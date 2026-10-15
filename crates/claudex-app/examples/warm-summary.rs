//! Developer-only formatter differential peer; no broker, scheduler or native IO.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::io::{Read, Write};
fn main() -> Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    ensure!(
        input.len() <= 1024 * 1024,
        "Formatter fixture input exceeds its bound."
    );
    let requests: Value = serde_json::from_str(&input)?;
    let output = requests
        .as_array()
        .context("Formatter fixtures must be an array.")?
        .iter()
        .map(|request| {
            json!(claudex_app::warm_hook::summary(
                &request["result"],
                &request["context"],
                request["language"].as_str().unwrap_or("en")
            ))
        })
        .collect::<Vec<_>>();
    std::io::stdout().write_all(serde_json::to_string(&output)?.as_bytes())?;
    Ok(())
}
