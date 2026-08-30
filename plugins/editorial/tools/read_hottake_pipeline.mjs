// Editorial plugin — read_hottake_pipeline. Surface entry point for the old
// GET /api/hot-takes/pipeline route (the Publications + Social tabs): every
// non-dismissed package decorated with its legs and the single next action,
// grouped by stage. The logic lives in lib/hot-takes.mjs pipelineView.

import { pipelineView } from './hot-takes.mjs';

export const def = {
  name: 'read_hottake_pipeline',
  description: 'The Hot Takes pipeline view: every package grouped in_flight / needs_review / ready / scheduled / published, each with its social legs and the one next action. What the Publications and Social tabs render.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return pipelineView(api);
}
