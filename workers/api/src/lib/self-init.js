// Build this install's database on first contact.
//
// A worker deployed by a one-click button gets code and an EMPTY database:
// nothing in that flow runs migrations or registers the bundled plugins. So
// the worker does it itself, once, on the first request that finds no tables.
// Idempotent, guarded, and silent afterwards — a normal install (where the
// installer already ran the migrations) never enters this path.
import SCHEMA_SQL from '../generated/schema-sql.js';
import { logEvent } from './db.js';

let done = false;      // per-isolate short circuit once the database exists
let running = false;   // this isolate is already building it

async function alreadyBuilt(env) {
  try {
    const r = await env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='install_state'",
    ).first();
    return !!r;
  } catch { return false; }
}

// The bundled SQL is schema + every migration concatenated. Statements are
// applied one at a time on purpose: a historical migration referencing a table
// later removed from the schema must not stop the ones after it.
function statements(sql) {
  const out = [];
  let depth = 0, buf = '';
  for (const ch of sql) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth <= 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

// Is the database there yet? One cheap query, and only until it is.
export async function needsInit(env) {
  if (done) return false;
  if (await alreadyBuilt(env)) { done = true; return false; }
  return true;
}

// Build it. Called in the BACKGROUND (ctx.waitUntil): 251KB of schema takes
// longer than a request may last, so making the first visitor wait for it is
// how the first visitor gets a timeout instead of a product.
export async function selfInit(env) {
  if (done || running) return { skipped: 'already building or built' };
  running = true;

  // ONE call. D1's exec() takes the whole script; prepare()/batch() cost a
  // subrequest each, and a worker is capped well below the ~170 statements
  // here — which is why the background build kept dying silently after
  // creating nothing.
  let ok = 0, failed = 0;
  try {
    const r = await env.DB.exec(SCHEMA_SQL);
    ok = r?.count ?? 1;
  } catch (e) {
    // Fall back to batches (a handful of subrequests, still under the cap).
    const all = statements(SCHEMA_SQL);
    const SIZE = 60;
    for (let i = 0; i < all.length; i += SIZE) {
      const chunk = all.slice(i, i + SIZE);
      try { await env.DB.batch(chunk.map((st) => env.DB.prepare(st))); ok += chunk.length; }
      catch { failed += chunk.length; }
    }
  }
  done = true;
  running = false;
  await logEvent(env, { kind: 'install_self_initialized', actor: 'system', payload: { statements: ok, skipped: failed } }).catch(() => {});
  return { built: true, statements: ok, skipped: failed };
}
