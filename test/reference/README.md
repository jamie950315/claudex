# JavaScript behavioral reference

`bin/` preserves the former JavaScript entry points unchanged. They are not
product commands and must not be called by the Rust runtime. Their original
relative imports are intended for the isolated overlay created by
`dev/test-reference.mjs`, not direct execution from this directory.

`assets/` preserves the matching pre-migration Mod manifest/host/observer and
Swift process adapter from the migration baseline. Their old Node engine
contract belongs only to this reference fixture; the normal product sources
use the native Rust executable. Keep each reference host and its manifest
coherent instead of weakening the old behavioral tests to accept new packaging.

Run the existing reference suite with `npm run test:reference`, or select test
files with `npm run test:reference -- test/cli.test.mjs`.
The runner copies current reference sources and test assets into its own
temporary directory, restores these entry points there, and removes only that
directory when the child test process exits. It never installs or starts the
user's services. Rust entry-point tests run separately with
`npm run test:entrypoints`.
