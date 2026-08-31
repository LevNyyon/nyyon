// Editorial plugin — edit_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, logEvent → api.log
// (kind gains the plugin prefix, the original actor rides in the payload).

import { patchSocialPost } from './social-posts.mjs';

export const def = {
  name: 'edit_social_post',
  description: "Replace a queued post's text with a full new version — use this while refining a draft with the operator. Pass the whole new text, not a diff. Edits only; it never publishes and never changes the channel.",
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, content: { type: 'string', description: 'the full new post text' } },
    required: ['id', 'content'],
  },
};

export async function run(api, input) {
  const post = await patchSocialPost(api, input?.id, { content: input?.content });
  await api.log('social_post_edited', { id: input?.id, chars: String(input?.content || '').length, actor: 'operator' }).catch(() => {});
  return { post };
}
