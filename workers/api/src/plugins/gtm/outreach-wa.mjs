// GTM plugin — lib/outreach-wa.mjs. The prospect conversation surface, ported
// from workers/api/src/lib/outreach-wa.js (contract v2.1 pack lib).
//
// The Outreach module's default tab is a WhatsApp inbox filtered to PROSPECTS:
// people who came through Prospecting/GTM and who we have a WhatsApp DM with.
// Three reads and one compose live here; the tools/ wrappers stay thin.
//
//   listProspectThreads — the conversation list (latest first, uncaught pinned)
//   readProspectThread  — one chat's full history + which lead it belongs to
//   draftReply          — the suggested draft under the composer
//
// The lead <-> chat join is DERIVED, not stored: plugin_gtm_leads
// .normalized_phone maps to the WhatsApp DM id `<digits>@c.us` (toChatId,
// duplicated below per the lib-imports-nothing contract). No new table.
//
// Everything the operator might want to tune — how many threads, how much
// history, how the draft is written — lives in the
// `plugin-gtm-outreach-reply-drafting` knowledge doc, seeded on first read.
// The model is reached ONLY through the `llm` gateway.
//
// Port notes (behavioral deltas from the host original):
// - Host tables wa_messages / wa_chats / wa_lid_map are SELECT-only here
//   (requires.host_reads). The original's best-effort `syncFromGateway` call in
//   conversationStatesFor wrote host tables and had no gateway mode, so it is
//   DROPPED: freshness now relies on the host's own webhook/cron sync.
// - loadModelConfig is replaced by a read of the host `llm-models` doc (declare
//   in requires.knowledge); env-var fallbacks are unreachable from a plugin, so
//   a missing/unparseable doc falls back to the coded writer default.
// - Helpers from whatsapp.js / gtm.js / gtm-outreach.js / outreach-threads.js /
//   outreach-cadence.js are DUPLICATED here (lib files import nothing).

const DRAFT_SLUG = 'plugin-gtm-outreach-reply-drafting';

// Bound every fan-out: D1 chokes on an IN() list that grows with the data, so
// every lookup below chunks at this width (the getThreadStats precedent).
const CHUNK = 80;

// WhatsApp timestamps arrive as seconds from some gateway builds and ms from
// others; normalise so ordering never silently inverts.
const waMs = (t) => (t == null ? null : (Number(t) < 1e12 ? Number(t) * 1000 : Number(t)));
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

// Duplicated from host lib/whatsapp.js toChatId (pure).
function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('chatId required');
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`could not parse chatId from ${input}`);
  return `${digits}@c.us`;
}

// The DM id for a phone. Group chats are never prospects — this is 1:1 only.
const chatIdForPhone = (phone) => { try { return toChatId(phone); } catch { return null; } };

// Duplicated from host lib/util.js safeJSON (pure).
function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// Duplicated from host lib/whatsapp.js recentMessages — a SELECT on the host
// wa_messages table (declared host read).
async function recentMessages(api, { chat_id = null, limit = 200 } = {}) {
  const sql = chat_id
    ? 'SELECT * FROM wa_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM wa_messages ORDER BY timestamp DESC LIMIT ?';
  const stmt = chat_id ? api.db.prepare(sql).bind(chat_id, limit) : api.db.prepare(sql).bind(limit);
  const r = await stmt.all();
  return (r.results || []).map((m) => ({ ...m, raw_json: safeJSON(m.raw_json) }));
}

// Duplicated from host lib/outreach-threads.js getThreadStats — the thread KPI
// cache, renamed to the plugin namespace.
async function getThreadStats(api, keys = []) {
  const out = new Map();
  const uniq = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 90) {
    const c = uniq.slice(i, i + 90);
    const r = (await api.db.prepare(
      `SELECT key, channel, replied, uncaught, msgs_in, msgs_out, sentiment, sentiment_reason, last_inbound_text, last_inbound_at
       FROM plugin_gtm_outreach_threads WHERE key IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) out.set(row.key, row);
  }
  return out;
}

// Duplicated from host lib/gtm-outreach.js readAngles.
async function readAngles(api, leadId) {
  const r = await api.db.prepare('SELECT payload, updated_at FROM plugin_gtm_outreach_angles WHERE lead_id = ?').bind(leadId).first();
  if (!r) return null;
  try { return { ...JSON.parse(r.payload), angles_at: r.updated_at }; } catch { return null; }
}

// Duplicated from host lib/gtm.js getLead.
async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

// Duplicated from host lib/gtm.js (pure). A linkedin.com/company/ page is the
// COMPANY, never the person.
const isCompanyLinkedin = (u) => /linkedin\.com\/company\//i.test(String(u || ''));
const personLinkedin = (lead, socials) =>
  (lead.linkedin && !isCompanyLinkedin(lead.linkedin) ? lead.linkedin : null)
  || (socials.find((s) => s.type === 'linkedin' && !isCompanyLinkedin(s.url))?.url ?? null);

// Duplicated from host lib/gtm.js leadState (pure). Green = first + last name +
// company + linkedin + position; red = none; yellow = partial.
function leadState(lead) {
  let socials = [];
  try { socials = lead.socials ? JSON.parse(lead.socials) : []; } catch { socials = []; }
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const signals = [
    parts.length >= 1,
    parts.length >= 2,
    !!lead.company,
    !!personLinkedin(lead, socials),
    !!lead.position,
  ];
  const n = signals.filter(Boolean).length;
  return n === signals.length ? 'green' : n === 0 ? 'red' : 'yellow';
}

// ── cadence (duplicated from host lib/outreach-cadence.js, read-only) ───────
// Only dead_after_days is used here, but the whole shape is kept so the numbers
// cannot drift from the queue engine's copy of the same doc.
const CADENCE_DEFAULTS = {
  step_delays_hours: [72, 96, 168],
  max_sends_per_day: 20,
  min_gap_minutes: 8,
  quiet_start_hour: 9,
  quiet_end_hour: 19,
  weekdays_only: true,
  timezone: 'Asia/Jerusalem',
  dead_after_days: 21,
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
  if (out.quiet_end_hour <= out.quiet_start_hour) {
    out.quiet_start_hour = CADENCE_DEFAULTS.quiet_start_hour;
    out.quiet_end_hour = CADENCE_DEFAULTS.quiet_end_hour;
  }
  return out;
}

async function loadCohortCadence(api) {
  try {
    const doc = await api.knowledge('plugin-gtm-outreach-cohort-cadence');
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

// ── the writer model (replaces host loadModelConfig().writer) ───────────────
// Reads the host `llm-models` doc (declared in requires.knowledge). A plugin
// cannot reach env vars, so the doc value falls back straight to the coded
// default the host would have used.
const WRITER_DEFAULT = 'claude-opus-4-8';
async function writerModel(api) {
  try {
    const doc = await api.knowledge('llm-models');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const s = String(src.writer ?? '').trim();
    // model ids are short tokens — refuse anything that looks like prose
    return s && s.length <= 120 && !/\s{2,}|\n/.test(s) ? s : WRITER_DEFAULT;
  } catch { return WRITER_DEFAULT; }
}

// ── knowledge: the drafting rules + the surface's numeric limits ────────────
const DRAFT_DEFAULT = `How to write the suggested reply to a prospect on WhatsApp:

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

// Numeric limits live in the doc's json block so they are tunable without a
// deploy (same pattern as wa_search_weights in the wa-chat-search doc).
const DRAFT_LIMITS = {
  // conversations listed in the WA tab
  thread_limit: 60,
  // messages loaded when a conversation is opened
  message_limit: 300,
  // messages handed to the model when composing a draft
  draft_context_messages: 12,
  // characters of any one message given to the model
  draft_context_chars: 500,
};

function draftSeedBody(rules, limits) {
  return `Outreach · WA — how the suggested draft under the composer is written, and how much of the conversation the tab loads.

The draft is a SUGGESTION. It is never sent automatically: it lands in the composer for you to edit or delete. When you have not messaged the prospect yet, the tab shows the top saved GTM angle verbatim instead of writing anything new — so a cold first touch is always exactly the message you approved in GTM → Outreach.

Edit the rules below to change how replies are written. Edit the json block to change how much the tab loads. Both apply with no deploy.

\`\`\`json
${JSON.stringify(limits, null, 2)}
\`\`\`

---
${rules}
`;
}

// ── knowledge: the default first-touch message ──────────────────────────────
// What the composer suggests for a prospect nobody has messaged yet and who
// has no saved GTM angle. Verbatim except {first_name} (the lead's stored
// first name). Edit the doc to change it — no deploy.
const FIRST_TOUCH_SLUG = 'plugin-gtm-outreach-first-touch';
const FIRST_TOUCH_DEFAULT = `היי {first_name}, לב (דרך הקבוצה של גיא פרנקלין)
אני מחפש חיבור למי שמוביל אצלכם פרוייקטים פנימיים.

בתכלס - אני מפעיל קונסלטנסי שלוקח את הפרויקט החשוב שאין לאף אחד זמן להוביל ומחזיר אותו כמערכת עובדת שהצוות שלכם יודע להריץ. תחשוב FDE על סטאק דינמי ו senior judgement אמיתי.

יכול להיות רלוונטי?`;

function firstTouchSeedBody(template) {
  return `Outreach · the default first-touch message.

Offered in the composer for prospects with NO conversation and NO saved GTM
angle (a saved angle always wins). {first_name} is replaced with the lead's
stored first name; everything else is sent exactly as written below. Never
sent automatically — it lands in the composer for you to edit.

---
${template}
`;
}

export async function loadFirstTouchTemplate(api) {
  try {
    const doc = await api.knowledge(FIRST_TOUCH_SLUG);
    if (!doc) {
      await api.saveKnowledge(FIRST_TOUCH_SLUG, {
        title: 'Outreach · default first touch',
        body: firstTouchSeedBody(FIRST_TOUCH_DEFAULT),
      }).catch(() => {});
      return FIRST_TOUCH_DEFAULT;
    }
    const body = String(doc.body || '');
    const idx = body.indexOf('\n---\n');
    return (idx >= 0 ? body.slice(idx + 5) : body).trim() || FIRST_TOUCH_DEFAULT;
  } catch { return FIRST_TOUCH_DEFAULT; }
}

function renderFirstTouch(template, lead) {
  let first = String(lead?.name || '').trim().split(/\s+/)[0] || '';
  // lead names are stored lowercase-latin; a greeting deserves a capital
  if (/^[a-z]/.test(first)) first = first[0].toUpperCase() + first.slice(1);
  // a nameless lead gets a clean greeting, not a dangling placeholder
  const t = first ? template : template.replace(/היי \{first_name\},/g, 'היי,');
  return t.replaceAll('{first_name}', first).replace(/ ,/g, ',');
}

// Read the rules + limits, seeding the doc on first read. Never throws.
export async function loadDraftingRules(api) {
  try {
    const doc = await api.knowledge(DRAFT_SLUG);
    if (!doc) {
      await api.saveKnowledge(DRAFT_SLUG, {
        title: 'Outreach · WA reply drafting',
        body: draftSeedBody(DRAFT_DEFAULT, DRAFT_LIMITS),
      }).catch(() => {});
      return { rules: DRAFT_DEFAULT, limits: { ...DRAFT_LIMITS }, source: 'defaults' };
    }
    const body = String(doc.body || '');
    const m = body.match(/```json\s*([\s\S]*?)```/);
    const limits = { ...DRAFT_LIMITS };
    if (m) {
      try {
        const src = JSON.parse(m[1]);
        for (const k of Object.keys(DRAFT_LIMITS)) {
          const v = Number(src[k]);
          if (Number.isFinite(v) && v > 0) limits[k] = Math.floor(v);
        }
      } catch { /* keep defaults */ }
    }
    const idx = body.indexOf('\n---\n');
    const rules = (idx >= 0 ? body.slice(idx + 5) : body).trim() || DRAFT_DEFAULT;
    return { rules, limits, source: 'doc' };
  } catch {
    return { rules: DRAFT_DEFAULT, limits: { ...DRAFT_LIMITS }, source: 'defaults' };
  }
}

export async function saveDraftingRules(api, { rules, limits } = {}) {
  const cur = await loadDraftingRules(api);
  const clean = String(rules ?? cur.rules).trim() || DRAFT_DEFAULT;
  const nextLimits = { ...cur.limits };
  for (const k of Object.keys(DRAFT_LIMITS)) {
    const v = Number(limits?.[k]);
    if (Number.isFinite(v) && v > 0) nextLimits[k] = Math.floor(v);
  }
  await api.saveKnowledge(DRAFT_SLUG, {
    title: 'Outreach · WA reply drafting',
    body: draftSeedBody(clean, nextLimits),
  });
  await api.log('outreach_drafting_rules_updated', { chars: clean.length, limits: nextLimits });
  return { rules: clean, limits: nextLimits, source: 'doc' };
}

// ── the prospect card ───────────────────────────────────────────────────────
// The subset of a lead the side panel shows. Wide JSON columns (sources,
// conflicts, raw org payloads) stay out — this rides in every list response.
function prospectCard(lead) {
  if (!lead) return null;
  let socials = [];
  try { socials = lead.socials ? JSON.parse(lead.socials) : []; } catch { socials = []; }
  let icp = null;
  try { icp = lead.icp_reasons ? JSON.parse(lead.icp_reasons) : null; } catch { icp = null; }
  let positions = [];
  try { positions = lead.open_positions ? JSON.parse(lead.open_positions) : []; } catch { positions = []; }
  return {
    lead_id: lead.id,
    name: lead.name || null,
    company: lead.company || null,
    position: lead.position || null,
    photo: lead.photo || null,
    phone: lead.normalized_phone || lead.phone || null,
    email: lead.email || null,
    linkedin: lead.linkedin || null,
    // The COMPANY page is not a column — it lives in socials as a
    // linkedin_company entry (the manual-edit tool owns that shape).
    company_linkedin: (socials.find((s) => isCompanyLinkedin(s?.url))?.url) || null,
    company_staff_count: lead.company_staff_count ?? null,
    country: lead.country || null,
    region: lead.region || null,
    icp_fit: lead.icp_fit || null,
    icp_reasons: Array.isArray(icp?.reasons) ? icp.reasons : [],
    icp_gaps: Array.isArray(icp?.gaps) ? icp.gaps : [],
    org_status: lead.org_status || null,
    org_note: lead.org_note || null,
    open_positions: Array.isArray(positions) ? positions.slice(0, 8) : [],
    socials: Array.isArray(socials) ? socials.map((s) => ({ type: s?.type || null, url: s?.url || null })).filter((s) => s.url) : [],
    status: lead.status || null,
  };
}

// A WhatsApp privacy chat (`<digits>@lid`) hides the real number, so its id
// digits are NOT the prospect's phone and match no lead. wa_lid_map holds the
// resolution (lid → pn / phone) the gateway recorded. Returns Map<lid, digits>.
// Without this, every prospect WhatsApp has anonymised is invisible here — 14
// leads and 443 lid chats on live data, against 6 conversations shown.
async function digitsForLids(api, lids = []) {
  const out = new Map();
  if (!lids.length) return out;
  for (let i = 0; i < lids.length; i += CHUNK) {
    const c = lids.slice(i, i + CHUNK);
    const r = (await api.db.prepare(
      `SELECT lid, phone, pn FROM wa_lid_map WHERE lid IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) {
      const d = digitsOf(row.phone || String(row.pn || '').split('@')[0]);
      if (d) out.set(row.lid, d);
    }
  }
  return out;
}

// Leads for a set of chat ids, keyed by chat id. Chunked IN() — the chat set
// is the bounded side of this join (chats we actually hold), never the leads.
// Handles both `<digits>@c.us` (digits ARE the phone) and `<digits>@lid`
// (digits are meaningless; the phone comes from wa_lid_map).
async function leadsByChatId(api, chatIds = []) {
  const ids = chatIds.map(String);
  const lidResolved = await digitsForLids(api, ids.filter((id) => id.endsWith('@lid')));
  const byDigits = new Map();
  for (const id of ids) {
    const d = id.endsWith('@lid') ? lidResolved.get(id) : digitsOf(id.split('@')[0]);
    // Several chat ids can resolve to one phone (a lid and its @c.us twin).
    // Keep them all so each conversation still finds its lead.
    if (d) {
      if (!byDigits.has(d)) byDigits.set(d, []);
      byDigits.get(d).push(id);
    }
  }
  const out = new Map();
  const digits = [...byDigits.keys()];
  for (let i = 0; i < digits.length; i += CHUNK) {
    const c = digits.slice(i, i + CHUNK);
    // Match on the E.164 column with its punctuation stripped, so a lead stored
    // as "+972 50-000-0000" still lines up with chat id 972500000000@c.us.
    const r = (await api.db.prepare(
      `SELECT * FROM plugin_gtm_leads
        WHERE replace(replace(replace(replace(coalesce(normalized_phone, phone), '+', ''), '-', ''), ' ', ''), '(', '')
              IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const lead of r) {
      const d = digitsOf(lead.normalized_phone || lead.phone);
      // First lead wins per chat — a duplicate phone in the lead store must not
      // silently swap which prospect a live conversation is attributed to.
      for (const chatId of byDigits.get(d) || []) if (!out.has(chatId)) out.set(chatId, lead);
    }
  }
  return out;
}

// Per chat: the latest REAL message plus the inbound/outbound tallies the list
// needs to classify a conversation (empty bodies are receipts, not text).
// Aggregated in SQL rather than by calling threadFacts per row — a list of
// sixty conversations cannot afford sixty message reads.
async function lastMessages(api, chatIds = []) {
  const out = new Map();
  for (let i = 0; i < chatIds.length; i += CHUNK) {
    const c = chatIds.slice(i, i + CHUNK);
    const ph = c.map(() => '?').join(',');
    const REAL = "body IS NOT NULL AND length(trim(body)) > 0";
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

// Operator "this is dead" markings, keyed by lead (a person can hold several
// chat ids — dead on one and alive on another would be nonsense).
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

// ── where each prospect's conversation stands, in bulk ──────────────────────
// The Cohorts sheet needs the same four states the Conversations tab shows, for
// every member at once. Doing it per row would be one query per person; this
// resolves every chat id (including the `@lid` privacy twins) and reads the
// messages in chunked passes instead.
//
// The vocabulary is deliberately IDENTICAL to listProspectThreads' buckets, and
// derived from the same messages, so a prospect cannot read "active" on one tab
// and "untouched" on the other. The only addition is splitting that tab's
// `unanswered` into UNTOUCHED (we have never said anything) and TOUCHED (we
// have, they have not) — a distinction the cohort sheet needs and the inbox
// does not, because in a cohort those two demand opposite actions.
//
//   untouched — nothing has ever been sent to them
//   touched   — we have sent, they have not replied
//   active    — they have replied; the automation is off them permanently
//   dead      — marked dead by hand, or nothing has happened for dead_after_days
//
// Dead wins over active, exactly as it does in the inbox.
//
// PORT NOTE: the host original ran a best-effort incremental syncFromGateway
// here before reading, so a reply that arrived since the last cron flipped a
// person to `active` before the approve button could offer to message them.
// That sync WRITES the host wa_messages/wa_chats tables and has no gateway
// mode, so a plugin cannot run it: this read now answers from the host tables
// as the webhook/cron sync last left them.
export async function conversationStatesFor(api, leads = []) {
  const out = new Map();
  if (!leads.length) return out;
  const deadAfterDays = (await loadCohortCadence(api)).cadence.dead_after_days;

  // Every id a person might hold: the phone-derived `@c.us`, whatever id we
  // stored at enrol time, and any `@lid` twin WhatsApp has mapped to either.
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

  const deadBefore = Date.now() - deadAfterDays * 86400000;
  for (const lead of leads) {
    const ids = [...(idsOf.get(lead.id) || [])];
    // Merge every id the person holds. A reply that landed on the privacy twin
    // still means answered even when the newest message sits on the other id —
    // the same merge the inbox does, for the same reason.
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

// Mark a conversation dead (or bring it back). Manual only — time-based death
// is derived at read time, so un-marking always restores the real state.
export async function setConversationDead(api, { lead_id, dead = true, reason = null } = {}) {
  if (!lead_id) return { error: 'lead_id required' };
  const t = Date.now();
  await api.db.prepare(
    `INSERT INTO plugin_gtm_outreach_conversation_state (lead_id, dead_at, dead_reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET dead_at=excluded.dead_at, dead_reason=excluded.dead_reason, updated_at=excluded.updated_at`,
  ).bind(lead_id, dead ? t : null, dead ? (reason || null) : null, t).run();
  await api.log(
    dead ? 'outreach_conversation_marked_dead' : 'outreach_conversation_revived',
    { lead_id, reason: reason || null },
  );
  return { lead_id, dead: !!dead, reason: reason || null };
}

// ── the conversation list ───────────────────────────────────────────────────
// Prospect DMs only, newest first, with the ones who spoke last pinned to the
// top — the operator's actual queue is "who is waiting on me".
export async function listProspectThreads(api, { q = '', limit = null, status = 'active' } = {}) {
  // Freshness is the HOST's job (webhook + cron sync of wa_messages) so this
  // read answers straight from D1 — blocking here doubled the module's first
  // paint.
  const { limits } = await loadDraftingRules(api);
  const cap = Math.min(200, limit || limits.thread_limit);
  const deadAfterDays = (await loadCohortCadence(api)).cadence.dead_after_days;

  // The conversation set comes from wa_messages, NOT wa_chats. A chat row is
  // only written by the gateway pull-sync; an outbound send pre-inserts the
  // message alone. On live data most outreach conversations therefore have
  // messages and no wa_chats row — sourcing from wa_chats hid nearly all of
  // them. wa_chats is still unioned in (it carries the chat name, and holds
  // chats we have not exchanged a message in yet).
  // 1:1 chats are `@c.us` OR `@lid` (a privacy chat is still a person, just an
  // anonymised one). Groups (`@g.us`) are never a prospect conversation.
  const fromMsgs = ((await api.db.prepare(
    `SELECT chat_id AS id, MAX(timestamp) AS last_message_at
       FROM wa_messages
      WHERE chat_id LIKE '%@c.us' OR chat_id LIKE '%@lid'
      GROUP BY chat_id
      ORDER BY last_message_at DESC
      LIMIT 400`,
  ).all().catch(() => ({ results: [] }))).results) || [];
  const fromChats = ((await api.db.prepare(
    `SELECT id, name, last_message_at, last_snippet
       FROM wa_chats
      WHERE is_group = 0 AND (id LIKE '%@c.us' OR id LIKE '%@lid')
      ORDER BY (last_message_at IS NULL), last_message_at DESC
      LIMIT 400`,
  ).all().catch(() => ({ results: [] }))).results) || [];

  const byId = new Map();
  for (const r of fromMsgs) byId.set(r.id, { id: r.id, name: null, last_message_at: r.last_message_at, last_snippet: null });
  for (const r of fromChats) {
    const ex = byId.get(r.id);
    if (ex) { ex.name = r.name || null; ex.last_snippet = r.last_snippet || null; }
    else byId.set(r.id, { id: r.id, name: r.name || null, last_message_at: r.last_message_at, last_snippet: r.last_snippet || null });
  }
  const chats = [...byId.values()];
  if (!chats.length) return { threads: [], total: 0 };

  const ids = chats.map((c) => c.id);
  const leads = await leadsByChatId(api, ids);
  const matched = chats.filter((c) => leads.has(c.id));
  if (!matched.length) return { threads: [], total: 0 };

  const matchedIds = matched.map((c) => c.id);
  const [lasts, stats, marks] = await Promise.all([
    lastMessages(api, matchedIds),
    getThreadStats(api, matchedIds).catch(() => new Map()),
    deadMarks(api, [...new Set(matched.map((c) => leads.get(c.id).id))]),
  ]);

  const needle = String(q || '').trim().toLowerCase();
  let threads = matched.map((chat) => {
    const lead = leads.get(chat.id);
    const last = lasts.get(chat.id) || null;
    const st = stats.get(chat.id) || null;
    const lastAt = last ? waMs(last.timestamp) : waMs(chat.last_message_at);
    return {
      chat_id: chat.id,
      lead_id: lead.id,
      name: lead.name || chat.name || null,
      company: lead.company || null,
      position: lead.position || null,
      photo: lead.photo || null,
      icp_fit: lead.icp_fit || null,
      last_text: last?.body || chat.last_snippet || null,
      last_from_me: last ? Number(last.from_me) === 1 : null,
      last_at: lastAt || null,
      // They spoke last => the ball is in our court. Derived from the messages
      // themselves so a badge never depends on the KPI cache having run.
      uncaught: last ? Number(last.from_me) === 0 : false,
      never_messaged: !last,
      // ANSWERED = they have said something back at any point. This is what
      // separates a real conversation from a monologue.
      answered: (last?.in_n ?? 0) > 0,
      sentiment: st?.sentiment || null,
      msgs_in: last?.in_n ?? st?.msgs_in ?? null,
      msgs_out: last?.out_n ?? st?.msgs_out ?? null,
      dead_marked: marks.has(lead.id),
      dead_reason: marks.get(lead.id)?.dead_reason || null,
    };
  });

  // One row per PROSPECT, not per chat id. A lead whose number WhatsApp has
  // anonymised can hold both a `@c.us` and a `@lid` chat; listing both would
  // show the same person twice. Keep the most recently active as the row (the
  // thread reader merges every id's messages back together anyway).
  const perLead = new Map();
  for (const t of threads) {
    const ex = perLead.get(t.lead_id);
    if (!ex) { perLead.set(t.lead_id, t); continue; }
    // Merge, don't just pick: a reply on the privacy twin still means answered
    // even when the newest message sits on the other id.
    const keep = (t.last_at || 0) > (ex.last_at || 0) ? t : ex;
    keep.answered = ex.answered || t.answered;
    keep.msgs_in = (ex.msgs_in || 0) + (t.msgs_in || 0);
    keep.msgs_out = (ex.msgs_out || 0) + (t.msgs_out || 0);
    perLead.set(t.lead_id, keep);
  }
  threads = [...perLead.values()];

  // FRESH prospects — fully enriched (state green) with a usable phone but no
  // WhatsApp conversation anywhere yet. Prospecting finished the work on them;
  // without this block they were invisible here (the set above starts from
  // chats, so a person nobody messaged has no row). Additive: existing threads
  // are never touched, a fresh row appears only when the lead matched NO chat.
  {
    const seenLeadIds = new Set(threads.map((t) => t.lead_id));
    const allLeads = (await api.db.prepare(
      `SELECT * FROM plugin_gtm_leads WHERE normalized_phone IS NOT NULL ORDER BY updated_at DESC LIMIT 400`,
    ).all().catch(() => ({ results: [] }))).results || [];
    for (const lead of allLeads) {
      if (seenLeadIds.has(lead.id)) continue;
      const chatId = chatIdForPhone(lead.normalized_phone || lead.phone);
      if (!chatId) continue;
      let level = null;
      try { level = leadState(lead); } catch { continue; }   // returns 'green' | 'yellow' | 'red'
      if (level !== 'green') continue;
      threads.push({
        chat_id: chatId,
        lead_id: lead.id,
        name: lead.name || null,
        company: lead.company || null,
        position: lead.position || null,
        photo: lead.photo || null,
        icp_fit: lead.icp_fit || null,
        last_text: null, last_from_me: null, last_at: null,
        uncaught: false, never_messaged: true, answered: false,
        sentiment: null, msgs_in: null, msgs_out: null,
        dead_marked: false, dead_reason: null,
        fresh: true,
      });
    }
  }

  // Three buckets the operator actually thinks in:
  //   dead       — they marked it, or nothing has happened for dead_after_days
  //   active     — a real two-way conversation
  //   unanswered — we have spoken, they have not (yet)
  // Dead wins: a conversation that was answered but went cold weeks ago is not
  // something to show at the top of a working queue.
  const deadBefore = Date.now() - deadAfterDays * 86400000;
  for (const t of threads) {
    t.status = t.fresh ? 'fresh'
      : (t.dead_marked || (t.last_at && t.last_at < deadBefore)) ? 'dead'
      : t.answered ? 'active'
      : 'unanswered';
    t.dead_by = t.dead_marked ? 'marked' : (t.status === 'dead' ? 'stale' : null);
  }

  // A person with a QUEUED send is not 'no messages yet' — the sidebar shows
  // the queued text and a 'scheduled' status until it fires.
  {
    const live = (await api.db.prepare(
      `SELECT lead_id, bubbles, send_at FROM plugin_gtm_scheduled_sends WHERE status IN ('scheduled','claimed') ORDER BY send_at ASC LIMIT 200`,
    ).all().catch(() => ({ results: [] }))).results || [];
    const byLead = new Map();
    for (const s of live) if (!byLead.has(s.lead_id)) byLead.set(s.lead_id, s);
    for (const t of threads) {
      const s = byLead.get(t.lead_id);
      if (!s) continue;
      try { t.scheduled_text = JSON.parse(s.bubbles || '[]')[0] || null; } catch { t.scheduled_text = null; }
      t.scheduled_at = s.send_at;
      if (t.status === 'fresh' || t.never_messaged) t.status = 'scheduled';
    }
  }

  // Counted BEFORE filtering, so the toggle can say what it is hiding.
  const counts = { active: 0, unanswered: 0, dead: 0, fresh: 0, scheduled: 0 };
  for (const t of threads) counts[t.status]++;

  // Default view is 'working': every live conversation INCLUDING unanswered
  // first touches — a message you sent must never vanish from the screen just
  // because nobody replied yet. Only dead drops out; 'all' shows dead too.
  if (status && status !== 'all') {
    threads = threads.filter((t) => (
      status === 'working' ? t.status !== 'dead'
      : status === 'active' ? (t.status === 'active' || t.status === 'fresh')
      : t.status === status));
  }

  if (needle) {
    threads = threads.filter((t) => [t.name, t.company, t.position, t.last_text]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }

  // Newest activity first, plain — the phone app's order. (Uncaught threads
  // used to pin to the top; the operator reads that as wrong ordering.)
  threads.sort((a, b) => (b.last_at || 0) - (a.last_at || 0));

  return { threads: threads.slice(0, cap), total: threads.length, counts, status };
}

// A row we wrote ourselves at send time (the host whatsapp gateway's
// preInsertOutbound stamps raw_json.source), as opposed to one the gateway's
// webhook delivered. recentMessages parses raw_json, so accept either shape.
function isPreInsert(m) {
  const raw = m?.raw_json;
  if (raw && typeof raw === 'object') return raw.source === 'outbound';
  return String(raw || '').includes('outbound');
}

// Every chat id that belongs to one person: the `@c.us` id and any `@lid`
// privacy twin WhatsApp issued for the same number (either direction, since
// the operator may have opened either one).
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

// Collapse the SAME outgoing message written twice: once by us at send time
// (pre-insert) and once when WhatsApp echoed it back through the webhook. They
// carry different ids, so only text + closeness in time can pair them. Keeping
// both renders the operator's own message two or three times in the thread.
// The surviving copy is confirmed if any of its copies was webhook-sourced.
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
    // Merge: a webhook copy anywhere in the pair proves WhatsApp took it, and
    // the earliest timestamp is when we actually sent.
    twin.preinsert = twin.preinsert && m.preinsert;
    twin.at = Math.min(twin.at || m.at || 0, m.at || twin.at || 0) || twin.at;
  }
  return out;
}

// ── the one place "what happened in this conversation" is decided ───────────
// Every reader — the thread view, the draft, and the automated queue — goes
// through this, so they cannot disagree about whether a prospect replied. A
// queue that thought "no reply" while the screen showed one would keep messaging
// someone mid-conversation, which is the single worst thing this module could do.
//
// Merges every chat id the person holds, dedupes our double-written sends, and
// reports the facts the callers actually branch on.
export async function threadFacts(api, { chat_id, lead = null, limit = 300 } = {}) {
  const chatIds = await siblingChatIds(api, chat_id, lead);
  const rows = (await Promise.all(
    chatIds.map((cid) => recentMessages(api, { chat_id: cid, limit }).catch(() => [])),
  )).flat();

  // recentMessages is newest-first (the feed's order); a chat reads oldest-first.
  const ordered = rows
    .map((m) => ({
      id: m.id,
      from_me: Number(m.from_me) === 1,
      body: m.body || '',
      sender_name: m.sender_name || null,
      at: waMs(m.timestamp),
      // Our pre-insert is our OWN record that we called send; only a
      // webhook-sourced row proves WhatsApp actually processed the message.
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
    // Deliberately not "replied since our last send" — once a human has
    // spoken, the conversation belongs to a human.
    answered: inbound.length > 0,
    msgs_in: inbound.length,
    msgs_out: outbound.length,
    first_out_at: outbound[0]?.at ?? null,
    last_in_at: inbound[inbound.length - 1]?.at ?? null,
    last_out_at: outbound[outbound.length - 1]?.at ?? null,
    last_at: last?.at ?? null,
    last_text: last?.body ?? null,
    last_from_me: last ? last.from_me : null,
    // They spoke last => the ball is in our court.
    uncaught: !!last && !last.from_me,
  };
}

// ── one conversation ────────────────────────────────────────────────────────
// Full history for a chat plus the prospect it belongs to. Read-only: opening a
// conversation never writes and never spends a model call.
export async function readProspectThread(api, { chat_id, lead_id = null, limit = null } = {}) {
  const { limits } = await loadDraftingRules(api);
  let chatId = chat_id || null;
  let lead = null;

  if (!chatId && lead_id) {
    lead = await getLead(api, lead_id).catch(() => null);
    chatId = lead ? chatIdForPhone(lead.normalized_phone || lead.phone) : null;
  }
  if (!chatId) return { error: 'chat_id or a lead_id with a phone is required' };
  if (!lead) {
    const found = await leadsByChatId(api, [chatId]);
    lead = found.get(chatId) || null;
  }

  const { chat_ids: chatIds, messages: merged, answered } = await threadFacts(api, {
    chat_id: chatId, lead, limit: Math.min(1000, limit || limits.message_limit),
  });

  const messages = merged.map(({ preinsert, ...m }) => ({
    ...m,
    // '✓ sent' = we asked WhatsApp to send it. '✓✓ confirmed' = WhatsApp
    // echoed it back. Inbound has no tick. Claiming confirmed for every
    // outbound would tell the operator a message landed when we don't know.
    status: m.from_me ? (preinsert ? 'sent' : 'confirmed') : 'received',
  }));

  const stats = await getThreadStats(api, chatIds).catch(() => new Map());
  const st = chatIds.map((c) => stats.get(c)).find(Boolean) || null;

  return {
    chat_id: chatId,
    chat_ids: chatIds,
    // Named at the top level, not only inside the card: the reply workflow
    // threads one context, and its later steps are keyed by lead.
    lead_id: lead?.id || null,
    // ANSWERED is the fork the drafting steps read — a prospect who has spoken
    // gets a composed reply, one who has not gets the approved bubble.
    answered,
    prospect: prospectCard(lead),
    messages,
    count: messages.length,
    stats: st ? {
      replied: Number(st.replied) === 1,
      uncaught: Number(st.uncaught) === 1,
      msgs_in: st.msgs_in, msgs_out: st.msgs_out,
      sentiment: st.sentiment || null, sentiment_reason: st.sentiment_reason || null,
    } : null,
  };
}

// ── the suggested draft ─────────────────────────────────────────────────────
// The top saved angle, ranked. Angles are [{rank,target,type,rationale,
// messages[],confidence}] — rank 1 is the recommended play.
function topAngle(angles) {
  const list = Array.isArray(angles?.angles) ? angles.angles : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => (Number(a?.rank) || 99) - (Number(b?.rank) || 99))[0] || null;
}

function angleBubbles(angle) {
  const msgs = Array.isArray(angle?.messages) ? angle.messages : [];
  return msgs.map((m) => String(typeof m === 'string' ? m : (m?.text || ''))).filter((s) => s.trim());
}

// What to suggest under the composer.
//   no outbound yet -> the approved GTM angle, verbatim (no model, no drift)
//   a live thread   -> a reply composed from the angle + the last messages
export async function draftReply(api, { chat_id, lead_id = null, force_llm = false } = {}) {
  const { rules, limits } = await loadDraftingRules(api);
  let chatId = chat_id || null;
  let lead = lead_id ? await getLead(api, lead_id).catch(() => null) : null;
  if (!chatId && lead) chatId = chatIdForPhone(lead.normalized_phone || lead.phone);
  if (!chatId) return { error: 'chat_id or a lead_id with a phone is required' };
  if (!lead) {
    const found = await leadsByChatId(api, [chatId]);
    lead = found.get(chatId) || null;
  }
  if (!lead) return { draft: null, source: 'none', reason: 'This chat is not linked to a prospect in the lead store.' };

  const angles = await readAngles(api, lead.id).catch(() => null);
  const angle = topAngle(angles);
  const bubbles = angleBubbles(angle);

  // Same merge + dedup as the thread view. Reading a single id would miss a
  // reply that landed on the prospect's privacy chat — and then hand back a
  // cold opener to someone who has already answered.
  const chatIds = await siblingChatIds(api, chatId, lead);
  const rows = (await Promise.all(
    chatIds.map((cid) => recentMessages(api, { chat_id: cid, limit: limits.draft_context_messages }).catch(() => [])),
  )).flat();
  const real = dedupeOutbound(
    rows
      .filter((m) => String(m.body || '').trim())
      .map((m) => ({ ...m, from_me: Number(m.from_me) === 1, at: waMs(m.timestamp), preinsert: isPreInsert(m) }))
      .sort((a, b) => (a.at || 0) - (b.at || 0)),
  );
  const weSpoke = real.some((m) => m.from_me);
  const theySpoke = real.some((m) => !m.from_me);

  // They have NOT spoken — first touch OR a follow-up into silence. Either way
  // the answer is the next UNSENT approved bubble, never a composed one: there
  // is nothing to reply to, and a model handed a one-sided transcript writes
  // things like "thanks for getting back to me" to someone who never did.
  // This also makes the panel show exactly what the queue would send next.
  if (!theySpoke && !force_llm) {
    const sentCount = real.filter((m) => m.from_me).length;
    const next = bubbles[sentCount];
    if (!bubbles.length) {
      // No approved angle: the DEFAULT first touch from the
      // plugin-gtm-outreach-first-touch doc, personalised, straight into the panel.
      const template = await loadFirstTouchTemplate(api);
      return {
        draft: renderFirstTouch(template, lead), source: 'template', first_touch: true, lead_id: lead.id,
        reason: 'No saved angle — this is the default first touch (outreach-first-touch doc).',
      };
    }
    if (!next) {
      return {
        draft: null, source: 'none', lead_id: lead.id,
        reason: `The approved sequence is finished — all ${bubbles.length} messages have been sent and they have not answered.`,
      };
    }
    await api.log('outreach_draft_suggested', { lead_id: lead.id, chat_id: chatId, source: 'angle', step: sentCount });
    return {
      draft: next, source: 'angle', lead_id: lead.id, step: sentCount,
      first_touch: sentCount === 0,
      angle: angle ? { rank: angle.rank ?? null, type: angle.type || null, rationale: angle.rationale || null } : null,
      // The rest of the approved sequence, so the operator can send it as-is.
      alternatives: bubbles.slice(sentCount + 1),
    };
  }

  // A live conversation — compose a reply grounded in the angle and the thread.
  // Reachable without an inbound only via force_llm (the operator asking for
  // something fresh); say so in the prompt rather than letting the model assume.
  if (!theySpoke && !weSpoke && !force_llm) {
    return { draft: null, source: 'none', lead_id: lead.id, reason: 'Nothing to reply to yet.' };
  }

  const model = await writerModel(api);
  const card = prospectCard(lead);
  // `real` is oldest-first, so the most recent context is the TAIL. Taking the
  // head would hand the model the start of the conversation and hide the
  // message it is supposed to be answering.
  const transcript = real
    .slice(-limits.draft_context_messages)
    .map((m) => `${m.from_me ? 'US' : 'THEM'}: ${String(m.body).replace(/\s+/g, ' ').slice(0, limits.draft_context_chars)}`)
    .join('\n');

  const context = [
    `PROSPECT: ${card.name || 'unknown'}${card.position ? `, ${card.position}` : ''}${card.company ? ` at ${card.company}` : ''}.`,
    card.icp_fit ? `ICP fit: ${card.icp_fit}.` : '',
    card.icp_reasons.length ? `Why they fit: ${card.icp_reasons.slice(0, 4).join('; ')}.` : '',
    angle ? `OUR ANGLE (from GTM → Outreach, rank ${angle.rank ?? 1}${angle.type ? `, ${angle.type}` : ''}): ${angle.rationale || ''}` : '',
    bubbles.length ? `The approved opener we based this on: ${bubbles[0]}` : '',
  ].filter(Boolean).join('\n');

  const system = `You write the next WhatsApp message to a sales prospect, on behalf of the operator. You are given the conversation so far and what we believe about this person. Return ONLY the message text — no greeting label, no quotes, no commentary, no alternatives.

${rules}`;
  // Spelling out the one-sided case matters: given a transcript of our own
  // messages a model will cheerfully thank them for a reply that never came.
  const situation = theySpoke
    ? 'They have replied. Answer what they actually said.'
    : 'They have NOT replied to anything yet. This is a follow-up into silence — do not thank them for a reply, do not reference a response, and do not imply any contact back from them.';
  const prompt = `${context}\n\nCONVERSATION SO FAR (oldest first):\n${transcript || '(nothing sent yet)'}\n\n${situation}\n\nWrite the next message from US.`;

  let text;
  try {
    text = await api.gateway('llm', 'text', { system, prompt, model, max_tokens: 400, heavy: false });
  } catch (e) {
    // Never leave the composer empty-handed: fall back to the approved bubble.
    return {
      draft: bubbles[0] || null, source: bubbles.length ? 'angle' : 'none', lead_id: lead.id,
      reason: `Could not compose a reply (${String(e?.message || e)}).`,
    };
  }

  const draft = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!draft) return { draft: bubbles[0] || null, source: bubbles.length ? 'angle' : 'none', lead_id: lead.id, reason: 'The model returned nothing.' };

  await api.log('outreach_draft_suggested', { lead_id: lead.id, chat_id: chatId, source: 'llm', chars: draft.length });
  return {
    draft, source: 'llm', lead_id: lead.id,
    angle: angle ? { rank: angle.rank ?? null, type: angle.type || null, rationale: angle.rationale || null } : null,
    based_on_messages: real.length,
    at: Date.now(),
  };
}

// ── draftReply's two halves, as separate decisions ──────────────────────────
// draftReply above does the whole thing in one call for the composer route.
// The `draft-prospect-reply` workflow needs the same outcome as steps that can
// be read and re-run, and the split is exactly where the behaviour changes: one
// half hands back words a human already approved, the other spends a model
// call. Both read the conversation from the shared context rather than the DB,
// so what they judge is what the thread step actually loaded.

// The deterministic half: the next UNSENT approved bubble, or the default first
// touch. Fires only while the prospect has NOT spoken — with nothing to reply
// to, a model handed a one-sided transcript writes "thanks for getting back to
// me" to someone who never did. `needs_compose` hands the turn to composeReply.
export async function pickNextBubble(api, {
  lead_id = null, prospect = null, messages = [], answered = null, angles = [], force_llm = false,
} = {}) {
  const list = Array.isArray(angles) ? angles : [];
  const history = Array.isArray(messages) ? messages : [];
  const theySpoke = answered === null || answered === undefined
    ? history.some((m) => !m.from_me)
    : !!answered;
  const leadId = lead_id || prospect?.lead_id || null;

  if (theySpoke || force_llm) return { needs_compose: true, draft: null, source: null, lead_id: leadId };

  const bubbles = angleBubbles(topAngle({ angles: list }));
  const sentCount = history.filter((m) => m.from_me).length;

  if (!bubbles.length) {
    const template = await loadFirstTouchTemplate(api);
    return {
      needs_compose: false, lead_id: leadId,
      draft: renderFirstTouch(template, prospect || {}), source: 'template',
      first_touch: true, step: 0,
      reason: 'No saved angle — this is the default first touch (outreach-first-touch doc).',
    };
  }
  const next = bubbles[sentCount];
  if (!next) {
    return {
      needs_compose: false, lead_id: leadId, draft: null, source: 'none',
      reason: `The approved sequence is finished — all ${bubbles.length} messages have been sent and they have not answered.`,
    };
  }
  await api.log('outreach_draft_suggested', { lead_id: leadId, source: 'angle', step: sentCount });
  return {
    needs_compose: false, lead_id: leadId, draft: next, source: 'angle',
    step: sentCount, first_touch: sentCount === 0,
    // The rest of the approved sequence, so the operator can send it as-is.
    alternatives: bubbles.slice(sentCount + 1),
  };
}

// The reasoning half: ONE model call grounded in the angle and the thread.
// A no-op passthrough when the previous step already produced a draft — the
// workflow stays a straight line and the approved words are never overwritten.
export async function composeReply(api, {
  prospect = null, messages = [], angles = [], rules = null, limits = null,
  answered = null, draft = null, source = null, needs_compose = false, force_llm = false,
} = {}) {
  if (!needs_compose && !force_llm) return { draft, source: source || (draft ? 'angle' : 'none'), composed: false };

  const cfg = {
    rules: typeof rules === 'string' && rules.trim() ? rules : (await loadDraftingRules(api)).rules,
    limits: limits && typeof limits === 'object' ? { ...DRAFT_LIMITS, ...limits } : (await loadDraftingRules(api)).limits,
  };
  const card = prospect || {};
  const history = Array.isArray(messages) ? messages : [];
  const theySpoke = answered === null || answered === undefined
    ? history.some((m) => !m.from_me)
    : !!answered;
  const angle = topAngle({ angles: Array.isArray(angles) ? angles : [] });
  const bubbles = angleBubbles(angle);
  const model = await writerModel(api);

  // The history is oldest-first, so the most recent context is the TAIL. Taking
  // the head would hide the very message this is supposed to answer.
  const transcript = history
    .slice(-cfg.limits.draft_context_messages)
    .map((m) => `${m.from_me ? 'US' : 'THEM'}: ${String(m.body || '').replace(/\s+/g, ' ').slice(0, cfg.limits.draft_context_chars)}`)
    .join('\n');

  const context = [
    `PROSPECT: ${card.name || 'unknown'}${card.position ? `, ${card.position}` : ''}${card.company ? ` at ${card.company}` : ''}.`,
    card.icp_fit ? `ICP fit: ${card.icp_fit}.` : '',
    (card.icp_reasons || []).length ? `Why they fit: ${(card.icp_reasons || []).slice(0, 4).join('; ')}.` : '',
    angle ? `OUR ANGLE (from GTM → Outreach, rank ${angle.rank ?? 1}${angle.type ? `, ${angle.type}` : ''}): ${angle.rationale || ''}` : '',
    bubbles.length ? `The approved opener we based this on: ${bubbles[0]}` : '',
  ].filter(Boolean).join('\n');

  const system = `You write the next WhatsApp message to a sales prospect, on behalf of the operator. You are given the conversation so far and what we believe about this person. Return ONLY the message text — no greeting label, no quotes, no commentary, no alternatives.

${cfg.rules}`;
  // Spelling out the one-sided case matters: given a transcript of our own
  // messages a model will cheerfully thank them for a reply that never came.
  const situation = theySpoke
    ? 'They have replied. Answer what they actually said.'
    : 'They have NOT replied to anything yet. This is a follow-up into silence — do not thank them for a reply, do not reference a response, and do not imply any contact back from them.';
  const prompt = `${context}\n\nCONVERSATION SO FAR (oldest first):\n${transcript || '(nothing sent yet)'}\n\n${situation}\n\nWrite the next message from US.`;

  let text;
  try {
    text = await api.gateway('llm', 'text', { system, prompt, model, max_tokens: 400, heavy: false });
  } catch (e) {
    // Never leave the composer empty-handed: fall back to the approved bubble.
    return {
      draft: bubbles[0] || null, source: bubbles.length ? 'angle' : 'none', composed: false,
      reason: `Could not compose a reply (${String(e?.message || e)}).`,
    };
  }
  const composed = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!composed) {
    return { draft: bubbles[0] || null, source: bubbles.length ? 'angle' : 'none', composed: false, reason: 'The model returned nothing.' };
  }

  await api.log('outreach_draft_suggested', { lead_id: card.lead_id || null, source: 'llm', chars: composed.length });
  return {
    draft: composed, source: 'llm', composed: true, lead_id: card.lead_id || null,
    angle: angle ? { rank: angle.rank ?? null, type: angle.type || null, rationale: angle.rationale || null } : null,
    based_on_messages: history.length,
    at: Date.now(),
  };
}
