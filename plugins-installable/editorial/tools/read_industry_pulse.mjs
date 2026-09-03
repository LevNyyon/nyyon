// Editorial plugin — read_industry_pulse. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { readPulse, topSignals } from './heartbeat.mjs';

export const def = {
  name: 'read_industry_pulse',
  description: 'Read the current industry pulse — the synthesized awareness note plus the top scored signals behind it. Pull this into any strategic conversation (positioning, campaigns, client calls, content) where current external context would sharpen the answer.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  const [pulse, signals] = await Promise.all([
    readPulse(api),
    topSignals(api, { days: 7, minContent: 60, limit: 8 }),
  ]);
  return {
    pulse: pulse || null,
    top_signals: signals.map((s) => ({
      id: s.id, title: s.title, source: s.source_name,
      content_score: s.content_score, angle: s.suggested_angle, url: s.url,
    })),
  };
}
