// Editorial plugin — aeo-suggestions. Ported from workers/api/src/lib/aeo-suggestions.js.
// OSINT signals developed into article angles, held for operator approval
// BEFORE they become a real aeo_questions row.
//
// Pipeline: plugin_editorial_osint_signals (scored by heartbeat)
//   --generate--> plugin_editorial_aeo_suggestions (pending, angle attached)
//   --approve--> plugin_editorial_aeo_questions (pre-filled "interview")
//   --the writer (aeo-writer.mjs runAeoCronForSlug)--> a DRAFT blog post.
//
// Plugin capability contract: this file imports NOTHING; every exported fn
// takes `api` first. Interview helpers are duplicated inline (lib files cannot
// import each other). The one cross-lib call the host had — approve firing
// runAeoCronForSlug from aeo-writer.js — is INJECTED: the approving tool
// imports runAeoCronForSlug from './aeo-writer.mjs' and passes it as
// `run_writer`; without it, approve stops at 'approved' + needs_write:true.
//
// Tables:    plugin_editorial_aeo_suggestions, plugin_editorial_aeo_questions,
//            plugin_editorial_osint_signals (all own, r/w)
// Knowledge: reads host brand-voice, article-playbook;
//            owns plugin-editorial-aeo-suggestion-policy (read + write).
// Gateways:  llm(json), web(text).

const now = () => Date.now();
const uid = () => crypto.randomUUID();

const POLICY_SLUG = 'plugin-editorial-aeo-suggestion-policy';
const POLICY_DEFAULTS = Object.freeze({
  daily_limit: 2,        // new suggestions the daily cron creates per tick
  max_pending: 5,        // never let the unreviewed pile grow past this
  min_content_score: 65, // signal eligibility floor (heartbeat-priorities governs the score itself)
});

export async function loadSuggestionPolicy(api) {
  try {
    const doc = await api.knowledge(POLICY_SLUG).catch(() => null);
    if (!doc) {
      await api.saveKnowledge(POLICY_SLUG, {
        title: 'AEO suggestion policy — daily cap + eligibility',
        body: `How many OSINT-sourced article suggestions land in the AEO queue per day, and the minimum signal quality to be eligible. The code (\`loadSuggestionPolicy\` in the editorial plugin's aeo-suggestions lib) reads the JSON block below at run time — edit here or in Settings, no deploy.\n\n- \`daily_limit\` — new suggestions generated per daily cron tick\n- \`max_pending\` — hard cap on the unreviewed pile; generation skips once this many are already awaiting your decision\n- \`min_content_score\` — signal eligibility floor (content_score from the heartbeat scorer)\n\n\`\`\`json\n${JSON.stringify(POLICY_DEFAULTS, null, 2)}\n\`\`\``,
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

// ─── inline duplicates: aeo_questions store (see blog-db.mjs) ───────────────
async function readAeoQuestionRow(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).first();
}

async function writeAeoQuestionRow(api, { slug, question, target_keyword = null, priority = 5, status = 'pending', scheduled_for = null, notes = null }) {
  if (!slug || !question) throw new Error('slug + question required');
  const t = now();
  const existing = await readAeoQuestionRow(api, slug);
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_aeo_questions SET question=?, target_keyword=?, priority=?, status=?, scheduled_for=?, notes=?, updated_at=? WHERE slug=?`,
    ).bind(question, target_keyword, priority, status, scheduled_for, notes, t, slug).run();
  } else {
    await api.db.prepare(
      `INSERT INTO plugin_editorial_aeo_questions (slug, question, target_keyword, priority, status, scheduled_for, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, question, target_keyword, priority, status, scheduled_for, notes, t, t).run();
  }
  await api.log('aeo_question_upserted', { slug, status });
  return readAeoQuestionRow(api, slug);
}

async function ensureUniqueQuestionSlug(api, candidate) {
  let slug = candidate;
  for (let i = 2; await readAeoQuestionRow(api, slug); i++) slug = `${candidate}-${i}`;
  return slug;
}

// ─── inline duplicates: interview seeding (see aeo-interview.mjs) ───────────
async function saveInterviewQuestionsInline(api, slug, questions) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET interview_status = 'pending', expert_context_json = ?, updated_at = ? WHERE slug = ?`,
  ).bind(JSON.stringify({ questions, answers: null, started_at: t }), t, slug).run();
  try { await api.log('aeo_interview_started', { slug, questions: questions?.length ?? null }); } catch { /* never fatal */ }
}

async function saveInterviewAnswersInline(api, slug, answersText) {
  const row = await readAeoQuestionRow(api, slug);
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

// ─── inline duplicate: read one signal's full article on demand ─────────────
// (heartbeat.js readSignalContent, compacted: same fetch-strip-cache behavior
// through the web gateway; returns the signal row, '' extraction = no cache.)
async function readSignalContentInline(api, signalId) {
  const sig = await api.db.prepare('SELECT * FROM plugin_editorial_osint_signals WHERE id=?').bind(signalId).first();
  if (!sig) return null;
  if (sig.full_text) return sig;
  let text = '';
  try {
    const r = await api.gateway('web', 'text', {
      url: sig.url, timeout_ms: 12000, max_bytes: 400000,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; heartbeat-rss/1.0)' },
    });
    if (r?.ok && /html|text/.test(r.content_type || '')) {
      let html = String(r.text || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
      const main = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
      const scope = main ? main[0] : html;
      const plain = scope.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ').trim();
      text = plain.length > 200 ? plain.slice(0, 8000) : '';
    }
  } catch { /* extraction is best-effort — caller falls back to summary */ }
  if (text) {
    await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET full_text=?, content_fetched_at=? WHERE id=?`)
      .bind(text, now(), signalId).run();
    sig.full_text = text;
  }
  return sig;
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

// ─── granular steps (v2) ────────────────────────────────────────────────────

// Step 1 — the policy and how much room is left in the unreviewed pile.
export async function readSuggestionPolicy(api, { limit = null } = {}) {
  const policy = await loadSuggestionPolicy(api);
  const pending_count = (await api.db.prepare(`SELECT COUNT(*) AS n FROM plugin_editorial_aeo_suggestions WHERE status='pending'`).first())?.n || 0;
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
export async function draftSuggestionAngles(api, { signals = null, limit = null } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const cap = Number.isFinite(limit) && limit > 0 ? limit : list.length;
  if (!list.length || cap <= 0) return { suggestions: [], reason: !list.length ? 'no eligible signals' : 'no room in the pending pile' };

  const [brandVoiceDoc, playbookDoc, existingQuestions, existingSuggestions] = await Promise.all([
    api.knowledge('brand-voice'),
    api.knowledge('article-playbook'),
    api.db.prepare(`SELECT question FROM plugin_editorial_aeo_questions LIMIT 300`).all(),
    api.db.prepare(`SELECT title FROM plugin_editorial_aeo_suggestions WHERE status != 'rejected' LIMIT 100`).all(),
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

  const out = await api.gateway('llm', 'json', { system: ANGLE_SYSTEM, prompt, heavy: true });
  const suggestions = (Array.isArray(out?.suggestions) ? out.suggestions : [])
    .filter((s) => s?.title && s?.angle)
    .slice(0, cap);
  return { suggestions };
}

// Step 3 — persist the developed angles and mark their source signals actioned
// so the same news can never be suggested twice.
export async function saveAeoSuggestions(api, { suggestions = null, signals = null, limit = null } = {}) {
  const picks = (Array.isArray(suggestions) ? suggestions : []).filter((s) => s?.title && s?.angle);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : picks.length;
  if (!picks.length || cap <= 0) return { ok: true, created: 0, ids: [] };

  const byId = new Map((Array.isArray(signals) ? signals : []).map((s) => [s.id, s]));
  const ids = [];
  for (const pick of picks.slice(0, cap)) {
    let sig = pick.signal_id ? byId.get(pick.signal_id) : null;
    if (!sig && pick.signal_id) {
      sig = await api.db.prepare(`SELECT * FROM plugin_editorial_osint_signals WHERE id = ?`).bind(pick.signal_id).first();
    }
    // Never re-suggest a signal that already produced one.
    if (sig) {
      const dup = await api.db.prepare(`SELECT id FROM plugin_editorial_aeo_suggestions WHERE signal_id = ? LIMIT 1`).bind(sig.id).first();
      if (dup) continue;
    }
    const id = 'aeos_' + uid().replace(/-/g, '').slice(0, 10);
    await api.db.prepare(
      `INSERT INTO plugin_editorial_aeo_suggestions (id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, sig?.id || null, String(pick.title).slice(0, 200), String(pick.angle), pick.rationale || null,
      pick.target_keyword || null, sig?.source_name || null, sig?.url || null, now()).run();
    if (sig) await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET status='actioned' WHERE id=?`).bind(sig.id).run();
    await api.log('aeo_suggestion_created', { id, title: pick.title, signal_id: sig?.id || null });
    ids.push(id);
  }
  return { ok: true, created: ids.length, ids };
}

// Pull top eligible signals, ask the LLM to develop angles for up to `limit`
// of them, write suggestion rows, and mark the source signals 'actioned'.
// Never throws — errors return {ok:false}.
export async function generateAeoSuggestions(api, { limit = null } = {}) {
  const policy = await loadSuggestionPolicy(api);
  const wantLimit = Number.isFinite(limit) ? limit : policy.daily_limit;

  const pendingCount = (await api.db.prepare(`SELECT COUNT(*) AS n FROM plugin_editorial_aeo_suggestions WHERE status='pending'`).first())?.n || 0;
  const room = Math.max(0, policy.max_pending - pendingCount);
  const effectiveLimit = Math.min(wantLimit, room);
  if (effectiveLimit <= 0) {
    return { ok: true, created: 0, reason: pendingCount >= policy.max_pending ? 'pending pile at cap' : 'nothing requested' };
  }

  // Candidate pool: unconverted, well-scored signals — widest first, LLM narrows.
  const candidates = (await api.db.prepare(
    `SELECT * FROM plugin_editorial_osint_signals
      WHERE status IN ('scored','surfaced') AND content_score >= ?
        AND id NOT IN (SELECT signal_id FROM plugin_editorial_aeo_suggestions WHERE signal_id IS NOT NULL)
      ORDER BY content_score DESC, created_at DESC LIMIT ?`,
  ).bind(policy.min_content_score, Math.max(effectiveLimit * 3, 9)).all()).results || [];
  if (!candidates.length) return { ok: true, created: 0, reason: 'no eligible signals' };

  // Full text for the top few — sharper angles, bounded cost.
  for (const s of candidates.slice(0, Math.min(6, candidates.length))) {
    if (!s.full_text) {
      const full = await readSignalContentInline(api, s.id).catch(() => null);
      if (full?.full_text) s.full_text = full.full_text;
    }
  }

  const [brandVoiceDoc, playbookDoc, existingQuestions, existingSuggestions] = await Promise.all([
    api.knowledge('brand-voice'),
    api.knowledge('article-playbook'),
    api.db.prepare(`SELECT question FROM plugin_editorial_aeo_questions LIMIT 300`).all(),
    api.db.prepare(`SELECT title FROM plugin_editorial_aeo_suggestions WHERE status != 'rejected' LIMIT 100`).all(),
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
    out = await api.gateway('llm', 'json', { system: ANGLE_SYSTEM, prompt, heavy: true });
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
    const id = 'aeos_' + uid().replace(/-/g, '').slice(0, 10);
    await api.db.prepare(
      `INSERT INTO plugin_editorial_aeo_suggestions (id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, sig.id, String(pick.title).slice(0, 200), String(pick.angle), pick.rationale || null, pick.target_keyword || null, sig.source_name || null, sig.url, now()).run();
    await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET status='actioned' WHERE id=?`).bind(sig.id).run();
    await api.log('aeo_suggestion_created', { id, title: pick.title, signal_id: sig.id });
    created.push(id);
  }
  return { ok: true, created: created.length, ids: created, considered: candidates.length };
}

export async function listAeoSuggestions(api, { status = null, limit = 100 } = {}) {
  const sql = status
    ? `SELECT * FROM plugin_editorial_aeo_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM plugin_editorial_aeo_suggestions ORDER BY created_at DESC LIMIT ?`;
  const r = status ? await api.db.prepare(sql).bind(status, limit).all() : await api.db.prepare(sql).bind(limit).all();
  return r.results || [];
}

// Mirror the linked question row's true state onto the suggestion once the
// writer has had a chance to run. Exported (the host original kept it private)
// so the approving tool can compose approve → write → sync.
export async function syncSuggestionFromQuestion(api, suggestionId, slug) {
  const q = await readAeoQuestionRow(api, slug);
  if (!q) return;
  if (q.status === 'drafted' || q.status === 'published') {
    await api.db.prepare(`UPDATE plugin_editorial_aeo_suggestions SET status='drafted', last_error=NULL WHERE id=?`).bind(suggestionId).run();
  } else if (q.status === 'failed') {
    await api.db.prepare(`UPDATE plugin_editorial_aeo_suggestions SET status='failed', last_error=? WHERE id=?`).bind(q.last_error || 'writer failed', suggestionId).run();
  }
  // status still 'pending' on the question = paused (llm down) or claimed —
  // leave the suggestion 'approved' so it's visibly in-flight / retryable.
}

// Approve: seed the question with a pre-filled "interview" (the developed
// angle stands in for the operator's answers — same shape the real interview
// flow produces) then fire the writer for that slug.
//
// `run_writer` is the injected writer entry point — the calling tool passes
// runAeoCronForSlug imported from './aeo-writer.mjs' (lib files cannot import
// each other, so the cross-lib call the host had moves to the tool layer).
// Without it, the approve stops after seeding and returns needs_write:true.
export async function approveAeoSuggestion(api, id, { actor = 'operator', run_writer = null } = {}) {
  const sug = await api.db.prepare(`SELECT * FROM plugin_editorial_aeo_suggestions WHERE id = ?`).bind(id).first();
  if (!sug) throw new Error(`suggestion ${id} not found`);
  if (sug.status !== 'pending') throw new Error(`suggestion ${id} is already ${sug.status}`);

  const baseSlug = slugify(sug.title) || 'aeo-suggestion';
  const slug = await ensureUniqueQuestionSlug(api, baseSlug);

  await writeAeoQuestionRow(api, {
    slug, question: sug.title, target_keyword: sug.target_keyword, priority: 2, status: 'pending',
    notes: `From an OSINT-sourced AEO suggestion (${sug.id}). Source: ${sug.source_name || 'unknown'} — ${sug.source_url || ''}`.trim(),
  });
  // Pre-fill the interview with the developed angle — guarantees the writer's
  // mandatory interview gate sees a well-formed { questions, answers } context.
  await saveInterviewQuestionsInline(api, slug, [`What's Nyyon's angle on: ${sug.title}?`]);
  const answerText = sug.rationale ? `${sug.angle}\n\nWhy now: ${sug.rationale}` : sug.angle;
  await saveInterviewAnswersInline(api, slug, answerText);

  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_suggestions SET status='approved', question_slug=?, decided_at=?, decided_by=? WHERE id=?`,
  ).bind(slug, now(), actor, id).run();
  await api.log('aeo_suggestion_approved', { id, slug });

  if (typeof run_writer !== 'function') {
    // No writer injected: the question is seeded + ready; the caller (or the
    // next cron tick) writes it.
    return { ok: true, status: 'approved', slug, needs_write: true };
  }

  try {
    await run_writer(api, { slug, actor: 'aeo-suggestion' });
    await syncSuggestionFromQuestion(api, id, slug);
  } catch (e) {
    await api.db.prepare(`UPDATE plugin_editorial_aeo_suggestions SET status='failed', last_error=? WHERE id=?`)
      .bind(String(e?.message || e).slice(0, 500), id).run().catch(() => {});
  }
  const final = await api.db.prepare(`SELECT status, last_error FROM plugin_editorial_aeo_suggestions WHERE id=?`).bind(id).first();
  return { ok: true, status: final?.status || 'approved', slug, last_error: final?.last_error || null };
}

export async function rejectAeoSuggestion(api, id, { actor = 'operator' } = {}) {
  const sug = await api.db.prepare(`SELECT * FROM plugin_editorial_aeo_suggestions WHERE id = ?`).bind(id).first();
  if (!sug) throw new Error(`suggestion ${id} not found`);
  if (sug.status !== 'pending') throw new Error(`suggestion ${id} is already ${sug.status}`);
  await api.db.prepare(`UPDATE plugin_editorial_aeo_suggestions SET status='rejected', decided_at=?, decided_by=? WHERE id=?`).bind(now(), actor, id).run();
  if (sug.signal_id) {
    await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET status='dismissed' WHERE id=?`).bind(sug.signal_id).run().catch(() => {});
  }
  await api.log('aeo_suggestion_rejected', { id });
  return { ok: true };
}
