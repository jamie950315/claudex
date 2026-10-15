// Explicit Node compatibility only; all runtime behavior belongs to Rust.
import { accessSync, constants, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

export const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

export function rustEngine() {
  const engine = process.env.CLAUDEX_RUST_ENGINE
    ?? fileURLToPath(new URL('../target/release/claudex', import.meta.url));
  try {
    if (!isAbsolute(engine)) throw new Error('CLAUDEX_RUST_ENGINE must be an absolute executable path.');
    try {
      accessSync(engine, constants.X_OK);
      if (!statSync(engine).isFile()) throw new Error('Not a regular executable.');
    } catch {
      throw new Error(`Rust engine is not built or executable: ${engine}\nBuild it with: cargo build --locked --release -p claudex-cli`);
    }
    return engine;
  } catch (error) {
    process.stderr.write(`Claudex: ${error.message}\n`);
    process.exit(127);
  }
}

export function runRust(prefix = [], args = process.argv.slice(2)) {
  const engine = rustEngine();
  const child = spawn(engine, [...prefix, ...args], { env: process.env, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => () => child.kill(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  child.once('error', error => {
    process.stderr.write(`Claudex: Could not execute the Rust engine: ${error.message}\n`);
    process.exit(127);
  });
  child.once('exit', (code, signal) => {
    signals.forEach((name, index) => process.off(name, handlers[index]));
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
