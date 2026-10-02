import { createController } from './controller.mjs';
import { createNativeWakePump, createSessionObserver } from './delivery.mjs';
import { createLocalization, localizedUsage, LANGUAGE_PREFERENCE_KEY } from './localization.mjs';
import { renderPanel } from './panel.mjs';
const PANE = 'claudex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\r\n\0]/u.test(value);

function api($, options, observer = null) {
  return {
    worker: async () => await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1',
    context: async () => ({ sessionId: await $.session.id(), cwd: await $.session.cwd() }),
    usage: () => $.session.usage(), version: () => $.session.version(),
    redraw: () => { $.ui.invalidate('ui.render'); },
    fill: args => $.prompt.fill(args),
    sendSession: args => $.session.send(args),
    tools: () => $.tool.list(),
    selfEnabled: options.selfWake === true,
    nativeWakeEnabled: options.nativeWake === true,
    observation: observer ? () => observer.snapshot() : undefined,
    inbound: async () => (await $.settings.read()).crossSessionInbound,
    after: (ms, callback) => $.clock.after(ms, callback),
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
  on('session.start', async ($, e, next) => {
    const ticket = ++lifecycle;
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') !== '1') {
      await localization.load(api($, options));
      await $.command.register({ name: 'claudex', description: localization.t('Open the Claudex control pane. /claudex receipt UUID inspects an action.'), immediate: true });
      await controller.bind(api($, options));
      await controller.refreshUsage(api($, options));
      if (ticket !== lifecycle) return next(e);
      await observer.start(api($, options));
      if (ticket === lifecycle) wake.start(api($, options, observer));
    }
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    // Real settings hooks remain installed and keep their own native registration/ACK work.
    controller.reset();
    const ticket = ++lifecycle;
    wake.stop();
    await observer.stop();
    if (ticket !== lifecycle) return next(e);
    await observer.start(api($, options));
    if (ticket === lifecycle) wake.start(api($, options, observer));
    $.ui.invalidate('ui.render');
    return next(e);
  });
  on('session.end', async ($, e, next) => { lifecycle++; controller.reset(); wake.stop(); await observer.stop(); $.ui.invalidate('ui.render'); return next(e); });
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
    await controller.refreshUsage(api($, options));
    await observer.refresh();
    $.ui.invalidate('ui.render');
    return result;
  });
  on('command.run', { command: 'claudex' }, async ($, e) => {
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return { text: localization.t('Use this managed worker\'s existing generation-scoped MCP tools.') };
    await localization.load(api($, options));
    await controller.bind(api($, options));
    const words = (e.args ?? '').trim().split(/\s+/u).filter(Boolean);
    if (words[0] === 'receipt' && UUID.test(words[1] ?? '') && words.length === 2) await controller.receipt(api($, options), words[1]);
    else if (words.length) return { text: localization.t('Use /claudex or /claudex receipt UUID.') };
    else await controller.refresh(api($, options));
    await $.ui.open({ id: PANE, title: 'Claudex', focus: true, closeOnEscape: true, columns: 64 });
    return {};
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const original = await next(e);
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return original;
    const ticket = await controller.bind(api($, options));
    if (!ticket) return original;
    await localization.load(api($, options));
    const { Box, Text } = $.ui.resolve(e);
    if (e.props.maxRows < 1) return original;
    const children = [Text({ wrap: 'truncate', children: [`Claudex | ${localizedUsage(controller.state.usage, localization.t)} | /claudex`] })];
    if (original !== null && original !== undefined) children.push(original);
    return Box({ flexDirection: 'column', children });
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return next(e);
    await controller.bind(api($, options));
    await localization.load(api($, options));
    return renderPanel({ ui: $.ui.resolve(e), state: controller.state, controller,
      host: () => api($, options), options, wake, t: localization.t,
      language: localization.preference, languageError: localization.error,
      setLanguage: value => localization.select(api($, options), value) });
  });
}
