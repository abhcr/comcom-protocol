import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const base = "https://abhcr.github.io/comcom-protocol/releases/";
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const files = new Map();
files.set("profiles/manifest", "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Comcom v0.2.1 manifest profile</title><h1>Comcom v0.2.1 manifest profile</h1><p>Experimental discovery publishers and existing v0.2 interaction manifests.</p><p><a href=\"../schemas/manifest.schema.json\">Pinned JSON Schema</a> · <a href=\"../../../spec/v0.2.1/discovery.md\">Specification</a></p></html>\n");
const legacy = JSON.parse(await readFile(resolve(root, "releases/v0.2.0/schema-bundle.json"), "utf8"));
const schemas = { ...legacy.$defs };
for (const name of (await readdir(resolve(root, "schemas/v0.2.1"))).sort()) {
  const contents = await readFile(resolve(root, "schemas/v0.2.1", name), "utf8");
  files.set(`schemas/${name}`, contents);
  schemas[`v021_${name.replace(".schema.json", "")}`] = JSON.parse(contents);
}
files.set("schema-bundle.json", json({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${base}v0.2.1/schema-bundle.json`,
  $defs: schemas
}));
files.set("offline-bundle.json", json({
  release: "v0.2.1",
  protocolVersion: "0.2",
  resources: { "schema-bundle.json": JSON.parse(files.get("schema-bundle.json")) }
}));
const entries = [...files].map(([path, contents]) => ({
  path,
  mediaType: path === "profiles/manifest" ? "text/html" : path.startsWith("schemas/") ? "application/schema+json" : "application/json",
  bytes: Buffer.byteLength(contents),
  sha256: createHash("sha256").update(contents).digest("hex")
})).sort((left, right) => left.path.localeCompare(right.path));
files.set("release-manifest.json", json({
  release: "v0.2.1",
  protocolVersion: "0.2",
  maturity: "experimental",
  createdAt: "2026-10-04T00:00:00Z",
  files: entries,
  treeSha256: createHash("sha256").update(entries.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex")
}));
for (const [path, contents] of files) {
  const target = resolve(root, "releases/v0.2.1", path);
  if (check) {
    if (await readFile(target, "utf8") !== contents) throw new Error(`${path} differs from the v0.2.1 sources`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
console.log(`${check ? "Verified" : "Built"} v0.2.1 discovery artifacts; v0.2.0 remains unchanged.`);
