import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { Google } from './google.js';
import { OAuth } from './oauth.js';
import { Store } from './store.js';
import { loadModules } from './modules/index.js';
import { registerTools } from './tools.js';

export function createApp(config, { googleEndpoints } = {}) {
  const store = new Store(config.dataDir, config.encryptionKey);
  const google = new Google({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    endpoints: googleEndpoints,
    store,
  });
  const oauth = new OAuth({ config, store, google });
  const modules = loadModules(config.modules);
  const mcpUrl = new URL('/mcp', config.publicUrl);

  const app = express();
  app.disable('x-powered-by');
  // cloudflared connects from loopback; trust its X-Forwarded-For so rate limits apply per real client.
  app.set('trust proxy', 'loopback');

  // Access log without query strings, which carry OAuth codes and state.
  app.use((req, res, next) => {
    res.on('finish', () => {
      const rpc = [req.body].flat().map((m) => m?.method).filter(Boolean).join(',');
      const version = req.headers['mcp-protocol-version'];
      console.log([req.method, req.originalUrl.split('?')[0], res.statusCode, rpc, version && `v${version}`].filter(Boolean).join(' '));
    });
    next();
  });

  app.use((req, res, next) => {
    // Only serve the public hostname: blocks DNS rebinding and anything not routed via the tunnel.
    if (req.headers.host !== config.publicUrl.host) return res.status(421).end();
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });

  app.use(mcpAuthRouter({ provider: oauth, issuerUrl: config.publicUrl, resourceServerUrl: mcpUrl }));
  app.get('/oauth/google/callback', oauth.googleCallback);

  const bearer = requireBearerAuth({ verifier: oauth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    // Stateless: a fresh server and transport per request.
    const server = new McpServer({ name: 'rounak-mcp', version: '1.0.0' });
    registerTools(server, { store, google, modules, config });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

  // Anything else: 404 with no body, and never a stack trace.
  app.use((_req, res) => res.status(404).end());
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).end());
  return app;
}
