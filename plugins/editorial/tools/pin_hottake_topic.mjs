// Editorial plugin — pin_hottake_topic. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first). hostOf is inlined per
// the contract.

import { pinTopic } from './hot-takes.mjs';

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export const def = {
  name: 'pin_hottake_topic',
  description: 'Pin a topic into Selected Topics as a publication package at status "topic". Pass a feed card\'s fields (origin, origin_ref, title, summary, source_name, source_url) to pin it, or just a title to create one by hand. Idempotent by origin_ref, so pinning the same card twice never duplicates.',
  input_schema: {
    type: 'object',
    properties: {
      title:          { type: 'string' },
      summary:        { type: 'string' },
      why_it_matters: { type: 'string' },
      origin:         { type: 'string', description: 'osint_topic|osint_signal|digest|link|manual' },
      origin_ref:     { type: 'string', description: 'the card\'s stable id — what makes pinning idempotent' },
      source_name:    { type: 'string' },
      source_url:     { type: 'string' },
      published_at:   { type: 'number', description: 'ms epoch' },
      multi_source:   { type: 'array', items: { type: 'object' } },
      note:           { type: 'string', description: 'a quick operator note (stored as company_notes)' },
    },
    required: ['title'],
  },
};

export async function run(api, input) {
  // `url` is accepted as an alias so a link-extraction step upstream can
  // thread its source through without renaming anything.
  const sourceUrl = input.source_url || input.url || null;
  return {
    package: await pinTopic(api, {
      origin: input.origin || (sourceUrl ? 'link' : 'manual'),
      origin_ref: input.origin_ref || sourceUrl || null,
      title: input.title,
      summary: input.summary ?? null,
      why_it_matters: input.why_it_matters ?? null,
      source_name: input.source_name || (sourceUrl ? hostOf(sourceUrl) : null),
      source_url: sourceUrl,
      published_at: input.published_at ?? null,
      multi_source: input.multi_source ?? null,
      company_notes: input.note ?? null,
    }, input.actor || 'operator'),
  };
}
