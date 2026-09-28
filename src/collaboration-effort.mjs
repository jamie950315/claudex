// Provider-native values are not translated into equivalent reasoning budgets.
export const collaborationEfforts = Object.freeze({
  codex: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

export function validateCollaborationEffort(provider, value) {
  if (!Object.hasOwn(collaborationEfforts, provider)) throw new Error('Provider must be codex or claude.');
  if (value === null) return null;
  if (typeof value !== 'string' || !collaborationEfforts[provider].includes(value))
    throw new Error(`Unsupported reasoning effort for ${provider}. Expected ${collaborationEfforts[provider].join(', ')} or null.`);
  return value;
}
