import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createProtocol } from "../reference/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const readJson = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const protocol = await createProtocol();
const failures = [];

if (!protocol.validateRegistry(protocol.registry)) failures.push({ artifact: "registry", errors: protocol.validateRegistry.errors });

const discovery = await readJson("examples/.well-known/comcom");
if (!protocol.validateDiscovery(discovery)) failures.push({ artifact: "discovery", errors: protocol.validateDiscovery.errors });

const manifest = await readJson("examples/manifest.json");
if (!protocol.validateManifest(manifest)) failures.push({ artifact: "manifest", errors: protocol.validateManifest.errors });

const validFixtures = await readJson("fixtures/v0.1/valid.json");
for (const fixture of validFixtures) {
  const validate = protocol.ajv.getSchema(fixture.schema);
  if (!validate?.(fixture.instance)) failures.push({ artifact: fixture.capability, expected: "valid", errors: validate?.errors });
}

const invalidFixtures = await readJson("fixtures/v0.1/invalid.json");
for (const fixture of invalidFixtures) {
  const validate = protocol.ajv.getSchema(fixture.schema);
  if (validate?.(fixture.instance)) failures.push({ artifact: fixture.capability, expected: "invalid" });
}

const duplicateIds = protocol.registry.capabilities
  .map(capability => capability.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateIds.length) failures.push({ artifact: "registry", duplicateIds });

if (protocol.registry.capabilities.length < 150 || protocol.registry.capabilities.length > 250) {
  failures.push({ artifact: "registry", error: "Capability count must be between 150 and 250." });
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Validated discovery, manifest, ${protocol.registry.capabilities.length} capabilities, ${validFixtures.length} positive fixtures, and ${invalidFixtures.length} negative fixtures.`);
}
