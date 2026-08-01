// Hot Takes + the signal feed — the editorial pipeline (topic → take → brief →
// article seed → link → review scan → schedule) and the awareness engines that
// feed it (heartbeat sources + signals, OSINT listeners/targets/mentions, the
// digest regenerate).
//
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
// One verb on one noun: every tool calls lib functions only, reaches the outside
// world only through gateways, and never calls another tool. The composition
// lives in workflows/seeds/hottakes.js.
//
// The social legs are NOT drafted, saved or sent here. Migration 0062 folded
// hot_take_posts into social_posts, so a Hot Takes leg IS a social post with
// package_id set — the Social family's draft_social_post / save_social_post /
// approve_social_post / push_social_post own that half, and this family stops at
// linking the article and scanning it. Publishing the website is the Blog
// family's publish_blog_post for the same reason.
//
// Every tunable (voice library, patterns, quality rules, playbook, timing
// offsets, link-extraction prompt, scoring rubric) is read from a knowledge doc
// at call time — nothing in this file decides editorial policy.

import { callGateway } from '../gateways/index.js';
import {
  listPackages, readPackage, patchPackage, dismissPackage, pinTopic,
  listPosts, computeNextAction, releaseChannels, topicsOfTheDay,
  loadLinkExtractPrompt, ensurePackageForSlug, findPackageBySlug,
  buildArticleSeed, linkArticle, articleView,
  scheduleRelease, cancelSchedule,
  loadPovLibrary, loadPatterns, loadQualityRules, loadPlaybook, blogUrl,
} from '../lib/hot-takes.js';
import {
  listHeartbeatSources, writeHeartbeatSource, deleteHeartbeatSource,
  ingestHeartbeat, scoreNewSignals, enrichSignals,
  synthesizePulse, readPulse, synthesizeHotTopics, topHotTopics, topSignals,
  readSignalContent, signalQuestionSeed, patchSignal,
} from '../lib/heartbeat.js';
import {
  listOsintListeners, patchOsintListener, listOsintTargets, readOsintTarget,
  writeOsintTarget, deleteOsintTarget, listMentions, scrapeTarget, runOsintCron,
  OSINT_SOURCES,
} from '../lib/osint.js';
import {
  readSetupState, proposeSources, validateFeed, applySetup, skipSetup, reopenSetup,
} from '../lib/hottakes-setup.js';
import { generateDigest } from '../lib/digest.js';

// Crude tag-strip so a pasted page is cheap + safe to hand the model. Callers
// that already fetched clean text (fetch_web_page) pass through untouched.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The topic as the drafters see it — one shape, so take and brief argue about
// the same facts.
function topicContext(pkg) {
  return [
    `TOPIC: ${pkg.title || 'Untitled'}`,
    pkg.summary ? `What happened: ${pkg.summary}` : '',
    pkg.why_it_matters ? `Why it may matter: ${pkg.why_it_matters}` : '',
    pkg.source_name || pkg.source_url ? `Source: ${pkg.source_name || ''} ${pkg.source_url || ''}`.trim() : '',
    pkg.company_notes ? `Company notes: ${pkg.company_notes}` : '',
    pkg.author_notes ? `Author notes: ${pkg.author_notes}` : '',
  ].filter(Boolean).join('\n');
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export const tools = {
  // ── packages: the editorial pipeline ────────────────────────
  list_hottake_packages: {
    def: {
      name: 'list_hottake_packages',
      description: 'List the Hot Takes publication packages — the editorial pipeline from selected topic through take, brief, article, review, ready, scheduled and published. Filter by status to answer "what is waiting on me".',
      input_schema: {
        type: 'object',
        properties: {
          statuses: { type: 'array', items: { type: 'string' }, description: 'topic|take|brief|article|review|ready|scheduled|published|complete' },
          limit:    { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ packages: await listPackages(env, input || {}) }),
  },

  read_hottake_package: {
    def: {
      name: 'read_hottake_package',
      description: 'Read one Hot Takes package by id: its full topic/take/brief/article/review state, its social legs, and the single next action the operator should take.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { found: false };
      const posts = await listPosts(env, input.id);
      return { found: true, package: pkg, posts, next_action: computeNextAction(pkg, posts, releaseChannels(env)) };
    },
  },

  list_topic_feed: {
    def: {
      name: 'list_topic_feed',
      description: 'The live feed of topics worth a company response — synthesized hot topics, scored industry signals and actionable digest items merged, deduped and newest-first. Read-only; pin a card with pin_hottake_topic to start a package. Pass history:true (with a bigger limit) or q to browse and search everything retained.',
      input_schema: {
        type: 'object',
        properties: {
          limit:   { type: 'number' },
          offset:  { type: 'number' },
          q:       { type: 'string', description: 'search across all retained cards' },
          history: { type: 'boolean', description: 'widen the window past today\'s feed' },
        },
        required: [],
      },
    },
    run: async (env, input) => topicsOfTheDay(env, input || {}),
  },

  pin_hottake_topic: {
    def: {
      name: 'pin_hottake_topic',
      description: 'Pin a topic into Selected Topics as a publication package at status "topic". Pass a feed card\'s fields (origin, origin_ref, title, summary, source_name, source_url) to pin it, or just a title to create one by hand. Idempotent by origin_ref, so pinning the same card twice never duplicates.',
      input_schema: {
        type: 'object',
        properties: {
          title:          { type: 'string' },
          summary:        { type: 'string' },
          why_it_matters: { type: 'string' },
          origin:         { type: 'string', description: 'osint_topic|osint_signal|digest|link|manual' },
          origin_ref:     { type: 'string', description: 'the card\'s stable id — what makes pinning idempotent' },
          source_name:    { type: 'string' },
          source_url:     { type: 'string' },
          published_at:   { type: 'number', description: 'ms epoch' },
          multi_source:   { type: 'array', items: { type: 'object' } },
          note:           { type: 'string', description: 'a quick operator note (stored as company_notes)' },
        },
        required: ['title'],
      },
    },
    run: async (env, input) => {
      // `url` is accepted as an alias so a link-extraction step upstream can
      // thread its source through without renaming anything.
      const sourceUrl = input.source_url || input.url || null;
      return {
        package: await pinTopic(env, {
          origin: input.origin || (sourceUrl ? 'link' : 'manual'),
          origin_ref: input.origin_ref || sourceUrl || null,
          title: input.title,
          summary: input.summary ?? null,
          why_it_matters: input.why_it_matters ?? null,
          source_name: input.source_name || (sourceUrl ? hostOf(sourceUrl) : null),
          source_url: sourceUrl,
          published_at: input.published_at ?? null,
          multi_source: input.multi_source ?? null,
          company_notes: input.note ?? null,
        }, input.actor || 'operator'),
      };
    },
  },

  save_hottake_package: {
    def: {
      name: 'save_hottake_package',
      description: 'Patch one Hot Takes package — the topic fields, the take and its four inputs, the headline, notes, pinned, or the status. Pass only the keys to change. status:"dismissed" retires the package (reversible by patching the status back).',
      input_schema: {
        type: 'object',
        properties: {
          id:             { type: 'string' },
          title:          { type: 'string' }, summary: { type: 'string' }, why_it_matters: { type: 'string' },
          take:           { type: 'string' }, believe: { type: 'string' }, misunderstood: { type: 'string' },
          who_cares:      { type: 'string' }, reader_action: { type: 'string' }, headline: { type: 'string' },
          company_notes:  { type: 'string' }, author_notes: { type: 'string' },
          status:         { type: 'string' }, pinned: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const { id, actor, ...patch } = input || {};
      // Dismissal is its own transition on the bus, not a status write.
      if (patch.status === 'dismissed') return { package: await dismissPackage(env, id, actor || 'operator') };
      return { package: await patchPackage(env, id, patch, actor || 'operator') };
    },
  },

  adopt_blog_draft: {
    def: {
      name: 'adopt_blog_draft',
      description: 'Adopt an existing blog post into the Hot Takes release pipeline by slug, creating the package it needs to be scheduled and distributed. Idempotent — a slug that already has a package returns it unchanged.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => ({ package: await ensurePackageForSlug(env, input.slug, input.actor || 'operator') }),
  },

  extract_article_meta: {
    def: {
      name: 'extract_article_meta',
      description: 'Read an already-fetched article page and pull out its title, publication, plain-language summary, why-it-matters and publish date. Use after fetching a pasted URL, to turn it into a topic card.',
      input_schema: {
        type: 'object',
        properties: {
          url:  { type: 'string' },
          text: { type: 'string', description: 'the page text (HTML is stripped if you pass markup)' },
        },
        required: ['url'],
      },
    },
    run: async (env, input) => {
      const url = String(input.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };
      // `content` is what the shared page-fetch step emits; `text` is the
      // direct-call name. Same thing.
      const text = stripHtml(input.text ?? input.content ?? '').slice(0, 8000);
      const host = hostOf(url);

      let meta = {};
      if (text) {
        const system = await loadLinkExtractPrompt(env);
        meta = await callGateway(env, 'llm', 'json', {
          system,
          prompt: `URL: ${url}\n\nPAGE TEXT:\n${text}`,
          max_tokens: 700,
        }) || {};
      }
      const publishedAt = meta.published_at_iso ? (Date.parse(meta.published_at_iso) || null) : null;
      // The threading keys (origin/origin_ref/source_url/published_at) are what
      // the pinning step consumes — a page that extracts to nothing still pins
      // as a usable card off the URL alone.
      return {
        title: meta.title || host,
        source_name: meta.source_name || host,
        summary: meta.summary || null,
        why_it_matters: meta.why_it_matters || null,
        published_at_iso: meta.published_at_iso || null,
        published_at: publishedAt,
        source_url: url,
        origin: 'link',
        origin_ref: url,
      };
    },
  },

  // ── the editorial spine ─────────────────────────────────────
  draft_hottake_take: {
    def: {
      name: 'draft_hottake_take',
      description: 'Propose the company\'s take on a package\'s topic: a specific, defensible argument (never a neutral summary) plus what the company believes, what is commonly misunderstood, who should care, and what the reader should do differently. Saves it on the package for the operator to confirm or rewrite.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      const [pov, playbook, prior] = await Promise.all([
        loadPovLibrary(env), loadPlaybook(env),
        listPackages(env, { statuses: ['published', 'complete'], limit: 6 }),
      ]);
      const priorTakes = prior.filter((p) => p.take).map((p) => `- ${p.title}: ${p.take}`).join('\n');
      const out = await callGateway(env, 'llm', 'json', {
        system: `${playbook.body}\n\nReturn ONLY JSON: {"take","believe","misunderstood","who_cares","reader_action"}. take = the proposed argument, 1-3 sentences, specific and opinionated. The other four are one sentence each.`,
        prompt: `## Point-of-View Library\n${pov.body}\n\n${priorTakes ? `## Prior published takes (stay consistent, don't repeat)\n${priorTakes}\n\n` : ''}## The topic\n${topicContext(pkg)}`,
        max_tokens: 900,
        heavy: true,
      });
      if (!out?.take) return { error: 'drafter returned no take' };
      return {
        package: await patchPackage(env, input.id, {
          take: out.take, believe: out.believe || null, misunderstood: out.misunderstood || null,
          who_cares: out.who_cares || null, reader_action: out.reader_action || null,
          status: 'take',
        }, input.actor || 'hot-takes'),
      };
    },
  },

  build_hottake_brief: {
    def: {
      name: 'build_hottake_brief',
      description: 'Build the short editorial brief from a package\'s approved take: argument, audience, why-now, 3-5 supporting points, evidence, likely objections, conclusion, and the publication pattern that fits. Run before the article is written so the operator can adjust cheaply.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      if (!pkg.take) return { error: 'no take yet — run draft_hottake_take first' };
      const [playbook, patterns] = await Promise.all([loadPlaybook(env), loadPatterns(env)]);
      const out = await callGateway(env, 'llm', 'json', {
        system: `${playbook.body}\n\nReturn ONLY JSON: {"argument","audience","why_now","points":[3-5 strings],"evidence":[strings],"objections":[strings],"conclusion","pattern"}. pattern = which publication pattern fits (name it). Points must each ADVANCE the argument, not restate it.`,
        prompt: `## Publication patterns\n${patterns.body}\n\n## The approved take\n${pkg.take}\nBelieve: ${pkg.believe || ''}\nMisunderstood: ${pkg.misunderstood || ''}\nWho cares: ${pkg.who_cares || ''}\nReader action: ${pkg.reader_action || ''}\n\n## The topic\n${topicContext(pkg)}`,
        max_tokens: 1200,
        heavy: true,
      });
      if (!out?.argument || !Array.isArray(out.points)) return { error: 'brief builder returned no argument/points' };
      return { package: await patchPackage(env, input.id, { brief: out, status: 'brief' }, input.actor || 'hot-takes') };
    },
  },

  build_hottake_seed: {
    def: {
      name: 'build_hottake_seed',
      description: 'Assemble the article seed for a package: deterministic prose built from the approved take, the brief and the playbook\'s Article instruction. No model, no writes — hand the result straight to the article writer.',
      input_schema: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          voice: { type: 'string', enum: ['lev', 'house'], description: 'default lev' },
        },
        required: ['id'],
      },
    },
    // title/body/voice are exactly the keys the shared article writer reads.
    run: async (env, input) => ({ ...(await buildArticleSeed(env, input.id)), voice: input.voice || 'lev' }),
  },

  link_hottake_article: {
    def: {
      name: 'link_hottake_article',
      description: 'Link a written blog draft to its Hot Takes package by slug — stores the slug, headline and intro and moves the package to review. Also emits the article\'s title, url, excerpt, tags, body and cover so the distribution drafters can use them.',
      input_schema: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'package id' },
          slug:    { type: 'string', description: 'blog post slug (blog_slug is accepted too)' },
          title:   { type: 'string', description: 'defaults to the saved post\'s title' },
          excerpt: { type: 'string', description: 'defaults to the saved post\'s excerpt' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const slug = input.slug || input.blog_slug;
      if (!slug) return { error: 'pass slug (or blog_slug)' };
      const pkg = await linkArticle(env, input.id, { slug, title: input.title, excerpt: input.excerpt }, input.actor || 'operator');
      const view = await articleView(env, input.id);
      const a = view?.article || {};
      return {
        package: pkg,
        package_id: input.id,
        blog_slug: slug,
        slug,
        title: a.title || pkg.headline || pkg.title,
        url: blogUrl(slug),
        excerpt: a.excerpt || pkg.intro || null,
        tags: a.tags || [],
        body_html: a.body || '',
        image_url: a.featured_image_url || null,
      };
    },
  },

  scan_hottake_article: {
    def: {
      name: 'scan_hottake_article',
      description: 'Scan a package\'s written article for review: pull out the factual claims that matter (typed directly_supported / company_experience / opinion / unsupported, each confirmed or needing confirmation) and flag concrete quality weaknesses. Decision support for the operator — it never approves anything.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const view = await articleView(env, input.id);
      if (!view?.article?.body) return { error: 'no article yet — write it first' };
      const rules = await loadQualityRules(env);
      const plain = stripHtml(view.article.body).slice(0, 16000);
      const out = await callGateway(env, 'llm', 'json', {
        system: `You are an editorial fact-and-quality reviewer. Apply these rules:\n${rules.body}\n\nReturn ONLY JSON: {"claims":[{"text","support":"directly_supported|company_experience|opinion|unsupported","source","status":"needs_confirmation|confirmed"}],"quality_flags":[{"kind","section","note","severity":"high|medium|low"}]}. claims = the 4-10 factual statements that MATTER to the argument (quote them short). status = needs_confirmation when support is unsupported or shaky, else confirmed. quality_flags = concrete weaknesses only; empty array if genuinely clean.`,
        prompt: `## Article: ${view.article.title}\n\n${plain}\n\n## The intended argument\n${view.package.take || ''}\n\n## Source under discussion\n${view.package.source_name || ''} ${view.package.source_url || ''}`,
        max_tokens: 1600,
        heavy: true,
      });
      const review = {
        claims: Array.isArray(out?.claims) ? out.claims : [],
        // Flags land unresolved: resolving one is an operator act, never the
        // scanner's.
        quality_flags: (Array.isArray(out?.quality_flags) ? out.quality_flags : []).map((f) => ({ ...f, resolved: false })),
        scanned_at: Date.now(),
      };
      const pkg = await patchPackage(env, input.id, { review, status: 'review' }, input.actor || 'hot-takes');
      return {
        package: pkg,
        open_claims: review.claims.filter((c) => c.status === 'needs_confirmation').length,
        flags: review.quality_flags.length,
      };
    },
  },

  // ── release scheduling ──────────────────────────────────────
  schedule_hottake_release: {
    def: {
      name: 'schedule_hottake_release',
      description: 'Schedule a publication: the website publish plus a time for each LinkedIn leg. Pass the package id or a blog slug (a plain draft is adopted automatically). Times are ms epochs; anything omitted takes the recommended offset from the hottakes-timing note, and a reschedule preserves each leg\'s current gap from the publish.',
      input_schema: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'package id' },
          slug:        { type: 'string', description: 'blog slug — used when there is no package yet' },
          website_at:  { type: 'number', description: 'ms epoch for the website publish' },
          company_at:  { type: 'number' },
          personal_at: { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const id = input.id || (input.slug ? (await ensurePackageForSlug(env, input.slug, input.actor || 'operator')).id : null);
      if (!id) return { error: 'pass id or slug' };
      // Booking a time is NOT approving a post: the lib deliberately leaves each
      // leg in draft/ready, so only an explicit per-post approval can promote it
      // to 'scheduled' (the state the due-scan fires).
      return scheduleRelease(env, id, input || {}, input.actor || 'operator');
    },
  },

  cancel_hottake_schedule: {
    def: {
      name: 'cancel_hottake_schedule',
      description: 'Cancel a scheduled publication by package id or blog slug: the package returns to ready, queued legs go back to ready or draft with their times cleared, and the calendar entry is marked cancelled. Nothing is deleted.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' }, slug: { type: 'string' } },
        required: [],
      },
    },
    run: async (env, input) => {
      // Lookup only — cancelling must never CREATE a package for the slug.
      const pkg = input.id ? await readPackage(env, input.id) : await findPackageBySlug(env, input.slug);
      if (!pkg) return { error: 'no package found — nothing is scheduled for this publication' };
      return cancelSchedule(env, pkg.id, input.actor || 'operator');
    },
  },

  // ── heartbeat: the feed sources ─────────────────────────────
  list_heartbeat_sources: {
    def: {
      name: 'list_heartbeat_sources',
      description: 'List the industry-awareness feed sources — the RSS feeds and Google News topic queries the hourly sweep ingests, with each one\'s theme, enabled state and last fetch result.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ sources: await listHeartbeatSources(env) }),
  },

  save_heartbeat_source: {
    def: {
      name: 'save_heartbeat_source',
      description: 'Add or edit one feed source. New RSS feed: {kind:"rss", name, url}. New Google News topic: {kind:"gnews", name, query} (the feed URL is built from the query). Edit: pass id plus the fields to change; enabled:false pauses a feed without losing its signals.',
      input_schema: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'omit to create' },
          kind:    { type: 'string', enum: ['rss', 'gnews'] },
          name:    { type: 'string' },
          url:     { type: 'string' },
          query:   { type: 'string', description: 'gnews only — plain search query' },
          theme:   { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ source: await writeHeartbeatSource(env, input || {}) }),
  },

  delete_heartbeat_source: {
    def: {
      name: 'delete_heartbeat_source',
      description: 'Delete one feed source by id; its already-ingested signals are kept. Prefer save_heartbeat_source with enabled:false to pause a feed reversibly.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => deleteHeartbeatSource(env, input.id),
  },

  // ── first run: what should this install watch at all? ───────
  // A fresh install watches the feeds that shipped with it, which is somebody
  // else's industry. These five turn "what do you care about" into real
  // osint_sources rows — and every feed offered has been fetched and parsed
  // first, because a proposal that 404s is worse than no proposal.
  read_hottakes_setup: {
    def: {
      name: 'read_hottakes_setup',
      description: 'Whether the Hot Takes module has been set up on this install, and what it has to work with: which of company-profile / icp / pov-library / heartbeat-priorities carry the operator\'s own material versus the shipped placeholders, plus how many sources, signals and hot topics exist. Read this before offering to configure the feed.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => readSetupState(env),
  },

  propose_heartbeat_sources: {
    def: {
      name: 'propose_heartbeat_sources',
      description: 'Scout the feeds and news queries this operator should watch, and VALIDATE every one by fetching it before offering it — only sources that really parsed come back, each with the item count seen. Reads what onboarding learned; returns reason:"no_material" (and proposes nothing) when the knowledge notes are still the shipped placeholders and no hint is given. Read-only: nothing is saved until save_hottakes_setup.',
      input_schema: {
        type: 'object',
        properties: {
          hint: { type: 'string', description: 'one line from the operator about what they do and who it is for — required when the knowledge notes are still generic' },
        },
        required: [],
      },
    },
    // Batch by nature: one scouting judgement, then N bounded fetches to prove
    // each candidate. Splitting it per candidate would re-ask the model N times
    // for the same list.
    run: async (env, input) => proposeSources(env, { hint: input?.hint || '', actor: input?.actor || 'operator' }),
  },

  validate_feed_url: {
    def: {
      name: 'validate_feed_url',
      description: 'Fetch one URL and prove it is a working RSS/Atom feed, using the same parser the hourly ingest uses. Returns {ok, items, latest_at, sample} or the reason it failed. Use before adding any feed a human or a model handed you.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    run: async (env, input) => validateFeed(env, { url: input.url }),
  },

  save_hottakes_setup: {
    def: {
      name: 'save_hottakes_setup',
      description: 'Commit the Hot Takes first run: add the chosen feed sources, add brand/competitor listeners, write the operator\'s own words into the heartbeat-priorities note, and record that this module has been set up so its first-run panel never opens unattended again. Everything is optional — saving with nothing chosen still closes the first run and leaves a working, empty module.',
      input_schema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            description: 'feeds to watch: {kind:"rss", name, url} or {kind:"gnews", name, query}',
            items: { type: 'object' },
          },
          targets: {
            type: 'array',
            description: 'names to listen for: {name, domain, kind:"brand"|"competitor"}',
            items: { type: 'object' },
          },
          watch: {
            type: 'object',
            description: 'the operator\'s own words: {topics:[], keywords:[], ignore:[], note}',
          },
          ran_ingest: { type: 'boolean', description: 'record that the first ingest was run as part of setup' },
        },
        required: [],
      },
    },
    run: async (env, input) => applySetup(env, {
      sources: input?.sources || [],
      targets: input?.targets || [],
      watch: input?.watch || null,
      ran_ingest: Boolean(input?.ran_ingest),
      actor: input?.actor || 'operator',
    }),
  },

  skip_hottakes_setup: {
    def: {
      name: 'skip_hottakes_setup',
      description: 'Record that the operator declined the Hot Takes first run. The module keeps working (empty, not broken) and the panel never opens on its own again. Pass reopen:true to undo — the setup can then be started again deliberately from Approved Sources.',
      input_schema: {
        type: 'object',
        properties: { reopen: { type: 'boolean', description: 'true = clear the decision so setup can be run again' } },
        required: [],
      },
    },
    run: async (env, input) => (input?.reopen
      ? reopenSetup(env, { actor: input?.actor || 'operator' })
      : skipSetup(env, { actor: input?.actor || 'operator' })),
  },

  // ── heartbeat: signals ──────────────────────────────────────
  ingest_signals: {
    def: {
      name: 'ingest_signals',
      description: 'Pull every enabled feed and insert the items we have not seen before as unscored signals. The read half of the awareness sweep — it never judges anything.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    // Batch by nature: one pass over N feeds, deduped by URL inside the lib.
    run: async (env) => {
      const r = await ingestHeartbeat(env);
      return { inserted: r.inserted, per_source: r.perSource };
    },
  },

  score_signals: {
    def: {
      name: 'score_signals',
      description: 'Score the newly ingested signals for relevance and content value against the heartbeat-priorities rubric, and record the angle we would take. One batch judging pass; run it after ingest_signals.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'how many new signals to score (default 30)' } },
        required: [],
      },
    },
    // One LLM call scores the whole batch — splitting it per signal would cost
    // N calls for the same judgement, so the loop stays inside the lib.
    run: async (env, input) => scoreNewSignals(env, { limit: input?.limit || 30 }),
  },

  enrich_signals: {
    def: {
      name: 'enrich_signals',
      description: 'Re-score the high-relevance signals from their full article text instead of their headline, caching the text as it goes. Bounded per run; use when the titles alone are not enough to judge what is worth writing about.',
      input_schema: {
        type: 'object',
        properties: {
          limit:         { type: 'number' },
          min_relevance: { type: 'number', description: 'defaults to the heartbeat-priorities gate' },
        },
        required: [],
      },
    },
    // Fetch-then-rejudge per signal, bounded: the pairing is the guarantee (a
    // fetched article is always scored from its own text, never a stale title).
    run: async (env, input) => enrichSignals(env, {
      limit: input?.limit || 12,
      minRelevance: input?.min_relevance ?? null,
    }),
  },

  list_signals: {
    def: {
      name: 'list_signals',
      description: 'List recent scored industry signals — real news and blog items with a content score (how write-worthy) and a suggested angle. Use to find content opportunities or answer "what is new in X".',
      input_schema: {
        type: 'object',
        properties: {
          min_content: { type: 'number', description: 'minimum content score 0-100 (default 55)' },
          days:        { type: 'number', description: 'lookback window (default 7)' },
          q:           { type: 'string' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const sigs = await topSignals(env, {
        days: input?.days || 7,
        minContent: input?.min_content ?? 55,
        limit: 20,
        q: input?.q || '',
      });
      return {
        signals: sigs.map((s) => ({
          id: s.id, title: s.title, source: s.source_name, theme: s.theme,
          content_score: s.content_score, formats: s.formats, angle: s.suggested_angle, url: s.url,
        })),
      };
    },
  },

  read_signal: {
    def: {
      name: 'read_signal',
      description: 'Read the full article behind one signal, not just its headline (fetched and cached on first read). Use before reacting to a piece of news, and as the first step of turning a signal into an article — it also returns the question, notes and expert context that seed one.',
      input_schema: { type: 'object', properties: { signal_id: { type: 'string' } }, required: ['signal_id'] },
    },
    run: async (env, input) => {
      const sig = await readSignalContent(env, input.signal_id);
      if (!sig) return { ok: false, error: 'signal not found' };
      // The seed keys (question/notes/priority/expert_context) are deterministic
      // field selection done in the lib — they exist so the question-writing
      // step downstream reads them straight off the context.
      const seed = signalQuestionSeed(sig);
      return {
        ok: !!sig.full_text,
        signal_id: sig.id,
        title: sig.title,
        source: sig.source_name,
        url: sig.url,
        summary: sig.summary || null,
        angle: sig.suggested_angle || null,
        content: sig.full_text || null,
        ...seed,
        ...(sig.full_text ? {} : { error: `couldn't fetch the article (paywall, JS-only, or blocked). URL: ${sig.url}` }),
      };
    },
  },

  save_signal: {
    def: {
      name: 'save_signal',
      description: 'Patch one signal\'s status: "actioned" once it has produced an article or post (so it is never suggested again), "dismissed" when the operator waves it off.',
      input_schema: {
        type: 'object',
        properties: {
          signal_id: { type: 'string' },
          status:    { type: 'string', enum: ['new', 'scored', 'actioned', 'dismissed'] },
        },
        required: ['signal_id', 'status'],
      },
    },
    run: async (env, input) => ({ signal: await patchSignal(env, input.signal_id, { status: input.status }) }),
  },

  // ── heartbeat: synthesis ────────────────────────────────────
  synthesize_pulse: {
    def: {
      name: 'synthesize_pulse',
      description: 'Rebuild the industry-pulse knowledge note from this week\'s strongest signals — what is happening in our world right now and what we could do about it. Writes the note; read it back with read_industry_pulse.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const pulse = await synthesizePulse(env);
      return { ok: !!pulse, pulse: pulse || null };
    },
  },

  read_industry_pulse: {
    def: {
      name: 'read_industry_pulse',
      description: 'Read the current industry pulse — the synthesized awareness note plus the top scored signals behind it. Pull this into any strategic conversation (positioning, campaigns, client calls, content) where current external context would sharpen the answer.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const [pulse, signals] = await Promise.all([
        readPulse(env),
        topSignals(env, { days: 7, minContent: 60, limit: 8 }),
      ]);
      return {
        pulse: pulse || null,
        top_signals: signals.map((s) => ({
          id: s.id, title: s.title, source: s.source_name,
          content_score: s.content_score, angle: s.suggested_angle, url: s.url,
        })),
      };
    },
  },

  synthesize_hot_topics: {
    def: {
      name: 'synthesize_hot_topics',
      description: 'Cluster the strongest scored signals into a handful of sharp hot topics, each with a thesis, a why-now and our angle. This is the layer the topic feed and the morning digest lead with.',
      input_schema: {
        type: 'object',
        properties: {
          days:        { type: 'number', description: 'signal lookback (default 10)' },
          min_content: { type: 'number', description: 'defaults to the heartbeat-priorities gate' },
        },
        required: [],
      },
    },
    run: async (env, input) => synthesizeHotTopics(env, {
      days: input?.days || 10,
      minContent: input?.min_content ?? null,
    }),
  },

  list_hot_topics: {
    def: {
      name: 'list_hot_topics',
      description: 'List the current synthesized hot topics — blog-grade angles on what is happening now, each with a thesis, why-now and source links. Use when asked "what should we write about" or "what is hot".',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number' }, days: { type: 'number' }, q: { type: 'string' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const topics = await topHotTopics(env, {
        limit: input?.limit || 6,
        days: input?.days || 3,
        q: input?.q || '',
      });
      return {
        topics: topics.map((t) => ({
          id: t.id, title: t.title, thesis: t.thesis, why_now: t.why_now,
          angle: t.angle, format: t.format, heat: t.heat, sources: t.sources,
        })),
      };
    },
  },

  generate_digest: {
    def: {
      name: 'generate_digest',
      description: 'Regenerate the morning digest from every enabled channel: prune what has gone stale, pull each channel, dedupe against what is already there. A step in the hourly awareness sweep — read the result with the digest listing tools.',
      input_schema: {
        type: 'object',
        properties: { since_ms: { type: 'number', description: 'lookback window in ms (default 24h)' } },
        required: [],
      },
    },
    // Channel fan-out with per-channel error capture lives in the lib: one
    // flaky source must never cost the whole brief.
    run: async (env, input) => {
      const r = await generateDigest(env, { since_ms: input?.since_ms || 86_400_000 });
      return { generated: r.generated, pruned: r.pruned, per_source: r.per_source };
    },
  },

  // ── OSINT: listeners, targets, mentions ─────────────────────
  list_osint_listeners: {
    def: {
      name: 'list_osint_listeners',
      description: 'List the scraper engines (hn, reddit, stackoverflow, github, appstore, website, duckduckgo) with their enabled state, cadence, last run and lifetime totals. Listeners are the HOW of monitoring; targets are the WHAT.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ listeners: await listOsintListeners(env) }),
  },

  save_osint_listener: {
    def: {
      name: 'save_osint_listener',
      description: 'Enable, disable or re-cadence one scraper engine. Use for "turn on the github listener", "disable stackoverflow", "switch reddit to daily".',
      input_schema: {
        type: 'object',
        properties: {
          source:  { type: 'string', enum: OSINT_SOURCES },
          enabled: { type: 'boolean' },
          cadence: { type: 'string', enum: ['manual', 'daily', 'hourly'] },
          notes:   { type: 'string' },
        },
        required: ['source'],
      },
    },
    run: async (env, input) => ({ listener: await patchOsintListener(env, input.source, input) }),
  },

  list_osint_targets: {
    def: {
      name: 'list_osint_targets',
      description: 'List the brands and companies we monitor, each with its domain, App Store id and mention rollups. Call before scraping or reading mentions so you know which target id to pass.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ targets: await listOsintTargets(env) }),
  },

  read_osint_target: {
    def: {
      name: 'read_osint_target',
      description: 'Read one monitored target by id.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const target = await readOsintTarget(env, input.id);
      return target ? { found: true, target } : { found: false };
    },
  },

  save_osint_target: {
    def: {
      name: 'save_osint_target',
      description: 'Create or update a monitored target. Use for "monitor Acme", "also watch acme.io for them", "add their App Store id". Omit id to create.',
      input_schema: {
        type: 'object',
        properties: {
          id:     { type: 'string', description: 'omit to create' },
          name:   { type: 'string' },
          domain: { type: 'string' },
          app_id: { type: 'string', description: 'Apple App Store id, for the appstore listener' },
          notes:  { type: 'string' },
        },
        required: ['name'],
      },
    },
    run: async (env, input) => ({ target: await writeOsintTarget(env, { ...input, updated_by: input.actor || 'nyo' }) }),
  },

  delete_osint_target: {
    def: {
      name: 'delete_osint_target',
      description: 'Remove one monitored target and its mentions. Use sparingly — prefer leaving a stale target in place and simply not scraping it.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => { await deleteOsintTarget(env, input.id); return { ok: true, id: input.id }; },
  },

  scrape_osint_targets: {
    def: {
      name: 'scrape_osint_targets',
      description: 'Run the enabled listeners and harvest fresh mentions. Pass an id to scrape one target now; omit it to sweep the targets that have gone stale, bounded by stale_after_ms and max_targets. Slow — each engine has its own throttle.',
      input_schema: {
        type: 'object',
        properties: {
          id:             { type: 'string', description: 'one target; omit for the stale sweep' },
          sources:        { type: 'array', items: { type: 'string', enum: OSINT_SOURCES }, description: 'override which engines run, even disabled ones' },
          stale_after_ms: { type: 'number', description: 'sweep only: re-scrape targets untouched for longer than this' },
          max_targets:    { type: 'number', description: 'sweep only: cap on targets per run (overflow defers, oldest first)' },
        },
        required: [],
      },
    },
    // The per-target loop and its per-source error capture stay in the lib: a
    // flaky engine must degrade to a recorded error, never a failed sweep.
    run: async (env, input) => {
      const perSource = (ran) => {
        const acc = new Map();
        for (const t of ran) {
          for (const r of (t.results || [])) {
            const cur = acc.get(r.source) || { source: r.source, count: 0, errors: 0 };
            cur.count += r.count || 0;
            if (r.error) cur.errors += 1;
            acc.set(r.source, cur);
          }
        }
        return [...acc.values()];
      };
      if (input?.id) {
        const r = await scrapeTarget(env, input.id, { sources: input.sources || null });
        const ran = [{ id: r.target_id, total: r.total, results: r.results }];
        return { ran, skipped: [], per_source: perSource(ran) };
      }
      const r = await runOsintCron(env, {
        actor: input?.actor || 'operator',
        ...(input?.stale_after_ms ? { staleAfterMs: input.stale_after_ms } : {}),
        ...(input?.max_targets ? { maxTargets: input.max_targets } : {}),
      });
      // The early return ("no listeners enabled") reports skipped as a string.
      const ran = Array.isArray(r.ran) ? r.ran : [];
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      return {
        ran,
        skipped,
        per_source: perSource(ran),
        ...(typeof r.skipped === 'string' ? { note: r.skipped } : {}),
      };
    },
  },

  list_osint_mentions: {
    def: {
      name: 'list_osint_mentions',
      description: 'List the mentions and conversations the listeners harvested, filtered by target and/or source. Use to answer "what are people saying about X this week" or to mine quotes and sentiment.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string' },
          source:    { type: 'string', enum: OSINT_SOURCES },
          limit:     { type: 'number', description: 'default 200' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ mentions: await listMentions(env, input || {}) }),
  },
};
