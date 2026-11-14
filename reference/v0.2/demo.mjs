import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDemoAuthenticator, createDemoResponderIdentity } from "./demo-auth.mjs";
import { createInteractionClient } from "./interaction-client.mjs";
import { createProtocolV02 } from "./protocol.mjs";
import { createComcomV02Server } from "./server.mjs";

const VENDOR = "https://vendor.example";
const BOOKING = { id: "comcom.booking.create", version: "0.2.0" };

const protocol = await createProtocolV02();
const app = await createComcomV02Server({ port: 0 });
await app.start();
const loopback = `http://127.0.0.1:${app.server.address().port}`;
console.log("Comcom v0.2 booking evaluation: HTTP loopback, mocked authentication; not a conformant production transport.");

// The reusable client performs discovery, request preparation, submission,
// and result validation. Only the mocked transport trust below is demo-specific:
// the credentials the buyer presents and the responder identity it trusts.
const client = createInteractionClient({
  protocol,
  developmentOrigins: { [VENDOR]: loopback },
  authenticate: createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [VENDOR] }),
  responderIdentity: createDemoResponderIdentity({ [VENDOR]: "https://vendor.example" })
});

function expectOutcome(result, outcome) {
  assert.equal(result.outcome, outcome, JSON.stringify(result));
  return result;
}

try {
  const discovery = await client.discover({ origin: VENDOR, capability: BOOKING });
  expectOutcome(discovery, "advertised");
  assert.equal(discovery.conformant, false, "loopback discovery must be flagged as non-conformant");
  console.log("PASS discovery and pinned-profile manifest validation");

  const example = JSON.parse(await readFile(new URL("../../examples/v0.2/booking-create.request.json", import.meta.url)));
  const input = (startOffsetMs, overrides = {}) => {
    const payload = structuredClone(example.payload);
    payload.parameters.booking.start = new Date(Date.now() + startOffsetMs).toISOString();
    payload.parameters.booking.end = new Date(Date.now() + startOffsetMs + 1_800_000).toISOString();
    Object.assign(payload.parameters.booking, overrides);
    return { principal: example.principal, sender: example.sender, agent: example.agent, authorization: example.authorization, payload };
  };

  const prepared = await client.prepare(discovery, input(86_400_000));
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const result = expectOutcome(await client.submit(prepared), "completed");
  assert.equal(result.status, 200);
  assert.equal(result.response.payload.status, "completed");
  console.log("PASS booking.create: HTTP 200, correlated and identity-bound result");

  const replay = expectOutcome(await client.submit(prepared), "completed");
  assert.equal(replay.status, 200);
  assert.equal(replay.raw, result.raw);
  console.log("PASS exact replay: identical response bytes");

  const conflicting = await client.prepare(discovery, {
    ...input(86_400_000, { start: prepared.request.payload.parameters.booking.start, end: prepared.request.payload.parameters.booking.end, providerId: "https://vendor.example/providers/another" }),
    idempotencyKey: prepared.request.idempotencyKey
  });
  assert.equal(conflicting.ok, true, JSON.stringify(conflicting));
  const conflict = expectOutcome(await client.submit(conflicting), "rejected");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.problem.code, "idempotency-conflict");
  console.log("PASS changed request with reused key: HTTP 409 idempotency-conflict");

  const asyncPrepared = await client.prepare(discovery, { ...input(172_800_000), executionMode: "asynchronous" });
  assert.equal(asyncPrepared.ok, true, JSON.stringify(asyncPrepared));
  const accepted = expectOutcome(await client.submit(asyncPrepared), "pending");
  assert.equal(accepted.status, 202);
  assert.equal(accepted.operation.state, "accepted");
  const completed = expectOutcome(await client.poll(asyncPrepared, accepted, { intervalMs: 25, timeoutMs: 5000 }), "completed");
  assert.equal(completed.operation.output.status, "completed");
  console.log("PASS asynchronous booking: HTTP 202 → polling → completed");
  console.log("Evaluation passed. No external business service was called.");
} finally {
  await app.close();
}
