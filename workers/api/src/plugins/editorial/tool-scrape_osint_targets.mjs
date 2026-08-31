// Editorial plugin — scrape_osint_targets. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first). OSINT_SOURCES is
// imported from the lib so the def enum can never drift from the engines.

import { scrapeTarget, runOsintCron, OSINT_SOURCES } from './osint.mjs';

export const def = {
  name: 'scrape_osint_targets',
  description: 'Run the enabled listeners and harvest fresh mentions. Pass an id to scrape one target now; omit it to sweep the targets that have gone stale, bounded by stale_after_ms and max_targets. Slow — each engine has its own throttle.',
  input_schema: {
    type: 'object',
    properties: {
      id:             { type: 'string', description: 'one target; omit for the stale sweep' },
      sources:        { type: 'array', items: { type: 'string', enum: OSINT_SOURCES }, description: 'override which engines run, even disabled ones' },
      stale_after_ms: { type: 'number', description: 'sweep only: re-scrape targets untouched for longer than this' },
      max_targets:    { type: 'number', description: 'sweep only: cap on targets per run (overflow defers, oldest first)' },
    },
    required: [],
  },
};

// The per-target loop and its per-source error capture stay in the lib: a
// flaky engine must degrade to a recorded error, never a failed sweep.
export async function run(api, input) {
  const perSource = (ran) => {
    const acc = new Map();
    for (const t of ran) {
      for (const r of (t.results || [])) {
        const cur = acc.get(r.source) || { source: r.source, count: 0, errors: 0 };
        cur.count += r.count || 0;
        if (r.error) cur.errors += 1;
        acc.set(r.source, cur);
      }
    }
    return [...acc.values()];
  };
  if (input?.id) {
    const r = await scrapeTarget(api, input.id, { sources: input.sources || null });
    const ran = [{ id: r.target_id, total: r.total, results: r.results }];
    return { ran, skipped: [], per_source: perSource(ran) };
  }
  const r = await runOsintCron(api, {
    actor: input?.actor || 'operator',
    ...(input?.stale_after_ms ? { staleAfterMs: input.stale_after_ms } : {}),
    ...(input?.max_targets ? { maxTargets: input.max_targets } : {}),
  });
  // The early return ("no listeners enabled") reports skipped as a string.
  const ran = Array.isArray(r.ran) ? r.ran : [];
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  return {
    ran,
    skipped,
    per_source: perSource(ran),
    ...(typeof r.skipped === 'string' ? { note: r.skipped } : {}),
  };
}
