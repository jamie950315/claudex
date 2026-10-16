//! Bounded named-export provenance. Dependency ASTs are released after their
//! compact index is built; exact helper bodies are parsed only when needed.
use crate::frontend_ast::*;
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub const ASSET_ROOT: &str = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/";
pub fn asset_url(url: &str) -> bool {
    url.strip_prefix(ASSET_ROOT).is_some_and(|name| {
        name.ends_with(".js")
            && !name[..name.len() - 3].is_empty()
            && name[..name.len() - 3]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    })
}
pub fn resolve_url(base: &str, spec: &str) -> Option<String> {
    let result = url::Url::parse(base).ok()?.join(spec).ok()?.to_string();
    asset_url(&result).then_some(result)
}
pub fn native_host(node: &Value) -> bool {
    kind(node) == "MemberExpression"
        && node["computed"] == true
        && id(&node["object"]) == Some("globalThis")
        && node["property"]["value"] == "claude.web"
}
pub fn native_api_expression(node: &Value) -> &Value {
    if kind(node) != "SequenceExpression" {
        return node;
    }
    if array(&node["expressions"]).len() == 2 && native_host(&node["expressions"][0]) {
        &node["expressions"][1]
    } else {
        &Value::Null
    }
}
fn native_object(node: &Value) -> bool {
    let node = unwrap(native_api_expression(node));
    node["optional"] == true && native_host(&node["object"])
}
fn public_getter(node: &Value) -> bool {
    kind(node) == "Property"
        && kind(&node["value"]) == "ArrowFunctionExpression"
        && array(&node["value"]["params"]).is_empty()
        && id(&node["value"]["body"]).is_some()
}
fn api_expression(node: &Value) -> Value {
    match kind(node) {
        "Identifier" => json!({"type":"Identifier","name":node["name"]}),
        "Literal" => json!({"type":"Literal","value":node["value"]}),
        "ChainExpression" => {
            json!({"type":"ChainExpression","expression":api_expression(&node["expression"])})
        }
        "MemberExpression" => {
            json!({"type":"MemberExpression","computed":node["computed"],"optional":node["optional"],"object":api_expression(&node["object"]),"property":api_expression(&node["property"])})
        }
        "SequenceExpression" if array(&node["expressions"]).len() == 2 => {
            json!({"type":"SequenceExpression","expressions":array(&node["expressions"]).iter().map(api_expression).collect::<Vec<_>>()})
        }
        other => json!({"type":other}),
    }
}
#[derive(Clone, Debug)]
pub struct Index {
    locals: BTreeMap<String, Vec<Value>>,
    getters: Vec<Value>,
    exports: Vec<Value>,
    imports: Vec<Value>,
}
impl Index {
    pub fn compact(ast: &Value) -> Self {
        Self::build(ast, false)
    }
    fn build(ast: &Value, full: bool) -> Self {
        let exports=array(&ast["body"]).iter().filter(|n|matches!(kind(n),"ExportNamedDeclaration"|"ExportAllDeclaration")).map(|n|{
            let names=if kind(&n["declaration"])=="VariableDeclaration" {array(&n["declaration"]["declarations"]).iter().filter_map(|d|id(&d["id"])).map(str::to_owned).collect::<Vec<_>>()}
                else {id(&n["declaration"]["id"]).map(str::to_owned).into_iter().collect()};
            json!({"type":n["type"],"source":n["source"],"specifiers":n["specifiers"],"exported":n["exported"],"names":names})
        }).collect::<Vec<_>>();
        let mut exported = BTreeSet::new();
        for declaration in &exports {
            for name in array(&declaration["names"]) {
                if let Some(name) = name.as_str() {
                    exported.insert(name.to_owned());
                }
            }
            if kind(declaration) == "ExportNamedDeclaration" && declaration["source"].is_null() {
                for specifier in array(&declaration["specifiers"]) {
                    if let Some(name) = id(&specifier["local"]) {
                        exported.insert(name.into());
                    }
                }
            }
        }
        let mut locals: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for statement in array(&ast["body"]) {
            let statement = if kind(statement) == "ExportNamedDeclaration"
                && !statement["declaration"].is_null()
            {
                &statement["declaration"]
            } else {
                statement
            };
            let declarations = if kind(statement) == "FunctionDeclaration" {
                vec![statement]
            } else if kind(statement) == "VariableDeclaration" {
                array(&statement["declarations"]).iter().collect()
            } else {
                vec![]
            };
            for declaration in declarations {
                let Some(name) = id(&declaration["id"]) else {
                    continue;
                };
                if !full && !exported.contains(name) {
                    continue;
                }
                let api = [
                    "LocalSessions",
                    "useEffect",
                    "useRef",
                    "useContext",
                    "createContext",
                    "useSyncExternalStore",
                    "useMemo",
                    "memo",
                ]
                .iter()
                .any(|p| member(&declaration["init"], p))
                    || member(native_api_expression(&declaration["init"]), "LocalSessions");
                let entry = if full {
                    declaration.clone()
                } else {
                    let mut value = json!({"type":declaration["type"],"id":declaration["id"],"start":declaration["start"],"end":declaration["end"]});
                    if kind(declaration) == "VariableDeclarator" {
                        value["init"] = if api {
                            api_expression(&declaration["init"])
                        } else {
                            Value::Null
                        };
                    }
                    value
                };
                locals.entry(name.into()).or_default().push(entry);
            }
        }
        Self {
            locals,
            getters: nodes(ast, public_getter).into_iter().cloned().collect(),
            exports,
            imports: array(&ast["body"])
                .iter()
                .filter(|n| kind(n) == "ImportDeclaration")
                .cloned()
                .collect(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Module {
    pub url: String,
    pub source: String,
    pub eager: Vec<String>,
    pub imports: Vec<String>,
    index: Index,
}
impl Module {
    pub fn parse(url: impl Into<String>, source: impl Into<String>) -> Result<Self> {
        let source = source.into();
        let ast = syntax(&source)?;
        Ok(Self {
            url: url.into(),
            eager: imports(&ast, true),
            imports: imports(&ast, false),
            index: Index::build(&ast, false),
            source,
        })
    }
}
pub type Modules = BTreeMap<String, Module>;
pub trait ModuleGraph {
    fn source(&self, url: &str) -> Option<&str>;
    fn index(&self, url: &str) -> Option<&Index>;
}
impl ModuleGraph for Modules {
    fn source(&self, url: &str) -> Option<&str> {
        self.get(url).map(|module| module.source.as_str())
    }
    fn index(&self, url: &str) -> Option<&Index> {
        self.get(url).map(|module| &module.index)
    }
}
#[derive(Clone, Debug)]
pub struct Resolved {
    pub module: String,
    pub local: String,
    pub node: Value,
    pub getters: Vec<Value>,
}
pub struct Resolver<'a> {
    pub source: &'a str,
    pub url: &'a str,
    pub ast: Value,
    index: Index,
    pub modules: &'a dyn ModuleGraph,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Imported {
    pub local: String,
    pub exported: String,
    pub path: String,
}
impl<'a> Resolver<'a> {
    pub fn new(source: &'a str, url: &'a str, modules: &'a dyn ModuleGraph) -> Result<Self> {
        let ast = syntax(source)?;
        let index = Index::build(&ast, true);
        Ok(Self {
            source,
            url,
            ast,
            index,
            modules,
        })
    }
    fn index(&self, module: &str) -> Option<&Index> {
        if module == self.url {
            Some(&self.index)
        } else {
            self.modules.index(module)
        }
    }
    pub fn local(&self, name: &str) -> Result<Option<Resolved>> {
        self.local_in(self.url, name, &[])
    }
    fn local_in(
        &self,
        module: &str,
        name: &str,
        seen: &[(String, String)],
    ) -> Result<Option<Resolved>> {
        let Some(index) = self.index(module) else {
            return Ok(None);
        };
        let rows = index.locals.get(name).cloned().unwrap_or_default();
        ensure!(
            rows.len() <= 1,
            "Claude frontend anchors: static local binding missing or ambiguous."
        );
        if let Some(node) = rows.into_iter().next() {
            return Ok(Some(Resolved {
                module: module.into(),
                local: name.into(),
                node,
                getters: index.getters.clone(),
            }));
        }
        let mut imports = vec![];
        for declaration in &index.imports {
            for spec in array(&declaration["specifiers"]) {
                if kind(spec) == "ImportSpecifier" && id(&spec["local"]) == Some(name) {
                    imports.push((declaration, spec));
                }
            }
        }
        if imports.len() != 1 {
            return Ok(None);
        }
        let Some(dependency) = imports[0].0["source"]["value"]
            .as_str()
            .and_then(|spec| resolve_url(module, spec))
        else {
            return Ok(None);
        };
        self.exported_inner(
            &dependency,
            id(&imports[0].1["imported"]).unwrap_or(""),
            seen,
        )
    }
    pub fn exported(&self, module: &str, name: &str) -> Result<Option<Resolved>> {
        self.exported_inner(module, name, &[])
    }
    fn exported_inner(
        &self,
        module: &str,
        name: &str,
        seen: &[(String, String)],
    ) -> Result<Option<Resolved>> {
        if seen.len() >= 8 || seen.iter().any(|(m, n)| m == module && n == name) {
            return Ok(None);
        }
        let Some(index) = self.index(module) else {
            return Ok(None);
        };
        let mut seen = seen.to_vec();
        seen.push((module.into(), name.into()));
        let mut matches: BTreeMap<(String, usize, usize, String), Resolved> = BTreeMap::new();
        let mut add = |resolved: Option<Resolved>| {
            if let Some(value) = resolved {
                matches.insert(
                    (
                        value.module.clone(),
                        start(&value.node),
                        end(&value.node),
                        kind(&value.node).into(),
                    ),
                    value,
                );
            }
        };
        for statement in &index.exports {
            if kind(statement) == "ExportNamedDeclaration" {
                for spec in array(&statement["specifiers"]) {
                    if id(&spec["exported"]) != Some(name) {
                        continue;
                    }
                    if let Some(path) = statement["source"]["value"].as_str() {
                        if let Some(dependency) = resolve_url(module, path) {
                            add(self.exported_inner(
                                &dependency,
                                id(&spec["local"]).unwrap_or(""),
                                &seen,
                            )?);
                        }
                    } else {
                        add(self.local_in(module, id(&spec["local"]).unwrap_or(""), &seen)?);
                    }
                }
                if array(&statement["names"]).iter().any(|n| n == name) {
                    add(self.local_in(module, name, &seen)?);
                }
            } else if kind(statement) == "ExportAllDeclaration" && statement["exported"].is_null() {
                if let Some(dependency) = statement["source"]["value"]
                    .as_str()
                    .and_then(|path| resolve_url(module, path))
                {
                    add(self.exported_inner(&dependency, name, &seen)?);
                }
            }
        }
        ensure!(
            matches.len() <= 1,
            "Claude frontend anchors: static exported binding missing or ambiguous."
        );
        Ok(matches.into_values().next())
    }
    pub fn imported(&self, declaration: &Value, specifier: &Value) -> Result<Option<Resolved>> {
        if kind(specifier) != "ImportSpecifier" {
            return Ok(None);
        }
        let Some(dependency) = declaration["source"]["value"]
            .as_str()
            .and_then(|path| resolve_url(self.url, path))
        else {
            return Ok(None);
        };
        self.exported(&dependency, id(&specifier["imported"]).unwrap_or(""))
    }
    pub fn definition(&self, resolved: &Resolved) -> Result<Value> {
        if resolved.module == self.url {
            return Ok(resolved.node.clone());
        }
        let Some(source) = self.modules.source(&resolved.module) else {
            anyhow::bail!("Defining module is unavailable.")
        };
        let raw = code(source, &resolved.node)?;
        let variable = kind(&resolved.node) == "VariableDeclarator";
        let source = if variable {
            format!("let {raw};")
        } else {
            raw.into()
        };
        let ast = syntax(&source)?;
        Ok(if variable {
            ast["body"][0]["declarations"][0].clone()
        } else {
            ast["body"][0].clone()
        })
    }
    pub fn export_names(&self, module: &str) -> Vec<String> {
        fn collect(
            resolver: &Resolver<'_>,
            module: &str,
            seen: &mut Vec<String>,
            names: &mut BTreeSet<String>,
        ) {
            if seen.len() >= 8 || seen.iter().any(|m| m == module) {
                return;
            }
            let Some(index) = resolver.index(module) else {
                return;
            };
            seen.push(module.into());
            for statement in &index.exports {
                if kind(statement) == "ExportNamedDeclaration" {
                    for spec in array(&statement["specifiers"]) {
                        if let Some(name) = id(&spec["exported"]) {
                            names.insert(name.into());
                        }
                    }
                    for name in array(&statement["names"]) {
                        if let Some(name) = name.as_str() {
                            names.insert(name.into());
                        }
                    }
                } else if kind(statement) == "ExportAllDeclaration"
                    && statement["exported"].is_null()
                {
                    if let Some(dependency) = statement["source"]["value"]
                        .as_str()
                        .and_then(|path| resolve_url(module, path))
                    {
                        collect(resolver, &dependency, seen, names);
                    }
                }
            }
            seen.pop();
        }
        let mut names = BTreeSet::new();
        collect(self, module, &mut vec![], &mut names);
        names.into_iter().collect()
    }
    pub fn imported_api(&self, property_name: &str, native: bool) -> Result<Imported> {
        let mut matches = vec![];
        for declaration in array(&self.ast["body"])
            .iter()
            .filter(|n| kind(n) == "ImportDeclaration")
        {
            for spec in array(&declaration["specifiers"]) {
                let Some(resolved) = self.imported(declaration, spec)? else {
                    continue;
                };
                if kind(&resolved.node) != "VariableDeclarator"
                    || !member(
                        if native {
                            native_api_expression(&resolved.node["init"])
                        } else {
                            &resolved.node["init"]
                        },
                        property_name,
                    )
                {
                    continue;
                }
                if native {
                    if !native_object(&resolved.node["init"]) {
                        continue;
                    }
                } else {
                    let getters = resolved
                        .getters
                        .iter()
                        .filter(|getter| property(getter, property_name))
                        .collect::<Vec<_>>();
                    if getters.is_empty() {
                        continue;
                    }
                    let getter = unique(getters, &format!("React {property_name} public binding"))?;
                    if id(&getter["value"]["body"]) != Some(resolved.local.as_str()) {
                        continue;
                    }
                }
                matches.push(Imported {
                    local: id(&spec["local"]).unwrap_or("").into(),
                    exported: id(&spec["imported"]).unwrap_or("").into(),
                    path: declaration["source"]["value"].as_str().unwrap_or("").into(),
                });
            }
        }
        unique(matches, &format!("{property_name} import"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provenance_follows_named_reexports_and_rejects_ambiguous_native_objects() -> Result<()> {
        let root = format!("{ASSET_ROOT}index-main.js");
        let mut modules = Modules::new();
        for (name, source) in [
            (
                "native.js",
                "const n=globalThis['claude.web']?.LocalSessions;export{n as N};",
            ),
            ("reexport.js", "export{N as API}from'./native.js';"),
        ] {
            let url = format!("{ASSET_ROOT}{name}");
            modules.insert(url.clone(), Module::parse(url, source)?);
        }
        let source = "import{API as local}from'./reexport.js';local?.forkSession;";
        let resolver = Resolver::new(source, &root, &modules)?;
        assert_eq!(resolver.imported_api("LocalSessions", true)?.local, "local");
        let bad = "import{API as a}from'./reexport.js';import{N as b}from'./native.js';";
        assert!(
            Resolver::new(bad, &root, &modules)?
                .imported_api("LocalSessions", true)
                .is_err()
        );
        assert!(resolve_url(&root, "https://other.invalid/test.js").is_none());
        Ok(())
    }
}
