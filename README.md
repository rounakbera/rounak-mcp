# rounak-mcp

A self-hosted, modular MCP server for claude.ai (web, desktop and mobile). It runs on your own
machine and is reachable only through a Cloudflare Tunnel on your own domain. It works with multiple
Google accounts. The first module is **mail** (Gmail).

```
Claude (phone/desktop/web) → claude.ai → https://mcp.<domain> → Cloudflare → tunnel (outbound-only)
  → cloudflared → 127.0.0.1:$PORT (this server) → Google APIs
```

Dependencies: `@modelcontextprotocol/sdk`, plus `express` and `zod`, which the SDK already pulls in.
Google APIs are called with plain `fetch`.

## Layout

```
src/
  main.js            server entry point: listens on 127.0.0.1
  link.js            `npm run link` CLI: link/unlink Google accounts via a localhost redirect
  app.js             Express app: host check, security headers, OAuth router, /mcp
  oauth.js           OAuth 2.1 provider for claude.ai, with owner-only Google sign-in
  google.js          Google OAuth + authenticated API requests per linked account
  tools.js           tool helpers, account resolution, the core `list_accounts` tool
  config.js          env parsing and validation
  store.js           encrypted state file
  modules/
    index.js         module registry
    mail/            Gmail tools (index.js) and MIME handling (mime.js)
test/
  helpers/           fake-google.js (the only mock), harness.js
  *.test.js          security, accounts, mail, persistence
deploy/              systemd user units + install.sh
```

## Tools

- **Core:** `list_accounts`
- **mail:** `mail_search_threads` (searches all accounts by default), `mail_get_thread`,
  `mail_send_email` (also handles replies), `mail_create_draft`, `mail_list_labels`,
  `mail_modify_thread` (archive, read, star, labels), `mail_trash_thread`

Accounts are linked and unlinked only on the host machine, with `npm run link` and
`npm run link -- --remove <email>`, never through the public server.

## Modules

A module is a folder in `src/modules/` whose `index.js` default-exports two things:

```js
export default {
  scopes: ['https://www.googleapis.com/auth/calendar'], // Google scopes it needs
  register({ google, linked, resolve, tool }) {
    tool('calendar_list_events', 'List upcoming events', { account }, READ, async (args) => {
      const email = resolve(args.account);
      return google.request(email, 'GET', `${google.endpoints.calendar}/calendars/primary/events`);
    });
  },
};
```

To add one:
1. Register it in `src/modules/index.js`.
2. If it calls a new Google API, add that API's base URL to `GOOGLE_ENDPOINTS` in `src/google.js`.
3. Turn it on with `MODULES=mail,calendar` in `.env`.
4. Run `npm run link` again for each account, so the account grants the new scopes.

Prefix each tool name with the module name.

## Configuration

Everything deployment-specific (domain, emails, ports, credentials, enabled modules) lives in `.env`,
and no tracked file contains any of it. See [`.env.example`](.env.example) for every variable. The
server won't start while any value is still `REPLACE_ME`.

## Security model

**Network**
- The server listens on `127.0.0.1` only. No router ports are open, and your home IP never shows up
  in DNS. The tunnel connects outbound to Cloudflare.
- Every request must carry the public `Host` header (anything else gets a `421`). This blocks DNS
  rebinding and anything that didn't come through the tunnel.
- `cloudflared` runs with only `TUNNEL_TOKEN` in its environment, and the app runs without it.

**Authentication** (OAuth 2.1, the SDK's auth router)
- There's exactly one confidential client, claude.ai, with a secret from `.env`. Dynamic client
  registration is turned off. claude.ai holds the connection for all of your devices.
- Redirects are allowed only to claude.ai's callback. PKCE (S256) is required, both for Claude
  connecting to this server and for this server signing in to Google.
- You sign in with Google, and only `OWNER_EMAIL` is accepted; any other account gets a `403`. This
  sign-in asks only for `openid email`. API access is granted separately, through `npm run link`.
- Codes and states are single-use and expire after 10 minutes. Access tokens last 1 hour and live
  only in memory. Refresh tokens last 30 days and rotate on every use. All of them are stored only
  as SHA-256 hashes.
- The SDK rate-limits the auth endpoints. Responses use `no-store`, a strict CSP, and never include
  stack traces.

**Data**
- Linked accounts' Google refresh tokens live in `$DATA_DIR/state.enc` (AES-256-GCM, file mode `0600`).
- The mail module's scope is `gmail.modify`: read, send, label and trash, but no permanent delete and
  no settings changes.
- Sending and trashing are marked `destructiveHint`, so Claude asks before doing them.

**Secrets**
- `.env` and `data/` are git-ignored. A pre-commit hook (`.githooks/`, turned on by `npm install`)
  also refuses to commit them, or anything that looks like a Google secret, tunnel token or private key.
  CI repeats the tracked-file check, and GitHub secret scanning with push protection is turned on.

## Contributing

See [AGENTS.md](AGENTS.md): branch, open a PR, pass CI, squash merge.

## Setup

### 1. Google Cloud (browser, once)
1. Create a project and enable the API for each module you'll use (mail: **Gmail API**).
2. In the OAuth consent screen, choose External. Then set the **publishing status to "In production"**.
   If you leave it in Testing, Google expires refresh tokens after 7 days. You'll see an "unverified
   app" warning when you sign in; that's expected for a personal app.
3. Create an OAuth client of type **Web application** with two authorized redirect URIs:
   - `https://mcp.<domain>/oauth/google/callback` (connector sign-in)
   - `http://localhost:<LINK_PORT>/callback` (`npm run link`; default port 8788)

### 2. Cloudflare Tunnel (browser, once)
1. Go to Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared).
2. Add a public hostname `mcp.<domain>` with service `http://127.0.0.1:<PORT>`. Leave "HTTP Host
   Header" unset.
3. Copy the tunnel token into `.env`.

**Optional hardening (recommended):** add a WAF custom rule (Security → WAF) that only lets
Anthropic's backend reach the machine-to-machine endpoints. The two browser-facing paths stay open
for your phone:

```
(http.host eq "mcp.<domain>"
 and not ip.src in {160.79.104.0/21}
 and not http.request.uri.path in {"/authorize" "/oauth/google/callback"})
```
Action: **Block**. `160.79.104.0/21` is Anthropic's published outbound range
(https://platform.claude.com/docs/en/api/ip-addresses), so check that page from time to time.

### 3. This machine
```bash
sudo apt install cloudflared   # https://pkg.cloudflare.com/
npm install
$EDITOR .env                   # replace every REPLACE_ME (generation commands are inline)
npm test
npm run link                   # once per Google account; pick the account in Google's chooser
./deploy/install.sh            # systemd user units for the server + tunnel
sudo loginctl enable-linger $USER
```
WSL: to keep the VM running, set `vmIdleTimeout=-1` under `[wsl2]` in `%UserProfile%\.wslconfig`,
and start WSL when Windows logs in.

Logs: `journalctl --user -u rounak-mcp -u cloudflared-rounak-mcp -f`

### 4. claude.ai (once)
Go to Settings → Connectors → **Add custom connector**:
- URL: `https://mcp.<domain>/mcp`
- Advanced settings: enter `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`

Sign in with `OWNER_EMAIL`. The connector then works in every Claude app you're signed in to, and
claude.ai refreshes its token in the background.

## Tests

`npm test` runs end-to-end tests. They start the real app and connect with the real MCP SDK client,
going through the whole OAuth flow and the `npm run link` flow. The only fake is
`test/helpers/fake-google.js`, a local HTTP server that stands in for Google OAuth and its APIs.
