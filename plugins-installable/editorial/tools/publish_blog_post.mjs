// Editorial plugin — publish_blog_post. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).
//
// This is the operator's approval gate for the public site — the only path a
// draft has to production.

import { publishBlogPostToProd } from './publish.mjs';

export const def = {
  name: 'publish_blog_post',
  description: 'Publish one blog post live on the public site. Marks it published, verifies the edge worker actually serves it (live=true means confirmed, not queued), pings IndexNow, and logs the attempt to the Outbox. This is the operator\'s approval gate: call it only when they say publish or ship.',
  input_schema: {
    type: 'object',
    properties: {
      slug:   { type: 'string', description: 'the blog post slug to publish' },
      deploy: { type: 'boolean', description: 'also kick the marketing-site rebuild (default true)' },
    },
    required: ['slug'],
  },
};

export async function run(api, input) {
  return publishBlogPostToProd(api, input.slug, {
    source: input.actor || 'nyo',
    deploy: input.deploy !== false,
  });
}
