# Contributing to Comcom

Implementation reports, focused regression tests, documentation corrections, and protocol feedback are welcome. Small documentation and test fixes can go straight to a pull request; no proposal or prior discussion is required.

## Evaluate and report

With Node.js 24, run `npm ci` and `npm run demo:v0.2`. Read the [booking and Purplecore walkthrough](docs/evaluate.html), then file an [implementation report](https://github.com/abhcr/comcom-protocol/issues/new?template=implementation-report.yml) with your commit, commands, actual results, and missing requirements. A finding that Comcom is unsuitable for your project is useful evidence too.

## Focused pull requests

1. Fork the repository, create a focused branch, and inspect nearby code and [AGENTS.md](AGENTS.md).
2. Make the smallest correct change. Documentation and tooling fixes do not require modifying capability profiles.
3. Run checks relevant to the change. Site edits use `npm run build:site`, `npm run check:site`, and `npm run verify:site`. Runtime changes use `npm test` and `npm run demo:v0.2`.
4. For protocol changes, install Python 3.13 dependencies in a virtual environment (`python -m pip install -r requirements.txt`), then run `npm run check:v0.2`, `npm run verify:release`, and `npm run conformance:v0.2` as well.
5. Include a regression or valid/invalid example for changed behavior. Explain the compatibility or security consequences and any validation you could not run.

Published versioned artifacts are immutable. Do not rewrite v0.1.0 or v0.2.0 artifacts. Business semantics are authored under `profiles/v0.2/`; generators must not invent schemas, transitions, fixtures, or evidence. Changes to published semantics require a new version.

## Semantic and capability proposals

Open an issue or Discussion before proposing new business semantics. Describe the concrete interaction, search existing capabilities to avoid overlaps, and explain why an extension namespace does not suffice. Include two independent sender/receiver use cases where possible.

A proposed core capability must define its identifier, roles, message kinds, resource, closed input/output/resource schemas, preconditions, every allowed and forbidden lifecycle transition, retry and reversal rules, positive and independently authored negative examples, security floor, relevant standards mappings, and an evidence record. Normative promotion requires two successful independent interoperability journeys plus the gates in [GOVERNANCE.md](GOVERNANCE.md).

Experimental behavior should use a reverse-domain namespace such as `org.example.*`. Successful extensions can later be proposed for the core registry without breaking their original namespace. Purplecore is a first-party discovery deployment and does not count as independent interoperability evidence.

## License

By contributing, you agree that your contribution is licensed under Apache-2.0 as described in the repository license.
