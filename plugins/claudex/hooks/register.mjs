import { createController, configurationDiagnostic } from './controller.mjs';
import { createNativeWakePump, createSessionObserver } from './delivery.mjs';
import { createLocalization, LANGUAGE_PREFERENCE_KEY } from './localization.mjs';
import { renderPanel } from './panel.mjs';
import { createCacheWarmClient, cacheWarmTtl, assertNativeCacheTtlChange, CACHE_TTL_PREFERENCE_KEY, CACHE_TTL_LAST_KEY } from './cache-warm.mjs';
const PANE = 'claudex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\r\n\0]/u.test(value);

async function nativeCacheTtlState($) {
  const environmentValue = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL');
  const force = await $.env.get('FORCE_PROMPT_CACHING_5M');
  const settings = await $.settings.read(), policy = await $.settings.read({ source: 'policy' });
  const valid = value => ['1h', '5m'].includes(value) ? value : null;
  const truthy = value => value === '1' || value === 'true' || value === true;
  const force5m = truthy(force) || truthy(policy.env?.FORCE_PROMPT_CACHING_5M);
  const policyLocked = Object.hasOwn(policy, 'promptCacheTtl') || Object.hasOwn(policy.env ?? {}, 'CLAUDE_CODE_PROMPT_CACHE_TTL')
    || truthy(policy.env?.FORCE_PROMPT_CACHING_5M);
  const policyValue = truthy(policy.env?.FORCE_PROMPT_CACHING_5M) ? '5m'
    : valid(policy.env?.CLAUDE_CODE_PROMPT_CACHE_TTL) ?? valid(policy.promptCacheTtl);
  return { scope: 'current-process', environmentValue: valid(environmentValue), settingValue: valid(settings.promptCacheTtl),
    value: force5m ? '5m' : valid(environmentValue) ?? valid(settings.promptCacheTtl), force5m, policyLocked, policyValue };
}

async function applyNativeCacheTtl($, desired, expectedValue, beforeWrite) {
  const before = await nativeCacheTtlState($);
  assertNativeCacheTtlChange(before, desired);
  if (before.value !== expectedValue) throw new Error('Native cache TTL changed during confirmation; confirm again.');
  const changed = before.value !== desired || before.environmentValue !== desired;
  await beforeWrite();
  if (changed) await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', desired);
  const state = await nativeCacheTtlState($);
  assertNativeCacheTtlChange(state, desired);
  if (state.value !== desired || state.environmentValue !== desired) throw new Error('Native cache TTL readback failed.');
  return { value: desired, scope: 'current-process', changed, verifiedAt: await $.clock.now() };
}

function api($, options, observer = null) {
  return {
    worker: async () => await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1',
    context: async () => ({ sessionId: await $.session.id(), cwd: await $.session.cwd() }),
    usage: () => $.session.usage(), version: () => $.session.version(),
    configuration: async () => {
      const layers = {};
      for (const source of ['user', 'flag', 'policy']) {
        try { layers[source] = await $.settings.read({ source }); }
        catch { layers[source] = null; }
      }
      return configurationDiagnostic({ options, plugin: { name: $.plugin.name, root: $.plugin.root }, layers });
    },
    redraw: () => { $.ui.invalidate('ui.render'); },
    fill: args => $.prompt.fill(args),
    sendSession: args => $.session.send(args),
    tools: () => $.tool.list(),
    selfEnabled: options.selfWake === true,
    nativeWakeEnabled: options.nativeWake === true,
    observation: observer ? () => observer.snapshot() : undefined,
    inbound: async () => (await $.settings.read()).crossSessionInbound,
    after: (ms, callback) => $.clock.after(ms, callback),
    now: () => $.clock.now(),
    pluginName: $.plugin.name,
    readPrompt: () => $.prompt.read(),
    submitPrompt: args => $.prompt.submit(args),
    readCacheTtl: () => nativeCacheTtlState($),
    readTtlPreference: () => $.store.get(CACHE_TTL_PREFERENCE_KEY),
    writeTtlPreference: value => $.store.set(CACHE_TTL_PREFERENCE_KEY, value),
    readLastTtlChoice: revision => $.store.get(`${CACHE_TTL_LAST_KEY}:${revision}`),
    writeLastTtlChoice: value => $.store.set(`${CACHE_TTL_LAST_KEY}:${value.revision}`, value),
    checkCacheTtl: async value => { const state = await nativeCacheTtlState($); assertNativeCacheTtlChange(state, value); return state; },
    applyCacheTtl: (value, expectedValue, beforeWrite) => applyNativeCacheTtl($, value, expectedValue, beforeWrite),
    cacheConfiguration: async preference => {
      const model = await $.session.model(), settings = await $.settings.read();
      const ttl = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL');
      const force5m = await $.env.get('FORCE_PROMPT_CACHING_5M');
      const effort = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL') ?? settings.effortLevel ?? null;
      const cacheTtl = cacheWarmTtl({ ttl, force5m, setting: settings.promptCacheTtl, preference });
      return { ttl: cacheTtl, fingerprint: JSON.stringify({ model, effort, ...cacheTtl }) };
    },
    readLanguage: () => $.store.get(LANGUAGE_PREFERENCE_KEY),
    writeLanguage: value => $.store.set(LANGUAGE_PREFERENCE_KEY, value),
    preferredLanguages: () => $.process.run(['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 2000 }),
    bridge: async request => {
      if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') throw new Error('Managed worker controller access is disabled.');
      if (!validPath(options.stateRoot) || !validPath(options.nodeBinary)) throw new Error('Stage and configure the Claudex companion with canonical root and Node paths.');
      const root = $.plugin.root;
      if (!validPath(root)) throw new Error('The native plugin root is unavailable.');
      const reply = await $.process.run([options.nodeBinary, `${root}/runtime/bin/claudex-mod-bridge.mjs`,
        '--root', options.stateRoot, ...(options.nativeWake === true ? ['--native-wake'] : []), ...(options.selfWake === true ? ['--self-wake'] : [])], {
        stdin: JSON.stringify(request), timeoutMs: request.op === 'wake-next' ? 35000 : 20000,
      });
      if (typeof reply.stdout !== 'string' || reply.stdout.length > 1024 * 1024) throw new Error('Companion output exceeded its bound. Inspect the existing receipt.');
      let decoded;
      try { decoded = JSON.parse(reply.stdout); } catch { throw new Error('Companion response was incomplete. Inspect the existing receipt; preserve uncertainty.'); }
      if (reply.exitCode !== 0 || decoded.ok !== true) {
        const error = new Error(`${decoded.error?.code ?? 'COMPANION_UNAVAILABLE'}: ${decoded.error?.message ?? 'Inspect the companion receipt and broker.'}`);
        error.code = decoded.error?.code ?? 'COMPANION_UNAVAILABLE'; throw error;
      }
      return decoded.result;
    },
  };
}

export function register(on, options = {}) {
  let lifecycle = 0;
  const controller = createController({ nativeWake: options.nativeWake === true });
  const wake = createNativeWakePump({ enabled: options.nativeWake === true });
  const observer = createSessionObserver();
  const localization = createLocalization();
  const cacheWarm = createCacheWarmClient();
  on('session.start', async ($, e, next) => {
    const ticket = ++lifecycle;
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') !== '1') {
      await localization.load(api($, options));
      await $.command.register({ name: 'claudex', description: localization.t('Open the Claudex control pane. /claudex receipt UUID inspects an action.'), immediate: true });
      await controller.bind(api($, options));
      await controller.refreshUsage(api($, options));
      if (ticket !== lifecycle) return next(e);
      await observer.start(api($, options));
      if (ticket === lifecycle) await cacheWarm.start(api($, options), { restore: true });
      if (ticket === lifecycle) wake.start(api($, options, observer));
    }
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    // Real settings hooks remain installed and keep their own native registration/ACK work.
    controller.reset();
    const ticket = ++lifecycle;
    wake.stop();
    await cacheWarm.stop();
    await observer.stop();
    if (ticket !== lifecycle) return next(e);
    await observer.start(api($, options));
    if (ticket === lifecycle) await cacheWarm.start(api($, options));
    if (ticket === lifecycle) wake.start(api($, options, observer));
    $.ui.invalidate('ui.render');
    return next(e);
  });
  on('session.end', async ($, e, next) => { lifecycle++; controller.reset(); wake.stop(); await cacheWarm.stop(); await observer.stop(); $.ui.invalidate('ui.render'); return next(e); });
  on('prompt.submit', async ($, e, next) => {
    const refusal = await cacheWarm.prompt(e);
    return refusal ?? next(e);
  });
  on('turn.start', async ($, e, next) => { await cacheWarm.turnStart(e); return next(e); });
  on('turn.step', async function* ($, e, next) {
    let ticket = null;
    try { ticket = await cacheWarm.stepStart(e); } catch { cacheWarm.invalidate(); }
    const result = yield* next(e);
    try { await cacheWarm.stepEnd(ticket, result); } catch { cacheWarm.invalidate(); }
    return result;
  });
  on('tool.call', async ($, e, next) => cacheWarm.deniesTool(e)
    ? { deny: 'Tools are disabled for this explicitly authorized cache-warming turn. Reply only OK.' } : next(e));
  on('config.set', async ($, e, next) => { cacheWarm.invalidate(); return next(e); });
  on('session.receive', async ($, e, next) => {
    if (!e.text.startsWith('CLAUDEX_SELF_INBOX_V1\n')) return next(e);
    // This prefix is a routing hint, never authority. Read the original peer text
    // only from a live exact broker claim after checking the current native owner.
    const ticket = lifecycle;
    let phase = 'envelope';
    if (options.nativeWake !== true || options.selfWake !== true || e.agentId)
      return { consumed: 'Claudex own-inbox delivery is not enabled for this session.' };
    try {
      if (e.text.length > 8192) throw new Error('Invalid self-inbox envelope');
      const payload = JSON.parse(e.text.slice('CLAUDEX_SELF_INBOX_V1\n'.length));
      if (!payload || Object.keys(payload).some(key => !['messageId', 'claimId', 'target'].includes(key))) throw new Error('Invalid self-inbox envelope');
      const host = api($, options), context = await host.context();
      phase = 'context';
      if (ticket !== lifecycle || await host.worker()) throw new Error('Session changed');
      phase = 'claim';
      const result = await host.bridge({ version: 1, op: 'wake-self-receive', context, ...payload, route: 'mod-self' });
      phase = 'lifecycle';
      const current = await host.context();
      if (ticket !== lifecycle || current.sessionId !== context.sessionId || current.cwd !== context.cwd
        || result?.ready !== true || typeof result.context !== 'string' || result.context.length > 8192) throw new Error('Unverified self-inbox delivery');
      return next({ ...e, text: result.context });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,48}$/.test(error.code) ? error.code : 'UNVERIFIED';
      controller.state.error = `Own-inbox receive blocked (${phase}: ${code}). Preserve the receipt; no automatic replay.`;
      $.ui.invalidate('ui.render');
      return { consumed: 'Claudex could not verify this own-inbox claim; it was not delivered or replayed.' };
    }
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    await cacheWarm.turnComplete(e);
    await controller.refreshUsage(api($, options));
    await observer.refresh();
    $.ui.invalidate('ui.render');
    return result;
  });
  // The shipped warm skill supplies the native namespaced catalogue entry.
  // Return locally without next(): never execute its model prompt as a command.
  on('command.run', { command: 'claudex:warm' }, async ($, e) => {
    try {
      const words = (e.args ?? '').trim().split(/\s+/u).filter(Boolean);
      return { text: JSON.stringify(await cacheWarm.sessionCommand(api($, options), words, e.origin), null, 2) };
    } catch (error) { return { text: `Cache warming: ${error.message}` }; }
  });
  on('command.run', { command: 'claudex' }, async ($, e) => {
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return { text: localization.t('Use this managed worker\'s existing generation-scoped MCP tools.') };
    await localization.load(api($, options));
    await controller.bind(api($, options));
    const words = (e.args ?? '').trim().split(/\s+/u).filter(Boolean);
    if (words[0] === 'warm') {
      try { return { text: JSON.stringify(await cacheWarm.command(api($, options), words.slice(1), e.origin), null, 2) }; }
      catch (error) { return { text: `Cache warming: ${error.message}` }; }
    }
    if (words[0] === 'receipt' && UUID.test(words[1] ?? '') && words.length === 2) await controller.receipt(api($, options), words[1]);
    else if (words.length) return { text: localization.t('Use /claudex or /claudex receipt UUID.') };
    else await controller.refresh(api($, options));
    await $.ui.open({ id: PANE, title: 'Claudex', focus: true, closeOnEscape: true, columns: 64 });
    // A text answer also gives headless/Desktop dispatch an explicit local result.
    return { text: 'Claudex' };
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return next(e);
    await controller.bind(api($, options));
    await localization.load(api($, options));
    return renderPanel({ ui: $.ui.resolve(e), state: controller.state, controller,
      host: () => ({ ...api($, options),
        cacheCommand: (words, context) => cacheWarm.command(api($, options), words, { kind: 'claudex-panel' }, context) }),
      options, wake, t: localization.t,
      language: localization.preference, languageError: localization.error,
      setLanguage: value => localization.select(api($, options), value) });
  });
}
