// Editorial plugin — list_heartbeat_sources. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { listHeartbeatSources } from './heartbeat.mjs';

export const def = {
  name: 'list_heartbeat_sources',
  description: 'List the industry-awareness feed sources — the RSS feeds and Google News topic queries the hourly sweep ingests, with each one\'s theme, enabled state and last fetch result.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { sources: await listHeartbeatSources(api) };
}
