import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { validateCollaborationEffort } from './collaboration-effort.mjs';

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_NAME = 'claudex';
const API_KEY_ENV = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

function failure(message, { uncertain = false, cause } = {}) {
  const error = new Error(message, { cause });
  error.executionUncertain = uncertain;
  return error;
}

function checkedString(value, name, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) {
    throw failure(`${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}

function checkedMcp(mcp) {
  if (mcp == null) return null;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw failure('mcp must be an object.');
  const command = checkedString(mcp.command, 'mcp.command', 4096);
  const args = mcp.args ?? [];
  if (!Array.isArray(args) || args.length > 64) throw failure('mcp.args must be an array of at most 64 strings.');
  for (const arg of args) checkedString(arg, 'mcp.args entry', 4096);
  const env = mcp.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw failure('mcp.env must be an object.');
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw failure('mcp.env contains an invalid environment variable.');
    }
    if (API_KEY_ENV.has(key)) throw failure('mcp.env cannot override native account authentication.');
  }
  return { command, args, env };
}

function argv(provider, { prompt, model, effort, permission, mcp }) {
  if (provider === 'codex') {
    const args = [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '--sandbox', permission === 'workspace-write' ? 'workspace-write' : 'read-only',
      '-c', 'approval_policy="never"',
    ];
    if (model) args.push('--model', model);
    if (effort != null) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (mcp) {
      args.push('-c', `mcp_servers.${MCP_NAME}.command=${JSON.stringify(mcp.command)}`);
      args.push('-c', `mcp_servers.${MCP_NAME}.args=${JSON.stringify(mcp.args)}`);
      args.push('-c', `mcp_servers.${MCP_NAME}.env_vars=${JSON.stringify(Object.keys(mcp.env))}`);
      args.push('-c', `mcp_servers.${MCP_NAME}.required=true`);
      args.push('-c', `mcp_servers.${MCP_NAME}.default_tools_approval_mode="approve"`);
    }
    args.push('-');
    return args;
  }
  const tools = permission === 'workspace-write'
    ? 'Read,Glob,Grep,Edit,Write'
    : 'Read,Glob,Grep';
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--restricted', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--tools', tools, '--allowedTools', mcp ? `${tools},mcp__${MCP_NAME}__*` : tools,
  ];
  if (model) args.push('--model', model);
  if (effort != null) args.push('--effort', effort);
  if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { [MCP_NAME]: { command: mcp.command, args: mcp.args } } }));
  return args;
}

function decodeEvent(provider, event, result) {
  if (provider === 'codex') {
    if (event.type === 'thread.started') result.sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') result.text = event.item.text;
    if (event.type === 'turn.completed') {
      if (result.terminal && result.terminal !== 'success') result.conflictingReceipt = true;
      result.terminal = 'success'; result.usage = event.usage;
    }
    if (event.type === 'turn.failed') {
      if (result.terminal && result.terminal !== 'failed') result.conflictingReceipt = true;
      result.terminal = 'failed';
    }
  } else {
    if (event.session_id && typeof event.session_id === 'string') result.sessionId = event.session_id;
    if (event.type === 'result' && typeof event.is_error === 'boolean') {
      const terminal = event.is_error ? 'failed' : 'success';
      if (result.terminal && result.terminal !== terminal) result.conflictingReceipt = true;
      result.terminal = terminal;
      if (typeof event.result === 'string') result.text = event.result;
      result.usage = event.usage;
    }
  }
}

export function createNativeCollaborationRunner({
  spawnImpl = spawn,
  commands = { codex: 'codex', claude: 'claude' },
  signalGroupImpl = (pid, signal) => process.kill(-pid, signal),
  groupAliveImpl = (pid) => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  },
} = {}) {
  return async function runCollaborationNative({
    provider, cwd, prompt, model, effort = null, mcp: rawMcp, permission = 'read-only',
    timeoutMs = DEFAULT_TIMEOUT_MS, signal, onEvent,
  } = {}) {
    if (provider !== 'codex' && provider !== 'claude') throw failure('provider must be codex or claude.');
    checkedString(cwd, 'cwd', 4096);
    checkedString(prompt, 'prompt', 1024 * 1024);
    if (model != null) checkedString(model, 'model');
    try { validateCollaborationEffort(provider, effort); }
    catch (error) { throw failure(error.message); }
    if (!['read-only', 'workspace-write'].includes(permission)) throw failure('Invalid permission.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 24 * 60 * 60 * 1000) {
      throw failure('timeoutMs must be between 1000 ms and 24 hours.');
    }
    if (onEvent != null && typeof onEvent !== 'function') throw failure('onEvent must be a function.');
    const mcp = checkedMcp(rawMcp);
    const canonicalCwd = await realpath(cwd);
    if (!(await stat(canonicalCwd)).isDirectory()) throw failure('cwd must be a directory.');
    if (signal?.aborted) throw failure('Native execution was cancelled before launch.');

    const command = checkedString(commands[provider], `${provider} command`, 4096);
    const args = argv(provider, { prompt, model, effort, permission, mcp });
    const env = { ...process.env, ...mcp?.env };
    for (const key of API_KEY_ENV) delete env[key];
    for (const key of ['CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) delete env[key];
    if (provider === 'claude') {
      delete env.CLAUDE_CONFIG_DIR;
      // A caller's session-level environment must not override task effort selection.
      delete env.CLAUDE_CODE_EFFORT_LEVEL;
    }
    const result = { text: '', sessionId: provider === 'claude' ? randomUUID() : null,
      usage: undefined, terminal: null, conflictingReceipt: false };
    if (provider === 'claude') args.push('--session-id', result.sessionId);

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(command, args, { cwd: canonicalCwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
      } catch (cause) {
        reject(failure('Could not start native collaboration process.', { cause }));
        return;
      }
      let closed = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let startupDiagnostic = '';
      let lineBuffer = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let problem = null;
      let killTimer;
      let cancelled = false;
      let eventQueue = Promise.resolve();
      let sessionNotified = false;
      const notify = (event) => {
        eventQueue = eventQueue.then(() => onEvent?.(event)).catch((cause) => {
          stop(failure('Native event handler failed.', { uncertain: true, cause }));
        });
        return eventQueue;
      };
      const signalOwnedGroup = (kind) => {
        if (Number.isSafeInteger(child.pid) && child.pid > 0) {
          try { signalGroupImpl(child.pid, kind); return; }
          catch (error) { if (error.code === 'ESRCH') return; }
        }
        if (!closed) child.kill(kind);
      };
      const stop = (error) => {
        if (!problem) problem = error;
        if (!closed) {
          signalOwnedGroup('SIGTERM');
          killTimer ??= setTimeout(() => { if (!closed) signalOwnedGroup('SIGKILL'); }, 2000);
          killTimer.unref?.();
        }
      };
      const abort = () => {
        cancelled = true;
        stop(failure('Native execution was cancelled.', { uncertain: true }));
      };
      const timeout = setTimeout(() => stop(failure('Native execution timed out; its outcome is uncertain.', { uncertain: true })), timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        notify({ type: 'spawn', pid: child.pid }).then(() => {
          if (!problem && !closed) {
            try { child.stdin?.end(prompt); }
            catch (cause) { stop(failure('Native input could not be delivered.', { uncertain: true, cause })); }
          }
        });
      }
      const consume = (line) => {
        if (!line.trim() || problem) return;
        let event;
        try { event = JSON.parse(line); }
        catch (cause) { stop(failure('Native execution emitted invalid JSON.', { uncertain: true, cause })); return; }
        decodeEvent(provider, event, result);
        if (result.sessionId && !sessionNotified &&
          (provider === 'codex' ? event.type === 'thread.started' : typeof event.session_id === 'string')) {
          sessionNotified = true;
          notify({ type: 'session', sessionId: result.sessionId });
        }
        notify(event);
      };
      child.stdout?.on('data', (chunk) => {
        if (problem) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT) { stop(failure('Native output exceeded its limit.', { uncertain: true })); return; }
        lineBuffer += stdoutDecoder.write(chunk);
        let end;
        while ((end = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
          if (line.length > MAX_LINE) { stop(failure('Native event exceeded its limit.', { uncertain: true })); return; }
          consume(line);
        }
        if (lineBuffer.length > MAX_LINE) stop(failure('Native event exceeded its limit.', { uncertain: true }));
      });
      // Keep only a bounded in-memory candidate for exact known pre-execution
      // failures. Never persist arbitrary native stderr, credentials or prompts.
      child.stderr?.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 4096) startupDiagnostic += chunk.toString('utf8');
        else startupDiagnostic = '';
      });
      child.stdin?.on('error', (cause) => stop(failure('Native input could not be delivered.', { uncertain: true, cause })));
      child.on('error', (cause) => {
        stop(failure('Native collaboration process failed.', { uncertain: Boolean(child.pid), cause }));
      });
      child.on('close', async (code, processSignal) => {
        closed = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        lineBuffer += stdoutDecoder.end();
        if (lineBuffer.trim() && !problem) consume(lineBuffer);
        let drainTimer;
        await Promise.race([
          eventQueue,
          new Promise((done) => {
            drainTimer = setTimeout(() => {
              if (!problem) problem = failure('Native event handler did not finish.', { uncertain: true });
              done();
            }, 10_000);
          }),
        ]);
        clearTimeout(drainTimer);
        // The detached group belongs only to this invocation, including its MCP children.
        if (Number.isSafeInteger(child.pid) && child.pid > 0 && groupAliveImpl(child.pid)) {
          signalOwnedGroup('SIGTERM');
          for (let i = 0; i < 20 && groupAliveImpl(child.pid); i++) {
            await new Promise((done) => setTimeout(done, 50));
          }
          if (groupAliveImpl(child.pid)) signalOwnedGroup('SIGKILL');
          for (let i = 0; i < 20 && groupAliveImpl(child.pid); i++) {
            await new Promise((done) => setTimeout(done, 50));
          }
        }
        const groupClosed = !Number.isSafeInteger(child.pid) || !groupAliveImpl(child.pid);
        if (cancelled && problem && groupClosed) problem.executionUncertain = false;
        if (problem) { reject(problem); return; }
        if (!groupClosed) { reject(failure('Native subprocesses survived completion.', { uncertain: true })); return; }
        if (result.conflictingReceipt) {
          reject(failure('Native execution emitted conflicting terminal receipts.', { uncertain: true }));
          return;
        }
        if (result.terminal === 'failed') {
          reject(failure(`Native ${provider} execution failed with a terminal receipt.`, { uncertain: false }));
          return;
        }
        if (provider === 'codex' && code === 1 && !processSignal && stdoutBytes === 0 && !result.sessionId
          && stderrBytes <= 4096 && startupDiagnostic.trim() === 'Not inside a trusted directory and --skip-git-repo-check was not specified.') {
          reject(failure('Codex refused the selected non-Git project before execution. Update the collaboration launcher; no model work was started.', { uncertain: false }));
          return;
        }
        if (code !== 0 || processSignal || result.terminal !== 'success' || typeof result.text !== 'string' || !result.text) {
          reject(failure(`Native ${provider} execution did not complete successfully${code == null ? '' : ` (exit ${code})`}.`, { uncertain: true }));
          return;
        }
        resolve({ text: result.text, sessionId: result.sessionId, usage: result.usage });
      });
    });
  };
}

export const runCollaborationNative = createNativeCollaborationRunner();
