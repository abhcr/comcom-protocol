import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createProtocolV02, semanticHash } from "../reference/v0.2/protocol.mjs";
import { createComcomV02Server } from "../reference/v0.2/server.mjs";
import { isPublicAddress, secureFetch } from "../reference/v0.2/secure-fetch.mjs";
import { parseStrictJson } from "../reference/v0.2/strict-json.mjs";

const root = resolve(import.meta.dirname, "..");
const port = 18788;
const origin = `http://127.0.0.1:${port}`;
let protocol;
let manifest;
let request;
let app;

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

function context(overrides = {}) {
  return {
    manifest,
    endpoint: { url: "https://vendor.example/comcom/interactions", method: "POST" },
    transport: { senderId: "https://buyer.example", scheme: "businessOAuth", scopes: ["booking:create"], roles: ["buyer"] },
    now: "2026-08-17T09:00:02Z",
    ...overrides
  };
}

before(async () => {
  protocol = await createProtocolV02();
  manifest = JSON.parse(await readFile(resolve(root, "examples/v0.2/vendor-manifest.json")));
  request = JSON.parse(await readFile(resolve(root, "examples/v0.2/booking-create.request.json")));
  app = await createComcomV02Server({ port });
  await app.start();
});

after(async () => app.close());

describe("v0.2 authored profiles", () => {
  test("preserves exactly 201 closed, draft capability profiles", async () => {
    assert.equal(protocol.capabilities.size, 201);
    const paths = (await walk(resolve(root, "profiles/v0.2"))).filter(path => path.endsWith("definition.json"));
    assert.equal(paths.length, 201);
    for (const path of paths) {
      const definition = JSON.parse(await readFile(path));
      assert.equal(definition.version, "0.2.0");
      assert.equal(definition.status, "draft");
      for (const name of ["input", "output", "resource"]) {
        const schema = JSON.parse(await readFile(resolve(path, `../schemas/${name}.schema.json`)));
        assert(!JSON.stringify(schema).includes('"additionalProperties":true'));
      }
    }
  });

  test("accepts every authored positive payload and rejects every authored negative payload", async () => {
    for (const capability of protocol.registry.capabilities) {
      const valid = JSON.parse(await readFile(resolve(root, capability.source, "examples/valid-request.json")));
      const invalid = JSON.parse(await readFile(resolve(root, capability.source, "examples/invalid-request.json"))).instance;
      const validate = protocol.ajv.getSchema(capability.schemas.input);
      assert.equal(validate(valid), true, `${capability.id} positive: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate(invalid), false, `${capability.id} negative`);
    }
  });
});

describe("v0.2 kernel validation", () => {
  test("validates the one-capability and initiator-only manifests", async () => {
    assert.equal(protocol.validateManifest(JSON.stringify(manifest)).valid, true);
    const initiator = await readFile(resolve(root, "examples/v0.2/initiator-manifest.json"));
    assert.equal(protocol.validateManifest(initiator).valid, true);
  });

  test("rejects duplicate keys before ordinary parsing", () => {
    assert.throws(() => parseStrictJson('{"kind":"command","kind":"event"}'), error => error.code === "duplicate-key");
  });

  test("rejects wrong kinds and sender spoofing before payload dispatch", () => {
    const wrongKind = { ...request, kind: "event" };
    assert.equal(protocol.validateRequest(JSON.stringify(wrongKind), context()).code, "message-kind-mismatch");
    assert.equal(protocol.validateRequest(JSON.stringify(request), context({ transport: { ...context().transport, senderId: "https://attacker.example" } })).code, "sender-identity-mismatch");
  });

  test("JCS idempotency ignores property order and retry metadata", () => {
    const reordered = {
      ...request,
      id: "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      issuedAt: "2026-08-17T09:00:01Z",
      agent: { id: "https://buyer.example/software/workflow", type: "workflow" },
      payload: { parameters: request.payload.parameters, capability: request.payload.capability }
    };
    assert.equal(semanticHash(request), semanticHash(reordered));
  });

  test("rejects unsafe address classes and unsafe schemes", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:192.168.1.1"]) assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress("8.8.8.8"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
    await assert.rejects(() => secureFetch("ftp://example.com/catalog"), error => error.code === "unsafe-scheme");
    await assert.rejects(() => secureFetch("https://example.com/catalog", { resolver: async () => [{ address: "10.0.0.1", family: 4 }] }), error => error.code === "unsafe-address");
  });
});

describe("v0.2 responder", () => {
  function liveMessage(key, hours = 1) {
    const value = structuredClone(request);
    value.id = `urn:uuid:${crypto.randomUUID()}`;
    value.idempotencyKey = key;
    value.issuedAt = new Date().toISOString();
    value.expiresAt = new Date(Date.now() + 60_000).toISOString();
    value.payload.parameters.booking.start = new Date(Date.now() + hours * 3_600_000).toISOString();
    value.payload.parameters.booking.end = new Date(Date.now() + (hours + .5) * 3_600_000).toISOString();
    return value;
  }

  async function post(message, prefer) {
    const response = await fetch(`${origin}/comcom/interactions`, {
      method: "POST",
      headers: {
        "content-type": "application/comcom+json",
        authorization: "Bearer test",
        "x-comcom-sender": "https://buyer.example",
        "x-comcom-scopes": "booking:create",
        ...(prefer ? { prefer } : {})
      },
      body: JSON.stringify(message)
    });
    return { status: response.status, body: await response.json() };
  }

  test("returns the exact stored status and envelope for a semantic replay", async () => {
    const firstMessage = liveMessage(`sync-${crypto.randomUUID()}`, 3);
    const first = await post(firstMessage);
    const retry = structuredClone(firstMessage);
    retry.id = `urn:uuid:${crypto.randomUUID()}`;
    retry.issuedAt = "2019-12-31T23:59:00Z";
    retry.expiresAt = "2020-01-01T00:00:00Z";
    retry.agent = { id: "https://buyer.example/software/retry", type: "workflow" };
    retry.payload = { parameters: retry.payload.parameters, capability: retry.payload.capability };
    const replay = await post(retry);
    assert.equal(first.status, 200);
    assert.equal(replay.status, first.status);
    assert.deepEqual(replay.body, first.body);
  });

  test("returns 409 when an idempotency tuple identifies different semantics", async () => {
    const firstMessage = liveMessage(`conflict-${crypto.randomUUID()}`, 5);
    assert.equal((await post(firstMessage)).status, 200);
    const changed = structuredClone(firstMessage);
    changed.payload.parameters.booking.providerId = "https://vendor.example/providers/other";
    const conflict = await post(changed);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "idempotency-conflict");
  });

  test("returns one operation ID for async acceptance, retry, and polling", async () => {
    const message = liveMessage(`async-${crypto.randomUUID()}`, 7);
    const accepted = await post(message, "respond-async");
    const retry = await post(message, "respond-async");
    assert.equal(accepted.status, 202);
    assert.deepEqual(retry.body, accepted.body);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    const operationId = accepted.body.payload.id.split("/").at(-1);
    const polled = await fetch(`${origin}/comcom/interactions/${operationId}`);
    const result = await polled.json();
    assert.equal(result.payload.state, "completed");
    assert.equal(result.correlationId, message.id);
    assert.equal(result.payload.output.status, "completed");
  });
});
