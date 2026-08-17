# V0.2 release gates

Every v0.2 release is experimental. Capability maturity remains independent of release maturity.

| Release | Gate |
| --- | --- |
| `v0.2.0-alpha.1` | Hardened kernel: RFC 9727 discovery, manifest, security, envelope, operation, release, raw validation, safe URL, and idempotency rules. |
| `v0.2.0-alpha.2` | Commerce batch: 39 catalog, pricing, order, and procurement capabilities. |
| `v0.2.0-alpha.3` | Transactions batch: 48 booking, scheduling, service, subscription, and support capabilities. |
| `v0.2.0-alpha.4` | Operations batch: 42 logistics, inventory, production, digital, IoT, and communication capabilities. |
| `v0.2.0-alpha.5` | Identity batch: 38 identity, privacy, trust, contract, credential, and workforce capabilities. |
| `v0.2.0-alpha.6` | Regulated/public batch: 34 finance, government, property, insurance, utility, education, healthcare, and research capabilities. |
| `v0.2.0-beta.1` | Complete 201-capability catalog, documentation, fixtures, bundles, and independent corpus. |
| `v0.2.0-rc.1` | Node/Python agreement, interoperability journeys, security tests, release digests, and rendered accessibility gates. |
| `v0.2.0` | Experimental final. No production-readiness or global-interoperability claim. |

`node scripts/package-release.mjs <tag>` creates the exact stage-qualified registry, profile bundles, conformance corpus, offline bundle, and release manifest in `dist/<tag>/`. Release assets are immutable after publication.
