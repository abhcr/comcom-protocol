# Comcom Protocol

**A shared language for business software.**

Imagine booking a dentist appointment from an app you already use. Your app needs to know what the clinic offers, how to request a booking, and whether it was accepted. Comcom proposes a common way for the two systems to exchange that information.

## What is it?

Comcom is an open set of rules for software to exchange business requests and results in a shared format. A request might book an appointment, place an order, or check a delivery. Developers add support to their existing software; Comcom is not a booking app or a marketplace.

## Why does it matter?

Businesses use different software, so connecting them often requires custom work. Even a simple booking needs both sides to agree on the details and what counts as success. A shared format aims to make those connections easier to build and the results easier to understand.

## How does it work?

1. **Discover:** a business publishes the actions its software supports and the details each action needs.
2. **Request:** an app reads those instructions and sends a request with the required permission.
3. **Get a result:** the business returns a reply the app can read, such as a booking confirmation, a rejection, or a pending status.

Both systems must support Comcom for the actions they exchange. A person can start through a form or an AI assistant; the business software handles the request. The dentist example is illustrative, not a live service.

**Current stage:** experimental. The examples are for evaluation; production readiness and independent interoperability have not been established.

## The technical idea

> Humans should be able to speak naturally. Businesses should communicate precisely.

Comcom is an open protocol for deterministic business interaction on the web. A business advertises exact, versioned capabilities; another business discovers them through RFC 9727 and exchanges authenticated, schema-valid JSON. The business-to-business path needs no model, tokens, embeddings, phone imitation, or natural-language interpretation.

UI and AI adapters remain useful at the human edge:

`Human ↔ UI or AI adapter ↔ Comcom ↔ Business`

The structured Comcom message and result—not an AI explanation—are the authoritative business record.

## Maturity

Comcom v0.2 is experimental. All 201 capability profiles are currently `draft`; catalog presence does not imply normative status or global interoperability. Each capability must pass domain, security, independent conformance, lifecycle, and interoperability evidence gates before normative promotion.

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

## Contributing and governance

Business semantics are authored under `profiles/v0.2/`. Generation is limited to indexes, detail pages, bundles, and digests; it cannot invent schemas, lifecycle transitions, fixtures, or maturity evidence. See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
