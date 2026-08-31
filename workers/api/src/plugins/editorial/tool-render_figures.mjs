// Editorial plugin — render_figures. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first). Pixel work happens in the
// host render gateway; the lib keeps only the orchestration.

import { renderFigures } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'render_figures',
  description: 'Render drafted figure specs into stored PNGs (brand SVG templates, no AI image model, zero cost). Returns each figure\'s URL with the anchor it belongs to, for embed_figures to place.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      specs:     { type: 'array', description: 'from draft_figures' },
    },
    required: ['specs'],
  },
};

export async function run(api, input) {
  return renderFigures(api, {
    blog_slug: slugArg(input),
    specs: input.specs,
  });
}
