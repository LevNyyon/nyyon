// Editorial plugin — aeo-interview. Ported from workers/api/src/lib/aeo-interview.js.
// Nyo-driven expert interview before article writing:
//   1. aeo_start_interview(slug) → generates 4 targeted questions, saves them.
//   2. Operator answers in chat.
//   3. aeo_write_with_answers(slug, answers) → saves answers, fires the writer
//      with the expert context baked in (runAeoCronForSlug in aeo-writer.mjs).
// This file imports NOTHING; every exported fn takes `api` first.
//
// Tables: plugin_editorial_aeo_questions (read + write)
// Knowledge: plugin-editorial-editorial-taste (own, read)
// Gateways: llm(text)

const now = () => Date.now();

// ─── question generator ───────────────────────────────────────────────────
const QUESTION_SYSTEM = `You help a marketing agency operator produce high-quality expert blog articles.

Given an AEO question / topic, generate EXACTLY 4 interview questions to ask the operator before writing.

The questions should extract:
1. The most common mistake they see companies make (gives the article a strong critique angle)
2. The mechanism / framework that actually works, from their experience (gives the article a concrete solution)
3. A specific client example, metric, or data point they can share — even anonymised (gives the article credibility)
4. The counterintuitive or non-obvious thing most people get wrong (gives the article a distinctive edge)

Rules:
- Each question is short, direct, conversational — like a smart editor asking a writer.
- Do NOT ask generic "what is X" questions. Assume the operator already knows the theory.
- The goal is to surface their LIVED EXPERIENCE and OPINION.
- No numbering, no preamble. Output only the 4 questions, one per line.

Example output for "How do AI-native marketing teams make faster decisions?":
What's the single biggest bottleneck you see when teams try to move faster with AI — and why does it persist?
Walk me through the decision-making system you'd build if starting from scratch today.
Is there a client situation where you saw this play out — either working or failing — that you could describe without naming them?
What do most frameworks for "decision velocity" get wrong that nobody is talking about?`;

// Duplicated taste read (lib files import nothing — contract).
async function readTasteProfile(api) {
  const doc = await api.knowledge('plugin-editorial-editorial-taste').catch(() => null);
  return doc?.body || null;
}

export async function generateInterviewQuestions(api, { slug, question, target_keyword, notes }) {
  const taste = await readTasteProfile(api).catch(() => null);
  const prompt = [
    `AEO question to rank for: "${question}"`,
    target_keyword ? `Primary keyword: ${target_keyword}` : null,
    notes ? `Notes: ${notes}` : null,
    taste ? `\nThe founder's editorial taste (learned — angle the questions to surface what he cares about):\n${taste}` : null,
    '',
    'Generate the 4 interview questions now.',
  ].filter(Boolean).join('\n');

  const raw = await api.gateway('llm', 'text', { system: QUESTION_SYSTEM, prompt, model: 'gpt-4o-mini' });
  // Split on newlines, filter blanks
  const questions = String(raw).split('\n').map((q) => q.trim()).filter((q) => q.length > 10).slice(0, 4);
  return questions;
}

// ─── save questions (marks interview as pending) ──────────────────────────
export async function saveInterviewQuestions(api, slug, questions) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET interview_status = 'pending', expert_context_json = ?, updated_at = ? WHERE slug = ?`,
  ).bind(JSON.stringify({ questions, answers: null, started_at: t }), t, slug).run();
  try { await api.log('aeo_interview_started', { slug, questions: questions?.length ?? null }); } catch { /* never fatal */ }
}

// ─── save answers + mark ready to write ──────────────────────────────────
export async function saveInterviewAnswers(api, slug, answersText) {
  const row = await api.db.prepare('SELECT * FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).first();
  if (!row) throw new Error(`AEO question not found: ${slug}`);

  let ctx = {};
  try { ctx = JSON.parse(row.expert_context_json || '{}'); } catch { /* treat as empty */ }

  ctx.answers = answersText;
  ctx.answered_at = now();

  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET interview_status = 'ready', expert_context_json = ?, updated_at = ? WHERE slug = ?`,
  ).bind(JSON.stringify(ctx), t, slug).run();
  try { await api.log('aeo_interview_answered', { slug }); } catch { /* never fatal */ }
}

// ─── format context for the article writer ───────────────────────────────
// Returns a markdown block injected into the LLM prompt so the writer treats
// the operator's answers as ground truth. Pure function — no api needed.
export function formatExpertContext(expertContextJson) {
  if (!expertContextJson) return null;
  let ctx;
  try { ctx = JSON.parse(expertContextJson); } catch { return null; }
  if (!ctx.questions || !ctx.answers) return null;

  const lines = ['## Expert interview — operator answers (treat as authoritative source material)', ''];
  ctx.questions.forEach((q, i) => {
    lines.push(`**Q${i + 1}: ${q}**`);
  });
  lines.push('');
  lines.push('**Operator answers:**');
  lines.push(ctx.answers);
  lines.push('');
  lines.push('Use the operator\'s exact perspective, frameworks, examples, and opinions. This is first-hand expertise — build the article around it, do not dilute or genericise it.');
  return lines.join('\n');
}
