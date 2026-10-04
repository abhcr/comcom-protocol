import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
for (const [release, schemaDirectory] of [["v0.2.0", "v0.2"], ["v0.2.1", "v0.2.1"]]) {
  const manifest = JSON.parse(await readFile(resolve(root, `releases/${release}/release-manifest.json`), "utf8"));

  function sourceFor(path) {
    if (path.startsWith("profiles/v0.2/")) return resolve(root, path);
    if (path.startsWith("schemas/")) return resolve(root, `schemas/${schemaDirectory}`, path.slice("schemas/".length));
    return resolve(root, `releases/${release}`, path);
  }

  for (const file of manifest.files) {
    const bytes = await readFile(sourceFor(file.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== file.bytes || digest !== file.sha256) throw new Error(`${file.path} differs from the ${release} release manifest`);
  }
  const tree = createHash("sha256").update(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
  if (tree !== manifest.treeSha256) throw new Error(`${release} release tree digest differs`);
  if ((await stat(resolve(root, `releases/${release}/offline-bundle.json`))).size > 16_777_216) throw new Error("offline bundle exceeds 16 MiB");
  if (release === "v0.2.0") {
    const registry = await readFile(resolve(root, "registry/v0.2/capabilities.json"));
    const expected = manifest.files.find(file => file.path === "registry.json");
    if (registry.length !== expected.bytes || createHash("sha256").update(registry).digest("hex") !== expected.sha256) throw new Error("Working registry differs from the pinned v0.2.0 registry");
  }
  console.log(`Verified ${manifest.files.length} ${release} release files (${tree}).`);
}
