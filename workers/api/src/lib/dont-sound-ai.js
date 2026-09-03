// "Don't sound AI" — the hard anti-AI-tell writing rules, as a knowledge doc
// welded into EVERY composition (nyyon-lite layer 5).
//
// The rules themselves live in onboarding-playbook.js (the interview welds
// them into the voice docs it writes). This lib makes them a first-class,
// editable knowledge doc and hands them to the chat loop, so every surface
// that composes words — Nyo, the planner, any persona — carries them in its
// system prompt. Doc wins over baked default: edit the doc, behavior changes,
// no deploy. Never throws.

import { readKnowledge } from './db.js';
import { UNIVERSAL_STYLE_RULES, UNIVERSAL_PERSONAL_RULES } from './onboarding-playbook.js';

export const DOC_SLUG = 'dont-sound-ai';

const DONT_SOUND_AI_DEFAULT = `# Don't sound AI

Hard rules for EVERY composition this system produces — chat replies, plans,
briefs, drafts, articles, outreach. Read by every composing surface; the setup
interview also welds these into the voice documents it writes. Edit freely —
this doc is the live source.

${UNIVERSAL_STYLE_RULES}

${UNIVERSAL_PERSONAL_RULES}`;

// Read the doc; seed it on first read so it appears in the Knowledge tree.
export async function loadDontSoundAi(env) {
  try {
    const doc = await readKnowledge(env, DOC_SLUG);
    if (doc) return String(doc.body || '').trim() || DONT_SOUND_AI_DEFAULT;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO knowledge_docs (slug, title, body, parent_slug, updated_at)
       VALUES (?, ?, ?, 'knowledge-root', ?)`,
    ).bind(DOC_SLUG, "Don't sound AI — composition rules", DONT_SOUND_AI_DEFAULT, Date.now()).run();
    return DONT_SOUND_AI_DEFAULT;
  } catch {
    return DONT_SOUND_AI_DEFAULT;
  }
}
