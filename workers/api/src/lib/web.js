// Funnel ingestion — sessions, web_events, identities, conversions.
// Pattern adapted from the seamless v4-tracker worker, slimmed for D1.

import { uid, now, safeJSON } from './util.js';
import { logEvent } from './db.js';

const SESSION_REUSE_WINDOW_MS = 30 * 60 * 1000;  // 30 min — same-cookie page hops reuse the session
const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
                          'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'];

// ─── sessions ────────────────────────────────────────────────
// Reuse the last session for this cookie IF (a) it's recent AND (b) no fresh
// attribution params arrived (UTM or click ID = new ad click = new session).
export async function ingestSession(env, body, headers) {
  const t = now();
  const cookie_id = body.cookie_id || uid();
  const ip = headers['cf-connecting-ip'] || headers['x-forwarded-for'] || null;
  const ua = headers['user-agent'] || null;

  const hasAttribution = ATTRIBUTION_KEYS.some((k) => body[k]);
  let session_id = null;

  if (!hasAttribution) {
    const recent = await env.DB.prepare(
      'SELECT id, last_seen_at FROM sessions WHERE cookie_id = ? ORDER BY started_at DESC LIMIT 1',
    ).bind(cookie_id).first();
    if (recent && t - recent.last_seen_at < SESSION_REUSE_WINDOW_MS) {
      session_id = recent.id;
      await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(t, session_id).run();
    }
  }

  if (!session_id) {
    session_id = uid();
    await env.DB.prepare(
      `INSERT INTO sessions (id, cookie_id, person_id, ip, ua,
                             utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                             gclid, gbraid, wbraid, fbclid, msclkid, ttclid,
                             browser, os, device, referrer, landing_path,
                             started_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?)`,
    ).bind(
      session_id, cookie_id, ip, ua,
      body.utm_source ?? null, body.utm_medium ?? null, body.utm_campaign ?? null, body.utm_content ?? null, body.utm_term ?? null,
      body.gclid ?? null, body.gbraid ?? null, body.wbraid ?? null, body.fbclid ?? null, body.msclkid ?? null, body.ttclid ?? null,
      body.browser ?? null, body.os ?? null, body.device ?? null,
      body.referrer ?? null, body.landing_path ?? null,
      t, t,
    ).run();
  }

  // Adopt any pre-known person from prior identify on this cookie.
  let person_id = null;
  const known = await env.DB.prepare(
    `SELECT person_id FROM sessions WHERE cookie_id = ? AND person_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
  ).bind(cookie_id).first();
  if (known?.person_id) {
    person_id = known.person_id;
    await env.DB.prepare('UPDATE sessions SET person_id = ? WHERE id = ? AND person_id IS NULL')
      .bind(person_id, session_id).run();
  }

  return { session_id, cookie_id, person_id };
}

// ─── events ──────────────────────────────────────────────────
export async function ingestEvent(env, body) {
  const id = uid();
  const t  = now();
  await env.DB.prepare(
    `INSERT INTO web_events (id, session_id, cookie_id, person_id, event_type, event_data, page_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    body.session_id ?? null,
    body.cookie_id ?? null,
    body.person_id ?? null,
    String(body.event_type),
    body.event_data === undefined ? null : (typeof body.event_data === 'string' ? body.event_data : JSON.stringify(body.event_data)),
    body.page_path ?? null,
    t,
  ).run();

  // Touch the session's last_seen_at so it stays warm for the reuse window.
  if (body.session_id) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(t, body.session_id).run();
  }
  return { event_id: id, session_id: body.session_id, person_id: body.person_id };
}

// ─── identity ────────────────────────────────────────────────
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Re-point every row from one person_id onto another, then delete the loser.
// Used when the same cookie has been linked to two different person_ids
// (e.g. user identified once with email_A then later with email_B on the
// same browser — almost always the same human).
export async function mergePersonIds(env, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { merged: false };

  const loser  = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(fromId).first();
  const winner = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(toId).first();
  if (!loser || !winner) return { merged: false, reason: 'one side missing' };

  // Re-point every reference. Order: sessions → web_events → conversions → identity_links → identity row.
  await env.DB.prepare('UPDATE sessions       SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE web_events     SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE conversions    SET identity_id = ? WHERE identity_id = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE identity_links SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();

  // Fold loser metadata into winner if winner is missing it. Keep the older first_seen_at.
  const newFirstSeen = Math.min(loser.first_seen_at ?? winner.first_seen_at, winner.first_seen_at ?? loser.first_seen_at);
  const newLastSeen  = Math.max(loser.last_seen_at  ?? 0,                    winner.last_seen_at  ?? 0);
  await env.DB.prepare(
    `UPDATE identities
        SET display_name = COALESCE(display_name, ?),
            phone        = COALESCE(phone,        ?),
            handle       = COALESCE(handle,       ?),
            meta         = COALESCE(meta,         ?),
            first_seen_at = ?,
            last_seen_at  = ?
      WHERE id = ?`,
  ).bind(loser.display_name, loser.phone, loser.handle, loser.meta, newFirstSeen, newLastSeen, toId).run();

  // Write an audit row so the merge is visible in identity_links + ops Activity.
  await env.DB.prepare(
    `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uid(), loser.cookie_id ?? null, toId, 'merge', String(fromId), 'merge_from_prior_person', null, now()).run();

  await env.DB.prepare('DELETE FROM identities WHERE id = ?').bind(fromId).run();
  await logEvent(env, { kind: 'identity_merged', payload: { from: fromId, to: toId, loser_email: loser.email } });

  return { merged: true, from: fromId, to: toId };
}

// Upsert an identity by email + backfill person_id onto every session AND
// every web_event for this cookie. If the cookie was previously linked to a
// different person, merge that person INTO this email's canonical person.
// Always writes an identity_links row for the (cookie ↔ person ↔ email) tuple.
export async function identifyByEmail(env, body) {
  const email = normalizeEmail(body.email);
  if (!email) throw new Error('email required');
  const cookie_id  = body.cookie_id  || null;
  const session_id = body.session_id || null;
  const t = now();

  // 1. Find or create canonical identity by email.
  let identity = await env.DB.prepare('SELECT * FROM identities WHERE email = ?').bind(email).first();
  let person_id;
  if (identity) {
    person_id = identity.id;
    await env.DB.prepare(
      'UPDATE identities SET cookie_id = COALESCE(cookie_id, ?), last_seen_at = ? WHERE id = ?',
    ).bind(cookie_id, t, person_id).run();
  } else {
    person_id = uid();
    await env.DB.prepare(
      `INSERT INTO identities (id, cookie_id, email, channel, display_name, meta, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      person_id, cookie_id, email, 'web',
      body.display_name ?? null,
      body.meta ? JSON.stringify(body.meta) : null,
      t, t,
    ).run();
  }

  // 2. Merge any prior person_ids that the cookie was already linked to.
  // Sources of truth: sessions OR identity_links.
  const merges = [];
  if (cookie_id) {
    const priorR = await env.DB.prepare(`
      SELECT DISTINCT pid FROM (
        SELECT person_id AS pid FROM sessions       WHERE cookie_id = ? AND person_id IS NOT NULL
        UNION
        SELECT person_id AS pid FROM identity_links WHERE cookie_id = ? AND person_id IS NOT NULL
      ) WHERE pid IS NOT NULL AND pid != ?
    `).bind(cookie_id, cookie_id, person_id).all();
    for (const row of (priorR.results || [])) {
      const r = await mergePersonIds(env, row.pid, person_id);
      if (r.merged) merges.push(row.pid);
    }
  }

  // 3. Backfill person_id on all sessions for this cookie.
  let sessions_backfilled = 0;
  if (cookie_id) {
    const r = await env.DB.prepare(
      'UPDATE sessions SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    sessions_backfilled = r.meta?.changes ?? 0;
  } else if (session_id) {
    await env.DB.prepare('UPDATE sessions SET person_id = ? WHERE id = ?').bind(person_id, session_id).run();
    sessions_backfilled = 1;
  }

  // 4. Backfill person_id on all web_events for this cookie.
  let events_backfilled = 0;
  if (cookie_id) {
    const r = await env.DB.prepare(
      'UPDATE web_events SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    events_backfilled = r.meta?.changes ?? 0;
  }

  // 5. Audit the (cookie ↔ person ↔ email) link. Skip if exact tuple already exists.
  if (cookie_id) {
    const exists = await env.DB.prepare(
      `SELECT id FROM identity_links
        WHERE cookie_id = ? AND person_id = ? AND identifier_type = 'email' AND identifier_value = ?`,
    ).bind(cookie_id, person_id, email).first();
    if (!exists) {
      await env.DB.prepare(
        `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), cookie_id, person_id, 'email', email,
        body.method ?? 'email_submit',
        body.source_event_id ?? null,
        t,
      ).run();
    }
  }

  return {
    person_id, email,
    sessions_backfilled, events_backfilled,
    merged_person_ids: merges,
  };
}

// Symmetric to identifyByEmail but keyed on phone — for the WhatsApp channel.
// Same backfill of sessions + web_events for the cookie, same merge of any
// prior person_id seen on the cookie, same identity_links audit row.
function normalizePhone(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // Strip everything that isn't a digit; require + prefix on output.
  const digits = t.replace(/\D/g, '');
  return digits ? '+' + digits : '';
}

export async function identifyByPhone(env, body) {
  const phone = normalizePhone(body.phone);
  if (!phone) throw new Error('phone required');
  const cookie_id  = body.cookie_id  || null;
  const session_id = body.session_id || null;
  const t = now();

  let identity = await env.DB.prepare('SELECT * FROM identities WHERE phone = ?').bind(phone).first();
  let person_id;
  if (identity) {
    person_id = identity.id;
    await env.DB.prepare(
      'UPDATE identities SET cookie_id = COALESCE(cookie_id, ?), last_seen_at = ? WHERE id = ?',
    ).bind(cookie_id, t, person_id).run();
  } else {
    person_id = uid();
    await env.DB.prepare(
      `INSERT INTO identities (id, cookie_id, phone, channel, display_name, meta, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      person_id, cookie_id, phone,
      body.channel || 'whatsapp',
      body.display_name ?? null,
      body.meta ? JSON.stringify(body.meta) : null,
      t, t,
    ).run();
  }

  // Merge any prior person_ids the cookie was linked to.
  const merges = [];
  if (cookie_id) {
    const priorR = await env.DB.prepare(`
      SELECT DISTINCT pid FROM (
        SELECT person_id AS pid FROM sessions       WHERE cookie_id = ? AND person_id IS NOT NULL
        UNION
        SELECT person_id AS pid FROM identity_links WHERE cookie_id = ? AND person_id IS NOT NULL
      ) WHERE pid IS NOT NULL AND pid != ?
    `).bind(cookie_id, cookie_id, person_id).all();
    for (const row of (priorR.results || [])) {
      const r = await mergePersonIds(env, row.pid, person_id);
      if (r.merged) merges.push(row.pid);
    }
  }

  // Backfill sessions + web_events for this cookie.
  let sessions_backfilled = 0;
  let events_backfilled = 0;
  if (cookie_id) {
    const sr = await env.DB.prepare(
      'UPDATE sessions SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    sessions_backfilled = sr.meta?.changes ?? 0;
    const er = await env.DB.prepare(
      'UPDATE web_events SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    events_backfilled = er.meta?.changes ?? 0;
  }

  // Audit the (cookie ↔ person ↔ phone) link.
  if (cookie_id) {
    const exists = await env.DB.prepare(
      `SELECT id FROM identity_links
        WHERE cookie_id = ? AND person_id = ? AND identifier_type = 'phone' AND identifier_value = ?`,
    ).bind(cookie_id, person_id, phone).first();
    if (!exists) {
      await env.DB.prepare(
        `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), cookie_id, person_id, 'phone', phone,
        body.method ?? 'wa_inbound',
        body.source_event_id ?? null,
        t,
      ).run();
    }
  }

  return { person_id, phone, sessions_backfilled, events_backfilled, merged_person_ids: merges };
}

// Detailed identity rollup for the ops UI drawer.
export async function getIdentityDetail(env, id) {
  const identity = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(id).first();
  if (!identity) return null;

  const [cookiesR, sessionsR, eventsR, conversionsR, linksR] = await Promise.all([
    env.DB.prepare(`
      SELECT DISTINCT cookie_id FROM (
        SELECT cookie_id FROM sessions       WHERE person_id = ? AND cookie_id IS NOT NULL
        UNION
        SELECT cookie_id FROM identity_links WHERE person_id = ? AND cookie_id IS NOT NULL
      )
    `).bind(id, id).all(),
    env.DB.prepare('SELECT * FROM sessions       WHERE person_id   = ? ORDER BY started_at DESC LIMIT 20').bind(id).all(),
    env.DB.prepare('SELECT * FROM web_events     WHERE person_id   = ? ORDER BY created_at DESC LIMIT 50').bind(id).all(),
    env.DB.prepare('SELECT * FROM conversions    WHERE identity_id = ? ORDER BY created_at DESC').bind(id).all(),
    env.DB.prepare('SELECT * FROM identity_links WHERE person_id   = ? ORDER BY created_at DESC').bind(id).all(),
  ]);

  return {
    identity: { ...identity, meta: safeJSON(identity.meta) },
    cookies:     (cookiesR.results || []).map((r) => r.cookie_id),
    sessions:    sessionsR.results    || [],
    events:      (eventsR.results     || []).map((e) => ({ ...e, event_data: safeJSON(e.event_data) })),
    conversions: (conversionsR.results|| []).map((c) => ({ ...c, payload:    safeJSON(c.payload) })),
    links:       linksR.results       || [],
  };
}

// ─── conversions / pipeline stages ───────────────────────────
// Pipeline stage vocab. Online stages fire from the public tracker, offline
// stages are entered by the operator from the ops Funnel module.
export const STAGES = [
  { key: 'lead',         label: 'Lead',         channel: 'website' },
  { key: 'mql',          label: 'MQL',          channel: 'website' },
  { key: 'sql',          label: 'SQL',          channel: 'website' },
  { key: 'negotiations', label: 'Negotiations', channel: 'offline' },
  { key: 'deal',         label: 'Deal',         channel: 'offline' },
  { key: 'contract',     label: 'Contract',     channel: 'offline' },
  { key: 'client',       label: 'Client',       channel: 'offline' },
  { key: 'dropped',      label: 'Dropped',      channel: 'offline', tone: 'negative' },
  { key: 'disqualified', label: 'Disqualified', channel: 'website', tone: 'negative' },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
// Back-compat alias — old public-site code may still POST 'booked'; treat as sql.
const KIND_ALIASES = { booked: 'sql' };
const CONVERSION_KINDS = STAGE_KEYS.concat(Object.keys(KIND_ALIASES));

export async function logConversion(env, body) {
  let kind = String(body.kind || '').toLowerCase();
  if (KIND_ALIASES[kind]) kind = KIND_ALIASES[kind];
  if (!CONVERSION_KINDS.includes(kind)) {
    throw new Error(`unknown conversion kind ${kind}. Allowed: ${STAGE_KEYS.join(', ')}`);
  }
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO conversions (id, identity_id, session_id, kind, value, currency, source, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    body.person_id ?? null,
    body.session_id ?? null,
    kind,
    body.value ?? null,
    body.currency ?? 'USD',
    body.source ?? 'web',
    body.payload ? JSON.stringify(body.payload) : null,
    now(),
  ).run();
  await logEvent(env, { kind: 'conversion_logged', actor: body.source || 'web', payload: { kind, person_id: body.person_id, value: body.value } });
  return { conversion_id: id, kind };
}

// People (identities) who reached a given pipeline stage in the window.
// Sorted by most-recent reach. Includes the conversion's first-reach ts +
// total touches at this stage so the operator sees both recency and weight.
export async function peopleAtStage(env, kind, since = '24h') {
  if (!STAGE_KEYS.includes(kind)) throw new Error(`unknown stage ${kind}`);
  const ms = WINDOW_MS[since] ?? WINDOW_MS['24h'];
  const sinceTs = ms ? now() - ms : 0;
  const r = await env.DB.prepare(`
    SELECT i.id, i.email, i.display_name, i.first_seen_at, i.last_seen_at,
           MIN(c.created_at) AS reached_at,
           MAX(c.created_at) AS last_touch_at,
           COUNT(c.id)       AS touches,
           SUM(c.value)      AS total_value
      FROM conversions c
      LEFT JOIN identities i ON i.id = c.identity_id
     WHERE c.kind = ? AND c.created_at >= ?
     GROUP BY c.identity_id
     ORDER BY last_touch_at DESC
  `).bind(kind, sinceTs).all();
  return (r.results || []).map((x) => ({
    person_id:     x.id,
    email:         x.email,
    display_name:  x.display_name,
    reached_at:    x.reached_at,
    last_touch_at: x.last_touch_at,
    touches:       x.touches,
    total_value:   x.total_value,
  }));
}

// ─── operator-facing reads (Funnel module in ops UI) ─────────
export async function recentWebSessions(env, limit = 100) {
  // Include event count + best-known email per session for the ops list.
  const r = await env.DB.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM web_events e WHERE e.session_id = s.id) AS events_count,
           (SELECT email FROM identities i WHERE i.id = s.person_id)     AS person_email
      FROM sessions s
     ORDER BY s.started_at DESC
     LIMIT ?
  `).bind(limit).all();
  return r.results || [];
}
export async function recentWebEvents(env, limit = 200) {
  const r = await env.DB.prepare(`
    SELECT e.*,
           (SELECT email FROM identities i WHERE i.id = e.person_id) AS person_email
      FROM web_events e
     ORDER BY e.created_at DESC
     LIMIT ?
  `).bind(limit).all();
  return (r.results || []).map((e) => ({ ...e, event_data: safeJSON(e.event_data) }));
}
export async function listIdentities(env, limit = 100) {
  // Include rollups so the ops list can show "20 events / 3 sessions / 2 conversions".
  const r = await env.DB.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM sessions    s WHERE s.person_id   = i.id) AS sessions_count,
           (SELECT COUNT(*) FROM web_events  e WHERE e.person_id   = i.id) AS events_count,
           (SELECT COUNT(*) FROM conversions c WHERE c.identity_id = i.id) AS conversions_count
      FROM identities i
     ORDER BY i.last_seen_at DESC
     LIMIT ?
  `).bind(limit).all();
  return (r.results || []).map((x) => ({ ...x, meta: safeJSON(x.meta) }));
}
export async function recentConversions(env, limit = 100) {
  const r = await env.DB.prepare(`
    SELECT c.*,
           (SELECT email FROM identities i WHERE i.id = c.identity_id) AS person_email
      FROM conversions c
     ORDER BY c.created_at DESC
     LIMIT ?
  `).bind(limit).all();
  return (r.results || []).map((c) => ({ ...c, payload: safeJSON(c.payload) }));
}

// Aggregate funnel KPIs over a rolling window. Returns counts per event_type
// + sessions, identities, conversions(by-kind) + ratios between stages.
const WINDOW_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, 'all': null };
export async function funnelStats(env, since = '24h') {
  const ms = WINDOW_MS[since] ?? WINDOW_MS['24h'];
  const sinceTs = ms ? now() - ms : 0;

  const [sessionsR, identitiesR, eventsR, conversionsR] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?').bind(sinceTs).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM identities WHERE first_seen_at >= ?').bind(sinceTs).first(),
    env.DB.prepare(`
      SELECT event_type, COUNT(*) AS n
        FROM web_events
       WHERE created_at >= ?
       GROUP BY event_type
       ORDER BY n DESC
    `).bind(sinceTs).all(),
    env.DB.prepare(`
      SELECT kind, COUNT(*) AS n, COALESCE(SUM(value), 0) AS total_value
        FROM conversions
       WHERE created_at >= ?
       GROUP BY kind
    `).bind(sinceTs).all(),
  ]);

  const eventsByType = Object.fromEntries((eventsR.results || []).map((r) => [r.event_type, r.n]));
  const conversionsByKind = Object.fromEntries((conversionsR.results || []).map((r) => [r.kind, { n: r.n, total_value: r.total_value }]));

  const visits      = eventsByType.visit         ?? 0;
  const preqSubmits = eventsByType.preq_submit   ?? 0;
  const leads       = conversionsByKind.lead?.n         ?? 0;
  const mqls        = conversionsByKind.mql?.n          ?? 0;
  const sqls        = conversionsByKind.sql?.n          ?? 0;
  // Back-compat: old 'booked' rows count toward sql too.
  const booked      = (conversionsByKind.booked?.n      ?? 0) + sqls;
  const dq          = conversionsByKind.disqualified?.n ?? 0;

  return {
    since,
    since_ts: sinceTs,
    generated_at: now(),
    sessions:    sessionsR?.n ?? 0,
    identities:  identitiesR?.n ?? 0,
    visits,
    preq_submits: preqSubmits,
    leads,
    mqls,
    booked,
    disqualified: dq,
    rates: {
      visit_to_preq:  visits ? preqSubmits / visits : 0,
      preq_to_lead:   preqSubmits ? leads / preqSubmits : 0,
      lead_to_mql:    leads ? mqls / leads : 0,
      mql_to_booked:  mqls ? booked / mqls : 0,
    },
    events_by_type:      eventsByType,
    conversions_by_kind: conversionsByKind,
  };
}

// ─── Overview ────────────────────────────────────────────────
// Shape modeled after seamless-cmd Overview: KPI cards with delta-%, funnel
// bars (CONV/DEV/AVG), campaigns table with delta-% per cell. Trend + heatmap
// land in phase 2.
export async function overviewStats(env, since = '7d') {
  const ms = WINDOW_MS[since] ?? WINDOW_MS['7d'];
  const nowMs = now();
  const curStart  = ms ? nowMs - ms     : 0;
  const prevStart = ms ? nowMs - 2 * ms : 0;
  const prevEnd   = ms ? curStart       : 0;
  const hasPrev   = ms != null;

  async function distinctVisitors(from, to) {
    if (to) {
      const r = await env.DB.prepare('SELECT COUNT(DISTINCT cookie_id) AS n FROM sessions WHERE started_at >= ? AND started_at < ?').bind(from, to).first();
      return r?.n ?? 0;
    }
    const r = await env.DB.prepare('SELECT COUNT(DISTINCT cookie_id) AS n FROM sessions WHERE started_at >= ?').bind(from).first();
    return r?.n ?? 0;
  }
  async function convCount(kind, from, to) {
    if (to) {
      const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM conversions WHERE kind = ? AND created_at >= ? AND created_at < ?').bind(kind, from, to).first();
      return r?.n ?? 0;
    }
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM conversions WHERE kind = ? AND created_at >= ?').bind(kind, from).first();
    return r?.n ?? 0;
  }
  function pctDelta(cur, prev) {
    if (prev === 0) return cur === 0 ? 0 : 100;
    return Math.round(((cur - prev) / prev) * 100);
  }
  const rate = (a, b) => (b > 0 ? (a / b) * 100 : 0);

  const [vCur, vPrev, lCur, lPrev, mCur, mPrev, sCur, sPrev, vAll, lAll, mAll, sAll] = await Promise.all([
    distinctVisitors(curStart),
    hasPrev ? distinctVisitors(prevStart, prevEnd) : 0,
    convCount('lead', curStart),
    hasPrev ? convCount('lead', prevStart, prevEnd) : 0,
    convCount('mql', curStart),
    hasPrev ? convCount('mql', prevStart, prevEnd) : 0,
    convCount('sql', curStart),
    hasPrev ? convCount('sql', prevStart, prevEnd) : 0,
    distinctVisitors(0),
    convCount('lead', 0),
    convCount('mql', 0),
    convCount('sql', 0),
  ]);

  const funnel = [
    { key: 'visit', label: 'VISIT', n: vCur, conv_pct: 100,
      dev_pp: 0, avg_pct: 100 },
    { key: 'lead',  label: 'LEAD',  n: lCur, conv_pct: rate(lCur, vCur),
      dev_pp: +(rate(lCur, vCur) - rate(lAll, vAll)).toFixed(1), avg_pct: +rate(lAll, vAll).toFixed(1) },
    { key: 'mql',   label: 'MQL',   n: mCur, conv_pct: rate(mCur, lCur),
      dev_pp: +(rate(mCur, lCur) - rate(mAll, lAll)).toFixed(1), avg_pct: +rate(mAll, lAll).toFixed(1) },
    { key: 'sql',   label: 'SQL',   n: sCur, conv_pct: rate(sCur, mCur),
      dev_pp: +(rate(sCur, mCur) - rate(sAll, mAll)).toFixed(1), avg_pct: +rate(sAll, mAll).toFixed(1) },
  ].map((row) => ({ ...row, conv_pct: +row.conv_pct.toFixed(1) }));

  // Campaigns — group sessions in window by utm_campaign + utm_source,
  // attach conversion counts via session_id join. Same-shape query for prev
  // window so we can render delta-% per cell.
  async function campaignsFor(from, to) {
    // Group traffic by a MEANINGFUL source + landing page, not just the UTM tags.
    // Untagged organic traffic (google search, direct blog visits) has no
    // utm_source, so classify the referrer into a channel instead of dumping it
    // all into "direct". Landing path is stripped of its query string so
    // cache-busters (?cb=...) don't split one page into many rows.
    const derive = `
        COALESCE(NULLIF(utm_campaign, ''), 'direct') AS name,
        CASE
          WHEN utm_source IS NOT NULL AND utm_source != '' THEN utm_source
          WHEN referrer LIKE '%google.%'    THEN 'google'
          WHEN referrer LIKE '%bing.%'      THEN 'bing'
          WHEN referrer LIKE '%duckduckgo%' THEN 'duckduckgo'
          WHEN referrer LIKE '%linkedin.%' OR referrer LIKE '%lnkd.in%' THEN 'linkedin'
          WHEN referrer LIKE '%facebook.%' OR referrer LIKE '%fb.%'     THEN 'facebook'
          WHEN referrer LIKE '%t.co%' OR referrer LIKE '%twitter.%' OR referrer LIKE '%x.com%' THEN 'x'
          WHEN referrer IS NULL OR referrer = '' THEN 'direct'
          ELSE 'referral'
        END AS source,
        CASE WHEN instr(landing_path, '?') > 0
             THEN substr(landing_path, 1, instr(landing_path, '?') - 1)
             ELSE COALESCE(NULLIF(landing_path, ''), '/') END AS landing`;
    const inner = to
      ? `SELECT id, started_at, ${derive} FROM sessions WHERE started_at >= ? AND started_at < ?`
      : `SELECT id, started_at, ${derive} FROM sessions WHERE started_at >= ?`;
    const cols = `s.name, s.source, s.landing,
                COUNT(DISTINCT s.id)                              AS visits,
                SUM(CASE WHEN c.kind = 'lead' THEN 1 ELSE 0 END)  AS leads,
                SUM(CASE WHEN c.kind = 'mql'  THEN 1 ELSE 0 END)  AS mqls,
                SUM(CASE WHEN c.kind = 'sql'  THEN 1 ELSE 0 END)  AS sqls`;
    const q = to
      ? `SELECT ${cols} FROM (${inner}) s
           LEFT JOIN conversions c ON c.session_id = s.id AND c.created_at >= ? AND c.created_at < ?
           GROUP BY s.name, s.source, s.landing`
      : `SELECT ${cols} FROM (${inner}) s
           LEFT JOIN conversions c ON c.session_id = s.id AND c.created_at >= ?
           GROUP BY s.name, s.source, s.landing`;
    const r = to
      ? await env.DB.prepare(q).bind(from, to, from, to).all()
      : await env.DB.prepare(q).bind(from, from).all();
    return r.results || [];
  }
  // Stages — distinct identities reaching each of the 9 pipeline stages.
  // Same counting logic as peopleAtStage so the Overview embed matches the
  // Pipeline tab exactly. Two single-query trips (current + previous window)
  // GROUP BY kind so we don't hammer D1 with one query per stage.
  async function stageCountsFor(from, to) {
    const q = to
      ? `SELECT kind, COUNT(DISTINCT COALESCE(identity_id, id)) AS n
           FROM conversions
           WHERE created_at >= ? AND created_at < ?
           GROUP BY kind`
      : `SELECT kind, COUNT(DISTINCT COALESCE(identity_id, id)) AS n
           FROM conversions
           WHERE created_at >= ?
           GROUP BY kind`;
    const r = to
      ? await env.DB.prepare(q).bind(from, to).all()
      : await env.DB.prepare(q).bind(from).all();
    const out = {};
    for (const row of r.results || []) out[row.kind] = row.n;
    return out;
  }

  const [curCamps, prevCamps, curStages, prevStages] = await Promise.all([
    campaignsFor(curStart),
    hasPrev ? campaignsFor(prevStart, prevEnd) : Promise.resolve([]),
    stageCountsFor(curStart),
    hasPrev ? stageCountsFor(prevStart, prevEnd) : Promise.resolve({}),
  ]);
  const stages = STAGES.map((s) => {
    const n = curStages[s.key] || 0;
    const prev = prevStages[s.key] || 0;
    return {
      key: s.key,
      label: s.label,
      channel: s.channel,
      tone: s.tone || null,
      n,
      prev_n: prev,
      delta_pct: hasPrev ? pctDelta(n, prev) : null,
    };
  });
  const prevMap = Object.fromEntries(prevCamps.map((r) => [`${r.name}::${r.source}::${r.landing}`, r]));
  const campaigns = curCamps
    .sort((a, b) => (b.visits || 0) - (a.visits || 0))
    .slice(0, 12)
    .map((r) => {
      const p = prevMap[`${r.name}::${r.source}::${r.landing}`] || { visits: 0, leads: 0, mqls: 0, sqls: 0 };
      return {
        name: r.name,
        source: r.source,
        landing:          r.landing || null,
        visits:           r.visits || 0,
        visits_delta_pct: hasPrev ? pctDelta(r.visits || 0, p.visits || 0) : null,
        leads:            r.leads || 0,
        leads_delta_pct:  hasPrev ? pctDelta(r.leads || 0, p.leads || 0) : null,
        mqls:             r.mqls || 0,
        mqls_delta_pct:   hasPrev ? pctDelta(r.mqls || 0, p.mqls || 0) : null,
        sqls:             r.sqls || 0,
        sqls_delta_pct:   hasPrev ? pctDelta(r.sqls || 0, p.sqls || 0) : null,
      };
    });

  return {
    since,
    generated_at: nowMs,
    has_prev: hasPrev,
    kpis: {
      visitors: { n: vCur, delta_pct: hasPrev ? pctDelta(vCur, vPrev) : null },
      leads:    { n: lCur, delta_pct: hasPrev ? pctDelta(lCur, lPrev) : null },
      mqls:     { n: mCur, delta_pct: hasPrev ? pctDelta(mCur, mPrev) : null },
      sqls:     { n: sCur, delta_pct: hasPrev ? pctDelta(sCur, sPrev) : null },
    },
    funnel,
    stages,
    campaigns,
  };
}

// ─── Overview breakdowns ─────────────────────────────────────
// Deep drill for the Overview: group the window's sessions by ONE dimension —
// source (derived channel), referrer (raw URL), landing (query-stripped path),
// or campaign — with conversion counts per row. NO top-N cap: every referrer
// and landing page in the window shows. webBreakdownSessions then returns the
// actual sessions behind any row (session ids included) so a number is always
// one click away from the raw evidence.
const BREAKDOWN_DIMS = {
  source: `CASE
    WHEN s.utm_source IS NOT NULL AND s.utm_source != '' THEN s.utm_source
    WHEN s.referrer LIKE '%google.%'    THEN 'google'
    WHEN s.referrer LIKE '%bing.%'      THEN 'bing'
    WHEN s.referrer LIKE '%duckduckgo%' THEN 'duckduckgo'
    WHEN s.referrer LIKE '%linkedin.%' OR s.referrer LIKE '%lnkd.in%' THEN 'linkedin'
    WHEN s.referrer LIKE '%facebook.%' OR s.referrer LIKE '%fb.%'     THEN 'facebook'
    WHEN s.referrer LIKE '%t.co%' OR s.referrer LIKE '%twitter.%' OR s.referrer LIKE '%x.com%' THEN 'x'
    WHEN s.referrer IS NULL OR s.referrer = '' THEN 'direct'
    ELSE 'referral'
  END`,
  referrer: `COALESCE(NULLIF(s.referrer, ''), '(none)')`,
  landing:  `CASE WHEN instr(s.landing_path, '?') > 0
                  THEN substr(s.landing_path, 1, instr(s.landing_path, '?') - 1)
                  ELSE COALESCE(NULLIF(s.landing_path, ''), '/') END`,
  campaign: `COALESCE(NULLIF(s.utm_campaign, ''), '(none)')`,
};

export async function webBreakdown(env, { since = '7d', by = 'source' } = {}) {
  const dim = BREAKDOWN_DIMS[by] || BREAKDOWN_DIMS.source;
  const ms = WINDOW_MS[since] ?? WINDOW_MS['7d'];
  const from = ms ? now() - ms : 0;
  const r = await env.DB.prepare(`
    SELECT ${dim} AS value,
           COUNT(DISTINCT s.id)        AS visits,
           COUNT(DISTINCT s.cookie_id) AS visitors,
           SUM(CASE WHEN c.kind = 'lead' THEN 1 ELSE 0 END) AS leads,
           SUM(CASE WHEN c.kind = 'mql'  THEN 1 ELSE 0 END) AS mqls,
           SUM(CASE WHEN c.kind = 'sql'  THEN 1 ELSE 0 END) AS sqls,
           MAX(s.started_at)           AS last_visit_at
      FROM sessions s
      LEFT JOIN conversions c ON c.session_id = s.id AND c.created_at >= ?
     WHERE s.started_at >= ?
     GROUP BY ${dim}
     ORDER BY visits DESC, last_visit_at DESC
  `).bind(from, from).all();
  return { since, by, rows: r.results || [] };
}

export async function webBreakdownSessions(env, { since = '7d', by = 'source', value, limit = 200 } = {}) {
  const dim = BREAKDOWN_DIMS[by] || BREAKDOWN_DIMS.source;
  const ms = WINDOW_MS[since] ?? WINDOW_MS['7d'];
  const from = ms ? now() - ms : 0;
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const r = await env.DB.prepare(`
    SELECT s.id, s.started_at, s.last_seen_at, s.cookie_id, s.person_id,
           s.referrer, s.landing_path, s.utm_source, s.utm_medium, s.utm_campaign,
           s.browser, s.os, s.device, s.gclid, s.fbclid,
           (SELECT COUNT(*) FROM web_events e WHERE e.session_id = s.id)             AS events_count,
           (SELECT email FROM identities i WHERE i.id = s.person_id)                 AS person_email,
           (SELECT GROUP_CONCAT(kind) FROM conversions c WHERE c.session_id = s.id)  AS conversion_kinds
      FROM sessions s
     WHERE s.started_at >= ? AND ${dim} = ?
     ORDER BY s.started_at DESC
     LIMIT ?
  `).bind(from, String(value ?? ''), cap).all();
  return { since, by, value, sessions: r.results || [] };
}

// ─── Sankey ──────────────────────────────────────────────────
// Five-pass build per the seamless-cmd recipe:
//   1. Cohort — sessions in window with a person_id.
//   2. First touch — earliest session per person → campaign + landing page.
//   3. Stage classification — set of stages each person reached.
//   4. Monotonic fill — reaching stage N implies stages 1..N.
//   5. Link aggregation — group (source, target, campaign) and count.
export async function sankeyData(env, since = '7d') {
  const ms = WINDOW_MS[since] ?? WINDOW_MS['7d'];
  const nowMs = now();
  const sinceTs = ms ? nowMs - ms : 0;

  // 1+2. Cohort + first-touch.
  const sessR = await env.DB.prepare(`
    SELECT id, person_id, utm_campaign, utm_source, landing_path, started_at
      FROM sessions
     WHERE started_at >= ? AND person_id IS NOT NULL
     ORDER BY started_at ASC
  `).bind(sinceTs).all();

  const firstTouch = new Map();
  for (const s of sessR.results || []) {
    if (firstTouch.has(s.person_id)) continue;
    firstTouch.set(s.person_id, {
      campaign: (s.utm_campaign && String(s.utm_campaign).trim()) || 'Direct',
      landing:  s.landing_path || '/',
    });
  }

  // 3+4. Stages per person + monotonic backfill.
  const STAGE_CHAIN = ['lead', 'mql', 'sql', 'negotiations', 'deal', 'contract', 'client'];
  const convR = await env.DB.prepare(`
    SELECT identity_id, kind FROM conversions
     WHERE created_at >= ? AND identity_id IS NOT NULL
  `).bind(sinceTs).all();

  const stagesReached = new Map();
  for (const c of convR.results || []) {
    if (!stagesReached.has(c.identity_id)) stagesReached.set(c.identity_id, new Set());
    stagesReached.get(c.identity_id).add(c.kind);
  }
  for (const set of stagesReached.values()) {
    let highest = -1;
    for (let i = 0; i < STAGE_CHAIN.length; i++) if (set.has(STAGE_CHAIN[i])) highest = i;
    for (let i = 0; i <= highest; i++) set.add(STAGE_CHAIN[i]);
  }

  // 5. Link aggregation. Six columns:
  //    0 campaign → 1 lp → 2 lead → 3 mql → 4 sql → 5 client
  // Two PARALLEL BANDS classified by destiny: top = will reach CLIENT, bottom
  // = will drop somewhere. Every column has top + bottom sub-nodes (campaign,
  // LP, and each stage). People stay in their destined band the whole way —
  // no ribbon ever crosses bands, so the chart reads as two clean funnels.
  // The bottom band shrinks at each transition; the shrinkage at column X
  // visualizes the drop count at stage X-1.
  const COLUMNS = [
    { key: 'campaign', label: 'CAMPAIGN' },
    { key: 'lp',       label: 'LP' },
    { key: 'lead',     label: 'LEAD' },
    { key: 'mql',      label: 'MQL' },
    { key: 'sql',      label: 'SQL' },
    { key: 'client',   label: 'CLIENT' },
  ];
  const STAGE_KEYS = ['lead', 'mql', 'sql', 'client'];

  const linkMap = new Map();
  function bump(source, target, campaign) {
    const k = `${campaign}|${source}|${target}`;
    const cur = linkMap.get(k);
    if (cur) cur.value += 1;
    else linkMap.set(k, { source, target, value: 1, campaign });
  }

  let cohortInFunnel = 0;
  for (const [pid, t] of firstTouch) {
    const stages = stagesReached.get(pid) || new Set();
    let deepestIdx = -1;
    for (let i = 0; i < STAGE_KEYS.length; i++) if (stages.has(STAGE_KEYS[i])) deepestIdx = i;
    if (deepestIdx < 0) continue; // never reached a funnel stage
    cohortInFunnel++;

    // Destiny classifier — reaches CLIENT (top) or drops somewhere (bottom).
    const band = stages.has('client') ? 'top' : 'bottom';

    const chain = [`campaign:${t.campaign}:${band}`, `lp:${t.landing}:${band}`];
    // Walk through every stage they actually reached, all in their band. The
    // ribbon naturally terminates at their deepest stage — that's how the
    // bottom band visibly shrinks (e.g. lead-droppers' ribbons end at LEAD).
    for (let i = 0; i <= deepestIdx; i++) chain.push(`stage:${STAGE_KEYS[i]}:${band}`);

    for (let i = 0; i < chain.length - 1; i++) bump(chain[i], chain[i + 1], t.campaign);
  }

  const links = [...linkMap.values()];

  // Build node set from links. Side encoded in id (`:top`/`:bottom`).
  function colFor(id) {
    const parts = id.split(':');
    const prefix = parts[0];
    const band   = parts[parts.length - 1]; // 'top' | 'bottom'
    const name   = parts.slice(1, -1).join(':');
    if (prefix === 'campaign') return { column: 0, side: band, label: name };
    if (prefix === 'lp')       return { column: 1, side: band, label: name };
    if (prefix === 'stage') {
      const i = STAGE_KEYS.indexOf(name);
      return { column: 2 + i, side: band, label: COLUMNS[2 + i].label };
    }
    return { column: -1, side: band, label: id };
  }
  const nodeAcc = new Map();
  function ensure(id) {
    if (!nodeAcc.has(id)) {
      const meta = colFor(id);
      nodeAcc.set(id, { id, ...meta, value: 0, in: 0, out: 0 });
    }
    return nodeAcc.get(id);
  }
  for (const l of links) {
    ensure(l.source).out += l.value;
    ensure(l.target).in  += l.value;
  }
  const nodes = [...nodeAcc.values()].map((n) => ({
    ...n,
    value: Math.max(n.in, n.out),
  }));

  // Campaign colors — even hue spread. Use the same hue for both bands of a
  // campaign so the eye traces one color through both top + bottom flows.
  const campaignSet = [...new Set(nodes.filter((n) => n.column === 0).map((n) => n.label))].sort();
  const campaigns = campaignSet;
  for (const n of nodes) {
    if (n.column === 0) {
      const idx = campaignSet.indexOf(n.label);
      n.color = `hsl(${Math.round((idx / Math.max(1, campaignSet.length)) * 360)}, 70%, 55%)`;
    } else if (n.side === 'bottom') {
      n.color = '#fb7185'; // rose-400 — bottom-band nodes signal loss
    } else {
      n.color = '#cbd5e1';
    }
  }

  return {
    since,
    generated_at: nowMs,
    cohort_total: firstTouch.size,
    cohort_in_funnel: cohortInFunnel,
    campaigns,
    columns: COLUMNS,
    nodes,
    links,
  };
}
