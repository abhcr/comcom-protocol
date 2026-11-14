import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_MAX_MANIFESTS, discoverCapability } from "../reference/v0.2/discover.mjs";
import { createProtocolV02 } from "../reference/v0.2/protocol.mjs";
import { createComcomV02Server } from "../reference/v0.2/server.mjs";

const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "reference/v0.2/discover-cli.mjs");
const readJson = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const LEGACY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest";
const DISCOVERY_PROFILE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest";
const LINKSET = "application/linkset+json";
const MANIFEST = "application/vnd.comcom.manifest+json";
const ORIGIN = "https://vendor.example";
const CREATE = { id: "comcom.booking.create", version: "0.2.0" };

// Every retrieval in this file targets a loopback IP literal, so DNS must never
// be consulted. A resolver call means a request escaped to the network.
let resolverCalls = 0;
const forbiddenResolver = async host => {
  resolverCalls += 1;
  throw new Error(`DNS lookup of ${host} is forbidden in tests`);
};

let protocol;
let vendorManifest;
let publisherManifest;

before(async () => {
  protocol = await createProtocolV02();
  vendorManifest = await readJson("examples/v0.2/vendor-manifest.json");
  publisherManifest = await readJson("examples/v0.2.1/publisher-manifest.json");
});

after(() => assert.equal(resolverCalls, 0, "no test may perform DNS resolution"));

function catalog(items, anchor = `${ORIGIN}/.well-known/api-catalog`) {
  return { linkset: [{ anchor, item: items }] };
}

function link(path, profile = LEGACY_PROFILE) {
  return { href: `${ORIGIN}${path}`, type: MANIFEST, profile };
}

// Starts a loopback fixture. `routes` maps a path to a handler or to
// { status, type, body, headers }. Unknown paths return 404.
async function fixture(t, routes) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    const route = routes[request.url];
    if (typeof route === "function") return route(request, response);
    if (!route) {
      response.writeHead(404);
      return response.end();
    }
    const body = typeof route.body === "string" || Buffer.isBuffer(route.body) ? route.body : JSON.stringify(route.body);
    response.writeHead(route.status ?? 200, { ...(route.type ? { "content-type": route.type } : {}), ...route.headers });
    response.end(body);
  });
  const connections = [];
  server.on("connection", () => connections.push(hits.length));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolveClose => {
    server.closeAllConnections();
    server.close(resolveClose);
  }));
  return { hits, connections, developmentOrigins: { [ORIGIN]: `http://127.0.0.1:${server.address().port}` } };
}

// A route that never answers: the only way out is a timeout or the deadline.
const hang = () => {};

// A route answered after `ms` milliseconds (unless the client disconnects first).
function delayed(ms, { status = 200, type, body }) {
  return (request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(status, type ? { "content-type": type } : {});
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    }, ms);
    request.on("close", () => clearTimeout(timer));
  };
}

function discover(developmentOrigins, overrides = {}) {
  return discoverCapability({ origin: ORIGIN, capability: CREATE, protocol, resolver: forbiddenResolver, developmentOrigins, ...overrides });
}

function assertFailed(result, phase, code) {
  assert.equal(result.outcome, "failed", JSON.stringify(result));
  assert.equal(result.advertised, false);
  assert.equal(result.phase, phase, JSON.stringify(result));
  assert.equal(result.code, code, JSON.stringify(result));
  assert(result.errors.length > 0);
}

describe("discovery against the reference booking responder", () => {
  let app;
  let developmentOrigins;

  before(async () => {
    app = await createComcomV02Server({ port: 0 });
    await app.start();
    developmentOrigins = { [ORIGIN]: `http://127.0.0.1:${app.server.address().port}` };
  });
  after(() => app.close());

  test("reports an advertised capability with its forms and security requirements", async () => {
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "advertised");
    assert.equal(result.advertised, true);
    assert.equal(result.code, "capability-advertised");
    assert.deepEqual(result.errors, []);
    assert.equal(result.conformant, false, "loopback development transport must be flagged");
    assert.deepEqual(result.capability, {
      id: "comcom.booking.create", version: "0.2.0", profile: "transactions.booking",
      title: "Booking Create", requestKind: "command", maturity: "draft"
    });
    assert.equal(result.source.catalogUrl, `${ORIGIN}/.well-known/api-catalog`);
    assert.deepEqual(result.source.manifests.map(({ url, profile, outcome }) => ({ url, profile, outcome })), [
      { url: `${ORIGIN}/comcom/v0.2/manifest`, profile: LEGACY_PROFILE, outcome: "advertised" }
    ]);
    assert.deepEqual(result.entity, vendorManifest.entity);
    assert.deepEqual(result.serviceOrigins, [ORIGIN]);
    assert.deepEqual(result.declaration.kinds, ["command"]);
    assert.deepEqual(result.declaration.executionModes, ["synchronous", "asynchronous"]);
    assert.equal(result.declaration.anonymousCommand, false);
    assert.deepEqual(result.forms.map(form => [form.executionMode, form.method, form.href, form.statusTemplate]), [
      ["synchronous", "POST", `${ORIGIN}/comcom/interactions`, undefined],
      ["asynchronous", "POST", `${ORIGIN}/comcom/interactions`, `${ORIGIN}/comcom/interactions/{id}`]
    ]);
    for (const form of result.forms) {
      assert.deepEqual(form.security, [{ businessOAuth: ["booking:create"] }]);
      assert.equal(form.anonymousAllowed, false);
    }
    assert.deepEqual(result.securitySchemes, { businessOAuth: vendorManifest.securitySchemes.businessOAuth });
    assert.deepEqual(result.identity, { entityId: ORIGIN, entityMatchesOrigin: true, externalFormOrigins: [] });
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0].manifest, { url: `${ORIGIN}/comcom/v0.2/manifest`, profile: LEGACY_PROFILE, crossOrigin: false });
    assert.deepEqual(result.matches[0].forms, result.forms);
  });

  test("the discovered form and security are sufficient for request validation", async () => {
    const result = await discover(developmentOrigins);
    const [form] = result.forms;
    const [requirement] = form.security;
    const [[scheme, scopes]] = Object.entries(requirement);
    const request = await readJson("examples/v0.2/booking-create.request.json");
    const verdict = protocol.validateRequest(JSON.stringify(request), {
      manifest: vendorManifest,
      endpoint: { url: form.href, method: form.method },
      transport: { senderId: request.sender.id, scheme, scopes },
      now: "2026-08-17T09:00:02Z"
    });
    assert.equal(verdict.valid, true, JSON.stringify(verdict));
  });

  test("results are deterministic across runs", async () => {
    assert.deepEqual(await discover(developmentOrigins), await discover(developmentOrigins));
  });

  test("a registered capability the business does not declare is not advertised", async () => {
    const result = await discover(developmentOrigins, { capability: { id: "comcom.booking.get", version: "0.2.0" } });
    assert.equal(result.outcome, "not-advertised");
    assert.equal(result.code, "capability-not-advertised");
    assert.deepEqual(result.source.manifests[0].entity, vendorManifest.entity);
    assert.equal(result.forms, undefined);
    assert.equal(result.matches, undefined);
  });

  test("the CLI reports outcomes through exit status and flags development transport", async () => {
    const run = async (...args) => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, ...args], { encoding: "utf8" });
        return { status: 0, stdout, stderr };
      } catch (error) {
        return { status: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const mapping = `${ORIGIN}=${developmentOrigins[ORIGIN]}`;

    const advertised = await run(ORIGIN, "comcom.booking.create", "0.2.0", "--development-origin", mapping);
    assert.equal(advertised.status, 0, advertised.stderr);
    assert.match(advertised.stderr, /non-conformant/);
    const verdict = JSON.parse(advertised.stdout);
    assert.equal(verdict.outcome, "advertised");
    assert.equal(verdict.forms.length, 2);

    const absent = await run(ORIGIN, "comcom.booking.get", "0.2.0", "--development-origin", mapping);
    assert.equal(absent.status, 1);
    assert.equal(JSON.parse(absent.stdout).code, "capability-not-advertised");

    const unknown = await run(ORIGIN, "comcom.booking.create", "9.9.9", "--development-origin", mapping);
    assert.equal(unknown.status, 2);
    assert.equal(JSON.parse(unknown.stdout).code, "unsupported-capability");

    const insecure = await run("http://vendor.example", "comcom.booking.create", "0.2.0");
    assert.equal(insecure.status, 2);
    assert.equal(JSON.parse(insecure.stdout).code, "invalid-origin");

    for (const args of [[ORIGIN, "comcom.booking.create"], [ORIGIN, "comcom.booking.create", "0.2.0", "--timeout-ms", "0"], [ORIGIN, "comcom.booking.create", "0.2.0", "--development-origin", "nonsense"], [ORIGIN, "comcom.booking.create", "0.2.0", "--unknown"], [ORIGIN, "comcom.booking.create", "0.2.0", "--max-manifests", "0"], [ORIGIN, "comcom.booking.create", "0.2.0", "--max-manifests", "1e2"], [ORIGIN, "comcom.booking.create", "0.2.0", "--deadline-ms", "0"], [ORIGIN, "comcom.booking.create", "0.2.0", "--deadline-ms", "5s"]]) {
      const usage = await run(...args);
      assert.equal(usage.status, 64, args.join(" "));
      assert.equal(JSON.parse(usage.stdout).code, "cli-input-invalid");
    }
  });
});

describe("discovery outcomes from fixture publishers", () => {
  test("a v0.2.1 discovery-only publisher is not advertised; contactUrl is navigation only", async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/comcom/manifest.json", DISCOVERY_PROFILE)]) },
      "/comcom/manifest.json": { type: MANIFEST, body: publisherManifest }
    });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "not-advertised");
    assert.equal(result.code, "discovery-only-publisher");
    assert.equal(result.source.manifests[0].contactUrl, publisherManifest.contactUrl);
    assert.deepEqual(result.source.manifests[0].roles, ["discoveryPublisher"]);
    assert.equal(result.forms, undefined);
  });

  test("a send-only declaration is not advertised for receipt", async t => {
    const sender = await readJson("examples/v0.2/initiator-manifest.json");
    sender.profiles = vendorManifest.profiles;
    const { forms, ...declaration } = vendorManifest.capabilities[0];
    sender.capabilities = [{ ...declaration, direction: "send" }];
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/m")]) },
      "/m": { type: MANIFEST, body: sender }
    });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "not-advertised");
    assert.equal(result.code, "direction-mismatch");
  });

  test("an advertising manifest later in the catalog is found and all attempts are reported", async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/publisher", DISCOVERY_PROFILE), link("/vendor")]) },
      "/publisher": { type: MANIFEST, body: publisherManifest },
      "/vendor": { type: MANIFEST, body: vendorManifest }
    });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "advertised");
    assert.deepEqual(result.source.manifests.map(item => [item.url, item.code]), [
      [`${ORIGIN}/publisher`, "discovery-only-publisher"],
      [`${ORIGIN}/vendor`, "capability-advertised"]
    ]);
  });

  test("one unreadable manifest prevents a not-advertised conclusion", async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/publisher", DISCOVERY_PROFILE), link("/broken")]) },
      "/publisher": { type: MANIFEST, body: publisherManifest },
      "/broken": { status: 503, type: "text/plain", body: "unavailable" }
    });
    const result = await discover(developmentOrigins);
    assertFailed(result, "manifest", "manifest-http-status");
    assert.equal(result.httpStatus, 503);
  });

  test("reports OR alternatives, the anonymous alternative, and only the referenced schemes", async t => {
    const manifest = structuredClone(vendorManifest);
    manifest.securitySchemes.partnerKey = { type: "apiKey", name: "x-partner-key", in: "header" };
    manifest.securitySchemes.unused = { type: "http", scheme: "basic" };
    const create = manifest.capabilities[0];
    manifest.capabilities.push({
      ...create,
      id: "comcom.booking.get",
      kinds: ["query"],
      executionModes: ["synchronous"],
      inputSchema: create.inputSchema.replace("comcom-booking-create", "comcom-booking-get"),
      outputSchema: create.outputSchema.replace("comcom-booking-create", "comcom-booking-get"),
      forms: [{ ...create.forms[0], security: [{}, { partnerKey: [] }, { partnerKey: [], businessOAuth: ["booking:create"] }] }]
    });
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/m")]) },
      "/m": { type: MANIFEST, body: manifest }
    });
    const result = await discover(developmentOrigins, { capability: { id: "comcom.booking.get", version: "0.2.0" } });
    assert.equal(result.outcome, "advertised", JSON.stringify(result));
    assert.deepEqual(result.declaration.kinds, ["query"]);
    assert.equal(result.forms.length, 1);
    assert.deepEqual(result.forms[0].security, [{}, { partnerKey: [] }, { partnerKey: [], businessOAuth: ["booking:create"] }]);
    assert.equal(result.forms[0].anonymousAllowed, true);
    assert.deepEqual(Object.keys(result.securitySchemes), ["businessOAuth", "partnerKey"]);
  });

  test("a same-origin relative redirect is followed and reported", async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { status: 302, headers: { location: "/catalog.json" }, body: "" },
      "/catalog.json": { type: LINKSET, body: catalog([link("/vendor")]) },
      "/vendor": { type: MANIFEST, body: vendorManifest }
    });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "advertised");
    assert.equal(result.source.redirects, 1);
    assert.equal(result.source.catalogFinalUrl, `${ORIGIN}/catalog.json`);
  });
});

describe("multiple manifests: order independence, all matches, and ambiguity", () => {
  const CDN = "https://cdn.example";
  const reversedCatalog = body => ({ linkset: body.linkset.map(group => ({ ...group, item: [...group.item].reverse() })).reverse() });

  // Serves the same routes for both the business origin and a second hosting origin.
  async function multiFixture(t, catalogBody, manifests) {
    const routes = { "/.well-known/api-catalog": { type: LINKSET, body: catalogBody } };
    for (const [path, body] of Object.entries(manifests)) routes[path] = { type: MANIFEST, body };
    const served = await fixture(t, routes);
    served.developmentOrigins[CDN] = served.developmentOrigins[ORIGIN];
    return served;
  }

  // Two alternatives (OR), one with two scopes (AND within the scheme).
  function multiAlternativeVendor() {
    const manifest = structuredClone(vendorManifest);
    manifest.securitySchemes.partnerKey = { type: "apiKey", name: "x-partner-key", in: "header" };
    for (const form of manifest.capabilities[0].forms) form.security = [{ businessOAuth: ["booking:create", "booking:read"] }, { partnerKey: [] }];
    return manifest;
  }

  // The same contract with every set-like array in a different order.
  function reorderedVendor() {
    const manifest = multiAlternativeVendor();
    manifest.capabilities[0].forms.reverse();
    manifest.capabilities[0].executionModes.reverse();
    manifest.roles.reverse();
    for (const form of manifest.capabilities[0].forms) form.security = [{ partnerKey: [] }, { businessOAuth: ["booking:read", "booking:create"] }];
    return manifest;
  }

  function conflictingVendor() {
    const manifest = structuredClone(vendorManifest);
    manifest.securitySchemes.partnerKey = { type: "apiKey", name: "x-partner-key", in: "header" };
    for (const form of manifest.capabilities[0].forms) form.security = [{ partnerKey: [] }];
    return manifest;
  }

  test("equivalent manifests are advertised once, with every match reported, regardless of catalog order", async t => {
    const body = catalog([link("/b"), link("/a")]);
    const { developmentOrigins } = await multiFixture(t, body, { "/a": multiAlternativeVendor(), "/b": reorderedVendor() });
    const forward = await discover(developmentOrigins);
    assert.equal(forward.outcome, "advertised", JSON.stringify(forward));
    assert.deepEqual(forward.matches.map(match => match.manifest.url), [`${ORIGIN}/a`, `${ORIGIN}/b`]);
    assert.deepEqual(forward.forms, forward.matches[0].forms, "the reported contract comes from the canonical first match");
    const again = await multiFixture(t, reversedCatalog(body), { "/a": multiAlternativeVendor(), "/b": reorderedVendor() });
    assert.deepEqual(await discover(again.developmentOrigins), forward);
  });

  test("conflicting security requirements are reported as ambiguous with all matches and no chosen contract", async t => {
    const body = catalog([link("/a"), link("/b")]);
    const { developmentOrigins } = await multiFixture(t, body, { "/a": vendorManifest, "/b": conflictingVendor() });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.advertised, false);
    assert.equal(result.code, "ambiguous-advertisement");
    assert.equal(result.distinctContracts, 2);
    assert.equal(result.forms, undefined);
    assert.equal(result.securitySchemes, undefined);
    assert.deepEqual(result.matches.map(match => [match.manifest.url, match.forms[0].security]), [
      [`${ORIGIN}/a`, [{ businessOAuth: ["booking:create"] }]],
      [`${ORIGIN}/b`, [{ partnerKey: [] }]]
    ]);
    const again = await multiFixture(t, reversedCatalog(body), { "/a": vendorManifest, "/b": conflictingVendor() });
    assert.deepEqual(await discover(again.developmentOrigins), result);
  });

  test("conflicting endpoints and conflicting identities are each ambiguous", async t => {
    const otherEndpoint = structuredClone(vendorManifest);
    otherEndpoint.capabilities[0].forms[0].href = `${ORIGIN}/comcom/other`;
    const otherEntity = structuredClone(vendorManifest);
    otherEntity.entity = { id: "https://bank.example", type: "organization", name: "Unrelated Bank" };
    for (const [name, variant] of [["endpoint", otherEndpoint], ["entity", otherEntity]]) {
      const { developmentOrigins } = await multiFixture(t, catalog([link("/a"), link("/b")]), { "/a": vendorManifest, "/b": variant });
      const result = await discover(developmentOrigins);
      assert.equal(result.outcome, "ambiguous", name);
    }
  });

  test("a failed manifest prevents a conclusion even when another advertises, in either order", async t => {
    for (const order of [["/a", "/broken"], ["/broken", "/a"]]) {
      const routes = {
        "/.well-known/api-catalog": { type: LINKSET, body: catalog(order.map(path => link(path))) },
        "/a": { type: MANIFEST, body: vendorManifest },
        "/broken": { type: MANIFEST, body: "{}" }
      };
      const { developmentOrigins } = await fixture(t, routes);
      const result = await discover(developmentOrigins);
      assertFailed(result, "manifest", "schema-invalid");
      assert.deepEqual(result.failedManifest, { url: `${ORIGIN}/broken`, profile: LEGACY_PROFILE });
      assert.equal(result.matches, undefined);
      // No partial conclusion from the manifest that did advertise.
      assert.deepEqual(result.source.manifests, [
        { url: `${ORIGIN}/a`, profile: LEGACY_PROFILE, checked: true },
        { url: `${ORIGIN}/broken`, profile: LEGACY_PROFILE, checked: true, code: "schema-invalid" }
      ]);
    }
  });

  test("one URL listed under both profiles is retrieved once and validated under each", async t => {
    const { developmentOrigins, hits } = await multiFixture(t, catalog([link("/m", DISCOVERY_PROFILE), link("/m", LEGACY_PROFILE)]), { "/m": vendorManifest });
    const result = await discover(developmentOrigins);
    assert.equal(result.outcome, "advertised");
    assert.deepEqual(result.matches.map(match => match.manifest.profile), [LEGACY_PROFILE, DISCOVERY_PROFILE]);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog", "GET /m"]);
    assert.equal((await discover(developmentOrigins, { maxManifests: 1 })).outcome, "advertised", "the limit counts distinct URLs, not links");
  });

  test("five distinct manifest URLs fail closed by default without retrieval, and succeed when the limit is raised", async t => {
    const paths = ["/m1", "/m2", "/m3", "/m4", "/m5"];
    const { developmentOrigins, hits } = await multiFixture(t, catalog(paths.map(path => link(path))), Object.fromEntries(paths.map(path => [path, vendorManifest])));
    const limited = await discover(developmentOrigins);
    assertFailed(limited, "discovery", "manifest-link-limit");
    assert.equal(limited.manifestUrlCount, 5);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog"], "no manifest is retrieved when the limit is exceeded");
    const raised = await discover(developmentOrigins, { maxManifests: 5 });
    assert.equal(raised.outcome, "advertised");
    assert.equal(raised.matches.length, 5);
  });

  test("when nothing is advertised the most specific reason wins, independent of order", async t => {
    const sender = await readJson("examples/v0.2/initiator-manifest.json");
    sender.profiles = vendorManifest.profiles;
    const { forms, ...declaration } = vendorManifest.capabilities[0];
    sender.capabilities = [{ ...declaration, direction: "send" }];
    const items = [link("/publisher", DISCOVERY_PROFILE), link("/sender")];
    for (const ordered of [items, [...items].reverse()]) {
      const { developmentOrigins } = await multiFixture(t, catalog(ordered), { "/publisher": publisherManifest, "/sender": sender });
      const result = await discover(developmentOrigins);
      assert.equal(result.outcome, "not-advertised");
      assert.equal(result.code, "direction-mismatch");
    }
  });

  test("identity facts distinguish same-origin, delegated hosting, and a differing entity claim", async t => {
    const foreign = structuredClone(vendorManifest);
    foreign.entity = { id: "https://bank.example", type: "organization", name: "Unrelated Bank" };
    foreign.serviceOrigins = ["https://bank.example"];
    for (const form of foreign.capabilities[0].forms) {
      form.href = "https://bank.example/comcom/interactions";
      if (form.statusTemplate) form.statusTemplate = "https://bank.example/comcom/interactions/{id}";
    }
    const cases = [
      [`${ORIGIN}/m`, vendorManifest, { crossOrigin: false, entityMatchesOrigin: true, externalFormOrigins: [] }],
      [`${CDN}/m`, vendorManifest, { crossOrigin: true, entityMatchesOrigin: true, externalFormOrigins: [] }],
      [`${CDN}/m`, foreign, { crossOrigin: true, entityMatchesOrigin: false, externalFormOrigins: ["https://bank.example"] }]
    ];
    for (const [href, manifest, expected] of cases) {
      const { developmentOrigins } = await multiFixture(t, catalog([{ ...link("/m"), href }]), { "/m": manifest });
      const result = await discover(developmentOrigins);
      // Identity facts are reported, not enforced: the protocol defines no binding rule.
      assert.equal(result.outcome, "advertised", JSON.stringify(result));
      assert.equal(result.matches[0].manifest.crossOrigin, expected.crossOrigin, href);
      assert.equal(result.identity.entityMatchesOrigin, expected.entityMatchesOrigin, href);
      assert.deepEqual(result.identity.externalFormOrigins, expected.externalFormOrigins, href);
    }
  });

  test("the CLI exits 3 for an ambiguous advertisement", async t => {
    const { developmentOrigins } = await multiFixture(t, catalog([link("/a"), link("/b")]), { "/a": vendorManifest, "/b": conflictingVendor() });
    const result = await promisify(execFile)(process.execPath, [cliPath, ORIGIN, "comcom.booking.create", "0.2.0", "--development-origin", `${ORIGIN}=${developmentOrigins[ORIGIN]}`], { encoding: "utf8" })
      .then(() => ({ status: 0 }), error => ({ status: error.code, stdout: error.stdout }));
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).outcome, "ambiguous");
  });
});

describe("overall discovery deadline", () => {
  const assertNoConclusion = result => {
    for (const field of ["matches", "forms", "securitySchemes", "declaration", "entity", "identity"]) assert.equal(result[field], undefined, field);
  };

  test("a catalog that never answers fails at the deadline and reports the catalog as unchecked", { timeout: 3000 }, async t => {
    const { developmentOrigins, hits } = await fixture(t, { "/.well-known/api-catalog": hang });
    const started = performance.now();
    const result = await discover(developmentOrigins, { deadlineMs: 200 });
    assert(performance.now() - started < 2000, "the deadline, not the 10 s retrieval timeout, ended discovery");
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.equal(result.deadlineMs, 200);
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog"]);
    assertNoConclusion(result);
  });

  test("the per-retrieval timeout still applies when it is shorter than the remaining deadline", { timeout: 3000 }, async t => {
    const { developmentOrigins } = await fixture(t, { "/.well-known/api-catalog": hang });
    const result = await discover(developmentOrigins, { timeoutMs: 100, deadlineMs: 5000 });
    assertFailed(result, "discovery", "fetch-timeout");
    assert.equal(result.unchecked, undefined);
  });

  test("a manifest that never answers stops discovery; it and later manifests are unchecked and no advertisement is reported", { timeout: 3000 }, async t => {
    const { developmentOrigins, hits } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/c"), link("/b"), link("/a")]) },
      "/a": { type: MANIFEST, body: vendorManifest },
      "/b": hang,
      "/c": { type: MANIFEST, body: vendorManifest }
    });
    const result = await discover(developmentOrigins, { deadlineMs: 300 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [
      { kind: "manifest", url: `${ORIGIN}/b`, profile: LEGACY_PROFILE },
      { kind: "manifest", url: `${ORIGIN}/c`, profile: LEGACY_PROFILE }
    ]);
    assert.deepEqual(result.source.manifests.map(item => [item.url, item.checked]), [
      [`${ORIGIN}/a`, true], [`${ORIGIN}/b`, false], [`${ORIGIN}/c`, false]
    ]);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog", "GET /a", "GET /b"], "no retrieval starts after the deadline");
    assertNoConclusion(result);
  });

  test("the deadline is cumulative across slow manifests that each meet the per-retrieval timeout", { timeout: 4000 }, async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/a"), link("/b"), link("/c")]) },
      "/a": delayed(400, { type: MANIFEST, body: vendorManifest }),
      "/b": delayed(400, { type: MANIFEST, body: vendorManifest }),
      "/c": hang
    });
    const result = await discover(developmentOrigins, { timeoutMs: 1000, deadlineMs: 1000 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked.map(item => item.url), [`${ORIGIN}/c`]);
    assertNoConclusion(result);
  });

  test("a manifest that timed out on its own is checked; the deadline still decides the outcome", { timeout: 4000 }, async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/a"), link("/b")]) },
      "/a": hang,
      "/b": hang
    });
    const result = await discover(developmentOrigins, { timeoutMs: 400, deadlineMs: 600 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.source.manifests.map(item => [item.url, item.checked, item.code]), [
      [`${ORIGIN}/a`, true, "fetch-timeout"], [`${ORIGIN}/b`, false, undefined]
    ]);
    assert.deepEqual(result.unchecked.map(item => item.url), [`${ORIGIN}/b`]);
  });

  test("ordinary multi-manifest discovery with slow responses within the deadline still succeeds", { timeout: 5000 }, async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": delayed(100, { type: LINKSET, body: catalog([link("/c"), link("/a"), link("/b")]) }),
      "/a": delayed(100, { type: MANIFEST, body: vendorManifest }),
      "/b": delayed(100, { type: MANIFEST, body: vendorManifest }),
      "/c": delayed(100, { type: MANIFEST, body: vendorManifest })
    });
    const defaults = await discover(developmentOrigins);
    assert.equal(defaults.outcome, "advertised", JSON.stringify(defaults));
    assert.deepEqual(defaults.matches.map(match => match.manifest.url), [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]);
    assert.equal(defaults.unchecked, undefined);
    assert.deepEqual(await discover(developmentOrigins, { deadlineMs: 3000 }), defaults);
  });

  test("the CLI reports a deadline failure with exit status 2", { timeout: 10000 }, async t => {
    const { developmentOrigins } = await fixture(t, { "/.well-known/api-catalog": hang });
    const result = await promisify(execFile)(process.execPath, [cliPath, ORIGIN, "comcom.booking.create", "0.2.0", "--deadline-ms", "200", "--development-origin", `${ORIGIN}=${developmentOrigins[ORIGIN]}`], { encoding: "utf8" })
      .then(() => ({ status: 0 }), error => ({ status: error.code, stdout: error.stdout }));
    assert.equal(result.status, 2);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.code, "discovery-deadline-exceeded");
    assert.deepEqual(verdict.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
  });
});

describe("the overall deadline spans DNS resolution and redirects", () => {
  // These fixtures are reached through http://localhost:PORT rather than an IP
  // literal, so every retrieval and every redirect hop performs a resolver call.
  async function localhostFixture(t, routes) {
    const served = await fixture(t, routes);
    served.developmentOrigins[ORIGIN] = served.developmentOrigins[ORIGIN].replace("127.0.0.1", "localhost");
    return served;
  }

  // Answers only "localhost", after `ms` (or never, when ms is Infinity).
  function slowResolver(ms) {
    const calls = [];
    const resolver = host => {
      calls.push(host);
      if (host !== "localhost") return Promise.reject(new Error(`DNS lookup of ${host} is forbidden in tests`));
      if (ms === Infinity) return new Promise(() => {});
      return new Promise(resolveLookup => setTimeout(() => resolveLookup([{ address: "127.0.0.1", family: 4 }]), ms));
    };
    return { resolver, calls };
  }

  function redirect(ms, location) {
    return (request, response) => {
      const timer = setTimeout(() => {
        response.writeHead(302, { location });
        response.end();
      }, ms);
      request.on("close", () => clearTimeout(timer));
    };
  }

  const catalogOf = paths => ({ type: LINKSET, body: catalog(paths.map(path => link(path))) });
  const manifest = { type: MANIFEST, body: null };
  before(() => { manifest.body = vendorManifest; });

  // Asserts that nothing (no connection, no new DNS lookup) happens after the result.
  async function assertQuietAfter(hits, calls, ms = 500) {
    const [hitCount, callCount] = [hits.length, calls.length];
    await new Promise(resolveWait => setTimeout(resolveWait, ms));
    assert.deepEqual([hits.length, calls.length], [hitCount, callCount], "no retrieval or DNS lookup continues after the deadline");
  }

  test("a resolver that never answers cannot outlast the deadline", { timeout: 3000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, { "/.well-known/api-catalog": catalogOf(["/a"]), "/a": manifest });
    const { resolver, calls } = slowResolver(Infinity);
    const started = performance.now();
    const result = await discover(developmentOrigins, { resolver, deadlineMs: 200 });
    assert(performance.now() - started < 2000, "the deadline, not the 10 s retrieval timeout, ended discovery");
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    assert.deepEqual(calls, ["localhost"]);
    assert.deepEqual(hits, []);
  });

  test("a late DNS answer after the deadline does not lead to a connection", { timeout: 3000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, { "/.well-known/api-catalog": catalogOf(["/a"]), "/a": manifest });
    const { resolver, calls } = slowResolver(400);
    const result = await discover(developmentOrigins, { resolver, deadlineMs: 150 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    await assertQuietAfter(hits, calls);
    assert.deepEqual(hits, []);
  });

  test("the conformant path applies the deadline to DNS resolution", { timeout: 3000 }, async () => {
    const calls = [];
    const result = await discoverCapability({
      origin: ORIGIN, capability: CREATE, protocol, deadlineMs: 200,
      resolver: host => { calls.push(host); return new Promise(() => {}); }
    });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.equal(result.conformant, true);
    assert.deepEqual(calls, ["vendor.example"]);
  });

  test("slow DNS accumulates across the catalog and manifest retrievals", { timeout: 5000 }, async t => {
    const routes = { "/.well-known/api-catalog": catalogOf(["/a", "/b"]), "/a": manifest, "/b": manifest };
    const limited = await localhostFixture(t, routes);
    const slow = slowResolver(300);
    // 300 ms per lookup is within the 1000 ms per-retrieval timeout each time,
    // but three lookups exceed the 750 ms budget.
    const result = await discover(limited.developmentOrigins, { resolver: slow.resolver, timeoutMs: 1000, deadlineMs: 750 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked.map(item => item.url), [`${ORIGIN}/b`]);
    assert.deepEqual(limited.hits, ["GET /.well-known/api-catalog", "GET /a"]);
    await assertQuietAfter(limited.hits, slow.calls);

    const control = await localhostFixture(t, routes);
    const result2 = await discover(control.developmentOrigins, { resolver: slowResolver(300).resolver, timeoutMs: 1000, deadlineMs: 3000 });
    assert.equal(result2.outcome, "advertised", "the same lookups succeed within a larger budget");
  });

  test("a redirect chain consumes the catalog budget instead of resetting it per hop", { timeout: 5000 }, async t => {
    const routes = {
      "/.well-known/api-catalog": redirect(300, "/r1"),
      "/r1": redirect(300, "/r2"),
      "/r2": redirect(300, "/r3"),
      "/r3": delayed(300, catalogOf(["/a"])),
      "/a": manifest
    };
    const limited = await localhostFixture(t, routes);
    const dns = slowResolver(0);
    // Each hop takes 300 ms, far below the 10 s per-retrieval timeout.
    const result = await discover(limited.developmentOrigins, { resolver: dns.resolver, deadlineMs: 750 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    assert(!limited.hits.includes("GET /r3"), `the chain stops at the deadline: ${limited.hits}`);
    await assertQuietAfter(limited.hits, dns.calls);

    const control = await localhostFixture(t, routes);
    const result2 = await discover(control.developmentOrigins, { resolver: slowResolver(0).resolver, deadlineMs: 3000 });
    assert.equal(result2.outcome, "advertised");
    assert.equal(result2.source.redirects, 3);
  });

  test("DNS lookups for each redirect hop draw from the same budget", { timeout: 5000 }, async t => {
    const routes = {
      "/.well-known/api-catalog": redirect(0, "/r1"),
      "/r1": redirect(0, "/r2"),
      "/r2": redirect(0, "/r3"),
      "/r3": catalogOf(["/a"]),
      "/a": manifest
    };
    const limited = await localhostFixture(t, routes);
    const slow = slowResolver(200);
    // Four lookups of 200 ms are needed for the catalog alone; the budget is 500 ms.
    const result = await discover(limited.developmentOrigins, { resolver: slow.resolver, deadlineMs: 500 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert(slow.calls.length <= 3, `lookups stop at the deadline: ${slow.calls.length}`);
    await assertQuietAfter(limited.hits, slow.calls);

    const control = await localhostFixture(t, routes);
    const generous = slowResolver(200);
    const result2 = await discover(control.developmentOrigins, { resolver: generous.resolver, deadlineMs: 3000 });
    assert.equal(result2.outcome, "advertised");
    assert.equal(generous.calls.length, 5, "four catalog hops and one manifest");
  });

  test("manifest redirects spend what the catalog's redirects left", { timeout: 5000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, {
      "/.well-known/api-catalog": redirect(200, "/c1"),
      "/c1": delayed(200, catalogOf(["/a"])),
      "/a": redirect(200, "/a1"),
      "/a1": redirect(200, "/a2"),
      "/a2": delayed(200, manifest)
    });
    const dns = slowResolver(0);
    // The catalog takes at least 400 ms and the manifest at least 600 ms; each
    // is below the 1000 ms per-retrieval timeout, but together they exceed 650 ms.
    const result = await discover(developmentOrigins, { resolver: dns.resolver, timeoutMs: 1000, deadlineMs: 650 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked.map(item => item.url), [`${ORIGIN}/a`]);
    assert(!hits.includes("GET /a2"), `the manifest chain stops at the deadline: ${hits}`);
    await assertQuietAfter(hits, dns.calls);
  });

  // Blocks the event loop synchronously on lookup number `call`, then answers.
  // While the loop is blocked no timer can fire, so only an explicit clock
  // check can stop the request that would otherwise follow the late answer.
  function blockingResolver(call, ms, address = "127.0.0.1") {
    const calls = [];
    const resolver = host => {
      calls.push(host);
      if (calls.length === call) {
        const until = performance.now() + ms;
        while (performance.now() < until);
        return [{ address, family: 4 }];
      }
      if (host !== "localhost") throw new Error(`DNS lookup of ${host} is forbidden in tests`);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    return { resolver, calls };
  }

  test("a lookup that blocks past the deadline and then returns starts no catalog connection", { timeout: 5000 }, async t => {
    const { developmentOrigins, hits, connections } = await localhostFixture(t, { "/.well-known/api-catalog": catalogOf(["/a"]), "/a": manifest });
    const { resolver, calls } = blockingResolver(1, 400);
    const result = await discover(developmentOrigins, { resolver, deadlineMs: 200 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    await assertQuietAfter(hits, calls);
    assert.deepEqual(connections, [], "no TCP connection was opened");
    assert.deepEqual(hits, []);
    assert.deepEqual(calls, ["localhost"]);
  });

  test("a redirect hop whose lookup blocks past the deadline sends no request for that hop", { timeout: 5000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, {
      "/.well-known/api-catalog": redirect(0, "/r1"),
      "/r1": catalogOf(["/a"]),
      "/a": manifest
    });
    const { resolver, calls } = blockingResolver(2, 400);
    const result = await discover(developmentOrigins, { resolver, deadlineMs: 200 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    await assertQuietAfter(hits, calls);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog"], "the redirect target was never requested");
    assert.equal(calls.length, 2);
  });

  test("a manifest lookup that blocks past the deadline sends no request and yields no partial conclusion", { timeout: 5000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, {
      "/.well-known/api-catalog": catalogOf(["/a", "/b"]),
      "/a": manifest,
      "/b": manifest
    });
    // Lookups: 1 catalog, 2 manifest /a (advertises), 3 manifest /b (blocks).
    const { resolver, calls } = blockingResolver(3, 400);
    const result = await discover(developmentOrigins, { resolver, deadlineMs: 200 });
    assertFailed(result, "manifest", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "manifest", url: `${ORIGIN}/b`, profile: LEGACY_PROFILE }]);
    assert.deepEqual(result.source.manifests.map(item => [item.url, item.checked]), [[`${ORIGIN}/a`, true], [`${ORIGIN}/b`, false]]);
    for (const field of ["matches", "forms", "securitySchemes", "declaration", "entity", "identity"]) assert.equal(result[field], undefined, field);
    await assertQuietAfter(hits, calls);
    assert.deepEqual(hits, ["GET /.well-known/api-catalog", "GET /a"], "/b was never requested");
  });

  test("when blocking overruns both the retrieval timeout and the deadline, the deadline is reported", { timeout: 5000 }, async t => {
    const { developmentOrigins, hits } = await localhostFixture(t, { "/.well-known/api-catalog": catalogOf(["/a"]), "/a": manifest });
    const { resolver } = blockingResolver(1, 400);
    // The 100 ms retrieval timeout is the shorter limit, but the 400 ms block
    // also exhausts the 200 ms discovery budget.
    const result = await discover(developmentOrigins, { resolver, timeoutMs: 100, deadlineMs: 200 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.deepEqual(result.unchecked, [{ kind: "catalog", url: `${ORIGIN}/.well-known/api-catalog` }]);
    assert.deepEqual(hits, []);
  });

  test("after a blocking lookup the deadline is reported even if the late answer is unsafe", { timeout: 5000 }, async () => {
    const { resolver, calls } = blockingResolver(1, 400, "10.0.0.1");
    const result = await discoverCapability({ origin: ORIGIN, capability: CREATE, protocol, resolver, deadlineMs: 200 });
    assertFailed(result, "discovery", "discovery-deadline-exceeded");
    assert.equal(result.conformant, true);
    assert.deepEqual(calls, ["vendor.example"]);
  });

  test("the redirect limit still applies within a generous deadline", async t => {
    const { developmentOrigins } = await localhostFixture(t, {
      "/.well-known/api-catalog": redirect(0, "/r1"),
      "/r1": redirect(0, "/r2"),
      "/r2": redirect(0, "/r3"),
      "/r3": redirect(0, "/r4"),
      "/r4": catalogOf(["/a"])
    });
    const result = await discover(developmentOrigins, { resolver: slowResolver(0).resolver, deadlineMs: 5000 });
    assertFailed(result, "discovery", "redirect-limit");
  });
});

describe("discovery failures are explicit and stop before unsafe use", () => {
  const routesFor = (catalogRoute, manifestRoute = { type: MANIFEST, body: vendorManifest }) => ({
    "/.well-known/api-catalog": catalogRoute,
    "/m": manifestRoute
  });
  const validCatalog = { type: LINKSET, body: catalog([link("/m")]) };

  const cases = [
    ["catalog not published", () => routesFor({ status: 404, type: "text/plain", body: "" }), "discovery", "discovery-http-status"],
    ["catalog without a content type", () => routesFor({ body: catalog([link("/m")]) }), "discovery", "content-type-mismatch"],
    ["catalog with the wrong content type", () => routesFor({ type: "application/json", body: catalog([link("/m")]) }), "discovery", "content-type-mismatch"],
    ["catalog with duplicate JSON keys", () => routesFor({ type: LINKSET, body: '{"linkset":[],"linkset":[]}' }), "raw", "duplicate-key"],
    ["catalog larger than 64 KiB", () => routesFor({ type: LINKSET, body: " ".repeat(70_000) }), "discovery", "response-too-large"],
    ["catalog with an unknown manifest profile", () => routesFor({ type: LINKSET, body: catalog([link("/m", "https://attacker.example/profile")]) }), "discovery", "schema-invalid"],
    ["catalog linking a manifest over HTTP", () => routesFor({ type: LINKSET, body: catalog([{ ...link("/m"), href: "http://vendor.example/m" }]) }), "discovery", "unsafe-url"],
    ["catalog anchored at another origin", () => routesFor({ type: LINKSET, body: catalog([link("/m")], "https://other.example/.well-known/api-catalog") }), "discovery", "manifest-link-missing"],
    ["catalog with too many manifest URLs", () => routesFor({ type: LINKSET, body: catalog(Array.from({ length: DEFAULT_MAX_MANIFESTS + 1 }, (_, index) => link(`/m${index}`))) }), "discovery", "manifest-link-limit"],
    ["redirect downgrading to non-loopback HTTP", () => routesFor({ status: 302, headers: { location: "http://vendor.example/catalog" }, body: "" }), "discovery", "unsafe-scheme"],
    ["manifest with the wrong content type", () => routesFor(validCatalog, { type: "application/json", body: vendorManifest }), "manifest", "content-type-mismatch"],
    ["manifest with an unverified profile digest", () => {
      const tampered = structuredClone(vendorManifest);
      tampered.profiles[0].sha256 = "0".repeat(64);
      return routesFor(validCatalog, { type: MANIFEST, body: tampered });
    }, "manifest", "profile-digest-mismatch"],
    ["manifest form outside its service origins", () => {
      const tampered = structuredClone(vendorManifest);
      tampered.capabilities[0].forms[0].href = "https://attacker.example/comcom/interactions";
      return routesFor(validCatalog, { type: MANIFEST, body: tampered });
    }, "endpoint", "endpoint-origin-mismatch"],
    ["manifest referencing an undeclared security scheme", () => {
      const tampered = structuredClone(vendorManifest);
      tampered.capabilities[0].forms[0].security = [{ undeclared: [] }];
      return routesFor(validCatalog, { type: MANIFEST, body: tampered });
    }, "security", "unknown-security-scheme"],
    ["discovery-only manifest mislabeled with the v0.2.0 profile", () => routesFor(validCatalog, { type: MANIFEST, body: publisherManifest }), "manifest", "schema-invalid"]
  ];

  for (const [name, routes, phase, code] of cases) {
    test(name, async t => {
      const { developmentOrigins } = await fixture(t, routes());
      assertFailed(await discover(developmentOrigins), phase, code);
    });
  }

  test("a stalled catalog is bounded by the retrieval deadline", { timeout: 2000 }, async t => {
    const { developmentOrigins } = await fixture(t, { "/.well-known/api-catalog": () => {} });
    const result = await discover(developmentOrigins, { timeoutMs: 100 });
    assertFailed(result, "discovery", "fetch-timeout");
    assert.equal(result.conformant, false, "a failed development retrieval is still non-conformant");
  });

  test("conformant retrieval rejects a business origin resolving to a private address", async () => {
    const result = await discoverCapability({
      origin: ORIGIN, capability: CREATE, protocol,
      resolver: async () => [{ address: "10.0.0.1", family: 4 }]
    });
    assertFailed(result, "discovery", "unsafe-address");
    assert.equal(result.conformant, true);
  });
});

describe("discovery input validation happens before any retrieval", () => {
  const inputs = [
    [{ origin: "http://vendor.example" }, "invalid-origin"],
    [{ origin: "https://vendor.example/comcom" }, "invalid-origin"],
    [{ origin: "https://vendor.example/?q" }, "invalid-origin"],
    [{ origin: "https://vendor.example?" }, "invalid-origin"],
    [{ origin: "https://vendor.example#fragment" }, "invalid-origin"],
    [{ origin: "https://user:secret@vendor.example" }, "invalid-origin"],
    [{ origin: "vendor.example" }, "invalid-origin"],
    [{ origin: undefined }, "invalid-origin"],
    [{ capability: { id: "comcom.booking.create" } }, "invalid-capability"],
    [{ capability: { id: "comcom.booking.create", version: "0.2" } }, "unsupported-capability"],
    [{ capability: { id: "comcom.booking.create", version: "0.2.1" } }, "unsupported-capability"],
    [{ capability: { id: "com.example.booking.create", version: "0.2.0" } }, "unsupported-capability"],
    [{ developmentOrigins: { [ORIGIN]: "https://127.0.0.1:8443" } }, "invalid-development-origin"],
    [{ developmentOrigins: { [ORIGIN]: "http://127.0.0.1:8788/path" } }, "invalid-development-origin"],
    [{ developmentOrigins: { "http://vendor.example": "http://127.0.0.1:8788" } }, "invalid-origin"],
    [{ maxManifests: 0 }, "invalid-max-manifests"],
    [{ maxManifests: 1025 }, "invalid-max-manifests"],
    [{ maxManifests: 2.5 }, "invalid-max-manifests"],
    [{ deadlineMs: 0 }, "invalid-deadline"],
    [{ deadlineMs: 600_001 }, "invalid-deadline"],
    [{ deadlineMs: 1.5 }, "invalid-deadline"]
  ];

  for (const [overrides, code] of inputs) {
    test(`${JSON.stringify(overrides)} → ${code}`, async t => {
      // Route the origin to a live fixture so any premature retrieval is observable.
      const { hits, developmentOrigins } = await fixture(t, {
        "/.well-known/api-catalog": { type: LINKSET, body: catalog([link("/m")]) },
        "/m": { type: MANIFEST, body: vendorManifest }
      });
      const result = await discover(developmentOrigins, overrides);
      assertFailed(result, "input", code);
      assert.deepEqual(hits, []);
      assert.equal(result.source.catalogUrl, undefined);
    });
  }

  test("origins are normalized to their serialized form", async t => {
    const { developmentOrigins } = await fixture(t, {
      "/.well-known/api-catalog": { type: LINKSET, body: catalog([{ ...link("/m"), href: "https://VENDOR.example:443/m" }]) },
      "/m": { type: MANIFEST, body: vendorManifest }
    });
    const result = await discover(developmentOrigins, { origin: "https://VENDOR.example:443/" });
    assert.equal(result.source.manifests[0].url, "https://VENDOR.example:443/m", "provenance records the published href verbatim");
    assert.equal(result.origin, ORIGIN);
    assert.equal(result.outcome, "advertised");
  });
});
