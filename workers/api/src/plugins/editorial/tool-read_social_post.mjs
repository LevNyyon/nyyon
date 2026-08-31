// Editorial plugin — read_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { readSocialPost } from './social-posts.mjs';

export const def = {
  name: 'read_social_post',
  description: 'Read one social post by id — channel, status, source article, package link, and the full current text.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const post = await readSocialPost(api, input?.id);
  return post ? { found: true, post } : { found: false };
}
