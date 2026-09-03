// GTM plugin · outreach angles and contact status.
//
// ANGLES — per green prospect, one model call assembles the operator profile
// (plugin-gtm-you) + the outreach control doc (plugin-gtm-outreach) + the brand
// positioning + the stored company facts into ranked angles with draft message
// bubbles (strict JSON, invented-person guard, dash scrub). Drafts persist in
// plugin_gtm_outreach_angles, one payload per lead, replaced on regenerate.
//
// CONTACT STATUS — who has been messaged and who answered, derived from this
// pack's own send log plus the host's WhatsApp message store. Nothing here
// sends; sending lives in gtm-schedule.mjs and send_prospect_message.
//
// Contract v2.1 lib file: imports NOTHING; every exported function takes `api`
// first. Helpers the host libs used to provide (getLead, gtmLLM, extractJson,
// gtmDoc, readYou) are duplicated below — lib files may not import each other.

const now = () => Date.now();

// ── duplicated helpers (contract: no lib-to-lib imports) ─────────────────────

async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
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
export async function draftAnglesForLead(api, { lead } = {}) {
  if (!lead) return { angles_payload: null, error: 'no lead' };
  const you = await readYou(api);
  // Single sources of truth — read live, never copied into other docs:
  //   plugin-gtm-outreach → the outreach control surface (strategy + Hebrew
  //                       rules + exemplars + self-check + pacing). GTM-specific.
  //   brand-positioning   → the brand frame + the RETIRED marketing frame to
  //                       avoid. HOST doc (declared in requires.knowledge);
  //                       shared with blog/social/aeo.
  const outreachDoc = await gtmDoc(api, 'plugin-gtm-outreach', '(outreach doc missing)');
  const positioning = await gtmDoc(api, 'brand-positioning', '');
  let companyCtx = null;
  try { companyCtx = JSON.parse(lead.company_context || 'null'); } catch { companyCtx = null; }
  const companyLine = companyCtx && !companyCtx.error
    ? [companyCtx.summary, companyCtx.industry, companyCtx.staff_count ? `${companyCtx.staff_count} employees` : null].filter(Boolean).join(' · ')
    : '(company not checked yet)';
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
Name NOBODY except the prospect and the operator's own mutuals listed above. Never invent a colleague, a title or a shared contact.

Return STRICT JSON only:
{"playbook_fit":{"language":"Hebrew|English","channel":"WhatsApp|LinkedIn","fits_hebrew_playbook":true,"why":"..."},
"connection_points":[{"type":"geo|mutual|peer|company|group","detail":"...","strength":"low|soft|medium|high"}],
"angles":[{"rank":1,"target":"Name - Role","type":"warm_mutual|trigger|org_referral|position_alignment","rationale":"...","messages":["bubble 1","bubble 2"],"confidence":"low|medium|high","missing":"..."}]}`;

  const prompt = `PROSPECT: ${lead.name} - ${lead.position || '?'} at ${lead.company || '?'} (${[lead.region, lead.country].filter(Boolean).join(', ') || 'location unknown'})
Israeli founder signal: ${israeli ? 'YES, write Hebrew' : 'no clear signal'}
COMPANY: ${companyLine}

Produce the JSON.`;

  try {
    // Outreach copy is the highest-stakes text we generate (native Hebrew, no
    // tells), so it runs on the strongest model regardless of the global default.
    // heavy:true — if the main model is out of credit this PAUSES (LlmDownError)
    // rather than drafting Hebrew outreach on a 3B.
    const out = extractJson(await gtmLLM(api, { system, prompt, model: 'claude-opus-4-8', maxTokens: 6000, heavy: true }));
    // Guard against invented targets: an angle aimed at anyone other than the
    // prospect names a person we have no record of, so its confidence is forced
    // low and the doubt is written into the angle where the operator sees it.
    const known = [String(lead.name || '').toLowerCase(), ...(you.connections || []).map((c) => String(c).toLowerCase())].filter(Boolean);
    const realTarget = (t) => { const nm = String(t || '').split(' - ')[0].trim().toLowerCase(); return !nm || known.some((o) => o.includes(nm) || nm.includes(o)); };
    // Scrub the recurring model slip: em/en dashes (should be commas or a split).
    const clean = (m) => String(m || '').replace(/\s*[—–]+\s*/g, ', ').replace(/([֐-׿])\s*-\s*(?=[A-Za-z])/g, '$1 ').replace(/,\s*,/g, ',').trim();
    const angles = (out.angles || []).map((a) => {
      const x = { ...a, messages: (a.messages || []).map(clean) };
      return realTarget(a.target) ? x : { ...x, confidence: 'low', missing: 'this target is neither the prospect nor a mutual on file, the model may have invented them, confirm before sending' };
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

// Green leads with everything the Verified Contacts list renders: stored
// angles and contact status. One place, so Nyo and the module agree.
//
// greenLeads lives in gtm.mjs and lib files may not import each other, so the
// TOOL fetches the green leads and passes them in.
export async function greenLeadsWithStatus(api, leads = []) {
  const ids = leads.map((l) => l.id);
  const [angles, statuses] = await Promise.all([readAnglesMany(api, ids), contactStatuses(api, ids)]);
  return leads.map((l) => ({ ...l, angles: angles.get(l.id) ?? null, ...(statuses.get(l.id) || {}) }));
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

// ── who replied ─────────────────────────────────────────────────────────────

// Everyone who ANSWERED our outreach: a lead whose contact status derives to
// 'replied' (an inbound message landing after our first outbound touch). Read
// only — it moves nothing and marks nothing, so it is safe to run on a tick.
export async function collectReplies(api) {
  const ids = ((await api.db.prepare(
    'SELECT id FROM plugin_gtm_leads WHERE normalized_phone IS NOT NULL',
  ).all()).results || []).map((r) => r.id);
  const statuses = await contactStatuses(api, ids);
  const replies = [];
  for (const [leadId, st] of statuses) {
    if (st.contact_status !== 'replied') continue;
    const lead = await getLead(api, leadId);
    if (!lead) continue;
    replies.push({
      lead_id: leadId,
      name: lead.name || null,
      company: lead.company || null,
      title: lead.position || null,
      phone: lead.normalized_phone || lead.phone || null,
      linkedin: lead.linkedin || null,
      replied_at: st.replied_at || null,
      first_contacted_at: st.first_contacted_at || null,
      sends: st.sends || 0,
    });
  }
  replies.sort((a, b) => (b.replied_at || 0) - (a.replied_at || 0));
  return { ok: true, replies, count: replies.length };
}
