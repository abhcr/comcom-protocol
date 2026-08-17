import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createProtocol, entity, message } from "../reference/protocol.mjs";
import { createComcomServer } from "../reference/server.mjs";

const port = 18787;
const origin = `http://localhost:${port}`;
const buyer = entity("https://buyer.example", "organization", "Test Buyer");
let app;
let protocol;
let manifest;

function requestMessage(capability, kind, parameters, options = {}) {
  return message({
    id: options.id ?? `urn:uuid:${randomUUID()}`,
    kind,
    capability,
    principal: buyer,
    sender: buyer,
    recipient: manifest.entity,
    idempotencyKey: options.idempotencyKey,
    expiresAt: options.expiresAt,
    payload: { capability, parameters }
  });
}

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  protocol = await createProtocol();
  app = await createComcomServer({ port });
  await app.start();
  manifest = app.manifest;
});

after(async () => app.close());

describe("discovery and capability publication", () => {
  test("publishes valid discovery and manifest documents", async () => {
    const discoveryResponse = await fetch(`${origin}/.well-known/comcom`);
    const discovery = await discoveryResponse.json();
    assert.equal(discoveryResponse.status, 200);
    assert.equal(protocol.validateDiscovery(discovery), true);
    const manifestResponse = await fetch(discovery.manifest);
    const remoteManifest = await manifestResponse.json();
    assert.equal(protocol.validateManifest(remoteManifest), true);
    assert(remoteManifest.capabilities.length < protocol.registry.capabilities.length);
  });

  test("accepts an initiator-only manifest with no received capability", () => {
    const initiator = {
      protocolVersions: ["0.1"],
      entity: buyer,
      roles: ["initiator"],
      baseUrl: "https://buyer.example/comcom",
      capabilities: []
    };
    assert.equal(protocol.validateManifest(initiator), true, JSON.stringify(protocol.validateManifest.errors));
  });

  test("accepts a one-capability responder manifest", () => {
    const single = { ...manifest, roles: ["responder"], capabilities: [manifest.capabilities[0]] };
    delete single.inbox;
    assert.equal(protocol.validateManifest(single), true, JSON.stringify(protocol.validateManifest.errors));
  });
});

describe("queries and commands", () => {
  test("completes product search with a typed result", async () => {
    const request = requestMessage("comcom.product.search", "query", { criteria: { category: "furniture" }, limit: 10 });
    assert.equal(protocol.validateMessage(request).valid, true);
    const response = await post("/comcom/interactions", request);
    assert.equal(response.status, 200);
    assert.equal(protocol.validateMessage(response.body).valid, true);
    assert.equal(response.body.payload.items.length, 2);
  });

  test("creates a booking once and returns the recorded result on retry", async () => {
    const key = `booking-${randomUUID()}`;
    const parameters = {
      offeringId: "https://vendor.example/services/testing",
      customerId: buyer.id,
      start: "2026-09-01T09:00:00Z",
      end: "2026-09-01T10:00:00Z"
    };
    const first = requestMessage("comcom.booking.create", "command", parameters, { idempotencyKey: key });
    const retry = requestMessage("comcom.booking.create", "command", parameters, { idempotencyKey: key });
    const firstResponse = await post("/comcom/interactions", first);
    const retryResponse = await post("/comcom/interactions", retry);
    assert.equal(firstResponse.status, 200);
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(retryResponse.body, firstResponse.body);
  });

  test("rejects reuse of an idempotency key with a different payload", async () => {
    const key = `booking-${randomUUID()}`;
    const base = {
      offeringId: "https://vendor.example/services/idempotency",
      customerId: buyer.id,
      start: "2026-09-02T09:00:00Z",
      end: "2026-09-02T10:00:00Z"
    };
    await post("/comcom/interactions", requestMessage("comcom.booking.create", "command", base, { idempotencyKey: key }));
    const response = await post("/comcom/interactions", requestMessage("comcom.booking.create", "command", { ...base, end: "2026-09-02T11:00:00Z" }, { idempotencyKey: key }));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "idempotency-conflict");
  });

  test("rejects a concurrent booking for an occupied slot", async () => {
    const parameters = {
      offeringId: "https://vendor.example/services/conflict",
      customerId: buyer.id,
      start: "2026-09-03T09:00:00Z",
      end: "2026-09-03T10:00:00Z"
    };
    const first = await post("/comcom/interactions", requestMessage("comcom.booking.create", "command", parameters, { idempotencyKey: `booking-${randomUUID()}` }));
    const second = await post("/comcom/interactions", requestMessage("comcom.booking.create", "command", parameters, { idempotencyKey: `booking-${randomUUID()}` }));
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "slot-conflict");
  });

  test("rejects expired work before business processing", async () => {
    const request = requestMessage("comcom.booking.create", "command", {
      offeringId: "https://vendor.example/services/expired",
      customerId: buyer.id,
      start: "2026-09-04T09:00:00Z",
      end: "2026-09-04T10:00:00Z"
    }, { idempotencyKey: `booking-${randomUUID()}`, expiresAt: "2020-01-01T00:00:00Z" });
    const response = await post("/comcom/interactions", request);
    assert.equal(response.status, 412);
    assert.equal(response.body.code, "message-expired");
  });

  test("rejects invalid capability payload before dispatch", async () => {
    const request = requestMessage("comcom.booking.create", "command", { customerId: buyer.id }, { idempotencyKey: `booking-${randomUUID()}` });
    const response = await post("/comcom/interactions", request);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid-message");
  });
});

describe("inbox filtering", () => {
  function announcement(topic, options = {}) {
    return requestMessage("comcom.announcement.receive", "event", {
      topic,
      subject: "Test announcement",
      content: "Structured business announcement."
    }, { id: options.id, idempotencyKey: options.idempotencyKey ?? `announcement-${randomUUID()}` });
  }

  test("returns accepted without promising storage", async () => {
    const response = await post("/comcom/inbox", announcement("supplier-update"));
    assert.equal(response.status, 202);
    assert.equal(response.body.payload.disposition, "accepted");
    assert.equal(protocol.validateMessage(response.body).valid, true);
  });

  test("returns discarded for a filtered topic", async () => {
    const response = await post("/comcom/inbox", announcement("blocked"));
    assert.equal(response.status, 202);
    assert.equal(response.body.payload.disposition, "discarded");
  });

  test("detects the same event under a new delivery key", async () => {
    const id = `urn:uuid:${randomUUID()}`;
    const first = await post("/comcom/inbox", announcement("supplier-update", { id, idempotencyKey: `announcement-${randomUUID()}` }));
    const duplicate = await post("/comcom/inbox", announcement("supplier-update", { id, idempotencyKey: `announcement-${randomUUID()}` }));
    assert.equal(first.body.payload.disposition, "accepted");
    assert.equal(duplicate.body.payload.disposition, "duplicate");
  });
});
