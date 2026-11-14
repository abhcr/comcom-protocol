# Changelog

## Unreleased

- Added `discoverCapability` (`reference/v0.2/discover.mjs`) and `npm run discover`: given a business HTTPS origin and an exact capability ID/version, retrieve the API catalog and manifests with safe retrieval, validate them against pinned profiles, and report whether receipt is advertised with its forms and security requirements.
- Discovery evaluates every listed manifest in canonical order, reports all matches, returns `ambiguous` when matching manifests declare different contracts, and reports identity facts (`entityMatchesOrigin`, `externalFormOrigins`, `crossOrigin`). The manifest limit is configurable with `maxManifests`.
- Added an overall discovery deadline (`deadlineMs`, `--deadline-ms`, default 30 s) covering the catalog and all manifest retrievals, including DNS resolution and redirect hops. Per-retrieval timeouts and the manifest limit still apply. On expiry, discovery fails with `discovery-deadline-exceeded` and lists what remains `unchecked`.
- Fixed: a DNS lookup that blocked past the deadline and then returned could still open a connection or send a request, including on a redirect hop. `secureFetch` now checks the clock before every DNS lookup and every request, and accepts an optional absolute `deadline`. Blocking can still delay the failure response until the blocking call returns.
- Added deterministic loopback integration tests for advertised, ambiguous, not-advertised, discovery-only, deadline, and failure outcomes.
- Fixed: a failed discovery's `source.manifests` could still show another manifest's `advertised` outcome, entity, and roles. Failed results now list only `url`, `profile`, `checked`, and a failing manifest's own `code`, matching the deadline failure shape. The MCP server applies the same restriction independently.
- Added `createInteractionClient` (`reference/v0.2/interaction-client.mjs`): discover, prepare and validate a request from the discovered contract, submit the validated bytes through `secureFetch`, validate results, problems, and operations, and poll declared status URLs. Nothing is submitted unless discovery is `advertised` and the request validates. It has no MCP or model dependency.
- The client requires a caller-supplied trusted responder identity (`responderIdentity`) before submitting. It has no fallback to a manifest's `entity.id`. A missing identity (`responder-identity-unavailable`) or one that differs from the discovered entity (`responder-identity-mismatch`) returns `not-submitted` with no request sent. Discovery identity stays informational.
- Added an MCP server over stdio (`reference/v0.2/mcp-server.mjs`) with two read-only tools, `discover_capabilities` and `prepare_request`, built on the interaction client. Identity, credentials, and transport settings are server-side configuration that tool inputs cannot override; responses contain no credentials; nothing is submitted. Added `npm run mcp` and `npm run mcp:example`. New dependencies: `@modelcontextprotocol/sdk` 1.32.2 and `zod` 4.6.7, pinned exactly and used only by the MCP server.
- The booking demo now runs through the client. Its mocked authentication and its explicitly stated mocked responder identity are in the demo-only `reference/v0.2/demo-auth.mjs`. `secureFetch` accepts a request `body`.

## 0.2.1 — Experimental discovery publishers

- Added a pinned discovery-only manifest profile with company identity and a contact navigation link.
- Added a runnable booking demo, complete browser examples, agent guidance, and evaluation instructions.
- Enforced total retrieval deadlines, artifact integrity before validator use, and trusted response identities.
- Preserved published v0.2.0 artifacts and all 201 draft capability profiles.

## 0.2.0 — Experimental

- Define RFC 9727 discovery, capability publication, deterministic message envelopes, HTTP outcomes, idempotency, lifecycle, inbox receipts, asynchronous operations, and extension namespaces.
- Publish 201 draft cross-domain capability profiles with closed schemas, lifecycle examples, and conformance fixtures.
- Provide Node.js and Python validators, a reference responder, an offline browser checker, tests, CI, and GitHub Pages documentation.
- Document AI and UI as optional edge adapters; no model is required by the protocol or reference package.
