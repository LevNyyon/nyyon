// GTM ∩ WhatsApp intake — surface the people the operator already talks to as
// selectable lead candidates: DM chats (contacts AND anyone who ever messaged),
// senders seen inside groups, and live group rosters from the wa-gateway.
// Selected people become gtm_leads rows (name carried over, source noted) and
// flow into the normal Intake -> Enrich chain.

import { normalizePhone, locatePhone } from './gtm-phone.js';
import { readWaGroupInfo, resolveWaLids } from './whatsapp.js';
import { logEvent } from './db.js';
import { now } from './util.js';

const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// '972545492444@c.us' -> '+972545492444'; '@lid' / '@g.us' ids carry no phone.
function phoneFromWaId(waId) {
  const m = /^(\d{6,17})@c\.us$/.exec(String(waId || ''));
  if (!m) return null;
  const n = normalizePhone('+' + m[1]);
  return n.valid ? n.normalized : null;
}

async function leadPhoneSet(env) {
  const r = await env.DB.prepare('SELECT normalized_phone FROM gtm_leads WHERE normalized_phone IS NOT NULL').all();
  return new Set((r.results || []).map((x) => x.normalized_phone));
}

async function contactPhoneSet(env) {
  const out = new Set();
  try {
    const r = await env.DB.prepare('SELECT phone FROM contacts WHERE phone IS NOT NULL AND phone != \'\'').all();
    for (const row of r.results || []) {
      const n = normalizePhone(row.phone);
      if (n.valid) out.add(n.normalized);
    }
  } catch { /* contacts table optional */ }
  return out;
}

// Fill phones for @lid people from the gateway's LID<->PN map (cached in
// wa_lid_map; up to 25 unknown lids resolve per call, the rest warm up on
// later opens). Mutates in place.
async function fillLidPhones(env, people) {
  const lids = people.filter((p) => !p.phone && /@lid$/.test(p.wa_id)).map((p) => p.wa_id);
  if (!lids.length) return;
  const map = await resolveWaLids(env, lids);
  for (const p of people) {
    if (!p.phone && map.has(p.wa_id)) {
      const phone = map.get(p.wa_id);
      if (phone) {
        const n = normalizePhone(phone);
        p.phone = n.valid ? n.normalized : phone;
      }
    }
  }
}

function annotate(person, leadSet, contactSet) {
  return {
    ...person,
    already_lead: !!(person.phone && leadSet.has(person.phone)),
    is_contact:   !!(person.phone && contactSet.has(person.phone)),
  };
}

// Everyone WhatsApp knows about: DM chats (one row per person we have a chat
// with) merged with distinct group senders (people who messaged in groups —
// includes non-contacts). '@lid' senders surface with phone:null so the
// operator sees them but can't import them (the enrich chain needs a phone).
export async function listWaIntakePeople(env, { q = '', limit = 1000 } = {}) {
  const byId = new Map();

  const dms = await env.DB.prepare(
    "SELECT id, name, last_message_at FROM wa_chats WHERE is_group = 0 AND id NOT LIKE '%@broadcast'",
  ).all();
  for (const c of dms.results || []) {
    byId.set(c.id, {
      wa_id: c.id, name: c.name || null, phone: phoneFromWaId(c.id),
      kind: 'chat', last_seen: c.last_message_at || null, messages: null,
    });
  }

  const senders = await env.DB.prepare(
    `SELECT sender_id, sender_name, MAX(timestamp) AS t, COUNT(*) AS n
       FROM wa_messages
      WHERE from_me = 0 AND sender_id IS NOT NULL AND sender_id != ''
        AND sender_id NOT LIKE '%@g.us' AND sender_id NOT LIKE '%@broadcast'
      GROUP BY sender_id`,
  ).all();
  for (const s of senders.results || []) {
    const prev = byId.get(s.sender_id);
    if (prev) {
      prev.name = prev.name || s.sender_name || null;
      prev.last_seen = Math.max(prev.last_seen || 0, s.t || 0) || null;
      prev.messages = s.n;
    } else {
      byId.set(s.sender_id, {
        wa_id: s.sender_id, name: s.sender_name || null, phone: phoneFromWaId(s.sender_id),
        kind: 'group-sender', last_seen: s.t || null, messages: s.n,
      });
    }
  }

  const needle = String(q || '').trim().toLowerCase();
  let people = [...byId.values()];
  if (needle) {
    people = people.filter((p) =>
      (p.name || '').toLowerCase().includes(needle) || (p.phone || '').includes(needle) || p.wa_id.includes(needle));
  }
  people.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  people = people.slice(0, limit);
  await fillLidPhones(env, people);
  const leadSet = await leadPhoneSet(env);
  const contactSet = await contactPhoneSet(env);
  return people.map((p) => annotate(p, leadSet, contactSet));
}

export async function listWaIntakeGroups(env) {
  const r = await env.DB.prepare(
    'SELECT id, name, last_message_at FROM wa_chats WHERE is_group = 1 ORDER BY last_message_at DESC',
  ).all();
  return r.results || [];
}

// Live roster for one group (via the wa-gateway), names resolved from the
// gateway payload first, then from messages we've persisted for that group.
export async function listWaGroupCandidates(env, groupId) {
  const info = await readWaGroupInfo(env, groupId);
  const nameById = new Map();
  try {
    const r = await env.DB.prepare(
      `SELECT sender_id, sender_name FROM wa_messages
        WHERE chat_id = ? AND sender_name IS NOT NULL AND sender_name != ''
        GROUP BY sender_id`,
    ).bind(groupId).all();
    for (const row of r.results || []) nameById.set(row.sender_id, row.sender_name);
  } catch { /* names stay null */ }

  const raw = (info.participants || []).map((p) => {
    const waId = typeof p === 'string' ? p : (p?.id?._serialized || p?.id || '');
    const gwName = typeof p === 'object' ? (p?.pushname || p?.name || p?.notify || null) : null;
    return {
      wa_id: waId,
      name: gwName || nameById.get(waId) || null,
      phone: phoneFromWaId(waId),
      kind: 'participant',
      is_admin: typeof p === 'object' ? !!(p?.isAdmin || p?.isSuperAdmin) : false,
    };
  }).filter((p) => p.wa_id);
  await fillLidPhones(env, raw);
  const leadSet = await leadPhoneSet(env);
  const contactSet = await contactPhoneSet(env);
  const participants = raw.map((p) => annotate(p, leadSet, contactSet));

  return { group: { id: info.id, name: info.name, participant_count: info.participant_count }, participants };
}

// Drain the LID backlog: every @lid the picker can show (DM chats + group
// senders) that has no fresh cache row, resolved one gateway-batch at a time.
// The picker calls this in a loop while open, so phones fill in live instead
// of trickling 25 per open. Returns progress so the loop knows when to stop.
export async function resolveWaIntakeBacklog(env, { limit = 50 } = {}) {
  const lidSet = new Set();
  const dms = await env.DB.prepare(
    "SELECT id FROM wa_chats WHERE is_group = 0 AND id LIKE '%@lid'",
  ).all().catch(() => ({ results: [] }));
  for (const r of dms.results || []) lidSet.add(r.id);
  const senders = await env.DB.prepare(
    `SELECT DISTINCT sender_id FROM wa_messages
      WHERE from_me = 0 AND sender_id LIKE '%@lid'`,
  ).all().catch(() => ({ results: [] }));
  for (const r of senders.results || []) lidSet.add(r.sender_id);

  const all = [...lidSet];
  if (!all.length) return { attempted: 0, resolved: 0, remaining: 0 };
  const NULL_TTL_MS = 7 * 24 * 3600 * 1000;
  const cached = await env.DB.prepare('SELECT lid, phone, resolved_at FROM wa_lid_map').all().catch(() => ({ results: [] }));
  const fresh = new Set();
  for (const row of cached.results || []) {
    const stale = row.phone == null && (Date.now() - row.resolved_at) > NULL_TTL_MS;
    if (!stale) fresh.add(row.lid);
  }
  const backlog = all.filter((l) => !fresh.has(l));
  if (!backlog.length) return { attempted: 0, resolved: 0, remaining: 0 };

  const chunk = backlog.slice(0, Math.min(limit, 50));
  const map = await resolveWaLids(env, chunk, { maxResolve: chunk.length });
  let resolved = 0;
  for (const phone of map.values()) if (phone) resolved++;
  return { attempted: chunk.length, resolved, remaining: Math.max(0, backlog.length - chunk.length) };
}

// Import selected people as gtm_leads — same batch/dedupe/event conventions as
// importLeads, plus the name WhatsApp already knows and provenance in sources.
export async function importWaLeads(env, { people = [], source = null } = {}) {
  const batch_id = gid('gb');
  let valid = 0, invalid = 0, duplicates = 0, created = 0;
  const leadSet = await leadPhoneSet(env);
  for (const person of people) {
    const n = normalizePhone(person?.phone || '');
    if (!n.valid) { invalid++; continue; }
    valid++;
    if (leadSet.has(n.normalized)) { duplicates++; continue; }
    leadSet.add(n.normalized);
    const g = locatePhone(n.normalized);
    const name = String(person?.name || '').trim() || null;
    const sources = name ? { name: { tool: 'whatsapp', at: now() } } : {};
    await env.DB.prepare(`
      INSERT INTO gtm_leads (id, phone, normalized_phone, status, source, batch_id, country, region, name, sources, created_at, updated_at)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(gid('gl'), n.normalized, n.normalized, source || 'whatsapp', batch_id, g.country, g.region, name, JSON.stringify(sources), now(), now()).run();
    created++;
  }
  const summary = { total: people.length, valid, invalid, duplicates, created, batch_id: created > 0 ? batch_id : null, via: 'whatsapp', source: source || 'whatsapp' };
  if (created > 0) {
    await env.DB.prepare('INSERT INTO gtm_batches (id, source, via, total, created, duplicates, invalid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(batch_id, source || 'whatsapp', 'whatsapp', people.length, created, duplicates, invalid, now()).run();
  }
  await logEvent(env, { kind: 'gtm_leads_imported', actor: 'operator', payload: summary });
  return summary;
}
