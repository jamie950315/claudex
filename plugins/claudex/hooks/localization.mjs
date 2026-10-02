import { catalogs } from './locales.mjs';

export const LANGUAGE_IDS = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'es', 'de', 'fr', 'it'];
export const LANGUAGE_PREFERENCE_KEY = 'ui-language';
const validPreference = value => value === 'system' || LANGUAGE_IDS.includes(value);

// Match the app's script-first Chinese resolution, including region-only tags.
export function resolveLanguage(preferred) {
  for (const value of preferred) {
    const parts = String(value).replaceAll('_', '-').toLowerCase().split('-');
    if (parts[0] === 'zh') {
      if (parts.includes('hant')) return 'zh-Hant';
      if (parts.includes('hans')) return 'zh-Hans';
      return parts.some(part => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    }
    if (LANGUAGE_IDS.includes(parts[0])) return parts[0];
  }
  return 'en';
}

// `defaults read -g AppleLanguages` emits an OpenStep array, not JSON. Accept
// only its bounded language-tag grammar; never execute or interpret the output.
export function parsePreferredLanguages(reply) {
  if (reply?.exitCode !== 0 || reply.isStdoutTruncated || typeof reply.stdout !== 'string' || reply.stdout.length > 8192)
    throw new Error('System language could not be read. Select a language.');
  const source = reply.stdout.trim();
  if (!source.startsWith('(') || !source.endsWith(')')) throw new Error('System language could not be read. Select a language.');
  const values = source.slice(1, -1).trim();
  if (!values) return [];
  const tags = values.split(',').map(value => value.trim());
  if (tags.length > 64 || tags.some(value => !/^(?:"[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*"|[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*)$/.test(value)))
    throw new Error('System language could not be read. Select a language.');
  return tags.map(value => value.replace(/^"|"$/g, ''));
}

export function translator(language) {
  const catalog = catalogs[language] ?? catalogs.en;
  const t = (key, params = {}) => (catalog[key] ?? key).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  t.diagnostic = raw => {
    if (typeof raw !== 'string') return String(raw ?? '');
    if (Object.prototype.hasOwnProperty.call(catalog, raw)) return t(raw);
    // Only application-authored envelopes are translated. Captures such as IDs,
    // native reason codes and opaque peer diagnostics are retained verbatim.
    const templates = [
      [/^Action ([0-9a-f-]{36}) exceeds the full-preview UI bound\. Use the operator workflow; it remains uncommitted\.$/i,
        'Action {id} exceeds the full-preview UI bound. Use the operator workflow; it remains uncommitted.', ['id']],
      [/^Dispatch outcome requires inspection\. Receipt ([0-9a-f-]{36}); automatic replay is disabled\.$/i,
        'Dispatch outcome requires inspection. Receipt {id}; automatic replay is disabled.', ['id']],
      [/^Native delivery: ([a-z-]+) \(([^\r\n]*)\)\. ([\s\S]*) No automatic resend\.$/,
        'Native delivery: {state} ({reason}). {nativeReason} No automatic resend.', ['state', 'reason', 'nativeReason']],
      [/^Own-inbox receive blocked \(([a-z]+): ([A-Z_]{1,48})\)\. Preserve the receipt; no automatic replay\.$/,
        'Own-inbox receive blocked ({phase}: {code}). Preserve the receipt; no automatic replay.', ['phase', 'code']],
    ];
    for (const [pattern, key, names] of templates) {
      const match = raw.match(pattern);
      if (match) return t(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
    }
    return raw;
  };
  return t;
}

export function localizedUsage(usage, t) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const context = valid(usage?.context?.percent) ? `${usage.context.percent.toFixed(1)}%` : t('Unknown');
  const rates = Array.isArray(usage?.rateLimits) ? usage.rateLimits
    .filter(item => typeof item.kind === 'string' && valid(item.percentUsed))
    .map(item => `${item.kind === 'five_hour' ? t('5-hour allowance') : item.kind === 'seven_day' ? t('7-day allowance') : item.kind} ${item.percentUsed.toFixed(1)}%`).join(' | ') : '';
  return `${t('Context {value}', { value: context })}${rates ? ` | ${rates}` : ''}`;
}

export function createLocalization() {
  let preference = 'system', systemLanguage = 'en', error = '', initial = null, write = Promise.resolve();
  let systemRead = null;
  async function readSystem(host) {
    if (!systemRead) systemRead = (async () => {
      try {
        systemLanguage = resolveLanguage(parsePreferredLanguages(await host.preferredLanguages()));
        return true;
      } catch { return false; }
    })();
    return systemRead;
  }
  return {
    get preference() { return preference; },
    get resolved() { return preference === 'system' ? systemLanguage : preference; },
    get error() { return error; },
    get t() { return translator(preference === 'system' ? systemLanguage : preference); },
    async load(host) {
      if (!initial) initial = (async () => {
        try {
          const saved = await host.readLanguage();
          if (saved !== undefined && saved !== null) {
            if (validPreference(saved)) preference = saved;
            else error = 'Saved language is unsupported. Select a language.';
          }
        } catch { error = 'Language preference could not be read. Select a language.'; }
        if (preference === 'system' && !await readSystem(host)) error = 'System language could not be read. Select a language.';
      })();
      await initial;
    },
    select(host, value) {
      if (!validPreference(value)) return Promise.resolve();
      write = write.then(async () => {
        await this.load(host);
        if (value === 'system' && !await readSystem(host)) {
          error = 'System language could not be read. Select a language.'; host.redraw(); return;
        }
        try {
          await host.writeLanguage(value);
          preference = value; error = '';
        } catch { error = 'Language preference could not be saved. Your previous selection is unchanged.'; }
        host.redraw();
      });
      return write;
    },
  };
}
