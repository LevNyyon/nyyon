// Digest plugin — toggle_digest_channel. Ported from cmd's tools/digest.js.

import { patchDigestChannel } from './digest.mjs';

export const def = {
  name: 'toggle_digest_channel',
  description: 'Enable, disable, or re-cadence one of the digest data channels. Use when the operator says "stop reading calendar into the brief", "turn on LinkedIn signals", or "switch whatsapp to daily".',
  input_schema: {
    type: 'object',
    properties: {
      source:  { type: 'string', enum: ['attention', 'li_signals', 'osint_insights', 'whatsapp', 'calendar', 'osint', 'heartbeat', 'email'] },
      enabled: { type: 'boolean' },
      cadence: { type: 'string', enum: ['manual', 'daily', 'hourly'] },
      notes:   { type: 'string' },
    },
    required: ['source'],
  },
};

export async function run(api, input) {
  return { channel: await patchDigestChannel(api, input.source, input) };
}
