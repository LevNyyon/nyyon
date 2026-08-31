// Digest plugin — clear_read_digest. cmd fronted this with
// POST /api/digest/clear-read; same lib atom.

import { clearReadDigestItems } from './digest.mjs';

export const def = {
  name: 'clear_read_digest',
  description: 'Delete every already-read digest item (the archive sweep). Unread and starred items stay. Use when the operator asks to clean the brief\'s history.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return clearReadDigestItems(api);
}
