import { z } from 'zod';

export const READ = { readOnlyHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const account = z.string().optional().describe('Google account email to use; optional when only one is linked');

// Registers the core tools, then each enabled module's tools.
export function registerTools(server, { store, google, modules }) {
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

  tool('list_accounts', 'List linked Google accounts', {}, READ, () => linked());
  for (const m of modules) m.register({ google, linked, resolve, tool });
}
