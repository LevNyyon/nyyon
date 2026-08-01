// Persisted webhook subscribers (data/webhooks.json). Both apps re-register on
// every boot, so register() dedups by url. Survives gateway restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '..', 'data', 'webhooks.json');

let subs = [];

function loadFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    subs = Array.isArray(parsed) ? parsed : [];
  } catch {
    subs = [];
  }
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(subs, null, 2));
  } catch (e) {
    console.error('[webhooks] persist failed:', e?.message || e);
  }
}

loadFromDisk();

export function list() {
  return subs.slice();
}

// Register or update by url (re-registration on boot must not duplicate).
export function register({ url, events, secret, retryCount } = {}) {
  if (!url || typeof url !== 'string') throw new Error('webhook url is required');
  const rec = {
    url,
    events: Array.isArray(events) && events.length ? events : ['message.received'],
    secret: secret || null,
    retryCount: Number.isFinite(retryCount) ? retryCount : 3,
    active: true,
  };
  const existing = subs.find((s) => s.url === url);
  if (existing) Object.assign(existing, rec);
  else subs.push(rec);
  persist();
  return rec;
}

export function remove(url) {
  const before = subs.length;
  subs = subs.filter((s) => s.url !== url);
  if (subs.length !== before) persist();
  return before - subs.length;
}
