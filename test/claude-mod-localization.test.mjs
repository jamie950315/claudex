import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogs } from '../plugins/claudex/hooks/locales.mjs';
import { LANGUAGE_IDS, createLocalization, localizedUsage, parsePreferredLanguages, resolveLanguage, translator } from '../plugins/claudex/hooks/localization.mjs';
import { validateModCatalogSource } from '../src/claude-mod-install.mjs';

test('all Mod catalogs have complete translated keys and exact placeholders', async () => {
  const source = await readFile(new URL('../plugins/claudex/hooks/locales.mjs', import.meta.url), 'utf8');
  const rows = validateModCatalogSource(source);
  assert.deepEqual(Object.keys(catalogs), LANGUAGE_IDS);
  for (const language of LANGUAGE_IDS) assert.deepEqual(Object.keys(catalogs[language]).sort(), Object.keys(rows).sort());
  for (const [key, values] of Object.entries(rows)) {
    assert.equal(catalogs.en[key], key);
    LANGUAGE_IDS.slice(1).forEach((language, index) => assert.equal(catalogs[language][key], values[index]));
  }
  // Catch newly introduced literal labels before shipping an English-only control.
  for (const filename of ['panel.mjs', 'localization.mjs', 'register.mjs']) {
    const module = await readFile(new URL(`../plugins/claudex/hooks/${filename}`, import.meta.url), 'utf8');
    for (const match of module.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
      assert.ok(Object.hasOwn(catalogs.en, key), `${filename}: ${key}`);
    }
  }
});

test('catalog validation rejects missing languages and changed placeholder contracts', () => {
  const source = rows => `const rows = ${JSON.stringify(rows)};\n\nconst languages = [];`;
  assert.throws(() => validateModCatalogSource(source({ Hello: ['你好'] })), { code: 'MOD_LOCALES' });
  assert.throws(() => validateModCatalogSource(source({ 'Value {value}': Array(8).fill('值 {other}') })), { code: 'MOD_LOCALES' });
  assert.throws(() => validateModCatalogSource('export const catalogs = {};'), { code: 'MOD_LOCALES' });
});

test('system language resolution matches app script and region precedence', () => {
  for (const [input, expected] of [
    [['zh-TW'], 'zh-Hant'], [['zh_HK'], 'zh-Hant'], [['zh-MO'], 'zh-Hant'],
    [['zh-Hans-TW'], 'zh-Hans'], [['zh-Hant-CN'], 'zh-Hant'], [['zh-CN'], 'zh-Hans'],
    [['pt-BR', 'ja-JP'], 'ja'], [['fr-CA', 'en'], 'fr'], [['xx'], 'en'], [[], 'en'],
  ]) assert.equal(resolveLanguage(input), expected);
  assert.deepEqual(parsePreferredLanguages({ exitCode: 0, stdout: '(\n "zh-Hant-TW",\n en\n)' }), ['zh-Hant-TW', 'en']);
  for (const reply of [
    { exitCode: 1, stdout: '(en)' }, { exitCode: 0, stdout: 'en' },
    { exitCode: 0, stdout: '("en", "$(command)")' }, { exitCode: 0, stdout: '(en)', isStdoutTruncated: true },
  ]) assert.throws(() => parsePreferredLanguages(reply));
});

test('language persistence is serialized and changes presentation only', async () => {
  const localization = createLocalization();
  let reads = 0, defaults = 0, writes = [], redraws = 0;
  const host = { readLanguage: async () => { reads++; return 'system'; },
    preferredLanguages: async () => { defaults++; return { exitCode: 0, stdout: '(zh-TW)' }; },
    writeLanguage: async value => { writes.push(value); }, redraw: () => { redraws++; } };
  await Promise.all([localization.load(host), localization.load(host)]);
  assert.equal(localization.resolved, 'zh-Hant');
  await Promise.all([localization.select(host, 'ja'), localization.select(host, 'de')]);
  assert.equal(localization.resolved, 'de');
  assert.deepEqual(writes, ['ja', 'de']);
  await localization.select(host, 'system');
  assert.equal(localization.resolved, 'zh-Hant');
  assert.equal(reads, 1); assert.equal(defaults, 1); assert.equal(redraws, 3);
  await localization.select({ ...host, writeLanguage: async () => { throw new Error('fixture'); } }, 'it');
  assert.equal(localization.preference, 'system');
  assert.match(localization.error, /could not be saved/);
});

test('failed system discovery is visible and explicit language selection still works', async () => {
  const localization = createLocalization();
  const host = { readLanguage: async () => null, preferredLanguages: async () => { throw new Error('missing defaults'); },
    writeLanguage: async () => {}, redraw: () => {} };
  await localization.load(host);
  assert.match(localization.error, /System language could not be read/);
  await localization.select(host, 'zh-Hant');
  assert.equal(localization.resolved, 'zh-Hant'); assert.equal(localization.error, '');
});

test('translation preserves opaque native content and substitutes values once', () => {
  const t = translator('zh-Hant');
  assert.equal(t.diagnostic('Native vendor error: {value} /some/exact/path'), 'Native vendor error: {value} /some/exact/path');
  assert.ok(t('Context {value}', { value: 'opaque {value}' }).endsWith('opaque {value}'));
  const id = '11111111-1111-4111-8111-111111111111';
  assert.ok(t.diagnostic(`Dispatch outcome requires inspection. Receipt ${id}; automatic replay is disabled.`).includes(id));
  assert.match(localizedUsage({ context: { percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 25 }, { kind: 'custom-native-limit', percentUsed: 1 }] }, t), /custom-native-limit 1\.0%/);
  assert.ok(localizedUsage(null, t).includes(t('Unknown')));
});
