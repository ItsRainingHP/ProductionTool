// Streaming reverse-proxy regression tests.
const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { createProxyServer } = require("./http-proxy.cjs");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("streams an upload larger than 10 MB to the API and routes pages to Next", async () => {
  let uploaded = 0;
  const api = http.createServer((request, response) => {
    request.on("data", (chunk) => { uploaded += chunk.length; });
    request.on("end", () => response.writeHead(202).end("accepted"));
  });
  const web = http.createServer((_request, response) => response.end("web"));
  const apiPort = await listen(api);
  const webPort = await listen(web);
  const proxy = createProxyServer({ apiPort, webPort });
  const port = await listen(proxy);
  try {
    const bytes = 11 * 1024 * 1024;
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/v1/jobs/id/source", method: "PUT", headers: { "Content-Length": bytes } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      const chunk = Buffer.alloc(64 * 1024, 65);
      for (let remaining = bytes; remaining > 0; remaining -= chunk.length) request.write(chunk.subarray(0, Math.min(remaining, chunk.length)));
      request.end();
    });
    assert.equal(result, 202);
    assert.equal(uploaded, bytes);
    const page = await fetch(`http://127.0.0.1:${port}/wizard`);
    assert.equal(await page.text(), "web");
  } finally {
    await Promise.all([api, web, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
