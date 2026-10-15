// Optional developer-only Rust peer. The ordinary JS test path is unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

export async function rustFrontendProof(modules, url) {
  const executable = process.env.CLAUDEX_RUST_FRONTEND_OWNER;
  if (!executable) return null;
  assert.ok(isAbsolute(executable), 'Rust frontend proof executable must be absolute');
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  let pending, closed = false;
  const failed = error => { closed = true; pending?.reject(error); pending = null; };
  child.once('error', failed);
  child.once('exit', code => failed(new Error(`Rust fixture peer exited (${code})`)));
  lines.on('line', line => {
    const active = pending; pending = null;
    if (!active) { child.kill(); return; }
    try { const response = JSON.parse(line); response.refused ? active.reject(new Error(response.refused)) : active.resolve(response); }
    catch (error) { active.reject(error); }
  });
  const request = value => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Rust fixture peer is closed')); return; }
    assert.ok(!pending, 'One synthetic proof owns the peer at a time');
    pending = { resolve, reject };
    child.stdin.write(JSON.stringify(value) + '\n', error => { if (error) failed(error); });
  });
  try { assert.equal((await request({ operation: 'init', url, modules: Object.fromEntries([...modules].map(([key, module]) => [key, module.source])) })).ready, true); }
  catch (error) { child.kill(); lines.close(); throw error; }
  return {
    async transform(source, bootstrap) { return (await request({ operation: 'transform', source, bootstrap })).source; },
    close() { child.stdin.end(); lines.close(); child.kill(); },
  };
}
