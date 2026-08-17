#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createProtocolV02 } from "./protocol.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const command = process.argv[2];
const input = await readFile(0);
const separator = input.indexOf("\n\n");
if (separator < 0) {
  console.log(JSON.stringify({ valid: false, phase: "raw", code: "cli-input-invalid", errors: [{ path: "/", message: "stdin must contain context JSON, a blank line, then raw document bytes" }] }));
  process.exit(1);
}

let context;
try {
  context = parseStrictJson(input.subarray(0, separator));
} catch (error) {
  console.log(JSON.stringify({ valid: false, phase: "raw", code: error.code ?? "cli-input-invalid", errors: [{ path: "/context", message: error.message }] }));
  process.exit(1);
}
const raw = input.subarray(separator + 2);
const protocol = await createProtocolV02();
const validators = {
  request: () => protocol.validateRequest(raw, context),
  response: () => protocol.validateResponse(raw, context),
  discovery: () => protocol.validateDiscovery(raw, context),
  manifest: () => protocol.validateManifest(raw, context),
  "release-bundle": () => protocol.validateReleaseBundle(raw, context)
};
if (!validators[command]) {
  console.log(JSON.stringify({ valid: false, phase: "raw", code: "cli-command-invalid", errors: [{ path: "/", message: "command must be request, response, discovery, manifest, or release-bundle" }] }));
  process.exit(1);
}
const verdict = validators[command]();
delete verdict.value;
delete verdict.capability;
delete verdict.declaration;
delete verdict.form;
console.log(JSON.stringify(verdict));
process.exitCode = verdict.valid ? 0 : 1;
