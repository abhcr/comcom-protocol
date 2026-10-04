import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
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
  for (const marker of ['rel="canonical"', 'name="description"', 'property="og:title"', 'name="twitter:card"']) {
    assert.ok(html.includes(marker), `${path} is missing ${marker}`);
  }
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:https?:|#|mailto:)/.test(href)) continue;
    const clean = href.split(/[?#]/)[0];
    let target = clean.startsWith("./releases/") ? resolve(root, clean.slice(2)) : resolve(dirname(path), clean);
    if (!extname(target)) target = resolve(target, "index.html");
    await readFile(target).catch(() => { throw new Error(`${path} has broken local link ${href}`); });
  }
}
const browser = { window: {}, TextEncoder, TextDecoder };
runInNewContext(await readFile(resolve(docs, "validator.bundle.js"), "utf8"), browser);
const checker = browser.window.comcomOffline;
const newProfile = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest";
for (const [name, example] of Object.entries(checker.examples)) {
  const type = name === "legacy-manifest" ? "manifest" : name;
  const verdict = checker.validate(type, JSON.stringify(example), { manifestProfile: newProfile });
  assert.equal(verdict.valid, true, `${name}: ${JSON.stringify(verdict)}`);
}
assert.equal(checker.validate("manifest", JSON.stringify(checker.examples.manifest)).valid, false);
assert.equal(checker.validate("manifest", JSON.stringify(checker.examples["legacy-manifest"])).valid, true);
assert.equal(checker.validate("manifest", JSON.stringify(checker.examples.manifest), { manifestProfile: "https://untrusted.example/schema" }).code, "unsupported-manifest-profile");
assert.equal(checker.validate("manifest", JSON.stringify(checker.examples["legacy-manifest"]), { manifestProfile: null }).code, "unsupported-manifest-profile");
for (const contactUrl of ["http://purplecore.in/", "https://user:password@purplecore.in/", "javascript:alert(1)"]) {
  assert.equal(checker.validate("manifest", JSON.stringify({ ...checker.examples.manifest, contactUrl }), { manifestProfile: newProfile }).valid, false);
}
assert.equal(checker.validate("manifest", JSON.stringify({ ...checker.examples.manifest, serviceOrigins: [] }), { manifestProfile: newProfile }).valid, false);
for (const [id, type] of [["discovery", "discovery"], ["manifest-snippet", "manifest"], ["request-snippet", "request"], ["result-snippet", "response"]]) {
  const encoded = index.match(new RegExp(`<pre id="${id}"><code>([\\s\\S]*?)</code></pre>`))[1];
  const raw = encoded.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const verdict = checker.validate(type, raw);
  assert.equal(verdict.valid, true, `${id}: ${JSON.stringify(verdict)}`);
}
assert.ok(index.includes('id="load-example"'));
assert.ok(index.includes('id="manifest-profile"'));
const sitemap = await readFile(resolve(docs, "sitemap.xml"), "utf8");
assert.equal((sitemap.match(/<loc>/g) ?? []).length, htmlPaths.length);
console.log("Verified all bundled examples, copyable documents, and pinned browser profile selection.");
console.log(`Verified accessibility markers and local links across ${htmlPaths.length} HTML pages.`);
