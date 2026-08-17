# Contributing to Comcom

Comcom welcomes implementation reports, protocol feedback, capability proposals, schemas, tests, and documentation improvements.

## Before opening a change

- Use a GitHub Discussion or issue to describe the problem and real business interaction.
- Search existing capabilities and proposals to avoid synonyms or overlapping semantics.
- Show why an extension namespace cannot solve the problem first.
- For protocol changes, include at least two independent sender/receiver use cases where possible.

## Pull requests

1. Fork the repository and create a focused branch.
2. Change the generator source when modifying generated registry, schema, or fixture artifacts.
3. Run `npm install`, `npm run generate`, `npm run validate`, and `npm test`.
4. Include valid and invalid examples for behavior changes.
5. Explain compatibility and security consequences.

Published versioned artifacts are immutable. Fixes to a published version are released under a new version; pull requests must not silently alter its semantics.

## Capability proposals

A proposed core capability must define its identifier, roles, message kinds, resource, input/output shapes, preconditions, lifecycle transitions, retry and reversal rules, examples, and relevant standards mappings. Core acceptance requires demonstrated general use across more than one organization or domain.

Experimental behavior should use a reverse-domain namespace such as `org.example.*`. Successful extensions can later be proposed for the core registry without breaking their original namespace.

## License

By contributing, you agree that your contribution is licensed under Apache-2.0 as described in the repository license.
