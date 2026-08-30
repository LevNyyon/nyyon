// Editorial plugin — list_blog_posts. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { listBlogPosts } from './blog-db.mjs';

export const def = {
  name: 'list_blog_posts',
  description: 'List blog post stubs (slug, title, excerpt, published date). Call it before writing so you know what already exists, and pass the result to draft_article so the writer does not repeat an argument the blog already makes.',
  input_schema: {
    type: 'object',
    properties: {
      limit:          { type: 'number', description: 'default 200' },
      published_only: { type: 'boolean', description: 'default true' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return {
    posts: await listBlogPosts(api, {
      limit: input?.limit ?? 200,
      publishedOnly: input?.published_only !== false,
    }),
  };
}
