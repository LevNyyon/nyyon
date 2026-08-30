// Thin REST client + Nyo chat SSE helper.

export type Event = { id: string; kind: string; actor: string; payload: any; created_at: number };

// Nyo conversation history. `messages` on the detail mirrors the Msg shape the
// Chat component renders, so a resumed thread drops straight into state.
export type ConversationSummary = {
  // `turns` counts operator messages, not raw persisted rows (one exchange
  // writes an assistant row per model hop plus a row per tool call).
  id: string; title: string; turns: number; created_at: number; updated_at: number;
};
export type ConversationDetail = {
  id: string; title: string; created_at: number; updated_at: number; truncated?: boolean;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    tool_events?: Array<{ name: string; input?: unknown; result?: unknown; error?: string }>;
    ts?: number;
  }>;
};

export type SystemHealthLevel = 'green' | 'yellow' | 'red';
export type SystemHealthCheck = {
  name: string;
  status: SystemHealthLevel;
  severity: 'critical' | 'degraded';
  note: string | null;
};
export type SystemHealth = {
  overall: SystemHealthLevel;
  checks: SystemHealthCheck[];
  ts: number;
};

export type KnowledgeDoc = {
  slug: string; title: string; body: string;
  scope: 'global' | 'module';
  module: string | null;
  // Tree parent. Null for the root doc (`nyyon-root`). Forms the "context
  // route" — walk parents up to root for the breadcrumb chain.
  parent_slug: string | null;
  updated_at: number;
};
// One step in the breadcrumb chain root → … → self. Returned by
// `/api/knowledge/:slug/path`. Used by the Knowledge page header and by
// Nyo when answering "what context do I need to understand X".
export type KnowledgePathStep = { slug: string; title: string };

export type OsintSource = 'hn' | 'reddit' | 'stackoverflow' | 'github' | 'appstore' | 'website' | 'duckduckgo';

export type HeartbeatSource = {
  id: string; kind: 'rss' | 'gnews'; name: string; url: string;
  theme: string | null; enabled: number;
  last_fetched_at: number | null; last_status: string | null; last_error: string | null;
};
// Score gates — what survives each stage of the sweep. Stored in the editable
// `heartbeat-priorities` knowledge note, never hardcoded; these are 0-100.
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

// ─── blog (analytics overlay on top of blog_posts) ──────────
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
  // Featured image (populated by lib/blog-images.js via Workers AI → R2).
  // URL is same-origin (/assets/blog/<slug>.png).
  featured_image_url: string | null;
  featured_image_prompt: string | null;
  featured_image_model: string | null;
  featured_image_generated_at: number | null;
};

export type BlogImageResult = {
  url: string;
  key: string;
  model: string;
  prompt: string;
  generated_at: number;
  size_bytes: number;
  width: number;
  height: number;
  slug: string;
};

export type BlogPostWithTags = Omit<BlogPost, 'tags'> & { tags: string[] };

export type FeatureFlag = {
  key: string;
  value: number;
  scope: 'surface' | 'tool' | 'module';
  description: string | null;
  updated_at: number;
};

// A 401 means the session cookie is missing or expired. Every read in the app
// funnels through here, so this is the one place that can tell the shell to
// show the sign-in screen instead of each page inventing its own error state.
export const AUTH_EVENT = 'nyyon:unauthorized';

async function j<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
    throw new Error('401 unauthorized');
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// Sign in against the worker's gate. The cookie it sets is what every later
// request rides on, so a success here is followed by a reload, not by state
// juggling — the whole shell re-reads with the session in place.
export async function signIn(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/__gate/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json().catch(() => ({}));
  return r.ok && body?.ok ? { ok: true } : { ok: false, error: body?.error || `sign-in failed (${r.status})` };
}

export type NyoModelMap = {
  nyo_low: string; nyo_mid: string; nyo_high: string;
  writer: string; writer_small: string; vision: string;
  writer_fallback: string;
  source?: 'doc' | 'defaults';
};
export type BrainInfo = {
  provider: 'anthropic' | 'openai' | string;
  model: string | null;
  key_set: boolean;
  models: NyoModelMap;
  defaults: Omit<NyoModelMap, 'source'>;
};

// ─── Social (auto-drafted posts from published blog articles) ─────
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

// ─── Daily Planner (per-day plan + weekly objectives) ──────────
// ─── Hot Takes — editorial command center (topic → take → brief → article → distribute) ─
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
// Who appears as the poster in a channel's post preview — from the editable
// `hottakes-social-identities` note.
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
// One page of Topics of the Day. `has_more` is authoritative for paging —
// the server drops already-selected cards, so page length alone says nothing.
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

// ── Hot Takes module first run ───────────────────────────────────────────────
// `first_run_needed` is the ONLY thing that opens the panel: it is false the
// moment a decision (done or skipped) is recorded, so the wizard never nags.
// `personalisation.docs[*].personal` is the honest per-note answer to "did
// onboarding actually leave anything, or is this still the shipped placeholder".
export type SetupDocState = { slug: string; label: string; exists: boolean; personal: boolean; chars: number };
export type HotTakeSetupState = {
  module: string;
  first_run_needed: boolean;
  status: 'pending' | 'done' | 'skipped';
  completed_at: number | null;
  // `sources_kept` are the ones that were already watched — applying twice adds
  // nothing, and the receipt says so rather than double-counting.
  summary: { sources_added: number; sources_kept?: number; listeners_added: number; listeners_kept?: number; watch_written: boolean; ran_ingest: boolean; failed: number } | null;
  personalisation: { personalised: boolean; docs: Record<string, SetupDocState>; material: string[] };
  sources: { total: number; enabled: number; feeds: number; topics: number };
  signals: number;
  hot_topics: number;
};
// Every proposal has been FETCHED and parsed — `items` is how many entries we
// actually saw, which is why a card can honestly say "42 items".
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
  // The Topics FEED after the sweep — what the operator will actually see on
  // the tab, which is scored signals as well as clustered topics.
  topics: { id: string; title: string; origin?: string }[];
};

export const api = {
  health: () => j<{ ok: boolean }>('/health'),

  // Hot Takes — editorial command center (topic → take → brief → article → distribute).
  hotTakePackages: (status?: string) =>
    j<{ packages: HotTakePackage[] }>(`/api/hot-takes/packages${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) => r.packages),
  hotTakePackage: (id: string) =>
    j<{ package: HotTakePackage; posts: HotTakePost[]; next_action: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}`),
  // Returns the full envelope (not just the cards) because `has_more` is what
  // drives the Load more button — a short page is not proof of exhaustion.
  // `history` widens the lookback to everything retained; Load more grows
  // `limit` with it set rather than paging by offset (see topicsOfTheDay).
  hotTakeTopicsOfTheDay: (
    { limit = 12, q = '', history = false }: { limit?: number; q?: string; history?: boolean } = {},
  ) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) p.set('q', q.trim());
    if (history) p.set('history', '1');
    return j<TopicsOfTheDayPage>(`/api/hot-takes/topics-of-the-day?${p}`);
  },
  hotTakeAddTopic: (body: { title: string; summary?: string; why_it_matters?: string; note?: string }) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/packages', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.package),
  hotTakeAddLink: (url: string) =>
    j<{ package?: HotTakePackage; error?: string }>('/api/hot-takes/add-link', { method: 'POST', body: JSON.stringify({ url }) }),
  hotTakePinTopic: (card: Partial<HotTakeTopicCard>) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/topics/pin', { method: 'POST', body: JSON.stringify(card) }).then((r) => r.package),
  hotTakeDismissTopic: (card: Partial<HotTakeTopicCard>) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/topics/dismiss', { method: 'POST', body: JSON.stringify(card) }).then((r) => r.package),
  hotTakePatchPackage: (id: string, patch: Partial<HotTakePackage>) =>
    j<{ package: HotTakePackage }>(`/api/hot-takes/packages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.package),
  hotTakeDismiss: (id: string) =>
    j<{ package: HotTakePackage }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }).then((r) => r.package),
  hotTakeDraftTake: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/draft-take`, { method: 'POST' }),
  hotTakeBuildBrief: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/build-brief`, { method: 'POST' }),
  hotTakeWriteArticle: (id: string, voice?: 'personal' | 'house') =>
    j<{ ok?: boolean; slug?: string; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/write-article`, { method: 'POST', body: JSON.stringify({ voice }) }),
  hotTakeReviewScan: (id: string) =>
    j<{ package?: HotTakePackage; open_claims?: number; flags?: number; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/review-scan`, { method: 'POST' }),
  // Pass channel to redraft ONE leg (the unit's Redraft button); omit for both.
  hotTakeDraftSocial: (id: string, channel?: 'linkedin-company' | 'linkedin-personal') =>
    j<{ posts?: HotTakePost[]; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/draft-social`, {
      method: 'POST', body: JSON.stringify(channel ? { channel } : {}),
    }),
  hotTakeSchedule: (id: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(times) }),
  hotTakeCancelSchedule: (id: string) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/cancel-schedule`, { method: 'POST' }),
  // Plain blog drafts (no package yet) — the worker adopts them into the
  // release pipeline, so scheduling and social legs work on any article.
  hotTakeScheduleBlog: (slug: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/blog/${encodeURIComponent(slug)}/schedule`, { method: 'POST', body: JSON.stringify(times) }),
  hotTakeDraftSocialBlog: (slug: string) =>
    j<{ posts?: HotTakePost[]; package_id?: string; error?: string }>(`/api/hot-takes/blog/${encodeURIComponent(slug)}/draft-social`, { method: 'POST' }),
  hotTakePublishWebsite: (id: string) =>
    j<{ ok?: boolean; url?: string; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/publish-website`, { method: 'POST' }),
  hotTakeSendPost: (postId: string) =>
    j<{ ok?: boolean; dry_run?: boolean; would?: Record<string, unknown>; error?: string }>(`/api/hot-takes/posts/${encodeURIComponent(postId)}/send`, { method: 'POST' }),
  hotTakePatchPost: (postId: string, patch: Partial<HotTakePost>) =>
    j<{ post: HotTakePost }>(`/api/hot-takes/posts/${encodeURIComponent(postId)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.post),
  hotTakeView: (id: string) => j<HotTakeView>(`/api/hot-takes/article/${encodeURIComponent(id)}`),
  hotTakeSaveArticle: (id: string, patch: { title?: string; excerpt?: string; body?: string }) =>
    j<HotTakeView>(`/api/hot-takes/article/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  hotTakePipeline: () => j<HotTakePipeline>('/api/hot-takes/pipeline'),
  hotTakeScheduleView: (days = 30) => j<HotTakeScheduleView>(`/api/hot-takes/schedule?days=${days}`),
  hotTakeSources: () => j<{ channels: HotTakeSource[]; topics: HotTakeSource[] }>('/api/hot-takes/sources'),

  // Module first run. Only `hotTakeSetup()` runs on mount — proposing costs a
  // model call plus a couple of dozen real feed fetches, so it is always an
  // explicit operator action.
  hotTakeSetup: () => j<HotTakeSetupState>('/api/hot-takes/setup'),
  hotTakeProposeSources: (hint?: string) =>
    j<SourceProposals>('/api/hot-takes/setup/propose', { method: 'POST', body: JSON.stringify({ hint: hint || '' }) }),
  hotTakeValidateFeed: (url: string) =>
    j<FeedCheck>('/api/hot-takes/setup/validate', { method: 'POST', body: JSON.stringify({ url }) }),
  hotTakeApplySetup: (body: {
    sources?: Partial<SourceProposal>[];
    targets?: { name: string; domain?: string | null; kind?: 'brand' | 'competitor' }[];
    watch?: { topics?: string[]; keywords?: string[]; ignore?: string[]; note?: string } | null;
    ran_ingest?: boolean;
  }) => j<{ ok: boolean; status: string; summary: HotTakeSetupState['summary']; failed: { name: string; error: string }[] }>(
    '/api/hot-takes/setup/apply', { method: 'POST', body: JSON.stringify(body) }),
  hotTakeSkipSetup: (reopen = false) =>
    j<{ ok: boolean }>('/api/hot-takes/setup/skip', { method: 'POST', body: JSON.stringify({ reopen }) }),
  hotTakeFirstIngest: () =>
    j<FirstIngestResult>('/api/hot-takes/setup/first-ingest', { method: 'POST', body: JSON.stringify({}) }),
  hotTakeSearch: (q: string) => j<HotTakeSearchResults>(`/api/hot-takes/search?q=${encodeURIComponent(q)}`),
  hotTakeNotes: () => j<Record<string, KnowledgeDoc>>('/api/hot-takes/notes'),
  hotTakeState: () => j<{ live: boolean }>('/api/hot-takes/state'),
  // Poster identities for the social-post previews (editable knowledge note).
  hotTakeSocialIdentities: () =>
    j<{ identities: Record<string, SocialIdentity> }>('/api/hot-takes/social-identities').then((r) => r.identities),
  hotTakeSetLive: (live: boolean) =>
    j<{ ok: boolean }>('/api/feature-flags/hottakes.live', { method: 'PUT', body: JSON.stringify({ value: live }) }),
  hotTakeSaveNote: (slug: string, title: string, body: string) =>
    j<{ doc: KnowledgeDoc }>(`/api/knowledge/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify({ title, body }) }).then((r) => r.doc),
  systemHealth: () => j<SystemHealth>('/api/system/health'),
  brain:  () => j<BrainInfo>('/api/nyo/brain'),
  saveNyoModels: (patch: Partial<NyoModelMap>) =>
    j<{ models: NyoModelMap }>('/api/nyo/models', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.models),

  // Nyo pending-message queue — background workers (AEO cron, image gen, etc)
  // queue assistant turns; Chat polls + injects them.
  listNyoPending: () =>
    j<{ messages: Array<{ id: string; content: string; kind: string | null; ref_kind: string | null; ref_id: string | null; payload: unknown; created_at: number }> }>(
      '/api/nyo/pending',
    ).then((r) => r.messages),
  deliverNyoMessage: (id: string) =>
    j<{ ok: boolean }>(`/api/nyo/pending/${encodeURIComponent(id)}/deliver`, { method: 'POST' }),

  // Conversation history — browse past Nyo threads and reopen one. The server
  // has always persisted every turn; these read it back so a finished thread
  // can be resumed instead of lost when the drawer closes.
  listConversations: (limit = 40) =>
    j<{ conversations: ConversationSummary[]; total: number }>(`/api/chat/conversations?limit=${limit}`),
  readConversation: (id: string) =>
    j<ConversationDetail>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) =>
    j<{ id: string; title: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    j<{ ok: boolean; id: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Proactive wake-up — surveys state, autofires missed AEO publish, queues a
  // morning briefing as a Nyo message. Idempotent server-side (skips when
  // nothing changed since last wake-up).
  systemWakeUp: (autofire = true) =>
    j<{ queued: boolean; message_id?: string; fired?: unknown; summary?: string; reason?: string }>(
      '/api/system/wake-up',
      { method: 'POST', body: JSON.stringify({ autofire }) },
    ),

  events: (limit = 100) =>
    j<{ events: Event[] }>(`/api/events?limit=${limit}`).then((r) => r.events),

  listKnowledge: () => j<{ docs: KnowledgeDoc[] }>('/api/knowledge').then((r) => r.docs),
  readKnowledge: (slug: string) => j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`).then((r) => r.doc),
  readKnowledgePath: (slug: string) =>
    j<{ path: KnowledgePathStep[] }>(`/api/knowledge/${slug}/path`).then((r) => r.path),
  writeKnowledge: (slug: string, patch: Partial<KnowledgeDoc> & { title: string; body: string }) =>
    j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.doc),
  deleteKnowledge: (slug: string) =>
    j<{ ok: boolean }>(`/api/knowledge/${slug}`, { method: 'DELETE' }),

  // Social — auto-drafted LinkedIn/Facebook posts from published articles.
  listSocialPosts: (opts: { status?: SocialStatus; slug?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.slug)   qs.set('slug',   opts.slug);
    return j<{ posts: SocialPost[] }>(`/api/social/posts?${qs.toString()}`).then((r) => r.posts);
  },
  socialSettings: () => j<{ connections: SocialConnection[] }>('/api/social/settings').then((r) => r.connections),
  editSocialPost: (id: string, content: string) =>
    j<{ post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content }) }).then((r) => r.post),
  approveSocialPost: (id: string) =>
    j<{ ok: boolean; error?: string; channel?: string; outbox_id?: string }>(`/api/social/posts/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  skipSocialPost: (id: string) =>
    j<{ post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}/skip`, { method: 'POST' }).then((r) => r.post),
  deleteSocialPost: (id: string) =>
    j<{ ok: boolean }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteSocialGroup: (slug: string) =>
    j<{ ok: boolean; deleted: number | null }>(`/api/social/group/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  generateSocialPosts: (slug: string, force = false) =>
    j<{ ok: boolean; drafted?: number; skipped?: boolean; reason?: string; run_id?: string }>(`/api/social/generate/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify({ force }) }),

  // Heartbeat feed sources (the topic feed behind Hot Takes): RSS + Google News
  // queries. The OSINT PAGE is gone; the scraper + its listeners stay headless,
  // and Hot Takes is the surface that reads and edits them.
  writeHeartbeatSource: (body: Partial<HeartbeatSource> & { query?: string }) =>
    j<{ source: HeartbeatSource }>('/api/heartbeat/sources', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.source),
  patchHeartbeatSource: (id: string, patch: Partial<HeartbeatSource>) =>
    j<{ source: HeartbeatSource }>(`/api/heartbeat/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.source),
  deleteHeartbeatSource: (id: string) =>
    j<{ ok: boolean }>(`/api/heartbeat/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  heartbeatGates: () => j<{ gates: HeartbeatGates }>('/api/heartbeat/gates').then((r) => r.gates),
  saveHeartbeatGates: (patch: Partial<HeartbeatGates>) =>
    j<{ gates: HeartbeatGates }>('/api/heartbeat/gates', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.gates),
  listOsintListeners: () => j<{ listeners: OsintListener[] }>('/api/osint/listeners').then((r) => r.listeners),
  patchOsintListener: (source: OsintSource, patch: Partial<Pick<OsintListener,'enabled'|'cadence'|'notes'>>) =>
    j<{ listener: OsintListener }>(`/api/osint/listeners/${encodeURIComponent(source)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.listener),

  // blog — analytics-joined list
  listBlogAnalytics: async (publishedOnly = true): Promise<BlogPostWithTags[]> => {
    const qs = publishedOnly ? '?published_only=1' : '';
    const r = await j<{ posts: BlogPost[] }>(`/api/blog/analytics${qs}`);
    return r.posts.map((p) => {
      let tags: string[] = [];
      if (p.tags) { try { const x = JSON.parse(p.tags); if (Array.isArray(x)) tags = x; } catch { /* ignore */ } }
      return { ...p, tags };
    });
  },
  // One post row (no analytics decoration) — the editor's post-draft fetch.
  // Tags come JSON-encoded from the DB; normalize to the array shape every
  // consumer of BlogPostWithTags expects.
  getBlogPost: (slug: string) =>
    j<{ post: BlogPost }>(`/api/blog/${encodeURIComponent(slug)}`).then((r): BlogPostWithTags => {
      let tags: string[] = [];
      try { const t = JSON.parse(r.post.tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* raw string */ }
      return { ...r.post, tags };
    }),
  generateBlogImage: (slug: string, opts: { prompt_override?: string; model?: string } = {}) =>
    j<{ image: BlogImageResult }>(`/api/blog/${encodeURIComponent(slug)}/generate-image`, {
      method: 'POST', body: JSON.stringify(opts),
    }).then((r) => r.image),
  // Redesign ONE in-article chart (the editor's per-chart Change button). The
  // src can be the dev-rewritten URL — the server matches by its blog-figures/
  // path segment. Instructions, when given, lead the drafter's prompt.
  regenerateBlogFigure: (slug: string, body: { src: string; instructions?: string | null }) =>
    j<{ ok: boolean; url: string; alt: string; template: string; figure_html: string; error?: string }>(
      `/api/blog/${encodeURIComponent(slug)}/regenerate-figure`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // Live-edit a post's body/title/excerpt. Sends the full row so the PUT
  // (which overwrites) preserves published/tags/published_at — editing a draft
  // keeps it a draft; publishing stays a separate step.
  updateBlogPost: (
    slug: string,
    patch: { title: string; excerpt: string | null; body: string | null; tags: string[]; published: number; published_at: number | null },
  ) =>
    j<{ post: BlogPost }>(`/api/blog/${encodeURIComponent(slug)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }).then((r) => r.post),

  // Is the post actually served on the public site yet? Polled after publish to
  // flip the UI to "live" once the rebuild + CDN have caught up.
  blogLiveStatus: (slug: string) =>
    j<{ live: boolean; status: number; url: string }>(`/api/blog/${encodeURIComponent(slug)}/live-status`),

  // Mirror this slug from local D1 to prod and trigger the marketing-site
  // rebuild. Every attempt logs to the Outbox (channel='blog'). The
  // response's `deploy.ok` reflects whether the sidecar acknowledged.
  publishBlogPost: (slug: string, opts: { deploy?: boolean } = {}) =>
    j<{
      ok: boolean;          // === live: the edge worker actually serves the post
      slug: string;
      live: boolean;
      url: string;
      prod: BlogPost | null;
      mirrored?: boolean;
      mirror_error?: string | null;
      edge?: { live: boolean; status: number } | null;
      outbox_id: string;
    }>(`/api/blog/${encodeURIComponent(slug)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ deploy: opts.deploy !== false }),
    }),

  // Delete a blog post from local D1 (draft or published). Does NOT unpublish
  // from prod — for a live post, take it down at the source separately.
  deleteBlogPost: (slug: string) =>
    j<{ ok: boolean }>(`/api/blog/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // wa-gateway connection management (ops Settings → WhatsApp)
  waProbe: () => j<{
    url: string;
    api_key_configured: boolean;
    session_id: string;
    reachable: boolean;
    http: number | null;
    sessions: unknown;
    webhooks: unknown;
    error: string | null;
  }>('/api/wa/probe'),
  waRegisterWebhook: (inbound_url: string, events: string[] = ['message']) =>
    j<{ http: number; ok: boolean; body: string; url: string }>('/api/wa/register-webhook', {
      method: 'POST', body: JSON.stringify({ inbound_url, events }),
    }),
  waTestInbound: (chat_id: string, body_text?: string) =>
    j<{ synthetic_payload: unknown; result: { ok: boolean; accepted?: boolean; reason?: string; chat_id?: string; person_id?: string | null } }>('/api/wa/test-inbound', {
      method: 'POST', body: JSON.stringify({ chat_id, body_text }),
    }),

  // The outbox-audited send (beginSend → gateway → markSent, and the sent
  // message is pre-inserted into wa_messages so the thread reflects it at once).
  waSend: (chatId: string, text: string) =>
    j<{ messageId?: string; timestamp?: number; chatId?: string; outbox_id?: string; error?: string }>(
      '/api/wa/send', { method: 'POST', body: JSON.stringify({ chatId, text }) },
    ),

  listFlags: () => j<{ flags: FeatureFlag[] }>('/api/feature-flags').then((r) => r.flags),
  setFlag:   (key: string, value: boolean) =>
    j<{ ok: boolean }>(`/api/feature-flags/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

};

// ─── Module prerequisites ───────────────────────────────────────────────────
// What a module needs before it is worth opening. Setup stops at the model key,
// so everything else — the voice interview, the service connections — is asked
// for HERE, by the module that needs it, at the moment the operator opens it.
//
// One payload shape for two kinds of prerequisite, because one component
// renders both (components/ModuleSetupGate.tsx):
//
//   voice    knowledge documents that must be the operator's own rather than
//            the placeholders the app shipped. `slugs` names the ones that are
//            still ours. Fixed by Nyo's interview while setup is still open,
//            and by editing the note in Knowledge once it has closed.
//   gateway  an external service that is not configured. `fields` is the
//            connect form, straight from the server's own resolver — a secret
//            field reports only whether it is `set`, never its value.
//   setup    a first run the module owns itself (Hot Takes' source panel).
//            Reported so the gate can mention it; there is no generic fix.
export type ModulePrereqKind = 'voice' | 'gateway' | 'setup';
export type ModulePrereqField = {
  key: string; label?: string; required?: boolean; secret?: boolean;
  help?: string | null; set?: boolean; source?: string;
};
export type ModulePrereq = {
  kind: ModulePrereqKind;
  /** gateway slug, or the module-owned setup key */
  slug?: string;
  /** voice: the documents still carrying the shipped placeholder */
  slugs?: string[];
  label: string;
  /** what this unlocks, in the operator's terms */
  why: string;
  /** what still works without it — the gate never hard-blocks */
  degraded?: string;
  /** how the gate offers to fix it */
  fix?: 'interview' | 'connect' | 'knowledge' | 'module';
  fields?: ModulePrereqField[];
  /** gateway: 'any' = one credential is enough */
  requires?: 'all' | 'any';
  /** voice: the setup interview is still reachable on this install */
  interview_available?: boolean;
  /** voice: the interview is itself a model call */
  llm_ready?: boolean;
};
export type ModuleStatus = {
  module: string;
  label: string;
  /** every REQUIRED prerequisite is satisfied */
  ready: boolean;
  missing: ModulePrereq[];
  optional: ModulePrereq[];
};
export type AllModuleStatus = {
  modules: ModuleStatus[];
  voice: Array<{ slug: string; label: string; exists: boolean; personal: boolean; shipped: boolean }>;
  interview_available: boolean;
  llm_ready: boolean;
  not_ready: string[];
};

export const modulePrereqs = {
  one: (slug: string) => j<ModuleStatus>(`/api/modules/${encodeURIComponent(slug)}/status`),
  all: () => j<AllModuleStatus>('/api/modules/status'),
  // The gate's inline connect form. Deliberately the POST-SETUP twin
  // (/api/gateways, not /api/onboarding/gateways): the onboarding routes stop
  // answering the moment setup completes, and this surface has to keep working
  // for the life of the install.
  connectGateway: (slug: string, config: Record<string, string>) =>
    j<{ slug: string; configured: boolean; missing?: string[]; error?: string }>('/api/gateways', {
      method: 'POST', body: JSON.stringify({ slug, config }),
    }),
  // Every gateway with its live configured/missing state — the same resolver
  // the gateways themselves read through, so Settings never invents its own.
  gatewayStatus: () => j<{ gateways: GatewayStatus[] }>('/api/gateways'),
  // Installed plugins' pages. A surface is data, so it appears the moment the
  // plugin is active — no rebuild, no restart.
  pluginSurfaces: () => j<{ surfaces: PluginSurfaceDef[] }>('/api/plugins/surfaces'),
};

export type { PluginSurfaceDef } from '../components/PluginSurface';
import type { PluginSurfaceDef } from '../components/PluginSurface';

export type GatewayStatus = {
  slug: string;
  configured: boolean;
  source?: 'db' | 'env' | 'none';
  missing?: string[];
  fields?: { key: string; label?: string; required?: boolean; secret?: boolean; help?: string }[];
};

// ─── Setup ──────────────────────────────────────────────────────────────────
// The first-run sequence. Its FIRST step runs before an admin exists, so none
// of it can ride the shared `j()` helper — a 401 there fires AUTH_EVENT and
// drops the operator into the sign-in screen in the middle of setup. These
// calls surface the status instead and let the caller decide what a failure
// means (404 = this build has no setup surface, or setup is already finished).
//
// From step two onward the operator IS signed in and these routes are cookie
// gated like any other, so a 401 here means the session went away, not that
// the build lacks the feature.

// `step` is whatever the server calls the current stage. The client maps it to
// its own progress rail loosely and never invents one when it is absent. The
// rest is what the interview has actually produced so far — the page reports
// those, it does not compute them.
export type OnboardingState = {
  /** false = no model key yet, so the interview cannot run at all */
  llm_ready?: boolean;
  /** boot should land on the setup surface (not finished, not postponed) */
  needed: boolean;
  /** an account exists: they can sign in, and step one is behind them */
  has_admin: boolean;
  /** the interview finished and the setup surface is closed for good */
  setup_complete?: boolean;
  /** they said "later": in the app, on the shipped default voice docs */
  setup_deferred?: boolean;
  step?: string | null;
  message_count?: number;
  docs_saved?: string[];
  gateways_connected?: string[];
};
export type OnboardingGatewayField = {
  key: string; label?: string; required?: boolean; secret?: boolean;
  help?: string | null;
  // Already has a value on this machine (usually from the install's env). A
  // required field that is `set` needs no input — blank means "leave it".
  set?: boolean;
};
export type OnboardingGateway = {
  slug: string;
  service?: string;
  description?: string;
  configured: boolean;
  source?: string;
  fields?: OnboardingGatewayField[];
};
export type OnboardingMessage = { role: 'user' | 'assistant'; content: string };
// The stored transcript also carries `tool` rows — the beats where the
// interview did something (connected a service, saved a voice doc). They are
// shown, never sent back.
export type OnboardingThreadMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string | null;
  created_at?: number;
};
// `state` is deliberately opaque: the server owns the interview, the client
// only peeks at the few fields it can render honestly.
export type OnboardingTurn = { reply?: string; state?: Record<string, unknown> | null; done?: boolean };

// Setup access. On a machine other than the one the worker runs on, the
// onboarding routes want the token the installer printed. It arrives as
// ?setup_token=… once; we keep it for the session and strip it back out of the
// address bar, because a token in a URL ends up in history and logs.
const SETUP_TOKEN_KEY = 'nyyon.setup-token';
function captureSetupToken(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('setup_token');
    if (!fromUrl) return sessionStorage.getItem(SETUP_TOKEN_KEY) || '';
    sessionStorage.setItem(SETUP_TOKEN_KEY, fromUrl);
    url.searchParams.delete('setup_token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  } catch { return ''; }
}
let SETUP_TOKEN = captureSetupToken();
export function clearSetupToken() {
  SETUP_TOKEN = '';
  try { sessionStorage.removeItem(SETUP_TOKEN_KEY); } catch { /* ignore */ }
}

// status 0 = never reached the server (offline, dev worker down).
export class OnboardingUnavailable extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message || `onboarding unavailable (${status})`);
    this.name = 'OnboardingUnavailable';
    this.status = status;
  }
}

async function ob<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init || {};
  let r: Response;
  try {
    r = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(SETUP_TOKEN ? { 'X-Setup-Token': SETUP_TOKEN } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      ...rest,
    });
  } catch (e) {
    throw new OnboardingUnavailable(0, e instanceof Error ? e.message : 'network error');
  }
  const text = await r.text().catch(() => '');
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { /* html error page from a route that doesn't exist */ } }
  if (!r.ok) throw new OnboardingUnavailable(r.status, body?.error ? String(body.error) : `${r.status} ${r.statusText}`);
  return (body ?? {}) as T;
}

export const onboarding = {
  state: () => ob<OnboardingState>('/api/onboarding/state'),
  // STEP ONE: the account. A form, no model, no conversation. `signed_in`
  // means the worker already issued the session cookie, so the app carries
  // straight on into step two instead of stopping at a login box for a
  // password chosen ten seconds ago.
  // Going back from a later step. The account cannot be un-created, so "back"
  // rewrites it — the mistyped-username escape hatch.
  updateAccount: (username: string, password: string) =>
    ob<{ ok?: boolean; username?: string; signed_in?: boolean; error?: string }>('/api/onboarding/account/update', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  createAccount: (username: string, password: string) =>
    ob<{ ok?: boolean; username?: string; signed_in?: boolean; error?: string }>('/api/onboarding/account', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  // The interview as the SERVER has it. Read on mount so a refresh (or a
  // second tab) resumes the real conversation instead of a browser-local copy
  // of it.
  transcript: () =>
    ob<{ messages?: OnboardingThreadMessage[] }>('/api/onboarding/transcript')
      .then((r) => (Array.isArray(r?.messages) ? r.messages : [])),
  // Full transcript every turn — the server owns the interview state, the
  // client just carries the conversation.
  chat: (messages: OnboardingMessage[]) =>
    ob<OnboardingTurn>('/api/onboarding/chat', { method: 'POST', body: JSON.stringify({ messages }) }),
  // Step one, and deliberately not a chat turn: the interview is itself an LLM
  // call, so this has to succeed before there is anything to talk to. The
  // worker proves the key with a real request rather than just storing it.
  saveLlmKey: (key: string, provider = 'anthropic') =>
    ob<{ ok?: boolean; error?: string; verified?: boolean }>('/api/onboarding/llm-key', {
      method: 'POST', body: JSON.stringify({ key, provider }),
    }),
  gateways: () =>
    ob<{ gateways?: OnboardingGateway[] }>('/api/onboarding/gateways')
      .then((r) => (Array.isArray(r?.gateways) ? r.gateways : [])),
  connectGateway: (slug: string, config: Record<string, string>) =>
    ob<{ ok?: boolean; error?: string }>('/api/onboarding/gateways', {
      method: 'POST', body: JSON.stringify({ slug, config }),
    }),
  // THE LAST STEP. Irreversible: after this every route above 404s.
  finish: (reason = 'interview') =>
    ob<{ ok?: boolean; setup_complete?: boolean; error?: string }>('/api/onboarding/finish', {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  // "Later." Deliberately NOT finish: it leaves the surface alive so `resume`
  // has something to come back to.
  defer: () =>
    ob<{ ok?: boolean; setup_deferred?: boolean; error?: string }>('/api/onboarding/defer', { method: 'POST' }),
  resume: () =>
    ob<{ ok?: boolean; setup_deferred?: boolean; error?: string }>('/api/onboarding/resume', { method: 'POST' }),
};

// Chat helper. Streams SSE events from /api/chat.
export type ChatEvent =
  | { kind: 'start'; conversation_id: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; name: string; input: any }
  | { kind: 'tool_result'; name: string; ok: boolean; result?: any; error?: string }
  | { kind: 'done'; conversation_id: string }
  | { kind: 'error'; message: string };

export async function chat(
  messages: { role: 'user' | 'assistant'; content: string | any[] }[],
  conversation_id: string | null,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
  tier?: 'low' | 'mid' | 'high',
  speech?: boolean,
  agent?: string,
) {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, conversation_id, tier, speech, agent }),
      signal,
    });
  } catch (e) {
    // Stop pressed before the response arrived — clean exit, not an error.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!res.ok || !res.body) {
    onEvent({ kind: 'error', message: `${res.status} ${res.statusText}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let idx; (idx = buffer.indexOf('\n\n')) >= 0; ) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          onEvent({ kind: event as ChatEvent['kind'], ...parsed } as ChatEvent);
        } catch {
          /* swallow malformed sse frames */
        }
      }
    }
  } catch (e) {
    // Stop pressed mid-stream — the reader read() rejects; end cleanly.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
