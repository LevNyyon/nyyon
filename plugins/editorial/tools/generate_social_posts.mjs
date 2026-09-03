// Editorial plugin — generate_social_posts. NEW tool fronting what the host
// /api/social/generate/:slug route did (the social-drafts-for-article fan-out):
// draft the full channel set for one article — company LinkedIn, personal
// LinkedIn, company Facebook — as review-queue rows in the Social module.
// Nothing is published; the operator approves each post separately.
//
// Same client contract the route kept: {ok, drafted, skipped?, reason?} — a
// domain miss (post not found) comes back ok:false, not a throw.

import { generateSocialPostsForBlog } from './social-posts.mjs';

export const def = {
  name: 'generate_social_posts',
  description: "Draft the whole social set for one blog article (company LinkedIn, personal LinkedIn, company Facebook) into the Social review queue. Skips an article that already has posts unless force=true (force replaces only unposted drafts, never the audit trail of what shipped). Drafts only — publishing stays the operator's approval.",
  input_schema: {
    type: 'object',
    properties: {
      slug:  { type: 'string', description: 'the blog post slug to draft from' },
      force: { type: 'boolean', description: 'redraft even if the article already has social posts' },
    },
    required: ['slug'],
  },
};

export async function run(api, input) {
  return generateSocialPostsForBlog(api, input.slug, {
    source: input.source || 'social-generate',
    force:  !!input.force,
  });
}
