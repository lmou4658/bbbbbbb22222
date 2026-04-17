import http from "http";

const PORT = Number(process.env.PORT ?? 3000);
const TARGET = "http://localhost:8080";

const server = http.createServer((req, res) => {
  const options = {
    hostname: "localhost",
    port: 8080,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", (err) => {
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  });

  req.pipe(proxy, { end: true });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Portal proxy listening on port ${PORT} → ${TARGET}`);
});
