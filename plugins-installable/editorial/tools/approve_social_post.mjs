// Editorial plugin — approve_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first). The atomic outbox
// claim lives in claimSocialPostSend — this tool is only the decision point.

import { claimSocialPostSend, readSocialPost, sendGate } from './social-posts.mjs';

export const def = {
  name: 'approve_social_post',
  description: "Approve one draft for release: refuses a post that already went out, resolves the article's CURRENT cover over whatever image the row captured at draft time, and opens the outbox send claim that push_social_post requires. This is the operator gate — only run it when the operator has approved this specific post.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const row = await readSocialPost(api, input?.id);
  if (!row) throw new Error('social post not found');

  // Hot Takes legs stay a dry run until the operator flips hottakes.live.
  // Checked BEFORE the claim so a dry run leaves the row exactly as it was.
  const gate = await sendGate(api, row);
  if (gate.gated && !gate.live) {
    await api.log('hottake_dryrun', { action: 'approve_social_post', id: row.id, channel: row.channel, actor: 'operator' }).catch(() => {});
    return {
      id: row.id, channel: row.channel, content: row.content,
      image_url: row.image_url || null, image_title: row.blog_title || '',
      outbox_id: null, dry_run: true,
    };
  }
  return claimSocialPostSend(api, row.id, { actor: input?.actor || 'operator' });
}
