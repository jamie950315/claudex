//! Declaration-based lexical identities for vendor functions. Hoisted vars,
//! patterns, loop/catch bindings and nested writes retain their real scope.
use crate::frontend_ast::{array, end, id, kind, start};
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Key(pub usize, pub usize, pub String);
pub fn key(node: &Value) -> Key {
    Key(start(node), end(node), kind(node).into())
}
#[derive(Debug)]
struct Scope {
    parent: Option<usize>,
    function: usize,
    bindings: HashMap<String, usize>,
}
#[derive(Debug)]
pub struct Declaration<'a> {
    pub id: &'a Value,
    pub kind: String,
    pub node: &'a Value,
}
#[derive(Debug)]
pub struct Binding<'a> {
    pub name: String,
    pub scope: usize,
    pub declarations: Vec<Declaration<'a>>,
    pub identifiers: Vec<&'a Value>,
    pub references: Vec<&'a Value>,
}
pub struct Scopes<'a> {
    scopes: Vec<Scope>,
    owners: HashMap<Key, usize>,
    resolved: HashMap<Key, usize>,
    pub bindings: Vec<Binding<'a>>,
    parents: HashMap<Key, (&'a Value, String)>,
    pending: Vec<(&'a Value, usize)>,
    free: HashMap<String, Vec<&'a Value>>,
}
fn function(node: &Value) -> bool {
    matches!(
        kind(node),
        "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression"
    )
}
impl<'a> Scopes<'a> {
    pub fn analyze(root: &'a Value) -> Self {
        let mut this = Self {
            scopes: vec![],
            owners: HashMap::new(),
            resolved: HashMap::new(),
            bindings: vec![],
            parents: HashMap::new(),
            pending: vec![],
            free: HashMap::new(),
        };
        let top = this.scope(root, None, true);
        if function(root) {
            for parameter in array(&root["params"]) {
                this.pattern(parameter, top, top, "param", root);
            }
            if kind(&root["body"]) == "BlockStatement" {
                for statement in array(&root["body"]["body"]) {
                    this.walk(statement, top, Some((&root["body"], "body")));
                }
            } else {
                this.walk(&root["body"], top, Some((root, "body")));
            }
        } else if kind(root) == "Program" {
            for statement in array(&root["body"]) {
                this.walk(statement, top, Some((root, "body")));
            }
        } else {
            this.walk(root, top, None);
        }
        for (node, scope) in std::mem::take(&mut this.pending) {
            if let Some(binding) = this.lookup(id(node).unwrap(), scope) {
                this.bindings[binding].identifiers.push(node);
                this.bindings[binding].references.push(node);
                this.resolved.insert(key(node), binding);
            } else {
                this.free
                    .entry(id(node).unwrap().into())
                    .or_default()
                    .push(node);
            }
        }
        for binding in &mut this.bindings {
            binding.identifiers.sort_by_key(|node| start(node));
        }
        this
    }
    fn scope(&mut self, node: &Value, parent: Option<usize>, function: bool) -> usize {
        let index = self.scopes.len();
        let function = if function {
            index
        } else {
            parent.map(|p| self.scopes[p].function).unwrap_or(index)
        };
        self.scopes.push(Scope {
            parent,
            function,
            bindings: HashMap::new(),
        });
        self.owners.insert(key(node), index);
        index
    }
    fn declare(&mut self, target: usize, node: &'a Value, kind: &str, declaration: &'a Value) {
        let Some(name) = id(node) else { return };
        let binding = if let Some(binding) = self.scopes[target].bindings.get(name) {
            *binding
        } else {
            let binding = self.bindings.len();
            self.bindings.push(Binding {
                name: name.into(),
                scope: target,
                declarations: vec![],
                identifiers: vec![],
                references: vec![],
            });
            self.scopes[target].bindings.insert(name.into(), binding);
            binding
        };
        self.bindings[binding].declarations.push(Declaration {
            id: node,
            kind: kind.into(),
            node: declaration,
        });
        self.bindings[binding].identifiers.push(node);
        self.resolved.insert(key(node), binding);
    }
    fn pattern(
        &mut self,
        node: &'a Value,
        current: usize,
        target: usize,
        kind_name: &str,
        declaration: &'a Value,
    ) {
        match kind(node) {
            "Identifier" => self.declare(target, node, kind_name, declaration),
            "ObjectPattern" => {
                for property in array(&node["properties"]) {
                    if kind(property) == "RestElement" {
                        self.pattern(
                            &property["argument"],
                            current,
                            target,
                            kind_name,
                            declaration,
                        );
                    } else {
                        if property["computed"] == true {
                            self.walk(&property["key"], current, Some((property, "key")));
                        }
                        self.pattern(&property["value"], current, target, kind_name, declaration);
                    }
                }
            }
            "ArrayPattern" => {
                for element in array(&node["elements"]) {
                    self.pattern(element, current, target, kind_name, declaration);
                }
            }
            "AssignmentPattern" => {
                self.pattern(&node["left"], current, target, kind_name, declaration);
                self.walk(&node["right"], current, Some((node, "right")));
            }
            "RestElement" => {
                self.pattern(&node["argument"], current, target, kind_name, declaration)
            }
            _ => self.walk(node, current, None),
        }
    }
    fn reference(parent: Option<(&Value, &str)>) -> bool {
        let Some((parent, field)) = parent else {
            return true;
        };
        !((kind(parent) == "MemberExpression" && field == "property" && parent["computed"] != true)
            || (matches!(
                kind(parent),
                "Property" | "MethodDefinition" | "PropertyDefinition"
            ) && field == "key"
                && parent["computed"] != true)
            || (matches!(
                kind(parent),
                "LabeledStatement" | "BreakStatement" | "ContinueStatement"
            ) && field == "label")
            || (kind(parent) == "ExportSpecifier" && field == "exported")
            || matches!(
                kind(parent),
                "ImportSpecifier"
                    | "ImportDefaultSpecifier"
                    | "ImportNamespaceSpecifier"
                    | "MetaProperty"
                    | "ImportAttribute"
            ))
    }
    fn children(&mut self, node: &'a Value, current: usize) {
        if let Some(object) = node.as_object() {
            for (field, value) in object {
                if let Some(items) = value.as_array() {
                    for item in items {
                        self.walk(item, current, Some((node, field)));
                    }
                } else if !kind(value).is_empty() {
                    self.walk(value, current, Some((node, field)));
                }
            }
        }
    }
    fn function(&mut self, node: &'a Value, current: usize) {
        let outer = if kind(node) == "FunctionExpression" && !node["id"].is_null() {
            let outer = self.scope(&node["id"], Some(current), false);
            self.declare(outer, &node["id"], "function", node);
            outer
        } else {
            current
        };
        let inner = self.scope(node, Some(outer), true);
        for parameter in array(&node["params"]) {
            self.pattern(parameter, inner, inner, "param", node);
        }
        if kind(&node["body"]) == "BlockStatement" {
            for statement in array(&node["body"]["body"]) {
                self.walk(statement, inner, Some((&node["body"], "body")));
            }
        } else {
            self.walk(&node["body"], inner, Some((node, "body")));
        }
    }
    fn walk(&mut self, node: &'a Value, current: usize, parent: Option<(&'a Value, &str)>) {
        if kind(node).is_empty() {
            return;
        }
        if id(node).is_some() {
            if Self::reference(parent) {
                if let Some((p, k)) = parent {
                    self.parents.insert(key(node), (p, k.into()));
                }
                self.pending.push((node, current));
            }
            return;
        }
        match kind(node) {
            "FunctionDeclaration" => {
                self.declare(current, &node["id"], "function", node);
                self.function(node, current);
            }
            "FunctionExpression" | "ArrowFunctionExpression" => self.function(node, current),
            "ClassDeclaration" | "ClassExpression" => {
                let mut inner = current;
                if !node["id"].is_null() {
                    if kind(node) == "ClassDeclaration" {
                        self.declare(current, &node["id"], "class", node);
                    } else {
                        inner = self.scope(node, Some(current), false);
                        self.declare(inner, &node["id"], "class", node);
                    }
                }
                self.walk(&node["superClass"], inner, Some((node, "superClass")));
                self.walk(&node["body"], inner, Some((node, "body")));
            }
            "VariableDeclaration" => {
                let target = if node["kind"] == "var" {
                    self.scopes[current].function
                } else {
                    current
                };
                for declaration in array(&node["declarations"]) {
                    self.pattern(
                        &declaration["id"],
                        current,
                        target,
                        node["kind"].as_str().unwrap_or(""),
                        declaration,
                    );
                    self.walk(&declaration["init"], current, Some((declaration, "init")));
                }
            }
            "BlockStatement" | "StaticBlock" | "SwitchStatement" => {
                let inner = self.scope(node, Some(current), kind(node) == "StaticBlock");
                if kind(node) == "SwitchStatement" {
                    self.walk(&node["discriminant"], current, Some((node, "discriminant")));
                    for item in array(&node["cases"]) {
                        self.walk(item, inner, Some((node, "cases")));
                    }
                } else {
                    for statement in array(&node["body"]) {
                        self.walk(statement, inner, Some((node, "body")));
                    }
                }
            }
            "ForStatement" | "ForInStatement" | "ForOfStatement" => {
                let inner = self.scope(node, Some(current), false);
                self.children(node, inner);
            }
            "CatchClause" => {
                let inner = self.scope(node, Some(current), false);
                self.pattern(&node["param"], inner, inner, "catch", node);
                self.walk(&node["body"], inner, Some((node, "body")));
            }
            "ImportDeclaration" => {
                for specifier in array(&node["specifiers"]) {
                    self.declare(current, &specifier["local"], "import", specifier);
                }
            }
            "ExportNamedDeclaration" => {
                if node["source"].is_null() {
                    self.children(node, current);
                }
            }
            "ExportAllDeclaration" => {}
            _ => self.children(node, current),
        }
    }
    fn lookup(&self, name: &str, mut scope: usize) -> Option<usize> {
        loop {
            if let Some(binding) = self.scopes[scope].bindings.get(name) {
                return Some(*binding);
            }
            scope = self.scopes[scope].parent?;
        }
    }
    pub fn binding_id(&self, node: &Value) -> Option<usize> {
        self.resolved.get(&key(node)).copied()
    }
    pub fn binding(&self, node: &Value) -> Option<&Binding<'a>> {
        self.binding_id(node).map(|index| &self.bindings[index])
    }
    pub fn use_of(&self, node: &Value) -> Option<(&'a Value, &str)> {
        self.parents
            .get(&key(node))
            .map(|(node, field)| (*node, field.as_str()))
    }
    pub fn same(&self, a: &Value, b: &Value) -> bool {
        id(a).is_some() && id(a) == id(b) && self.binding_id(a) == self.binding_id(b)
    }
    pub fn is_free(&self, node: &Value) -> bool {
        id(node).is_some() && self.binding_id(node).is_none()
    }
    pub fn free(&self, name: &str) -> &[&'a Value] {
        self.free.get(name).map(Vec::as_slice).unwrap_or_default()
    }
    pub fn at(&self, owner: &Value, name: &str) -> Result<Option<usize>> {
        Ok(self.lookup(
            name,
            *self
                .owners
                .get(&key(owner))
                .context("Claude frontend scope: unknown scope owner.")?,
        ))
    }
    pub fn owns(&self, owner: &Value, binding: usize) -> bool {
        self.owners
            .get(&key(owner))
            .is_some_and(|scope| *scope == self.bindings[binding].scope)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend_ast::{nodes, syntax, unique};
    #[test]
    fn declarations_not_minified_spelling_decide_shadowing() -> Result<()> {
        let ast = syntax(
            "function x(a){f(a);if(a){let f;f(a)}for(let f of a)f(a);try{}catch(f){f(a)}function nested(){f(a);var f} return f(a)}",
        )?;
        let function = &ast["body"][0];
        let scopes = Scopes::analyze(function);
        let calls = nodes(function, |n| {
            kind(n) == "CallExpression" && id(&n["callee"]) == Some("f")
        });
        assert_eq!(calls.len(), 6);
        assert!(scopes.is_free(&calls[0]["callee"]));
        for call in &calls[1..5] {
            assert!(!scopes.is_free(&call["callee"]));
        }
        assert!(scopes.is_free(&calls[5]["callee"]));
        let nested = unique(
            nodes(function, |n| {
                kind(n) == "FunctionDeclaration" && id(&n["id"]) == Some("nested")
            }),
            "nested",
        )?;
        assert!(scopes.at(nested, "f")?.is_some());
        assert!(scopes.at(function, "f")?.is_none());
        Ok(())
    }
}
