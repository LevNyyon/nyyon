// Boundary to ONE service: Groq's OpenAI-compatible API.
// Reads only its own provider row; never sees env. capability 'llm-backup'
// is how the host chat engine discovers it without knowing the plugin.
async function row(api) {
  return api.DB.prepare(
    "SELECT api_key, model, active FROM plugin_free_llm_providers WHERE provider = 'groq'",
  ).first().catch(() => null);
}
async function post(key, body, timeoutMs = 90000) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch { /* prose */ }
  return { http: r.status, ok: r.ok, json, text };
}
const errOf = (r) => String(r.json?.error?.message || r.text || `HTTP ${r.http}`).slice(0, 300);

export const gateway = {
  slug: 'groq',
  service: 'Groq (api.groq.com, OpenAI-compatible)',
  description: 'Free LLM provider. Fast; tight per-minute token limits on the free tier.',
  capability: 'llm-backup',
  modes: {
    // Which model can THIS key actually converse with? Groq retires names
    // under people's feet, so the answer is discovered, never hardcoded.
    discover: async (api, input) => {
      const key = String(input?.api_key || '').trim();
      if (!key) return { ok: false, error: 'api_key required' };
      const lr = await fetch('https://api.groq.com/openai/v1/models', {
        signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${key}` },
      });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return { ok: false, error: String(ld?.error?.message || `HTTP ${lr.status}`).slice(0, 200) };
      const ids = (ld?.data || []).map((m) => String(m?.id || ''))
        .filter((id) => id && !/whisper|tts|guard|embed|vision|safety|orpheus|compound|allam/i.test(id));
      const rank = (id) =>
        /gpt-oss-120b/i.test(id) ? 0 : /llama.*70b/i.test(id) ? 1 :
        /qwen.*2[0-9]b|70b|72b/i.test(id) ? 2 : /gpt-oss/i.test(id) ? 3 : /llama/i.test(id) ? 4 : 5;
      const candidates = [...ids].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
      let lastErr = 'no usable chat models on this key';
      for (const model of candidates) {
        const r = await post(key, { model, max_tokens: 40, messages: [{ role: 'user', content: 'say ok' }] }, 30000);
        if (r.ok && r.json?.choices?.[0]) return { ok: true, model };
        lastErr = errOf(r);
      }
      return { ok: false, error: lastErr };
    },
    status: async (api) => {
      const r = await row(api);
      return { connected: !!r?.api_key, active: r ? r.active !== 0 : false, model: r?.model || null, label: 'Groq' };
    },
    probe: async (api) => {
      const r = await row(api);
      if (!r?.api_key) return { ok: false, error: 'not connected' };
      const p = await post(r.api_key, { model: r.model, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }, 30000);
      return p.ok && p.json?.choices?.[0]
        ? { ok: true, label: 'Groq', model: r.model, reply: String(p.json.choices[0].message?.content || '').trim().slice(0, 80) }
        : { ok: false, http: p.http, error: errOf(p) };
    },
    chat: async (api, input) => {
      const r = await row(api);
      if (!r?.api_key) return { ok: false, status: 0, error: 'Groq is not connected' };
      const body = {
        model: String(input?.model || r.model),
        messages: input?.messages || [],
        max_tokens: Math.min(Math.max(Number(input?.max_tokens) || 2000, 1), 8000),
      };
      if (Array.isArray(input?.tools) && input.tools.length) { body.tools = input.tools; body.tool_choice = 'auto'; }
      const p = await post(r.api_key, body);
      return { ok: p.ok && !!p.json, status: p.http, provider: 'groq', model: body.model, body: p.json, error: p.ok && p.json ? null : errOf(p) };
    },
  },
};
