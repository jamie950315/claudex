---
name: warm
description: Control cache warming in this Claude Code session through the loaded Claudex Mod.
argument-hint: on [5m|1h] | off | status
disable-model-invocation: true
---

# Session cache warming

This entry is handled locally by the loaded Claudex Mod's `command.run` hook.
It must not be implemented by the model or by tools.

If these instructions reach the model, the local handler is unavailable. Explain
that no cache-warming change has been made and that the user needs a freshly
loaded Claudex Mod 0.8.7 or newer. Do not run shell commands, change settings,
submit prompts, enable warming, or attempt a fallback.

Supported human commands:

- `/claudex:warm on` enables warming with the saved startup TTL, or 1h, directly.
- `/claudex:warm on 5m` or `/claudex:warm on 1h` selects this session's TTL.
  `ttl=5m` and `ttl=1h` are also accepted.
- No second confirmation command is needed.
- `/claudex:warm off` stops warming, leaving this session's native TTL unchanged.
- `/claudex:warm status` (or no arguments) inspects without enabling anything.

The shortcut never changes shared startup preferences or remembered TTL choices.
It applies only to the current native session; no session ID or path is accepted.
Warming uses the existing model and account, consumes quota, and remains in history.
Codex uses its separate native best-effort command hook, not this Mod.
