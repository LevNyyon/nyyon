// GTM enrichment API usage tracking — PDL / SerpApi / Twilio limits, visible
// in cmd with a warning before a cap is hit.
//
// Signal sources, merged best-first:
//   1. provider truth  — whatever quota numbers a provider reported that the
//                        enrich chain captured into plugin_gtm_api_quota
//                        (cacheQuota). In the plugin runtime there is no raw
//                        fetch and no host secret access, so the live SerpApi
//                        /account and Twilio balance checks of the host
//                        original cannot run here — cached truth only.
//   2. our own count   — every billable call bumps plugin_gtm_api_usage for
//                        the current renewal period. Always works, even offline.
//   3. operator config — the plugin-gtm-api-limits knowledge doc holds each
//                        plan's monthly cap, renewal day, and warn threshold
//                        (editable like every other control surface).
//
// Crossing the warn threshold writes ONE activity-bus warning per provider per
// period (warned_at latch). The host original queued a Nyo chat message too;
// a plugin cannot write nyo_messages, so the full warning text rides on the
// api_limit_warning log event instead.
//
// Plugin lib (contract v2.1): imports NOTHING; every exported function takes
// `api` first.

const DOC_SLUG = 'plugin-gtm-api-limits';

export const LIMITS_DEFAULTS = {
  pdl:     { monthly_limit: 100, renewal_day: 1, warn_at_pct: 80 },
  serpapi: { monthly_limit: 250, renewal_day: 1, warn_at_pct: 80 },
  twilio:  { balance_warn_usd: 5 },
};

function limitsSeedBody(cfg) {
  return `GTM enrichment API limits — plan caps for the usage meters in the GTM module.

Set each provider's real plan numbers here; the module shows used/limit, days to
renewal, and warns once per period when usage crosses \`warn_at_pct\`.
\`renewal_day\` is the day of the month the plan resets (check the provider's
billing page). Twilio has no monthly cap — it is pay-per-use, so the meter shows
the account balance and warns below \`balance_warn_usd\`.

Where the provider reports its own numbers (PDL response headers, the SerpApi
account payload), those override the counted estimate automatically — this doc
mainly supplies the cap, the renewal day, and the warning line.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;
}

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

export async function loadLimits(api) {
  try {
    const doc = await api.knowledge(DOC_SLUG);
    if (!doc) {
      await api.saveKnowledge(DOC_SLUG, {
        title: 'GTM · enrichment API limits',
        body: limitsSeedBody(LIMITS_DEFAULTS),
      }).catch(() => {});
      return { ...LIMITS_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeLimits(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...LIMITS_DEFAULTS, source: 'defaults' };
  }
}

export async function saveLimits(api, patch = {}) {
  const cur = await loadLimits(api);
  const merged = {
    pdl:     { ...cur.pdl,     ...(patch.pdl || {}) },
    serpapi: { ...cur.serpapi, ...(patch.serpapi || {}) },
    twilio:  { ...cur.twilio,  ...(patch.twilio || {}) },
  };
  const next = sanitizeLimits(merged);
  await api.saveKnowledge(DOC_SLUG, {
    title: 'GTM · enrichment API limits',
    body: limitsSeedBody(next),
  });
  await api.log('api_limits_updated', next);
  return { ...next, source: 'doc' };
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

// ── counting + provider-truth capture (called from the enrich tools) ────────

// Bump the billable-call counter for a provider, and fire the once-per-period
// warning when usage crosses the configured threshold. Never throws — a
// tracking failure must not fail an enrichment.
export async function bumpUsage(api, provider) {
  try {
    const limits = await loadLimits(api);
    const cfg = limits[provider];
    if (!cfg) return;
    const period = periodAnchor(cfg.renewal_day || 1);
    await api.db.prepare(
      `INSERT INTO plugin_gtm_api_usage (provider, period, used, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(provider, period) DO UPDATE SET used = used + 1, updated_at = ?`,
    ).bind(provider, period, Date.now(), Date.now()).run();

    if (!cfg.monthly_limit || !cfg.warn_at_pct) return;
    const row = await api.db.prepare(
      `SELECT used, warned_at FROM plugin_gtm_api_usage WHERE provider = ? AND period = ?`,
    ).bind(provider, period).first();
    const pct = Math.round(((row?.used || 0) / cfg.monthly_limit) * 100);
    if (pct >= cfg.warn_at_pct && !row?.warned_at) {
      await api.db.prepare(`UPDATE plugin_gtm_api_usage SET warned_at = ? WHERE provider = ? AND period = ?`)
        .bind(Date.now(), provider, period).run();
      const days = daysToRenewal(cfg.renewal_day || 1);
      await api.log('api_limit_warning', {
        provider, used: row.used, limit: cfg.monthly_limit, pct,
        message: `⚠️ GTM: ${provider.toUpperCase()} is at ${row.used}/${cfg.monthly_limit} for this period (${pct}%) — renews in ${days} day${days === 1 ? '' : 's'}. Enrichment beyond the cap will fail or bill overage; consider pausing big imports until renewal or raising the plan.`,
      });
    }
  } catch { /* tracking must never break enrichment */ }
}

// Cache whatever quota numbers a provider reported (PDL headers, account
// payloads the enrich chain sees).
export async function cacheQuota(api, provider, payload) {
  try {
    await api.db.prepare(
      `INSERT INTO plugin_gtm_api_quota (provider, payload, captured_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET payload = ?, captured_at = ?`,
    ).bind(provider, JSON.stringify(payload), Date.now(), JSON.stringify(payload), Date.now()).run();
  } catch { /* best-effort */ }
}

// Pull PDL's credit headers off a response (X-TotalLimit-*, X-RateLimit-*,
// X-LifeTime-*) into a plain object; returns null when none present. Accepts a
// Headers object or a plain {header: value} object (a gateway result can only
// carry the latter).
export function pdlQuotaFromHeaders(api, headers) {
  const out = {};
  try {
    const entries = typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {});
    for (const [k, v] of entries) {
      if (/^x-.*(limit|lifetime)/i.test(k)) out[String(k).toLowerCase()] = v;
    }
  } catch { return null; }
  return Object.keys(out).length ? out : null;
}

// ── the merged usage view (tool + module UI) ────────────────────────────────

export async function gtmApiUsage(api) {
  const limits = await loadLimits(api);
  const usageRows = (await api.db.prepare(`SELECT * FROM plugin_gtm_api_usage`).all()).results || [];
  const quotaRows = (await api.db.prepare(`SELECT * FROM plugin_gtm_api_quota`).all()).results || [];
  const quota = Object.fromEntries(quotaRows.map((r) => {
    try { return [r.provider, { ...JSON.parse(r.payload), captured_at: r.captured_at }]; } catch { return [r.provider, null]; }
  }));

  const counted = (provider, renewalDay) => {
    const period = periodAnchor(renewalDay || 1);
    return usageRows.find((r) => r.provider === provider && r.period === period)?.used || 0;
  };
  // The plugin runtime has no host-secret access, so "is the key set" is
  // inferred: a provider that ever reported quota or was ever counted is
  // configured. (The host original read env.*_KEY directly.)
  const inferredConfigured = (provider) =>
    !!quota[provider] || usageRows.some((r) => r.provider === provider && (r.used || 0) > 0);

  const providers = [];

  // PDL — counted + cached header truth (remaining credits when reported).
  {
    const cfg = limits.pdl;
    const used = counted('pdl', cfg.renewal_day);
    const q = quota.pdl || null;
    // PDL reports remaining purchased credits in x-totallimit-remaining (or the
    // -purchased- variant); when present it overrides the counted estimate.
    const reportedRemaining = q ? Number(q['x-totallimit-remaining'] ?? q['x-totallimit-purchased-remaining']) : NaN;
    const remaining = Number.isFinite(reportedRemaining) ? reportedRemaining : Math.max(0, cfg.monthly_limit - used);
    const effUsed = Number.isFinite(reportedRemaining) ? Math.max(0, cfg.monthly_limit - reportedRemaining) : used;
    const pct = Math.min(100, Math.round((effUsed / Math.max(1, cfg.monthly_limit)) * 100));
    providers.push({
      provider: 'pdl', configured: inferredConfigured('pdl'), used: effUsed, limit: cfg.monthly_limit, remaining, pct,
      renews_in_days: daysToRenewal(cfg.renewal_day), warn_at_pct: cfg.warn_at_pct,
      warning: pct >= cfg.warn_at_pct,
      source: Number.isFinite(reportedRemaining) ? 'provider' : 'counted',
      detail: q,
    });
  }

  // SerpApi — cached account payload when the enrich chain captured one;
  // counted fallback. (The host original's live /account check needs the raw
  // key and cannot run inside the plugin runtime.)
  {
    const cfg = limits.serpapi;
    const q = quota.serpapi || null;
    const limit = Number.isFinite(Number(q?.searches_per_month)) ? Number(q.searches_per_month) : cfg.monthly_limit;
    const reportedLeft = Number(q?.plan_searches_left);
    const used = Number.isFinite(Number(q?.this_month_usage)) ? Number(q.this_month_usage) : counted('serpapi', cfg.renewal_day);
    const remaining = Number.isFinite(reportedLeft) ? reportedLeft : Math.max(0, limit - used);
    const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
    providers.push({
      provider: 'serpapi', configured: inferredConfigured('serpapi'), used, limit, remaining, pct,
      renews_in_days: daysToRenewal(cfg.renewal_day), warn_at_pct: cfg.warn_at_pct,
      warning: pct >= cfg.warn_at_pct,
      source: q ? 'provider-cached' : 'counted',
      detail: q,
    });
  }

  // Twilio — pay-per-use: the meter is the account balance (cached when the
  // enrich chain captured one; the live Balance.json check needs the raw
  // credentials and cannot run inside the plugin runtime).
  {
    const cfg = limits.twilio;
    const q = quota.twilio || null;
    providers.push({
      provider: 'twilio', configured: inferredConfigured('twilio'), kind: 'balance',
      balance: q?.balance ?? null, currency: q?.currency || 'USD',
      used: counted('twilio', 1), // lookups made this calendar month (informational)
      balance_warn_usd: cfg.balance_warn_usd,
      warning: q ? Number(q.balance) < cfg.balance_warn_usd : false,
      source: q ? 'provider-cached' : 'counted',
      detail: q,
    });
  }

  return { now: Date.now(), providers, limits_source: limits.source };
}
