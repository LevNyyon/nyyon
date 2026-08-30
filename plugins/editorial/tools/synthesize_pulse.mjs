// Editorial plugin — synthesize_pulse. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first). The pulse note is the
// plugin-owned plugin-editorial-industry-pulse doc, written inside the lib via
// api.saveKnowledge.

import { synthesizePulse } from './heartbeat.mjs';

export const def = {
  name: 'synthesize_pulse',
  description: 'Rebuild the industry-pulse knowledge note from this week\'s strongest signals — what is happening in our world right now and what we could do about it. Writes the note; read it back with read_industry_pulse.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  const pulse = await synthesizePulse(api);
  return { ok: !!pulse, pulse: pulse || null };
}
