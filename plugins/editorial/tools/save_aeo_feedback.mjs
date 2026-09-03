// Editorial plugin — save_aeo_feedback. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { recordAeoFeedback } from './blog-db.mjs';

export const def = {
  name: 'save_aeo_feedback',
  description: 'Record the operator\'s reaction to an article idea (love, like, meh, reject, edit) with their own words about why. Call it whenever they react to an idea you proposed; the reactions are what the editorial-taste profile is learned from.',
  input_schema: {
    type: 'object',
    properties: {
      question_slug: { type: 'string', description: 'if the idea is a saved AEO question' },
      idea_title:    { type: 'string', description: 'if it is not a saved question yet' },
      reaction:      { type: 'string', enum: ['love', 'like', 'meh', 'reject', 'edit'] },
      note:          { type: 'string', description: 'their words: why, or how to change it' },
    },
    required: ['reaction'],
  },
};

export async function run(api, input) {
  await recordAeoFeedback(api, {
    question_slug: input.question_slug || input.slug || null,
    idea_title: input.idea_title || null,
    reaction: input.reaction,
    note: input.note || null,
  });
  return { ok: true, recorded: true, reaction: input.reaction };
}
