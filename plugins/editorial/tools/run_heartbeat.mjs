// Editorial plugin — run_heartbeat. NEW cron entry tool: the host scheduled
// handler used to import runHeartbeat from lib/heartbeat.js directly (the :15
// awareness-sweep leg); it is rewired to invoke this tool by name. Thin
// wrapper — the whole pass (ingest all sources → score new signals in batches
// → enrich survivors → synthesize pulse → cluster hot topics) lives in the
// ported lib, and the result is the lib's return untouched.

import { runHeartbeat } from './heartbeat.mjs';

export const def = {
  name: 'run_heartbeat',
  description: 'Run the full hourly awareness heartbeat: ingest every enabled feed source, score the new signals against the priorities rubric, enrich the high-relevance ones from their full article text, rebuild the industry pulse and cluster fresh hot topics. The cron\'s :15 leg — safe to run by hand for an immediate sweep.',
  input_schema: {
    type: 'object',
    properties: {
      actor: { type: 'string', description: 'who ran it (default heartbeat-cron)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return runHeartbeat(api, { actor: input?.actor || 'heartbeat-cron' });
}
