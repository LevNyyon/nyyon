// Editorial plugin — release_social_post. NEW tool: the host fronted this with
// the social-release-post WORKFLOW (approve_social_post → push_social_post)
// behind POST /api/social/posts/:id/approve. A plugin surface drives tools, so
// the two steps ship as one tool over the same lib atoms — approveAndPush IS
// literally claim-then-send, so there is still exactly ONE send path and no
// way around the outbox claim. Result shape = push_social_post's result (what
// the workflow handed the Approve button).

import { approveAndPush, readSocialPost, sendGate } from './social-posts.mjs';

export const def = {
  name: 'release_social_post',
  description: "Release one queued post in a single call: take the atomic outbox send claim, send through the channel's connection and close the claim — approve_social_post + push_social_post as one step. This is the operator gate: only run it when the operator approved this exact post. A 'failed' row may be released again; that retry is the operator's decision too. A 'posted' row is refused.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const row = await readSocialPost(api, input?.id);
  if (!row) throw new Error('social post not found');

  // Hot Takes legs stay a dry run until the operator flips hottakes.live —
  // checked BEFORE the claim so a dry run leaves the row exactly as it was.
  const gate = await sendGate(api, row);
  if (gate.gated && !gate.live) {
    await api.log('hottake_dryrun', {
      action: 'release_social_post', id: row.id, channel: row.channel,
      chars: (row.content || '').length,
      actor: input?.actor || 'operator',
    }).catch(() => {});
    return {
      ok: true, id: row.id, channel: row.channel, outbox_id: null, dry_run: true,
      would: { action: 'post', channel: row.channel, chars: (row.content || '').length },
    };
  }
  return approveAndPush(api, row.id, { actor: input?.actor || 'operator' });
}
