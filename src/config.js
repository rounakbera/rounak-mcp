const REQUIRED = [
  'PUBLIC_URL',
  'OWNER_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MCP_CLIENT_ID',
  'MCP_CLIENT_SECRET',
  'ENCRYPTION_KEY',
];

// claude.ai's OAuth callbacks; override with REDIRECT_URIS (comma-separated) if they change.
export const CLAUDE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || env[k].includes('REPLACE_ME'));
  if (missing.length) throw new Error(`Missing or placeholder values in .env: ${missing.join(', ')}`);

  const encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  if (env.MCP_CLIENT_SECRET.length < 32) throw new Error('MCP_CLIENT_SECRET must be at least 32 characters');

  // List IDs go into a URL parameter Google splits on "!", so allow only ID characters.
  const mapsListIds = env.MAPS_LIST_IDS ? env.MAPS_LIST_IDS.split(',').map((id) => id.trim()).filter(Boolean) : [];
  if (mapsListIds.some((id) => !/^[\w-]+$/.test(id))) throw new Error('MAPS_LIST_IDS must be comma-separated Google Maps list IDs');

  const publicUrl = new URL(env.PUBLIC_URL);
  if (publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL must be https');

  const modules = (env.MODULES || 'mail').split(',').map((m) => m.trim());
  if (modules.includes('maps') && !mapsListIds.length) throw new Error('The maps module needs MAPS_LIST_IDS');

  return {
    publicUrl,
    port: Number(env.PORT || 8787),
    linkPort: Number(env.LINK_PORT || 8788),
    modules,
    mapsListIds,
    calendarIds: env.CALENDAR_IDS ? env.CALENDAR_IDS.split(',').map((c) => c.trim()).filter(Boolean) : null,
    ownerEmail: env.OWNER_EMAIL.toLowerCase(),
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    mcpClientId: env.MCP_CLIENT_ID,
    mcpClientSecret: env.MCP_CLIENT_SECRET,
    redirectUris: env.REDIRECT_URIS ? env.REDIRECT_URIS.split(',').map((u) => u.trim()) : CLAUDE_REDIRECT_URIS,
    encryptionKey,
    dataDir: env.DATA_DIR || './data',
  };
}
