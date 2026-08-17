import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frozenRoots = ["schemas/v0.1", "registry/v0.1", "fixtures/v0.1", "spec/v0.1"];
const manifestPath = resolve(root, "releases/v0.1.0/sha256.json");

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

const paths = (await Promise.all(frozenRoots.map(path => walk(resolve(root, path)))))
  .flat()
  .map(path => relative(root, path).replaceAll("\\", "/"))
  .sort();
const files = [];
for (const path of paths) {
  const bytes = await readFile(resolve(root, path));
  files.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const treeSha256 = createHash("sha256")
  .update(files.map(file => `${file.path}\0${file.sha256}\n`).join(""))
  .digest("hex");
const current = { sourceCommit: "733a344", status: "experimental-prototype", treeSha256, files };

if (process.argv.includes("--write")) {
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Recorded ${files.length} frozen v0.1 files (${treeSha256}).`);
} else {
  const recorded = JSON.parse(await readFile(manifestPath, "utf8"));
  if (JSON.stringify(recorded) !== JSON.stringify(current)) {
    console.error("Frozen v0.1 artifacts differ from releases/v0.1.0/sha256.json.");
    process.exitCode = 1;
  } else {
    console.log(`Verified ${files.length} frozen v0.1 files (${treeSha256}).`);
  }
}
