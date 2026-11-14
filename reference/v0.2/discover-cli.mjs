#!/usr/bin/env node
// Usage:
//   node reference/v0.2/discover-cli.mjs <origin> <capability-id> <capability-version>
//     [--timeout-ms <ms>] [--deadline-ms <ms>] [--max-manifests <n>] [--pretty]
//     [--development-origin https://business.example=http://127.0.0.1:8788]...
//
// Writes one JSON result to stdout. Exit status:
//   0 advertised (all matching manifests agree), 1 not advertised,
//   2 discovery failed (including discovery-deadline-exceeded), 3 ambiguous
//   (matching manifests disagree), 64 usage error.
import { parseArgs } from "node:util";
import { discoverCapability, MAX_DEADLINE_MS, MAX_MANIFESTS_LIMIT } from "./discover.mjs";

const usage = "usage: discover-cli.mjs <origin> <capability-id> <capability-version> [--timeout-ms <ms>] [--deadline-ms <ms>] [--max-manifests <n>] [--pretty] [--development-origin <https-origin>=<http-loopback-origin>]...";

function usageError(message) {
  console.log(JSON.stringify({ outcome: "failed", advertised: false, phase: "input", code: "cli-input-invalid", errors: [{ path: "/", message }] }));
  console.error(usage);
  process.exit(64);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      "timeout-ms": { type: "string" },
      "deadline-ms": { type: "string" },
      "max-manifests": { type: "string" },
      "development-origin": { type: "string", multiple: true },
      pretty: { type: "boolean", default: false }
    }
  });
} catch (error) {
  usageError(error.message);
}

const { positionals, values } = parsed;
if (positionals.length !== 3) usageError("expected exactly three arguments: origin, capability ID, and capability version");
const [origin, id, version] = positionals;

let timeoutMs;
if (values["timeout-ms"] !== undefined) {
  timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) usageError("--timeout-ms must be an integer from 1 to 60000");
}

let deadlineMs;
if (values["deadline-ms"] !== undefined) {
  deadlineMs = Number(values["deadline-ms"]);
  if (!/^[0-9]+$/.test(values["deadline-ms"]) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) usageError(`--deadline-ms must be an integer from 1 to ${MAX_DEADLINE_MS}`);
}

let maxManifests;
if (values["max-manifests"] !== undefined) {
  maxManifests = Number(values["max-manifests"]);
  if (!/^[0-9]+$/.test(values["max-manifests"]) || maxManifests < 1 || maxManifests > MAX_MANIFESTS_LIMIT) usageError(`--max-manifests must be an integer from 1 to ${MAX_MANIFESTS_LIMIT}`);
}

const developmentOrigins = {};
for (const mapping of values["development-origin"] ?? []) {
  const separator = mapping.indexOf("=");
  if (separator < 1) usageError("--development-origin must have the form https://business.example=http://127.0.0.1:8788");
  developmentOrigins[mapping.slice(0, separator)] = mapping.slice(separator + 1);
}
if (Object.keys(developmentOrigins).length) {
  console.error("WARNING: --development-origin retrieves over HTTP loopback. This is non-conformant and for local development only.");
}

const result = await discoverCapability({ origin, capability: { id, version }, timeoutMs, deadlineMs, maxManifests, developmentOrigins });
console.log(values.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
process.exitCode = { advertised: 0, "not-advertised": 1, ambiguous: 3 }[result.outcome] ?? 2;
