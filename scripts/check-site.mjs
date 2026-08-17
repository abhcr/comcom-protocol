import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docs = resolve(root, "docs");

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

const htmlPaths = (await walk(docs)).filter(path => path.endsWith(".html"));
if (htmlPaths.filter(path => path.includes("/capabilities/")).length !== 202) throw new Error("site must contain 201 detail pages and one complete catalog page");
const index = await readFile(resolve(docs, "index.html"), "utf8");
for (const required of ["class=\"skip\"", "Experimental v0.2 line", "not an IANA-registered", "<noscript>", "id=\"checker\"", "validator.bundle.js"]) {
  if (!index.includes(required)) throw new Error(`site index is missing ${required}`);
}
if ((index.match(/aria-live=/g) ?? []).length !== 1) throw new Error("only the result count may be an ARIA live region");

for (const path of htmlPaths) {
  const html = await readFile(path, "utf8");
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:https?:|#|mailto:)/.test(href)) continue;
    const clean = href.split(/[?#]/)[0];
    let target = clean.startsWith("./releases/") ? resolve(root, clean.slice(2)) : resolve(dirname(path), clean);
    if (!extname(target)) target = resolve(target, "index.html");
    await readFile(target).catch(() => { throw new Error(`${path} has broken local link ${href}`); });
  }
}
console.log(`Verified accessibility markers and local links across ${htmlPaths.length} HTML pages.`);
