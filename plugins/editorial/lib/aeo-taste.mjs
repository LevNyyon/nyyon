// Editorial plugin — aeo-taste. Ported from workers/api/src/lib/aeo-taste.js.
// Turns accumulated operator feedback into a living "editorial taste" profile,
// stored as the plugin-editorial-editorial-taste knowledge doc (re-slugged from
// the host's `editorial-taste`; runtime-written docs live in the plugin
// namespace). This file imports NOTHING; every exported fn takes `api` first.
//
// Tables: plugin_editorial_aeo_feedback (read)
// Knowledge: plugin-editorial-editorial-taste (own, read + write)
// Gateways: llm(text)

export const TASTE_SLUG = 'plugin-editorial-editorial-taste';

const TASTE_SYSTEM = `You maintain the editorial TASTE PROFILE for Nyyon's founder — the rules Nyo should follow when proposing blog/AEO article ideas, learned from the founder's reactions to past ideas.

You are given: the current taste profile (may be empty) and a list of recent reactions (reaction + the idea + the founder's note). Produce an UPDATED profile that folds in the new signal. Keep it tight, concrete, and prescriptive — it will be pasted into idea-generation prompts.

Output clean markdown with these sections (omit a section if you have no signal for it):

## Angles he loves
(bullets — concrete patterns/topics/framings he reacted well to)

## Angles he rejects
(bullets — what he kills, and why, in his words where possible)

## Recurring asks
(bullets — edits he keeps requesting, e.g. "more specific", "tie to incrementality", "name the mechanism")

## Voice & framing notes
(bullets — how he wants ideas framed: contrarian, proof-led, no listicles, etc.)

Rules: synthesise, don't just list every reaction. Merge duplicates into sharper rules. Keep it under ~250 words. Only assert what the reactions support — do not invent preferences.`;

// Duplicated from blog-db.mjs — lib files import nothing (contract).
async function recentAeoFeedback(api, { limit = 60 } = {}) {
  const r = await api.db.prepare(`SELECT * FROM plugin_editorial_aeo_feedback ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
  return r.results || [];
}

// DRAFT the updated profile from the latest feedback — one LLM step, no writes.
// Returns the knowledge doc to save (or null when there is no signal yet).
export async function draftTasteProfile(api) {
  const feedback = await recentAeoFeedback(api, { limit: 80 });
  if (!feedback.length) return null;

  const current = await api.knowledge(TASTE_SLUG).catch(() => null);
  const fbLines = feedback.map((f) => {
    const subject = f.idea_title || f.question_slug || '(idea)';
    return `- [${f.reaction}] "${subject}"${f.note ? ` — ${f.note}` : ''}`;
  }).join('\n');

  const prompt = [
    '## Current taste profile',
    current?.body || '(none yet)',
    '',
    '## Recent reactions (newest first)',
    fbLines,
    '',
    'Produce the updated taste profile now.',
  ].join('\n');

  const md = await api.gateway('llm', 'text', { system: TASTE_SYSTEM, prompt, model: 'gpt-4o-mini' });

  return {
    slug: TASTE_SLUG,
    title: 'AEO · Editorial taste profile',
    body: String(md).trim(),
  };
}

// Rebuild AND save the taste profile. Best-effort; callers should not fail if
// this errors (it's an enrichment, not a critical path).
export async function refreshTasteProfile(api) {
  const doc = await draftTasteProfile(api);
  if (!doc) return null;
  await api.saveKnowledge(doc.slug, { title: doc.title, body: doc.body });
  await api.log('taste_profile_refreshed', { slug: doc.slug, chars: doc.body.length });
  return doc.body;
}

// Read the taste profile body for injection into a generation prompt. Returns
// null when there's no profile yet (generators then run without it).
export async function readTasteProfile(api) {
  const doc = await api.knowledge(TASTE_SLUG).catch(() => null);
  return doc?.body || null;
}
