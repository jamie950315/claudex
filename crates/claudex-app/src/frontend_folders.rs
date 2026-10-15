//! Native folder grouping/key and React consumer proofs.
use crate::{
    frontend_anchors::{function_bindings, has_member},
    frontend_ast::*,
    frontend_bindings::{Imported, ModuleGraph, Resolver},
    frontend_scope::{self, Scopes},
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::collections::BTreeSet;
#[derive(Clone, Debug)]
pub struct Variant {
    pub key: Value,
    pub grouping: Value,
    pub label: Value,
    pub rows: String,
    pub row: String,
    pub pure: bool,
    pub grouping_export: Option<String>,
    pub key_export: Option<String>,
    pub plain_memo: Option<Value>,
    pub memo: Option<Value>,
    pub cache: Option<String>,
    pub size: usize,
    pub condition: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct Anchor {
    pub variants: Vec<Variant>,
    pub grouping_binding: String,
    pub native: String,
    pub subscribe: Option<String>,
}
impl Anchor {
    pub fn first(&self) -> &Variant {
        &self.variants[0]
    }
}
fn functions(ast: &Value) -> Vec<&Value> {
    array(&ast["body"])
        .iter()
        .filter(|n| kind(n) == "FunctionDeclaration")
        .collect()
}
fn exported_name(ast: &Value, local: &str) -> Result<String> {
    unique(
        nodes(ast, |n| {
            kind(n) == "ExportSpecifier" && id(&n["local"]) == Some(local)
        })
        .into_iter()
        .filter_map(|n| id(&n["exported"]).map(str::to_owned))
        .collect(),
        "exported binding",
    )
}
fn legacy_key(key: &Value, ast: &Value) -> bool {
    let parameters = array(&key["params"]);
    if parameters.len() != 1 || id(&parameters[0]).is_none() || !has_member(key, "cwd") {
        return false;
    }
    let parameter = id(&parameters[0]);
    let scopes = Scopes::analyze(key);
    nodes(key, |n| {
        kind(n) == "CallExpression"
            && id(&n["callee"]).is_some()
            && array(&n["arguments"]).len() == 1
            && id(&n["arguments"][0]) == parameter
    })
    .into_iter()
    .any(|call| {
        if !scopes.is_free(&call["callee"]) {
            return false;
        }
        let helpers = functions(ast)
            .into_iter()
            .filter(|f| id(&f["id"]) == id(&call["callee"]))
            .collect::<Vec<_>>();
        if helpers.len() != 1 {
            return false;
        }
        let helper = helpers[0];
        let parameters = array(&helper["params"]);
        if helper["async"] == true
            || helper["generator"] == true
            || parameters.len() != 1
            || id(&parameters[0]).is_none()
        {
            return false;
        }
        let reference = id(&parameters[0]);
        let body = array(&helper["body"]["body"]);
        if body.len() != 1 || kind(&body[0]) != "ReturnStatement" {
            return false;
        }
        let value = &body[0]["argument"];
        let test = |node: &Value, literal: &str| {
            kind(node) == "BinaryExpression"
                && node["operator"] == "==="
                && (member(&node["left"], "type")
                    && id(&node["left"]["object"]) == reference
                    && node["right"]["value"] == literal
                    || member(&node["right"], "type")
                        && id(&node["right"]["object"]) == reference
                        && node["left"]["value"] == literal)
        };
        kind(value) == "LogicalExpression"
            && value["operator"] == "||"
            && (test(&value["left"], "local") && test(&value["right"], "cli")
                || test(&value["left"], "cli") && test(&value["right"], "local"))
    })
}
pub fn anchors(source: &str, url: &str, graph: &dyn ModuleGraph) -> Result<Anchor> {
    let resolver = Resolver::new(source, url, graph)?;
    let ast = &resolver.ast;
    let plausible = |f: &Value| {
        has_member(f, "latestTimestamp")
            && has_member(f, "sessionStatus")
            && !nodes(f, |n| property(n, "hasActiveSessions")).is_empty()
            && !nodes(f, |n| property(n, "disambiguationText")).is_empty()
    };
    let binding = unique(
        function_bindings(ast, false, None)
            .into_iter()
            .filter(|b| b.variants.iter().any(plausible))
            .collect(),
        "sidebar grouping binding",
    )?;
    ensure!(
        binding.variants.iter().all(plausible),
        "Claude frontend anchors: sidebar grouping branches missing or ambiguous."
    );
    let mut variants = vec![];
    for grouping in &binding.variants {
        let label = unique(
            nodes(grouping, |n| {
                property(n, "name")
                    && kind(&n["value"]) == "LogicalExpression"
                    && n["value"]["operator"] == "??"
                    && member(&n["value"]["left"], "name")
            }),
            "sidebar label",
        )?;
        let rows = id(&grouping["params"][0]).ok_or_else(|| {
            anyhow::anyhow!("Claude frontend anchors: sidebar rows missing or ambiguous.")
        })?;
        let row_loop = unique(
            nodes(grouping, |n| {
                kind(n) == "ForOfStatement" && id(&n["right"]) == Some(rows)
            }),
            "sidebar row loop",
        )?;
        let row = id(&row_loop["left"]["declarations"][0]["id"]).ok_or_else(|| {
            anyhow::anyhow!("Claude frontend anchors: sidebar row binding missing or ambiguous.")
        })?;
        let key_call = unique(
            nodes(&row_loop["body"], |n| {
                kind(n) == "VariableDeclarator"
                    && kind(&n["init"]) == "CallExpression"
                    && id(&n["init"]["callee"]).is_some()
                    && array(&n["init"]["arguments"]).len() == 1
                    && id(&n["init"]["arguments"][0]) == Some(row)
                    && id(&n["id"]) == id(&label["value"]["right"])
            }),
            "sidebar project key call",
        )?;
        let key = unique(
            functions(ast)
                .into_iter()
                .filter(|function| {
                    id(&function["id"]) == id(&key_call["init"]["callee"])
                        && has_member(function, "repoInfo")
                        && (has_member(function, "isScratchWorkspace") || legacy_key(function, ast))
                        && has_member(function, "environmentId")
                        && !nodes(function, |n| kind(n) == "Literal" && n["value"] == "bridge")
                            .is_empty()
                })
                .collect(),
            "native project key",
        )?;
        let mut variant = Variant {
            key: key.clone(),
            grouping: grouping.clone(),
            label: label.clone(),
            rows: rows.into(),
            row: row.into(),
            pure: false,
            grouping_export: None,
            key_export: None,
            plain_memo: None,
            memo: None,
            cache: None,
            size: 0,
            condition: None,
        };
        let memos = nodes(&grouping["body"]["body"][0], |n| {
            kind(n) == "VariableDeclarator"
                && kind(&n["init"]) == "CallExpression"
                && array(&n["init"]["arguments"]).len() == 1
                && n["init"]["arguments"][0]["value"].as_u64().is_some()
        });
        if memos.is_empty() {
            let plain = nodes(grouping, |n| {
                kind(n) == "CallExpression"
                    && id(&n["callee"]).is_some()
                    && array(&n["arguments"]).len() == 2
                    && kind(&n["arguments"][0]) == "ArrowFunctionExpression"
                    && kind(&n["arguments"][0]["body"]) == "BlockStatement"
                    && start(&n["arguments"][0]) < start(row_loop)
                    && end(&n["arguments"][0]) > end(row_loop)
                    && kind(&n["arguments"][1]) == "ArrayExpression"
                    && array(&n["arguments"][1]["elements"])
                        .iter()
                        .any(|element| id(element) == Some(rows))
            });
            if plain.is_empty()
                && binding.variants.len() == 1
                && kind(grouping) == "FunctionDeclaration"
                && array(&grouping["body"]["body"])
                    .iter()
                    .any(|n| frontend_scope::key(n) == frontend_scope::key(row_loop))
                && array(&grouping["params"]).len() == 4
                && array(&grouping["params"])[2..]
                    .iter()
                    .all(|n| kind(n) == "AssignmentPattern")
                && kind(
                    array(&grouping["body"]["body"])
                        .last()
                        .unwrap_or(&Value::Null),
                ) == "ReturnStatement"
            {
                ensure!(
                    nodes(&key["body"], |n| kind(n) == "CallExpression"
                        && id(&n["callee"]) == id(&key["id"]))
                    .is_empty(),
                    "Claude frontend anchors: recursive project key missing or ambiguous."
                );
                variant.pure = true;
                variant.grouping_export = Some(exported_name(ast, &binding.name)?);
                variant.key_export = Some(exported_name(ast, id(&key["id"]).unwrap())?);
            } else {
                let memo = unique(plain, "sidebar uncompiled memo")?;
                ensure!(
                    resolver.imported_api("useMemo", false)?.local
                        == id(&memo["callee"]).unwrap_or(""),
                    "Claude frontend anchors: sidebar useMemo binding missing or ambiguous."
                );
                variant.plain_memo = Some(memo["arguments"][1].clone());
            }
        } else {
            let memo = unique(memos, "sidebar memo cache")?;
            let cache = id(&memo["id"])
                .ok_or_else(|| anyhow::anyhow!("Sidebar memo cache name missing."))?;
            let size = memo["init"]["arguments"][0]["value"].as_u64().unwrap() as usize;
            ensure!(
                (1..=4096).contains(&size),
                "Claude frontend anchors: sidebar memo bound missing or ambiguous."
            );
            let store = unique(
                nodes(grouping, |n| {
                    kind(n) == "AssignmentExpression"
                        && n["operator"] == "="
                        && kind(&n["left"]) == "MemberExpression"
                        && id(&n["left"]["object"]) == Some(cache)
                        && n["left"]["computed"] == true
                        && n["left"]["property"]["value"] == 4
                }),
                "sidebar memo result store",
            )?;
            let condition = unique(
                nodes(grouping, |n| {
                    kind(n) == "IfStatement"
                        && kind(&n["consequent"]) == "BlockStatement"
                        && start(&n["consequent"]) < start(store)
                        && end(&n["consequent"]) > end(store)
                        && (0..4).all(|index| {
                            nodes(&n["test"], |test| {
                                kind(test) == "BinaryExpression"
                                    && test["operator"] == "!=="
                                    && kind(&test["left"]) == "MemberExpression"
                                    && id(&test["left"]["object"]) == Some(cache)
                                    && test["left"]["property"]["value"] == index
                            })
                            .len()
                                == 1
                        })
                }),
                "sidebar memo invalidation",
            )?;
            ensure!(
                nodes(&key["body"], |n| kind(n) == "CallExpression"
                    && id(&n["callee"]) == id(&key["id"]))
                .is_empty(),
                "Claude frontend anchors: recursive project key missing or ambiguous."
            );
            variant.memo = Some(memo.clone());
            variant.cache = Some(cache.into());
            variant.size = size;
            variant.condition = Some(condition.clone());
        }
        variants.push(variant);
    }
    ensure!(
        variants
            .iter()
            .map(|v| frontend_scope::key(&v.key))
            .collect::<std::collections::HashSet<_>>()
            .len()
            == 1,
        "Claude frontend anchors: sidebar shared native key missing or ambiguous."
    );
    let subscribe = if variants[0].pure {
        None
    } else {
        Some(resolver.imported_api("useSyncExternalStore", false)?.local)
    };
    if let Some(name) = &subscribe {
        for variant in &variants {
            ensure!(
                Scopes::analyze(&variant.grouping)
                    .at(&variant.grouping, name)?
                    .is_none(),
                "Claude frontend anchors: sidebar subscription lexical binding missing or ambiguous."
            );
        }
    }
    Ok(Anchor {
        variants,
        grouping_binding: binding.name,
        native: resolver.imported_api("LocalSessions", true)?.local,
        subscribe,
    })
}
pub fn transform(source: &str, anchor: &Anchor, bootstrap: &str) -> Result<String> {
    let first = anchor.first();
    let key = &first.key;
    let name = id(&key["id"]).ok_or_else(|| anyhow::anyhow!("Native key name missing."))?;
    let parameter =
        id(&key["params"][0]).ok_or_else(|| anyhow::anyhow!("Native key argument missing."))?;
    let mut edits = vec![
        Edit::insert(start(key), bootstrap),
        Edit::replace(&key["id"], "__cldxNativeProjectKey"),
        Edit::insert(
            end(key),
            format!(
                "function {name}({parameter}){{return __cldx.lookup({parameter})?.projectKey??__cldxNativeProjectKey({parameter})}}"
            ),
        ),
    ];
    for variant in &anchor.variants {
        let subscription = if variant.pure {
            String::new()
        } else {
            format!(
                "const __cldxVersion={}(__cldx.subscribe,__cldx.getSnapshot,__cldx.getSnapshot);",
                anchor.subscribe.as_deref().unwrap()
            )
        };
        edits.push(Edit::insert(
            start(&variant.grouping["body"]) + 1,
            format!(
                "{subscription}__cldx.setRows({},__cldxNativeProjectKey);",
                variant.rows
            ),
        ));
        if !variant.pure {
            if let Some(memo) = &variant.plain_memo {
                edits.push(Edit::insert(end(memo) - 1, ",__cldxVersion"));
            } else {
                let memo = variant.memo.as_ref().unwrap();
                let condition = variant.condition.as_ref().unwrap();
                edits.push(Edit::replace(
                    &memo["init"]["arguments"][0],
                    (variant.size + 1).to_string(),
                ));
                edits.push(Edit::replace(
                    &condition["test"],
                    format!(
                        "({})||{}[{}]!==__cldxVersion",
                        code(source, &condition["test"])?,
                        variant.cache.as_deref().unwrap(),
                        variant.size
                    ),
                ));
                edits.push(Edit::insert(
                    end(&condition["consequent"]) - 1,
                    format!(
                        ";{}[{}]=__cldxVersion;",
                        variant.cache.as_deref().unwrap(),
                        variant.size
                    ),
                ));
            }
        }
        edits.push(Edit::replace(
            &variant.label["value"],
            format!(
                "__cldx.lookup({})?.label??{}",
                variant.row,
                code(source, &variant.label["value"])?
            ),
        ));
    }
    if first.pure {
        edits.push(Edit::insert(
            source.len(),
            ";export{__cldx as __cldxFolderStore,__cldxNativeProjectKey};",
        ));
    }
    apply_edits(source, edits)
}
#[derive(Clone, Debug)]
pub struct Consumer {
    pub component: Value,
    pub memo: Value,
    pub condition: Value,
    pub guards: Vec<Value>,
    pub prepare_at: usize,
    pub rows: String,
    pub last: Value,
    pub cache: String,
    pub size: usize,
    pub imported_path: String,
    pub subscription: Imported,
}
fn memo_call(node: &Value, cache: &str) -> bool {
    kind(node) == "CallExpression"
        && id(&node["callee"]).is_some()
        && id(&node["arguments"][0]) == Some(cache)
        && node["arguments"][1]["value"].as_i64().is_some()
}
pub fn consumer(
    source: &str,
    url: &str,
    graph: &dyn ModuleGraph,
    helper: &Anchor,
    imported_path: &str,
) -> Result<Consumer> {
    let resolver = Resolver::new(source, url, graph)?;
    let ast = &resolver.ast;
    let import = unique(
        array(&ast["body"])
            .iter()
            .filter(|n| kind(n) == "ImportDeclaration" && n["source"]["value"] == imported_path)
            .collect(),
        "folder helper import",
    )?;
    let grouping = unique(
        array(&import["specifiers"])
            .iter()
            .filter(|n| id(&n["imported"]) == helper.first().grouping_export.as_deref())
            .collect(),
        "folder grouping import",
    )?;
    let key = unique(
        array(&import["specifiers"])
            .iter()
            .filter(|n| id(&n["imported"]) == helper.first().key_export.as_deref())
            .collect(),
        "folder key import",
    )?;
    let call = unique(
        nodes(ast, |n| {
            kind(n) == "CallExpression" && id(&n["callee"]) == id(&grouping["local"])
        }),
        "folder grouping consumer",
    )?;
    let args = array(&call["arguments"]);
    ensure!(
        args.len() == 4 && args.iter().all(|n| id(n).is_some()),
        "Claude frontend anchors: folder grouping arguments missing or ambiguous."
    );
    let component = unique(
        functions(ast)
            .into_iter()
            .filter(|n| start(n) < start(call) && end(n) > end(call))
            .collect(),
        "folder consumer component",
    )?;
    let memo = unique(
        nodes(&component["body"]["body"][0], |n| {
            kind(n) == "VariableDeclarator"
                && kind(&n["init"]) == "CallExpression"
                && array(&n["init"]["arguments"]).len() == 1
                && n["init"]["arguments"][0]["value"].as_u64().is_some()
        }),
        "folder consumer cache",
    )?;
    let cache = id(&memo["id"]).ok_or_else(|| anyhow::anyhow!("Folder consumer cache missing."))?;
    let size = memo["init"]["arguments"][0]["value"].as_u64().unwrap() as usize;
    ensure!(
        (1..=4096).contains(&size),
        "Claude frontend anchors: folder consumer cache bound missing or ambiguous."
    );
    let condition = unique(
        nodes(component, |n| {
            kind(n) == "ConditionalExpression"
                && start(&n["consequent"]) < start(call)
                && end(&n["consequent"]) > end(call)
        }),
        "folder consumer invalidation",
    )?;
    if memo_call(&condition["test"], cache) {
        let compared = array(&condition["test"]["arguments"]);
        let compared = &compared[2..];
        let stored = &condition["consequent"];
        let first = condition["test"]["arguments"][1]["value"].as_i64().unwrap();
        let slot = &condition["alternate"];
        ensure!(
            compared.len() == 4
                && compared.iter().all(|n| id(n).is_some())
                && args
                    .iter()
                    .all(|arg| compared.iter().any(|n| id(n) == id(arg))),
            "Claude frontend anchors: folder consumer dependencies missing or ambiguous."
        );
        let stored_args = array(&stored["arguments"]);
        ensure!(
            memo_call(stored, cache)
                && stored["arguments"][1]["value"] == first
                && stored_args.len() == compared.len() + 3
                && frontend_scope::key(stored_args.last().unwrap()) == frontend_scope::key(call)
                && compared
                    .iter()
                    .enumerate()
                    .all(|(i, n)| id(&stored_args[i + 2]) == id(n))
                && kind(slot) == "MemberExpression"
                && id(&slot["object"]) == Some(cache)
                && slot["computed"] == true
                && slot["property"]["value"] == first + compared.len() as i64,
            "Claude frontend anchors: folder consumer result missing or ambiguous."
        );
        ensure!(
            first >= 0 && first + (compared.len() as i64) < (size as i64),
            "Claude frontend anchors: folder consumer cache writes missing or ambiguous."
        );
    } else {
        let tests = nodes(&condition["test"], |n| {
            kind(n) == "BinaryExpression"
                && n["operator"] == "!=="
                && kind(&n["left"]) == "MemberExpression"
                && id(&n["left"]["object"]) == Some(cache)
                && n["left"]["computed"] == true
                && n["left"]["property"]["value"].as_i64().is_some()
                && id(&n["right"]).is_some()
        });
        ensure!(
            tests.len() == 4
                && nodes(&condition["test"], |n| kind(n) == "CallExpression").is_empty()
                && tests
                    .iter()
                    .map(|n| n["left"]["property"]["value"].as_i64().unwrap())
                    .collect::<BTreeSet<_>>()
                    .len()
                    == 4
                && args
                    .iter()
                    .all(|arg| tests.iter().any(|n| id(&n["right"]) == id(arg))),
            "Claude frontend anchors: folder consumer dependencies missing or ambiguous."
        );
        ensure!(
            kind(&condition["consequent"]) == "SequenceExpression",
            "Claude frontend anchors: folder consumer stores missing or ambiguous."
        );
        let expressions = array(&condition["consequent"]["expressions"]);
        let result = expressions
            .last()
            .ok_or_else(|| anyhow::anyhow!("Folder result missing."))?;
        ensure!(
            kind(result) == "AssignmentExpression"
                && result["operator"] == "="
                && kind(&result["left"]) == "MemberExpression"
                && id(&result["left"]["object"]) == Some(cache)
                && result["left"]["computed"] == true
                && result["left"]["property"]["value"].as_i64().is_some()
                && id(&result["right"]).is_some()
                && code(source, &result["left"])?
                    == code(source, &condition["alternate"]["right"])?
                && kind(&condition["alternate"]) == "AssignmentExpression"
                && id(&condition["alternate"]["left"]) == id(&result["right"])
                && kind(&expressions[0]) == "AssignmentExpression"
                && id(&expressions[0]["left"]) == id(&result["right"])
                && frontend_scope::key(&expressions[0]["right"]) == frontend_scope::key(call),
            "Claude frontend anchors: folder consumer result missing or ambiguous."
        );
        ensure!(
            expressions.len() == 6
                && tests
                    .iter()
                    .all(
                        |test| expressions[1..expressions.len() - 1].iter().any(|n| kind(n)
                            == "AssignmentExpression"
                            && n["operator"] == "="
                            && code(source, &n["left"]).ok() == code(source, &test["left"]).ok()
                            && id(&n["right"]) == id(&test["right"]))
                    )
                && tests
                    .iter()
                    .map(|n| n["left"]["property"]["value"].as_i64().unwrap())
                    .chain(result["left"]["property"]["value"].as_i64())
                    .all(|index| index >= 0 && index < (size as i64)),
            "Claude frontend anchors: folder consumer cache writes missing or ambiguous."
        );
    }
    let key_calls = nodes(component, |n| {
        kind(n) == "CallExpression" && id(&n["callee"]) == id(&key["local"])
    });
    let mut guards = vec![condition.clone()];
    let mut prepare_at = start(condition);
    let mut rows = id(&args[0]).unwrap().to_string();
    if let Some(first) = key_calls.first() {
        let row_loop = unique(
            nodes(component, |n| {
                kind(n) == "ForOfStatement"
                    && id(&n["right"]).is_some()
                    && start(&n["body"]) < start(first)
                    && end(&n["body"]) > end(first)
            }),
            "folder consumer source rows",
        )?;
        rows = id(&row_loop["right"]).unwrap().into();
        if id(&args[0]) != Some(rows.as_str()) {
            unique(
                nodes(component, |n| {
                    kind(n) == "VariableDeclarator"
                        && id(&n["id"]) == id(&args[0])
                        && kind(&n["init"]) == "ConditionalExpression"
                        && id(&n["init"]["alternate"]) == Some(rows.as_str())
                }),
                "folder consumer grouping rows",
            )?;
        }
        for key_call in key_calls {
            let guard = unique(
                nodes(component, |n| {
                    matches!(kind(n), "IfStatement" | "ConditionalExpression")
                        && start(&n["consequent"]) < start(key_call)
                        && end(&n["consequent"]) > end(key_call)
                        && (memo_call(&n["test"], cache)
                            || !nodes(&n["test"], |x| {
                                kind(x) == "MemberExpression"
                                    && id(&x["object"]) == Some(cache)
                                    && x["computed"] == true
                            })
                            .is_empty())
                }),
                "folder key memo guard",
            )?;
            ensure!(
                !nodes(&guard["consequent"], |n| kind(n) == "AssignmentExpression"
                    && kind(&n["left"]) == "MemberExpression"
                    && id(&n["left"]["object"]) == Some(cache)
                    || memo_call(&guard["test"], cache)
                        && memo_call(n, cache)
                        && n["arguments"][1]["value"]
                            == guard["test"]["arguments"][1]["value"])
                .is_empty(),
                "Claude frontend anchors: folder key memo store missing or ambiguous."
            );
            if !guards
                .iter()
                .any(|n| frontend_scope::key(n) == frontend_scope::key(guard))
            {
                guards.push(guard.clone());
            }
        }
        prepare_at = start(unique(
            array(&component["body"]["body"])
                .iter()
                .filter(|n| start(n) <= start(row_loop) && end(n) >= end(row_loop))
                .collect(),
            "folder rows preparation",
        )?);
    }
    let last = array(&component["body"]["body"])
        .last()
        .unwrap_or(&Value::Null);
    ensure!(
        kind(last) == "ReturnStatement" && guards.iter().all(|guard| end(guard) <= start(last)),
        "Claude frontend anchors: folder consumer return boundary missing or ambiguous."
    );
    Ok(Consumer {
        component: component.clone(),
        memo: memo.clone(),
        condition: condition.clone(),
        guards,
        prepare_at,
        rows,
        last: last.clone(),
        cache: cache.into(),
        size,
        imported_path: imported_path.into(),
        subscription: resolver.imported_api("useSyncExternalStore", false)?,
    })
}
pub fn transform_consumer(source: &str, anchor: &Consumer) -> Result<String> {
    let mut edits = vec![
        Edit::insert(
            0,
            format!(
                "import{{__cldxFolderStore,__cldxNativeProjectKey}}from{};import{{{} as __cldxFolderSubscribe}}from{};",
                serde_json::to_string(&anchor.imported_path)?,
                anchor.subscription.exported,
                serde_json::to_string(&anchor.subscription.path)?
            ),
        ),
        Edit::insert(
            start(&anchor.component["body"]) + 1,
            "const __cldxVersion=__cldxFolderSubscribe(__cldxFolderStore.subscribe,__cldxFolderStore.getSnapshot,__cldxFolderStore.getSnapshot);",
        ),
        Edit::replace(
            &anchor.memo["init"]["arguments"][0],
            (anchor.size + 1).to_string(),
        ),
        Edit::insert(
            anchor.prepare_at,
            format!(
                "__cldxFolderStore.setRows({},__cldxNativeProjectKey);",
                anchor.rows
            ),
        ),
        Edit::insert(
            start(&anchor.last),
            format!("{}[{}]=__cldxVersion;", anchor.cache, anchor.size),
        ),
    ];
    for guard in &anchor.guards {
        edits.push(Edit::replace(
            &guard["test"],
            format!(
                "({})||{}[{}]!==__cldxVersion",
                code(source, &guard["test"])?,
                anchor.cache,
                anchor.size
            ),
        ));
    }
    apply_edits(source, edits)
}
