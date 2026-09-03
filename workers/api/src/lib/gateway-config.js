// Runtime credential store for the gateway layer.
//
// THE PROBLEM THIS SOLVES
// A Worker cannot write its own secrets. `wrangler secret put` runs on a
// developer's machine at deploy time, so a command center configured only
// through env can only ever be configured by whoever deployed it. Fine for one
// operator, fatal for a product somebody unzips and runs: the pre-login
// onboarding chat has to CONNECT WhatsApp, or accept a pasted Anthropic key,
// at runtime, from a person who never opens a terminal.
//
// So credentials resolve DB-first, env-second:
//
//   resolveCredential(env, 'WA_API_KEY')
//     -> gateway_config row of whichever gateway declares that key
//     -> env.WA_API_KEY  (Cloudflare secret / .dev.vars)
//     -> null
//
// PURELY ADDITIVE. With no rows in gateway_config every lookup falls straight
// through to env, so an install that prefers `wrangler secret put` behaves
// exactly as it did before this file existed. Nobody is forced off secrets.
//
// THE SEAM
// The libs underneath read `env.WA_API_KEY` synchronously, in dozens of
// places, and a DB read is async. Rewriting every lib to await a resolver
// would be a large, risky diff for no benefit. Instead withResolvedCredentials
// returns an env-SHAPED object with the DB values layered on top, applied at
// the few async choke points that already exist: callGateway(), and the lib
// entry points that own an outbound boundary (waFetch, the LinkedIn call
// funnel, the LLM entry points, the SaaS enrichers). Everything below those
// points keeps reading env.X and simply sees the right value.
//
// SECURITY: only keys a gateway DECLARES (CREDENTIALS below) are ever stored
// or overlaid. Without that allowlist a write to gateway_config could shadow a
// Worker binding — {"DB": "..."} on the resolved env would replace the D1
// handle with a string. The allowlist is what makes the overlay safe.

import { listGateways } from '../gateways/index.js';
import { logEvent } from './db.js';
import { now } from './util.js';

// ── what each gateway needs ────────────────────────────────────────────────
// Derived by reading what the libs behind each gateway ACTUALLY pull off env
// (grep `env\.[A-Z_]+` across lib/ and gateways/). Key names are the env names
// verbatim — that is what makes the overlay a one-line change per boundary
// instead of a translation table nobody maintains.
//
// These live in code, not in a knowledge note, deliberately. A knowledge note
// is an editable RULE; this is a contract WITH the code. Editing "WA_API_KEY"
// to something else in a doc could not change what lib/whatsapp.js reads — it
// would only make the connect form write a key nobody consumes. The one thing
// this list must never drift from is the source, so it lives beside it.
//
//   required — the gateway cannot work at all without it
//   secret   — the VALUE never leaves the server; reads report "set", not what
//
// Bindings (DB, ASSETS, AI) are intentionally absent: they are wrangler.jsonc
// bindings, not strings, and cannot come from a database.
export const CREDENTIALS = {
  llm: [
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', required: true,  secret: true,  help: 'console.anthropic.com → API keys. Everything that writes runs on this.' },
  ],
  whatsapp: [
    { key: 'WA_BASE_URL',   label: 'wa-gateway URL', required: true,  secret: false, help: 'e.g. https://wa.example.com/api or http://127.0.0.1:2785/api' },
    { key: 'WA_API_KEY',    label: 'wa-gateway key', required: true,  secret: true,  help: 'The X-API-Key the wa-gateway daemon expects.' },
    { key: 'WA_SESSION_ID', label: 'Session id',     required: false, secret: false, help: 'Defaults to "default".' },
  ],
  linkedin: [
    { key: 'UNIPILE_DSN',        label: 'Unipile DSN',        required: true,  secret: false, help: 'from your Unipile dashboard, e.g. api1.unipile.com:13111' },
    { key: 'UNIPILE_API_KEY',    label: 'Unipile API key',    required: true,  secret: true },
    { key: 'UNIPILE_ACCOUNT_ID', label: 'Unipile account id', required: false, secret: false, help: 'optional — first connected LinkedIn account is used otherwise' },
  ],
  telegram: [
    { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', required: true, secret: true, help: 'from @BotFather — /newbot, then paste the token' },
  ],
  social: [
    // A Make.com webhook URL is bearer-equivalent: the URL IS the credential.
    { key: 'NYYON_GW_LINKEDIN_COMPANY_URL',  label: 'LinkedIn company webhook',  required: false, secret: true },
    { key: 'NYYON_GW_LINKEDIN_PERSONAL_URL', label: 'LinkedIn personal webhook', required: false, secret: true },
    { key: 'NYYON_GW_FACEBOOK_COMPANY_URL',  label: 'Facebook company webhook',  required: false, secret: true },
  ],
  image: [
  ],
  assets: [
    { key: 'ASSETS_BASE_URL', label: 'Public asset base URL', required: false, secret: false, help: 'Public origin in front of the R2 bucket. The bucket itself is a binding.' },
  ],
  pdl: [
    { key: 'PDL_API_KEY', label: 'People Data Labs key', required: true, secret: true },
  ],
  twilio: [
    { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio account SID', required: true, secret: false },
    { key: 'TWILIO_AUTH_TOKEN',  label: 'Twilio auth token',  required: true, secret: true },
  ],
  serp: [
    { key: 'SERPAPI_KEY', label: 'SerpApi key', required: true, secret: true },
  ],
  hf: [
    { key: 'HF_TOKEN', label: 'Hugging Face token', required: true, secret: true, help: 'The writing fallback while the Anthropic breaker is open.' },
  ],
  tts: [
    { key: 'TTS_BASE_URL', label: 'Piper TTS URL', required: true,  secret: false },
    { key: 'TTS_API_KEY',  label: 'Piper TTS key', required: false, secret: true },
  ],
  deploy: [
  ],
  // web and theorg hit public endpoints and need no credential. They are still
  // listed so a "connect your services" screen shows them as already working
  // rather than silently omitting them.
  web: [],
  theorg: [],
};

// Every key any gateway may own. Some are shared — OPENAI_API_KEY is declared
// by both llm and image — and the resolver takes the first non-empty value in
// declaration order, so setting it on either gateway configures both.
const DECLARED_KEYS = new Set(Object.values(CREDENTIALS).flat().map((f) => f.key));

// Gateways that are usable with ANY ONE of their credentials rather than all
// of them. `social` is the case that forced this: an operator may connect only
// LinkedIn, or only Facebook, and posting works either way — but with no
// webhook at all the gateway does nothing, so "every field optional" would
// have reported a gateway that cannot post as ready.
const ANY_OF = new Set(['social']);

const fieldsFor = (slug) => CREDENTIALS[slug] || [];
const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// ── isolate cache ──────────────────────────────────────────────────────────
// callGateway runs on every outbound call; without a cache each one costs a D1
// round trip. The TTL is a cache-coherence window, not a behaviour rule, which
// is why it is a code constant rather than a knowledge value: reading it from
// a knowledge doc would cost the very DB read the cache exists to avoid.
// saveGatewayConfig invalidates immediately, so a value can never be stale
// within the request that wrote it; the TTL only bounds how long a DIFFERENT
// isolate keeps serving the previous value.
const CACHE_TTL_MS = 10_000;
let CACHE = null; // { at, bySlug: {slug: {KEY: value}}, byKey: {KEY: value} }

export function invalidateGatewayConfigCache() { CACHE = null; }

async function loadAll(env) {
  if (CACHE && (now() - CACHE.at) < CACHE_TTL_MS) return CACHE;
  const bySlug = {};
  const byKey = {};
  if (env?.DB) {
    try {
      const r = await env.DB.prepare('SELECT slug, config FROM gateway_config').all();
      for (const row of (r.results || [])) {
        let cfg = null;
        try { cfg = JSON.parse(row.config || '{}'); } catch { cfg = null; }
        bySlug[row.slug] = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
      }
    } catch (e) {
      // A missing table (install not migrated yet) or a transient D1 error must
      // never take the app down: env-configured installs keep working and a
      // DB-configured one recovers on the next tick.
      if (!/no such table/i.test(String(e?.message || e))) {
        console.warn('gateway_config read failed:', String(e?.message || e));
      }
    }
  }
  // Flatten in declaration order so a shared key resolves deterministically.
  for (const slug of Object.keys(CREDENTIALS)) {
    for (const f of fieldsFor(slug)) {
      if (byKey[f.key] !== undefined) continue;
      const v = bySlug[slug]?.[f.key];
      if (isSet(v)) byKey[f.key] = String(v).trim();
    }
  }
  CACHE = { at: now(), bySlug, byKey };
  return CACHE;
}

// ── reads ──────────────────────────────────────────────────────────────────

// The stored JSON for one gateway, or null when nothing has been saved.
// Returns REAL values — it is the read-modify-write path for an edit form.
// Anything rendering to a browser must use listGatewayStatus instead, which
// never emits a secret value.
export async function readGatewayConfig(env, slug) {
  const { bySlug } = await loadAll(env);
  const cfg = bySlug[slug];
  return cfg ? { ...cfg } : null;
}

// DB first, env second. The one function the whole credential story rests on.
export async function resolveCredential(env, key) {
  if (!key) return null;
  if (DECLARED_KEYS.has(key)) {
    const { byKey } = await loadAll(env);
    if (isSet(byKey[key])) return byKey[key];
  }
  const fromEnv = env?.[key];
  return isSet(fromEnv) ? String(fromEnv).trim() : null;
}

// THE SEAM. Returns an object that behaves exactly like `env` (bindings and
// all) with DB-configured credentials layered on top, so every synchronous
// `env.WA_API_KEY` underneath resolves DB-first with no further changes.
//
// With nothing configured in the DB it returns the SAME object it was handed,
// so an env-only install pays nothing and behaves identically. Idempotent: a
// resolved env is tagged and passes straight back out, so nesting the call at
// several layers costs one lookup, not several.
const RESOLVED = Symbol.for('nyyon.credentials.resolved');
export async function withResolvedCredentials(env) {
  if (!env || env[RESOLVED]) return env;
  let byKey;
  try { ({ byKey } = await loadAll(env)); } catch { return env; }
  const keys = Object.keys(byKey);
  if (!keys.length) return env;
  const out = { ...env };
  for (const k of keys) {
    // Belt and braces: loadAll already filters to declared keys. This makes it
    // impossible for a future change there to shadow a binding by accident.
    if (DECLARED_KEYS.has(k)) out[k] = byKey[k];
  }
  Object.defineProperty(out, RESOLVED, { value: true, enumerable: false });
  return out;
}

// Per-gateway readiness, safe to hand to a browser or to Nyo. Never contains a
// secret VALUE: secret fields report only whether they are set, and from where.
//
// Shape is { gateways, summary } rather than a bare array because the
// onboarding conversation and the setup routes were built against that
// contract; each row is a superset of what they read.
export async function listGatewayStatus(env) {
  const { bySlug, byKey } = await loadAll(env);
  const gateways = listGateways().map((g) => {
    const defs = fieldsFor(g.slug);
    const cfg = bySlug[g.slug] || {};
    const fields = [];
    const set_in_store = []; const set_in_env = []; const missing = [];
    const anyOf = ANY_OF.has(g.slug);
    let anySet = false;

    for (const f of defs) {
      // A shared key (OPENAI_API_KEY) counts as stored for this gateway when
      // it was saved under the other one — the resolver will find it there.
      const stored = isSet(cfg[f.key]) ? String(cfg[f.key]).trim()
        : (isSet(byKey[f.key]) ? byKey[f.key] : null);
      const fromEnv = isSet(env?.[f.key]) ? String(env[f.key]) : null;
      const source = stored ? 'db' : (fromEnv ? 'env' : 'none');

      if (source === 'db') set_in_store.push(f.key);
      if (source === 'env') set_in_env.push(f.key);
      if (source !== 'none') anySet = true;
      if (source === 'none' && (f.required || anyOf)) missing.push(f.key);

      fields.push({
        key: f.key,
        label: f.label,
        required: !!f.required,
        secret: !!f.secret,
        help: f.help || null,
        set: source !== 'none',
        source,
        // Non-secret values come back so a settings form can prefill the URL
        // the operator already typed. Secret values never leave the server.
        value: f.secret ? null : (stored || fromEnv || null),
      });
    }

    // any-of: one credential is enough, and `missing` then lists the choices
    // rather than a set of things all of which are required.
    const configured = anyOf ? anySet : missing.length === 0;
    return {
      slug: g.slug,
      service: g.service,
      description: g.description,
      modes: g.modes,
      configured,
      // Which store the gateway is actually reading from right now.
      source: set_in_store.length ? 'db' : (set_in_env.length ? 'env' : 'none'),
      fields,
      // Kept for the surfaces built against the earlier contract. `live` used
      // to mean "the worker can actually read this"; with the DB-first
      // resolver a stored value IS readable, so it now tracks `configured`.
      required: defs.filter((f) => f.required).map((f) => f.key),
      optional: defs.filter((f) => !f.required).map((f) => f.key),
      // 'all' = every required key; 'any' = one of them is enough.
      requires: anyOf ? 'any' : 'all',
      set_in_env,
      set_in_store,
      missing: configured ? [] : missing,
      live: configured,
      needs_config: anyOf || defs.some((f) => f.required),
    };
  });

  return {
    gateways,
    summary: {
      total: gateways.length,
      configured: gateways.filter((g) => g.configured).length,
      missing: gateways.filter((g) => !g.configured).map((g) => g.slug),
    },
  };
}

// ── write ──────────────────────────────────────────────────────────────────

// Upsert one gateway's credentials. Unknown keys are DROPPED (the allowlist
// that stops the env overlay shadowing a binding), and an empty value CLEARS a
// key — which is how "disconnect" works without a second endpoint.
export async function saveGatewayConfig(env, slug, config = {}) {
  if (!CREDENTIALS[slug]) throw new Error(`unknown gateway "${slug}"`);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be an object of { KEY: value }');
  }
  const allowed = new Set(fieldsFor(slug).map((f) => f.key));
  const prior = (await readGatewayConfig(env, slug)) || {};
  const next = { ...prior };
  const saved_keys = []; const cleared_keys = []; const ignored_keys = [];

  for (const [k, raw] of Object.entries(config)) {
    if (!allowed.has(k)) { ignored_keys.push(k); continue; }
    const v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (v === '') { if (k in next) { delete next[k]; cleared_keys.push(k); } continue; }
    next[k] = v;
    saved_keys.push(k);
  }

  const ts = now();
  const hasAny = Object.keys(next).length > 0;
  await env.DB.prepare(
    `INSERT INTO gateway_config (slug, config, configured_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       config        = excluded.config,
       configured_at = COALESCE(gateway_config.configured_at, excluded.configured_at),
       updated_at    = excluded.updated_at`,
  ).bind(slug, JSON.stringify(next), hasAny ? ts : null, ts).run();

  // The write has to be visible to the rest of THIS request, not in ten seconds.
  invalidateGatewayConfigCache();

  // The activity bus records that a boundary was configured, never WHAT with.
  // Key names only: a secret value written here would outlive every rotation
  // and show up in the activity feed forever.
  await logEvent(env, {
    kind: 'gateway_configured',
    actor: 'operator',
    payload: { slug, keys: saved_keys, cleared: cleared_keys, ignored: ignored_keys },
  });

  const status = (await listGatewayStatus(env)).gateways.find((g) => g.slug === slug);
  return {
    slug,
    saved_keys,
    cleared_keys,
    ignored_keys,
    configured: Boolean(status?.configured),
    live: Boolean(status?.configured),
    missing: status?.missing || [],
  };
}
