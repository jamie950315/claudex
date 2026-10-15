//! Selection over one exact reachable graph, plus complete source preparation.
use crate::{
    frontend_anchors,
    frontend_ast::*,
    frontend_folders,
    frontend_graph::{Graph, resolve_import},
    frontend_owner, frontend_runtime,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Adapter {
    Folders,
    ChatWake,
    OwnerWake,
    Commands,
}
impl Adapter {
    pub const ALL: [Self; 4] = [
        Self::Folders,
        Self::ChatWake,
        Self::OwnerWake,
        Self::Commands,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Folders => "folders",
            Self::ChatWake => "chatWake",
            Self::OwnerWake => "ownerWake",
            Self::Commands => "commands",
        }
    }
    pub fn directory(self) -> &'static str {
        match self {
            Self::Folders => "ui-folders",
            Self::ChatWake => "ui-chat-wake",
            Self::OwnerWake => "ui-owner-wake",
            Self::Commands => "ui-commands",
        }
    }
}
#[derive(Clone, Debug)]
pub enum Bindings {
    Folders(frontend_folders::Anchor),
    Chat(frontend_anchors::ChatAnchor),
    Owner(frontend_owner::Anchor),
    Commands(frontend_anchors::CommandAnchor),
}
#[derive(Clone, Debug)]
pub struct ConsumerTarget {
    pub url: String,
    pub bindings: frontend_folders::Consumer,
}
#[derive(Clone, Debug)]
pub struct Target {
    pub url: String,
    pub bindings: Bindings,
    pub consumer: Option<ConsumerTarget>,
}
#[derive(Clone, Debug)]
pub enum Selection {
    Matched(Target),
    Skipped { reason: String },
}
impl Selection {
    pub fn target(&self) -> Option<&Target> {
        if let Self::Matched(target) = self {
            Some(target)
        } else {
            None
        }
    }
}
#[derive(Clone, Debug)]
pub struct Selections {
    pub adapters: BTreeMap<Adapter, Selection>,
    pub shared_folder_chat: bool,
}
#[derive(Clone, Debug)]
pub struct PreparedSource {
    pub url: String,
    pub source: String,
}
fn probe(graph: &Graph, url: &str, adapter: Adapter) -> Result<Bindings> {
    let module = graph
        .modules
        .get(url)
        .context("Frontend target is unavailable.")?;
    Ok(match adapter {
        Adapter::Folders => {
            Bindings::Folders(frontend_folders::anchors(&module.source, url, graph)?)
        }
        Adapter::ChatWake => Bindings::Chat(frontend_anchors::chat(&module.source, url, graph)?),
        Adapter::OwnerWake => Bindings::Owner(frontend_owner::anchors(&module.source, url, graph)?),
        Adapter::Commands => {
            Bindings::Commands(frontend_anchors::commands(&module.source, url, graph)?)
        }
    })
}
fn plausible(source: &str, adapter: Adapter) -> bool {
    match adapter {
        Adapter::Folders => [
            "disambiguationText",
            "hasActiveSessions",
            "repoInfo",
            "environmentId",
        ]
        .iter()
        .all(|marker| source.contains(marker)),
        Adapter::ChatWake => [
            "forkSession",
            "amber_tributary_lantern_overview_toggle",
            "reopenClosed",
        ]
        .iter()
        .all(|marker| source.contains(marker)),
        Adapter::OwnerWake => ["submitMessage", "getComposerSnapshot", "initialSessionId"]
            .iter()
            .all(|marker| source.contains(marker)),
        Adapter::Commands => [
            "empty slash-command list (cold CLI bridge)",
            "trustedSelectedFolder",
            "getSupportedCommands",
        ]
        .iter()
        .all(|marker| source.contains(marker)),
    }
}
fn select(graph: &Graph, adapter: Adapter) -> Result<Target> {
    let eager = graph.eager_urls();
    let pool = graph
        .modules
        .values()
        .filter(|module| adapter != Adapter::ChatWake || eager.contains(&module.url))
        .collect::<Vec<_>>();
    let marked = pool
        .iter()
        .copied()
        .filter(|module| plausible(&module.source, adapter))
        .collect::<Vec<_>>();
    let mut candidates =
        if matches!(adapter, Adapter::Folders | Adapter::OwnerWake) && marked.len() > 1 {
            marked
                .iter()
                .copied()
                .filter(|module| probe(graph, &module.url, adapter).is_ok())
                .collect::<Vec<_>>()
        } else {
            marked.clone()
        };
    if adapter == Adapter::ChatWake && marked.is_empty() {
        candidates = pool
            .iter()
            .copied()
            .filter(|module| {
                module.source.contains("forkSession") && probe(graph, &module.url, adapter).is_ok()
            })
            .collect();
        if candidates.len() > 1 {
            candidates.retain(|module|matches!(probe(graph,&module.url,adapter),Ok(Bindings::Chat(anchor))if anchor.fork_action));
        }
    }
    let target = unique(candidates, &format!("{} target module", adapter.name()))?;
    let bindings = probe(graph, &target.url, adapter)?;
    let mut consumer = None;
    if let Bindings::Folders(folder) = &bindings {
        if folder.first().pure {
            let asset = target.url.rsplit('/').next().unwrap();
            let mut consumers = vec![];
            for module in graph
                .modules
                .values()
                .filter(|module| module.source.contains(asset))
            {
                let ast = syntax(&module.source)?;
                for import in array(&ast["body"])
                    .iter()
                    .filter(|n| kind(n) == "ImportDeclaration")
                {
                    let Some(path) = import["source"]["value"].as_str() else {
                        continue;
                    };
                    if resolve_import(&module.url, path).as_deref() != Some(target.url.as_str())
                        || !array(&import["specifiers"]).iter().any(|specifier| {
                            id(&specifier["imported"]) == folder.first().grouping_export.as_deref()
                        })
                    {
                        continue;
                    }
                    consumers.push(ConsumerTarget {
                        url: module.url.clone(),
                        bindings: frontend_folders::consumer(
                            &module.source,
                            &module.url,
                            graph,
                            folder,
                            path,
                        )?,
                    });
                }
            }
            consumer = Some(unique(consumers, "folder grouping consumer module")?);
        }
    }
    Ok(Target {
        url: target.url.clone(),
        bindings,
        consumer,
    })
}
pub fn resolve(graph: &Graph) -> Selections {
    let adapters = Adapter::ALL
        .into_iter()
        .map(|adapter| {
            let selection = match select(graph, adapter) {
                Ok(target) => Selection::Matched(target),
                Err(error) => Selection::Skipped {
                    reason: error.to_string().chars().take(240).collect(),
                },
            };
            (adapter, selection)
        })
        .collect::<BTreeMap<_, _>>();
    let shared_folder_chat = adapters[&Adapter::Folders]
        .target()
        .zip(adapters[&Adapter::ChatWake].target())
        .is_some_and(|(a, b)| a.url == b.url);
    Selections {
        adapters,
        shared_folder_chat,
    }
}
/// The complete helper and consumer are prepared before publication of either.
/// A combined resource adds the independent chat bootstrap only once.
pub fn prepare_sources(
    root: &Path,
    home: &Path,
    graph: &Graph,
    target: &Target,
    adapter: Adapter,
    shared_chat: Option<&Target>,
) -> Result<Vec<PreparedSource>> {
    let module = graph
        .modules
        .get(&target.url)
        .context("Frontend selected target disappeared.")?;
    let registry = home.join("Library/Application Support/Claude/claude-code-sessions");
    let asset = module.url.rsplit('/').next().unwrap();
    let source = match (&target.bindings, adapter) {
        (Bindings::Commands(anchor), Adapter::Commands) => {
            frontend_anchors::transform_commands(&module.source, anchor, asset)?
        }
        (Bindings::Owner(anchor), Adapter::OwnerWake) => frontend_owner::transform(
            &module.source,
            anchor,
            &frontend_runtime::owner(root, anchor, asset)?,
        )?,
        (Bindings::Chat(anchor), Adapter::ChatWake) => {
            let result = module.source.clone()
                + &frontend_runtime::chat(root, &registry, &anchor.native, asset)?;
            syntax(&result)?;
            result
        }
        (Bindings::Folders(anchor), Adapter::Folders) => {
            let mut result = frontend_folders::transform(
                &module.source,
                anchor,
                &frontend_runtime::folder(root, &registry, anchor, asset)?,
            )?;
            if let Some(chat) = shared_chat {
                ensure!(
                    chat.url == target.url,
                    "Shared renderer resource bindings changed."
                );
                let Bindings::Chat(chat) = &chat.bindings else {
                    anyhow::bail!("Shared resource has no chat proof.")
                };
                result += &frontend_runtime::chat(root, &registry, &chat.native, asset)?;
                syntax(&result)?;
            }
            result
        }
        _ => anyhow::bail!("Frontend adapter and structural proof do not match."),
    };
    let mut sources = vec![PreparedSource {
        url: target.url.clone(),
        source,
    }];
    if let Some(consumer) = &target.consumer {
        ensure!(
            adapter == Adapter::Folders,
            "Only a folder helper may have a React consumer."
        );
        let module = graph
            .modules
            .get(&consumer.url)
            .context("Folder consumer disappeared.")?;
        sources.push(PreparedSource {
            url: consumer.url.clone(),
            source: frontend_folders::transform_consumer(&module.source, &consumer.bindings)?,
        });
    }
    Ok(sources)
}
