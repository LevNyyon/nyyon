// Editorial plugin — append_faq_schema. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { appendFaqSchema } from './aeo-writer.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'append_faq_schema',
  description: 'Append one FAQPage JSON-LD block to a post body so answer engines can lift the Q&As. Use it right after saving an expanded article that produced an FAQ.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      faq:       { type: 'array', description: 'array of {q, a}' },
    },
    required: ['faq'],
  },
};

export async function run(api, input) {
  return appendFaqSchema(api, {
    blog_slug: slugArg(input),
    faq: input.faq,
  });
}
