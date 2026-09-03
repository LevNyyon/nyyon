// Hot Takes surface — the data layer. The host REST routes this page used to
// call are gone: a plugin surface drives its OWN pack's tools through the
// scoped invoke route, so the page, the chat personas and the crons all write
// through the same verbs and can never diverge. Helper NAMES and result shapes
// are kept identical to the old lib/api.ts so the three page files port
// verbatim; the types travel here with the module.

// ─── types (moved verbatim from web/src/lib/api.ts) ─────────────────────────

export type KnowledgeDoc = {
  slug: string; title: string; body: string;
  scope?: 'global' | 'module';
  module?: string | null;
  parent_slug?: string | null;
  updated_at?: number;
};

export type OsintSource = 'hn' | 'reddit' | 'stackoverflow' | 'github' | 'appstore' | 'website' | 'duckduckgo';

export type HeartbeatSource = {
  id: string; kind: 'rss' | 'gnews'; name: string; url: string;
  theme: string | null; enabled: number;
  last_fetched_at: number | null; last_status: string | null; last_error: string | null;
};
export type HeartbeatGates = {
  digest_min_content: number;
  topics_min_content: number;
  enrich_min_relevance: number;
};
export type OsintListener = {
  source: OsintSource;
  label: string;
  enabled: number;          // 1 | 0
  cadence: 'manual' | 'daily' | 'hourly';
  notes: string | null;
  last_run_at: number | null;
  last_status: 'ok' | 'error' | 'running' | null;
  last_error: string | null;
  total_runs: number;
  total_added: number;
  created_at: number;
  updated_at: number;
};

export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  tags: string | null;          // JSON-encoded string[] in DB; parsed below
  published_at: number | null;
  published: number;
  updated_at: number;
  updated_by: string | null;
  views: number;
  unique_visitors: number;
  last_view: number | null;
  avg_scroll: number;           // 0-100
  cta_clicks: number;
  featured_image_url: string | null;
  featured_image_prompt: string | null;
  featured_image_model: string | null;
  featured_image_generated_at: number | null;
};
export type BlogPostWithTags = Omit<BlogPost, 'tags'> & { tags: string[] };
export type BlogImageResult = {
  url: string;
  key?: string;
  model?: string;
  prompt?: string;
  generated_at: number;
  size_bytes?: number;
  width?: number;
  height?: number;
  slug?: string;
};

export type HotTakePackage = {
  id: string;
  status: string;
  title: string | null;
  summary: string | null;
  why_it_matters: string | null;
  source_name: string | null;
  source_url: string | null;
  published_at: number | null;
  origin: string | null;
  origin_ref: string | null;
  multi_source: { title?: string; url?: string }[];
  pinned: boolean;
  take: string | null;
  believe: string | null;
  misunderstood: string | null;
  who_cares: string | null;
  reader_action: string | null;
  brief: Record<string, unknown> | null;
  blog_slug: string | null;
  headline: string | null;
  intro: string | null;
  review: Record<string, unknown> | null;
  company_notes: string | null;
  author_notes: string | null;
  website_status: string;
  website_url: string | null;
  scheduled_at: number | null;
  actor: string | null;
  created_at: number;
  updated_at: number;
};
export type SocialIdentity = { name: string; headline: string; avatar_url: string | null };
export type HotTakePost = {
  id: string;
  package_id: string;
  channel: string;
  body: string | null;
  notes: string | null;
  image_url: string | null;
  status: string;
  scheduled_at: number | null;
  posted_at: number | null;
  outbox_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export type HotTakeTopicCard = {
  origin: string;
  origin_ref: string;
  title: string;
  summary: string;
  why_it_matters: string;
  source_name: string;
  source_url: string | null;
  published_at: number | null;
  heat: number | null;
  multi_source: number;
  kind: string;
  already_selected: boolean;
};
export type TopicsOfTheDayPage = {
  topics: HotTakeTopicCard[];
  generated_at: number;
  offset: number;
  limit: number;
  has_more: boolean;
};
export type HotTakeClaim = { text: string; support: string; source?: string; status: 'needs_confirmation' | 'confirmed' };
export type HotTakeFlag = { kind: string; section?: string; note?: string; severity?: string; resolved?: boolean };
export type HotTakeArticle = {
  slug: string; title: string; excerpt: string | null; body: string | null;
  tags: string[]; featured_image_url: string | null; published: boolean; published_at: number | null;
};
export type HotTakeView = {
  package: HotTakePackage; posts: HotTakePost[]; article: HotTakeArticle | null; next_action: string;
};
export type HotTakePipeline = {
  in_flight: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  needs_review: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  ready: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  scheduled: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  published: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
};
export type HotTakeMarker = { state: string; at: number | null; url?: string | null; error?: string };
export type HotTakeRelease = {
  id: string; title: string | null; blog_slug: string | null; status: string;
  scheduled_at: number | null; website_url: string | null;
  markers: Record<string, HotTakeMarker>; overall: string; posts: HotTakePost[]; next_action: string;
};
export type HotTakeScheduleView = {
  releases: HotTakeRelease[];
  attention: { kind: string; id: string; title: string | null; note: string }[];
  live: boolean; channels: string[]; window_days: number; now: number;
};
export type HotTakeSource = HeartbeatSource & { last_signal_at: number | null; signals_14d: number; useful_14d: number };
export type HotTakeSearchResults = {
  query: string;
  packages: { id: string; title: string | null; headline: string | null; status: string; summary: string | null }[];
  posts: { id: string; package_id: string; channel: string; status: string; snippet: string }[];
  notes: { slug: string; title: string }[];
};

export type SetupDocState = { slug: string; label: string; exists: boolean; personal: boolean; chars: number };
export type HotTakeSetupState = {
  module: string;
  first_run_needed: boolean;
  status: 'pending' | 'done' | 'skipped';
  completed_at: number | null;
  summary: { sources_added: number; sources_kept?: number; listeners_added: number; listeners_kept?: number; watch_written: boolean; ran_ingest: boolean; failed: number } | null;
  personalisation: { personalised: boolean; docs: Record<string, SetupDocState>; material: string[] };
  sources: { total: number; enabled: number; feeds: number; topics: number };
  signals: number;
  hot_topics: number;
};
export type SourceProposal = {
  kind: 'rss' | 'gnews';
  name: string; url: string; query: string | null; theme: string; why: string;
  items: number; latest_at: number | null; sample: string[];
};
export type SourceProposals = {
  ok: boolean;
  reason?: 'no_material' | 'llm_failed';
  message?: string;
  personalisation: HotTakeSetupState['personalisation'];
  industry?: string;
  proposals?: SourceProposal[];
  rejected?: { name: string; url: string; error: string }[];
  fetches?: number;
  brands?: string[]; competitors?: string[]; keywords?: string[]; ignore?: string[];
};
export type FeedCheck = {
  ok: boolean; url: string; status?: number; items?: number;
  latest_at?: number | null; sample?: string[]; error?: string;
};
export type FirstIngestResult = {
  ok: boolean; error: string | null;
  inserted: number; scored: number;
  per_source: { source: string; added?: number; error?: string }[];
  topics: { id: string; title: string; origin?: string }[];
};

// ─── public-site origin (inlined from the host's lib/site.ts, which leaves
//     with the editorial module) ───────────────────────────────────────────
export const PUBLIC_SITE_URL: string =
  String((import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
export const PUBLIC_SITE_HOST: string = PUBLIC_SITE_URL.replace(/^https?:\/\//, '');

// ─── the invoke pipe ────────────────────────────────────────────────────────
async function invoke<T>(tool: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`/api/plugins/editorial/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

const parseTags = (p: BlogPost): BlogPostWithTags => {
  let tags: string[] = [];
  if (p.tags) { try { const x = JSON.parse(p.tags); if (Array.isArray(x)) tags = x; } catch { /* raw string */ } }
  return { ...p, tags };
};

// ─── the api the page files consume — old names, same shapes ────────────────
export const api = {
  // package store
  hotTakePackages: (status?: string) =>
    invoke<{ packages: HotTakePackage[] }>('list_hottake_packages',
      status ? { statuses: status.split(',').map((s) => s.trim()).filter(Boolean) } : {},
    ).then((r) => r.packages),
  hotTakePackage: (id: string) =>
    invoke<{ found: boolean; package: HotTakePackage; posts: HotTakePost[]; next_action: string }>('read_hottake_package', { id })
      .then((r) => { if (!r.found) throw new Error('not found'); return r; }),
  hotTakeTopicsOfTheDay: (
    { limit = 12, q = '', history = false }: { limit?: number; q?: string; history?: boolean } = {},
  ) => invoke<TopicsOfTheDayPage>('list_topic_feed', { limit, ...(q.trim() ? { q: q.trim() } : {}), ...(history ? { history: true } : {}) }),
  hotTakeAddLink: (url: string) =>
    invoke<{ package?: HotTakePackage; error?: string }>('add_hottake_link', { url }),
  hotTakePinTopic: (card: Partial<HotTakeTopicCard>) =>
    invoke<{ package: HotTakePackage }>('pin_hottake_topic', card).then((r) => r.package),
  hotTakeDismissTopic: (card: Partial<HotTakeTopicCard>) =>
    invoke<{ package: HotTakePackage }>('dismiss_hottake_topic', card).then((r) => r.package),
  hotTakePatchPackage: (id: string, patch: Partial<HotTakePackage>) =>
    invoke<{ package: HotTakePackage }>('save_hottake_package', { id, ...patch }).then((r) => r.package),
  hotTakeDismiss: (id: string) =>
    invoke<{ package: HotTakePackage }>('save_hottake_package', { id, status: 'dismissed' }).then((r) => r.package),

  // the editorial spine
  hotTakeDraftTake: (id: string) =>
    invoke<{ package?: HotTakePackage; error?: string }>('draft_hottake_take', { id }),
  hotTakeBuildBrief: (id: string) =>
    invoke<{ package?: HotTakePackage; error?: string }>('build_hottake_brief', { id }),
  hotTakeWriteArticle: (id: string, voice?: 'personal' | 'house') =>
    invoke<{ ok?: boolean; slug?: string; error?: string }>('write_hottake_article', voice ? { id, voice } : { id }),
  hotTakeReviewScan: (id: string) =>
    invoke<{ package?: HotTakePackage; open_claims?: number; flags?: number; error?: string }>('scan_hottake_article', { id }),

  // distribution
  hotTakeDraftSocial: (id: string, channel?: 'linkedin-company' | 'linkedin-personal') =>
    invoke<{ posts?: HotTakePost[]; error?: string }>('draft_hottake_social', channel ? { id, channel } : { id }),
  hotTakeSchedule: (id: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    invoke<HotTakeView & { error?: string }>('schedule_hottake_release', { id, ...times }),
  hotTakeCancelSchedule: (id: string) =>
    invoke<HotTakeView & { error?: string }>('cancel_hottake_schedule', { id }),
  hotTakeScheduleBlog: (slug: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    invoke<HotTakeView & { error?: string }>('schedule_hottake_release', { slug, ...times }),
  hotTakeDraftSocialBlog: (slug: string) =>
    invoke<{ posts?: HotTakePost[]; package_id?: string; error?: string }>('draft_hottake_social', { slug }),
  hotTakePublishWebsite: (id: string) =>
    invoke<{ ok?: boolean; url?: string; error?: string }>('publish_hottake_website', { id }),
  hotTakePatchPost: (postId: string, patch: Partial<HotTakePost>) =>
    invoke<{ post: HotTakePost; error?: string }>('save_hottake_post', { id: postId, ...patch })
      .then((r) => { if (!r.post) throw new Error(r.error || 'save failed'); return r.post; }),

  // views over the same store
  hotTakeView: (id: string) =>
    invoke<HotTakeView & { error?: string }>('read_hottake_article', { id })
      .then((r) => { if (r.error) throw new Error(r.error); return r; }),
  hotTakeSaveArticle: (id: string, patch: { title?: string; excerpt?: string; body?: string }) =>
    invoke<HotTakeView & { error?: string }>('save_hottake_article', { id, ...patch })
      .then((r) => { if (r.error) throw new Error(r.error); return r; }),
  hotTakePipeline: () => invoke<HotTakePipeline>('read_hottake_pipeline'),
  hotTakeScheduleView: (days = 30) => invoke<HotTakeScheduleView>('read_hottake_schedule', { days }),
  hotTakeSources: () => invoke<{ channels: HotTakeSource[]; topics: HotTakeSource[] }>('list_approved_sources'),
  hotTakeSearch: (q: string) => invoke<HotTakeSearchResults>('search_hottakes', { q }),
  hotTakeNotes: () => invoke<Record<string, KnowledgeDoc>>('read_hottakes_notes'),
  hotTakeState: () => invoke<{ live: boolean }>('read_hottakes_state'),
  hotTakeSocialIdentities: () =>
    invoke<{ identities: Record<string, SocialIdentity> }>('read_social_identities').then((r) => r.identities),
  hotTakeSaveNote: (slug: string, title: string, body: string) =>
    invoke<{ doc: KnowledgeDoc; error?: string }>('save_hottakes_note', { slug, title, body })
      .then((r) => { if (!r.doc) throw new Error(r.error || 'save failed'); return r.doc; }),

  // module first run
  hotTakeSetup: () => invoke<HotTakeSetupState>('read_hottakes_setup'),
  hotTakeProposeSources: (hint?: string) =>
    invoke<SourceProposals>('propose_heartbeat_sources', { hint: hint || '' }),
  hotTakeValidateFeed: (url: string) =>
    invoke<FeedCheck>('validate_feed_url', { url }),
  hotTakeApplySetup: (body: {
    sources?: Partial<SourceProposal>[];
    targets?: { name: string; domain?: string | null; kind?: 'plugin-editorial-brand' | 'competitor' }[];
    watch?: { topics?: string[]; keywords?: string[]; ignore?: string[]; note?: string } | null;
    ran_ingest?: boolean;
  }) => invoke<{ ok: boolean; status: string; summary: HotTakeSetupState['summary']; failed: { name: string; error: string }[] }>(
    'save_hottakes_setup', body),
  hotTakeSkipSetup: (reopen = false) =>
    invoke<{ ok: boolean }>('skip_hottakes_setup', { reopen }),
  // The first sweep. The old route ran the hottakes-first-ingest workflow;
  // here the pack's own run_heartbeat tool IS that sweep (ingest → score →
  // enrich → pulse → topics), and the feed read fills the receipt's cards.
  hotTakeFirstIngest: async (): Promise<FirstIngestResult> => {
    let sweep: { ok?: boolean; error?: string | null; inserted?: number; scored?: number; per_source?: { source: string; added?: number; error?: string }[] };
    try {
      sweep = await invoke('run_heartbeat', { actor: 'first-ingest' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'sweep failed', inserted: 0, scored: 0, per_source: [], topics: [] };
    }
    let topics: FirstIngestResult['topics'] = [];
    try {
      const feed = await invoke<TopicsOfTheDayPage>('list_topic_feed', { limit: 6 });
      topics = (feed.topics || []).map((t) => ({ id: `${t.origin}:${t.origin_ref}`, title: t.title, origin: t.origin }));
    } catch { /* the sweep already succeeded — an empty receipt list is fine */ }
    return {
      ok: sweep.ok !== false,
      error: sweep.ok === false ? (sweep.error || 'sweep failed') : null,
      inserted: sweep.inserted ?? 0,
      scored: sweep.scored ?? 0,
      per_source: sweep.per_source || [],
      topics,
    };
  },

  // heartbeat feed sources + gates (the same store the sweep reads)
  writeHeartbeatSource: (body: Partial<HeartbeatSource> & { query?: string }) =>
    invoke<{ source: HeartbeatSource }>('save_heartbeat_source', body).then((r) => r.source),
  patchHeartbeatSource: (id: string, patch: Partial<HeartbeatSource>) =>
    invoke<{ source: HeartbeatSource }>('save_heartbeat_source', {
      id, ...patch,
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
    }).then((r) => r.source),
  deleteHeartbeatSource: (id: string) =>
    invoke<{ ok: boolean }>('delete_heartbeat_source', { id }),
  heartbeatGates: () => invoke<{ gates: HeartbeatGates; error?: string }>('read_heartbeat_gates').then((r) => r.gates),
  saveHeartbeatGates: (patch: Partial<HeartbeatGates>) =>
    invoke<{ gates: HeartbeatGates; error?: string }>('save_heartbeat_gates', patch)
      .then((r) => { if (!r.gates) throw new Error(r.error || 'could not save gates'); return r.gates; }),

  // the shared OSINT listener table
  listOsintListeners: () => invoke<{ listeners: OsintListener[] }>('list_osint_listeners').then((r) => r.listeners),
  patchOsintListener: (source: OsintSource, patch: Partial<Pick<OsintListener, 'enabled' | 'cadence' | 'notes'>>) =>
    invoke<{ listener: OsintListener }>('save_osint_listener', {
      source, ...patch,
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
    }).then((r) => r.listener),

  // blog store (the joined publications view + the editor's fetches)
  listBlogAnalytics: async (publishedOnly = true): Promise<BlogPostWithTags[]> => {
    const r = await invoke<{ posts: BlogPost[] }>('list_blog_analytics', { published_only: publishedOnly });
    return (r.posts || []).map(parseTags);
  },
  getBlogPost: (slug: string) =>
    invoke<{ found: boolean; post: BlogPost }>('read_blog_post', { slug })
      .then((r) => { if (!r.found || !r.post) throw new Error('not found'); return parseTags(r.post); }),
  generateBlogImage: (slug: string, opts: { prompt_override?: string; model?: string } = {}) =>
    invoke<{ image: BlogImageResult }>('generate_blog_image', { slug, ...opts }).then((r) => r.image),
  publishBlogPost: (slug: string, opts: { deploy?: boolean } = {}) =>
    invoke<{
      ok: boolean; slug: string; live: boolean; url: string;
      mirrored?: boolean; mirror_error?: string | null; error?: string;
    }>('publish_blog_post', { slug, deploy: opts.deploy !== false }),
  deleteBlogPost: (slug: string) =>
    invoke<{ ok: boolean }>('delete_blog_post', { slug }),
};
