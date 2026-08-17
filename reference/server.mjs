import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProtocol, entity, message, problem } from "./protocol.mjs";

const supported = [
  "comcom.product.search",
  "comcom.availability.check",
  "comcom.quote.request",
  "comcom.order.create",
  "comcom.appointment.create",
  "comcom.booking.create",
  "comcom.booking.get",
  "comcom.booking.cancel",
  "comcom.announcement.receive",
  "comcom.offer.receive"
];

const provider = entity("https://vendor.example", "organization", "Example Vendor");
const root = fileURLToPath(new URL("../", import.meta.url));
const products = [
  { id: "https://vendor.example/products/desk", type: "Product", state: "available", attributes: { name: "Standing desk", category: "furniture", price: 420, currency: "USD" } },
  { id: "https://vendor.example/products/chair", type: "Product", state: "available", attributes: { name: "Ergonomic chair", category: "furniture", price: 260, currency: "USD" } }
];

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
  response.end(JSON.stringify(body, null, 2));
};

async function bodyOf(request, maxBytes = 262144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Payload exceeds receiver limit."), { status: 413, code: "payload-too-large" });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body is not valid JSON."), { status: 400, code: "invalid-json" }); }
}

function responseEnvelope(requestMessage, capability, payload, kind = "result") {
  return message({
    id: `urn:uuid:${randomUUID()}`,
    kind,
    capability,
    principal: provider,
    sender: provider,
    recipient: requestMessage.sender,
    correlationId: requestMessage.id,
    payload
  });
}

export async function createComcomServer({ port = 8787 } = {}) {
  const protocol = await createProtocol();
  const idempotency = new Map();
  const eventIds = new Set();
  const bookings = new Map();
  const operations = new Map();
  const baseUrl = `http://localhost:${port}/comcom`;
  const capabilityEntries = supported.map(id => {
    const capability = protocol.capabilities.get(id);
    return {
      id,
      version: capability.version,
      direction: capability.kind === "event" ? "receive" : "receive",
      inputSchema: capability.inputSchema,
      outputSchema: capability.outputSchema,
      forms: [{ href: capability.kind === "event" ? `${baseUrl}/inbox` : `${baseUrl}/interactions`, method: "POST", contentType: "application/json", security: ["public"], synchronous: true, timeoutSeconds: 30 }]
    };
  });
  const manifest = {
    protocolVersions: ["0.1"],
    entity: provider,
    roles: ["responder", "inboxReceiver"],
    baseUrl,
    securitySchemes: { public: { type: "none" } },
    capabilities: capabilityEntries,
    inbox: { href: `${baseUrl}/inbox`, acceptedCapabilities: ["comcom.announcement.receive", "comcom.offer.receive"], maxBytes: 65536, security: ["public"] }
  };

  async function execute(requestMessage, capability) {
    const parameters = requestMessage.payload.parameters;
    switch (capability.id) {
      case "comcom.product.search": {
        const criteria = parameters.criteria;
        const items = products.filter(product => Object.entries(criteria).every(([key, value]) => String(product.attributes[key] ?? "").toLowerCase().includes(String(value).toLowerCase())));
        return { status: "completed", items };
      }
      case "comcom.availability.check":
        return { status: "completed", resource: { id: `${parameters.serviceId}#availability`, type: "Availability", state: "available", attributes: { slots: [{ start: parameters.start, end: parameters.end, remaining: 1 }] } } };
      case "comcom.quote.request": {
        const total = parameters.items.reduce((sum, line) => sum + line.quantity * 100, 0);
        return { status: "completed", resource: { id: `urn:uuid:${randomUUID()}`, type: "Quote", state: "proposed", attributes: { total, currency: parameters.currency, validUntil: new Date(Date.now() + 3600000).toISOString() } } };
      }
      case "comcom.order.create":
        return { status: "completed", resource: { id: `urn:uuid:${randomUUID()}`, type: "Order", state: "accepted", attributes: { lines: parameters.lines } }, nextActions: ["comcom.order.get", "comcom.order.cancel"] };
      case "comcom.appointment.create":
      case "comcom.booking.create": {
        const resourceId = parameters.serviceId ?? parameters.offeringId;
        const slot = `${resourceId}|${parameters.start}|${parameters.end}`;
        if ([...bookings.values()].some(booking => booking.slot === slot && booking.state !== "cancelled")) {
          throw Object.assign(new Error("The requested slot is no longer available."), { status: 409, code: "slot-conflict" });
        }
        const id = `urn:uuid:${randomUUID()}`;
        bookings.set(id, { id, slot, state: "accepted", ...parameters });
        return { status: "completed", resource: { id, type: capability.resourceType, state: "accepted", attributes: parameters }, nextActions: capability.id === "comcom.booking.create" ? ["comcom.booking.get", "comcom.booking.cancel"] : ["comcom.appointment.get", "comcom.appointment.cancel"] };
      }
      case "comcom.booking.get": {
        const booking = bookings.get(parameters.resourceId);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "resource-not-found" });
        return { status: "completed", resource: { id: booking.id, type: "Booking", state: booking.state, attributes: booking } };
      }
      case "comcom.booking.cancel": {
        const booking = bookings.get(parameters.resourceId);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "resource-not-found" });
        if (booking.state === "cancelled") throw Object.assign(new Error("Booking is already cancelled."), { status: 409, code: "invalid-transition" });
        booking.state = "cancelled";
        return { status: "completed", resource: { id: booking.id, type: "Booking", state: "cancelled", attributes: booking } };
      }
      default:
        throw Object.assign(new Error("Capability is not implemented by this responder."), { status: 404, code: "unsupported-capability" });
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/.well-known/comcom") {
        return json(response, 200, { versions: ["0.1"], manifest: `${baseUrl}/manifest` }, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
      }
      if (request.method === "GET" && url.pathname === "/comcom/manifest") return json(response, 200, manifest, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
      if (request.method === "GET" && url.pathname === "/ui") {
        const ui = await readFile(fileURLToPath(new URL("./ui.html", import.meta.url)));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(ui);
      }
      if (request.method === "GET" && url.pathname.startsWith("/schemas/v0.1/")) {
        const relative = url.pathname.slice(1);
        const target = resolve(root, relative);
        if (!target.startsWith(resolve(root, "schemas/v0.1/"))) return json(response, 404, problem(404, "not-found", "Schema not found"));
        try {
          const schema = await readFile(target);
          response.writeHead(200, { "content-type": "application/schema+json", "access-control-allow-origin": "*" });
          return response.end(schema);
        } catch {
          return json(response, 404, problem(404, "not-found", "Schema not found"));
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/comcom/interactions/")) {
        const operation = operations.get(url.pathname.split("/").at(-1));
        return operation ? json(response, 200, operation) : json(response, 404, problem(404, "operation-not-found", "Operation not found"));
      }
      if (request.method === "POST" && ["/comcom/interactions", "/comcom/inbox"].includes(url.pathname)) {
        const requestMessage = await bodyOf(request, url.pathname.endsWith("inbox") ? 65536 : 262144);
        const validation = protocol.validateMessage(requestMessage);
        if (!validation.valid) return json(response, 400, problem(400, "invalid-message", "Invalid Comcom message", `Validation failed during ${validation.phase}.`, validation.errors));
        if (requestMessage.expiresAt && Date.parse(requestMessage.expiresAt) <= Date.now()) return json(response, 412, problem(412, "message-expired", "Message has expired"));
        if (!supported.includes(validation.capability.id)) return json(response, 404, problem(404, "unsupported-capability", "Unsupported capability"));
        const expectedEndpoint = validation.capability.kind === "event" ? "/comcom/inbox" : "/comcom/interactions";
        if (url.pathname !== expectedEndpoint || requestMessage.kind !== validation.capability.kind) return json(response, 400, problem(400, "wrong-message-kind", "Message kind or endpoint does not match capability"));

        const key = `${requestMessage.sender.id}|${validation.capability.id}|${requestMessage.idempotencyKey ?? ""}`;
        const fingerprint = hash(requestMessage.payload);
        if (requestMessage.idempotencyKey && idempotency.has(key)) {
          const previous = idempotency.get(key);
          if (previous.fingerprint !== fingerprint) return json(response, 409, problem(409, "idempotency-conflict", "Idempotency key was reused with a different payload"));
          return json(response, previous.status, previous.response);
        }

        if (validation.capability.kind === "event") {
          const topic = requestMessage.payload.parameters.topic;
          const disposition = eventIds.has(requestMessage.id) ? "duplicate" : topic === "blocked" ? "discarded" : "accepted";
          eventIds.add(requestMessage.id);
          const receipt = responseEnvelope(requestMessage, validation.capability.id, { disposition, receivedAt: new Date().toISOString() }, "receipt");
          idempotency.set(key, { fingerprint, status: 202, response: receipt });
          return json(response, 202, receipt);
        }

        const payload = await execute(requestMessage, validation.capability);
        const result = responseEnvelope(requestMessage, validation.capability.id, payload);
        const resultValidation = protocol.validateMessage(result);
        if (!resultValidation.valid) throw Object.assign(new Error("Reference responder produced an invalid result."), { status: 500, code: "invalid-server-result", validation: resultValidation.errors });
        if (requestMessage.idempotencyKey) idempotency.set(key, { fingerprint, status: 200, response: result });
        return json(response, 200, result);
      }
      return json(response, 404, problem(404, "not-found", "Endpoint not found"));
    } catch (error) {
      const status = error.status ?? 500;
      return json(response, status, problem(status, error.code ?? "internal-error", status >= 500 ? "Receiver failure" : "Request rejected", error.message, error.validation));
    }
  });

  return {
    server,
    manifest,
    start: () => new Promise(resolveStart => server.listen(port, "127.0.0.1", resolveStart)),
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const app = await createComcomServer({ port });
  await app.start();
  console.log(`Comcom reference responder listening at http://localhost:${port}`);
  console.log(`Schema-driven UI: http://localhost:${port}/ui`);
}
