import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
// Loopback only: the server is reachable from outside solely through the Cloudflare tunnel.
createApp(config).listen(config.port, '127.0.0.1', () => {
  console.log(`gmail-mcp listening on 127.0.0.1:${config.port} for ${config.publicUrl.href}`);
});
