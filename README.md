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

The demo runs through the reusable [interaction client](#submit-an-interaction-with-the-client): it discovers `comcom.booking.create`, prepares and validates each request from the discovered contract, submits it, and validates every result.

**Demo transport:** HTTP loopback and mocked authentication headers are development-only. The mocked headers come from `reference/v0.2/demo-auth.mjs`, which only the demo and tests use and which never attaches its token outside the locally mapped origin. The advertised `vendor.example` HTTPS URLs are mapped to the local responder by this runner. Production implementations require HTTPS and real transport identity/authorization binding.

Read the [evaluation walkthrough](https://abhcr.github.io/comcom-protocol/evaluate.html), or [inspect its source](docs/evaluate.html). The [offline browser checker](https://abhcr.github.io/comcom-protocol/#checker) checks document shapes; use the CLI for contextual validation.

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

> Evaluate Comcom for one concrete interaction in this project. Read its README and evaluation walkthrough. Run `npm ci` and `npm run demo:v0.2` in a separate checkout. Compare the exact capability input/output, security, lifecycle, retry, and reversal requirements with our existing code. Report the commit, commands, observed outcomes, missing requirements, and the smallest useful integration or a reason not to adopt. Do not add a dependency, send an enquiry, or make a real business transaction without authorization. Propose a focused implementation report or contribution supported by reproducible evidence.

## Discovery and compatibility

Production discovery uses HTTPS `GET` or `HEAD` at `/.well-known/api-catalog` with `application/linkset+json`. Its manifest link declares an exact profile:

- `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest` describes the original interactive manifest.
- `https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest` also accepts a discovery-only publisher: entity identity, `roles: ["discoveryPublisher"]`, empty profiles/capabilities, and an optional HTTPS `contactUrl` navigation link.

The v0.2.1 profile does not create an enquiry API. A `contactUrl` may identify a page fragment and must not be interpreted as a callable endpoint. Older validators do not understand this new profile. Existing CLI/library callers default to the v0.2.0 manifest profile; pass `manifestProfile` explicitly for v0.2.1.

The wire protocol remains `0.2` and existing capability versions remain `0.2.0`. Published v0.2.0 artifacts are frozen.

Fictional example: [Example Company](docs/evaluate.html#publisher) illustrates identity and a contact link, with no callable interactions. Its `publisher.example` URLs are placeholders, not live endpoints.

## Discover a business capability

Check whether a business advertises that it can receive one exact capability:

```sh
npm run discover -- https://business.example comcom.booking.create 0.2.0 --pretty
```

The command retrieves `https://business.example/.well-known/api-catalog`, takes the Comcom manifest links anchored at that origin, retrieves and validates **every** listed manifest against its pinned profile, and prints one JSON result. Catalog order never affects the result:

- `outcome: "advertised"` (exit 0): every matching manifest declares the same contract. The result includes `entity`, `declaration`, each `forms` entry with its OpenAPI `security` requirement alternatives, the referenced `securitySchemes`, `identity` facts, and `matches` listing each manifest that advertised it;
- `outcome: "ambiguous"` (exit 3): matching manifests differ in endpoints, security, entity, roles, origins, or limits. All `matches` are returned and no contract is chosen. Differences that are only ordering (forms, security alternatives, scopes, modes) are not ambiguous;
- `outcome: "not-advertised"` (exit 1): `code` is `direction-mismatch` (send only), `capability-not-advertised`, or `discovery-only-publisher`, in that precedence. Per-manifest entity and any `contactUrl` are in `source.manifests`; a `contactUrl` is a navigation link, not an endpoint;
- `outcome: "failed"` (exit 2): discovery could not be completed; `phase` and `code` identify why. If any listed manifest fails, no conclusion is drawn, even when another manifest advertises the capability, because the unread manifest could conflict. A failed result has no `matches` or contract. Each `source.manifests` entry holds only `url`, `profile`, `checked`, and, for a manifest that itself failed, its `code`; it never includes another manifest's outcome, entity, or roles. The MCP tools return the same restricted view. Usage errors exit 64.

By default at most 4 distinct manifest URLs are retrieved, to bound cost. This is a local policy, not a protocol limit. A larger catalog fails with `manifest-link-limit` without retrieving any manifest; raise the limit with `--max-manifests` (up to 1024, the catalog schema maximum).

Two time limits apply. Each retrieval, including its DNS resolution and every redirect hop (each with its own DNS resolution), has its own timeout (`--timeout-ms`, default 10 s). One overall deadline (`--deadline-ms`, default 30 s, maximum 600 s) covers the catalog and all manifest retrievals, which run sequentially. It starts when catalog retrieval starts, so argument checks and loading the pinned artifacts are excluded. Each retrieval gets the smaller of its own timeout and the time remaining, so slow DNS and redirect chains spend the same budget; neither resets it. The clock is also checked before every DNS lookup and again before every request, including each redirect hop. So no lookup, connection, or request starts after the deadline, even when a resolver blocks past the deadline and then returns an answer.

Blocking can delay the failure response. A timer cannot interrupt code that blocks the event loop, such as a synchronous resolver. Discovery therefore reports the deadline failure only when the blocking call returns, which can be later than the deadline. The late answer is discarded without starting a request. A lookup already in progress when the deadline passes cannot be cancelled; it completes in the background and its answer is discarded.

When a limit is reached:

- if a retrieval's own timeout is the shorter limit and expires, it fails with `fetch-timeout` as before. For a manifest, the remaining manifests are still checked, and the result is `failed` once they finish;
- if the overall deadline expires, including when blocking overran both limits, no further retrieval starts. The result is `failed` with `code: "discovery-deadline-exceeded"`, `deadlineMs`, and `unchecked`. `unchecked` lists either the catalog (`kind: "catalog"`; manifest links are then unknown) or every manifest link not yet checked (`kind: "manifest"`, with `url` and `profile`). `source.manifests[].checked` marks each link. No `matches` or contract is returned, and no advertised, ambiguous, or not-advertised conclusion is drawn from partial results.

`identity` reports facts that discovery can determine, but it cannot judge legitimacy. `entityMatchesOrigin` shows whether `entity.id` has the requested origin. `externalFormOrigins` lists form origins outside it. Each match's `manifest.crossOrigin` shows whether the manifest is hosted elsewhere. The protocol defines no proof that a differing entity authorized this origin to publish for it, so treat `entityMatchesOrigin: false` as requiring out-of-band verification.

Retrieval is HTTPS-only with the safe URL rules in the specification: public addresses, pinned DNS, at most three redirects, a ten-second deadline per retrieval, 64 KiB for the catalog and 1 MiB for each manifest. The capability must be in the pinned registry at that exact version. Discovery never calls a declared form or retrieves schema URLs. In code, use `discoverCapability({ origin, capability: { id, version } })` from `reference/v0.2/discover.mjs`.

For local development only, `--development-origin https://vendor.example=http://127.0.0.1:8788` maps an advertised origin to a loopback responder such as `node reference/v0.2/server.mjs` (port 8788). Such results report `conformant: false`.

## Submit an interaction with the client

`createInteractionClient` in `reference/v0.2/interaction-client.mjs` connects discovery to submission for any advertised capability. It uses no model on either side: every step is deterministic validation against pinned artifacts.

```js
import { createInteractionClient } from "./reference/v0.2/interaction-client.mjs";

const client = createInteractionClient({
  authenticate,        // caller-supplied credentials
  responderIdentity    // caller-supplied trusted responder identity (required)
});
const result = await client.interact({
  origin: "https://business.example",
  capability: { id: "comcom.booking.create", version: "0.2.0" },
  input: { principal, sender, payload, executionMode: "synchronous" }
});
```

1. **Discover.** `discoverCapability` runs with the rules above. Anything other than `outcome: "advertised"` stops the flow with `outcome: "not-submitted"`, `stage: "discovery"`, and `submitted: false`. This covers failed, ambiguous, not-advertised, and deadline results.
2. **Prepare.** For each form with the requested execution mode, the client first asks `responderIdentity` for the trusted identity of the form's origin. It must be an absolute URI equal to the discovered `entity.id`. Only then does it ask `authenticate` for credentials, so none are obtained for an unconfirmed responder. The first form that passes both is used. It builds the envelope with the recipient set to the discovered entity and the kind set to the capability's registered request kind. It then validates the serialized request with `validateRequest` against the discovered declaration, form, security requirements, and the identity `authenticate` asserts. Any failure also returns `not-submitted`, with `stage: "prepare"`.
3. **Submit.** The exact validated bytes are sent to the form with `secureFetch`. Redirects are not followed, so a booking is never re-sent elsewhere. An asynchronous form is requested with `Prefer: respond-async` (RFC 7240). This matches the reference responder; Comcom does not yet define how a client selects an asynchronous form.
4. **Validate the result.** Success responses must be `application/comcom+json` and pass `validateResponse`: correlation, reversed participants, the trusted responder identity, and the capability output schema. Error responses must be valid RFC 9457 problems for their HTTP status (`outcome: "rejected"`); anything else is `outcome: "error"`.
5. **Poll.** For HTTP 202, the operation must correlate to the request, and its status URL must match the form's declared `statusTemplate` within the manifest's `serviceOrigins`. Only then is it polled, with the same credentials, until a terminal state or the poll timeout.

`authenticate({ capability, recipient, form, securitySchemes })` returns `{ senderId, scheme, scopes, headers }`, or `null` if it cannot satisfy any of the form's security alternatives.

**Trust boundary.** Discovered catalogs and manifests are claims made by whoever serves them. A manifest's `entity.id` is never trusted as the responder identity, and there is no fallback to it. The caller must supply `responderIdentity({ capability, form, origin })`, which returns the identity its authenticated transport vouches for at that endpoint. Examples are a verified TLS server identity or a pinned partner registry. The hook receives only the endpoint, not the discovered documents, so it cannot simply echo the manifest's claim. That trusted identity is used in two places:

- **before submission:** it must equal the discovered `entity.id`, the recipient the request is addressed to. If the hook is missing, returns nothing, or returns something other than an absolute URI, the result is `not-submitted` with `code: "responder-identity-unavailable"`. If it differs, for example because the manifest claims another business, the result is `not-submitted` with `code: "responder-identity-mismatch"`. In both cases `submitted` is `false` and no request is sent;
- **after submission:** it is the trusted `transport.senderId` for `validateResponse`, so a result is accepted only from that responder.

Discovery is unaffected: it still reports `outcome: "advertised"` and the informational facts in `result.discovery.identity`. The check is made only when a transaction is prepared. In the local demo, `createDemoResponderIdentity` in `demo-auth.mjs` states the mocked identity explicitly, because loopback HTTP authenticates nothing.

`prepare`, `submit`, and `poll` are also available individually. Submitting the same prepared request again replays it with identical bytes and the same idempotency key. Results are plain JSON. A future MCP adapter can expose `interact` as a tool, passing its arguments through and returning the result unchanged; business logic stays in the client, shared by ordinary applications and the adapter.

## Use Comcom from an MCP host

`reference/v0.2/mcp-server.mjs` is a Model Context Protocol server over stdio. It exposes the interaction client to agents through two read-only tools. It does not execute transactions: neither tool sends a business request.

| Tool | Input | Returns |
| --- | --- | --- |
| `discover_capabilities` | `origin`, and 1–5 `capabilities` as `{ id, version }` | For each capability: `outcome` (`advertised`, `ambiguous`, `not-advertised`, or `failed`), forms, security requirements, informational `identity` facts, and the capability's `payloadSchema` from the pinned local artifacts. Ambiguous results list every match; failed results include `unchecked` and `failedManifest` where applicable. |
| `prepare_request` | `origin`, `capability`, `principal`, `payload`, and optional `executionMode`, `authorization` (a reference URI), `idempotencyKey`, `expiresInSeconds` | `outcome: "prepared"` with a `preview`: the validated request envelope, `bodyBytes`, `bodySha256`, `endpoint`, `trustedResponderIdentity`, and a non-secret `authentication` summary (sender, scheme names, scopes). Otherwise `isError: true` with `outcome: "not-prepared"`, the `stage`, and the `code`. `submitted` is always `false`. |

**Server-side identity and credentials.** The server configuration supplies `sender`, `authenticate`, and `responderIdentity`, plus optional `agent`, `timeoutMs`, `discovery` (`deadlineMs`, `maxManifests`), and, for development only, `developmentOrigins`. Tool input schemas are closed: an argument such as `sender`, `responderIdentity`, `headers`, `authenticate`, `agent`, or `developmentOrigins` is rejected as invalid input, not ignored. Responses are built from an allowlist and never include credential headers or tokens. The [trust boundary](#submit-an-interaction-with-the-client) is the interaction client's: without a configured trusted responder identity equal to the discovered entity, `prepare_request` fails with `responder-identity-unavailable` or `responder-identity-mismatch`.

### Try it without an AI model

```sh
npm ci
npm run mcp:example
```

The example starts the local booking responder and launches the MCP server with `reference/v0.2/mcp-demo.config.mjs`, the only configuration using the mocked demo transport. It then calls both tools through the official MCP client, as an agent host would. It prints the request preview and fails if any booking request is sent or any credential appears in a response.

### Connect an MCP host

Start the local responder with `node reference/v0.2/server.mjs` (port 8788), then add the server to your MCP host. Many hosts accept this form:

```json
{
  "mcpServers": {
    "comcom": {
      "command": "node",
      "args": [
        "/absolute/path/to/comcom-protocol/reference/v0.2/mcp-server.mjs",
        "--config",
        "/absolute/path/to/comcom-protocol/reference/v0.2/mcp-demo.config.mjs"
      ],
      "env": { "COMCOM_DEMO_RESPONDER": "http://127.0.0.1:8788" }
    }
  }
}
```

A production configuration is a module default-exporting `sender`, a real `authenticate` hook that returns credentials, and a real `responderIdentity` hook backed by the authenticated transport. It has no `developmentOrigins`. The server writes only MCP messages to stdout; warnings and errors go to stderr. Programs can embed it with `createComcomMcpServer(config)`.

**Limits.** Each `discover_capabilities` capability, and each `prepare_request`, runs its own discovery. The configured discovery deadline bounds each one, so five capabilities can take up to five deadlines. An MCP client cancellation or timeout does not abort retrieval already in progress. That retrieval still ends at the server's deadline, and its result is discarded. `principal` and `authorization` are caller-supplied request data; they are validated but not yet restricted by server policy.

## Use the validators

The Node and Python CLIs accept a context JSON document, a blank line, then raw document bytes on standard input. Commands are `request`, `response`, `discovery`, `manifest`, and `release-bundle`. Verdicts contain `valid`, `phase`, `code`, and normalized `errors`.

```sh
{ printf '%s\n\n' '{"manifestProfile":"https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest"}'; cat examples/v0.2.1/publisher-manifest.json; } \
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
- [Contribution guide](CONTRIBUTING.md), [governance](GOVERNANCE.md), and [security](SECURITY.md).
- [Submit an implementation report](https://github.com/abhcr/comcom-protocol/issues/new?template=implementation-report.yml) or [find contribution opportunities](https://github.com/abhcr/comcom-protocol/issues).

Evaluate one booking capability in your project and submit a reproducible implementation report. Documentation fixes and focused regression tests can go directly to pull requests.

Apache License 2.0. See [LICENSE](LICENSE).
