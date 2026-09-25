// Exact runtime versions with isolated native transport/history evidence.
// Keep the rollout codec's schema label separate from runtime compatibility.
export const SUPPORTED_CODEX_VERSIONS = Object.freeze([
  'codex-cli 0.155.0-alpha.16.3',
  'codex-cli 0.155.0-alpha.16.4',
]);
export const isSupportedCodexVersion = version => SUPPORTED_CODEX_VERSIONS.includes(version);
