// Editorial plugin — draft_article. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { draftArticle } from './aeo-writer.mjs';

export const def = {
  name: 'draft_article',
  description: 'Write one article in house HTML, in a single reasoning step. Give it the topic (title) and, when there is one, the operator\'s raw draft as `body` or their interview as `expert_context`; it follows the AEO playbook, sticks to the existing tag taxonomy, and avoids repeating the posts you pass in. It returns the article and saves nothing.',
  input_schema: {
    type: 'object',
    properties: {
      title:          { type: 'string', description: 'the topic, question or angle to write about' },
      body:           { type: 'string', description: 'the operator\'s hand-written draft in plain prose; it becomes the definitive source' },
      source_text:    { type: 'string', description: 'other seed text to expand into an article (e.g. a social post)' },
      voice_doc:      { type: 'string', description: 'from read_voice_profile' },
      posts:          { type: 'array', description: 'recent post stubs from list_blog_posts, used for dedup + tag taxonomy' },
      target_keyword: { type: 'string', description: 'primary keyword to rank for' },
      expert_context: { type: 'string', description: 'the operator\'s interview answers, from read_aeo_question' },
      tags:           { type: 'array', items: { type: 'string' }, description: 'fallback tags if the writer picks none' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return draftArticle(api, {
    title:          input.title || null,
    body:           input.body || null,
    source_text:    input.source_text || null,
    post:           input.post || null,
    voice_doc:      input.voice_doc || null,
    posts:          Array.isArray(input.posts) ? input.posts : null,
    target_keyword: input.target_keyword || null,
    expert_context: input.expert_context || null,
    tags:           Array.isArray(input.tags) ? input.tags : null,
  });
}
