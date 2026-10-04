# Experimental discovery-only profile, v0.2.1

Profile identifier: `https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest`.

Manifest schema: `https://abhcr.github.io/comcom-protocol/releases/v0.2.1/schemas/manifest.schema.json`.

This additive profile uses wire protocol `0.2`. It accepts either the unchanged v0.2.0 interactive manifest, referenced by its immutable schema ID, or a discovery-only publisher. It does not change any capability contract or promote any draft capability.

## Discovery-only document

A discovery-only manifest contains exactly these required fields:

- `protocolVersions: ["0.2"]`;
- `entity`, using the existing v0.2 entity schema;
- `roles: ["discoveryPublisher"]`;
- empty `profiles` and `capabilities` arrays.

The only optional field is `contactUrl`: an absolute HTTPS navigation link, optionally containing a fragment. It must not contain URL credentials, whitespace, or backslashes. It identifies a human-facing contact page; it does not authorize submission or describe an API endpoint. Consumers must not infer a callable capability from this URL.

Interaction-only fields, including `serviceOrigins`, `limits`, `securitySchemes`, `security`, and `inbox`, are rejected in this branch. Discovery-only publishers advertise zero interactions. The schema is closed to other fields.

## Publication and validation

Publish an RFC 9727 linkset at `/.well-known/api-catalog` over HTTPS with `application/linkset+json`. The manifest item uses `application/vnd.comcom.manifest+json` and the exact profile identifier above. GET returns the document; HEAD returns equivalent headers without a body.

The updated discovery schema accepts both the v0.2.0 and v0.2.1 profile identifiers. Validators select a manifest schema using the optional context `manifestProfile`. Omitting that context preserves the original v0.2.0 default. An unknown identifier fails with `phase: "manifest"` and `code: "unsupported-manifest-profile"`. Schema resolution uses pinned local artifacts, never arbitrary document-supplied URLs.

Older validators will reject or not recognize the new profile. Publishers must not label discovery-only documents with the v0.2.0 profile. Existing interactive manifests remain valid with their original profile and are also accepted by the new profile's legacy branch.

The [Purplecore fixtures](../../examples/v0.2.1/) illustrate this profile. The first-party Purplecore deployment is an evaluation example, not independent interoperability evidence.
