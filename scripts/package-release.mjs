import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv[2];
const stageBatch = {
  "v0.2.0-alpha.1": 1,
  "v0.2.0-alpha.2": 2,
  "v0.2.0-alpha.3": 3,
  "v0.2.0-alpha.4": 4,
  "v0.2.0-alpha.5": 5,
  "v0.2.0-alpha.6": 6,
  "v0.2.0-beta.1": 6,
  "v0.2.0-rc.1": 6,
  "v0.2.0": 6
};
if (release === "v0.2.1") {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [resolve(root, "scripts/build-v0.2.1.mjs"), "--check"], { stdio: "inherit" });
  execFileSync(process.execPath, [resolve(root, "scripts/verify-release.mjs")], { stdio: "inherit" });
  await cp(resolve(root, "releases/v0.2.1"), resolve(root, "dist/v0.2.1"), { recursive: true });
  console.log("Packaged v0.2.1 discovery artifacts with unchanged v0.2.0 schema dependencies.");
  process.exit(0);
}
if (!stageBatch[release]) throw new Error("release must be one of the planned v0.2 tags");

const target = resolve(root, "dist", release);
await mkdir(resolve(target, "profiles"), { recursive: true });
const registry = JSON.parse(await readFile(resolve(root, "registry/v0.2/capabilities.json"), "utf8"));
const capabilities = registry.capabilities.filter(capability => capability.batch <= stageBatch[release]);
const selectedProfiles = new Set(capabilities.map(capability => capability.profile));
const assets = new Map();
assets.set("schema-bundle.json", await readFile(resolve(root, "releases/v0.2.0/schema-bundle.json"), "utf8"));
assets.set("registry.json", `${JSON.stringify({ ...registry, capabilityCount: capabilities.length, capabilities }, null, 2)}\n`);

for (const name of (await readdir(resolve(root, "releases/v0.2.0/profiles"))).sort()) {
  const profile = name.replace(".bundle.json", "");
  if (selectedProfiles.has(profile)) assets.set(`profiles/${name}`, await readFile(resolve(root, "releases/v0.2.0/profiles", name), "utf8"));
}
const corpus = JSON.parse(await readFile(resolve(root, "releases/v0.2.0/conformance-corpus.json"), "utf8"));
const cases = corpus.cases.filter(testCase => testCase.applicableProfile === "kernel" || selectedProfiles.has(testCase.applicableProfile));
const documentNames = new Set(cases.map(testCase => testCase.document));
assets.set("conformance-corpus.json", `${JSON.stringify({
  ...corpus,
  cases,
  documents: Object.fromEntries(Object.entries(corpus.documents).filter(([name]) => documentNames.has(name)))
}, null, 2)}\n`);
assets.set("offline-bundle.json", `${JSON.stringify({
  release,
  protocolVersion: "0.2",
  resources: Object.fromEntries([...assets].map(([path, contents]) => [path, JSON.parse(contents)]))
}, null, 2)}\n`);

const files = [...assets].map(([path, contents]) => ({
  path,
  mediaType: "application/json",
  bytes: Buffer.byteLength(contents),
  sha256: createHash("sha256").update(contents).digest("hex")
})).sort((left, right) => left.path.localeCompare(right.path));
const treeSha256 = createHash("sha256").update(files.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
const createdAt = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString();
assets.set("release-manifest.json", `${JSON.stringify({ release, protocolVersion: "0.2", maturity: "experimental", createdAt, files, treeSha256 }, null, 2)}\n`);

for (const [path, contents] of assets) {
  await mkdir(dirname(resolve(target, path)), { recursive: true });
  await writeFile(resolve(target, path), contents);
}
console.log(`Packaged ${release}: ${capabilities.length} capabilities, ${selectedProfiles.size} profiles, ${cases.length} conformance cases (${treeSha256}).`);
