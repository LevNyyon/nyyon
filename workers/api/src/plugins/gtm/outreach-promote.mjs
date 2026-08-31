// GTM plugin lib — outreach replies → pipeline. Ported from
// workers/api/src/lib/outreach-promote.js: the shared logic behind the two
// tools the replies-to-pipeline workflow orders.
//
// A reply is the strongest buying signal we get, so anyone who answered our
// LinkedIn outreach (plugin_gtm_li_prospects.replied_at) or our GTM WhatsApp
// outreach (an inbound message after our first send) should land in the sales
// pipeline — created if new, advanced if they're already there. The matching +
// create/update rules are the reasoning, so they live HERE (a tool may reason);
// the workflow itself just runs collect → promote in order, holding no logic.
//
// The rules (which stage a reply lands at, whether to ever move a further-along
// deal backward, the stage order) live in the editable
// `plugin-gtm-outreach-promotion` knowledge doc, seeded with a default on
// first read.
//
// Plugin boundary: clients/contacts are HOST tables — read-only here (declared
// host_reads, pure SELECTs). Every write goes through the host `crm` gateway:
//   promote      — turn a GTM lead into a client + mirrored contact
//   write_contact — upsert a contact
//   update_deal  — move a deal on the board
// Note: the SQL replace() the host used for phone matching reads as a write
// verb to the plugin SQL scanner, so digit matching happens in JS over pure
// SELECT rows instead.
//
// Lib contract: no imports; every exported function takes `api` first. The
// helpers the host version imported from gtm.js / gtm-outreach.js (getLead,
// contactStatuses) are duplicated here, per the lib rules.

const PROMO_SLUG = 'plugin-gtm-outreach-promotion';

export const PROMOTION_DEFAULTS = {
  replied_stage: 'lead',       // where a reply lands a person on the board
  advance_only: true,          // never move a further-along deal backward
  // board order low → high; a reply advances toward `replied_stage` but never
  // past where the deal already is. 'target' is the raw-promotion stage.
  stage_rank: ['target', 'lead', 'talking', 'discovery', 'offer-sent', 'reviewing', 'won'],
  tag: 'replied',              // tag stamped on the client + contact
};

function promoSeedBody(cfg) {
  return `Outreach replies → pipeline — how an answered outreach becomes a deal.

When someone replies to our LinkedIn outreach or our GTM WhatsApp outreach, the
replies-to-pipeline workflow pulls them in and puts them on the sales
board. A brand-new person is created as a \`prospect\` client at \`replied_stage\`;
someone already on the board is advanced to \`replied_stage\` — but only forward:
with \`advance_only\`, a deal already at (say) \`offer-sent\` is left where it is, we
never drag it back to \`lead\` just because a message came in.

\`stage_rank\` is the board order used to decide "forward". \`tag\` is stamped on the
client and contact so replied-driven entries are filterable. Matching to an
existing record is by: the GTM lead's linked client, then a contact with the same
phone or LinkedIn URL, then a client whose name matches — so re-running never
duplicates anyone.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;
}

function sanitizePromotion(src) {
  const out = { ...PROMOTION_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  if (typeof src.replied_stage === 'string' && src.replied_stage.trim()) out.replied_stage = src.replied_stage.trim();
  if (typeof src.advance_only === 'boolean') out.advance_only = src.advance_only;
  if (Array.isArray(src.stage_rank) && src.stage_rank.every((s) => typeof s === 'string') && src.stage_rank.length) out.stage_rank = src.stage_rank;
  if (typeof src.tag === 'string') out.tag = src.tag.trim();
  return out;
}

export async function loadPromotion(api) {
  try {
    const doc = await api.knowledge(PROMO_SLUG);
    if (!doc) {
      await api.saveKnowledge(PROMO_SLUG, {
        title: 'Outreach · replies → pipeline rules',
        body: promoSeedBody(PROMOTION_DEFAULTS),
      }).catch(() => {});
      return { ...PROMOTION_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizePromotion(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...PROMOTION_DEFAULTS, source: 'defaults' };
  }
}

export async function savePromotion(api, patch = {}) {
  const cur = await loadPromotion(api);
  const next = sanitizePromotion({ ...cur, ...patch });
  await api.saveKnowledge(PROMO_SLUG, {
    title: 'Outreach · replies → pipeline rules',
    body: promoSeedBody(next),
  });
  await api.log('outreach_promotion_updated', next);
  return { ...next, source: 'doc' };
}

// ── duplicated helpers (host imports the lib contract forbids) ──────────────

// wa timestamps are ms in this store, but old rows may be seconds — normalize
const waMs = (t) => (t == null ? null : (t < 1e12 ? t * 1000 : t));
// phone → canonical +digits form (strips spaces, dashes, RTL marks, parens)
const canonPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? `+${d}` : null; };
const cusOf = (phone) => { const c = canonPhone(phone); return c ? `${c.slice(1)}@c.us` : null; };
// what the host's SQL replace(...) chain did to a stored phone before the
// endsWith LIKE — spaces, dashes and parens removed, nothing else
const cleanStoredPhone = (p) => String(p || '').replace(/[ \-()]/g, '');

async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

// ── contact status: the "who did I contact / who replied" layer ─────────────
// Duplicated from the host gtm-outreach contactStatuses (lib files may not
// import each other). Derived per lead from what ACTUALLY happened across BOTH
// channels, no new state to maintain:
//   contacted  — either the engine sent (plugin_gtm_sends), OR you messaged the
//                lead by hand in WhatsApp (wa_messages from_me=1 on the chat)
//   replied    — an INBOUND wa message (from_me=0) on that lead's chat AFTER
//                our first outbound touch
// Leads reach a WhatsApp chat two ways: a plain "<digits>@c.us" DM, or a
// "<lid>@lid" identity chat — resolved to the lead's phone through wa_lid_map.
// Everything is batched (IN() chunks); no per-lead query, no correlated
// subquery (a correlated join here blows D1's per-query CPU budget).
async function contactStatuses(api, leadIds = []) {
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
  const cusToLead = new Map(); // "<digits>@c.us" → lead_id
  for (let i = 0; i < leadIds.length; i += 80) {
    const chunk = leadIds.slice(i, i + 80);
    const r = await api.db.prepare(
      `SELECT id, normalized_phone FROM plugin_gtm_leads WHERE id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    for (const row of r.results || []) {
      const cus = cusOf(row.normalized_phone);
      if (cus) cusToLead.set(cus, row.id);
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
  const waByLead = new Map(); // lead_id → {out_first, out_last, out_n, in_last}
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

// ── STEP 1 tool body: collect everyone who replied, normalized ──────────────
export async function collectReplies(api) {
  const replies = [];

  // LinkedIn — replied_at is set when the operator marks a reply (li read APIs
  // are dead, so replies are operator-marked via li_outreach_mark_reply).
  try {
    const li = (await api.db.prepare(
      `SELECT id, name, company, role, public_id, replied_at FROM plugin_gtm_li_prospects WHERE replied_at IS NOT NULL`,
    ).all()).results || [];
    for (const p of li) {
      replies.push({
        source: 'li_outreach', ref_id: p.id, name: p.name, company: p.company || null,
        title: p.role || null, phone: null,
        linkedin: p.public_id ? `https://www.linkedin.com/in/${p.public_id}` : null,
        replied_at: p.replied_at || null, lead_id: null,
      });
    }
  } catch { /* plugin_gtm_li_prospects may be absent */ }

  // GTM WhatsApp — a lead whose contact status derives to 'replied' (inbound
  // after our first outbound). Reuse the same detector the Outreach tab uses.
  try {
    const ids = ((await api.db.prepare(
      `SELECT id FROM plugin_gtm_leads WHERE normalized_phone IS NOT NULL`,
    ).all()).results || []).map((r) => r.id);
    const statuses = await contactStatuses(api, ids);
    for (const [leadId, st] of statuses) {
      if (st.contact_status !== 'replied') continue;
      const lead = await getLead(api, leadId);
      if (!lead) continue;
      replies.push({
        source: 'gtm_whatsapp', ref_id: leadId, name: lead.name || null, company: lead.company || null,
        title: lead.position || null, phone: lead.normalized_phone || lead.phone || null,
        linkedin: lead.linkedin || null, replied_at: st.replied_at || null,
        lead_id: leadId, client_id: lead.client_id || null,
      });
    }
  } catch { /* gtm tables may be absent */ }

  return { ok: true, replies, counts: { total: replies.length, li_outreach: replies.filter((r) => r.source === 'li_outreach').length, gtm_whatsapp: replies.filter((r) => r.source === 'gtm_whatsapp').length } };
}

// find an existing client for a reply: GTM link → contact phone/linkedin → name
// (clients/contacts are host reads — pure SELECTs, matching in JS)
async function findExistingClient(api, reply) {
  if (reply.client_id) {
    const c = await api.db.prepare('SELECT id, name, stage, status FROM clients WHERE id = ?').bind(reply.client_id).first();
    if (c) return c;
  }
  const phone = canonPhone(reply.phone);
  if (phone) {
    const rows = (await api.db.prepare(
      `SELECT ct.phone AS ct_phone, cl.id, cl.name, cl.stage, cl.status
       FROM contacts ct JOIN clients cl ON cl.id = ct.client_id
       WHERE ct.client_id IS NOT NULL AND ct.phone IS NOT NULL`,
    ).all().catch(() => ({ results: [] }))).results || [];
    const hit = rows.find((r) => cleanStoredPhone(r.ct_phone).endsWith(phone.slice(1)));
    if (hit) return { id: hit.id, name: hit.name, stage: hit.stage, status: hit.status };
  }
  if (reply.linkedin) {
    const slug = String(reply.linkedin).replace(/\/+$/, '').split('/').pop();
    if (slug) {
      const row = await api.db.prepare(
        `SELECT cl.id, cl.name, cl.stage, cl.status FROM contacts ct JOIN clients cl ON cl.id = ct.client_id
         WHERE ct.client_id IS NOT NULL AND ct.linkedin_url LIKE ? LIMIT 1`,
      ).bind(`%${slug}%`).first().catch(() => null);
      if (row) return row;
    }
  }
  if (reply.name) {
    const like = reply.company ? `${reply.name} (${reply.company})` : reply.name;
    const row = await api.db.prepare('SELECT id, name, stage, status FROM clients WHERE name = ? LIMIT 1').bind(like).first().catch(() => null);
    if (row) return row;
  }
  return null;
}

// Find THIS person's existing contact under a client (phone → linkedin → name),
// so a re-run updates it instead of inserting a duplicate. The promote workflow
// runs hourly; without this, an already-promoted lead grew one new contact row
// every hour.
async function findClientContact(api, clientId, reply) {
  const phone = canonPhone(reply.phone);
  if (phone) {
    const rows = (await api.db.prepare(
      'SELECT id, phone FROM contacts WHERE client_id = ? AND phone IS NOT NULL',
    ).bind(clientId).all().catch(() => ({ results: [] }))).results || [];
    const hit = rows.find((r) => cleanStoredPhone(r.phone).endsWith(phone.slice(1)));
    if (hit) return hit.id;
  }
  if (reply.linkedin) {
    const slug = String(reply.linkedin).replace(/\/+$/, '').split('/').pop();
    if (slug) {
      const r = await api.db.prepare('SELECT id FROM contacts WHERE client_id = ? AND linkedin_url LIKE ? LIMIT 1').bind(clientId, `%${slug}%`).first().catch(() => null);
      if (r) return r.id;
    }
  }
  if (reply.name) {
    const r = await api.db.prepare('SELECT id FROM contacts WHERE client_id = ? AND full_name = ? LIMIT 1').bind(clientId, reply.name).first().catch(() => null);
    if (r) return r.id;
  }
  return null;
}

// Find the person's contact ANYWHERE (no client scoping) — used by the
// no-lead new-person path below so the hourly workflow updates one contact
// instead of inserting a duplicate every run.
async function findAnyContact(api, reply) {
  const phone = canonPhone(reply.phone);
  if (phone) {
    const rows = (await api.db.prepare(
      'SELECT id, phone FROM contacts WHERE phone IS NOT NULL',
    ).all().catch(() => ({ results: [] }))).results || [];
    const hit = rows.find((r) => cleanStoredPhone(r.phone).endsWith(phone.slice(1)));
    if (hit) return hit.id;
  }
  if (reply.linkedin) {
    const slug = String(reply.linkedin).replace(/\/+$/, '').split('/').pop();
    if (slug) {
      const r = await api.db.prepare('SELECT id FROM contacts WHERE linkedin_url LIKE ? LIMIT 1').bind(`%${slug}%`).first().catch(() => null);
      if (r) return r.id;
    }
  }
  if (reply.name) {
    const r = await api.db.prepare('SELECT id FROM contacts WHERE full_name = ? LIMIT 1').bind(reply.name).first().catch(() => null);
    if (r) return r.id;
  }
  return null;
}

// ── STEP 2 tool body: create/advance each reply on the board ────────────────
export async function promoteRepliesToPipeline(api, { replies } = {}) {
  const rules = await loadPromotion(api);
  const rank = (s) => { const i = rules.stage_rank.indexOf(s); return i < 0 ? -1 : i; };
  const targetRank = rank(rules.replied_stage);
  const list = Array.isArray(replies) ? replies : [];

  const out = { ok: true, total: list.length, created: 0, advanced: 0, unchanged: 0, skipped: 0, details: [] };
  for (const reply of list) {
    if (!reply || !reply.name) { out.skipped++; out.details.push({ ref_id: reply?.ref_id, skipped: 'no name' }); continue; }
    try {
      const existing = await findExistingClient(api, reply);

      if (existing) {
        // advance forward only (per advance_only); keep a further-along deal put.
        // A stage that isn't on the rank list (null, 'active', 'nurture', 'lost',
        // a real client already won) is UNKNOWN, not "earlier" — never drag those
        // to replied_stage. Only a known, genuinely-earlier stage advances.
        let moved = false;
        const curRank = rank(existing.stage);
        const knownEarlier = curRank >= 0 && curRank < targetRank;
        if (!rules.advance_only || knownEarlier) {
          if (existing.stage !== rules.replied_stage) {
            await api.gateway('crm', 'update_deal', { id: existing.id, patch: { stage: rules.replied_stage }, actor: 'outreach-promote' });
            moved = true;
          }
        }
        // make sure a contact carries the reply provenance — UPDATE the existing
        // contact (found by phone/linkedin/name) rather than inserting a new one
        // every hourly run.
        const contactId = await findClientContact(api, existing.id, reply);
        await api.gateway('crm', 'write_contact', {
          id: contactId || undefined,
          full_name: reply.name, phone: reply.phone || undefined, company: reply.company || undefined,
          title: reply.title || undefined, linkedin_url: reply.linkedin || undefined,
          status: 'lead', source: 'cold_outreach', client_id: existing.id, tags: [rules.tag, reply.source],
          updated_by: 'outreach-promote',
        }).catch(() => {});
        if (reply.lead_id) await api.db.prepare('UPDATE plugin_gtm_leads SET client_id=?, updated_at=? WHERE id=? AND client_id IS NULL').bind(existing.id, Date.now(), reply.lead_id).run().catch(() => {});
        if (moved) out.advanced++; else out.unchanged++;
        out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: existing.id, action: moved ? 'advanced' : 'unchanged', stage: rules.replied_stage });
        await api.log('outreach_promoted', { source: reply.source, name: reply.name, client_id: existing.id, action: moved ? 'advanced' : 'matched' });
        continue;
      }

      // NEW, with a GTM lead behind it — the crm gateway's promote mode creates
      // the client + mirrored contact + links the lead, same as the host did.
      if (reply.lead_id) {
        const r = await api.gateway('crm', 'promote', { id: reply.lead_id, actor: 'outreach-promote' });
        if (!r?.ok) { out.skipped++; out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, skipped: r?.error || 'promote failed' }); continue; }
        const clientId = r.client_id;
        await api.gateway('crm', 'update_deal', { id: clientId, patch: { stage: rules.replied_stage }, actor: 'outreach-promote' }).catch(() => {});
        out.created++;
        out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: clientId, action: 'created', stage: rules.replied_stage });
        await api.log('outreach_promoted', { source: reply.source, name: reply.name, client_id: clientId, action: 'created' });
        continue;
      }

      // NEW, no GTM lead behind it (a LinkedIn reply). The host created a
      // client directly here, but the crm gateway has no client-create mode —
      // so the best the plugin can do is upsert the person as a tagged contact
      // carrying the reply provenance (deduped by phone/linkedin/name so the
      // hourly workflow never duplicates). No deal opens on the board until
      // the crm gateway grows a write_client mode.
      const contactId = await findAnyContact(api, reply);
      await api.gateway('crm', 'write_contact', {
        id: contactId || undefined,
        full_name: reply.name, phone: reply.phone || undefined, company: reply.company || undefined,
        title: reply.title || undefined, linkedin_url: reply.linkedin || undefined,
        status: 'lead', source: 'cold_outreach', tags: [rules.tag, reply.source],
        notes: `Replied to ${reply.source === 'li_outreach' ? 'LinkedIn' : 'WhatsApp'} outreach.${reply.title ? ' ' + reply.title + (reply.company ? ' at ' + reply.company : '') + '.' : ''}${reply.linkedin ? ' LinkedIn: ' + reply.linkedin : ''}`,
        created_by: 'outreach-promote', updated_by: 'outreach-promote',
      });
      if (contactId) {
        out.unchanged++;
        out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: null, action: 'unchanged', stage: rules.replied_stage, note: 'contact refreshed — crm gateway has no client-create mode, no deal opened' });
      } else {
        out.created++;
        out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: null, action: 'created', stage: rules.replied_stage, note: 'contact only — crm gateway has no client-create mode, no deal opened' });
        await api.log('outreach_promoted', { source: reply.source, name: reply.name, client_id: null, action: 'created' });
      }
    } catch (e) {
      out.skipped++;
      out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, skipped: String(e?.message || e) });
    }
  }
  return out;
}
