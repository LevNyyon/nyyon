// The backup brain: a free LLM provider reached over its OpenAI-compatible
// endpoint.
//
// Why this lives in a PLUGIN and not in the host: the key belongs to whoever
// installs it, the free-tier landscape changes faster than the app does, and a
// plugin gateway is handed nothing but its own scoped tables — it cannot read
// env, so it can never see the operator's real model key. The blast radius of
// installing someone's model plugin is exactly this one table.
//
// `chat` is the only mode the host chat loop needs: OpenAI-shaped request in,
// OpenAI-shaped response out. The host already translates Anthropic <-> OpenAI,
// so this is a transport, not a translator.

const PROVIDERS = {
  groq: {
    label: 'Groq',
    default_model: 'openai/gpt-oss-120b',
    base: () => 'https://api.groq.com/openai/v1',
    signup: 'console.groq.com/keys',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    default_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    base: (cfg) => `https://api.cloudflare.com/client/v4/accounts/${String(cfg.account_id || '').trim()}/ai/v1`,
    signup: 'dash.cloudflare.com → AI → Workers AI',
  },
};

async function readCfg(api) {
  const r = await api.DB.prepare(
    'SELECT provider, api_key, model, account_id FROM plugin_free_llm_config WHERE id = 1',
  ).first().catch(() => null);
  if (!r || !r.provider || !r.api_key) return null;
  const p = PROVIDERS[r.provider];
  if (!p) return null;
  if (r.provider === 'cloudflare' && !String(r.account_id || '').trim()) return null;
  return { ...r, model: r.model || p.default_model, base: p.base(r), label: p.label };
}

// Every provider's compat layer is strict about something different. Cloudflare
// rejects `content: null` and array content outright (the host sends both:
// null alongside tool_calls, arrays for tool results), which is exactly how a
// working fallback turns into a 400 mid-conversation. Flatten to plain strings
// once, here, and every provider accepts the same payload.
function normalize(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    const msg = { role: m.role };
    if (typeof m.content === 'string') msg.content = m.content;
    else if (Array.isArray(m.content)) {
      msg.content = m.content
        .map((b) => (typeof b === 'string' ? b : String(b?.text ?? b?.content ?? '')))
        .filter(Boolean).join('\n');
    } else msg.content = '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;
    out.push(msg);
  }
  return out;
}

async function post(cfg, body, timeoutMs = 90000) {
  const r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* provider returned prose */ }
  return { http: r.status, ok: r.ok, json, text };
}

export const gateway = {
  slug: 'backup-llm',
  service: 'a free LLM provider (Groq or Cloudflare Workers AI) over its OpenAI-compatible endpoint',
  description: 'A backup brain for when the main model has no key or no credit. Holds its own key in its own table; never sees env.',
  // How the host FINDS this without knowing the plugin's name. Any plugin
  // advertising llm-backup can serve as the fallback brain.
  capability: 'llm-backup',
  modes: {
    // What is connected, without spending a request.
    status: async (api) => {
      const cfg = await readCfg(api);
      if (!cfg) return { connected: false, providers: Object.entries(PROVIDERS).map(([k, p]) => ({ key: k, label: p.label, default_model: p.default_model, signup: p.signup })) };
      return { connected: true, provider: cfg.provider, label: cfg.label, model: cfg.model };
    },

    // One real (tiny) request, so "connected" means answering, not just saved.
    probe: async (api) => {
      const cfg = await readCfg(api);
      if (!cfg) return { ok: false, error: 'nothing connected yet' };
      const r = await post(cfg, { model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }, 30000);
      const reply = r.json?.choices?.[0]?.message?.content;
      if (!r.ok || !reply) {
        return { ok: false, http: r.http, provider: cfg.provider, model: cfg.model, error: String(r.json?.error?.message || r.json?.errors?.[0]?.message || r.text || `HTTP ${r.http}`).slice(0, 300) };
      }
      return { ok: true, provider: cfg.provider, label: cfg.label, model: cfg.model, reply: String(reply).trim().slice(0, 80) };
    },

    // The transport the host chat loop calls.
    chat: async (api, input) => {
      const cfg = await readCfg(api);
      if (!cfg) return { ok: false, status: 0, error: 'no free model connected — open the Free LLM page and paste a key' };
      const body = {
        model: String(input?.model || cfg.model),
        messages: normalize(input?.messages),
        max_tokens: Math.min(Math.max(Number(input?.max_tokens) || 2000, 1), 8000),
      };
      if (Array.isArray(input?.tools) && input.tools.length) {
        body.tools = input.tools;
        body.tool_choice = 'auto';
      }
      const r = await post(cfg, body);
      return {
        ok: r.ok && !!r.json,
        status: r.http,
        provider: cfg.provider,
        model: cfg.model,
        body: r.json,
        error: r.ok && r.json ? null : String(r.json?.error?.message || r.json?.errors?.[0]?.message || r.text || `HTTP ${r.http}`).slice(0, 400),
      };
    },
  },
};
