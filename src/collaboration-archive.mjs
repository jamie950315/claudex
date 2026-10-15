import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, privateJSON } from './claude-mod-storage.mjs';
import { atomicWrite, publishExclusive } from './storage.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keyPattern = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const settled = task => ['completed', 'failed', 'cancelled'].includes(task.status)
  && !task.active && !task.pendingHandoff && !['requested', 'checkpoint'].includes(task.pause?.state);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const storageError = () => fail('CLAUDEX_WORK_ARCHIVE_UNSAFE', 'Work archive evidence is invalid; preserve it and inspect private storage.');

export function workCapacity(hub, state = hub.state) {
  const usage = { tasks: Object.keys(state.tasks).length, requests: Object.keys(state.requests).length,
    bytes: bytes(state) };
  const limits = { tasks: hub.maxTasks, requests: hub.maxRequests, bytes: hub.maxStateBytes };
  const resources = Object.fromEntries(Object.entries(limits).map(([name, limit]) => [name,
    { used: usage[name], limit, remaining: Math.max(0, limit - usage[name]), exhausted: usage[name] >= limit }]));
  return { ...resources, available: Object.keys(limits).every(name => usage[name] <= limits[name]),
    refusalCode: 'CLAUDEX_WORK_CAPACITY_EXHAUSTED' };
}

/** Cold history is immutable. Exact task locators and request keys need no scans.
 * Only the active ledger commits retirement; an interrupted archive publication
 * may leave redundant evidence, never erase an active task or replay receipt. */
export class WorkArchive {
  constructor(root) { this.root = join(root, 'work-archive'); }

  async directory(kind, create = false) {
    if (!create) {
      try { await privateDir(this.root); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    } else await privateDir(this.root, true);
    const path = join(this.root, kind);
    if (!create) {
      try { await privateDir(path); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    } else await privateDir(path, true);
    return path;
  }

  async request(key) {
    if (!keyPattern.test(key)) storageError();
    const dir = await this.directory('requests');
    if (!dir) return null;
    const value = await privateJSON(join(dir, `${key}.json`), { optional: true, maxBytes: 1024 * 1024 });
    if (value === null) return null;
    if (value.version !== 1 || value.key !== key || !keyPattern.test(value.receipt?.fingerprint ?? '')
      || !value.receipt.result || typeof value.receipt.result !== 'object') storageError();
    return value.receipt;
  }

  async saveRequest(key, receipt) {
    const existing = await this.request(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) storageError();
      return false;
    }
    const path = join(await this.directory('requests', true), `${key}.json`);
    await publishExclusive(path, JSON.stringify({ version: 1, key, receipt }) + '\n');
    return true;
  }

  async tree(taskId) {
    if (!uuid.test(taskId ?? '')) return null;
    const dir = await this.directory('tasks');
    if (!dir) return null;
    const locator = await privateJSON(join(dir, `${taskId}.json`), { optional: true, maxBytes: 1024 });
    if (locator === null) return null;
    if (locator.version !== 1 || locator.taskId !== taskId || !uuid.test(locator.snapshot ?? '')
      || !uuid.test(locator.rootId ?? '')) storageError();
    const trees = await this.directory('trees');
    if (!trees) storageError();
    const tree = await privateJSON(join(trees, `${locator.snapshot}.json`), { maxBytes: MAX_ARCHIVE_BYTES });
    if (tree.version !== 1 || tree.rootId !== locator.rootId || !tree.tasks || Array.isArray(tree.tasks)
      || !tree.tasks[taskId] || !tree.tasks[tree.rootId] || tree.tasks[tree.rootId].parentId !== null
      || Object.keys(tree.tasks).length > 10000) storageError();
    for (const [id, task] of Object.entries(tree.tasks)) {
      if (id !== task.id || !uuid.test(id) || !settled(task) || !Array.isArray(task.messages)
        || !Number.isSafeInteger(task.revision) || task.revision < 1
        || !Number.isSafeInteger(task.generation) || task.generation < 0
        || (id !== tree.rootId && tree.tasks[task.parentId]?.depth !== task.depth - 1)) storageError();
    }
    return tree;
  }

  async task(taskId) { return (await this.tree(taskId))?.tasks[taskId] ?? null; }

  async saveTree(tasks, rootId) {
    const snapshot = randomUUID();
    const treePath = join(await this.directory('trees', true), `${snapshot}.json`);
    const value = { version: 1, rootId, tasks };
    if (bytes(value) > MAX_ARCHIVE_BYTES) storageError();
    await publishExclusive(treePath, JSON.stringify(value) + '\n');
    const taskDir = await this.directory('tasks', true);
    for (const taskId of Object.keys(tasks)) {
      // Validate a prior locator before replacing it. Earlier immutable snapshots
      // remain available, including the history before a completed task reopened.
      await this.task(taskId);
      await atomicWrite(join(taskDir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, rootId, snapshot }) + '\n');
    }
  }

  async restore(state, taskId) {
    const tree = await this.tree(taskId);
    if (!tree) return;
    if (Object.keys(tree.tasks).some(id => state.tasks[id])) storageError();
    for (const [id, task] of Object.entries(tree.tasks)) {
      state.tasks[id] = task;
      if (task.notification && !state.requests[task.notification.requestKey]) {
        const request = await this.request(task.notification.requestKey);
        if (!request) storageError();
        state.requests[task.notification.requestKey] = request;
        if (state.archive) state.archive.requests = Math.max(0, state.archive.requests - 1);
      }
    }
    state.archive ??= { tasks: 0, requests: 0 };
    state.archive.tasks = Math.max(0, state.archive.tasks - Object.keys(tree.tasks).length);
  }

  async notificationSettled(hub, task, now) {
    const n = task.notification;
    if (!n) return true;
    if (!n.origin && n.challengeExpiresAt > now) return false;
    if (n.origin && n.suppressedRevision !== task.revision && task.updatedAt + n.policy.expiresInMs > now
      && !n.deliveries.some(d => (d.kind ?? 'terminal') === 'terminal' && d.revision === task.revision)) return false;
    if (n.deliveries.some(d => ['dispatching', 'uncertain'].includes(d.state) || d.createdAt > now - 60000)) return false;
    for (const delivery of n.deliveries) if (delivery.state === 'queued') {
      if (!delivery.messageId) return false;
      const receipt = await hub.chatMailbox.status(delivery.messageId);
      if (!['acknowledged', 'expired'].includes(receipt.state) || ['dispatching', 'uncertain'].includes(receipt.wake?.state)) return false;
    }
    return true;
  }

  async makeRoom(hub, state) {
    const fits = () => workCapacity(hub, state).available;
    state.archive ??= { tasks: 0, requests: 0 };
    // Retain the creation receipt required by active origin validation. Other
    // requests can move independently; their exact fingerprint/result never changes.
    const archiveRequests = async () => {
      const pinned = new Set(Object.values(state.tasks).flatMap(t => t.notification ? [t.notification.requestKey] : []));
      for (const [key, receipt] of Object.entries(state.requests)) {
        const capacity = workCapacity(hub, state);
        if (capacity.requests.used <= capacity.requests.limit && capacity.bytes.used <= capacity.bytes.limit) break;
        if (pinned.has(key) || JSON.stringify(hub.state.requests[key]) !== JSON.stringify(receipt)) continue;
        await this.saveRequest(key, receipt);
        state.archive.requests++;
        delete state.requests[key];
      }
    };
    await archiveRequests();
    const now = Date.now();
    const roots = Object.values(state.tasks).filter(task => task.parentId === null)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
    for (const root of roots) {
      if (fits()) return;
      const ids = new Set([root.id]);
      for (const task of Object.values(state.tasks).sort((a, b) => a.depth - b.depth))
        if (ids.has(task.parentId)) ids.add(task.id);
      const tasks = Object.fromEntries([...ids].map(id => [id, state.tasks[id]]));
      if (Object.values(tasks).some(task => !settled(task) || hub.running.has(task.id)
        || JSON.stringify(task) !== JSON.stringify(hub.state.tasks[task.id]))) continue;
      let safe = true;
      for (const task of Object.values(tasks)) if (!await this.notificationSettled(hub, task, now)) { safe = false; break; }
      if (!safe) continue;
      // Publish creation receipts too before cold task lookup becomes visible.
      for (const task of Object.values(tasks)) if (task.notification) {
        const key = task.notification.requestKey;
        await this.saveRequest(key, state.requests[key] ?? await this.request(key));
      }
      await this.saveTree(tasks, root.id);
      for (const id of ids) delete state.tasks[id];
      state.archive.tasks += ids.size;
      await archiveRequests();
    }
    if (!fits()) {
      const cap = workCapacity(hub, state);
      const names = ['tasks', 'requests', 'bytes'].filter(name => cap[name].used > cap[name].limit);
      const resource = names[0];
      throw Object.assign(new Error(`Work ledger capacity reached (${names.join(', ')}); no safely settled history can be archived. Pending and uncertain work and exact replay decisions were preserved.`),
        { code: 'CLAUDEX_WORK_CAPACITY_EXHAUSTED', resource, used: cap[resource].used, limit: cap[resource].limit });
    }
  }
}
