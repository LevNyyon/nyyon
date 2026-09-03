// Editorial plugin — regenerate_blog_figure. NEW tool fronting what the host
// /api/blog/:slug/regenerate-figure route did via regenerateOneFigure:
// redesign ONE in-article chart (the editor's per-chart Change button). The
// src can be the dev-rewritten URL — the lib matches by its blog-figures/
// path segment. Instructions, when given, lead the drafter's prompt.

import { regenerateOneFigure } from './cards-figures.mjs';

export const def = {
  name: 'regenerate_blog_figure',
  description: "Redesign one in-article chart: a replacement figure is drafted from the article text around that spot (operator instructions win when given), rendered, and swapped into the body in place. Returns {ok, url, figure_html} — the caller swaps figure_html into its editor view.",
  input_schema: {
    type: 'object',
    properties: {
      slug:         { type: 'string', description: 'the blog post slug' },
      src:          { type: 'string', description: "the current figure's img src (public or dev-rewritten URL)" },
      instructions: { type: 'string', description: 'operator steering for the replacement chart' },
    },
    required: ['slug', 'src'],
  },
};

export async function run(api, input) {
  return regenerateOneFigure(api, {
    slug:         input.slug,
    src:          input.src,
    instructions: input.instructions || null,
    actor:        input.actor || 'operator',
  });
}
