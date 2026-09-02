// Boundary to ONE service: Google Gemini's OpenAI-compatible endpoint.
// Reads only its own provider row; never sees env. capability 'llm-backup'
// is how the host chat engine discovers it without knowing the plugin.
async function row(api) {
  return api.DB.prepare(
    "SELECT api_key, model, active FROM plugin_free_llm_providers WHERE provider = 'gemini'",
  ).first().catch(() => null);
}
async function post(key, body, timeoutMs = 90000) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
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
  slug: 'gemini',
  service: 'Google Gemini (generativelanguage.googleapis.com, OpenAI-compatible)',
  description: 'Free LLM provider. Generous free limits — the free tier that actually fits a tool-calling agent.',
  capability: 'llm-backup',
  modes: {
    // Which model can THIS key actually converse with? providers retire names
    // under people's feet, so the answer is discovered, never hardcoded.
    discover: async (api, input) => {
      const key = String(input?.api_key || '').trim();
      if (!key) return { ok: false, error: 'api_key required' };
      const lr = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', {
        signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${key}` },
      });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return { ok: false, error: String(ld?.error?.message || `HTTP ${lr.status}`).slice(0, 200) };
      const ids = (ld?.data || []).map((m) => String(m?.id || ''))
        .filter(Boolean);
      // Gemini's compat endpoint prefixes ids with 'models/'. Prefer the
      // newest full-fat flash (speed + the biggest free budget), then pro,
      // then flash-lite.
      const clean = ids.map((id) => id.replace(/^models\//, ''))
        .filter((id) => /gemini/i.test(id) && !/embed|image|vision|tts|audio|live|aqa|learnlm|thinking|exp/i.test(id));
      const ver = (id) => Number((id.match(/gemini-([0-9]+(?:\.[0-9]+)?)/i) || [])[1] || 0);
      const rank = (id) =>
        (/flash/i.test(id) && !/lite/i.test(id)) ? 0 : /pro/i.test(id) ? 1 : /flash/i.test(id) ? 2 : 3;
      const candidates = [...clean].sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a)).slice(0, 3);
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
      return { connected: !!r?.api_key, active: r ? r.active !== 0 : false, model: r?.model || null, label: 'Google Gemini' };
    },
    probe: async (api) => {
      const r = await row(api);
      if (!r?.api_key) return { ok: false, error: 'not connected' };
      const p = await post(r.api_key, { model: r.model, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }, 30000);
      return p.ok && p.json?.choices?.[0]
        ? { ok: true, label: 'Google Gemini', model: r.model, reply: String(p.json.choices[0].message?.content || '').trim().slice(0, 80) }
        : { ok: false, http: p.http, error: errOf(p) };
    },
    chat: async (api, input) => {
      const r = await row(api);
      if (!r?.api_key) return { ok: false, status: 0, error: 'Gemini is not connected' };
      const body = {
        model: String(input?.model || r.model),
        messages: input?.messages || [],
        max_tokens: Math.min(Math.max(Number(input?.max_tokens) || 2000, 1), 8000),
      };
      if (Array.isArray(input?.tools) && input.tools.length) { body.tools = input.tools; body.tool_choice = 'auto'; }
      const p = await post(r.api_key, body);
      return { ok: p.ok && !!p.json, status: p.http, provider: 'gemini', model: body.model, body: p.json, error: p.ok && p.json ? null : errOf(p) };
    },
  },
};
