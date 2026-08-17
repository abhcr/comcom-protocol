# Comcom Protocol v0.1

## Status and normative language

This document defines Comcom Protocol v0.1. The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described by BCP 14 when they appear in uppercase.

The machine-readable schemas and registry published for this version are normative. Prose and schema must agree; an inconsistency is a specification defect and must be resolved in a new published version.

## 1. Vision

> Humans should be able to speak naturally. Businesses should communicate precisely.

Today, one business may use an AI agent to imitate a person over a phone call while another business uses another AI agent to understand that imitation and convert it back into booking data. This machine-to-human-to-machine theatre adds inference cost, delay, ambiguity, transcription errors, and operational complexity.

Comcom replaces that path with direct, deterministic communication:

`Business system → Comcom request → Business system`

AI and conventional interfaces remain valuable at the human boundary:

`Human ↔ UI or AI adapter ↔ Comcom ↔ Business`

A person may ask to find an available dentist tomorrow afternoon and book the cheapest suitable slot. An AI or UI can discover participating businesses, query typed availability, show exact options, collect missing data, obtain any required confirmation, submit a deterministic booking command, and explain the structured result naturally.

AI may be used internally by either business, but protocol conformance and message meaning MUST NOT depend on AI interpretation. Human-readable AI output is not the authoritative transaction record; the structured Comcom result is.

## 2. Design principles

Comcom has the following normative project goals:

1. **Deterministic between businesses.** Capability identifiers, versions, schemas, preconditions, and state transitions determine meaning.
2. **AI at the edges.** AI may translate between human intent and Comcom or explain a result, but is not required between businesses.
3. **UI-friendly by design.** Schema titles, descriptions, constraints, formats, units, enumerations, and examples support conventional form generation.
4. **No-AI baseline.** Discovery, validation, invocation, processing, and response work without models, tokens, embeddings, or probabilistic matching.
5. **Lightweight adoption.** A website can start with a static discovery file, a manifest, and one capability endpoint.
6. **Small subsets are valid.** No business is required to implement capabilities it does not support.
7. **No mandatory intermediary.** Direct operation requires no Comcom broker, directory, blockchain, or hosted service.
8. **Open and portable.** The specification, schemas, registry, validator, and examples use the Apache-2.0 license.
9. **Human accountability.** An adapter cannot change capability meaning or bypass authorization, confirmation, price, expiry, or policy requirements.
10. **Progressive enhancement.** Direct integrations, generated UIs, workflows, and AI assistants use the same protocol.

Determinism means that message semantics, validation, outcomes, and transitions are unambiguous. It does not require two businesses to return identical prices, availability, rankings, policies, or commercial decisions.

## 3. Conformance roles

All implementations MUST publish discovery and a capability manifest. An implementation declares one or more roles:

- `responder`: accepts queries or commands.
- `initiator`: discovers and invokes another implementation.
- `inboxReceiver`: receives supported events, offers, or announcements.
- `asyncResponder`: accepts work that completes after the initial HTTP response.

Roles are independent. A responder-only business does not need to initiate requests. An initiator-only business can publish a manifest without received capabilities. A single-capability implementation is conformant.

## 4. Discovery

Given an HTTPS origin such as `https://vendor.example`, an initiator requests:

`GET https://vendor.example/.well-known/comcom`

A successful response MUST use HTTP 200 and validate against `discovery.schema.json`. It lists supported major/minor versions and an absolute HTTPS manifest URL.

Initiators MUST:

1. enforce normal TLS certificate validation;
2. limit response size and redirect depth;
3. reject non-HTTPS remote URLs except for explicitly configured local development;
4. select an exact common version;
5. fetch and validate the manifest before invocation.

Discovery documents SHOULD be cacheable and SHOULD provide `ETag` and `Cache-Control` headers. A 404 means the origin has not published Comcom discovery.

## 5. Capability manifest

The manifest validates against `manifest.schema.json` and declares:

- the business or system identity;
- supported protocol versions and conformance roles;
- the default API base URL;
- supported capability identifiers and versions;
- whether each capability is sent, received, or both;
- canonical input and output schemas;
- callable endpoint forms;
- security schemes and optional inbox policy.

The manifest MUST list only capabilities supported by the implementation. Advertising a capability is a conformance claim for its schemas and behavior, not a promise that every valid request will be commercially accepted.

The default forms are:

- `POST {baseUrl}/interactions` for queries and commands;
- `GET {baseUrl}/interactions/{id}` for asynchronous status;
- `POST {baseUrl}/inbox` for events.

A capability MAY instead map to an existing endpoint by declaring its URL, HTTP method, content type, security, synchrony, and timeout. Receivers MUST NOT require callers to infer undocumented endpoints.

## 6. Capability identifiers and registry

Core identifiers use the `comcom.*` namespace. Examples include:

- `comcom.product.search`
- `comcom.availability.check`
- `comcom.quote.request`
- `comcom.order.create`
- `comcom.appointment.create`
- `comcom.announcement.receive`

Only the Comcom specification may define `comcom.*`. External extensions use a reverse-domain namespace controlled by their publisher, such as `org.example.freight.cold-chain.reserve`.

Callers MUST match an exact identifier and compatible version. Fuzzy text, embeddings, inferred synonyms, or natural-language similarity MUST NOT select wire semantics. Human titles, aliases, and descriptions are informative.

The normative registry contains 201 capabilities. Each defines purpose, roles, kind, action, resource type, input and output schemas, preconditions, permitted transitions, retry and reversal behavior, and informative mappings to established standards.

## 7. Message model

Every message validates against `envelope.schema.json` and a capability-specific payload schema.

### 7.1 Message kinds

- `query`: retrieves information without requesting a business-state change.
- `command`: requests a state-changing business operation.
- `event`: communicates a fact, offer, announcement, or state change.
- `result`: answers a query or command.
- `receipt`: acknowledges an inbox event without implying storage or business action.

### 7.2 Envelope fields

The envelope contains:

- `protocolVersion`: selected major/minor protocol version;
- `id`: sender-unique message URI;
- `kind`: one of the message kinds above;
- `capability`: exact identifier and version;
- `principal`: person or entity responsible for the interaction;
- `sender`: authenticated transmitting business or system;
- `recipient`: intended receiving business or system;
- `agent`: optional UI, workflow, or AI adapter acting for the principal;
- `authorization`: optional reference to external authority or delegation;
- `issuedAt` and optional `expiresAt`;
- optional `conversationId` and conditional `correlationId`;
- conditional `idempotencyKey`;
- optional typed resource reference;
- `payload` validated by the selected capability schema;
- optional reverse-domain `extensions`.

Commands and events MUST include an idempotency key. Results and receipts MUST correlate to the message they answer. Receivers MUST reject expired messages before business processing.

The principal, sender, and agent are distinct. For example, a person may be the principal, their employer the sender, and an AI assistant the agent. The agent does not acquire authority merely by being named.

## 8. Processing

A receiver processes a message in this order:

1. enforce transport and payload size policy;
2. authenticate the sender when required;
3. validate the envelope;
4. verify that the capability and version are advertised;
5. validate the capability payload;
6. enforce expiry, authorization, and business preconditions;
7. enforce idempotency;
8. perform or enqueue the interaction;
9. return a schema-valid result, receipt, operation resource, or problem.

Invalid messages MUST NOT reach the business handler.

### 8.1 Idempotency

The tuple of authenticated sender, capability identifier, and idempotency key identifies one logical command or event. A retry with the same key and identical payload MUST return the recorded outcome without repeating the state change. Reuse with a different payload MUST return HTTP 409.

Receivers MUST publish how long they retain idempotency records. Initiators MUST NOT reuse keys for unrelated work.

### 8.2 State transitions

A receiver MUST apply only transitions declared by the capability and valid for the resource's current state. A syntactically valid request for an invalid transition returns HTTP 409 with a stable problem code.

Cancellation, reversal, refund, return, or revocation are explicit capabilities. They are not implied by repeating or negating the original message.

### 8.3 Synchronous and asynchronous results

A completed synchronous interaction returns HTTP 200 and a `result` message. Accepted asynchronous work returns HTTP 202, a typed operation resource, and a status URL. The operation endpoint returns stable states such as `accepted`, `inProgress`, `completed`, `failed`, or `cancelled`.

HTTP 202 confirms admission, not completion.

## 9. Inbox delivery

An inbox is optional. Its manifest entry declares accepted event capability IDs, authentication schemes, and maximum size. A sender MUST NOT post a capability the inbox does not advertise.

Successful delivery returns a receipt with one disposition:

- `accepted`: the event passed admission policy; storage, review, and action are not implied;
- `discarded`: the event was valid but intentionally not processed;
- `duplicate`: the event was already received.

A business may omit an inbox, retain accepted events temporarily, store them, route them, or ignore them. These internal choices do not change the meaning of the receipt.

Announcements and offers do not create marketing consent or a business obligation. Senders remain responsible for lawful authority and recipient policy.

## 10. HTTP binding and errors

JSON over HTTPS is the normative v0.1 binding. Requests and successful responses use `application/json`. Errors use RFC 9457 problem details and validate against `problem.schema.json`.

| Status | Meaning |
| --- | --- |
| 200 | Synchronous result |
| 202 | Accepted async work or inbox receipt |
| 400 | Invalid envelope or payload schema |
| 401 | Authentication required or failed |
| 403 | Sender not authorized |
| 404 | Unsupported capability or unknown resource |
| 409 | Idempotency conflict or invalid transition |
| 412 | Business precondition not satisfied |
| 429 | Rate limited |
| 5xx | Receiver failure |

Problem responses include a stable URI `type`, human title, HTTP status, and a stable Comcom `code`. Schema errors SHOULD include machine-readable locations without echoing secrets.

## 11. AI and UI adapters

Comcom does not define an AI endpoint. The manifest and JSON Schemas are the universal adapter boundary.

An AI or UI adapter may:

1. discover capabilities;
2. map human intent to one exact capability;
3. collect missing required fields;
4. retrieve structured options;
5. show exact price, provider, time, policies, and consequences;
6. obtain confirmation when required;
7. produce a schema-valid Comcom message;
8. render the structured result.

AI confidence, reasoning, conversation history, and generated prose stay outside the wire message. Once sent, an AI-created message has exactly the same semantics and validation as one created by conventional code.

A generated UI may use schema annotations to create form controls. UI annotations do not override validation or capability semantics.

## 12. Security and privacy

Remote production use requires HTTPS. Manifests declare established authentication schemes instead of inventing credentials. Public read-only queries may declare no authentication; sensitive or state-changing capabilities SHOULD use established business authentication such as OAuth 2.0 client credentials or mutual TLS.

Implementations MUST address:

- authentication and authorization;
- replay and idempotency retention;
- request, response, redirect, and schema-reference limits;
- rate limiting and abuse controls for public discovery and inboxes;
- data minimization, retention, and purpose limitation;
- secret and personal-data exclusion from logs and problem details;
- SSRF protections when resolving declared URLs;
- clock skew and expiry handling.

Comcom communicates business intent and outcome. It does not define payment settlement, cryptographic signatures, custody, legal enforceability, or regulatory compliance. Domain profiles map to the established systems that provide those effects.

## 13. Versioning and extensions

Protocol and capability versions use `major.minor` on the wire. A patch release may clarify text or fix artifacts without changing behavior. Additive compatible behavior increments minor; incompatible behavior increments major.

Published versioned artifacts are immutable. A manifest may advertise multiple versions. Initiators select an exact common version and MUST fail clearly when none exists.

Unknown core fields are invalid. Unknown reverse-domain extensions may be ignored unless the extension declares itself critical; a receiver that does not understand a critical extension MUST reject the message before processing.

## 14. Conformance

A conforming implementation:

1. publishes valid discovery and manifest documents;
2. implements only advertised roles and capabilities;
3. validates envelopes and capability payloads before business logic;
4. follows declared lifecycle, idempotency, expiry, and response rules;
5. returns valid results, receipts, or problem details;
6. passes the applicable published conformance cases.

The reference validator and demo are informative implementations. Passing their tests is evidence of conformance but does not replace the normative specification.

## 15. IANA considerations

This specification defines a proposed well-known URI suffix `comcom` under RFC 8615.

- **URI suffix:** `comcom`
- **Change controller:** Comcom Protocol maintainers
- **Specification document:** this document, Section 4
- **Related information:** the resource returns protocol versions and a manifest URL; it contains no credentials and requires no authentication.

The name has not been registered at the time of v0.1 publication. Implementations and documentation MUST NOT claim IANA registration until the IANA registry confirms it.

## 16. Informative standards alignment

Comcom maps rather than replaces established standards, including OASIS UBL and UN/CEFACT for trade, GS1 EPCIS for supply-chain events, ISO 20022 for finance, HL7 FHIR for healthcare, IATA Offers and Orders for airline retailing, iCalendar for scheduling, W3C Verifiable Credentials for credentials, ActivityStreams for social events, Schema.org for public vocabulary, and W3C Web of Things for interaction affordances.
