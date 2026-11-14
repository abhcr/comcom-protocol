#!/usr/bin/env node
// Comcom MCP server (stdio) exposing two read-only tools:
//
//   discover_capabilities  - does a business advertise receipt of exact capabilities?
//   prepare_request        - build and validate a request; return a preview.
//
// Nothing is submitted: this server cannot execute transactions.
//
// All business logic lives in interaction-client.mjs; this module only maps
// tool calls to it and shapes results. Identity and authentication are
// server-side configuration: tool inputs cannot name the sender, the trusted
// responder identity, credentials, or transport settings, and responses never
// include credential material.
//
// Usage: node reference/v0.2/mcp-server.mjs [--config <config.mjs>]
// The config module default-exports an object with any of CONFIG_KEYS.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { normalizeOrigin } from "./discover.mjs";
import { createInteractionClient } from "./interaction-client.mjs";
import { createProtocolV02 } from "./protocol.mjs";

export const SERVER_NAME = "comcom";
export const SERVER_VERSION = "0.2.1";
export const CONFIG_KEYS = ["sender", "agent", "authenticate", "responderIdentity", "developmentOrigins", "resolver", "timeoutMs", "discovery"];

const ENTITY_TYPES = ["person", "organization", "government", "nonprofit", "system", "device"];
const CAPABILITY_ID = /^(comcom|[a-z0-9-]+(?:\.[a-z0-9-]+)+)\.[a-z0-9.-]+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NOT_SUBMITTED = "Prepared and validated only. Nothing was sent to the business; this server does not execute transactions.";

const capabilityRef = z.object({
  id: z.string().max(200).regex(CAPABILITY_ID).describe("Exact capability ID, e.g. comcom.booking.create"),
  version: z.string().max(64).regex(SEMVER).describe("Exact capability version, e.g. 0.2.0")
}).strict();
const origin = z.string().max(2048).describe("Business HTTPS origin, e.g. https://vendor.example");

const discoverInput = z.object({
  origin,
  capabilities: z.array(capabilityRef).min(1).max(5).describe("Capabilities to check, each by exact ID and version")
}).strict();

const prepareInput = z.object({
  origin,
  capability: capabilityRef,
  executionMode: z.enum(["synchronous", "asynchronous"]).optional().describe("Form to prepare for; default synchronous"),
  principal: z.object({
    id: z.string().max(2048).describe("URI of the person or organization the request is for"),
    type: z.enum(ENTITY_TYPES),
    name: z.string().min(1).max(300).optional()
  }).strict(),
  payload: z.record(z.string(), z.unknown()).describe("Capability input payload; see payloadSchema from discover_capabilities"),
  authorization: z.string().max(2048).optional().describe("URI of an external authorization record (a reference, not a credential)"),
  idempotencyKey: z.string().min(1).max(200).optional(),
  expiresInSeconds: z.number().int().min(1).max(86_400).optional()
}).strict();

function validateConfig(config) {
  if (config === null || typeof config !== "object") throw new TypeError("config must be an object");
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown config keys: ${unknown.join(", ")}`);
  for (const key of ["authenticate", "responderIdentity", "resolver"]) {
    if (config[key] !== undefined && typeof config[key] !== "function") throw new TypeError(`${key} must be a function`);
  }
  if (config.sender !== undefined && (typeof config.sender?.id !== "string" || !ENTITY_TYPES.includes(config.sender?.type))) {
    throw new TypeError("sender must be { id, type }");
  }
}

const json = value => JSON.stringify(value, null, 2);
const toolResult = (value, isError = false) => ({ content: [{ type: "text", text: json(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });

// Per-manifest records. A failed discovery is incomplete, so only what was
// checked and which manifest failed is copied; a complete not-advertised
// result may also describe each manifest.
const manifestRecord = outcome => record => {
  if (outcome !== "failed") return record;
  const failedItself = record.code && (record.outcome === undefined || record.outcome === "failed");
  return {
    url: record.url,
    profile: record.profile,
    ...(record.checked !== undefined ? { checked: record.checked } : {}),
    ...(failedItself ? { code: record.code } : {})
  };
};

// Compact, credential-free view of a discovery result for tool callers.
function summarize(discovery, protocol) {
  const base = {
    capability: discovery.capability,
    outcome: discovery.outcome,
    code: discovery.code,
    ...(discovery.errors?.length ? { errors: discovery.errors } : {}),
    ...(discovery.conformant === false ? { conformant: false, notice: "Retrieved over a non-conformant development transport" } : {})
  };
  if (discovery.outcome === "advertised") {
    return {
      ...base,
      entity: discovery.entity,
      identity: { ...discovery.identity, note: "Informational. A transaction also requires the server's trusted responder identity." },
      serviceOrigins: discovery.serviceOrigins,
      declaration: discovery.declaration,
      forms: discovery.forms,
      securitySchemes: discovery.securitySchemes,
      limits: discovery.limits,
      manifests: discovery.matches.map(match => match.manifest),
      payloadSchema: protocol.ajv.getSchema(discovery.declaration.inputSchema)?.schema ?? null
    };
  }
  if (discovery.outcome === "ambiguous") return { ...base, distinctContracts: discovery.distinctContracts, matches: discovery.matches };
  return {
    ...base,
    ...(discovery.unchecked ? { unchecked: discovery.unchecked } : {}),
    ...(discovery.failedManifest ? { failedManifest: discovery.failedManifest } : {}),
    ...(discovery.httpStatus ? { httpStatus: discovery.httpStatus } : {}),
    ...(discovery.source?.manifests?.length ? { manifests: discovery.source.manifests.map(manifestRecord(discovery.outcome)) } : {})
  };
}

function inputError(code, message) {
  return toolResult({ outcome: "invalid-input", code, errors: [{ path: "/", message }] }, true);
}

/**
 * Creates the MCP server. Embed it with real `authenticate` and
 * `responderIdentity` hooks, or run this file with --config.
 */
export async function createComcomMcpServer(config = {}, { protocol: suppliedProtocol, log = message => process.stderr.write(`${message}\n`) } = {}) {
  validateConfig(config);
  const protocol = suppliedProtocol ?? await createProtocolV02();
  const client = createInteractionClient({
    protocol,
    authenticate: config.authenticate ?? (async () => null),
    responderIdentity: config.responderIdentity,
    developmentOrigins: config.developmentOrigins,
    resolver: config.resolver,
    timeoutMs: config.timeoutMs,
    discovery: config.discovery
  });
  if (config.developmentOrigins && Object.keys(config.developmentOrigins).length) {
    log("WARNING: developmentOrigins retrieves over HTTP loopback. This is non-conformant and for local development only.");
  }

  // Unexpected exceptions become a generic tool error; details go to stderr only.
  const guarded = handler => async args => {
    try {
      return await handler(args);
    } catch (error) {
      log(`comcom MCP internal error: ${error?.stack ?? error}`);
      return toolResult({ outcome: "error", code: "internal-error", errors: [{ path: "/", message: "Internal server error" }] }, true);
    }
  };

  function checkOrigin(value) {
    try {
      normalizeOrigin(value);
      return null;
    } catch (error) {
      return inputError(error.code ?? "invalid-origin", error.message);
    }
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "Discover Comcom business capabilities and prepare validated requests. Tools never submit or execute transactions."
  });

  server.registerTool("discover_capabilities", {
    title: "Discover Comcom capabilities",
    description: "Checks whether a business HTTPS origin advertises that it can receive exact Comcom capabilities. Returns, per capability, the outcome (advertised, ambiguous, not-advertised, failed), declared forms, security requirements, informational identity facts, and the payload JSON Schema. Sends no business request.",
    inputSchema: discoverInput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, guarded(async ({ origin: value, capabilities }) => {
    const invalid = checkOrigin(value);
    if (invalid) return invalid;
    const results = [];
    for (const capability of capabilities) results.push(summarize(await client.discover({ origin: value, capability }), protocol));
    const inputFailure = results.find(result => result.outcome === "failed" && result.errors && ["unsupported-capability", "invalid-capability"].includes(result.code));
    return toolResult({ origin: normalizeOrigin(value), results }, Boolean(inputFailure));
  }));

  server.registerTool("prepare_request", {
    title: "Prepare a Comcom request",
    description: "Discovers the capability, then builds and validates a request against the discovered contract using the server's configured sender identity, trusted responder identity, and credentials. Returns a request preview or a clear error. Never submits the request.",
    inputSchema: prepareInput,
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, guarded(async input => {
    const invalid = checkOrigin(input.origin);
    if (invalid) return invalid;
    const discovery = await client.discover({ origin: input.origin, capability: input.capability });
    if (discovery.outcome !== "advertised") {
      return toolResult({ outcome: "not-prepared", stage: "discovery", submitted: false, phase: discovery.phase, code: discovery.code, errors: discovery.errors, discovery: summarize(discovery, protocol) }, true);
    }
    if (!config.sender) {
      return toolResult({ outcome: "not-prepared", stage: "prepare", submitted: false, phase: "identity", code: "sender-unconfigured", errors: [{ path: "/", message: "The server has no configured sender identity" }] }, true);
    }
    const prepared = await client.prepare(discovery, {
      principal: input.principal,
      sender: config.sender,
      ...(config.agent ? { agent: config.agent } : {}),
      ...(input.authorization ? { authorization: input.authorization } : {}),
      payload: input.payload,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.expiresInSeconds ? { expiresInMs: input.expiresInSeconds * 1000 } : {}),
      executionMode: input.executionMode ?? "synchronous"
    });
    if (!prepared.ok) {
      return toolResult({ outcome: "not-prepared", stage: "prepare", submitted: false, phase: prepared.phase, code: prepared.code, errors: prepared.errors }, true);
    }
    // Allowlisted preview: prepared.headers (credentials) is never copied.
    const { form } = prepared;
    return toolResult({
      outcome: "prepared",
      submitted: false,
      notice: NOT_SUBMITTED,
      preview: {
        request: prepared.request,
        bodyBytes: Buffer.byteLength(prepared.body),
        bodySha256: createHash("sha256").update(prepared.body).digest("hex"),
        endpoint: { href: form.href, method: form.method, contentType: form.contentType, executionMode: form.executionMode, ...(form.statusTemplate ? { statusTemplate: form.statusTemplate } : {}) },
        trustedResponderIdentity: prepared.responderId,
        authentication: { senderId: prepared.transport.senderId, schemes: [].concat(prepared.transport.scheme ?? []), scopes: prepared.transport.scopes, requirements: form.security }
      },
      discovery: {
        outcome: discovery.outcome,
        ...(discovery.conformant === false ? { conformant: false } : {}),
        identity: discovery.identity,
        manifests: discovery.matches.map(match => match.manifest)
      }
    });
  }));

  return server;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  let config = {};
  if (values.config) config = (await import(pathToFileURL(resolve(values.config)).href)).default ?? {};
  const server = await createComcomMcpServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write("comcom MCP server ready on stdio\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`comcom MCP server failed to start: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
