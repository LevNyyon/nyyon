// LinkedIn via Unipile — the hosted messaging API (https://developer.unipile.com).
//
// This file replaces the old self-hosted daemon transport behind the SAME
// export surface lib/linkedin.js had, so the `linkedin` gateway and every tool
// above it are untouched: probe / profile / search / dm / connect / post /
// react / conversations all keep their signatures and (normalized) shapes.
//
// Why Unipile: the shipped product has no daemon, no tunnel, no browser
// session to babysit. The operator connects their LinkedIn once through
// Unipile's hosted auth page (connectLink() below returns the URL), Unipile
// holds the session and the IP hygiene, and this file speaks plain REST.
//
// Config (lib/gateway-config.js resolves DB-first, then env):
//   UNIPILE_DSN        e.g. api1.unipile.com:13111  (their per-account host)
//   UNIPILE_API_KEY    X-API-KEY header value
//   UNIPILE_ACCOUNT_ID optional — otherwise the first LINKEDIN account found
//
// Every write still goes through the Outbox (beginSend/markSent/markFailed):
// the unified audit trail survives the transport swap.

import { beginSend, markSent, markFailed } from './outbox.js';
import { withResolvedCredentials } from './gateway-config.js';

function baseUrl(env) {
  let dsn = String(env.UNIPILE_DSN || '').trim().replace(/\/+$/, '');
  if (!dsn) return null;
  if (!/^https?:\/\//.test(dsn)) dsn = 'https://' + dsn;
  return dsn;
}

// The single funnel to Unipile. Consistent {ok,http,data,error,ms} result so
// callers can always act on it; bounded timeout so nothing wedges a request.
async function call(env, method, path, body = null, { timeoutMs = 30000, form = false } = {}) {
  env = await withResolvedCredentials(env);
  const base = baseUrl(env);
  if (!base) return { ok: false, http: 0, error: 'UNIPILE_DSN not configured — connect LinkedIn in Settings', ms: 0 };
  const headers = { 'X-API-KEY': env.UNIPILE_API_KEY || '' };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== null && form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) fd.append(k, String(v));
    init.body = fd; // fetch sets the multipart boundary header itself
  } else if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const started = Date.now();
  let res;
  try {
    res = await fetch(base + path, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /abort|timeout/i.test(String(e?.message || ''));
    return { ok: false, http: 0, timedOut, error: timedOut ? `unipile timeout after ${timeoutMs}ms` : `unipile unreachable: ${String(e?.message || e)}`, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON, keep raw */ }
  if (!res.ok) {
    const errMsg = json?.detail || json?.title || json?.error || text?.slice(0, 300) || res.statusText;
    return { ok: false, http: res.status, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 300), ms };
  }
  return { ok: true, http: res.status, data: json, ms };
}

// The LinkedIn account to act as. Explicit UNIPILE_ACCOUNT_ID wins; otherwise
// the first connected LINKEDIN account on the Unipile workspace.
async function accountId(env) {
  env = await withResolvedCredentials(env);
  if (env.UNIPILE_ACCOUNT_ID) return env.UNIPILE_ACCOUNT_ID;
  const r = await call(env, 'GET', '/api/v1/accounts');
  if (!r.ok) throw new Error(r.error);
  const items = r.data?.items || [];
  const li = items.find((a) => String(a.type || a.provider || '').toUpperCase().includes('LINKEDIN'));
  if (!li) throw new Error('no LinkedIn account connected on Unipile — open the connect link first');
  return li.id;
}

// ─── probe + hosted auth ─────────────────────────────────────────

export async function probeLinkedIn(env) {
  const r = await call(env, 'GET', '/api/v1/accounts', null, { timeoutMs: 10000 });
  if (!r.ok) return { ok: false, error: r.error, http: r.http };
  const items = r.data?.items || [];
  const li = items.filter((a) => String(a.type || a.provider || '').toUpperCase().includes('LINKEDIN'));
  return {
    ok: li.length > 0,
    accounts: li.map((a) => ({ id: a.id, name: a.name || null, status: a.sources?.[0]?.status || null })),
    error: li.length ? null : 'Unipile reachable, but no LinkedIn account is connected yet',
  };
}

// Generate the hosted auth URL the operator opens to connect (or reconnect)
// their LinkedIn. Links are short-lived by design — generate per click.
export async function connectLink(env, { reconnect_account = null, success_redirect_url = null } = {}) {
  env = await withResolvedCredentials(env);
  const base = baseUrl(env);
  if (!base) throw new Error('UNIPILE_DSN not configured');
  const body = reconnect_account
    ? { type: 'reconnect', reconnect_account, api_url: base, expiresOn: new Date(Date.now() + 3600_000).toISOString() }
    : { type: 'create', providers: ['LINKEDIN'], api_url: base, expiresOn: new Date(Date.now() + 3600_000).toISOString() };
  if (success_redirect_url) body.success_redirect_url = success_redirect_url;
  const r = await call(env, 'POST', '/api/v1/hosted/accounts/link', body);
  if (!r.ok) throw new Error(r.error);
  return { url: r.data?.url || null };
}

// ─── reads ───────────────────────────────────────────────────────

export async function getMyProfile(env) {
  const id = await accountId(env);
  const r = await call(env, 'GET', `/api/v1/users/me?account_id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getProfile(env, public_id) {
  if (!public_id) throw new Error('public_id required');
  const id = await accountId(env);
  const r = await call(env, 'GET', `/api/v1/users/${encodeURIComponent(public_id)}?account_id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  // Normalized on top of the raw payload: the old daemon exposed urn_id, and
  // downstream tools pass that straight back as profile_urn_id for dm/connect.
  return { ...d, urn_id: d.provider_id || null, public_id: d.public_identifier || public_id };
}

export async function getFeed(env, { count = 20 } = {}) {
  // Unipile has no home-feed endpoint; the nearest honest read is the
  // account owner's own recent posts.
  const id = await accountId(env);
  const me = await getMyProfile(env);
  const pid = me?.provider_id;
  if (!pid) throw new Error('could not resolve own provider_id for posts read');
  const r = await call(env, 'GET', `/api/v1/users/${encodeURIComponent(pid)}/posts?account_id=${encodeURIComponent(id)}&limit=${Math.min(Number(count) || 20, 100)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getLiCompany(env, universalName) {
  if (!universalName) throw new Error('universal_name required');
  const id = await accountId(env);
  const r = await call(env, 'GET', `/api/v1/linkedin/company/${encodeURIComponent(universalName)}?account_id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getLiCompanyJobs() {
  throw new Error('company job listings are not available through Unipile — use the company profile plus a people search instead');
}

export async function searchPeople(env, { keywords, limit = 10 }) {
  if (!keywords) throw new Error('keywords required');
  const id = await accountId(env);
  const r = await call(env, 'POST',
    `/api/v1/linkedin/search?account_id=${encodeURIComponent(id)}&limit=${Math.min(Number(limit) || 10, 100)}`,
    { api: 'classic', category: 'people', keywords });
  if (!r.ok) throw new Error(r.error);
  const items = (r.data?.items || []).map((it) => ({
    urn_id: it.id || it.provider_id || null,          // usable as profile_urn_id downstream
    public_id: it.public_identifier || null,
    name: it.name || [it.first_name, it.last_name].filter(Boolean).join(' ') || null,
    headline: it.headline || null,
    location: it.location || null,
    network_distance: it.network_distance || null,
  }));
  return { items, cursor: r.data?.cursor || null, count: items.length };
}

export async function listSentInvitations(env) {
  const id = await accountId(env);
  const r = await call(env, 'GET', `/api/v1/users/invite/sent?account_id=${encodeURIComponent(id)}&limit=100`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function listConversations(env, { limit = 25 } = {}) {
  const id = await accountId(env);
  const r = await call(env, 'GET', `/api/v1/chats?account_id=${encodeURIComponent(id)}&account_type=LINKEDIN&limit=${Math.min(Number(limit) || 25, 250)}`);
  if (!r.ok) throw new Error(r.error);
  const items = (r.data?.items || []).map((c) => ({
    id: c.id,
    attendee_provider_id: c.attendee_provider_id || null,
    name: c.name || null,
    timestamp: c.timestamp || null,
    unread_count: c.unread_count ?? 0,
  }));
  return { items, cursor: r.data?.cursor || null };
}

export async function getConversationMessages(env, conversation_urn, { limit = 25 } = {}) {
  if (!conversation_urn) throw new Error('conversation id required');
  const r = await call(env, 'GET', `/api/v1/chats/${encodeURIComponent(conversation_urn)}/messages?limit=${Math.min(Number(limit) || 25, 250)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getSentMessages(env, { since_ms } = {}) {
  const id = await accountId(env);
  const after = since_ms ? `&after=${encodeURIComponent(new Date(Number(since_ms)).toISOString())}` : '';
  const r = await call(env, 'GET', `/api/v1/messages?account_id=${encodeURIComponent(id)}&limit=250${after}`, null, { timeoutMs: 60000 });
  if (!r.ok) throw new Error(r.error);
  const items = (r.data?.items || []).filter((m) => m.is_sender === 1 || m.is_sender === true);
  return { items, cursor: r.data?.cursor || null };
}

// ─── writes (all through the Outbox) ─────────────────────────────

export async function sendDirectMessage(env, { profile_urn_id, body }, opts = {}) {
  if (!profile_urn_id || !body) throw new Error('profile_urn_id + body required');
  const log = await beginSend(env, {
    channel: 'li', kind: 'text', to_id: profile_urn_id, body,
    payload: { profile_urn_id },
    source: opts.source || 'operator', source_ref: opts.source_ref || null,
    parent_id: opts.parent_id || null, attempt: opts.attempt || 1,
  });
  try {
    const id = await accountId(env);
    const r = await call(env, 'POST', '/api/v1/chats', {
      account_id: id, attendees_ids: [profile_urn_id], text: body,
    }, { timeoutMs: 60000 });
    if (!r.ok) throw new Error(r.error);
    // 201 with a null message_id means Unipile accepted nothing — treat as a
    // real failure so it logs failed rather than a phantom "sent".
    const message_id = r.data?.message_id || null;
    const chat_id = r.data?.chat_id || null;
    if (!message_id && !chat_id) throw new Error('Unipile returned no chat/message id — not delivered');
    await markSent(env, log.id, { message_id: message_id || chat_id });
    return { ok: true, id: message_id, chat_id, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export const sendLinkedInMessage = sendDirectMessage;

export async function sendConnectionRequest(env, { profile_urn_id, note = null }, opts = {}) {
  if (!profile_urn_id) throw new Error('profile_urn_id required');
  const log = await beginSend(env, {
    channel: 'li', kind: 'connect', to_id: profile_urn_id, body: note || '(no note)',
    payload: { profile_urn_id },
    source: opts.source || 'operator', source_ref: opts.source_ref || null,
    parent_id: opts.parent_id || null, attempt: opts.attempt || 1,
  });
  try {
    const id = await accountId(env);
    const payload = { account_id: id, provider_id: profile_urn_id };
    if (note) payload.message = String(note).slice(0, 300); // LinkedIn cap
    const r = await call(env, 'POST', '/api/v1/users/invite', payload, { timeoutMs: 60000 });
    if (!r.ok) throw new Error(r.error);
    const invitation_id = r.data?.invitation_id || null;
    if (!invitation_id) throw new Error('Unipile returned no invitation_id — invite not sent');
    await markSent(env, log.id, { message_id: invitation_id });
    return { ok: true, invitation_id, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export async function postText(env, { body }, opts = {}) {
  if (!body) throw new Error('body required');
  const log = await beginSend(env, {
    channel: 'li', kind: 'post', to_id: 'feed', body,
    source: opts.source || 'operator', source_ref: opts.source_ref || null, attempt: opts.attempt || 1,
  });
  try {
    const id = await accountId(env);
    // Unipile's posts endpoint takes multipart form-data.
    const r = await call(env, 'POST', '/api/v1/posts', { account_id: id, text: body }, { timeoutMs: 60000, form: true });
    if (!r.ok) throw new Error(r.error);
    await markSent(env, log.id, { message_id: r.data?.post_id || null });
    return { ok: true, post_id: r.data?.post_id || null, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

export async function reactToPost(env, { post_url, post_id = null, reaction = 'LIKE' }) {
  // Accept either a bare post id/urn or a full LinkedIn URL with an activity id.
  let target = post_id;
  if (!target && post_url) {
    const m = String(post_url).match(/activity[:-](\d+)/);
    target = m ? `urn:li:activity:${m[1]}` : post_url;
  }
  if (!target) throw new Error('post_id or post_url required');
  const id = await accountId(env);
  const map = { LIKE: 'like', CELEBRATE: 'celebrate', SUPPORT: 'support', LOVE: 'love', INSIGHTFUL: 'insightful', FUNNY: 'funny' };
  const r = await call(env, 'POST', '/api/v1/posts/reaction', {
    account_id: id, post_id: target, reaction_type: map[String(reaction).toUpperCase()] || 'like',
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}
