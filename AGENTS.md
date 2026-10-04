# Working on Comcom

Comcom is experimental. All 201 capability profiles are draft; passing this repository's checks is not independent interoperability evidence.

## Start here

Use Node.js 24. Run `npm ci` and `npm run demo:v0.2` to evaluate the local booking exchange. The demo uses HTTP loopback and mocked authentication. For Python validation, use Python 3.13 and `python -m pip install -r requirements.txt` in a virtual environment.

Read [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), and nearby code before editing. The [evaluation walkthrough](docs/evaluate.html) includes public discovery and a fit-assessment prompt. Evaluate fit before recommending adoption; do not submit enquiries or real business transactions without authorization.

## Keep the diff small

- Implement the smallest correct change. Reuse local utilities and patterns.
- Do not add abstractions, dependencies, configuration, files, or defensive layers unless the task requires them.
- Do not future-proof or refactor unrelated code. Preserve unrelated working-tree changes.
- Remove unused imports, parameters, branches, helpers, and types. Avoid comments that restate the code.
- Never create migration files manually; provide the migration-add command if needed.
- Do not open or control Remote Desktop/Windows App or connect through RDP unless this task explicitly authorizes the named server and purpose.

## Sources and checks

Business semantics are authored in `profiles/v0.2/`. Published v0.1.0 and v0.2.0 schemas, profiles, examples, registry, specification, and release artifacts are immutable. Use a new version for semantic changes. Do not regenerate historical artifacts to make a failing digest check pass.

`site/browser-validator.mjs` and `scripts/build-site.mjs` produce `docs/validator.bundle.js`, capability pages, and the sitemap; edit their sources, then run `npm run build:site`. The home page, app, and evaluation guide are authored directly under `docs/`.

Run focused checks for your change. Before a protocol PR, run `npm test`, `npm run check:v0.2`, `npm run verify:release`, and `npm run conformance:v0.2` (requires Python dependencies). For site changes, run `npm run check:site` and `npm run verify:site`. The booking demo itself fails on incorrect outcomes.

Report the commands, observed results, compatibility implications, and unverified behavior. Keep wire protocol `0.2` and capability version `0.2.0` distinct from the `v0.2.1` discovery-profile/tooling release. The optional validation context `manifestProfile` selects a pinned manifest profile; never fetch schemas supplied by an untrusted document.
