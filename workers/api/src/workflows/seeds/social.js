// Social · workflow seeds.
//
// Three outcomes, all built from the same granular tools, all threading one
// context through the runner.
//
// social-drafts-for-article alternates draft → save three times on purpose:
// each draft_social_post overwrites {channel, content} on the shared context
// and the save that follows consumes exactly those two keys before the next
// draft replaces them. The article the drafts are written from rides along as
// `article` (draft_social_post emits it, save never touches it), which is why
// step 4 still knows the title after step 3's save has overwritten `post`.
//
// social-release-post and social-post-now share the release half: approve takes
// the atomic outbox claim, push refuses to send without it. Approve is the
// operator gate — the workflows exist so a person clicking Approve gets the
// claimed send, never a second send path around it. Never mark the push step
// optional: that would turn a real delivery failure into a green run, and never
// put a second push in one run.

export const workflows = [
  {
    slug: 'social-drafts-for-article',
    name: 'Social · draft posts for an article',
    description: 'One draft per channel (linkedin-company, facebook-company, linkedin-personal) into the Social review queue, each in that channel\'s voice. Nothing is published: the operator approves each post themselves. Idempotent per slug — a channel that already has a post is skipped unless force is true. Fires on blog publish; also runnable with {slug, force?}.',
    trigger: { kind: 'event', note: 'blog publish (publish.js); manual via run_workflow with {slug, force?}' },
    steps: [
      { tool: 'read_blog_post' },
      { tool: 'draft_social_post', input: { channel: 'linkedin-company' } },
      { tool: 'save_social_post' },
      { tool: 'draft_social_post', input: { channel: 'facebook-company' } },
      { tool: 'save_social_post' },
      { tool: 'draft_social_post', input: { channel: 'linkedin-personal' } },
      { tool: 'save_social_post' },
    ],
  },
  {
    slug: 'social-release-post',
    name: 'Social · release an approved post',
    description: 'Send one approved post through its connection under the outbox no-duplicate claim, and flip the row to posted or failed with the full audit trail. The operator pressing Approve IS the gate; run with {id}.',
    trigger: { kind: 'ui', note: 'Social page Approve button; on-demand via run_workflow with {id}' },
    steps: [
      { tool: 'approve_social_post' },
      { tool: 'push_social_post' },
    ],
  },
  {
    slug: 'social-post-now',
    name: 'Social · post now',
    description: 'Publish an ad-hoc post the operator wrote in chat to ONE connection, through the same claim path as everything else (the old direct-post tool bypassed the outbox). Run with {channel, content, image_url, title?} only after the operator has explicitly confirmed the text, the image and the channel. Cross-posting is one run per connection.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {channel, content, image_url, title?} after explicit operator confirmation' },
    steps: [
      { tool: 'save_social_post' },
      { tool: 'approve_social_post' },
      { tool: 'push_social_post' },
    ],
  },
];
