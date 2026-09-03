// Editorial plugin — score_signals. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { scoreNewSignals } from './heartbeat.mjs';

export const def = {
  name: 'score_signals',
  description: 'Score the newly ingested signals for relevance and content value against the heartbeat-priorities rubric, and record the angle we would take. One batch judging pass; run it after ingest_signals.',
  input_schema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'how many new signals to score (default 30)' } },
    required: [],
  },
};

// One LLM call scores the whole batch — splitting it per signal would cost
// N calls for the same judgement, so the loop stays inside the lib.
export async function run(api, input) {
  return scoreNewSignals(api, { limit: input?.limit || 30 });
}
