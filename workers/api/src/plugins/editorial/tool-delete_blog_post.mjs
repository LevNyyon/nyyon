// Editorial plugin — delete_blog_post. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { deleteBlogPost } from './blog-db.mjs';

export const def = {
  name: 'delete_blog_post',
  description: 'Delete one blog post by slug. Irreversible, and it does not take a live post off the public site by itself. Resolve the exact slug with list_blog_posts and confirm with the operator first.',
  input_schema: {
    type: 'object',
    properties: { slug: { type: 'string' } },
    required: ['slug'],
  },
};

export async function run(api, input) {
  await deleteBlogPost(api, input.slug);
  return { ok: true, slug: input.slug };
}
