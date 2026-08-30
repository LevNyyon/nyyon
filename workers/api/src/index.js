// Nyyon Command Center — Hono router + Nyo SSE chat.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  recentEvents,
  listKnowledge, readKnowledge, writeKnowledge, deleteKnowledge, readKnowledgePath,
  listBlogPosts, readBlogPost, writeBlogPost, deleteBlogPost, listBlogAnalytics,
  listAeoQuestions, readAeoQuestion, writeAeoQuestion, addAeoQuestion, deleteAeoQuestion, nextPendingAeoQuestion,
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
import { todayLocal, weekAnchor, readPlan, savePlan, searchPlans, recentPlans, readWeeklyObjectives, saveWeeklyObjectives } from './lib/daily-planner.js';
import {
  listPackages as htListPackages, readPackage as htReadPackage, createPackage as htCreatePackage,
  patchPackage as htPatchPackage, dismissPackage as htDismissPackage, listPosts as htListPosts,
  computeNextAction as htNextAction, topicsOfTheDay as htTopicsOfTheDay, pinTopic as htPinTopic,
  dismissTopicCard as htDismissTopicCard,
  releaseChannels as htReleaseChannels,
  pipelineView as htPipelineView, articleView as htArticleView, saveArticleEdit as htSaveArticleEdit,
  patchPost as htPatchPost, scheduleView as htScheduleView, listApprovedSources as htListApprovedSources,
  searchHotTakes as htSearch, loadAllHotTakesNotes as htLoadNotes, runDueReleases as htRunDueReleases,
  hotTakesLive as htLive,
} from './lib/hot-takes.js';
import {
  // The enrichment entry points (enrichFullOne / enrichResumeOne / waEnrichOne)
  // are the enrich-lead workflow now; intake, the batch stepper and the manual
  // edit have no v2 Prospecting tool and keep their lib calls.
  importLeads as gtmImportLeads, listLeads as gtmListLeads, listBatches as gtmListBatches,
  manualEditLead as gtmManualEdit,
  enrichBatchStep as gtmEnrichBatchStep, leadState as gtmLeadState,
  evaluateConfidence as gtmConfidence,
} from './lib/gtm.js';
import { listWaIntakePeople, listWaIntakeGroups, listWaGroupCandidates, importWaLeads, resolveWaIntakeBacklog } from './lib/gtm-wa-intake.js';
import { writeYou, probeTheorg } from './lib/gtm-context.js';
import { listSends, leadThread } from './lib/gtm-outreach.js';
import { runTool } from './tools/index.js';
import { callGateway } from './gateways/index.js';
import { runWorkflow } from './workflows/runner.js';
import { getLlmHealth } from './lib/llm.js';
import { listSocialCards } from './lib/social-cards.js';
import { regenerateOneFigure } from './lib/article-figures.js';
// Raw li_at / JSESSIONID capture is not a tool and has no gateway mode — the
// 11-tool LinkedIn family deliberately does not cover it, so this one lib
// symbol stays. Every other LinkedIn route goes through the pool.
// OSINT is HEADLESS now: the scraper page is cut, but the scrape itself is the
// first leg of the hourly awareness sweep that feeds the Hot Takes topic feed,
// so the cron entry point stays. Every other osint.js symbol is reached from
// tools/hottakes.js, not from here.
import { runOsintCron } from './lib/osint.js';
// Same shape for the digest: the Digest PAGE is cut, but generateDigest is the
// :30 sweep leg whose digest_items the Hot Takes topic feed reads.
import { generateDigest } from './lib/digest.js';
// The KPI drawer went with the Digest page; refreshOutreachData stays because it
// is what fills the outreach_threads cache the KEPT Outreach module's
// Conversations tab reads (reply / uncaught / sentiment per thread).
import { refreshOutreachData } from './lib/kpi.js';
import { listConversations, readConversation, renameConversation, deleteConversation } from './lib/conversations.js';
// The batch publisher stays on the lib: it is a loop with ONE trailing rebuild,
// not a tool (the single-slug route goes through publish_blog_post).
import { publishBlogPostsToProd } from './lib/publish.js';
// Two Social surfaces have no v2 tool in the 12-tool family — skip (a status
// flip the spec expected on a save_hottake_post that was never built) and the
// whole-slug group delete. They keep their lib calls.
import { skipSocialPost, deleteSocialGroup } from './lib/social-posts.js';
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
      "SELECT source, enabled, last_status FROM digest_channels WHERE enabled = 1",
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
  } catch { /* digest_channels table may not exist yet — skip */ }

  // 7. OSINT sources (DuckDuckGo, Reddit, HN, GitHub, …) — surface per-source
  //    failures, and when the recorded error looks like rate-limiting, say so
  //    and what to do about it (rather than a bare "error").
  try {
    const rows = await env.DB.prepare(
      "SELECT source, last_status, last_error FROM osint_listeners WHERE enabled = 1",
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
  } catch { /* osint_listeners table may not exist yet — skip */ }

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

// ─── blog posts ───────────────────────────────────────────────
app.get('/api/blog', async (c) => {
  const limit = parseInt(c.req.query('limit') || '200', 10);
  const all   = c.req.query('all') === '1'; // include unpublished
  return c.json({ posts: await listBlogPosts(c.env, { limit, publishedOnly: !all }) });
});
// MUST come before /api/blog/:slug or "analytics" matches as a slug.
app.get('/api/blog/analytics', async (c) => {
  const publishedOnly = c.req.query('published_only') === '1';
  return c.json({ posts: await listBlogAnalytics(c.env, { publishedOnly }) });
});
app.get('/api/blog/:slug', async (c) => {
  const p = await readBlogPost(c.env, c.req.param('slug'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ post: p });
});
app.put('/api/blog/:slug', async (c) => {
  const body = await c.req.json();
  if (!body?.title) return c.json({ error: 'title required' }, 400);
  return c.json({ post: await writeBlogPost(c.env, { ...body, slug: c.req.param('slug'), updated_by: body.updated_by || 'operator' }) });
});
app.delete('/api/blog/:slug', async (c) => {
  await deleteBlogPost(c.env, c.req.param('slug'));
  return c.json({ ok: true });
});

// Featured-image generation (Cloudflare Workers AI → R2). Body optionally
// accepts { prompt_override, model } to tweak. Returns the generated metadata
// plus the public same-origin URL written back to the post row.
// Publish a single blog post from local D1 to the production worker and
// (by default) trigger the marketing-site rebuild. Every attempt — win,
// no-op, or fail — lands in the Outbox under channel='blog' so the
// operator and Nyo both see the audit trail.
app.post('/api/blog/:slug/publish', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    // runTool takes no executionCtx, so the route keeps the background rebuild
    // itself: the tool's own await covers publish + edge verify, and anything
    // the lib deferred to ctx.waitUntil now rides this route's waitUntil.
    return c.json(await runTool(c.env, 'publish_blog_post', {
      slug:   c.req.param('slug'),
      deploy: body.deploy !== false,
      actor:  body.source || 'operator',
    }));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// Is this post actually SERVED on the public site yet? Publish only QUEUES a
// rebuild (full static-site snapshot + Pages deploy + CDN, ~1-2 min), so the ops
// UI polls this after approve to flip to "live". Checked server-side because the
// browser can't read the cross-origin public site. live = 200 AND the page
// carries this post's own /blog/<slug> canonical (a soft-404 fallback would not).
app.get('/api/blog/:slug/live-status', async (c) => {
  // Checked against the blog-edge worker's URL, NOT the public site: a
  // Worker's subrequest to its own zone bypasses Workers routes and would
  // hit the static origin — reporting every edge-served post as "not live".
  // The edge URL exercises the same code + same D1 the public URL serves.
  const slug = c.req.param('slug');
  const { verifyLiveOnEdge } = await import('./lib/publish.js');
  const edge = await verifyLiveOnEdge(c.env, slug, { attempts: 1 });
  // Public URL from the configured site origin; with none configured there is
  // no public URL to report.
  const origin = String(c.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return c.json({ live: edge.live, status: edge.status, url: origin ? `${origin}/blog/${encodeURIComponent(slug)}/` : null, edge });
});

// Bulk publish — pass {slugs: [...]} to mirror many posts and run the
// rebuild once at the end.
app.post('/api/blog/publish-batch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const slugs = Array.isArray(body.slugs) ? body.slugs : [];
  if (!slugs.length) return c.json({ error: 'slugs[] required' }, 400);
  return c.json(await publishBlogPostsToProd(c.env, slugs, { source: body.source || 'operator' }));
});

// Reshape an EXISTING post through the article pipeline — rewrites its body to
// clean house-style HTML (brand voice + learned taste, banned phrases stripped)
// and generates editorial figures + a featured image. Fixes bare saves that
// landed as raw markdown with no visuals. In place (same slug).
app.post('/api/blog/:slug/reshape', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => ({}));
  // blog-shape has no read step (it also serves fresh writes), so the route
  // reads the post itself. published/published_at are NOT passed on: the
  // workflow's save_blog_post preserves the row's publication state by design.
  const post = await readBlogPost(c.env, slug);
  if (!post) return c.json({ error: 'post not found' }, 404);
  try {
    const r = await runWorkflow(c.env, 'blog-shape', {
      slug,
      title:          post.title,
      body:           post.body,
      voice:          body.voice || 'personal',
      target_keyword: body.target_keyword || null,
      actor:          'operator',
    });
    if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 500);
    // Same {blog_slug, post} contract save_blog_post returned through the lib;
    // `skipped` names any optional figure/cover step that failed.
    return c.json({
      ok: true, run_id: r.run_id, skipped: r.skipped,
      blog_slug: r.output?.blog_slug || slug,
      post: r.output?.post ?? null,
      featured_image_url: r.output?.featured_image_url ?? null,
    });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// Expand an existing post: deepen the story, weave in the company's upside,
// append an AEO-optimised FAQ + FAQPage schema, then re-embed figures + cover.
app.post('/api/blog/:slug/expand', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => ({}));
  try {
    // voice:'personal' is passed explicitly — read_voice_profile now defaults to
    // 'house', so dropping it would silently change this route's output voice.
    const r = await runWorkflow(c.env, 'blog-expand', { slug, voice: body.voice || 'personal' });
    if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 500);
    return c.json({
      ok: true, run_id: r.run_id, skipped: r.skipped,
      blog_slug: r.output?.blog_slug || slug,
      post: r.output?.post ?? null,
      faq_count: r.output?.faq_count ?? null,
    });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

app.post('/api/blog/:slug/generate-image', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => ({}));
  try {
    // prompt_override has no place in blog-featured-image: draft_visual_brief
    // would overwrite it on the shared context. That path calls the three
    // tools directly instead; everything else runs the workflow.
    if (body.prompt_override) {
      const rendered = await runTool(c.env, 'render_images', {
        blog_slug: slug, prompt: body.prompt_override, model: body.model || null, n: body.n || null,
      });
      const judged = await runTool(c.env, 'judge_images', { blog_slug: slug, candidates: rendered.candidates });
      const set = await runTool(c.env, 'set_featured_image', {
        blog_slug: slug, winner_url: judged.winner_url, model: judged.model || body.model || null, prompt: body.prompt_override, actor: 'operator',
      });
      return c.json({ image: { url: set.featured_image_url || judged.winner_url, model: judged.model || null, prompt: body.prompt_override } });
    }
    const r = await runWorkflow(c.env, 'blog-featured-image', { slug, model: body.model || null, n: body.n || null });
    if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 500);
    return c.json({
      image: {
        url:    r.output?.featured_image_url || r.output?.winner_url || null,
        model:  r.output?.model || null,
        prompt: r.output?.prompt || null,
      },
      run_id: r.run_id,
    });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// ─── social cards (code-drawn brand graphics — the Social family's card tools) ───
app.post('/api/social-cards/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    // From a slug the `social-card` workflow reads the article first; a
    // custom-title card has no article to read, so it enters at draft_card.
    if (body.slug) {
      const r = await runWorkflow(c.env, 'social-card', {
        slug: body.slug, template: body.template || null, slots: body.slots || null,
      });
      if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 500);
      return c.json({ card: r.output?.card ?? null, run_id: r.run_id });
    }
    const drafted  = await runTool(c.env, 'draft_card', {
      title: body.title || null, excerpt: body.excerpt || null,
      template: body.template || null, slots: body.slots || null,
    });
    const rendered = await runTool(c.env, 'render_card', { template: drafted.template, slots: drafted.slots });
    const saved    = await runTool(c.env, 'save_social_card', { card: rendered.card, slots: drafted.slots, actor: body.actor || 'operator' });
    return c.json({ card: saved.card });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

app.get('/api/social-cards', async (c) => {
  const slug  = c.req.query('slug') || null;
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ cards: await listSocialCards(c.env, { slug, limit }) });
});

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

// ─── Sunday Brain (weekly editorial planning) ────────────────
app.get('/api/brain/current', async (c) => {
  const { getThisWeekSession } = await import('./lib/brain.js');
  const s = await getThisWeekSession(c.env);
  return c.json({ session: s || null });
});
app.get('/api/brain/sessions', async (c) => {
  const { recentBrainSessions } = await import('./lib/brain.js');
  return c.json({ sessions: await recentBrainSessions(c.env, { limit: 12 }) });
});
app.post('/api/brain/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { startBrainSession } = await import('./lib/brain.js');
  try { return c.json(await startBrainSession(c.env, { force: !!body.force })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/brain/submit', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.answers) return c.json({ error: 'answers required' }, 400);
  const { submitBrainAnswers } = await import('./lib/brain.js');
  try { return c.json(await submitBrainAnswers(c.env, { sessionId: body.session_id || null, answers: body.answers })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});

// ─── AEO feedback + editorial taste ──────────────────────────
app.get('/api/aeo/feedback', async (c) => {
  const { recentAeoFeedback } = await import('./lib/db.js');
  return c.json({ feedback: await recentAeoFeedback(c.env, { limit: 80 }) });
});
app.post('/api/aeo/feedback', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.reaction) return c.json({ error: 'reaction required' }, 400);
  // save_aeo_feedback → draft_taste_profile → write_knowledge. The taste-doc
  // refresh that used to be a silent enrichment is now a visible workflow run.
  const r = await runWorkflow(c.env, 'aeo-react', {
    reaction:      body.reaction,
    note:          body.note || null,
    question_slug: body.slug || null,
    idea_title:    body.idea_title || null,
  });
  if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({ ok: true, feedback: r.output?.feedback ?? null, taste_updated: !r.output?.skipped, run_id: r.run_id });
});
app.post('/api/aeo/taste/refresh', async (c) => {
  try {
    const doc = await runTool(c.env, 'draft_taste_profile', {});
    if (doc.skipped) return c.json({ ok: true, taste: null, skipped: doc.skipped });
    await runTool(c.env, 'write_knowledge', doc);
    return c.json({ ok: true, taste: doc });
  } catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 500); }
});

// ─── AEO (question backlog + writer) ─────────────────────────
app.get('/api/aeo/questions', async (c) => {
  const status = c.req.query('status') || null;
  const limit  = parseInt(c.req.query('limit') || '200', 10);
  return c.json({ questions: await listAeoQuestions(c.env, { status, limit }) });
});
app.get('/api/aeo/queue', async (c) => {
  const [pending, next] = await Promise.all([
    listAeoQuestions(c.env, { status: 'pending', limit: 1000 }),
    nextPendingAeoQuestion(c.env),
  ]);
  return c.json({ pending_count: pending.length, next });
});
app.get('/api/aeo/questions/:slug', async (c) => {
  const q = await readAeoQuestion(c.env, c.req.param('slug'));
  if (!q) return c.json({ error: 'not found' }, 404);
  return c.json({ question: q });
});
app.post('/api/aeo/questions', async (c) => {
  const body = await c.req.json();
  try { return c.json({ question: await writeAeoQuestion(c.env, body) }, 201); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// Add a brand-new topic from just its text (auto-slugged, unique). Nyo reaches
// the same surface through save_aeo_question's create branch.
app.post('/api/aeo/add', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ question: await addAeoQuestion(c.env, body) }, 201); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.put('/api/aeo/questions/:slug', async (c) => {
  const body = await c.req.json();
  try { return c.json({ question: await writeAeoQuestion(c.env, { ...body, slug: c.req.param('slug') }) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/aeo/questions/:slug', async (c) => {
  try {
    const removed = await deleteAeoQuestion(c.env, c.req.param('slug'));
    if (!removed) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// The aeo-write run reshaped into the {ok, question_slug, blog_slug, title}
// contract the AEO page reads (AeoDraftResult) — the runner's envelope is not
// that shape, and returning it raw would leave the page with no title/slug.
function aeoWriteResponse(r) {
  if (r.ok) {
    return {
      ok: true,
      question_slug: r.output?.question_slug ?? null,
      blog_slug:     r.output?.blog_slug ?? null,
      title:         r.output?.title ?? null,
      run_id:        r.run_id,
      skipped:       r.skipped,
    };
  }
  return {
    ok: false,
    error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`,
    question_slug: r.output?.question_slug ?? null,
    run_id: r.run_id || null,
  };
}
app.post('/api/aeo/draft-now', async (c) => {
  // Manual trigger — same workflow the cron runs. BEHAVIOUR SPLIT vs the old
  // runAeoCron: claim_aeo_question is fail-closed and REFUSES a question whose
  // interview has no answers instead of quietly starting one. The old
  // two-in-one behaviour is restored here by catching that one refusal and
  // running the interview workflow for the same question.
  const r = await runWorkflow(c.env, 'aeo-write', {});
  if (!r.ok && r.tool === 'claim_aeo_question' && /no interview answers yet/.test(r.error || '')) {
    const slug = (r.error.match(/AEO question (\S+) has no interview answers/) || [])[1]
      || (await nextPendingAeoQuestion(c.env))?.slug || null;
    if (slug) {
      const iv = await runWorkflow(c.env, 'aeo-interview-start', { question_slug: slug });
      return c.json({
        ok: iv.ok, question_slug: slug, interview_started: iv.ok,
        error: iv.ok ? undefined : (iv.error || `interview workflow failed at step ${iv.failed_step}`),
        run_id: iv.run_id || null,
      }, iv.ok ? 200 : 400);
    }
  }
  return c.json(aeoWriteResponse(r));
});
app.post('/api/aeo/publish-scheduled', async (c) => {
  // Autonomous scheduler hook (scheduler.sh / LaunchAgent). Writes ONE ready +
  // scheduled-due article (interview already captured — e.g. from the Sunday
  // Brain). readyOnly is now the DEFAULT, not a flag: claim_aeo_question with
  // no slug claims the next due question whose interview is ready and never
  // starts an interview, so this stays safe to run unattended.
  return c.json(aeoWriteResponse(await runWorkflow(c.env, 'aeo-write', {})));
});
app.post('/api/aeo/write/:slug', async (c) => {
  // Write a SPECIFIC question now (used to release a queued, ready idea).
  // claim_aeo_question accepts status pending OR failed (a retry) but never
  // 'drafting', so a concurrent run still cannot double-write.
  return c.json(aeoWriteResponse(await runWorkflow(c.env, 'aeo-write', { question_slug: c.req.param('slug') })));
});

// ─── AEO suggestions (OSINT signals -> developed angles -> approval) ────
app.get('/api/aeo/suggestions', async (c) => {
  const { listAeoSuggestions } = await import('./lib/aeo-suggestions.js');
  return c.json({ suggestions: await listAeoSuggestions(c.env, { status: c.req.query('status') || null }) });
});
app.post('/api/aeo/suggestions/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await runWorkflow(c.env, 'aeo-suggestion-generator', { limit: body?.limit ?? null });
  // The AEO page reads {ok, created, reason?} — save_aeo_suggestions' own
  // shape, which lands on the run's shared context.
  if (!r.ok) return c.json({ ok: false, created: 0, error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({ ok: true, created: r.output?.created ?? 0, reason: r.output?.reason, run_id: r.run_id });
});
// No v2 tool exists for approving or rejecting a suggestion (the spec lists no
// approve_/reject_/list_aeo_suggestion in any family), so these two stay on
// lib/aeo-suggestions.js. The v2 equivalent of approve would be
// save_aeo_question → save_interview_questions → save_interview_answers →
// runWorkflow('aeo-write', {question_slug}); flagged, not built.
app.post('/api/aeo/suggestions/:id/approve', async (c) => {
  const { approveAeoSuggestion } = await import('./lib/aeo-suggestions.js');
  try { return c.json(await approveAeoSuggestion(c.env, c.req.param('id'), { actor: 'operator', ctx: c.executionCtx })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/aeo/suggestions/:id/reject', async (c) => {
  const { rejectAeoSuggestion } = await import('./lib/aeo-suggestions.js');
  try { return c.json(await rejectAeoSuggestion(c.env, c.req.param('id'), { actor: 'operator' })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── article figures (generate illustrations for blog posts) ───
app.post('/api/blog/:slug/generate-figures', async (c) => {
  // Generate article illustrations for a single post (new or existing).
  // `replace` is gone: embed_figures always strips the previous run's figures,
  // so every run is a clean regenerate.
  const slug = c.req.param('slug');
  const r = await runWorkflow(c.env, 'article-figures', { slug });
  if (!r.ok) return c.json({ ok: false, error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({
    ok: true, run_id: r.run_id, blog_slug: r.output?.blog_slug || slug,
    figures: r.output?.figures ?? null,
    featured_image_url: r.output?.featured_image_url ?? null,
  });
});
app.post('/api/blog/:slug/regenerate-figure', async (c) => {
  // Redesign ONE in-article chart (the editor's per-chart Change button).
  // Body: { src: "<the figure img src>", instructions?: "<operator steering>" }.
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await regenerateOneFigure(c.env, {
      slug: c.req.param('slug'),
      src: body?.src,
      instructions: body?.instructions || null,
      actor: 'operator',
    }));
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/blog/:slug/regenerate-cover', async (c) => {
  // Re-render ONLY the featured cover (refresh branding/wordmark). No body
  // change. Overwrites the cover in place. Pass {polish:true} to re-draft the
  // cover's accent highlight + standfirst via the LLM (keeps the original
  // look); omit for a free deterministic render. Loop this per-slug from a
  // script for a full backfill (each call is one draft + render + upload).
  //
  // blog-cover ALWAYS drafts the slots (the old polish:true path). polish:false
  // is the free deterministic render, which is render_cover's own fallback
  // (first tag + title + excerpt, no LLM) — so that branch calls the two tools
  // directly rather than the workflow.
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => ({}));
  if (!body?.polish) {
    const rendered = await runTool(c.env, 'render_cover', { blog_slug: slug });
    const set = await runTool(c.env, 'set_featured_image', { blog_slug: slug, cover_url: rendered.cover_url, actor: 'operator-cover' });
    return c.json({ ok: true, blog_slug: slug, cover_url: rendered.cover_url, featured_image_url: set.featured_image_url ?? null });
  }
  const r = await runWorkflow(c.env, 'blog-cover', { slug });
  if (!r.ok) return c.json({ ok: false, error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({
    ok: true, run_id: r.run_id, blog_slug: r.output?.blog_slug || slug,
    cover_url: r.output?.cover_url ?? null,
    featured_image_url: r.output?.featured_image_url ?? null,
  });
});
app.post('/api/blog/covers/prune-orphans', async (c) => {
  // Delete cover PNGs in R2 that no post references. Repeated/killed cover
  // backfills leave many `${slug}-cover-<ts>.png` orphans; only the one in each
  // post's featured_image_url is in use. Body figures (`-fig-N.png`) and the
  // referenced covers are always kept. Pass {dryRun:true} to preview.
  const body = await c.req.json().catch(() => ({}));
  const dryRun = !!body?.dryRun;
  // Read featured_image_url straight from D1 — the list projection omits it.
  const rows = await c.env.DB.prepare('SELECT featured_image_url FROM blog_posts').all();
  const keep = new Set();
  for (const r of (rows.results || [])) {
    const m = (r.featured_image_url || '').match(/blog-figures\/[^/?#"]+\.png/);
    if (m) keep.add(m[0]);
  }
  let scanned = 0, figuresKept = 0, coversKeptReferenced = 0, coversDeleted = 0;
  const sample = [];
  let cursor;
  do {
    const listed = await c.env.ASSETS.list({ prefix: 'blog-figures/', cursor, limit: 1000 });
    for (const o of listed.objects) {
      scanned++;
      if (!/-cover(-\d+)?\.png$/.test(o.key)) { figuresKept++; continue; }  // a figure, keep
      if (keep.has(o.key)) { coversKeptReferenced++; continue; }            // in use, keep
      if (!dryRun) await c.env.ASSETS.delete(o.key);
      coversDeleted++;
      if (sample.length < 5) sample.push(o.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return c.json({ ok: true, dryRun, scanned, keep_set: keep.size, figures_kept: figuresKept, covers_kept_referenced: coversKeptReferenced, covers_deleted: coversDeleted, sample });
});
app.post('/api/blog/batch/generate-figures', async (c) => {
  // Backfill article figures for ALL posts. Fire-and-forget, returns immediately.
  // Check /api/blog/batch/generate-figures/status for progress.
  const posts = await listBlogPosts(c.env, { limit: 500, publishedOnly: true });
  const body = await c.req.json().catch(() => ({}));
  const parallel = Math.min(body?.parallel || 3, 10);  // 3 concurrent by default
  let processed = 0, succeeded = 0, failed = 0;
  // The batching/parallelism stays HERE: a batch is not a workflow. Each post
  // is one article-figures run, so every item gets its own workflow_runs row.
  (async () => {
    for (let i = 0; i < posts.length; i += parallel) {
      const batch = posts.slice(i, i + parallel);
      await Promise.all(
        batch.map(async (p) => {
          try {
            const r = await runWorkflow(c.env, 'article-figures', { slug: p.slug });
            if (r.ok) succeeded += 1; else failed += 1;
          } catch (e) {
            failed += 1;
          } finally {
            processed += 1;
          }
        }),
      );
    }
  })();
  return c.json({
    queued: true,
    total: posts.length,
    parallel,
    message: 'figures generation started in background',
  });
});

// ─── gtm (gtm-builder folded in: intake → enrich → outreach; shared gateways) ──
// The per-lead buttons all run a prospecting WORKFLOW now, and the runner's
// envelope ({ok, run_id, results, output}) is not what the GTM page reads. This
// is the common half of every reshape: ok / error / id / the optional legs that
// failed, so a partial run stays visibly partial instead of silently green.
function gtmWorkflowResponse(r, id) {
  if (!r.ok) {
    return { ok: false, id, error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null };
  }
  return {
    ok: true, id, run_id: r.run_id,
    errors: (r.skipped || []).map((s) => `${s.tool}: ${s.error}`),
  };
}
// The stored org chart in the D1 column shape the drawer's chart renders from
// (read_lead and the fetchers speak theorg's nodeId/photo/reportCount).
function orgRowsFromToolShape(people) {
  return (people || []).map((p) => ({
    node_id: p.nodeId ?? p.node_id ?? null, parent_node_id: p.parentId ?? p.parent_node_id ?? null,
    name: p.name ?? null, role: p.role ?? null,
    photo_url: p.photo ?? p.photo_url ?? null, report_count: p.reportCount ?? p.report_count ?? null,
  }));
}
app.get('/api/gtm/batches', async (c) => c.json({ batches: await gtmListBatches(c.env) }));
app.get('/api/gtm/usage', async (c) => c.json(await runTool(c.env, 'read_api_usage', {})));
app.get('/api/gtm/leads', async (c) => {
  const leads = await gtmListLeads(c.env, {
    batch_id: c.req.query('batch_id') || null,
    status:   c.req.query('status') || null,
    stage:    c.req.query('stage') || null,
    q:        c.req.query('q') || null,
  });
  return c.json({ leads });
});
app.post('/api/gtm/import', async (c) => {
  const b = await c.req.json();
  return c.json(await gtmImportLeads(c.env, { text: b.text, url: b.url, source: b.source }));
});
// Batch enrichment stepper — the UI loops this while remaining > 0 so each
// Worker invocation stays small (2 leads/call) instead of one long chain.
// WhatsApp intake picker — people the operator already talks to (DM chats +
// group senders + live group rosters) as selectable lead candidates.
app.get('/api/gtm/wa/people', async (c) =>
  c.json({ people: await listWaIntakePeople(c.env, { q: c.req.query('q') || '', limit: Number(c.req.query('limit')) || 1000 }) }));
app.get('/api/gtm/wa/groups', async (c) => c.json({ groups: await listWaIntakeGroups(c.env) }));
app.get('/api/gtm/wa/groups/:id/participants', async (c) => {
  try { return c.json(await listWaGroupCandidates(c.env, c.req.param('id'))); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 502); }
});
app.post('/api/gtm/wa/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await resolveWaIntakeBacklog(c.env, { limit: Number(body.limit) || 50 }));
});
app.post('/api/gtm/wa/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.people) || !body.people.length) return c.json({ error: 'people[] required' }, 400);
  return c.json(await importWaLeads(c.env, { people: body.people, source: body.source || null }));
});

app.post('/api/gtm/enrich', async (c) => {
  const b = await c.req.json();
  if (!b.batch_id) return c.json({ error: 'batch_id required' }, 400);
  return c.json(await gtmEnrichBatchStep(c.env, { batch_id: b.batch_id, limit: b.limit || 2 }));
});
app.get('/api/gtm/leads/:id', async (c) => {
  const id = c.req.param('id');
  const r = await runTool(c.env, 'read_lead', { id });
  if (r.error) return c.json({ error: r.error }, 404);
  // read_lead hands back org_people in theorg's shape (nodeId/parentId/photo/
  // reportCount); the lead drawer's org chart reads the D1 column names. Mapped
  // here so the route's {lead, org, angles, sends} contract is unchanged.
  // `sends` has no tool in the Outreach family (no list_sends in the 41), so
  // the send history keeps its lib call.
  return c.json({
    lead: r.lead, org: orgRowsFromToolShape(r.org_people), angles: r.angles,
    sends: await listSends(c.env, id),
  });
});
app.post('/api/gtm/leads/:id', async (c) => {
  // A rejected value is the caller's problem, not a server fault: manualEditLead
  // throws on input it refuses to coerce (a non-numeric headcount), and that
  // must read as 400 with the reason rather than a bare 500.
  try {
    const lead = await gtmManualEdit(c.env, c.req.param('id'), await c.req.json());
    return c.json({ lead: { ...lead, state: gtmLeadState(lead), confidence: gtmConfidence(lead) } });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
// The whole chain that used to live inside the fat enrich call is now the
// enrich-lead workflow: sources self-skip, each leg is an optional step whose
// failure is recorded on the run, and exactly one writer (save_lead) closes it.
app.post('/api/gtm/leads/:id/enrich', async (c) => {
  const id = c.req.param('id');
  // Every kind maps to the same workflow. 'resume' costs nothing beyond the
  // legs a manual edit actually unblocked (the sources self-skip), and 'wa' is
  // a subset of it: lookup_wa_identity → reconcile_identity → save_lead.
  const r = await runWorkflow(c.env, 'enrich-lead', { id });
  return c.json(gtmWorkflowResponse(r, id), r.ok ? 200 : 400);
});
app.post('/api/gtm/leads/:id/theorg', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  // The slug override is the theorg_slug input key now.
  const r = await runWorkflow(c.env, 'company-context', { id, theorg_slug: b.slug || null, refresh: !!b.refresh });
  const out = gtmWorkflowResponse(r, id);
  if (!r.ok) return c.json({ ...out, people: [], status: null }, 400);
  // The drawer reads {company, people[], status, note} and renders `people`
  // straight into the chart, so read the STORED rows back (save_org_chart is
  // the source of truth; a cached run fetches nothing and would answer []).
  const after = await runTool(c.env, 'read_lead', { id });
  return c.json({
    ...out,
    company: after.lead?.company ?? r.output?.org_company ?? null,
    people:  orgRowsFromToolShape(after.org_people),
    status:  after.lead?.org_status ?? r.output?.org_status ?? null,
    note:    after.lead?.org_note ?? r.output?.org_note ?? null,
  });
});
// Org chart + LinkedIn headcount + open roles in one pass, so qualification can
// be run in bulk against real company facts. Partial by design: the three fetch
// legs are optional steps, so a failure is recorded in workflow_step_runs and
// save_lead's coalesce keeps the facts already on file.
app.post('/api/gtm/leads/:id/company-context', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runWorkflow(c.env, 'company-context', { id: c.req.param('id'), refresh: !!b.refresh });
  const out = gtmWorkflowResponse(r, c.req.param('id'));
  // The Qualification bulk pass reads {error} | {errors[], staff_count}; the
  // rest is kept so the shape still matches GtmCompanyContext. Note the source
  // keys: fetch_company_profile emits staff_count / company_name and
  // fetch_open_roles emits positions[], not open_roles.
  return c.json({
    ...out,
    company:     r.output?.org_company ?? r.output?.company_name ?? null,
    org_people:  Array.isArray(r.output?.org_people) ? r.output.org_people.length : 0,
    org_status:  r.output?.org_status ?? null,
    org_note:    r.output?.org_note ?? null,
    staff_count: r.output?.staff_count ?? null,
    open_roles:  Array.isArray(r.output?.positions) ? r.output.positions.length : 0,
  }, r.ok ? 200 : 400);
});
app.post('/api/gtm/leads/:id/icp', async (c) => {
  // score_icp no longer persists on its own — save_lead writes icp_fit +
  // icp_reasons, which is why this is the workflow and not the bare tool.
  const r = await runWorkflow(c.env, 'qualify-lead', { id: c.req.param('id') });
  const out = gtmWorkflowResponse(r, c.req.param('id'));
  // score_icp emits icp_fit / icp_reasons / icp_gaps; the Qualification tab
  // reads fit / reasons / gaps.
  return c.json({
    ...out,
    fit:     r.output?.icp_fit ?? null,
    reasons: r.output?.icp_reasons ?? [],
    gaps:    r.output?.icp_gaps ?? [],
  }, r.ok ? 200 : 400);
});
app.post('/api/gtm/leads/:id/positions', async (c) => {
  // fetch_open_roles is a PURE fetch in v2 — calling it alone would return the
  // roles without storing them, so this route goes through the workflow.
  const r = await runWorkflow(c.env, 'company-context', { id: c.req.param('id') });
  const out = gtmWorkflowResponse(r, c.req.param('id'));
  return c.json({ ...out, positions: r.output?.positions ?? [], count: r.output?.count ?? 0 }, r.ok ? 200 : 400);
});
app.get('/api/gtm/green', async (c) => c.json(await runTool(c.env, 'list_green_leads', {})));
app.post('/api/gtm/leads/:id/angles', async (c) => {
  // Still drafts only. The blocked-on-org_status='warn' guard lives in
  // draft_angles, and save_angles refuses an empty payload, so a block can
  // never wipe the angles already stored.
  const r = await runWorkflow(c.env, 'draft-outreach-angles', { id: c.req.param('id') });
  const out = gtmWorkflowResponse(r, c.req.param('id'));
  // The Outreach tab reads GtmAngles at the TOP level ({playbook_fit,
  // connection_points, angles}) plus an optional `blocked` reason.
  return c.json({ ...out, ...(r.output?.angles_payload || {}), blocked: r.output?.blocked ?? undefined }, r.ok ? 200 : 400);
});
app.post('/api/gtm/leads/:id/angles/save', async (c) => {
  const b = await c.req.json();
  return c.json(await runTool(c.env, 'save_angles', { id: c.req.param('id'), payload: b.payload || b }));
});
app.post('/api/gtm/leads/:id/schedule', async (c) => {
  const b = await c.req.json();
  return c.json(await runTool(c.env, 'schedule_send', { id: c.req.param('id'), bubbles: b.bubbles, send_at: b.send_at }));
});
// The lead filter is `lead_id` on the v2 tool, and the cancel verb takes
// `schedule_id` — both input keys were renamed with the split.
app.get('/api/gtm/schedules', async (c) => c.json(await runTool(c.env, 'list_scheduled_sends', { lead_id: c.req.query('lead') || undefined })));
app.delete('/api/gtm/schedules/:id', async (c) => c.json(await runTool(c.env, 'cancel_scheduled_send', { schedule_id: c.req.param('id') })));
// NOT in the v2 tool list (gtm_lead_thread was cut with tools/gtm.js and the
// Outreach family's read_prospect_thread is the WA-thread reader, not this
// send-history view), so this route keeps the lib call it wraps.
app.get('/api/gtm/leads/:id/thread', async (c) =>
  c.json(await leadThread(c.env, c.req.param('id'), { refresh: c.req.query('refresh') === '1' })));
app.post('/api/gtm/leads/:id/send', async (c) => {
  const b = await c.req.json();
  return c.json(await runTool(c.env, 'send_outreach', { id: c.req.param('id'), bubbles: b.bubbles, force: !!b.force }));
});
app.get('/api/gtm/you', async (c) => c.json(await runTool(c.env, 'read_you', {})));
// The WRITE side has no v2 tool by design — the gtm-you doc is edited with
// write_knowledge — so the operator's Save button keeps its lib call.
app.post('/api/gtm/you', async (c) => c.json({ you: await writeYou(c.env, await c.req.json()) }));
app.post('/api/gtm/you/pull-groups', async (c) => {
  const { groups } = await runTool(c.env, 'list_wa_groups', {}); // { groups, source, live_error }
  const { you } = await runTool(c.env, 'read_you', {});
  const names = new Set([...(you?.groups || []), ...(groups || []).map((g) => g.name).filter(Boolean)]);
  return c.json({ you: await writeYou(c.env, { groups: [...names] }) });
});
// Promote a lead into the Pipeline CRM: contact (person) + client row at stage
// 'target', linked both ways. Idempotent per lead via gtm_leads.client_id.
app.post('/api/gtm/leads/:id/to-pipeline', async (c) => {
  const r = await runTool(c.env, 'promote_lead', { id: c.req.param('id') });
  if (!r.ok) return c.json({ error: r.error }, r.code || 400);
  return c.json(r);
});

// ─── outreach · WA (the Outreach module's prospect inbox) ─────────
// Thin dispatchers onto the shared outreach_wa_* tool pool — Nyo drives the
// exact same surface. Sending stays on /api/wa/send (the outbox-audited path):
// nothing here can dispatch a message.
app.get('/api/outreach/wa/threads', async (c) => {
  // Freshness runs in the BACKGROUND: the read answers from D1 immediately,
  // the gateway pull lands before the UI's next poll. Keeps the module's
  // first paint fast while still tracking the phone.
  c.executionCtx.waitUntil(syncFromGateway(c.env).catch(() => {}));
  return c.json(await runTool(c.env, 'list_prospect_threads', {
    q: c.req.query('q') || '', limit: Number(c.req.query('limit')) || null,
    status: c.req.query('status') || 'active',
  }));
});
app.post('/api/outreach/wa/dead', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'mark_thread_dead', { lead_id: b?.lead_id, dead: b?.dead !== false, reason: b?.reason || null });
  return r?.error ? c.json(r, 400) : c.json(r);
});

// ─── outreach · queue (the automated ladder) ──────────────────────
// Sending is gated on the `outreach.live` feature flag — until it is true the
// tick reports what it WOULD have sent and sends nothing.
app.get('/api/outreach/cohort', async (c) => c.json(await runTool(c.env, 'list_cohort_members', {
  status: c.req.query('status') || null,
  cohort_id: c.req.query('cohort_id') || null,
})));

// Named queues (campaigns). Nobody may be in two — see the enroll routes.
app.get('/api/outreach/cohorts', async (c) => c.json(await runTool(c.env, 'list_cohorts', {})));
app.post('/api/outreach/cohorts', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'create_cohort', { name: b?.name, note: b?.note || null });
  return r?.error ? c.json(r, 400) : c.json(r);
});
app.patch('/api/outreach/cohorts/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'update_cohort', { ...b, cohort_id: c.req.param('id') });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// Drafts one step's copy for the operator to read — never saves, never sends.
app.post('/api/outreach/cohorts/:id/draft-step', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'draft_step_copy', {
    cohort_id: c.req.param('id'), step_index: b?.step_index || 0,
    language: b?.language || 'en', instruction: b?.instruction || '',
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
app.delete('/api/outreach/cohorts/:id', async (c) => {
  const r = await runTool(c.env, 'delete_cohort', { cohort_id: c.req.param('id') });
  return r?.error ? c.json(r, 400) : c.json(r);
});

// The single-enrol tool is gone: enroll_members is the one staging verb, and
// the reply is {added[], conflicts[], skipped[]} rather than a bare
// {conflict:true} / {added:true}. `start_at` is dropped on purpose — enrolling
// never schedules; launch_members / reschedule_member set the time.
app.post('/api/outreach/cohort/enroll', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'enroll_members', {
    lead_ids: b?.lead_id ? [b.lead_id] : [], cohort_id: b?.cohort_id || null, override: !!b?.override,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// Bulk add from Prospecting → Qualification. A 200 here does NOT mean everyone
// was added: the body separates queued / conflicts / skipped, and conflicts are
// prospects already being worked elsewhere that need an explicit override.
app.post('/api/outreach/cohort/add-many', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'enroll_members', {
    lead_ids: b?.lead_ids || [], cohort_id: b?.cohort_id || null, override: !!b?.override,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// Approve the next message for specific prospects. Per message, not per person:
// it lapses on send, so the following one has to be approved again. A 200 does
// NOT mean everyone was approved — the body separates approved / refused.
app.post('/api/outreach/cohort/approve', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'approve_message', {
    lead_ids: b?.lead_ids || [], approve: b?.approve !== false,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// Rewrite ONE prospect's next message, for that prospect only. Saving withdraws
// any approval — the operator approved text that has now changed.
app.put('/api/outreach/cohort/:lead_id/message', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'override_message', {
    lead_id: c.req.param('lead_id'), text: b?.text || '', clear: !!b?.clear,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// Move one prospect's next send. Stored exactly as given; the reply flags when
// that lands outside the cohort's window rather than quietly moving it.
app.put('/api/outreach/cohort/:lead_id/schedule', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'reschedule_member', {
    lead_id: c.req.param('lead_id'), send_at: b?.send_at,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// The one action-string tool split into three verbs; an unknown action 400s
// here rather than silently no-opping the way a bad string used to.
app.post('/api/outreach/cohort/control', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const lead_id = b?.lead_id;
  let r;
  switch (b?.action) {
    case 'pause':      r = await runTool(c.env, 'pause_member', { lead_id, paused: true });  break;
    case 'resume':     r = await runTool(c.env, 'pause_member', { lead_id, paused: false }); break;
    case 'stop':       r = await runTool(c.env, 'stop_member', { lead_id });                 break;
    case 'unschedule': r = await runTool(c.env, 'unschedule_member', { lead_id });           break;
    default: return c.json({ error: `unknown action "${b?.action ?? ''}" — expected pause, resume, stop or unschedule` }, 400);
  }
  return r?.error ? c.json(r, 400) : c.json(r);
});
app.delete('/api/outreach/cohort/:lead_id', async (c) => c.json(
  await runTool(c.env, 'remove_member', { lead_id: c.req.param('lead_id') }),
));
app.post('/api/outreach/cohort/tick', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runWorkflow(c.env, 'outreach-cohort-tick', {
    dry_run: b?.dry_run === undefined ? null : !!b.dry_run, force: !!b?.force, limit: b?.limit || null,
  });
  if (!r.ok) return c.json({ ran: false, reason: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  // The Cohorts page reads OutreachTickResult ({ran, reason, dry_run, live,
  // due, sent, next_open, results[]}). Those fields now live on the run's
  // shared context, and `due` is the ARRAY of due rows there, not a count.
  const o = r.output || {};
  return c.json({
    ran:       o.ran !== false,
    reason:    o.reason,
    dry_run:   o.dry_run,
    live:      o.live,
    due:       Array.isArray(o.due) ? o.due.length : (o.due ?? 0),
    sent:      o.sent ?? 0,
    next_open: o.next_open,
    results:   o.results || [],
    retired:   o.retired, blocked: o.blocked, awaiting: o.awaiting ?? o.awaiting_approval, unverified: o.unverified,
    budget:    o.budget,
    run_id:    r.run_id,
  });
});
// The cohort's message sequence — the copy the whole queue receives. The
// read/write overload is split into two tools.
app.get('/api/outreach/cohorts/:id/sequence', async (c) => c.json(
  await runTool(c.env, 'read_sequence', { cohort_id: c.req.param('id') }),
));
app.put('/api/outreach/cohorts/:id/sequence', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  // sequence is required by save_sequence's schema, so the `|| {steps: []}`
  // default has to stay in the route.
  const r = await runTool(c.env, 'save_sequence', {
    cohort_id: c.req.param('id'), sequence: b?.sequence || { steps: [] }, scope: b?.scope || 'new_only',
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
// The ONLY route that schedules anything.
app.post('/api/outreach/cohort/go-live', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runTool(c.env, 'launch_members', { lead_ids: b?.lead_ids || [], start_at: b?.start_at || null });
  return r?.error ? c.json(r, 400) : c.json(r);
});
app.get('/api/outreach/cohort/settings', async (c) => c.json(await runTool(c.env, 'read_cadence', {})));
// The old tool READ when the body was empty; save_cadence always writes, so an
// empty PUT is now a no-op write of the current values rather than a read.
app.put('/api/outreach/cohort/settings', async (c) => {
  try { return c.json(await runTool(c.env, 'save_cadence', await c.req.json())); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.get('/api/outreach/wa/thread', async (c) => {
  // Same background freshness as the list route: answer from D1 now, pull
  // the gateway after the response; the 10s thread poll shows what landed.
  c.executionCtx.waitUntil(syncFromGateway(c.env).catch(() => {}));
  const r = await runTool(c.env, 'read_prospect_thread', {
    chat_id: c.req.query('chat_id') || null,
    lead_id: c.req.query('lead_id') || null,
    limit: Number(c.req.query('limit')) || null,
  });
  return r?.error ? c.json(r, 400) : c.json(r);
});
app.post('/api/outreach/wa/draft', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await runWorkflow(c.env, 'draft-prospect-reply', {
    chat_id: b?.chat_id || null, lead_id: b?.lead_id || null, force_llm: !!b?.force_llm,
  });
  if (!r.ok) return c.json({ draft: null, source: 'none', error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  // The composer reads OutreachDraft flat ({draft, source, step, alternatives,
  // first_touch, reason, …}); the drafting chain leaves all of it on the run's
  // shared context, so it is lifted back to the top level here.
  const o = r.output || {};
  return c.json({
    draft: o.draft ?? null, source: o.source ?? 'none',
    lead_id: o.lead_id, reason: o.reason, step: o.step,
    first_touch: o.first_touch, angle: o.angle ?? null,
    alternatives: o.alternatives || [], based_on_messages: o.based_on_messages,
    at: o.at, run_id: r.run_id,
  });
});
// The read/write overload is split into two tools.
app.get('/api/outreach/wa/settings', async (c) => c.json(await runTool(c.env, 'read_drafting_rules', {})));
app.put('/api/outreach/wa/settings', async (c) => {
  try { return c.json(await runTool(c.env, 'save_drafting_rules', await c.req.json())); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── daily planner (per-day plan + weekly objectives; operator + planner chat) ──
app.get('/api/daily-plan', async (c) => {
  const date = c.req.query('date') || (await todayLocal(c.env));
  const plan = await readPlan(c.env, date);
  return c.json({ date, plan });
});
app.put('/api/daily-plan', async (c) => {
  const b = await c.req.json();
  const src = b.plan || b;
  const date = b.date || src.date || (await todayLocal(c.env));
  const plan = await savePlan(c.env, { date, plan: src, mode: src.mode, actor: 'operator' });
  return c.json({ plan });
});
app.get('/api/daily-plan/search', async (c) => {
  const r = await searchPlans(c.env, { query: c.req.query('q') || '', limit: Number(c.req.query('limit')) || 20 });
  return c.json(r);
});
app.get('/api/daily-plan/recent', async (c) => {
  const r = await recentPlans(c.env, { days: Number(c.req.query('days')) || 3 });
  return c.json(r);
});
app.get('/api/weekly-objectives', async (c) => {
  // `week` = a literal week_start; `date` = any day, anchored server-side (the
  // workweek convention lives in weekAnchor — clients never re-derive it).
  const wk = c.req.query('week')
    || (await weekAnchor(c.env, c.req.query('date') || await todayLocal(c.env)));
  const objectives = await readWeeklyObjectives(c.env, wk);
  return c.json({ week_start: wk, objectives });
});
app.put('/api/weekly-objectives', async (c) => {
  const b = await c.req.json();
  const wk = b.week_start || (await weekAnchor(c.env, await todayLocal(c.env)));
  const objectives = await saveWeeklyObjectives(c.env, { week_start: wk, objectives: b.objectives || [], actor: 'operator' });
  return c.json({ objectives });
});

// ─── Hot Takes (editorial command center — topic → take → brief → article → distribute) ──
app.get('/api/hot-takes/packages', async (c) => {
  const statusQ = c.req.query('status');
  const statuses = statusQ ? statusQ.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const packages = await htListPackages(c.env, { statuses, limit: Number(c.req.query('limit')) || 200 });
  return c.json({ packages });
});
// `history=1` widens the lookback to everything we retain (the UI's Load more
// grows `limit` with this set); `q` searches all of it, not just what's loaded;
// `offset` is honoured for API callers. All optional — omitting them returns
// today's feed exactly as before.
app.get('/api/hot-takes/topics-of-the-day', async (c) => {
  const history = c.req.query('history');
  return c.json(await htTopicsOfTheDay(c.env, {
    limit: Number(c.req.query('limit')) || 12,
    offset: Number(c.req.query('offset')) || 0,
    q: c.req.query('q') || '',
    history: history === '1' || history === 'true',
  }));
});
app.post('/api/hot-takes/packages', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const pkg = await htCreatePackage(c.env, { ...b, origin: b.origin || 'manual', pinned: b.pinned ?? 1, actor: 'operator' });
  return c.json({ package: pkg });
});
app.post('/api/hot-takes/topics/pin', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htPinTopic(c.env, b, 'operator') });
});
// Manually remove a Topic-of-the-Day card from the feed (persisted; stays gone).
app.post('/api/hot-takes/topics/dismiss', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htDismissTopicCard(c.env, b, 'operator') });
});
app.post('/api/hot-takes/add-link', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  // fetch_web_page → extract_article_meta → pin_hottake_topic. The Add-link box
  // reads {package}, which is pin_hottake_topic's result on the shared context.
  const r = await runWorkflow(c.env, 'hottake-add-link', { url: b.url, actor: 'operator' });
  if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({ package: r.output?.package ?? null, run_id: r.run_id });
});
app.get('/api/hot-takes/packages/:id', async (c) => {
  const pkg = await htReadPackage(c.env, c.req.param('id'));
  if (!pkg) return c.json({ error: 'not found' }, 404);
  const posts = await htListPosts(c.env, pkg.id);
  return c.json({ package: pkg, posts, next_action: htNextAction(pkg, posts, htReleaseChannels(c.env)) });
});
app.patch('/api/hot-takes/packages/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htPatchPackage(c.env, c.req.param('id'), b, 'operator') });
});
app.post('/api/hot-takes/packages/:id/dismiss', async (c) => {
  return c.json({ package: await htDismissPackage(c.env, c.req.param('id'), 'operator') });
});
// The editorial spine — each step is a shared-pool tool (reasoning via the llm
// gateway); routes just trigger them with the operator actor.
app.post('/api/hot-takes/packages/:id/draft-take', async (c) => {
  const res = await runTool(c.env, 'draft_hottake_take', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/build-brief', async (c) => {
  const res = await runTool(c.env, 'build_hottake_brief', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/write-article', async (c) => {
  // JUDGMENT CALL (docs/route-migrations.md flags it): there is NO v2 tool for
  // "write the article only" — the spec dissolved it into hottake-produce,
  // which STARTS at draft_hottake_take and would overwrite an already-approved
  // take. This is one of three spine buttons the operator presses in order, so
  // pointing it at that workflow would silently redo the two steps before it.
  // Kept on the lib, like the other 15 Hot Takes routes.
  const b = await c.req.json().catch(() => ({}));
  const { writeArticleFromBrief } = await import('./lib/hot-takes.js');
  try {
    const res = await writeArticleFromBrief(c.env, c.req.param('id'), { voice: b.voice, actor: 'operator' });
    return c.json(res, res?.error ? 400 : 200);
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});
app.post('/api/hot-takes/packages/:id/review-scan', async (c) => {
  const res = await runTool(c.env, 'scan_hottake_article', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
// draft_hottake_post / save_hottake_post were cut as twins of the Social
// family's pair, and no `hottake-social-legs` workflow was seeded, so the legs
// are drafted here with the granular tools. read_blog_post (NOT
// link_hottake_article) gathers the article fields: link_hottake_article moves
// the package status back to 'review' and would regress a package already at
// ready/scheduled. save_social_post MUST carry package_id or the legs are
// orphaned from their package — and it REPLACES that package+channel's
// existing unposted leg, which is what makes re-running the Redraft button.
const HOTTAKE_LEG_CHANNELS = ['linkedin-company', 'linkedin-personal'];
async function draftHotTakeLegs(env, { package_id, slug, channels }) {
  const { post } = await runTool(env, 'read_blog_post', { slug });
  if (!post) return { error: `no article to draft from (slug ${slug})` };
  const posts = [];
  for (const channel of channels) {
    const d = await runTool(env, 'draft_social_post', { channel, post, slug: post.slug, package_id });
    if (d.skipped || !d.content) continue;
    const s = await runTool(env, 'save_social_post', {
      channel, content: d.content, slug: post.slug, title: post.title,
      image_url: post.featured_image_url || null, package_id, actor: 'operator',
    });
    if (s.post) posts.push(s.post);
  }
  return { posts };
}
app.post('/api/hot-takes/packages/:id/draft-social', async (c) => {
  // Optional body {channel} narrows to a single-leg redraft.
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const pkg = await runTool(c.env, 'read_hottake_package', { id });
  if (!pkg.found) return c.json({ error: 'not found' }, 400);
  if (!pkg.package?.blog_slug) return c.json({ error: 'package has no article yet' }, 400);
  const res = await draftHotTakeLegs(c.env, {
    package_id: id, slug: pkg.package.blog_slug,
    channels: b?.channel ? [b.channel] : HOTTAKE_LEG_CHANNELS,
  });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/schedule', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'schedule_hottake_release', { id: c.req.param('id'), ...b, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/cancel-schedule', async (c) => {
  const res = await runTool(c.env, 'cancel_hottake_schedule', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
// Plain blog drafts (no package yet) — schedule or social-draft by slug; the
// tool adopts the draft into the release pipeline (ensurePackageForSlug).
app.post('/api/hot-takes/blog/:slug/schedule', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'schedule_hottake_release', { slug: c.req.param('slug'), ...b, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/blog/:slug/draft-social', async (c) => {
  // adopt_blog_draft replaces the old tool's implicit slug → package adoption
  // (it is idempotent), then the same per-channel drafting pair runs.
  const slug = c.req.param('slug');
  const { package: pkg } = await runTool(c.env, 'adopt_blog_draft', { slug, actor: 'operator' });
  if (!pkg?.id) return c.json({ error: 'could not adopt this draft into a package' }, 400);
  const res = await draftHotTakeLegs(c.env, { package_id: pkg.id, slug, channels: HOTTAKE_LEG_CHANNELS });
  return c.json(res?.error ? res : { ...res, package_id: pkg.id }, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/publish-website', async (c) => {
  // publish_blog_post neither mirrors the calendar event nor calls
  // maybeComplete the way lib publishWebsite did, so the save_hottake_package
  // write below is MANDATORY (it is what still moves the package). The
  // auto-complete is lost on this manual path; the cron path is unaffected
  // (POST /api/hot-takes/run-due still goes through lib runDueReleases).
  const id = c.req.param('id');
  try {
    const pkg = await runTool(c.env, 'read_hottake_package', { id });
    if (!pkg.found) return c.json({ error: 'not found' }, 400);
    if (!pkg.package?.blog_slug) return c.json({ error: 'package has no article yet' }, 400);
    const r = await runTool(c.env, 'publish_blog_post', { slug: pkg.package.blog_slug });
    await runTool(c.env, 'save_hottake_package', {
      id, status: 'published', website_status: 'published', website_url: r.url, actor: 'operator',
    });
    return c.json({ ok: r.ok !== false, url: r.url || null, live: r.live ?? null });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/hot-takes/posts/:postId/send', async (c) => {
  // approve_social_post opens the outbox claim push_social_post requires, so
  // claim-then-send stays atomic. Both halves keep the hottakes.live dry-run
  // gate lib postLeg had, and push adds the outbox claim postLeg never took.
  const r = await runWorkflow(c.env, 'social-release-post', { id: c.req.param('postId') });
  if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
  return c.json({
    ok: r.output?.ok !== false, dry_run: !!r.output?.dry_run, would: r.output?.would,
    outbox_id: r.output?.outbox_id ?? null, run_id: r.run_id,
  });
});
app.patch('/api/hot-takes/posts/:postId', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ post: await htPatchPost(c.env, c.req.param('postId'), b, 'operator') });
});
// Views over the same package store — the tabs.
app.get('/api/hot-takes/pipeline', async (c) => c.json(await htPipelineView(c.env)));
app.get('/api/hot-takes/article/:id', async (c) => {
  const v = await htArticleView(c.env, c.req.param('id'));
  return v ? c.json(v) : c.json({ error: 'not found' }, 404);
});
app.patch('/api/hot-takes/article/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await htSaveArticleEdit(c.env, c.req.param('id'), b, 'operator'));
});
app.get('/api/hot-takes/schedule', async (c) => c.json(await htScheduleView(c.env, { days: Number(c.req.query('days')) || 30 })));
app.get('/api/hot-takes/sources', async (c) => c.json(await htListApprovedSources(c.env)));
app.get('/api/hot-takes/search', async (c) => c.json(await htSearch(c.env, { q: c.req.query('q') || '' })));
app.get('/api/hot-takes/notes', async (c) => c.json(await htLoadNotes(c.env)));
app.get('/api/hot-takes/state', async (c) => c.json({ live: await htLive(c.env) }));

// ─── Hot Takes · module first run ─────────────────────────────
// The awareness feed is only useful if it watches the RIGHT things, and a fresh
// install watches whatever shipped in DEFAULT_SOURCES. These five routes are
// the one-time surface that fixes that from inside the module: read what
// onboarding learned, propose validated feeds, save the picks, and remember
// that it ran. Every one of them goes through the shared tool pool — the page
// is a module, so it never reaches a lib or a service directly.
//
// The proposal route is the expensive one (one model call plus up to ~26 real
// feed fetches), which is why it is a POST the operator triggers and never
// something the page does on mount.
app.get('/api/hot-takes/setup', async (c) => {
  try { return c.json(await runTool(c.env, 'read_hottakes_setup', {})); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/hot-takes/setup/propose', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'propose_heartbeat_sources', { hint: body?.hint || '', actor: 'operator' })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
// A pasted feed gets the same proof as a proposed one — the operator should
// never be able to add a URL this module has not successfully parsed.
app.post('/api/hot-takes/setup/validate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  try { return c.json(await runTool(c.env, 'validate_feed_url', { url: String(body.url) })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/hot-takes/setup/apply', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await runTool(c.env, 'save_hottakes_setup', {
      sources: body?.sources || [], targets: body?.targets || [],
      watch: body?.watch || null, ran_ingest: Boolean(body?.ran_ingest), actor: 'operator',
    }));
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/hot-takes/setup/skip', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'skip_hottakes_setup', { reopen: Boolean(body?.reopen), actor: 'operator' })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
// The first sweep, so the Topics tab opens with real cards instead of an empty
// state. Seeds the catalog first: a fresh install has never listed workflows,
// so the row this runs would not exist yet.
app.post('/api/hot-takes/setup/first-ingest', async (c) => {
  const { seedSystemWorkflows } = await import('./workflows/runner.js');
  await seedSystemWorkflows(c.env).catch(() => {});
  try {
    const run = await runWorkflow(c.env, 'hottakes-first-ingest', {}, { trigger_kind: 'manual' });
    // The FEED, not just the synthesized hot topics: the Topics tab renders
    // scored signals alongside clustered topics, so a first sweep that pulled
    // plenty but has too few high scorers to cluster still fills the tab.
    // Reporting only hot topics here would say "nothing came back" about a
    // screen that is visibly full.
    const topics = await runTool(c.env, 'list_topic_feed', { limit: 6 }).catch(() => ({ topics: [] }));
    return c.json({
      ok: Boolean(run?.ok),
      error: run?.ok ? null : (run?.error || null),
      // Straight off the shared workflow context — the counts the operator sees
      // are the ones the steps actually reported, not a re-derived guess.
      inserted: run?.output?.inserted ?? 0,
      scored:   run?.output?.scored ?? 0,
      per_source: run?.output?.per_source || [],
      skipped: run?.skipped || [],
      topics: topics?.topics || [],
    }, run?.ok ? 200 : 500);
  } catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
// Poster identities for the social-post previews — read from the editable
// `hottakes-social-identities` note, never hardcoded.
app.get('/api/hot-takes/social-identities', async (c) => {
  const { loadSocialIdentities } = await import('./lib/hot-takes.js');
  try { return c.json({ identities: await loadSocialIdentities(c.env) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/hot-takes/run-due', async (c) => c.json(await htRunDueReleases(c.env, { ctx: c.executionCtx })));

// ─── Social (auto-drafted social posts from published blog articles) ────
app.get('/api/social/posts', async (c) => c.json(await runTool(c.env, 'list_social_posts', {
  status: c.req.query('status') || null, slug: c.req.query('slug') || null,
})));
app.get('/api/social/settings', async (c) => c.json(await runTool(c.env, 'list_social_integrations', {})));
app.get('/api/social/posts/:id', async (c) => {
  const r = await runTool(c.env, 'read_social_post', { id: c.req.param('id') });
  if (!r.post) return c.json({ error: 'not found' }, 404);
  return c.json({ post: r.post });
});
// Edit a draft's copy before approving.
app.put('/api/social/posts/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await runTool(c.env, 'edit_social_post', { id: c.req.param('id'), content: body.content })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// Approve → push through the gateway under the outbox claim. Logs to Outbox +
// activity. The workflow IS approve-then-push, so the claim stays atomic.
app.post('/api/social/posts/:id/approve', async (c) => {
  try {
    const r = await runWorkflow(c.env, 'social-release-post', { id: c.req.param('id') });
    if (!r.ok) return c.json({ ok: false, error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
    return c.json({ ...r.output, ok: r.output?.ok !== false, run_id: r.run_id }, r.output?.ok === false ? 400 : 200);
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// No v2 tool: the spec expected skip to be covered by a save_hottake_post
// {status:'skipped'} that no family defines. Kept on the lib.
app.post('/api/social/posts/:id/skip', async (c) => {
  try { return c.json({ post: await skipSocialPost(c.env, c.req.param('id')) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/social/posts/:id', async (c) => {
  try { return c.json(await runTool(c.env, 'delete_social_post', { id: c.req.param('id') })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// No v2 tool for a whole-slug group delete either — kept on the lib.
app.delete('/api/social/group/:slug', async (c) => {
  try { return c.json(await deleteSocialGroup(c.env, c.req.param('slug'))); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// Manual (re)generation for a slug — ?force=1 replaces unposted drafts.
app.post('/api/social/generate/:slug', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Same declarative workflow the publish fan-out runs — one definition, one
  // trail. The CLIENT contract stays the tool's result ({ok, drafted, skipped,
  // reason}) + run_id: a runner-level failure (disabled workflow / step threw)
  // maps to 400 like the pre-workflow route did, not a silent 200.
  try {
    const slug = c.req.param('slug');
    const { seedSystemWorkflows } = await import('./workflows/runner.js');
    await seedSystemWorkflows(c.env);
    const r = await runWorkflow(c.env, 'social-drafts-for-article', { slug, force: !!body.force });
    if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
    // MUST be counted per step, not read off the last one: the chain is now 7
    // steps ending in save_social_post, whose result is {post,id} (or
    // {skipped,reason}). Spreading that returned a single post row where the
    // client expects {ok, drafted, skipped, reason}.
    const steps   = r.results || [];
    const drafted = steps.filter((s) => s.tool === 'save_social_post' && s.result?.post).length;
    const skipped = steps.filter((s) => s.result?.skipped).length;
    return c.json({
      ok: true, slug, drafted, skipped,
      reason: drafted ? undefined : steps.map((s) => s.result?.reason).filter(Boolean)[0],
      run_id: r.run_id,
    });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// ─── LinkedIn (via Unipile — hosted sessions, hosted auth) ─
app.get('/api/li/probe', async (c) => c.json(await runTool(c.env, 'probe_linkedin', {})));
// Connecting an account is Unipile's hosted auth page: this returns the URL
// the operator opens. Cookie pasting is gone with the daemon it belonged to.
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

// ─── Heartbeat (OSINT v2 — awareness layer) ──────────────────
app.post('/api/heartbeat/run', async (c) => {
  const { runHeartbeat } = await import('./lib/heartbeat.js');
  try { return c.json(await runHeartbeat(c.env, { actor: 'manual' })); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 500); }
});
// Score gates — the thresholds that decide what survives each stage. They are
// stored in the `heartbeat-priorities` knowledge note, not in code, so these
// routes read/write that note rather than any constant.
app.get('/api/heartbeat/gates', async (c) => {
  const { heartbeatGates } = await import('./lib/heartbeat.js');
  try { return c.json({ gates: await heartbeatGates(c.env) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.put('/api/heartbeat/gates', async (c) => {
  const { patchHeartbeatGates } = await import('./lib/heartbeat.js');
  try { return c.json({ gates: await patchHeartbeatGates(c.env, await c.req.json()) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.get('/api/heartbeat/signals', async (c) => {
  const { topSignals } = await import('./lib/heartbeat.js');
  const minContent = parseInt(c.req.query('min') || '55', 10);
  const days = parseInt(c.req.query('days') || '7', 10);
  return c.json({ signals: await topSignals(c.env, { days, minContent, limit: 30 }) });
});
app.get('/api/heartbeat/pulse', async (c) => {
  const { readPulse } = await import('./lib/heartbeat.js');
  return c.json({ pulse: await readPulse(c.env) });
});
// OSINT hot topics — synthesized, digest-ready angles from the scored signals.
app.post('/api/osint/topics', async (c) => {
  const { synthesizeHotTopics } = await import('./lib/heartbeat.js');
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await synthesizeHotTopics(c.env, body || {})); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 500); }
});
app.get('/api/osint/topics', async (c) => {
  const { topHotTopics } = await import('./lib/heartbeat.js');
  const limit = Number(c.req.query('limit')) || 6;
  return c.json({ topics: await topHotTopics(c.env, { limit }) });
});
app.post('/api/heartbeat/enrich', async (c) => {
  const { enrichSignals } = await import('./lib/heartbeat.js');
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await enrichSignals(c.env, { limit: body.limit || 8, minRelevance: body.minRelevance ?? 50 })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.get('/api/heartbeat/sources', async (c) => {
  const { listHeartbeatSources } = await import('./lib/heartbeat.js');
  return c.json({ sources: await listHeartbeatSources(c.env) });
});
app.post('/api/heartbeat/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { writeHeartbeatSource } = await import('./lib/heartbeat.js');
  try { return c.json({ source: await writeHeartbeatSource(c.env, body) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.patch('/api/heartbeat/sources/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { writeHeartbeatSource } = await import('./lib/heartbeat.js');
  try { return c.json({ source: await writeHeartbeatSource(c.env, { ...body, id: c.req.param('id') }) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/heartbeat/sources/:id', async (c) => {
  const { deleteHeartbeatSource } = await import('./lib/heartbeat.js');
  return c.json(await deleteHeartbeatSource(c.env, c.req.param('id')));
});

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
  // hour's fresh mentions/signals. Every leg logs a workflow_runs row under
  // the same hourly-awareness-sweep slug with output.leg naming it.
  const logLeg = (leg, startedAt, output, error) => logWorkflowRun(env, {
    workflow_slug: 'hourly-awareness-sweep', status: error ? 'failed' : 'succeeded',
    trigger_kind: 'cron', output: { leg, ...(output || {}) }, started_at: startedAt,
    error: error ? `${leg}: ${error}` : null,
  }).catch(console.error);

  if (cron.startsWith('15 ')) {
    ctx.waitUntil((async () => {
      const t0 = Date.now();
      try {
        const { runHeartbeat } = await import('./lib/heartbeat.js');
        const r = await runHeartbeat(env, { actor: 'heartbeat-cron' });
        console.log('[heartbeat-cron]', cron, JSON.stringify({ inserted: r.inserted, scored: r.scored }));
        await logLeg('heartbeat', t0, { inserted: r.inserted, scored: r.scored }, null);
      } catch (e) {
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
        const r = await generateDigest(env, {});
        console.log('[digest-cron]', cron, JSON.stringify({ added: r?.added ?? r?.count ?? null }));
        await logLeg('digest', t0, { added: r?.added ?? r?.count ?? null }, null);
      } catch (e) {
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

  // :00 — OSINT leg. 3h stale window (not the 22h default): each hourly tick
  // re-scrapes any target untouched for 3h; maxTargets 5 bounds one
  // invocation's scrape fan-out (overflow defers, oldest first).
  ctx.waitUntil((async () => {
    const t0 = Date.now();
    try {
      const r = await runOsintCron(env, { actor: 'osint-cron', staleAfterMs: 3 * 60 * 60 * 1000, maxTargets: 5 });
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
      console.error('[osint-cron] unhandled', e?.message || e);
      await logLeg('osint', t0, null, String(e?.message || e));
    }
  })());

  // Hot Takes due-scan — publish scheduled websites + fire scheduled LinkedIn
  // legs that are due. Website publishes are REAL (same trust as the Blog
  // Approve button); LinkedIn legs stay dry-run (log-only) unless the operator
  // set the hottakes.live feature flag. Own waitUntil + own workflow_runs row.
  ctx.waitUntil((async () => {
    const t0 = Date.now();
    try {
      const r = await htRunDueReleases(env, { ctx });
      const n = (r.website_published?.length || 0) + (r.posts_sent?.length || 0);
      if (n || r.errors?.length) console.log('[hottake-cron]', cron, JSON.stringify(r));
      await logWorkflowRun(env, {
        workflow_slug: 'hottake-scheduler', status: r.errors?.length ? 'failed' : 'succeeded',
        trigger_kind: 'cron', output: r, started_at: t0,
        error: r.errors?.length ? JSON.stringify(r.errors).slice(0, 500) : null,
      }).catch(console.error);
    } catch (e) {
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

  // Outreach thread cache — classify the day's outbound WhatsApp by content,
  // resolve the chat names, and refresh the per-thread reply / uncaught /
  // sentiment stats into `outreach_threads`. The Outreach module's
  // Conversations tab reads that cache and never computes it inline, so this
  // leg is what keeps it current. Own waitUntil so a slow pass never blocks
  // the sweep.
  //   The LinkedIn sent-message sync and the outreach-vs-goal KPI snapshot that
  //   used to sit here were read only by the Digest KPI drawer, which is cut.
  ctx.waitUntil((async () => {
    try {
      await refreshOutreachData(env);
      console.log('[outreach-threads-cron]', cron, 'refreshed');
    } catch (e) { console.error('[outreach-threads-cron] unhandled', e?.message || e); }
  })());

  // Digest consideration layer — learn from what the operator dismissed and
  // tune the interest filter (no-op unless enough new dismissals accumulated).
  ctx.waitUntil((async () => {
    try {
      const { learnFromDismissals } = await import('./lib/digest-relevance.js');
      const r = await learnFromDismissals(env, {});
      if (r?.learned) console.log('[digest-learn]', cron, JSON.stringify({ avoid: r.avoid?.length }));
    } catch (e) { console.error('[digest-learn] unhandled', e?.message || e); }
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
