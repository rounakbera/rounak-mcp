# gmail-mcp

A self-hosted, multi-account Gmail MCP server for claude.ai (web and mobile). It runs on this
desktop and is reachable only through a Cloudflare Tunnel on your own domain.

```
Claude (phone/web) → claude.ai → https://mail-mcp.<domain> → Cloudflare → tunnel (outbound-only)
  → cloudflared → 127.0.0.1:$PORT (this server) → Gmail API
```

Dependencies: `@modelcontextprotocol/sdk`, plus `express` and `zod`, which the SDK already pulls in.
Google OAuth and Gmail are called with plain `fetch`.

## Tools

`list_accounts`, `link_account`, `unlink_account`, `search_threads` (across all accounts by default),
`get_thread`, `send_email` (also handles replies), `create_draft`, `list_labels`, `modify_thread`
(archive, read, star, labels), `trash_thread`.

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
- You sign in with Google, and only `OWNER_EMAIL` is accepted. Any other account gets a `403`, and
  its Google grant is revoked right away.
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
3. Create an OAuth client of type **Web application** with this authorized redirect URI:
   `https://mail-mcp.<domain>/oauth/google/callback`.

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

Sign in with `OWNER_EMAIL`; that account is linked automatically. To add another account, ask Claude
to "link another Gmail account" and open the one-time URL it gives you. The connector then works in
the Claude mobile app as well.

## Tests

`npm test` runs end-to-end tests. They start the real app and connect with the real MCP SDK client,
going through the whole OAuth flow. The only fake is `test/fake-google.js`, a local HTTP server that
stands in for Google OAuth and the Gmail API.
