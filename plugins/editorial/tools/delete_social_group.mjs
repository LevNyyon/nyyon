// Editorial plugin — delete_social_group. NEW tool: the host kept this on the
// lib behind DELETE /api/social/group/:slug (no v2 tool existed). Same
// behavior, same result shape as that route ({ ok, slug, deleted }).

import { deleteSocialGroup } from './social-posts.mjs';

export const def = {
  name: 'delete_social_group',
  description: "Delete EVERY social post for one source slug at once — an article's whole fan-out group, a digest:<id> reaction set, or a standalone: row. The Outbox and activity feed keep the record of anything already posted. Irreversible: confirm the slug with the operator first.",
  input_schema: { type: 'object', properties: { slug: { type: 'string', description: 'the blog_slug the group is keyed by' } }, required: ['slug'] },
};

export async function run(api, input) {
  const slug = String(input?.slug || '').trim();
  if (!slug) throw new Error('slug required');
  const r = await deleteSocialGroup(api, slug);
  await api.log('social_group_deleted', { slug, deleted: r?.deleted ?? null, actor: 'operator' }).catch(() => {});
  return r;
}
