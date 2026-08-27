// WhatsApp module — connects to the wa-gateway (whatsapp-web.js, port 2799).
// Listener (inbound webhook) + outbound sends + per-chat policy.

import { uid, now, safeJSON } from './util.js';
import { logEvent } from './db.js';
import { identifyByPhone } from './web.js';
import { beginSend, markSent, markFailed } from './outbox.js';
import { withResolvedCredentials } from './gateway-config.js';

// ─── normalize wa-gateway's loose payload shapes ────────────────
// wa-gateway can wrap the message in {event, session, payload:{}} or send it flat.
// We accept either + drill into _data for the friendly notify name.
export function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;

  const id = p.id || p.messageId || p.key?.id;
  if (!id) return null;

  const chat_id = p.chatId || p.from || p.to || p.key?.remoteJid;
  if (!chat_id) return null;

  const from_me = !!(p.fromMe ?? p.key?.fromMe);

  // Sender of the message.
  //   - In DMs, `p.from` IS the person, so it's a fine fallback.
  //   - In groups, `p.from` is the group id, which is NOT a person — falling
  //     back to it (or to chat_id) writes the group jid into sender_id and
  //     downstream code can't recover the real person. When wa-gateway omits
  //     author/participant on a group message (some relayed types do this),
  //     it's better to leave sender_id null and let the digest layer recover
  //     via metadata.full_name → contacts lookup than to pollute the DB.
  const is_group_chat = String(chat_id).endsWith('@g.us');
  const sender_id =
    from_me
      ? (p.author || p.participant || null)
      : is_group_chat
        ? (p.author || p.participant || null)
        : (p.author || p.participant || p.from || chat_id);

  const sender_name =
    p.senderName || p.notifyName || p._data?.notifyName || p.pushName || null;

  const body = typeof p.body === 'string' ? p.body : (p.text || p.caption || '');

  // wa-gateway gives seconds; normalise to ms.
  const tsRaw = p.timestamp ?? p.t ?? p.messageTimestamp;
  const tsNum = typeof tsRaw === 'number' ? tsRaw : parseInt(tsRaw, 10) || Math.floor(Date.now() / 1000);
  const timestamp = tsNum > 1e11 ? tsNum : tsNum * 1000;

  const is_group = chat_id.endsWith('@g.us');

  return { id, chat_id, from_me, sender_id, sender_name, body, timestamp, is_group, raw };
}

// ─── chat registry ──────────────────────────────────────────
export async function getOrCreateChat(env, chat_id, name, is_group) {
  const t = now();
  const existing = await env.DB.prepare('SELECT * FROM wa_chats WHERE id = ?').bind(chat_id).first();
  if (existing) {
    if (name && name !== existing.name) {
      await env.DB.prepare('UPDATE wa_chats SET name = ?, updated_at = ? WHERE id = ?').bind(name, t, chat_id).run();
      return { ...existing, name, updated_at: t };
    }
    return existing;
  }
  // Default: auto_listen=0. Operator must opt in per chat from the ops Channels module.
  await env.DB.prepare(
    `INSERT INTO wa_chats (id, name, is_group, auto_listen, can_send, last_message_at, last_snippet, first_seen_at, updated_at)
     VALUES (?, ?, ?, 0, 0, NULL, NULL, ?, ?)`,
  ).bind(chat_id, name || null, is_group ? 1 : 0, t, t).run();
  await logEvent(env, { kind: 'wa_chat_discovered', payload: { chat_id, name, is_group } });
  return env.DB.prepare('SELECT * FROM wa_chats WHERE id = ?').bind(chat_id).first();
}

export async function listChats(env) {
  const r = await env.DB.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM wa_messages m WHERE m.chat_id = c.id) AS messages_count
      FROM wa_chats c
     ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC, c.first_seen_at DESC
  `).all();
  return r.results || [];
}

// Find a WhatsApp chat/person by partial name or phone — the fuzzy, multi-source
// lookup the old exact-name filter lacked. WhatsApp itself barely gives us names
// for 1:1 DMs (chat name is usually empty; many sender ids are @lid privacy ids),
// so we search every source and, crucially, resolve real names from the CRM by
// phone. Token-based + case-insensitive, so "Jane Doe Chicago" still finds
// "Jane Doe". Returns chats to act on, ranked; best-known name resolved.
const _digits = (s) => String(s || '').replace(/\D/g, '');
const _phoneOf = (waId) => _digits(String(waId || '').split('@')[0]);

// Match-source ranking weights. Editable via a ```json {"wa_search_weights":
// {...}}``` block in the wa-chat-search knowledge doc; these are the defaults
// (CRM names are the operator's own data, so they outrank live chat names,
// which outrank third-party sender pushnames).
const WA_SEARCH_WEIGHTS = { crm: 5, phone: 4, chat_name: 3, sender_name: 2 };
async function waSearchWeights(env) {
  try {
    const { readKnowledge } = await import('./db.js');
    const doc = await readKnowledge(env, 'wa-chat-search');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const w = m ? JSON.parse(m[1])?.wa_search_weights : null;
    if (w && typeof w === 'object') return { ...WA_SEARCH_WEIGHTS, ...w };
  } catch { /* defaults win */ }
  return WA_SEARCH_WEIGHTS;
}

export async function searchWaChats(env, { query, limit = 15 } = {}) {
  const W = await waSearchWeights(env);
  const raw = String(query || '').trim();
  if (!raw) return [];
  const ql = raw.toLowerCase();
  // match on the whole query OR any word (>=2 chars) — handles extra words like "Haifa"
  const tokens = [...new Set([ql, ...ql.split(/\s+/).filter((t) => t.length >= 2)])];
  const likeSql = (col) => tokens.map(() => `lower(${col}) LIKE ?`).join(' OR ');
  const likeVals = tokens.map((t) => `%${t}%`);
  const qDigits = _digits(raw);

  const [chatsRes, crmRes, senderRes] = await Promise.all([
    env.DB.prepare('SELECT id, name, is_group, last_message_at, last_snippet FROM wa_chats').all(),
    env.DB.prepare(`SELECT full_name, phone FROM contacts WHERE phone IS NOT NULL AND phone != '' AND (${likeSql('full_name')})`).bind(...likeVals).all(),
    env.DB.prepare(
      `SELECT chat_id AS id, MAX(sender_name) AS sender_name, MAX(sender_id) AS sender_id
         FROM wa_messages
        WHERE from_me = 0 AND sender_name IS NOT NULL AND sender_name != '' AND sender_name NOT LIKE '%@lid'
          AND (${likeSql('sender_name')})
        GROUP BY chat_id`,
    ).bind(...likeVals).all(),
  ]);
  const chats = chatsRes.results || [];
  const chatById = new Map(chats.map((c) => [c.id, c]));

  // chat_id -> aggregated match
  const hits = new Map();
  const bump = (id, { name, source, score }) => {
    if (!id) return;
    const ch = chatById.get(id);
    const cur = hits.get(id) || {
      chat_id: id, is_group: ch?.is_group || 0, phone: ch?.is_group ? null : _phoneOf(id),
      last_message_at: ch?.last_message_at ?? null, last_snippet: ch?.last_snippet ?? null,
      name: null, matched_on: new Set(), score: 0,
    };
    if (name && !cur.name) cur.name = name;   // first (highest-priority) name source wins
    cur.matched_on.add(source); cur.score += score;
    hits.set(id, cur);
  };

  // 1) CRM name -> phone -> DM chat (best names come from the operator's own CRM)
  for (const c of (crmRes.results || [])) {
    const cd = _digits(c.phone).slice(-9);
    if (cd.length < 6) continue;
    const chat = chats.find((x) => !x.is_group && _phoneOf(x.id).endsWith(cd));
    if (chat) bump(chat.id, { name: c.full_name, source: 'crm', score: W.crm });
  }
  // 2) chat/group name
  const byName = (await env.DB.prepare(`SELECT id, name FROM wa_chats WHERE ${likeSql('name')}`).bind(...likeVals).all()).results || [];
  for (const c of byName) bump(c.id, { name: c.name, source: 'chat_name', score: W.chat_name });
  // 3) sender pushname on the other party's messages
  for (const s of (senderRes.results || [])) bump(s.id, { name: s.sender_name, source: 'sender_name', score: W.sender_name });
  // 4) phone digits
  if (qDigits.length >= 6) for (const ch of chats) if (_phoneOf(ch.id).includes(qDigits)) bump(ch.id, { name: ch.name, source: 'phone', score: W.phone });

  return [...hits.values()]
    .map((h) => ({ ...h, matched_on: [...h.matched_on] }))
    .sort((a, b) => (b.score - a.score) || ((b.last_message_at || 0) - (a.last_message_at || 0)))
    .slice(0, limit);
}

// Live group catalog from wa-gateway, merged with whatever we already know in the
// local `wa_chats` table (auto_listen, can_send, messages_count). If the
// gateway is unreachable / puppet not ready, fall back to DB-only listing of
// chats with is_group=1.
export async function listWaGroups(env) {
  const sid = waSession(env);
  let live = null;
  let liveError = null;
  try {
    const r = await waFetch(env, `/sessions/${sid}/groups`);
    if (r.ok) {
      const data = await r.json();
      live = Array.isArray(data) ? data : (data?.groups || data?.results || []);
    } else {
      liveError = `gateway ${r.status}`;
    }
  } catch (e) { liveError = String(e?.message || e); }

  // Persist every live group into `wa_chats` so auto_listen toggles can target
  // them BEFORE the first inbound message arrives. INSERT OR IGNORE on PK,
  // then UPDATE name so renames propagate.
  if (live && live.length) {
    const t = now();
    for (const g of live) {
      const id   = g.id || g.groupId || g.chatId || g._serialized || null;
      const name = g.name || g.subject || null;
      if (!id) continue;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO wa_chats (id, name, is_group, auto_listen, can_send, first_seen_at, updated_at)
         VALUES (?, ?, 1, 0, 0, ?, ?)`,
      ).bind(id, name, t, t).run();
      if (name) {
        await env.DB.prepare(`UPDATE wa_chats SET name = ?, updated_at = ? WHERE id = ? AND (name IS NULL OR name = '' OR name != ?)`)
          .bind(name, t, id, name).run();
      }
    }
  }

  // Build a lookup from local DB (auto_listen / can_send / messages_count).
  const dbRows = await env.DB.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM wa_messages m WHERE m.chat_id = c.id) AS messages_count
      FROM wa_chats c
     WHERE c.is_group = 1
  `).all();
  const dbMap = new Map((dbRows.results || []).map((r) => [r.id, r]));

  if (live && live.length) {
    const out = live.map((g) => {
      const id   = g.id || g.groupId || g.chatId || g._serialized || null;
      const row  = id ? dbMap.get(id) : null;
      const participants = Array.isArray(g.participants) ? g.participants : [];
      return {
        id,
        name:        g.name || g.subject || (row?.name) || null,
        is_group:    1,
        participant_count: participants.length || g.participantCount || g.size || null,
        auto_listen: row?.auto_listen ?? 0,
        can_send:    row?.can_send    ?? 0,
        messages_count: row?.messages_count ?? 0,
        last_message_at: row?.last_message_at ?? null,
        source: 'gateway',
      };
    });
    return { groups: out, source: 'gateway', live_error: liveError };
  }

  // Fallback — local DB only. Participant count unknown.
  const out = (dbRows.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    is_group: 1,
    participant_count: null,
    auto_listen: r.auto_listen,
    can_send:    r.can_send,
    messages_count: r.messages_count || 0,
    last_message_at: r.last_message_at,
    source: 'db',
  }));
  return { groups: out, source: 'db', live_error: liveError || 'gateway returned no groups' };
}

// Detailed participant list for one group. Always hits the gateway — the
// local DB only stores per-message sender_ids, not the canonical roster.
export async function readWaGroupInfo(env, groupId) {
  const sid = waSession(env);
  const r = await waFetch(env, `/sessions/${sid}/groups/${encodeURIComponent(groupId)}`);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`wa-gateway group fetch failed ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const participants = Array.isArray(data?.participants) ? data.participants : [];
  // Merge auto_listen state from DB.
  const row = await env.DB.prepare('SELECT auto_listen, can_send, name FROM wa_chats WHERE id = ?').bind(groupId).first();
  return {
    id: groupId,
    name: data?.name || data?.subject || row?.name || null,
    participant_count: participants.length,
    participants,
    auto_listen: row?.auto_listen ?? 0,
    can_send:    row?.can_send    ?? 0,
    raw: data,
  };
}

export async function setChatPolicy(env, chat_id, { auto_listen, can_send, name }) {
  const fields = [];
  const args = [];
  if (auto_listen !== undefined) { fields.push('auto_listen = ?'); args.push(auto_listen ? 1 : 0); }
  if (can_send    !== undefined) { fields.push('can_send = ?');    args.push(can_send    ? 1 : 0); }
  if (name        !== undefined) { fields.push('name = ?');        args.push(name); }
  if (!fields.length) return env.DB.prepare('SELECT * FROM wa_chats WHERE id = ?').bind(chat_id).first();
  fields.push('updated_at = ?'); args.push(now());
  args.push(chat_id);
  await env.DB.prepare(`UPDATE wa_chats SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  await logEvent(env, { kind: 'wa_chat_policy_changed', actor: 'operator', payload: { chat_id, auto_listen, can_send } });
  return env.DB.prepare('SELECT * FROM wa_chats WHERE id = ?').bind(chat_id).first();
}

// Ambiguity-safe digest-listening flip. Resolving a chat by name is a WhatsApp
// fact, not the caller's job: 1:1 DMs usually carry no stored chat name, so a
// substring can hit several chats. When it does we change NOTHING and hand the
// candidates back so the operator picks — flipping the wrong chat silently
// starts (or stops) mining someone else's conversation.
export async function setChatListening(env, { chat_id, name_match, listening } = {}) {
  const want = !!listening;
  if (chat_id) {
    return { ok: true, mode: 'by_id', chat: await setChatPolicy(env, chat_id, { auto_listen: want }) };
  }
  if (!name_match) return { ok: false, error: 'pass either chat_id or name_match' };
  const q = String(name_match).toLowerCase();
  const candidates = (await listChats(env)).filter((r) => (r.name || '').toLowerCase().includes(q));
  if (!candidates.length) {
    return { ok: false, error: `no chat name contains "${name_match}". Try list_wa_chats with name_contains to browse.` };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      candidates: candidates.slice(0, 10).map((c) => ({
        id: c.id, name: c.name, is_group: c.is_group, last_message_at: c.last_message_at, auto_listen: c.auto_listen,
      })),
      error: `${candidates.length} chats match "${name_match}" — ask the operator which one, then call again with chat_id.`,
    };
  }
  return { ok: true, mode: 'by_name', chat: await setChatPolicy(env, candidates[0].id, { auto_listen: want }) };
}

// Flip a chat into the listened set — called whenever we actively converse
// with someone (send/schedule), so their replies flow into the store via the
// hourly history refresh without a manual toggle.
export async function ensureListening(env, chat_id) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO wa_chats (id, name, is_group, auto_listen, can_send, first_seen_at, updated_at)
     VALUES (?, NULL, ?, 1, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET auto_listen = 1, updated_at = excluded.updated_at`,
  ).bind(chat_id, chat_id.endsWith('@g.us') ? 1 : 0, t, t).run();
}

// ─── inbound persistence ────────────────────────────────────
export async function persistMessage(env, msg) {
  const t = now();
  // INSERT OR IGNORE on message id PK — dedups echoes from any outbound work later.
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO wa_messages
       (id, chat_id, from_me, sender_id, sender_name, body, timestamp, raw_json, person_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    msg.id, msg.chat_id, msg.from_me ? 1 : 0,
    msg.sender_id ?? null, msg.sender_name ?? null,
    (msg.body ?? '').slice(0, 8000),
    msg.timestamp,
    JSON.stringify(msg.raw ?? {}),
    t,
  ).run();
  const inserted = (r.meta?.changes ?? 0) > 0;
  if (inserted) {
    // Refresh chat's last-message preview.
    await env.DB.prepare(
      `UPDATE wa_chats SET last_message_at = ?, last_snippet = ?, updated_at = ? WHERE id = ?`,
    ).bind(msg.timestamp, (msg.body ?? '').slice(0, 240), t, msg.chat_id).run();
  }
  return { inserted };
}

// ─── pull-sync from the gateway (the WhatsApp source of truth) ──────────────
// The gateway now persists every message; the command-center just PULLS. This
// incrementally fetches everything newer than the newest message we already
// have and upserts it into the D1 cache (wa_messages/wa_chats), so the digest
// and find_wa_chat keep reading local D1 while all WhatsApp handling — inbound
// and outbound — lives in the gateway. No webhook into this API.
export async function syncFromGateway(env, { limit = 1000 } = {}) {
  // Cursor on the gateway row's created_at (when the gateway PERSISTED the
  // message), not the message's own timestamp: the bridge's deaf-window sweep
  // stores days-old messages long after their ts, and a ts cursor would skip
  // them forever. First run seeds from the newest message we already hold.
  let since = Number((await env.DB.prepare(
    `SELECT value FROM sync_state WHERE key = 'wa_created_cursor'`,
  ).first().catch(() => null))?.value) || 0;
  if (!since) {
    const row = await env.DB.prepare('SELECT MAX(timestamp) AS ts FROM wa_messages').first();
    since = Number(row?.ts) || 0;
  }
  let r;
  try {
    r = await waFetch(env, `/messages?created_since=${since}&limit=${limit}`);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), synced: 0, since };
  }
  if (!r.ok) return { ok: false, error: `gateway HTTP ${r.status}`, synced: 0, since };
  const data = await r.json().catch(() => ({}));
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const t = now();
  let synced = 0;
  let cursor = since;
  for (const m of msgs) {
    if (!m.id || !m.chat_id) continue;
    // Ensure a chat row exists without clobbering a known name (group names get
    // enriched separately via listWaGroups).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO wa_chats (id, name, is_group, auto_listen, can_send, first_seen_at, updated_at)
       VALUES (?, NULL, ?, 0, 0, ?, ?)`,
    ).bind(m.chat_id, m.is_group ? 1 : 0, t, t).run();
    const res = await persistMessage(env, {
      id: m.id, chat_id: m.chat_id, from_me: m.from_me,
      sender_id: m.sender_id, sender_name: m.sender_name,
      body: m.body, timestamp: m.ts, raw: m,
    });
    if (res.inserted) synced++;
    if (Number(m.created_at) > cursor) cursor = Number(m.created_at);
  }
  if (cursor > since) {
    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ('wa_created_cursor', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(cursor, t).run().catch(() => {});
  }
  return { ok: true, scanned: msgs.length, synced, since };
}

// Extract a clean phone string from an wa-gateway sender id like '972500000000@c.us'.
export function phoneFromSenderId(senderId) {
  if (!senderId || typeof senderId !== 'string') return null;
  const m = senderId.match(/^(\d{6,15})(?:@|\b)/);
  return m ? '+' + m[1] : null;
}

// ─── identity stitching from a WhatsApp message ─────────────
// Called only when chat.auto_listen=1 AND message is inbound (from_me=0).
// Phone is the natural identifier on WhatsApp; the cookie_id is the chat id
// so cross-channel events (web cookie + wa chat) can still merge if the same
// human shows up identified by both email + phone separately.
export async function identifyFromMessage(env, msg) {
  if (msg.from_me) return null;
  const phone = phoneFromSenderId(msg.sender_id);
  if (!phone) return null;

  const res = await identifyByPhone(env, {
    phone,
    cookie_id: msg.chat_id,            // WA chat id acts as the channel cookie
    display_name: msg.sender_name || null,
    method: 'wa_inbound',
    source_event_id: msg.id,
  });

  // Tag the just-persisted message with the resolved person_id.
  if (res?.person_id) {
    await env.DB.prepare('UPDATE wa_messages SET person_id = ? WHERE id = ?').bind(res.person_id, msg.id).run();
  }
  return res;
}

// ─── inbound webhook handler ────────────────────────────────
// wa-gateway POSTs every message here. We always upsert the chat (so operator can
// see new chats appear and opt in), but only persist the message body when
// auto_listen=1.
export async function handleInbound(env, rawBody) {
  const msg = normalizePayload(rawBody);
  if (!msg) return { ok: false, reason: 'unparseable' };

  const chat = await getOrCreateChat(env, msg.chat_id, msg.sender_name && !msg.is_group ? msg.sender_name : null, msg.is_group);

  if (chat.auto_listen !== 1) {
    return { ok: true, accepted: false, reason: 'chat not in auto_listen', chat_id: msg.chat_id };
  }

  const { inserted } = await persistMessage(env, msg);
  let identity = null;
  if (inserted && !msg.from_me) {
    identity = await identifyFromMessage(env, msg);
  }
  return { ok: true, accepted: true, inserted, chat_id: msg.chat_id, person_id: identity?.person_id ?? null };
}

// ─── wa-gateway reachability + outbound ──────────────────────────
// Built so the ops UI can show connection status + diagnose the most common
// "I configured the env but nothing flows" problem without leaving Settings.
function waBase(env) {
  return (env.WA_BASE_URL || 'http://127.0.0.1:2785/api').replace(/\/$/, '');
}
function waHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  if (env.WA_API_KEY) h['X-API-Key'] = env.WA_API_KEY;
  return h;
}
function waSession(env) { return env.WA_SESSION_ID || 'default'; }

// ─── wa-gateway throttle ────────────────────────────────────────
// The wa-gateway puppet is a single browser session driving WhatsApp Web — it
// can't take parallel hammering or rapid bursts. Every outbound call from
// this module routes through `waFetch`, which serializes requests AND
// enforces a 1-second floor between consecutive calls. One Nyo turn may fan
// out into 30+ group-info calls (scan-and-tag flow); without this, the puppet
// goes wedged and we get 500s.
const WA_MIN_GAP_MS = 1000;
let waLastCallAt   = 0;
let waChain        = Promise.resolve();
async function waFetch(env, path, init = {}) {
  const next = waChain.then(async () => {
    // Every outbound call to the daemon funnels through here, so this is the
    // single place WA_BASE_URL / WA_API_KEY need to become DB-first (an
    // operator who connected WhatsApp in the onboarding chat has them in D1,
    // not in env). No-op when they are only in env. See lib/gateway-config.js.
    const e = await withResolvedCredentials(env);
    const wait = WA_MIN_GAP_MS - (Date.now() - waLastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    waLastCallAt = Date.now();
    const url = path.startsWith('http') ? path : `${waBase(e)}${path.startsWith('/') ? path : '/' + path}`;
    return fetch(url, { ...init, headers: { ...waHeaders(e), ...(init.headers || {}) } });
  });
  // Keep the chain alive even if this call throws — otherwise the throttle
  // permanently breaks after the first network error.
  waChain = next.then(() => {}, () => {});
  return next;
}

// Normalize an input like "+972 50-000-0000", "972500000000", or already
// "972500000000@c.us" to a canonical wa-gateway chatId. Groups must come in
// already-formatted ("…@g.us") — we don't synthesize group ids.
//
// `@lid` (modern WhatsApp LinkedID — a separate identifier space from
// phone numbers) MUST also pass through unchanged. Earlier we stripped
// the suffix and re-synthesized as `<digits>@c.us` which made the digest
// drawer's "DM the sender" path send to a non-existent phone-formatted
// account — wa-gateway rejected those with /reply 500.
export function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('chatId required');
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`could not parse chatId from ${input}`);
  return `${digits}@c.us`;
}

// Canonical send sequence (matches knowledge doc whatsapp-endpoints):
//   1. probe   GET /sessions/<sid>
//   2. prime if status != ready: POST /sessions/<sid>/start
//   3. poll status until "ready" — max 20s
// Throws if we can't reach ready state.
export async function ensureSessionReady(env, { maxWaitMs = 20_000, pollMs = 2_000 } = {}) {
  const sid = waSession(env);

  const fetchStatus = async () => {
    const r = await waFetch(env, `/sessions/${sid}`);
    if (!r.ok) throw new Error(`wa-gateway probe ${r.status}`);
    const j = await r.json();
    return j?.status || 'unknown';
  };

  let status = await fetchStatus();
  if (status === 'ready') return { status, primed: false };

  // Prime — POST /start. Returns 201 with "initializing".
  await waFetch(env, `/sessions/${sid}/start`, { method: 'POST' });

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, pollMs));
    status = await fetchStatus();
    if (status === 'ready') return { status, primed: true };
  }
  throw new Error(`wa-gateway session never reached "ready" within ${maxWaitMs}ms — last status=${status}`);
}

// Full puppet restart — stop the session, wait a beat, start it again, poll
// until ready. Useful when the puppet wedges (Nyyon can't send, history
// pulls hang, etc.) and the operator just wants Nyo to bounce it.
//
// No QR re-scan needed if the session was already linked — credentials
// persist in wa-gateway's session dir. If the session was never linked this
// will throw because status never reaches "ready".
export async function restartWaSession(env, { waitForReadyMs = 25_000 } = {}) {
  const sid = waSession(env);
  // 1. stop — best-effort, succeeds whether running or not
  try { await waFetch(env, `/sessions/${sid}/stop`, { method: 'POST' }); } catch { /* idempotent */ }
  // 2. small breather so the puppet finishes tearing down chrome
  await new Promise((res) => setTimeout(res, 1500));
  // 3. start — kicks the puppet
  await waFetch(env, `/sessions/${sid}/start`, { method: 'POST' });
  // 4. poll until ready
  const deadline = Date.now() + waitForReadyMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000));
    const r = await waFetch(env, `/sessions/${sid}`);
    if (r.ok) {
      const j = await r.json();
      last = j?.status || 'unknown';
      if (last === 'ready') {
        await logEvent(env, { kind: 'wa_session_restarted', actor: 'nyo', payload: { sid, status: last } });
        return { ok: true, status: last };
      }
    }
  }
  throw new Error(`WhatsApp session restart timed out — last status=${last}`);
}

// Look a phone number up on WhatsApp via the gateway's read-only contact
// endpoint: registered?, pushname, profile photo URL, about, business flag.
// Used by the GTM module's intake enrichment (number -> identity). Goes
// through waFetch so it shares the 1s serialization with everything else.
// Resolve WhatsApp LIDs ('<digits>@lid' privacy ids) to real phones through
// the gateway (WhatsApp Web's own LID<->PN map), cached in wa_lid_map so each
// LID costs one round-trip ever. Null phones re-resolve after 7 days.
// Returns Map<lid, phone|null> (phone is E.164 '+<digits>').
export async function resolveWaLids(env, lids = [], { maxResolve = 50 } = {}) {
  const want = [...new Set([].concat(lids).filter((x) => /@lid$/.test(String(x))))];
  const out = new Map();
  if (!want.length) return out;
  const NULL_TTL_MS = 7 * 24 * 3600 * 1000;
  // D1 caps bound parameters at 100 per statement — an IN(...) over a few
  // hundred lids throws (and used to be swallowed, which made every cached
  // phone past the first gateway batch vanish). Chunk the cache reads.
  const fresh = new Set();
  for (let i = 0; i < want.length; i += 90) {
    const chunk = want.slice(i, i + 90);
    const cached = await env.DB.prepare(
      `SELECT lid, phone, resolved_at FROM wa_lid_map WHERE lid IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all().catch(() => ({ results: [] }));
    for (const row of cached.results || []) {
      const stale = row.phone == null && (Date.now() - row.resolved_at) > NULL_TTL_MS;
      if (!stale) { out.set(row.lid, row.phone || null); fresh.add(row.lid); }
    }
  }
  // Bounded per call: unknown LIDs cost the gateway a server existence query
  // each — the rest resolve progressively on later calls (or via the
  // resolve-backlog loop the picker runs).
  const missing = want.filter((l) => !fresh.has(l)).slice(0, Math.max(0, maxResolve));
  if (!missing.length) return out;
  try {
    const sid = waSession(env);
    const r = await waFetch(env, `/sessions/${sid}/lids`, {
      method: 'POST', body: JSON.stringify({ lids: missing }),
    });
    if (r.ok) {
      const rows = await r.json();
      for (const row of Array.isArray(rows) ? rows : []) {
        const phone = row.number ? '+' + String(row.number).replace(/\D/g, '') : null;
        out.set(row.lid, phone);
        // A per-id gateway error is transient — never cache it as "no phone".
        if (row.error) continue;
        await env.DB.prepare(
          `INSERT INTO wa_lid_map (lid, phone, pn, resolved_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(lid) DO UPDATE SET phone=excluded.phone, pn=excluded.pn, resolved_at=excluded.resolved_at`,
        ).bind(row.lid, phone, row.pn || null, Date.now()).run().catch(() => {});
      }
    }
  } catch { /* gateway down — cached results still returned */ }
  return out;
}

export async function fetchWaContact(env, number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) throw new Error('number required');
  const r = await waFetch(env, `/sessions/${waSession(env)}/contacts/${digits}`);
  if (!r.ok) throw new Error(`wa contact lookup HTTP ${r.status}: ${(await r.text()).slice(0, 140)}`);
  return r.json(); // { on_whatsapp, whatsapp_id?, name?, pushname?, photo?, about?, is_business? }
}

// Resolve EVERY outbound @lid chat we haven't mapped yet into wa_lid_map, so
// downstream lead↔chat matching (GTM contactStatuses, the KPI) can tell a lid
// chat belongs to a lead by phone. Previously lids were only resolved lazily
// (20 at a time, when the KPI drawer happened to render them), so people you
// messaged on a @lid chat showed as "not contacted". resolveWaLids caches each
// result (including a null with a 7-day TTL for genuinely-unresolvable privacy
// lids, so we don't re-query them every run). Returns { pending, resolved }.
export async function backfillWaLidMap(env, { limit = 50 } = {}) {
  let pending = [];
  try {
    pending = ((await env.DB.prepare(
      `SELECT DISTINCT m.chat_id AS lid FROM wa_messages m
       LEFT JOIN wa_lid_map l ON l.lid = m.chat_id
       WHERE m.from_me = 1 AND m.chat_id LIKE '%@lid' AND l.lid IS NULL
       LIMIT ?`,
    ).bind(limit).all()).results || []).map((r) => r.lid);
  } catch { return { pending: 0, resolved: 0 }; }
  if (!pending.length) return { pending: 0, resolved: 0 };
  const map = await resolveWaLids(env, pending, { maxResolve: limit });
  let resolved = 0;
  for (const v of map.values()) if (v) resolved++;
  await logEvent(env, { kind: 'wa_lid_backfill', payload: { pending: pending.length, resolved } }).catch(() => {});
  return { pending: pending.length, resolved };
}

// Lightweight session-health check — returns `{ ok, status, error }` without
// trying to (re)start the puppet. Used by the digest generator to surface
// "session disconnected" / "gateway down" warnings instead of silently
// returning 0 messages.
export async function checkWaHealth(env) {
  env = await withResolvedCredentials(env); // waSession() below reads it synchronously
  try {
    // Ask the wa-gateway for the live session state — the gateway owns the
    // one linked session. (This used to probe a local read-only digest daemon
    // on :47291 that is retired; from the deployed worker that fetch answered
    // 403 and health reported a false "session down" forever.)
    const r = await waFetch(env, `/sessions/${waSession(env)}`);
    if (!r.ok) return { ok: false, status: null, error: `gateway HTTP ${r.status}` };
    const j = await r.json();
    const status = j?.status || 'unknown';
    return { ok: status === 'ready', status, error: null };
  } catch (e) {
    return { ok: false, status: null, error: `gateway unreachable: ${String(e?.message || e).slice(0, 140)}` };
  }
}

export async function probeWaGateway(env) {
  // Reports what the gateway is ACTUALLY using, so a connection made through
  // the onboarding chat (credentials in D1) shows as configured here too.
  env = await withResolvedCredentials(env);
  const url = waBase(env);
  const out = {
    url,
    api_key_configured: !!env.WA_API_KEY,
    session_id: env.WA_SESSION_ID || 'default',
    reachable: false,
    http: null,
    sessions: null,
    webhooks: null,
    error: null,
  };
  try {
    const r = await waFetch(env, `/sessions`);
    out.http = r.status;
    out.reachable = r.ok;
    if (r.ok) {
      const body = await r.json().catch(() => null);
      out.sessions = body;
      // Try to read webhook list for our session — endpoint shape varies by wa-gateway build.
      try {
        const wr = await waFetch(env, `/sessions/${out.session_id}/webhooks`);
        if (wr.ok) out.webhooks = await wr.json().catch(() => null);
      } catch { /* webhooks list unsupported on this build */ }
    } else {
      out.error = (await r.text().catch(() => '')).slice(0, 300);
    }
  } catch (e) {
    out.error = String(e?.message || e);
  }
  return out;
}

// One-click webhook registration from the ops UI Settings surface.
// inbound_url is the URL wa-gateway should POST messages to — defaults to the
// caller's origin + /api/wa/inbound.
export async function registerWebhook(env, { inbound_url, events = ['message'] }) {
  if (!inbound_url) throw new Error('inbound_url required');
  env = await withResolvedCredentials(env); // the session id can come from D1
  const session = env.WA_SESSION_ID || 'default';
  const r = await waFetch(env, `/sessions/${session}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ url: inbound_url, events }),
  });
  const body = await r.text();
  return { http: r.status, ok: r.ok, body: body.slice(0, 500), url: inbound_url };
}

// ─── outbound sends ──────────────────────────────────────────
// Every send goes through ensureSessionReady() first so the puppet can't be
// asleep when we POST. On success we pre-insert into wa_messages with
// from_me=1 + the returned messageId — so the inbound echo from wa-gateway
// dedups via INSERT OR IGNORE (same mirror pattern).

async function postSend(env, path, body) {
  await ensureSessionReady(env);
  const r = await waFetch(env, `/sessions/${waSession(env)}/messages/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    throw new Error(`wa-gateway /${path} ${r.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

async function preInsertOutbound(env, { messageId, chat_id, body }) {
  // The gateway can deliver without returning an id (whatsapp-web.js quirk).
  // The send still happened — record it under a synthetic id so conversations
  // show OUR sends even when the gateway's message events are down. If the
  // real echo ever arrives it inserts under its own id; the thread view
  // dedups by text+time, not by id.
  if (!messageId) messageId = `local_${chat_id}_${now()}_${Math.floor(Math.random() * 1e6)}`;
  const t = now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO wa_messages
       (id, chat_id, from_me, sender_id, sender_name, body, timestamp, raw_json, person_id, created_at)
     VALUES (?, ?, 1, ?, 'Nyyon', ?, ?, ?, NULL, ?)`,
  ).bind(
    messageId, chat_id,
    `${env.WA_SESSION_ID ? '' : ''}me`,
    (body || '').slice(0, 8000),
    t,
    JSON.stringify({ source: 'outbound' }),
    t,
  ).run();
  await env.DB.prepare(
    `UPDATE wa_chats SET last_message_at = ?, last_snippet = ?, updated_at = ? WHERE id = ?`,
  ).bind(t, (body || '').slice(0, 240), t, chat_id).run();
}

// Quoted reply — uses wa-gateway's /messages/reply so the message lands as a
// proper reply (with the quoted bubble) instead of a fresh post in the
// chat. `quotedMessageId` is the WhatsApp waMessageId of the message being
// replied to (matches the `id` we store in wa_messages).
//
// Every WA send routes through the outbox: we insert a `queued` row before
// the provider call, then update to `sent` (with messageId) or `failed`
// (with the error text) when it returns. The send still throws on failure so
// callers like digest-execute can react — the outbox row is the operator's
// after-the-fact record.
export async function replyToWaMessage(env, { chatId, quotedMessageId, text }, opts = {}) {
  if (!text) throw new Error('text required');
  if (!quotedMessageId) throw new Error('quotedMessageId required');
  const chat = toChatId(chatId);
  const log  = await beginSend(env, {
    channel: 'wa', kind: 'reply', to_id: chat, body: text,
    payload: { quotedMessageId },
    ...outboxOpts(opts),
  });
  try {
    await ensureSessionReady(env);
    const r = await waFetch(env, `/sessions/${waSession(env)}/messages/reply`, {
      method: 'POST',
      body: JSON.stringify({ chatId: chat, quotedMessageId, text }),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`wa-gateway /reply ${r.status}: ${raw.slice(0, 300)}`);
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
    await preInsertOutbound(env, { messageId: data.messageId, chat_id: chat, body: text });
    await logEvent(env, { kind: 'wa_sent', actor: 'operator', payload: { chatId: chat, kind: 'reply', quotedMessageId, messageId: data.messageId } });
    await markSent(env, log.id, { message_id: data.messageId });
    return { messageId: data.messageId, timestamp: data.timestamp, chatId: chat, quotedMessageId, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export async function sendText(env, { chatId, text }, opts = {}) {
  if (!text) throw new Error('text required');
  const chat = toChatId(chatId);
  const log  = await beginSend(env, {
    channel: 'wa', kind: 'text', to_id: chat, body: text,
    ...outboxOpts(opts),
  });
  try {
    const res = await postSend(env, 'send-text', { chatId: chat, text });
    await preInsertOutbound(env, { messageId: res.messageId, chat_id: chat, body: text });
    await logEvent(env, { kind: 'wa_sent', actor: 'operator', payload: { chatId: chat, kind: 'text', messageId: res.messageId } });
    await markSent(env, log.id, { message_id: res.messageId });
    return { messageId: res.messageId, timestamp: res.timestamp, chatId: chat, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export async function sendImage(env, { chatId, url, caption }, opts = {}) {
  if (!url) throw new Error('url required');
  const chat = toChatId(chatId);
  const log  = await beginSend(env, {
    channel: 'wa', kind: 'image', to_id: chat, body: caption || null,
    payload: { url },
    ...outboxOpts(opts),
  });
  try {
    const res = await postSend(env, 'send-image', { chatId: chat, url, caption });
    await preInsertOutbound(env, { messageId: res.messageId, chat_id: chat, body: caption || `[image] ${url}` });
    await logEvent(env, { kind: 'wa_sent', actor: 'operator', payload: { chatId: chat, kind: 'image', url, messageId: res.messageId } });
    await markSent(env, log.id, { message_id: res.messageId });
    return { messageId: res.messageId, timestamp: res.timestamp, chatId: chat, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export async function sendDocument(env, { chatId, url, filename, mimetype }, opts = {}) {
  if (!url) throw new Error('url required');
  if (!filename) throw new Error('filename required — picks the name when it lands');
  const chat = toChatId(chatId);
  const log  = await beginSend(env, {
    channel: 'wa', kind: 'document', to_id: chat, body: filename,
    payload: { url, filename, mimetype },
    ...outboxOpts(opts),
  });
  try {
    const res = await postSend(env, 'send-document', { chatId: chat, url, filename, mimetype });
    await preInsertOutbound(env, { messageId: res.messageId, chat_id: chat, body: `[document] ${filename}` });
    await logEvent(env, { kind: 'wa_sent', actor: 'operator', payload: { chatId: chat, kind: 'document', filename, messageId: res.messageId } });
    await markSent(env, log.id, { message_id: res.messageId });
    return { messageId: res.messageId, timestamp: res.timestamp, chatId: chat, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// Pull operator-supplied outbox metadata (source, source_ref, parent_id,
// attempt) into the shape beginSend expects. Anything not provided defaults
// inside beginSend, so callers that don't care can pass `{}` (or omit opts).
function outboxOpts({ source, source_ref, parent_id, attempt } = {}) {
  return {
    source:     source     || 'operator',
    source_ref: source_ref || null,
    parent_id:  parent_id  || null,
    attempt:    attempt    || 1,
  };
}

// Safe test-send: forces the destination to env.WA_TEST_CHAT_ID regardless
// of what the caller asks. This exists so any verification path — Claude
// debugging the pipeline, a healthcheck cron, an integration test — can
// confirm "yes, wa-gateway → puppet → WA Web → my number" works WITHOUT ever
// touching a real client / group chat. Throws if WA_TEST_CHAT_ID is unset.
export async function sendTestText(env, { text } = {}) {
  if (!env.WA_TEST_CHAT_ID) throw new Error('WA_TEST_CHAT_ID not set — refusing to test-send to avoid hitting a real chat');
  const safeText = `[NYYON TEST · ${new Date().toISOString().slice(11, 19)}] ${text || 'ping'}`;
  return sendText(env, { chatId: env.WA_TEST_CHAT_ID, text: safeText });
}

// Reply round-trip — sends an anchor message to WA_TEST_CHAT_ID, then replies
// to it as a quoted reply. Returns both messageIds so the operator can
// verify on phone that the second message renders as a proper reply bubble.
export async function sendTestReply(env, { anchorText, replyText } = {}) {
  if (!env.WA_TEST_CHAT_ID) throw new Error('WA_TEST_CHAT_ID not set — refusing to test-reply');
  const ts = new Date().toISOString().slice(11, 19);
  const anchor = await sendText(env, {
    chatId: env.WA_TEST_CHAT_ID,
    text:   `[NYYON TEST anchor · ${ts}] ${anchorText || 'this is the anchor message'}`,
  });
  // Tiny pause so WA Web registers the anchor before we quote it.
  await new Promise((r) => setTimeout(r, 600));
  const reply = await replyToWaMessage(env, {
    chatId:          env.WA_TEST_CHAT_ID,
    quotedMessageId: anchor.messageId,
    text:            `[NYYON TEST reply · ${ts}] ${replyText || 'and this is the reply quoting the anchor'}`,
  });
  return { anchor, reply };
}

// Pull recent messages wa-gateway already has cached and persist them into our
// own wa_messages table. Useful right after a fresh QR-link: the puppet only
// stores what it sees AFTER connecting, but we want those rows in our DB so
// the digest + funnel can mine them. Returns inserted count + per-chat count.
export async function backfillMessages(env, { limit = 50, chatId = null, allAutoListen = true } = {}) {
  // Decide which chats to backfill:
  //   - explicit chatId → just that one
  //   - else allAutoListen=true → every chat marked auto_listen=1
  //
  // We call wa-gateway's new /messages/history/:chatId endpoint per chat, which
  // returns BOTH directions (the plain /messages store is outbound-only).
  // Each call is 1s-throttled by waFetch.
  const sid = waSession(env);
  let targetChats = [];
  if (chatId) {
    targetChats = [{ id: chatId, name: null, is_group: chatId.endsWith('@g.us') ? 1 : 0 }];
  } else if (allAutoListen) {
    const r = await env.DB.prepare('SELECT id, name, is_group FROM wa_chats WHERE auto_listen = 1').all();
    targetChats = r.results || [];
  } else {
    throw new Error('backfill requires either chatId or allAutoListen=true');
  }
  if (!targetChats.length) {
    return { fetched: 0, inserted: 0, per_chat: {}, chats_scanned: 0, warning: 'no chats with auto_listen=1 — flip some on first' };
  }

  let totalFetched = 0;
  let inserted = 0;
  const perChat = {};

  for (const chat of targetChats) {
    const cid = chat.id;
    try {
      const r = await waFetch(env, `/sessions/${sid}/messages/history/${encodeURIComponent(cid)}?limit=${limit}`);
      if (!r.ok) continue;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data?.messages || []);
      totalFetched += list.length;

      for (const m of list) {
        const wa_id  = m.id || m.waMessageId;
        if (!wa_id) continue;
        const fromMe = Boolean(m.fromMe) || (m.direction || '').toLowerCase() === 'outgoing';
        // media/calls carry no text — store a typed placeholder so
        // conversations can SHOW that something happened there
        const body   = m.body || m.text || m.caption
          || (m.type && m.type !== 'chat' ? `[${m.type}]` : null);
        const ts     = typeof m.timestamp === 'number'
          ? (m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp)
          : (Date.parse(m.createdAt || '') || now());
        const senderId   = fromMe ? null : (m.from || m.author || null);
        const senderName = m.senderName || m.notifyName || null;
        const isGroup    = cid.endsWith('@g.us');

        await env.DB.prepare(
          `INSERT OR IGNORE INTO wa_chats (id, name, is_group, auto_listen, can_send, first_seen_at, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?)`,
        ).bind(cid, chat.name || null, isGroup ? 1 : 0, ts, ts).run();

        const res = await env.DB.prepare(
          `INSERT OR IGNORE INTO wa_messages
             (id, chat_id, from_me, sender_id, sender_name, body, timestamp, raw_json, person_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).bind(
          wa_id, cid, fromMe ? 1 : 0, senderId, senderName,
          body, ts,
          JSON.stringify({ source: 'backfill_history', type: m.type || null }),
          now(),
        ).run();
        if (res.meta?.changes) {
          inserted++;
          perChat[cid] = (perChat[cid] || 0) + 1;
        }
      }
    } catch (e) { /* per-chat failure — skip and continue */ }
  }
  await logEvent(env, { kind: 'wa_backfill', actor: 'operator', payload: { chats_scanned: targetChats.length, fetched: totalFetched, inserted } });
  return { fetched: totalFetched, inserted, per_chat: perChat, chats_scanned: targetChats.length };
}

export async function reactToMessage(env, { messageId, reaction }, opts = {}) {
  if (!messageId || !reaction) throw new Error('messageId + reaction required');
  const log = await beginSend(env, {
    channel: 'wa', kind: 'reaction', to_id: null, body: reaction,
    payload: { messageId, reaction },
    ...outboxOpts(opts),
  });
  try {
    await ensureSessionReady(env);
    const r = await waFetch(env, `/sessions/${waSession(env)}/messages/react`, {
      method: 'POST',
      body: JSON.stringify({ messageId, reaction }),
    });
    if (!r.ok) throw new Error(`react failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await logEvent(env, { kind: 'wa_reacted', actor: 'operator', payload: { messageId, reaction } });
    await markSent(env, log.id, { message_id: messageId });
    return { ok: true, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// Operator-triggered synthetic inbound — proves the persistence + identify path
// even if wa-gateway itself isn't reachable yet. Falls through the same handleInbound.
export async function testInbound(env, { chat_id, body_text }) {
  if (!chat_id) throw new Error('chat_id required');
  const stamp = Date.now();
  const synthetic = {
    event: 'message',
    session: env.WA_SESSION_ID || 'default',
    payload: {
      id: `test_${stamp}_${Math.random().toString(36).slice(2, 8)}`,
      from: chat_id,
      chatId: chat_id,
      fromMe: false,
      body: body_text || '[test] synthetic inbound from ops Settings',
      timestamp: Math.floor(stamp / 1000),
      _data: { notifyName: 'Synthetic Sender' },
    },
  };
  const { handleInbound } = await import('./whatsapp.js');
  const res = await handleInbound(env, synthetic);
  return { synthetic_payload: synthetic, result: res };
}

// ─── operator reads ─────────────────────────────────────────
export async function recentMessages(env, { chat_id = null, limit = 200 } = {}) {
  const sql = chat_id
    ? 'SELECT * FROM wa_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM wa_messages ORDER BY timestamp DESC LIMIT ?';
  const stmt = chat_id ? env.DB.prepare(sql).bind(chat_id, limit) : env.DB.prepare(sql).bind(limit);
  const r = await stmt.all();
  return (r.results || []).map((m) => ({ ...m, raw_json: safeJSON(m.raw_json) }));
}
