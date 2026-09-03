// Editorial plugin — read_hottakes_notes. Surface entry point for the old
// GET /api/hot-takes/notes route: the editable editorial library (POV library,
// publication patterns, quality rules, playbook, timing, social identities),
// each seeded with its shipped default on first read.

import { loadAllHotTakesNotes } from './hot-takes.mjs';

export const def = {
  name: 'read_hottakes_notes',
  description: 'The Hot Takes editorial library — every editable rule note (pov, patterns, quality, playbook, timing, identities) keyed by role, seeded with defaults on first read. Edit with save_hottakes_note.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return loadAllHotTakesNotes(api);
}
