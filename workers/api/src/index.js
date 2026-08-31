// Nyyon Command Center — Hono router + Nyo SSE chat.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  recentEvents,
  listKnowledge, readKnowledge, writeKnowledge, deleteKnowledge, readKnowledgePath,
  queueNyoMessage, listPendingNyoMessages, markNyoMessageDelivered, recentNyoMessages,
  logEvent,
  listCalendarEvents, readCalendarEvent, upsertCalendarEvent, deleteCalendarEvent,
  CALENDAR_KINDS, CALENDAR_STATUSES,
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns, logWorkflowRun,
  listSections, patchSection, upsertSection, reorderSections, deleteSection,
  listFlags, setFlag,
} from './lib/db.js';
import { runWakeUp } from './lib/wake-up.js';
import { ttsConfigured, synthesize } from './lib/tts-gateway.js';
import {
  // Everything the WhatsApp family covers now goes through the pool; what is
  // left here has no tool: the legacy inbound webhook, the chat-policy patch
  // (set_chat_listening only covers the digest listener flag), the message
  // reader, the gateway probes/test-sends and the pull-sync.
  handleInbound, setChatPolicy, recentMessages,
  probeWaGateway, registerWebhook, testInbound, checkWaHealth,
  sendTestText, sendTestReply,
  syncFromGateway,
} from './lib/whatsapp.js';
import { handleChat } from './chat/index.js';
// GTM (Prospecting + Outreach) ships as a plugin now; the theorg probe stays
// host because the theorg gateway is host infrastructure (lib/enrich-gateways.js).
import { probeTheorg } from './lib/enrich-gateways.js';
import { runTool } from './tools/index.js';
import { callGateway } from './gateways/index.js';
import { runWorkflow } from './workflows/runner.js';
import { getLlmHealth } from './lib/llm.js';
import { listConversations, readConversation, renameConversation, deleteConversation } from './lib/conversations.js';
import { gate, handleGateLogin, handleGateLogout, issueGateSession, hasGateSession } from './gate.js';
// First-run setup. The install store is the security boundary (how far has this
// copy been claimed?); lib/onboarding.js is the conversation engine and the
// only thing the routes below talk to.
import { readInstallState, updateAdminCredentials, verifySetupAccess } from './lib/install.js';
import {
  onboardingState, onboardingTranscript, runOnboardingTurn,
  onboardingGateways, connectOnboardingGateway, saveAndVerifyLlmKey,
  createOperatorAccount, finishSetup, postponeSetup, reopenSetup,
} from './lib/onboarding.js';
import { devListRegistry, devInvokeTool, devInvokeGateway, devInvokeWorkflow } from './lib/dev-invoke.js';
// What each module needs before it is worth opening (the prerequisite table).
import { moduleStatus, allModuleStatus } from './lib/module-prereqs.js';
// Credentials an operator saved live in D1, not in env — a Worker cannot write
// its own secrets. The health panel has to read them the same way.
import { withResolvedCredentials } from './lib/gateway-config.js';

const app = new Hono();
app.use('*', cors());

// Build stamp — surfaces the deployed build on every response (incl. the login
// page, pre-auth) as `X-Nyyon-Build`, so a push can be verified live with a
// `curl -I` against the deployed worker. Runs before the gate; only tags the
// response after the chain, so it has no effect on auth.
//   BUILD_SHA is injected at deploy time by the GitHub Action via
//   `wrangler deploy --define BUILD_SHA:'"<git-sha>"'` (esbuild replaces the
//   token in-bundle). The typeof-guard falls back to 'dev' for local `wrangler
//   dev`, where the token is never defined.
const BUILD = (typeof BUILD_SHA === 'string') ? BUILD_SHA : 'dev';
app.use('*', async (c, next) => { await next(); c.header('X-Nyyon-Build', BUILD); });

// Auth gate — must run before every route. Unauthenticated requests get the
// login page (navigations) or 401 (/api). The single credential + rate limit
// live in gate.js; the password is a Cloudflare secret, not in this repo.
app.use('*', gate());
app.post('/__gate/login', handleGateLogin);
app.post('/__gate/logout', handleGateLogout);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ─── first-run setup ──────────────────────────────────────────
// The sequence a new operator walks: their account (a form — it creates the
// login and signs them in), the model key, then Nyo's voice interview, then
// services. Only the FIRST of those happens before there is a session; the
// rest happen inside the app, signed in.
//
// gate.js decides who reaches this prefix at all (exempt before an account
// exists, cookie-gated after, 404 once setup is complete). Every handler then
// authorizes itself through verifySetupAccess, which applies the SAME rule
// from the other side, so a routing mistake in one file cannot open the other.
function setupToken(c) {
  // Header first. The query fallback exists only for a local `curl` and the
  // installer's own redirect; a token in a URL leaks into logs and history.
  return c.req.header('X-Setup-Token') || c.req.query('setup_token') || '';
}
async function hasSetupAccess(c) {
  return verifySetupAccess(c.env, {
    token: setupToken(c),
    host: c.req.header('Host') || new URL(c.req.url).host,
    // After step one this is the ONLY thing that counts. Before it, it is
    // false and irrelevant.
    session: await hasGateSession(c),
  }).catch(() => false);
}
async function requireSetupAccess(c) {
  const st = await readInstallState(c.env).catch(() => null);
  if (!st || st.setup_complete) return c.json({ error: 'not found' }, 404);
  if (!(await hasSetupAccess(c))) {
    // An account exists and the caller has no session: that is a sign-in
    // problem, not a "wrong machine" problem, and 401 is what makes the SPA
    // show the door instead of a dead end.
    return c.json({ error: 'setup access denied' }, st.has_admin ? 401 : 403);
  }
  return null;   // allowed
}

// Deliberately UNGUARDED: the SPA has to know which boot screen to render
// before anyone has proved anything. The unproven answer carries only how far
// this install has been claimed (account yet? setup finished?) — the
// interview's CONTENTS (company, audience, which gateways are wired) need
// setup access, because on a publicly reachable fresh deploy this endpoint is
// world-readable.
app.get('/api/onboarding/state', async (c) => c.json(
  await onboardingState(c.env, { detail: await hasSetupAccess(c) }),
));

// STEP ONE, and the reason the whole sequence was reordered: the account, as a
// plain form, with no model and no interview in front of it. It creates the
// credential, burns the setup token, and signs them straight in — the rest of
// setup then runs as the signed-in operator.
//
// It does NOT finish setup. /api/onboarding/finish does.
app.post('/api/onboarding/account', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const r = await createOperatorAccount(c.env, { username: body?.username, password: body?.password });
    await issueGateSession(c, r.username);
    return c.json({ ok: true, username: r.username, signed_in: Boolean(c.env.GATE_SECRET) });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// Going BACK from a later setup step. The account itself cannot be un-created,
// so "back" means CHANGE it: an operator who mistyped their username on the
// first screen rewrites it here rather than living with it. Behind the session
// gate via requireSetupAccess, which after an account exists means the cookie
// and nothing else.
app.post('/api/onboarding/account/update', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const r = await updateAdminCredentials(c.env, { username: body?.username, password: body?.password });
    // Re-issue the cookie: it carries the username, and the old one would name
    // an account that no longer exists.
    await issueGateSession(c, r.username);
    return c.json({ ok: true, username: r.username, signed_in: Boolean(c.env.GATE_SECRET) });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// The stored transcript — what makes a browser refresh RESUME the interview.
app.get('/api/onboarding/transcript', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  return c.json(await onboardingTranscript(c.env));
});

// One turn of the setup conversation. Not SSE: this loop calls the llm gateway
// (json mode) rather than the raw streaming transport, so a turn is one
// request/response and the UI stays a plain fetch.
app.post('/api/onboarding/chat', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  if (body?.messages !== undefined && !Array.isArray(body.messages)) {
    return c.json({ error: 'messages must be an array' }, 400);
  }
  try {
    return c.json(await runOnboardingTurn(c.env, { messages: body?.messages || [] }));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// Step one of setup, and the only one that cannot be a conversation: the
// interview is itself an LLM call, so with no model key there is nothing to
// talk to. The key is verified with a real request before we accept it —
// letting a typo through would strand the operator on a chat that silently
// never answers.
app.post('/api/onboarding/llm-key', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const r = await saveAndVerifyLlmKey(c.env, { key: body?.key, provider: body?.provider || 'anthropic' });
  return r.ok ? c.json(r) : c.json(r, 400);
});

app.get('/api/onboarding/gateways', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  return c.json(await onboardingGateways(c.env));
});

app.post('/api/onboarding/gateways', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  if (!body?.slug) return c.json({ error: 'slug required' }, 400);
  try {
    return c.json(await connectOnboardingGateway(c.env, String(body.slug), body.config || {}));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// THE LAST STEP: setup is finished. This is the write that closes
// verifySetupAccess permanently, so every route in this section stops
// answering after it. The account already exists — nothing here touches a
// credential.
app.post('/api/onboarding/finish', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await finishSetup(c.env, { reason: body?.reason }));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// "Later." Not the same write: postponing must leave the surface alive, or
// the offer to resume is a lie. Boot sends them into the app, and the app
// carries a banner back to here.
app.post('/api/onboarding/defer', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  try {
    return c.json(await postponeSetup(c.env));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// Coming back to it from the banner or from Settings.
app.post('/api/onboarding/resume', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  try {
    return c.json(await reopenSetup(c.env));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// Reachability probe for a local-service gateway (WhatsApp, LinkedIn, website…).
// The deployed worker runs in Cloudflare's cloud, so a gateway on localhost is
// UNREACHABLE — the real fix is a public tunnel. The note says that explicitly
// instead of telling the operator to "open localhost" (which never works here).
async function probeGateway(name, baseUrl, envVar, { headers = {}, deployed = false } = {}) {
  const url = (baseUrl || '').replace(/\/$/, '');
  if (!url) {
    return { name, status: 'yellow', severity: 'degraded',
      note: `not configured — give it a public tunnel (like wa-gateway) and set ${envVar} to that URL` };
  }
  const isLocal = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(url);
  const tunnelNote = `${envVar} is localhost (${url}) — the deployed worker can't reach it; expose it with a tunnel like wa-gateway and point ${envVar} there`;
  // A localhost gateway is unreachable from the DEPLOYED worker no matter what a
  // probe returns (Cloudflare may answer loopback fetches itself) — flag it up
  // front with the real fix rather than trusting a misleading response.
  if (deployed && isLocal) {
    return { name, status: 'yellow', severity: 'degraded', note: tunnelNote };
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status < 500) return { name, status: 'green', severity: 'degraded', note: null };
    return { name, status: 'yellow', severity: 'degraded', note: `HTTP ${r.status} from ${url} — gateway up but erroring` };
  } catch {
    return { name, status: 'yellow', severity: 'degraded',
      note: isLocal ? tunnelNote : `unreachable at ${url} — the gateway or its tunnel is down` };
  }
}

// ─── Aggregated system health ─────────────────────────────────
// Used by the sidebar status dot. Returns an overall traffic-light status
// plus per-check breakdown so the operator can see what's wrong on hover.
//   green  — everything green
//   yellow — at least one non-critical check is degraded
//   red    — a mission-critical check is failing
app.get('/api/system/health', async (c) => {
  const checks = [];
  // D1-first credentials, exactly like every gateway call does
  // (gateways/index.js). Without this the health panel reads the raw bindings
  // and reports a key "not set" that the operator pasted into setup minutes
  // ago and that every real call is happily using — an install that works
  // while permanently displaying DOWN.
  const env = await withResolvedCredentials(c.env);
  // Deployed cloud worker vs local dev: localhost gateways are reachable in
  // dev but never from the deployed worker — the probe uses this.
  const deployed = !/^(localhost|127\.0\.0\.1)/.test((() => { try { return new URL(c.req.url).host; } catch { return ''; } })());

  // 1. DB — if we got here, the worker booted; assume reachable.
  let dbOk = false;
  try {
    const r = await env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = r?.ok === 1;
  } catch (e) {
    checks.push({ name: 'D1 database', status: 'red', severity: 'critical', note: String(e?.message || e).slice(0, 200) });
  }
  if (dbOk) checks.push({ name: 'D1 database', status: 'green', severity: 'critical', note: null });

  // 2. LLM provider — needed for digest/Nyo/anything reasoning. Critical.
  // Beyond "is the key set?", read the circuit-breaker's health row: when the
  // primary (Anthropic) runs out of credit or rejects the key, the breaker
  // opens, chat + light jobs fall back to the local model, and heavy writers
  // pause. Surface that as a distinct degraded state so the operator sees the
  // outage here (not just via the one-time Nyo message).
  const provider = (env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const keySet =
    provider === 'anthropic' ? !!env.ANTHROPIC_API_KEY :
    provider === 'openai'    ? !!env.OPENAI_API_KEY    :
    false;
  if (!keySet) {
    checks.push({
      name: `LLM provider · ${provider}`,
      status: 'red',
      severity: 'critical',
      // Remediation an operator of THIS product can actually act on. The old
      // text said "run: wrangler secret put …", which is how the deployed
      // cloud worker was configured and is meaningless in an installed app —
      // the key goes in through setup or Settings, and is stored in D1.
      note: 'No model key yet — add one in Settings, under Nyo brain. Nothing that needs a model can run until you do.',
    });
  } else {
    const h = await getLlmHealth(env);
    const down = h.status === 'down';
    const mins = down && h.since ? Math.max(1, Math.round((Date.now() - h.since) / 60000)) : null;
    const why = h.reason === 'auth' ? 'rejecting the API key' : 'out of credit';
    // Real, live model data (the llm-models doc / Settings editor — not the
    // static provider name) so this actually says which model is running.
    const { loadModelConfig } = await import('./lib/model-config.js');
    const models = await loadModelConfig(env);
    const usingFallback = down && !!models.writer_fallback;
    checks.push({
      name: `LLM · ${down ? (usingFallback ? models.writer_fallback : models.nyo_mid) : models.nyo_mid}`,
      status: down ? (usingFallback ? 'yellow' : 'yellow') : 'green',
      severity: 'critical',
      note: down
        ? `Primary (${models.nyo_mid}) ${why}${mins ? ` (~${mins} min)` : ''} — chat fell back to ${models.nyo_low}. ${usingFallback ? `Heavy writers (AEO, GTM outreach) are running on the fallback writer ${models.writer_fallback}.` : 'Heavy writers (AEO, GTM outreach) are PAUSED — set a Fallback writer in Settings to keep them running.'} ${h.reason === 'auth' ? 'Fix ANTHROPIC_API_KEY' : 'Top up Anthropic credit'} and it recovers automatically.`
        : `Nyo tiers: low=${models.nyo_low} · mid=${models.nyo_mid} · high=${models.nyo_high}. Writers: ${models.writer}${models.writer_fallback ? ` (fallback: ${models.writer_fallback})` : ' (no fallback set)'}.`,
    });
  }

  // 3. WA gateway + session — degraded (not critical) since Nyyon still
  //    works without WhatsApp; just the digest's WA channel goes silent.
  // All URLs derive from the configured WA_BASE_URL (the online gateway tunnel),
  // so the notes point at the REAL gateway — not a hardcoded localhost port.
  const waBase   = (env.WA_BASE_URL || '').replace(/\/$/, '');
  const linkPage = waBase ? waBase.replace(/\/api$/, '') + '/link' : null;
  try {
    if (!waBase) throw new Error('WA_BASE_URL not set');
    // Through the gateway lib — auth/header/session logic lives ONLY there.
    const wa = await checkWaHealth(env);
    if (wa.error && /HTTP 401/.test(wa.error)) {
      checks.push({ name: 'WA gateway', status: 'yellow', severity: 'degraded',
        note: 'gateway rejected the key (401) — WA_API_KEY must match the gateway API_KEY' });
    } else if (wa.error) {
      checks.push({ name: 'WA gateway', status: 'yellow', severity: 'degraded',
        note: `${wa.error} — is the gateway + tunnel up?` });
    } else {
      checks.push({
        name: `WhatsApp session · ${wa.status}`,
        status: wa.ok ? 'green' : 'yellow',
        severity: 'degraded',
        note: wa.ok ? null
          : `not linked — open ${linkPage} on the gateway machine and scan the QR`,
      });
    }
  } catch (e) {
    checks.push({ name: 'WA gateway', status: 'yellow', severity: 'degraded',
      note: `unreachable at ${waBase || '(WA_BASE_URL unset)'} — is the gateway + tunnel up?` });
  }

  // 4. LinkedIn gateway — reachability only (real work also needs LI cookies,
  //    tracked separately). Same public-tunnel requirement as WhatsApp; not
  //    set up yet, so on the deployed worker this reports "needs a tunnel".
  try {
    // Through the pool (probe_linkedin → the linkedin gateway) — same
    // reachability check, one transport, and an exact pass-through of the probe
    // blob, so the reachable/error reads below are unchanged.
    const li = await runTool(env, 'probe_linkedin', {});
    checks.push({
      name: 'LinkedIn gateway', severity: 'degraded',
      status: li?.reachable ?? li?.ok ? 'green' : 'yellow',
      note: (li?.reachable ?? li?.ok) ? null : (li?.error || 'Unipile not configured — connect LinkedIn in Settings'),
    });
  } catch (e) {
    checks.push({ name: 'LinkedIn gateway', status: 'yellow', severity: 'degraded',
      note: `unreachable (${String(e?.message || e).slice(0, 80)})` });
  }

  // 5. Website — the operator's live public site (WEBSITE_BASE_URL).
  //    Publicly reachable, so a straight fetch works from the deployed
  //    worker — no tunnel needed.
  checks.push(await probeGateway('Website', env.WEBSITE_BASE_URL, 'WEBSITE_BASE_URL', { deployed }));

  // 6. Digest channels — any enabled channel whose last_status is 'error'
  //    is degraded. Skipped channels (disabled) don't count.
  try {
    const rows = await env.DB.prepare(
      "SELECT source, enabled, last_status FROM plugin_editorial_digest_channels WHERE enabled = 1",
    ).all();
    const bad = (rows.results || []).filter((r) => r.last_status === 'error');
    if (bad.length) {
      checks.push({
        name: `Digest channels (${bad.length} erroring)`,
        status: 'yellow',
        severity: 'degraded',
        note: bad.map((b) => b.source).join(', ') + ' — clears once the source gateway/session is live (fix the matching gateway check above)',
      });
    } else if ((rows.results || []).length === 0) {
      checks.push({ name: 'Digest channels', status: 'yellow', severity: 'degraded', note: 'no channels enabled' });
    } else {
      checks.push({ name: `Digest channels (${rows.results.length} on)`, status: 'green', severity: 'degraded', note: null });
    }
  } catch { /* plugin_editorial_digest_channels table may not exist yet — skip */ }

  // 7. OSINT sources (DuckDuckGo, Reddit, HN, GitHub, …) — surface per-source
  //    failures, and when the recorded error looks like rate-limiting, say so
  //    and what to do about it (rather than a bare "error").
  try {
    const rows = await env.DB.prepare(
      "SELECT source, last_status, last_error FROM plugin_editorial_osint_listeners WHERE enabled = 1",
    ).all();
    const results = rows.results || [];
    const bad = results.filter((r) => r.last_status === 'error');
    const isThrottle = (e) => /\b(429|403)\b|rate.?limit|throttl|too many|quota|blocked/i.test(String(e || ''));
    if (bad.length) {
      const detail = bad.map((b) => {
        const err = String(b.last_error || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return isThrottle(b.last_error) ? `${b.source}: throttled${err ? ` (${err})` : ''}` : `${b.source}: ${err || 'error'}`;
      }).join('; ');
      const throttled = bad.some((b) => isThrottle(b.last_error));
      checks.push({
        name: `OSINT sources (${bad.length} failing)`,
        status: 'yellow',
        severity: 'degraded',
        note: throttled
          ? `${detail} — being rate-limited; slow that source's throttle or pause it for a while`
          : detail,
      });
    } else if (results.length) {
      checks.push({ name: `OSINT sources (${results.length} on)`, status: 'green', severity: 'degraded', note: null });
    }
  } catch { /* plugin_editorial_osint_listeners table may not exist yet — skip */ }

  // 8. GTM gateways — the module's own external dependencies. WhatsApp +
  //    LinkedIn ride the shared gateway checks above (same servers — the GTM
  //    contact-lookup and company/jobs endpoints live on them). What's GTM-
  //    specific: theorg (org charts, public GraphQL, the Enrich tab's hard
  //    dependency) and the three OPTIONAL paid enrichment keys.
  try {
    // Through the theorg gateway probe — reachability only, never burns quota.
    const r = await probeTheorg(env);
    if (!r.ok) throw new Error(r.error || 'probe failed');
    checks.push({
      name: `GTM · theorg (org charts) · HTTP ${r.http}`,
      status: 'green', severity: 'degraded', note: null,
    });
  } catch (e) {
    checks.push({
      name: 'GTM · theorg (org charts)',
      status: 'yellow', severity: 'degraded',
      note: `unreachable (${String(e?.message || e).slice(0, 100)}) — Enrich-tab org charts + outreach org verification will fail`,
    });
  }
  {
    // Optional paid legs: configured-or-not only (a health check must never
    // burn paid API credits). Unset keys don't degrade the overall status —
    // the enrichment chain skips those legs gracefully — but they're listed
    // so the operator can see at a glance what's off.
    const gtmKeys = [
      ['PDL',     !!env.PDL_API_KEY,                                    'PDL_API_KEY'],
      ['SerpApi', !!env.SERPAPI_KEY,                                    'SERPAPI_KEY'],
      ['Twilio',  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),  'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN'],
    ];
    const unset = gtmKeys.filter(([, ok]) => !ok);
    checks.push({
      name: `GTM · enrichment keys (${gtmKeys.length - unset.length}/${gtmKeys.length} configured)`,
      status: 'green',
      severity: 'degraded',
      note: unset.length
        ? `optional — these legs skip until set: ${unset.map(([n, , s]) => `${n} (wrangler secret put ${s.split(' ')[0]})`).join(' · ')}`
        : null,
    });
  }

  // Roll up: red beats yellow beats green.
  const overall = checks.some((c) => c.status === 'red')    ? 'red'
                : checks.some((c) => c.status === 'yellow') ? 'yellow'
                : 'green';
  return c.json({ overall, checks, ts: Date.now() });
});

// ─── Nyo wake-up — proactive survey + catchup ───────────────
// Called by the Chat component on mount + tab refocus. Thin caller — the
// business rules (Sunday brain offer, stats survey, cadence gating, the
// once-per-day AEO autofire cap, outbox auto-retry) live in lib/wake-up.js,
// and the tunable thresholds live in the `wake-up-policy` knowledge doc.
//
// Body: { autofire?: boolean } — if true (default), missed AEO publish
// gets actually fired. If false, just reports what would be done.
app.post('/api/system/wake-up', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const autofire = body.autofire !== false; // default true
  const r = await runWakeUp(c.env, { autofire });
  return c.json(r.body, r.status);
});

// ─── Nyo pending messages (queue → chat injection) ───────────
// The Chat component polls /pending every 30s. Background workers
// (AEO writer, image generator, future cron tasks) queue assistant turns
// here via queueNyoMessage; the chat injects them + POSTs /deliver to clear.
app.get('/api/nyo/pending', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20', 10);
  // Piggyback: this 30s poll is the only steady local heartbeat, so it also
  // drives the meeting reminders. The gate is REQUIRED, not cosmetic: the
  // workflow's send_whatsapp step is mandatory (marking it optional would turn
  // a real delivery failure into a green run), so a tick with nothing due would
  // fail on "text required" and flood workflow_runs. list_due_meetings is
  // read-only and claims nothing, so gating on it has no side effects.
  c.executionCtx.waitUntil((async () => {
    const due = await runTool(c.env, 'list_due_meetings', {});
    if (due.due_meetings?.length) await runWorkflow(c.env, 'meeting-reminders', {}, { trigger_kind: 'poll' });
  })().catch(() => {}));
  return c.json({ messages: await listPendingNyoMessages(c.env, { limit }) });
});
app.post('/api/nyo/pending/:id/deliver', async (c) => {
  await markNyoMessageDelivered(c.env, c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/api/nyo/messages', async (c) => {
  // Full history surface (for an inbox-style view if we want one later).
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ messages: await recentNyoMessages(c.env, { limit }) });
});
app.post('/api/nyo/pending', async (c) => {
  // Manual queueing — handy for the scheduler.sh hook or for Nyo itself to
  // self-queue a follow-up message. Body: { content, kind?, ref_kind?, ref_id?, payload? }
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ queued: await queueNyoMessage(c.env, body) }, 201); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── Nyo brain config (which LLM provider + model is wired) ─
app.get('/api/nyo/brain', async (c) => {
  const provider = (c.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const { loadModelConfig, modelDefaults } = await import('./lib/model-config.js');
  const models = await loadModelConfig(c.env);
  const keySet =
    provider === 'anthropic' ? !!c.env.ANTHROPIC_API_KEY :
    provider === 'openai'    ? !!c.env.OPENAI_API_KEY    :
    false;
  return c.json({
    provider,
    model: models.writer,           // the background-writer brain (legacy field)
    key_set: keySet,
    models,                          // full per-surface map incl. source
    defaults: modelDefaults(c.env),  // env/coded fallbacks, for the Settings UI
  });
});
// Update the per-surface model map (writes the llm-models knowledge doc).
app.put('/api/nyo/models', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { saveModelConfig } = await import('./lib/model-config.js');
  try {
    const models = await saveModelConfig(c.env, body);
    await logEvent(c.env, { kind: 'llm_models_updated', actor: 'operator', payload: body });
    return c.json({ models });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── activity log ─────────────────────────────────────────────
app.get('/api/events', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  return c.json({ events: await recentEvents(c.env, limit) });
});

// ─── knowledge ────────────────────────────────────────────────
app.get('/api/knowledge', async (c) => c.json({ docs: await listKnowledge(c.env) }));
// Breadcrumb path root → … → :slug. UI uses this for the breadcrumb strip
// above the doc; Nyo uses it when answering "what context do I need to
// understand X" so it can read the whole chain in one shot.
app.get('/api/knowledge/:slug/path', async (c) => {
  return c.json({ path: await readKnowledgePath(c.env, c.req.param('slug')) });
});
app.get('/api/knowledge/:slug', async (c) => {
  const d = await readKnowledge(c.env, c.req.param('slug'));
  if (!d) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: d });
});
app.put('/api/knowledge/:slug', async (c) => {
  const body = await c.req.json();
  const slug = c.req.param('slug');
  if (!body?.title || body?.body === undefined) return c.json({ error: 'title + body required' }, 400);
  const d = await writeKnowledge(c.env, { ...body, slug });
  return c.json({ doc: d });
});
app.delete('/api/knowledge/:slug', async (c) => {
  await deleteKnowledge(c.env, c.req.param('slug'));
  return c.json({ ok: true });
});

// ─── blog + social-cards routes removed — Blog/AEO ships in the editorial
// plugin; its surfaces drive the plugin's own tools via
// /api/plugins/editorial/invoke/*. The R2 asset re-serving below stays: the
// image URLs are baked into published post bodies.

// ─── static assets served from R2 ─────────────────────────────
// The featured-image generator stores PNGs in the nyyon-assets bucket; we
// re-serve them at /assets/<key> so blog posts can use same-origin URLs.
// One-year immutable cache — the slug is in the path, regenerate overwrites
// the same key, browsers must hard-reload to see the new image (the ops
// "regenerate" button busts cache by appending ?t=<ts>).
app.get('/assets/blog/:filename', async (c) => {
  const key = `blog/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
    },
  });
});

// Article figures + covers live under blog-figures/ in the same bucket. In
// --local dev the public r2.dev URLs 404 (objects are in the local R2 sim), so
// the ops app rewrites figure URLs to this same-origin route to preview them.
app.get('/assets/blog-figures/:filename', async (c) => {
  const key = `blog-figures/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// Social cards live under social/ in the same bucket — same serving rules.
app.get('/assets/social/:filename', async (c) => {
  const key = `social/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
    },
  });
});

// ─── workflows (visibility into stitched pipelines + their runs) ──
app.get('/api/workflows', async (c) => {
  const source = c.req.query('source') || null;
  const status = c.req.query('status') || null;
  // Seed the code-logged system slugs before listing so their run history is
  // never orphaned on a fresh DB (idempotent INSERT OR IGNORE).
  const { seedSystemWorkflows } = await import('./workflows/runner.js');
  await seedSystemWorkflows(c.env).catch(() => {});
  return c.json({ workflows: await listWorkflows(c.env, { source, status }) });
});
app.get('/api/workflows/runs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ runs: await listWorkflowRuns(c.env, { limit }) });
});
app.get('/api/workflows/:slug', async (c) => {
  const w = await readWorkflow(c.env, c.req.param('slug'));
  if (!w) return c.json({ error: 'not found' }, 404);
  return c.json({ workflow: w });
});
app.get('/api/workflows/:slug/runs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ runs: await listWorkflowRuns(c.env, { workflow_slug: c.req.param('slug'), limit }) });
});
app.put('/api/workflows/:slug', async (c) => {
  const body = await c.req.json();
  try {
    // Same gate as the write_workflow tool: steps must reference live tools,
    // or the workflow only fails later at run time.
    const { validateWorkflowSteps } = await import('./workflows/runner.js');
    const problems = await validateWorkflowSteps(c.env, body.steps);
    if (problems.length) return c.json({ error: 'invalid steps', problems }, 400);
    return c.json({ workflow: await writeWorkflow(c.env, { ...body, slug: c.req.param('slug') }) });
  }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/workflows/:slug', async (c) => {
  await deleteWorkflow(c.env, c.req.param('slug'));
  return c.json({ ok: true });
});

// ─── calendar (central event store, any module writes here) ─
app.get('/api/calendar', async (c) => {
  const from   = c.req.query('from');
  const to     = c.req.query('to');
  const kind   = c.req.query('kind');
  const source = c.req.query('source');
  const limit  = parseInt(c.req.query('limit') || '1000', 10);
  const events = await listCalendarEvents(c.env, {
    from:   from ? parseInt(from, 10) : null,
    to:     to   ? parseInt(to,   10) : null,
    kind:   kind   || null,
    source: source || null,
    limit,
  });
  return c.json({ events });
});
app.get('/api/calendar/taxonomy', (c) => c.json({ kinds: CALENDAR_KINDS, statuses: CALENDAR_STATUSES }));
app.get('/api/calendar/events/:id', async (c) => {
  const e = await readCalendarEvent(c.env, c.req.param('id'));
  if (!e) return c.json({ error: 'not found' }, 404);
  return c.json({ event: e });
});
app.post('/api/calendar/events', async (c) => {
  const body = await c.req.json();
  try { return c.json({ event: await upsertCalendarEvent(c.env, body) }, 201); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.put('/api/calendar/events/:id', async (c) => {
  const body = await c.req.json();
  try { return c.json({ event: await upsertCalendarEvent(c.env, { ...body, id: c.req.param('id') }) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/calendar/events/:id', async (c) => {
  await deleteCalendarEvent(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ─── meeting reminders (WhatsApp self-message before meetings) ─
app.get('/api/reminders', async (c) => {
  const { upcomingReminders } = await import('./lib/reminders.js');
  const { settings, events } = await upcomingReminders(c.env);
  const recent = await c.env.DB.prepare(
    "SELECT kind, payload, created_at FROM events WHERE kind IN ('meeting_reminder_sent','meeting_reminder_failed') ORDER BY created_at DESC LIMIT 20",
  ).all();
  return c.json({
    settings,
    upcoming: events,
    recent: (recent.results || []).map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') })),
  });
});
app.put('/api/reminders', async (c) => {
  const { updateReminderSettings } = await import('./lib/reminders.js');
  try { return c.json({ settings: await updateReminderSettings(c.env, await c.req.json()) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/reminders/check', async (c) => {
  // Same gate as the poll: the workflow's mandatory send step would fail on
  // "text required" with nothing due, so an empty tick answers without a run.
  const due = await runTool(c.env, 'list_due_meetings', {});
  if (!due.due_meetings?.length) return c.json({ ...due, ran: false });
  return c.json(await runWorkflow(c.env, 'meeting-reminders', {}, { trigger_kind: 'manual' }));
});

// ─── Sunday Brain + AEO + article-figures routes removed — the whole
// editorial engine (brain, feedback/taste, question queue, suggestions,
// figures/covers) ships in the editorial plugin.

// ─── gtm (Prospecting + Outreach) ─────────────────────────────────────────────
// GTM routes removed — the module ships as the gtm plugin; its surfaces drive
// the plugin's own tools via /api/plugins/gtm/invoke/*.

// ─── daily planner (per-day plan + weekly objectives; operator + planner chat) ──
// Daily Planner routes removed — the module ships as a plugin; its surface
// drives the plugin's own tools via /api/plugins/daily-planner/invoke/*.

// ─── Hot Takes + Social routes removed — both ship in the editorial plugin;
// their page surfaces drive the plugin's own tools via
// /api/plugins/editorial/invoke/*.

// ─── LinkedIn (via Unipile — hosted sessions, hosted auth) ─
app.get('/api/li/probe', async (c) => c.json(await runTool(c.env, 'probe_linkedin', {})));
// Connecting an account is Unipile's hosted auth page: this returns the URL
// the operator opens. Cookie pasting is gone with the daemon it belonged to.
// ─── Plugins (trade capabilities between nyyon systems) ─────────────────
// Operator surface (gated): list / import / export / remove.
// Applier surface (bearer NYYON_APPLIER_KEY, exempted in gate.js):
// pending / applied / verify.
app.get('/api/plugins', async (c) => {
  const { listPlugins } = await import('./lib/plugins.js');
  return c.json({ plugins: await listPlugins(c.env) });
});
app.post('/api/plugins/import', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.manifest) return c.json({ ok: false, error: 'manifest required' }, 400);
  const { importPlugin } = await import('./lib/plugins.js');
  return c.json(await importPlugin(c.env, body.manifest, { actor: 'operator' }));
});
// A plugin package (.zip): manifest.json + real .mjs / .md files. The
// authoring form — editable and diffable — assembled back into the canonical
// manifest on import, so nothing downstream knows which form arrived.
// The primary import path: a SOURCE, not a file. A URL carries a version, can
// be re-fetched when the author ships a fix, and can be read before it is
// trusted — none of which a pasted blob or a zip on a desktop can do.
app.post('/api/plugins/import-url', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.url) return c.json({ ok: false, error: 'url required' }, 400);
  try {
    const { manifestFromUrl } = await import('./lib/plugin-package.js');
    const manifest = await manifestFromUrl(c.env, body.url, body.ref);
    const { importPlugin } = await import('./lib/plugins.js');
    const r = await importPlugin(c.env, manifest, { actor: 'operator' });
    return c.json({ ...r, source: manifest.origin });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});
// Bundled packs (the repo's plugins/ folders) are seeded by the APPLIER on
// boot with the install's own key — a fresh install comes up with its standard
// modules installed, no operator import step. Same pipeline as any import.
app.post('/api/plugins/import-bundled', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.manifest) return c.json({ ok: false, error: 'manifest required' }, 400);
  const { importPlugin } = await import('./lib/plugins.js');
  const existing = await c.env.DB.prepare('SELECT status, version FROM plugins WHERE name = ?')
    .bind(String(body.manifest?.name || '')).first().catch(() => null);
  // A blocked row may retry (environmental blocks heal), and a DIFFERENT
  // shipped version re-imports — that is how bundled packs update when the
  // install's checkout moves. Same version + settled status = nothing to do.
  if (existing && existing.status !== 'blocked'
      && String(existing.version) === String(body.manifest?.version || '')) {
    return c.json({ ok: true, skipped: `already ${existing.status} at ${existing.version}` });
  }
  const r = await importPlugin(c.env, body.manifest, { actor: 'bundled-seed' });
  return c.json(r);
});
app.post('/api/plugins/import-package', async (c) => {
  const buf = await c.req.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return c.json({ ok: false, error: 'no package uploaded' }, 400);
  if (buf.byteLength > 5_000_000) return c.json({ ok: false, error: 'package too large (5 MB limit)' }, 400);
  try {
    const { manifestFromZip } = await import('./lib/plugin-package.js');
    const manifest = await manifestFromZip(buf);
    const { importPlugin } = await import('./lib/plugins.js');
    return c.json(await importPlugin(c.env, manifest, { actor: 'operator' }));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});
app.get('/api/plugins/:name/package', async (c) => {
  const name = c.req.param('name');
  try {
    const { exportPlugin } = await import('./lib/plugins.js');
    const { packageFiles, writeZip } = await import('./lib/plugin-package.js');
    const zip = writeZip(packageFiles(await exportPlugin(c.env, name)));
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name}.nyyon-plugin.zip"`,
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 404);
  }
});
app.get('/api/plugins/:name/export', async (c) => {
  const { exportPlugin } = await import('./lib/plugins.js');
  try { return c.json(await exportPlugin(c.env, c.req.param('name'))); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 404); }
});
app.delete('/api/plugins/:name', async (c) => {
  const { removePlugin } = await import('./lib/plugins.js');
  try { return c.json(await removePlugin(c.env, c.req.param('name'))); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 404); }
});
app.get('/api/plugins/surfaces', async (c) => {
  const { pluginSurfaces } = await import('./lib/plugins.js');
  return c.json({ surfaces: await pluginSurfaces(c.env) });
});
app.post('/api/plugins/:name/invoke/:tool', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  const { invokePluginTool } = await import('./lib/plugins.js');
  const r = await invokePluginTool(c.env, c.req.param('name'), c.req.param('tool'), input);
  return c.json(r, r.ok ? 200 : 400);
});
app.get('/api/plugins/registry', async (c) => {
  const { pluginRegistry } = await import('./lib/plugins.js');
  return c.json({ plugins: await pluginRegistry(c.env) });
});
app.get('/api/plugins/pending', async (c) => {
  const { pendingMaterializations } = await import('./lib/plugins.js');
  return c.json(await pendingMaterializations(c.env));
});
app.post('/api/plugins/applied', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { markMaterialized } = await import('./lib/plugins.js');
  return c.json(await markMaterialized(c.env, body.name, { ok: !!body.ok, error: body.error || null }));
});
app.post('/api/plugins/cleaned', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { markCleaned } = await import('./lib/plugins.js');
  return c.json(await markCleaned(c.env, body.name));
});
app.post('/api/plugins/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { verifyPlugin } = await import('./lib/plugins.js');
  return c.json(await verifyPlugin(c.env, body.name));
});

// ─── Telegram (Nyo's direct line — inbound from the bundled poll service) ─
// Auth happens in gate.js (TELEGRAM_INBOUND_KEY bearer, timing-safe). The
// heavy work rides waitUntil so the poller gets its 200 immediately.
app.post('/api/telegram/inbound', async (c) => {
  const update = await c.req.json().catch(() => null);
  if (!update) return c.json({ ok: false, error: 'bad update' }, 400);
  const { handleTelegramInbound } = await import('./lib/nyo-telegram.js');
  c.executionCtx.waitUntil(handleTelegramInbound(c.env, update).catch((e) => console.error('[telegram-inbound]', e?.message || e)));
  return c.json({ ok: true });
});

app.post('/api/li/connect-link', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await callGateway(c.env, 'linkedin', 'connect_link', body)); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.get('/api/li/me',    async (c) => safeLi(c, () => runTool(c.env, 'read_my_linkedin_profile', {})));
app.get('/api/li/profile/:public_id', async (c) => safeLi(c, () => runTool(c.env, 'read_linkedin_profile', { public_id: c.req.param('public_id') })));
app.get('/api/li/feed',  async (c) => safeLi(c, () => runTool(c.env, 'get_linkedin_feed', { count: parseInt(c.req.query('count') || '20', 10) })));
app.get('/api/li/conversations', async (c) => safeLi(c, () => runTool(c.env, 'list_linkedin_dms', { limit: parseInt(c.req.query('limit') || '25', 10) })));
app.get('/api/li/conversations/:urn/messages', async (c) =>
  safeLi(c, () => runTool(c.env, 'read_linkedin_dm', { conversation_urn: c.req.param('urn'), limit: parseInt(c.req.query('limit') || '25', 10) })),
);
app.post('/api/li/search/people', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return safeLi(c, () => runTool(c.env, 'search_linkedin_people', { keywords: body?.keywords, limit: body?.limit }));
});
app.post('/api/li/messages/send', async (c) => {
  // NOTE the collision: `body` here is the parsed REQUEST, body.body is the
  // message text. Failures still throw (safeLi → 500) — that is the
  // no-false-sent guardrail; never soften it to ok:false.
  const body = await c.req.json().catch(() => ({}));
  return safeLi(c, () => runTool(c.env, 'send_linkedin_dm', { profile_urn_id: body?.profile_urn_id, body: body?.body, actor: 'operator' }));
});
app.post('/api/li/connections/request', async (c) => {
  // profile_urn must keep being forwarded: it is what lets the gateway skip the
  // dead (HTTP 410) profile lookup.
  const body = await c.req.json().catch(() => ({}));
  return safeLi(c, () => runTool(c.env, 'send_linkedin_connection', { profile_urn_id: body?.profile_urn_id, note: body?.note, profile_urn: body?.profile_urn, actor: 'operator' }));
});
app.post('/api/li/posts/text', async (c) => {
  // Pass-through of postText's full verdict {ok, posted, verified, post_url,
  // outbox_id, note|error}. This route must NEVER be made to throw on
  // posted:false — "gateway errored but the post is live" is a real outcome.
  const body = await c.req.json().catch(() => ({}));
  return safeLi(c, () => runTool(c.env, 'post_linkedin_text', { body: body?.body, visibility: body?.visibility, actor: 'operator' }));
});
app.post('/api/li/posts/react', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return safeLi(c, () => runTool(c.env, 'react_linkedin_post', { post_url: body?.post_url, reaction: body?.reaction, actor: 'operator' }));
});

async function safeLi(c, fn) {
  try { return c.json(await fn()); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
}

// ─── Heartbeat/OSINT routes removed — the awareness layer ships in the
// editorial plugin.

// ─── home_sections (per-section visibility + ordering) ───────
app.get('/api/sections', async (c) => {
  const page = c.req.query('page') || 'home';
  return c.json({ sections: await listSections(c.env, page) });
});
app.patch('/api/sections/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ section: await patchSection(c.env, c.req.param('id'), body) });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.put('/api/sections/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ section: await upsertSection(c.env, c.req.param('id'), body) });
});
app.post('/api/sections/reorder', async (c) => {
  const body = await c.req.json();
  const page = body?.page || 'home';
  try {
    return c.json({ sections: await reorderSections(c.env, page, body?.order || []) });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.delete('/api/sections/:id', async (c) => {
  const r = await deleteSection(c.env, c.req.param('id'));
  return c.json(r, r.ok ? 200 : 404);
});

// ─── feature flags ────────────────────────────────────────────
app.get('/api/feature-flags', async (c) => c.json({ flags: await listFlags(c.env) }));
app.put('/api/feature-flags/:key', async (c) => {
  const { value } = await c.req.json();
  await setFlag(c.env, c.req.param('key'), !!value);
  return c.json({ ok: true });
});


// ─── registry (live: gateways + Nyo tools + workflows + knowledge deps) ──
// Replaces the old hand-maintained modules/tools tables — derived from code.
// Gateway credentials AFTER setup. The /api/onboarding/* twins of these stop
// answering the moment onboarding completes, which would otherwise leave an
// operator with no way to connect a service they skipped, rotate a leaked key,
// or disconnect one (saving an empty value clears it). Both are safe for a
// signed-in operator: the status read never emits a secret value, and the save
// drops any key a gateway did not declare.
app.get('/api/gateways', async (c) => c.json(await onboardingGateways(c.env)));

app.post('/api/gateways', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.slug) return c.json({ error: 'slug required' }, 400);
  try {
    return c.json(await connectOnboardingGateway(c.env, String(body.slug), body.config || {}));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});


// ─── module prerequisites ─────────────────────────────────────────
// What a module needs before it is worth opening: the operator's own voice
// documents where a surface writes in their name, a connected gateway where it
// reaches a service. Setup stops at the model key now, so this is where the
// rest of it happens — at the moment the operator opens the thing that needs
// it, rather than in a corridor before they have seen the product.
//
// Ordinary session auth (gate.js), nothing special: this is an in-app read for
// a signed-in operator, not part of the setup surface. It never emits a secret
// value — the gateway fields come from listGatewayStatus, which reports a
// secret as "set", never as itself.
app.get('/api/modules/status', async (c) => c.json(await allModuleStatus(c.env)));

app.get('/api/modules/:slug/status', async (c) => {
  const s = await moduleStatus(c.env, c.req.param('slug'));
  return s ? c.json(s) : c.json({ error: 'unknown module' }, 404);
});

// ─── WhatsApp listener (shared wa-gateway) ────────────
// Pull-sync from the gateway (the WhatsApp source of truth) into the D1 cache.
// This replaces the old webhook-into-this-API path: nothing pushes to us — we
// call the gateway. Triggered by the wake-up, digest generation, and on demand.
app.post('/api/wa/sync', async (c) => c.json(await syncFromGateway(c.env)));
// Legacy inbound webhook — kept for compatibility but no longer the primary
// path (the gateway persists + we pull). Left gated; no webhook is registered to it.
app.post('/api/wa/inbound', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad json' }, 400);
  return c.json(await handleInbound(c.env, body));
});
// limit:500 because the tool caps at 50 by default and the Channels page
// renders the FULL chat list (the lib call it replaces had no cap).
app.get('/api/wa/chats', async (c) => c.json(await runTool(c.env, 'list_wa_chats', { limit: 500 })));
// Fuzzy find a WhatsApp chat/person by partial name or phone (chat names +
// sender pushnames + CRM names-by-phone). Powers the ops search + Nyo's find_wa_chat.
app.get('/api/wa/search', async (c) => {
  const q = c.req.query('q') || '';
  if (!q.trim()) return c.json({ error: 'q required' }, 400);
  return c.json(await runTool(c.env, 'find_wa_chat', { query: q, limit: Number(c.req.query('limit')) || 15 }));
});
// KEPT on lib setChatPolicy deliberately: the Channels UI also patches
// can_send and name, which set_chat_listening does not cover (the spec scopes
// it to the digest listener flag). Migrating the whole route would silently
// drop those two fields.
app.put('/api/wa/chats/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  return c.json({ chat: await setChatPolicy(c.env, id, body) });
});
app.get('/api/wa/messages', async (c) => {
  const chat_id = c.req.query('chat_id') || null;
  const limit   = parseInt(c.req.query('limit') || '200', 10);
  return c.json({ messages: await recentMessages(c.env, { chat_id, limit }) });
});

// ─── wa-gateway outbound (prime → poll → send sequence baked in) ─
app.post('/api/wa/send', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'send_whatsapp', { chatId: body.chatId, text: body.text })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/wa/send-image', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'send_whatsapp_image', { chatId: body.chatId, url: body.url, caption: body.caption })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/wa/send-document', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'send_whatsapp_document', { chatId: body.chatId, url: body.url, filename: body.filename, mimetype: body.mimetype })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/wa/react', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'react_whatsapp', { messageId: body.messageId, reaction: body.reaction })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});

// ─── wa-gateway connection management (ops Settings → WhatsApp) ─
app.get('/api/wa/probe', async (c) => c.json(await probeWaGateway(c.env)));
app.get('/api/wa/groups', async (c) => c.json(await runTool(c.env, 'list_wa_groups', {})));
// Safe test-send — always routes to env.WA_TEST_CHAT_ID. Use this for any
// pipeline verification instead of poking /api/wa/send directly.
app.post('/api/wa/test-send', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await sendTestText(c.env, body || {})); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/wa/test-reply', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await sendTestReply(c.env, body || {})); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/wa/restart-session', async (c) => {
  try { return c.json(await runTool(c.env, 'restart_wa_session', {})); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/wa/backfill', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'backfill_wa_messages', { limit: body?.limit, chatId: body?.chatId })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/wa/register-webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await registerWebhook(c.env, body));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.post('/api/wa/test-inbound', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await testInbound(c.env, body));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// ─── Dev-invoke API — authenticated curl access to every component ────────
// Auth: DEV_API_KEY bearer token, checked in gate.js, scoped to /api/dev/*.
// The operator's test bench: list the registries, invoke any tool/gateway/
// workflow directly, every invocation logged to Activity as dev_invoke.
app.get('/api/dev/registry', async (c) => c.json(await devListRegistry(c.env)));
app.post('/api/dev/tools/:name', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  const r = await devInvokeTool(c.env, c.req.param('name'), input);
  return c.json(r, r.ok ? 200 : 400);
});
app.post('/api/dev/gateways/:slug', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await devInvokeGateway(c.env, c.req.param('slug'), body);
  return c.json(r, r.ok ? 200 : 400);
});
app.post('/api/dev/workflows/:slug', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  // Seed system workflows first (idempotent) so a system slug is runnable on a
  // fresh DB — mirrors the social-drafts run route.
  const { seedSystemWorkflows } = await import('./workflows/runner.js');
  await seedSystemWorkflows(c.env).catch(() => {});
  const r = await devInvokeWorkflow(c.env, c.req.param('slug'), input);
  return c.json(r, r.ok ? 200 : 400);
});

// ─── Nyo chat (SSE) ───────────────────────────────────────────
app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body?.messages)) return c.json({ error: 'messages required' }, 400);
  return handleChat(c.env, body);
});

// ─── Nyo conversation history — browse and resume past threads ────
// `agent` scopes the list to one persona's threads (omitted = Nyo), so the Nyo
// panel never shows or reopens a Daily Planner conversation.
app.get('/api/chat/conversations', async (c) => c.json(
  await listConversations(c.env, {
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    agent: c.req.query('agent') || null,
  }),
));

app.get('/api/chat/conversations/:id', async (c) => {
  const conv = await readConversation(c.env, c.req.param('id'), { agent: c.req.query('agent') || null });
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  return c.json(conv);
});

app.patch('/api/chat/conversations/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await renameConversation(c.env, c.req.param('id'), body?.title));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

app.delete('/api/chat/conversations/:id', async (c) => {
  try {
    return c.json(await deleteConversation(c.env, c.req.param('id')));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// ─── Nyo voice — speech mode reads Nyo's reply aloud. Proxy the text to the
// local Piper TTS gateway (TTS_BASE_URL, behind the tunnel) and stream back the
// WAV. Gated like the rest of /api (operator only). length_scale<1 = snappier.
app.post('/api/nyo/tts', async (c) => {
  if (!ttsConfigured(c.env)) return c.json({ error: 'voice not configured (TTS_BASE_URL unset)' }, 503);
  let body; try { body = await c.req.json(); } catch { body = {}; }
  if (!String(body?.text || '').trim()) return c.json({ error: 'empty text' }, 400);
  try {
    const r = await synthesize(c.env, { text: body.text, length_scale: body?.length_scale ?? 0.95 });
    if (!r.ok) return c.json({ error: `tts gateway ${r.status}` }, 502);
    return new Response(r.body, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return c.json({ error: `tts unreachable: ${String(e?.message || e)}` }, 502);
  }
});

// Cron handler — fires on the schedule defined in wrangler.jsonc triggers.crons.
async function handleScheduled(event, env, ctx) {
  // Two cron slots (wrangler.jsonc triggers.crons):
  //   "0 * * * *" (hourly) → the awareness sweep: OSINT scrape → heartbeat →
  //                          regenerate the digest → fire meeting reminders.
  //   "0 6 * * *" (daily)  → AEO article publisher ONLY (never hourly — it would
  //                          double-post to the public site).
  // At 06:00 both expressions fire, but each invocation carries its own
  // event.cron, so we branch and never double-run the sweep.
  const cron = event.cron || '';
  const isDaily = cron.startsWith('0 6 ');

  if (isDaily) {
    ctx.waitUntil((async () => {
      try {
        // "ready only" is now claim_aeo_question's own contract: with no slug
        // it claims the next due question whose interview is ready and never
        // starts one. The runner writes the workflow_runs row itself.
        const result = await runWorkflow(env, 'aeo-write', {}, { trigger_kind: 'cron' });
        console.log('[aeo-cron]', cron, JSON.stringify({ ok: result.ok, blog_slug: result.output?.blog_slug, error: result.error }));
      } catch (e) { console.error('[aeo-cron] unhandled', e?.message || e); }
    })());
    // Second leg, same tick: refill the AEO suggestion queue from OSINT
    // signals (capped by aeo-suggestion-policy — never floods the pile).
    ctx.waitUntil((async () => {
      try {
        const result = await runWorkflow(env, 'aeo-suggestion-generator', {}, { trigger_kind: 'cron' });
        console.log('[aeo-suggestions-cron]', cron, JSON.stringify({ ok: result.ok, created: result.output?.created, reason: result.output?.reason, error: result.error }));
      } catch (e) {
        console.error('[aeo-suggestions-cron] unhandled', e?.message || e);
      }
    })());
    return;
  }

  // ── Hourly awareness sweep — one LEG per invocation. The three legs used to
  // chain inside one invocation and together blew the Worker subrequest budget
  // (seen live twice: heartbeat died on "Too many subrequests" after the OSINT
  // scrapes). Staggered cron slots give each leg its own budget: :00 OSINT,
  // :15 heartbeat scoring, :30 digest regenerate — the digest still reads this
  // hour's fresh mentions/signals. The engines live in the editorial plugin
  // now, so each leg runs the pack's cron wrapper tool BY NAME through the
  // shared pool; every leg still logs a workflow_runs row under the same
  // hourly-awareness-sweep slug with output.leg naming it.
  const logLeg = (leg, startedAt, output, error) => logWorkflowRun(env, {
    workflow_slug: 'hourly-awareness-sweep', status: error ? 'failed' : 'succeeded',
    trigger_kind: 'cron', output: { leg, ...(output || {}) }, started_at: startedAt,
    error: error ? `${leg}: ${error}` : null,
  }).catch(console.error);
  // An install without the editorial pack has none of these wrapper tools —
  // that is a quiet skip, never an hourly failed-run drumbeat.
  const packMissing = (e) => /^unknown tool /.test(String(e?.message || e));

  if (cron.startsWith('15 ')) {
    ctx.waitUntil((async () => {
      const t0 = Date.now();
      try {
        const r = await runTool(env, 'run_heartbeat', {});
        console.log('[heartbeat-cron]', cron, JSON.stringify({ inserted: r.inserted, scored: r.scored }));
        await logLeg('heartbeat', t0, { inserted: r.inserted, scored: r.scored }, null);
      } catch (e) {
        if (packMissing(e)) { console.log('[heartbeat-cron] editorial plugin not installed — leg skipped'); return; }
        console.error('[heartbeat-cron] unhandled', e?.message || e);
        await logLeg('heartbeat', t0, null, String(e?.message || e));
      }
    })());
    return;
  }

  if (cron.startsWith('30 ')) {
    ctx.waitUntil((async () => {
      const t0 = Date.now();
      try {
        const r = await runTool(env, 'run_digest', {});
        console.log('[digest-cron]', cron, JSON.stringify({ added: r?.added ?? r?.count ?? null }));
        await logLeg('digest', t0, { added: r?.added ?? r?.count ?? null }, null);
      } catch (e) {
        if (packMissing(e)) { console.log('[digest-cron] editorial plugin not installed — leg skipped'); return; }
        console.error('[digest-cron] unhandled', e?.message || e);
        await logLeg('digest', t0, null, String(e?.message || e));
      }
    })());
    return;
  }

  // :45 — the WhatsApp outreach queue. Own cron slot = own subrequest budget
  // (jittered sends can add up). Sends for real ONLY when the `outreach.live`
  // feature flag is true — otherwise it walks the queue, drops anyone who
  // replied, and records what it WOULD have sent.
  //   The LI Outreach tick that used to share this slot went with the module.
  if (cron.startsWith('45 ')) {
    ctx.waitUntil((async () => {
      try {
        // runWorkflow writes its own workflow_runs trail under the real slug
        // (outreach-cohort-tick), so the hand-rolled logWorkflowRun that used
        // to sit here — under the stale 'outreach-queue-tick' slug — is gone.
        const r = await runWorkflow(env, 'outreach-cohort-tick', {}, { trigger_kind: 'cron' });
        const o = r.output || {};
        console.log('[outreach-queue-cron]', cron, JSON.stringify({ ran: o.ran, due: Array.isArray(o.due) ? o.due.length : o.due, sent: o.sent, dry_run: o.dry_run, error: r.error }));
      } catch (e) {
        console.error('[outreach-queue-cron] unhandled', e?.message || e);
      }
    })());
    return;
  }

  // :00 — OSINT leg. The pack's run_osint_scan wrapper carries the same 3h
  // stale window + maxTargets 5 defaults the direct lib call used to pass.
  ctx.waitUntil((async () => {
    const t0 = Date.now();
    try {
      const r = await runTool(env, 'run_osint_scan', {});
      // ran/skipped are arrays on a normal run but a STRING ('no listeners
      // enabled') on the early-return — never persist a string's length as a count.
      const out = {
        ran: Array.isArray(r.ran) ? r.ran.length : 0,
        skipped: Array.isArray(r.skipped) ? r.skipped.length : 0,
        ...(typeof r.skipped === 'string' ? { note: r.skipped } : {}),
      };
      console.log('[osint-cron]', cron, JSON.stringify(out));
      await logLeg('osint', t0, out, null);
    } catch (e) {
      if (packMissing(e)) { console.log('[osint-cron] editorial plugin not installed — leg skipped'); return; }
      console.error('[osint-cron] unhandled', e?.message || e);
      await logLeg('osint', t0, null, String(e?.message || e));
    }
  })());

  // Hot Takes due-scan — publish scheduled websites + fire scheduled LinkedIn
  // legs that are due. Website publishes are REAL (same trust as the Blog
  // Approve button); LinkedIn legs stay dry-run (log-only) unless the operator
  // set the hottakes.live feature flag. The engine is the pack's
  // run_due_releases wrapper now; own waitUntil + own workflow_runs row.
  ctx.waitUntil((async () => {
    const t0 = Date.now();
    try {
      const r = await runTool(env, 'run_due_releases', {});
      const n = (r.website_published?.length || 0) + (r.posts_sent?.length || 0);
      if (n || r.errors?.length) console.log('[hottake-cron]', cron, JSON.stringify(r));
      await logWorkflowRun(env, {
        workflow_slug: 'hottake-scheduler', status: r.errors?.length ? 'failed' : 'succeeded',
        trigger_kind: 'cron', output: r, started_at: t0,
        error: r.errors?.length ? JSON.stringify(r.errors).slice(0, 500) : null,
      }).catch(console.error);
    } catch (e) {
      if (packMissing(e)) { console.log('[hottake-cron] editorial plugin not installed — leg skipped'); return; }
      console.error('[hottake-cron] unhandled', e?.message || e);
      await logWorkflowRun(env, {
        workflow_slug: 'hottake-scheduler', status: 'failed',
        trigger_kind: 'cron', error: String(e?.message || e), started_at: t0,
      }).catch(console.error);
    }
  })());

  // Nyo → Telegram: push queued update messages to the paired chats, so the
  // operator hears about finished work without opening the app.
  ctx.waitUntil((async () => {
    try {
      const { nyoTelegramPush } = await import('./lib/nyo-telegram.js');
      const r = await nyoTelegramPush(env);
      if (r.pushed) console.log('[telegram-push]', cron, JSON.stringify(r));
    } catch (e) { console.error('[telegram-push] unhandled', e?.message || e); }
  })());

  // WhatsApp lid-map backfill — resolve outbound @lid chats to phones so
  // lead↔chat matching (GTM contactStatuses + the KPI) knows who you messaged.
  ctx.waitUntil((async () => {
    try {
      const r = await runTool(env, 'backfill_lid_map', { limit: 50 });
      if (r.pending) console.log('[wa-lid-backfill]', cron, JSON.stringify(r));
    } catch (e) { console.error('[wa-lid-backfill] unhandled', e?.message || e); }
  })());

  // Scheduled sends — every tick claims + fires due schedules (atomic,
  // fail-closed, never twice; run_due_sends wraps the same lib atom), now with
  // an auditable workflow_runs row per tick.
  ctx.waitUntil((async () => {
    try {
      const r = await runWorkflow(env, 'scheduled-send-tick', {}, { trigger_kind: 'cron' });
      const o = r.output || {};
      if (o.claimed || o.sent || o.failed) console.log('[gtm-scheduled]', cron, JSON.stringify({ claimed: o.claimed, sent: o.sent, failed: o.failed }));
    } catch (e) { console.error('[gtm-scheduled] unhandled', e?.message || e); }
  })());

  // Hourly chat-history refresh — while the gateway's live message events are
  // broken (WA Web drift, since 2026-07-26), this pulls every auto_listen
  // chat's recent history through the repaired raw-Store read, so replies
  // keep reaching the digest/threads even with no webhook flow.
  ctx.waitUntil((async () => {
    try {
      // No chatId = every auto_listen chat (allAutoListen defaults true in the lib).
      const r = await runTool(env, 'backfill_wa_messages', { limit: 30 });
      if (r.inserted) console.log('[wa-history-refresh]', cron, JSON.stringify({ inserted: r.inserted, chats: r.chats_scanned }));
    } catch (e) { console.error('[wa-history-refresh] unhandled', e?.message || e); }
  })());

  // Outreach thread cache — the hourly refreshOutreachData leg (classify the
  // day's outbound WhatsApp, resolve chat names, refresh per-thread stats into
  // the threads cache) went with the GTM plugin conversion: the classify +
  // thread-refresh code lives in plugins/gtm/lib now, and the pack ships no
  // tool that wraps the refresh, so there is nothing to call by name here.
  // The plugin's Conversations tab reads plugin_gtm_outreach_threads directly.

  // Digest consideration layer — learn from what the operator dismissed and
  // tune the interest filter (no-op unless enough new dismissals accumulated).
  ctx.waitUntil((async () => {
    try {
      const r = await runTool(env, 'learn_dismissals', {});
      if (r?.learned) console.log('[digest-learn]', cron, JSON.stringify({ avoid: r.avoid?.length }));
    } catch (e) {
      if (packMissing(e)) return; // editorial plugin not installed — quiet skip
      console.error('[digest-learn] unhandled', e?.message || e);
    }
  })());

  // Outreach replies → pipeline — pull anyone who answered LI/WA outreach onto
  // the board (create/advance, idempotent). Own budget; the runner writes its
  // own workflow_runs trail, so no extra logLeg here.
  ctx.waitUntil((async () => {
    try {
      const { seedSystemWorkflows } = await import('./workflows/runner.js');
      await seedSystemWorkflows(env).catch(() => {});
      const r = await runWorkflow(env, 'outreach-replies-to-pipeline', {}, { trigger_kind: 'cron' });
      const p = r?.results?.find((s) => s.tool === 'promote_replies')?.result || {};
      console.log('[outreach-promote-cron]', cron, JSON.stringify({ created: p.created, advanced: p.advanced, unchanged: p.unchanged }));
    } catch (e) { console.error('[outreach-promote-cron] unhandled', e?.message || e); }
  })());

  // Meeting reminders — independent of the sweep; fires a WhatsApp lead_minutes
  // before a meeting (no-op if the operator hasn't set a reminder chat_id).
  // Gated on list_due_meetings: the workflow's send step is mandatory, so an
  // empty tick would fail on "text required". runWorkflow writes the
  // workflow_runs + workflow_step_runs trail itself, so there is no hand-rolled
  // logging here any more (that used to double-log every tick).
  ctx.waitUntil((async () => {
    try {
      const due = await runTool(env, 'list_due_meetings', {});
      if (due.due_meetings?.length) {
        const r = await runWorkflow(env, 'meeting-reminders', {}, { trigger_kind: 'cron' });
        console.log('[reminders-cron]', cron, JSON.stringify(r));
      }
    } catch (e) {
      console.error('[reminders-cron] unhandled', e?.message || e);
    }
  })());
}

// Authenticated fall-through: the gate passed and no /api route matched, so
// serve the built SPA (web/dist). run_worker_first=true routes every request
// through the Worker, so this handler is what actually serves static assets
// via the STATIC binding (with SPA fallback to index.html).
app.all('*', async (c) => {
  if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404);
  return c.env.STATIC.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
