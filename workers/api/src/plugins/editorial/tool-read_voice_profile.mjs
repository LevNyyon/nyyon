// Editorial plugin — read_voice_profile. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readVoiceProfile } from './aeo-writer.mjs';

export const def = {
  name: 'read_voice_profile',
  description: 'Read the assembled writing voice: the brand voice doc plus the operator\'s learned editorial taste, and the founder\'s personal voice when voice="personal". Feed the result to draft_article or expand_article so everything is written in house voice.',
  input_schema: {
    type: 'object',
    properties: { voice: { type: 'string', enum: ['house', 'personal'], description: 'house (default) or personal' } },
    required: [],
  },
};

export async function run(api, input) {
  return readVoiceProfile(api, { voice: input?.voice === 'personal' ? 'personal' : 'house' });
}
