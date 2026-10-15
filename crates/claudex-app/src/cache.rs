//! The observed Chromium simple-cache v5 codec. Vendor code is never executed.
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::io::Read;
pub const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const HEADER: u64 = 0xfcfb6d1ba7725c30;
const FOOTER: u64 = 0xf4fa6f45970d41d8;
fn u32_at(b: &[u8], i: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        b.get(i..i + 4)
            .context("Truncated cache field")?
            .try_into()?,
    ))
}
fn u64_at(b: &[u8], i: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        b.get(i..i + 8)
            .context("Truncated cache field")?
            .try_into()?,
    ))
}
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ ((0u32.wrapping_sub(crc & 1)) & 0xedb88320)
        }
    }
    !crc
}
#[derive(Debug, Clone)]
pub struct Entry {
    pub url: String,
    pub start: usize,
    pub body_end: usize,
    pub body: Vec<u8>,
    pub metadata: Vec<u8>,
    pub source: String,
    pub source_hash: String,
}
pub fn inspect(bytes: &[u8], target: Option<&str>) -> Result<Entry> {
    ensure!(
        (128..=MAX_CACHE_BYTES).contains(&bytes.len()),
        "Invalid cache entry size."
    );
    ensure!(
        u64_at(bytes, 0)? == HEADER && u32_at(bytes, 8)? == 5,
        "Unsupported cache header."
    );
    let key_len = u32_at(bytes, 12)? as usize;
    let start = 24 + key_len;
    ensure!(
        (1..=4096).contains(&key_len) && start < bytes.len(),
        "Invalid cache key."
    );
    let key = &bytes[24..start];
    let key_text = std::str::from_utf8(key)?;
    let url = key_text
        .strip_prefix("1/0/")
        .context("Unsupported cache key partition.")?;
    ensure!(target.is_none_or(|v| v == url), "Unexpected resource URL.");
    let eof0 = bytes.len() - 24;
    ensure!(
        u64_at(bytes, eof0)? == FOOTER && u32_at(bytes, eof0 + 8)? == 3,
        "Unsupported metadata footer."
    );
    let metadata_len = usize::try_from(u64_at(bytes, eof0 + 16)?)?;
    let eof1 = eof0
        .checked_sub(32 + metadata_len + 24)
        .context("Invalid metadata length.")?;
    ensure!(
        metadata_len > 0
            && eof1 >= start
            && u64_at(bytes, eof1)? == FOOTER
            && u32_at(bytes, eof1 + 8)? == 1
            && u64_at(bytes, eof1 + 16)? == 0,
        "Unsupported body footer."
    );
    let body = &bytes[start..eof1];
    let metadata = &bytes[eof1 + 24..eof0 - 32];
    ensure!(
        crc32(body) == u32_at(bytes, eof1 + 12)?
            && crc32(metadata) == u32_at(bytes, eof0 + 12)?
            && Sha256::digest(key).as_slice() == &bytes[eof0 - 32..eof0],
        "Cache checksum mismatch."
    );
    let mut decoded = Vec::new();
    zstd::stream::read::Decoder::new(body)?
        .take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut decoded)?;
    ensure!(
        decoded.len() <= MAX_SOURCE_BYTES,
        "Decoded source exceeds its bound."
    );
    let source_hash = hash(&decoded);
    let source = String::from_utf8(decoded)?;
    Ok(Entry {
        url: url.into(),
        start,
        body_end: eof1,
        body: body.into(),
        metadata: metadata.into(),
        source,
        source_hash,
    })
}
fn replace_header(bytes: &[u8], old: usize, new: usize) -> Result<Vec<u8>> {
    let mut result = bytes.to_vec();
    for name in ["content-length", "x-goog-stored-content-length"] {
        let before = format!("\0{name}:{old}\0").into_bytes();
        let after = format!("\0{name}:{new}\0").into_bytes();
        let positions: Vec<_> = result
            .windows(before.len())
            .enumerate()
            .filter_map(|(i, w)| (w == before).then_some(i))
            .collect();
        ensure!(positions.len() == 1, "Response length metadata changed.");
        let i = positions[0];
        result.splice(i..i + before.len(), after);
    }
    Ok(result)
}
fn lengths(metadata: &[u8], old: usize, new: usize) -> Result<Vec<u8>> {
    if old.to_string().len() == new.to_string().len() {
        return replace_header(metadata, old, new);
    }
    ensure!(
        metadata.len() >= 44
            && metadata.len() % 4 == 0
            && u32_at(metadata, 0)? as usize == metadata.len() - 4
            && u32_at(metadata, 4)? == 0x82476d03
            && u32_at(metadata, 8)? == 6,
        "Compressed length changes unsupported HTTP metadata."
    );
    let size = u32_at(metadata, 36)? as usize;
    let end = 40 + size;
    let tail = 40 + size.div_ceil(4) * 4;
    ensure!(
        size >= 16 && tail <= metadata.len(),
        "Invalid HTTP header length."
    );
    let raw = &metadata[40..end];
    ensure!(
        (raw.starts_with(b"HTTP/1.1 200\0") || raw.starts_with(b"HTTP/1.1 200 "))
            && raw.ends_with(&[0, 0])
            && metadata[end..tail].iter().all(|b| *b == 0),
        "Unsupported HTTP header string."
    );
    let headers = replace_header(raw, old, new)?;
    let mut result = metadata[..40].to_vec();
    result.extend(&headers);
    result.resize(result.len() + (4 - headers.len() % 4) % 4, 0);
    result.extend(&metadata[tail..]);
    let len = (result.len() - 4) as u32;
    result[0..4].copy_from_slice(&len.to_le_bytes());
    result[36..40].copy_from_slice(&(headers.len() as u32).to_le_bytes());
    Ok(result)
}
pub fn replace_source(original: &[u8], source: &str, target: Option<&str>) -> Result<Vec<u8>> {
    let e = inspect(original, target)?;
    ensure!(
        source.len() <= MAX_SOURCE_BYTES,
        "Patched source exceeds its bound."
    );
    let compressed = zstd::stream::encode_all(source.as_bytes(), 19)?;
    let metadata = lengths(&e.metadata, e.body.len(), compressed.len())?;
    let eof0 = original.len() - 24;
    let mut footer1 = original[e.body_end..e.body_end + 24].to_vec();
    footer1[12..16].copy_from_slice(&crc32(&compressed).to_le_bytes());
    let mut footer0 = original[eof0..].to_vec();
    footer0[12..16].copy_from_slice(&crc32(&metadata).to_le_bytes());
    footer0[16..24].copy_from_slice(&(metadata.len() as u64).to_le_bytes());
    let mut result = original[..e.start].to_vec();
    result.extend(compressed);
    result.extend(footer1);
    result.extend(metadata);
    result.extend(&original[eof0 - 32..eof0]);
    result.extend(footer0);
    ensure!(
        inspect(&result, target)?.source == source,
        "Candidate verification failed."
    );
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture(source: &str) -> Vec<u8> {
        let key = b"1/0/https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-test.js";
        let compressed = zstd::stream::encode_all(source.as_bytes(), 19).unwrap();
        let raw = format!(
            "HTTP/1.1 200\0content-length:{}\0x-goog-stored-content-length:{}\0\0",
            compressed.len(),
            compressed.len()
        )
        .into_bytes();
        let mut meta = vec![0; 40];
        meta[4..8].copy_from_slice(&0x82476d03u32.to_le_bytes());
        meta[8..12].copy_from_slice(&6u32.to_le_bytes());
        meta[36..40].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        meta.extend(raw);
        meta.resize(meta.len().div_ceil(4) * 4, 0);
        meta.extend([0xaa, 0xbb, 0xcc, 0xdd]);
        let len = (meta.len() - 4) as u32;
        meta[..4].copy_from_slice(&len.to_le_bytes());
        let mut b = vec![0; 24];
        b[..8].copy_from_slice(&HEADER.to_le_bytes());
        b[8..12].copy_from_slice(&5u32.to_le_bytes());
        b[12..16].copy_from_slice(&(key.len() as u32).to_le_bytes());
        b.extend(key);
        b.extend(&compressed);
        for (data, kind) in [(&compressed, 1u32), (&meta, 3u32)] {
            if kind == 3 {
                b.extend(&meta);
                b.extend(Sha256::digest(key));
            }
            let mut f = vec![0; 24];
            f[..8].copy_from_slice(&FOOTER.to_le_bytes());
            f[8..12].copy_from_slice(&kind.to_le_bytes());
            f[12..16].copy_from_slice(&crc32(data).to_le_bytes());
            if kind == 3 {
                f[16..24].copy_from_slice(&(meta.len() as u64).to_le_bytes())
            }
            b.extend(f)
        }
        b
    }
    #[test]
    fn codec_roundtrip_retains_http_tail_and_checksums() {
        let b = fixture("export const a=1;");
        let c = replace_source(
            &b,
            &format!("export const a={:?};", (0..1000).collect::<Vec<_>>()),
            None,
        )
        .unwrap();
        let e = inspect(&c, None).unwrap();
        assert!(e.source.contains("999"));
        assert!(e.metadata.ends_with(&[0xaa, 0xbb, 0xcc, 0xdd]));
        let mut bad = c;
        bad[30] ^= 1;
        assert!(inspect(&bad, None).is_err())
    }
    #[test]
    fn crc_matches_ieee() {
        assert_eq!(crc32(b"123456789"), 0xcbf43926)
    }
}
