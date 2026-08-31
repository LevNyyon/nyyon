// Editorial plugin — read_hottake_article. Surface entry point for the old
// GET /api/hot-takes/article/:id route: the package, its legs, the linked blog
// article (when written) and the next action — the spine drawer's and the
// publication editor's one read.

import { articleView } from './hot-takes.mjs';

export const def = {
  name: 'read_hottake_article',
  description: 'Read one Hot Takes package as the article view: the package, its social legs, the linked blog article (title/body/tags/cover/published) when one exists, and the next action.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const v = await articleView(api, input.id);
  if (!v) return { error: 'not found' };
  return v;
}
