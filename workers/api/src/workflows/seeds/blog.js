// Blog + article engine — workflow seeds (architecture v2).
//
// Each entry is a linear list of tools from the shared pool; the runner threads
// one shared context through them (see workflows/runner.js). No logic lives
// here, only order.
//
// Why some steps carry `optional: true`: in the workflows whose OUTCOME is an
// article, everything after save_blog_post is illustration. A template that
// fails to render, or an LLM that fumbles the figure specs, must never cost the
// operator the draft that is already saved — the failure is recorded on the run
// and the chain carries on. In the workflows whose outcome IS the visual
// (article-figures, blog-cover, blog-featured-image) the same steps are
// required, because a silent success there would be a lie.
//
// The publish gate is deliberately absent from every chain: save_blog_post
// always saves a draft, and publish_blog_post is the operator's own action.

const FIGURE_STEPS_OPTIONAL = [
  { tool: 'draft_figures',      optional: true },
  { tool: 'render_figures',     optional: true },
  { tool: 'embed_figures',      optional: true },
  { tool: 'render_cover',       optional: true },
  { tool: 'set_featured_image', optional: true },
];

// claim → read → voice → dedup → write → save → mark drafted, then visuals.
// Shared by both AEO writing workflows so they can never drift apart.
const AEO_WRITE_STEPS = [
  'claim_aeo_question',
  'read_aeo_question',
  'read_voice_profile',
  'list_blog_posts',
  'draft_article',
  'save_blog_post',
  { tool: 'save_aeo_question', input: { status: 'drafted' } },
  ...FIGURE_STEPS_OPTIONAL,
  'notify_operator',
];

export const workflows = [
  {
    slug: 'blog-shape',
    name: 'Blog · shape a draft',
    description: 'A house-styled DRAFT in Blog > Needs review with 2-5 embedded figures and a code-drawn cover; never published. Run with {title, body?, voice?, target_keyword?}; pass {slug} to reshape an existing post in place.',
    trigger: { kind: 'on-demand', note: "Nyo 'write a post' / Blog UI; run_workflow with {title, body?}" },
    steps: [
      'read_voice_profile',
      'list_blog_posts',
      'draft_article',
      'save_blog_post',
      ...FIGURE_STEPS_OPTIONAL,
    ],
  },

  {
    slug: 'blog-expand',
    name: 'Blog · expand an article',
    description: 'Existing post expanded to 1600-2200 words with an FAQ + FAQPage JSON-LD, refreshed figures and cover; publish stays a separate operator action. Run with {slug}; add {voice:"lev"} for the founder\'s voice.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {slug}' },
    steps: [
      'read_blog_post',
      'read_voice_profile',
      'expand_article',
      'save_blog_post',
      'append_faq_schema',
      ...FIGURE_STEPS_OPTIONAL,
    ],
  },

  {
    slug: 'article-figures',
    name: 'Blog · article figures',
    description: '2-5 editorial diagrams regenerated and embedded at their anchor sentences, cover refreshed and set as the featured image. Run with {slug}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {slug}' },
    steps: [
      'read_blog_post',
      'draft_figures',
      'render_figures',
      'embed_figures',
      'render_cover',
      'set_featured_image',
    ],
  },

  {
    slug: 'blog-cover',
    name: 'Blog · refresh the cover',
    description: 'Reliable code-drawn cover regenerated at a cache-busted URL and set as the featured image. No AI image model, no key, zero cost. Run with {slug}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {slug}' },
    steps: [
      'read_blog_post',
      'draft_cover',
      'render_cover',
      'set_featured_image',
    ],
  },

  {
    slug: 'blog-featured-image',
    name: 'Blog · featured image',
    description: 'AI-illustration featured image: visual brief, N candidates, vision judge, winner set on the post. Run with {slug, n?, model?}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {slug}' },
    steps: [
      'read_blog_post',
      'draft_visual_brief',
      'render_images',
      'judge_images',
      'set_featured_image',
    ],
  },

  {
    slug: 'social-card',
    name: 'Social · share card',
    description: 'Brand-locked share-card PNG in R2 plus a social_cards record. Run with {slug}; a custom-title card starts at draft_card with {title, excerpt}.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {slug} or {title, excerpt}' },
    steps: [
      'read_blog_post',
      'draft_card',
      'render_card',
      'save_social_card',
    ],
  },

  {
    slug: 'article-from-social',
    name: 'Blog · article from a social post',
    description: 'A social post expanded into a full article DRAFT through the same shape pipeline. Run with {id} of the social post; nothing publishes.',
    trigger: { kind: 'on-demand', note: 'run_workflow with {id}' },
    steps: [
      'read_social_post',
      'read_voice_profile',
      'list_blog_posts',
      'draft_article',
      'save_blog_post',
      ...FIGURE_STEPS_OPTIONAL,
    ],
  },

  {
    slug: 'aeo-interview-start',
    name: 'AEO · start an interview',
    description: 'Question queued (or created on the fly) with 4 saved interview questions awaiting the operator\'s answers. Run with {question_slug} or {question}.',
    trigger: { kind: 'on-demand', note: 'Nyo, when the operator picks a topic to work on' },
    steps: [
      'save_aeo_question',
      'draft_interview_questions',
      'save_interview_questions',
    ],
  },

  {
    slug: 'aeo-write',
    name: 'AEO · write a drafted article',
    description: 'A ready (interviewed) AEO question written as a DRAFT article with figures and cover, the question marked drafted, the operator notified. The claim gate blocks un-interviewed or concurrently-claimed questions. Run with {question_slug}, or with nothing to take the next due ready question.',
    trigger: { kind: 'on-demand', note: 'Nyo / cron; no slug = claim the next due ready question' },
    steps: AEO_WRITE_STEPS,
  },

  {
    slug: 'aeo-write-with-answers',
    name: 'AEO · answers then write',
    description: 'The operator\'s answers are saved, then the full aeo-write chain runs and produces the drafted article from their expertise. Run with {question_slug, answers} the moment they reply.',
    trigger: { kind: 'on-demand', note: 'Nyo, the moment interview answers arrive' },
    steps: ['save_interview_answers', ...AEO_WRITE_STEPS],
  },

  {
    slug: 'aeo-react',
    name: 'AEO · learn the operator\'s taste',
    description: 'Reaction recorded and the nyyon-editorial-taste knowledge doc refreshed from every recent reaction. Run with {reaction, note?, question_slug?|idea_title?}.',
    trigger: { kind: 'on-demand', note: 'Nyo, whenever the operator reacts to an idea' },
    steps: [
      'save_aeo_feedback',
      'draft_taste_profile',
      'write_knowledge',
    ],
  },

  {
    slug: 'aeo-suggestion-generator',
    name: 'AEO · suggestions from signals',
    description: 'Up to the policy cap of pending aeo_suggestions rows developed from the top-scored unconverted OSINT signals; source signals are marked actioned so the same news is never re-suggested. Caps live in the aeo-suggestion-policy doc.',
    trigger: { kind: 'cron', note: 'daily; also manual via run_workflow' },
    steps: [
      'read_suggestion_policy',
      'list_signals',
      'draft_suggestion_angles',
      'save_aeo_suggestions',
    ],
  },
];
