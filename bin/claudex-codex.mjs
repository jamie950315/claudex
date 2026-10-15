#!/usr/bin/env node
// Keep the OpenAI-signed Node parent; Rust controls a sibling sidecar.
import { rustEngine } from './rust-entry.mjs';
process.argv.splice(2, 0, rustEngine());
await import('../crates/claudex-cli/host/codex-host.mjs');
