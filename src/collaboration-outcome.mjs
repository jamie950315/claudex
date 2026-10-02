// Worker statements are structured context, never independent completion proof.
export const OUTCOMES = ['done', 'partial', 'blocked', 'needs-input'];
export const NEED_KINDS = ['information', 'authorization', 'access', 'dependency', 'environment'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Object.assign(new Error('Invalid structured outcome.'), { code: 'CLAUDEX_INVALID_OUTCOME' }); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
  && !value.includes('\0') && Buffer.byteLength(value) <= max;
export function validateOutcome(value) {
  if (!object(value) || Object.keys(value).some(key => !['outcome', 'summary', 'remaining', 'needs', 'artifacts'].includes(key))
    || !OUTCOMES.includes(value.outcome) || !text(value.summary, 4096)) fail();
  if (value.remaining !== undefined && (!Array.isArray(value.remaining) || value.remaining.length > 16
    || value.remaining.some(item => !text(item, 2048)))) fail();
  if (value.needs !== undefined && (!Array.isArray(value.needs) || value.needs.length > 16
    || value.needs.some(item => !object(item) || Object.keys(item).some(key => !['kind', 'description'].includes(key))
      || !NEED_KINDS.includes(item.kind) || !text(item.description, 2048)))) fail();
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length > 32
    || value.artifacts.some(item => !object(item) || Object.keys(item).some(key => !['kind', 'reference', 'description'].includes(key))
      || !['file', 'url', 'commit', 'other'].includes(item.kind) || !text(item.reference, 2048)
      || item.description !== undefined && !text(item.description, 2048)))) fail();
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) fail();
  return structuredClone(value);
}

export function outcomePresentation(task) {
  const report = task.active?.report ?? task.lastExecution?.report;
  return report ? { ...structuredClone(report), current: report.generation === task.generation
    && (task.status === 'running' || task.status === 'completed' || task.status === 'waiting') }
    : { provenance: 'unreported', outcome: null };
}
