// Digest plugin: digest_context. The card plus its source row: a calendar
// card carries the calendar_events row it came from; a news card is
// self-contained (headline, link, topic).

import { getDigestItemContext } from './digest.mjs';

export const def = {
  name: 'digest_context',
  description: 'Source-enriched context for one digest item: the item itself, and for calendar cards the underlying calendar event (time, location, link). Use before discussing an item or deciding what to do with it.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  const ctx = await getDigestItemContext(api, input.id);
  if (!ctx) return { error: 'not found' };
  return ctx;
}
