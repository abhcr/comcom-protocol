import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createProtocolV02 } from "./protocol.mjs";
import { createComcomV02Server } from "./server.mjs";

const protocol = await createProtocolV02();
const app = await createComcomV02Server({ port: 0 });
await app.start();
const origin = `http://127.0.0.1:${app.server.address().port}`;
console.log("Comcom v0.2 booking evaluation: HTTP loopback, mocked authentication; not a conformant production transport.");

function localUrl(href) {
  const url = new URL(href);
  assert.equal(url.origin, "https://vendor.example");
  return `${origin}${url.pathname}`;
}

function accepted(verdict) {
  assert.equal(verdict.valid, true, JSON.stringify(verdict));
  return verdict.value;
}

async function send(request, asynchronous = false) {
  const response = await fetch(localUrl(endpoint.href), {
    method: "POST",
    headers: {
      "content-type": "application/comcom+json",
      authorization: "Bearer demo-only-not-a-real-token",
      "x-comcom-sender": request.sender.id,
      "x-comcom-scopes": "booking:create",
      ...(asynchronous ? { prefer: "respond-async" } : {})
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, raw: await response.text() };
}

let endpoint;
try {
  const discoveryResponse = await fetch(`${origin}/.well-known/api-catalog`, { signal: AbortSignal.timeout(5000) });
  assert.equal(discoveryResponse.status, 200);
  const discovery = accepted(protocol.validateDiscovery(await discoveryResponse.text(), {
    method: "GET", contentType: discoveryResponse.headers.get("content-type")
  }));
  const link = discovery.linkset[0].item[0];
  const manifestResponse = await fetch(localUrl(link.href), { signal: AbortSignal.timeout(5000) });
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get("content-type"), "application/vnd.comcom.manifest+json");
  const manifest = accepted(protocol.validateManifest(await manifestResponse.text(), { manifestProfile: link.profile }));
  endpoint = manifest.capabilities.find(capability => capability.id === "comcom.booking.create").forms.find(form => form.executionMode === "synchronous");
  console.log("PASS discovery and pinned-profile manifest validation");

  const request = JSON.parse(await readFile(new URL("../../examples/v0.2/booking-create.request.json", import.meta.url)));
  const now = Date.now();
  request.id = `urn:uuid:${randomUUID()}`;
  request.idempotencyKey = randomUUID();
  request.issuedAt = new Date(now).toISOString();
  request.expiresAt = new Date(now + 300_000).toISOString();
  request.payload.parameters.booking.start = new Date(now + 86_400_000).toISOString();
  request.payload.parameters.booking.end = new Date(now + 88_200_000).toISOString();
  accepted(protocol.validateRequest(JSON.stringify(request), {
    manifest,
    endpoint: { url: endpoint.href, method: endpoint.method },
    transport: { senderId: request.sender.id, scheme: "businessOAuth", scopes: ["booking:create"] }
  }));
  const responseContext = { request, transport: { senderId: manifest.entity.id } };
  const result = await send(request);
  assert.equal(result.status, 200);
  assert.equal(accepted(protocol.validateResponse(result.raw, responseContext)).payload.status, "completed");
  console.log("PASS booking.create: HTTP 200, correlated and identity-bound result");

  const replay = await send(request);
  assert.equal(replay.status, 200);
  assert.equal(replay.raw, result.raw);
  console.log("PASS exact replay: identical response bytes");

  const conflict = structuredClone(request);
  conflict.payload.parameters.booking.providerId = "https://vendor.example/providers/another";
  const conflictingResponse = await send(conflict);
  assert.equal(conflictingResponse.status, 409);
  assert.equal(JSON.parse(conflictingResponse.raw).code, "idempotency-conflict");
  console.log("PASS changed request with reused key: HTTP 409 idempotency-conflict");

  const asynchronous = structuredClone(request);
  asynchronous.id = `urn:uuid:${randomUUID()}`;
  asynchronous.idempotencyKey = randomUUID();
  asynchronous.payload.parameters.booking.start = new Date(now + 172_800_000).toISOString();
  asynchronous.payload.parameters.booking.end = new Date(now + 174_600_000).toISOString();
  const asyncContext = { request: asynchronous, transport: { senderId: manifest.entity.id } };
  const pending = await send(asynchronous, true);
  assert.equal(pending.status, 202);
  let operation = accepted(protocol.validateResponse(pending.raw, asyncContext)).payload;
  assert.equal(operation.state, "accepted");
  const deadline = Date.now() + 5000;
  while (operation.state !== "completed" && Date.now() < deadline) {
    await setTimeout(25);
    const polled = await fetch(localUrl(operation.statusUrl), { signal: AbortSignal.timeout(5000) });
    assert.equal(polled.status, 200);
    operation = accepted(protocol.validateResponse(await polled.text(), asyncContext)).payload;
  }
  assert.equal(operation.state, "completed");
  assert.equal(operation.output.status, "completed");
  console.log("PASS asynchronous booking: HTTP 202 → polling → completed");
  console.log("Evaluation passed. No external business service was called.");
} finally {
  await app.close();
}
