// Editorial plugin — the Social surface's data layer.
//
// The host REST routes this page used to call (/api/social/posts,
// /api/social/settings, the per-post edit/approve/skip/delete verbs and the
// group delete) are gone with the module: a plugin surface drives its OWN
// plugin's tools through the scoped invoke route, so the page, the publish
// fan-out and Nyo all write through the exact same verbs and can never
// diverge. The types travel with the module too — they used to live in
// web/src/lib/api.ts, which the conversion strips of its Social section.
//
// The old approve route fronted the social-release-post WORKFLOW
// (approve_social_post → push_social_post); that ships as the pack's
// release_social_post tool, same result shape, same single claim-then-send
// path. skip and the group delete lived only on the host lib behind their
// routes — they ship as the pack's skip_social_post / delete_social_group.

export type SocialChannel = 'linkedin-company' | 'linkedin-personal' | 'facebook-company';
export type SocialStatus  = 'draft' | 'posted' | 'failed' | 'skipped';
export type SocialPost = {
  id: string;
  blog_slug: string;
  blog_title: string | null;
  channel: SocialChannel;
  status: SocialStatus;
  content: string;
  image_url: string | null;
  error: string | null;
  outbox_id: string | null;
  posted_at: number | null;
  created_at: number;
  updated_at: number;
};
export type SocialConnection = { connection: SocialChannel; label: string; network: string; kind: string; configured: boolean };

async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const r = await fetch(`/api/plugins/editorial/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

export const api = {
  listSocialPosts: (opts: { status?: SocialStatus; slug?: string } = {}) =>
    invoke<{ posts: SocialPost[] }>('list_social_posts', { status: opts.status, slug: opts.slug }).then((r) => r.posts),
  socialSettings: () =>
    invoke<{ connections: SocialConnection[] }>('list_social_integrations', {}).then((r) => r.connections),
  editSocialPost: (id: string, content: string) =>
    invoke<{ post: SocialPost }>('edit_social_post', { id, content }).then((r) => r.post),
  // One call = one release: the tool takes the outbox claim and sends under it.
  // A tool-level refusal (already posted, no open claim) THROWS via the invoke
  // envelope; a delivery failure comes back as { ok: false, error } — exactly
  // the two shapes the page already tells apart.
  approveSocialPost: (id: string) =>
    invoke<{ ok: boolean; error?: string; channel?: string; outbox_id?: string | null }>('release_social_post', { id }),
  skipSocialPost: (id: string) =>
    invoke<{ post: SocialPost }>('skip_social_post', { id }).then((r) => r.post),
  deleteSocialPost: (id: string) =>
    invoke<{ ok: boolean }>('delete_social_post', { id }),
  deleteSocialGroup: (slug: string) =>
    invoke<{ ok: boolean; deleted: number | null }>('delete_social_group', { slug }),
};
