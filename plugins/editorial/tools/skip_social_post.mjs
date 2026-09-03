// Editorial plugin — skip_social_post. NEW tool: the host kept this on the lib
// behind POST /api/social/posts/:id/skip (no v2 tool existed). Same behavior,
// same result shape as that route ({ post }).

import { skipSocialPost } from './social-posts.mjs';

export const def = {
  name: 'skip_social_post',
  description: "Mark one queued social post 'skipped' — the operator decided this channel sits this release out. The row stays in the queue as the record of that decision; nothing is deleted and nothing is sent. A skipped post can still be redrafted (force) or approved later. Returns the updated post.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const post = await skipSocialPost(api, input?.id);
  if (!post) throw new Error('social post not found');
  await api.log('social_post_skipped', { id: input?.id, channel: post.channel, actor: 'operator' }).catch(() => {});
  return { post };
}
