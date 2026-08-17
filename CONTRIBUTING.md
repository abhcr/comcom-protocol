# Contributing to Comcom

Comcom welcomes implementation reports, protocol feedback, capability proposals, schemas, tests, and documentation improvements.

## Before opening a change

- Use a GitHub Discussion or issue to describe the problem and real business interaction.
- Search existing capabilities and proposals to avoid synonyms or overlapping semantics.
- Show why an extension namespace cannot solve the problem first.
- For protocol changes, include at least two independent sender/receiver use cases where possible.

## Pull requests

1. Fork the repository and create a focused branch.
2. Edit the applicable authored source under `profiles/v0.2/`; generators must not create schemas, transitions, fixtures, or business semantics.
3. Run `npm install`, install `requirements.txt` with Python 3.13, then run `npm run build:v0.2`, `npm run check:v0.2`, `npm run conformance:v0.2`, and `npm test`.
4. Include valid and invalid examples for behavior changes.
5. Explain compatibility and security consequences.

Published versioned artifacts are immutable. Fixes to a published version are released under a new version; pull requests must not silently alter its semantics.

## Capability proposals

A proposed core capability must define its identifier, roles, message kinds, resource, closed input/output/resource schemas, preconditions, every allowed and forbidden lifecycle transition, retry and reversal rules, positive and independently authored negative examples, security floor, relevant standards mappings, and an evidence record. Normative promotion requires two successful independent interoperability journeys plus the gates in [GOVERNANCE.md](GOVERNANCE.md).

Experimental behavior should use a reverse-domain namespace such as `org.example.*`. Successful extensions can later be proposed for the core registry without breaking their original namespace.

## License

By contributing, you agree that your contribution is licensed under Apache-2.0 as described in the repository license.
