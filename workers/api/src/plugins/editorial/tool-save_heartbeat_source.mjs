// Editorial plugin — save_heartbeat_source. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { writeHeartbeatSource } from './heartbeat.mjs';

export const def = {
  name: 'save_heartbeat_source',
  description: 'Add or edit one feed source. New RSS feed: {kind:"rss", name, url}. New Google News topic: {kind:"gnews", name, query} (the feed URL is built from the query). Edit: pass id plus the fields to change; enabled:false pauses a feed without losing its signals.',
  input_schema: {
    type: 'object',
    properties: {
      id:      { type: 'string', description: 'omit to create' },
      kind:    { type: 'string', enum: ['rss', 'gnews'] },
      name:    { type: 'string' },
      url:     { type: 'string' },
      query:   { type: 'string', description: 'gnews only — plain search query' },
      theme:   { type: 'string' },
      enabled: { type: 'boolean' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return { source: await writeHeartbeatSource(api, input || {}) };
}
