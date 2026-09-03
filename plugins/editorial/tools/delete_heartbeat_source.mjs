// Editorial plugin — delete_heartbeat_source. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { deleteHeartbeatSource } from './heartbeat.mjs';

export const def = {
  name: 'delete_heartbeat_source',
  description: 'Delete one feed source by id; its already-ingested signals are kept. Prefer save_heartbeat_source with enabled:false to pause a feed reversibly.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  return deleteHeartbeatSource(api, input.id);
}
