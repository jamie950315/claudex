//! Code-session owner wake proof: exact selection, retained native send and
//! already-attached stdio client. No vendor code or model input is executed.
use crate::{
    frontend_anchors::{callback, function_bindings, has_member, is_function, scope_nodes},
    frontend_ast::*,
    frontend_bindings::{ModuleGraph, Resolver, resolve_url},
    frontend_scope::{self, Key, Scopes},
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum ReturnArgument {
    Index(usize),
    Last,
}
fn identity_helper(mut function: &Value) -> Option<ReturnArgument> {
    if kind(function) == "VariableDeclarator" {
        function = &function["init"];
    }
    if !is_function(function) || function["async"] == true || function["generator"] == true {
        return None;
    }
    let parameters = array(&function["params"]);
    let rest = parameters
        .last()
        .filter(|n| kind(n) == "RestElement")
        .map(|n| &n["argument"]);
    let fixed = if rest.is_some() {
        &parameters[..parameters.len() - 1]
    } else {
        parameters
    };
    if fixed.is_empty()
        || !fixed.iter().all(|n| id(n).is_some())
        || rest.is_some_and(|n| id(n).is_none())
    {
        return None;
    }
    let scopes = Scopes::analyze(function);
    let parameter = |node: &Value| {
        scopes
            .binding(node)
            .is_some_and(|binding| binding.declarations.iter().any(|d| d.kind == "param"))
    };
    let all = nodes(&function["body"], |_| true);
    if all.iter().any(|n| {
        matches!(
            kind(n),
            "CallExpression"
                | "NewExpression"
                | "AwaitExpression"
                | "YieldExpression"
                | "TaggedTemplateExpression"
                | "ImportExpression"
                | "ThrowStatement"
                | "ClassExpression"
                | "ClassDeclaration"
                | "FunctionDeclaration"
                | "FunctionExpression"
                | "ArrowFunctionExpression"
                | "ThisExpression"
                | "MetaProperty"
                | "WithStatement"
        ) || kind(n) == "UnaryExpression" && n["operator"] == "delete"
            || id(n).is_some() && scopes.is_free(n) && scopes.use_of(n).is_some()
    }) {
        return None;
    }
    for node in &all {
        let target = match kind(node) {
            "AssignmentExpression" => Some(&node["left"]),
            "UpdateExpression" => Some(&node["argument"]),
            "ForInStatement" | "ForOfStatement" if kind(&node["left"]) != "VariableDeclaration" => {
                Some(&node["left"])
            }
            _ => None,
        };
        let Some(target) = target else { continue };
        if id(target).is_some() {
            if parameter(target) {
                return None;
            }
        } else if kind(target) != "MemberExpression"
            || target["computed"] != true
            || id(&target["object"]).is_none()
            || scopes.binding_id(&target["object"]) != scopes.binding_id(&fixed[0])
        {
            return None;
        }
    }
    let returned = if kind(&function["body"]) == "BlockStatement" {
        nodes(&function["body"], |n| kind(n) == "ReturnStatement")
            .into_iter()
            .map(|n| &n["argument"])
            .collect::<Vec<_>>()
    } else {
        vec![&function["body"]]
    };
    let mut results = HashSet::new();
    for value in returned {
        let result = if kind(value) == "SequenceExpression" {
            array(&value["expressions"]).last()?
        } else {
            value
        };
        let returned = if id(result).is_some()
            && parameter(result)
            && !rest.is_some_and(|rest| scopes.same(result, rest))
        {
            ReturnArgument::Index(
                fixed
                    .iter()
                    .position(|p| scopes.binding_id(p) == scopes.binding_id(result))?,
            )
        } else if let Some(rest) = rest {
            if kind(result) != "MemberExpression"
                || result["computed"] != true
                || !scopes.same(&result["object"], rest)
                || kind(&result["property"]) != "BinaryExpression"
                || result["property"]["operator"] != "-"
                || !member(&result["property"]["left"], "length")
                || !scopes.same(&result["property"]["left"]["object"], rest)
                || result["property"]["right"]["value"] != 1
            {
                return None;
            }
            ReturnArgument::Last
        } else {
            return None;
        };
        results.insert(returned);
    }
    (results.len() == 1).then(|| *results.iter().next().unwrap())
}
fn slot(node: &Value) -> bool {
    kind(node) == "MemberExpression"
        && node["computed"] == true
        && id(&node["object"]).is_some()
        && node["property"]["value"].as_u64().is_some_and(|n| n < 4096)
}
struct Store<'a> {
    cache: &'a Value,
    first: i64,
    last: i64,
}
struct Flow<'a> {
    functions: HashMap<Key, &'a Value>,
    slots: Vec<&'a Value>,
    stores: Vec<Store<'a>>,
    active: HashSet<usize>,
    steps: usize,
    depth: usize,
    unknown: bool,
}
impl<'a> Flow<'a> {
    fn new(active: HashSet<usize>) -> Self {
        Self {
            functions: HashMap::new(),
            slots: vec![],
            stores: vec![],
            active,
            steps: 0,
            depth: 0,
            unknown: false,
        }
    }
}
struct Callbacks<'a, 'b> {
    component: &'a Value,
    resolver: &'b Resolver<'b>,
    scopes: Scopes<'a>,
    writes: Vec<&'a Value>,
    targets: HashSet<Key>,
    helpers: HashMap<String, Option<ReturnArgument>>,
}
impl<'a, 'b> Callbacks<'a, 'b> {
    fn new(component: &'a Value, resolver: &'b Resolver<'b>) -> Self {
        fn target(node: &Value, targets: &mut HashSet<Key>) {
            if id(node).is_some() {
                targets.insert(frontend_scope::key(node));
            } else {
                match kind(node) {
                    "ObjectPattern" => {
                        for p in array(&node["properties"]) {
                            target(
                                if kind(p) == "RestElement" {
                                    &p["argument"]
                                } else {
                                    &p["value"]
                                },
                                targets,
                            );
                        }
                    }
                    "ArrayPattern" => {
                        for element in array(&node["elements"]) {
                            target(element, targets);
                        }
                    }
                    "AssignmentPattern" => target(&node["left"], targets),
                    "RestElement" => target(&node["argument"], targets),
                    _ => {}
                }
            }
        }
        let writes = nodes(component, |n| {
            matches!(
                kind(n),
                "AssignmentExpression" | "ForInStatement" | "ForOfStatement" | "UpdateExpression"
            )
        });
        let mut targets = HashSet::new();
        for write in &writes {
            target(
                if kind(write) == "UpdateExpression" {
                    &write["argument"]
                } else {
                    &write["left"]
                },
                &mut targets,
            );
        }
        Self {
            component,
            resolver,
            scopes: Scopes::analyze(component),
            writes,
            targets,
            helpers: HashMap::new(),
        }
    }
    fn definitions(&self, node: &Value) -> Vec<&'a Value> {
        let Some(binding) = self.scopes.binding(node) else {
            return vec![];
        };
        let mut rows = vec![];
        for declaration in &binding.declarations {
            if kind(declaration.node) != "VariableDeclarator"
                || frontend_scope::key(&declaration.node["id"])
                    != frontend_scope::key(declaration.id)
            {
                return vec![];
            }
            rows.push(declaration.node);
        }
        for reference in &binding.references {
            if !self.targets.contains(&frontend_scope::key(reference)) {
                continue;
            }
            let Some((parent, key)) = self.scopes.use_of(reference) else {
                return vec![];
            };
            if kind(parent) != "AssignmentExpression" || key != "left" || parent["operator"] != "="
            {
                return vec![];
            }
            rows.push(parent);
        }
        rows.sort_by_key(|node| start(node));
        rows
    }
    fn helper(&mut self, call: &Value) -> Option<ReturnArgument> {
        let name = id(&call["callee"])?;
        if !self.scopes.is_free(&call["callee"])
            || array(&call["arguments"])
                .iter()
                .any(|n| kind(n) == "SpreadElement")
        {
            return None;
        }
        if let Some(summary) = self.helpers.get(name) {
            return *summary;
        }
        let summary = self
            .resolver
            .local(name)
            .ok()
            .flatten()
            .and_then(|resolved| self.resolver.definition(&resolved).ok())
            .and_then(|definition| identity_helper(&definition));
        self.helpers.insert(name.into(), summary);
        summary
    }
    fn flow(&mut self, node: &'a Value, state: &mut Flow<'a>) {
        state.steps += 1;
        if node.is_null() || state.unknown || state.steps > 96 {
            state.unknown = true;
            return;
        }
        if callback(node) {
            state.functions.insert(frontend_scope::key(node), node);
            return;
        }
        if id(node).is_some() {
            let Some(binding) = self.scopes.binding_id(node) else {
                state.unknown = true;
                return;
            };
            if state.active.contains(&binding) {
                return;
            }
            let rows = self.definitions(node);
            let values = rows
                .into_iter()
                .filter_map(|row| {
                    row.get("init")
                        .filter(|v| !v.is_null())
                        .or_else(|| row.get("right"))
                })
                .collect::<Vec<_>>();
            if values.is_empty() || state.depth >= 12 {
                state.unknown = true;
                return;
            }
            state.active.insert(binding);
            state.depth += 1;
            for value in values {
                self.flow(value, state);
            }
            state.depth -= 1;
            state.active.remove(&binding);
            return;
        }
        match kind(node) {
            "SequenceExpression" => {
                if let Some(last) = array(&node["expressions"]).last() {
                    self.flow(last, state);
                } else {
                    state.unknown = true;
                }
            }
            "ConditionalExpression" => {
                self.flow(&node["consequent"], state);
                self.flow(&node["alternate"], state);
            }
            "MemberExpression" if slot(node) => state.slots.push(node),
            "CallExpression" => {
                let Some(summary) = self.helper(node) else {
                    state.unknown = true;
                    return;
                };
                let args = array(&node["arguments"]);
                let Some(first) = node["arguments"][1]["value"].as_i64() else {
                    state.unknown = true;
                    return;
                };
                if id(&node["arguments"][0]).is_none() {
                    state.unknown = true;
                    return;
                }
                let index = match summary {
                    ReturnArgument::Index(index) => index,
                    ReturnArgument::Last => args.len().saturating_sub(1),
                };
                if index < 2 || index >= args.len() {
                    state.unknown = true;
                    return;
                }
                state.stores.push(Store {
                    cache: &args[0],
                    first,
                    last: first + args.len() as i64 - 3,
                });
                self.flow(&args[index], state);
            }
            _ => state.unknown = true,
        }
    }
    fn resolve(&mut self, value: &'a Value) -> Vec<&'a Value> {
        let mut state = Flow::new(HashSet::new());
        self.flow(value, &mut state);
        if state.unknown || state.functions.len() != 1 {
            return vec![];
        }
        let callback = *state.functions.values().next().unwrap();
        let callback_key = frontend_scope::key(callback);
        let own = if id(value).is_some() {
            self.scopes.binding_id(value)
        } else {
            None
        };
        for read in state.slots {
            let direct = self
                .writes
                .iter()
                .copied()
                .filter(|node| {
                    kind(node) == "AssignmentExpression"
                        && slot(&node["left"])
                        && self.scopes.same(&node["left"]["object"], &read["object"])
                        && node["left"]["property"]["value"] == read["property"]["value"]
                })
                .collect::<Vec<_>>();
            for write in &direct {
                if write["operator"] != "=" {
                    return vec![];
                }
                let mut stored = Flow::new(own.into_iter().collect());
                self.flow(&write["right"], &mut stored);
                if stored.unknown
                    || !stored.slots.is_empty()
                    || stored.functions.keys().any(|key| *key != callback_key)
                    || stored.functions.is_empty()
                        && !(own.is_some() && self.scopes.binding_id(&write["right"]) == own)
                {
                    return vec![];
                }
            }
            let index = read["property"]["value"].as_i64().unwrap();
            if direct.is_empty()
                && !state.stores.iter().any(|store| {
                    self.scopes.same(store.cache, &read["object"])
                        && store.first <= index
                        && index <= store.last
                })
            {
                return vec![];
            }
        }
        vec![callback]
    }
}
#[derive(Clone, Debug)]
pub struct Variant {
    pub component: Value,
    pub send: Value,
    pub reference: String,
    pub read: String,
    pub selection_end: usize,
    pub getter: Option<String>,
    pub retained_ref: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Client {
    pub path: String,
    pub exported: String,
}
#[derive(Clone, Debug)]
pub struct Anchor {
    pub variants: Vec<Variant>,
    pub component_binding: String,
    pub effect: String,
    pub client: Client,
    pub component_candidates: usize,
    pub proven_components: usize,
}
#[derive(Clone)]
struct Retained<'a> {
    seed: &'a Value,
    end: usize,
    name: String,
}
struct Read<'a> {
    seed: &'a Value,
    end: usize,
    names: Vec<&'a Value>,
    getter: Option<String>,
    retained_ref: Option<String>,
}
struct Prover<'a, 'b> {
    callbacks: Callbacks<'a, 'b>,
    effect: &'b str,
    selected: HashSet<usize>,
    use_ref: Option<String>,
    retained: HashMap<usize, Option<Retained<'a>>>,
}
impl<'a, 'b> Prover<'a, 'b> {
    fn selection(&self, node: &'a Value) -> Option<&'a Value> {
        let binding = self.callbacks.scopes.binding_id(node)?;
        (self.selected.contains(&binding)
            && self
                .callbacks
                .definitions(node)
                .iter()
                .any(|n| kind(n) == "VariableDeclarator")
            && self
                .callbacks
                .scopes
                .owns(self.callbacks.component, binding))
        .then_some(node)
    }
    fn statement(&self, node: &Value) -> Option<&'a Value> {
        array(&self.callbacks.component["body"]["body"])
            .iter()
            .find(|n| start(n) <= start(node) && end(n) >= end(node))
    }
    fn retained_ref(&mut self, node: &'a Value) -> Option<Retained<'a>> {
        let binding = self.callbacks.scopes.binding_id(node)?;
        if let Some(saved) = self.retained.get(&binding) {
            return saved.clone();
        }
        self.retained.insert(binding, None);
        let rows = self.callbacks.definitions(node);
        let declaration = *rows.first()?;
        let init = &declaration["init"];
        let seed = self.selection(&init["arguments"][0])?;
        if rows.len() != 1
            || kind(declaration) != "VariableDeclarator"
            || kind(init) != "CallExpression"
            || array(&init["arguments"]).len() != 1
            || !self.callbacks.scopes.is_free(&init["callee"])
        {
            return None;
        }
        if self.use_ref.is_none() {
            self.use_ref = self
                .callbacks
                .resolver
                .imported_api("useRef", false)
                .ok()
                .map(|api| api.local);
        }
        if id(&init["callee"]) != self.use_ref.as_deref() {
            return None;
        }
        let identifiers = self.callbacks.scopes.bindings[binding].identifiers.clone();
        for identifier in identifiers {
            if frontend_scope::key(identifier) == frontend_scope::key(&declaration["id"]) {
                continue;
            }
            let (parent, key) = self.callbacks.scopes.use_of(identifier)?;
            if kind(parent) != "MemberExpression" || key != "object" || !member(parent, "current") {
                return None;
            }
        }
        let calls = scope_nodes(self.callbacks.component, |n| {
            kind(n) == "CallExpression"
                && id(&n["callee"]) == Some(self.effect)
                && self.callbacks.scopes.is_free(&n["callee"])
                && array(&n["arguments"]).len() == 2
                && kind(&n["arguments"][1]) == "ArrayExpression"
                && array(&n["arguments"][1]["elements"]).len() == 1
                && self
                    .callbacks
                    .scopes
                    .same(&n["arguments"][1]["elements"][0], seed)
        });
        let mut mirrors = vec![];
        for call in calls {
            for callback in self.callbacks.resolve(&call["arguments"][0]) {
                let body = &callback["body"];
                let statement = if kind(body) == "BlockStatement" && array(&body["body"]).len() == 1
                {
                    &body["body"][0]
                } else {
                    &Value::Null
                };
                let write = if kind(body) == "BlockStatement" {
                    if kind(statement) == "ExpressionStatement" {
                        &statement["expression"]
                    } else {
                        &Value::Null
                    }
                } else {
                    body
                };
                if callback["async"] != true
                    && array(&callback["params"]).is_empty()
                    && kind(write) == "AssignmentExpression"
                    && write["operator"] == "="
                    && member(&write["left"], "current")
                    && self.callbacks.scopes.binding_id(&write["left"]["object"]) == Some(binding)
                    && self.callbacks.scopes.same(&write["right"], seed)
                {
                    mirrors.push((call, &write["left"]));
                }
            }
        }
        let writes = nodes(self.callbacks.component, |n| {
            matches!(kind(n), "AssignmentExpression" | "UpdateExpression")
                || kind(n) == "UnaryExpression" && n["operator"] == "delete"
        })
        .into_iter()
        .map(|n| unwrap(n.get("left").unwrap_or(&n["argument"])))
        .filter(|n| {
            kind(n) == "MemberExpression"
                && self.callbacks.scopes.binding_id(&n["object"]) == Some(binding)
        })
        .collect::<Vec<_>>();
        let boundaries = mirrors
            .iter()
            .filter_map(|(call, _)| self.statement(call))
            .filter(|n| kind(n) == "ExpressionStatement" && start(n) > end(declaration))
            .collect::<Vec<_>>();
        if boundaries.is_empty()
            || writes.iter().any(|n| {
                !mirrors
                    .iter()
                    .any(|(_, write)| frontend_scope::key(write) == frontend_scope::key(n))
            })
        {
            return None;
        }
        let retained = Retained {
            seed,
            end: end(boundaries[0]),
            name: self.callbacks.scopes.bindings[binding].name.clone(),
        };
        self.retained.insert(binding, Some(retained.clone()));
        Some(retained)
    }
    fn session_read(&mut self, node: &'a Value, depth: usize) -> Option<Read<'a>> {
        let node = unwrap(node);
        if node.is_null() || depth > 4 {
            return None;
        }
        if member(node, "current") && node["optional"] != true && id(&node["object"]).is_some() {
            let retained = self.retained_ref(&node["object"])?;
            return Some(Read {
                seed: retained.seed,
                end: retained.end,
                names: vec![&node["object"]],
                getter: None,
                retained_ref: (depth == 0).then_some(retained.name),
            });
        }
        if kind(node) != "CallExpression"
            || !array(&node["arguments"]).is_empty()
            || id(&node["callee"]).is_none()
        {
            return None;
        }
        let rows = self.callbacks.definitions(&node["callee"]);
        let getter = *rows.first()?;
        let wrapper = retained_submit_wrapper(&self.callbacks).ok()?;
        if rows.len() != 1
            || kind(getter) != "VariableDeclarator"
            || kind(&getter["init"]) != "CallExpression"
            || !self
                .callbacks
                .scopes
                .same(&getter["init"]["callee"], &wrapper["init"]["callee"])
            || array(&getter["init"]["arguments"]).len() != 1
        {
            return None;
        }
        let readers = self
            .callbacks
            .resolve(&getter["init"]["arguments"][0])
            .into_iter()
            .filter(|callback| callback["async"] != true && array(&callback["params"]).is_empty())
            .collect::<Vec<_>>();
        if readers.len() != 1 {
            return None;
        }
        let body = &readers[0]["body"];
        let value = if kind(body) != "BlockStatement" {
            body
        } else if array(&body["body"]).len() == 1 && kind(&body["body"][0]) == "ReturnStatement" {
            &body["body"][0]["argument"]
        } else {
            return None;
        };
        let statement = self.statement(getter)?;
        let inner = if let Some(seed) = self.selection(value) {
            Read {
                seed,
                end: 0,
                names: vec![],
                getter: None,
                retained_ref: None,
            }
        } else {
            self.session_read(value, depth + 1)?
        };
        if kind(statement) != "VariableDeclaration" {
            return None;
        }
        let getter_name =
            (depth == 0 && inner.names.is_empty()).then(|| id(&getter["id"]).unwrap().to_owned());
        let mut names = vec![&node["callee"]];
        names.extend(inner.names);
        Some(Read {
            seed: inner.seed,
            end: inner.end.max(end(statement)),
            names,
            getter: getter_name,
            retained_ref: None,
        })
    }
}
fn retained_submit_wrapper<'a>(callbacks: &Callbacks<'a, '_>) -> Result<&'a Value> {
    let submit = unique(
        nodes(callbacks.component, |n| property(n, "submitMessage")),
        "Code imperative submit",
    )?;
    let call = unique(
        nodes(&submit["value"], |n| {
            kind(n) == "CallExpression" && id(&n["callee"]).is_some()
        }),
        "Code submit callback",
    )?;
    unique(
        callbacks
            .definitions(&call["callee"])
            .into_iter()
            .filter(|n| {
                kind(n) == "VariableDeclarator"
                    && kind(&n["init"]) == "CallExpression"
                    && id(&n["init"]["callee"]).is_some()
                    && array(&n["init"]["arguments"]).len() == 1
            })
            .collect(),
        "Code retained submit wrapper",
    )
}
fn prove_component(component: &Value, resolver: &Resolver<'_>, effect: &str) -> Result<Variant> {
    let mut callbacks = Callbacks::new(component, resolver);
    ensure!(
        callbacks.scopes.at(component, effect)?.is_none(),
        "Claude frontend anchors: Code effect lexical binding missing or ambiguous."
    );
    let wrapper = retained_submit_wrapper(&callbacks)?;
    let send = unique(
        callbacks.resolve(&wrapper["init"]["arguments"][0]),
        "Code retained send callback",
    )?;
    ensure!(
        send["async"] == true
            && kind(&send["body"]) == "BlockStatement"
            && has_member(send, "waitForImagesReady"),
        "Claude frontend anchors: Code async send missing or ambiguous."
    );
    let selected = scope_nodes(component, |n| {
        member(n, "id") && id(&unwrap(n)["object"]).is_some()
    })
    .into_iter()
    .filter_map(|n| callbacks.scopes.binding_id(&unwrap(n)["object"]))
    .collect();
    let mut prover = Prover {
        callbacks,
        effect,
        selected,
        use_ref: None,
        retained: HashMap::new(),
    };
    let mut identities = vec![];
    for read in scope_nodes(send, |n| {
        kind(n) == "VariableDeclarator" && !n["init"].is_null()
    }) {
        let Some(proof) = prover.session_read(&read["init"], 0) else {
            continue;
        };
        let Some(binding) = prover.callbacks.scopes.binding_id(proof.seed) else {
            continue;
        };
        if !prover.callbacks.scopes.bindings[binding]
            .declarations
            .iter()
            .all(|d| end(d.node) <= proof.end)
            || proof.names.is_empty()
            || prover
                .callbacks
                .scopes
                .at(send, id(proof.names[0]).unwrap())?
                != prover.callbacks.scopes.binding_id(proof.names[0])
        {
            continue;
        }
        identities.push((
            binding,
            Variant {
                component: component.clone(),
                send: send.clone(),
                reference: id(proof.seed).unwrap().into(),
                read: code(resolver.source, unwrap(&read["init"]))?.into(),
                selection_end: proof.end,
                getter: proof.getter,
                retained_ref: proof.retained_ref,
            },
        ));
    }
    ensure!(
        identities
            .iter()
            .map(|(binding, _)| binding)
            .collect::<HashSet<_>>()
            .len()
            == 1,
        "Claude frontend anchors: Code selection and native send identity missing or ambiguous."
    );
    let end = identities
        .iter()
        .map(|(_, v)| v.selection_end)
        .max()
        .unwrap();
    let mut result = identities.remove(0).1;
    result.selection_end = end;
    Ok(result)
}
fn attached_client_lookup(lookup: &Value) -> Result<bool> {
    if kind(lookup) != "FunctionDeclaration"
        || array(&lookup["params"]).len() != 1
        || id(&lookup["params"][0]).is_none()
        || nodes(lookup, |n| {
            kind(n) == "ForOfStatement"
                && kind(&n["right"]) == "CallExpression"
                && member(&n["right"]["callee"], "entries")
                && id(&n["right"]["callee"]["object"]) == Some("Object")
                && member(&n["right"]["arguments"][0], "localClients")
        })
        .is_empty()
    {
        return Ok(false);
    }
    let row_loop = unique(
        nodes(lookup, |n| kind(n) == "ForOfStatement"),
        "stdio client loop",
    )?;
    let declaration = unique(
        nodes(&row_loop["left"], |n| kind(n) == "ObjectPattern"),
        "stdio client record",
    )?;
    let uuid = id(&unique(
        array(&declaration["properties"])
            .iter()
            .filter(|n| property(n, "uuid"))
            .collect(),
        "stdio UUID",
    )?["value"]);
    let client = id(&unique(
        array(&declaration["properties"])
            .iter()
            .filter(|n| property(n, "client"))
            .collect(),
        "stdio client",
    )?["value"]);
    let test = &row_loop["body"];
    ensure!(
        uuid.is_some()
            && client.is_some()
            && kind(test) == "IfStatement"
            && kind(&test["test"]) == "BinaryExpression"
            && test["test"]["operator"] == "==="
            && id(&test["test"]["left"]) == uuid
            && id(&test["test"]["right"]) == id(&lookup["params"][0])
            && kind(&test["consequent"]) == "ReturnStatement"
            && id(&test["consequent"]["argument"]) == client
            && nodes(lookup, |n| kind(n) == "ReturnStatement").len() == 1,
        "Claude frontend anchors: stdio exact UUID return missing or ambiguous."
    );
    ensure!(
        !nodes(lookup, |n| kind(n) == "CallExpression")
            .iter()
            .any(|n| !member(&n["callee"], "getState") && !member(&n["callee"], "entries")),
        "Claude frontend anchors: stdio read-only lookup missing or ambiguous."
    );
    Ok(true)
}
pub fn anchors(source: &str, url: &str, graph: &dyn ModuleGraph) -> Result<Anchor> {
    let resolver = Resolver::new(source, url, graph)?;
    let effect = resolver.imported_api("useEffect", false)?.local;
    let plausible = |component: &Value| {
        !nodes(component, |n| property(n, "submitMessage")).is_empty()
            && !nodes(component, |n| property(n, "getComposerSnapshot")).is_empty()
            && !nodes(component, |n| property(n, "sessionType")).is_empty()
            && !nodes(component, |n| property(n, "initialSessionId")).is_empty()
            && has_member(component, "waitForImagesReady")
    };
    let wrapped = array(&resolver.ast["body"])
        .iter()
        .filter(|n| kind(n) == "VariableDeclaration")
        .flat_map(|n| array(&n["declarations"]))
        .any(|d| {
            kind(&d["init"]) == "CallExpression"
                && id(&d["init"]["callee"]).is_some()
                && array(&d["init"]["arguments"]).len() == 1
                && callback(&d["init"]["arguments"][0])
                && plausible(&d["init"]["arguments"][0])
        });
    let wrapper = if wrapped {
        Some(resolver.imported_api("memo", false)?.local)
    } else {
        None
    };
    let candidates = function_bindings(&resolver.ast, true, wrapper.as_deref())
        .into_iter()
        .filter(|binding| binding.variants.iter().any(plausible))
        .collect::<Vec<_>>();
    let count = candidates.len();
    let mut proven = vec![];
    let mut refused = vec![];
    for candidate in candidates {
        let variants = if candidate.variants.iter().all(plausible) {
            candidate
                .variants
                .iter()
                .map(|component| prove_component(component, &resolver, &effect))
                .collect::<Result<Vec<_>>>()
        } else {
            Err(anyhow::anyhow!(
                "Claude frontend anchors: Code session component branches missing or ambiguous."
            ))
        };
        match variants {
            Ok(variants) => proven.push((candidate.name, variants)),
            Err(error) => refused.push(error),
        }
    }
    if proven.is_empty() && count == 1 {
        return Err(refused.remove(0));
    }
    let proven_count = proven.len();
    let (component_binding, variants) = unique(proven, "Code session component binding")?;
    let mut matches = vec![];
    for import in array(&resolver.ast["body"])
        .iter()
        .filter(|n| kind(n) == "ImportDeclaration")
    {
        let Some(path) = import["source"]["value"].as_str() else {
            continue;
        };
        let Some(dependency) = resolve_url(url, path) else {
            continue;
        };
        for exported in resolver.export_names(&dependency) {
            let Some(resolved) = resolver.exported(&dependency, &exported)? else {
                continue;
            };
            let Some(source) = (if resolved.module == url {
                Some(source)
            } else {
                graph.source(&resolved.module)
            }) else {
                continue;
            };
            let body = code(source, &resolved.node)?;
            if body.contains("localClients")
                && body.contains("Object.entries")
                && attached_client_lookup(&resolver.definition(&resolved)?)?
            {
                matches.push(Client {
                    path: path.into(),
                    exported,
                });
            }
        }
    }
    Ok(Anchor {
        variants,
        component_binding,
        effect,
        client: unique(matches, "Code attached stdio lookup module")?,
        component_candidates: count,
        proven_components: proven_count,
    })
}
pub fn transform(source: &str, anchor: &Anchor, bootstrap: &str) -> Result<String> {
    let mut edits = vec![];
    for variant in &anchor.variants {
        edits.push(Edit::insert(variant.selection_end,format!(";{}(()=>{{try{{void __cldxOwnerWake.signal({}?.id,\"selection\",{}?.type)}}catch{{}}}},[{}?.id,{}?.type]);",anchor.effect,variant.reference,variant.reference,variant.reference,variant.reference)));
        edits.push(Edit::insert(start(&variant.send["body"])+1,format!("try{{const ref={};void __cldxOwnerWake.signal(ref?.id,\"submit\",ref?.type)}}catch{{}}",variant.read)));
    }
    edits.push(Edit::insert(source.len(), bootstrap));
    apply_edits(source, edits)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_helper_body_decides_returned_argument() -> Result<()> {
        for (source, index) in [
            (
                "function store(c,i,d,v){return c[i]=d,c[i+1]=v,v}",
                ReturnArgument::Index(3),
            ),
            (
                "function store(c,i,v,d){return c[i]=d,c[i+1]=v,v}",
                ReturnArgument::Index(2),
            ),
            (
                "function store(c,i,...args){for(let j=0;j<args.length;j++)c[i+j]=args[j];return args[args.length-1]}",
                ReturnArgument::Last,
            ),
        ] {
            let ast = syntax(source)?;
            assert_eq!(identity_helper(&ast["body"][0]), Some(index));
        }
        let ast = syntax("function store(c,i,d,v){other();return v}")?;
        assert_eq!(identity_helper(&ast["body"][0]), None);
        Ok(())
    }
}
