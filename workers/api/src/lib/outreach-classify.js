// Outreach content classifier — reads each outbound WhatsApp message and decides
// whether it's a GENUINE outreach pitch (aligned with our outreach content) or
// just a follow-up / reply / personal message. This is what lets the KPI count
// real outreach instead of every message you happened to send.
//
// nyyon-lite placement: a reasoning helper behind the KPI. It reaches the model
// ONLY through the `llm` gateway (callGateway(env,'llm','text',…) — the single
// sanctioned LLM boundary), on the knowledge-backed `writer_small` model tier
// (llm-models doc), reads its rubric from an editable knowledge note
// (outreach-signature) grounded in the real gtm-outreach guide, and caches every
// verdict in wa_outreach_class so a message is classified once. Light call →
// falls back to the local model if the main model is down (low-stakes).

import { now } from './util.js';
import { readKnowledge, writeKnowledge, logEvent } from './db.js';
import { callGateway } from '../gateways/index.js';
import { loadModelConfig } from './model-config.js';
import { gtmDoc } from './gtm-context.js';

const SIG_SLUG = 'outreach-signature';

const SIGNATURE_DEFAULT = `What a GENUINE outreach message looks like (counts toward the KPI):
- A first-touch / cold message opening a conversation with a prospect.
- Introduces who we are (Lev / Nyyon — a forward-deployed AI consultancy) or leads with a personalized hook, then makes a soft ask (connect, a quick call, sharing something relevant).
- Reads like a deliberate business pitch, even when personalized and casual.

What is NOT outreach (does NOT count):
- Follow-up nudges on an existing thread ("did you see my message?", "just bumping this").
- Replies continuing an ongoing conversation (answering a question, logistics, scheduling).
- Personal / social messages to friends or acquaintances ("yo, how are you", catching up).
- Operational chatter (invoices, expenses, files, internal coordination).

Rule of thumb: if this message is the kind of thing we'd send a brand-new prospect to START a business relationship, it's outreach. If it only makes sense as part of an existing relationship or thread, it's not.`;

function sigSeedBody(sig) {
  return `Outreach signature — the rubric the KPI uses to tell a genuine outreach message from a follow-up or personal chat.

The classifier reads each outbound WhatsApp message and, using this rubric plus the real \`gtm-outreach\` guide, decides is_outreach true/false. Edit this note to tune what counts — e.g. add phrases your outreach always uses, or examples of messages that should NOT count. Changes apply to newly-classified messages with no deploy.

---
${sig}
`;
}

export async function loadSignature(env) {
  try {
    const doc = await readKnowledge(env, SIG_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: SIG_SLUG, title: 'Outreach · signature (KPI classifier rubric)',
        body: sigSeedBody(SIGNATURE_DEFAULT), parent_slug: 'module-digest',
      }).catch(() => {});
      return { rubric: SIGNATURE_DEFAULT, source: 'defaults' };
    }
    // the rubric is everything after the '---' separator, else the whole body
    const body = String(doc.body || '');
    const idx = body.indexOf('\n---\n');
    return { rubric: (idx >= 0 ? body.slice(idx + 5) : body).trim() || SIGNATURE_DEFAULT, source: 'doc' };
  } catch {
    return { rubric: SIGNATURE_DEFAULT, source: 'defaults' };
  }
}

export async function saveSignature(env, rubric) {
  const clean = String(rubric || '').trim() || SIGNATURE_DEFAULT;
  await writeKnowledge(env, {
    slug: SIG_SLUG, title: 'Outreach · signature (KPI classifier rubric)',
    body: sigSeedBody(clean), parent_slug: 'module-digest',
  });
  await logEvent(env, { kind: 'outreach_signature_updated', payload: { chars: clean.length } });
  return { rubric: clean, source: 'doc' };
}

// Classify a batch of messages in ONE LLM call. Returns Map<msg_id, {is,reason}>.
// Channel-agnostic: items are { id, body } — reused for LinkedIn sent messages.
export async function classifyBatch(env, items) {
  const { rubric } = await loadSignature(env);
  const guide = await gtmDoc(env, 'gtm-outreach', '').catch(() => '');
  const system = `You label WhatsApp messages as genuine business OUTREACH or not, for a sales KPI.

${rubric}

${guide ? `Our actual outreach guide (source of truth for what our outreach content sounds like):\n${String(guide).slice(0, 2500)}\n` : ''}
You will get a numbered list of outbound messages (messages WE sent). For each, decide if it is a genuine outreach pitch (true) or not (false). Judge by CONTENT and language, not length. Messages may be in Hebrew or English.
Return STRICT JSON only: {"verdicts":[{"i":<number>,"outreach":true|false,"why":"<=6 words"}]}`;
  const prompt = items.map((it, n) => `[${n}] ${String(it.body || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const maxTokens = Math.min(4000, 300 + items.length * 60);
  // Classification is a cheap utility call → the knowledge-backed `writer_small`
  // tier (llm-models doc; default Haiku). Runs through the ONLY sanctioned LLM
  // boundary (the `llm` gateway → circuit breaker → local fallback), never a
  // direct model call. heavy:false so it degrades to the local model if the
  // main model is down instead of pausing.
  const model = (await loadModelConfig(env)).writer_small;
  const raw = await callGateway(env, 'llm', 'text', { system, prompt, model, max_tokens: maxTokens, heavy: false });
  // Parse tolerantly: pull each {"i":N,...,"outreach":true|false,...,"why":"..."}
  // with a regex instead of JSON.parse-ing the whole reply — survives code
  // fences and a truncated final object (we keep every verdict that completed).
  const map = new Map();
  const s = String(raw || '');
  const re = /"i"\s*:\s*(\d+)[\s\S]{0,80}?"outreach"\s*:\s*(true|false)(?:[\s\S]{0,20}?"why"\s*:\s*"([^"]{0,120})")?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const it = items[Number(m[1])];
    if (it) map.set(it.id, { is: m[2] === 'true' ? 1 : 0, reason: (m[3] || '').slice(0, 120) });
  }
  if (map.size === 0) { const e = new Error(`classify parse failed: ${s.slice(0, 200)}`); e.raw = s.slice(0, 4000); throw e; }
  // anything the model skipped → default not-outreach (conservative)
  for (const it of items) if (!map.has(it.id)) map.set(it.id, { is: 0, reason: 'unclassified' });
  return map;
}

// Ensure every outbound 1:1 WhatsApp message since `sinceMs` has a cached
// verdict. Bounded per call; safe to call on read paths (returns fast when
// everything's already classified). Returns count newly classified.
// Returns a diagnostic object: { classified, pending, error?, raw? }. Never
// throws — read paths call it fire-and-forget.
export async function ensureClassified(env, sinceMs, { limit = 80 } = {}) {
  let pending;
  try {
    pending = (await env.DB.prepare(
      `SELECT m.id, m.chat_id, m.body FROM wa_messages m
       LEFT JOIN wa_outreach_class c ON c.msg_id = m.id
       WHERE m.from_me = 1 AND m.chat_id NOT LIKE '%@g.us' AND m.timestamp >= ?
         AND c.msg_id IS NULL AND m.body IS NOT NULL AND length(trim(m.body)) > 1
       ORDER BY m.timestamp DESC LIMIT ?`,
    ).bind(sinceMs, limit).all()).results || [];
  } catch (e) { return { classified: 0, pending: 0, error: `select: ${String(e?.message || e)}` }; }
  if (!pending.length) return { classified: 0, pending: 0 };

  const t = now();
  let wrote = 0; let firstErr = null;
  // Classify in small chunks — one LLM call each — so a long day can't produce a
  // truncated (unparseable) response, and one bad chunk doesn't lose the rest.
  for (let i = 0; i < pending.length; i += 25) {
    const chunk = pending.slice(i, i + 25);
    let verdicts;
    try { verdicts = await classifyBatch(env, chunk); }
    catch (e) { if (!firstErr) firstErr = { error: String(e?.message || e), raw: e?.raw }; continue; }
    for (const it of chunk) {
      const v = verdicts.get(it.id) || { is: 0, reason: 'unclassified' };
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO wa_outreach_class (msg_id, chat_id, is_outreach, reason, classified_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(it.id, it.chat_id, v.is, v.reason, t).run();
        wrote++;
      } catch { /* skip a bad row, keep going */ }
    }
  }
  if (wrote) await logEvent(env, { kind: 'outreach_classified', payload: { n: wrote } });
  return { classified: wrote, pending: pending.length, ...(firstErr || {}) };
}
