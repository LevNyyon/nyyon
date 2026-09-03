// Editorial plugin — read_hottakes_setup. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { readSetupState } from './hottakes-setup.mjs';

export const def = {
  name: 'read_hottakes_setup',
  description: 'Whether the Hot Takes module has been set up on this install, and what it has to work with: which of company-profile / icp / pov-library / heartbeat-priorities carry the operator\'s own material versus the shipped placeholders, plus how many sources, signals and hot topics exist. Read this before offering to configure the feed.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return readSetupState(api);
}
