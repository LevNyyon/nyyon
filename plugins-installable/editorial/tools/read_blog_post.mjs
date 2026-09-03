// Editorial plugin — read_blog_post. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readBlogPost } from './blog-db.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'read_blog_post',
  description: 'Read one blog post by slug: title, excerpt, body, tags and published state. Use it before editing, expanding or sharing a post.',
  input_schema: {
    type: 'object',
    properties: { slug: { type: 'string', description: 'the blog post slug' } },
    required: ['slug'],
  },
};

export async function run(api, input) {
  const post = await readBlogPost(api, slugArg(input));
  if (!post) return { found: false };
  return {
    found: true,
    blog_slug: post.slug,
    post,
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
    tags: post.tags,
  };
}
