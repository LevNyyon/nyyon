// Editorial plugin — validate_feed_url. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { validateFeed } from './hottakes-setup.mjs';

export const def = {
  name: 'validate_feed_url',
  description: 'Fetch one URL and prove it is a working RSS/Atom feed, using the same parser the hourly ingest uses. Returns {ok, items, latest_at, sample} or the reason it failed. Use before adding any feed a human or a model handed you.',
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
};

export async function run(api, input) {
  return validateFeed(api, { url: input.url });
}
