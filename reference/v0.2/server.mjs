import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createProtocolV02, semanticHash } from "./protocol.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const provider = { id: "https://vendor.example", type: "organization", name: "Example Vendor" };
const manifestPath = fileURLToPath(new URL("../../examples/v0.2/vendor-manifest.json", import.meta.url));

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": status >= 400 ? "application/problem+json" : "application/comcom+json",
    ...headers
  });
  if (response.req.method === "HEAD") response.end();
  else response.end(JSON.stringify(body, null, 2));
}

function problem(status, phase, code, detail) {
  return {
    type: `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/problems/${code}`,
    title: code.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join(" "),
    status,
    phase,
    code,
    detail
  };
}

async function rawBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("Request exceeds the declared message limit"), { status: 413, phase: "raw", code: "message-too-large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function responseEnvelope(request, payload) {
  return {
    protocolVersion: "0.2",
    id: `urn:uuid:${randomUUID()}`,
    kind: "result",
    capability: request.capability,
    principal: request.principal,
    sender: provider,
    recipient: request.sender,
    issuedAt: new Date().toISOString(),
    correlationId: request.id,
    payload
  };
}

export async function createComcomV02Server({ port = 8788 } = {}) {
  const protocol = await createProtocolV02();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const idempotency = new Map();
  const slots = new Map();
  const operations = new Map();

  function transportContext(request) {
    const authorization = request.headers.authorization ?? "";
    return {
      senderId: request.headers["x-comcom-sender"],
      scheme: authorization.startsWith("Bearer ") ? "businessOAuth" : undefined,
      scopes: String(request.headers["x-comcom-scopes"] ?? "").split(" ").filter(Boolean),
      roles: String(request.headers["x-comcom-roles"] ?? "").split(" ").filter(Boolean)
    };
  }

  function completeBooking(request) {
    const booking = request.payload.parameters.booking;
    const now = new Date().toISOString();
    const resource = {
      id: `https://vendor.example/bookings/${randomUUID()}`,
      type: "Booking",
      state: "accepted",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...booking
    };
    return { status: "completed", resource, nextActions: ["comcom.booking.get", "comcom.booking.cancel"] };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (["GET", "HEAD"].includes(request.method) && url.pathname === "/.well-known/api-catalog") {
        const linkset = {
          linkset: [{
            anchor: "https://vendor.example/.well-known/api-catalog",
            item: [{
              href: "https://vendor.example/comcom/v0.2/manifest",
              type: "application/vnd.comcom.manifest+json",
              profile: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest",
              title: "Example Vendor Comcom manifest"
            }]
          }]
        };
        return send(response, 200, linkset, { "content-type": "application/linkset+json", "cache-control": "public, max-age=300" });
      }
      if (["GET", "HEAD"].includes(request.method) && url.pathname === "/comcom/v0.2/manifest") {
        return send(response, 200, manifest, { "content-type": "application/vnd.comcom.manifest+json", "cache-control": "public, max-age=300" });
      }
      if (["GET", "HEAD"].includes(request.method) && url.pathname === "/.well-known/comcom") {
        return send(response, 200, { versions: ["0.1"], manifest: "https://vendor.example/comcom/v0.1/manifest", status: "legacy-v0.1-compatibility" }, { "content-type": "application/json", "deprecation": "true" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/comcom/interactions/")) {
        const id = url.pathname.split("/").at(-1);
        const operation = operations.get(id);
        if (!operation) return send(response, 404, problem(404, "response", "operation-not-found", "No such operation"));
        return send(response, 200, operation.envelope);
      }
      if (request.method === "POST" && url.pathname === "/comcom/interactions") {
        if ((request.headers["content-type"] ?? "").split(";")[0] !== "application/comcom+json") return send(response, 415, problem(415, "endpoint", "content-type-mismatch", "Use application/comcom+json"));
        const raw = await rawBody(request, manifest.limits.messageBytes);
        const transport = transportContext(request);
        let message;
        try {
          message = parseStrictJson(raw, { maxBytes: manifest.limits.messageBytes });
        } catch (error) {
          return send(response, error.code === "message-too-large" ? 413 : 400, problem(error.code === "message-too-large" ? 413 : 400, "raw", error.code, error.message));
        }

        let key;
        let fingerprint;
        if (message?.sender?.id && message?.capability?.id && message?.idempotencyKey) {
          key = `${message.sender.id}\0${message.capability.id}\0${message.idempotencyKey}`;
          try { fingerprint = semanticHash(message); } catch { /* validation below produces the stable failure */ }
        }
        if (key && idempotency.has(key)) {
          const validation = protocol.validateRequest(raw, {
            manifest,
            endpoint: { url: "https://vendor.example/comcom/interactions", method: "POST" },
            transport,
            recordedReplay: true
          });
          if (!validation.valid) return send(response, validation.status, problem(validation.status, validation.phase, validation.code, validation.errors[0].message));
          const stored = idempotency.get(key);
          if (stored.fingerprint !== fingerprint) return send(response, 409, problem(409, "idempotency", "idempotency-conflict", "The same sender/capability/key identifies a different semantic request"));
          return send(response, stored.status, stored.envelope);
        }

        const validation = protocol.validateRequest(raw, {
          manifest,
          endpoint: { url: "https://vendor.example/comcom/interactions", method: "POST" },
          transport
        });
        if (!validation.valid) return send(response, validation.status, problem(validation.status, validation.phase, validation.code, validation.errors[0].message));

        const booking = message.payload.parameters.booking;
        const slot = `${booking.offeringId}\0${booking.providerId}\0${booking.start}\0${booking.end}`;
        if (slots.has(slot)) return send(response, 409, problem(409, "payload", "slot-conflict", "The requested booking slot is no longer available"));
        slots.set(slot, true);

        let status;
        let envelope;
        if (request.headers.prefer === "respond-async") {
          const id = randomUUID();
          const acceptedAt = new Date().toISOString();
          envelope = responseEnvelope(message, {
            id: `https://vendor.example/operations/${id}`,
            statusUrl: `https://vendor.example/comcom/interactions/${id}`,
            state: "accepted",
            acceptedAt,
            updatedAt: acceptedAt,
            originalCorrelationId: message.id
          });
          operations.set(id, { envelope });
          setTimeout(() => {
            const completedAt = new Date().toISOString();
            operations.set(id, { envelope: responseEnvelope(message, {
              id: `https://vendor.example/operations/${id}`,
              statusUrl: `https://vendor.example/comcom/interactions/${id}`,
              state: "completed",
              acceptedAt,
              updatedAt: completedAt,
              completedAt,
              originalCorrelationId: message.id,
              output: completeBooking(message)
            }) });
          }, 10);
          status = 202;
        } else {
          envelope = responseEnvelope(message, completeBooking(message));
          status = 200;
        }
        const outputValidation = protocol.validateResponse(Buffer.from(JSON.stringify(envelope)), { request: message, transport: { senderId: provider.id } });
        if (!outputValidation.valid) throw Object.assign(new Error(outputValidation.errors[0].message), { status: 500, phase: outputValidation.phase, code: "invalid-server-result" });
        idempotency.set(key, { fingerprint, status, envelope });
        return send(response, status, envelope);
      }
      return send(response, 404, problem(404, "endpoint", "not-found", "Endpoint not found"));
    } catch (error) {
      const status = error.status ?? 500;
      return send(response, status, problem(status, error.phase ?? "response", error.code ?? "internal-error", error.message));
    }
  });

  return {
    manifest,
    server,
    start: () => new Promise(resolveStart => server.listen(port, "127.0.0.1", resolveStart)),
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8788);
  const app = await createComcomV02Server({ port });
  await app.start();
  console.log(`Comcom v0.2 non-conformant loopback demo: http://127.0.0.1:${port}`);
}
