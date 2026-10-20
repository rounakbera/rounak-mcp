# gmail-mcp

A self-hosted, multi-account Gmail MCP server for claude.ai (web and mobile). It runs on this
desktop and is reachable only through a Cloudflare Tunnel on your own domain.

```
Claude (phone/web) → claude.ai → https://mail-mcp.<domain> → Cloudflare → tunnel (outbound-only)
  → cloudflared → 127.0.0.1:$PORT (this server) → Gmail API
```

Dependencies: `@modelcontextprotocol/sdk`, plus `express` and `zod`, which the SDK already pulls in.
Google OAuth and Gmail are called with plain `fetch`.

## Layout

```
src/
  main.js      server entry point: listens on 127.0.0.1
  link.js      `npm run link` CLI: link/unlink Gmail accounts via a localhost redirect
  app.js       Express app: host check, security headers, OAuth router, /mcp
  oauth.js     OAuth 2.1 provider for claude.ai, with owner-only Google sign-in
  google.js    Google OAuth + Gmail REST client
  tools.js     MCP tools
  mime.js      Gmail message parsing and MIME building
  config.js    env parsing and validation
  store.js     encrypted state file
test/
  helpers/             fake-google.js (the only mock), harness.js
  *.test.js            security, accounts, mail, persistence
deploy/                systemd user units + install.sh
```

## Tools

`list_accounts`, `search_threads` (across all accounts by default), `get_thread`, `send_email`
(also handles replies), `create_draft`, `list_labels`, `modify_thread` (archive, read, star, labels),
`trash_thread`.

Accounts are linked and unlinked only on this machine, with `npm run link` and
`npm run link -- --remove <email>`, never through the public server.

## Configuration

Everything deployment-specific (domain, emails, ports, credentials) lives in `.env`, and no tracked
file contains any of it. See [`.env.example`](.env.example) for every variable. The server won't
start while any value is still `REPLACE_ME`.

## Security model

**Network**
- The server listens on `127.0.0.1` only. No router ports are open, and your home IP never shows up
  in DNS. The tunnel connects outbound to Cloudflare.
- Every request must carry the public `Host` header (anything else gets a `421`). This blocks DNS
  rebinding and anything that didn't come through the tunnel.
- `cloudflared` runs with only `TUNNEL_TOKEN` in its environment, and the app runs without it.

**Authentication** (OAuth 2.1, the SDK's auth router)
- There's exactly one confidential client, claude.ai, with a secret from `.env`. Dynamic client
  registration is turned off.
- Redirects are allowed only to claude.ai's callback. PKCE (S256) is required, both for Claude
  connecting to this server and for this server signing in to Google.
- You sign in with Google, and only `OWNER_EMAIL` is accepted; any other account gets a `403`. This
  sign-in asks only for `openid email`. Gmail access is granted separately, through `npm run link`.
- Codes and states are single-use and expire after 10 minutes. Access tokens last 1 hour and live
  only in memory. Refresh tokens last 30 days and rotate on every use. All of them are stored only
  as SHA-256 hashes.
- The SDK rate-limits the auth endpoints. Responses use `no-store`, a strict CSP, and never include
  stack traces.

**Data**
- Linked accounts' Google refresh tokens live in `data/state.enc` (AES-256-GCM, file mode `0600`).
- The Gmail scope is `gmail.modify`: read, send, label and trash, but no permanent delete and no
  settings changes.
- Sending and trashing are marked `destructiveHint`, so Claude asks before doing them.

**Secrets**
- `.env` and `data/` are git-ignored. A pre-commit hook (`.githooks/`, turned on by `npm install`)
  also refuses to commit them, or anything that looks like a Google secret, tunnel token or private key.

## Setup

### 1. Google Cloud (browser)
1. Create a project and enable the **Gmail API**.
2. In the OAuth consent screen, choose External. Then set the **publishing status to "In production"**.
   If you leave it in Testing, Google expires refresh tokens after 7 days. You'll see an "unverified
   app" warning when you sign in; that's expected for a personal app.
3. Create an OAuth client of type **Web application** with two authorized redirect URIs:
   - `https://mail-mcp.<domain>/oauth/google/callback` (connector sign-in)
   - `http://localhost:<LINK_PORT>/callback` (`npm run link`; default port 8788)

### 2. Cloudflare Tunnel (browser)
1. Go to Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared).
2. Add a public hostname `mail-mcp.<domain>` with service `http://127.0.0.1:<PORT>`. Leave "HTTP Host
   Header" unset.
3. Copy the tunnel token into `.env`.

**Optional hardening (recommended):** add a WAF custom rule (Security → WAF) that only lets
Anthropic's backend reach the machine-to-machine endpoints. The two browser-facing paths stay open
for your phone:

```
(http.host eq "mail-mcp.<domain>"
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
npm run link                   # once per Gmail account; open the printed URL on this machine
./deploy/install.sh            # systemd user units for the server + tunnel
sudo loginctl enable-linger $USER
```
WSL: to keep the VM running, set `vmIdleTimeout=-1` under `[wsl2]` in `%UserProfile%\.wslconfig`,
and start WSL when Windows logs in.

Logs: `journalctl --user -u gmail-mcp -u cloudflared-gmail-mcp -f`

### 4. claude.ai
Go to Settings → Connectors → **Add custom connector**:
- URL: `https://mail-mcp.<domain>/mcp`
- Advanced settings: enter `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`

Sign in with `OWNER_EMAIL` once. The connector then works in the Claude mobile app too, and claude.ai
refreshes its token in the background.

## Tests

`npm test` runs end-to-end tests. They start the real app and connect with the real MCP SDK client,
going through the whole OAuth flow and the `npm run link` flow. The only fake is `test/helpers/fake-google.js`, a local HTTP server that
stands in for Google OAuth and the Gmail API.
