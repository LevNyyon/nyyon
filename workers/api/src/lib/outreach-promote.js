// Outreach replies → pipeline (nyyon-lite: the shared logic behind two tools
// the `outreach-replies-to-pipeline` workflow orders).
//
// A reply is the strongest buying signal we get, so anyone who answered our
// LinkedIn outreach (li_prospects.replied_at) or our GTM WhatsApp outreach
// (an inbound message after our first send) should land in the sales pipeline —
// created if new, advanced if they're already there. The matching + create/
// update rules are the reasoning, so they live HERE (a tool may reason); the
// workflow itself just runs collect → promote in order, holding no logic.
//
// The rules (which stage a reply lands at, whether to ever move a further-along
// deal backward, the stage order) live in the editable `outreach-promotion`
// knowledge doc, seeded with a default on first read.

import { now, uid } from './util.js';
import { readKnowledge, writeKnowledge, logEvent, writeClient, writeContact } from './db.js';
import { getLead, leadState } from './gtm.js';
import { contactStatuses } from './gtm-outreach.js';
import { promoteLeadToPipeline, updateDeal } from './pipeline.js';

const PROMO_SLUG = 'outreach-promotion';

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
\`outreach-replies-to-pipeline\` workflow pulls them in and puts them on the sales
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

export async function loadPromotion(env) {
  try {
    const doc = await readKnowledge(env, PROMO_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: PROMO_SLUG, title: 'Outreach · replies → pipeline rules',
        body: promoSeedBody(PROMOTION_DEFAULTS), parent_slug: 'module-gtm',
      }).catch(() => {});
      return { ...PROMOTION_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizePromotion(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...PROMOTION_DEFAULTS, source: 'defaults' };
  }
}

export async function savePromotion(env, patch = {}) {
  const cur = await loadPromotion(env);
  const next = sanitizePromotion({ ...cur, ...patch });
  await writeKnowledge(env, {
    slug: PROMO_SLUG, title: 'Outreach · replies → pipeline rules',
    body: promoSeedBody(next), parent_slug: 'module-gtm',
  });
  await logEvent(env, { kind: 'outreach_promotion_updated', payload: next });
  return { ...next, source: 'doc' };
}

const canonPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? `+${d}` : null; };

// ── STEP 1 tool body: collect everyone who replied, normalized ──────────────
export async function collectReplies(env) {
  const replies = [];

  // LinkedIn — replied_at is set when the operator marks a reply (li read APIs
  // are dead, so replies are operator-marked via li_outreach_mark_reply).
  try {
    const li = (await env.DB.prepare(
      `SELECT id, name, company, role, public_id, replied_at FROM li_prospects WHERE replied_at IS NOT NULL`,
    ).all()).results || [];
    for (const p of li) {
      replies.push({
        source: 'li_outreach', ref_id: p.id, name: p.name, company: p.company || null,
        title: p.role || null, phone: null,
        linkedin: p.public_id ? `https://www.linkedin.com/in/${p.public_id}` : null,
        replied_at: p.replied_at || null, lead_id: null,
      });
    }
  } catch { /* li_prospects may be absent */ }

  // GTM WhatsApp — a lead whose contact status derives to 'replied' (inbound
  // after our first outbound). Reuse the same detector the Outreach tab uses.
  try {
    const ids = ((await env.DB.prepare(
      `SELECT id FROM gtm_leads WHERE normalized_phone IS NOT NULL`,
    ).all()).results || []).map((r) => r.id);
    const statuses = await contactStatuses(env, ids);
    for (const [leadId, st] of statuses) {
      if (st.contact_status !== 'replied') continue;
      const lead = await getLead(env, leadId);
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
async function findExistingClient(env, reply) {
  if (reply.client_id) {
    const c = await env.DB.prepare('SELECT id, name, stage, status FROM clients WHERE id = ?').bind(reply.client_id).first();
    if (c) return c;
  }
  const phone = canonPhone(reply.phone);
  if (phone) {
    const row = await env.DB.prepare(
      `SELECT cl.id, cl.name, cl.stage, cl.status FROM contacts ct JOIN clients cl ON cl.id = ct.client_id
       WHERE ct.client_id IS NOT NULL AND replace(replace(replace(replace(ct.phone,' ',''),'-',''),'(',''),')','') LIKE ? LIMIT 1`,
    ).bind(`%${phone.slice(1)}`).first().catch(() => null);
    if (row) return row;
  }
  if (reply.linkedin) {
    const slug = String(reply.linkedin).replace(/\/+$/, '').split('/').pop();
    if (slug) {
      const row = await env.DB.prepare(
        `SELECT cl.id, cl.name, cl.stage, cl.status FROM contacts ct JOIN clients cl ON cl.id = ct.client_id
         WHERE ct.client_id IS NOT NULL AND ct.linkedin_url LIKE ? LIMIT 1`,
      ).bind(`%${slug}%`).first().catch(() => null);
      if (row) return row;
    }
  }
  if (reply.name) {
    const like = reply.company ? `${reply.name} (${reply.company})` : reply.name;
    const row = await env.DB.prepare('SELECT id, name, stage, status FROM clients WHERE name = ? LIMIT 1').bind(like).first().catch(() => null);
    if (row) return row;
  }
  return null;
}

// Find THIS person's existing contact under a client (phone → linkedin → name),
// so a re-run updates it instead of inserting a duplicate. The promote workflow
// runs hourly; without this, an already-promoted lead grew one new contact row
// every hour.
async function findClientContact(env, clientId, reply) {
  const phone = canonPhone(reply.phone);
  if (phone) {
    const r = await env.DB.prepare(
      `SELECT id FROM contacts WHERE client_id = ?
         AND replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')','') LIKE ? LIMIT 1`,
    ).bind(clientId, `%${phone.slice(1)}`).first().catch(() => null);
    if (r) return r.id;
  }
  if (reply.linkedin) {
    const slug = String(reply.linkedin).replace(/\/+$/, '').split('/').pop();
    if (slug) {
      const r = await env.DB.prepare('SELECT id FROM contacts WHERE client_id = ? AND linkedin_url LIKE ? LIMIT 1').bind(clientId, `%${slug}%`).first().catch(() => null);
      if (r) return r.id;
    }
  }
  if (reply.name) {
    const r = await env.DB.prepare('SELECT id FROM contacts WHERE client_id = ? AND full_name = ? LIMIT 1').bind(clientId, reply.name).first().catch(() => null);
    if (r) return r.id;
  }
  return null;
}

// ── STEP 2 tool body: create/advance each reply on the board ────────────────
export async function promoteRepliesToPipeline(env, { replies } = {}) {
  const rules = await loadPromotion(env);
  const rank = (s) => { const i = rules.stage_rank.indexOf(s); return i < 0 ? -1 : i; };
  const targetRank = rank(rules.replied_stage);
  const list = Array.isArray(replies) ? replies : [];

  const out = { ok: true, total: list.length, created: 0, advanced: 0, unchanged: 0, skipped: 0, details: [] };
  for (const reply of list) {
    if (!reply || !reply.name) { out.skipped++; out.details.push({ ref_id: reply?.ref_id, skipped: 'no name' }); continue; }
    try {
      const existing = await findExistingClient(env, reply);

      if (existing) {
        // advance forward only (per advance_only); keep a further-along deal put.
        // A stage that isn't on the rank list (null, 'active', 'nurture', 'lost',
        // a real client already won) is UNKNOWN, not "earlier" — never drag those
        // to replied_stage. Only a known, genuinely-earlier stage advances.
        let moved = false;
        const curRank = rank(existing.stage);
        const knownEarlier = curRank >= 0 && curRank < targetRank;
        if (!rules.advance_only || knownEarlier) {
          if (existing.stage !== rules.replied_stage) { await updateDeal(env, existing.id, { stage: rules.replied_stage }, 'outreach-promote'); moved = true; }
        }
        // make sure a contact carries the reply provenance — UPDATE the existing
        // contact (found by phone/linkedin/name) rather than inserting a new one
        // every hourly run.
        const contactId = await findClientContact(env, existing.id, reply);
        await writeContact(env, {
          id: contactId || undefined,
          full_name: reply.name, phone: reply.phone || undefined, company: reply.company || undefined,
          title: reply.title || undefined, linkedin_url: reply.linkedin || undefined,
          status: 'lead', source: 'cold_outreach', client_id: existing.id, tags: [rules.tag, reply.source],
          updated_by: 'outreach-promote',
        }).catch(() => {});
        if (reply.lead_id) await env.DB.prepare('UPDATE gtm_leads SET client_id=?, updated_at=? WHERE id=? AND client_id IS NULL').bind(existing.id, now(), reply.lead_id).run().catch(() => {});
        if (moved) out.advanced++; else out.unchanged++;
        out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: existing.id, action: moved ? 'advanced' : 'unchanged', stage: rules.replied_stage });
        await logEvent(env, { kind: 'outreach_promoted', actor: 'outreach-promote', payload: { source: reply.source, name: reply.name, client_id: existing.id, action: moved ? 'advanced' : 'matched' } });
        continue;
      }

      // NEW — create on the board at replied_stage
      let clientId;
      if (reply.lead_id) {
        // reuse the GTM promotion (creates client + mirrored contact + links lead)
        const r = await promoteLeadToPipeline(env, reply.lead_id, 'outreach-promote');
        if (!r.ok) { out.skipped++; out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, skipped: r.error }); continue; }
        clientId = r.client_id;
      } else {
        const client = await writeClient(env, {
          name: reply.company ? `${reply.name} (${reply.company})` : reply.name,
          status: 'prospect', tags: ['person', reply.source, rules.tag],
          notes: `Replied to ${reply.source === 'li_outreach' ? 'LinkedIn' : 'WhatsApp'} outreach.${reply.title ? ' ' + reply.title + (reply.company ? ' at ' + reply.company : '') + '.' : ''}${reply.linkedin ? ' LinkedIn: ' + reply.linkedin : ''}`,
        });
        clientId = client.id;
        await writeContact(env, {
          full_name: reply.name, phone: reply.phone || undefined, company: reply.company || undefined,
          title: reply.title || undefined, linkedin_url: reply.linkedin || undefined,
          status: 'lead', source: 'cold_outreach', client_id: clientId, tags: [rules.tag, reply.source],
          created_by: 'outreach-promote',
        }).catch(() => {});
      }
      await updateDeal(env, clientId, { stage: rules.replied_stage }, 'outreach-promote').catch(() => {});
      out.created++;
      out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, client_id: clientId, action: 'created', stage: rules.replied_stage });
      await logEvent(env, { kind: 'outreach_promoted', actor: 'outreach-promote', payload: { source: reply.source, name: reply.name, client_id: clientId, action: 'created' } });
    } catch (e) {
      out.skipped++;
      out.details.push({ ref_id: reply.ref_id, source: reply.source, name: reply.name, skipped: String(e?.message || e) });
    }
  }
  return out;
}
