// Editorial plugin — blog_live_status. NEW tool fronting what the host
// /api/blog/:slug/live-status route did: is this post actually SERVED on the
// public site yet? Publish only confirms/queues; the ops UI polls this after
// approve to flip to "live". Checked server-side (through the web gateway)
// because the browser can't read the cross-origin public site.
//
// Checked against the blog-edge worker's URL, NOT the public site: a Worker's
// subrequest to its own zone bypasses Workers routes and would hit the static
// origin — reporting every edge-served post as "not live". The edge URL
// exercises the same code + same D1 the public URL serves.

import { verifyLiveOnEdge, loadPublishConfig } from './publish.mjs';

export const def = {
  name: 'blog_live_status',
  description: 'Check whether one blog post is actually served on the public site (via the blog-edge worker). Returns {live, status, url}. Poll it after a publish that came back not-yet-live; live=true is the edge-verified ground truth.',
  input_schema: {
    type: 'object',
    properties: {
      slug:     { type: 'string', description: 'the blog post slug to check' },
      attempts: { type: 'number', description: 'edge probe attempts (default 1 — polling callers retry themselves)' },
    },
    required: ['slug'],
  },
};

export async function run(api, input) {
  const slug = input.slug;
  const edge = await verifyLiveOnEdge(api, slug, { attempts: input?.attempts || 1 });
  // Public URL from the configured site origin; with none configured there is
  // no public URL to report.
  const { public_origin: origin } = await loadPublishConfig(api);
  return {
    live:   edge.live,
    status: edge.status,
    url:    origin ? `${origin}/blog/${encodeURIComponent(slug)}/` : null,
    edge,
  };
}
