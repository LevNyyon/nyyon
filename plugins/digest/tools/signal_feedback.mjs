// Digest plugin — signal_feedback. Ported from cmd's tools/digest.js pool.

import { distillPriorityFeedback } from './signal-priority.mjs';

export const def = {
  name: 'signal_feedback',
  description: 'Teach the signal scorer the operator\'s taste: pass his comment on a signal\'s priority verdict. The comment distills into durable taste rules in the plugin-digest-signal-priority knowledge doc (bounded) and the signal is immediately rescored under the updated rubric.',
  input_schema: {
    type: 'object',
    properties: { digest_id: { type: 'string' }, comment: { type: 'string' } },
    required: ['digest_id', 'comment'],
  },
};

export async function run(api, input) {
  return distillPriorityFeedback(api, input.digest_id, input.comment);
}
