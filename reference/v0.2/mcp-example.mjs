// Runnable MCP example without an AI model.
//
// Starts the local booking responder, launches the Comcom MCP server over
// stdio with the local demo configuration, and calls both tools with the
// official MCP client, exactly as an agent host would. Verifies that no
// booking request is sent and no credential appears in any response.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createComcomV02Server } from "./server.mjs";

const here = new URL(".", import.meta.url);
const BOOKING = { id: "comcom.booking.create", version: "0.2.0" };

const responder = await createComcomV02Server({ port: 0 });
await responder.start();
const posts = [];
responder.server.on("request", request => { if (request.method === "POST") posts.push(request.url); });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("mcp-server.mjs", here).pathname, "--config", new URL("mcp-demo.config.mjs", here).pathname],
  env: { ...process.env, COMCOM_DEMO_RESPONDER: `http://127.0.0.1:${responder.server.address().port}` },
  stderr: "pipe"
});
const client = new Client({ name: "comcom-mcp-example", version: "0.2.1" });
console.log("Comcom MCP example: stdio server, loopback responder, mocked authentication; no AI model involved.");

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["discover_capabilities", "prepare_request"]);
  console.log(`PASS tools/list: ${tools.map(tool => tool.name).join(", ")}`);

  const discovered = await client.callTool({ name: "discover_capabilities", arguments: { origin: "https://vendor.example", capabilities: [BOOKING] } });
  const [result] = discovered.structuredContent.results;
  assert.equal(result.outcome, "advertised", JSON.stringify(result));
  console.log(`PASS discover_capabilities: ${BOOKING.id}@${BOOKING.version} advertised with ${result.forms.length} forms; payload schema returned`);

  const example = JSON.parse(await readFile(new URL("../../examples/v0.2/booking-create.request.json", import.meta.url)));
  const payload = structuredClone(example.payload);
  payload.parameters.booking.start = new Date(Date.now() + 86_400_000).toISOString();
  payload.parameters.booking.end = new Date(Date.now() + 88_200_000).toISOString();
  const prepared = await client.callTool({
    name: "prepare_request",
    arguments: { origin: "https://vendor.example", capability: BOOKING, principal: example.principal, payload }
  });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared.structuredContent));
  const { preview } = prepared.structuredContent;
  console.log(`PASS prepare_request: validated ${preview.request.kind} to ${preview.endpoint.method} ${preview.endpoint.href}, ${preview.bodyBytes} bytes, sha256 ${preview.bodySha256.slice(0, 16)}…`);
  console.log(JSON.stringify({ request: preview.request, authentication: preview.authentication, trustedResponderIdentity: preview.trustedResponderIdentity }, null, 2));

  assert.equal(JSON.stringify([discovered, prepared]).includes("demo-only-not-a-real-token"), false);
  assert.deepEqual(posts, []);
  console.log("PASS no booking request was sent and no credential appeared in any response");
} finally {
  await client.close();
  await responder.close();
}
