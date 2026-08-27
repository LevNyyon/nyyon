// brain.js — the Sunday Brain. A weekly editorial planning interview that
// turns the operator's knowledge, opinions, and live commentary into the
// coming week's article slate.
//
// Flow:
//   1. Sunday (or on demand) → brain_start: reads the knowledge base + recent
//      work, generates ~18 questions across categories, saves a brain_sessions
//      row (status='open'), returns the questions for Nyo to ask.
//   2. Operator answers in chat (free text — all at once or across messages).
//   3. brain_submit_answers: saves the answers, derives 5-8 article ideas
//      spanning the categories, and creates an aeo_questions row for each with
//      interview_status='ready' + the brain answers as expert_context. The AEO
//      writer then writes each WITHOUT a second interview (the brain IS the
//      interview). Marks the session status='derived'.

import { callOpenAIText, callOpenAIJson } from './openai.js';
import { readKnowledge, writeKnowledge, listBlogPosts, writeAeoQuestion, readAeoQuestion, upsertCalendarEvent, logEvent } from './db.js';
import { uid, now } from './util.js';

// ─── week math ────────────────────────────────────────────────────────────
// Returns ms-epoch of the most recent Sunday at 00:00 local time. Workers run
// in UTC; we don't have the operator's tz, so we use UTC Sunday — close enough
// for a weekly cadence, and consistent.
export function weekOfSunday(ts = Date.now()) {
  const d = new Date(ts);
  const day = d.getUTCDay();             // 0 = Sunday
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);    // back up to Sunday
  return d.getTime();
}

export async function getThisWeekSession(env) {
  const week = weekOfSunday();
  return env.DB.prepare(`SELECT * FROM brain_sessions WHERE week_of = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(week).first();
}

export async function getBrainSession(env, id) {
  return env.DB.prepare(`SELECT * FROM brain_sessions WHERE id = ?`).bind(id).first();
}

export async function recentBrainSessions(env, { limit = 8 } = {}) {
  const r = await env.DB.prepare(`SELECT * FROM brain_sessions ORDER BY week_of DESC LIMIT ?`).bind(limit).all();
  return r.results || [];
}

// ─── question generator ─────────────────────────────────────────────────────
const QUESTION_SYSTEM = `You are the editorial brain for Nyyon, a premium AI-native marketing agency. Once a week you interview the founder to mine a full week of original blog content from his head.

Generate EXACTLY 18 interview questions, grouped across these categories. The goal is to surface ORIGINAL material — lived experience, sharp opinions, live reactions — not generic prompts.

Categories (label each question with its category in brackets):
- [BUILT] 3 questions about what he shipped / worked on / solved recently (systems, features, client work). These become "how we did X" / case-style articles.
- [OPINION] 5 questions surfacing contrarian takes, strong beliefs, what's overrated/underrated, mistakes he sees repeatedly. These become opinion/argument pieces.
- [LIVE] 4 questions about what's happening RIGHT NOW in AI / marketing / tech this week — new models, launches, news, a competitor move — and his reaction. These become timely commentary. Ask him to bring the news; you don't know it.
- [CLIENT] 3 questions about a specific client situation, a result/number, or a pattern across clients (anonymised is fine). These become credibility/proof articles.
- [FORWARD] 3 questions about a prediction, a trend he's betting on, or where the industry is heading. These become thought-leadership pieces.

Rules:
- Each question is short, direct, conversational — like a sharp editor mining a writer.
- Do NOT ask generic "what is X" questions. Assume he knows the theory cold.
- Reference Nyyon's actual positioning and topics (from the brand context provided) so questions feel specific to his world.
- Number them 1-18. Prefix each with its [CATEGORY] tag.

Output ONLY the 18 numbered questions, one per line.`;

export async function generateBrainQuestions(env) {
  const { readTasteProfile } = await import('./aeo-taste.js');
  const [brand, voice, recentPosts, taste] = await Promise.all([
    readKnowledge(env, 'brand').catch(() => null),
    readKnowledge(env, 'brand-voice').catch(() => null),
    listBlogPosts(env, { limit: 30, publishedOnly: true }).catch(() => []),
    readTasteProfile(env).catch(() => null),
  ]);

  // Pull the live industry pulse + top signals from the heartbeat so the
  // [LIVE] questions reference REAL current news — the operator no longer has
  // to recall what happened this week; the awareness layer already knows.
  let pulse = null, liveSignals = [];
  try {
    const hb = await import('./heartbeat.js');
    pulse = await hb.readPulse(env);
    liveSignals = await hb.topSignals(env, { days: 7, minContent: 65, limit: 8 });
  } catch { /* heartbeat optional */ }

  const recentTitles = (recentPosts || []).slice(0, 25).map((p) => `- ${p.title}`).join('\n');
  const liveList = liveSignals.map((s) => `- ${s.title}${s.suggested_angle ? ` (angle: ${s.suggested_angle})` : ''}`).join('\n');

  const prompt = [
    '## Nyyon brand + positioning',
    (brand?.body || voice?.body || 'Premium AI-native marketing agency.'),
    '',
    taste ? '## The founder\'s editorial taste (learned from past reactions — lean into this)\n' + taste + '\n' : '',
    pulse ? '## Live industry pulse (from the heartbeat — ground the [LIVE] questions in THIS)\n' + pulse + '\n' : '',
    liveList ? '## This week\'s top signals (real news — turn the sharpest into [LIVE] questions)\n' + liveList + '\n' : '',
    '## Recently published (do NOT regenerate these angles — we want fresh ones)',
    recentTitles || '(none)',
    '',
    'Generate the 18 interview questions now. For [LIVE] questions, reference the actual signals above so you ask the founder for his take on real, current events — not hypotheticals.',
  ].filter(Boolean).join('\n');

  const raw = await callOpenAIText(env, { system: QUESTION_SYSTEM, prompt, model: 'gpt-4o-mini' });
  const questions = raw.split('\n')
    .map((q) => q.trim())
    .filter((q) => q.length > 8 && /\[?(BUILT|OPINION|LIVE|CLIENT|FORWARD)/i.test(q) || /^\d+[\.\)]/.test(q))
    .slice(0, 18);
  return questions.length ? questions : raw.split('\n').map((q) => q.trim()).filter((q) => q.length > 8).slice(0, 18);
}

// Create (or return existing) this week's session, generating questions if new.
export async function startBrainSession(env, { force = false } = {}) {
  const existing = await getThisWeekSession(env);
  if (existing && !force) {
    return { ...existing, questions: safeArr(existing.questions_json), reused: true };
  }
  const questions = await generateBrainQuestions(env);
  const id = uid();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO brain_sessions (id, week_of, status, questions_json, created_at) VALUES (?, ?, 'open', ?, ?)`
  ).bind(id, weekOfSunday(), JSON.stringify(questions), t).run();
  await logEvent(env, { kind: 'brain_session_started', actor: 'operator', payload: { id, week_of: weekOfSunday() } }).catch(() => {});
  return { id, week_of: weekOfSunday(), status: 'open', questions, reused: false };
}

// ─── article derivation ─────────────────────────────────────────────────────
const DERIVE_SYSTEM = `You are Nyyon's editorial strategist. The founder just answered a weekly interview. Turn his answers into the coming week's blog article slate.

Produce 6 article ideas (aim for 5-8) that span the categories he discussed:
- At least one BUILT (how-we-did-it / system case)
- At least two OPINION (contrarian argument pieces)
- At least one LIVE (timely commentary on the news/model he mentioned — only if he gave live material)
- At least one CLIENT (proof / result piece, anonymised)
- At least one FORWARD (prediction / where-it's-heading)

Each idea must be ORIGINAL and grounded in something he actually said. Do NOT invent facts, numbers, or client names he didn't provide. Pull the angle straight from his answers.

For each idea output:
- title: compelling, specific, ≤ 65 chars, close to a real headline
- angle: 1-2 sentences on the core argument, derived from his answer
- category: BUILT | OPINION | LIVE | CLIENT | FORWARD
- target_keyword: the AEO/SEO phrase this should rank for (lowercase)
- source_quote: a short paraphrase of the specific thing he said that seeds this article

Return ONLY a JSON object: { "ideas": [ {title, angle, category, target_keyword, source_quote}, ... ] }`;

export async function deriveArticles(env, sessionId) {
  const session = await getBrainSession(env, sessionId);
  if (!session) throw new Error(`brain session not found: ${sessionId}`);
  if (!session.answers_text) throw new Error('no answers saved for this session yet');

  const { readTasteProfile } = await import('./aeo-taste.js');
  const taste = await readTasteProfile(env).catch(() => null);

  const questions = safeArr(session.questions_json);
  const prompt = [
    '## The interview',
    questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n'),
    '',
    '## His answers (verbatim)',
    session.answers_text,
    '',
    taste ? '## His editorial taste (learned — match it when shaping titles/angles)\n' + taste + '\n' : '',
    'Derive the article slate now. Output ONLY the JSON object.',
  ].filter(Boolean).join('\n');

  const out = await callOpenAIJson(env, { system: DERIVE_SYSTEM, prompt });
  const ideas = Array.isArray(out?.ideas) ? out.ideas : [];
  if (!ideas.length) throw new Error('derivation produced no ideas');

  // Create an aeo_questions row for each idea, pre-loaded with the brain
  // answers as expert_context so the AEO writer skips the per-article
  // interview (the brain WAS the interview).
  // Schedule the slate across the coming week — one post per day, LIVE/timely
  // pieces first. Each gets a scheduled_for (the writer's queue only picks a
  // question once scheduled_for has passed) AND a calendar event, so the
  // operator sees the week's plan. Nyo can still post one early via aeo_write_now.
  const DAY = 86400000;
  const order = { LIVE: 0, OPINION: 1, BUILT: 2, CLIENT: 3, FORWARD: 4 };
  const ordered = [...ideas].sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9));
  // Start Monday of the brain's week; if that day is already past, start tomorrow.
  let base = session.week_of + DAY;
  const todayStart = now() - (now() % DAY);
  if (base <= todayStart) base = todayStart + DAY;

  const created = [];
  for (let i = 0; i < ordered.length; i++) {
    const idea = ordered[i];
    const baseSlug = slugify(idea.title);
    const slug = await ensureUniqueQuestionSlug(env, baseSlug);
    const scheduledFor = base + i * DAY; // one per day across the week
    const expertContext = {
      questions,
      answers: `From the weekly brain — ${idea.category} angle.\n\nThis article's seed: ${idea.source_quote || idea.angle}\n\nFull interview answers for context:\n${session.answers_text}`,
      from_brain: sessionId,
      category: idea.category,
    };
    await writeAeoQuestion(env, {
      slug,
      question: idea.title,
      target_keyword: idea.target_keyword || null,
      priority: idea.category === 'LIVE' ? 2 : 5, // timely commentary jumps the queue
      status: 'pending',
      notes: `${idea.category} · ${idea.angle}`,
    });
    // OPINION + FORWARD pieces are founder POV → write in the operator's personal voice.
    // BUILT / LIVE / CLIENT stay house voice (brand, not person).
    const voice = (idea.category === 'OPINION' || idea.category === 'FORWARD') ? 'personal' : 'house';
    // attach interview context, mark ready (the brain WAS the interview), and
    // set the scheduled publish date.
    await env.DB.prepare(
      `UPDATE aeo_questions SET expert_context_json = ?, interview_status = 'ready', voice = ?, scheduled_for = ?, updated_at = ? WHERE slug = ?`
    ).bind(JSON.stringify(expertContext), voice, scheduledFor, now(), slug).run();
    // Put it on the calendar so the operator sees the week's slate (best-effort).
    try {
      await upsertCalendarEvent(env, {
        kind:       'blog_publish',
        title:      idea.title,
        description: idea.angle || null,
        starts_at:  scheduledFor,
        all_day:    true,
        status:     'confirmed',
        source:     'aeo',
        source_ref: slug,
        link_url:   `/blog/${slug}`,
        created_by: 'nyo',
      });
    } catch { /* calendar event is best-effort — derivation already succeeded */ }
    created.push({ slug, voice, scheduled_for: scheduledFor, ...idea });
  }

  await env.DB.prepare(
    `UPDATE brain_sessions SET status='derived', derived_json=?, completed_at=? WHERE id=?`
  ).bind(JSON.stringify(created), now(), sessionId).run();
  await logEvent(env, { kind: 'brain_derived', actor: 'operator', payload: { session_id: sessionId, articles: created.length } }).catch(() => {});

  // Archive the session's insights into the knowledge base — so the founder's
  // expertise accumulates over time, not just spawns one week of articles.
  // Best-effort: a knowledge write failing must not roll back the derivation.
  let knowledgeSlug = null;
  try {
    knowledgeSlug = await archiveBrainToKnowledge(env, { session, questions, ideas: created });
  } catch (e) {
    // swallow — the articles are already created; the archive is a bonus
  }

  return { session_id: sessionId, count: created.length, ideas: created, knowledge_slug: knowledgeSlug };
}

// ─── knowledge archive ──────────────────────────────────────────────────────
// Distils a completed brain session into a permanent knowledge doc: the
// week's themes, the founder's key positions, and the article slate. Filed
// under a `brain-archive` parent so the whole editorial history is browsable
// and future question/article generation can draw on accumulated POV.
const ARCHIVE_SYSTEM = `You are Nyyon's knowledge librarian. Distil a weekly editorial brain session into a tight knowledge document that captures the founder's THINKING — so it can be reused later.

Write clean markdown (no JSON). Structure:
# Week of <date> — Editorial Brain

## Key positions
(3-6 bullets — the founder's strongest opinions/claims this week, in his voice, specific.)

## What we shipped / worked on
(bullets — concrete things built or done, with any specifics he gave.)

## Live context
(bullets — news/models/events he reacted to this week. Skip if none.)

## Proof & numbers
(bullets — any client results, metrics, anonymised examples he mentioned.)

## Predictions
(bullets — forward-looking bets.)

## Article slate derived
(the list of article titles + their category.)

Rules: only use what he actually said. Do not invent facts or numbers. Keep it dense and reusable — this is institutional memory, not prose.`;

async function archiveBrainToKnowledge(env, { session, questions, ideas }) {
  const weekDate = new Date(session.week_of).toISOString().slice(0, 10);
  const slug = `brain-${weekDate}`;

  const slate = ideas.map((i) => `- [${i.category}] ${i.title}`).join('\n');
  const prompt = [
    `## Week of ${weekDate}`,
    '',
    '## Interview questions',
    questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n'),
    '',
    '## Founder answers (verbatim)',
    session.answers_text || '(none)',
    '',
    '## Article slate already derived',
    slate,
    '',
    'Write the knowledge document now.',
  ].join('\n');

  const md = await callOpenAIText(env, { system: ARCHIVE_SYSTEM, prompt, model: 'gpt-4o-mini' });

  // Ensure the parent archive doc exists (idempotent upsert).
  await writeKnowledge(env, {
    slug: 'brain-archive',
    title: 'Brain Archive — weekly editorial sessions',
    body: 'Permanent record of every Sunday Brain. Each child doc captures one week\'s founder positions, shipped work, live commentary, proof, predictions, and the article slate derived. Builds institutional memory of the founder\'s POV over time.\n\nSee `module-brain` for how it works.',
    scope: 'global',
    parent_slug: 'knowledge-root',
  }).catch(() => {});

  await writeKnowledge(env, {
    slug,
    title: `Brain · Week of ${weekDate}`,
    body: md,
    scope: 'global',
    module: 'brain',
    parent_slug: 'brain-archive',
  });

  return slug;
}

export async function submitBrainAnswers(env, { sessionId, answers }) {
  let session = sessionId ? await getBrainSession(env, sessionId) : await getThisWeekSession(env);
  // ponytail: auto-start a session if none exists — answers must never dead-end
  // on a missing session (the Jun-14 bug: Nyo asked the questions but no session
  // row was ever created, so submit had nothing to attach to).
  if (!session) session = await startBrainSession(env, {});
  await env.DB.prepare(`UPDATE brain_sessions SET answers_text = ? WHERE id = ?`)
    .bind(answers, session.id).run();
  return deriveArticles(env, session.id);
}

// ─── helpers ────────────────────────────────────────────────────────────────
function safeArr(json) { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 70).replace(/^-|-$/g, '');
}
async function ensureUniqueQuestionSlug(env, base) {
  if (!(await readAeoQuestion(env, base))) return base;
  for (let i = 2; i <= 50; i++) {
    const next = `${base}-${i}`;
    if (!(await readAeoQuestion(env, next))) return next;
  }
  return `${base}-${Date.now()}`;
}
