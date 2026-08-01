// KPI — the operator's daily outreach goal, measured against what actually
// went out across BOTH channels (LinkedIn + WhatsApp).
//
// nyyon-lite placement: this is the shared computation behind the
// `kpi_outreach_status` tool and the Digest module's KPI bar. The target and
// what-counts rules live in an editable knowledge note (kpi-outreach), seeded
// with a default on first read — change the goal by editing the note, no deploy.
//
// What counts as one outreach: the FIRST time you message a person, counted
// once on that day — an ongoing thread never re-counts. Per channel:
//   WhatsApp — a 1:1 chat (groups excluded) whose first outbound message is today
//   LinkedIn — a prospect whose first sequence MESSAGE is today; connection
//              requests never count.
// "Today" and "is it a work day" are resolved in the operator's timezone so the
// counter rolls over at local midnight, not UTC.

import { readKnowledge, writeKnowledge, logEvent } from './db.js';
import { ensureClassified } from './outreach-classify.js';
import { callGateway } from '../gateways/index.js';
import { refreshWaThreads, getThreadStats } from './outreach-threads.js';

const KPI_SLUG = 'kpi-outreach';

export const KPI_DEFAULTS = {
  daily_target: 20,          // NEW outreaches per work day, across LI + WA
  tz: 'Asia/Jerusalem',      // the day + work-week are read in this zone (TLV)
  work_days: [0, 1, 2, 3, 4], // 0=Sun .. 6=Sat — Sun-Thu is the Israeli work week
  work_hours: [8, 22],       // local TLV hours that frame the workday (drives pace / "expected by now")
};

function kpiSeedBody(cfg) {
  return `Daily outreach KPI — the goal and how progress is measured.

The target is \`daily_target\` NEW outreaches per WORK DAY, counted across LinkedIn
and WhatsApp together. The Digest KPI bar and the \`kpi_outreach_status\` tool both
read this note live, and the hourly :00 cron logs a snapshot to the activity bus —
so the status is re-checked every hour with no deploy.

One "outreach" is the FIRST time you message a person — a person counts on the
day you first reach out to them, once, and an ongoing back-and-forth never counts
again. This is per channel: WhatsApp = a 1:1 chat whose first outbound message is
today (groups excluded); LinkedIn = a prospect whose first sequence MESSAGE is
today. LinkedIn CONNECTION REQUESTS do not count — only actual messages do.

\`tz\` fixes when "today" rolls over and which weekday it is, so the count resets
at local midnight. \`work_days\` are the weekdays the goal applies (0=Sun..6=Sat;
default Sun-Thu). \`work_hours\` frame the day for pace — "expected by now" ramps
from 0 at the start hour to the full target at the end hour, so you can tell
mid-afternoon whether you're behind.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;
}

function sanitizeKpi(src) {
  const out = { ...KPI_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null);
  const t = num(src.daily_target, 1, 1000); if (t !== null) out.daily_target = Math.round(t);
  if (typeof src.tz === 'string' && src.tz.trim()) out.tz = src.tz.trim();
  if (Array.isArray(src.work_days)) {
    const days = [...new Set(src.work_days.map((d) => num(d, 0, 6)).filter((d) => d !== null))].sort();
    if (days.length) out.work_days = days;
  }
  if (Array.isArray(src.work_hours) && src.work_hours.length === 2) {
    const a = num(src.work_hours[0], 0, 23), b = num(src.work_hours[1], 1, 24);
    if (a !== null && b !== null && a < b) out.work_hours = [a, b];
  }
  return out;
}

export async function loadKpiConfig(env) {
  try {
    const doc = await readKnowledge(env, KPI_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: KPI_SLUG, title: 'KPI · daily outreach goal',
        body: kpiSeedBody(KPI_DEFAULTS), parent_slug: 'module-digest',
      }).catch(() => {});
      return { ...KPI_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeKpi(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...KPI_DEFAULTS, source: 'defaults' };
  }
}

export async function saveKpiConfig(env, patch = {}) {
  const cur = await loadKpiConfig(env);
  const next = sanitizeKpi({ ...cur, ...patch });
  await writeKnowledge(env, {
    slug: KPI_SLUG, title: 'KPI · daily outreach goal',
    body: kpiSeedBody(next), parent_slug: 'module-digest',
  });
  await logEvent(env, { kind: 'kpi_outreach_updated', payload: next });
  return { ...next, source: 'doc' };
}

// ── timezone helpers ────────────────────────────────────────────────────────
// The Workers runtime clock is UTC. Formatting an instant into the target zone's
// wall-clock and RE-parsing that string (which Date.parse reads as runtime-UTC)
// yields the instant shifted by the zone's offset — the standard trick. Good to
// the minute; a DST-boundary midnight may be an hour off, which never matters
// for a per-day counter.
function tzOffsetMs(tz, atMs) {
  const wall = new Date(atMs).toLocaleString('en-US', { timeZone: tz, hour12: false });
  const asUtc = Date.parse(wall);
  return Number.isFinite(asUtc) ? asUtc - atMs : 0;
}

// wa_messages timestamps are ms in this store, but old rows may be seconds.
const waMs = (t) => (t == null ? null : (Number(t) < 1e12 ? Number(t) * 1000 : Number(t)));
// phone → canonical +digits (strips spaces/dashes/RTL marks/parens).
const canonPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? `+${d}` : null; };

function localParts(tz, atMs) {
  const off = tzOffsetMs(tz, atMs);
  const d = new Date(atMs + off); // fake-UTC whose UTC fields equal local wall clock
  const dayStartFake = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    weekday: d.getUTCDay(),
    hour: d.getUTCHours() + d.getUTCMinutes() / 60,
    dayStartMs: dayStartFake - off, // real ms of local midnight today
  };
}

// ── the KPI ─────────────────────────────────────────────────────────────────
export async function outreachKpi(env, { log = false } = {}) {
  const cfg = await loadKpiConfig(env);
  const nowMs = Date.now();
  const { weekday, hour, dayStartMs } = localParts(cfg.tz, nowMs);
  const isWorkDay = cfg.work_days.includes(weekday);

  // An outreach = a GENUINE outreach message (a pitch aligned with our outreach
  // content), not a follow-up/reply/personal chat. WhatsApp messages are judged
  // by CONTENT (the outreach-classify verdict cached in wa_outreach_class); this
  // read path counts only already-classified messages (fast, no LLM) — the
  // hourly cron + opening the log keep classifications fresh.
  //   WhatsApp: distinct 1:1 chats with a message classified is_outreach today
  //   LinkedIn: distinct conversations with a SENT message classified is_outreach
  //             today (li_sent_messages, synced from the inbox — covers engine +
  //             manual DMs; connection requests aren't messages, so never count)
  const waSql = `SELECT COUNT(DISTINCT m.chat_id) AS n
    FROM wa_messages m JOIN wa_outreach_class c ON c.msg_id = m.id
    WHERE m.from_me = 1 AND m.chat_id NOT LIKE '%@g.us' AND m.timestamp >= ? AND c.is_outreach = 1`;
  const liSql = `SELECT COUNT(DISTINCT conversation_urn) AS n FROM li_sent_messages
    WHERE is_outreach = 1 AND at >= ?`;

  let wa = 0; let li = 0;
  try { wa = (await env.DB.prepare(waSql).bind(dayStartMs).first())?.n || 0; } catch { /* table may be absent */ }
  try { li = (await env.DB.prepare(liSql).bind(dayStartMs).first())?.n || 0; } catch { /* table may be absent */ }

  const done = wa + li;
  const target = cfg.daily_target;
  const remaining = Math.max(0, target - done);
  const pct = target > 0 ? Math.min(1, done / target) : 0;

  // pace — how much of the workday has elapsed, and what that implies we should
  // have done by now (linear ramp across work_hours).
  const [startH, endH] = cfg.work_hours;
  const elapsedFrac = Math.max(0, Math.min(1, (hour - startH) / (endH - startH)));
  const expectedByNow = isWorkDay ? Math.round(target * elapsedFrac) : 0;

  let status;
  if (!isWorkDay) status = 'off_day';
  else if (done >= target) status = 'done';
  else if (done >= expectedByNow) status = 'on_track';
  else status = 'behind';

  const result = {
    target,
    done,
    remaining,
    pct,
    status,                 // off_day | behind | on_track | done
    expected_by_now: expectedByNow,
    is_work_day: isWorkDay,
    by_channel: { linkedin: li, whatsapp: wa },
    tz: cfg.tz,
    day_start_ms: dayStartMs,
    computed_at: nowMs,
  };

  // Only the hourly cron asks to log — a snapshot on the activity bus is the
  // "checked every hour" record. Read paths (UI poll, Nyo) don't log, to avoid
  // flooding the bus.
  if (log) await logEvent(env, { kind: 'kpi_outreach_snapshot', payload: { done, target, status, li, wa, is_work_day: isWorkDay } });

  return result;
}

// ── the outreach LOG — what you actually did today ──────────────────────────
// The KPI counts distinct people; this is the itemized attempts behind it, so
// clicking the bar answers "who did I reach out to, when, with what message".
// Sources: LinkedIn = li_touches (the sent copy is stored per touch); WhatsApp
// = outbound wa_messages (1:1 only). Each attempt is a real send, so multiple
// messages to one person show as multiple rows (unlike the deduped KPI count).

// Resolve WhatsApp chat_ids → a human name, best source first:
//   GTM lead name → stored chat name → the other party's inbound sender_name →
//   (backfill) the gateway's contact pushname → phone → "WhatsApp contact".
// Never returns a raw "…@lid" privacy id. With { backfill:true } it asks the
// WhatsApp gateway to resolve unknown lids → phone (cached into wa_lid_map) and
// fetch a display name (cached into wa_chats.name), so the log shows real names.
async function resolveChatNames(env, chatIds, { backfill = false } = {}) {
  const out = new Map();
  if (!chatIds.length) return out;
  const IN = (arr) => arr.map(() => '?').join(',');

  // stored chat names
  const chatName = new Map();
  for (let i = 0; i < chatIds.length; i += 80) {
    const c = chatIds.slice(i, i + 80);
    const r = (await env.DB.prepare(`SELECT id, name FROM wa_chats WHERE id IN (${IN(c)})`).bind(...c).all()).results || [];
    for (const row of r) if (row.name) chatName.set(row.id, row.name);
  }
  // the other party's name from an inbound message in that chat
  const inboundName = new Map();
  for (let i = 0; i < chatIds.length; i += 80) {
    const c = chatIds.slice(i, i + 80);
    const r = (await env.DB.prepare(
      `SELECT chat_id, sender_name, MAX(timestamp) FROM wa_messages
       WHERE from_me = 0 AND sender_name IS NOT NULL AND chat_id IN (${IN(c)}) GROUP BY chat_id`,
    ).bind(...c).all()).results || [];
    for (const row of r) if (row.sender_name) inboundName.set(row.chat_id, row.sender_name);
  }

  // chat → phone (c.us direct; lid via wa_lid_map)
  const chatPhone = new Map();
  const lidChats = [];
  for (const id of chatIds) {
    if (id.endsWith('@c.us')) { const p = canonPhone(id.split('@')[0]); if (p) chatPhone.set(id, p); }
    else if (id.endsWith('@lid')) lidChats.push(id);
  }
  for (let i = 0; i < lidChats.length; i += 80) {
    const c = lidChats.slice(i, i + 80);
    const r = (await env.DB.prepare(`SELECT lid, phone, pn FROM wa_lid_map WHERE lid IN (${IN(c)})`).bind(...c).all()).results || [];
    for (const row of r) { const p = canonPhone(row.phone || row.pn); if (p) chatPhone.set(row.lid, p); }
  }

  // backfill: resolve still-unknown lids through the gateway, cache into wa_lid_map
  const pushName = new Map();
  if (backfill) {
    const unknownLids = lidChats.filter((l) => !chatPhone.has(l)).slice(0, 20);
    if (unknownLids.length) {
      try {
        // { lid: phone|null } — resolveWaLids already caches into wa_lid_map.
        const res = await callGateway(env, 'whatsapp', 'resolve_lids', { lids: unknownLids });
        for (const [lid, phone] of Object.entries(res || {})) {
          const p = canonPhone(phone);
          if (p) chatPhone.set(lid, p);
        }
      } catch { /* gateway down — DB tiers still apply */ }
    }
  }

  // lead name via phone
  const phones = [...new Set([...chatPhone.values()])];
  const phoneName = new Map();
  for (let i = 0; i < phones.length; i += 60) {
    const c = phones.slice(i, i + 60);
    const r = (await env.DB.prepare(`SELECT normalized_phone, name FROM gtm_leads WHERE normalized_phone IN (${IN(c)})`).bind(...c).all()).results || [];
    for (const row of r) { const p = canonPhone(row.normalized_phone); if (p && row.name) phoneName.set(p, row.name); }
  }

  // backfill: for chats STILL nameless but with a phone, ask the gateway for the
  // contact's display name (pushname), and persist it to wa_chats for next time.
  if (backfill) {
    const stillNameless = chatIds.filter((id) => {
      const ph = chatPhone.get(id);
      return !chatName.get(id) && !inboundName.get(id) && !(ph && phoneName.get(ph));
    }).slice(0, 12);
    for (const id of stillNameless) {
      const ph = chatPhone.get(id);
      if (!ph) continue;
      try {
        const info = await callGateway(env, 'whatsapp', 'contact', { number: ph.slice(1) });
        const nm = info?.name || info?.pushname;
        if (nm) {
          pushName.set(id, nm);
          await env.DB.prepare('UPDATE wa_chats SET name=?, updated_at=? WHERE id=?').bind(nm, Date.now(), id).run().catch(() => {});
        }
      } catch { /* skip */ }
    }
  }

  for (const id of chatIds) {
    const ph = chatPhone.get(id);
    const name = (ph && phoneName.get(ph)) || chatName.get(id) || inboundName.get(id) || pushName.get(id) || ph || 'WhatsApp contact';
    out.set(id, name);
  }
  return out;
}

// The heavy, network-bound refresh behind the outreach log: content
// classification (LLM), WhatsApp name resolution (gateway), and per-thread
// reply/sentiment stats. Run this in the BACKGROUND (cron + a waitUntil on the
// drawer route) — never inline in outreachAttempts, which must stay a fast
// cached read. (Inline, it took ~11s and could hang on a slow WA gateway, the
// same way the LI detail did.)
export async function refreshOutreachData(env) {
  const cfg = await loadKpiConfig(env);
  const { dayStartMs } = localParts(cfg.tz, Date.now());
  await ensureClassified(env, dayStartMs, { limit: 60 }).catch(() => {});
  try {
    const rows = (await env.DB.prepare(
      `SELECT DISTINCT m.chat_id AS chat_id FROM wa_messages m JOIN wa_outreach_class c ON c.msg_id = m.id
       WHERE c.is_outreach = 1 AND m.from_me = 1 AND m.chat_id NOT LIKE '%@g.us'`,
    ).all()).results || [];
    const keys = rows.map((r) => r.chat_id);
    const names = await resolveChatNames(env, keys, { backfill: true }).catch(() => new Map());
    await refreshWaThreads(env, keys.map((key) => ({ key, name: names.get(key) })));
  } catch { /* best-effort */ }
}

export async function outreachAttempts(env) {
  const cfg = await loadKpiConfig(env);
  const { dayStartMs } = localParts(cfg.tz, Date.now());
  const attempts = [];

  // FAST READ ONLY — all classification / name-resolution / thread-stat work is
  // done in the background (refreshOutreachData, via the cron + the drawer
  // route's waitUntil). This just reads what's already cached.

  // Mirrors the KPI exactly: one entry per NEW person you first messaged today —
  // the first-touch message itself (its copy + time). Ongoing threads and
  // LinkedIn connection requests never appear.

  // LinkedIn — one genuine-outreach sent message per conversation today (synced
  // from the inbox + content-classified). SQLite returns the body/name of the
  // MIN() row alongside the aggregate.
  try {
    const li = (await env.DB.prepare(
      `SELECT conversation_urn AS key, MIN(at) AS at, body AS body, name AS name FROM li_sent_messages
       WHERE is_outreach = 1 AND at >= ? GROUP BY conversation_urn ORDER BY at DESC`,
    ).bind(dayStartMs).all()).results || [];
    for (const r of li) attempts.push({ channel: 'linkedin', key: r.key, name: r.name || 'LinkedIn', company: null, kind: 'message', body: r.body || '', at: r.at });
  } catch { /* li tables may be absent */ }

  // WhatsApp — 1:1 chats with a GENUINE outreach message today (classified by
  // content); show that first outreach message. Name resolution is a SEPARATE
  // best-effort pass so a resolver hiccup can never drop the messages.
  let waRows = [];
  try {
    waRows = (await env.DB.prepare(
      `SELECT m.chat_id AS chat_id, m.body AS body, MIN(m.timestamp) AS ts
       FROM wa_messages m JOIN wa_outreach_class c ON c.msg_id = m.id
       WHERE m.from_me = 1 AND m.chat_id NOT LIKE '%@g.us' AND m.timestamp >= ? AND c.is_outreach = 1
       GROUP BY m.chat_id ORDER BY ts DESC`,
    ).bind(dayStartMs).all()).results || [];
  } catch { waRows = []; /* wa_messages may be absent */ }
  const waTodayChats = new Set(waRows.map((r) => r.chat_id));

  // ALSO surface today's REPLIES on any thread we've EVER genuinely pitched —
  // not just chats first-touched today. Without this, a reply that lands days
  // after the pitch is invisible here forever (the query above only catches a
  // chat whose OWN first outreach message is today), even though "someone
  // replied today" is exactly the activity the digest exists to surface.
  let replyRows = [];
  try {
    replyRows = (await env.DB.prepare(
      `SELECT m.chat_id AS chat_id, m.body AS body, MAX(m.timestamp) AS ts
       FROM wa_messages m
       WHERE m.from_me = 0 AND m.chat_id NOT LIKE '%@g.us' AND m.timestamp >= ?
         AND m.body IS NOT NULL AND length(trim(m.body)) > 0
         AND m.chat_id IN (SELECT DISTINCT chat_id FROM wa_outreach_class WHERE is_outreach = 1)
       GROUP BY m.chat_id ORDER BY ts DESC`,
    ).bind(dayStartMs).all()).results || [];
  } catch { replyRows = []; }
  const replyOnlyRows = replyRows.filter((r) => !waTodayChats.has(r.chat_id));

  let waNames = new Map();
  try {
    waNames = await resolveChatNames(env, [...new Set([...waRows, ...replyOnlyRows].map((r) => r.chat_id))], { backfill: false });
  } catch { waNames = new Map(); }
  for (const r of waRows) attempts.push({ channel: 'whatsapp', key: r.chat_id, name: waNames.get(r.chat_id) || r.chat_id, company: null, kind: 'message', body: r.body || '', at: waMs(r.ts) });
  for (const r of replyOnlyRows) attempts.push({ channel: 'whatsapp', key: r.chat_id, name: waNames.get(r.chat_id) || r.chat_id, company: null, kind: 'reply', body: r.body || '', at: waMs(r.ts) });

  // Enrich each attempt with its conversation stats (replied / uncaught reply /
  // depth / sentiment) from the CACHE — computed in the background by
  // refreshOutreachData, never inline here.
  try {
    const stats = await getThreadStats(env, attempts.map((a) => a.key));
    for (const a of attempts) {
      const st = stats.get(a.key);
      a.replied = st ? !!st.replied : false;
      a.uncaught = st ? !!st.uncaught : false;
      a.sentiment = st?.sentiment || null;
      a.sentiment_reason = st?.sentiment_reason || null;
      a.msgs_in = st?.msgs_in || 0;
      a.msgs_out = st?.msgs_out || 0;
      a.reply_text = st?.last_inbound_text || null;
    }
  } catch { /* best-effort */ }

  attempts.sort((a, b) => (b.at || 0) - (a.at || 0));
  return {
    day_start_ms: dayStartMs,
    total: attempts.length,
    by_channel: {
      linkedin: attempts.filter((a) => a.channel === 'linkedin').length,
      whatsapp: attempts.filter((a) => a.channel === 'whatsapp').length,
    },
    attempts,
  };
}
