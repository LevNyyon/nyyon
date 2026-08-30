// Enrichment gateway implementations — the HOST half of the pdl / twilio /
// serp / theorg gateway slugs (gateways/index.js). The GTM module moved into
// plugins/gtm, but gateways are host infrastructure: each impl here wraps ONE
// external service, does no reasoning, and degrades to { skipped } when its
// secret is unset. Moved verbatim from lib/gtm.js (pdlEnrich / twilioLookup /
// serpSearch) and lib/gtm-context.js (fetchTheorg / probeTheorg) in the
// GTM-plugin conversion.
//
// Usage metering: every billable call bumps plugin_gtm_api_usage and caches
// provider quota truth in plugin_gtm_api_quota — the PLUGIN's tables (host
// code may write plugin tables; the plugin's read_api_usage tool renders the
// meter). Plan caps come from the plugin-gtm-api-limits knowledge doc, which
// the plugin seeds and owns; missing doc = defaults, no seed from here.

import { readKnowledge, logEvent, queueNyoMessage } from './db.js';
import { withResolvedCredentials } from './gateway-config.js';

const now = () => Date.now();

// ── plan limits (read-only view of the plugin's editable doc) ───────────────

const DOC_SLUG = 'plugin-gtm-api-limits';

export const LIMITS_DEFAULTS = {
  pdl:     { monthly_limit: 100, renewal_day: 1, warn_at_pct: 80 },
  serpapi: { monthly_limit: 250, renewal_day: 1, warn_at_pct: 80 },
  twilio:  { balance_warn_usd: 5 },
};

function sanitizeLimits(src) {
  const out = JSON.parse(JSON.stringify(LIMITS_DEFAULTS));
  if (!src || typeof src !== 'object') return out;
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null);
  for (const p of ['pdl', 'serpapi']) {
    const s = src[p] || {};
    const lim = num(s.monthly_limit, 1, 1000000); if (lim !== null) out[p].monthly_limit = lim;
    const day = num(s.renewal_day, 1, 28);        if (day !== null) out[p].renewal_day = day;
    const pct = num(s.warn_at_pct, 1, 100);       if (pct !== null) out[p].warn_at_pct = pct;
  }
  const bw = num(src.twilio?.balance_warn_usd, 0, 10000);
  if (bw !== null) out.twilio.balance_warn_usd = bw;
  return out;
}

async function loadLimits(env) {
  try {
    const doc = await readKnowledge(env, DOC_SLUG);
    if (!doc) return { ...LIMITS_DEFAULTS, source: 'defaults' };
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeLimits(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...LIMITS_DEFAULTS, source: 'defaults' };
  }
}

// ── period math (renewal-anchored, not calendar-month) ──────────────────────

function periodAnchor(renewalDay, at = new Date()) {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), renewalDay));
  if (d.getUTCDate() < renewalDay) anchor.setUTCMonth(anchor.getUTCMonth() - 1);
  return anchor.toISOString().slice(0, 10);
}

function daysToRenewal(renewalDay, at = new Date()) {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), renewalDay));
  if (at.getUTCDate() >= renewalDay) next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.max(0, Math.ceil((next.getTime() - at.getTime()) / 86400000));
}

// ── counting + provider-truth capture (called from the enrich clients) ──────

// Bump the billable-call counter for a provider, and fire the once-per-period
// Nyo warning when usage crosses the configured threshold. Never throws — a
// tracking failure must not fail an enrichment.
async function bumpUsage(env, provider) {
  try {
    const limits = await loadLimits(env);
    const cfg = limits[provider];
    if (!cfg) return;
    const period = periodAnchor(cfg.renewal_day || 1);
    await env.DB.prepare(
      `INSERT INTO plugin_gtm_api_usage (provider, period, used, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(provider, period) DO UPDATE SET used = used + 1, updated_at = ?`,
    ).bind(provider, period, now(), now()).run();

    if (!cfg.monthly_limit || !cfg.warn_at_pct) return;
    const row = await env.DB.prepare(
      `SELECT used, warned_at FROM plugin_gtm_api_usage WHERE provider = ? AND period = ?`,
    ).bind(provider, period).first();
    const pct = Math.round(((row?.used || 0) / cfg.monthly_limit) * 100);
    if (pct >= cfg.warn_at_pct && !row?.warned_at) {
      await env.DB.prepare(`UPDATE plugin_gtm_api_usage SET warned_at = ? WHERE provider = ? AND period = ?`)
        .bind(now(), provider, period).run();
      const days = daysToRenewal(cfg.renewal_day || 1);
      await queueNyoMessage(env, {
        content: `⚠️ GTM: ${provider.toUpperCase()} is at ${row.used}/${cfg.monthly_limit} for this period (${pct}%) — renews in ${days} day${days === 1 ? '' : 's'}. Enrichment beyond the cap will fail or bill overage; consider pausing big imports until renewal or raising the plan.`,
        kind: 'alert', ref_kind: 'gtm_api_usage', ref_id: provider,
      }).catch(() => {});
      await logEvent(env, { kind: 'gtm_api_limit_warning', payload: { provider, used: row.used, limit: cfg.monthly_limit, pct } });
    }
  } catch { /* tracking must never break enrichment */ }
}

// Cache whatever quota numbers a provider reported (PDL headers, live checks).
async function cacheQuota(env, provider, payload) {
  try {
    await env.DB.prepare(
      `INSERT INTO plugin_gtm_api_quota (provider, payload, captured_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET payload = ?, captured_at = ?`,
    ).bind(provider, JSON.stringify(payload), now(), JSON.stringify(payload), now()).run();
  } catch { /* best-effort */ }
}

// Pull PDL's credit headers off a response (X-TotalLimit-*, X-RateLimit-*,
// X-LifeTime-*) into a plain object; returns null when none present.
function pdlQuotaFromHeaders(headers) {
  const out = {};
  try {
    for (const [k, v] of headers.entries()) {
      if (/^x-.*(limit|lifetime)/i.test(k)) out[k.toLowerCase()] = v;
    }
  } catch { return null; }
  return Object.keys(out).length ? out : null;
}

// ── SaaS clients (direct, optional secrets; degrade gracefully) ─────────────
// Each resolves its key DB-first, env-second (lib/gateway-config.js): a key
// pasted into the onboarding chat lands in D1, and a Worker cannot write its
// own secrets. The overlay is a no-op when the key is only in env.

export async function pdlEnrich(env, { phone, name, region, country } = {}) {
  env = await withResolvedCredentials(env);
  if (!env.PDL_API_KEY) return { skipped: 'PDL not configured (set the PDL_API_KEY secret)' };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ phone, name, region, country })) if (v) qs.set(k, v);
  const r = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${qs}`, {
    headers: { 'X-Api-Key': env.PDL_API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  // usage meter: count the billable call + capture PDL's credit headers (its
  // own remaining-quota truth). Both are fire-safe no-ops on failure.
  await bumpUsage(env, 'pdl');
  const pdlQuota = pdlQuotaFromHeaders(r.headers);
  if (pdlQuota) await cacheQuota(env, 'pdl', pdlQuota);
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) return { matched: false };
  if (!r.ok) return { error: `PDL ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
  const d = j.data || {};
  const profiles = (d.profiles || []).map((p) => ({ type: p.network, url: p.url && (p.url.startsWith('http') ? p.url : 'https://' + p.url) })).filter((p) => p.url);
  return {
    matched: true,
    likelihood: j.likelihood,
    name: d.full_name || null,
    job_title: d.job_title || null,
    company: d.job_company_name || null,
    email: (d.emails || [])[0]?.address || d.recommended_personal_email || null,
    region: d.location_region || null,
    country: d.location_country || null,
    profiles,
  };
}

export async function twilioLookup(env, number) {
  env = await withResolvedCredentials(env);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return { skipped: 'Twilio not configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN secrets)' };
  const e164 = String(number || '').startsWith('+') ? number : '+' + String(number || '').replace(/\D/g, '');
  const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence,caller_name`, {
    headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) },
    signal: AbortSignal.timeout(20000),
  });
  await bumpUsage(env, 'twilio'); // usage meter (lookup count; balance is checked live)
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `Twilio ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
  return {
    valid: j.valid !== false,
    line_type: j.line_type_intelligence?.type || null,
    carrier: j.line_type_intelligence?.carrier_name || null,
    caller_name: j.caller_name?.caller_name || null,
    country_code: j.country_code || null,
  };
}

export async function serpSearch(env, { q, engine = 'google', num = 10, url } = {}) {
  env = await withResolvedCredentials(env);
  if (!env.SERPAPI_KEY) return { skipped: 'SerpApi not configured (set the SERPAPI_KEY secret)' };
  const qs = new URLSearchParams({ engine, api_key: env.SERPAPI_KEY });
  if (q) qs.set('q', q);
  if (url) qs.set('url', url);
  if (num) qs.set('num', String(num));
  const r = await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(30000) });
  await bumpUsage(env, 'serpapi'); // usage meter (the /account check refines it with SerpApi's own numbers)
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return { error: `SerpApi: ${j.error || r.status}` };
  const results = (j.organic_results || []).map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
  return { results, data: j };
}

// ── theorg org chart (public GraphQL, no key) ───────────────────────────────

const GQL = 'https://prod-graphql-api.theorg.com/graphql';
const FRAG = `fragment P on OrgChartStructureNode {
  id title node {
    ... on Position { position { fullName role slug profileImage { endpoint uri ext versions __typename } __typename } __typename }
    __typename
  } reportCount parentId __typename
}`;
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function theorgImageUrl(img) {
  if (!img) return null;
  const ver = img.versions?.includes('medium') ? 'medium' : (img.versions?.[0] ?? 'thumb');
  return `${img.endpoint}/${img.uri}_${ver}.${img.ext}`;
}

async function theorgGql(op, query, variables) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/json', 'x-org-client': 'web', 'x-operation-name': op },
    body: JSON.stringify({ operationName: op, variables, query }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(String(JSON.stringify(j.errors)).slice(0, 200));
  return j.data;
}

export async function fetchTheorg(env, { company, slug } = {}) {
  const useSlug = (slug && String(slug).trim()) || slugify(company);
  if (!useSlug) return { error: 'no company' };
  try {
    const c = (await theorgGql('GetCompany', 'query GetCompany($slug:String!){company(slug:$slug){id name}}', { slug: useSlug })).company;
    if (!c) return { error: `not found on theorg (tried slug "${useSlug}")`, people: [] };
    const nodes = (await theorgGql('OrgChartPreview', `query OrgChartPreview($companyId:UUID!){nodes(companyId:$companyId,mode:{}){...P}}${FRAG}`, { companyId: c.id })).nodes || [];
    const people = nodes
      .filter((n) => n.node?.position)
      .map((n) => {
        const p = n.node.position;
        return { nodeId: n.id, parentId: n.parentId, name: p.fullName, role: p.role, photo: theorgImageUrl(p.profileImage), reportCount: n.reportCount };
      });
    return { company: c.name, people };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Health probe — empty POST answers 400, which still proves theorg is up,
// and no real query means health probes never hit quota.
export async function probeTheorg(env) {
  try {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-org-client': 'web' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    return { ok: true, http: r.status };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}
