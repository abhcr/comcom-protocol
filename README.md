# Comcom Protocol

> Humans should be able to speak naturally. Businesses should communicate precisely.

Comcom is an open protocol for deterministic business interaction on the web. A business advertises exact, versioned capabilities; another business discovers them through RFC 9727 and exchanges authenticated, schema-valid JSON. The business-to-business path needs no model, tokens, embeddings, phone imitation, or natural-language interpretation.

UI and AI adapters remain useful at the human edge:

`Human ↔ UI or AI adapter ↔ Comcom ↔ Business`

The structured Comcom message and result—not an AI explanation—are the authoritative business record.

## Maturity

Comcom v0.2 is experimental. All 201 capability profiles are currently `draft`; catalog presence does not imply normative status or global interoperability. Each capability must pass domain, security, independent conformance, lifecycle, and interoperability evidence gates before normative promotion.

V0.1.0 is a [frozen experimental prototype](advisories/v0.1.md). Its schema, registry, fixture, and specification bytes are guarded by [a recorded SHA-256 manifest](releases/v0.1.0/sha256.json).

## Try v0.2

Requirements are Node.js 24 and Python 3.13.

```sh
npm install
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run check:v0.2
npm test
npm run conformance:v0.2
```

Run the non-conformant HTTP-loopback demo:

```sh
node reference/v0.2/server.mjs
```

Production discovery is HTTPS `GET` or `HEAD` at `/.well-known/api-catalog` with media type `application/linkset+json`. See the [complete discovery, manifest, request, result, and asynchronous examples](examples/v0.2/).

## What v0.2 contains

- [Normative kernel specification](spec/v0.2/specification.md) with RFC 9727 discovery, OpenAPI 3.1.1 security semantics, raw-byte validation order, safe URL resolution, RFC 8785 idempotency, and asynchronous operations.
- 201 stable `comcom.*` IDs in [individually committed profile sources](profiles/v0.2/) with closed input, output, and resource schemas, lifecycle, reversal, errors, mappings, fixtures, and evidence.
- [Machine-readable v0.2 registry](registry/v0.2/capabilities.json) and 20 profile bundles.
- Independent Node.js and Python validators with the same CLI framing and verdict model.
- [Independent raw conformance corpus](conformance/v0.2/cases.json), including duplicate-key and invalid-encoding cases.
- Digest-verified [release manifest](releases/v0.2.0/release-manifest.json) and a 16-MiB-bounded [offline bundle](releases/v0.2.0/offline-bundle.json).
- A no-AI reference responder with exact replay, conflict, synchronous, asynchronous, and polling behavior.
- Static documentation with permanent pages for every capability, a no-JavaScript catalog, and a fully bundled offline browser checker.

## Validator CLI

Both implementations accept a context JSON document, a blank line, and the raw document bytes on standard input. Commands are `request`, `response`, `discovery`, `manifest`, and `release-bundle`.

```sh
{ printf '%s\n\n' '{"method":"GET","contentType":"application/linkset+json"}'; cat examples/v0.2/discovery.json; } \
  | node reference/v0.2/cli.mjs discovery
```

Use `reference/v0.2/comcom_validator.py` in the same way for Python. Each writes JSON containing `valid`, `phase`, `code`, and normalized `errors`.

## Roles and subsets

Implementations declare any applicable combination:

- `responder` receives queries and commands;
- `initiator` sends interactions and may expose no receive capability;
- `inboxReceiver` receives declared events;
- `asyncResponder` supports operation polling.

A one-capability responder is conformant. A business implements only what it actually supports.

## Discovery compatibility

V0.2 uses the registered RFC 9727 `/.well-known/api-catalog` mechanism. `/.well-known/comcom` exists only as an explicitly labelled v0.1 compatibility route and is not an IANA-registered suffix.

## Contributing and governance

Business semantics are authored under `profiles/v0.2/`. Generation is limited to indexes, detail pages, bundles, and digests; it cannot invent schemas, lifecycle transitions, fixtures, or maturity evidence. See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
