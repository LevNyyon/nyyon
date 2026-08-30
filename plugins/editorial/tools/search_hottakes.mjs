// Editorial plugin — search_hottakes. Surface entry point for the old
// GET /api/hot-takes/search route: free-text search across packages, release
// legs and the editable editorial notes.

import { searchHotTakes } from './hot-takes.mjs';

export const def = {
  name: 'search_hottakes',
  description: 'Search Hot Takes: packages (title/headline/summary/take/notes), release legs (text/notes) and the editable editorial library notes. Returns the header search dropdown\'s three groups.',
  input_schema: {
    type: 'object',
    properties: {
      q:     { type: 'string' },
      limit: { type: 'number', description: 'default 30' },
    },
    required: ['q'],
  },
};

export async function run(api, input) {
  return searchHotTakes(api, { q: input?.q || '', limit: Number(input?.limit) || 30 });
}
