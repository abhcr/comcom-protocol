import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createProtocolV02 } from "../reference/v0.2/protocol.mjs";
import { createComcomV02Server } from "../reference/v0.2/server.mjs";

const root = resolve(import.meta.dirname, "..");
const serverPath = resolve(root, "reference/v0.2/mcp-server.mjs");
const ORIGIN = "https://vendor.example";
const BUYER = "https://buyer.example";
const BOOKING = { id: "comcom.booking.create", version: "0.2.0" };
const LEGACY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest";
const DISCOVERY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest";
const LINKSET = "application/linkset+json";
const MANIFEST = "application/vnd.comcom.manifest+json";
const MOCK_TOKEN = "demo-only-not-a-real-token";

let protocol;
let vendorManifest;
let example;
let booking;
let proxy;
let directory;
let configured;
let withoutIdentity;
// The routes the business origin serves; everything else goes to the booking responder.
let routes = {};
const proxyRequests = [];
const bookingRequests = [];
const posts = () => [...proxyRequests, ...bookingRequests].filter(entry => entry.startsWith("POST "));
// Every tool response, scanned for credentials at the end.
const responses = [];

const catalog = items => ({ linkset: [{ anchor: `${ORIGIN}/.well-known/api-catalog`, item: items }] });
const link = (path, profile = LEGACY_PROFILE) => ({ href: `${ORIGIN}${path}`, type: MANIFEST, profile });
const twoManifests = (second = vendorManifest) => ({
  "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/v0.2/manifest"), link("/comcom/v0.2/mirror", DISCOVERY_PROFILE)]) },
  "/comcom/v0.2/manifest": { type: MANIFEST, body: vendorManifest },
  "/comcom/v0.2/mirror": { type: MANIFEST, body: second }
});

// Writes a server-side configuration module: mocked demo transport, DNS forbidden.
async function writeConfig(name, { identities }) {
  const demoAuth = pathToFileURL(resolve(root, "reference/v0.2/demo-auth.mjs")).href;
  const settings = {
    sender: { id: BUYER, type: "organization" },
    developmentOrigins: { [ORIGIN]: `http://127.0.0.1:${proxy.address().port}` },
    auth: { senderId: BUYER, scopes: ["booking:create"], localOrigins: [ORIGIN] },
    identities,
    discovery: { deadlineMs: 1000 }
  };
  const path = resolve(directory, `${name}.config.mjs`);
  await writeFile(path, `import { createDemoAuthenticator, createDemoResponderIdentity } from ${JSON.stringify(demoAuth)};
const settings = ${JSON.stringify(settings)};
export default {
  sender: settings.sender,
  developmentOrigins: settings.developmentOrigins,
  authenticate: createDemoAuthenticator(settings.auth),
  ...(settings.identities ? { responderIdentity: createDemoResponderIdentity(settings.identities) } : {}),
  resolver: async host => { throw new Error("DNS lookup of " + host + " is forbidden in tests"); },
  discovery: settings.discovery
};
`);
  return path;
}

async function connect(configPath) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--config", configPath], stderr: "pipe" });
  const client = new Client({ name: "comcom-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options);
  responses.push(JSON.stringify(result));
  return result;
}

let slot = 0;
function payload(overrides = {}) {
  slot += 1;
  const value = structuredClone(example.payload);
  value.parameters.booking.start = new Date(Date.now() + slot * 7_200_000).toISOString();
  value.parameters.booking.end = new Date(Date.now() + slot * 7_200_000 + 1_800_000).toISOString();
  Object.assign(value.parameters.booking, overrides);
  return value;
}
const prepareArgs = (overrides = {}) => ({ origin: ORIGIN, capability: BOOKING, principal: example.principal, payload: payload(), ...overrides });

before(async () => {
  protocol = await createProtocolV02();
  vendorManifest = JSON.parse(await readFile(resolve(root, "examples/v0.2/vendor-manifest.json"), "utf8"));
  example = JSON.parse(await readFile(resolve(root, "examples/v0.2/booking-create.request.json"), "utf8"));
  booking = await createComcomV02Server({ port: 0 });
  await booking.start();
  booking.server.on("request", request => bookingRequests.push(`${request.method} ${request.url}`));
  proxy = createServer((request, response) => {
    proxyRequests.push(`${request.method} ${request.url}`);
    const route = routes[request.url];
    if (typeof route === "function") return route(request, response);
    if (route) {
      response.writeHead(route.status ?? 200, route.type ? { "content-type": route.type } : {});
      return response.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body));
    }
    const upstream = http.request({ host: "127.0.0.1", port: booking.server.address().port, method: request.method, path: request.url, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  directory = await mkdtemp(resolve(tmpdir(), "comcom-mcp-"));
  configured = await connect(await writeConfig("configured", { identities: { [ORIGIN]: ORIGIN } }));
  withoutIdentity = await connect(await writeConfig("without-identity", { identities: undefined }));
});

after(async () => {
  await configured?.close();
  await withoutIdentity?.close();
  proxy.closeAllConnections();
  await new Promise(resolveClose => proxy.close(resolveClose));
  await booking.close();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  routes = twoManifests();
  proxyRequests.length = 0;
  bookingRequests.length = 0;
});

function assertNoPosts() {
  assert.deepEqual(posts(), [], "no booking POST request may be sent");
}

describe("MCP server over stdio", () => {
  test("lists exactly two read-only tools whose inputs cannot carry identity, credentials, or transport settings", async () => {
    const { tools } = await configured.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["discover_capabilities", "prepare_request"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      for (const forbidden of ["sender", "agent", "responderIdentity", "authenticate", "headers", "credentials", "developmentOrigins", "resolver"]) {
        assert.equal(Object.hasOwn(tool.inputSchema.properties, forbidden), false, `${tool.name}.${forbidden}`);
      }
    }
  });

  test("discover_capabilities: multi-manifest discovery returns the contract and payload schema", async () => {
    const result = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING, { id: "comcom.booking.get", version: "0.2.0" }] });
    assert.equal(result.isError, undefined);
    const [create, get] = result.structuredContent.results;
    assert.equal(create.outcome, "advertised");
    assert.deepEqual(create.manifests.map(item => item.url), [`${ORIGIN}/comcom/v0.2/manifest`, `${ORIGIN}/comcom/v0.2/mirror`]);
    assert.deepEqual(create.forms.map(form => form.executionMode), ["synchronous", "asynchronous"]);
    assert.equal(create.payloadSchema.$id, create.declaration.inputSchema);
    assert.equal(create.identity.entityMatchesOrigin, true);
    assert.equal(create.conformant, false, "the loopback development transport is flagged");
    assert.equal(get.outcome, "not-advertised");
    assert.equal(get.code, "capability-not-advertised");
    assertNoPosts();
  });

  test("prepare_request: returns a validated preview using server-side identity and no credentials", async () => {
    const args = prepareArgs();
    const result = await call(configured, "prepare_request", args);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const { outcome, submitted, preview } = result.structuredContent;
    assert.equal(outcome, "prepared");
    assert.equal(submitted, false);
    assert.equal(preview.request.sender.id, BUYER, "the sender comes from server configuration");
    assert.equal(preview.request.recipient.id, ORIGIN);
    assert.deepEqual(preview.request.payload, args.payload);
    assert.equal(preview.trustedResponderIdentity, ORIGIN);
    assert.deepEqual(preview.authentication, { senderId: BUYER, schemes: ["businessOAuth"], scopes: ["booking:create"], requirements: [{ businessOAuth: ["booking:create"] }] });
    assert.deepEqual(preview.endpoint, { href: `${ORIGIN}/comcom/interactions`, method: "POST", contentType: "application/comcom+json", executionMode: "synchronous" });
    // The preview is exactly the validated body, and it validates independently.
    const body = JSON.stringify(preview.request);
    assert.equal(createHash("sha256").update(body).digest("hex"), preview.bodySha256);
    assert.equal(Buffer.byteLength(body), preview.bodyBytes);
    const verdict = protocol.validateRequest(body, {
      manifest: vendorManifest,
      endpoint: { url: preview.endpoint.href, method: preview.endpoint.method },
      transport: { senderId: BUYER, scheme: "businessOAuth", scopes: ["booking:create"] }
    });
    assert.equal(verdict.valid, true, JSON.stringify(verdict));
    assert.equal(JSON.stringify(result).includes("headers"), false);
    assertNoPosts();
  });

  test("prepare_request: asynchronous form preview includes its status template", async () => {
    const result = await call(configured, "prepare_request", prepareArgs({ executionMode: "asynchronous" }));
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.preview.endpoint.statusTemplate, `${ORIGIN}/comcom/interactions/{id}`);
    assertNoPosts();
  });
});

describe("bad inputs return clear errors and send nothing", () => {
  const cases = [
    ["an origin that is not HTTPS", "discover_capabilities", () => ({ origin: "http://vendor.example", capabilities: [BOOKING] }), "invalid-origin"],
    ["an origin with a path", "prepare_request", () => prepareArgs({ origin: `${ORIGIN}/comcom` }), "invalid-origin"],
    ["a capability version outside the pinned registry", "discover_capabilities", () => ({ origin: ORIGIN, capabilities: [{ id: BOOKING.id, version: "9.9.9" }] }), "unsupported-capability"],
    ["a payload that fails the capability schema", "prepare_request", () => prepareArgs({ payload: payload({ start: "tomorrow morning" }) }), "schema-invalid"],
    ["an unknown principal type", "prepare_request", () => prepareArgs({ principal: { id: "https://buyer.example/customers/1", type: "robot" } }), /Input validation error/],
    ["an empty capability list", "discover_capabilities", () => ({ origin: ORIGIN, capabilities: [] }), /Input validation error/],
    ["a missing payload", "prepare_request", () => { const args = prepareArgs(); delete args.payload; return args; }, /Input validation error/]
  ];
  for (const [name, tool, args, expected] of cases) {
    test(`${tool}: ${name}`, async () => {
      const result = await call(configured, tool, args());
      assert.equal(result.isError, true, JSON.stringify(result));
      if (expected instanceof RegExp) assert.match(result.content[0].text, expected);
      else assert.equal(result.structuredContent.code ?? result.structuredContent.results?.[0]?.code, expected, JSON.stringify(result.structuredContent));
      assertNoPosts();
    });
  }

  test("callers cannot override server-side identity, credentials, or transport settings", async () => {
    for (const [key, value] of Object.entries({
      sender: { id: "https://attacker.example", type: "organization" },
      responderIdentity: "https://attacker.example",
      headers: { authorization: "Bearer stolen" },
      authenticate: "anything",
      developmentOrigins: { [ORIGIN]: "http://127.0.0.1:1" },
      agent: { id: "https://attacker.example/agent", type: "ai" }
    })) {
      const result = await call(configured, "prepare_request", { ...prepareArgs(), [key]: value });
      assert.equal(result.isError, true, key);
      assert.match(result.content[0].text, new RegExp(`Unrecognized key.*${key}`), key);
    }
    const unaffected = await call(configured, "prepare_request", prepareArgs());
    assert.equal(unaffected.structuredContent.preview.request.sender.id, BUYER);
    assert.equal(unaffected.structuredContent.preview.trustedResponderIdentity, ORIGIN);
    assertNoPosts();
  });
});

describe("trusted responder identity", () => {
  test("missing server-side identity: discovery still reports, preparation is refused", async () => {
    const discovered = await call(withoutIdentity, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    assert.equal(discovered.structuredContent.results[0].outcome, "advertised", "discovery identity stays informational");
    const result = await call(withoutIdentity, "prepare_request", prepareArgs());
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.outcome, "not-prepared");
    assert.equal(result.structuredContent.submitted, false);
    assert.equal(result.structuredContent.code, "responder-identity-unavailable");
    assertNoPosts();
  });

  test("a forged manifest identity is refused even with a configured trusted identity", async () => {
    const forged = structuredClone(vendorManifest);
    forged.entity = { id: "https://bank.example", type: "organization", name: "Unrelated Bank" };
    routes = { ...twoManifests(), "/comcom/v0.2/manifest": { type: MANIFEST, body: forged }, "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/v0.2/manifest")]) } };
    const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    assert.equal(discovered.structuredContent.results[0].identity.entityMatchesOrigin, false);
    const result = await call(configured, "prepare_request", prepareArgs());
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "responder-identity-mismatch");
    assertNoPosts();
  });
});

describe("unclear discovery", () => {
  const conflicting = () => {
    const manifest = structuredClone(vendorManifest);
    manifest.securitySchemes.partnerKey = { type: "apiKey", name: "x-partner-key", in: "header" };
    for (const form of manifest.capabilities[0].forms) form.security = [{ partnerKey: [] }];
    return manifest;
  };

  test("ambiguous manifests: discovery lists every match, preparation is refused", async () => {
    routes = twoManifests(conflicting());
    const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    const [result] = discovered.structuredContent.results;
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.distinctContracts, 2);
    assert.equal(result.matches.length, 2);
    const prepared = await call(configured, "prepare_request", prepareArgs());
    assert.equal(prepared.isError, true);
    assert.equal(prepared.structuredContent.stage, "discovery");
    assert.equal(prepared.structuredContent.code, "ambiguous-advertisement");
    assertNoPosts();
  });

  test("one failed manifest: no conclusion and no preparation", async () => {
    routes = { ...twoManifests(), "/comcom/v0.2/mirror": { type: MANIFEST, body: "{}" } };
    const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    const [result] = discovered.structuredContent.results;
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.failedManifest, { url: `${ORIGIN}/comcom/v0.2/mirror`, profile: DISCOVERY_PROFILE });
    const prepared = await call(configured, "prepare_request", prepareArgs());
    assert.equal(prepared.isError, true);
    assert.equal(prepared.structuredContent.code, "schema-invalid");
    assertNoPosts();
  });
});

describe("stuck requests and timeouts", () => {
  test("a catalog that never answers ends at the server's discovery deadline", { timeout: 10000 }, async () => {
    routes = { "/.well-known/api-catalog": () => {} };
    const started = performance.now();
    const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    assert(performance.now() - started < 5000);
    const [result] = discovered.structuredContent.results;
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    const prepared = await call(configured, "prepare_request", prepareArgs());
    assert.equal(prepared.isError, true);
    assert.equal(prepared.structuredContent.code, "discovery-deadline-exceeded");
    assertNoPosts();
  });

  test("a manifest that stalls mid-response ends at the deadline with the manifest unchecked", { timeout: 10000 }, async () => {
    routes = {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/v0.2/manifest")]) },
      "/comcom/v0.2/manifest": (request, response) => {
        response.writeHead(200, { "content-type": MANIFEST });
        response.write('{"protocolVersions": ["0.2"], "entity": ');
      }
    };
    const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    const [result] = discovered.structuredContent.results;
    assert.equal(result.code, "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "manifest", url: `${ORIGIN}/comcom/v0.2/manifest`, profile: LEGACY_PROFILE }]);
    assertNoPosts();
  });

  test("an MCP client timeout does not disturb the server, which keeps serving", { timeout: 10000 }, async () => {
    routes = { "/.well-known/api-catalog": () => {} };
    await assert.rejects(
      configured.callTool({ name: "prepare_request", arguments: prepareArgs() }, undefined, { timeout: 200 }),
      error => error instanceof McpError && error.code === ErrorCode.RequestTimeout
    );
    routes = twoManifests();
    const result = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
    assert.equal(result.structuredContent.results[0].outcome, "advertised");
    // Let the abandoned call reach its deadline, then confirm it sent nothing.
    await new Promise(resolveWait => setTimeout(resolveWait, 1200));
    assertNoPosts();
  });
});

describe("incomplete discovery exposes no partial matches or contract", () => {
  // Keys that would describe a match, a contract, or a conclusion.
  const FORBIDDEN_KEYS = new Set(["matches", "forms", "declaration", "securitySchemes", "payloadSchema", "serviceOrigins", "limits", "entity", "roles", "identity", "contactUrl", "preview", "distinctContracts"]);
  const FORBIDDEN_VALUES = new Set(["advertised", "capability-advertised", "ambiguous", "not-advertised", "prepared"]);
  function scan(value, path = "$", found = []) {
    if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`, found));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`);
        scan(item, `${path}.${key}`, found);
      }
    } else if (FORBIDDEN_VALUES.has(value)) found.push(`${path} = ${value}`);
    return found;
  }

  const advertising = () => ({ type: MANIFEST, body: vendorManifest });
  const scenarios = [
    ["an advertising manifest beside an invalid one", () => ({ "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/a"), link("/b")]) }, "/a": advertising(), "/b": { type: MANIFEST, body: "{}" } }), "schema-invalid"],
    ["an advertising manifest beside an HTTP 500", () => ({ "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/a"), link("/b")]) }, "/a": advertising(), "/b": { status: 500, type: "text/plain", body: "" } }), "manifest-http-status"],
    ["an advertising manifest, then a deadline on the next", () => ({ "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/a"), link("/b")]) }, "/a": advertising(), "/b": () => {} }), "discovery-deadline-exceeded"],
    ["a catalog that never answers", () => ({ "/.well-known/api-catalog": () => {} }), "discovery-deadline-exceeded"]
  ];

  for (const [name, makeRoutes, code] of scenarios) {
    test(name, { timeout: 10000 }, async () => {
      routes = makeRoutes();
      const discovered = await call(configured, "discover_capabilities", { origin: ORIGIN, capabilities: [BOOKING] });
      const [result] = discovered.structuredContent.results;
      assert.equal(result.outcome, "failed");
      assert.equal(result.code, code);
      assert.deepEqual(scan(discovered.structuredContent), [], "discover_capabilities");
      const prepared = await call(configured, "prepare_request", prepareArgs());
      assert.equal(prepared.isError, true);
      assert.equal(prepared.structuredContent.code, code);
      assert.deepEqual(scan(prepared.structuredContent), [], "prepare_request");
      // The text content carries the same JSON, so it is equally clean.
      assert.deepEqual(scan(JSON.parse(prepared.content[0].text)), []);
      assertNoPosts();
    });
  }
});

describe("credentials and the runnable example", () => {
  test("no tool response contained credential material", () => {
    assert(responses.length >= 20, `scanned ${responses.length} responses`);
    for (const response of responses) {
      assert.equal(response.includes(MOCK_TOKEN), false);
      assert.equal(/Bearer /.test(response), false);
      assert.equal(/x-comcom-(sender|scopes)/i.test(response), false);
    }
  });

  test("npm run mcp:example completes without an AI model and sends no booking", { timeout: 30000 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(root, "reference/v0.2/mcp-example.mjs")], { encoding: "utf8" });
    for (const line of ["PASS tools/list", "PASS discover_capabilities", "PASS prepare_request", "PASS no booking request was sent"]) assert(stdout.includes(line), line);
  });
});
