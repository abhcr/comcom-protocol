// DEVELOPMENT ONLY. MCP server configuration for the local booking demo.
//
// Identity and authentication are server-side settings; MCP tool callers
// cannot override them. This demo uses the mocked transport from demo-auth.mjs
// and maps https://vendor.example to a loopback responder
// (COMCOM_DEMO_RESPONDER, default http://127.0.0.1:8788, as started by
// `node reference/v0.2/server.mjs`).
//
// A production configuration supplies real `authenticate` (credentials) and
// `responderIdentity` (identity verified by the transport) hooks and no
// developmentOrigins.
import { createDemoAuthenticator, createDemoResponderIdentity } from "./demo-auth.mjs";

const VENDOR = "https://vendor.example";

export default {
  sender: { id: "https://buyer.example", type: "organization" },
  agent: { id: "https://buyer.example/software/comcom-mcp", type: "software", name: "Comcom MCP server (local demo)" },
  developmentOrigins: { [VENDOR]: process.env.COMCOM_DEMO_RESPONDER ?? "http://127.0.0.1:8788" },
  authenticate: createDemoAuthenticator({ senderId: "https://buyer.example", scopes: ["booking:create"], localOrigins: [VENDOR] }),
  responderIdentity: createDemoResponderIdentity({ [VENDOR]: VENDOR }),
  discovery: { deadlineMs: 10_000 }
};
