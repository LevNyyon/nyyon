// Editorial plugin — adopt_blog_draft. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { ensurePackageForSlug } from './hot-takes.mjs';

export const def = {
  name: 'adopt_blog_draft',
  description: 'Adopt an existing blog post into the Hot Takes release pipeline by slug, creating the package it needs to be scheduled and distributed. Idempotent — a slug that already has a package returns it unchanged.',
  input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
};

export async function run(api, input) {
  return { package: await ensurePackageForSlug(api, input.slug, input.actor || 'operator') };
}
