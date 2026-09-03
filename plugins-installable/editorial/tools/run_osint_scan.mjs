// Editorial plugin — run_osint_scan. NEW cron entry tool: the host scheduled
// handler used to import runOsintCron from lib/osint.js directly (the :00
// awareness-sweep leg, with staleAfterMs 3h and maxTargets 5); it is rewired
// to invoke this tool by name. The defaults here are the CRON's values, not
// the lib's 22h/unbounded ones, so a bare invocation reproduces the scheduled
// behavior exactly; the operator-facing scrape_osint_targets keeps the wider
// lib defaults. Result is the lib's return untouched (ran/skipped are arrays
// on a normal run but skipped is a STRING on the "no listeners enabled" early
// return — callers must not take a string's length as a count).

import { runOsintCron } from './osint.mjs';

export const def = {
  name: 'run_osint_scan',
  description: 'Run the hourly OSINT sweep the cron runs at :00: re-scrape every monitored target untouched for longer than the stale window (default 3h), capped per run (default 5 targets, overflow defers oldest-first). Returns the raw sweep result. Safe to run by hand for an immediate scan.',
  input_schema: {
    type: 'object',
    properties: {
      stale_after_ms: { type: 'number', description: 're-scrape targets untouched for longer than this (default 3h)' },
      max_targets: { type: 'number', description: 'cap on targets per run (default 5)' },
      actor: { type: 'string', description: 'who ran it (default osint-cron)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return runOsintCron(api, {
    actor: input?.actor || 'osint-cron',
    staleAfterMs: input?.stale_after_ms || 3 * 60 * 60 * 1000,
    maxTargets: input?.max_targets || 5,
  });
}
