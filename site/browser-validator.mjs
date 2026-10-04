import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseStrictJson } from "../reference/v0.2/strict-json.mjs";
import { registry, schemas, examples } from "comcom:validation-data";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const meta = schemas.find(schema => schema.$id.endsWith("comcom-meta.schema.json"));
ajv.addMetaSchema(meta);
for (const schema of schemas.filter(schema => schema !== meta)) ajv.addSchema(schema);
const capabilities = new Map(registry.capabilities.map(capability => [capability.id, capability]));
const base = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/";

const errors = validation => (validation.errors ?? []).map(error => ({ path: error.instancePath || "/", message: error.message }));

window.comcomOffline = {
  examples,
  validate(type, raw, context = {}) {
    let value;
    try {
      value = parseStrictJson(raw);
    } catch (error) {
      return { valid: false, phase: "raw", code: error.code ?? "invalid-json", errors: [{ path: "/", message: error.message }] };
    }
    const manifestProfile = context.manifestProfile === undefined ? "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest" : context.manifestProfile;
    if (type === "manifest" && !["v0.2.0", "v0.2.1"].some(version => manifestProfile === `https://abhcr.github.io/comcom-protocol/releases/${version}/profiles/manifest`)) {
      return { valid: false, phase: "manifest", code: "unsupported-manifest-profile", errors: [{ path: "/", message: "Select a supported pinned manifest profile" }] };
    }
    const schemaId = {
      discovery: "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/schemas/discovery.schema.json",
      manifest: type === "manifest" ? manifestProfile.replace("/profiles/manifest", "/schemas/manifest.schema.json") : undefined,
      request: `${base}envelope.schema.json`,
      response: `${base}envelope.schema.json`,
      "release-manifest": `${base}release-manifest.schema.json`
    }[type];
    const validate = ajv.getSchema(schemaId);
    if (!validate(value)) return { valid: false, phase: type, code: "schema-invalid", errors: errors(validate) };
    if (type === "request" || type === "response") {
      const capability = capabilities.get(value.capability.id);
      if (!capability || capability.version !== value.capability.version) return { valid: false, phase: "capability", code: "capability-version-mismatch", errors: [{ path: "/capability", message: "not in the verified v0.2 release" }] };
      const expected = type === "request" ? capability.requestKind : value.kind;
      if (type === "request" && value.kind !== expected) return { valid: false, phase: "capability", code: "message-kind-mismatch", errors: [{ path: "/kind", message: `expected ${expected}` }] };
      let payloadSchema = type === "request" ? capability.schemas.input : capability.schemas.output;
      if (type === "response" && value.payload && typeof value.payload === "object" && "statusUrl" in value.payload) payloadSchema = `${base}operation.schema.json`;
      const validatePayload = ajv.getSchema(payloadSchema);
      if (!validatePayload(value.payload)) return { valid: false, phase: "payload", code: "schema-invalid", errors: errors(validatePayload) };
    }
    return { valid: true, phase: "complete", code: "valid", errors: [] };
  }
};
