import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilesRoot = resolve(root, "profiles/v0.2");
const check = process.argv.includes("--check");
const requiredFiles = [
  "definition.json",
  "evidence.json",
  "schemas/input.schema.json",
  "schemas/output.schema.json",
  "schemas/resource.schema.json",
  "examples/valid-request.json",
  "examples/invalid-request.json",
  "examples/lifecycle.json",
  "examples/reversal.json"
];

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

const sourceFiles = (await walk(profilesRoot)).sort();
const definitionPaths = sourceFiles.filter(path => path.endsWith("/definition.json"));
const v01 = JSON.parse(await readFile(resolve(root, "registry/v0.1/capabilities.json"), "utf8"));
const v01Ids = v01.capabilities.map(capability => capability.id).sort();
const capabilities = [];

for (const definitionPath of definitionPaths) {
  const directory = dirname(definitionPath);
  for (const required of requiredFiles) {
    if (!sourceFiles.includes(resolve(directory, required))) throw new Error(`${relative(root, directory)} is missing ${required}`);
  }
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  const evidence = JSON.parse(await readFile(resolve(directory, "evidence.json"), "utf8"));
  const schemas = {};
  for (const name of ["input", "output", "resource"]) {
    schemas[name] = JSON.parse(await readFile(resolve(directory, `schemas/${name}.schema.json`), "utf8"));
    if (JSON.stringify(schemas[name]).includes('"additionalProperties":true')) throw new Error(`${definition.id} contains an open business object`);
  }
  if (definition.version !== "0.2.0" || evidence.version !== "0.2.0") throw new Error(`${definition.id} does not use exact version 0.2.0`);
  if (definition.status === "normative") {
    const complete = evidence.domainReview.completed && evidence.securityReview.completed &&
      evidence.implementations.includes("node") && evidence.implementations.includes("python") &&
      evidence.interoperabilityJourneys.length >= 2 && evidence.conformanceDigests.length > 0;
    if (!complete) throw new Error(`${definition.id} is normative without complete evidence`);
  }
  capabilities.push({ ...definition, source: relative(root, directory).replaceAll("\\", "/"), evidence });
}

capabilities.sort((left, right) => left.id.localeCompare(right.id));
const ids = capabilities.map(capability => capability.id);
if (capabilities.length !== 201 || JSON.stringify(ids) !== JSON.stringify(v01Ids)) {
  throw new Error("v0.2 must preserve exactly the 201 v0.1 capability IDs");
}
const batchCounts = Object.fromEntries([2, 3, 4, 5, 6].map(batch => [batch, capabilities.filter(capability => capability.batch === batch).length]));
if (JSON.stringify(batchCounts) !== JSON.stringify({ 2: 39, 3: 48, 4: 42, 5: 38, 6: 34 })) throw new Error("profile batch counts differ from the release plan");

const outputs = new Map();
const json = value => `${JSON.stringify(value, null, 2)}\n`;
outputs.set("registry/v0.2/capabilities.json", json({
  protocolVersion: "0.2",
  capabilityVersion: "0.2.0",
  maturity: "experimental",
  capabilityCount: capabilities.length,
  capabilities
}));

const kernelPaths = (await walk(resolve(root, "schemas/v0.2"))).filter(path => path.endsWith(".json")).sort();
const kernelSchemas = [];
for (const path of kernelPaths) kernelSchemas.push(JSON.parse(await readFile(path, "utf8")));
outputs.set("releases/v0.2.0/schema-bundle.json", json({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schema-bundle.json",
  $defs: Object.fromEntries(kernelSchemas.map(schema => [schema.$id.split("/").at(-1).replace(".schema.json", ""), schema]))
}));

const profiles = [...new Set(capabilities.map(capability => capability.profile))].sort();
for (const profile of profiles) {
  const members = capabilities.filter(capability => capability.profile === profile);
  const resources = [];
  const authored = [];
  for (const member of members) {
    const directory = resolve(root, member.source);
    for (const name of ["input", "output", "resource"]) resources.push(JSON.parse(await readFile(resolve(directory, `schemas/${name}.schema.json`), "utf8")));
    authored.push({
      definition: Object.fromEntries(Object.entries(member).filter(([name]) => !["source", "evidence"].includes(name))),
      evidence: member.evidence,
      examples: Object.fromEntries(await Promise.all(["valid-request", "invalid-request", "lifecycle", "reversal"].map(async name => [name, JSON.parse(await readFile(resolve(directory, `examples/${name}.json`), "utf8"))])))
    });
  }
  outputs.set(`releases/v0.2.0/profiles/${profile}.bundle.json`, json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/${profile}.bundle.json`,
    profile,
    version: "0.2.0",
    capabilityIds: members.map(member => member.id),
    capabilities: authored,
    $defs: Object.fromEntries(resources.map(schema => [schema.$id.replace("https://abhcr.github.io/comcom-protocol/releases/v0.2.0/", "").replaceAll("/", "__"), schema]))
  }));
}

outputs.set("releases/v0.2.0/registry.json", outputs.get("registry/v0.2/capabilities.json"));
const corpusRoot = resolve(root, "conformance/v0.2");
const corpus = JSON.parse(await readFile(resolve(corpusRoot, "cases.json"), "utf8"));
const documents = {};
for (const testCase of corpus.cases) {
  if (!documents[testCase.document]) documents[testCase.document] = (await readFile(resolve(corpusRoot, testCase.document))).toString("base64");
}
outputs.set("releases/v0.2.0/conformance-corpus.json", json({
  ...corpus,
  documentEncoding: "base64",
  documents,
  contextSources: {
    manifest: JSON.parse(await readFile(resolve(root, "examples/v0.2/vendor-manifest.json"), "utf8")),
    request: JSON.parse(await readFile(resolve(root, "examples/v0.2/booking-create.request.json"), "utf8"))
  }
}));
const offlineEntries = Object.fromEntries([...outputs]
  .filter(([path]) => path.startsWith("releases/v0.2.0/"))
  .map(([path, contents]) => [path.replace("releases/v0.2.0/", ""), JSON.parse(contents)]));
const sourceEntries = {};
const sourceContents = {};
for (const path of [...kernelPaths, ...sourceFiles].sort()) {
  if (!path.endsWith(".json")) continue;
  const sourcePath = relative(root, path).replaceAll("\\", "/");
  const releasePath = sourcePath.startsWith("schemas/v0.2/") ? sourcePath.replace("schemas/v0.2/", "schemas/") : sourcePath;
  const contents = await readFile(path, "utf8");
  sourceEntries[releasePath] = JSON.parse(contents);
  sourceContents[releasePath] = contents;
}
outputs.set("releases/v0.2.0/offline-bundle.json", json({
  release: "v0.2.0",
  protocolVersion: "0.2",
  resources: offlineEntries,
  authoredSources: sourceEntries
}));
const manifestFiles = [];
for (const [path, contents] of [...outputs].sort(([left], [right]) => left.localeCompare(right))) {
  if (!path.startsWith("releases/v0.2.0/") || path.endsWith("release-manifest.json")) continue;
  manifestFiles.push({
    path: path.replace("releases/v0.2.0/", ""),
    mediaType: "application/json",
    bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex")
  });
}
for (const path of Object.keys(sourceEntries)) {
  const contents = sourceContents[path];
  manifestFiles.push({
    path,
    mediaType: path.includes("/schemas/") || path.startsWith("schemas/") ? "application/schema+json" : "application/json",
    bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex")
  });
}
manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
const treeSha256 = createHash("sha256").update(manifestFiles.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
outputs.set("releases/v0.2.0/release-manifest.json", json({
  release: "v0.2.0",
  protocolVersion: "0.2",
  maturity: "experimental",
  createdAt: "2026-08-17T00:00:00Z",
  files: manifestFiles,
  treeSha256
}));

for (const [path, contents] of outputs) {
  const target = resolve(root, path);
  if (check) {
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing !== contents) throw new Error(`${path} is not generated from the committed v0.2 profile sources`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

console.log(`${check ? "Verified" : "Built"} ${capabilities.length} v0.2 profiles and ${outputs.size} mechanical artifacts.`);
