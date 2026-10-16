//! Host-required JavaScript injected into proved vendor modules. This code is
//! data in the native engine, never a fallback engine or a Node invocation.
use crate::{frontend_ast::*, frontend_folders, frontend_owner, platform};
use anyhow::{Context, Result, ensure};
use std::path::Path;

const PROJECTION: &str = include_str!("../../../src/claude-folder-projection.mjs");
const FOLDER: &str = include_str!("../../../src/claude-folder-runtime.mjs");
const HANDOFF: &str = include_str!("../../../src/claude-desktop-handoff-runtime.mjs");
const LOCAL_ANCHOR: &str = include_str!("../../../src/claude-folder-anchor.mjs");
const CHAT: &str = include_str!("../../../src/claude-chat-wake-runtime.mjs");
const OWNER: &str = include_str!("../../../src/claude-owner-wake-runtime.mjs");
fn embedded(source: &str) -> Result<String> {
    let ast = syntax(source)?;
    let mut edits = vec![];
    for statement in array(&ast["body"]) {
        match kind(statement) {
            "ImportDeclaration" => edits.push(Edit::replace(statement, "")),
            "ExportNamedDeclaration" if !statement["declaration"].is_null() => edits.push(Edit {
                start: start(statement),
                end: start(&statement["declaration"]),
                text: String::new(),
            }),
            "ExportNamedDeclaration" | "ExportAllDeclaration" | "ExportDefaultDeclaration" => {
                anyhow::bail!("Unsupported embedded renderer module export.")
            }
            _ => {}
        }
    }
    apply_edits(source, edits)
}
fn path(path: &Path) -> Result<String> {
    platform::absolute(path)?;
    Ok(serde_json::to_string(
        path.to_str().context("Renderer path is not UTF-8.")?,
    )?)
}
fn native(name: &str) -> Result<()> {
    let ast = syntax(&format!("let {name};"))?;
    ensure!(
        id(&ast["body"][0]["declarations"][0]["id"]) == Some(name),
        "Renderer native identifier is not a proved binding."
    );
    Ok(())
}
pub fn folder(
    root: &Path,
    registry: &Path,
    anchor: &frontend_folders::Anchor,
    asset: &str,
) -> Result<String> {
    native(&anchor.native)?;
    let template = r#"const __cldx=(()=>{try{@PROJECTION@
@ANCHOR@
@HANDOFF@
@FOLDER@
const runtime=createClaudeFolderRuntime({readMap:typeof @NATIVE@?.readFileAtCwd==="function"?()=>@NATIVE@.readFileAtCwd(@ROOT@,"folder-map.json"):null,onError:e=>console.warn("[Claudex folder mapping] "+e),createHandoff:o=>createClaudeDesktopHandoffRuntime({...o,registryRoot:@REGISTRY@,readManifest:typeof @NATIVE@?.readFileAtCwd==="function"?()=>@NATIVE@.readFileAtCwd(@ROOT@,"desktop-handoff.json"):null,native:@NATIVE@,normalizeAnchor:typeof normalizeClaudeLocalFolderAnchor==="function"?normalizeClaudeLocalFolderAnchor:undefined,hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex native handoff] "+e),onStatus:e=>console.warn("[Claudex native handoff status] "+e)})});console.warn("[Claudex folder mapping] loaded "+@ASSET@);return{getSnapshot:()=>{try{return runtime.getSnapshot()}catch{return 0}},subscribe:l=>{try{const u=runtime.subscribe(l);return()=>{try{u()}catch{}}}catch{return()=>{}}},subscribeModes:l=>{try{const u=runtime.subscribeModes(l);return()=>{try{u()}catch{}}}catch{return()=>{}}},setModeRows:(r,k)=>{try{runtime.setModeRows(r,k)}catch{}},setRows:(r,k)=>{try{runtime.setRows(r,k)}catch{}},lookup:r=>{try{return runtime.lookup(r)}catch{}}}}catch{try{console.warn("[Claudex folder mapping] disabled")}catch{}return{getSnapshot:()=>0,subscribe:()=>()=>{},subscribeModes:()=>()=>{},setModeRows(){},setRows(){},lookup(){}}}})();"#;
    let mut result = template
        .replace("@NATIVE@", &anchor.native)
        .replace("@ROOT@", &path(root)?)
        .replace("@REGISTRY@", &path(registry)?)
        .replace("@ASSET@", &serde_json::to_string(asset)?);
    // Replace source placeholders last so no path or placeholder inside a
    // trusted embedded module is accidentally interpreted as template input.
    for (marker, source) in [
        ("@PROJECTION@", PROJECTION),
        ("@ANCHOR@", LOCAL_ANCHOR),
        ("@HANDOFF@", HANDOFF),
        ("@FOLDER@", FOLDER),
    ] {
        result = result.replace(marker, &embedded(source)?);
    }
    syntax(&result)?;
    Ok(result)
}
pub fn chat(root: &Path, registry: &Path, native_binding: &str, asset: &str) -> Result<String> {
    native(native_binding)?;
    let template = r#"
;(()=>{try{@RUNTIME@
const wake=createClaudeChatWakeRuntime({native:@NATIVE@,registryRoot:@REGISTRY@,readManifest:()=>@NATIVE@.readFileAtCwd(@ROOT@,"collaboration/chat-mailbox/wake-manifest.json"),hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex chat wake] "+e),onStatus:e=>console.warn("[Claudex chat wake] "+e)});console.warn("[Claudex chat wake] loaded "+@ASSET@);wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});}catch{try{console.warn("[Claudex chat wake] disabled")}catch{}}})();
"#;
    let result = template
        .replace("@NATIVE@", native_binding)
        .replace("@REGISTRY@", &path(registry)?)
        .replace("@ROOT@", &path(root)?)
        .replace("@ASSET@", &serde_json::to_string(asset)?)
        .replace("@RUNTIME@", &embedded(CHAT)?);
    syntax(&result)?;
    Ok(result)
}
pub fn owner(root: &Path, anchor: &frontend_owner::Anchor, asset: &str) -> Result<String> {
    let template = r#"
import{@EXPORT@ as __cldxOwnerWakeClient}from@CLIENT@;
const __cldxOwnerWake=(()=>{try{@RUNTIME@
const local=globalThis["claude.web"]?.LocalSessions;const wake=createClaudeOwnerWakeRuntime({readMap:typeof local?.readFileAtCwd==="function"?()=>local.readFileAtCwd(@ROOT@,"folder-map.json"):undefined,getClient:__cldxOwnerWakeClient,onStatus:e=>console.warn("[Claudex owner wake] "+e)});console.warn("[Claudex owner wake] loaded "+@ASSET@);wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});return{signal(...a){try{const p=wake.signal(...a);if(p&&typeof p.catch==="function")p.catch(()=>{})}catch{}}}}catch{try{console.warn("[Claudex owner wake] disabled")}catch{}return{signal(){}}}})();
"#;
    let result = template
        .replace("@EXPORT@", &anchor.client.exported)
        .replace("@CLIENT@", &serde_json::to_string(&anchor.client.path)?)
        .replace("@ROOT@", &path(root)?)
        .replace("@ASSET@", &serde_json::to_string(asset)?)
        .replace("@RUNTIME@", &embedded(OWNER)?);
    syntax(&result)?;
    Ok(result)
}
