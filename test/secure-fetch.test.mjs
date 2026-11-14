import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { secureFetch } from "../reference/v0.2/secure-fetch.mjs";

test("the total deadline includes DNS that never resolves", { timeout: 1000 }, async () => {
  await assert.rejects(secureFetch("https://example.com", {
    timeoutMs: 25,
    resolver: () => new Promise(() => {})
  }), { code: "fetch-timeout" });
});

test("a continuously arriving body cannot extend the total deadline", { timeout: 2000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200);
    response.write("start");
    const interval = setInterval(() => response.write("."), 10);
    request.on("close", () => clearInterval(interval));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(secureFetch(`http://127.0.0.1:${server.address().port}/`, {
    allowInsecureLoopback: true,
    timeoutMs: 60
  }), { code: "fetch-timeout" });
});

test("redirects share the original deadline", { timeout: 2000 }, async t => {
  const server = createServer((request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(302, { location: "/next" });
      response.end();
    }, 40);
    request.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(secureFetch(`http://127.0.0.1:${server.address().port}/`, {
    allowInsecureLoopback: true,
    timeoutMs: 70
  }), { code: "fetch-timeout" });
});

test("a DNS hostname uses the pinned address with Node's address selection", async t => {
  const server = createServer((request, response) => response.end("pinned"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await secureFetch(`http://localhost:${server.address().port}/`, {
    allowInsecureLoopback: true,
    resolver: async () => [{ address: "127.0.0.1", family: 4 }]
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "pinned");
});

test("a lookup that blocks past the timeout and then returns starts no request, including on a redirect hop", { timeout: 5000 }, async t => {
  const requests = [];
  const connections = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/") response.writeHead(302, { location: "/next" });
    response.end("ok");
  });
  server.on("connection", () => connections.push(requests.length));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://localhost:${server.address().port}/`;
  const blockOn = call => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls === call) { const until = performance.now() + 300; while (performance.now() < until); }
      return [{ address: "127.0.0.1", family: 4 }];
    };
  };

  // The server shares this process, so let it handle anything already sent.
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(secureFetch(url, { allowInsecureLoopback: true, timeoutMs: 100, resolver: blockOn(1) }), { code: "fetch-timeout" });
  await settle();
  assert.deepEqual([requests, connections], [[], []], "first hop: no connection or request");

  await assert.rejects(secureFetch(url, { allowInsecureLoopback: true, timeoutMs: 10_000, deadline: performance.now() + 100, resolver: blockOn(2) }), { code: "fetch-timeout" });
  await settle();
  assert.deepEqual(requests, ["/"], "redirect hop: /next was never requested");
});

test("an already expired deadline stops retrieval before DNS resolution", async () => {
  let lookups = 0;
  await assert.rejects(secureFetch("https://example.com/", {
    deadline: performance.now() - 1,
    resolver: async () => { lookups += 1; return [{ address: "93.184.215.14", family: 4 }]; }
  }), { code: "fetch-timeout" });
  assert.equal(lookups, 0);
});
