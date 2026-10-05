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
  let checkingTitle = localization.text("Checking history in background")
  precondition(!checkingTitle.isEmpty && (language == "en" || checkingTitle != "Checking history in background"))
  precondition(localization.text("Available: codex-cli 99.0.0").contains("codex-cli 99.0.0"))
  precondition(localization.text("The setup engine exited with code 42. Check the app installation, then retry.").contains("42"))
  precondition(!localization.format(" · next check in %@s", ["18"]).contains("%@"))
  let savedDirectory = localization.format("Saved working directory: %@", ["/deleted/project with spaces"])
  precondition(savedDirectory.contains("/deleted/project with spaces") && !savedDirectory.contains("%@"))
  let directoryNextStep = "Restore the saved working directory, or stop tracking this conversation while preserving its histories. Stop synchronization normally before changing tracking; do not retry setup or resend messages."
  precondition(language == "en" || localization.text(directoryNextStep) != directoryNextStep)
  let missingDirectoryNextStep = "When the saved working directory is confirmed missing, Claudex stops tracking automatically and preserves all histories. If still paused, open diagnostics for the safety hold. Do not retry setup or resend messages."
  precondition(language == "en" || localization.text(missingDirectoryNextStep) != missingDirectoryNextStep)
  let unresolvedDirectoryNextStep = "Check the saved working directory and open diagnostics for the exact reason. Histories are preserved; do not retry setup or resend messages."
  precondition(language == "en" || localization.text(unresolvedDirectoryNextStep) != unresolvedDirectoryNextStep)
  let failedStopNextStep = "Claudex could not safely stop tracking this conversation. Histories are preserved. Open diagnostics for the blocking reason; do not retry setup or resend messages."
  precondition(language == "en" || localization.text(failedStopNextStep) != failedStopNextStep)
  precondition(localization.text("3 conversation(s) need attention. raw-proof-ABC").contains("raw-proof-ABC"))
  precondition(localization.text("raw-proof-ABC") == "raw-proof-ABC")
  let progress = localization.detail("Checked 3 of 12 conversations.\\nChecking Translation task (65 seconds elapsed).\\nSaved histories are being checked in the background; they are not being imported again. New and changed conversations are prioritized. Wait for the latest messages in the conversation you are using before switching apps.")
  precondition(progress.contains("3") && progress.contains("12") && progress.contains("65") && progress.contains("Translation task"))
  precondition(progress.contains(localization.text("Saved histories are being checked in the background; they are not being imported again. New and changed conversations are prioritized. Wait for the latest messages in the conversation you are using before switching apps.")))
  precondition(!progress.contains("%@") && !progress.hasPrefix(localization.text("Diagnostic details:")))
  precondition(language == "en" || !progress.hasPrefix("Checked "))
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
