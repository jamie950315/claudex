// Required signed-process host only. Runtime policy and transport live in Rust.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const enginePath = process.argv[2];
if (!enginePath?.startsWith('/') || /[\r\n\0]/.test(enginePath)) {
  process.stderr.write('Claudex native engine path is invalid.\n');
  process.exit(1);
}
const engine = spawn(enginePath, ['codex-host', ...process.argv.slice(3)], {
  env: process.env,
  stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
});
let native;
let nativeDone = true;
let engineDone = false;
let result = 1;
let resultSignal;
const event = value => {
  if (!engineDone && engine.stdio[4].writable) {
    engine.stdio[4].write(`${JSON.stringify(value)}\n`);
  }
};
const finish = () => {
  if (!engineDone || !nativeDone) return;
  if (resultSignal) {
    process.removeAllListeners(resultSignal);
    process.kill(process.pid, resultSignal);
  } else process.exit(result);
};
const stop = signal => {
  if (native && !nativeDone) native.kill(signal);
};
const lines = createInterface({ input: engine.stdio[3] });
lines.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { engine.kill('SIGTERM'); return; }
  if (command.op === 'spawn') {
    if (native || typeof command.binary !== 'string' || !Array.isArray(command.args)
      || !command.args.every(arg => typeof arg === 'string')
      || !['shared', 'passthrough'].includes(command.mode)) {
      event({ type: 'error', message: 'Invalid native host spawn request.' });
      return;
    }
    nativeDone = false;
    const mask = process.umask(0o077);
    try {
      native = spawn(command.binary, command.args, {
        env: process.env,
        stdio: command.mode === 'shared' ? ['pipe', 'ignore', 'ignore'] : 'inherit',
      });
    } finally { process.umask(mask); }
    native.once('spawn', () => event({ type: 'spawned', pid: native.pid }));
    native.once('error', () => {
      nativeDone = true;
      event({ type: 'error', message: 'Could not start the native Codex backend.' });
      finish();
    });
    native.once('exit', (code, signal) => {
      nativeDone = true;
      event({ type: 'exit', code, signal });
      finish();
    });
  } else if (command.op === 'stop') {
    stop(command.signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  } else {
    event({ type: 'error', message: 'Unknown native host operation.' });
  }
});
lines.once('close', () => { if (!engineDone) stop('SIGTERM'); });
engine.stdio[4].on('error', () => {});
engine.once('error', () => {
  engineDone = true;
  stop('SIGTERM');
  finish();
});
engine.once('exit', (code, signal) => {
  engineDone = true;
  result = code ?? 1;
  resultSignal = signal;
  stop('SIGTERM');
  finish();
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { if (!engineDone) engine.kill(signal); });
}
