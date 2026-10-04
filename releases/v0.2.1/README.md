# Comcom v0.2.1 — Experimental discovery publishers

This release adds a discovery-only manifest profile. A website can publish its identity and a human contact link without claiming to receive Comcom interactions. Purplecore's documents are the first-party example; they are not independent interoperability evidence.

Wire protocol `0.2`, all 201 draft capability profiles, and published v0.2.0 artifact bytes remain unchanged. Upgraded clients support both pinned manifest profiles; older clients do not recognize the new profile. The validator CLI defaults to the legacy manifest profile unless `manifestProfile` is supplied explicitly.

The release also includes a runnable booking demo, complete browser examples, agent contribution guidance, a total fetch deadline, verification of pinned schema/registry bytes before use, and mandatory responder identity for full response validation.

The small discovery offline bundle contains the new schemas and their unchanged v0.2 kernel dependencies. It does not duplicate the capability catalog or replace the v0.2.0 interaction bundle.

Run `npm ci && npm run demo:v0.2` for the explicitly non-conformant loopback booking example. See the repository README and evaluation guide for the discovery-only walkthrough. No production-readiness or normative maturity claim is made.
