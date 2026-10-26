# Gateway frontend installation and recovery

[Back to macOS setup](app.md)

Claude Desktop's Gateway profile can load its Code interface directly from
signed `ion-dist` resources instead of its HTTP cache. The explicit
`renderer-bundle` command installs Claudex's structurally verified frontend
adapters in that source. Ordinary setup and background maintenance never modify
or re-sign Claude.app.

This is an advanced operator workflow. It changes Claude.app into a locally
ad-hoc-signed build and keeps the complete original application for restoration.
Allow disk space for another complete app. Native app updates are not silently
patched; a changed app or an older renderer recipe requires explicit attention.
Native authentication, model routing, project trust and permission rules remain.

## Check the source without changing anything

Use the installed `claudex` executable, or `bin/claudex` from a built checkout.
Supply the actual canonical app path; the examples use `/Applications/Claude.app`.
`--root` selects Claudex state and `--home` selects the native home when these
differ from their defaults.

```sh
claudex app renderer-bundle check --app /Applications/Claude.app
claudex app renderer-bundle status --app /Applications/Claude.app
```

`check` verifies the publisher and complete reachable source graph, then prepares
the same transforms as installation without writing them. `status` reports the
saved generation and whether it still matches. Structural checks, signed bytes
and installed resources do not establish that a running interface loaded them
or that a history packet was acknowledged.

## Install while both applications are stopped

1. Use **Quit Claudex** and let its services and owned conversations finish
   draining. Closing the window alone does not stop them.
2. Quit Claude Desktop normally. Keep its native deployment in Gateway mode for
   installation.
3. Run the explicit opt-in command:

   ```sh
   claudex app renderer-bundle install --app /Applications/Claude.app --allow-bundle-modification yes
   ```

The command copies the complete application into a private sibling container,
verifies that copy, patches only proved resources, ad-hoc signs the outer bundle
and verifies its strict deep signature. One atomic exchange installs it and
preserves the complete original. It does not stop or open an app or start a
model query. The output names the exact `journal` and `preservedBundle` paths.
Keep both: neither is a disposable cache.

Open Claude and Claudex normally afterward. Background maintenance recognizes
the installed generation read-only. Each adapter retains its own status; a
folder proof refusal remains explicit even when chat, owner and commands are
installed. Activation remains `load-not-verified` until native acceptance is
established separately.

## Restore, upgrade or resolve an interrupted operation

Stop both applications as above, then restore the complete original:

```sh
claudex app renderer-bundle restore --app /Applications/Claude.app --allow-bundle-modification yes
```

Restoration works after a native switch back to first-party mode too; it does not
require another Gateway sign-out. The previously installed patched app is also
retained. To install a newer Claudex renderer recipe, restore first, select
Gateway natively if needed, then explicitly install with the new executable.

For an interrupted copy or exchange, inspect `status`, then run:

```sh
claudex app renderer-bundle recover --app /Applications/Claude.app --allow-bundle-modification yes
```

Recovery checks where both exact bundles are located; it never repeats an
uncertain exchange. An unpublished interrupted copy may be marked abandoned
while preserving its artifacts. A foreign update, missing original or uncertain
placement refuses recovery and leaves the pending journal intact. Do not delete
the journal, replace a preserved bundle, or manually edit native history to
force it through; retain the reported paths for diagnosis.

If status reports `prepared`, the signed candidate has not been exchanged.
Run the explicit `install` command again to publish that same verified candidate;
it does not copy or sign another app. A `publishing` or `restoring` status must
first go through `recover`, which determines the exact outcome without another
exchange.
