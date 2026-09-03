// Editorial plugin — delete_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, logEvent → api.log
// (kind gains the plugin prefix, the original actor rides in the payload).

import { deleteSocialPost } from './social-posts.mjs';

export const def = {
  name: 'delete_social_post',
  description: 'Delete one social post from the queue by id — a draft the operator does not want, a duplicate, a test row. Irreversible: resolve the exact id with list_social_posts and confirm with the operator first.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  await deleteSocialPost(api, input?.id);
  await api.log('social_post_deleted', { id: input?.id, actor: 'operator' }).catch(() => {});
  return { ok: true, id: input?.id };
}
