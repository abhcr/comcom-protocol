import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "registry/v0.1/capabilities.json");
const capabilitySchemaPath = resolve(root, "schemas/v0.1/capabilities");

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

export async function createProtocol() {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);

  const sharedNames = [
    "resource.schema.json",
    "discovery.schema.json",
    "envelope.schema.json",
    "manifest.schema.json",
    "registry.schema.json",
    "problem.schema.json"
  ];
  for (const name of sharedNames) ajv.addSchema(await readJson(resolve(root, "schemas/v0.1", name)));

  for (const name of await readdir(capabilitySchemaPath)) {
    if (name.endsWith(".json")) ajv.addSchema(await readJson(resolve(capabilitySchemaPath, name)));
  }

  const registry = await readJson(registryPath);
  const capabilities = new Map(registry.capabilities.map(capability => [capability.id, capability]));
  const envelopeId = "https://abhcr.github.io/comcom-protocol/schemas/v0.1/envelope.schema.json";

  return {
    ajv,
    registry,
    capabilities,
    validateDiscovery: ajv.getSchema("https://abhcr.github.io/comcom-protocol/schemas/v0.1/discovery.schema.json"),
    validateManifest: ajv.getSchema("https://abhcr.github.io/comcom-protocol/schemas/v0.1/manifest.schema.json"),
    validateRegistry: ajv.getSchema("https://abhcr.github.io/comcom-protocol/schemas/v0.1/registry.schema.json"),
    validateEnvelope: ajv.getSchema(envelopeId),
    validateMessage(message) {
      const validEnvelope = this.validateEnvelope(message);
      if (!validEnvelope) return { valid: false, phase: "envelope", errors: this.validateEnvelope.errors };
      const capability = capabilities.get(message.capability.id);
      if (!capability || capability.version !== message.capability.version) {
        return { valid: false, phase: "capability", errors: [{ instancePath: "/capability", message: "is not registered at the requested version" }] };
      }
      const schemaId = ["result", "receipt"].includes(message.kind) ? capability.outputSchema : capability.inputSchema;
      const validatePayload = ajv.getSchema(schemaId);
      if (!validatePayload(message.payload)) return { valid: false, phase: "payload", errors: validatePayload.errors };
      return { valid: true, capability };
    }
  };
}

export function entity(id, type = "organization", name) {
  return { id, type, ...(name ? { name } : {}) };
}

export function message({ id, kind, capability, principal, sender, recipient, payload, idempotencyKey, correlationId, agent, expiresAt, resource }) {
  return {
    protocolVersion: "0.1",
    id,
    kind,
    capability: { id: capability, version: "0.1" },
    principal,
    sender,
    recipient,
    ...(agent ? { agent } : {}),
    issuedAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(resource ? { resource } : {}),
    payload
  };
}

export function problem(status, code, title, detail, errors) {
  return {
    type: `https://abhcr.github.io/comcom-protocol/problems/${code}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {})
  };
}
