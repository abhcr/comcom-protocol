import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createProtocolV02 } from "../reference/v0.2/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const python = process.env.COMCOM_PYTHON ?? (existsSync(resolve(root, ".venv/bin/python")) ? resolve(root, ".venv/bin/python") : "python3");
const profile = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest";
const legacyProfile = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest";
const readJson = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));

function cli(runtime, directory, command, document, context = {}) {
  const executable = runtime === "node" ? process.execPath : python;
  const script = runtime === "node" ? "cli.mjs" : "comcom_validator.py";
  const result = spawnSync(executable, [resolve(directory, "reference/v0.2", script), command], {
    input: `${JSON.stringify(context)}\n\n${JSON.stringify(document)}`,
    encoding: "utf8"
  });
  assert(result.stdout, `${runtime} produced no verdict: ${result.stderr}`);
  return { status: result.status, verdict: JSON.parse(result.stdout) };
}

test("Node and Python agree on offline manifest profiles, discovery safety, and response identity", async () => {
  const protocol = await createProtocolV02();
  const discoveryManifest = await readJson("examples/v0.2.1/purplecore-manifest.json");
  const catalog = await readJson("examples/v0.2.1/purplecore-api-catalog.json");
  const legacyManifest = await readJson("examples/v0.2/vendor-manifest.json");
  const request = await readJson("examples/v0.2/booking-create.request.json");
  const response = await readJson("examples/v0.2/booking-create.result.json");
  const cases = [];
  const add = (name, command, document, context, valid, code = valid ? "valid" : "schema-invalid") => {
    cases.push({ name, command, raw: JSON.stringify(document), context, valid, code });
  };
  const manifestContext = { manifestProfile: profile };
  add("discovery-only", "manifest", discoveryManifest, manifestContext, true);
  const noContact = structuredClone(discoveryManifest);
  delete noContact.contactUrl;
  add("contact optional", "manifest", noContact, manifestContext, true);
  add("legacy default", "manifest", legacyManifest, {}, true);
  add("legacy explicit", "manifest", legacyManifest, { manifestProfile: legacyProfile }, true);
  add("legacy under new profile", "manifest", legacyManifest, manifestContext, true);
  add("new document requires profile", "manifest", discoveryManifest, {}, false);
  add("new document rejected by legacy profile", "manifest", discoveryManifest, { manifestProfile: legacyProfile }, false);
  for (const unsupported of ["https://attacker.example/schema.json", null, [], ""]) {
    add(`unsupported profile ${JSON.stringify(unsupported)}`, "manifest", discoveryManifest, { manifestProfile: unsupported }, false, "unsupported-manifest-profile");
  }
  for (const [field, value] of Object.entries({
    serviceOrigins: [], limits: {}, security: [], securitySchemes: {}, inbox: {},
    profiles: [{ id: "transactions.services" }], capabilities: [{ id: "comcom.booking.create" }],
    roles: ["discoveryPublisher", "responder"], protocolVersions: ["0.2", "0.2"]
  })) add(`closed discovery field ${field}`, "manifest", { ...discoveryManifest, [field]: value }, manifestContext, false);
  for (const contactUrl of [
    "http://purplecore.in/#contact-form", "javascript:alert(1)", "https://user:secret@purplecore.in/",
    "https://purplecore.in\\@attacker.example/", "https:///contact", "https://purplecore.in/a b"
  ]) add(`unsafe contact ${contactUrl}`, "manifest", { ...discoveryManifest, contactUrl }, manifestContext, false);
  add("new discovery", "discovery", catalog, {}, true);
  const legacyCatalog = structuredClone(catalog);
  legacyCatalog.linkset[0].item[0].profile = legacyProfile;
  add("legacy discovery", "discovery", legacyCatalog, {}, true);
  const unknownCatalog = structuredClone(catalog);
  unknownCatalog.linkset[0].item[0].profile = "https://attacker.example/schema.json";
  add("unknown discovery profile", "discovery", unknownCatalog, {}, false);
  const unsafeAnchor = structuredClone(catalog);
  unsafeAnchor.linkset[0].anchor = "http://purplecore.in";
  add("unsafe discovery anchor", "discovery", unsafeAnchor, {}, false, "unsafe-url");
  const responseContext = { request, now: "2026-08-17T09:00:02Z" };
  add("trusted responder", "response", response, { ...responseContext, transport: { senderId: "https://vendor.example" } }, true);
  add("missing responder identity", "response", response, responseContext, false, "sender-identity-mismatch");
  add("incorrect responder identity", "response", response, { ...responseContext, transport: { senderId: "https://attacker.example" } }, false, "sender-identity-mismatch");

  const pythonResult = spawnSync(python, ["-c", `
import json, socket, sys
sys.path.insert(0, sys.argv[1])
from comcom_validator import Protocol
socket.create_connection = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Network access forbidden"))
protocol = Protocol()
print(json.dumps([{key: value for key, value in getattr(protocol, "validate_" + case["command"])(case["raw"].encode(), case["context"]).items() if key in ("valid", "phase", "code", "status")} for case in json.load(sys.stdin)]))
`, resolve(root, "reference/v0.2")], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 2_000_000 });
  assert.equal(pythonResult.status, 0, pythonResult.stderr);
  const pythonVerdicts = JSON.parse(pythonResult.stdout);
  for (const [index, item] of cases.entries()) {
    const method = `validate${item.command[0].toUpperCase()}${item.command.slice(1)}`;
    const nodeVerdict = protocol[method](item.raw, item.context);
    for (const [runtime, verdict] of [["node", nodeVerdict], ["python", pythonVerdicts[index]]]) {
      assert.equal(verdict.valid, item.valid, `${item.name}: ${runtime} ${JSON.stringify(verdict.errors)}`);
      assert.equal(verdict.code, item.code, `${item.name}: ${runtime}`);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(nodeVerdict).filter(([key]) => ["valid", "phase", "code", "status"].includes(key))), pythonVerdicts[index], item.name);
  }
  for (const runtime of ["node", "python"]) {
    const result = cli(runtime, root, "manifest", discoveryManifest, manifestContext);
    assert.equal(result.status, 0);
    assert.equal(result.verdict.valid, true);
    assert.equal(Object.hasOwn(result.verdict, "value"), false);
  }
});

test("both CLIs reject changed kernel, profile, registry, and release metadata bytes before validation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "comcom-integrity-"));
  try {
    for (const path of ["schemas", "profiles", "reference/v0.2"]) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
    await mkdir(resolve(directory, "registry/v0.2"), { recursive: true });
    await cp(resolve(root, "registry/v0.2/capabilities.json"), resolve(directory, "registry/v0.2/capabilities.json"));
    for (const version of ["v0.2.0", "v0.2.1"]) {
      await mkdir(resolve(directory, `releases/${version}`), { recursive: true });
      await cp(resolve(root, `releases/${version}/release-manifest.json`), resolve(directory, `releases/${version}/release-manifest.json`));
    }
    await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
    const manifest = await readJson("examples/v0.2.1/purplecore-manifest.json");
    for (const path of [
      "schemas/v0.2/entity.schema.json", "schemas/v0.2.1/manifest.schema.json",
      "profiles/v0.2/transactions.booking/comcom-booking-create/schemas/input.schema.json",
      "registry/v0.2/capabilities.json", "releases/v0.2.0/release-manifest.json", "releases/v0.2.1/release-manifest.json"
    ]) {
      const fullPath = resolve(directory, path);
      const original = await readFile(fullPath);
      const altered = path.endsWith("release-manifest.json")
        ? JSON.stringify({ ...JSON.parse(original), treeSha256: "0".repeat(64) })
        : Buffer.concat([original, Buffer.from(" ")]);
      await writeFile(fullPath, altered);
      for (const runtime of ["node", "python"]) {
        const result = cli(runtime, directory, "manifest", manifest, { manifestProfile: profile });
        assert.equal(result.status, 1, `${path}: ${runtime}`);
        assert.equal(result.verdict.phase, "bundle", `${path}: ${runtime}`);
        assert.equal(result.verdict.code, "digest-mismatch", `${path}: ${runtime}`);
      }
      await writeFile(fullPath, original);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
