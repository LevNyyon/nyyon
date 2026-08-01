// Social gateway: the single layer Nyo posts through. Each CONNECTION is a
// route to one social profile, backed by our own Make-webhook gateways (the
// gateway-* MCP repos): linkedin-company, linkedin-personal, facebook-company.
// (Postiz was retired 2026-07-07 — it is no longer a connection.)
//
// Make webhooks are capability URLs (whoever holds the URL can post as us), so
// they live in env (.dev.vars locally, wrangler secret in prod) and never in
// source. A connection with no URL configured fails loud, not silent.
//
// They may also live in D1 when the operator connected them through the
// in-app onboarding chat — see lib/gateway-config.js.

import { withResolvedCredentials } from './gateway-config.js';

// network → the exact JSON body each Make scenario expects (matches the
// gateway-* MCP repos verbatim).
const MAKE_SHAPES = {
  linkedin: ({ content, imageUrl, imageTitle, altText }) => ({
    post_content: content,
    img_url: imageUrl || '',
    img_title: imageTitle || '',
    alt_text: altText || '',
  }),
  facebook: ({ content, imageUrl, imageCaption }) => ({
    post_content: content,
    image_url: imageUrl || '',
    image_caption: imageCaption || '',
  }),
};

// The fixed set of connections Nyo can reach. `urlEnv` is the env var holding
// the Make webhook for that profile.
const CONNECTIONS = {
  'linkedin-company':  { label: 'Nyyon LinkedIn (company page)',     network: 'linkedin', kind: 'make', urlEnv: 'NYYON_GW_LINKEDIN_COMPANY_URL' },
  'linkedin-personal': { label: 'Lev Kerzhner LinkedIn (personal)',  network: 'linkedin', kind: 'make', urlEnv: 'NYYON_GW_LINKEDIN_PERSONAL_URL' },
  'facebook-company':  { label: 'Nyyon Facebook (company page)',     network: 'facebook', kind: 'make', urlEnv: 'NYYON_GW_FACEBOOK_COMPANY_URL' },
};

// When a caller names a bare network instead of a connection key, this is the
// connection it resolves to. (Personal LinkedIn is always opt-in by key.)

const DEFAULT_CONNECTION = { linkedin: 'linkedin-company', facebook: 'facebook-company' };

function makeUrl(env, conn) {
  return (env[conn.urlEnv] || '').trim();
}

// Resolve a caller token (connection key OR bare network) to a connection key.
export function resolveConnection(token) {
  const t = String(token || '').trim().toLowerCase();
  if (CONNECTIONS[t]) return t;
  if (DEFAULT_CONNECTION[t]) return DEFAULT_CONNECTION[t];
  return null;
}

export function listConnections(env) {
  return Object.entries(CONNECTIONS).map(([key, c]) => ({
    connection: key,
    label: c.label,
    network: c.network,
    kind: c.kind,
    configured: !!makeUrl(env, c),
  }));
}

async function postMake(env, key, conn, { content, imageUrl, imageTitle, altText, imageCaption }) {
  const url = makeUrl(env, conn);
  if (!url) throw new Error(`Connection "${key}" not configured — set ${conn.urlEnv} in .dev.vars (and as a wrangler secret in prod).`);
  // Hard guardrail: the Make scenarios behind these webhooks require an image
  // to complete the post. Without one, Make still accepts the webhook (200 —
  // looks like success to us) but the scenario fails downstream with nothing
  // to show for it. That silent gap was the 2026-07-09 incident. Refuse
  // before ever calling Make, rather than reporting a false "posted."
  if (!imageUrl) throw new Error(`Connection "${key}" requires an image_url — Make's scenario cannot complete a post without one.`);
  const payload = MAKE_SHAPES[conn.network]({ content, imageUrl, imageTitle, altText, imageCaption });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`${key} webhook HTTP ${r.status}: ${text.slice(0, 200)}`);
  // Make webhooks post immediately; there is no scheduling on this path.
  return { ok: true, connection: key, label: conn.label, http: r.status, response: text.slice(0, 200) };
}

// Post to ONE connection (all connections are Make webhooks now).
export async function postToConnection(env, key, { content, imageUrl, imageTitle, altText, imageCaption } = {}) {
  env = await withResolvedCredentials(env); // webhook URLs may live in D1
  const conn = CONNECTIONS[key];
  if (!conn) throw new Error(`Unknown connection "${key}". Options: ${Object.keys(CONNECTIONS).join(', ')}.`);
  return postMake(env, key, conn, { content, imageUrl, imageTitle, altText, imageCaption });
}
