// Tool modules. Each exports { scopes, register(ctx) } and is enabled by name via MODULES in .env.
import mail from './mail/index.js';

const MODULES = { mail };

export function loadModules(names) {
  return names.map((name) => {
    if (!MODULES[name]) throw new Error(`Unknown module "${name}". Available: ${Object.keys(MODULES).join(', ')}`);
    return MODULES[name];
  });
}

export const scopesFor = (modules) => [...new Set(modules.flatMap((m) => m.scopes))];
