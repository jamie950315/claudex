//! Pinned SDK 0.3.281 managed-field presence normalization. The descriptor is
//! data only: no JavaScript or policy helper is evaluated at runtime.
use anyhow::{Result, ensure};
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

fn descriptor() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../data/maintenance-settings-sdk-0.3.281.json"
        ))
        .expect("Pinned policy schema is valid JSON")
    })
}
fn node(reference: &Value) -> &'static Value {
    &descriptor()["nodes"][reference["$ref"].as_u64().expect("Pinned schema reference") as usize]
}
type Parsed = std::result::Result<Option<Value>, ()>;
fn re(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|re| re.is_match(value))
}
fn str_len(value: &Value) -> Option<usize> {
    value
        .as_str()
        .map(|s| s.encode_utf16().count())
        .or_else(|| value.as_array().map(Vec::len))
}
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn input_control(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control()
            || matches!(c,'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
    })
}
fn permission(value: &Value, allow: bool) -> bool {
    let Some(raw) = value.as_str() else {
        return false;
    };
    if raw.trim().is_empty() {
        return false;
    }
    let positions = |text: &str, needle: u8| {
        text.bytes()
            .enumerate()
            .filter_map(|(i, b)| {
                (b == needle
                    && text.as_bytes()[..i]
                        .iter()
                        .rev()
                        .take_while(|b| **b == b'\\')
                        .count()
                        % 2
                        == 0)
                    .then_some(i)
            })
            .collect::<Vec<_>>()
    };
    let open = positions(raw, b'(').first().copied();
    let close = positions(raw, b')').last().copied();
    let (tool, content) = match (open, close) {
        (None, None) => (raw, None),
        (Some(a), Some(b)) if b > a && b == raw.len() - 1 && !raw[..a].contains(['(', ')']) => {
            if a == 0 || a + 1 == b {
                return false;
            }
            (&raw[..a], Some(&raw[a + 1..b]))
        }
        _ => return false,
    };
    let tool = match tool {
        "Task" => "Agent",
        "KillShell" | "KillBash" => "TaskStop",
        "ListPeers" => "ListAgents",
        "Brief" => "SendUserMessage",
        "ListMcpResources" => "ListMcpResourcesTool",
        "ReadMcpResource" => "ReadMcpResourceTool",
        "ReadMcpResourceDir" => "ReadMcpResourceDirTool",
        v => v,
    };
    let wildcard = |s: &str| s.contains('*');
    let mcp = tool
        .strip_prefix("mcp__")
        .filter(|s| !s.split("__").next().unwrap_or("").is_empty());
    if allow
        && wildcard(tool)
        && !mcp.is_some_and(|s| !wildcard(s.split("__").next().unwrap_or("")))
    {
        return false;
    }
    if mcp.is_some() {
        return content.is_none();
    }
    if tool.is_empty()
        || !tool.contains('_')
            && tool
                .chars()
                .next()
                .is_some_and(|c| c.to_uppercase().to_string() != c.to_string())
    {
        return false;
    }
    if let Some(raw_content) = content {
        if re(r"(?:^|[^\\])\\[()]", raw_content)
            && positions(raw_content, b'(').len() != positions(raw_content, b')').len()
        {
            return false;
        }
        if raw_content == "*" {
            return true;
        }
        let decoded = raw_content
            .replace("\\(", "(")
            .replace("\\)", ")")
            .replace("\\\\", "\\");
        let content = decoded.as_str();
        if tool == "WebSearch" && content.contains(['*', '?']) {
            return false;
        }
        if tool == "WebFetch"
            && (!content.starts_with("domain:")
                || content.contains("://")
                || content.starts_with("http"))
        {
            return false;
        }
        if tool == "Bash" && (content == ":*" || content.contains(":*") && !content.ends_with(":*"))
        {
            return false;
        }
        if [
            "Read",
            "Write",
            "Edit",
            "Glob",
            "NotebookRead",
            "NotebookEdit",
            "Cd",
        ]
        .contains(&tool)
            && content.contains(":*")
        {
            return false;
        }
    }
    true
}
fn reserved_marketplace(s: &str) -> bool {
    [
        "claude-community",
        "claude-plugins-community",
        "healthcare",
        "claude-code-marketplace",
        "claude-code-plugins",
        "claude-plugins-official",
        "anthropic-marketplace",
        "anthropic-plugins",
        "agent-skills",
        "anthropic-agent-skills",
        "life-sciences",
        "knowledge-work-plugins",
        "claude-for-legal",
        "claude-for-financial-services",
        "financial-services-plugins",
        "first-party-plugins",
        "claude-tag-plugins",
        "anthropic-plugin-directory",
        "claude-plugin-directory",
    ]
    .contains(&s.to_lowercase().as_str())
}
fn unsafe_host(host: &str) -> bool {
    let lower = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_lowercase();
    let metadata = [
        "metadata.google.internal",
        "metadata.goog",
        "metadata",
        "instance-data",
        "instance-data.ec2.internal",
        "ip6-localhost",
        "ip6-loopback",
        "localhost.localdomain",
        "localhost4",
        "localhost4.localdomain4",
        "localhost6",
        "localhost6.localdomain6",
        "localhost",
    ];
    if lower.is_empty()
        || metadata.contains(&lower.as_str())
        || lower.ends_with(".localhost")
        || lower.starts_with("instance-data.") && lower.ends_with(".compute.internal")
    {
        return true;
    }
    let ipv4 = |b: &[u8]| {
        b[0] == 127
            || b[0] == 0
            || b[0] == 169 && b[1] == 254
            || b == [100, 100, 100, 200]
            || b == [168, 63, 129, 16]
            || b == [192, 0, 0, 192]
    };
    match lower.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ipv4(&ip.octets()),
        Ok(std::net::IpAddr::V6(ip)) => {
            let b = ip.octets();
            let nat = b[..4] == [0, 100, 255, 155];
            if ip.is_loopback()
                || ip.is_unspecified()
                || b[0] == 254 && (128..=191).contains(&b[1])
                || ip.to_string() == "fd00:ec2::254"
                || nat && b[4..6] == [0, 1]
            {
                return true;
            }
            b[..2] == [32, 2] && ipv4(&b[2..6])
                || (b[..10] == [0; 10] && (b[10..12] == [255, 255] || b[10..12] == [0, 0])
                    || nat && b[4..12] == [0; 8]
                    || matches!(b[8], 0 | 2) && b[9..12] == [0, 94, 254])
                    && ipv4(&b[12..])
        }
        Err(_) => false,
    }
}
fn custom(id: usize, value: &Value) -> bool {
    let s = value.as_str().unwrap_or("");
    match id {
        65 | 128 | 187 | 246 => {
            !input_control(s) && !re(r"[\p{Default_Ignorable_Code_Point}\x{2028}\x{2029}]", s)
        }
        66 | 129 | 247 => s.starts_with('/'),
        188 => re(r"^(?:[A-Za-z]:[\\/]|\\\\)", s),
        67 | 130 | 248 | 68 | 131 | 249 => true,
        189 => re(r"(?i)\.(exe|ps1)$", s),
        190 => !re(r"(?i)\.ps1$", s),
        69 | 132 | 250 => {
            s == "/"
                || s.starts_with('/')
                    && !s.ends_with('/')
                    && !s.contains("//")
                    && !s.split('/').any(|p| p == "." || p == "..")
                    && !re(
                        r"(?i)^/(?:proc|dev/(?:fd|stdin|stdout|stderr)|network/servers)(?:/|$)",
                        s,
                    )
        }
        191 => !s.contains("..") && !s.ends_with(['.', ' ']),
        77 | 140 | 199 | 258 => !s.contains('\0'),
        78 | 141 | 200 | 259 => true,
        79 | 142 | 260 => true,
        201 => s.is_ascii(),
        394 => permission(value, true),
        398 => permission(value, false),
        512 | 531 => {
            ["serverName", "serverCommand", "serverUrl"]
                .iter()
                .filter(|k| value.get(**k).is_some())
                .count()
                == 1
        }
        523 => !s.trim().is_empty(),
        524 => s == s.trim(),
        809 | 930 | 955 => {
            s.is_ascii() && !s.chars().any(|c| c < ' ' || c > '~') && !s.contains("    ")
        }
        838 => !s.contains("..") && !s.contains("//"),
        839 => {
            re(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$", s)
                && !s.contains("..")
                && !s.contains("//")
        }
        847 | 893 => {
            url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
                && re(r"(?i)^https?://[^/\\]", s)
        }
        866 | 876 => !s.contains(' '),
        867 | 877 => !input_control(s),
        868 => !s.contains(['/', '\\']) && !s.contains("..") && s != ".",
        869 => {
            reserved_marketplace(s)
                || s.is_ascii()
                    && !re(
                        r"(?i)(?:official[^a-z0-9]*(?:anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official|^(?:anthropic|claude)[^a-z0-9]*(?:marketplace|plugins|official))",
                        s,
                    )
        }
        870 => ![
            "inline",
            "builtin",
            "skills-dir",
            "synced",
            "claude-plugin-test",
        ]
        .contains(&s.to_lowercase().as_str()),
        871 => !reserved_marketplace(s),
        887 => {
            re(
                r"(?i)^(?:file|https?|git(?:\+https?|\+ssh)?|ssh|github|gitlab|bitbucket):",
                s,
            ) || !s.contains("..")
        }
        921 => url::Url::parse(s)
            .is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| !unsafe_host(h))),
        956 => !value["source"].is_string(),
        957 => value["source"].is_string() || value["source"]["source"] != "unsupported",
        1091 => !s.strip_suffix('*').unwrap_or(s).contains('*'),
        1193 => {
            let fields = [
                value["accessKeyIdVar"].as_str(),
                value["secretAccessKeyVar"].as_str(),
                value["sessionTokenVar"].as_str(),
            ];
            let set = fields
                .into_iter()
                .flatten()
                .collect::<std::collections::HashSet<_>>();
            set.len() == fields.into_iter().flatten().count()
        }
        970 | 975 => value.as_object().is_some_and(|entries| {
            entries
                .iter()
                .all(|(key, v)| v["source"]["source"] != "settings" || v["source"]["name"] == *key)
        }),
        // These checks can alter only inner helper/credential values, never
        // top-level presence: helpers are refused, credentials catch locally.
        115 | 116 | 175 | 234 | 293 | 1150 | 1175 => true,
        _ => panic!("Unmapped pinned SDK custom check {id}"),
    }
}
fn checks(id: usize, schema: &Value, value: &Value) -> bool {
    for reference in schema["checks"].as_array().into_iter().flatten() {
        let check = node(reference);
        let cid = reference["$ref"].as_u64().unwrap() as usize;
        let valid = match check["check"].as_str().unwrap_or("") {
            "custom" => custom(cid, value),
            "number_format" => value
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9007199254740991.0),
            "greater_than" => value.as_f64().is_some_and(|v| {
                if check["inclusive"] == true {
                    v >= check["value"].as_f64().unwrap()
                } else {
                    v > check["value"].as_f64().unwrap()
                }
            }),
            "less_than" => value.as_f64().is_some_and(|v| {
                if check["inclusive"] == true {
                    v <= check["value"].as_f64().unwrap()
                } else {
                    v < check["value"].as_f64().unwrap()
                }
            }),
            "min_length" => {
                str_len(value).is_some_and(|n| n >= check["minimum"].as_u64().unwrap() as usize)
            }
            "max_length" => {
                str_len(value).is_some_and(|n| n <= check["maximum"].as_u64().unwrap() as usize)
            }
            "length_equals" => str_len(value) == Some(check["length"].as_u64().unwrap() as usize),
            "string_format" => {
                value
                    .as_str()
                    .is_some_and(|s| match check["format"].as_str().unwrap_or("") {
                        "url" => url::Url::parse(s).is_ok(),
                        "starts_with" => s.starts_with(check["prefix"].as_str().unwrap()),
                        "regex" => re(check["pattern"]["regex"].as_str().unwrap(), s),
                        _ => panic!("Unmapped pinned SDK string format in {id}"),
                    })
            }
            _ => panic!("Unmapped pinned SDK check in {id}"),
        };
        if !valid {
            return false;
        }
    }
    true
}
fn parse(reference: &Value, input: Option<&Value>, depth: usize) -> Parsed {
    if depth > 256 {
        return Err(());
    }
    let schema = node(reference);
    let id = reference["$ref"].as_u64().unwrap() as usize;
    let recurse = |r: &Value, v: Option<&Value>| parse(r, v, depth + 1);
    let output = match schema["type"].as_str().unwrap_or("") {
        "optional" => {
            if input.is_none() {
                Ok(None)
            } else {
                recurse(&schema["innerType"], input)
            }
        }
        "catch" => match recurse(&schema["innerType"], input) {
            Ok(v) => Ok(v),
            Err(_) => {
                if id == 1058 && input.is_some_and(|v| v.get("credentials").is_some()) {
                    Ok(Some(json!({"credentials":{}})))
                } else {
                    Ok((schema["fallbackDefined"] == true).then(|| schema["fallback"].clone()))
                }
            }
        },
        "lazy" => recurse(&schema["inner"], input),
        "pipe" => {
            let value = recurse(&schema["in"], input)?;
            recurse(&schema["out"], value.as_ref())
        }
        "transform" => match schema["op"].as_str().unwrap_or("") {
            "null_unset" => Ok(input.filter(|v| !v.is_null()).cloned()),
            "unset" => Ok(None),
            "spinner_entries" => Ok(Some(Value::Array(
                input
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter(|v| v.is_string() || v.is_object())
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default(),
            ))),
            "model_settings" => {
                let mut value = input.cloned();
                if let Some(map) = value.as_mut().and_then(Value::as_object_mut) {
                    map.retain(|k, _| {
                        ![
                            "constructor",
                            "__proto__",
                            "toString",
                            "valueOf",
                            "hasOwnProperty",
                            "isPrototypeOf",
                            "propertyIsEnumerable",
                            "toLocaleString",
                            "__defineGetter__",
                            "__defineSetter__",
                            "__lookupGetter__",
                            "__lookupSetter__",
                        ]
                        .contains(&k.as_str())
                    });
                }
                Ok(value)
            }
            "transform_381" => Ok(input.map(|v| match v {
                Value::Bool(true) => json!({}),
                Value::Bool(false) => json!({"commit":"","pr":"","sessionUrl":false}),
                v => v.clone(),
            })),
            "transform_496" => Ok(input.filter(|v| v.is_object()).cloned()),
            "transform_403" => Ok(input.map(|v| {
                if *v == "manual" {
                    json!("default")
                } else {
                    v.clone()
                }
            })),
            "transform_880" => Ok(input.map(|v| if *v == "." { json!("./") } else { v.clone() })),
            "transform_731" => Ok(input.map(|v| match v {
                Value::Array(values) => Value::Array(
                    values
                        .iter()
                        .filter(|v| {
                            v.as_str()
                                .is_some_and(|s| ["skills", "agents", "hooks", "mcp"].contains(&s))
                        })
                        .cloned()
                        .collect(),
                ),
                v => v.clone(),
            })),
            // These pinned operations clamp a helper number, filter an array,
            // emit diagnostics, or normalize a locally caught credential/path
            // value. They cannot change top-level field presence. Helper maps
            // are refused before this parser, and credential errors catch
            // inside sandbox, so their full execution semantics are not used.
            "transform_36" | "transform_47" | "transform_95" | "transform_105"
            | "transform_158" | "transform_168" | "transform_217" | "transform_227"
            | "transform_276" | "transform_286" | "transform_298" | "transform_425"
            | "transform_513" | "transform_532" | "transform_711" | "transform_717"
            | "transform_769" | "transform_985" | "transform_999" | "transform_1131"
            | "transform_1151" | "transform_1158" | "transform_1176" | "transform_1194"
            | "transform_1230" | "transform_1235" | "transform_1454" | "transform_1538" => {
                Ok(input.cloned())
            }
            _ => panic!("Unmapped pinned SDK transform in {id}"),
        },
        "unknown" => Ok(input.cloned()),
        "undefined" => {
            if input.is_none() {
                Ok(None)
            } else {
                Err(())
            }
        }
        "null" => {
            if input.is_some_and(Value::is_null) {
                Ok(Some(Value::Null))
            } else {
                Err(())
            }
        }
        "string" => {
            if schema["coerce"] == true {
                Ok(Some(json!(
                    input.map(js_string).unwrap_or_else(|| "undefined".into())
                )))
            } else {
                input.filter(|v| v.is_string()).cloned().map(Some).ok_or(())
            }
        }
        "boolean" => input
            .filter(|v| v.is_boolean())
            .cloned()
            .map(Some)
            .ok_or(()),
        "number" => input.filter(|v| v.is_number()).cloned().map(Some).ok_or(()),
        "enum" => input
            .filter(|v| {
                schema["entries"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|e| e == *v)
            })
            .cloned()
            .map(Some)
            .ok_or(()),
        "literal" => input
            .filter(|v| schema["values"].as_array().unwrap().contains(v))
            .cloned()
            .map(Some)
            .ok_or(()),
        "union" => schema["options"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|r| recurse(r, input).ok())
            .ok_or(()),
        "array" => {
            let values = input.and_then(Value::as_array).ok_or(())?;
            let mut out = vec![];
            for v in values {
                out.push(recurse(&schema["element"], Some(v))?.unwrap_or(Value::Null));
            }
            Ok(Some(Value::Array(out)))
        }
        "object" => {
            let input = input.and_then(Value::as_object).ok_or(())?;
            let mut output = Map::new();
            let shape = schema["shape"].as_object().unwrap();
            for (key, reference) in shape {
                if let Some(v) = recurse(reference, input.get(key))? {
                    output.insert(key.clone(), v);
                }
            }
            if let Some(catchall) = schema.get("catchall") {
                for (key, value) in input {
                    if !shape.contains_key(key) {
                        if let Some(v) = recurse(catchall, Some(value))? {
                            output.insert(key.clone(), v);
                        }
                    }
                }
            }
            Ok(Some(Value::Object(output)))
        }
        "record" => {
            let input = input.and_then(Value::as_object).ok_or(())?;
            let mut out = Map::new();
            // z.record(enum, value) requires every enumerated key. Hooks uses
            // partialRecord in the SDK, represented by optin on value/keys.
            for (key, value) in input {
                recurse(&schema["keyType"], Some(&json!(key)))?;
                if let Some(v) = recurse(&schema["valueType"], Some(value))? {
                    out.insert(key.clone(), v);
                }
            }
            Ok(Some(Value::Object(out)))
        }
        _ => panic!("Unmapped pinned SDK schema node {id}"),
    }?;
    if output.as_ref().is_some_and(|v| !checks(id, schema, v)) {
        return Err(());
    }
    Ok(output)
}

/// Preserve all unknown fields. Known fields must survive the pinned native
/// validator before they can make a higher managed tier nonempty.
pub fn normalize(value: Value) -> Result<Value> {
    ensure!(
        value.is_object(),
        "Cold maintenance policy settings are unavailable or invalid."
    );
    let shape = descriptor()["nodes"][0]["shape"].as_object().unwrap();
    let mut out = Map::new();
    for (key, value) in value.as_object().unwrap() {
        if key == "policyHelpers" {
            if !value.is_null() {
                out.insert(key.clone(), json!({}));
            }
        } else if let Some(reference) = shape.get(key) {
            if let Ok(Some(normalized)) = parse(reference, Some(value), 0) {
                out.insert(
                    key.clone(),
                    if ["hooks", "managedSourcesBehavior", "policyHelper"].contains(&key.as_str()) {
                        normalized
                    } else {
                        value.clone()
                    },
                );
            }
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_known_fields_do_not_shadow_lower_managed_tiers() -> Result<()> {
        assert_eq!(
            normalize(json!({"model":42,"hooks":null,"managedSourcesBehavior":"invalid"}))?,
            json!({})
        );
        assert_eq!(
            normalize(json!({"futureNativePolicy":{"opaque":true}}))?,
            json!({"futureNativePolicy":{"opaque":true}})
        );
        assert_eq!(
            normalize(
                json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"synthetic"}]}]}})
            )?["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            normalize(json!({"policyHelper":null,"policyHelpers":null}))?,
            json!({})
        );
        Ok(())
    }
    #[test]
    fn pinned_sdk_differential_presence_and_safety_fields_match() -> Result<()> {
        let fixture: Value =
            serde_json::from_str(include_str!("../data/maintenance-settings-cases.json"))?;
        assert_eq!(fixture["sdkVersion"], "0.3.281");
        let mut failures = vec![];
        for case in fixture["cases"].as_array().unwrap() {
            let key = case[0].as_str().unwrap();
            let out = normalize(json!({key:case[1]}))?;
            let relevant = match key {
                "hooks" => json!({"hookKeys":out[key].as_object().map(Map::len).unwrap_or(0)}),
                "managedSourcesBehavior" => json!({"mode":out[key]}),
                "policyHelper" | "policyHelpers" => {
                    json!({"truthy":match &out[key]{Value::Null=>false,Value::Bool(b)=>*b,Value::Number(n)=>n.as_f64()!=Some(0.0),Value::String(s)=>!s.is_empty(),_=>true}})
                }
                _ => Value::Null,
            };
            if out.get(key).is_some() != case[2].as_bool().unwrap() || relevant != case[3] {
                failures.push(json!({"field":key,"input":case[1],"expectedPresent":case[2],"actualPresent":out.get(key).is_some(),"expectedRelevant":case[3],"actualRelevant":relevant}));
            }
        }
        assert!(
            failures.is_empty(),
            "{} differential mismatches; first cases: {}",
            failures.len(),
            serde_json::to_string(&failures.iter().take(20).collect::<Vec<_>>())?
        );
        Ok(())
    }
}
