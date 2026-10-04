import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import "./verify-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const registry = JSON.parse(await readFile(resolve(root, "registry/v0.2/capabilities.json"), "utf8"));

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

const schemaPaths = [
  ...(await walk(resolve(root, "schemas/v0.2"))),
  ...(await walk(resolve(root, "schemas/v0.2.1"))),
  ...(await walk(resolve(root, "profiles/v0.2")))
].filter(path => path.endsWith(".schema.json")).sort();
const schemas = await Promise.all(schemaPaths.map(async path => JSON.parse(await readFile(path, "utf8"))));
const examples = {};
for (const [name, path] of Object.entries({
  discovery: "examples/v0.2.1/purplecore-api-catalog.json",
  manifest: "examples/v0.2.1/purplecore-manifest.json",
  "legacy-manifest": "examples/v0.2/vendor-manifest.json",
  request: "examples/v0.2/booking-create.request.json",
  response: "examples/v0.2/booking-create.result.json",
  "release-manifest": "releases/v0.2.0/release-manifest.json"
})) examples[name] = JSON.parse(await readFile(resolve(root, path), "utf8"));
const result = await build({
  entryPoints: [resolve(root, "site/browser-validator.mjs")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  plugins: [{
    name: "validation-data",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^comcom:validation-data$/ }, () => ({ path: "validation-data", namespace: "comcom" }));
      buildApi.onLoad({ filter: /.*/, namespace: "comcom" }, () => ({
        contents: `export const registry=${JSON.stringify(registry)};export const schemas=${JSON.stringify(schemas)};export const examples=${JSON.stringify(examples)};`,
        loader: "js"
      }));
    }
  }]
});

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const json = value => escape(JSON.stringify(value, null, 2));
const outputs = new Map([["docs/validator.bundle.js", result.outputFiles[0].contents]]);
const siteUrl = "https://abhcr.github.io/comcom-protocol/";
const metadata = (title, description, path) => `<meta name="description" content="${escape(description)}"><link rel="canonical" href="${siteUrl}${path}"><meta property="og:type" content="website"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${siteUrl}${path}"><meta name="twitter:card" content="summary">`;
const cards = [];
const sitemapPaths = ["", "evaluate.html", "capabilities/"];
for (const capability of registry.capabilities) {
  const slug = capability.id.replaceAll(".", "-");
  sitemapPaths.push(`capabilities/${slug}.html`);
  const directory = resolve(root, capability.source);
  const examples = {
    request: JSON.parse(await readFile(resolve(directory, "examples/valid-request.json"), "utf8")),
    lifecycle: JSON.parse(await readFile(resolve(directory, "examples/lifecycle.json"), "utf8")),
    reversal: JSON.parse(await readFile(resolve(directory, "examples/reversal.json"), "utf8"))
  };
  const standards = capability.standards.map(url => `<li><a href="${escape(url)}">${escape(url)}</a></li>`).join("");
  const transitions = capability.lifecycle.transitions.length
    ? capability.lifecycle.transitions.map(transition => `<tr><td>${escape(transition.from)}</td><td>${escape(transition.to)}</td><td>${transition.revisionRequired ? "revision required" : "allowed"}</td></tr>`).join("")
    : `<tr><td colspan="3">This capability does not change resource lifecycle state.</td></tr>`;
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(capability.title)} · Comcom</title>${metadata(`${capability.title} · Comcom`, `${capability.purpose} Experimental draft capability ${capability.id}.`, `capabilities/${slug}.html`)}<link rel="stylesheet" href="../styles.css"></head>
<body><a class="skip" href="#content">Skip to content</a><header class="subhead"><nav aria-label="Primary"><a class="mark" href="../"><span>CC</span> Comcom</a><div><a href="./">All capabilities</a><a href="../#checker">Validate</a><a href="https://github.com/abhcr/comcom-protocol">GitHub</a></div></nav></header>
<main id="content" class="detail"><p class="notice"><strong>Draft v0.2 profile.</strong> Catalog presence is not normative status.</p><p class="eyebrow">${escape(capability.profile)} · ${escape(capability.status)}</p><h1>${escape(capability.title)}</h1><p class="lead dark">${escape(capability.purpose)}</p>
<dl class="facts"><div><dt>Capability</dt><dd><code>${escape(capability.id)}@${escape(capability.version)}</code></dd></div><div><dt>Kind</dt><dd>${escape(capability.requestKind)}</dd></div><div><dt>Security floor</dt><dd>${escape(capability.minimumSecurity)}</dd></div><div><dt>Execution</dt><dd>${escape(capability.executionModes.join(", "))}</dd></div></dl>
<section><h2>Schemas</h2><ul><li><a href="${escape(capability.schemas.input)}">Input schema</a></li><li><a href="${escape(capability.schemas.output)}">Output schema</a></li><li><a href="${escape(capability.schemas.resource)}">Resource schema</a></li></ul><h3>Valid payload</h3><pre><code>${json(examples.request)}</code></pre></section>
<section><h2>Lifecycle and reversal</h2><div class="table-scroll"><table><thead><tr><th>From</th><th>To</th><th>Rule</th></tr></thead><tbody>${transitions}</tbody></table></div><h3>Reversal</h3><pre><code>${json(examples.reversal)}</code></pre></section>
<section><h2>Errors and mappings</h2><p>${capability.errors.map(error => `<code>${escape(error)}</code>`).join(" · ")}</p><ul>${standards}</ul></section>
<section><h2>Evidence</h2><p>Domain review: <strong>${capability.evidence.domainReview.completed ? "complete" : "incomplete"}</strong>. Security review: <strong>${capability.evidence.securityReview.completed ? "complete" : "incomplete"}</strong>. Interoperability journeys: <strong>${capability.evidence.interoperabilityJourneys.length}</strong>.</p><p><a href="https://github.com/abhcr/comcom-protocol/tree/main/${escape(capability.source)}">Inspect authored source and fixtures</a></p></section></main><footer><a href="./">Back to all 201 capabilities</a></footer></body></html>`;
  outputs.set(`docs/capabilities/${slug}.html`, Buffer.from(page));
  cards.push(`<li><a href="./${slug}.html"><code>${escape(capability.id)}</code><strong>${escape(capability.title)}</strong><span>${escape(capability.profile)} · ${escape(capability.status)}</span></a></li>`);
}
outputs.set("docs/capabilities/index.html", Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>All capabilities · Comcom</title>${metadata("All capabilities · Comcom", "Inspect 201 experimental draft business capabilities, schemas, lifecycle rules, and evidence.", "capabilities/")}<link rel="stylesheet" href="../styles.css"></head><body><a class="skip" href="#content">Skip to content</a><header class="subhead"><nav><a class="mark" href="../"><span>CC</span> Comcom</a><div><a href="../#checker">Validate</a><a href="https://github.com/abhcr/comcom-protocol">GitHub</a></div></nav></header><main id="content" class="detail"><p class="notice"><strong>All 201 profiles are draft.</strong> They are not globally normative until their evidence gates pass.</p><p class="eyebrow">Complete no-JavaScript catalog</p><h1>Capability profiles</h1><ul class="fallback-list">${cards.join("")}</ul></main></body></html>`));

outputs.set("docs/sitemap.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map(path => `  <url><loc>${siteUrl}${path}</loc></url>`).join("\n")}\n</urlset>\n`));

for (const [path, contents] of outputs) {
  const target = resolve(root, path);
  if (check) {
    const existing = await readFile(target).catch(() => null);
    if (!existing || !existing.equals(contents)) throw new Error(`${path} is not current`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
console.log(`${check ? "Verified" : "Built"} the offline validator and ${registry.capabilities.length} capability pages.`);
