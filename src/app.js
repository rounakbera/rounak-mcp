import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { Auth } from './auth.js';
import { Google, GOOGLE_ENDPOINTS } from './google.js';
import { Store } from './store.js';
import { registerTools } from './tools.js';

export function createApp(config, { googleEndpoints = GOOGLE_ENDPOINTS } = {}) {
  const store = new Store(config.dataDir, config.encryptionKey);
  const google = new Google({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: new URL('/oauth/google/callback', config.publicUrl).href,
    endpoints: googleEndpoints,
    store,
  });
  const auth = new Auth({ config, store, google });
  const mcpUrl = new URL('/mcp', config.publicUrl);

  const app = express();
  app.disable('x-powered-by');
  // cloudflared connects from loopback; trust its X-Forwarded-For so rate limits apply per real client.
  app.set('trust proxy', 'loopback');

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

  // The SDK only reads client credentials from the form body; also accept HTTP Basic (RFC 6749 2.3.1).
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false, limit: '10kb' }), (req, _res, next) => {
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() === 'basic' && value) {
      const decoded = Buffer.from(value, 'base64').toString();
      const i = decoded.indexOf(':');
      req.body ??= {};
      req.body.client_id ??= decodeURIComponent(decoded.slice(0, i));
      req.body.client_secret ??= decodeURIComponent(decoded.slice(i + 1));
    }
    next();
  });

  app.use(mcpAuthRouter({ provider: auth, issuerUrl: config.publicUrl, resourceServerUrl: mcpUrl }));
  app.get('/oauth/google/callback', auth.googleCallback);

  const bearer = requireBearerAuth({
    verifier: auth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    // Stateless: a fresh server and transport per request.
    const server = new McpServer({ name: 'gmail', version: '1.0.0' });
    registerTools(server, { store, google, auth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

  app.use((_req, res) => res.status(404).end());
  // Never leak stack traces.
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).end());
  return app;
}
