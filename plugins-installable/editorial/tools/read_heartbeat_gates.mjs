// Editorial plugin — read_heartbeat_gates. Surface entry point for the old
// GET /api/heartbeat/gates route: the score gates each incoming item must
// clear, read live from the priorities note (never hardcoded).

import { heartbeatGates } from './heartbeat.mjs';

export const def = {
  name: 'read_heartbeat_gates',
  description: 'The sweep\'s score gates (enrich_min_relevance, topics_min_content, digest_min_content, 0-100) as currently read from the plugin-editorial-heartbeat-priorities note.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { gates: await heartbeatGates(api) };
}
