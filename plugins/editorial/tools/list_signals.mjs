// Editorial plugin — list_signals. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { topSignals } from './heartbeat.mjs';

export const def = {
  name: 'list_signals',
  description: 'List recent scored industry signals — real news and blog items with a content score (how write-worthy) and a suggested angle. Use to find content opportunities or answer "what is new in X".',
  input_schema: {
    type: 'object',
    properties: {
      min_content: { type: 'number', description: 'minimum content score 0-100 (default 55)' },
      days:        { type: 'number', description: 'lookback window (default 7)' },
      q:           { type: 'string' },
    },
    required: [],
  },
};

export async function run(api, input) {
  const sigs = await topSignals(api, {
    days: input?.days || 7,
    minContent: input?.min_content ?? 55,
    limit: 20,
    q: input?.q || '',
  });
  return {
    signals: sigs.map((s) => ({
      id: s.id, title: s.title, source: s.source_name, theme: s.theme,
      content_score: s.content_score, formats: s.formats, angle: s.suggested_angle, url: s.url,
    })),
  };
}
