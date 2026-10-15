//! Developer-only NDJSON peer for synthetic binding mutation differential tests.
//! It parses fixture sources and never evaluates JavaScript or accesses a cache.
use anyhow::{Context, Result, ensure};
use claudex_app::{
    frontend_bindings::{Module, Modules},
    frontend_owner,
};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn main() -> Result<()> {
    let mut modules = Modules::new();
    let mut url = String::new();
    let mut output = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        ensure!(
            line.len() <= 4 * 1024 * 1024,
            "Synthetic fixture request exceeds its bound."
        );
        let request: Value = serde_json::from_str(&line)?;
        let result = (|| -> Result<Value> {
            match request["operation"].as_str() {
                Some("init") => {
                    url = request["url"]
                        .as_str()
                        .context("Missing fixture URL.")?
                        .into();
                    modules.clear();
                    for (path, source) in request["modules"]
                        .as_object()
                        .context("Missing fixture modules.")?
                    {
                        modules.insert(
                            path.clone(),
                            Module::parse(
                                path,
                                source.as_str().context("Invalid fixture source.")?,
                            )?,
                        );
                    }
                    Ok(json!({"ready":true}))
                }
                Some("transform") => {
                    ensure!(
                        !url.is_empty(),
                        "Initialize the synthetic module graph first."
                    );
                    let source = request["source"]
                        .as_str()
                        .context("Missing fixture source.")?;
                    let bootstrap = request["bootstrap"]
                        .as_str()
                        .context("Missing synthetic bootstrap.")?;
                    let anchor = frontend_owner::anchors(source, &url, &modules)?;
                    Ok(json!({"source":frontend_owner::transform(source,&anchor,bootstrap)?}))
                }
                _ => anyhow::bail!("Unsupported synthetic proof operation."),
            }
        })();
        let response = match result {
            Ok(value) => value,
            Err(error) => json!({"refused":error.to_string()}),
        };
        writeln!(output, "{}", serde_json::to_string(&response)?)?;
        output.flush()?;
    }
    Ok(())
}
