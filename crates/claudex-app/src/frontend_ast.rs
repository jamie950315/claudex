//! Vendor JavaScript is parsed, never evaluated. All edit offsets are UTF-8
//! byte offsets from Oxc; source preservation does not depend on minified names.
use anyhow::{Result, ensure};
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use serde::Deserialize;
use serde_json::Value;
use std::{borrow::Cow, collections::BTreeSet};

pub const SOURCE_LIMIT: usize = 4 * 1024 * 1024;
pub fn syntax(source: &str) -> Result<Value> {
    ensure!(
        source.len() <= SOURCE_LIMIT,
        "Claude frontend source exceeds its 4 MiB bound."
    );
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs())
        .with_options(ParseOptions {
            preserve_parens: false,
            ..Default::default()
        })
        .parse();
    ensure!(
        !parsed.panicked && parsed.errors.is_empty(),
        "Claude frontend anchors: module syntax rejected."
    );
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    ensure!(
        semantic.errors.is_empty(),
        "Claude frontend anchors: module lexical syntax rejected."
    );
    let serialized = parsed.program.to_estree_js_json(false);
    let serialized = utf16_literals(&serialized);
    let mut decoder = serde_json::Deserializer::from_str(&serialized);
    decoder.disable_recursion_limit();
    let ast = Value::deserialize(serde_stacker::Deserializer::new(&mut decoder))?;
    decoder.end()?;
    Ok(ast)
}
/// ESTree has JavaScript UTF-16 strings, while serde_json strings are Unicode
/// scalar values. Keep an unpaired surrogate as inert, exact escaped data;
/// never turn it into a replacement character or an ASCII anchor candidate.
fn utf16_literals(serialized: &str) -> Cow<'_, str> {
    let bytes = serialized.as_bytes();
    let mut position = 0;
    let mut copied = 0;
    let mut output = String::new();
    fn unit(bytes: &[u8], at: usize) -> Option<u16> {
        if bytes.get(at..at + 2)? != b"\\u" {
            return None;
        }
        let hex = std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?;
        u16::from_str_radix(hex, 16).ok()
    }
    while position < bytes.len() {
        if bytes[position] != b'"' {
            position += 1;
            continue;
        }
        let start = position;
        position += 1;
        let mut opaque = false;
        while position < bytes.len() && bytes[position] != b'"' {
            if bytes[position] != b'\\' {
                position += 1;
                continue;
            }
            if let Some(code) = unit(bytes, position) {
                if (0xd800..=0xdbff).contains(&code) {
                    if unit(bytes, position + 6)
                        .is_some_and(|next| (0xdc00..=0xdfff).contains(&next))
                    {
                        position += 12;
                        continue;
                    }
                    opaque = true;
                } else if (0xdc00..=0xdfff).contains(&code) {
                    opaque = true;
                }
                position += 6;
            } else {
                position += 2;
            }
        }
        position += 1;
        if opaque {
            output.push_str(&serialized[copied..start]);
            output.push_str(
                &serde_json::json!({"__cldxUtf16Escaped": &serialized[start + 1..position - 1]})
                    .to_string(),
            );
            copied = position;
        }
    }
    if copied == 0 {
        Cow::Borrowed(serialized)
    } else {
        output.push_str(&serialized[copied..]);
        Cow::Owned(output)
    }
}
pub fn kind(node: &Value) -> &str {
    node["type"].as_str().unwrap_or("")
}
pub fn id(node: &Value) -> Option<&str> {
    (kind(node) == "Identifier")
        .then(|| node["name"].as_str())
        .flatten()
}
pub fn start(node: &Value) -> usize {
    node["start"].as_u64().unwrap_or(0) as usize
}
pub fn end(node: &Value) -> usize {
    node["end"].as_u64().unwrap_or(0) as usize
}
pub fn array(node: &Value) -> &[Value] {
    node.as_array().map(Vec::as_slice).unwrap_or_default()
}
pub fn unwrap(node: &Value) -> &Value {
    if kind(node) == "ChainExpression" {
        &node["expression"]
    } else {
        node
    }
}
pub fn member(node: &Value, name: &str) -> bool {
    let node = unwrap(node);
    kind(node) == "MemberExpression"
        && node["computed"] != true
        && id(&node["property"]) == Some(name)
}
pub fn property(node: &Value, name: &str) -> bool {
    kind(node) == "Property"
        && node["computed"] != true
        && id(&node["key"]).or(node["key"]["value"].as_str()) == Some(name)
}
pub fn nodes<'a>(root: &'a Value, predicate: impl Fn(&Value) -> bool) -> Vec<&'a Value> {
    fn walk<'a>(root: &'a Value, predicate: &dyn Fn(&Value) -> bool, found: &mut Vec<&'a Value>) {
        if !root.is_object() || kind(root).is_empty() {
            return;
        }
        if predicate(root) {
            found.push(root);
        }
        for (_, value) in root.as_object().unwrap() {
            if let Some(items) = value.as_array() {
                for item in items {
                    walk(item, predicate, found);
                }
            } else if value.is_object() {
                walk(value, predicate, found);
            }
        }
    }
    let mut result = vec![];
    walk(root, &predicate, &mut result);
    result
}
pub fn unique<T>(mut values: Vec<T>, label: &str) -> Result<T> {
    ensure!(
        values.len() == 1,
        "Claude frontend anchors: {label} missing or ambiguous."
    );
    Ok(values.remove(0))
}
pub fn code<'a>(source: &'a str, node: &Value) -> Result<&'a str> {
    source
        .get(start(node)..end(node))
        .ok_or_else(|| anyhow::anyhow!("Invalid frontend source span."))
}
#[derive(Clone, Debug)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}
impl Edit {
    pub fn insert(at: usize, text: impl Into<String>) -> Self {
        Self {
            start: at,
            end: at,
            text: text.into(),
        }
    }
    pub fn replace(node: &Value, text: impl Into<String>) -> Self {
        Self {
            start: start(node),
            end: end(node),
            text: text.into(),
        }
    }
}
pub fn apply_edits(source: &str, mut edits: Vec<Edit>) -> Result<String> {
    edits.sort_by(|a, b| b.start.cmp(&a.start).then(b.end.cmp(&a.end)));
    let mut output = source.to_owned();
    let mut edge = source.len() + 1;
    for edit in edits {
        ensure!(
            edit.start <= edit.end
                && edit.end <= source.len()
                && edit.end <= edge
                && source.is_char_boundary(edit.start)
                && source.is_char_boundary(edit.end),
            "Claude frontend anchors: overlapping transform refused."
        );
        output.replace_range(edit.start..edit.end, &edit.text);
        edge = edit.start;
    }
    syntax(&output)?;
    Ok(output)
}
/// Static imports and re-exports load with an evaluated entry. Literal dynamic
/// imports participate in reachability only, never eager bootstrap selection.
pub fn imports(ast: &Value, eager: bool) -> Vec<String> {
    let candidates = if eager {
        array(&ast["body"])
            .iter()
            .filter(|node| {
                matches!(
                    kind(node),
                    "ImportDeclaration" | "ExportNamedDeclaration" | "ExportAllDeclaration"
                )
            })
            .collect()
    } else {
        nodes(ast, |node| {
            matches!(
                kind(node),
                "ImportDeclaration"
                    | "ExportNamedDeclaration"
                    | "ExportAllDeclaration"
                    | "ImportExpression"
            )
        })
    };
    candidates
        .into_iter()
        .filter_map(|node| node["source"]["value"].as_str().map(str::to_owned))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_proves_static_closure_and_preserves_unicode_byte_offsets() -> Result<()> {
        let source =
            "import{x}from'./a.js';export{x as y}from'./b.js';let s='繁體';import('./lazy.js');";
        let ast = syntax(source)?;
        assert_eq!(imports(&ast, true), vec!["./a.js", "./b.js"]);
        assert_eq!(imports(&ast, false), vec!["./a.js", "./b.js", "./lazy.js"]);
        let literal = unique(nodes(&ast, |n| n["value"] == "繁體"), "unicode literal")?;
        assert_eq!(code(source, literal)?, "'繁體'");
        assert!(apply_edits(source, vec![Edit::replace(literal, "'正體'")])?.contains("'正體'"));
        assert!(syntax("const a=1; let a=2;").is_err());
        assert!(apply_edits(source, vec![Edit::insert(0, "let __cldx=;")]).is_err());
        Ok(())
    }
    #[test]
    fn unpaired_utf16_is_exact_inert_data_not_a_lossy_string_anchor() -> Result<()> {
        let source = r#"let a='\ud800',b='\udc00',c='\ud800\udc00',d='\\ud800',e='�';"#;
        let ast = syntax(source)?;
        let values = array(&ast["body"])[0]["declarations"].as_array().unwrap();
        assert_eq!(values[0]["init"]["value"]["__cldxUtf16Escaped"], r"\ud800");
        assert_eq!(values[1]["init"]["value"]["__cldxUtf16Escaped"], r"\udc00");
        assert_eq!(values[2]["init"]["value"], "𐀀");
        assert_eq!(values[3]["init"]["value"], r"\ud800");
        assert_eq!(values[4]["init"]["value"], "�");
        assert_eq!(code(source, &values[0]["init"])?, r"'\ud800'");
        Ok(())
    }
    #[test]
    fn native_nested_expressions_exceed_the_generic_json_depth_limit() -> Result<()> {
        let source = format!("const value={}0{};", "[".repeat(96), "]".repeat(96));
        let ast = syntax(&source)?;
        assert_eq!(kind(&ast), "Program");
        assert_eq!(
            nodes(&ast, |node| kind(node) == "ArrayExpression").len(),
            96
        );
        Ok(())
    }
    #[test]
    fn parentheses_keep_standard_estree_shapes_and_inner_source_spans() -> Result<()> {
        let source =
            "let out=guard?(value=group(rows),cache[0]=rows,cache[1]=value):value=cache[1];";
        let ast = syntax(source)?;
        assert!(nodes(&ast, |node| kind(node) == "ParenthesizedExpression").is_empty());
        let branch = &ast["body"][0]["declarations"][0]["init"]["consequent"];
        assert_eq!(kind(branch), "SequenceExpression");
        assert_eq!(
            code(source, branch)?,
            "value=group(rows),cache[0]=rows,cache[1]=value"
        );
        Ok(())
    }
}
