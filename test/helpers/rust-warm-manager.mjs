// Test-only transport. All policy, admission and persistence behavior stays in Rust.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../../target/debug/examples/warm-contract', import.meta.url));

export class CacheWarmManager {
  constructor({ root, now, compactAfterWarm = () => true }) {
    this.root = root;
    this.now = now;
    this.compactAfterWarm = compactAfterWarm;
    this.pending = new Map();
    this.sequence = 0;
  }

  async initialize() {
    this.child = spawn(executable, [this.root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    this.child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout });
    const ready = new Promise((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    const fail = error => {
      this.failure = error;
      this.ready?.reject(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    lines.on('line', line => {
      const response = JSON.parse(line);
      if (response.ready === true) {
        this.ready.resolve();
        return;
      }
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.error !== undefined) request.reject(new Error(response.error));
      else request.resolve(response.result);
    });
    this.child.on('error', error => fail(new Error(`Build warm-contract before running host tests: ${error.message}`)));
    this.exit = new Promise(resolve => {
      this.child.on('close', (code, signal) => {
        if (!this.closing) fail(new Error(`Rust warm-contract exited (${code ?? signal}): ${stderr}`));
        lines.close();
        resolve();
      });
    });
    await ready;
    return this;
  }

  async dispatch(action, params = {}) {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error('Rust warm-contract is closed.');
    const id = ++this.sequence;
    const result = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.child.stdin.write(JSON.stringify({ id, action, params, now: this.now(), compactAfterWarm: this.compactAfterWarm() }) + '\n');
    return result;
  }

  configure(params) { return this.dispatch('configure', params); }
  observe(params) { return this.dispatch('observe', params); }
  claim(params) { return this.dispatch('claim', params); }
  check(params) { return this.dispatch('check', params); }
  receipt(params) { return this.dispatch('receipt', params); }
  list(params) { return this.dispatch('list', params); }

  async close() {
    if (!this.closing) {
      this.closing = true;
      this.child.stdin.end();
    }
    await this.exit;
  }
}
