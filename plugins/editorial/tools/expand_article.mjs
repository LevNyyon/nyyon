// Editorial plugin — expand_article. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { expandArticle } from './aeo-writer.mjs';

export const def = {
  name: 'expand_article',
  description: 'Expand an existing article to 1600-2200 words and write its AEO FAQ, in a single reasoning step. Deepens the story with examples, failure modes and why-now, and returns the new excerpt, body and FAQ. It saves nothing: pass the result to save_blog_post and append_faq_schema.',
  input_schema: {
    type: 'object',
    properties: {
      post:      { type: 'object', description: 'the post from read_blog_post' },
      slug:      { type: 'string', description: 'alternative to post: read it by slug' },
      voice_doc: { type: 'string', description: 'from read_voice_profile' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return expandArticle(api, {
    post:      input.post || null,
    slug:      input.slug || null,
    blog_slug: input.blog_slug || null,
    voice_doc: input.voice_doc || null,
  });
}
