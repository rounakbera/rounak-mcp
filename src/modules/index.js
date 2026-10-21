// Tool modules. Each exports { scopes, register(ctx) } and is enabled by name via MODULES in .env.
import calendar from './calendar/index.js';
import mail from './mail/index.js';
import maps from './maps/index.js';

const MODULES = { calendar, mail, maps };

export function loadModules(names) {
  return names.map((name) => {
    if (!MODULES[name]) throw new Error(`Unknown module "${name}". Available: ${Object.keys(MODULES).join(', ')}`);
    return { name, ...MODULES[name] };
  });
}

export const scopesFor = (modules) => [...new Set(modules.flatMap((m) => m.scopes))];
