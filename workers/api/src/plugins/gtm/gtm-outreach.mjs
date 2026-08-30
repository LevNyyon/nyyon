// GTM plugin · Outreach — ported from workers/api/src/lib/gtm-outreach.js.
// Per green prospect: one Opus call assembles the operator profile
// (plugin-gtm-you) + the single outreach control doc (plugin-gtm-outreach) +
// the brand positioning + the verified org into ranked angles with draft
// message bubbles (strict JSON, invented-person guard, dash scrub). Drafts
// persist in plugin_gtm_outreach_angles (one payload per lead, replaced on
// regenerate; bubble edits saved whole-payload).
//
// SEND — the shared wa-gateway CAN send, so sendOutreach() delivers the
// bubbles through it with the pacing spec from docs/outreach-messaging.md §9:
// each bubble its own message, jittered 4–9s human gap scaled to the next
// bubble's length (cap 12s), stop the sequence on the first failure. Every
// bubble is logged to plugin_gtm_sends (delivery rides the host whatsapp
// gateway's send mode, which carries its own outbox audit).
//
// Contract v2.1 lib file: imports NOTHING; every exported function takes `api`
// first. Helpers the host libs used to provide (getLead, toChatId, gtmLLM,
// extractJson, gtmDoc, readYou, listOrgPeople) are duplicated below — lib
// files may not import each other.

const now = () => Date.now();
const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── duplicated helpers (contract: no lib-to-lib imports) ─────────────────────

async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

async function listOrgPeople(api, leadId) {
  const r = await api.db.prepare('SELECT * FROM plugin_gtm_org_people WHERE lead_id = ? ORDER BY created_at').bind(leadId).all();
  return r.results || [];
}

async function gtmDoc(api, slug, fallback = '') {
  const d = await api.knowledge(slug);
  return d?.body || fallback;
}

async function readYou(api) {
  try { return JSON.parse(await gtmDoc(api, 'plugin-gtm-you', '{}')); } catch { return {}; }
}

// The single LLM boundary, reached through the declared gateway. Signature
// kept from lib/gtm.js gtmLLM so GTM call sites stay untouched.
async function gtmLLM(api, { system, prompt, model = null, maxTokens = 4000, heavy = false } = {}) {
  return api.gateway('llm', 'text', { system, prompt, model, max_tokens: maxTokens, heavy });
}

function extractJson(txt) {
  const s = String(txt || '');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

// Normalize an input like "+972 50-000-0000", "972500000000", or already
// "972500000000@c.us" to a canonical wa-gateway chatId. Groups must come in
// already-formatted ("…@g.us"); `@lid` ids pass through unchanged.
function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('chatId required');
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`could not parse chatId from ${input}`);
  return `${digits}@c.us`;
}

// ── angles store ─────────────────────────────────────────────────────────────

export async function readAngles(api, leadId) {
  const r = await api.db.prepare('SELECT payload, updated_at FROM plugin_gtm_outreach_angles WHERE lead_id = ?').bind(leadId).first();
  if (!r) return null;
  try { return { ...JSON.parse(r.payload), angles_at: r.updated_at }; } catch { return null; }
}

// Batched variant for list views: one IN() query instead of one query per lead
// (the per-lead loop cost ~12s and most of a Worker's subrequest budget once
// the green list grew past a handful). Returns Map<lead_id, angles|null>.
export async function readAnglesMany(api, leadIds = []) {
  const out = new Map();
  for (let i = 0; i < leadIds.length; i += 80) {
    const chunk = leadIds.slice(i, i + 80);
    const r = await api.db.prepare(
      `SELECT lead_id, payload, updated_at FROM plugin_gtm_outreach_angles WHERE lead_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    for (const row of r.results || []) {
      try { out.set(row.lead_id, { ...JSON.parse(row.payload), angles_at: row.updated_at }); } catch { /* skip corrupt */ }
    }
  }
  return out;
}

export async function saveAngles(api, leadId, payload) {
  await api.db.prepare(`
    INSERT INTO plugin_gtm_outreach_angles (lead_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(leadId, JSON.stringify(payload), now(), now()).run();
  return { ok: true };
}

// Draft only — the model step, nothing persisted. Returns
// { angles_payload } on success, { angles_payload: null, blocked } when the
// company is unverified, { angles_payload: null, error } when drafting failed.
// Never saves: a blocked or failed draft must not overwrite angles the operator
// already has, so the save is a separate, explicit step.
export async function draftAnglesForLead(api, { lead, org_people = [] } = {}) {
  if (!lead) return { angles_payload: null, error: 'no lead' };
  // A warn'd / mismatched lead means theorg likely returned a namesake company.
  // Don't outreach on a wrong company, and don't hand the model an empty org.
  if (lead.org_status === 'warn' || lead.org_status === 'mismatch') {
    return { angles_payload: null, blocked: `Company unverified: theorg matched a possible namesake for "${lead.company}". Confirm the right company in the Enrich tab (paste the correct theorg slug) before generating outreach.` };
  }
  const people = org_people;
  const you = await readYou(api);
  // Single sources of truth — read live, never copied into other docs:
  //   plugin-gtm-outreach → the outreach control surface (strategy + Hebrew
  //                       rules + exemplars + self-check + pacing). GTM-specific.
  //   brand-positioning   → the brand frame + the RETIRED marketing frame to
  //                       avoid. HOST doc (declared in requires.knowledge);
  //                       shared with blog/social/aeo.
  const outreachDoc = await gtmDoc(api, 'plugin-gtm-outreach', '(outreach doc missing)');
  const positioning = await gtmDoc(api, 'brand-positioning', '');
  const org = people.map((p) => `${p.name} - ${p.role}`).join('\n') || '(none)';
  // Hebrew is the default for the Israeli-founder ICP; a lead is flagged
  // English per-lead via outreach_lang when a prospect is truly foreign.
  const israeli = String(lead.outreach_lang || '').toLowerCase() !== 'en';

  const system = `You write a first-touch outreach message for ${you.name || 'the operator'} (${you.role || ''}).
WHAT THEY DO (the positioning line, use it, never invent a category): ${you.business || '(not set)'}
Location: ${you.location || ''}. Mutuals on file: ${(you.connections || []).join(', ') || 'none'}.

== WHO NYYON IS / HOW TO POSITION (brand source of truth) ==
${positioning}

== OUTREACH GUIDE (strategy, rules, exemplars, self-check, pacing) ==
${outreachDoc}

ENFORCEMENT (not editable, do not break):
${israeli ? 'THIS PROSPECT IS ISRAELI: write Hebrew, no exceptions.' : 'Pick the language per the rules above.'}
Name only people listed in the ORG CHART below. If the org is empty or unverified, name nobody except the prospect.

Return STRICT JSON only:
{"playbook_fit":{"language":"Hebrew|English","channel":"WhatsApp|LinkedIn","fits_hebrew_playbook":true,"why":"..."},
"connection_points":[{"type":"geo|mutual|peer|company|group","detail":"...","strength":"low|soft|medium|high"}],
"angles":[{"rank":1,"target":"Name - Role","type":"warm_mutual|trigger|org_referral|position_alignment","rationale":"...","messages":["bubble 1","bubble 2"],"confidence":"low|medium|high","missing":"..."}]}`;

  const prompt = `PROSPECT: ${lead.name} - ${lead.position || '?'} at ${lead.company || '?'} (${[lead.region, lead.country].filter(Boolean).join(', ') || 'location unknown'})
Israeli founder signal: ${israeli ? 'YES, write Hebrew' : 'no clear signal'}
ORG CHART:
${org}

Produce the JSON.`;

  try {
    // Outreach copy is the highest-stakes text we generate (native Hebrew, no
    // tells), so it runs on the strongest model regardless of the global default.
    // heavy:true — if the main model is out of credit this PAUSES (LlmDownError)
    // rather than drafting Hebrew outreach on a 3B.
    const out = extractJson(await gtmLLM(api, { system, prompt, model: 'claude-opus-4-8', maxTokens: 6000, heavy: true }));
    // Guard against invented targets: any angle naming a person not in the
    // verified org gets confidence forced low + a warning note.
    const orgNames = [String(lead.name || '').toLowerCase(), ...people.map((p) => String(p.name || '').toLowerCase())].filter(Boolean);
    const realTarget = (t) => { const nm = String(t || '').split(' - ')[0].trim().toLowerCase(); return !nm || orgNames.some((o) => o.includes(nm) || nm.includes(o)); };
    // Scrub the recurring model slip: em/en dashes (should be commas or a split).
    const clean = (m) => String(m || '').replace(/\s*[—–]+\s*/g, ', ').replace(/([֐-׿])\s*-\s*(?=[A-Za-z])/g, '$1 ').replace(/,\s*,/g, ',').trim();
    const angles = (out.angles || []).map((a) => {
      const x = { ...a, messages: (a.messages || []).map(clean) };
      return realTarget(a.target) ? x : { ...x, confidence: 'low', missing: 'target not in the verified org, the model may have invented this person, confirm before sending' };
    });
    const payload = { playbook_fit: out.playbook_fit || null, connection_points: out.connection_points || [], angles };
    return { angles_payload: payload };
  } catch (e) {
    // Main model out of credit → a clean "paused" (blocked) result, not a raw error.
    if (e?.llmDown) {
      return { angles_payload: null, blocked: 'The main model (Anthropic) is out of credit — outreach drafting is paused until it\'s topped up. Chat + light jobs are still running on the local model.' };
    }
    return { angles_payload: null, error: String(e.message || e) };
  }
}

// The old fat entry point, kept working for the tools that still call it:
// draft + save + log in one. Retired once every caller runs draft-outreach-angles.
export async function generateAngles(api, leadId) {
  const lead = await getLead(api, leadId);
  if (!lead) return { error: 'no lead' };
  const people = await listOrgPeople(api, leadId);
  const r = await draftAnglesForLead(api, { lead, org_people: people });
  if (r.blocked) return { playbook_fit: null, connection_points: [], angles: [], blocked: r.blocked };
  if (!r.angles_payload) return { error: r.error || 'drafting failed' };
  await saveAngles(api, leadId, r.angles_payload);
  await api.log('angles_generated', { id: leadId, angles: r.angles_payload.angles.length });
  return r.angles_payload;
}

// Green leads with everything the Outreach list renders: warm-contact flags,
// stored angles, contact status. One place, so Nyo and the module agree.
//
// SIGNATURE CHANGE from the host original (which called greenLeads(env)
// itself): greenLeads lives in lib/gtm-context.mjs and lib files may not
// import each other, so the TOOL fetches the green leads and passes them in
// (contract v2.1: "the TOOL passes results"). Merge behavior is identical.
export async function greenLeadsWithStatus(api, leads = []) {
  const ids = leads.map((l) => l.id);
  const [angles, statuses] = await Promise.all([readAnglesMany(api, ids), contactStatuses(api, ids)]);
  return leads.map((l) => ({ ...l, angles: angles.get(l.id) ?? null, ...(statuses.get(l.id) || {}) }));
}

// ── paced send through the shared wa-gateway ─────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §9 pacing: human gap jittered (never fixed), scaled to the next bubble's
// length, capped. The plugin-gtm-outreach knowledge doc has always CLAIMED
// pacing is tunable there; it actually is — add a fenced ```json block
// containing {"pacing": {"gap_min_ms":4000, "gap_jitter_ms":5000,
// "cap_ms":12000}} to the doc and the next send uses it. Defaults preserve
// the shipped 4-9s/12s feel.
const PACING_DEFAULTS = { gap_min_ms: 4000, gap_jitter_ms: 5000, cap_ms: 12000 };
async function pacingConfig(api) {
  try {
    const doc = await api.knowledge('plugin-gtm-outreach');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const pacing = m ? JSON.parse(m[1])?.pacing : null;
    if (pacing && typeof pacing === 'object') return { ...PACING_DEFAULTS, ...pacing };
  } catch { /* malformed block — defaults win, a bad doc edit can't break sends */ }
  return PACING_DEFAULTS;
}
function bubbleGapMs(nextBubble, p = PACING_DEFAULTS) {
  const base = p.gap_min_ms + Math.random() * p.gap_jitter_ms;
  const scale = Math.min(1.5, 0.6 + String(nextBubble || '').length / 160);
  return Math.min(p.cap_ms, Math.round(base * scale));
}

export async function sendOutreach(api, { lead_id, bubbles, force = false, source = 'operator', source_ref = null } = {}) {
  const lead = await getLead(api, lead_id);
  if (!lead) return { error: 'no lead' };
  const msgs = (bubbles || []).map((b) => String(b || '').trim()).filter(Boolean);
  if (!msgs.length) return { error: 'no bubbles to send' };
  if (msgs.length > 4) return { error: 'more than 4 bubbles — the playbook caps a first touch at 4' };
  // Double-send guard: a paced send takes ~30-40s, longer than Nyo's per-tool
  // timeout — a timed-out-then-retried call must NOT message the prospect
  // twice. Refuse when this lead was already sent to in the last 10 minutes.
  if (!force) {
    const recent = await api.db.prepare("SELECT COUNT(*) AS n FROM plugin_gtm_sends WHERE lead_id = ? AND status = 'sent' AND created_at > ?")
      .bind(lead_id, now() - 10 * 60 * 1000).first();
    if ((recent?.n ?? 0) > 0) {
      return { error: 'bubbles were already sent to this lead in the last 10 minutes — the earlier send very likely went through (check plugin_gtm_sends / the Outbox). Pass force:true only if the operator confirms a re-send.' };
    }
  }
  const chatId = toChatId(lead.normalized_phone || lead.phone);
  // ensureListening lived on the host wa lib; the gateway's set_listening mode
  // is the plugin-safe equivalent. Best-effort, exactly like the original.
  await api.gateway('whatsapp', 'set_listening', { chat_id: chatId, listening: true }).catch(() => {});
  const pacing = await pacingConfig(api);
  const sent = [];
  for (let i = 0; i < msgs.length; i++) {
    try {
      // The gateway send throws on failure (it never returns a soft error) —
      // the catch below is the single failure path. source/source_ref ride in
      // the input for the gateway's outbox audit.
      await api.gateway('whatsapp', 'send', { chatId, text: msgs[i], source, source_ref });
      await api.db.prepare('INSERT INTO plugin_gtm_sends (id, lead_id, chat_id, bubble, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(gid('gs'), lead_id, chatId, msgs[i], 'sent', null, now()).run();
      sent.push(i);
    } catch (e) {
      await api.db.prepare('INSERT INTO plugin_gtm_sends (id, lead_id, chat_id, bubble, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(gid('gs'), lead_id, chatId, msgs[i], 'failed', String(e.message || e).slice(0, 300), now()).run();
      return { sent, failed_at: i, error: String(e.message || e) };
    }
    if (i < msgs.length - 1) await sleep(bubbleGapMs(msgs[i + 1], pacing));
  }
  await api.log('outreach_sent', { id: lead_id, bubbles: msgs.length, chat_id: chatId });
  return { ok: true, sent: msgs.length, chat_id: chatId };
}

export async function listSends(api, leadId) {
  const r = await api.db.prepare('SELECT * FROM plugin_gtm_sends WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50').bind(leadId).all();
  return r.results || [];
}

// The lead's CONVERSATION, honestly sourced from what actually happened:
// engine sends (plugin_gtm_sends: sent / failed) merged with the WhatsApp
// store for that chat (wa_messages, host read: outbound echoes = WhatsApp
// accepted the message → status 'confirmed'; inbound rows = the lead's
// replies). An engine send that also appears in the store is deduped up to
// 'confirmed' (matched by text within a 3-minute window). Read-only; the UI
// polls this after sending.
export async function leadThread(api, leadId, { refresh = false } = {}) {
  const lead = await getLead(api, leadId);
  if (!lead) return { error: 'no lead' };
  // toChatId THROWS on a missing/unparseable phone — a phoneless lead must
  // still get its engine-send history, just with no WhatsApp store to merge.
  let chatId = null;
  try { chatId = toChatId(lead.normalized_phone || lead.phone); } catch { /* no chat */ }
  const sends = await listSends(api, leadId);
  // The lead may live in a privacy (@lid) chat — include those ids too, the
  // same wa_lid_map resolution contactStatuses uses.
  const chatIds = chatId ? [chatId] : [];
  if (chatId) {
    const lids = await api.db.prepare('SELECT lid FROM wa_lid_map WHERE pn = ?').bind(chatId).all();
    for (const row of lids.results || []) if (row.lid) chatIds.push(row.lid);
  }
  // refresh=true pulls the chat's LIVE history from WhatsApp itself (via the
  // gateway's raw Store read) into the store first — this is what makes the
  // conversation FULL, not just what the webhook happened to catch.
  if (refresh && chatIds.length) {
    for (const cid of chatIds) {
      try { await api.gateway('whatsapp', 'backfill_messages', { chatId: cid, allAutoListen: false, limit: 100 }); }
      catch { /* gateway briefly down — show what the store has */ }
    }
  }
  const wa = chatIds.length
    ? (await api.db.prepare(
        `SELECT from_me, sender_name, body, timestamp, raw_json, created_at FROM wa_messages
         WHERE chat_id IN (${chatIds.map(() => '?').join(',')}) AND body IS NOT NULL AND length(trim(body)) > 0
         ORDER BY COALESCE(timestamp, created_at) DESC LIMIT 100`,
      ).bind(...chatIds).all()).results || []
    : [];
  const waMsOf = (m) => waMs(m.timestamp) ?? m.created_at;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // The worker PRE-INSERTS its own outbound rows (raw_json source
  // nyyon-outbound) at send time; those are our own record, NOT a WhatsApp
  // echo. Only webhook-persisted rows may confirm a send as ✓✓ — otherwise
  // every gateway-accepted send would instantly claim "confirmed".
  const isPreInsert = (m) => String(m.raw_json || '').includes('outbound');
  const messages = [];
  const claimed = new Set();
  for (const s of [...sends].reverse()) {
    // engine send → find its true WhatsApp echo (same text, ±3 min, webhook-sourced)
    const echoIdx = wa.findIndex((m, i) => !claimed.has(i) && m.from_me && !isPreInsert(m)
      && norm(m.body) === norm(s.bubble) && Math.abs(waMsOf(m) - s.created_at) < 3 * 60 * 1000);
    // also claim the pre-inserted twin so it doesn't render as a duplicate bubble
    const preIdx = wa.findIndex((m, i) => !claimed.has(i) && m.from_me && isPreInsert(m)
      && norm(m.body) === norm(s.bubble) && Math.abs(waMsOf(m) - s.created_at) < 3 * 60 * 1000);
    if (preIdx >= 0) claimed.add(preIdx);
    if (echoIdx >= 0) claimed.add(echoIdx);
    messages.push({
      dir: 'out',
      text: s.bubble,
      at: s.created_at,
      status: s.status === 'failed' ? 'failed' : echoIdx >= 0 ? 'confirmed' : 'sent',
      error: s.status === 'failed' ? s.error : null,
      source: 'engine',
    });
  }
  wa.forEach((m, i) => {
    if (claimed.has(i)) return;
    messages.push({
      dir: m.from_me ? 'out' : 'in',
      text: m.body,
      at: waMsOf(m),
      // a pre-inserted row is our own send record (✓); only webhook rows
      // prove WhatsApp processed the message (✓✓)
      status: m.from_me ? (isPreInsert(m) ? 'sent' : 'confirmed') : 'received',
      error: null,
      source: m.from_me ? 'manual' : 'reply',
    });
  });
  messages.sort((a, b) => a.at - b.at);
  return { lead_id: leadId, chat_id: chatId, messages: messages.slice(-60) };
}

// wa timestamps are ms in this store, but old rows may be seconds — normalize
const waMs = (t) => (t == null ? null : (t < 1e12 ? t * 1000 : t));
// phone → canonical +digits form (strips spaces, dashes, RTL marks, parens)
const canonPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? `+${d}` : null;
};
const cusOf = (phone) => { const c = canonPhone(phone); return c ? `${c.slice(1)}@c.us` : null; };

// ── contact status: the "who did I contact / who replied" layer ─────────────
// Derived per lead from what ACTUALLY happened across BOTH channels, no new
// state to maintain:
//   contacted  — either the engine sent (plugin_gtm_sends), OR you messaged
//                the lead by hand in WhatsApp (wa_messages from_me=1 on the
//                lead's chat)
//   replied    — an INBOUND wa message (from_me=0) on that lead's chat AFTER
//                our first outbound touch
// Leads reach a WhatsApp chat two ways: a plain "<digits>@c.us" DM, or a
// "<lid>@lid" identity chat — resolved to the lead's phone through wa_lid_map
// (host read). Everything is batched (IN() chunks); no per-lead query, no
// correlated subquery (a correlated join here blows D1's per-query CPU budget).
export async function contactStatuses(api, leadIds = []) {
  const out = new Map();
  if (!leadIds.length) return out;
  for (const id of leadIds) out.set(id, { contact_status: 'not_contacted', first_contacted_at: null, last_contacted_at: null, sends: 0, replied_at: null });

  // 1. engine sends (plugin_gtm_sends) — first/last/count per lead
  const eng = new Map(); // lead_id → {first, last, n}
  for (let i = 0; i < leadIds.length; i += 80) {
    const chunk = leadIds.slice(i, i + 80);
    const r = await api.db.prepare(
      `SELECT lead_id, min(created_at) AS first_at, max(created_at) AS last_at, count(*) AS n
       FROM plugin_gtm_sends WHERE status='sent' AND lead_id IN (${chunk.map(() => '?').join(',')}) GROUP BY lead_id`,
    ).bind(...chunk).all();
    for (const row of r.results || []) eng.set(row.lead_id, { first: row.first_at, last: row.last_at, n: row.n });
  }

  // 2. lead phones → candidate chat_ids (c.us + any mapped lids)
  const leadPhone = new Map(); // lead_id → canonical phone
  const cusToLead = new Map(); // "<digits>@c.us" → lead_id
  for (let i = 0; i < leadIds.length; i += 80) {
    const chunk = leadIds.slice(i, i + 80);
    const r = await api.db.prepare(
      `SELECT id, normalized_phone FROM plugin_gtm_leads WHERE id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    for (const row of r.results || []) {
      const cus = cusOf(row.normalized_phone);
      if (!cus) continue;
      leadPhone.set(row.id, canonPhone(row.normalized_phone));
      cusToLead.set(cus, row.id);
    }
  }
  const cusList = [...cusToLead.keys()];
  const chatToLead = new Map(cusToLead); // chat_id (c.us or lid) → lead_id
  // resolve lids for these phones via wa_lid_map (pn is "<digits>@c.us")
  for (let i = 0; i < cusList.length; i += 80) {
    const chunk = cusList.slice(i, i + 80);
    const r = await api.db.prepare(
      `SELECT lid, pn FROM wa_lid_map WHERE pn IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    for (const row of r.results || []) {
      const lead = cusToLead.get(row.pn);
      if (lead && row.lid) chatToLead.set(row.lid, lead);
    }
  }

  // 3. one pass over wa_messages for all candidate chats — outbound + inbound
  const chatIds = [...chatToLead.keys()];
  const waByLead = new Map(); // lead_id → {out_first, out_last, out_n, in_first}
  for (let i = 0; i < chatIds.length; i += 80) {
    const chunk = chatIds.slice(i, i + 80);
    const r = await api.db.prepare(
      // Keep every outbound, but count an INBOUND only if it has real text — empty
      // from_me=0 rows (delivery/read receipts, echoes, often at the same
      // timestamp as our outbound) must never register as a reply.
      `SELECT chat_id, from_me, min(timestamp) AS first_ts, max(timestamp) AS last_ts, count(*) AS n
       FROM wa_messages
       WHERE chat_id IN (${chunk.map(() => '?').join(',')})
         AND (from_me = 1 OR (body IS NOT NULL AND length(trim(body)) > 0))
       GROUP BY chat_id, from_me`,
    ).bind(...chunk).all();
    for (const row of r.results || []) {
      const lead = chatToLead.get(row.chat_id);
      if (!lead) continue;
      const agg = waByLead.get(lead) || { out_first: null, out_last: null, out_n: 0, in_last: null };
      if (row.from_me === 1 || row.from_me === true) {
        agg.out_n += row.n;
        const f = waMs(row.first_ts); const l = waMs(row.last_ts);
        if (f != null && (agg.out_first == null || f < agg.out_first)) agg.out_first = f;
        if (l != null && (agg.out_last == null || l > agg.out_last)) agg.out_last = l;
      } else {
        // track LATEST inbound — a reply is any inbound after our first touch,
        // even on a chat that had prior history before outreach began
        const l = waMs(row.last_ts);
        if (l != null && (agg.in_last == null || l > agg.in_last)) agg.in_last = l;
      }
      waByLead.set(lead, agg);
    }
  }

  // 4. merge both channels per lead
  for (const id of leadIds) {
    const e = eng.get(id);
    const w = waByLead.get(id);
    const engFirst = e ? e.first : null;
    const engLast = e ? e.last : null;
    const waOutFirst = w && w.out_n ? w.out_first : null;
    const waOutLast = w && w.out_n ? w.out_last : null;
    const firsts = [engFirst, waOutFirst].filter((x) => x != null);
    const lasts = [engLast, waOutLast].filter((x) => x != null);
    if (!firsts.length) continue; // truly not contacted
    const firstAt = Math.min(...firsts);
    const lastAt = Math.max(...lasts);
    const sends = (e?.n || 0) + (w?.out_n || 0);
    // replied: any inbound landing after our first outbound touch
    let repliedAt = null;
    if (w && w.in_last != null && w.in_last > firstAt) repliedAt = w.in_last;
    out.set(id, {
      contact_status: repliedAt ? 'replied' : 'contacted',
      first_contacted_at: firstAt,
      last_contacted_at: lastAt,
      sends,
      replied_at: repliedAt,
    });
  }
  return out;
}
