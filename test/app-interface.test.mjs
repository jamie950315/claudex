import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('graphical app owns one status item and integrates the bounded health controller', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../native/ClaudexApp/StatusController.swift', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../src/app-bundle.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/NSStatusBar\.system\.statusItem\(/g) || []).length, 1);
  assert.doesNotMatch(controller, /NSStatusBar\.system\.statusItem|NSApplication\.shared|app\.run\(/);
  assert.match(source, /health\.start\(item: statusItem\)/);
  assert.match(source, /runningApplications\(withBundleIdentifier:/);
  for (const action of ['showHealth', 'showSetup', 'showDiagnostics', 'notifications']) {
    assert.match(source, new RegExp(`#selector\\(${action}\\(_:\\)\\)`));
  }
  assert.match(controller, /report = loadHealth\(root\)/);
  assert.match(controller, /guard !readOnly else \{ return \}/);
  assert.match(controller, /gate\.event\(for: report/);
  assert.match(builder, /StatusController\.swift/);
  assert.match(builder, /ClaudexStatus', 'StatusModel\.swift/);
});
