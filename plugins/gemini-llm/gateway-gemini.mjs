// Boundary to ONE service: the Google Gemini API — NATIVE protocol.
//
// Google's OpenAI-compatible shim answers instantly for retired models and
// HANGS on current ones (verified live: /models fine, 2.5-flash errors fast,
// 3.6-flash never answers). The native endpoint answers in under two seconds.
// Translating in and out is exactly a gateway's job, so this speaks native
// Gemini and presents the OpenAI shape the host chat engine expects.
// capability 'llm-backup' is how the host discovers it — never by name.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function row(api) {
  return api.DB.prepare(
    'SELECT api_key, model, active FROM plugin_gemini_llm_config WHERE id = 1',
  ).first().catch(() => null);
}
async function call(key, path, body, timeoutMs = 90000) {
  const r = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch { /* prose */ }
  return { http: r.status, ok: r.ok, json, text };
}
const errOf = (r) => String(r.json?.error?.message || r.json?.[0]?.error?.message || r.text || `HTTP ${r.http}`).slice(0, 300);

// OpenAI-shaped conversation -> native contents[]. Tool results need the
// function NAME (native has no call ids), so ids are mapped back to names
// from the assistant turn that made the call.
function toNative(messages) {
  let system = null;
  const contents = [];
  const nameById = {};
  for (const m of messages || []) {
    if (m.role === 'system') { system = (system ? system + '\n\n' : '') + String(m.content || ''); continue; }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const c of m.tool_calls || []) {
        nameById[c.id] = c.function?.name;
        let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* empty */ }
        parts.push({ functionCall: { name: c.function?.name, args } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      const name = m.name || nameById[m.tool_call_id] || 'tool';
      let response; try { response = JSON.parse(m.content); } catch { response = { result: String(m.content ?? '') }; }
      if (response === null || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] });
  }
  return { system, contents };
}

// Native candidate -> the OpenAI response shape the host translates onward.
function toOpenAi(json, model) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  const calls = parts.filter((p) => p.functionCall).map((p, i) => ({
    id: `call_${i}_${p.functionCall.name}`,
    type: 'function',
    function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
  }));
  return {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: calls.length ? 'tool_calls' : 'stop',
    }],
    model,
    usage: json?.usageMetadata || undefined,
  };
}

export const gateway = {
  slug: 'gemini',
  service: 'Google Gemini (generativelanguage.googleapis.com, native API)',
  description: 'Free LLM provider with limits that fit real tool-calling conversations. Speaks the native Gemini protocol.',
  capability: 'llm-backup',
  modes: {
    discover: async (api, input) => {
      const key = String(input?.api_key || '').trim();
      if (!key) return { ok: false, error: 'api_key required' };
      const lr = await call(key, '/models', null, 20000);
      if (!lr.ok) return { ok: false, error: errOf(lr) };
      const ids = (lr.json?.models || []).map((m) => String(m?.name || '').replace(/^models\//, ''))
        .filter((id) => /gemini/i.test(id) && !/embed|image|vision|tts|audio|live|aqa|learnlm|veo|imagen/i.test(id));
      const ver = (id) => Number((id.match(/gemini-([0-9]+(?:\.[0-9]+)?)/i) || [])[1] || 0);
      const rank = (id) =>
        (/flash/i.test(id) && !/lite|preview/i.test(id)) ? 0 :
        (/flash/i.test(id) && !/lite/i.test(id)) ? 1 :
        /pro/i.test(id) ? 2 : 3;
      const candidates = [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a)).slice(0, 3);
      let lastErr = 'no usable chat models on this key';
      for (const model of candidates) {
        const r = await call(key, `/models/${model}:generateContent`,
          { contents: [{ role: 'user', parts: [{ text: 'say ok' }] }], generationConfig: { maxOutputTokens: 60 } }, 30000);
        if (r.ok && r.json?.candidates?.[0]) return { ok: true, model };
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
      const p = await call(r.api_key, `/models/${r.model}:generateContent`,
        { contents: [{ role: 'user', parts: [{ text: 'say ok' }] }], generationConfig: { maxOutputTokens: 60 } }, 30000);
      const text = (p.json?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
      return p.ok && p.json?.candidates?.[0]
        ? { ok: true, label: 'Google Gemini', model: r.model, reply: text.trim().slice(0, 80) }
        : { ok: false, http: p.http, error: errOf(p) };
    },
    chat: async (api, input) => {
      const r = await row(api);
      if (!r?.api_key) return { ok: false, status: 0, error: 'Gemini is not connected' };
      const model = String(input?.model || r.model);
      const { system, contents } = toNative(input?.messages);
      const body = {
        contents,
        generationConfig: { maxOutputTokens: Math.min(Math.max(Number(input?.max_tokens) || 2000, 1), 8192) },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (Array.isArray(input?.tools) && input.tools.length) {
        body.tools = [{ functionDeclarations: input.tools.map((t) => ({
          name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters,
        })) }];
      }
      const p = await call(r.api_key, `/models/${model}:generateContent`, body);
      if (!p.ok || !p.json?.candidates?.[0]) return { ok: false, status: p.http, provider: 'gemini', model, error: errOf(p) };
      return { ok: true, status: p.http, provider: 'gemini', model, body: toOpenAi(p.json, model), error: null };
    },
  },
};
