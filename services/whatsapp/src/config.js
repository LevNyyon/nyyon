import './env.js';

export const PORT = Number(process.env.PORT || 2785);

// No default key.
//
// This used to fall back to a literal 'dev-admin-key'. That is survivable in
// one private deployment and indefensible in something people install: every
// copy would ship the same credential, so knowing it once would mean knowing
// it everywhere, on a service that can read and send somebody's WhatsApp.
// scripts/setup.mjs generates a random key per install and writes it to both
// this gateway and the worker, so there is nothing for anyone to paste and
// nothing shared between installs. Refusing to boot without one is the point:
// a gateway that silently accepted a known key would be worse than a gateway
// that does not start.
export const API_KEY = process.env.API_KEY || '';
if (!API_KEY) {
  console.error(
    '[wa-gateway] refusing to start: API_KEY is not set.\n' +
    '  Run "npm run setup" in the command center, which generates one.',
  );
  process.exit(1);
}

// 'default' rather than a hardcoded UUID. The old value was one specific
// person's session id, which every install would otherwise have inherited.
export const SESSION_ID = process.env.SESSION_ID || 'default';
