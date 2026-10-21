import { z } from 'zod';

export const READ = { readOnlyHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const account = z.string().optional().describe('Google account email to use; optional when only one is linked');
// A Google resource ID placed in a URL path. encodeURIComponent leaves "." and "..", which would
// move the request to a different endpoint.
export const id = z.string().regex(/^(?!\.\.?$)./, 'Must be a non-empty ID other than "." or ".."');

// Registers the core tools, then each enabled module's tools.
export function registerTools(server, { store, google, modules, config }) {
  const linked = () => Object.keys(store.read().accounts);

  // Maps an optional `account` argument to a linked account's email.
  function resolve(email) {
    const all = linked();
    if (email) {
      if (!all.includes(email.toLowerCase())) throw new Error(`Unknown account ${email}. Linked: ${all.join(', ')}`);
      return email.toLowerCase();
    }
    if (all.length === 1) return all[0];
    throw new Error(`Specify an account: ${all.join(', ')}`);
  }

  const tool = (name, description, inputSchema, annotations, handler) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(await handler(args), null, 2) }],
    }));

  // Accounts linked before scopes were recorded have none stored; Google decides for those.
  const granted = (email, scopes) => {
    const have = store.read().accounts[email]?.scopes;
    return !have || scopes.every((s) => have.includes(s));
  };

  tool('list_accounts', 'List linked Google accounts', {}, READ, () => linked());
  for (const m of modules) {
    // An account missing the module's scopes is an error, never silently left out of results.
    const check = (emails) => {
      const missing = emails.filter((email) => !granted(email, m.scopes));
      if (missing.length) throw new Error(`Re-link ${missing.join(', ')} with \`npm run link\` to grant ${m.name} access`);
      return emails;
    };
    const mLinked = () => check(linked());
    const mResolve = (email) => check([resolve(email)])[0];
    m.register({ google, linked: mLinked, resolve: mResolve, tool, config });
  }
}
