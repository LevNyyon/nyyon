// Editorial plugin — link_hottake_article. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first; blogUrl is the one
// pure exception — blogUrl(slug, origin?) — since the plugin runtime has no
// env, the URL stays site-relative, same as the host's no-PUBLIC_ORIGIN case).

import { linkArticle, articleView, blogUrl } from './hot-takes.mjs';

export const def = {
  name: 'link_hottake_article',
  description: 'Link a written blog draft to its Hot Takes package by slug — stores the slug, headline and intro and moves the package to review. Also emits the article\'s title, url, excerpt, tags, body and cover so the distribution drafters can use them.',
  input_schema: {
    type: 'object',
    properties: {
      id:      { type: 'string', description: 'package id' },
      slug:    { type: 'string', description: 'blog post slug (blog_slug is accepted too)' },
      title:   { type: 'string', description: 'defaults to the saved post\'s title' },
      excerpt: { type: 'string', description: 'defaults to the saved post\'s excerpt' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  const slug = input.slug || input.blog_slug;
  if (!slug) return { error: 'pass slug (or blog_slug)' };
  const pkg = await linkArticle(api, input.id, { slug, title: input.title, excerpt: input.excerpt }, input.actor || 'operator');
  const view = await articleView(api, input.id);
  const a = view?.article || {};
  return {
    package: pkg,
    package_id: input.id,
    blog_slug: slug,
    slug,
    title: a.title || pkg.headline || pkg.title,
    url: blogUrl(slug),
    excerpt: a.excerpt || pkg.intro || null,
    tags: a.tags || [],
    body_html: a.body || '',
    image_url: a.featured_image_url || null,
  };
}
