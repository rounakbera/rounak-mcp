# rounak-mcp

A self-hosted, modular MCP server for claude.ai (web, desktop and mobile). It runs on your own
machine and is reachable only through a Cloudflare Tunnel on your own domain. It works with multiple
Google accounts. The modules are **mail** (Gmail), **calendar** (Google Calendar) and **maps**
(saved Google Maps lists).

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
    calendar/        Google Calendar tools
    maps/            saved Google Maps list tools
test/
  helpers/           fake-google.js (the only mock), harness.js
  *.test.js          security, accounts, mail, calendar, maps, persistence
deploy/              systemd user units, install.sh, hourly update.sh
```

## Tools

- **Core:** `list_accounts`
- **mail:** `mail_search_threads` (searches all accounts by default), `mail_get_thread` (gives
  drafts' IDs too), `mail_send_email` (also handles replies), `mail_forward_message` (with
  attachments, kept in the original thread), `mail_create_draft`, `mail_list_drafts`,
  `mail_get_draft`, `mail_update_draft` (keeps the sender, reply threading, attachments, and the
  formatting unless the body changes), `mail_send_draft`, `mail_delete_draft`, `mail_list_labels`,
  `mail_modify_thread` (archive, read, star, labels), `mail_trash_thread`, `mail_trash_message`
  (one message in a thread; drafts go through `mail_delete_draft`)
- **calendar:** `calendar_list_calendars`, `calendar_list_events` (merges calendars across all
  accounts by default), `calendar_get_event`, `calendar_create_event`, `calendar_update_event`,
  `calendar_delete_event`, `calendar_respond_to_event`, `calendar_find_free_time`

Calendar tools read each account's *default* calendars unless given an `account` or `calendar_ids`
(`"primary"` means each account's main calendar). By default those are the calendars shown in Google
Calendar. Set `CALENDAR_IDS` in `.env` to choose them yourself; IDs come from `calendar_list_calendars`.
Times are ISO 8601 with an offset, or `YYYY-MM-DD` for all-day events.

### Google Maps lists

- **maps:** `maps_list_saved_lists`, `maps_search_saved` (by text, and by distance from a point)

Google has no API for saved lists, so the maps module reads lists through their share links, using
the same unauthenticated endpoint the shared-list page uses. It needs no Google account linking or
API key, but it only sees lists shared as "Anyone with the link", and that format is undocumented:
if Google changes it, the tools return an error until the parser is updated. Lists are cached for
5 minutes.

To add a list, share it in Google Maps and copy the link. Its ID is the part between `!2s` and the
next `!` in the URL the link redirects to:

```bash
curl -sI https://maps.app.goo.gl/<code> | grep -io '!2s[^!]*' | cut -c4-
```

Put the IDs in `MAPS_LIST_IDS` in `.env` and add `maps` to `MODULES`.

Accounts are linked and unlinked only on the host machine, with `npm run link` and
`npm run link -- --remove <email>`, never through the public server.

## Modules

A module is a folder in `src/modules/` whose `index.js` default-exports two things:

```js
export default {
  scopes: ['https://www.googleapis.com/auth/tasks.readonly'], // Google scopes it needs
  register({ google, linked, resolve, tool, config }) {
    tool('tasks_list_lists', 'List task lists', { account }, READ, async (args) => {
      const email = resolve(args.account);
      return google.request(email, 'GET', `${google.endpoints.tasks}/users/@me/lists`);
    });
  },
};
```

`npm run link` records each account's granted scopes. If an account is missing the module's scopes,
`linked()` and `resolve()` throw an error saying to re-link it, so it's never silently left out of
results. Accounts linked before scopes were recorded count as granted, and Google has the final say.

To add one:
1. Register it in `src/modules/index.js`.
2. If it calls a new Google API, add that API's base URL to `GOOGLE_ENDPOINTS` in `src/google.js`.
3. Turn it on with `MODULES=mail,calendar,tasks` in `.env`.
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
- The mail module's scope is `gmail.modify`: read, send, label and trash, but no settings changes.
  The only permanent delete is of drafts; messages and threads can only go to Trash.
- The calendar module's scopes are `calendar.events`, `calendar.calendarlist.readonly` and
  `calendar.freebusy`: it can read and edit events, but it can't create, delete or share calendars.
  Inviting attendees shares an event's details with them; `send_updates` only controls whether
  they're also emailed.
- Sending (including sending a draft), forwarding, trashing, changing or deleting drafts, and
  every calendar write (creating, changing, deleting and responding to events) are marked
  `destructiveHint`, so Claude asks before doing them. Each of these either can reach people
  outside the account or can't be undone. Changing a draft counts because it can quietly change
  who the draft goes to when you later send it from Gmail.
- Forwarded attachments' names and types come from the original sender, so they're sanitised before
  going into MIME headers, and forwards are capped at Gmail's 25 MB attachment limit. The approval
  prompt for a forward shows the message ID, not its contents, so check what's being forwarded,
  especially when the request came from an email.
- Creating a draft doesn't need approval, so `mail_send_draft` must be given the draft's To, Cc and
  Bcc, and refuses to send if they don't match. The approval prompt therefore shows where the draft
  goes; check its text with `mail_get_draft` before approving.
- IDs placed in Google API URLs are validated and encoded, and `.` and `..` are rejected, so a tool
  call can't move its request to a different endpoint.
- The maps module's tools are read-only. They fetch only the lists in `MAPS_LIST_IDS` (validated at
  startup) from a fixed google.com URL, never a URL from tool input. Responses are capped at 10 MB
  with a 10-second timeout, and the list owner's name and account ID in them are dropped. Anyone
  with a list's share link can see that list. Place names, notes and list names reach Claude as
  data, and whoever owns a list can change them, so only add lists you own or trust.

**Secrets**
- `.env` and `data/` are git-ignored. A pre-commit hook (`.githooks/`, turned on by `npm install`)
  also refuses to commit them, or anything that looks like a Google secret, tunnel token or private key.
  CI repeats the tracked-file check, and GitHub secret scanning with push protection is turned on.

## Contributing

See [AGENTS.md](AGENTS.md): branch, open a PR, pass CI, squash merge.

## Setup

### 1. Google Cloud (browser, once)
1. Create a project and enable the API for each module you'll use (mail: **Gmail API**;
   calendar: **Google Calendar API**; maps needs none).
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

Logs: `journalctl --user -u rounak-mcp -u cloudflared-rounak-mcp -u rounak-mcp-update -f`

**Auto-update:** a timer checks hourly for new commits on `main`. When it finds them, it
fast-forwards, runs `npm ci` and `npm test`, and restarts the server; if tests fail, it rolls back.
It skips while the checkout isn't a clean `main`, so local development is never touched. Run it now
with `systemctl --user start rounak-mcp-update`. Changes to unit files in `deploy/` still need
`./deploy/install.sh`.

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
