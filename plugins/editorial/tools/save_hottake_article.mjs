// Editorial plugin — save_hottake_article. Surface entry point for the old
// PATCH /api/hot-takes/article/:id route: edit the linked article's
// title/excerpt/body through the package (the headline follows a title edit).

import { saveArticleEdit } from './hot-takes.mjs';

export const def = {
  name: 'save_hottake_article',
  description: 'Edit a package\'s written article — title, excerpt and/or body. Saves through the blog store and keeps the package headline in sync with a title change. Returns the fresh article view.',
  input_schema: {
    type: 'object',
    properties: {
      id:      { type: 'string', description: 'package id' },
      title:   { type: 'string' },
      excerpt: { type: 'string' },
      body:    { type: 'string' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  try {
    return await saveArticleEdit(api, input.id, {
      title: input.title, excerpt: input.excerpt, body: input.body,
    }, input.actor || 'operator');
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
