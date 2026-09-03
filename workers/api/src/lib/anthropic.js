// The Anthropic client. Two jobs: the raw streaming transport the chat loop
// uses (llmTransportAnthropic) and the text/json completion the llm gateway
// hands to pack writers. The exported names callOpenAIText/callOpenAIJson are
// historic and kept only because installed packs call the gateway modes by
// those shapes; there is no OpenAI here.

import { guardLlm, handleLlmFailure, noteLlmOk } from './llm.js';
import { loadModelConfig } from './model-config.js';
import { withResolvedCredentials } from './gateway-config.js';


// Parse JSON that may arrive wrapped in ```json fences or with prose around it
// (Anthropic has no response_format, so we tolerate both).
export function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* noop */ } }
  throw new Error(`LLM returned non-JSON: ${String(text).slice(0, 200)}`);
}

// Transient upstream errors self-heal instead of surfacing as a failed generate:
// Anthropic returns 503/529 ("Overloaded") under load, plus the usual rate-limit /
// gateway hiccups. Retry with exponential backoff + jitter, honouring Retry-After.
// After the attempts are spent it returns the failed response so the caller still
// throws loudly (a real outage is not silently swallowed).
// ponytail: fixed 4 attempts / 8s cap — bump if provider load gets worse.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
// Internal only — every LLM caller goes through the entry points below, never
// this raw transport. (Was exported; digest.js/gtm.js/chat each ran their own
// parallel provider boundary on top of it — the four-boundaries violation.)
async function fetchLLM(url, init, { attempts = 4, baseMs = 600 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    try {
      const r = await fetch(url, init);
      if (r.ok || !RETRYABLE_STATUS.has(r.status) || last) return r;
      const ra = parseInt(r.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : baseMs * 2 ** i + Math.random() * 250;
      await new Promise((res) => setTimeout(res, Math.min(wait, 8000)));
    } catch (e) {
      if (last) throw e; // network error on the final try
      await new Promise((res) => setTimeout(res, baseMs * 2 ** i + Math.random() * 250));
    }
  }
}

// ── raw transports for the interactive chat loop ──────────────────────────
// The Nyo chat builds rich payloads (tool schemas, cache_control breakpoints,
// deferred tools) and consumes raw Responses. These two passthroughs keep that
// payload logic in chat/ while the PHYSICAL provider boundary (endpoints,
// auth headers, retry) lives here — the llm gateway is the only file that
// talks to a provider.
export async function llmTransportAnthropic(env, body, { timeoutMs = 60_000 } = {}) {
  // DB-first credentials (lib/gateway-config.js): the key an operator pasted
  // into the onboarding chat lives in D1, not env. No-op without one.
  env = await withResolvedCredentials(env);
  return fetchLLM('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, { attempts: 1 }); // chat loop does its own tier fallback; no blind retries
}

async function callAnthropicText(env, { system, prompt, model = null, wantJson = false, max_tokens = 6000 }) {
  // Honour an explicit Claude model; map cheap OpenAI overrides (gpt-*-mini)
  // to Haiku; otherwise use the configured Anthropic model. Never pass a
  // gpt-* string through — the Messages API would 404.
  const mc = await loadModelConfig(env);
  const useModel = model && /^claude/i.test(model)
    ? model
    : (model && /mini|small|haiku/i.test(model))
      ? mc.writer_small
      : mc.writer;

  const sys = wantJson
    ? `${system ? system + '\n\n' : ''}Respond with ONLY the raw JSON — no markdown fences, no prose.`
    : system;

  // Circuit-breaker: no key or out of credit pauses the job (LlmDownError)
  // instead of writing somewhere worse.
  await guardLlm(env);

  const r = await fetchLLM('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: useModel,
      max_tokens,
      system: sys || undefined,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    // credit/auth → open circuit + LlmDownError; transient/other → plain throw.
    return handleLlmFailure(env, r.status, await r.text().catch(() => ''));
  }
  await noteLlmOk(env);
  const json = await r.json();
  const text = (json.content || []).map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Anthropic returned no content');
  return text;
}

export async function callOpenAIText(env, { system, prompt, model = null, response_format = null, max_tokens = 6000 }) {
  // The LLM entry point every non-chat writer comes through, so this is where
  // a DB-configured key becomes live (see lib/gateway-config.js).
  env = await withResolvedCredentials(env);
  return callAnthropicText(env, { system, prompt, model, wantJson: response_format?.type === 'json_object', max_tokens });
}

// Convenience: ask for strict JSON and parse it (tolerant of fenced output).
export async function callOpenAIJson(env, opts) {
  const text = await callOpenAIText(env, {
    ...opts,
    response_format: { type: 'json_object' },
  });
  return parseJsonLoose(text);
}
