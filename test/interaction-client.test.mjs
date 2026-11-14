import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http, { createServer } from "node:http";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";
import { createDemoAuthenticator, createDemoResponderIdentity } from "../reference/v0.2/demo-auth.mjs";
import { createInteractionClient } from "../reference/v0.2/interaction-client.mjs";
import { createProtocolV02 } from "../reference/v0.2/protocol.mjs";
import { createComcomV02Server } from "../reference/v0.2/server.mjs";

const root = resolve(import.meta.dirname, "..");
const ORIGIN = "https://vendor.example";
const BOOKING = { id: "comcom.booking.create", version: "0.2.0" };
const LEGACY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest";
const DISCOVERY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest";
const LINKSET = "application/linkset+json";
const MANIFEST = "application/vnd.comcom.manifest+json";

let resolverCalls = 0;
const forbiddenResolver = async host => {
  resolverCalls += 1;
  throw new Error(`DNS lookup of ${host} is forbidden in tests`);
};

let protocol;
let vendorManifest;
let example;
let booking;
// Every request the real booking responder receives.
const bookingRequests = [];
const bookingPosts = () => bookingRequests.filter(entry => entry.startsWith("POST "));

before(async () => {
  protocol = await createProtocolV02();
  vendorManifest = JSON.parse(await readFile(resolve(root, "examples/v0.2/vendor-manifest.json"), "utf8"));
  example = JSON.parse(await readFile(resolve(root, "examples/v0.2/booking-create.request.json"), "utf8"));
  booking = await createComcomV02Server({ port: 0 });
  await booking.start();
  booking.server.on("request", request => bookingRequests.push(`${request.method} ${request.url}`));
});
after(async () => {
  await booking.close();
  assert.equal(resolverCalls, 0, "no test may perform DNS resolution");
});
beforeEach(() => { bookingRequests.length = 0; });

const catalog = items => ({ linkset: [{ anchor: `${ORIGIN}/.well-known/api-catalog`, item: items }] });
const link = (path, profile = LEGACY_PROFILE) => ({ href: `${ORIGIN}${path}`, type: MANIFEST, profile });

// The business origin for a test: serves `routes` (catalog and manifests) and
// forwards everything else to the real booking responder. `intercept` can
// answer submissions instead, to simulate a misbehaving responder.
async function business(t, routes, { intercept } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const route = routes[request.url];
    if (typeof route === "function") return route(request, response);
    if (route) {
      response.writeHead(route.status ?? 200, route.type ? { "content-type": route.type } : {});
      return response.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body));
    }
    if (intercept) return intercept(request, response);
    const upstream = http.request({ host: "127.0.0.1", port: booking.server.address().port, method: request.method, path: request.url, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(upstream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolveClose => {
    server.closeAllConnections();
    server.close(resolveClose);
  }));
  return { requests, posts: () => requests.filter(entry => entry.startsWith("POST ")), developmentOrigins: { [ORIGIN]: `http://127.0.0.1:${server.address().port}` } };
}

function client(developmentOrigins, overrides = {}) {
  return createInteractionClient({
    protocol,
    developmentOrigins,
    resolver: forbiddenResolver,
    authenticate: createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [ORIGIN] }),
    responderIdentity: createDemoResponderIdentity({ [ORIGIN]: ORIGIN }),
    ...overrides
  });
}

// Booking input with a slot no other test uses.
let slot = 0;
function input(overrides = {}) {
  slot += 1;
  const payload = structuredClone(example.payload);
  payload.parameters.booking.start = new Date(Date.now() + slot * 7_200_000).toISOString();
  payload.parameters.booking.end = new Date(Date.now() + slot * 7_200_000 + 1_800_000).toISOString();
  return { principal: example.principal, sender: example.sender, agent: example.agent, authorization: example.authorization, payload, ...overrides };
}

const twoManifests = (second = vendorManifest) => ({
  "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/v0.2/manifest"), link("/comcom/v0.2/mirror", DISCOVERY_PROFILE)]) },
  "/comcom/v0.2/manifest": { type: MANIFEST, body: vendorManifest },
  "/comcom/v0.2/mirror": { type: MANIFEST, body: second }
});

describe("multi-manifest discovery leads to a validated booking", () => {
  test("synchronous booking", async t => {
    const fixture = await business(t, twoManifests());
    const result = await client(fixture.developmentOrigins).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(result.stage, "submit");
    assert.equal(result.submitted, true);
    assert.equal(result.status, 200);
    assert.equal(result.discovery.outcome, "advertised");
    assert.deepEqual(result.discovery.matches.map(match => match.manifest.url), [`${ORIGIN}/comcom/v0.2/manifest`, `${ORIGIN}/comcom/v0.2/mirror`]);
    assert.equal(result.response.correlationId, result.request.id);
    assert.equal(result.response.sender.id, ORIGIN);
    assert.equal(result.response.payload.status, "completed");
    assert.equal(result.response.payload.resource.offeringId, result.request.payload.parameters.booking.offeringId);
    assert.deepEqual(fixture.posts(), ["POST /comcom/interactions"]);
    assert.deepEqual(bookingPosts(), ["POST /comcom/interactions"]);
    // Identity is reported, not enforced.
    assert.deepEqual(result.discovery.identity, { entityId: ORIGIN, entityMatchesOrigin: true, externalFormOrigins: [] });
    // Plain JSON, so an application or a future MCP adapter can return it as is.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  test("asynchronous booking completes through polling", async t => {
    const fixture = await business(t, twoManifests());
    const result = await client(fixture.developmentOrigins).interact({
      origin: ORIGIN, capability: BOOKING, input: input({ executionMode: "asynchronous" }), poll: { intervalMs: 20, timeoutMs: 5000 }
    });
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(result.stage, "poll");
    assert.equal(result.operation.state, "completed");
    assert.equal(result.operation.originalCorrelationId, result.request.id);
    assert.equal(result.operation.output.status, "completed");
    assert.deepEqual(fixture.posts(), ["POST /comcom/interactions"]);
    assert(fixture.requests.some(entry => /^GET \/comcom\/interactions\/[0-9a-f-]+$/.test(entry)), "the declared status URL was polled");
  });

  test("replay returns identical bytes and a changed request with the same key is a validated 409", async t => {
    const fixture = await business(t, twoManifests());
    const bookingClient = client(fixture.developmentOrigins);
    const discovery = await bookingClient.discover({ origin: ORIGIN, capability: BOOKING });
    const prepared = await bookingClient.prepare(discovery, input());
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const first = await bookingClient.submit(prepared);
    const replay = await bookingClient.submit(prepared);
    assert.equal(first.outcome, "completed");
    assert.equal(replay.raw, first.raw);

    const changed = input({ idempotencyKey: prepared.request.idempotencyKey });
    changed.payload.parameters.booking = { ...prepared.request.payload.parameters.booking, providerId: "https://vendor.example/providers/another" };
    const conflict = await bookingClient.submit(await bookingClient.prepare(discovery, changed));
    assert.equal(conflict.outcome, "rejected");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.problem.code, "idempotency-conflict");
    assert.equal(bookingPosts().length, 3);
  });
});

describe("no booking is submitted unless discovery and preparation succeed", () => {
  const conflicting = () => {
    const manifest = structuredClone(vendorManifest);
    manifest.securitySchemes.partnerKey = { type: "apiKey", name: "x-partner-key", in: "header" };
    for (const form of manifest.capabilities[0].forms) form.security = [{ partnerKey: [] }];
    return manifest;
  };

  const discoveryCases = [
    ["ambiguous discovery", () => twoManifests(conflicting()), {}, "ambiguous", "ambiguous-advertisement"],
    ["a failed manifest alongside a valid one", () => ({ ...twoManifests(), "/comcom/v0.2/mirror": { type: MANIFEST, body: "{}" } }), {}, "failed", "schema-invalid"],
    ["an unpublished catalog", () => ({ "/.well-known/api-catalog": { status: 404, type: "text/plain", body: "" } }), {}, "failed", "discovery-http-status"],
    ["a discovery deadline", () => ({ "/.well-known/api-catalog": () => {} }), { discovery: { deadlineMs: 200 } }, "failed", "discovery-deadline-exceeded"],
    ["a capability the business does not advertise", () => twoManifests(), { capability: { id: "comcom.booking.get", version: "0.2.0" } }, "not-advertised", "capability-not-advertised"]
  ];

  for (const [name, routes, options, discoveryOutcome, code] of discoveryCases) {
    test(`${name}: zero booking POST requests`, { timeout: 5000 }, async t => {
      const fixture = await business(t, routes());
      const { capability = BOOKING, ...clientOptions } = options;
      const result = await client(fixture.developmentOrigins, clientOptions).interact({ origin: ORIGIN, capability, input: input() });
      assert.equal(result.outcome, "not-submitted", JSON.stringify(result));
      assert.equal(result.stage, "discovery");
      assert.equal(result.submitted, false);
      assert.equal(result.discovery.outcome, discoveryOutcome);
      assert.equal(result.code, code);
      assert.equal(result.response, undefined);
      assert.deepEqual(fixture.posts(), []);
      assert.deepEqual(bookingPosts(), []);
    });
  }

  const prepareCases = [
    // Natural language is never interpreted; it simply fails the date-time format.
    ["a payload that violates the capability input schema", {}, () => { const value = input(); value.payload.parameters.booking.start = "tomorrow morning"; return value; }, "schema-invalid"],
    ["credentials that satisfy no security alternative", { authenticate: createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:read"], localOrigins: [ORIGIN] }) }, () => input(), "credentials-unavailable"],
    ["a sender that differs from the authenticated transport", {}, () => input({ sender: { id: "https://someone-else.example", type: "organization" } }), "sender-identity-mismatch"],
    ["claimed scopes that do not meet the form requirement", { authenticate: async () => ({ senderId: "https://buyer.example", scheme: "businessOAuth", scopes: [], headers: {} }) }, () => input(), "security-requirement-unsatisfied"]
  ];

  for (const [name, options, makeInput, code] of prepareCases) {
    test(`${name}: zero booking POST requests`, async t => {
      const fixture = await business(t, twoManifests());
      const result = await client(fixture.developmentOrigins, options).interact({ origin: ORIGIN, capability: BOOKING, input: makeInput() });
      assert.equal(result.outcome, "not-submitted", JSON.stringify(result));
      assert.equal(result.stage, "prepare");
      assert.equal(result.submitted, false);
      assert.equal(result.code, code);
      assert.deepEqual(fixture.posts(), []);
      assert.deepEqual(bookingPosts(), []);
    });
  }

  test("the mocked demo token is never attached to a non-local form", async () => {
    const authenticate = createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [ORIGIN] });
    const form = { ...vendorManifest.capabilities[0].forms[0], href: "https://elsewhere.example/comcom/interactions" };
    assert.equal(await authenticate({ form, securitySchemes: vendorManifest.securitySchemes }), null);
  });
});

describe("trusted responder identity is required before submission", () => {
  const missing = [
    ["no responderIdentity hook", { responderIdentity: undefined }],
    ["a hook with no identity for the origin", { responderIdentity: createDemoResponderIdentity({}) }],
    ["a hook returning something that is not an identity URI", { responderIdentity: async () => "vendor" }]
  ];
  for (const [name, options] of missing) {
    test(`${name}: not submitted, zero booking POST requests`, async t => {
      const fixture = await business(t, twoManifests());
      const result = await client(fixture.developmentOrigins, options).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
      assert.equal(result.outcome, "not-submitted", JSON.stringify(result));
      assert.equal(result.stage, "prepare");
      assert.equal(result.submitted, false);
      assert.equal(result.phase, "identity");
      assert.equal(result.code, "responder-identity-unavailable");
      assert.equal(result.discovery.outcome, "advertised", "discovery itself is unaffected");
      assert.deepEqual(fixture.posts(), []);
      assert.deepEqual(bookingPosts(), []);
    });
  }

  test("a forged manifest identity: discovery reports it, the client submits nothing and requests no credentials", async t => {
    const forged = structuredClone(vendorManifest);
    forged.entity = { id: "https://bank.example", type: "organization", name: "Unrelated Bank" };
    const fixture = await business(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/v0.2/manifest")]) },
      "/comcom/v0.2/manifest": { type: MANIFEST, body: forged }
    });
    let credentialRequests = 0;
    const authenticate = createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [ORIGIN] });
    const result = await client(fixture.developmentOrigins, { authenticate: async args => { credentialRequests += 1; return authenticate(args); } })
      .interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    // Discovery identity stays informational.
    assert.equal(result.discovery.outcome, "advertised");
    assert.equal(result.discovery.identity.entityMatchesOrigin, false);
    assert.equal(result.discovery.entity.id, "https://bank.example");
    // The transaction is refused because the trusted identity does not confirm the claim.
    assert.equal(result.outcome, "not-submitted");
    assert.equal(result.submitted, false);
    assert.equal(result.code, "responder-identity-mismatch");
    assert.equal(credentialRequests, 0, "no credentials are obtained for an unconfirmed responder");
    assert.deepEqual(fixture.posts(), []);
    assert.deepEqual(bookingPosts(), []);
  });

  test("a valid trusted identity: confirmed before credentials, from the endpoint only, and bound to the result", async t => {
    const fixture = await business(t, twoManifests());
    const calls = [];
    const trust = createDemoResponderIdentity({ [ORIGIN]: ORIGIN });
    const authenticate = createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [ORIGIN] });
    const result = await client(fixture.developmentOrigins, {
      responderIdentity: async args => { calls.push(["identity", Object.keys(args).sort()]); return trust(args); },
      authenticate: async args => { calls.push(["credentials"]); return authenticate(args); }
    }).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(result.submitted, true);
    assert.deepEqual(calls, [["identity", ["capability", "form", "origin"]], ["credentials"]], "the hook never receives discovered documents");
    assert.equal(result.request.recipient.id, ORIGIN);
    assert.equal(result.response.sender.id, ORIGIN);
    assert.deepEqual(bookingPosts(), ["POST /comcom/interactions"]);
  });
});

describe("responses are validated before they are trusted", () => {
  // Answers a submission with a crafted envelope derived from the request.
  function respondWith(status, build) {
    return async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks));
      response.writeHead(status, { "content-type": "application/comcom+json" });
      response.end(JSON.stringify(build(message)));
    };
  }
  const envelope = (message, payload, sender = message.recipient) => ({
    protocolVersion: "0.2", id: `urn:uuid:${crypto.randomUUID()}`, kind: "result", capability: message.capability,
    principal: message.principal, sender, recipient: message.sender, issuedAt: new Date().toISOString(), correlationId: message.id, payload
  });

  test("a result claiming a different responder is an error", async t => {
    const fixture = await business(t, twoManifests(), {
      intercept: respondWith(200, message => envelope(message, { status: "completed" }, { id: "https://attacker.example", type: "organization" }))
    });
    const result = await client(fixture.developmentOrigins).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "error");
    assert.equal(result.code, "recipient-mismatch");
    assert.equal(result.response, undefined);
  });

  test("a transport that authenticates a different server than the manifest claims submits nothing", async t => {
    const fixture = await business(t, twoManifests());
    const result = await client(fixture.developmentOrigins, { responderIdentity: async () => "https://authenticated-server.example" })
      .interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "not-submitted");
    assert.equal(result.code, "responder-identity-mismatch");
    assert.equal(result.submitted, false);
    assert.deepEqual(bookingPosts(), []);
  });

  test("a redirected submission is not followed, so the booking is never re-sent", async t => {
    const fixture = await business(t, twoManifests(), {
      intercept: (request, response) => { response.writeHead(307, { location: "/comcom/elsewhere" }); response.end(); }
    });
    const result = await client(fixture.developmentOrigins).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "error");
    assert.equal(result.code, "redirect-limit");
    assert.deepEqual(fixture.posts(), ["POST /comcom/interactions"]);
  });

  test("an error response that is not a valid problem for its status is an error, not a rejection", async t => {
    const fixture = await business(t, twoManifests(), {
      intercept: (request, response) => {
        response.writeHead(409, { "content-type": "application/problem+json" });
        response.end(JSON.stringify({ type: "https://vendor.example/problems/x", title: "X", status: 400, phase: "payload", code: "x" }));
      }
    });
    const result = await client(fixture.developmentOrigins).interact({ origin: ORIGIN, capability: BOOKING, input: input() });
    assert.equal(result.outcome, "error");
    assert.equal(result.code, "invalid-problem");
  });

  test("an operation that does not correlate to the request is an error", async t => {
    const fixture = await business(t, twoManifests(), {
      intercept: respondWith(202, message => envelope(message, {
        id: "https://vendor.example/operations/1", statusUrl: "https://vendor.example/comcom/interactions/1", state: "accepted",
        acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), originalCorrelationId: "urn:uuid:00000000-0000-4000-8000-000000000000"
      }))
    });
    const result = await client(fixture.developmentOrigins).interact({
      origin: ORIGIN, capability: BOOKING, input: input({ executionMode: "asynchronous" }), poll: { intervalMs: 10, timeoutMs: 500 }
    });
    assert.equal(result.outcome, "error");
    assert.equal(result.code, "correlation-mismatch");
  });

  test("an operation whose status URL is outside the declared template is not polled", async t => {
    const fixture = await business(t, twoManifests(), {
      intercept: respondWith(202, message => envelope(message, {
        id: "https://vendor.example/operations/1", statusUrl: "https://attacker.example/steal", state: "accepted",
        acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), originalCorrelationId: message.id
      }))
    });
    const result = await client(fixture.developmentOrigins).interact({
      origin: ORIGIN, capability: BOOKING, input: input({ executionMode: "asynchronous" }), poll: { intervalMs: 10, timeoutMs: 500 }
    });
    assert.equal(result.outcome, "error");
    assert.equal(result.code, "status-url-mismatch");
    assert.deepEqual(fixture.requests.filter(entry => entry.startsWith("GET ") && !/well-known|manifest|mirror/.test(entry)), []);
  });
});

describe("separation of concerns", () => {
  test("the interaction client imports no mocked authentication and no MCP or model dependency", async () => {
    const source = await readFile(resolve(root, "reference/v0.2/interaction-client.mjs"), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]).sort();
    assert.deepEqual(imports, ["./discover.mjs", "./protocol.mjs", "./secure-fetch.mjs", "./strict-json.mjs", "node:crypto"]);
  });

  test("the booking demo passes all evaluation checks through the client", { timeout: 30000 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(root, "reference/v0.2/demo.mjs")], { encoding: "utf8" });
    for (const line of [
      "PASS discovery and pinned-profile manifest validation",
      "PASS booking.create: HTTP 200, correlated and identity-bound result",
      "PASS exact replay: identical response bytes",
      "PASS changed request with reused key: HTTP 409 idempotency-conflict",
      "PASS asynchronous booking: HTTP 202 → polling → completed",
      "Evaluation passed. No external business service was called."
    ]) assert(stdout.includes(line), line);
  });
});
