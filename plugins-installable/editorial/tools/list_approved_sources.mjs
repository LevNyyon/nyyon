// Editorial plugin — list_approved_sources. Surface entry point for the old
// GET /api/hot-takes/sources route: the monitored feed sources decorated with
// their 14-day contribution stats, split channels (rss) / topics (gnews).

import { listApprovedSources } from './hot-takes.mjs';

export const def = {
  name: 'list_approved_sources',
  description: 'The Approved Sources readout: every monitored website feed and news query with its last-signal time, 14-day item count and how many of those scored write-worthy. channels = RSS feeds, topics = query sources.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return listApprovedSources(api);
}
