// GTM plugin · outreach-cohorts — the cohort engine, ported verbatim from
// workers/api/src/lib/outreach-cohorts.js.
//
// Contract v2.1 lib file: imports NOTHING. Every helper this engine used to
// import (sequence rendering, cadence windows, WA thread facts, model config)
// is duplicated below, per the pack contract. Every exported function takes
// `api` as its first argument in place of env.
//
// Tables: plugin_gtm_leads, plugin_gtm_outreach_cohorts,
// plugin_gtm_outreach_cohort_members, plugin_gtm_outreach_conversation_state
// (own, read-write) — wa_messages, wa_lid_map, feature_flags (host, SELECT-only).
//
// The copy is NOT written here and is never written unattended: it is the
// COHORT's own sequence, authored once for the group and personalised per
// recipient by variables and language variant. Step 0 is the first touch, step
// 1 the first follow-up, and so on. When the steps run out the prospect leaves
// the cohort. So every automated message is one the operator already approved.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a prospect who has said anything back
// is out of the automation, permanently — and that is re-checked in the moment
// before each send, not merely when the send was scheduled. A follow-up scheduled
// three days ago must not land on someone who replied yesterday.
//
// Sending is gated on the `outreach.live` feature flag. Until it is true the
// tick does everything except send, recording what it WOULD have sent.

const now = () => Date.now();
const safeJSON = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };

const CHUNK = 80;
const LIVE_FLAG = 'outreach.live';
// Members predating named cohorts, and anything created without one, live here.
const DEFAULT_COHORT = 'oq_default';

const qid = () => `oq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ════════════════════════════════════════════════════════════════════════════
// Duplicated: the sequence engine (from lib/outreach-sequence.js). Pure —
// parse, resolve a language, substitute, and report what is missing.
// ════════════════════════════════════════════════════════════════════════════

const VARIABLES = {
  first_name: (l) => String(l?.name || '').trim().split(/\s+/)[0] || '',
  name: (l) => String(l?.name || '').trim(),
  company: (l) => String(l?.company || '').trim(),
  position: (l) => String(l?.position || '').trim(),
  country: (l) => String(l?.country || '').trim(),
};
const VARIABLE_NAMES = Object.keys(VARIABLES);

const TOKEN = /\{([a-z_]+)\}/g;

// Which surface a step goes out on. Only WhatsApp is actually wired to a
// sender; the engine refuses the others out loud rather than pretending.
const CHANNELS = ['whatsapp', 'linkedin', 'email'];
const WIRED_CHANNELS = ['whatsapp'];
const TRIGGERS = ['no_reply', 'always'];

function parseSequence(raw) {
  let src = raw;
  if (typeof raw === 'string') { try { src = JSON.parse(raw); } catch { src = null; } }
  const steps = Array.isArray(src?.steps) ? src.steps : [];
  return {
    default_language: String(src?.default_language || 'en').toLowerCase(),
    steps: steps.map((s, i) => ({
      // Step 0 goes as soon as it is approved; later steps wait from the
      // previous send. A missing delay must not collapse a follow-up onto the
      // opener, so anything after the first defaults to a real gap.
      delay_hours: Number.isFinite(Number(s?.delay_hours)) ? Math.max(0, Number(s.delay_hours)) : (i === 0 ? 0 : 72),
      channel: CHANNELS.includes(s?.channel) ? s.channel : 'whatsapp',
      trigger: TRIGGERS.includes(s?.trigger) ? s.trigger : 'no_reply',
      bodies: (s?.bodies && typeof s.bodies === 'object') ? s.bodies : {},
    })).filter((s) => Object.values(s.bodies).some((b) => String(b || '').trim())),
  };
}

function serializeSequence(seq) {
  return JSON.stringify(parseSequence(seq));
}

// Which language a given prospect should receive. An explicit per-lead override
// wins; otherwise Israel gets Hebrew and everyone else the sequence default.
function languageFor(lead, seq) {
  const parsed = parseSequence(seq);
  const explicit = String(lead?.outreach_lang || '').trim().toLowerCase();
  const guessed = /israel/i.test(String(lead?.country || '')) ? 'he' : parsed.default_language;
  return { preferred: explicit || guessed, fallback: parsed.default_language };
}

function pickBody(step, lead, seq) {
  const { preferred, fallback } = languageFor(lead, seq);
  const has = (k) => String(step.bodies?.[k] || '').trim();
  return has(preferred) ? { body: step.bodies[preferred], lang: preferred }
    : has(fallback) ? { body: step.bodies[fallback], lang: fallback }
    : (() => {
        const first = Object.keys(step.bodies).find((k) => has(k));
        return first ? { body: step.bodies[first], lang: first } : { body: '', lang: null };
      })();
}

function renderStep(step, lead, seq) {
  const { body, lang } = pickBody(step, lead, seq);
  return { ...renderBody(body, lead), lang };
}

// Substitute one piece of copy for one prospect. A per-person edit goes through
// the SAME substitution and the same "missing" reporting as the cohort's own
// copy — an override rendered by different rules could ship a raw {company}.
function renderBody(body, lead) {
  const missing = new Set();
  const unknown = new Set();
  const text = String(body || '').replace(TOKEN, (whole, key) => {
    const get = VARIABLES[key];
    if (!get) { unknown.add(key); return whole; }
    const v = get(lead);
    if (!v) { missing.add(key); return whole; }
    return v;
  });
  return { text, missing: [...missing], unknown: [...unknown] };
}

// Render the whole sequence for one prospect. `blocked` is the single question
// the go-live check asks: is there any step this person cannot receive cleanly?
function renderSequence(seq, lead) {
  const parsed = parseSequence(seq);
  const steps = parsed.steps.map((s, i) => ({
    index: i, delay_hours: s.delay_hours, channel: s.channel, trigger: s.trigger,
    ...renderStep(s, lead, parsed),
  }));
  const missing = [...new Set(steps.flatMap((s) => s.missing))];
  const unknown = [...new Set(steps.flatMap((s) => s.unknown))];
  return {
    steps,
    length: steps.length,
    missing,
    unknown,
    blocked: !parsed.steps.length
      ? 'this cohort has no message sequence yet'
      : missing.length
        ? `missing ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`
        : unknown.length
          ? `unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
          : null,
  };
}

// Static check of the template itself, independent of any recipient.
function validateSequence(seq) {
  const parsed = parseSequence(seq);
  const unknown = new Set();
  const used = new Set();
  for (const s of parsed.steps) {
    for (const body of Object.values(s.bodies)) {
      let m;
      TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(String(body || ''))) !== null) {
        if (VARIABLES[m[1]]) used.add(m[1]); else unknown.add(m[1]);
      }
    }
  }
  const languages = [...new Set(parsed.steps.flatMap((s) => Object.keys(s.bodies)))];
  const unwired = [...new Set(parsed.steps.map((s) => s.channel).filter((c) => !WIRED_CHANNELS.includes(c)))];
  return {
    steps: parsed.steps.length,
    languages,
    unwired_channels: unwired,
    variables_used: [...used],
    unknown_variables: [...unknown],
    ok: parsed.steps.length > 0 && unknown.size === 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Duplicated: the cadence engine (from lib/outreach-cadence.js). Reads ONE
// knowledge doc (the plugin's own, re-slugged) and hands back plain numbers.
// ════════════════════════════════════════════════════════════════════════════

const CADENCE_SLUG = 'plugin-gtm-outreach-cohort-cadence';

// Defaults are deliberately conservative: follow-ups spread over two weeks,
// a small daily ceiling, and business hours only. The doc overrides all of it.
const CADENCE_DEFAULTS = {
  step_delays_hours: [72, 96, 168],
  max_sends_per_day: 20,
  min_gap_minutes: 8,
  quiet_start_hour: 9,
  quiet_end_hour: 19,
  weekdays_only: true,
  timezone: 'Asia/Jerusalem',
  dead_after_days: 21,
  // Every individual message waits for the operator to approve it. Defaults ON:
  // the safe direction for a mistake here is "nothing sent", never "sent unread".
  require_approval: true,
  max_message_chars: 4000,
};

const CADENCE_NUMERIC = ['max_sends_per_day', 'min_gap_minutes', 'quiet_start_hour', 'quiet_end_hour', 'dead_after_days', 'max_message_chars'];

function coerceCadence(src) {
  const out = { ...CADENCE_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const k of CADENCE_NUMERIC) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  if (Array.isArray(src.step_delays_hours)) {
    const arr = src.step_delays_hours.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (arr.length) out.step_delays_hours = arr;
  }
  if (typeof src.weekdays_only === 'boolean') out.weekdays_only = src.weekdays_only;
  if (typeof src.require_approval === 'boolean') out.require_approval = src.require_approval;
  if (typeof src.timezone === 'string' && src.timezone.trim()) out.timezone = src.timezone.trim();
  // A window that cannot open would silently freeze the queue forever — treat
  // it as unset rather than letting it look like "nothing is due".
  if (out.quiet_end_hour <= out.quiet_start_hour) {
    out.quiet_start_hour = CADENCE_DEFAULTS.quiet_start_hour;
    out.quiet_end_hour = CADENCE_DEFAULTS.quiet_end_hour;
  }
  return out;
}

// Read the cadence. Never throws. (The host version seeded the doc on write via
// its save path; loading falls back to defaults when the doc is absent.)
async function loadCohortCadence(api) {
  try {
    const doc = await api.knowledge(CADENCE_SLUG);
    if (!doc) return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
    const body = String(doc.body || '');
    const m = body.match(/```json\s*([\s\S]*?)```/);
    let parsed = null;
    if (m) { try { parsed = JSON.parse(m[1]); } catch { parsed = null; } }
    const idx = body.indexOf('\n---\n');
    return {
      cadence: coerceCadence(parsed),
      source: parsed ? 'doc' : 'defaults',
      notes: (idx >= 0 ? body.slice(idx + 5) : '').trim(),
    };
  } catch {
    return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
  }
}

// Hour-of-day + weekday in the configured zone. Intl does the DST work; a bad
// zone string falls back to UTC rather than throwing inside the cron.
function zonedParts(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date(at));
    const hour = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
    const wd = p.find((x) => x.type === 'weekday')?.value || '';
    return { hour: hour === 24 ? 0 : hour, weekday: wd, weekend: wd === 'Sat' || wd === 'Sun' };
  } catch {
    const d = new Date(at);
    return { hour: d.getUTCHours(), weekday: '', weekend: [0, 6].includes(d.getUTCDay()) };
  }
}

// Naming a moment in the zone it will actually happen in: the server names the
// moment — including the short zone tag and which calendar day it lands on —
// so the browser never re-derives it and the two can never disagree.
function zonedLabel(at, timezone) {
  if (!at) return null;
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZoneName: 'short', day: '2-digit', month: 'short',
    }).formatToParts(new Date(at));
    const get = (t) => p.find((x) => x.type === t)?.value || '';
    return {
      label: `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`,
      zone: get('timeZoneName'),
      ymd: zonedYmd(at, timezone),
    };
  } catch {
    return { label: new Date(at).toISOString().slice(0, 16).replace('T', ' '), zone: 'UTC', ymd: new Date(at).toISOString().slice(0, 10) };
  }
}

// The calendar day `at` falls on in `timezone`.
function zonedYmd(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(at));
    const get = (t) => p.find((x) => x.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

// Per-weekday sending windows: `{"1":{"start":"09:00","end":"17:30"}}`, 0 =
// Sunday. An absent day sends nothing. Wall-clock in the cohort's zone.
function parseWindows(raw) {
  let src = raw;
  if (typeof raw === 'string') { try { src = JSON.parse(raw); } catch { return null; } }
  if (!src || typeof src !== 'object') return null;
  const hm = (v) => {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h < 0 || h > 24 || mi < 0 || mi > 59) return null;
    return h * 60 + mi;
  };
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const w = src[d] ?? src[String(d)];
    if (!w) continue;
    const s = hm(w.start); const e = hm(w.end);
    // A window that cannot open is worse than no window: it looks configured
    // and sends nothing. Drop the day instead of storing an impossible one.
    if (s === null || e === null || e <= s) continue;
    out[d] = { start: w.start, end: w.end, s, e };
  }
  return Object.keys(out).length ? out : null;
}

// Epoch for a wall-clock moment in `timezone`. Fixed-point iteration so DST
// changeovers land on the real instant rather than an hour out.
function epochForWall(timezone, y, mo, d, hh, mi) {
  let guess = Date.UTC(y, mo - 1, d, hh, mi);
  for (let i = 0; i < 4; i++) {
    let p;
    try {
      p = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess));
    } catch { return guess; }
    const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const diff = Date.UTC(y, mo - 1, d, hh, mi) - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Calendar date + weekday of `at` in `timezone`.
function zonedDate(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date(at));
    const g = (t) => p.find((x) => x.type === t)?.value || '';
    return { y: Number(g('year')), mo: Number(g('month')), d: Number(g('day')), wd: WEEKDAY_INDEX[g('weekday')] ?? 0 };
  } catch {
    const dt = new Date(at);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
  }
}

// A cohort's own window layered over the account default. Anything the cohort
// leaves unset simply inherits.
function effectiveCadence(cadence, cohort) {
  if (!cohort) return cadence;
  const out = { ...cadence };
  if (cohort.timezone) out.timezone = cohort.timezone;
  const s = Number(cohort.start_hour);
  const e = Number(cohort.end_hour);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
    out.quiet_start_hour = Math.floor(s);
    out.quiet_end_hour = Math.floor(e);
  }
  let days = null;
  try { days = cohort.send_days ? JSON.parse(cohort.send_days) : null; } catch { days = null; }
  // An explicit day list beats the coarse weekdays_only flag. An EMPTY list
  // would mean "never" — treat it as unset rather than freezing the cohort.
  if (Array.isArray(days) && days.length) {
    out.send_days = days.map(Number).filter((d) => d >= 0 && d <= 6);
  }
  // Per-weekday windows, if the cohort has them, OVERRIDE both the single
  // start/end pair and the day list.
  const win = parseWindows(cohort.send_windows);
  if (win) out.send_windows = win;
  return out;
}

// Hour AND minute in the zone.
function zonedClock(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return { hour: g('hour') % 24, minute: g('minute') };
  } catch {
    const d = new Date(at);
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

// Is `at` inside the allowed sending window?
function withinWindow(at, cadence) {
  if (cadence.send_windows) {
    const { wd } = zonedDate(at, cadence.timezone);
    const w = cadence.send_windows[wd];
    if (!w) return false;
    const { hour, minute } = zonedClock(at, cadence.timezone);
    const mins = hour * 60 + minute;
    return mins >= w.s && mins < w.e;
  }
  const { hour, weekend, weekday } = zonedParts(at, cadence.timezone);
  if (Array.isArray(cadence.send_days) && cadence.send_days.length) {
    const idx = WEEKDAY_INDEX[weekday];
    if (idx === undefined || !cadence.send_days.includes(idx)) return false;
  } else if (cadence.weekdays_only && weekend) {
    return false;
  }
  return hour >= cadence.quiet_start_hour && hour < cadence.quiet_end_hour;
}

// The next moment sending is allowed at or after `at`. With per-day windows
// this COMPUTES the opening rather than walking forward in whole hours, which
// would stride straight over a 09:30 start.
function nextWindowOpening(at, cadence) {
  if (cadence.send_windows) {
    const tz = cadence.timezone;
    for (let i = 0; i < 14; i++) {
      const probe = at + i * 86400000;
      const { y, mo, d, wd } = zonedDate(probe, tz);
      const w = cadence.send_windows[wd];
      if (!w) continue;
      const open = epochForWall(tz, y, mo, d, Math.floor(w.s / 60), w.s % 60);
      const shut = epochForWall(tz, y, mo, d, Math.floor(w.e / 60), w.e % 60);
      if (at <= open) return open;      // window still to come today
      if (at < shut) return at;         // already inside it
    }
    return at;                          // nothing open in a fortnight — say so by not moving
  }
  let t = at;
  for (let i = 0; i < 24 * 14; i++) {
    if (withinWindow(t, cadence)) return t;
    t += 3600000;
  }
  return at;
}

// ════════════════════════════════════════════════════════════════════════════
// Duplicated: WA thread facts (from lib/outreach-wa.js + lib/whatsapp.js).
// SELECT-only over the host's wa_messages / wa_lid_map cache. The host keeps
// that cache fresh (webhook + cron); the incremental gateway pull the host
// version ran before reading writes host tables and therefore cannot run here.
// ════════════════════════════════════════════════════════════════════════════

// WhatsApp timestamps arrive as seconds from some gateway builds and ms from
// others; normalise so ordering never silently inverts.
const waMs = (t) => (t == null ? null : (Number(t) < 1e12 ? Number(t) * 1000 : Number(t)));
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

// The DM id for a phone. Group chats are never prospects — this is 1:1 only.
function chatIdForPhone(phone) {
  const s = String(phone || '').trim();
  if (!s) return null;
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

// Newest-first messages of one chat, raw_json parsed (host read).
async function recentMessages(api, { chat_id, limit = 200 } = {}) {
  const r = await api.db.prepare(
    'SELECT * FROM wa_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
  ).bind(chat_id, limit).all();
  return (r.results || []).map((m) => ({ ...m, raw_json: safeJSON(m.raw_json) }));
}

// A row we wrote ourselves at send time (the host stamps raw_json.source), as
// opposed to one the gateway's webhook delivered.
function isPreInsert(m) {
  const raw = m?.raw_json;
  if (raw && typeof raw === 'object') return raw.source === 'outbound';
  return String(raw || '').includes('outbound');
}

// Every chat id that belongs to one person: the `@c.us` id and any `@lid`
// privacy twin WhatsApp issued for the same number (either direction).
async function siblingChatIds(api, chatId, lead) {
  const ids = new Set([chatId]);
  const phoneChat = lead ? chatIdForPhone(lead.normalized_phone || lead.phone) : null;
  if (phoneChat) ids.add(phoneChat);
  try {
    if (String(chatId).endsWith('@lid')) {
      const r = await api.db.prepare('SELECT phone, pn FROM wa_lid_map WHERE lid = ?').bind(chatId).first();
      const d = digitsOf(r?.phone || String(r?.pn || '').split('@')[0]);
      if (d) ids.add(`${d}@c.us`);
    }
    for (const pn of [...ids].filter((i) => String(i).endsWith('@c.us'))) {
      const r = await api.db.prepare('SELECT lid FROM wa_lid_map WHERE pn = ?').bind(pn).all();
      for (const row of r.results || []) if (row.lid) ids.add(row.lid);
    }
  } catch { /* map unavailable — the id we were given still works */ }
  return [...ids];
}

// Collapse the SAME outgoing message written twice: once at send time
// (pre-insert) and once when WhatsApp echoed it back through the webhook.
const DUP_WINDOW_MS = 3 * 60 * 1000;
function dedupeOutbound(messages) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const m of messages) {
    if (!m.from_me) { out.push(m); continue; }
    const text = norm(m.body);
    const twin = text && out.find((k) => k.from_me && norm(k.body) === text
      && Math.abs((k.at || 0) - (m.at || 0)) < DUP_WINDOW_MS);
    if (!twin) { out.push(m); continue; }
    twin.preinsert = twin.preinsert && m.preinsert;
    twin.at = Math.min(twin.at || m.at || 0, m.at || twin.at || 0) || twin.at;
  }
  return out;
}

// The one place "what happened in this conversation" is decided. Every reader
// goes through this, so they cannot disagree about whether a prospect replied.
async function threadFacts(api, { chat_id, lead = null, limit = 300 } = {}) {
  const chatIds = await siblingChatIds(api, chat_id, lead);
  const rows = (await Promise.all(
    chatIds.map((cid) => recentMessages(api, { chat_id: cid, limit }).catch(() => [])),
  )).flat();

  const ordered = rows
    .map((m) => ({
      id: m.id,
      from_me: Number(m.from_me) === 1,
      body: m.body || '',
      sender_name: m.sender_name || null,
      at: waMs(m.timestamp),
      preinsert: isPreInsert(m),
    }))
    .filter((m) => String(m.body).trim())
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  const messages = dedupeOutbound(ordered);
  const inbound = messages.filter((m) => !m.from_me);
  const outbound = messages.filter((m) => m.from_me);
  const last = messages[messages.length - 1] || null;

  return {
    chat_ids: chatIds,
    messages,
    // ANSWERED is the automation kill-switch: they said something back, ever.
    answered: inbound.length > 0,
    msgs_in: inbound.length,
    msgs_out: outbound.length,
    first_out_at: outbound[0]?.at ?? null,
    last_in_at: inbound[inbound.length - 1]?.at ?? null,
    last_out_at: outbound[outbound.length - 1]?.at ?? null,
    last_at: last?.at ?? null,
    last_text: last?.body ?? null,
    last_from_me: last ? last.from_me : null,
    uncaught: !!last && !last.from_me,
  };
}

// Per chat: the latest REAL message plus the inbound/outbound tallies
// (empty bodies are receipts, not text). Aggregated in SQL, chunked.
async function lastMessages(api, chatIds = []) {
  const out = new Map();
  for (let i = 0; i < chatIds.length; i += CHUNK) {
    const c = chatIds.slice(i, i + CHUNK);
    const ph = c.map(() => '?').join(',');
    const REAL = 'body IS NOT NULL AND length(trim(body)) > 0';
    const r = (await api.db.prepare(
      `SELECT m.chat_id, m.body, m.from_me, m.timestamp
         FROM wa_messages m
         JOIN (SELECT chat_id, MAX(timestamp) AS t
                 FROM wa_messages
                WHERE chat_id IN (${ph}) AND ${REAL}
                GROUP BY chat_id) x
           ON x.chat_id = m.chat_id AND x.t = m.timestamp`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) if (!out.has(row.chat_id)) out.set(row.chat_id, row);

    const agg = (await api.db.prepare(
      `SELECT chat_id,
              SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) AS in_n,
              SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) AS out_n
         FROM wa_messages WHERE chat_id IN (${ph}) AND ${REAL}
        GROUP BY chat_id`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of agg) {
      const ex = out.get(row.chat_id);
      if (ex) { ex.in_n = row.in_n || 0; ex.out_n = row.out_n || 0; }
    }
  }
  return out;
}

// Operator "this is dead" markings, keyed by lead (own plugin table).
async function deadMarks(api, leadIds = []) {
  const out = new Map();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const c = leadIds.slice(i, i + CHUNK);
    const r = (await api.db.prepare(
      `SELECT lead_id, dead_at, dead_reason FROM plugin_gtm_outreach_conversation_state
        WHERE lead_id IN (${c.map(() => '?').join(',')}) AND dead_at IS NOT NULL`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) out.set(row.lead_id, row);
  }
  return out;
}

// Where each prospect's conversation stands, in bulk. Vocabulary IDENTICAL to
// the Conversations tab's buckets, derived from the same messages:
//   untouched — nothing has ever been sent to them
//   touched   — we have sent, they have not replied
//   active    — they have replied; the automation is off them permanently
//   dead      — marked dead by hand, or nothing happened for dead_after_days
// Dead wins over active, exactly as it does in the inbox.
async function conversationStatesFor(api, leads = []) {
  const out = new Map();
  if (!leads.length) return out;
  const deadAfterDays = (await loadCohortCadence(api)).cadence.dead_after_days;

  // Every id a person might hold: the phone-derived `@c.us`, whatever id we
  // stored at enrol time, and any `@lid` twin WhatsApp mapped to either.
  const idsOf = new Map();
  const allPn = new Set();
  for (const lead of leads) {
    const ids = new Set();
    const phoneChat = chatIdForPhone(lead.normalized_phone || lead.phone);
    if (phoneChat) ids.add(phoneChat);
    if (lead.chat_id) ids.add(lead.chat_id);
    idsOf.set(lead.id, ids);
    for (const i of ids) if (String(i).endsWith('@c.us')) allPn.add(i);
  }

  // One pass over the lid map for every phone id, rather than one per person.
  const lidByPn = new Map();
  const pnList = [...allPn];
  for (let i = 0; i < pnList.length; i += CHUNK) {
    const c = pnList.slice(i, i + CHUNK);
    const r = (await api.db.prepare(
      `SELECT pn, lid FROM wa_lid_map WHERE pn IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) {
      if (!row.lid) continue;
      if (!lidByPn.has(row.pn)) lidByPn.set(row.pn, []);
      lidByPn.get(row.pn).push(row.lid);
    }
  }
  for (const ids of idsOf.values()) {
    for (const pn of [...ids].filter((i) => String(i).endsWith('@c.us'))) {
      for (const lid of lidByPn.get(pn) || []) ids.add(lid);
    }
  }

  const everyId = [...new Set([...idsOf.values()].flatMap((s) => [...s]))];
  const [lasts, marks] = await Promise.all([
    lastMessages(api, everyId).catch(() => new Map()),
    deadMarks(api, leads.map((l) => l.id)).catch(() => new Map()),
  ]);

  const deadBefore = now() - deadAfterDays * 86400000;
  for (const lead of leads) {
    const ids = [...(idsOf.get(lead.id) || [])];
    // Merge every id the person holds. A reply that landed on the privacy twin
    // still means answered even when the newest message sits on the other id.
    let msgsIn = 0, msgsOut = 0, lastAt = null, lastText = null, lastFromMe = null;
    for (const id of ids) {
      const m = lasts.get(id);
      if (!m) continue;
      msgsIn += m.in_n || 0;
      msgsOut += m.out_n || 0;
      const at = waMs(m.timestamp);
      if (at && (!lastAt || at > lastAt)) { lastAt = at; lastText = m.body || null; lastFromMe = Number(m.from_me) === 1; }
    }
    const answered = msgsIn > 0;
    const neverMessaged = msgsIn === 0 && msgsOut === 0;
    const deadMarked = marks.has(lead.id);
    const status = (deadMarked || (lastAt && lastAt < deadBefore)) ? 'dead'
      : answered ? 'active'
      : neverMessaged ? 'untouched'
      : 'touched';
    out.set(lead.id, {
      chat_ids: ids,
      status,
      answered,
      never_messaged: neverMessaged,
      last_at: lastAt,
      last_text: lastText,
      last_from_me: lastFromMe,
      msgs_in: msgsIn,
      msgs_out: msgsOut,
      dead_marked: deadMarked,
      dead_reason: marks.get(lead.id)?.dead_reason || null,
      dead_by: deadMarked ? 'marked' : (status === 'dead' ? 'stale' : null),
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Duplicated: drafting rules + writer model (from lib/outreach-wa.js and
// lib/model-config.js) — only the reads generateStepCopy needs.
// ════════════════════════════════════════════════════════════════════════════

const DRAFT_RULES_SLUG = 'plugin-gtm-outreach-reply-drafting';
const DRAFT_RULES_DEFAULT = `How to write the suggested reply to a prospect on WhatsApp:

- One message, not a sequence. Short — two or three sentences, the length a
  busy person actually reads on a phone.
- Answer what they actually said FIRST. Never restate the pitch at someone who
  has already replied to it.
- Keep the angle's positioning, drop the angle's phrasing. The saved angle is
  what we believe about them; it is not a script to paste at them.
- Plain human words. No em dashes, no "I hope this finds you well", no
  "circling back", no exclamation marks, no emoji unless they used one first.
- Match their language. If they wrote in Hebrew, reply in Hebrew.
- Never invent a fact — no names, numbers, dates, mutual contacts, or claims
  about their company that are not in the context you were given.
- If they declined, do not push. Acknowledge it, leave the door open in one
  short line, and stop.
- End with at most one question, and only when a question actually moves it
  forward.`;

// Read the rules. Never throws. (Seeding the doc on first read belongs to the
// WA lib, which owns the doc; here an absent doc simply means the defaults.)
async function loadDraftingRules(api) {
  try {
    const doc = await api.knowledge(DRAFT_RULES_SLUG);
    if (!doc) return { rules: DRAFT_RULES_DEFAULT, source: 'defaults' };
    const body = String(doc.body || '');
    const idx = body.indexOf('\n---\n');
    const rules = (idx >= 0 ? body.slice(idx + 5) : body).trim() || DRAFT_RULES_DEFAULT;
    return { rules, source: 'doc' };
  } catch {
    return { rules: DRAFT_RULES_DEFAULT, source: 'defaults' };
  }
}

// The heavy-writer model id from the host's `llm-models` doc (declared host
// knowledge read). Doc value > coded default; never throws.
const WRITER_MODEL_DEFAULT = 'claude-opus-4-8';
async function writerModel(api) {
  try {
    const doc = await api.knowledge('llm-models');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const s = String(src?.writer ?? '').trim();
    // model ids are short tokens — refuse anything that looks like prose
    return (s && s.length <= 120 && !/\s{2,}|\n/.test(s)) ? s : WRITER_MODEL_DEFAULT;
  } catch { return WRITER_MODEL_DEFAULT; }
}

// ════════════════════════════════════════════════════════════════════════════
// The cohort engine itself (the file's real exports).
// ════════════════════════════════════════════════════════════════════════════

// ── named cohorts ──────────────────────────────────────────────────────────
// A cohort owns three things: who is in it, the copy they all receive, and its
// own run state + sending window. Status gates the sender, so pausing one stops
// every message inside it without disturbing anyone's place in the sequence.
export async function listCohorts(api) {
  const rows = ((await api.db.prepare(
    'SELECT * FROM plugin_gtm_outreach_cohorts ORDER BY created_at ASC',
  ).all().catch(() => ({ results: [] }))).results) || [];
  const counts = ((await api.db.prepare(
    `SELECT COALESCE(cohort_id, ?) AS cohort_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered
       FROM plugin_gtm_outreach_cohort_members GROUP BY COALESCE(cohort_id, ?)`,
  ).bind(DEFAULT_COHORT, DEFAULT_COHORT).all().catch(() => ({ results: [] }))).results) || [];
  const byId = new Map(counts.map((c) => [c.cohort_id, c]));
  return {
    cohorts: rows.map((r) => ({
      id: r.id, name: r.name, note: r.note || null, created_at: r.created_at,
      status: r.status || 'active',
      timezone: r.timezone || null,
      start_hour: r.start_hour ?? null,
      end_hour: r.end_hour ?? null,
      send_days: (() => { try { return r.send_days ? JSON.parse(r.send_days) : null; } catch { return null; } })(),
      // Per-weekday eligible sending times, {weekday: {start,end}}. NULL means
      // the cohort inherits the account default window.
      send_windows: (() => { const w = parseWindows(r.send_windows); return w ? Object.fromEntries(Object.entries(w).map(([d, x]) => [d, { start: x.start, end: x.end }])) : null; })(),
      languages: (() => { try { return r.languages ? JSON.parse(r.languages) : null; } catch { return null; } })(),
      has_sequence: !!String(r.sequence || '').trim() && parseSequence(r.sequence).steps.length > 0,
      total: byId.get(r.id)?.total || 0,
      active: byId.get(r.id)?.active || 0,
      answered: byId.get(r.id)?.answered || 0,
    })),
  };
}

export async function createCohort(api, { name, note = null } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { error: 'a cohort name is required' };
  if (clean.length > 80) return { error: 'cohort name is too long (80 characters max)' };
  const existing = await api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohorts WHERE name = ?').bind(clean).first().catch(() => null);
  // Idempotent by name: re-creating an existing cohort hands back that one
  // rather than failing the caller or minting a confusing duplicate.
  if (existing) return { cohort: { id: existing.id, name: existing.name }, created: false };
  const id = qid();
  const t = now();
  await api.db.prepare(
    'INSERT INTO plugin_gtm_outreach_cohorts (id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, clean, note || null, t, t).run();
  await api.log('outreach_cohort_created', { id, name: clean });
  return { cohort: { id, name: clean }, created: true };
}

// A cohort's run state and its own sending window. Status is not decoration:
// the sender skips any cohort that is not `active`.
export const COHORT_STATUSES = ['active', 'paused', 'finished', 'canceled'];

export async function updateCohort(api, patch = {}) {
  const { cohort_id } = patch;
  if (!cohort_id) return { error: 'cohort_id required' };
  const row = await api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohorts WHERE id = ?').bind(cohort_id).first().catch(() => null);
  if (!row) return { error: 'no such cohort' };

  const set = {};
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    if (!clean) return { error: 'a cohort name is required' };
    set.name = clean;
  }
  if (patch.status !== undefined) {
    if (!COHORT_STATUSES.includes(patch.status)) return { error: `status must be one of ${COHORT_STATUSES.join(', ')}` };
    set.status = patch.status;
  }
  if (patch.timezone !== undefined) {
    const tz = String(patch.timezone || '').trim();
    // A zone the runtime cannot resolve would silently push every send to a
    // wrong hour, so refuse it here rather than at 3am in someone's morning.
    if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return { error: `unknown timezone "${tz}"` }; } }
    set.timezone = tz || null;
  }
  if (patch.send_days !== undefined) {
    const days = Array.isArray(patch.send_days)
      ? [...new Set(patch.send_days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    // An empty list means "never" — store NULL (inherit) instead of freezing
    // the cohort in a state whose only symptom is nothing ever sending.
    set.send_days = days.length ? JSON.stringify(days) : null;
  }
  if (patch.languages !== undefined) {
    const langs = Array.isArray(patch.languages)
      ? [...new Set(patch.languages.map((l) => String(l || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    set.languages = langs.length ? JSON.stringify(langs) : null;
  }
  if (patch.send_windows !== undefined) {
    // Validate through the same parser the engine reads with, so anything the
    // engine would silently ignore is refused here where it can be seen.
    const win = parseWindows(patch.send_windows);
    if (patch.send_windows && !win && Object.keys(patch.send_windows || {}).length) {
      return { error: 'sending times must be HH:MM with the end after the start' };
    }
    set.send_windows = win
      ? JSON.stringify(Object.fromEntries(Object.entries(win).map(([d, w]) => [d, { start: w.start, end: w.end }])))
      : null;
  }
  if (patch.start_hour !== undefined || patch.end_hour !== undefined) {
    const s = patch.start_hour === undefined ? row.start_hour : Number(patch.start_hour);
    const e = patch.end_hour === undefined ? row.end_hour : Number(patch.end_hour);
    if (s != null && e != null) {
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > 24 || e <= s) {
        return { error: 'sending hours must be 0–24 with the end after the start' };
      }
      set.start_hour = Math.floor(s);
      set.end_hour = Math.floor(e);
    }
  }
  if (!Object.keys(set).length) return { error: 'nothing to change' };

  const keys = Object.keys(set);
  await api.db.prepare(
    `UPDATE plugin_gtm_outreach_cohorts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
  ).bind(...keys.map((k) => set[k]), now(), cohort_id).run();
  await api.log('outreach_cohort_updated', { cohort_id, ...set });
  return { ok: true, cohort_id, ...set };
}

export async function deleteCohort(api, { cohort_id } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  if (cohort_id === DEFAULT_COHORT) return { error: 'the default cohort cannot be deleted' };
  const n = Number((await api.db.prepare(
    'SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members WHERE cohort_id = ?',
  ).bind(cohort_id).first().catch(() => null))?.n || 0);
  if (n) return { error: `${n} prospect${n === 1 ? ' is' : 's are'} still in this cohort — remove them first` };
  await api.db.prepare('DELETE FROM plugin_gtm_outreach_cohorts WHERE id = ?').bind(cohort_id).run().catch(() => {});
  await api.log('outreach_cohort_deleted', { cohort_id });
  return { deleted: true, cohort_id };
}

async function cohortName(api, id) {
  if (!id) return null;
  const r = await api.db.prepare('SELECT name FROM plugin_gtm_outreach_cohorts WHERE id = ?').bind(id).first().catch(() => null);
  return r?.name || null;
}

// LIVE by default: an approved, scheduled message is an instruction to send.
// The flag stays as an explicit pause (set outreach.live false to hold the
// queue). Per-message approval, pacing and the no-duplicate claim are what
// actually prevent a mistake, and they are untouched.
// (feature_flags is a HOST table, SELECT-only, declared in requires.host_reads.)
async function isLive(api) {
  try {
    const r = await api.db.prepare('SELECT value FROM feature_flags WHERE key = ?').bind(LIVE_FLAG).first();
    // Same truth table as the host's flagsAsObject: a flag is true only when
    // value === 1; an absent row means "live" (the flag is an explicit pause).
    return !(r && Number(r.value) !== 1);
  } catch { return false; }
}

const chatIdOf = (lead) => {
  const digits = String(lead?.normalized_phone || lead?.phone || '').replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
};

// One lead row (own plugin_gtm_leads table — was lib/gtm.js getLead).
async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

// The cohort's own message sequence, and what it renders to for one prospect.
export async function cohortRow(api, cohortId) {
  return api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohorts WHERE id = ?')
    .bind(cohortId || DEFAULT_COHORT).first().catch(() => null);
}

async function sequenceOf(api, cohortId) {
  const r = await api.db.prepare('SELECT sequence FROM plugin_gtm_outreach_cohorts WHERE id = ?')
    .bind(cohortId || DEFAULT_COHORT).first().catch(() => null);
  return parseSequence(r?.sequence);
}

// `scope` decides what a bulk edit does to the people ALREADY in the cohort:
//
//   'new_only' (default) — anyone who was hand-edited keeps their own message.
//   'everyone'           — the cohort's copy replaces the hand-written ones too.
//
// APPROVALS ARE WITHDRAWN EITHER WAY, for every member whose next message this
// changes. Approval means "I have read this text"; leaving one standing after
// the text underneath it changed would send words nobody signed off.
export const SEQUENCE_SCOPES = ['new_only', 'everyone'];

export async function saveSequence(api, { cohort_id, sequence, scope = 'new_only' } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  if (!SEQUENCE_SCOPES.includes(scope)) return { error: `scope must be one of ${SEQUENCE_SCOPES.join(', ')}` };
  const exists = await api.db.prepare('SELECT 1 FROM plugin_gtm_outreach_cohorts WHERE id = ?').bind(cohort_id).first().catch(() => null);
  if (!exists) return { error: 'no such cohort' };
  const check = validateSequence(sequence);
  if (check.unknown_variables.length) {
    return { error: `unknown variable${check.unknown_variables.length > 1 ? 's' : ''}: ${check.unknown_variables.map((v) => `{${v}}`).join(', ')}` };
  }
  const t = now();
  await api.db.prepare('UPDATE plugin_gtm_outreach_cohorts SET sequence = ?, updated_at = ? WHERE id = ?')
    .bind(serializeSequence(sequence), t, cohort_id).run();

  // Whose hand-written message just got overwritten — counted BEFORE the write,
  // so the caller can tell the operator what it cost rather than guessing.
  const editedCount = Number((await api.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members
      WHERE COALESCE(cohort_id, ?) = ? AND override_text IS NOT NULL`,
  ).bind(DEFAULT_COHORT, cohort_id).first().catch(() => null))?.n || 0);

  let replaced = 0;
  if (scope === 'everyone' && editedCount) {
    await api.db.prepare(
      `UPDATE plugin_gtm_outreach_cohort_members
          SET override_text = NULL, override_step = NULL, updated_at = ?
        WHERE COALESCE(cohort_id, ?) = ? AND override_text IS NOT NULL`,
    ).bind(t, DEFAULT_COHORT, cohort_id).run();
    replaced = editedCount;
  }

  // Re-arm the gate. On 'new_only' the hand-edited members keep their approval,
  // because the text THEY are getting has not changed.
  const keepEdited = scope === 'new_only' ? ' AND override_text IS NULL' : '';
  const unapproved = Number((await api.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members
      WHERE COALESCE(cohort_id, ?) = ? AND approved_step IS NOT NULL${keepEdited}`,
  ).bind(DEFAULT_COHORT, cohort_id).first().catch(() => null))?.n || 0);
  await api.db.prepare(
    `UPDATE plugin_gtm_outreach_cohort_members
        SET approved_step = NULL, approved_step_at = NULL, updated_at = ?
      WHERE COALESCE(cohort_id, ?) = ? AND approved_step IS NOT NULL${keepEdited}`,
  ).bind(t, DEFAULT_COHORT, cohort_id).run();

  await api.log('outreach_sequence_saved', { cohort_id, scope, edits_replaced: replaced, approvals_withdrawn: unapproved, ...check });
  return { ok: true, cohort_id, scope, edits_replaced: replaced, approvals_withdrawn: unapproved, edits_kept: scope === 'new_only' ? editedCount : 0, ...check };
}

// ── draft one step's copy ───────────────────────────────────────────────────
// The editor's "generate" button. It never saves and never sends — the copy
// only becomes real when the operator presses save, which is what keeps "every
// automated message was approved" true even when a model helped write it.
export async function generateStepCopy(api, { cohort_id, step_index = 0, language = 'en', instruction = '' } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  const coh = await cohortRow(api, cohort_id);
  if (!coh) return { error: 'no such cohort' };

  // The brief is the cohort itself: its name, and a sample of who is in it.
  const sample = ((await api.db.prepare(
    `SELECT l.name, l.company, l.position, l.country
       FROM plugin_gtm_outreach_cohort_members m JOIN plugin_gtm_leads l ON l.id = m.lead_id
      WHERE COALESCE(m.cohort_id, ?) = ? LIMIT 8`,
  ).bind(DEFAULT_COHORT, cohort_id).all().catch(() => ({ results: [] }))).results) || [];

  const seq = await sequenceOf(api, cohort_id);
  const earlier = seq.steps.slice(0, step_index)
    .map((s, i) => `${i + 1}. ${Object.values(s.bodies)[0] || ''}`).filter(Boolean).join('\n');

  const { rules } = await loadDraftingRules(api);
  const model = await writerModel(api);

  const system = `You write one outreach message for a COHORT — a group of prospects who share a reason to be approached. The same text goes to everyone in the group, personalised only by variables.

Use ONLY these variables, in curly braces, and only where they genuinely help: ${VARIABLE_NAMES.map((v) => `{${v}}`).join(' ')}. Never invent a variable. Never write a name or company literally — use the variable.

${rules}

Return ONLY the message text. No preamble, no quotes, no alternatives.`;

  const who = sample.length
    ? sample.map((p) => `- ${[p.position, p.company, p.country].filter(Boolean).join(', ')}`).join('\n')
    : '(nobody added yet — write for the cohort name alone)';
  const prompt = [
    `COHORT: ${coh.name}`,
    `WHO IS IN IT:\n${who}`,
    earlier ? `MESSAGES ALREADY IN THE SEQUENCE (do not repeat them):\n${earlier}` : '',
    step_index === 0
      ? 'Write the FIRST message — a cold opener to someone who has never heard from us.'
      : `Write message ${step_index + 1} — a follow-up to someone who has NOT replied to the earlier ones. Do not thank them for a reply, and do not imply they responded.`,
    language !== 'en' ? `Write it in ${language === 'he' ? 'Hebrew' : language}.` : '',
    instruction ? `EXTRA DIRECTION FROM THE OPERATOR: ${instruction}` : '',
  ].filter(Boolean).join('\n\n');

  let text;
  try {
    text = await api.gateway('llm', 'text', { system, prompt, model, max_tokens: 400, heavy: false });
  } catch (e) {
    return { error: `could not draft it (${String(e?.message || e)})` };
  }
  const draft = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!draft) return { error: 'the model returned nothing' };

  await api.log('outreach_step_drafted', { cohort_id, step_index, language, chars: draft.length });
  return { draft, cohort_id, step_index, language, based_on: sample.length };
}

export async function readSequence(api, { cohort_id } = {}) {
  const seq = await sequenceOf(api, cohort_id);
  return { cohort_id: cohort_id || DEFAULT_COHORT, sequence: seq, ...validateSequence(seq) };
}

// Gap before the step at `index`. Step 0 goes as soon as it is approved; the
// spacing of later steps is the cohort's, authored alongside the copy.
function delayForStep(seq, index) {
  const s = seq.steps[index];
  return Math.max(0, Number(s?.delay_hours || 0)) * 3600000;
}

async function readRow(api, leadId) {
  return api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
}

async function writeRow(api, leadId, patch) {
  const fields = { ...patch, updated_at: now() };
  const keys = Object.keys(fields);
  await api.db.prepare(
    `UPDATE plugin_gtm_outreach_cohort_members SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE lead_id=?`,
  ).bind(...keys.map((k) => fields[k]), leadId).run().catch(() => {});
}

// ── enrol ───────────────────────────────────────────────────────────────────
// Put a prospect on the cohort. Idempotent: re-enrolling someone already on it
// returns the existing row rather than restarting their ladder. A prospect who
// has already replied is refused.
export async function enroll(api, { lead_id, cohort_id = null, override = false, start_at = null } = {}) {
  if (!lead_id) return { error: 'lead_id required' };
  const lead = await getLead(api, lead_id).catch(() => null);
  if (!lead) return { error: 'no such lead' };
  const target = cohort_id || DEFAULT_COHORT;

  const existing = await readRow(api, lead_id);
  if (existing) {
    const current = existing.cohort_id || DEFAULT_COHORT;
    if (current === target) return { added: false, reason: 'already in this cohort', lead_id, cohort_id: current };
    // ── THE ANTI-SPAM RULE ── they are already being worked in another cohort.
    // Refuse and hand the decision to a human rather than quietly messaging the
    // same person from two campaigns.
    if (!override) {
      return {
        conflict: true, lead_id, name: lead.name || null,
        current_cohort: { id: current, name: await cohortName(api, current) },
        requested_cohort: { id: target, name: await cohortName(api, target) },
        message: `${lead.name || 'This prospect'} is already in "${await cohortName(api, current) || current}". Adding them here would mean two campaigns messaging the same person.`,
      };
    }
    // Overridden: MOVE them. Never a second row.
    await writeRow(api, lead_id, { cohort_id: target });
    await api.log('outreach_cohort_override', { lead_id, name: lead.name || null, from: current, to: target });
    return { added: true, moved: true, lead_id, cohort_id: target, from_cohort: current };
  }

  const chatId = chatIdOf(lead);
  if (!chatId) return { error: 'lead has no usable phone number' };

  const facts = await threadFacts(api, { chat_id: chatId, lead, limit: 50 });
  if (facts.answered) {
    return { error: 'this prospect has already replied — they belong in Conversations, not the cohort' };
  }

  // STAGED, not scheduled. Adding somebody to a cohort is a filing decision;
  // it must never be the thing that causes a message. The sender only ever
  // selects status='active', so a staged row is invisible to it by
  // construction rather than by a check that could regress.
  const t = now();
  await api.db.prepare(
    `INSERT INTO plugin_gtm_outreach_cohort_members (lead_id, chat_id, cohort_id, status, step, next_send_at, last_sent_at, enrolled_at, updated_at)
     VALUES (?, ?, ?, 'staged', 0, NULL, ?, ?, ?)`,
  ).bind(lead_id, chatId, target, facts.last_out_at ?? null, t, t).run();

  await api.log('outreach_cohort_staged', { lead_id, name: lead.name || null, cohort_id: target });
  return { added: true, staged: true, lead_id, cohort_id: target };
}

// ── go live ─────────────────────────────────────────────────────────────────
// The ONLY thing that turns staged people into scheduled ones. Explicit, per
// selection, and it refuses anyone whose messages would render with a hole in
// them.
export async function goLive(api, { lead_ids = [], start_at = null } = {}) {
  const ids = [...new Set((lead_ids || []).filter(Boolean))];
  if (!ids.length) return { error: 'nobody selected' };
  const { cadence } = await loadCohortCadence(api);
  const seqCache = new Map();
  const cohortCache = new Map();

  const live = [];
  const blocked = [];
  for (const id of ids) {
    const row = await readRow(api, id);
    if (!row) { blocked.push({ lead_id: id, reason: 'not on any cohort' }); continue; }
    if (row.answered_at) { blocked.push({ lead_id: id, reason: 'they have replied — automation is off for them' }); continue; }
    if (row.status === 'active') { blocked.push({ lead_id: id, reason: 'already live' }); continue; }

    const lead = await getLead(api, row.lead_id).catch(() => null);
    if (!lead) { blocked.push({ lead_id: id, reason: 'lead missing' }); continue; }

    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(api, qId));
    if (!cohortCache.has(qId)) cohortCache.set(qId, await cohortRow(api, qId));
    const seq = seqCache.get(qId);
    const coh = cohortCache.get(qId);
    // Scheduling uses the COHORT's window, so "9am" means 9am wherever this
    // group actually lives.
    const cad = effectiveCadence(cadence, coh);

    // The whole sequence must render for THIS person before any of it is
    // scheduled — catching it now, not three steps in.
    const rendered = renderSequence(seq, lead);
    if (rendered.blocked) {
      blocked.push({ lead_id: id, name: lead.name || null, reason: rendered.blocked });
      continue;
    }

    const base = start_at || now();
    await writeRow(api, id, {
      status: 'active',
      step: 0,
      approved_at: now(),
      next_send_at: nextWindowOpening(base + delayForStep(seq, 0), cad),
      stop_reason: null,
      last_error: null,
    });
    live.push({ lead_id: id, name: lead.name || null, steps: rendered.length, first_text: rendered.steps[0]?.text || null });
  }

  await api.log('outreach_cohort_go_live', { requested: ids.length, live: live.length, blocked: blocked.length });
  return { live, blocked, requested: ids.length };
}

// ── bulk add (the Prospecting CTA) ──────────────────────────────────────────
// Adds many prospects to one cohort and reports each outcome separately. The
// conflicts come back as their own list so the operator can approve the
// override for exactly those people — never a blanket "force everything".
export async function enrollMany(api, { lead_ids = [], cohort_id = null, override = false } = {}) {
  const ids = [...new Set((lead_ids || []).filter(Boolean))];
  if (!ids.length) return { error: 'no prospects selected' };
  if (ids.length > 200) return { error: 'too many at once — select 200 or fewer' };
  const target = cohort_id || DEFAULT_COHORT;

  const added = [];
  const conflicts = [];
  const skipped = [];
  for (const id of ids) {
    let r;
    try { r = await enroll(api, { lead_id: id, cohort_id: target, override }); }
    catch (e) { r = { error: String(e?.message || e) }; }
    if (r?.conflict) conflicts.push(r);
    else if (r?.added) added.push(r);
    else skipped.push({ lead_id: id, reason: r?.error || r?.reason || 'not enrolled' });
  }

  await api.log('outreach_cohort_bulk_added', { cohort_id: target, requested: ids.length, added: added.length, conflicts: conflicts.length, skipped: skipped.length, override: !!override });
  return {
    cohort_id: target, cohort_name: await cohortName(api, target),
    requested: ids.length, added, conflicts, skipped,
  };
}

export async function remove(api, { lead_id, reason = 'manual' } = {}) {
  if (!lead_id) return { error: 'lead_id required' };
  await api.db.prepare('DELETE FROM plugin_gtm_outreach_cohort_members WHERE lead_id = ?').bind(lead_id).run().catch(() => {});
  await api.log('outreach_cohort_removed', { lead_id, reason });
  return { removed: true, lead_id };
}

// pause / resume / stop a single enrolment. Stopping is terminal-but-visible;
// removing is what clears the row entirely.
export async function control(api, { lead_id, action } = {}) {
  if (!lead_id || !action) return { error: 'lead_id and action required' };
  const row = await readRow(api, lead_id);
  if (!row) return { error: 'not enrolled' };
  if (row.answered_at && action === 'resume') {
    return { error: 'this prospect replied — automation cannot be resumed for them' };
  }
  const { cadence } = await loadCohortCadence(api);
  const patch = action === 'pause' ? { status: 'paused' }
    : action === 'resume' ? { status: 'active', next_send_at: nextWindowOpening(now(), cadence) }
    : action === 'stop' ? { status: 'stopped', stop_reason: 'manual', next_send_at: null }
    // Back to a draft: they keep their place in the ladder and their approval,
    // they simply have no send time any more. The tick only ever selects rows
    // WITH one, so this takes them out of the run without stopping them.
    : action === 'unschedule' ? { status: 'staged', next_send_at: null, stop_reason: null }
    : null;
  if (!patch) return { error: `unknown action "${action}"` };
  await writeRow(api, lead_id, patch);
  await api.log('outreach_cohort_control', { lead_id, action });
  return { lead_id, ...patch };
}

// ── moving ONE person's next send ───────────────────────────────────────────
// The sheet's Sending cell, edited in place. Stores EXACTLY the moment picked —
// it is not snapped into the cohort's window; the tick only runs inside the
// window anyway, so a time outside it simply means "first chance after that".
// `outside_window` is returned so the UI can say so out loud.
//
// Setting a time on someone staged is a go-live, and carries go-live's guard:
// the whole sequence must render for this person before any of it is armed.
export async function rescheduleMember(api, { lead_id, send_at } = {}) {
  const leadId = String(lead_id || '').trim();
  if (!leadId) return { error: 'lead_id required' };
  const at = Number(send_at);
  if (!Number.isFinite(at) || at <= 0) return { error: 'a send time is required' };

  const row = await readRow(api, leadId);
  if (!row) return { error: 'not in a cohort' };
  if (row.answered_at) return { error: 'they replied — automation is off them' };
  if (row.status === 'stopped' || row.status === 'done') {
    return { error: `this prospect is ${row.status} — resume them before scheduling` };
  }

  const lead = await getLead(api, leadId).catch(() => null);
  if (!lead) return { error: 'lead missing' };
  const qId = row.cohort_id || DEFAULT_COHORT;
  const rendered = renderSequence(await sequenceOf(api, qId), lead);
  if (rendered.blocked) return { error: rendered.blocked };

  const { cadence } = await loadCohortCadence(api);
  const coh = await cohortRow(api, qId);
  const cad = effectiveCadence(cadence, coh);
  const tz = coh?.timezone || cadence.timezone;

  // A time that has already passed is not an error — it means "as soon as the
  // sender next runs", which is a thing operators legitimately want.
  await writeRow(api, leadId, {
    status: 'active',
    next_send_at: at,
    stop_reason: null,
    // Rescheduling is not re-approving. Moving WHEN it goes does not change
    // WHAT goes, so the approval stands; the text is untouched.
  });
  await api.log('outreach_member_rescheduled', { lead_id: leadId, send_at: at, was: row.next_send_at || null, from_staged: row.status === 'staged' });
  return {
    lead_id: leadId,
    next_send_at: at,
    went_live: row.status === 'staged',
    outside_window: !withinWindow(at, cad),
    ...zonedLabel(at, tz),
  };
}

// ── approving one message for one person ────────────────────────────────────
// Approval is stored as the STEP INDEX approved, never as a boolean. Sending
// advances `step`, so the stored index stops matching by itself and the next
// message is un-approved by construction.
//
// Approving does not schedule and does not send. The two gates are separate on
// purpose: one is about the person, the other about the words.
export async function approveMessages(api, { lead_ids = [], approve = true } = {}) {
  const ids = [...new Set((lead_ids || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!ids.length) return { error: 'select at least one prospect' };

  const approved = [];
  const refused = [];
  const t = now();

  // Withdrawing needs none of the checks below — it can only ever make the
  // system quieter, so it is safe to do first and in bulk.
  if (!approve) {
    for (const leadId of ids) {
      const r = await api.db.prepare(
        'UPDATE plugin_gtm_outreach_cohort_members SET approved_step = NULL, approved_step_at = NULL, updated_at = ? WHERE lead_id = ?',
      ).bind(t, leadId).run().catch(() => null);
      if (r) approved.push({ lead_id: leadId, approved: false });
    }
    await api.log('outreach_message_unapproved', { count: approved.length, lead_ids: ids });
    return { approved, refused };
  }

  const rows = new Map();
  const leadsById = new Map();
  for (const leadId of ids) {
    const row = await api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
    if (!row) { refused.push({ lead_id: leadId, reason: 'not in a cohort' }); continue; }
    const lead = await getLead(api, leadId).catch(() => null);
    if (!lead) { refused.push({ lead_id: leadId, reason: 'lead missing' }); continue; }
    rows.set(leadId, row);
    leadsById.set(leadId, lead);
  }

  // ── read the CONVERSATION, not the stored flag ──
  // `answered_at` is only written when the tick next runs, so a prospect who
  // replied five minutes ago still has it NULL. Trusting it would let the
  // operator approve a message for somebody already mid-conversation — the one
  // thing this module must never do.
  const convo = await conversationStatesFor(api, [...rows.values()].map((row) => ({
    id: row.lead_id,
    chat_id: row.chat_id,
    normalized_phone: leadsById.get(row.lead_id)?.normalized_phone || null,
    phone: leadsById.get(row.lead_id)?.phone || null,
  }))).catch(() => new Map());

  for (const leadId of [...rows.keys()]) {
    const row = rows.get(leadId);
    const lead = leadsById.get(leadId);
    if (row.answered_at || convo.get(leadId)?.answered) {
      refused.push({ lead_id: leadId, name: lead.name || null, reason: 'they replied — automation is off them' });
      continue;
    }

    // Approve exactly the message the sheet showed. For a staged person that is
    // the opener; for a live one it is whatever step they are on.
    // NOT `staged ? 0` — an unscheduled member keeps their place in the ladder.
    const step = row.step;

    // Re-render before approving rather than trusting the row the browser was
    // looking at: the cohort's copy or the prospect's fields may have changed
    // since it loaded.
    const rendered = renderSequence(await sequenceOf(api, row.cohort_id), lead);
    if (rendered.blocked) { refused.push({ lead_id: leadId, name: lead.name || null, reason: rendered.blocked }); continue; }
    if (!rendered.steps[step]) { refused.push({ lead_id: leadId, name: lead.name || null, reason: 'no message at this step' }); continue; }
    if (row.override_text && row.override_step === step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        refused.push({ lead_id: leadId, name: lead.name || null, reason: `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}` });
        continue;
      }
    }

    await api.db.prepare(
      'UPDATE plugin_gtm_outreach_cohort_members SET approved_step = ?, approved_step_at = ?, updated_at = ? WHERE lead_id = ?',
    ).bind(step, t, t, leadId).run();
    approved.push({ lead_id: leadId, name: lead.name || null, step, approved: true });
  }

  await api.log(
    approve ? 'outreach_message_approved' : 'outreach_message_unapproved',
    { count: approved.length, refused: refused.length, lead_ids: approved.map((a) => a.lead_id) },
  );
  return { approved, refused };
}

// ── editing one message for one person ──────────────────────────────────────
// The edit belongs to this prospect at this step, NOT to the cohort. Saving an
// edit CLEARS any approval — approval means "I have read this text", and the
// text just changed.
export async function saveMessageOverride(api, { lead_id, text, clear = false } = {}) {
  const leadId = String(lead_id || '').trim();
  if (!leadId) return { error: 'lead_id required' };
  const row = await api.db.prepare('SELECT * FROM plugin_gtm_outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
  if (!row) return { error: 'not in a cohort' };
  // NOT `staged ? 0` — an unscheduled member keeps their place in the ladder.
  const step = row.step;
  const t = now();

  if (clear || !String(text || '').trim()) {
    await api.db.prepare(
      `UPDATE plugin_gtm_outreach_cohort_members
          SET override_text = NULL, override_step = NULL,
              approved_step = NULL, approved_step_at = NULL, updated_at = ?
        WHERE lead_id = ?`,
    ).bind(t, leadId).run();
    await api.log('outreach_message_edit_cleared', { lead_id: leadId, step });
    return { lead_id: leadId, step, cleared: true };
  }

  const body = String(text).trim();
  const { cadence } = await loadCohortCadence(api);
  if (body.length > cadence.max_message_chars) {
    return { error: `message is too long (${cadence.max_message_chars} characters max)` };
  }
  const lead = await getLead(api, leadId).catch(() => null);
  if (!lead) return { error: 'lead missing' };
  // Refuse a broken edit at the point of saving, where the operator is looking
  // at it, rather than accepting it and failing silently at send time.
  const r = renderBody(body, lead);
  if (r.unknown.length) return { error: `unknown variable${r.unknown.length > 1 ? 's' : ''}: ${r.unknown.map((u) => `{${u}}`).join(', ')}` };
  if (r.missing.length) return { error: `this prospect has no ${r.missing.map((m) => m.replace(/_/g, ' ')).join(', ')}` };

  await api.db.prepare(
    `UPDATE plugin_gtm_outreach_cohort_members
        SET override_text = ?, override_step = ?,
            approved_step = NULL, approved_step_at = NULL, updated_at = ?
      WHERE lead_id = ?`,
  ).bind(body, step, t, leadId).run();
  await api.log('outreach_message_edited', { lead_id: leadId, step, chars: body.length });
  return { lead_id: leadId, step, text: r.text, approved_cleared: true };
}

// ── read the cohort ─────────────────────────────────────────────────────────
// One row per enrolled prospect with what actually matters: what we last said,
// what goes next and when, and whether they have answered.
export async function listCohortMembers(api, { status = null, cohort_id = null } = {}) {
  const where = [];
  const binds = [];
  if (status && status !== 'all') { where.push('status = ?'); binds.push(status); }
  if (cohort_id && cohort_id !== 'all') { where.push('COALESCE(cohort_id, ?) = ?'); binds.push(DEFAULT_COHORT, cohort_id); }
  const rows = ((await api.db.prepare(
    `SELECT * FROM plugin_gtm_outreach_cohort_members ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (next_send_at IS NULL), next_send_at ASC`,
  ).bind(...binds).all().catch(() => ({ results: [] }))).results) || [];
  const { cohorts } = await listCohorts(api);
  const nameOf = new Map(cohorts.map((qq) => [qq.id, qq.name]));
  if (!rows.length) {
    return { members: [], cohorts, counts: { active: 0, answered: 0, paused: 0, done: 0, stopped: 0 }, live: await isLive(api) };
  }

  // Lead details in one chunked read rather than one query per row.
  const leadIds = rows.map((r) => r.lead_id);
  const leads = new Map();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const c = leadIds.slice(i, i + CHUNK);
    // country + outreach_lang are NOT optional here: they decide which language
    // variant a prospect gets.
    const r = (await api.db.prepare(
      `SELECT id, name, company, position, photo, icp_fit, normalized_phone, phone, country, outreach_lang
         FROM plugin_gtm_leads WHERE id IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const l of r) leads.set(l.id, l);
  }

  // Where each prospect's actual WhatsApp conversation stands, for every member
  // in one chunked pass. Same derivation the Conversations tab uses.
  const convo = await conversationStatesFor(
    api,
    rows.map((r) => ({
      id: r.lead_id,
      chat_id: r.chat_id,
      normalized_phone: leads.get(r.lead_id)?.normalized_phone || null,
      phone: leads.get(r.lead_id)?.phone || null,
    })),
  ).catch(() => new Map());

  const { cadence } = await loadCohortCadence(api);
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const seqCache = new Map();
  const members = [];
  for (const row of rows) {
    const lead = leads.get(row.lead_id) || null;
    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(api, qId));
    // Rendered for THIS person, so the row shows the message they would
    // actually receive — variables filled, in their language — not a template.
    const rendered = lead ? renderSequence(seqCache.get(qId), lead) : { steps: [], length: 0, blocked: 'lead missing' };
    const ladder = rendered.steps.map((s) => s.text);
    const shownStep = row.step;
    // A per-person edit replaces the cohort's copy for THAT step only, and is
    // rendered through the same substitution so it cannot ship a raw {token}.
    const override = (row.override_text && row.override_step === shownStep && lead)
      ? renderBody(row.override_text, lead)
      : null;
    // Both a live and a staged member are 'about to get' their current step;
    // only a paused/stopped/finished one has nothing pending.
    const baseText = (row.status === 'active' || row.status === 'staged')
      ? (ladder[row.step] ?? null)
      : null;
    const nextText = baseText === null ? null : (override ? override.text : baseText);

    // The zone the send is actually measured in — the cohort's own if it has
    // one, else the account default.
    const tz = cohortById.get(qId)?.timezone || cadence.timezone;
    const when = row.status === 'active' && row.next_send_at ? zonedLabel(row.next_send_at, tz) : null;

    // Approval is per (person, step): the stored step must equal the step about
    // to go out. After a send moves them forward the match breaks by itself.
    const approved = row.approved_step != null && row.approved_step === shownStep;

    members.push({
      lead_id: row.lead_id,
      chat_id: row.chat_id,
      cohort_id: row.cohort_id || DEFAULT_COHORT,
      cohort_name: nameOf.get(row.cohort_id || DEFAULT_COHORT) || null,
      name: lead?.name || null,
      company: lead?.company || null,
      position: lead?.position || null,
      photo: lead?.photo || null,
      icp_fit: lead?.icp_fit || null,
      status: row.status,
      // Staged = filed into the cohort but NOT scheduled. Only go-live moves
      // someone out of this, and only the operator can do that.
      staged: row.status === 'staged',
      approved_at: row.approved_at || null,
      // Why this person could not go live, if anything. Surfaced up front so
      // the gap is visible before pressing go live, not after. An edit that
      // broke the message counts as blocked too.
      blocked: rendered.blocked
        || (override && (override.missing.length || override.unknown.length)
          ? `edited message has unfilled ${[...override.missing, ...override.unknown].join(', ')}`
          : null),
      answered: !!row.answered_at,
      answered_at: row.answered_at || null,
      step: row.step,
      // How many messages this person has ACTUALLY RECEIVED. `step` is the
      // index of the next one to send, which is the same number — but naming it
      // separately stops the sheet showing 1/3 to someone who has had nothing.
      sent_count: row.step,
      ladder_length: ladder.length,
      last_sent_text: row.last_sent_text || null,
      last_sent_at: row.last_sent_at || null,
      next_text: nextText,
      next_send_at: row.status === 'active' ? row.next_send_at : null,

      // ── the next message, and everything the sheet says about it ──
      // DRAFT = written and waiting, with no send time (nobody has gone live).
      // SCHEDULED = it has a moment it will leave at.
      next_state: row.status === 'staged' ? 'draft'
        : (row.status === 'active' && row.next_send_at) ? 'scheduled'
        : null,
      next_step: nextText === null ? null : shownStep,
      next_send_label: when?.label || null,
      next_send_zone: when?.zone || null,
      next_send_ymd: when?.ymd || null,
      timezone: tz,
      // Scheduled for the cohort's TODAY — the rows the operator has to look at
      // now, which is why they are pinned to the top of their cohort below.
      due_today: !!(when && when.ymd === zonedYmd(now(), tz)),

      // Per-message approval.
      approved: approved,
      approved_step: row.approved_step ?? null,
      // Distinct from `approved_at` above, which is the GO-LIVE stamp: this one
      // is when THIS message was signed off.
      approved_step_at: row.approved_step_at || null,
      // Whether an approval is required at all is a knowledge-doc setting, and
      // the sheet must show the rule that is actually in force.
      approval_required: !!cadence.require_approval,

      // The operator's inline edit of this one message, if any.
      edited: !!override,
      override_text: override ? row.override_text : null,
      // An edit that introduced an unfillable variable must be visible as a
      // problem here, not discovered at send time.
      override_blocked: override && (override.missing.length || override.unknown.length)
        ? `edited message has unfilled ${[...override.missing, ...override.unknown].join(', ')}`
        : null,

      // Where their real conversation stands: untouched | touched | active | dead.
      conversation: convo.get(row.lead_id)?.status || 'untouched',
      conversation_last_at: convo.get(row.lead_id)?.last_at || null,
      dead_by: convo.get(row.lead_id)?.dead_by || null,
      msgs_in: convo.get(row.lead_id)?.msgs_in || 0,
      msgs_out: convo.get(row.lead_id)?.msgs_out || 0,
      // Nothing left to say — the ladder is spent, not the prospect.
      exhausted: row.status === 'active' && row.step >= ladder.length,
      stop_reason: row.stop_reason || null,
      last_error: row.last_error || null,
    });
  }

  // Anything going out TODAY sits at the top of its cohort, because those are
  // the messages the operator still has time to read, approve or edit.
  //
  // Cohort first, THEN rank: a comparator that returned 0 for members of
  // different cohorts would not be transitive, and Array.sort is free to
  // produce nonsense from one.
  const rank = (m) => (m.due_today ? 0 : m.next_send_at ? 1 : m.next_state === 'draft' ? 2 : 3);
  const cohortOrder = new Map(cohorts.map((c, i) => [c.id, i]));
  members.sort((a, b) => {
    const c = (cohortOrder.get(a.cohort_id) ?? 999) - (cohortOrder.get(b.cohort_id) ?? 999);
    if (c) return c;
    const r = rank(a) - rank(b);
    if (r) return r;
    // Within a rank, soonest first; unscheduled rows fall back to a stable name.
    if (a.next_send_at && b.next_send_at) return a.next_send_at - b.next_send_at;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const counts = { staged: 0, active: 0, answered: 0, paused: 0, done: 0, stopped: 0 };
  for (const q of members) if (counts[q.status] !== undefined) counts[q.status]++;
  return { members, cohorts, counts, live: await isLive(api) };
}

// ── the tick ────────────────────────────────────────────────────────────────
// Runs on cron. Walks the due enrolments, re-verifies each one against the
// live conversation, and sends at most what the cadence allows.
export async function runCohortTick(api, { force = false, dry_run = null, limit = null } = {}) {
  const { cadence } = await loadCohortCadence(api);
  const live = await isLive(api);
  // dry_run defaults to "whatever the flag says"; an explicit value wins so a
  // caller can preview without touching the flag.
  const dry = dry_run === null ? !live : !!dry_run;
  const t = now();

  if (!force && !withinWindow(t, cadence)) {
    return { ran: false, reason: 'outside the sending window', dry_run: dry, next_open: nextWindowOpening(t, cadence) };
  }

  // Whole-account daily ceiling — the number that stops a bad enrolment
  // becoming a bulk send. Counts real sends only, so dry runs never eat it.
  const dayAgo = t - 86400000;
  const sentToday = Number((await api.db.prepare(
    'SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members WHERE last_sent_at IS NOT NULL AND last_sent_at > ?',
  ).bind(dayAgo).first().catch(() => null))?.n || 0);
  const budget = Math.max(0, cadence.max_sends_per_day - sentToday);
  if (!budget && !dry) {
    return { ran: false, reason: `daily cap reached (${cadence.max_sends_per_day})`, dry_run: dry };
  }

  // A member is only due if THEIR cohort is running.
  // APPROVED ROWS SORT FIRST. This query is LIMITed, so ordering by time alone
  // let messages nobody had approved fill the window every tick and permanently
  // mask the approved ones behind them.
  //
  // Ordering rather than EXCLUDING the unapproved, deliberately: an unapproved
  // row still has to be looked at, because the reply check below is what takes
  // someone who answered out of the automation.
  // (SQLite sorts 1 before 0 before NULL under DESC, which is the order wanted.)
  const order = cadence.require_approval
    ? '(m.approved_step = m.step) DESC, m.next_send_at ASC'
    : 'm.next_send_at ASC';
  const due = ((await api.db.prepare(
    `SELECT m.* FROM plugin_gtm_outreach_cohort_members m
       LEFT JOIN plugin_gtm_outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
      ORDER BY ${order} LIMIT ?`,
  ).bind(t, Math.min(limit || 25, 50)).all().catch(() => ({ results: [] }))).results) || [];

  // Counted separately so a tick that sends nothing can say WHY — an invisible
  // backlog reads as "the sender is broken".
  const awaiting = cadence.require_approval ? Number((await api.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members m
       LEFT JOIN plugin_gtm_outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
        AND (m.approved_step IS NULL OR m.approved_step <> m.step)`,
  ).bind(t).first().catch(() => null))?.n || 0) : 0;

  const results = [];
  let sent = 0;
  for (const row of due) {
    if (!dry && sent >= budget) { results.push({ lead_id: row.lead_id, action: 'deferred', reason: 'daily cap' }); continue; }
    const lead = await getLead(api, row.lead_id).catch(() => null);
    if (!lead) {
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'lead missing', next_send_at: null });
      results.push({ lead_id: row.lead_id, action: 'stopped', reason: 'lead missing' });
      continue;
    }

    // ── THE GUARD ── re-read the conversation NOW. Whatever was true when this
    // step was scheduled is irrelevant; what matters is whether they have
    // spoken since.
    const facts = await threadFacts(api, { chat_id: row.chat_id || chatIdOf(lead), lead, limit: 50 });
    if (facts.answered) {
      await writeRow(api, row.lead_id, {
        status: 'answered', answered_at: facts.last_in_at || t, stop_reason: 'answered', next_send_at: null,
      });
      await api.log('outreach_cohort_answered', { lead_id: row.lead_id, name: lead.name || null });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'answered — removed from automation' });
      continue;
    }

    const seq = await sequenceOf(api, row.cohort_id);
    const cad = effectiveCadence(cadence, await cohortRow(api, row.cohort_id));
    const rendered = renderSequence(seq, lead);
    // Re-validated at send time, not just at go-live: the cohort's copy or the
    // prospect's fields may have changed since approval, and a message with an
    // unfilled variable must never leave.
    if (rendered.blocked) {
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: rendered.blocked, next_send_at: null });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: rendered.blocked });
      continue;
    }
    const step = rendered.steps[row.step];
    // 'always' steps ignore the reply rule — but the answered check above has
    // already removed anyone who replied, so this only matters for a cohort
    // whose earlier steps were skipped.
    if (step && !WIRED_CHANNELS.includes(step.channel)) {
      await writeRow(api, row.lead_id, {
        status: 'stopped', stop_reason: 'channel not wired',
        last_error: `step ${row.step + 1} is set to ${step.channel}, which cannot send yet`, next_send_at: null,
      });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: `${step.channel} is not wired to a sender` });
      continue;
    }
    let text = step?.text;
    if (!text) {
      await writeRow(api, row.lead_id, { status: 'done', stop_reason: 'exhausted', next_send_at: null });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sequence finished' });
      continue;
    }

    // The operator's edit of THIS message for THIS person wins over the
    // cohort's copy — re-rendered here, so an edit that has since become
    // unfillable stops rather than sending with a hole in it.
    if (row.override_text && row.override_step === row.step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        await writeRow(api, row.lead_id, {
          status: 'stopped', stop_reason: 'blocked',
          last_error: `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}`, next_send_at: null,
        });
        results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: 'edited message cannot be filled in' });
        continue;
      }
      text = o.text;
    }

    // ── THE APPROVAL GATE ── the operator has to have signed off THIS message,
    // not merely this person. Deliberately does NOT clear next_send_at: the row
    // stays due and keeps showing at the top of its cohort until it is approved
    // or removed, so an unapproved message is a visible backlog rather than
    // something that quietly disappeared from the run.
    if (cadence.require_approval && row.approved_step !== row.step) {
      results.push({
        lead_id: row.lead_id, name: lead.name || null, action: 'awaiting approval',
        step: row.step, text,
      });
      continue;
    }

    if (dry) {
      results.push({
        lead_id: row.lead_id, name: lead.name || null, action: 'would send',
        step: row.step, chat_id: row.chat_id, text,
      });
      continue;
    }

    try {
      await api.gateway('whatsapp', 'send', { chatId: row.chat_id, text });
      sent++;
      const nextStep = row.step + 1;
      const more = nextStep < rendered.length;
      await writeRow(api, row.lead_id, {
        step: nextStep,
        last_sent_at: now(),
        last_sent_text: text,
        last_error: null,
        status: more ? 'active' : 'done',
        stop_reason: more ? null : 'exhausted',
        // The gap to the next message is the cohort's own, authored beside the copy.
        next_send_at: more ? nextWindowOpening(now() + delayForStep(seq, nextStep), cad) : null,
      });
      await api.log('outreach_cohort_sent', { lead_id: row.lead_id, name: lead.name || null, step: row.step, chars: text.length });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sent', step: row.step });
    } catch (e) {
      const err = String(e?.message || e).slice(0, 300);
      // A failed send stops that prospect rather than retrying blindly — a
      // silent retry loop against a broken gateway is how duplicates happen.
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'failed', last_error: err, next_send_at: null });
      await api.log('outreach_cohort_failed', { lead_id: row.lead_id, error: err });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'failed', error: err });
    }

    // Human spacing between sends, so a tick never machine-guns the gateway.
    if (!dry && sent < budget) {
      await new Promise((r) => setTimeout(r, Math.min(cadence.min_gap_minutes * 60000, 15000)));
    }
  }

  await api.log('outreach_cohort_tick', { due: due.length, sent, awaiting_approval: awaiting, dry_run: dry, live });
  return { ran: true, dry_run: dry, live, due: due.length, sent, awaiting_approval: awaiting, results };
}

// ── the tick, as five decisions instead of one function ─────────────────────
// The `outreach-cohort-tick` workflow needs the SAME behaviour as ordered steps
// an operator can read, re-run and audit one at a time: who is due → who has
// since answered → what would each of them receive → which of those did the
// operator sign off → send.
//
// What is deliberately NOT split is the claim-then-send loop at the end. The
// conversation must be re-read in the moment BEFORE each send and the step must
// advance in the same breath as it; batching those apart would let a reply that
// lands mid-run still collect its follow-up.

// STEP 1 — who is due, and how much room is left in the day.
export async function listDueMembers(api, { force = false, dry_run = null, limit = null } = {}) {
  const { cadence } = await loadCohortCadence(api);
  const live = await isLive(api);
  const dry = (dry_run === null || dry_run === undefined) ? !live : !!dry_run;
  const t = now();

  if (!force && !withinWindow(t, cadence)) {
    return {
      ran: false, reason: 'outside the sending window', due: [], budget: 0,
      dry_run: dry, live, awaiting_approval: 0, next_open: nextWindowOpening(t, cadence),
    };
  }

  // Whole-account daily ceiling. Counts real sends only, so dry runs never eat it.
  const sentToday = Number((await api.db.prepare(
    'SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members WHERE last_sent_at IS NOT NULL AND last_sent_at > ?',
  ).bind(t - 86400000).first().catch(() => null))?.n || 0);
  const budget = Math.max(0, cadence.max_sends_per_day - sentToday);
  if (!budget && !dry) {
    return { ran: false, reason: `daily cap reached (${cadence.max_sends_per_day})`, due: [], budget: 0, dry_run: dry, live, awaiting_approval: 0 };
  }

  // APPROVED ROWS SORT FIRST — ordered rather than excluded because an
  // unapproved row still has to be LOOKED at: the reply check downstream is
  // what takes someone who answered out of the automation.
  const order = cadence.require_approval
    ? '(m.approved_step = m.step) DESC, m.next_send_at ASC'
    : 'm.next_send_at ASC';
  const due = ((await api.db.prepare(
    `SELECT m.* FROM plugin_gtm_outreach_cohort_members m
       LEFT JOIN plugin_gtm_outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
      ORDER BY ${order} LIMIT ?`,
  ).bind(t, Math.min(limit || 25, 50)).all().catch(() => ({ results: [] }))).results) || [];

  // Counted separately so a tick that sends nothing can say WHY.
  const awaiting = cadence.require_approval ? Number((await api.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_gtm_outreach_cohort_members m
       LEFT JOIN plugin_gtm_outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
        AND (m.approved_step IS NULL OR m.approved_step <> m.step)`,
  ).bind(t).first().catch(() => null))?.n || 0) : 0;

  return { ran: true, due, budget, dry_run: dry, live, awaiting_approval: awaiting };
}

// STEP 2 — anyone who has spoken since leaves the automation, permanently.
// Runs on EVERY due row, approved or not: filtering the unapproved out first
// would leave a prospect who replied sitting 'active' forever.
export async function retireAnsweredMembers(api, { due = [] } = {}) {
  const t = now();
  const kept = [];
  const retired = [];
  const unverified = [];
  for (const row of due) {
    const lead = await getLead(api, row.lead_id).catch(() => null);
    let facts = null;
    try {
      facts = await threadFacts(api, { chat_id: row.chat_id || chatIdOf(lead), lead, limit: 50 });
    } catch (e) {
      // Fail CLOSED: a conversation we could not read is one we cannot promise
      // is unanswered, so the row is dropped from this pass. Its send time is
      // untouched, so it stays due and is picked up again next tick.
      unverified.push({ lead_id: row.lead_id, name: lead?.name || null, error: String(e?.message || e).slice(0, 300) });
      continue;
    }
    if (!facts.answered) { kept.push(row); continue; }
    await writeRow(api, row.lead_id, {
      status: 'answered', answered_at: facts.last_in_at || t, stop_reason: 'answered', next_send_at: null,
    });
    await api.log('outreach_cohort_answered', { lead_id: row.lead_id, name: lead?.name || null });
    retired.push({ lead_id: row.lead_id, name: lead?.name || null, answered_at: facts.last_in_at || t });
  }
  return { due: kept, retired, unverified };
}

// STEP 3 — what each of them would actually receive. Fail-closed: a row whose
// message cannot be filled in is STOPPED here rather than sent with a hole in
// it.
export async function renderMemberMessages(api, { due = [] } = {}) {
  const seqCache = new Map();
  const sendable = [];
  const blocked = [];
  for (const row of due) {
    const lead = await getLead(api, row.lead_id).catch(() => null);
    if (!lead) {
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'lead missing', next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: null, action: 'stopped', reason: 'lead missing' });
      continue;
    }
    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(api, qId));
    const seq = seqCache.get(qId);
    const rendered = renderSequence(seq, lead);
    if (rendered.blocked) {
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: rendered.blocked, next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason: rendered.blocked });
      continue;
    }
    const step = rendered.steps[row.step];
    if (step && !WIRED_CHANNELS.includes(step.channel)) {
      const reason = `step ${row.step + 1} is set to ${step.channel}, which cannot send yet`;
      await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'channel not wired', last_error: reason, next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason });
      continue;
    }
    let text = step?.text;
    if (!text) {
      await writeRow(api, row.lead_id, { status: 'done', stop_reason: 'exhausted', next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sequence finished', reason: 'the ladder is spent' });
      continue;
    }
    // The operator's edit of THIS message for THIS person wins over the
    // cohort's copy — re-rendered here, so an edit that has since become
    // unfillable stops rather than sending with a hole in it.
    if (row.override_text && row.override_step === row.step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        const reason = `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}`;
        await writeRow(api, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: reason, next_send_at: null });
        blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason });
        continue;
      }
      text = o.text;
    }
    const nextStep = row.step + 1;
    sendable.push({
      lead_id: row.lead_id, name: lead.name || null, chat_id: row.chat_id,
      cohort_id: qId, step: row.step, approved_step: row.approved_step ?? null, text,
      // Everything the send step needs to arm the FOLLOWING message, resolved
      // here so it never has to re-render a sequence mid-send.
      more: nextStep < rendered.length,
      next_delay_ms: nextStep < rendered.length ? delayForStep(seq, nextStep) : null,
    });
  }
  return { sendable, blocked };
}

// STEP 4 — the approval gate. Approval is per (person, step): sending advances
// `step`, so a stored index stops matching by itself and the next message is
// un-approved by construction.
export async function gateMemberApprovals(api, { sendable = [] } = {}) {
  const { cadence } = await loadCohortCadence(api);
  if (!cadence.require_approval) return { sendable, awaiting: [], approval_required: false };
  const approved = [];
  const awaiting = [];
  for (const m of sendable) {
    if (m.approved_step === m.step) { approved.push(m); continue; }
    // Deliberately NO write: the row keeps its send time, so an unapproved
    // message stays visibly due at the top of its cohort rather than quietly
    // vanishing from the run.
    awaiting.push({ lead_id: m.lead_id, name: m.name, step: m.step, text: m.text });
  }
  return { sendable: approved, awaiting, approval_required: true };
}

// STEP 5 — send. THE LOOP THAT MUST NOT BE SPLIT: for each message the
// conversation is re-read in the moment before it leaves, the step advances in
// the same write as the send, and any failure STOPS that prospect rather than
// re-arming them. dry_run reports what would have gone and writes nothing.
export async function sendDueMessages(api, { sendable = [], budget = 0, dry_run = true } = {}) {
  const { cadence } = await loadCohortCadence(api);
  const dry = !!dry_run;
  const cohortCache = new Map();
  const results = [];
  let sent = 0;

  for (const m of sendable) {
    if (!dry && sent >= budget) { results.push({ lead_id: m.lead_id, name: m.name, action: 'deferred', reason: 'daily cap' }); continue; }
    if (dry) {
      results.push({ lead_id: m.lead_id, name: m.name, action: 'would send', step: m.step, chat_id: m.chat_id, text: m.text });
      continue;
    }

    // ── THE GUARD ── whatever was true when this step was rendered is
    // irrelevant; what matters is whether they have spoken since.
    const lead = await getLead(api, m.lead_id).catch(() => null);
    let facts = null;
    try {
      facts = await threadFacts(api, { chat_id: m.chat_id || chatIdOf(lead), lead, limit: 50 });
    } catch (e) {
      results.push({ lead_id: m.lead_id, name: m.name, action: 'held', reason: `could not verify the conversation (${String(e?.message || e).slice(0, 200)})` });
      continue;
    }
    if (facts.answered) {
      await writeRow(api, m.lead_id, {
        status: 'answered', answered_at: facts.last_in_at || now(), stop_reason: 'answered', next_send_at: null,
      });
      await api.log('outreach_cohort_answered', { lead_id: m.lead_id, name: m.name });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'answered — removed from automation' });
      continue;
    }

    if (!cohortCache.has(m.cohort_id)) cohortCache.set(m.cohort_id, await cohortRow(api, m.cohort_id));
    const cad = effectiveCadence(cadence, cohortCache.get(m.cohort_id));
    try {
      await api.gateway('whatsapp', 'send', { chatId: m.chat_id, text: m.text });
      sent++;
      await writeRow(api, m.lead_id, {
        step: m.step + 1,
        last_sent_at: now(),
        last_sent_text: m.text,
        last_error: null,
        status: m.more ? 'active' : 'done',
        stop_reason: m.more ? null : 'exhausted',
        next_send_at: m.more ? nextWindowOpening(now() + (m.next_delay_ms || 0), cad) : null,
      });
      await api.log('outreach_cohort_sent', { lead_id: m.lead_id, name: m.name, step: m.step, chars: m.text.length });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'sent', step: m.step });
    } catch (e) {
      const err = String(e?.message || e).slice(0, 300);
      await writeRow(api, m.lead_id, { status: 'stopped', stop_reason: 'failed', last_error: err, next_send_at: null });
      await api.log('outreach_cohort_failed', { lead_id: m.lead_id, error: err });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'failed', error: err });
    }

    // Human spacing between sends, so a run never machine-guns the gateway.
    if (sent < budget) await new Promise((r) => setTimeout(r, Math.min(cadence.min_gap_minutes * 60000, 15000)));
  }

  await api.log('outreach_cohort_tick', { sendable: sendable.length, sent, dry_run: dry });
  return { sent, results, dry_run: dry };
}
