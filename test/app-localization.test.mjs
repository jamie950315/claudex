import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { APP_LOCALES } from '../src/app-bundle.mjs';

const directory = new URL('../native/ClaudexApp/Locales/', import.meta.url).pathname;
test('all nine UI catalogs are complete with matching format placeholders', async () => {
  const english = JSON.parse(await readFile(join(directory, 'en.json'), 'utf8'));
  assert.deepEqual(APP_LOCALES, ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'es', 'de', 'fr', 'it']);
  assert.ok(Object.keys(english).length >= 190);
  for (const locale of APP_LOCALES) {
    const values = JSON.parse(await readFile(join(directory, `${locale}.json`), 'utf8'));
    assert.deepEqual(Object.keys(values).sort(), Object.keys(english).sort(), locale);
    for (const [key, value] of Object.entries(values)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim(), `${locale}: ${key}`);
      assert.equal((value.match(/%@/g) ?? []).length, (key.match(/%@/g) ?? []).length, `${locale}: ${key}`);
      assert.equal(value.replaceAll('%@', '').includes('%'), false, `${locale}: ${key}`);
    }
    if (locale !== 'en') assert.ok(Object.keys(values).filter(key => values[key] !== key).length > Object.keys(english).length * 0.85, locale);
  }
});

test('native locale selection and dynamic labels preserve diagnostics and format arguments',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-i18n-'));
    const main = join(root, 'main.swift'), binary = join(root, 'check');
    await writeFile(main, `import Foundation
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
precondition(Localization.resolve(["zh-TW"]) == "zh-Hant")
precondition(Localization.resolve(["zh-HK"]) == "zh-Hant")
precondition(Localization.resolve(["zh-Hans-TW"]) == "zh-Hans")
precondition(Localization.resolve(["zh-CN"]) == "zh-Hans")
precondition(Localization.resolve(["xx-XX", "es-MX"]) == "es")
precondition(Localization.resolve(["de-DE"]) == "de")
precondition(Localization.resolve(["xx-XX"]) == "en")
let localization = Localization(directory: directory, preference: "system", preferredLanguages: ["ja-JP"])
precondition(localization.language == "ja")
for (language, _) in Localization.languages {
  localization.select(language, persist: false)
  precondition(localization.language == language)
  let title = localization.text("Synchronization ready")
  precondition(!title.isEmpty && (language == "en" || title != "Synchronization ready"))
  precondition(localization.text("Available: codex-cli 99.0.0").contains("codex-cli 99.0.0"))
  precondition(localization.text("The setup engine exited with code 42. Check the app installation, then retry.").contains("42"))
  precondition(!localization.format(" · next check in %@s", ["18"]).contains("%@"))
  precondition(localization.text("3 conversation(s) need attention. raw-proof-ABC").contains("raw-proof-ABC"))
  precondition(localization.text("raw-proof-ABC") == "raw-proof-ABC")
}
localization.select("system", persist: false)
precondition(localization.language == "ja")
localization.select("not-a-language", persist: false)
precondition(localization.language == "ja")
print("Locale behavior verified")
`);
    const run = promisify(execFile);
    await run('/usr/bin/xcrun', ['swiftc', new URL('../native/ClaudexApp/Localization.swift', import.meta.url).pathname, main, '-o', binary]);
    assert.match((await run(binary, [directory])).stdout, /Locale behavior verified/);
  });
