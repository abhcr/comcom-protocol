// Reusable Comcom v0.2 interaction client.
//
// discover -> prepare -> submit -> poll, using only deterministic validation:
// - discovery uses discoverCapability (safe retrieval, pinned profiles, every
//   manifest evaluated, ambiguity reported);
// - a request is built from the discovered contract and validated with the
//   existing validateRequest before any byte is sent; the validated bytes are
//   exactly the bytes submitted;
// - responses, operations, and problems are validated with the pinned schemas
//   and validateResponse.
//
// Nothing here depends on MCP or on a model. Results are plain JSON so an
// application, a CLI, or a future MCP adapter can return them unchanged.
// Authentication is supplied by the caller through `authenticate`; this module
// contains no credentials and no mocked authentication.
//
// Trust boundary: discovered documents are claims. The responder identity used
// to address the request and to validate results must come from the caller's
// authenticated transport through `responderIdentity`; it is never taken from a
// manifest or a response. Discovery identity facts remain informational.
//
// No request is submitted unless discovery reports outcome "advertised", the
// caller supplies a trusted responder identity equal to the discovered entity,
// and the prepared request passes validation.

import { randomUUID as defaultRandomUUID } from "node:crypto";
import { developmentMap, developmentTarget, discoverCapability } from "./discover.mjs";
import { createProtocolV02 } from "./protocol.mjs";
import { secureFetch, UnsafeUrlError } from "./secure-fetch.mjs";
import { parseStrictJson, StrictJsonError } from "./strict-json.mjs";

const COMCOM_TYPE = "application/comcom+json";
const PROBLEM_TYPE = "application/problem+json";
const PROBLEM_SCHEMA = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/problem.schema.json";

const mediaType = value => String(value ?? "").split(";")[0].trim().toLowerCase();
const failure = (phase, code, message, extra = {}) => ({ phase, code, errors: [{ path: "/", message }], ...extra });

function isAbsoluteUri(value) {
  if (typeof value !== "string") return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

// The part of a receiver manifest that validateRequest consults, rebuilt from
// the discovered contract so request validation uses the validated declaration.
function receiverView(discovery) {
  return {
    entity: discovery.entity,
    roles: discovery.roles,
    capabilities: [{
      id: discovery.capability.id,
      version: discovery.capability.version,
      direction: "receive",
      kinds: discovery.declaration.kinds,
      inputSchema: discovery.declaration.inputSchema,
      outputSchema: discovery.declaration.outputSchema,
      forms: discovery.forms
    }]
  };
}

// Level-1 URI template match, e.g. https://vendor.example/ops/{id}.
function matchesTemplate(template, url) {
  const pattern = template.split(/(\{[^}]+\})/).map(part => part.startsWith("{") ? "[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${pattern}$`).test(url);
}

/**
 * @param {object} options
 * @param {Function} options.authenticate async ({ capability, recipient, form, securitySchemes })
 *   => null | { senderId, scheme, scopes, headers }. Returns the trusted
 *   transport identity and the headers that establish it, or null when no
 *   security alternative of the form can be satisfied.
 * @param {Function} options.responderIdentity async ({ capability, form, origin })
 *   => trusted responder ID, or null when unknown. Required before anything is
 *   submitted. It must come from the authenticated transport for `origin` (for
 *   example the verified TLS server identity or a pinned partner registry),
 *   not from discovered documents. No fallback exists: without it, nothing is
 *   submitted.
 * @param {object} [options.protocol] createProtocolV02() instance.
 * @param {Record<string,string>} [options.developmentOrigins] Non-conformant
 *   HTTPS-to-loopback mapping, applied to discovery, submission, and polling.
 * @param {Function} [options.resolver] DNS resolver for secureFetch.
 * @param {number} [options.timeoutMs=10000] Per-request timeout.
 * @param {object} [options.discovery] Extra discoverCapability options
 *   (deadlineMs, maxManifests).
 * @param {Function} [options.now] () => epoch milliseconds.
 * @param {Function} [options.randomUUID] UUID generator.
 */
export function createInteractionClient(options = {}) {
  if (typeof options.authenticate !== "function") throw new TypeError("authenticate must be a function");
  const development = developmentMap(options.developmentOrigins);
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  let protocolPromise = options.protocol ? Promise.resolve(options.protocol) : null;
  const protocol = () => (protocolPromise ??= createProtocolV02());

  async function send(url, { method, headers, body, maxBytes }) {
    const target = developmentTarget(development, url);
    try {
      const response = await secureFetch(target.url, {
        method,
        headers,
        body,
        maxBytes,
        maxRedirects: 0,
        timeoutMs: options.timeoutMs ?? 10_000,
        resolver: options.resolver,
        allowInsecureLoopback: target.mapped
      });
      return { response };
    } catch (error) {
      if (error instanceof UnsafeUrlError) return { error: failure("transport", error.code, error.message) };
      return { error: failure("transport", "fetch-failed", `Request failed${error?.code ? ` (${error.code})` : ""}: ${error?.message ?? error}`) };
    }
  }

  // Interprets an HTTP response to a submission or poll.
  async function readResponse(prepared, response, expectOperation) {
    const p = await protocol();
    const type = mediaType(response.headers["content-type"]);
    const raw = response.body.toString("utf8");
    if (response.status >= 400) {
      if (type !== PROBLEM_TYPE) return { outcome: "error", status: response.status, ...failure("response", "unexpected-response", `HTTP ${response.status} without ${PROBLEM_TYPE}`) };
      let problem;
      try {
        problem = parseStrictJson(response.body, { maxBytes: prepared.maxBytes });
      } catch (error) {
        if (!(error instanceof StrictJsonError)) throw error;
        return { outcome: "error", status: response.status, ...failure("response", error.code, error.message) };
      }
      const validate = p.ajv.getSchema(PROBLEM_SCHEMA);
      if (!validate(problem) || problem.status !== response.status) return { outcome: "error", status: response.status, ...failure("response", "invalid-problem", "Error response is not a valid Comcom problem for this status") };
      return { outcome: "rejected", status: response.status, problem, raw };
    }
    if (![200, 202].includes(response.status)) return { outcome: "error", status: response.status, ...failure("response", "unexpected-response", `Unexpected HTTP ${response.status}`) };
    if (type !== COMCOM_TYPE) return { outcome: "error", status: response.status, ...failure("response", "content-type-mismatch", `Response must be ${COMCOM_TYPE}`) };
    const verdict = p.validateResponse(response.body, { request: prepared.request, transport: { senderId: prepared.responderId }, maxBytes: prepared.maxBytes });
    if (!verdict.valid) return { outcome: "error", status: response.status, phase: verdict.phase, code: verdict.code, errors: verdict.errors };
    const envelope = verdict.value;
    const operation = envelope.payload && typeof envelope.payload === "object" && "statusUrl" in envelope.payload && "state" in envelope.payload ? envelope.payload : null;
    if (response.status === 202 && !operation) return { outcome: "error", status: 202, ...failure("response", "operation-missing", "HTTP 202 must carry an asynchronous operation") };
    if (operation) {
      if (!expectOperation) return { outcome: "error", status: response.status, ...failure("response", "unexpected-operation", "A synchronous form returned an asynchronous operation") };
      if (operation.originalCorrelationId !== prepared.request.id) return { outcome: "error", status: response.status, ...failure("correlation", "correlation-mismatch", "Operation does not correlate to the request") };
      // Credentials are only ever sent to a status URL the validated contract allows.
      const { statusTemplate } = prepared.form;
      if (!statusTemplate || !matchesTemplate(statusTemplate, operation.statusUrl) || !prepared.serviceOrigins.includes(new URL(operation.statusUrl).origin)) {
        return { outcome: "error", status: response.status, ...failure("response", "status-url-mismatch", `${operation.statusUrl} does not match the declared status template`) };
      }
      const outcome = { completed: "completed", failed: "operation-failed", cancelled: "operation-cancelled" }[operation.state] ?? "pending";
      return { outcome, status: response.status, response: envelope, operation, raw };
    }
    return { outcome: "completed", status: response.status, response: envelope, raw };
  }

  const client = {
    /** Discovers whether `origin` advertises receipt of `capability`. */
    async discover({ origin, capability }) {
      return discoverCapability({
        ...options.discovery,
        origin,
        capability,
        protocol: await protocol(),
        resolver: options.resolver,
        timeoutMs: options.timeoutMs,
        developmentOrigins: options.developmentOrigins
      });
    },

    /**
     * Builds and validates a request from an advertised discovery result.
     * input: { principal, sender, payload, agent?, authorization?, resource?,
     *          idempotencyKey?, expiresInMs? (default 300000), executionMode? }
     * Returns { ok: true, request, body, ... } or { ok: false, phase, code, errors }.
     */
    async prepare(discovery, input = {}) {
      if (discovery?.outcome !== "advertised") {
        return { ok: false, ...failure("discovery", "capability-not-advertised", `Discovery outcome is ${discovery?.outcome ?? "missing"}; nothing is submitted`) };
      }
      const executionMode = input.executionMode ?? "synchronous";
      const candidates = discovery.forms.filter(form => form.executionMode === executionMode);
      if (!candidates.length) return { ok: false, ...failure("endpoint", "execution-mode-unavailable", `No ${executionMode} form is advertised`) };
      let form;
      let credentials;
      let responderId;
      let identityFailure;
      for (const candidate of candidates) {
        // Confirm the responder before obtaining credentials for it.
        const origin = new URL(candidate.href).origin;
        const trusted = typeof options.responderIdentity === "function"
          ? await options.responderIdentity({ capability: discovery.capability, form: candidate, origin })
          : null;
        if (!isAbsoluteUri(trusted)) {
          identityFailure ??= failure("identity", "responder-identity-unavailable", `No trusted responder identity is available for ${origin}`);
          continue;
        }
        if (trusted !== discovery.entity.id) {
          identityFailure = failure("identity", "responder-identity-mismatch", `The manifest claims ${discovery.entity.id}, but the trusted identity for ${origin} is ${trusted}`);
          continue;
        }
        credentials = await options.authenticate({
          capability: discovery.capability,
          recipient: discovery.entity,
          form: candidate,
          securitySchemes: discovery.securitySchemes
        });
        if (credentials) {
          form = candidate;
          responderId = trusted;
          break;
        }
      }
      if (!form) return { ok: false, ...(identityFailure ?? failure("security", "credentials-unavailable", "No advertised security alternative can be satisfied")) };

      const issued = now();
      const kind = discovery.capability.requestKind;
      const request = {
        protocolVersion: "0.2",
        id: `urn:uuid:${randomUUID()}`,
        kind,
        capability: { id: discovery.capability.id, version: discovery.capability.version },
        principal: input.principal,
        sender: input.sender,
        recipient: discovery.entity,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.authorization ? { authorization: input.authorization } : {}),
        issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + (input.expiresInMs ?? 300_000)).toISOString(),
        ...(input.resource ? { resource: input.resource } : {}),
        ...(input.idempotencyKey || kind !== "query" ? { idempotencyKey: input.idempotencyKey ?? randomUUID() } : {}),
        payload: input.payload
      };
      const body = JSON.stringify(request);
      const transport = { senderId: credentials.senderId, scheme: credentials.scheme, scopes: credentials.scopes ?? [] };
      const maxBytes = discovery.limits.messageBytes;
      const verdict = (await protocol()).validateRequest(body, {
        manifest: receiverView(discovery),
        endpoint: { url: form.href, method: form.method },
        transport,
        maxBytes,
        now: issued
      });
      if (!verdict.valid) return { ok: false, phase: verdict.phase, code: verdict.code, errors: verdict.errors };
      return {
        ok: true,
        request,
        body,
        form,
        // Non-secret description of the authenticated transport. Credential
        // material stays in `headers`, which callers must not expose.
        transport,
        headers: credentials.headers ?? {},
        serviceOrigins: discovery.serviceOrigins,
        maxBytes,
        responderId
      };
    },

    /** Sends the exact validated bytes of a prepared request. May be repeated to replay. */
    async submit(prepared) {
      if (!prepared?.ok) throw new TypeError("submit requires a successfully prepared request");
      const asynchronous = prepared.form.executionMode === "asynchronous";
      const { response, error } = await send(prepared.form.href, {
        method: prepared.form.method,
        body: prepared.body,
        maxBytes: prepared.maxBytes,
        headers: {
          ...prepared.headers,
          "content-type": COMCOM_TYPE,
          accept: `${COMCOM_TYPE}, ${PROBLEM_TYPE}`,
          "content-length": String(Buffer.byteLength(prepared.body)),
          // RFC 7240; Comcom does not yet define how an asynchronous form is selected.
          ...(asynchronous ? { prefer: "respond-async" } : {})
        }
      });
      if (error) return { outcome: "error", ...error };
      return readResponse(prepared, response, asynchronous);
    },

    /** Polls an accepted operation until a terminal state or `timeoutMs`. */
    async poll(prepared, accepted, { intervalMs = 1000, timeoutMs = 30_000 } = {}) {
      let current = accepted;
      const stopAt = now() + timeoutMs;
      while (current.outcome === "pending" && now() < stopAt) {
        await new Promise(resolveWait => setTimeout(resolveWait, intervalMs));
        const { response, error } = await send(current.operation.statusUrl, {
          method: "GET",
          maxBytes: prepared.maxBytes,
          headers: { ...prepared.headers, accept: `${COMCOM_TYPE}, ${PROBLEM_TYPE}` }
        });
        if (error) return { outcome: "error", ...error };
        const next = await readResponse(prepared, response, true);
        if (next.outcome !== "error" && next.operation && next.operation.id !== accepted.operation.id) {
          return { outcome: "error", ...failure("response", "operation-mismatch", "Polling returned a different operation") };
        }
        current = next;
      }
      return current;
    },

    /**
     * discover -> prepare -> submit -> (poll). Returns a JSON result with the
     * stage reached, `submitted` (whether a request was sent), and details.
     */
    async interact({ origin, capability, input, poll = {} }) {
      const discovery = await client.discover({ origin, capability });
      if (discovery.outcome !== "advertised") {
        return { outcome: "not-submitted", stage: "discovery", submitted: false, phase: discovery.phase, code: discovery.code, errors: discovery.errors, discovery };
      }
      const prepared = await client.prepare(discovery, input);
      if (!prepared.ok) {
        const { ok, ...details } = prepared;
        return { outcome: "not-submitted", stage: "prepare", submitted: false, ...details, discovery };
      }
      let result = await client.submit(prepared);
      let stage = "submit";
      if (result.outcome === "pending" && poll !== false) {
        result = await client.poll(prepared, result, poll);
        stage = "poll";
      }
      return { ...result, stage, submitted: true, request: prepared.request, discovery };
    }
  };
  return client;
}
