# Comcom Protocol v0.2.0

## Status

This specification defines Comcom v0.2. Version 0.2.0 is experimental. A capability is interoperable only to the maturity stated by its own profile and evidence record; publication in the catalog does not make it normative.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described by BCP 14 when they appear in capitals.

## Principle and scope

> Humans should be able to speak naturally. Businesses should communicate precisely.

Comcom defines deterministic discovery, capability advertisement, request, response, receipt, and lifecycle semantics between businesses. Protocol conformance MUST NOT depend on a model, prompt, embedding, probabilistic match, or natural-language interpretation.

User interfaces and AI systems MAY operate at the human boundary:

`Human ↔ UI or AI adapter ↔ Comcom ↔ Business`

An adapter selects an exact advertised capability, constructs a schema-valid message, presents exact business consequences, and renders the structured result. Its conversation, confidence, and reasoning are not part of the authoritative wire message. An adapter MUST NOT bypass authorization, confirmation, pricing, expiry, or policy requirements.

## Versions and identifiers

- The wire `protocolVersion` is the major/minor string `0.2`.
- Capability and profile versions are exact SemVer strings. Core v0.2 capability profiles use `0.2.0`.
- Core capability identifiers begin with `comcom.`. External profiles use reverse-domain namespaces.
- Canonical v0.2 artifacts use release-qualified HTTPS identifiers under `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/`.
- Implementations MUST compare capability versions exactly. Range negotiation is outside a message.

## Roles

An entity declares any applicable combination:

- `responder`: receives queries or commands;
- `initiator`: sends queries, commands, or events;
- `inboxReceiver`: receives events;
- `asyncResponder`: exposes asynchronous forms.

A responder MAY advertise one capability. An initiator-only entity MAY advertise only `send` declarations or an empty capability list. There is no required broker, directory, blockchain, or hosted Comcom service.

## Discovery

### RFC 9727 API catalog

The required v0.2 discovery resource is:

`https://{business-origin}/.well-known/api-catalog`

It MUST support HTTPS `GET` and `HEAD`. A successful response has media type `application/linkset+json`. The JSON linkset contains an `item` link whose:

- `href` identifies the Comcom manifest;
- `type` is `application/vnd.comcom.manifest+json`; and
- `profile` is `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest`.

`HEAD` returns the same status and representation metadata as `GET` without a body. The discovery representation MUST NOT exceed 64 KiB.

### Safe URL resolution

Conformant network retrieval:

1. parses the URL and rejects credentials, fragments, malformed hosts, and schemes other than HTTPS;
2. resolves the host and rejects every loopback, private, link-local, multicast, reserved, unspecified, documentation, benchmark, and IPv4-mapped private IPv6 result;
3. connects only to a validated resolved address and verifies the connected address, preventing DNS rebinding;
4. applies the same checks to every redirect target and connected address;
5. rejects HTTPS-to-HTTP downgrade;
6. follows at most three redirects;
7. applies one ten-second deadline to resolution, redirects, connection, and body retrieval; and
8. enforces 64 KiB for discovery and 1 MiB for manifests and schemas.

HTTP loopback MAY be enabled by an explicit development option. Such operation is non-conformant and MUST be visibly identified as such.

## Manifest

A manifest contains:

- `protocolVersions`;
- the publishing `entity`;
- conformance `roles`;
- exact HTTPS `serviceOrigins`;
- verified profile release URLs and SHA-256 digests;
- OpenAPI 3.1.1 `securitySchemes` and requirements;
- capability declarations;
- execution and size limits; and
- optional inbox admissions.

Each capability declaration contains the exact ID, exact version, profile, `send` or `receive` direction, allowed request kinds, input and output schema identifiers, execution modes, and—for `receive`—one or more forms. A form declares its URL, HTTP method, media type, execution mode, and security requirements. An asynchronous form also declares its status URL template.

The following role bindings are mandatory:

| Declaration | Required role |
| --- | --- |
| receive `query` or `command` | `responder` |
| receive `event` | `inboxReceiver` |
| send any request kind | `initiator` |
| receive asynchronous form | `asyncResponder` in addition to the receipt role |

Every form URL MUST belong to a declared `serviceOrigin`. A declaration MUST reference a profile and schema from a verified, preloaded release. A receiver MUST NOT dereference a message-supplied schema URL during validation.

## Security

Comcom adopts OpenAPI 3.1.1 Security Scheme Object and Security Requirement Object semantics:

- permitted schemes are `apiKey`, `http`, `mutualTLS`, `oauth2`, and `openIdConnect`;
- `{}` is the anonymous alternative;
- separate requirement objects are alternatives (OR); and
- schemes inside one requirement object are combined (AND).

There is no `none` security scheme. A command form MUST require authenticated security unless its capability declaration explicitly permits anonymous command use.

Validation receives trusted transport context containing `senderId`, active scheme or schemes, scopes, and roles. The context is established by TLS, credentials, a gateway, or another mechanism outside the message. `message.sender.id` MUST equal the trusted `senderId`. A self-asserted sender inside JSON is never authentication.

## Message envelope

Message kinds are:

- `query`: retrieve information without requesting business-state change;
- `command`: request business-state change;
- `event`: communicate a fact, offer, announcement, or state change;
- `result`: response to a query or command; and
- `receipt`: admission response to an event.

The common envelope contains:

- `protocolVersion`, message `id`, and `kind`;
- exact capability ID and version;
- `principal`, authenticated `sender`, and `recipient`;
- optional `agent` and external `authorization` reference;
- `issuedAt` and optional `expiresAt`;
- optional conversation and resource references;
- correlation and idempotency fields;
- optional namespaced extensions and critical-extension names; and
- the profile-typed `payload`.

Commands and events MUST contain `idempotencyKey`. Results and receipts MUST contain `correlationId`. A critical extension name MUST be present in `extensions` and MUST be understood by the receiver. Otherwise validation fails before business logic.

`principal` identifies the accountable person or organization. `sender` identifies the authenticated sending system or business. `agent` identifies optional software, UI, workflow, or AI acting for the principal. These fields do not grant authority; `authorization` refers to authority established outside the message.

## Normative validation algorithm

Validation consumes raw bytes and trusted context. Implementations expose separate request and response validation operations. A receiver MUST perform the following checks in order and stop at the first failure:

1. Enforce the size limit, valid UTF-8, I-JSON, unique object member names, and maximum nesting depth before ordinary JSON parsing.
2. Require wire protocol version `0.2`.
3. Validate the closed envelope schema.
4. Resolve the capability from the verified offline release and require its exact version.
5. Require the request kind defined by the capability.
6. Require an exact manifest advertisement in the applicable direction.
7. Enforce the manifest role binding.
8. Match the recipient to the receiving manifest entity.
9. Match `sender.id` to trusted transport `senderId`.
10. Match the request URL and method to a declared form.
11. Evaluate OpenAPI security alternatives and combined schemes.
12. Require every critical extension to be present and supported.
13. Validate the payload with the preloaded capability schema.
14. For responses, require the expected `result` or `receipt` kind.
15. For responses, require capability identity, participant reversal, and correlation to the original request.
16. Reject `issuedAt` more than 60 seconds in the future, `expiresAt` before `issuedAt`, and an expired first-seen message.

No fuzzy capability matching is permitted. Invalid input is rejected before business logic.

Stable core failures include:

`duplicate-key`, `invalid-encoding`, `non-ijson`, `protocol-version-mismatch`, `capability-version-mismatch`, `message-kind-mismatch`, `direction-mismatch`, `role-mismatch`, `recipient-mismatch`, `sender-identity-mismatch`, `endpoint-mismatch`, `security-requirement-unsatisfied`, `unsupported-critical-extension`, `malformed-critical-extension`, `schema-invalid`, `response-kind-mismatch`, `correlation-mismatch`, `message-expired`, and `idempotency-conflict`.

Failures use RFC 9457 `application/problem+json` and include stable `phase` and `code` members.

## JSON Schema and offline validation

Comcom schemas use JSON Schema 2020-12 and require the `format-assertion` vocabulary. Formats are assertions, not documentation-only annotations. Compound release bundles preload kernel and profile schemas. Implementations MUST validate `$id` and digest membership before use and MUST NOT retrieve new schemas while validating a message.

The limits are:

- discovery: 64 KiB;
- manifest, schema, or message: 1 MiB each;
- offline bundle: 16 MiB; and
- JSON nesting and reference traversal: implementation-enforced bounds documented by the conformance profile.

Profile resources are closed objects. Common resource fields are `id`, `type`, `state`, `revision`, `createdAt`, and `updatedAt`. Profile-specific fields are explicit. There is no generic `attributes`, `criteria`, `content`, or arbitrary business-property bag.

Money uses a decimal string and ISO 4217 currency. Quantities use a decimal string and declared unit code. Instants use RFC 3339. Wall-time scheduling also carries an IANA time-zone identifier. Countries use ISO 3166-1 alpha-2 and languages use BCP 47. Extensibility is limited to declared namespaced extension containers.

## Deterministic idempotency

For every command or event, the receiver keys storage by:

`(authenticated sender ID, capability ID, idempotency key)`

It computes SHA-256 over the RFC 8785 JCS serialization of this semantic projection:

- capability;
- principal;
- recipient;
- authorization, when present;
- resource reference, when present;
- payload; and
- the values of named critical extensions.

Retry-specific message IDs, timestamps, expiry, and agent metadata are excluded. Inputs with duplicate keys or non-I-JSON values are rejected before hashing.

For a matching stored hash, the receiver returns the exact stored HTTP status and exact stored envelope. This includes the original message ID and operation ID. For a different hash under the same tuple, it returns HTTP 409 `idempotency-conflict`. The lookup occurs before first-seen expiry rejection: a recorded result remains retrievable after the original expiry, while an expired first-seen request is rejected before business logic. Authentication and sender binding still apply to a replay.

The receiver retains the record for at least its declared `idempotencyRetentionSeconds`.

## Asynchronous execution

An asynchronous command returns HTTP 202 with a `result` envelope. Its payload is a typed operation containing:

- operation ID and HTTPS status URL;
- state;
- accepted and updated timestamps;
- original request correlation; and
- when applicable, completion timestamp, output, or stable problem reference.

States are `accepted`, `inProgress`, `completed`, `failed`, and `cancelled`. Polling returns a new `result` envelope correlated to the original request. A completed operation contains the capability's exact output payload. A failed operation contains a stable RFC 9457 problem reference. An idempotent retry returns the original HTTP 202 envelope and operation ID even when polling has since completed.

## Inbox events

An inbox admission declares exact capability IDs, topics, sender constraints, maximum bytes, and security requirements. A receiver may omit an inbox.

A successful event admission returns a `receipt` with one disposition:

- `accepted`: admission policy passed; storage or action is not promised;
- `discarded`: valid but intentionally not processed; or
- `duplicate`: already received.

Internal retention, routing, storage, or ignoring behavior does not alter wire semantics. Invalid and unauthorized events return RFC 9457 problems, not receipts.

## Capability profiles and maturity

The catalog contains 201 `comcom.*` identifiers, each assigned to an authored profile. Each capability has closed input, output, and resource schemas; actors; purpose; request kind; security floor; preconditions; execution modes; lifecycle; retry and reversal behavior; stable errors; standards mappings; examples; and evidence.

Maturity states are `proposal`, `draft`, `experimental`, `normative`, `deprecated`.

A capability MUST NOT become normative until its evidence records:

- primary standards mapping and domain review;
- complete positive and independently authored negative fixtures;
- every allowed and forbidden lifecycle transition;
- matching Node and Python verdicts;
- at least two successful interoperability journeys;
- security review; and
- immutable conformance-run digests.

Generation MAY build registry indexes, documentation pages, bundles, and digest manifests. It MUST NOT invent business schemas, state transitions, fixtures, or semantics.

## Releases and conformance

Every release contains a compound kernel schema bundle, profile bundles, registry, independent conformance corpus, offline bundle, and SHA-256 manifest. Friendly Pages aliases MUST match the immutable release bytes. Release tags and assets SHOULD use GitHub immutable releases when available.

The reference validation CLI receives a context JSON document, a blank line, and then raw document bytes on standard input. It writes one JSON verdict containing `valid`, `phase`, `code`, and normalized `errors`. Commands are `request`, `response`, `discovery`, `manifest`, and `release-bundle`.

Node.js 24 and Python 3.13 validators MUST agree on the independent corpus. Production protocol and conformance code MUST contain no model calls, model API keys, tokens, embeddings, or probabilistic matching.

## IANA considerations

Comcom uses the registered RFC 9727 `api-catalog` well-known URI. This specification requests no new IANA registrations.
