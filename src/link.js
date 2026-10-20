// Link or unlink Google accounts from this machine:
//   npm run link                    grant the enabled modules' scopes via a localhost redirect
//   npm run link -- --remove EMAIL  revoke and forget an account
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Google } from './google.js';
import { loadModules, scopesFor } from './modules/index.js';
import { random, sha256 } from './oauth.js';
import { Store } from './store.js';

// Starts a one-shot loopback server; returns the consent URL and a promise for the linked email.
export async function linkAccount({ google, store, port, scopes }) {
  const state = random();
  const codeVerifier = random();
  let redirectUri;
  let finish;
  const linked = new Promise((resolve, reject) => (finish = { resolve, reject }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== '/callback') return res.writeHead(404).end();
    server.close();
    try {
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) throw new Error('Invalid or cancelled sign-in');
      const { email, tokens } = await google.exchangeCode({ code: url.searchParams.get('code'), codeVerifier, redirectUri });
      const granted = tokens.scope?.split(' ') ?? [];
      const missing = scopes.filter((s) => !granted.includes(s));
      if (missing.length || !tokens.refresh_token) throw new Error(`Access not granted: ${missing.join(', ') || 'offline'}`);
      store.update(({ accounts }) => (accounts[email] = { refreshToken: tokens.refresh_token }));
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`Linked ${email}. You can close this tab.`);
      finish.resolve(email);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(e.message);
      finish.reject(e);
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  redirectUri = `http://localhost:${server.address().port}/callback`;
  return { url: google.authUrl({ redirectUri, state, codeChallenge: sha256(codeVerifier), scopes }), linked };
}

export async function unlinkAccount({ google, store, email }) {
  const account = store.read().accounts[email];
  if (!account) throw new Error(`${email} is not linked`);
  await google.revoke(account.refreshToken);
  store.update(({ accounts }) => delete accounts[email]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const store = new Store(config.dataDir, config.encryptionKey);
  const google = new Google({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, store });
  if (process.argv[2] === '--remove') {
    await unlinkAccount({ google, store, email: process.argv[3]?.toLowerCase() });
    console.log(`Unlinked ${process.argv[3]}`);
  } else {
    const { url, linked } = await linkAccount({ google, store, port: config.linkPort, scopes: scopesFor(loadModules(config.modules)) });
    console.log(`Open this URL in a browser on this machine:\n\n${url}\n`);
    console.log(`Linked ${await linked}. Linked accounts: ${Object.keys(store.read().accounts).join(', ')}`);
  }
}
