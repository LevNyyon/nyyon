// Digest plugin — list_digest_channels. Ported from cmd's tools/digest.js.

import { listDigestChannels } from './digest.mjs';

export const def = {
  name: 'list_digest_channels',
  description: 'List the data sources feeding the digest (attention, li_signals, osint_insights, whatsapp, osint, heartbeat, calendar, email) with their enabled state, cadence, last-run, and lifetime totals. Use to answer "where does my brief pull from?" or before flipping a channel on/off.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { channels: await listDigestChannels(api) };
}
