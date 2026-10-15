// Native launch profiles and public capability reporting share this definition.
// These describe available tools, not an OS read jail or network reachability proof.
export const COLLABORATION_PERMISSION_PROFILES = Object.freeze({
  'read-only': Object.freeze({ network: false, userConfig: false, codexSandbox: 'read-only',
    claudeTools: 'Read,Glob,Grep' }),
  'workspace-write': Object.freeze({ network: false, userConfig: false, codexSandbox: 'workspace-write',
    claudeTools: 'Read,Glob,Grep,Edit,Write' }),
  'full-access': Object.freeze({ network: true, userConfig: true, codexSandbox: 'danger-full-access',
    claudeTools: null }),
});

export function collaborationCapabilities(permission, provider) {
  const profile = COLLABORATION_PERMISSION_PROFILES[permission];
  return { network: profile.network, userConfig: profile.userConfig,
    shell: provider === undefined ? { codex: true, claude: profile.claudeTools === null }
      : provider === 'codex' || profile.claudeTools === null };
}

export const SANDBOX_PERMISSION_DESCRIPTION = 'read-only and workspace-write run in an isolated sandbox with NO network access and do not load the user\'s Codex/Claude config, plugins, MCP servers or hooks (Claude: no Bash or web tools).';
export const PERMISSION_SELECTION_GUIDANCE = 'For work requiring the network, user CLI tools or user MCP servers, first check claudex_list for the broker default, then omit permission to inherit the parent or broker default; these capabilities require full-access.';
export const SANDBOX_WORKER_GUIDANCE = 'If this task needs network access or the user\'s tools/config, report the exact need to the controller in your result or claudex_report instead of retrying or working around the sandbox.';
export const MOD_PERMISSION_GUIDANCE = 'The Mod defaults to read-only and only permits sandboxed levels. For network access or user tools/config, use the existing agent/operator workflow with an authorized full-access default.';
