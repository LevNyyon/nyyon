// Digest plugin — draft voice: learn the operator's WA voice from his edits.
// Ported from cmd's workers/api/src/lib/draft-voice.js under the plugin
// capability contract (api first, imports NOTHING).
//
// Every LI-signal card carries an AI draft. When the operator edits it
// before sending, the delta between the AI's words and his words IS the
// style lesson. The distiller turns each edit into at most a few durable
// rules, kept in the plugin-digest-wa-draft-voice knowledge doc (editable
// by hand too). The loop closes: draft → edit → distill → better draft.
// Gateway: llm(text).

const DOC_SLUG = 'plugin-digest-wa-draft-voice';
const MAX_RULES = 25;
const DISTILL_PROMPT = 'You maintain a short list of durable STYLE rules describing how an operator rewrites AI-drafted WhatsApp outreach messages into his own voice. Compare the AI draft with the operator\'s final edit, extract at most 3 NEW durable style rules (tone, length, phrasing, structure, language choice), merge them with the existing rules, drop duplicates and one-off content differences, keep the list under {max_rules} rules, each one short and imperative. Return STRICT JSON: {"rules":["..."]}';

const DEFAULTS = { rules: [], max_rules: MAX_RULES, distill_prompt: DISTILL_PROMPT };

const seedBody = (rules, cfg = DEFAULTS) => `# WhatsApp draft voice

Style rules for the drafted outreach messages on Digest LI-signal cards,
learned automatically from the operator's own edits before sending (and
editable here by hand). The draft writer follows every rule below;
max_rules caps the list and distill_prompt steers the distiller.

\`\`\`json
${JSON.stringify({ rules, max_rules: cfg.max_rules ?? MAX_RULES, distill_prompt: cfg.distill_prompt ?? DISTILL_PROMPT }, null, 2)}
\`\`\`
`;

export async function loadDraftVoice(api) {
  let doc = null;
  try { doc = await api.knowledge(DOC_SLUG); } catch { doc = null; }
  if (!doc) {
    await api.saveKnowledge(DOC_SLUG, { title: 'WhatsApp draft voice', body: seedBody([]) }).catch(() => {});
    doc = { body: seedBody([]) };
  }
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const parsed = m ? JSON.parse(m[1]) : null;
    if (parsed && Array.isArray(parsed.rules)) {
      return {
        rules: parsed.rules.filter((r) => typeof r === 'string'),
        max_rules: Number(parsed.max_rules) || MAX_RULES,
        distill_prompt: (typeof parsed.distill_prompt === 'string' && parsed.distill_prompt) || DISTILL_PROMPT,
      };
    }
  } catch { /* malformed edit must not break drafting — defaults win */ }
  return DEFAULTS;
}

// One edit → distilled rules. Fired after a send whose final text differs
// from the AI draft; failures are logged, never surfaced to the send path.
export async function distillDraftEdit(api, { before, after }) {
  const a = String(before || '').trim();
  const b = String(after || '').trim();
  if (!a || !b || a === b) return { ok: true, skipped: 'no edit' };
  try {
    const cfg = await loadDraftVoice(api);
    const raw = await api.gateway('llm', 'text', {
      system: cfg.distill_prompt.replace('{max_rules}', String(cfg.max_rules)),
      prompt: `EXISTING RULES:\n${JSON.stringify(cfg.rules)}\n\nAI DRAFT:\n"${a.slice(0, 800)}"\n\nOPERATOR'S FINAL VERSION:\n"${b.slice(0, 800)}"`,
      max_tokens: 700,
    });
    const s = String(raw || '');
    const merged = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    const next = (Array.isArray(merged.rules) ? merged.rules : [])
      .filter((r) => typeof r === 'string' && r.trim()).slice(0, cfg.max_rules);
    if (!next.length) return { ok: true, skipped: 'nothing distilled' };
    await api.saveKnowledge(DOC_SLUG, { title: 'WhatsApp draft voice', body: seedBody(next, cfg) });
    await api.log('wa_draft_voice_updated', { rules: next.length, before_chars: a.length, after_chars: b.length });
    return { ok: true, rules: next.length };
  } catch (e) {
    await api.log('wa_draft_voice_error', { error: String((e && e.message) || e).slice(0, 200) }).catch(() => {});
    return { ok: false, error: String((e && e.message) || e) };
  }
}
