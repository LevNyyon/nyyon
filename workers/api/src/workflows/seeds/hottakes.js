// Hot Takes + signal feed · workflow seeds.
//
// Four outcomes, all built from existing tools with no logic in between. The
// runner threads one context: each step reads what it needs off the shared
// object and merges its own result back, so the ONLY design work here is
// ordering the steps whose output keys already line up.
//
// The guardrails these chains must preserve:
//   · Nothing publishes. hottake-produce ends at a package in review with both
//     LinkedIn legs saved as drafts — the operator still approves per post and
//     schedules. publish_blog_post and push_social_post are deliberately absent.
//   · Best-effort steps are marked optional so a failed figure or cover is
//     RECORDED and the article that was already saved survives. Never mark a
//     step optional whose failure should stop the chain.
//   · Legs live in the unified social_posts table: save_social_post must carry
//     the package_id that link_hottake_article puts in context, or the legs are
//     orphaned from their package.

export const workflows = [
  {
    slug: 'hottake-add-link',
    name: 'Hot Takes · add a link',
    description: 'Turn a pasted article URL into a standard Selected Topics card. Fetches the page, extracts title/source/summary/date per the hottakes-link-extract note, and pins the result as a package at status "topic". Run with {url}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {url}; also the Hot Takes page\'s Add link box' },
    // fetch_web_page emits {url, content}; extract_article_meta reads `content`
    // and emits the origin/origin_ref/source_url/published_at that the pin step
    // consumes — so a page that extracts to nothing still pins off the URL.
    steps: [
      { tool: 'fetch_web_page' },
      { tool: 'extract_article_meta' },
      { tool: 'pin_hottake_topic' },
    ],
  },

  {
    slug: 'hottake-produce',
    name: 'Hot Takes · produce a publication',
    description: 'A selected topic becomes a full package at review: take, brief, article draft with figures and cover, claim/quality scan, and both LinkedIn legs drafted into the social queue. Nothing publishes — the operator reviews, approves each post, and schedules. Run with {id}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {id: <package id>}; the Hot Takes unit\'s Produce button' },
    // Threading: build_hottake_seed emits {id,title,body,voice} — exactly the
    // keys read_voice_profile and draft_article read; save_blog_post emits
    // blog_slug; link_hottake_article turns that into the {title,url,excerpt,
    // tags,body_html,image_url,package_id} the two social drafts need.
    steps: [
      { tool: 'draft_hottake_take' },
      { tool: 'build_hottake_brief' },
      { tool: 'build_hottake_seed' },
      { tool: 'read_voice_profile' },
      { tool: 'list_blog_posts' },
      { tool: 'draft_article' },
      { tool: 'save_blog_post' },
      // Illustration is decoration on an article that already exists: a render
      // failure is recorded, never fatal.
      { tool: 'draft_figures', optional: true },
      { tool: 'render_figures', optional: true },
      { tool: 'embed_figures', optional: true },
      { tool: 'render_cover', optional: true },
      { tool: 'set_featured_image', optional: true },
      { tool: 'link_hottake_article' },
      { tool: 'scan_hottake_article' },
      { tool: 'draft_social_post', input: { channel: 'linkedin-company' } },
      { tool: 'save_social_post' },
      { tool: 'draft_social_post', input: { channel: 'linkedin-personal' } },
      { tool: 'save_social_post' },
    ],
  },

  {
    slug: 'hourly-awareness-sweep',
    name: 'Cron · hourly awareness',
    description: 'Fresh mentions scraped, new signals ingested, scored and content-enriched, the industry-pulse note rebuilt, hot topics synthesized, and the morning digest regenerated from every enabled channel. The whole awareness layer in one chain.',
    trigger: {
      kind: 'cron',
      note: 'hourly; the runner may stagger legs across the :00/:15/:30 slots for the Worker subrequest budget — a trigger detail, not workflow logic',
    },
    // The two web-heavy legs are optional: an unreachable scraper target or a
    // paywalled article must cost its own leg, never the hour's digest.
    // stale_after_ms/max_targets are this tick's subrequest budget (the values
    // the :00 cron has run with), visible here so they can be tuned without a
    // code change.
    steps: [
      { tool: 'scrape_osint_targets', input: { stale_after_ms: 10800000, max_targets: 5 }, optional: true },
      { tool: 'ingest_signals' },
      { tool: 'score_signals' },
      { tool: 'enrich_signals', optional: true },
      { tool: 'synthesize_pulse' },
      { tool: 'synthesize_hot_topics' },
      { tool: 'generate_digest' },
    ],
  },

  {
    slug: 'hottakes-first-ingest',
    name: 'Hot Takes · first ingest',
    description: 'The shortest path from "sources saved" to "the Topics tab has cards in it": pull every enabled feed, score what came back, and cluster the survivors into hot topics. Run once at the end of the module first run so the operator sees their own industry instead of an empty state.',
    trigger: { kind: 'on-demand', note: 'the Hot Takes first-run panel\'s "run the first sweep" button; run_workflow with no input' },
    // Deliberately SHORTER than hourly-awareness-sweep: no scraping (there are
    // no listeners on a first run), no article enrichment (it costs money per
    // signal and nothing has been read yet), no digest (that is the morning
    // brief's job, not this minute's). Synthesis is optional because a first
    // pull can legitimately return too few scored signals to cluster — the
    // ingest still counts, and the operator sees signals rather than an error.
    steps: [
      { tool: 'ingest_signals' },
      { tool: 'score_signals' },
      { tool: 'synthesize_hot_topics', optional: true },
    ],
  },

  {
    slug: 'signal-to-blog',
    name: 'Signals · signal → blog opportunity',
    description: 'An industry signal becomes a pending AEO question seeded with the article\'s real content and our angle, and the signal is marked actioned so it is never re-suggested. Run with {signal_id}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {signal_id}; the signal card\'s "write about this" action' },
    // read_signal fetches + caches the article and emits {question, notes,
    // priority, expert_context} — the question writer's own input keys. The
    // final step's fixed input is what closes the loop: actioned, so the
    // suggestion engine never offers this signal again.
    steps: [
      { tool: 'read_signal' },
      { tool: 'save_aeo_question' },
      { tool: 'save_signal', input: { status: 'actioned' } },
    ],
  },
];
