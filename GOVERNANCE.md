# Governance

Comcom begins as a maintainer-led open-source specification under the `abhcr` GitHub account. Protocol work, decisions, proposals, and release history are public.

## Decision principles

Maintainers prioritize:

1. deterministic interoperability;
2. a no-AI, low-cost baseline;
3. compatibility and independent implementation;
4. reuse of established standards;
5. small implementable subsets;
6. evidence over hypothetical extensibility;
7. neutrality between vendors, industries, and technology stacks.

## Maintainer responsibilities

The repository owner is the initial kernel maintainer. The project records three review responsibilities publicly:

- kernel maintainers review discovery, envelopes, security, validation, releases, and shared schemas;
- profile maintainers steward a named capability profile; and
- independent domain reviewers evaluate whether profile semantics and standards mappings match real practice.

Contributors who demonstrate sustained, constructive work may be invited into one of these roles. A person MUST NOT approve their own domain or security evidence.

## Changes

- Editorial fixes require one maintainer approval and passing CI.
- Capability proposals require the proposal template, independently authored fixtures, lifecycle and reversal coverage, standards evidence, and review by the applicable profile maintainer and a domain reviewer.
- Published semantic changes require two maintainer approvals, including one maintainer responsible for the affected kernel or profile.
- Wire-format or incompatible changes also require a public implementation period, migration guidance, and the applicable protocol-version change.
- Published versioned artifacts are never modified in place.

## Evidence-gated maturity

Catalog presence does not imply normative status. Normative promotion requires complete domain and security reviews, positive and independent negative cases, all allowed and forbidden transitions, matching Node and Python verdicts, two interoperability journeys, and immutable conformance digests. CI rejects a normative capability with incomplete evidence.

The profile sources are authoritative. Generation is limited to indexes, documentation, bundles, and digests and cannot supply business semantics.

## Pre-1.0 neutrality gate

A neutral canonical domain and a documented multi-stakeholder stewardship arrangement are mandatory before 1.0. Until then the project makes no claim of institutional neutrality.
