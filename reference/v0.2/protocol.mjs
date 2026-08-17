import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import { parseStrictJson, StrictJsonError } from "./strict-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ids = {
  discovery: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/discovery.schema.json",
  envelope: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/envelope.schema.json",
  manifest: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/manifest.schema.json",
  operation: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/operation.schema.json",
  release: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/release-manifest.schema.json"
};

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const normalizeErrors = errors => (errors ?? []).map(error => ({
  path: error.instancePath || "/",
  keyword: error.keyword,
  message: error.message ?? "validation failed"
}));

const valid = (value, extra = {}) => ({ valid: true, phase: "complete", code: "valid", errors: [], value, ...extra });
const invalid = (phase, code, message, status = 400, errors) => ({
  valid: false,
  phase,
  code,
  status,
  errors: errors ?? [{ path: "/", message }]
});

function rawValue(raw, maxBytes = 1048576) {
  try {
    return { value: parseStrictJson(raw, { maxBytes }) };
  } catch (error) {
    if (error instanceof StrictJsonError) return { error: invalid("raw", error.code, error.message, error.code === "message-too-large" ? 413 : 400) };
    throw error;
  }
}

function exactOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash && parsed.pathname === "/" && !parsed.search;
  } catch {
    return false;
  }
}

function securitySatisfied(requirements, context) {
  const active = new Set(Array.isArray(context.scheme) ? context.scheme : context.scheme ? [context.scheme] : []);
  const scopes = Array.isArray(context.scopes) ? context.scopes : [];
  for (const requirement of requirements ?? []) {
    const entries = Object.entries(requirement);
    if (entries.length === 0) return true;
    if (entries.every(([name, requiredScopes]) => active.has(name) && requiredScopes.every(scope => scopes.includes(scope)))) return true;
  }
  return false;
}

function criticalExtensions(message, supported = []) {
  for (const name of message.criticalExtensions ?? []) {
    if (!Object.hasOwn(message.extensions ?? {}, name)) return invalid("extensions", "malformed-critical-extension", `Critical extension ${name} is not present`);
    if (!supported.includes(name)) return invalid("extensions", "unsupported-critical-extension", `Critical extension ${name} is not supported`, 422);
  }
  return null;
}

function timeFailure(message, context = {}) {
  const now = new Date(context.now ?? Date.now()).getTime();
  const issued = Date.parse(message.issuedAt);
  if (issued > now + 60000) return invalid("expiry", "issued-at-in-future", "issuedAt exceeds the 60-second clock tolerance", 412);
  if (message.expiresAt && Date.parse(message.expiresAt) < now && !context.recordedReplay) return invalid("expiry", "message-expired", "The first-seen message has expired", 412);
  if (message.expiresAt && Date.parse(message.expiresAt) < issued) return invalid("expiry", "expiry-before-issuance", "expiresAt precedes issuedAt", 400);
  return null;
}

function selectForm(declaration, context) {
  if (!declaration?.forms) return null;
  return declaration.forms.find(form =>
    (!context.endpoint?.url || form.href === context.endpoint.url) &&
    (!context.endpoint?.method || form.method === context.endpoint.method)
  );
}

function profileSchema(protocol, capability, output = false) {
  const schemaId = output ? capability.schemas.output : capability.schemas.input;
  return protocol.ajv.getSchema(schemaId);
}

export function semanticProjection(message) {
  const extensionValues = Object.fromEntries((message.criticalExtensions ?? []).sort().map(name => [name, message.extensions[name]]));
  return {
    capability: message.capability,
    principal: message.principal,
    recipient: message.recipient,
    ...(message.authorization ? { authorization: message.authorization } : {}),
    ...(message.resource ? { resource: message.resource } : {}),
    payload: message.payload,
    ...(Object.keys(extensionValues).length ? { criticalExtensions: extensionValues } : {})
  };
}

export function semanticHash(message) {
  return createHash("sha256").update(canonicalize(semanticProjection(message))).digest("hex");
}

export async function createProtocolV02() {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  const kernel = await Promise.all((await walk(resolve(root, "schemas/v0.2"))).filter(path => path.endsWith(".json")).sort().map(async path => JSON.parse(await readFile(path, "utf8"))));
  const meta = kernel.find(schema => schema.$id.endsWith("comcom-meta.schema.json"));
  ajv.addMetaSchema(meta);
  for (const schema of kernel.filter(schema => schema !== meta)) ajv.addSchema(schema);
  const profileSchemas = (await walk(resolve(root, "profiles/v0.2"))).filter(path => path.endsWith(".schema.json")).sort();
  for (const path of profileSchemas) ajv.addSchema(JSON.parse(await readFile(path, "utf8")));
  const registry = JSON.parse(await readFile(resolve(root, "registry/v0.2/capabilities.json"), "utf8"));
  const capabilities = new Map(registry.capabilities.map(capability => [capability.id, capability]));
  const releaseManifest = JSON.parse(await readFile(resolve(root, "releases/v0.2.0/release-manifest.json"), "utf8"));
  const releaseFiles = new Map(releaseManifest.files.map(file => [file.path, file]));

  const protocol = {
    ajv,
    registry,
    releaseManifest,
    capabilities,

    validateDiscovery(raw, context = {}) {
      if (context.method === "HEAD" && (!raw || raw.length === 0)) {
        if (context.contentType !== "application/linkset+json") return invalid("discovery", "content-type-mismatch", "RFC 9727 discovery requires application/linkset+json", 415);
        return valid(null);
      }
      const parsed = rawValue(raw, 65536);
      if (parsed.error) return parsed.error;
      if (context.method && !["GET", "HEAD"].includes(context.method)) return invalid("discovery", "method-not-allowed", "Discovery supports GET and HEAD", 405);
      if (context.contentType && context.contentType.split(";")[0].trim() !== "application/linkset+json") return invalid("discovery", "content-type-mismatch", "RFC 9727 discovery requires application/linkset+json", 415);
      const validate = ajv.getSchema(ids.discovery);
      if (!validate(parsed.value)) return invalid("discovery", "schema-invalid", "Invalid RFC 9727 linkset", 400, normalizeErrors(validate.errors));
      for (const linkset of parsed.value.linkset) {
        if (!linkset.anchor.startsWith("https://")) return invalid("discovery", "unsafe-url", "Discovery anchors must use HTTPS");
        for (const item of linkset.item) if (!item.href.startsWith("https://")) return invalid("discovery", "unsafe-url", "Manifest links must use HTTPS");
      }
      return valid(parsed.value);
    },

    validateManifest(raw) {
      const parsed = rawValue(raw);
      if (parsed.error) return parsed.error;
      const validate = ajv.getSchema(ids.manifest);
      if (!validate(parsed.value)) return invalid("manifest", "schema-invalid", "Invalid manifest", 400, normalizeErrors(validate.errors));
      const manifest = parsed.value;
      const profileIds = new Set(manifest.profiles.map(profile => profile.id));
      const schemes = new Set(Object.keys(manifest.securitySchemes ?? {}));
      for (const profile of manifest.profiles) {
        const path = `profiles/${profile.id}.bundle.json`;
        const expected = releaseFiles.get(path);
        if (!expected || profile.release !== `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/${path}` || profile.sha256 !== expected.sha256) return invalid("manifest", "profile-digest-mismatch", `${profile.id} does not identify the verified profile bundle`);
      }
      const declarations = new Set();
      for (const declaration of manifest.capabilities) {
        const capability = capabilities.get(declaration.id);
        const declarationKey = `${declaration.id}\0${declaration.version}\0${declaration.direction}`;
        if (declarations.has(declarationKey)) return invalid("manifest", "duplicate-capability-declaration", `${declaration.id} is declared twice in the same direction`);
        declarations.add(declarationKey);
        if (!capability || capability.version !== declaration.version) return invalid("manifest", "unsupported-capability", `${declaration.id}@${declaration.version} is not in the verified release`);
        if (!profileIds.has(declaration.profile) || declaration.profile !== capability.profile) return invalid("manifest", "profile-mismatch", `${declaration.id} is assigned to a different profile`);
        if (declaration.kinds.length !== 1 || declaration.kinds[0] !== capability.requestKind) return invalid("manifest", "message-kind-mismatch", `${declaration.id} must declare only its registered request kind`);
        if (declaration.inputSchema !== capability.schemas.input || declaration.outputSchema !== capability.schemas.output) return invalid("manifest", "profile-schema-mismatch", `${declaration.id} schema identifiers differ from the verified profile`);
        if (declaration.executionModes.some(mode => !capability.executionModes.includes(mode))) return invalid("manifest", "execution-mode-mismatch", `${declaration.id} advertises an unsupported execution mode`);
        const role = declaration.kinds.includes("event") ? "inboxReceiver" : "responder";
        if (declaration.direction === "receive" && !manifest.roles.includes(role)) return invalid("role", "role-mismatch", `${declaration.id} receipt requires ${role}`);
        if (declaration.direction === "send" && !manifest.roles.includes("initiator")) return invalid("role", "role-mismatch", `${declaration.id} sending requires initiator`);
        if (declaration.executionModes.includes("asynchronous") && !manifest.roles.includes("asyncResponder") && declaration.direction === "receive") return invalid("role", "role-mismatch", `${declaration.id} asynchronous receipt requires asyncResponder`);
        for (const form of declaration.forms ?? []) {
          if (!declaration.executionModes.includes(form.executionMode)) return invalid("manifest", "execution-mode-mismatch", `${form.executionMode} is not declared for ${declaration.id}`);
          if (!manifest.serviceOrigins.some(origin => form.href.startsWith(`${origin}/`) || form.href === origin)) return invalid("endpoint", "endpoint-origin-mismatch", `${form.href} is outside serviceOrigins`);
          for (const requirement of form.security) for (const [name, scopes] of Object.entries(requirement)) {
            if (!schemes.has(name)) return invalid("security", "unknown-security-scheme", `${name} is not declared`);
            if (!["oauth2", "openIdConnect"].includes(manifest.securitySchemes[name].type) && scopes.length) return invalid("security", "invalid-security-scopes", `${name} cannot declare OAuth scopes`);
          }
          if (declaration.kinds.includes("command") && !declaration.anonymousCommand && form.security.some(requirement => Object.keys(requirement).length === 0)) return invalid("security", "anonymous-command-forbidden", `${declaration.id} does not explicitly permit anonymous commands`);
        }
        if (declaration.direction === "receive" && declaration.kinds[0] === "event" && !manifest.inbox?.admissions.some(admission => admission.capabilities.includes(declaration.id))) return invalid("manifest", "inbox-admission-missing", `${declaration.id} has no exact inbox admission`);
      }
      for (const origin of manifest.serviceOrigins) if (!exactOrigin(`${origin}/`)) return invalid("manifest", "unsafe-url", `${origin} is not an HTTPS origin`);
      return valid(manifest);
    },

    validateRequest(raw, context = {}) {
      const parsed = rawValue(raw, context.maxBytes ?? 1048576);
      if (parsed.error) return parsed.error;
      const message = parsed.value;
      if (message?.protocolVersion !== "0.2") return invalid("protocol", "protocol-version-mismatch", "protocolVersion must be 0.2");
      const envelope = ajv.getSchema(ids.envelope);
      if (!envelope(message)) return invalid("envelope", "schema-invalid", "Invalid Comcom envelope", 400, normalizeErrors(envelope.errors));
      const capability = capabilities.get(message.capability.id);
      if (!capability || capability.version !== message.capability.version) return invalid("capability", "capability-version-mismatch", "Capability ID and exact SemVer are not in the release", 422);
      if (message.kind !== capability.requestKind) return invalid("capability", "message-kind-mismatch", `Expected ${capability.requestKind}, received ${message.kind}`, 422);
      const manifest = context.manifest;
      if (!manifest) return invalid("direction", "manifest-required", "Request validation requires the receiver manifest");
      const declaration = manifest.capabilities.find(item => item.id === capability.id && item.version === capability.version && item.direction === "receive");
      if (!declaration) return invalid("direction", "direction-mismatch", "Capability is not advertised for receipt", 404);
      if (!declaration.kinds.includes(message.kind)) return invalid("capability", "message-kind-mismatch", "Manifest does not accept this message kind", 422);
      if (declaration.inputSchema !== capability.schemas.input || declaration.outputSchema !== capability.schemas.output) return invalid("capability", "profile-schema-mismatch", "Manifest schemas differ from the verified profile", 422);
      const requiredRole = message.kind === "event" ? "inboxReceiver" : "responder";
      if (!manifest.roles.includes(requiredRole)) return invalid("role", "role-mismatch", `Receipt requires ${requiredRole}`, 403);
      if (message.recipient.id !== manifest.entity.id) return invalid("recipient", "recipient-mismatch", "Message recipient does not match the receiving manifest", 403);
      if (!context.transport?.senderId || message.sender.id !== context.transport.senderId) return invalid("identity", "sender-identity-mismatch", "Authenticated transport sender does not match message.sender.id", 403);
      const form = selectForm(declaration, context);
      if (!form) return invalid("endpoint", "endpoint-mismatch", "Request was not delivered to a declared form", 404);
      const requirements = form.security ?? manifest.security;
      if (!requirements || !securitySatisfied(requirements, context.transport)) return invalid("security", "security-requirement-unsatisfied", "No OpenAPI security requirement alternative is satisfied", 401);
      const extensionFailure = criticalExtensions(message, context.supportedExtensions);
      if (extensionFailure) return extensionFailure;
      const validatePayload = profileSchema(protocol, capability);
      if (!validatePayload(message.payload)) return invalid("payload", "schema-invalid", "Payload does not match the capability input schema", 422, normalizeErrors(validatePayload.errors));
      const timing = timeFailure(message, context);
      if (timing) return timing;
      return valid(message, { capability, declaration, form });
    },

    validateResponse(raw, context = {}) {
      const parsed = rawValue(raw, context.maxBytes ?? 1048576);
      if (parsed.error) return parsed.error;
      const message = parsed.value;
      if (message?.protocolVersion !== "0.2") return invalid("protocol", "protocol-version-mismatch", "protocolVersion must be 0.2");
      const envelope = ajv.getSchema(ids.envelope);
      if (!envelope(message)) return invalid("envelope", "schema-invalid", "Invalid Comcom envelope", 400, normalizeErrors(envelope.errors));
      const request = context.request;
      if (!request) return invalid("response", "request-context-required", "Response validation requires the original request");
      const capability = capabilities.get(request.capability.id);
      if (!capability || message.capability.id !== request.capability.id || message.capability.version !== request.capability.version) return invalid("capability", "capability-version-mismatch", "Response capability differs from the request", 422);
      const expectedKind = request.kind === "event" ? "receipt" : "result";
      if (message.kind !== expectedKind) return invalid("response", "response-kind-mismatch", `Expected ${expectedKind}, received ${message.kind}`, 422);
      if (message.correlationId !== request.id) return invalid("correlation", "correlation-mismatch", "Response correlationId does not equal the request id", 422);
      if (message.recipient.id !== request.sender.id || message.sender.id !== request.recipient.id) return invalid("recipient", "recipient-mismatch", "Response participants do not reverse the request participants", 403);
      if (context.transport?.senderId && message.sender.id !== context.transport.senderId) return invalid("identity", "sender-identity-mismatch", "Authenticated responder does not match message.sender.id", 403);
      const extensionFailure = criticalExtensions(message, context.supportedExtensions);
      if (extensionFailure) return extensionFailure;
      const operationPayload = message.kind === "result" && message.payload && typeof message.payload === "object" && "statusUrl" in message.payload && "state" in message.payload;
      if (operationPayload) {
        const validateOperation = ajv.getSchema(ids.operation);
        if (!validateOperation(message.payload)) return invalid("payload", "schema-invalid", "Payload does not match the asynchronous operation schema", 422, normalizeErrors(validateOperation.errors));
        if (message.payload.state === "completed") {
          const validateOutput = profileSchema(protocol, capability, true);
          if (!validateOutput(message.payload.output)) return invalid("payload", "schema-invalid", "Completed operation output does not match the capability output schema", 422, normalizeErrors(validateOutput.errors));
        }
      } else {
        const validatePayload = profileSchema(protocol, capability, true);
        if (!validatePayload(message.payload)) return invalid("payload", "schema-invalid", "Payload does not match the capability output schema", 422, normalizeErrors(validatePayload.errors));
      }
      const timing = timeFailure(message, context);
      if (timing) return timing;
      return valid(message, { capability });
    },

    validateReleaseBundle(raw, context = {}) {
      const parsed = rawValue(raw, 16777216);
      if (parsed.error) return { ...parsed.error, phase: "bundle" };
      const validate = ajv.getSchema(ids.release);
      if (!validate(parsed.value)) return invalid("bundle", "schema-invalid", "Invalid release manifest", 400, normalizeErrors(validate.errors));
      for (const file of parsed.value.files) {
        const supplied = context.files?.[file.path];
        if (supplied === undefined) return invalid("bundle", "bundle-file-missing", `${file.path} is missing`);
        const bytes = Buffer.from(supplied, context.filesEncoding === "base64" ? "base64" : "utf8");
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) return invalid("bundle", "digest-mismatch", `${file.path} does not match its recorded digest`);
      }
      const tree = createHash("sha256").update(parsed.value.files.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
      if (tree !== parsed.value.treeSha256) return invalid("bundle", "digest-mismatch", "Release tree digest does not match");
      return valid(parsed.value);
    }
  };
  return protocol;
}
