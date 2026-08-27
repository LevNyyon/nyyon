// social — every social post this system makes, in one family.
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
//
// Migration 0062 folded hot_take_posts into social_posts, so there is now ONE
// queue and one set of verbs behind it. A blog fan-out row carries a blog_slug,
// a Hot Takes release leg carries a package_id (and no blog_slug until its
// article exists), an ad-hoc post carries a synthetic standalone slug. Same
// draft → save → edit → approve → push path for all three.
//
// The release guarantee (lib/social-posts.js owns the mechanics):
//   approve_social_post takes an ATOMIC claim and opens the outbox row;
//   push_social_post refuses to send anything that is not holding that claim.
//   A crash in between leaves the row 'claimed' — visible, never auto-retried.
//   Nothing here publishes on its own: a draft only moves because an operator
//   (or a workflow an operator started) approved it.
//
// Workflow steps hand a tool the whole shared context, so every run() picks the
// exact keys it needs off `input` rather than forwarding it wholesale.

import { callGateway } from '../gateways/index.js';
import { logEvent } from '../lib/db.js';
import {
  SOCIAL_CHANNELS, articleFromBlogPost, blogPostUrl, clearUnpostedSocialPosts,
  claimSocialPostSend, deleteSocialPost, draftSocialPostText, hasSocialPostFor,
  listSocialPosts, patchSocialPost, readSocialPost, sendClaimedSocialPost,
  sendGate, upsertSocialPost,
} from '../lib/social-posts.js';
import { draftCardSlots, renderSocialCard, saveSocialCardRecord, SOCIAL_CARD_TEMPLATES } from '../lib/social-cards.js';
import { uid } from '../lib/util.js';

// The article a draft is written from. Explicit fields win; otherwise we read
// the blog row read_blog_post put on the context, or the `article` a previous
// draft step already resolved (so step 4 of a fan-out does not depend on a
// `post` key that step 3's save has since overwritten).
function resolveArticle(input) {
  const fromPost = input?.post && !input.post.channel ? articleFromBlogPost(input.post) : null;
  const base = input?.article || fromPost || {};
  const slug = input?.slug || base.blog_slug || null;
  return {
    blog_slug: slug,
    title:     input?.title     ?? base.title     ?? '',
    url:       input?.url       ?? base.url       ?? (slug ? blogPostUrl(slug) : ''),
    excerpt:   input?.excerpt   ?? base.excerpt   ?? null,
    tags:      input?.tags      ?? base.tags      ?? null,
    body_html: input?.body_html ?? base.body_html ?? '',
    image_url: input?.image_url ?? base.image_url ?? null,
  };
}

export const tools = {
  // ── queue: read ─────────────────────────────────────────────
  list_social_posts: {
    def: {
      name: 'list_social_posts',
      description: 'List queued social posts — id, channel, status (draft | claimed | posted | failed | skipped), source article (blog_slug/blog_title), package_id for Hot Takes release legs, and the content. Filter by status, blog slug, or package. Use this to find the post the operator wants to work on.',
      input_schema: {
        type: 'object',
        properties: {
          status:     { type: 'string', description: 'draft | ready | scheduled | claimed | posted | failed | skipped | not_planned' },
          slug:       { type: 'string', description: 'source blog post slug' },
          package_id: { type: 'string', description: 'Hot Takes package id — its release legs' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({
      posts: await listSocialPosts(env, {
        status: input?.status || null, slug: input?.slug || null, package_id: input?.package_id || null,
      }),
    }),
  },

  read_social_post: {
    def: {
      name: 'read_social_post',
      description: 'Read one social post by id — channel, status, source article, package link, and the full current text.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const post = await readSocialPost(env, input?.id);
      return post ? { found: true, post } : { found: false };
    },
  },

  list_social_integrations: {
    def: {
      name: 'list_social_integrations',
      description: 'List the social CONNECTIONS posts can go out through and whether each is configured: linkedin-company (the Nyyon page, the default for LinkedIn), linkedin-personal (the operator\'s personal profile, opt-in), facebook-company. Call this before drafting or approving so you name a channel that actually works.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ connections: await callGateway(env, 'social', 'connections', {}) }),
  },

  // ── queue: write ────────────────────────────────────────────
  draft_social_post: {
    def: {
      name: 'draft_social_post',
      description: "Write ONE channel's post text in that channel's voice (brand for the company pages, the operator's personal voice for linkedin-personal), under the operator's style rules. Pass source_kind 'blog' (default) to promote one of our articles, 'news' to react to someone else's item with our point of view. Drafts only — nothing is saved or published. With a slug, it skips a channel that already has a post unless force is true.",
      input_schema: {
        type: 'object',
        properties: {
          channel:     { type: 'string', enum: SOCIAL_CHANNELS },
          title:       { type: 'string', description: 'article or news item headline' },
          url:         { type: 'string', description: 'the link the post points at' },
          excerpt:     { type: 'string' },
          tags:        { type: 'array', items: { type: 'string' } },
          body_html:   { type: 'string', description: 'article body for context (HTML or text)' },
          source_kind: { type: 'string', enum: ['blog', 'news'], description: "'blog' promotes our article, 'news' reacts to an industry item" },
          slug:        { type: 'string', description: 'blog slug — fills title/url from the context and enables the already-drafted check' },
          package_id:  { type: 'string', description: 'Hot Takes package — a leg of that release' },
          force:       { type: 'boolean', description: 'redraft even if this channel already has a post' },
        },
        required: ['channel'],
      },
    },
    run: async (env, input) => {
      const channel = input?.channel;
      if (!SOCIAL_CHANNELS.includes(channel)) throw new Error(`channel must be one of: ${SOCIAL_CHANNELS.join(', ')}`);
      const article = resolveArticle(input);
      const packageId = input?.package_id || null;

      // Idempotency, cheapest first: a channel that already has a post is not
      // redrafted (and costs no LLM call) unless the operator forces it. A
      // package leg is always a redraft — save_social_post replaces it in place.
      if (!input?.force && !packageId && article.blog_slug
        && await hasSocialPostFor(env, { slug: article.blog_slug, channel })) {
        return { channel, content: null, skipped: true, reason: 'already drafted for this channel', article };
      }
      if (!article.title || !article.url) {
        return { channel, content: null, skipped: true, reason: 'no title/url to write from', article };
      }

      const content = await draftSocialPostText(env, channel, {
        title:      article.title,
        excerpt:    article.excerpt,
        tags:       article.tags,
        url:        article.url,
        bodyHtml:   article.body_html,
        sourceKind: input?.source_kind === 'news' ? 'news' : 'blog',
      });
      return { channel, content, article, package_id: packageId };
    },
  },

  save_social_post: {
    def: {
      name: 'save_social_post',
      description: "Put one post into the review queue as a 'draft'. NEVER publishes: the operator approves it separately. Pass a slug for a blog fan-out row, a package_id for a Hot Takes release leg (which replaces that leg's previous draft), or neither for a standalone post written with the operator. Returns the row and its id.",
      input_schema: {
        type: 'object',
        properties: {
          channel:    { type: 'string', enum: SOCIAL_CHANNELS },
          content:    { type: 'string', description: 'the full post text' },
          slug:       { type: 'string', description: 'source blog slug — omit for a standalone post' },
          title:      { type: 'string', description: 'label shown in the queue' },
          image_url:  { type: 'string', description: 'the image the post goes out with' },
          package_id: { type: 'string', description: 'Hot Takes package this leg belongs to' },
          notes:      { type: 'string', description: 'operator note kept alongside the draft' },
          force:      { type: 'boolean', description: 'replace the unposted rows for this slug + channel first' },
        },
        required: ['channel', 'content'],
      },
    },
    run: async (env, input) => {
      const channel = input?.channel;
      const content = String(input?.content || '').trim();
      const article = resolveArticle(input);
      const packageId = input?.package_id || null;
      // A skipped draft threads through as content:null — record the skip
      // instead of saving whatever text the previous channel left on the ctx.
      if (!content) return { skipped: true, reason: 'no content to save' };

      const slug = input?.slug || article.blog_slug || (packageId ? null : `standalone:${uid()}`);
      if (input?.force) await clearUnpostedSocialPosts(env, { slug, package_id: packageId, channel });
      else if (!packageId && slug && await hasSocialPostFor(env, { slug, channel })) {
        return { skipped: true, reason: 'this channel already has a post for that source' };
      }

      const post = await upsertSocialPost(env, {
        blog_slug:  slug,
        blog_title: input?.title || article.title || null,
        package_id: packageId,
        channel,
        content,
        image_url:  input?.image_url || article.image_url || null,
        notes:      input?.notes || null,
        actor:      input?.actor || 'nyo',
      });
      return { post, id: post.id };
    },
  },

  edit_social_post: {
    def: {
      name: 'edit_social_post',
      description: 'Replace a queued post\'s text with a full new version — use this while refining a draft with the operator. Pass the whole new text, not a diff. Edits only; it never publishes and never changes the channel.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' }, content: { type: 'string', description: 'the full new post text' } },
        required: ['id', 'content'],
      },
    },
    run: async (env, input) => {
      const post = await patchSocialPost(env, input?.id, { content: input?.content });
      await logEvent(env, { kind: 'social_post_edited', actor: 'operator', payload: { id: input?.id, chars: String(input?.content || '').length } }).catch(() => {});
      return { post };
    },
  },

  delete_social_post: {
    def: {
      name: 'delete_social_post',
      description: 'Delete one social post from the queue by id — a draft the operator does not want, a duplicate, a test row. Irreversible: resolve the exact id with list_social_posts and confirm with the operator first.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      await deleteSocialPost(env, input?.id);
      await logEvent(env, { kind: 'social_post_deleted', actor: 'operator', payload: { id: input?.id } }).catch(() => {});
      return { ok: true, id: input?.id };
    },
  },

  // ── release ─────────────────────────────────────────────────
  approve_social_post: {
    def: {
      name: 'approve_social_post',
      description: 'Approve one draft for release: refuses a post that already went out, resolves the article\'s CURRENT cover over whatever image the row captured at draft time, and opens the outbox send claim that push_social_post requires. This is the operator gate — only run it when the operator has approved this specific post.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const row = await readSocialPost(env, input?.id);
      if (!row) throw new Error('social post not found');

      // Hot Takes legs stay a dry run until the operator flips hottakes.live.
      // Checked BEFORE the claim so a dry run leaves the row exactly as it was.
      const gate = await sendGate(env, row);
      if (gate.gated && !gate.live) {
        await logEvent(env, { kind: 'hottake_dryrun', actor: 'operator', payload: { action: 'approve_social_post', id: row.id, channel: row.channel } }).catch(() => {});
        return {
          id: row.id, channel: row.channel, content: row.content,
          image_url: row.image_url || null, image_title: row.blog_title || '',
          outbox_id: null, dry_run: true,
        };
      }
      return claimSocialPostSend(env, row.id, { actor: input?.actor || 'operator' });
    },
  },

  push_social_post: {
    def: {
      name: 'push_social_post',
      description: 'Send one CLAIMED post through its channel\'s connection and close the claim. Requires the open claim approve_social_post takes: an unclaimed, already-posted, or image-less post is refused rather than sent. Never call this to "retry" on your own — a repeat send is the operator\'s decision.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    // ⚙️ The claim-then-send loop stays inside lib/social-posts.js on purpose:
    // splitting the outbox claim from the gateway call is exactly what would
    // let the same post go out twice. This tool is the decision point, the lib
    // is the atom.
    run: async (env, input) => {
      const row = await readSocialPost(env, input?.id);
      if (!row) throw new Error('social post not found');

      const gate = await sendGate(env, row);
      if (gate.gated && !gate.live) {
        await logEvent(env, {
          kind: 'hottake_dryrun', actor: input?.actor || 'operator',
          payload: { action: 'push_social_post', id: row.id, channel: row.channel, chars: (row.content || '').length, has_image: !!row.image_url },
        }).catch(() => {});
        return {
          ok: true, id: row.id, channel: row.channel, outbox_id: null, dry_run: true,
          would: { action: 'post', channel: row.channel, chars: (row.content || '').length, image_url: row.image_url || null },
        };
      }
      return sendClaimedSocialPost(env, row.id, { actor: input?.actor || 'operator' });
    },
  },

  // ── share cards ─────────────────────────────────────────────
  draft_card: {
    def: {
      name: 'draft_card',
      description: `Pick the share-card template that fits the article and write its slot text (one cheap LLM step). Templates: ${SOCIAL_CARD_TEMPLATES.join(', ')} — split for a contrast, statement for one sharp claim, checklist for criteria, flow for a process. Pass template to force one, or slots to dictate the exact wording and skip the drafting entirely.`,
      input_schema: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: 'article title, or a custom line' },
          excerpt:  { type: 'string' },
          tags:     { type: 'array', items: { type: 'string' } },
          template: { type: 'string', enum: SOCIAL_CARD_TEMPLATES, description: 'force a template; omit to let the drafter pick' },
          slots:    { type: 'object', description: 'exact slot text — skips the drafter; must respect the template char limits' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const article = resolveArticle(input);
      const title = article.title;
      if (!title) throw new Error('draft_card: title required (pass title, or read the blog post first)');
      if (input?.slots && Object.keys(input.slots).length) {
        return { template: input?.template || 'statement', slots: input.slots };
      }
      return draftCardSlots(env, {
        title,
        excerpt:  article.excerpt || '',
        tags:     article.tags || [],
        template: input?.template || null,
      });
    },
  },

  render_card: {
    def: {
      name: 'render_card',
      description: 'Render one share card to a PNG in R2 from a template + its slot text. Code-drawn in the brand (no image model, no cost); the same blog slug and template always overwrite the same object, so re-rendering replaces the card instead of littering the bucket. Returns the public URL.',
      input_schema: {
        type: 'object',
        properties: {
          template:  { type: 'string', enum: SOCIAL_CARD_TEMPLATES },
          slots:     { type: 'object', description: 'slot text for that template' },
          blog_slug: { type: 'string', description: 'names the stored object; omit for a one-off card' },
        },
        required: ['template', 'slots'],
      },
    },
    run: async (env, input) => ({
      card: await renderSocialCard(env, {
        blog_slug: input?.blog_slug || input?.slug || null,
        template:  input?.template,
        slots:     input?.slots,
      }),
    }),
  },

  save_social_card: {
    def: {
      name: 'save_social_card',
      description: 'Record a rendered share card in the social_cards table so it shows up in the card history and can be reused as a post image. Takes the card render_card returned.',
      input_schema: {
        type: 'object',
        properties: {
          card:      { type: 'object', description: 'the {url, key, template, width, height} render_card returned' },
          slots:     { type: 'object', description: 'the slot text the card was rendered from' },
          blog_slug: { type: 'string' },
          actor:     { type: 'string' },
        },
        required: ['card'],
      },
    },
    run: async (env, input) => ({
      ok: true,
      card: await saveSocialCardRecord(env, {
        card:      input?.card,
        blog_slug: input?.blog_slug || input?.slug || null,
        slots:     input?.slots || null,
        actor:     input?.actor || 'nyo',
      }),
    }),
  },

};
