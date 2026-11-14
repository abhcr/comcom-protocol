// DEVELOPMENT ONLY. Mocked authentication and mocked responder identity for
// the local booking demo.
//
// The demo responder (server.mjs) trusts these headers instead of real
// credentials. This module is used only by demo.mjs and tests; the interaction
// client never imports it. Production callers supply an `authenticate` hook
// that obtains real credentials (OAuth tokens, mutual TLS, ...).

const MOCK_TOKEN = "Bearer demo-only-not-a-real-token";

/**
 * @param {object} options
 * @param {string} options.senderId Identity the mocked transport asserts.
 * @param {string[]} options.scopes Scopes the mocked token carries.
 * @param {string[]} options.localOrigins Advertised origins mapped to loopback.
 *   The mocked token is never attached to a form outside these origins.
 */
export function createDemoAuthenticator({ senderId, scopes, localOrigins }) {
  const allowed = new Set(localOrigins);
  return async ({ form, securitySchemes }) => {
    if (!allowed.has(new URL(form.href).origin)) return null;
    // Satisfy the first alternative made of OAuth 2.0 schemes whose required
    // scopes the mocked token carries. Anonymous alternatives are not used.
    for (const requirement of form.security) {
      const entries = Object.entries(requirement);
      if (!entries.length) continue;
      if (entries.every(([name, required]) => securitySchemes[name]?.type === "oauth2" && required.every(scope => scopes.includes(scope)))) {
        return {
          senderId,
          scheme: entries.map(([name]) => name),
          scopes,
          headers: {
            authorization: MOCK_TOKEN,
            "x-comcom-sender": senderId,
            "x-comcom-scopes": scopes.join(" ")
          }
        };
      }
    }
    return null;
  };
}

/**
 * Mocked trusted responder identity for the local demo. A production
 * `responderIdentity` hook derives this from the authenticated transport (for
 * example the verified TLS server identity); here the demo states it
 * explicitly, because loopback HTTP authenticates nothing.
 *
 * @param {Record<string,string>} identities Locally mapped origin -> identity
 *   the mocked transport vouches for. Any other origin has no identity.
 */
export function createDemoResponderIdentity(identities) {
  const trusted = new Map(Object.entries(identities));
  return async ({ origin }) => trusted.get(origin) ?? null;
}
