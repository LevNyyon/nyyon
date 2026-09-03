// LLM credit circuit-breaker + local fallback.
//
// "Our LM" = the primary reasoning provider (Anthropic — Nyo mid/high, the
// digest synthesis, module writers). When it runs OUT OF CREDIT (HTTP 400 "credit balance
// is too low" / 402) or REJECTS THE KEY (401/403), we OPEN a circuit:
//   • the operator is alerted once — the sidebar health dot + a Nyo message;
//   • chat + LIGHT jobs (digest extraction, OSINT/ICP scoring, company lookups)
//     fall back to the local Qwen so work continues;
//   • HEAVY writers (AEO articles, GTM outreach angles) PAUSE — a 3B model would
//     produce weak output — with a clear reason instead of a raw error.
// Every real call re-probes Anthropic; the circuit CLOSES (with a recovery
// message) the moment it answers again. Rate-limit (429) and 5xx are transient
// (already retried upstream) and never open the circuit.

import { logEvent, queueNyoMessage } from './db.js';

const PROBE_AFTER_MS = 3 * 60 * 1000; // when down, skip Anthropic for this long, then re-probe

export class LlmDownError extends Error {
  constructor(msg) {
    super(msg || 'The main model is out of credit — heavy generation is paused until it is topped up.');
    this.name = 'LlmDownError';
    this.llmDown = true;
  }
}

// Classify an Anthropic/OpenAI HTTP failure → what opens the circuit.
// Only a genuine credit-out / key-rejection counts; 429 rate-limits and 5xx are
// transient (fetchLLM retries them) and return null.
export function classifyLlmError(status, bodyText = '') {
  const t = String(bodyText || '').toLowerCase();
  if (status === 402) return 'credit';
  if (status === 400 && /credit balance is too low|billing|insufficient|payment/.test(t)) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 && /credit|billing|hard limit|monthly limit/.test(t)) return 'credit';
  return null;
}

export async function getLlmHealth(env) {
  try {
    const r = await env.DB.prepare('SELECT status, reason, since, last_error, last_check FROM llm_health WHERE id = ?').bind('primary').first();
    return r || { status: 'ok', reason: null, since: null, last_error: null, last_check: null };
  } catch {
    return { status: 'ok', reason: null, since: null, last_error: null, last_check: null };
  }
}

async function write(env, { status, reason, since, last_error }) {
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO llm_health (id, status, reason, since, last_error, last_check, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason=excluded.reason, since=excluded.since,
       last_error=excluded.last_error, last_check=excluded.last_check, updated_at=excluded.updated_at`,
  ).bind(status, reason ?? null, since ?? null, last_error ?? null, t, t).run();
}

// Record a credit/auth failure. Opens the circuit + alerts the operator ONCE on
// the ok→down transition (Nyo message + event). Safe to call on every failure.
export async function noteLlmDown(env, reason, lastError) {
  const cur = await getLlmHealth(env);
  const firstTime = cur.status !== 'down';
  await write(env, { status: 'down', reason, since: firstTime ? Date.now() : cur.since, last_error: String(lastError || '').slice(0, 300) });
  if (firstTime) {
    try {
      await logEvent(env, { kind: 'llm_down', actor: 'system', payload: { reason, last_error: String(lastError || '').slice(0, 200) } });
      await queueNyoMessage(env, {
        kind: 'llm_down',
        content: `⚠️ **The main model (Anthropic) is ${reason === 'credit' ? 'out of credit' : 'rejecting the API key'}.**\n\n`
          + `I've switched **chat + light jobs** (digest, OSINT / ICP scoring, company lookups) to the **local model** so you can keep working — replies will be simpler and a bit slower.\n\n`
          + (env.HF_TOKEN
              ? `` : `Background writer jobs are paused until it's back.\n\n`)
          + (reason === 'credit' ? `Top up the Anthropic credit` : `Fix the ANTHROPIC_API_KEY`) + ` and I'll switch back automatically — I'll tell you when.`,
        payload: { reason },
      });
    } catch { /* alerting is best-effort; never block the fallback */ }
  }
}

// Record a success. Closes the circuit + a recovery message ONCE on down→ok.
export async function noteLlmOk(env) {
  const cur = await getLlmHealth(env);
  if (cur.status === 'ok') return; // already healthy — no write, no spam
  await write(env, { status: 'ok', reason: null, since: null, last_error: null });
  try {
    await logEvent(env, { kind: 'llm_recovered', actor: 'system', payload: { down_since: cur.since } });
    await queueNyoMessage(env, {
      kind: 'llm_recovered',
      content: `✅ **The main model is back.** Chat + jobs are back on Anthropic, and the heavy writer jobs are live again.`,
      payload: {},
    });
  } catch { /* best-effort */ }
}

// When the circuit is down and freshly probed, skip Anthropic entirely (don't
// hammer a dead endpoint on every call) — but re-probe after PROBE_AFTER_MS so
// recovery is automatic.
export async function skipPrimary(env) {
  const h = await getLlmHealth(env);
  if (h.status !== 'down') return false;
  return (Date.now() - (h.last_check || 0)) < PROBE_AFTER_MS;
}

// Preamble guard for a non-streaming Anthropic text caller. Anthropic is the
// only provider: with no key, or while the credit breaker is open, the job
// pauses (LlmDownError) instead of running somewhere worse.
export async function guardLlm(env) {
  const noKey = !env.ANTHROPIC_API_KEY;
  if (noKey || (await skipPrimary(env))) {
    throw new LlmDownError(noKey ? 'ANTHROPIC_API_KEY not set' : 'The main model is out of credit.');
  }
  return { skip: false };
}

// Handle a non-ok Anthropic response for a non-streaming text caller. On a
// credit/auth error: opens the circuit and throws LlmDownError. On a
// transient/other error: throws a plain Error (no circuit change) so the
// existing retry/surfacing still applies.
export async function handleLlmFailure(env, status, bodyText) {
  const cls = classifyLlmError(status, bodyText);
  if (cls) {
    await noteLlmDown(env, cls, `${status}: ${String(bodyText).slice(0, 200)}`);
    throw new LlmDownError(`The main model is ${cls === 'credit' ? 'out of credit' : 'rejecting the key'}.`);
  }
  throw new Error(`LLM error ${status}: ${String(bodyText).slice(0, 300)}`);
}
