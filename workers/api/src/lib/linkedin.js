// LinkedIn — proxy from the Cloudflare worker to the local LinkedinGateway
// daemon (~/LinkedinGateway/, port 2786 by default). Mirrors the wa-gateway
// pattern in whatsapp.js: probe, ensureReady, then a small set of high-level
// helpers (profile, feed, messages, send DM, post text).
//
// The gateway is hybrid — voyager API for fast reads + DMs, headless
// Chromium (Playwright) for posts + reactions. Nyyon doesn't care which side
// handles a request; it just calls the gateway's REST surface.
//
// Recovery + session etiquette lives in the `linkedin-endpoints` knowledge
// doc. Tooling clients should call probeLinkedIn() before any real work so
// the operator sees clear "needs cookies" errors instead of HTTP 500s.

import { beginSend, markSent, markFailed } from './outbox.js';
import { withResolvedCredentials } from './gateway-config.js';

function baseUrl(env) {
  return (env.LI_BASE_URL || 'http://127.0.0.1:2786').replace(/\/+$/, '');
}

function headers(env) {
  // No fallback key. This used to send a literal 'dev-admin-key' whenever
  // LI_API_KEY was unset, which meant a gateway left on its own default was
  // reachable by anything that knew the string — and the string was in the
  // source. An unset key must fail as unauthenticated, not quietly succeed
  // against a shared secret.
  return {
    'X-API-Key':    env.LI_API_KEY || '',
    'Content-Type': 'application/json',
  };
}

// Low-level: GET with consistent error shape, ms-level timing tag for the
// activity feed.
async function call(env, method, path, body = null, { timeoutMs = 20000 } = {}) {
  // The single funnel to the daemon, so the only place LI_BASE_URL/LI_API_KEY
  // need to become DB-first (lib/gateway-config.js). No-op on an env install.
  env = await withResolvedCredentials(env);
  const url = baseUrl(env) + path;
  // Bounded timeout so a wedged gateway (esp. the Playwright posting path) can
  // never hang the caller — it ALWAYS resolves to a result Nyo can act on.
  const init = { method, headers: headers(env), signal: AbortSignal.timeout(timeoutMs) };
  if (body !== null) init.body = JSON.stringify(body);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /abort|timeout/i.test(String(e?.message || ''));
    return {
      ok: false, http: 0, timedOut,
      error: timedOut ? `gateway timeout after ${timeoutMs}ms (Playwright path can wedge)` : `gateway unreachable: ${String(e?.message || e)}`,
      ms: Date.now() - started,
    };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON, keep raw */ }
  if (!res.ok) {
    const errMsg = json?.detail?.error || json?.error || text?.slice(0, 300) || res.statusText;
    return { ok: false, http: res.status, error: errMsg, ms };
  }
  return { ok: true, http: res.status, data: json, ms };
}

// ─── probe + session prime ───────────────────────────────────────

export async function probeLinkedIn(env) {
  env = await withResolvedCredentials(env); // report what the funnel will use
  const url = baseUrl(env);
  const key = !!env.LI_API_KEY;
  const health = await call(env, 'GET', '/api/health');
  if (!health.ok) {
    return { url, api_key_configured: key, reachable: false, http: health.http, ready: false, cookies_loaded: false, profile: null, error: health.error };
  }
  const sess = await call(env, 'GET', '/api/session');
  return {
    url,
    api_key_configured: key,
    reachable: true,
    http: sess.http,
    cookies_loaded: !!sess.data?.cookies_loaded,
    cookie_age_seconds: sess.data?.cookie_age_seconds ?? null,
    ready: !!sess.data?.ready,
    profile: sess.data?.profile || null,
    error: sess.ok ? null : sess.error,
  };
}

export async function setLinkedInCookies(env, { li_at, JSESSIONID, user_agent = null }) {
  if (!li_at || !JSESSIONID) throw new Error('li_at + JSESSIONID required');
  const r = await call(env, 'POST', '/api/session/cookies', { li_at, JSESSIONID, user_agent });
  if (!r.ok) throw new Error(r.error || `gateway ${r.http}`);
  return r.data;
}

// Mirrors ensureSessionReady in whatsapp.js: if the gateway has cookies but
// reports `ready=false`, surface that to the caller cleanly. Nothing to
// auto-fix here — the operator must re-capture cookies.
async function ensureReady(env) {
  const p = await probeLinkedIn(env);
  if (!p.reachable) throw new Error(`linkedin gateway unreachable at ${p.url}: ${p.error || ''}`);
  if (!p.cookies_loaded) throw new Error('no linkedin cookies — POST /api/li/cookies first (see linkedin-endpoints doc)');
  if (!p.ready) throw new Error(`linkedin session not ready: ${p.error || 'voyager rejected cookies — likely expired'}`);
  return p;
}

// ─── voyager reads ────────────────────────────────────────────────

export async function getMyProfile(env) {
  await ensureReady(env);
  const r = await call(env, 'GET', '/api/me');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// All PENDING sent connection invitations. The funnel diffs our recorded
// invitation urns against this list — one of ours no longer pending means the
// invite was accepted (or withdrawn by hand). No per-profile lookups (dead).
export async function listSentInvitations(env) {
  await ensureReady(env);
  const r = await call(env, 'GET', '/api/invitations/sent');
  if (!r.ok) throw new Error(r.error);
  if (r.data && r.data.ok === false) throw new Error(r.data.error || 'invitation list failed');
  return r.data;
}

export async function getProfile(env, public_id) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/profile/${encodeURIComponent(public_id)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getFeed(env, { count = 20 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/feed?count=${count}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Company profile + numeric LinkedIn id by universal name (slug). One throttled
// Voyager read — the GTM module caches the id on the lead so it never repeats.
export async function getLiCompany(env, universalName) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/company/${encodeURIComponent(universalName)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data; // { company_id, name, universal_name, staff_count, url }
}

// Open roles via the gateway's public guest-jobs passthrough (no session cookie;
// runs from the gateway's residential IP because datacenter IPs get blocked).
export async function getLiCompanyJobs(env, companyId) {
  const r = await call(env, 'GET', `/api/company/${encodeURIComponent(companyId)}/jobs`);
  if (!r.ok) throw new Error(r.error);
  return r.data; // { positions: [{title,location,url,posted_at}], count, company_id }
}

// Confirm a freshly-published post is actually LIVE by reading it back from the
// feed via Voyager (the reliable API path). post_linkedin_text drives Playwright
// and can report success while silently failing — or error while actually
// having posted — so we never trust it blind; we verify against the feed.
async function verifyPostLive(env, body) {
  try {
    const feed = await call(env, 'GET', '/api/feed?count=25', null, { timeoutMs: 15000 });
    if (!feed.ok) return { found: false, url: null };
    const d = feed.data;
    const items = d?.items || d?.posts || d?.elements || (Array.isArray(d) ? d : []);
    const needle = String(body).trim().slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    if (needle.length < 12) return { found: false, url: null };
    for (const it of (Array.isArray(items) ? items : [])) {
      const hay = JSON.stringify(it).toLowerCase().replace(/\s+/g, ' ');
      if (hay.includes(needle)) {
        return { found: true, url: it.url || it.permalink || it.post_url || it.share_url || null };
      }
    }
    return { found: false, url: null };
  } catch { return { found: false, url: null }; }
}

export async function listConversations(env, { limit = 25 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/conversations?limit=${limit}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getConversationMessages(env, conversation_urn, { limit = 25 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/conversations/${encodeURIComponent(conversation_urn)}/messages?limit=${limit}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Messages the operator SENT since since_ms (ms epoch) — the outreach-KPI feed
// for manual LinkedIn DMs the engine never recorded. Returns { ok, messages, count }.
export async function getSentMessages(env, { since_ms, max_convos = 20 } = {}) {
  await ensureReady(env);
  // Slow read: the daemon makes one LinkedIn round-trip per active conversation,
  // so give it generous headroom (well past the default 20s).
  const r = await call(env, 'GET', `/api/sent-messages?since_ms=${Number(since_ms) || 0}&max_convos=${max_convos}`, null, { timeoutMs: 120000 });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function searchPeople(env, { keywords, limit = 10 }) {
  if (!keywords) throw new Error('keywords required');
  await ensureReady(env);
  const r = await call(env, 'POST', '/api/search/people', { keywords, limit });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// ─── voyager writes ──────────────────────────────────────────────

export async function sendDirectMessage(env, { profile_urn_id, body }, opts = {}) {
  if (!profile_urn_id || !body) throw new Error('profile_urn_id + body required');
  const log = await beginSend(env, {
    channel: 'li', kind: 'text', to_id: profile_urn_id, body,
    payload: { profile_urn_id },
    source:     opts.source     || 'operator',
    source_ref: opts.source_ref || null,
    parent_id:  opts.parent_id  || null,
    attempt:    opts.attempt    || 1,
  });
  try {
    await ensureReady(env);
    // 60s, not the 20s default: the gateway's message throttle sleeps up to
    // ~21s (15s interval + jitter) for LinkedIn-safe spacing BEFORE the send.
    // A 20s client timeout aborted mid-spacing, and on a multi-bubble message
    // that stranded a partial send (some bubbles delivered, then a timeout).
    const r = await call(env, 'POST', '/api/messages/send', { profile_urn_id, body }, { timeoutMs: 60000 });
    if (!r.ok) throw new Error(r.error);
    // HTTP 200 is NOT proof of delivery — Voyager returns { ok:false } when
    // LinkedIn rejected the send. Trusting only r.ok logged failed sends as
    // "sent" (caught live: a DM that never arrived showed sent). Treat a
    // business-level ok:false as a real failure so it logs failed + retries.
    // Propagate the gateway's REAL reason — the failure classifier keys off it
    // (e.g. "not connected" vs a hard rejection). A generic message here made
    // every business failure look identical downstream.
    if (r.data && r.data.ok === false) throw new Error(r.data.error || 'LinkedIn did not accept the message (gateway ok:false) — not delivered');
    await markSent(env, log.id, { message_id: r.data?.id || r.data?.urn || null });
    return { ...(r.data || {}), outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// Alias used by outbox retry — keeps the public surface stable while we
// settle on a single name across channels.
export const sendLinkedInMessage = sendDirectMessage;

export async function sendConnectionRequest(env, { profile_urn_id, note = null, profile_urn = null }, opts = {}) {
  if (!profile_urn_id) throw new Error('profile_urn_id required');
  // Log to the Outbox like DMs do, so EVERY LinkedIn send (connect + message)
  // is in the unified audit trail with sent/failed + retry.
  const log = await beginSend(env, {
    channel: 'li', kind: 'connect', to_id: profile_urn_id, body: note || '(no note)',
    payload: { profile_urn_id, note },
    source: opts.source || 'operator', source_ref: opts.source_ref || null,
  });
  try {
    await ensureReady(env);
    // Forward profile_urn (the member urn from intake) so the gateway skips the
    // now-dead (HTTP 410) profile lookup that add_connection would otherwise do.
    const r = await call(env, 'POST', '/api/connections/request', { profile_urn_id, note, profile_urn });
    if (!r.ok) throw new Error(r.error);
    // Same guard as DMs: don't call a request "sent" if the gateway reports a
    // business-level failure. (The connect endpoint currently always returns
    // ok:true, so it can't yet detect a silently-rejected request — surfacing
    // that real result is a gateway-side follow-up.)
    // Propagate the gateway's REAL reason — the failure classifier keys off it
    // ("no invitation"/"already"/"CANT_RESEND" → already_invited, not a retry).
    if (r.data && r.data.ok === false) throw new Error(r.data.error || 'LinkedIn did not accept the connection request (gateway ok:false)');
    await markSent(env, log.id, { message_id: r.data?.id || r.data?.urn || null });
    return { ...(r.data || {}), outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// ─── Playwright writes ──────────────────────────────────────────

export async function postText(env, { body, visibility = 'ANYONE' }, opts = {}) {
  if (!body || !body.trim()) throw new Error('body required');
  await ensureReady(env);

  // Log the attempt to the Outbox so "did it post?" is answerable from the
  // record, not from memory.
  const log = await beginSend(env, {
    channel: 'li', kind: 'post', to_id: 'feed', to_name: 'LinkedIn feed',
    body, payload: { visibility },
    source: opts.source || 'nyo', source_ref: opts.source_ref || null,
  });

  // Playwright path — slow + can wedge. Bounded at 60s so it always returns,
  // then CONFIRM via the reliable Voyager feed whether the post is actually live.
  const r = await call(env, 'POST', '/api/posts/text', { body, visibility }, { timeoutMs: 60000 });
  const verify = await verifyPostLive(env, body);

  const posted   = r.ok || verify.found;   // live if the gateway said ok OR we see it in the feed
  const verified = verify.found;           // we actually read it back
  const post_url = verify.url || r.data?.url || null;

  if (posted) {
    await markSent(env, log.id, { message_id: post_url || null });
    return {
      ok: true, posted: true, verified, post_url, outbox_id: log.id,
      note: verified
        ? 'Confirmed live — read back from the feed.'
        : (r.ok
            ? 'Gateway reported success but the post is NOT yet visible in the feed. Treat as PENDING — do not claim it is live until confirmed.'
            : 'Gateway errored but the post appears in the feed. Verify the link before relying on it.'),
    };
  }

  // Genuine failure: errored/timed out AND not visible in the feed.
  const errMsg = r.error || 'post failed';
  await markFailed(env, log.id, new Error(errMsg));
  return { ok: false, posted: false, verified: false, timedOut: !!r.timedOut, error: errMsg, outbox_id: log.id };
}

export async function reactToPost(env, { post_url, reaction = 'LIKE' }) {
  if (!post_url) throw new Error('post_url required');
  await ensureReady(env);
  const r = await call(env, 'POST', '/api/posts/react', { post_url, reaction });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
