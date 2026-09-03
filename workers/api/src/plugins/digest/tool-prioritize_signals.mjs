// Digest plugin: prioritize_signals. The sweep scores every unread,
// unscored card of a scored kind (score_kinds in the priority doc).

import { sweepSignalPriorities } from './signal-priority.mjs';

export const def = {
  name: 'prioritize_signals',
  description: 'Score every unread, unscored digest card of a scored kind (bounded batch) so the brief reads most-relevant first and background noise last. Safe to run repeatedly; scored items are skipped. Rubric, score_kinds and thresholds live in the plugin-digest-signal-priority knowledge doc.',
  input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'max cards this run (default from the doc)' } } },
};

export async function run(api, input) {
  return sweepSignalPriorities(api, { limit: input?.limit });
}
