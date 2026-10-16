//! Preserve JSON.stringify bytes used by existing authenticated checkpoints.
use anyhow::{Context, Result};
use serde_json::Value;
use std::io::Write;

pub fn stringify(value: &Value) -> Result<String> {
    serialize(value, false)
}
/// Matches the recursive Object.keys(...).sort() used by history fingerprints.
pub fn canonical_stringify(value: &Value) -> Result<String> {
    serialize(value, true)
}
/// Write the same checkpoint bytes without allocating a complete JSON string.
pub fn canonical_to_writer(value: &Value, writer: &mut impl Write) -> Result<()> {
    write(value, writer, true)
}
fn serialize(value: &Value, canonical: bool) -> Result<String> {
    let mut output = Vec::new();
    write(value, &mut output, canonical)?;
    Ok(String::from_utf8(output)?)
}
fn index(key: &str) -> Option<u32> {
    if key.len() > 10
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}
fn write(value: &Value, out: &mut impl Write, canonical: bool) -> Result<()> {
    match value {
        Value::Null => out.write_all(b"null")?,
        Value::Bool(v) => out.write_all(if *v { b"true" } else { b"false" })?,
        Value::Number(v) => {
            let number = v
                .as_f64()
                .context("JSON number is not representable by the native JavaScript codec.")?;
            if number == 0.0 {
                out.write_all(b"0")?;
            } else {
                out.write_all(ryu_js::Buffer::new().format_finite(number).as_bytes())?;
            }
        }
        Value::String(v) => serde_json::to_writer(out, v)?,
        Value::Array(values) => {
            out.write_all(b"[")?;
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    out.write_all(b",")?;
                }
                write(v, out, canonical)?;
            }
            out.write_all(b"]")?;
        }
        Value::Object(values) => {
            let mut entries: Vec<_> = values
                .iter()
                .map(|(key, value)| (key, value, index(key)))
                .collect();
            // JavaScript enumerates integer-index properties before other keys,
            // including objects reconstructed in lexicographic order.
            entries.sort_by(|(a, _, ai), (b, _, bi)| match (ai, bi) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ if canonical => a.encode_utf16().cmp(b.encode_utf16()),
                _ => std::cmp::Ordering::Equal,
            });
            out.write_all(b"{")?;
            for (i, (key, value, _)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.write_all(b",")?;
                }
                serde_json::to_writer(&mut *out, key)?;
                out.write_all(b":")?;
                write(value, out, canonical)?;
            }
            out.write_all(b"}")?;
        }
    }
    Ok(())
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

    #[test]
    fn streamed_json_keeps_utf16_order_escapes_and_integer_keys() -> Result<()> {
        let value: Value = serde_json::from_str(
            r#"{"\ue000":"last","\ud800\udc00":"first","01":true,"4294967295":null,"4294967294":-0.0,"0":"\"\\\n\u0000中文😀","":1}"#,
        )?;
        let expected = "{\"0\":\"\\\"\\\\\\n\\u0000中文😀\",\"4294967294\":0,\"\":1,\"01\":true,\"4294967295\":null,\"𐀀\":\"first\",\"\u{e000}\":\"last\"}";
        let mut bytes = Vec::new();
        canonical_to_writer(&value, &mut bytes)?;
        assert_eq!(bytes, expected.as_bytes());
        assert_eq!(canonical_stringify(&value)?, expected);
        for (key, expected) in [
            ("0", Some(0)),
            ("4294967294", Some(u32::MAX - 1)),
            ("", None),
            ("00", None),
            ("01", None),
            ("+1", None),
            ("-0", None),
            ("1e0", None),
            ("4294967295", None),
            ("4294967296", None),
            ("12345678901", None),
        ] {
            assert_eq!(index(key), expected, "{key}");
        }
        Ok(())
    }

    #[test]
    fn streamed_json_propagates_writer_failure() {
        struct Refuse;
        impl Write for Refuse {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture write refused"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(canonical_to_writer(&serde_json::json!({"x":1}), &mut Refuse).is_err());
    }
}
