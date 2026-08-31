// Editorial plugin — read_hottakes_state. Surface entry point for the old
// GET /api/hot-takes/state route: is distribution live or paused? Reads the
// hottakes.live feature flag (a HOST table, SELECT-only) via the lib gate.

import { hotTakesLive } from './hot-takes.mjs';

export const def = {
  name: 'read_hottakes_state',
  description: 'Whether Hot Takes distribution is live: hottakes.live feature-flag state. false = scheduled releases and posts are held (the page shows PAUSED).',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { live: await hotTakesLive(api) };
}
