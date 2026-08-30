// Editorial plugin — run_aeo_cron. NEW cron entry tool: the host scheduled
// handler used to import lib/aeo-writer.js runAeoCron directly; it now runs
// this tool by name. Thin wrapper — the result is the lib's return.

import { runAeoCron } from './aeo-writer.mjs';

export const def = {
  name: 'run_aeo_cron',
  description: 'Cron entry: run the AEO writer sweep — claim the next due, interviewed question, write its article in the assembled voice, illustrate it and save it as a draft. Returns the writer run report; a run with nothing due reports that instead of failing.',
  input_schema: {
    type: 'object',
    properties: {
      actor:       { type: 'string', description: 'who triggered the run (default aeo-cron)' },
      target_slug: { type: 'string', description: 'write this exact question instead of the next due one' },
      ready_only:  { type: 'boolean', description: 'only claim questions whose interview is answered (default false)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return runAeoCron(api, {
    actor:      input?.actor || 'aeo-cron',
    targetSlug: input?.target_slug || null,
    readyOnly:  input?.ready_only === true,
  });
}
