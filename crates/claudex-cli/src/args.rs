use anyhow::{Result, bail};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

#[derive(Debug, Default)]
pub struct Args {
    pub positionals: Vec<String>,
    pub values: BTreeMap<String, Vec<String>>,
    pub flags: BTreeSet<String>,
}
impl Args {
    pub fn parse(args: &[String], value_options: &[&str], flags: &[&str]) -> Result<Self> {
        let mut out = Self::default();
        let mut input = args.iter();
        let mut positional = false;
        while let Some(arg) = input.next() {
            if positional {
                out.positionals.push(arg.clone());
                continue;
            }
            if arg == "--" {
                positional = true;
                continue;
            }
            if arg == "-h" {
                out.flags.insert("help".into());
                continue;
            }
            if let Some(option) = arg.strip_prefix("--") {
                let (key, inline) = option
                    .split_once('=')
                    .map(|(k, v)| (k, Some(v)))
                    .unwrap_or((option, None));
                if flags.contains(&key) && inline.is_none() {
                    out.flags.insert(key.into());
                } else if value_options.contains(&key) {
                    let value = inline
                        .map(str::to_owned)
                        .or_else(|| input.next().cloned())
                        .ok_or_else(|| anyhow::anyhow!("Option --{key} requires a value."))?;
                    if value.contains('\0') {
                        bail!("Option --{key} contains a NUL byte.");
                    }
                    out.values.entry(key.into()).or_default().push(value);
                } else {
                    bail!("Unknown option: --{key}");
                }
            } else if arg.starts_with('-') {
                bail!("Unknown option: {arg}");
            } else {
                out.positionals.push(arg.clone());
            }
        }
        Ok(out)
    }
    pub fn value(&self, key: &str) -> Option<&str> {
        self.values
            .get(key)
            .and_then(|v| v.last())
            .map(String::as_str)
    }
    pub fn flag(&self, key: &str) -> bool {
        self.flags.contains(key)
    }
    pub fn root(&self) -> Result<PathBuf> {
        let raw = self
            .value("root")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("CLAUDEX_HOME").map(PathBuf::from))
            .unwrap_or(home()?.join(".local/share/claudex"));
        absolute(&raw)
    }
}
pub fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("The current user's home directory is unavailable."))
}
pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn option_parsing_keeps_repeated_projects_and_literal_values() -> Result<()> {
        let args = [
            "init",
            "--root=/tmp/private root",
            "--project",
            "/tmp/a",
            "--project",
            "/tmp/b",
            "--all-projects",
        ]
        .map(str::to_owned);
        let args = Args::parse(&args, &["root", "project"], &["all-projects"])?;
        assert_eq!(args.value("root"), Some("/tmp/private root"));
        assert_eq!(args.values["project"], vec!["/tmp/a", "/tmp/b"]);
        assert!(args.flag("all-projects"));
        assert!(Args::parse(&["--unknown".into()], &[], &[]).is_err());
        Ok(())
    }
}
