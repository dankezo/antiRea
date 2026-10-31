/** Demo-only Node HTTP integration: run `npm run build && node examples/node-canary-server.cjs`.
 * Bind to localhost; put production traffic behind TLS, authentication and an edge proxy.
 */
const http = require('node:http');
const { handleCanaryTrapRequest } = require('../dist/index.js');
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const result = await handleCanaryTrapRequest({
    url: `http://localhost:${port}${req.url || '/'}`,
    method: req.method,
    headers: { get: k => req.headers[k.toLowerCase()]?.toString() ?? null },
  }, {
    onAlert: event => console.warn('[canary]', JSON.stringify({ path:event.path, at:event.timestamp })),
    // Demo has no login: never derive an account ID from untrusted headers.
  });
  res.writeHead(result.isTrapped ? result.status : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result.isTrapped ? result.body : { error: 'not_found' }));
}).listen(port, '127.0.0.1', () => console.log(`Canary demo: http://127.0.0.1:${port}`));
