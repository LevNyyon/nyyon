// Editorial plugin — list_social_posts. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { listSocialPosts } from './social-posts.mjs';

export const def = {
  name: 'list_social_posts',
  description: 'List queued social posts — id, channel, status (draft | claimed | posted | failed | skipped), source article (blog_slug/blog_title), package_id for Hot Takes release legs, and the content. Filter by status, blog slug, or package. Use this to find the post the operator wants to work on.',
  input_schema: {
    type: 'object',
    properties: {
      status:     { type: 'string', description: 'draft | ready | scheduled | claimed | posted | failed | skipped | not_planned' },
      slug:       { type: 'string', description: 'source blog post slug' },
      package_id: { type: 'string', description: 'Hot Takes package id — its release legs' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return {
    posts: await listSocialPosts(api, {
      status: input?.status || null, slug: input?.slug || null, package_id: input?.package_id || null,
    }),
  };
}
