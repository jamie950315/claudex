//! Reuse the native exact-ID metadata reader and its existing account access.
//! This never discovers credentials, invokes a session, or paginates a list.
use crate::{
    frontend_ast::*,
    frontend_bindings::{Imported, ModuleGraph, Resolver, resolve_url},
    frontend_scope::Scopes,
};
use anyhow::{Context, Result, ensure};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct MetadataReader {
    pub path: String,
    pub read: String,
    pub normalize: String,
    pub is_bridge: String,
    pub fetch_hook: Imported,
    pub account_hook: Imported,
    pub cloud_hook: Imported,
    pub enabled_hook: Imported,
}
fn functions(ast: &Value) -> Vec<&Value> {
    array(&ast["body"])
        .iter()
        .filter(|n| kind(n) == "FunctionDeclaration")
        .collect()
}
fn literal(node: &Value, value: &str) -> bool {
    kind(node) == "Literal" && node["value"] == value
}
fn contains_literal(node: &Value, value: &str) -> bool {
    !nodes(node, |n| literal(n, value)).is_empty()
}
fn has_path(node: &Value) -> bool {
    !nodes(node, |n| {
        kind(n) == "TemplateElement"
            && n["value"]["cooked"]
                .as_str()
                .is_some_and(|s| s.starts_with("/v1/code/sessions/"))
    })
    .is_empty()
}
fn field<'a>(object: &'a Value, name: &str) -> Result<&'a Value> {
    Ok(&unique(
        array(&object["properties"])
            .iter()
            .filter(|p| property(p, name))
            .collect(),
        name,
    )?["value"])
}
fn exported(ast: &Value, function: &Value) -> Result<String> {
    unique(
        nodes(ast, |n| {
            kind(n) == "ExportSpecifier" && id(&n["local"]) == id(&function["id"])
        })
        .into_iter()
        .filter_map(|n| id(&n["exported"]).map(str::to_owned))
        .collect(),
        "native metadata export",
    )
}
fn import_for(ast: &Value, scopes: &Scopes<'_>, reference: &Value) -> Result<Imported> {
    let (declaration, spec) = unique(
        array(&ast["body"])
            .iter()
            .filter(|n| kind(n) == "ImportDeclaration")
            .flat_map(|n| array(&n["specifiers"]).iter().map(move |s| (n, s)))
            .filter(|(_, s)| scopes.same(&s["local"], reference))
            .collect(),
        "native metadata context getter",
    )?;
    ensure!(
        kind(spec) == "ImportSpecifier",
        "Metadata context getter must be a named native import."
    );
    Ok(Imported {
        local: id(&spec["local"]).unwrap().into(),
        exported: id(&spec["imported"]).unwrap().into(),
        path: declaration["source"]["value"].as_str().unwrap().into(),
    })
}
fn getter_declaration<'a>(
    ast: &'a Value,
    scope: &Scopes<'_>,
    reference: &Value,
) -> Result<&'a Value> {
    unique(
        nodes(ast, |n| {
            kind(n) == "VariableDeclarator" && scope.same(&n["id"], reference)
        }),
        "native metadata captured getter",
    )
}
/// A module-level declaration, local or, from the 2026-10-21 graph, imported by
/// name from the shared module that now declares the API base and headers.
fn declaration(
    ast: &Value,
    scopes: &Scopes<'_>,
    reference: &Value,
    imported: &dyn Fn(&Value, &Value) -> Result<Option<Value>>,
    name: &str,
) -> Result<Value> {
    let locals = array(&ast["body"])
        .iter()
        .flat_map(|n| match kind(n) {
            "FunctionDeclaration" => vec![n],
            "VariableDeclaration" => array(&n["declarations"]).iter().collect(),
            _ => vec![],
        })
        .filter(|n| scopes.same(&n["id"], reference))
        .collect::<Vec<_>>();
    let imports = array(&ast["body"])
        .iter()
        .filter(|n| kind(n) == "ImportDeclaration")
        .flat_map(|n| array(&n["specifiers"]).iter().map(move |s| (n, s)))
        .filter(|(_, s)| scopes.same(&s["local"], reference))
        .collect::<Vec<_>>();
    match (locals.as_slice(), imports.as_slice()) {
        ([local], []) => Ok((*local).clone()),
        ([], [(declaration, spec)]) if kind(spec) == "ImportSpecifier" => {
            imported(declaration, spec)?
                .with_context(|| format!("Claude frontend anchors: {name} import is unresolved."))
        }
        _ => anyhow::bail!("Claude frontend anchors: {name} missing or ambiguous."),
    }
}
fn empty_call(node: &Value) -> bool {
    kind(node) == "CallExpression"
        && id(&node["callee"]).is_some()
        && array(&node["arguments"]).is_empty()
}

fn prove(
    ast: &Value,
    path: &str,
    imported: &dyn Fn(&Value, &Value) -> Result<Option<Value>>,
) -> Result<MetadataReader> {
    let scopes = Scopes::analyze(ast);
    let read = unique(
        functions(ast)
            .into_iter()
            .filter(|f| contains_literal(f, "fetchCcrV2Session"))
            .collect(),
        "native exact-ID metadata reader",
    )?;
    let params = array(&read["params"]);
    let body = array(&read["body"]["body"]);
    ensure!(
        params.len() == 4
            && params.iter().all(|p| id(p).is_some())
            && read["async"] == true
            && body.len() == 4
            && kind(&body[0]) == "IfStatement"
            && kind(&body[0]["consequent"]) == "ThrowStatement"
            && kind(&body[1]) == "VariableDeclaration"
            && array(&body[1]["declarations"]).len() == 1
            && kind(&body[2]) == "IfStatement"
            && kind(&body[2]["consequent"]) == "ThrowStatement"
            && kind(&body[3]) == "ReturnStatement",
        "Native exact-ID reader lifecycle changed."
    );
    let response = &body[1]["declarations"][0];
    let request = &response["init"]["argument"];
    ensure!(
        kind(&response["init"]) == "AwaitExpression"
            && kind(request) == "CallExpression"
            && scopes.same(&request["callee"], &params[0])
            && array(&request["arguments"]).len() == 2,
        "Native exact-ID reader fetch provenance changed."
    );
    let url = &request["arguments"][0];
    let options = &request["arguments"][1];
    let parts = array(&url["expressions"]);
    let quasis = array(&url["quasis"]);
    ensure!(
        kind(url) == "TemplateLiteral"
            && parts.len() == 3
            && quasis.len() == 4
            && quasis[0]["value"]["cooked"] == ""
            && quasis[1]["value"]["cooked"] == "/"
            && quasis[2]["value"]["cooked"] == ""
            && quasis[3]["value"]["cooked"] == ""
            && kind(&parts[1]) == "CallExpression"
            && array(&parts[1]["arguments"]).len() == 1
            && scopes.same(&parts[1]["arguments"][0], &params[2])
            && kind(&parts[2]) == "ConditionalExpression"
            && literal(&parts[2]["alternate"], "")
            && member(unwrap(&parts[2]["test"]), "includeHearthBinding")
            && scopes.same(&unwrap(&parts[2]["test"])["object"], &params[3])
            && kind(options) == "ObjectExpression"
            && array(&options["properties"]).len() == 2
            && literal(field(options, "cache")?, "no-store"),
        "Native metadata lookup must remain a single default GET, not another endpoint or write."
    );
    let base = declaration(
        ast,
        &scopes,
        &parts[0],
        imported,
        "native metadata API base",
    )?;
    ensure!(
        kind(&base) == "VariableDeclarator" && literal(&base["init"], "/v1/code/sessions"),
        "Native metadata API base changed."
    );
    let headers = field(options, "headers")?;
    let header_call = unique(
        nodes(headers, |n| {
            kind(n) == "CallExpression"
                && array(&n["arguments"]).len() == 1
                && scopes.same(&n["arguments"][0], &params[1])
        }),
        "native organization headers",
    )?;
    let header_function = declaration(
        ast,
        &scopes,
        &header_call["callee"],
        imported,
        "native organization header factory",
    )?;
    let header_scopes = Scopes::analyze(&header_function);
    let header_parameter = &header_function["params"][0];
    let header_value = &header_function["body"]["body"][0]["argument"];
    ensure!(
        kind(&header_function) == "FunctionDeclaration"
            && header_function["async"] != true
            && array(&header_function["params"]).len() == 1
            && array(&header_function["body"]["body"]).len() == 1
            && kind(&header_function["body"]["body"][0]) == "ReturnStatement"
            && kind(header_value) == "ObjectExpression"
            && header_scopes.same(
                field(header_value, "x-organization-uuid")?,
                header_parameter
            ),
        "Native metadata organization binding changed."
    );
    ensure!(
        nodes(read, |n| kind(n) == "CallExpression"
            && scopes.same(&n["callee"], &params[0]))
        .len()
            == 1,
        "Native metadata reader must issue one request."
    );

    let normalize = unique(
        functions(ast)
            .into_iter()
            .filter(|f| {
                array(&f["params"]).len() == 1
                    && f["async"] != true
                    && !nodes(f, |n| {
                        kind(n) == "ObjectExpression"
                            && field(n, "type").is_ok_and(|v| literal(v, "session"))
                            && field(n, "session_status").is_ok()
                            && field(n, "environment_kind").is_ok()
                            && field(n, "id").is_ok()
                    })
                    .is_empty()
            })
            .collect(),
        "native session metadata normalizer",
    )?;
    ensure!(
        contains_literal(normalize, "ENVIRONMENT_KIND_"),
        "Native metadata normalizer no longer supplies native environment kinds."
    );
    let classifier = unique(
        functions(ast)
            .into_iter()
            .filter(|f| {
                array(&f["params"]).len() == 1
                    && array(&f["body"]["body"]).len() == 1
                    && contains_literal(f, "bridge")
                    && contains_literal(f, "pending")
                    && !nodes(f, |n| member(n, "environment_kind")).is_empty()
                    && nodes(f, |n| {
                        matches!(
                            kind(n),
                            "CallExpression"
                                | "AssignmentExpression"
                                | "UpdateExpression"
                                | "AwaitExpression"
                        )
                    })
                    .is_empty()
            })
            .collect(),
        "native bridge classifier",
    )?;
    let decision = &classifier["body"]["body"][0]["argument"];
    ensure!(
        kind(decision) == "ConditionalExpression"
            && kind(&decision["alternate"]) == "BinaryExpression"
            && decision["alternate"]["operator"] == "==="
            && member(&decision["alternate"]["left"], "environment_kind")
            && scopes.same(
                &decision["alternate"]["left"]["object"],
                &classifier["params"][0]
            )
            && literal(&decision["alternate"]["right"], "bridge"),
        "Native bridge classifier identity changed."
    );

    let prefetch = unique(
        functions(ast)
            .into_iter()
            .filter(|f| contains_literal(f, "Failed to prefetch session") && has_path(f))
            .collect(),
        "native exact-ID prefetch context",
    )?;
    let account = unique(
        nodes(prefetch, |n| {
            kind(n) == "VariableDeclarator"
                && kind(&n["id"]) == "ObjectPattern"
                && field(&n["id"], "activeOrganization").is_ok()
                && empty_call(&n["init"])
        }),
        "native metadata account getter",
    )?;
    let account_binding = field(&account["id"], "activeOrganization")?;
    let org = unique(
        nodes(prefetch, |n| {
            kind(n) == "VariableDeclarator"
                && member(unwrap(&n["init"]), "uuid")
                && scopes.same(&unwrap(&n["init"])["object"], account_binding)
        }),
        "native metadata organization UUID",
    )?;
    let prefetch_header = unique(
        nodes(prefetch, |n| {
            kind(n) == "CallExpression"
                && scopes.same(&n["callee"], &header_call["callee"])
                && array(&n["arguments"]).len() == 1
                && scopes.same(&n["arguments"][0], &org["id"])
        }),
        "native prefetch organization headers",
    )?;
    let prefetch_header_binding = unique(
        nodes(prefetch, |n| {
            kind(n) == "VariableDeclarator" && start(&n["init"]) == start(prefetch_header)
        }),
        "native prefetch header capture",
    )?;
    let prefetch_request = unique(
        nodes(prefetch, |n| {
            kind(n) == "CallExpression"
                && has_path(&n["arguments"][0])
                && array(&n["arguments"]).len() == 2
                && field(&n["arguments"][1], "headers")
                    .is_ok_and(|v| scopes.same(v, &prefetch_header_binding["id"]))
        }),
        "native authenticated prefetch request",
    )?;
    let fetch = getter_declaration(prefetch, &scopes, &prefetch_request["callee"])?;
    ensure!(
        empty_call(&fetch["init"]),
        "Native raw fetch must come from its existing context getter."
    );

    let lookup = unique(
        functions(ast)
            .into_iter()
            .filter(|f| {
                has_path(f)
                    && !nodes(f, |n| property(n, "queries")).is_empty()
                    && !nodes(f, |n| property(n, "method") && literal(&n["value"], "GET"))
                        .is_empty()
            })
            .collect(),
        "native exact-ID lookup access",
    )?;
    let lookup_account = unique(
        nodes(lookup, |n| {
            kind(n) == "VariableDeclarator"
                && kind(&n["id"]) == "ObjectPattern"
                && field(&n["id"], "activeOrganization").is_ok()
        }),
        "native lookup account",
    )?;
    ensure!(
        empty_call(&lookup_account["init"])
            && scopes.same(
                &lookup_account["init"]["callee"],
                &account["init"]["callee"]
            ),
        "Native lookup and prefetch must use the same account."
    );
    let lookup_org = field(&lookup_account["id"], "activeOrganization")?;
    let cloud = unique(
        nodes(lookup, |n| {
            kind(n) == "VariableDeclarator"
                && member(&n["init"], "cloud")
                && empty_call(&n["init"]["object"])
        }),
        "native Code cloud access getter",
    )?;
    ensure!(
        contains_literal(lookup, "allowed"),
        "Native Code cloud allow policy is absent."
    );
    let enabled = unique(
        nodes(lookup, |n| {
            kind(n) == "VariableDeclarator"
                && kind(&n["init"]) == "LogicalExpression"
                && !nodes(&n["init"], |v| scopes.same(v, lookup_org)).is_empty()
                && nodes(&n["init"], empty_call).len() == 1
        }),
        "native Code enabled policy",
    )?;
    let enabled_call = unique(
        nodes(&enabled["init"], empty_call),
        "native Code enabled getter",
    )?;
    Ok(MetadataReader {
        path: path.into(),
        read: exported(ast, read)?,
        normalize: exported(ast, normalize)?,
        is_bridge: exported(ast, classifier)?,
        fetch_hook: import_for(ast, &scopes, &fetch["init"]["callee"])?,
        account_hook: import_for(ast, &scopes, &account["init"]["callee"])?,
        cloud_hook: import_for(ast, &scopes, &cloud["init"]["object"]["callee"])?,
        enabled_hook: import_for(ast, &scopes, &enabled_call["callee"])?,
    })
}

pub fn resolve(source: &str, url: &str, graph: &dyn ModuleGraph) -> Result<Option<MetadataReader>> {
    let ast = syntax(source)?;
    let mut candidates = vec![];
    for import in array(&ast["body"])
        .iter()
        .filter(|n| kind(n) == "ImportDeclaration")
    {
        let Some(path) = import["source"]["value"].as_str() else {
            continue;
        };
        let Some(module) = resolve_url(url, path) else {
            continue;
        };
        let Some(source) = graph.source(&module) else {
            continue;
        };
        if source.contains("\"fetchCcrV2Session\"") && source.contains("/v1/code/sessions") {
            candidates.push((path, module, source));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let (path, module, source) = unique(candidates, "native metadata API module")?;
    let resolver = Resolver::new(source, &module, graph)?;
    let imported = |declaration: &Value, spec: &Value| {
        resolver
            .imported(declaration, spec)?
            .map(|resolved| resolver.definition(&resolved))
            .transpose()
    };
    Ok(Some(prove(&resolver.ast, path, &imported)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &str = r#"
import{Fetch,Account,Cloud,Enabled}from'./context.js';
const base='/v1/code/sessions',cache={};
function headers(org){return {'x-organization-uuid':org};}
async function read(fetch,org,id,options){
 if(local(id))throw Error('local only');
 let response=await fetch(`${base}/${encode(id)}${options?.includeHearthBinding?'?include_hearth_binding=true':''}`,{headers:{...headers(org),...cache},cache:'no-store'});
 if(!response.ok)throw Error('fetchCcrV2Session');
 return decode(await response.json()).session??null;
}
function normalize(value){return {type:'session',id:value.id,session_status:value.status,environment_kind:enumValue(value.environment_kind,'ENVIRONMENT_KIND_')};}
function bridge(value){return value.environment_kind===void 0?value.title&&value.session_status!=='pending':value.environment_kind==='bridge';}
function prefetch(){
 let {activeOrganization:account}=Account(),org=account?.uuid,fetch=Fetch();
 return id=>{let h=headers(org);return client.prefetchQuery({queryFn:async()=>{
 let response=await fetch(`/v1/code/sessions/${encode(id)}`,{headers:h});
 if(!response.ok)throw Error('Failed to prefetch session');return response.json();},retry:false});};
}
function lookup(ids){
 let {activeOrganization:account}=Account(),enabled=Enabled()&&!!account,cloud=Cloud().cloud;
 return useQueries({queries:ids.map(id=>({enabled:enabled&&cloud==='allowed',queryFn:()=>json(`/v1/code/sessions/${encode(id)}`,{method:'GET'})}))});
}
export{read,normalize,bridge};
"#;
    fn no_imports(_: &Value, _: &Value) -> Result<Option<Value>> {
        Ok(None)
    }
    const ROOT: &str = crate::frontend_bindings::ASSET_ROOT;
    fn graph(constants: &str, metadata: &str) -> crate::frontend_bindings::Modules {
        [("constants.js", constants), ("metadata.js", metadata)]
            .into_iter()
            .map(|(name, source)| {
                let url = format!("{ROOT}{name}");
                let module = crate::frontend_bindings::Module::parse(url.clone(), source).unwrap();
                (url, module)
            })
            .collect()
    }
    fn imported_base(constants: &str, import: &str) -> Result<Option<MetadataReader>> {
        let metadata = SOURCE
            .replace(
                "const base='/v1/code/sessions',cache={};",
                "const cache={};",
            )
            .replace(
                "function headers(org){return {'x-organization-uuid':org};}\n",
                "",
            )
            .replacen("import{", import, 1)
            .replace("'fetchCcrV2Session'", "\"fetchCcrV2Session\"");
        let modules = graph(constants, &metadata);
        resolve(
            "import{read}from'./metadata.js';",
            &format!("{ROOT}consumer.js"),
            &modules,
        )
    }
    #[test]
    fn imported_api_base_and_headers_are_proven() {
        let constants = "var base='/v1/code/sessions',other='/v1/sessions';\
            function sS(org){return {'x-organization-uuid':org};}export{base,other,sS};";
        let import = "import{base,sS as headers}from'./constants.js';import{";
        let reader = imported_base(constants, import).unwrap().unwrap();
        assert_eq!(reader.read, "read");
        for (constants, import) in [
            (
                constants.replace("'/v1/code/sessions'", "'/v1/other'"),
                import,
            ),
            (constants.replace("export{base,", "export{"), import),
            (
                constants.replace("export{base,other,sS}", "export{base,other}"),
                import,
            ),
            (
                constants.replace("'x-organization-uuid':org", "'x-organization-uuid':other"),
                import,
            ),
            (
                constants.replace("function sS(org)", "async function sS(org)"),
                import,
            ),
            (
                constants.into(),
                "import{base,sS as headers}from'./missing.js';import{",
            ),
            (
                constants.into(),
                "import{base,sS as headers}from'./constants.js';const base='/v1/code/sessions';import{",
            ),
        ] {
            assert!(
                imported_base(&constants, import).is_err(),
                "{constants} {import}"
            );
        }
    }
    #[test]
    fn exact_reader_and_existing_account_access_are_proven() {
        let p = prove(&syntax(SOURCE).unwrap(), "./metadata.js", &no_imports).unwrap();
        assert_eq!(
            (p.read.as_str(), p.normalize.as_str(), p.is_bridge.as_str()),
            ("read", "normalize", "bridge")
        );
        assert_eq!(p.fetch_hook.exported, "Fetch");
        assert_eq!(p.account_hook.exported, "Account");
        assert_eq!(p.cloud_hook.exported, "Cloud");
        assert_eq!(p.enabled_hook.exported, "Enabled");
    }
    #[test]
    fn changed_request_or_account_provenance_is_refused() {
        for (from, to) in [
            ("cache:'no-store'", "cache:'no-store',method:'POST'"),
            ("${encode(id)}${options", "${encode(other)}${options"),
            ("...headers(org)", "...headers(other)"),
            ("let h=headers(org)", "let h=headers(other)"),
            ("org=account?.uuid", "org=other?.uuid"),
            ("fetch=Fetch()", "fetch=untrusted"),
            ("function prefetch()", "function prefetch(Fetch)"),
            ("function prefetch()", "function prefetch(Account)"),
            ("environment_kind==='bridge'", "environment_kind==='remote'"),
            (
                "const base='/v1/code/sessions'",
                "const base='/v1/other/sessions'",
            ),
        ] {
            assert!(
                prove(
                    &syntax(&SOURCE.replace(from, to)).unwrap(),
                    "./metadata.js",
                    &no_imports
                )
                .is_err(),
                "{from}"
            );
        }
    }
}
