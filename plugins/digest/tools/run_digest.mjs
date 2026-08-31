// Digest plugin — run_digest. The cron entry tool: the host scheduled
// handler's :30 leg invokes this by name. Same generate pass as
// generate_digest, PLUS the pack's due-send flush — scheduled WhatsApp
// slots are half-hour aligned (09:30 / 19:30), so the :30 tick is exactly
// when a due digest send should leave.

import { generateDigest } from './digest.mjs';
import { flushDueWaQueue } from './wa-queue.mjs';

export const def = {
  name: 'run_digest',
  description: 'Run the digest tick the cron runs at :30: prune what has gone stale, pull every enabled channel, dedupe against what is already there, then deliver any due scheduled WhatsApp sends from the digest queue. Safe to run by hand to refresh the morning digest now.',
  input_schema: {
    type: 'object',
    properties: {
      since_ms: { type: 'number', description: 'lookback window in ms (default 24h)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  const gen = await generateDigest(api, input?.since_ms ? { since_ms: input.since_ms } : {});
  let wa_queue = null;
  try { wa_queue = await flushDueWaQueue(api, {}); }
  catch (e) { wa_queue = { ok: false, error: String(e?.message || e) }; }
  return { ...gen, wa_queue };
}
