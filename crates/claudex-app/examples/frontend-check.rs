//! Static copied-cache differential consumer. Never evaluates vendor modules.
use anyhow::{Context, Result, ensure};
use claudex_app::{
    frontend_adapters::{self, Adapter, Selection},
    frontend_graph, platform,
};
use serde_json::json;
use std::collections::BTreeMap;
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let options = platform::Options::parse(&args)?;
    ensure!(
        options.positions.is_empty()
            && options
                .values
                .keys()
                .all(|key| ["root", "home", "output"].contains(&key.as_str())),
        "Usage: frontend-check --root PRIVATE_STATE --home COPIED_HOME --output NEW_DIRECTORY"
    );
    let root = options.required_path("root")?;
    let home = options.required_path("home")?;
    let output = options.required_path("output")?;
    ensure!(
        !claudex_app::status_app::exists(&output)?,
        "Check output must be new."
    );
    platform::create_private(&output)?;
    let graph = frontend_graph::discover(&root, &home)?;
    let selections = frontend_adapters::resolve(&graph);
    let mut adapters = BTreeMap::new();
    for adapter in Adapter::ALL {
        let result = match &selections.adapters[&adapter] {
            Selection::Skipped { reason } => json!({"status":"skipped","reason":reason}),
            Selection::Matched(target) => {
                match frontend_adapters::prepare_sources(
                    &root, &home, &graph, target, adapter, None,
                ) {
                    Err(error) => json!({"status":"failed","reason":error.to_string()}),
                    Ok(sources) => {
                        let mut rows = vec![];
                        for (index, source) in sources.into_iter().enumerate() {
                            let path = output.join(format!("{}-{index}.mjs", adapter.name()));
                            platform::publish(&path, source.source.as_bytes(), 0o600)?;
                            rows.push(json!({"url":source.url,"path":path}));
                        }
                        json!({"status":"matched","url":target.url,"sources":rows})
                    }
                }
            }
        };
        adapters.insert(adapter.name(), result);
    }
    frontend_graph::verify(&graph).context("Copied graph changed during static comparison.")?;
    println!(
        "{}",
        serde_json::to_string(
            &json!({"entry":graph.entry,"missing":graph.missing.len(),"adapters":adapters})
        )?
    );
    Ok(())
}
