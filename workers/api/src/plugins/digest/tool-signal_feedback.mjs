// Digest plugin: signal_feedback. The operator's comment on a score becomes
// durable taste rules, then the card is rescored.

import { distillPriorityFeedback } from './signal-priority.mjs';

export const def = {
  name: 'signal_feedback',
  description: 'Teach the scorer the operator\'s taste: pass their comment on a card\'s priority verdict. The comment distills into durable taste rules in the plugin-digest-signal-priority knowledge doc (bounded) and the card is immediately rescored under the updated rubric.',
  input_schema: {
    type: 'object',
    properties: { digest_id: { type: 'string' }, comment: { type: 'string' } },
    required: ['digest_id', 'comment'],
  },
};

export async function run(api, input) {
  return distillPriorityFeedback(api, input.digest_id, input.comment);
}
