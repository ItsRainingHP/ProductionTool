// Stream API requests directly to uvicorn and other requests to Next.js.
// Author: Brent Coleman
// Copyright (c) 2026 Brent Coleman
// SPDX-License-Identifier: MIT

const http = require("node:http");

function createProxyServer({ apiPort = 8000, webPort = 3001 } = {}) {
  return http.createServer((client, response) => {
    const api = client.url === "/api" || client.url?.startsWith("/api/") || client.url?.startsWith("/api?");
    const port = api ? apiPort : webPort;
    const upstream = http.request({
      hostname: "127.0.0.1",
      port,
      method: client.method,
      path: client.url,
      headers: { ...client.headers, host: `127.0.0.1:${port}` },
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Service unavailable");
    });
    client.on("aborted", () => upstream.destroy());
    client.pipe(upstream);
  });
}

if (require.main === module) {
  createProxyServer({
    apiPort: Number(process.env.API_PORT ?? 8000),
    webPort: Number(process.env.WEB_PORT ?? 3001),
  }).listen(Number(process.env.PORT ?? 3000), process.env.PROXY_HOST ?? "0.0.0.0");
}

module.exports = { createProxyServer };
