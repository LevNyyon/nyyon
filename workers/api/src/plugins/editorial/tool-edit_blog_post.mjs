// Editorial plugin — edit_blog_post. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readBlogPost, patchBlogPost } from './blog-db.mjs';

export const def = {
  name: 'edit_blog_post',
  description: 'Patch an existing blog post: only the fields you pass change. Edit the body either by sending a full replacement `body` or by sending `find` + `replace` to swap an exact substring, which is the right tool for a typo, a stat or one sentence.',
  input_schema: {
    type: 'object',
    properties: {
      slug:      { type: 'string', description: 'the post to edit' },
      title:     { type: 'string' },
      excerpt:   { type: 'string' },
      body:      { type: 'string', description: 'full replacement body; use this OR find/replace' },
      find:      { type: 'string', description: 'exact substring in the current body to replace' },
      replace:   { type: 'string', description: 'text to put in place of `find`' },
      tags:      { type: 'array', items: { type: 'string' } },
      published: { type: 'boolean', description: 'publish/unpublish; omit to leave as-is' },
    },
    required: ['slug'],
  },
};

export async function run(api, input) {
  const { slug, title, excerpt, body, find, replace, tags, published } = input;
  const existing = await readBlogPost(api, slug);
  if (!existing) return { ok: false, error: `blog post not found: ${slug}` };

  const patch = { updated_by: input.actor || 'nyo' };
  if (title     !== undefined) patch.title     = title;
  if (excerpt   !== undefined) patch.excerpt   = excerpt;
  if (tags      !== undefined) patch.tags      = tags;
  if (published !== undefined) patch.published = published;
  if (body !== undefined) {
    patch.body = body;
  } else if (find !== undefined) {
    const cur = existing.body || '';
    if (!cur.includes(find)) return { ok: false, error: `\`find\` text is not in the body — nothing changed (looked for: "${String(find).slice(0, 60)}…")` };
    patch.body = cur.split(find).join(replace ?? '');
  }

  const post = await patchBlogPost(api, slug, patch);
  return {
    ok: true,
    blog_slug: post.slug,
    post: { slug: post.slug, title: post.title, published: !!post.published },
    note: existing.published
      ? 'Post is published — the edge worker serves the edit within ~60s.'
      : 'Draft updated (not live).',
  };
}
