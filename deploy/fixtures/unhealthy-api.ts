import http from "node:http";
// Test-only entry point: Compose keeps the API process alive while real HTTP health requests fail.
http
  .createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"ok":false}');
  })
  .listen(Number(process.env.API_PORT), process.env.API_HOST);
