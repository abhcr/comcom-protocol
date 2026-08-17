# Security policy

## Reporting a vulnerability

Do not disclose exploitable vulnerabilities in a public issue. Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, open a minimal issue asking a maintainer to provide a private contact without including sensitive details.

## Supported versions

Security fixes are made on the current development branch and the latest published minor version when practical. Published artifacts remain immutable; a fix is released as a new version.

## Implementation baseline

Production implementations must use HTTPS and normal certificate validation. Discovery and manifest resolution must validate every DNS answer and connected address, reject non-public networks and downgrade redirects, pin the connected address, follow at most three redirects, and apply the v0.2 ten-second and size limits. HTTP loopback is a non-conformant development option only.

Manifest URLs, callbacks, and extension URLs are untrusted input. Message validation must use digest-verified, preloaded release schemas and must never dereference a message-supplied schema. Raw JSON must be checked for duplicate keys, invalid UTF-8, non-I-JSON values, size, and depth before parsing.

Transport authentication must bind to `message.sender.id`; a sender claim in JSON is not authentication. OpenAPI security alternatives and combined schemes must be evaluated exactly. Commands are authenticated unless the capability expressly permits anonymous access.

Idempotency records contain authoritative transaction results. Protect them with the same access controls as the transaction, key them by authenticated sender/capability/key, use the RFC 8785 semantic projection, and return the exact stored status and envelope only after sender revalidation.

Comcom does not provide payment settlement, signatures, non-repudiation, custody, marketing consent, or legal authority. Use established systems and applicable law for those effects.
