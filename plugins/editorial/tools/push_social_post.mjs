// Editorial plugin — push_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).
//
// ⚙️ The claim-then-send loop stays inside lib social-posts.mjs on purpose:
// splitting the outbox claim from the gateway call is exactly what would
// let the same post go out twice. This tool is the decision point, the lib
// is the atom.

import { readSocialPost, sendClaimedSocialPost, sendGate } from './social-posts.mjs';

export const def = {
  name: 'push_social_post',
  description: 'Send one CLAIMED post through its channel\'s connection and close the claim. Requires the open claim approve_social_post takes: an unclaimed or already-posted post is refused rather than sent. Never call this to "retry" on your own — a repeat send is the operator\'s decision.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const row = await readSocialPost(api, input?.id);
  if (!row) throw new Error('social post not found');

  const gate = await sendGate(api, row);
  if (gate.gated && !gate.live) {
    await api.log('hottake_dryrun', {
      action: 'push_social_post', id: row.id, channel: row.channel,
      chars: (row.content || '').length,
      actor: input?.actor || 'operator',
    }).catch(() => {});
    return {
      ok: true, id: row.id, channel: row.channel, outbox_id: null, dry_run: true,
      would: { action: 'post', channel: row.channel, chars: (row.content || '').length },
    };
  }
  return sendClaimedSocialPost(api, row.id, { actor: input?.actor || 'operator' });
}
