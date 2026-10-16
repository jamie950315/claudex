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
    pub modes: Option<ModeConsumer>,
    pub inventory: Option<InventoryContext>,
}
#[derive(Clone, Debug)]
pub struct InventoryContext {
    pub exported: String,
    pub hook: Imported,
}
fn inventory_provider<'a>(
    ast: &'a Value,
    imported_path: &str,
) -> Result<Option<(&'a Value, &'a Value)>> {
    let scopes = Scopes::analyze(ast);
    let declarations = nodes(ast, |n| {
        kind(n) == "VariableDeclarator"
            && kind(&n["id"]) == "ObjectPattern"
            && array(&n["id"]["properties"])
                .iter()
                .any(|p| property(p, "rawCodeSessions"))
            && array(&n["id"]["properties"])
                .iter()
                .any(|p| property(p, "sessionsByKind"))
    });
    if declarations.is_empty() {
        return Ok(None);
    }
    let declaration = unique(declarations, "native Code inventory context source")?;
    let raw = field(&declaration["id"], "rawCodeSessions")
        .ok_or_else(|| anyhow::anyhow!("Native Code inventory source is ambiguous."))?;
    let owner = unique(
        functions(ast)
            .into_iter()
            .filter(|f| start(f) < start(declaration) && end(f) > end(declaration))
            .collect(),
        "native Code inventory provider",
    )?;
    ensure!(
        id(raw).is_some()
            && array(&owner["params"]).len() == 2
            && scopes.same(&declaration["init"], &owner["params"][1])
            && field(&declaration["id"], "codeCanLoadMore").is_some()
            && field(&declaration["id"], "isCodePlaceholderData").is_some()
            && nodes(ast, |n| (kind(n) == "AssignmentExpression"
                && scopes.same(&n["left"], raw))
                || (kind(n) == "UpdateExpression"
                    && scopes.same(&n["argument"], raw)))
            .is_empty(),
        "Claude frontend anchors: raw Code inventory provenance missing or ambiguous."
    );
    let provider = unique(
        nodes(owner, |n| {
            kind(n) == "CallExpression"
                && array(&n["arguments"]).len() >= 2
                && member(&n["arguments"][0], "Provider")
                && kind(&n["arguments"][1]) == "ObjectExpression"
                && field(&n["arguments"][1], "value").is_some_and(|v| scopes.same(v, raw))
        }),
        "native raw Code context provider",
    )?;
    let context = &provider["arguments"][0]["object"];
    let spec = unique(
        array(&ast["body"])
            .iter()
            .filter(|n| kind(n) == "ImportDeclaration" && n["source"]["value"] == imported_path)
            .flat_map(|n| array(&n["specifiers"]).iter())
            .filter(|n| scopes.same(&n["local"], context))
            .collect(),
        "native raw Code context import",
    )?;
    ensure!(
        nodes(ast, |n| member(n, "Provider")
            && scopes.same(&n["object"], context))
        .len()
            == 1,
        "Claude frontend anchors: competing raw Code context providers."
    );
    Ok(Some((context, &spec["imported"])))
}
fn inventory_context(
    resolver: &Resolver<'_>,
    imported_path: &str,
) -> Result<Option<InventoryContext>> {
    let Some((_, exported)) = inventory_provider(&resolver.ast, imported_path)? else {
        return Ok(None);
    };
    let helper_url = crate::frontend_bindings::resolve_url(resolver.url, imported_path)
        .ok_or_else(|| anyhow::anyhow!("Code context module is unavailable."))?;
    let helper_source = resolver
        .modules
        .source(&helper_url)
        .ok_or_else(|| anyhow::anyhow!("Code context source is unavailable."))?;
    let helper = Resolver::new(helper_source, &helper_url, resolver.modules)?;
    let resolved = helper
        .exported(&helper_url, id(exported).unwrap())?
        .ok_or_else(|| anyhow::anyhow!("Code context export is unavailable."))?;
    ensure!(
        resolved.module == helper_url,
        "Code context must be constructed in the proved folder helper."
    );
    let creator = helper.imported_api("createContext", false)?;
    let call = &resolved.node["init"];
    ensure!(
        kind(call) == "CallExpression"
            && id(&call["callee"]) == Some(creator.local.as_str())
            && array(&call["arguments"]).len() == 1
            && kind(&call["arguments"][0]) == "ArrayExpression"
            && array(&call["arguments"][0]["elements"]).is_empty(),
        "Claude frontend anchors: native Code context factory missing or ambiguous."
    );
    let scopes = Scopes::analyze(&helper.ast);
    ensure!(
        nodes(&helper.ast, |n| (kind(n) == "AssignmentExpression"
            && scopes.same(&n["left"], &resolved.node["id"]))
            || (kind(n) == "UpdateExpression"
                && scopes.same(&n["argument"], &resolved.node["id"])))
        .is_empty(),
        "Claude frontend anchors: native Code context has rival writes."
    );
    Ok(Some(InventoryContext {
        exported: id(exported).unwrap().into(),
        hook: resolver.imported_api("useContext", false)?,
    }))
}
#[derive(Clone, Debug)]
pub struct ModeConsumer {
    pub function: Value,
    pub context: String,
    pub projector: String,
}
fn field<'a>(object: &'a Value, name: &str) -> Option<&'a Value> {
    let fields = array(&object["properties"])
        .iter()
        .filter(|node| property(node, name))
        .collect::<Vec<_>>();
    (fields.len() == 1).then(|| &fields[0]["value"])
}
fn native_rows_context(ast: &Value, supplied: &Value, scopes: &Scopes) -> Result<()> {
    let mut current = supplied;
    let mut seen = BTreeSet::new();
    for _ in 0..8 {
        let declaration = unique(
            nodes(ast, |n| {
                kind(n) == "VariableDeclarator" && scopes.same(&n["id"], current)
            }),
            "group-mode context declaration",
        )?;
        ensure!(
            seen.insert(start(declaration)),
            "Group-mode context alias cycle."
        );
        ensure!(
            nodes(ast, |n| kind(n) == "UpdateExpression"
                && scopes.same(&n["argument"], current))
            .is_empty(),
            "Claude frontend anchors: group-mode context has rival writes."
        );
        let writes = nodes(ast, |n| {
            kind(n) == "AssignmentExpression" && scopes.same(&n["left"], current)
        });
        let initializer = &declaration["init"];
        if id(initializer).is_some() {
            ensure!(
                writes.is_empty(),
                "Group-mode context alias has rival writes."
            );
            current = initializer;
            continue;
        }
        let value = if initializer.is_null() {
            let condition = unique(
                nodes(ast, |n| {
                    kind(n) == "ConditionalExpression"
                        && kind(&n["consequent"]) == "SequenceExpression"
                        && scopes.same(&n["alternate"]["left"], current)
                }),
                "group-mode context memo",
            )?;
            let steps = array(&condition["consequent"]["expressions"]);
            let first = steps
                .first()
                .ok_or_else(|| anyhow::anyhow!("Context memo is empty."))?;
            let last = steps.last().unwrap();
            let alternate = &condition["alternate"];
            let slot = &alternate["right"];
            let same_slot = |node: &Value| {
                kind(node) == "MemberExpression"
                    && node["computed"] == true
                    && scopes.same(&node["object"], &slot["object"])
                    && node["property"]["value"] == slot["property"]["value"]
            };
            ensure!(
                writes.len() == 2
                    && steps.len() >= 2
                    && kind(first) == "AssignmentExpression"
                    && first["operator"] == "="
                    && scopes.same(&first["left"], current)
                    && kind(&first["right"]) == "ObjectExpression"
                    && kind(alternate) == "AssignmentExpression"
                    && alternate["operator"] == "="
                    && kind(slot) == "MemberExpression"
                    && slot["computed"] == true
                    && id(&slot["object"]).is_some()
                    && slot["property"]["value"].as_u64().is_some()
                    && kind(last) == "AssignmentExpression"
                    && last["operator"] == "="
                    && same_slot(&last["left"])
                    && scopes.same(&last["right"], current)
                    && nodes(ast, |n| kind(n) == "AssignmentExpression"
                        && same_slot(&n["left"]))
                    .len()
                        == 1
                    && nodes(ast, |n| kind(n) == "UpdateExpression"
                        && same_slot(&n["argument"]))
                    .is_empty(),
                "Claude frontend anchors: group-mode context cache roundtrip missing or ambiguous."
            );
            &first["right"]
        } else {
            ensure!(writes.is_empty(), "Group-mode context has rival writes.");
            initializer
        };
        unique(
            nodes(value, |n| {
                kind(n) == "ObjectExpression"
                    && field(n, "allRows").is_some_and(|v| id(v).is_some())
                    && field(n, "projectSectionRows").is_some_and(|v| id(v).is_some())
                    && field(n, "kind").is_some_and(|v| id(v).is_some())
            }),
            "group-mode native rows context",
        )?;
        return Ok(());
    }
    anyhow::bail!("Group-mode context alias bound exceeded.")
}
fn mode_consumer(ast: &Value, project_component: &Value) -> Result<Option<ModeConsumer>> {
    let candidates = functions(ast)
        .into_iter()
        .filter(|function| {
            let params = array(&function["params"]);
            params.len() == 1
                && kind(&params[0]) == "ObjectPattern"
                && array(&params[0]["properties"])
                    .iter()
                    .any(|n| property(n, "groupBy"))
                && array(&params[0]["properties"])
                    .iter()
                    .any(|n| property(n, "ctx"))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    let function = unique(candidates, "group-mode consumer")?;
    let pattern = &function["params"][0];
    let group = field(pattern, "groupBy")
        .ok_or_else(|| anyhow::anyhow!("Group-mode parameter is ambiguous."))?;
    let context = field(pattern, "ctx")
        .ok_or_else(|| anyhow::anyhow!("Group-mode context parameter is ambiguous."))?;
    let body = array(&function["body"]["body"]);
    ensure!(
        id(group).is_some()
            && id(context).is_some()
            && body.len() == 1
            && kind(&body[0]) == "ReturnStatement",
        "Claude frontend anchors: group-mode routing missing or ambiguous."
    );
    let call = &body[0]["argument"];
    ensure!(
        kind(call) == "CallExpression"
            && id(&call["callee"]).is_some()
            && array(&call["arguments"]).len() == 2
            && id(&call["arguments"][0]) == id(group)
            && id(&call["arguments"][1]) == id(context),
        "Claude frontend anchors: group-mode context missing or ambiguous."
    );
    let scopes = Scopes::analyze(ast);
    let rendering = unique(
        nodes(ast, |n| {
            kind(n) == "CallExpression"
                && array(&n["arguments"]).len() >= 2
                && scopes.same(&n["arguments"][0], &function["id"])
                && kind(&n["arguments"][1]) == "ObjectExpression"
        }),
        "group-mode render",
    )?;
    let supplied = field(&rendering["arguments"][1], "ctx")
        .ok_or_else(|| anyhow::anyhow!("Group-mode context is absent."))?;
    native_rows_context(ast, supplied, &scopes)?;
    let dispatcher = unique(
        functions(ast)
            .into_iter()
            .filter(|f| scopes.same(&f["id"], &call["callee"]))
            .collect(),
        "group-mode dispatcher",
    )?;
    let params = array(&dispatcher["params"]);
    ensure!(
        params.len() == 2 && params.iter().all(|p| id(p).is_some()),
        "Claude frontend anchors: group-mode dispatcher arguments missing or ambiguous."
    );
    let lookup = unique(
        nodes(dispatcher, |n| {
            kind(n) == "MemberExpression"
                && n["computed"] == true
                && scopes.same(&n["property"], &params[0])
        }),
        "group-mode table lookup",
    )?;
    let table = unique(
        nodes(ast, |n| {
            kind(n) == "VariableDeclarator"
                && scopes.same(&n["id"], &lookup["object"])
                && kind(&n["init"]) == "ObjectExpression"
        }),
        "group-mode table",
    )?;
    let project = field(&table["init"], "project").and_then(|n| field(n, "code"));
    ensure!(
        project.is_some_and(|n| id(n).is_some())
            && field(&table["init"], "state")
                .and_then(|n| field(n, "code"))
                .is_some()
            && !nodes(dispatcher, |n| member(n, "kind")
                && scopes.same(&n["object"], &params[1]))
            .is_empty(),
        "Claude frontend anchors: Code group-mode table missing or ambiguous."
    );
    let project = project.unwrap();
    let wrapper = unique(
        functions(ast)
            .into_iter()
            .filter(|f| scopes.same(&f["id"], project))
            .collect(),
        "project mode wrapper",
    )?;
    // Follow only native JSX component references, not arbitrary calls or names.
    let mut frontier = vec![wrapper];
    let mut reached = false;
    let mut seen = BTreeSet::new();
    for _ in 0..8 {
        let mut next = vec![];
        for parent in frontier {
            if !seen.insert(start(parent)) {
                continue;
            }
            for call in nodes(parent, |n| {
                kind(n) == "CallExpression"
                    && array(&n["arguments"]).len() >= 2
                    && id(&n["arguments"][0]).is_some()
                    && scopes.same(&n["callee"], &rendering["callee"])
                    && kind(&n["arguments"][1]) == "ObjectExpression"
            }) {
                let target = &call["arguments"][0];
                if scopes.same(target, &project_component["id"]) {
                    reached = true;
                }
                next.extend(
                    functions(ast)
                        .into_iter()
                        .filter(|f| scopes.same(&f["id"], target)),
                );
            }
        }
        frontier = next;
    }
    ensure!(
        reached,
        "Claude frontend anchors: project mode is disconnected from its proved folder consumer."
    );
    let projectors = functions(ast)
        .into_iter()
        .filter(|f| {
            let params = array(&f["params"]);
            if params.len() != 1
                || id(&params[0]).is_none()
                || f["async"] == true
                || f["generator"] == true
            {
                return false;
            }
            let body = array(&f["body"]["body"]);
            if body.len() != 1 || kind(&body[0]) != "ReturnStatement" {
                return false;
            }
            let call = &body[0]["argument"];
            if kind(call) != "CallExpression"
                || !member(&call["callee"], "flatMap")
                || !scopes.same(&call["callee"]["object"], &params[0])
                || array(&call["arguments"]).len() != 1
            {
                return false;
            }
            let callback = &call["arguments"][0];
            let row = &callback["params"][0];
            let value = &callback["body"];
            let test = &value["test"];
            kind(callback) == "ArrowFunctionExpression"
                && callback["async"] != true
                && array(&callback["params"]).len() == 1
                && kind(value) == "ConditionalExpression"
                && kind(test) == "BinaryExpression"
                && test["operator"] == "==="
                && member(&test["left"], "kind")
                && member(&test["left"]["object"], "source")
                && scopes.same(&test["left"]["object"]["object"], row)
                && test["right"]["value"] == "code"
                && kind(&value["consequent"]) == "ArrayExpression"
                && array(&value["consequent"]["elements"]).len() == 1
                && member(&value["consequent"]["elements"][0], "data")
                && member(&value["consequent"]["elements"][0]["object"], "source")
                && scopes.same(&value["consequent"]["elements"][0]["object"]["object"], row)
                && kind(&value["alternate"]) == "ArrayExpression"
                && array(&value["alternate"]["elements"]).is_empty()
        })
        .collect::<Vec<_>>();
    let projector = unique(projectors, "native Code row projector")?;
    ensure!(
        id(&projector["id"]) != id(group)
            && id(&projector["id"]) != id(context)
            && nodes(ast, |n| id(n)
                .is_some_and(|name| name.starts_with("__cldx")))
            .is_empty()
            && nodes(ast, |n| (kind(n) == "AssignmentExpression"
                && scopes.same(&n["left"], &projector["id"]))
                || (kind(n) == "UpdateExpression"
                    && scopes.same(&n["argument"], &projector["id"])))
            .is_empty(),
        "Claude frontend anchors: group-mode injected bindings are shadowed or rewritten."
    );
    ensure!(
        !nodes(project_component, |n| kind(n) == "CallExpression"
            && scopes.same(&n["callee"], &projector["id"]))
        .is_empty(),
        "Claude frontend anchors: native Code row projector is disconnected."
    );
    Ok(Some(ModeConsumer {
        function: function.clone(),
        context: id(context).unwrap().into(),
        projector: id(&projector["id"]).unwrap().into(),
    }))
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
    let modes = mode_consumer(ast, component)?;
    let inventory = if modes.is_some() {
        inventory_context(&resolver, imported_path)?
    } else {
        None
    };
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
        modes,
        inventory,
    })
}
pub fn transform_consumer(source: &str, anchor: &Consumer) -> Result<String> {
    let inventory_import=anchor.inventory.as_ref().map(|i|format!(
        "import{{{} as __cldxCodeInventory}}from{};import{{{} as __cldxFolderContext}}from{};",
        i.exported,serde_json::to_string(&anchor.imported_path).unwrap(),i.hook.exported,serde_json::to_string(&i.hook.path).unwrap())).unwrap_or_default();
    let mut edits = vec![
        Edit::insert(
            0,
            format!(
                "import{{__cldxFolderStore,__cldxNativeProjectKey}}from{};import{{{} as __cldxFolderSubscribe}}from{};{inventory_import}",
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
    if let Some(modes) = &anchor.modes {
        edits.push(Edit::insert(
            0,
            "const __cldxFolderNoSubscription=()=>()=>{};",
        ));
        let (read, rows) = if anchor.inventory.is_some() {
            (
                "const __cldxCodeRows=__cldxFolderContext(__cldxCodeInventory);".to_string(),
                "__cldxCodeRows".to_string(),
            )
        } else {
            (
                String::new(),
                format!("{}({}.allRows)", modes.projector, modes.context),
            )
        };
        edits.push(Edit::insert(start(&modes.function["body"]) + 1, format!(
            "const __cldxCodeMode={0}.kind===\"code\";{read}__cldxFolderSubscribe(__cldxCodeMode?__cldxFolderStore.subscribeModes:__cldxFolderNoSubscription,__cldxFolderStore.getSnapshot,__cldxFolderStore.getSnapshot);if(__cldxCodeMode)try{{__cldxFolderStore.setModeRows({rows},__cldxNativeProjectKey)}}catch{{}}",
            modes.context
        )));
    }
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

#[cfg(test)]
mod mode_tests {
    use super::*;
    const SOURCE: &str = r#"
function jsx(component, props) { return { component, props }; }
function codeRows(rows) { return rows.flatMap(row => row.source.kind === "code" ? [row.source.data] : []); }
function Folder(sessions) { const rows = codeRows(sessions); return rows; }
function Wrapper(props) { return jsx(Folder, {...props}); }
function Project({projectSectionRows}) { return jsx(Wrapper, {sessions:projectSectionRows}); }
function State(props) { return props; }
const modes = { project:{code:Project}, state:{code:State} };
function dispatch(group, context) { const choices=modes[group], chosen=typeof choices==="function"?choices:choices[context.kind]; return jsx(State,{children:chosen(context)}); }
function List({groupBy:group,ctx:context}) { return dispatch(group,context); }
function Parent(all, kind) { const context={allRows:all,projectSectionRows:all,kind}; return jsx(List,{groupBy:"state",ctx:context}); }
"#;
    fn inspect(source: &str) -> Result<Option<ModeConsumer>> {
        let ast = syntax(source)?;
        let project = functions(&ast)
            .into_iter()
            .find(|f| id(&f["id"]) == Some("Folder"))
            .unwrap();
        mode_consumer(&ast, project)
    }
    fn memo_context() -> String {
        SOURCE.replace("const context={allRows:all,projectSectionRows:all,kind};", "const memo=[];let cached;memo[0]!==all?(cached={allRows:all,projectSectionRows:all,kind},memo[0]=all,memo[1]=cached):cached=memo[1];const context=cached;")
    }
    #[test]
    fn every_code_group_mode_shares_a_proved_native_context_and_row_projector() -> Result<()> {
        let mode = inspect(SOURCE)?.unwrap();
        assert_eq!(id(&mode.function["id"]), Some("List"));
        assert_eq!(mode.context, "context");
        assert_eq!(mode.projector, "codeRows");
        assert!(inspect(&memo_context())?.is_some());
        assert!(inspect("function Folder(rows){return rows;}")?.is_none());
        Ok(())
    }
    #[test]
    fn disconnected_shadowed_or_changed_mode_contracts_cannot_install_a_lifecycle_patch() {
        for source in [
            SOURCE.replace("allRows:all", "otherRows:all"),
            SOURCE.replace("allRows:all", "allRows:all,allRows:other"),
            SOURCE.replace("code:Project", "code:State"),
            SOURCE.replace(
                "row.source.kind === \"code\"",
                "row.source.kind === \"chat\"",
            ),
            SOURCE.replace(
                "const rows = codeRows(sessions)",
                "const codeRows=other; const rows = codeRows(sessions)",
            ),
            SOURCE.replace("jsx(Folder,", "other(Folder,"),
            SOURCE.replace(
                "ctx:context}) { return dispatch(group,context)",
                "ctx:codeRows}) { return dispatch(group,codeRows)",
            ),
            SOURCE.to_owned() + "codeRows = other;",
            SOURCE.to_owned() + "const __cldxFolderStore=other;",
            memo_context().replace("memo[1]=cached", "memo[2]=cached"),
            memo_context().replace(
                "const context=cached;",
                "memo[1]=other;const context=cached;",
            ),
            SOURCE.to_owned() + "function Rival({groupBy:g,ctx:c}) { return dispatch(g,c); }",
        ] {
            assert!(
                inspect(&source).is_err(),
                "Accepted changed native mode contract: {source}"
            );
        }
    }
}

#[cfg(test)]
mod inventory_tests {
    use super::*;
    use crate::frontend_bindings::{ASSET_ROOT, Module, Modules};
    const SOURCE: &str = r#"import{Raw}from'./helper.js';import{U}from'./react.js';
function provider(options,data){const{rawCodeSessions:raw,sessionsByKind,codeCanLoadMore,isCodePlaceholderData}=data;return jsx(Raw.Provider,{value:raw,children:[]});}"#;
    fn inspect(source: &str, helper: &str, react: &str) -> Result<Option<InventoryContext>> {
        let mut modules = Modules::new();
        for (name, source) in [("helper.js", helper), ("react.js", react)] {
            let url = format!("{ASSET_ROOT}{name}");
            modules.insert(url.clone(), Module::parse(url, source)?);
        }
        inventory_context(
            &Resolver::new(source, &format!("{ASSET_ROOT}consumer.js"), &modules)?,
            "./helper.js",
        )
    }
    const HELPER: &str = "import{C}from'./react.js';const Context=C([]);export{Context as Raw};";
    const REACT: &str = "const U=React.useContext,C=React.createContext;const api={useContext:()=>U,createContext:()=>C};export{U,C};";
    #[test]
    fn native_raw_context_keeps_its_public_react_factory_and_read_hook_provenance() -> Result<()> {
        let context = inspect(SOURCE, HELPER, REACT)?.unwrap();
        assert_eq!(context.exported, "Raw");
        assert_eq!(context.hook.exported, "U");
        assert!(inspect("function old(rows){return rows}", HELPER, REACT)?.is_none());
        Ok(())
    }
    #[test]
    fn filtered_values_other_contexts_and_non_native_hooks_are_refused() -> Result<()> {
        for source in [
            SOURCE.replace("value:raw", "value:filtered"),
            SOURCE.replace("}=data", "}=other"),
            SOURCE.replace(
                "rawCodeSessions:raw,",
                "rawCodeSessions:raw,rawCodeSessions:rival,",
            ),
            SOURCE.replace("return jsx", "raw=[];return jsx"),
            SOURCE.replace(
                "function provider(options,data)",
                "function provider(Raw,data)",
            ),
            SOURCE.replace("return jsx", "jsx(Raw.Provider,{value:raw});return jsx"),
        ] {
            assert!(
                inspect(&source, HELPER, REACT).is_err(),
                "Accepted changed raw context: {source}"
            );
        }
        assert!(
            inspect(
                SOURCE,
                &HELPER.replace("Context=C([])", "Context=other([])"),
                REACT
            )
            .is_err()
        );
        assert!(
            inspect(
                SOURCE,
                HELPER,
                &REACT.replace("useContext:()=>U", "useContext:()=>other")
            )
            .is_err()
        );
        assert!(
            inspect(
                SOURCE,
                HELPER,
                &REACT.replace("createContext:()=>C", "createContext:()=>other")
            )
            .is_err()
        );
        Ok(())
    }
}
