// AEO suggestions — OSINT signals developed into article angles, held for
// operator approval BEFORE they become a real aeo_questions row.
//
// Pipeline: osint_signals (scored by heartbeat) --generate--> aeo_suggestions
// (pending, Nyyon's angle attached) --approve--> aeo_questions (pre-filled
// "interview" via the EXISTING saveInterviewQuestions/saveInterviewAnswers)
// --runAeoCronForSlug (existing, unchanged)--> full write + figures + a DRAFT
// in blog_posts, which lands in the Blog module's "Needs review" — the
// existing publish-approval gate. This file adds ONLY the intake + approval
// stage; the writer, visuals, and publish gate are all reused as-is.

import { readKnowledge, writeKnowledge, logEvent, readAeoQuestion, writeAeoQuestion } from './db.js';
import { saveInterviewQuestions, saveInterviewAnswers } from './aeo-interview.js';
import { runAeoCronForSlug } from './aeo-writer.js';
import { callOpenAIJson } from './openai.js';
import { uid, now } from './util.js';

const POLICY_SLUG = 'aeo-suggestion-policy';
const POLICY_DEFAULTS = Object.freeze({
  daily_limit: 2,       // new suggestions the daily cron creates per tick
  max_pending: 5,       // never let the unreviewed pile grow past this
  min_content_score: 65, // signal eligibility floor (heartbeat-priorities governs the score itself)
});

export async function loadSuggestionPolicy(env) {
  try {
    const doc = await readKnowledge(env, POLICY_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: POLICY_SLUG,
        title: 'AEO suggestion policy — daily cap + eligibility',
        body: `How many OSINT-sourced article suggestions land in the AEO queue per day, and the minimum signal quality to be eligible. The code (\`loadSuggestionPolicy\` in lib/aeo-suggestions.js) reads the JSON block below at run time — edit here or in Settings, no deploy.\n\n- \`daily_limit\` — new suggestions generated per daily cron tick\n- \`max_pending\` — hard cap on the unreviewed pile; generation skips once this many are already awaiting your decision\n- \`min_content_score\` — signal eligibility floor (content_score from the heartbeat scorer)\n\n\`\`\`json\n${JSON.stringify(POLICY_DEFAULTS, null, 2)}\n\`\`\``,
        parent_slug: 'module-aeo',
      }).catch(() => {});
      return { ...POLICY_DEFAULTS };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(POLICY_DEFAULTS)) {
      const n = Number(src[k]);
      out[k] = Number.isFinite(n) && n >= 0 ? n : dflt;
    }
    return out;
  } catch {
    return { ...POLICY_DEFAULTS };
  }
}

function slugify(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 70).replace(/^-|-$/g, '');
}
async function ensureUniqueQuestionSlug(env, candidate) {
  let slug = candidate;
  for (let i = 2; await readAeoQuestion(env, slug); i++) slug = `${candidate}-${i}`;
  return slug;
}

const ANGLE_SYSTEM = `You are Nyyon's editorial strategist. Nyyon is a white-glove, AI-native marketing agency: senior judgment plus the ability to personally ship AI-native systems for clients.

You are given a shortlist of industry signals (news, launches, debates) already scored as relevant + write-about-able. For each one worth turning into an article, develop a SPECIFIC angle — Nyyon's actual take, not a summary of the source.

For EACH signal you select, return:
  signal_id:      the id you were given
  title:          the article's working title (a question or a sharp claim, <=70 chars)
  target_keyword: the primary phrase this should rank for (2-5 words)
  angle:          2-4 sentences: Nyyon's specific thesis/take on this, in Nyyon's voice, with a concrete mechanism or consequence. This becomes the article's guiding "expert answer" — be opinionated and specific, not generic.
  rationale:      one sentence: why this is worth writing about now

Rules:
- Select AT MOST the requested number. Skip any signal that only supports a generic "AI is changing X" take — better to return fewer than to pad.
- Never propose a title/angle that duplicates an existing Nyyon post or already-queued topic (both listed below).
- No em-dashes or en-dashes. No banned phrases: revolutionary, game-changing, disruptive, next-gen, cutting-edge, world-class, leverage (as a verb), synergy, unlock, in today's world.

Return ONLY a JSON object: { "suggestions": [ { signal_id, title, target_keyword, angle, rationale }, ... ] }`;

function buildAnglePrompt({ signals, existingTitles, brandVoice, playbook }) {
  const signalList = signals.map((s, i) =>
    `[${i}] id=${s.id} score=${s.content_score} source=${s.source_name}\ntitle: ${s.title}\n${s.full_text ? 'excerpt: ' + s.full_text.slice(0, 1200) : 'summary: ' + (s.summary || '')}\nheartbeat angle: ${s.suggested_angle || '(none)'}\nwhy relevant: ${s.why || '(none)'}`
  ).join('\n\n');
  return [
    `## Candidate signals`, signalList, '',
    `## Already published / queued (do NOT duplicate)`,
    existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none)', '',
    `## Nyyon brand voice`, brandVoice, '',
    `## Nyyon AEO playbook (structure every article follows)`, playbook, '',
    `Develop up to the requested number of suggestions now. Output ONLY the JSON object.`,
  ].join('\n');
}

// ─── granular steps (v2) ─────────────────────────────────────────────────────
// generateAeoSuggestions below is policy + candidate pick + LLM + write in one
// call. These are the same stages as separate steps, sharing the prompt above.

// Step 1 — the policy and how much room is left in the unreviewed pile. The
// caps live in the aeo-suggestion-policy knowledge doc, never in code.
export async function readSuggestionPolicy(env, { limit = null } = {}) {
  const policy = await loadSuggestionPolicy(env);
  const pending_count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM aeo_suggestions WHERE status='pending'`).first())?.n || 0;
  const room = Math.max(0, policy.max_pending - pending_count);
  const wanted = Number.isFinite(limit) && limit > 0 ? limit : policy.daily_limit;
  return {
    policy,
    pending_count,
    room,
    min_score: policy.min_content_score,
    limit: Math.min(wanted, room),
  };
}

// Step 2 — one LLM step over the shortlisted signals. No writes: the operator
// still approves each suggestion before it becomes an article.
export async function draftSuggestionAngles(env, { signals = null, limit = null } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const cap = Number.isFinite(limit) && limit > 0 ? limit : list.length;
  if (!list.length || cap <= 0) return { suggestions: [], reason: !list.length ? 'no eligible signals' : 'no room in the pending pile' };

  const [brandVoiceDoc, playbookDoc, existingQuestions, existingSuggestions] = await Promise.all([
    readKnowledge(env, 'brand-voice'),
    readKnowledge(env, 'article-playbook'),
    env.DB.prepare(`SELECT question FROM aeo_questions LIMIT 300`).all(),
    env.DB.prepare(`SELECT title FROM aeo_suggestions WHERE status != 'rejected' LIMIT 100`).all(),
  ]);
  const existingTitles = [
    ...(existingQuestions.results || []).map((r) => r.question),
    ...(existingSuggestions.results || []).map((r) => r.title),
  ];

  const prompt = buildAnglePrompt({
    signals: list,
    existingTitles,
    brandVoice: brandVoiceDoc?.body || '',
    playbook: playbookDoc?.body || '',
  }) + `\n\nSelect at most ${cap} signal(s).`;

  const out = await callOpenAIJson(env, { system: ANGLE_SYSTEM, prompt, heavy: true });
  const suggestions = (Array.isArray(out?.suggestions) ? out.suggestions : [])
    .filter((s) => s?.title && s?.angle)
    .slice(0, cap);
  return { suggestions };
}

// Step 3 — persist the developed angles and mark their source signals actioned
// so the same news can never be suggested twice.
export async function saveAeoSuggestions(env, { suggestions = null, signals = null, limit = null } = {}) {
  const picks = (Array.isArray(suggestions) ? suggestions : []).filter((s) => s?.title && s?.angle);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : picks.length;
  if (!picks.length || cap <= 0) return { ok: true, created: 0, ids: [] };

  const byId = new Map((Array.isArray(signals) ? signals : []).map((s) => [s.id, s]));
  const ids = [];
  for (const pick of picks.slice(0, cap)) {
    let sig = pick.signal_id ? byId.get(pick.signal_id) : null;
    if (!sig && pick.signal_id) {
      sig = await env.DB.prepare(`SELECT * FROM osint_signals WHERE id = ?`).bind(pick.signal_id).first();
    }
    // Never re-suggest a signal that already produced one.
    if (sig) {
      const dup = await env.DB.prepare(`SELECT id FROM aeo_suggestions WHERE signal_id = ? LIMIT 1`).bind(sig.id).first();
      if (dup) continue;
    }
    const id = 'aeos_' + uid().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO aeo_suggestions (id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, sig?.id || null, String(pick.title).slice(0, 200), String(pick.angle), pick.rationale || null,
      pick.target_keyword || null, sig?.source_name || null, sig?.url || null, now()).run();
    if (sig) await env.DB.prepare(`UPDATE osint_signals SET status='actioned' WHERE id=?`).bind(sig.id).run();
    await logEvent(env, { kind: 'aeo_suggestion_created', actor: 'system', payload: { id, title: pick.title, signal_id: sig?.id || null } });
    ids.push(id);
  }
  return { ok: true, created: ids.length, ids };
}

// Pull top eligible signals, ask the LLM to develop angles for up to `limit`
// of them, write aeo_suggestions rows, and mark the source signals 'actioned'
// so they're never re-suggested. Never throws — errors return {ok:false}.
export async function generateAeoSuggestions(env, { limit = null } = {}) {
  const policy = await loadSuggestionPolicy(env);
  const wantLimit = Number.isFinite(limit) ? limit : policy.daily_limit;

  const pendingCount = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM aeo_suggestions WHERE status='pending'`).first())?.n || 0;
  const room = Math.max(0, policy.max_pending - pendingCount);
  const effectiveLimit = Math.min(wantLimit, room);
  if (effectiveLimit <= 0) {
    return { ok: true, created: 0, reason: pendingCount >= policy.max_pending ? 'pending pile at cap' : 'nothing requested' };
  }

  // Candidate pool: unconverted, well-scored signals — widest first, LLM narrows.
  const candidates = (await env.DB.prepare(
    `SELECT * FROM osint_signals
      WHERE status IN ('scored','surfaced') AND content_score >= ?
        AND id NOT IN (SELECT signal_id FROM aeo_suggestions WHERE signal_id IS NOT NULL)
      ORDER BY content_score DESC, created_at DESC LIMIT ?`,
  ).bind(policy.min_content_score, Math.max(effectiveLimit * 3, 9)).all()).results || [];
  if (!candidates.length) return { ok: true, created: 0, reason: 'no eligible signals' };

  // Full text for the top few — sharper angles, bounded cost.
  const { readSignalContent } = await import('./heartbeat.js');
  for (const s of candidates.slice(0, Math.min(6, candidates.length))) {
    if (!s.full_text) {
      const full = await readSignalContent(env, s.id).catch(() => null);
      if (full?.full_text) s.full_text = full.full_text;
    }
  }

  const [brandVoiceDoc, playbookDoc, existingQuestions, existingSuggestions] = await Promise.all([
    readKnowledge(env, 'brand-voice'),
    readKnowledge(env, 'article-playbook'),
    env.DB.prepare(`SELECT question FROM aeo_questions LIMIT 300`).all(),
    env.DB.prepare(`SELECT title FROM aeo_suggestions WHERE status != 'rejected' LIMIT 100`).all(),
  ]);
  const existingTitles = [
    ...(existingQuestions.results || []).map((r) => r.question),
    ...(existingSuggestions.results || []).map((r) => r.title),
  ];

  const prompt = buildAnglePrompt({
    signals: candidates,
    existingTitles,
    brandVoice: brandVoiceDoc?.body || '',
    playbook: playbookDoc?.body || '',
  }) + `\n\nSelect at most ${effectiveLimit} signal(s).`;

  let out;
  try {
    out = await callOpenAIJson(env, { system: ANGLE_SYSTEM, prompt, heavy: true });
  } catch (e) {
    if (e?.llmDown) return { ok: false, paused: true, reason: 'llm_out_of_credit' };
    return { ok: false, error: String(e?.message || e) };
  }
  const picks = Array.isArray(out?.suggestions) ? out.suggestions.slice(0, effectiveLimit) : [];
  const byId = new Map(candidates.map((s) => [s.id, s]));

  const created = [];
  for (const pick of picks) {
    const sig = byId.get(pick.signal_id);
    if (!sig || !pick.title || !pick.angle) continue;
    const id = 'aeos_' + uid().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO aeo_suggestions (id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, sig.id, String(pick.title).slice(0, 200), String(pick.angle), pick.rationale || null, pick.target_keyword || null, sig.source_name || null, sig.url, now()).run();
    await env.DB.prepare(`UPDATE osint_signals SET status='actioned' WHERE id=?`).bind(sig.id).run();
    await logEvent(env, { kind: 'aeo_suggestion_created', actor: 'heartbeat', payload: { id, title: pick.title, signal_id: sig.id } });
    created.push(id);
  }
  return { ok: true, created: created.length, ids: created, considered: candidates.length };
}

export async function listAeoSuggestions(env, { status = null, limit = 100 } = {}) {
  const sql = status
    ? `SELECT * FROM aeo_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM aeo_suggestions ORDER BY created_at DESC LIMIT ?`;
  const r = status ? await env.DB.prepare(sql).bind(status, limit).all() : await env.DB.prepare(sql).bind(limit).all();
  return r.results || [];
}

// Mirror the linked aeo_questions row's true state onto the suggestion once
// the (existing, unchanged) writer has had a chance to run.
async function syncSuggestionFromQuestion(env, suggestionId, slug) {
  const q = await readAeoQuestion(env, slug);
  if (!q) return;
  if (q.status === 'drafted' || q.status === 'published') {
    await env.DB.prepare(`UPDATE aeo_suggestions SET status='drafted', last_error=NULL WHERE id=?`).bind(suggestionId).run();
  } else if (q.status === 'failed') {
    await env.DB.prepare(`UPDATE aeo_suggestions SET status='failed', last_error=? WHERE id=?`).bind(q.last_error || 'writer failed', suggestionId).run();
  }
  // status still 'pending' on the question = paused (llm down) or claimed —
  // leave the suggestion 'approved' so it's visibly in-flight / retryable.
}

// Approve: seed aeo_questions with a pre-filled "interview" (the developed
// angle stands in for the operator's answers — same shape the real interview
// flow produces, via the SAME two functions it uses) then fire the EXISTING
// write pipeline for that slug. `ctx` (Hono's executionCtx) is optional: pass
// it from an HTTP route to return immediately while writing continues in the
// background; omit it (as Nyo tool calls do) to await the full write inline,
// matching how aeo_write_with_answers already behaves.
export async function approveAeoSuggestion(env, id, { actor = 'operator', ctx = null } = {}) {
  const sug = await env.DB.prepare(`SELECT * FROM aeo_suggestions WHERE id = ?`).bind(id).first();
  if (!sug) throw new Error(`suggestion ${id} not found`);
  if (sug.status !== 'pending') throw new Error(`suggestion ${id} is already ${sug.status}`);

  const baseSlug = slugify(sug.title) || 'aeo-suggestion';
  const slug = await ensureUniqueQuestionSlug(env, baseSlug);

  await writeAeoQuestion(env, {
    slug, question: sug.title, target_keyword: sug.target_keyword, priority: 2, status: 'pending',
    notes: `From an OSINT-sourced AEO suggestion (${sug.id}). Source: ${sug.source_name || 'unknown'} — ${sug.source_url || ''}`.trim(),
  });
  // Pre-fill the interview with the developed angle, using the SAME functions
  // the real Nyo-driven interview uses — guarantees the writer's mandatory
  // interview gate sees a well-formed { questions, answers } context.
  await saveInterviewQuestions(env, slug, [`What's Nyyon's angle on: ${sug.title}?`]);
  const answerText = sug.rationale ? `${sug.angle}\n\nWhy now: ${sug.rationale}` : sug.angle;
  await saveInterviewAnswers(env, slug, answerText);

  await env.DB.prepare(
    `UPDATE aeo_suggestions SET status='approved', question_slug=?, decided_at=?, decided_by=? WHERE id=?`,
  ).bind(slug, now(), actor, id).run();
  await logEvent(env, { kind: 'aeo_suggestion_approved', actor, payload: { id, slug } });

  const write = runAeoCronForSlug(env, { slug, actor: 'aeo-suggestion' })
    .then(() => syncSuggestionFromQuestion(env, id, slug))
    .catch(async (e) => {
      await env.DB.prepare(`UPDATE aeo_suggestions SET status='failed', last_error=? WHERE id=?`).bind(String(e?.message || e).slice(0, 500), id).run().catch(() => {});
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(write);
    return { ok: true, status: 'approved', slug, writing: true };
  }
  await write;
  const final = await env.DB.prepare(`SELECT status, last_error FROM aeo_suggestions WHERE id=?`).bind(id).first();
  return { ok: true, status: final?.status || 'approved', slug, last_error: final?.last_error || null };
}

export async function rejectAeoSuggestion(env, id, { actor = 'operator' } = {}) {
  const sug = await env.DB.prepare(`SELECT * FROM aeo_suggestions WHERE id = ?`).bind(id).first();
  if (!sug) throw new Error(`suggestion ${id} not found`);
  if (sug.status !== 'pending') throw new Error(`suggestion ${id} is already ${sug.status}`);
  await env.DB.prepare(`UPDATE aeo_suggestions SET status='rejected', decided_at=?, decided_by=? WHERE id=?`).bind(now(), actor, id).run();
  if (sug.signal_id) {
    await env.DB.prepare(`UPDATE osint_signals SET status='dismissed' WHERE id=?`).bind(sug.signal_id).run().catch(() => {});
  }
  await logEvent(env, { kind: 'aeo_suggestion_rejected', actor, payload: { id } });
  return { ok: true };
}
