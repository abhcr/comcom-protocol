# Comcom Protocol

> Humans should be able to speak naturally. Businesses should communicate precisely.

Comcom is an open, deterministic protocol for business interaction on the web. A business publishes the exact capabilities it supports; another business discovers those capabilities and exchanges schema-validated JSON over HTTPS. Implementations can expose one capability or hundreds and can be responder-only, initiator-only, inbox-only, or bidirectional.

Comcom removes the need for machines to imitate people when a structured interaction is available. AI and conventional user interfaces remain useful at the human boundary, where they can translate intent into exact Comcom capabilities and render typed results. The business-to-business exchange itself never requires a model, tokens, embeddings, or probabilistic interpretation.

## Start in five minutes

1. Serve a discovery document at `/.well-known/comcom`:

   ```json
   {
     "versions": ["0.1"],
     "manifest": "https://business.example/comcom/manifest"
   }
   ```

2. Publish a manifest containing only the capabilities you accept.
3. Validate messages with the published JSON Schemas.
4. Accept queries and commands at the standard interaction endpoint or map a capability to an existing API.

Run the included implementation:

```sh
npm install
npm test
npm run demo
```

In another terminal:

```sh
npm run demo:caller
```

Then open [http://localhost:8787/ui](http://localhost:8787/ui) for a schema-driven booking form.

## What is included

- [Normative v0.1 specification](spec/v0.1/specification.md)
- 201 normative capabilities in the [machine-readable registry](registry/v0.1/capabilities.json)
- JSON Schema 2020-12 definitions and per-capability input/output schemas
- Positive and negative conformance cases for every capability
- Node.js 24 validator, responder, caller, inbox, and no-AI UI examples
- Static searchable documentation for GitHub Pages
- Open governance, security, and contribution policies

## Core endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/comcom` | Discover versions and manifest |
| `GET /comcom/manifest` | Read supported capabilities |
| `POST /comcom/interactions` | Submit queries and commands |
| `GET /comcom/interactions/{id}` | Poll asynchronous work |
| `POST /comcom/inbox` | Deliver declared events, offers, or announcements |

These are defaults. A manifest may map a capability to an existing API endpoint.

## Conformance

Every implementation publishes discovery and a manifest. It may then declare any combination of:

- `responder`
- `initiator`
- `inboxReceiver`
- `asyncResponder`

A single-capability responder is conformant if its discovery, manifest, messages, and behavior satisfy the specification.

## Status

This repository implements Comcom Protocol v0.1. The `/.well-known/comcom` name is specified here for implementation and has not yet been registered with IANA. See the specification's IANA Considerations before describing it as registered.

## License

Apache License 2.0. See [LICENSE](LICENSE).
