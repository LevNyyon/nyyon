// Editorial plugin — save_heartbeat_gates. Surface entry point for the old
// PUT /api/heartbeat/gates route: rewrite ONLY the fenced json block in the
// priorities note, leaving the operator's prose intact.

import { patchHeartbeatGates } from './heartbeat.mjs';

export const def = {
  name: 'save_heartbeat_gates',
  description: 'Edit the sweep\'s score gates in place (0-100 each; pass only the keys to change). Writes the json block of the plugin-editorial-heartbeat-priorities note — the sweep reads it live, so the change applies on the next run.',
  input_schema: {
    type: 'object',
    properties: {
      enrich_min_relevance: { type: 'number' },
      topics_min_content:   { type: 'number' },
      digest_min_content:   { type: 'number' },
    },
    required: [],
  },
};

export async function run(api, input) {
  try {
    return { gates: await patchHeartbeatGates(api, input || {}) };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
