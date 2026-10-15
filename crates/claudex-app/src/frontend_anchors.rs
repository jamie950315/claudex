//! Structural native API anchors. Markers shortlist candidates; every selected
//! target retains complete binding and data-flow proof before transformation.
use crate::{
    frontend_ast::*,
    frontend_bindings::{Imported, ModuleGraph, Resolver},
    frontend_scope::{self, Scopes},
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::collections::BTreeSet;
pub fn has_member(node: &Value, name: &str) -> bool {
    !nodes(node, |n| member(n, name)).is_empty()
}
pub fn is_function(node: &Value) -> bool {
    matches!(
        kind(node),
        "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression"
    )
}
pub fn callback(node: &Value) -> bool {
    matches!(kind(node), "FunctionExpression" | "ArrowFunctionExpression")
}
pub fn void_zero(node: &Value) -> bool {
    kind(node) == "UnaryExpression" && node["operator"] == "void" && node["argument"]["value"] == 0
}
pub fn scope_nodes<'a>(root: &'a Value, predicate: impl Fn(&Value) -> bool) -> Vec<&'a Value> {
    fn walk<'a>(
        root: &'a Value,
        component: &Value,
        predicate: &dyn Fn(&Value) -> bool,
        found: &mut Vec<&'a Value>,
    ) {
        if kind(root).is_empty() {
            return;
        }
        if predicate(root) {
            found.push(root);
        }
        if frontend_scope::key(root) != frontend_scope::key(component) && is_function(root) {
            return;
        }
        for value in root.as_object().unwrap().values() {
            if let Some(items) = value.as_array() {
                for item in items {
                    walk(item, component, predicate, found);
                }
            } else if value.is_object() {
                walk(value, component, predicate, found);
            }
        }
    }
    let mut found = vec![];
    walk(root, root, &predicate, &mut found);
    found
}
#[derive(Clone, Debug)]
pub struct FunctionBinding {
    pub name: String,
    pub variants: Vec<Value>,
}
pub fn function_bindings(ast: &Value, arrows: bool, wrapper: Option<&str>) -> Vec<FunctionBinding> {
    let callable = |node: &Value| {
        kind(node) == "FunctionExpression"
            || (arrows
                && kind(node) == "ArrowFunctionExpression"
                && kind(&node["body"]) == "BlockStatement")
    };
    let mut out = vec![];
    for statement in array(&ast["body"]) {
        let statement = if arrows && kind(statement) == "ExportNamedDeclaration" {
            &statement["declaration"]
        } else {
            statement
        };
        if kind(statement) == "FunctionDeclaration" {
            if let Some(name) = id(&statement["id"]) {
                out.push(FunctionBinding {
                    name: name.into(),
                    variants: vec![statement.clone()],
                });
            }
        } else if kind(statement) == "VariableDeclaration" {
            for declaration in array(&statement["declarations"]) {
                let Some(name) = id(&declaration["id"]) else {
                    continue;
                };
                let init = &declaration["init"];
                let variants = if callable(init) {
                    vec![init.clone()]
                } else if wrapper.is_some()
                    && kind(init) == "CallExpression"
                    && id(&init["callee"]) == wrapper
                    && array(&init["arguments"]).len() == 1
                    && callable(&init["arguments"][0])
                {
                    vec![init["arguments"][0].clone()]
                } else if kind(init) == "ConditionalExpression"
                    && callable(&init["consequent"])
                    && callable(&init["alternate"])
                {
                    vec![init["consequent"].clone(), init["alternate"].clone()]
                } else {
                    vec![]
                };
                if !variants.is_empty() {
                    out.push(FunctionBinding {
                        name: name.into(),
                        variants,
                    });
                }
            }
        }
    }
    out
}
#[derive(Clone, Debug)]
pub struct CommandAnchor {
    pub function: Value,
    pub result: Value,
    pub session: String,
    pub native: String,
}
pub fn commands(source: &str, url: &str, graph: &dyn ModuleGraph) -> Result<CommandAnchor> {
    let resolver = Resolver::new(source, url, graph)?;
    let native = resolver.imported_api("LocalSessions", true)?.local;
    let ast = &resolver.ast;
    let call = unique(
        nodes(ast, |n| {
            kind(n) == "CallExpression"
                && member(&n["callee"], "getSupportedCommands")
                && id(&n["callee"]["object"]) == Some(native.as_str())
        }),
        "local command catalogue call",
    )?;
    let scopes = nodes(ast, |n| {
        is_function(n) && start(n) < start(call) && end(n) > end(call)
    });
    let function = unique(
        scopes
            .iter()
            .copied()
            .filter(|function| {
                function["async"] == true
                    && kind(&function["body"]) == "BlockStatement"
                    && array(&function["body"]["body"]).len() == 1
                    && kind(&function["body"]["body"][0]) == "ReturnStatement"
                    && kind(&function["body"]["body"][0]["argument"]) == "ConditionalExpression"
                    && frontend_scope::key(&function["body"]["body"][0]["argument"]["consequent"])
                        == frontend_scope::key(call)
            })
            .collect(),
        "local command catalogue function",
    )?;
    let outer = scopes.iter().copied().min_by_key(|f| start(f)).unwrap();
    let lexical = Scopes::analyze(outer);
    ensure!(
        lexical.is_free(&call["callee"]["object"])
            && lexical.is_free(&unwrap(&function["body"]["body"][0]["argument"]["test"])["object"]),
        "Claude frontend anchors: command catalogue native lexical binding missing or ambiguous."
    );
    let parameters = array(&function["params"]);
    ensure!(
        parameters.len() == 2
            && parameters.iter().all(|p| id(p).is_some())
            && !parameters.iter().any(|p| id(p) == Some(native.as_str())),
        "Claude frontend anchors: command catalogue scope missing or ambiguous."
    );
    let result = &function["body"]["body"][0]["argument"];
    ensure!(
        member(&result["test"], "getSupportedCommands")
            && id(&unwrap(&result["test"])["object"]) == Some(native.as_str())
            && kind(&result["alternate"]) == "ArrayExpression"
            && array(&result["alternate"]["elements"]).is_empty()
            && array(&call["arguments"]).len() == 1
            && kind(&call["arguments"][0]) == "ObjectExpression",
        "Claude frontend anchors: command catalogue native branch missing or ambiguous."
    );
    let fields = array(&call["arguments"][0]["properties"]);
    ensure!(
        fields.len() == 2,
        "Claude frontend anchors: command catalogue request fields missing or ambiguous."
    );
    let project = &unique(
        fields.iter().filter(|n| property(n, "cwd")).collect(),
        "command catalogue cwd",
    )?["value"];
    let target = &unique(
        fields.iter().filter(|n| property(n, "sessionId")).collect(),
        "command catalogue session",
    )?["value"];
    let cwd = id(&parameters[0]).unwrap();
    let session = id(&parameters[1]).unwrap();
    let fallback = |node: &Value, name: &str| {
        kind(node) == "LogicalExpression"
            && node["operator"] == "??"
            && id(&node["left"]) == Some(name)
            && void_zero(&node["right"])
    };
    ensure!(
        fallback(target, session)
            && kind(project) == "ConditionalExpression"
            && id(&project["test"]) == Some(session)
            && void_zero(&project["consequent"])
            && fallback(&project["alternate"], cwd),
        "Claude frontend anchors: command catalogue target routing missing or ambiguous."
    );
    Ok(CommandAnchor {
        function: function.clone(),
        result: result.clone(),
        session: session.into(),
        native,
    })
}
const COMMAND_CATALOG: &str = r#"function __cldxCommandCatalog(commands,sessionId){try{if(sessionId!=null||!Array.isArray(commands)||commands.some(c=>c?.name==="claudex"||Array.isArray(c?.aliases)&&c.aliases.includes("claudex"))||!commands.some(c=>c?.name==="claudex:claudex-workflow"))return commands;return[{name:"claudex",description:"Open the Claudex control pane.",argumentHint:"[receipt UUID]"},...commands]}catch{return commands}}"#;
pub fn transform_commands(source: &str, anchor: &CommandAnchor, asset: &str) -> Result<String> {
    let label = serde_json::to_string(asset)?;
    apply_edits(
        source,
        vec![
            Edit::replace(
                &anchor.result,
                format!(
                    "__cldxCommandCatalog(await ({}),{})",
                    code(source, &anchor.result)?,
                    anchor.session
                ),
            ),
            Edit::insert(
                source.len(),
                format!(
                    "\n;try{{console.warn(\"[Claudex commands] loaded \"+{label})}}catch{{}}{COMMAND_CATALOG}\n"
                ),
            ),
        ],
    )
}
#[derive(Clone, Debug)]
pub struct ChatAnchor {
    pub native: String,
    pub fork_action: bool,
}
pub fn chat(source: &str, url: &str, graph: &dyn ModuleGraph) -> Result<ChatAnchor> {
    let resolver = Resolver::new(source, url, graph)?;
    let native = resolver.imported_api("LocalSessions", true)?;
    let ast = &resolver.ast;
    let capabilities = nodes(ast, |n| {
        kind(n) == "BinaryExpression"
            && n["operator"] == "!=="
            && (void_zero(&n["right"])
                && member(&n["left"], "forkSession")
                && unwrap(&n["left"])["optional"] == true
                || void_zero(&n["left"])
                    && member(&n["right"], "forkSession")
                    && unwrap(&n["right"])["optional"] == true)
    })
    .into_iter()
    .filter_map(|n| {
        id(&unwrap(if void_zero(&n["right"]) {
            &n["left"]
        } else {
            &n["right"]
        })["object"])
        .map(str::to_owned)
    })
    .collect::<BTreeSet<_>>();
    ensure!(
        unique(
            capabilities.into_iter().collect(),
            "native fork capability binding"
        )? == native.local,
        "Claude frontend anchors: native fork capability import missing or ambiguous."
    );
    let actions = nodes(ast, |n| {
        kind(n) == "FunctionExpression"
            && n["async"] == true
            && n["generator"] != true
            && array(&n["params"]).len() == 2
            && array(&n["params"]).iter().all(|p| id(p).is_some())
            && kind(&n["body"]) == "BlockStatement"
    })
    .into_iter()
    .filter(|function| fork_action(function, &native))
    .count();
    Ok(ChatAnchor {
        native: native.local,
        fork_action: actions == 1,
    })
}
fn fork_action(function: &Value, native: &Imported) -> bool {
    let body = array(&function["body"]["body"]);
    if body.len() < 4 {
        return false;
    }
    let first = &body[0];
    let guard = &body[1];
    if kind(first) != "VariableDeclaration"
        || first["kind"] != "const"
        || array(&first["declarations"]).len() != 1
    {
        return false;
    }
    let alias = &first["declarations"][0];
    let Some(name) = id(&alias["id"]) else {
        return false;
    };
    let init = unwrap(&alias["init"]);
    let request = id(&function["params"][0]);
    if !member(init, "forkSession")
        || init["optional"] != true
        || id(&init["object"]) != Some(native.local.as_str())
        || nodes(function, |n| id(n) == Some(native.local.as_str())).len() != 1
        || array(&function["params"])
            .iter()
            .any(|n| id(n) == Some(name))
        || kind(guard) != "IfStatement"
        || !guard["alternate"].is_null()
        || kind(&guard["test"]) != "UnaryExpression"
        || guard["test"]["operator"] != "!"
        || id(&guard["test"]["argument"]) != Some(name)
        || kind(&guard["consequent"]) != "ReturnStatement"
        || kind(&guard["consequent"]["argument"]) != "Literal"
        || !guard["consequent"]["argument"]["value"].is_null()
    {
        return false;
    }
    let calls = nodes(function, |n| {
        kind(n) == "AwaitExpression"
            && kind(&n["argument"]) == "CallExpression"
            && id(&n["argument"]["callee"]) == Some(name)
    });
    if calls.len() != 1 {
        return false;
    }
    let branch = &body[3];
    let first_call = &branch["block"]["body"][0];
    if kind(&body[2]) != "VariableDeclaration"
        || array(&body[2]["declarations"])
            .iter()
            .any(|n| id(&n["id"]) == Some(name))
        || kind(branch) != "TryStatement"
        || kind(first_call) != "VariableDeclaration"
        || array(&first_call["declarations"]).len() != 1
        || id(&first_call["declarations"][0]["id"]) == Some(name)
        || frontend_scope::key(&first_call["declarations"][0]["init"])
            != frontend_scope::key(calls[0])
        || nodes(function, |n| {
            kind(n) == "CallExpression" && id(&n["callee"]) == Some(name)
        })
        .len()
            != 1
    {
        return false;
    }
    let args = array(&calls[0]["argument"]["arguments"]);
    if args.len() != 4
        || !member(&args[0], "id")
        || !member(&args[0]["object"], "ref")
        || id(&args[0]["object"]["object"]) != request
        || id(&args[1]).is_none()
        || !member(&args[2], "forkAtMessageUuid")
        || id(&args[2]["object"]) != request
        || !member(&args[3], "targetCwd")
        || id(&args[3]["object"]) != request
    {
        return false;
    }
    let seeds = scope_nodes(function, |n| {
        kind(n) == "VariableDeclarator" && id(&n["id"]) == id(&args[1])
    });
    if seeds.len() != 1 {
        return false;
    }
    let seed = &seeds[0]["init"];
    kind(seed) == "TemplateLiteral"
        && array(&seed["quasis"]).len() == 2
        && array(&seed["expressions"]).len() == 1
        && seed["quasis"][0]["value"]["cooked"] == "local_"
        && seed["quasis"][1]["value"]["cooked"] == ""
        && kind(&seed["expressions"][0]) == "CallExpression"
        && member(&seed["expressions"][0]["callee"], "randomUUID")
        && id(&seed["expressions"][0]["callee"]["object"]) == Some("crypto")
        && array(&seed["expressions"][0]["arguments"]).is_empty()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend_bindings::{ASSET_ROOT, Module, Modules};
    fn fixture() -> Result<(String, Modules)> {
        let root = format!("{ASSET_ROOT}index-main.js");
        let url = format!("{ASSET_ROOT}native.js");
        let mut graph = Modules::new();
        graph.insert(
            url.clone(),
            Module::parse(
                url,
                "const n=globalThis['claude.web']?.LocalSessions;export{n as N}",
            )?,
        );
        Ok((root, graph))
    }
    #[test]
    fn cold_catalog_retains_native_routing_and_refuses_enclosing_shadows() -> Result<()> {
        let (url, graph) = fixture()?;
        let source = "import{N as n}from'./native.js';async function list(c,s){return n?.getSupportedCommands?n.getSupportedCommands({cwd:s?void 0:c??void 0,sessionId:s??void 0}):[]}";
        let anchor = commands(source, &url, &graph)?;
        let patched = transform_commands(source, &anchor, "catalog.js")?;
        assert!(patched.contains("__cldxCommandCatalog(await (n?.getSupportedCommands?"));
        let shadow = "import{N as n}from'./native.js';function wrapper(n){return async(c,s)=>{return n?.getSupportedCommands?n.getSupportedCommands({cwd:s?void 0:c??void 0,sessionId:s??void 0}):[]}}";
        assert!(commands(shadow, &url, &graph).is_err());
        Ok(())
    }
    #[test]
    fn chat_capability_requires_the_unique_imported_native_binding() -> Result<()> {
        let (url, graph) = fixture()?;
        let source = "import{N as n}from'./native.js';let supported=n?.forkSession!==void 0;";
        assert!(!chat(source, &url, &graph)?.fork_action);
        assert!(
            chat(
                &source.replace("n?.forkSession", "other?.forkSession"),
                &url,
                &graph
            )
            .is_err()
        );
        Ok(())
    }
}
