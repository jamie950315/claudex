use anyhow::{Context, Result};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Claudex: {error:#}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args = std::env::args_os()
        .skip(1)
        .map(|a| {
            a.into_string()
                .map_err(|_| anyhow::anyhow!("Command arguments must be valid UTF-8."))
        })
        .collect::<Result<Vec<_>>>()
        .context("Could not read command arguments")?;
    claudex_cli::commands::run(&args).await
}
