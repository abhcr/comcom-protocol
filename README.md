# Comcom Protocol

Comcom is an experimental protocol for businesses to publish exact capabilities and exchange typed, correlated JSON results. It gives a booking, order, or other supported interaction a shared capability ID, version, schema, and lifecycle. Coding agents can inspect those contracts, evaluate fit, and build an integration using ordinary HTTP and the included validators.

Start with the working **booking demo**, or inspect **Purplecore's prepared discovery-only website integration**. A website can publish its identity and contact link without offering a business API. Purplecore's public deployment is pending; the walkthrough reports failure until its discovery routes are deployed and verified.

**Maturity:** all 201 capability profiles remain `draft`. The examples demonstrate implementation behavior; they do not establish production readiness or independent interoperability. Implement only the capabilities your application actually supports.

## Run the booking evaluation

Requires Node.js 24. No API key or Python setup is needed for this demo.

```sh
git clone https://github.com/abhcr/comcom-protocol.git
cd comcom-protocol
npm ci
npm run demo:v0.2
```

The command starts and stops its own responder on an available loopback port. It uses fresh IDs and timestamps and fails if any assertion fails. Expected results:

```text
PASS discovery and pinned-profile manifest validation
PASS booking.create: HTTP 200, correlated and identity-bound result
PASS exact replay: identical response bytes
PASS changed request with reused key: HTTP 409 idempotency-conflict
PASS asynchronous booking: HTTP 202 → polling → completed
Evaluation passed. No external business service was called.
```

**Demo transport:** HTTP loopback and mocked authentication headers are development-only. The advertised `vendor.example` HTTPS URLs are mapped to the local responder by this runner. Production implementations require HTTPS and real transport identity/authorization binding.

Read the [booking and Purplecore evaluation walkthrough](https://abhcr.github.io/comcom-protocol/evaluate.html), or [inspect its source](docs/evaluate.html). The [offline browser checker](https://abhcr.github.io/comcom-protocol/#checker) checks document shapes; use the CLI for contextual validation.

## Decide whether it fits

Comcom is useful to evaluate when independent systems need shared business semantics, exact replay behavior, and machine-readable results. A contact-only website can use the discovery profile. If a project only needs its own API documented, begin with its existing API contract; Comcom adoption should follow a demonstrated interoperability need.

| Interface | Main purpose | Where Comcom fits |
| --- | --- | --- |
| [HTTP/OpenAPI](https://spec.openapis.org/oas/v3.1.1.html) | Describe a service's HTTP operations, parameters, and responses. | Comcom adds shared business capability semantics and message/lifecycle rules. It uses OpenAPI security requirement semantics. |
| [MCP](https://modelcontextprotocol.io/specification/2025-11-25) | Connect applications using language models to tools, resources, and prompts. | An MCP tool could wrap a Comcom capability; this repository provides no MCP server. |
| [A2A](https://a2a-protocol.org/latest/specification/) | Enable communication and task collaboration between agents. | Comcom defines business interactions independently of whether either participant is an AI agent. |

An adapter may help a human express intent. The structured business request and result remain the authoritative records.

## Evaluate with a coding agent

Copy this prompt into your project's agent session:

> Evaluate Comcom for one concrete interaction in this project. Read its README, AGENTS.md, and evaluation walkthrough. Run `npm ci` and `npm run demo:v0.2` in a separate checkout. Compare the exact capability input/output, security, lifecycle, retry, and reversal requirements with our existing code. Report the commit, commands, observed outcomes, missing requirements, and the smallest useful integration or a reason not to adopt. Do not add a dependency, send an enquiry, or make a real business transaction without authorization. Propose a focused implementation report or contribution supported by reproducible evidence.

## Discovery and compatibility

Production discovery uses HTTPS `GET` or `HEAD` at `/.well-known/api-catalog` with `application/linkset+json`. Its manifest link declares an exact profile:

- `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest` describes the original interactive manifest.
- `https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest` also accepts a discovery-only publisher: entity identity, `roles: ["discoveryPublisher"]`, empty profiles/capabilities, and an optional HTTPS `contactUrl` navigation link.

The v0.2.1 profile does not create an enquiry API. A `contactUrl` may identify a page fragment and must not be interpreted as a callable endpoint. Older validators do not understand this new profile. Existing CLI/library callers default to the v0.2.0 manifest profile; pass `manifestProfile` explicitly for v0.2.1.

The wire protocol remains `0.2` and existing capability versions remain `0.2.0`. Published v0.1.0/v0.2.0 artifacts are frozen. `/.well-known/comcom` is only a v0.1 compatibility route and is not an IANA-registered suffix.

## Use the validators

The Node and Python CLIs accept a context JSON document, a blank line, then raw document bytes on standard input. Commands are `request`, `response`, `discovery`, `manifest`, and `release-bundle`. Verdicts contain `valid`, `phase`, `code`, and normalized `errors`.

```sh
{ printf '%s\n\n' '{"manifestProfile":"https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest"}'; cat examples/v0.2.1/purplecore-manifest.json; } \
  | node reference/v0.2/cli.mjs manifest
```

Full request validation needs the receiver manifest, selected endpoint, and trusted transport identity/security context. Full response validation requires the original request and a trusted `transport.senderId` for the responder; do not copy that identity from an untrusted response. Validators load pinned local artifacts and do not retrieve message-supplied schema URLs.

For an application integration, select one advertised capability, pin the release artifacts, map your existing business operation to its input/output contract, bind authenticated transport identity, and run the positive and negative fixtures. Do not advertise a capability until its actual behavior meets that contract. See the [kernel specification](spec/v0.2/specification.md) and [discovery-only profile](spec/v0.2.1/discovery.md).

Python is optional for the booking demo and required for independent cross-validator checks:

```sh
python3.13 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm run conformance:v0.2
```

## Inspect and contribute

- [Capability catalog](https://abhcr.github.io/comcom-protocol/capabilities/) and [authored profile sources](profiles/v0.2/).
- [Pinned v0.2.0 manifest](releases/v0.2.0/release-manifest.json) and [v0.2.1 discovery release](releases/v0.2.1/release-manifest.json).
- [Contribution guide](CONTRIBUTING.md), [agent instructions](AGENTS.md), [governance](GOVERNANCE.md), and [security](SECURITY.md).
- [Submit an implementation report](https://github.com/abhcr/comcom-protocol/issues/new?template=implementation-report.yml) or [find contribution opportunities](https://github.com/abhcr/comcom-protocol/issues).

Evaluate one booking capability in your project and submit a reproducible implementation report. Documentation fixes and focused regression tests can go directly to pull requests. Purplecore is a first-party deployment and does not count as independent interoperability evidence.

Apache License 2.0. See [LICENSE](LICENSE).
