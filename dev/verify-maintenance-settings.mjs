// Development-only SDK differential fixture generation. Never imported by the
// Rust runtime, app bundle or Claude Mod. It evaluates only the pinned schema.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdkRoot = join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
if (manifest.version !== '0.3.281') throw new Error('Use the pinned SDK 0.3.281 for schema verification.');
const descriptor = JSON.parse(await readFile(join(root, 'crates/claudex-sync/data/maintenance-settings-sdk-0.3.281.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'claudex-policy-schema-'));
try {
  const sdk = await readFile(join(sdkRoot, 'sdk.mjs'), 'utf8');
  const modulePath = join(temporary, 'schema.mjs');
  await writeFile(modulePath, `${sdk}\nexport { gC as maintenanceSchema };\n`);
  const { maintenanceSchema } = await import(pathToFileURL(modulePath));
  const schema = maintenanceSchema(() => {}, 'synthetic maintenance policy fixture');
  const shape = schema._def.in.shape;
  const pinnedShape = descriptor.nodes[0].shape;
  if (JSON.stringify(Object.keys(shape)) !== JSON.stringify(Object.keys(pinnedShape))) throw new Error('Pinned managed schema fields changed.');
  const node = ref => descriptor.nodes[ref.$ref];
  function example(ref, depth = 0, minimal = false) {
    if (depth > 15) return {};
    const d = node(ref);
    switch (d.type) {
      case 'optional': case 'catch': return example(d.innerType, depth + 1, minimal);
      case 'lazy': return example(d.inner, depth + 1, minimal);
      case 'pipe': return example(d.in, depth + 1, minimal);
      case 'transform': return 'synthetic';
      case 'enum': return Object.values(d.entries)[0];
      case 'literal': return d.values[0];
      case 'boolean': return true;
      case 'number': return Math.max(1, ...((d.checks ?? []).map(node).filter(c => c.check === 'greater_than').map(c => c.value + (c.inclusive ? 0 : 1))));
      case 'string': {
        const checks = (d.checks ?? []).map(node);
        const prefix = checks.find(c => c.prefix)?.prefix;
        if (prefix) return `${prefix}synthetic`;
        if (checks.some(c => c.format === 'url')) return 'https://example.com/synthetic';
        if (checks.some(c => c.pattern?.regex.includes('[a-f0-9]{40}'))) return 'a'.repeat(40);
        return 'synthetic';
      }
      case 'array': return minimal ? [] : [example(d.element, depth + 1, minimal)];
      case 'object': return Object.fromEntries(Object.entries(d.shape).filter(([,v]) => !minimal || node(v).optin !== 'optional').map(([k, v]) => [k, example(v, depth + 1, minimal)]));
      case 'record': return minimal ? {} : { [node(d.keyType).type === 'enum' ? Object.values(node(d.keyType).entries)[0] : 'synthetic']: example(d.valueType, depth + 1, minimal) };
      case 'union': return example(d.options[0], depth + 1, minimal);
      case 'null': return null;
      default: return {};
    }
  }
  const primitive = [null, false, true, 0, -1, 1, 1.5, 2147483647, '', 'default', 'merge', 'synthetic', '/synthetic/path', 'https://example.com', [], ['synthetic'], [null], {}, { enabled: true }];
  const cases = [];
  const add = (key, value) => {
    const result = schema.safeParse({ [key]: value });
    if (!result.success) throw new Error('Managed top-level schema unexpectedly refused an object fixture.');
    const settings = result.data;
    const present = Object.hasOwn(settings, key);
    const relevant = key === 'hooks' ? { hookKeys: Object.keys(settings[key] ?? {}).length }
      : key === 'managedSourcesBehavior' ? { mode: settings[key] ?? null }
      : ['policyHelper', 'policyHelpers'].includes(key) ? { truthy: Boolean(settings[key]) } : null;
    cases.push([key, value, present, relevant]);
  };
  for (const key of Object.keys(shape)) {
    for (const value of primitive) add(key, value);
    add(key, example(pinnedShape[key]));
    add(key, example(pinnedShape[key], 0, true));
  }
  for (const key of ['permissions', 'sandbox', 'modelPicker', 'quietHours', 'breakReminder', 'statusLine', 'fileSuggestion', 'modelPricing', 'remoteTools']) {
    const top = node(pinnedShape[key]);
    let d = top;
    while (['catch', 'optional', 'lazy'].includes(d.type)) d = node(d.innerType ?? d.inner);
    if (d.type !== 'object') continue;
    for (const nested of Object.keys(d.shape)) for (const value of primitive) add(key, { [nested]: value });
  }
  for (const value of [
    { Stop: [] }, { Stop: [{ hooks: [] }] }, { Stop: [{ hooks: [{ type: 'command', command: 'synthetic' }] }] },
    { FutureNativeEvent: [] }, { Stop: null }, { Stop: [{ hooks: [{ type: 'command', command: 42 }] }] },
    { Stop: [{ hooks: [{ type: 'http', url: 'https://example.com' }] }] },
  ]) add('hooks', value);
  for (const value of [
    { allow: ['Read'] }, { allow: ['read'] }, { allow: ['Bash(npm run:*)'] }, { allow: ['Bash(:*)'] },
    { allow: ['mcp__synthetic__*'] }, { allow: ['*'] }, { deny: ['*'] }, { ask: ['WebFetch(https://example.com)'] },
    { allow: ['Read()'] }, { allow: ['Read(src/**)'] }, { allow: ['WebSearch(test*)'] },
  ]) add('permissions', value);
  for (const mode of ['allow','deny','ask']) for (const tool of ['Read','Edit','Bash','WebSearch','WebFetch','mcp__synthetic__*','mcp__synthetic','mcp__*__tool','*','?','read','Task','custom_tool'])
    for (const content of [undefined,'','*','src/**',':*','npm run:*','npm:*test','domain:example.com','https://example.com','test*','test?','C:\\Projects\\(drafts)\\**','C:\\tools\\\\(x86)\\run.exe *','\\(literal\\)','test(foo)'])
      add('permissions', { [mode]: [content === undefined ? tool : `${tool}(${content})`] });
  add('permissions', { defaultMode: 'manual' });
  const names = ['synthetic','different','inline','builtin','npm','claude-plugins-official','custom-claude-plugins-official','official-claude','claude','../bad','space name'];
  for (const key of ['extraKnownMarketplaces','additionalMarketplaces']) for (const name of names)
    for (const source of [{ source:'settings', name, plugins:[] }, { source:'github', repo:'synthetic/repo' }, { source:'url', url:'https://example.com/marketplace.json' }]) add(key,{synthetic:{source}});
  const output = resolve(process.argv[2] ?? join(root, 'crates/claudex-sync/data/maintenance-settings-cases.json'));
  await writeFile(output, `${JSON.stringify({ sdkVersion: manifest.version, cases })}\n`);
  console.log(`Generated ${cases.length} pure-schema differential cases for ${Object.keys(shape).length} fields.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
