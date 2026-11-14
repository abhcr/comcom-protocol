// Capability discovery client for Comcom v0.2 / v0.2.1.
//
// Given a business HTTPS origin and an exact capability ID and version, this
// module retrieves the RFC 9727 API catalog, follows its Comcom manifest links,
// validates each manifest against its pinned profile, and reports whether the
// business advertises that it can *receive* the capability, together with the
// declared forms and the OpenAPI security requirements that apply to them.
//
// It composes existing building blocks rather than re-implementing them:
// - secureFetch: HTTPS-only retrieval with public-address checks, DNS pinning,
//   redirect limits, one deadline per retrieval, and byte limits;
// - protocol.validateDiscovery / protocol.validateManifest: strict JSON,
//   schema, pinned-profile digest, role, origin, and security-scheme checks;
// - protocol.capabilities: the pinned, digest-verified capability registry.
//
// Every listed manifest is evaluated, in a canonical order, so the result does
// not depend on catalog order. Equivalent matches yield "advertised"; differing
// matches yield "ambiguous" and no single contract is chosen.
//
// Discovery never dereferences document-supplied schema URLs and never calls a
// declared form. A discovery-only publisher's contactUrl is returned as a
// navigation link only.

import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { createProtocolV02 } from "./protocol.mjs";
import { secureFetch, UnsafeUrlError } from "./secure-fetch.mjs";

export const DISCOVERY_PATH = "/.well-known/api-catalog";
export const DISCOVERY_MAX_BYTES = 65_536;
export const MANIFEST_MAX_BYTES = 1_048_576;
// Default cost bound on distinct manifest URLs retrieved per discovery. It is a
// local policy, not a protocol limit; callers may raise it to the catalog
// schema maximum (32 linksets x 32 items) so that any valid catalog can be
// evaluated completely.
export const DEFAULT_MAX_MANIFESTS = 4;
export const MAX_MANIFESTS_LIMIT = 1024;
// Default overall budget for the catalog and all manifest retrievals. Each
// retrieval also keeps its own timeout; the smaller of the two applies.
export const DEFAULT_DEADLINE_MS = 30_000;
export const MAX_DEADLINE_MS = 600_000;

const LINKSET_TYPE = "application/linkset+json";
const MANIFEST_TYPE = "application/vnd.comcom.manifest+json";

class DiscoveryFailure extends Error {
  constructor(phase, code, message, extra = {}) {
    super(message);
    this.phase = phase;
    this.code = code;
    this.extra = extra;
  }
}

// Raised when the overall discovery deadline expires before a retrieval finishes.
class DeadlineExceeded extends Error {}

const mediaType = value => String(value ?? "").split(";")[0].trim().toLowerCase();

// Accepts "https://host[:port]" with an optional trailing "/". Anything that
// would make the origin ambiguous (path, query, fragment, credentials) fails.
export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new DiscoveryFailure("input", "invalid-origin", "origin must be an absolute HTTPS origin such as https://business.example");
  }
  if (url.protocol !== "https:") throw new DiscoveryFailure("input", "invalid-origin", "origin must use HTTPS");
  if (url.username || url.password) throw new DiscoveryFailure("input", "invalid-origin", "origin must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash || String(value).includes("#") || String(value).includes("?")) {
    throw new DiscoveryFailure("input", "invalid-origin", "origin must not contain a path, query, or fragment");
  }
  return url.origin;
}

function originOf(href) {
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

// Development-only mapping from an advertised HTTPS origin to a loopback HTTP
// origin, mirroring how the booking demo maps vendor.example to its responder.
// Exported so the interaction client maps form and status URLs identically.
export function developmentMap(value = {}) {
  const map = new Map();
  for (const [from, to] of Object.entries(value)) {
    const source = normalizeOrigin(from);
    let target;
    try {
      target = new URL(to);
    } catch {
      throw new DiscoveryFailure("input", "invalid-development-origin", `${to} is not a URL`);
    }
    if (target.protocol !== "http:" || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
      throw new DiscoveryFailure("input", "invalid-development-origin", `${to} must be an http:// loopback origin`);
    }
    map.set(source, target.origin);
  }
  return map;
}

// Returns the URL to retrieve for `href` and how to report the final URL in
// terms of the advertised HTTPS origin.
export function developmentTarget(map, href) {
  const publicOrigin = originOf(href);
  const mapped = map.get(publicOrigin);
  const parsed = new URL(href);
  return {
    mapped: Boolean(mapped),
    url: mapped ? `${mapped}${parsed.pathname}${parsed.search}` : href,
    publicUrl: finalUrl => mapped && originOf(finalUrl) === mapped ? `${publicOrigin}${finalUrl.slice(mapped.length)}` : finalUrl
  };
}

function failureFromFetch(error, phase) {
  if (error instanceof UnsafeUrlError) return new DiscoveryFailure(phase, error.code, error.message);
  return new DiscoveryFailure(phase, "fetch-failed", `Retrieval failed${error?.code ? ` (${error.code})` : ""}: ${error?.message ?? error}`);
}

function referencedSchemes(manifest, forms) {
  const names = [...new Set(forms.flatMap(form => form.security.flatMap(requirement => Object.keys(requirement))))].sort();
  return Object.fromEntries(names.map(name => [name, manifest.securitySchemes[name]]));
}

function describeForm(form) {
  return {
    href: form.href,
    method: form.method,
    contentType: form.contentType,
    executionMode: form.executionMode,
    ...(form.statusTemplate ? { statusTemplate: form.statusTemplate } : {}),
    // OpenAPI semantics: array entries are alternatives (OR); the schemes in
    // one entry are all required (AND); {} is the anonymous alternative.
    security: form.security,
    anonymousAllowed: form.security.some(requirement => Object.keys(requirement).length === 0)
  };
}

// Deterministic facts relating the declared identity and endpoints to the
// requested origin. Discovery cannot prove that a differing entity is
// legitimate; it only reports the relationship.
function identityFacts(origin, contract) {
  const formOrigins = [...new Set(contract.forms.map(form => originOf(form.href)))].sort();
  return {
    entityId: contract.entity.id,
    entityMatchesOrigin: originOf(contract.entity.id) === origin,
    externalFormOrigins: formOrigins.filter(formOrigin => formOrigin !== origin)
  };
}

const sorted = values => [...values].sort();
const canonicalSorted = values => values.map(value => canonicalize(value)).sort();

// Fingerprint of a reported contract, ignoring order where arrays are sets:
// forms, security alternatives, scopes, kinds, execution modes, roles, origins.
function contractFingerprint(contract) {
  const requirement = value => Object.fromEntries(Object.entries(value).map(([name, scopes]) => [name, sorted(scopes)]));
  return canonicalize({
    entity: contract.entity,
    roles: sorted(contract.roles),
    serviceOrigins: sorted(contract.serviceOrigins),
    limits: contract.limits,
    declaration: { ...contract.declaration, kinds: sorted(contract.declaration.kinds), executionModes: sorted(contract.declaration.executionModes) },
    forms: canonicalSorted(contract.forms.map(form => ({ ...form, security: canonicalSorted(form.security.map(requirement)) }))),
    securitySchemes: contract.securitySchemes
  });
}

// Evaluates one validated manifest for the requested capability.
function evaluateManifest(manifest, capability) {
  if (manifest.roles.includes("discoveryPublisher")) {
    return {
      outcome: "not-advertised",
      phase: "capability",
      code: "discovery-only-publisher",
      message: "The manifest is a discovery-only publisher and advertises no callable interactions"
    };
  }
  const matching = manifest.capabilities.filter(item => item.id === capability.id && item.version === capability.version);
  const declaration = matching.find(item => item.direction === "receive");
  if (!declaration) {
    return matching.length
      ? { outcome: "not-advertised", phase: "direction", code: "direction-mismatch", message: `${capability.id}@${capability.version} is declared only for sending, not for receipt` }
      : { outcome: "not-advertised", phase: "capability", code: "capability-not-advertised", message: `${capability.id}@${capability.version} is not declared by this manifest` };
  }
  return {
    outcome: "advertised",
    code: "capability-advertised",
    contract: {
      entity: manifest.entity,
      roles: manifest.roles,
      serviceOrigins: manifest.serviceOrigins,
      limits: manifest.limits,
      declaration: {
        kinds: declaration.kinds,
        executionModes: declaration.executionModes,
        inputSchema: declaration.inputSchema,
        outputSchema: declaration.outputSchema,
        anonymousCommand: declaration.anonymousCommand === true
      },
      forms: declaration.forms.map(describeForm),
      securitySchemes: referencedSchemes(manifest, declaration.forms)
    }
  };
}

// When no manifest advertises receipt, report the most specific reason.
const NOT_ADVERTISED_PRECEDENCE = ["direction-mismatch", "capability-not-advertised", "discovery-only-publisher"];

/**
 * Discover whether `origin` advertises receipt of an exact capability.
 *
 * @param {object} options
 * @param {string} options.origin HTTPS origin, e.g. "https://business.example".
 * @param {{id: string, version: string}} options.capability Exact capability ID and SemVer.
 * @param {object} [options.protocol] Instance from createProtocolV02(); created when omitted.
 * @param {number} [options.timeoutMs=10000] Deadline applied to each retrieval.
 * @param {number} [options.deadlineMs=30000] Overall deadline (1-600000) for the
 *   catalog and all manifest retrievals, starting when catalog retrieval starts.
 *   On expiry the result is a failure listing what remains unchecked.
 * @param {Function} [options.resolver] DNS resolver passed to secureFetch.
 * @param {number} [options.maxManifests=4] Maximum distinct manifest URLs to
 *   retrieve (1-1024). Larger catalogs fail closed with manifest-link-limit.
 * @param {Record<string,string>} [options.developmentOrigins] Non-conformant
 *   mapping of advertised HTTPS origins to loopback HTTP origins.
 * @returns {Promise<object>} A result whose `outcome` is "advertised",
 *   "ambiguous", "not-advertised", or "failed".
 */
export async function discoverCapability(options = {}) {
  const requested = {
    id: typeof options.capability?.id === "string" ? options.capability.id : undefined,
    version: typeof options.capability?.version === "string" ? options.capability.version : undefined
  };
  const state = {
    origin: typeof options.origin === "string" ? options.origin : undefined,
    conformant: true,
    source: { manifests: [] }
  };

  const finish = (outcome, phase, code, message, extra = {}) => ({
    outcome,
    advertised: outcome === "advertised",
    phase,
    code,
    errors: message === undefined ? [] : [{ path: "/", message }],
    conformant: state.conformant,
    origin: state.origin,
    capability: state.capability ?? requested,
    source: state.source,
    ...extra
  });

  try {
    state.origin = normalizeOrigin(options.origin);
    if (!requested.id || !requested.version) throw new DiscoveryFailure("input", "invalid-capability", "capability.id and capability.version are required");
    const maxManifests = options.maxManifests ?? DEFAULT_MAX_MANIFESTS;
    if (!Number.isSafeInteger(maxManifests) || maxManifests < 1 || maxManifests > MAX_MANIFESTS_LIMIT) {
      throw new DiscoveryFailure("input", "invalid-max-manifests", `maxManifests must be an integer from 1 to ${MAX_MANIFESTS_LIMIT}`);
    }
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) {
      throw new DiscoveryFailure("input", "invalid-deadline", `deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`);
    }
    const development = developmentMap(options.developmentOrigins);
    const protocol = options.protocol ?? await createProtocolV02();
    const registered = protocol.capabilities.get(requested.id);
    if (!registered || registered.version !== requested.version) {
      // A manifest declaring an unknown ID/version is rejected by validateManifest,
      // so discovery could never succeed; fail before any network access.
      throw new DiscoveryFailure("input", "unsupported-capability", `${requested.id}@${requested.version} is not in the pinned capability registry`);
    }
    state.capability = {
      id: registered.id,
      version: registered.version,
      profile: registered.profile,
      title: registered.title,
      requestKind: registered.requestKind,
      maturity: registered.status
    };

    let deadlineAt;
    async function retrieve(href, maxBytes, accept, phase) {
      // The per-retrieval timeout still applies; the overall deadline can only
      // shorten it. A timeout is attributed to the deadline only when the
      // deadline was the binding limit.
      const requestTimeout = options.timeoutMs ?? 10_000;
      const remaining = Math.floor(deadlineAt - performance.now());
      if (remaining <= 0) throw new DeadlineExceeded();
      const deadlineBound = remaining < requestTimeout;
      const { mapped, url: target, publicUrl } = developmentTarget(development, href);
      if (mapped) state.conformant = false;
      let response;
      try {
        response = await secureFetch(target, {
          method: "GET",
          headers: { accept },
          maxBytes,
          timeoutMs: deadlineBound ? remaining : requestTimeout,
          // Exact budget for secureFetch's checks before each DNS resolution
          // and request, which hold even when the event loop was blocked.
          deadline: deadlineAt,
          resolver: options.resolver,
          allowInsecureLoopback: Boolean(mapped)
        });
      } catch (error) {
        if (error instanceof UnsafeUrlError && error.code === "fetch-timeout" && (deadlineBound || performance.now() >= deadlineAt)) throw new DeadlineExceeded();
        throw failureFromFetch(error, phase);
      }
      if (!response.conformant) state.conformant = false;
      // Report final URLs in terms of the advertised HTTPS origin.
      return { ...response, url: publicUrl(response.url) };
    }

    // 1. RFC 9727 API catalog.
    const catalogUrl = `${state.origin}${DISCOVERY_PATH}`;
    state.source = { catalogUrl, manifests: [] };
    const deadlineFailure = (phase, unchecked, detail) => finish("failed", phase, "discovery-deadline-exceeded",
      `The ${deadlineMs} ms discovery deadline expired before ${detail}; no conclusion is drawn`, { deadlineMs, unchecked });
    deadlineAt = performance.now() + deadlineMs;
    let catalogResponse;
    try {
      catalogResponse = await retrieve(catalogUrl, DISCOVERY_MAX_BYTES, LINKSET_TYPE, "discovery");
    } catch (error) {
      if (!(error instanceof DeadlineExceeded)) throw error;
      return deadlineFailure("discovery", [{ kind: "catalog", url: catalogUrl }], "the API catalog was retrieved, so its manifest links are unknown");
    }
    state.source.redirects = catalogResponse.redirects;
    if (catalogResponse.url !== catalogUrl) state.source.catalogFinalUrl = catalogResponse.url;
    if (catalogResponse.status !== 200) throw new DiscoveryFailure("discovery", "discovery-http-status", `API catalog returned HTTP ${catalogResponse.status}`, { httpStatus: catalogResponse.status });
    // validateDiscovery skips the media-type check when no header is supplied,
    // so require it explicitly here.
    if (mediaType(catalogResponse.headers["content-type"]) !== LINKSET_TYPE) {
      throw new DiscoveryFailure("discovery", "content-type-mismatch", `API catalog must be ${LINKSET_TYPE}`);
    }
    const catalog = protocol.validateDiscovery(catalogResponse.body, { method: "GET", contentType: catalogResponse.headers["content-type"] });
    if (!catalog.valid) throw new DiscoveryFailure(catalog.phase, catalog.code, catalog.errors[0]?.message ?? "Invalid API catalog", { errors: catalog.errors });

    // 2. Manifest links whose linkset anchor belongs to the requested origin.
    // A linkset anchored elsewhere describes another context and is not
    // attributed to this business. Links are put in canonical (href, profile)
    // order so that catalog order cannot influence the result.
    const byKey = new Map();
    for (const linkset of catalog.value.linkset) {
      if (originOf(linkset.anchor) !== state.origin) continue;
      for (const item of linkset.item) byKey.set(`${item.href}\0${item.profile}`, item);
    }
    const links = [...byKey.values()].sort((a, b) => a.href < b.href ? -1 : a.href > b.href ? 1 : a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0);
    if (links.length === 0) throw new DiscoveryFailure("discovery", "manifest-link-missing", `The API catalog has no Comcom manifest link anchored at ${state.origin}`);
    const urls = [...new Set(links.map(item => item.href))];
    if (urls.length > maxManifests) {
      // Fail closed: evaluating a subset could neither prove absence nor rule
      // out a conflicting declaration.
      throw new DiscoveryFailure("discovery", "manifest-link-limit", `The API catalog lists ${urls.length} distinct manifest URLs; the limit is ${maxManifests}`, { manifestUrlCount: urls.length, maxManifests });
    }

    // 3. Retrieve each distinct URL once, then validate it under every profile
    // the catalog labels it with. Every manifest is evaluated.
    const retrieved = new Map();
    for (const url of urls) {
      try {
        // Checked before each retrieval and enforced during it by retrieve().
        const response = await retrieve(url, MANIFEST_MAX_BYTES, MANIFEST_TYPE, "manifest");
        if (response.status !== 200) throw new DiscoveryFailure("manifest", "manifest-http-status", `Manifest returned HTTP ${response.status}`, { httpStatus: response.status });
        if (mediaType(response.headers["content-type"]) !== MANIFEST_TYPE) throw new DiscoveryFailure("manifest", "content-type-mismatch", `Manifest must be ${MANIFEST_TYPE}`);
        retrieved.set(url, { response });
      } catch (error) {
        if (error instanceof DeadlineExceeded) {
          // Stop retrieving. Nothing is evaluated, so partial results cannot
          // become an advertised, ambiguous, or not-advertised conclusion.
          state.source.manifests = links.map(link => {
            const attempt = retrieved.get(link.href);
            return { url: link.href, profile: link.profile, checked: Boolean(attempt), ...(attempt?.error ? { code: attempt.error.code } : {}) };
          });
          const unchecked = links.filter(link => !retrieved.has(link.href)).map(link => ({ kind: "manifest", url: link.href, profile: link.profile }));
          return deadlineFailure("manifest", unchecked, `every manifest link was checked (${unchecked.length} of ${links.length} unchecked)`);
        }
        if (!(error instanceof DiscoveryFailure)) throw error;
        retrieved.set(url, { error });
      }
    }

    const evaluations = [];
    for (const link of links) {
      const record = { url: link.href, profile: link.profile, crossOrigin: originOf(link.href) !== state.origin };
      state.source.manifests.push(record);
      const { response, error } = retrieved.get(link.href);
      if (response) {
        if (response.url !== link.href) record.finalUrl = response.url;
        record.redirects = response.redirects;
      }
      let evaluation;
      if (error) {
        evaluation = { outcome: "failed", phase: error.phase, code: error.code, message: error.message, extra: error.extra };
      } else {
        const verdict = protocol.validateManifest(response.body, { manifestProfile: link.profile });
        if (!verdict.valid) {
          evaluation = { outcome: "failed", phase: verdict.phase, code: verdict.code, message: verdict.errors[0]?.message ?? "Invalid manifest", extra: { errors: verdict.errors } };
        } else {
          evaluation = evaluateManifest(verdict.value, requested);
          record.entity = verdict.value.entity;
          record.roles = verdict.value.roles;
          if (verdict.value.contactUrl) record.contactUrl = verdict.value.contactUrl;
        }
      }
      record.outcome = evaluation.outcome;
      record.code = evaluation.code;
      evaluations.push({ ...evaluation, record });
    }

    // 4. Conclude. A failure anywhere prevents any conclusion, because the
    // unread manifest could advertise a conflicting contract.
    const failure = evaluations.find(item => item.outcome === "failed");
    if (failure) {
      // No partial conclusions: per-manifest records keep only what was
      // checked and which manifests failed, never another manifest's outcome,
      // entity, or roles. This matches the deadline failure shape.
      state.source.manifests = evaluations.map(item => ({
        url: item.record.url,
        profile: item.record.profile,
        checked: true,
        ...(item.outcome === "failed" ? { code: item.code } : {})
      }));
      return finish("failed", failure.phase, failure.code, failure.message, { failedManifest: { url: failure.record.url, profile: failure.record.profile }, ...failure.extra });
    }

    const matches = evaluations.filter(item => item.outcome === "advertised").map(item => ({
      manifest: { url: item.record.url, profile: item.record.profile, crossOrigin: item.record.crossOrigin, ...(item.record.finalUrl ? { finalUrl: item.record.finalUrl } : {}) },
      identity: identityFacts(state.origin, item.contract),
      ...item.contract
    }));
    if (matches.length) {
      const distinct = new Set(evaluations.filter(item => item.outcome === "advertised").map(item => contractFingerprint(item.contract)));
      if (distinct.size > 1) {
        return finish("ambiguous", "capability", "ambiguous-advertisement",
          `${matches.length} manifests advertise ${requested.id}@${requested.version} with ${distinct.size} different contracts`,
          { distinctContracts: distinct.size, matches });
      }
      const { manifest, ...contract } = matches[0];
      return finish("advertised", "complete", "capability-advertised", undefined, { ...contract, matches });
    }

    const reason = NOT_ADVERTISED_PRECEDENCE.map(code => evaluations.find(item => item.code === code)).find(Boolean);
    return finish("not-advertised", reason.phase, reason.code, reason.message);
  } catch (error) {
    if (!(error instanceof DiscoveryFailure)) throw error;
    return finish("failed", error.phase, error.code, error.message, error.extra);
  }
}
