//! Preserve JSON.stringify bytes used by existing authenticated checkpoints.
use anyhow::{Context, Result};
use serde_json::Value;

pub fn stringify(value: &Value) -> Result<String> {
    serialize(value, false)
}
/// Matches the recursive Object.keys(...).sort() used by history fingerprints.
pub fn canonical_stringify(value: &Value) -> Result<String> {
    serialize(value, true)
}
fn serialize(value: &Value, canonical: bool) -> Result<String> {
    fn index(key: &str) -> Option<u32> {
        let n = key.parse::<u32>().ok()?;
        (n != u32::MAX && n.to_string() == key).then_some(n)
    }
    fn write(value: &Value, out: &mut String, canonical: bool) -> Result<()> {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Value::Number(v) => {
                let number = v
                    .as_f64()
                    .context("JSON number is not representable by the native JavaScript codec.")?;
                if number == 0.0 {
                    out.push('0');
                } else {
                    out.push_str(ryu_js::Buffer::new().format_finite(number));
                }
            }
            Value::String(v) => out.push_str(&serde_json::to_string(v)?),
            Value::Array(values) => {
                out.push('[');
                for (i, v) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(v, out, canonical)?;
                }
                out.push(']');
            }
            Value::Object(values) => {
                let mut keys: Vec<&String> = values.keys().collect();
                if canonical {
                    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                }
                // JavaScript enumerates integer-index properties before other keys,
                // including objects reconstructed in lexicographic order.
                keys.sort_by(|a, b| match (index(a), index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                });
                out.push('{');
                for (i, key) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key)?);
                    out.push(':');
                    write(&values[key], out, canonical)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut output = String::new();
    write(value, &mut output, canonical)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_numbers_and_property_order_keep_checkpoint_bytes() -> Result<()> {
        let v: Value = serde_json::from_str(
            r#"{"z":1.0,"10":1e-7,"2":1e20,"a":-0.0,"big":9007199254740993}"#,
        )?;
        assert_eq!(
            stringify(&v)?,
            r#"{"2":100000000000000000000,"10":1e-7,"z":1,"a":0,"big":9007199254740992}"#
        );
        assert_eq!(
            canonical_stringify(&v)?,
            r#"{"2":100000000000000000000,"10":1e-7,"a":0,"big":9007199254740992,"z":1}"#
        );
        Ok(())
    }
}
