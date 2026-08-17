import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createProtocolV02 } from "../reference/v0.2/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const corpusRoot = resolve(root, "conformance/v0.2");
const corpus = JSON.parse(await readFile(resolve(corpusRoot, "cases.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "examples/v0.2/vendor-manifest.json"), "utf8"));
const request = JSON.parse(await readFile(resolve(root, "examples/v0.2/booking-create.request.json"), "utf8"));
const protocol = await createProtocolV02();
const python = process.env.COMCOM_PYTHON ?? resolve(root, ".venv/bin/python");

function baseContext(name) {
  if (name === "request") return {
    manifest: structuredClone(manifest),
    endpoint: { url: "https://vendor.example/comcom/interactions", method: "POST" },
    transport: { senderId: "https://buyer.example", scheme: "businessOAuth", scopes: ["booking:create"], roles: ["buyer"] },
    supportedExtensions: [],
    now: "2026-08-17T09:00:00Z"
  };
  if (name === "response") return {
    request: structuredClone(request),
    transport: { senderId: "https://vendor.example", scheme: "businessOAuth", scopes: [] },
    supportedExtensions: [],
    now: "2026-08-17T09:00:02Z"
  };
  if (name === "discovery") return { method: "GET", contentType: "application/linkset+json" };
  return {};
}

function patch(target, changes = []) {
  for (const change of changes) {
    const parts = change.path.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const key = parts.pop();
    let cursor = target;
    for (const part of parts) cursor = cursor[part];
    if (change.op === "remove") delete cursor[key];
    else cursor[key] = change.value;
  }
  return target;
}

function nodeVerdict(command, raw, context) {
  if (command === "request") return protocol.validateRequest(raw, context);
  if (command === "response") return protocol.validateResponse(raw, context);
  if (command === "discovery") return protocol.validateDiscovery(raw, context);
  if (command === "manifest") return protocol.validateManifest(raw, context);
  return protocol.validateReleaseBundle(raw, context);
}

const summary = [];
for (const testCase of corpus.cases) {
  let raw = await readFile(resolve(corpusRoot, testCase.document));
  if (testCase.encoding === "base64") raw = Buffer.from(raw.toString("ascii").trim(), "base64");
  if (testCase.documentPatch) raw = Buffer.from(JSON.stringify(patch(JSON.parse(raw), testCase.documentPatch)));
  const context = patch(baseContext(testCase.context), testCase.contextPatch);
  const node = nodeVerdict(testCase.command, raw, context);
  const framed = Buffer.concat([Buffer.from(JSON.stringify(context)), Buffer.from("\n\n"), raw]);
  const process = spawnSync(python, [resolve(root, "reference/v0.2/comcom_validator.py"), testCase.command], { input: framed, encoding: "utf8", maxBuffer: 10_000_000 });
  if (!process.stdout) throw new Error(`Python produced no verdict for ${testCase.id}: ${process.stderr}`);
  const pythonVerdict = JSON.parse(process.stdout);
  const expected = testCase.expected;
  for (const [runtime, verdict] of [["node", node], ["python", pythonVerdict]]) {
    assert.equal(verdict.valid, expected.valid, `${testCase.id} ${runtime} validity`);
    assert.equal(verdict.phase, expected.phase, `${testCase.id} ${runtime} phase`);
    assert.equal(verdict.code, expected.code, `${testCase.id} ${runtime} code`);
    if (!expected.valid) assert.equal(verdict.status, expected.httpStatus, `${testCase.id} ${runtime} HTTP status`);
  }
  assert.deepEqual(
    { valid: node.valid, phase: node.phase, code: node.code, status: node.status },
    { valid: pythonVerdict.valid, phase: pythonVerdict.phase, code: pythonVerdict.code, status: pythonVerdict.status },
    `${testCase.id} cross-language verdict`
  );
  summary.push({ id: testCase.id, valid: node.valid, phase: node.phase, code: node.code });
}

console.log(`Node and Python agree on ${summary.length} independent v0.2 conformance cases.`);
