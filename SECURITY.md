# Security policy

## Reporting a vulnerability

Do not disclose exploitable vulnerabilities in a public issue. Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, open a minimal issue asking a maintainer to provide a private contact without including sensitive details.

## Supported versions

Security fixes are made on the current development branch and the latest published minor version when practical. Published artifacts remain immutable; a fix is released as a new version.

## Implementation baseline

Production implementations must use HTTPS and normal certificate validation. They must limit discovery redirects, response sizes, request bodies, schema resolution, and processing time. They must authenticate and authorize sensitive operations, protect idempotency records, reject expired work, rate-limit public endpoints, and keep secrets and personal data out of logs and error responses.

Manifest URLs, schema references, callbacks, and extension URLs are untrusted input. Implementers must prevent SSRF, local-network access, redirect loops, path traversal, and unbounded remote reference resolution.

Comcom does not provide payment settlement, signatures, non-repudiation, custody, marketing consent, or legal authority. Use established systems and applicable law for those effects.
