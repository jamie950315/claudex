// Behavioral reference for transport-argument tests; never a runtime entry point.
/** Replace transport options only; leave every other original argument intact. */
export function sharedServerArguments(args, socketPath) {
  const valueOptions = new Set(['-c', '--config', '--enable', '--disable', '-C', '--cd', '-p', '--profile']);
  const serverValueOptions = new Set(['--code-mode-host', '--ws-auth', '--ws-token-file', '--ws-token-sha256', '--ws-shared-secret-file', '--ws-issuer', '--ws-audience', '--ws-max-clock-skew-seconds']);
  let command = -1;
  for (let i = 0; i < args.length; i++) {
    if (valueOptions.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    command = i;
    break;
  }
  if (command < 0 || args[command] !== 'app-server') return null;
  const result = args.slice(0, command + 1);
  for (let i = command + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdio') continue;
    if (arg === '--listen') { if (++i >= args.length) throw new Error('Missing app-server transport argument'); continue; }
    if (arg.startsWith('--listen=')) continue;
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V') return null;
    if (valueOptions.has(arg) || serverValueOptions.has(arg)) {
      if (i + 1 >= args.length) throw new Error('Missing app-server option argument');
      result.push(arg, args[++i]);
      continue;
    }
    // Subcommands such as proxy and generate-json-schema are not server owners.
    if (!arg.startsWith('-')) return null;
    result.push(arg);
  }
  return [...result, '--listen', `unix://${socketPath}`];
}
