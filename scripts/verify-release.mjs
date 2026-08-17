import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "releases/v0.2.0/release-manifest.json"), "utf8"));

function sourceFor(path) {
  if (path.startsWith("profiles/v0.2/")) return resolve(root, path);
  if (path.startsWith("schemas/")) return resolve(root, "schemas/v0.2", path.slice("schemas/".length));
  return resolve(root, "releases/v0.2.0", path);
}

for (const file of manifest.files) {
  const bytes = await readFile(sourceFor(file.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== file.bytes || digest !== file.sha256) throw new Error(`${file.path} differs from the v0.2.0 release manifest`);
}
const tree = createHash("sha256").update(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
if (tree !== manifest.treeSha256) throw new Error("v0.2.0 release tree digest differs");
if ((await stat(resolve(root, "releases/v0.2.0/offline-bundle.json"))).size > 16_777_216) throw new Error("offline bundle exceeds 16 MiB");
console.log(`Verified ${manifest.files.length} v0.2.0 release files (${tree}).`);
