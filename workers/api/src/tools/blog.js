// blog + article engine — the granular tool pool (architecture v2).
//
// One verb on one noun each: read the voice, draft the article, save the draft,
// design the figures, render them, embed them, cover, featured image, publish.
// The chains that used to live inside composeAndSavePost / generateArticleFigures
// are now workflows (workflows/seeds/blog.js) built from these tools.
//
// Two guardrails are load-bearing here and must survive any edit:
//   • save_blog_post NEVER publishes — a draft reaches the public site only through
//     publish_blog_post, which is the operator's approval gate.
//   • claim_aeo_question is the atomic no-duplicate-write gate for the writer.
//
// Every tool returns plain JSON whose keys the NEXT step reads straight off the
// workflow's shared context (blog_slug, title, excerpt, body, specs, figures,
// cover, cover_url, candidates, winner_url).

import {
  listBlogPosts, readBlogPost, deleteBlogPost, patchBlogPost,
  readAeoQuestion, addAeoQuestion, writeAeoQuestion, setAeoVoice,
  markAeoQuestionDrafted, markAeoQuestionPublished, markAeoQuestionFailed,
  recordAeoFeedback,
} from '../lib/db.js';
import {
  readVoiceProfile, draftArticle, saveBlogPost, expandArticle, appendFaqSchema, claimAeoQuestion,
} from '../lib/aeo-writer.js';
import {
  draftFigures, renderFigures, embedFiguresInPost, draftCover, renderCover, setFeaturedImage,
} from '../lib/article-figures.js';
import { draftImageBrief, renderCandidateImages, judgeCandidateImages } from '../lib/blog-images.js';
import {
  generateInterviewQuestions, saveInterviewQuestions, saveInterviewAnswers, formatExpertContext,
} from '../lib/aeo-interview.js';
import { draftTasteProfile } from '../lib/aeo-taste.js';
import { readSuggestionPolicy, draftSuggestionAngles, saveAeoSuggestions } from '../lib/aeo-suggestions.js';
import { publishBlogPostToProd } from '../lib/publish.js';
import { IMAGE_MODELS } from '../lib/image-gateway.js';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const tools = {
  // ── blog posts: read + write ───────────────────────────────
  list_blog_posts: {
    def: {
      name: 'list_blog_posts',
      description: 'List blog post stubs (slug, title, excerpt, published date). Call it before writing so you know what already exists, and pass the result to draft_article so the writer does not repeat an argument the blog already makes.',
      input_schema: {
        type: 'object',
        properties: {
          limit:          { type: 'number', description: 'default 200' },
          published_only: { type: 'boolean', description: 'default true' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({
      posts: await listBlogPosts(env, {
        limit: input?.limit ?? 200,
        publishedOnly: input?.published_only !== false,
      }),
    }),
  },

  read_blog_post: {
    def: {
      name: 'read_blog_post',
      description: 'Read one blog post by slug: title, excerpt, body, tags, published state and featured image. Use it before editing, expanding, re-illustrating or sharing a post.',
      input_schema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'the blog post slug' } },
        required: ['slug'],
      },
    },
    run: async (env, input) => {
      const post = await readBlogPost(env, slugArg(input));
      if (!post) return { found: false };
      return {
        found: true,
        blog_slug: post.slug,
        post,
        title: post.title,
        excerpt: post.excerpt,
        body: post.body,
        tags: post.tags,
      };
    },
  },

  save_blog_post: {
    def: {
      name: 'save_blog_post',
      description: 'Save one drafted article to the blog as a DRAFT. Pass the {article} object a drafter produced; pass a slug too to overwrite that exact post, otherwise a fresh unique slug is minted from the title. This never publishes and never changes an existing post\'s published state — publishing is the operator\'s separate approval.',
      input_schema: {
        type: 'object',
        properties: {
          article: {
            type: 'object',
            description: 'the drafted article: {slug, title, excerpt, body_html, tags}',
          },
          slug:         { type: 'string', description: 'overwrite this exact post instead of minting a new slug' },
          published_at: { type: 'number', description: 'ms epoch — preserves an imported stub\'s original date on a first save' },
          actor:        { type: 'string', description: 'who is saving (default system)' },
        },
        required: ['article'],
      },
    },
    // Only `slug` targets an existing row — never `blog_slug` from the shared
    // context, which a non-blog step (a social post carries one) could have put
    // there and would silently overwrite the wrong article.
    run: async (env, input) => saveBlogPost(env, {
      article:      input.article,
      slug:         input.slug || null,
      published_at: input.published_at ?? null,
      actor:        input.actor || 'nyo',
    }),
  },

  edit_blog_post: {
    def: {
      name: 'edit_blog_post',
      description: 'Patch an existing blog post: only the fields you pass change. Edit the body either by sending a full replacement `body` or by sending `find` + `replace` to swap an exact substring, which is the right tool for a typo, a stat or one sentence.',
      input_schema: {
        type: 'object',
        properties: {
          slug:      { type: 'string', description: 'the post to edit' },
          title:     { type: 'string' },
          excerpt:   { type: 'string' },
          body:      { type: 'string', description: 'full replacement body; use this OR find/replace' },
          find:      { type: 'string', description: 'exact substring in the current body to replace' },
          replace:   { type: 'string', description: 'text to put in place of `find`' },
          tags:      { type: 'array', items: { type: 'string' } },
          published: { type: 'boolean', description: 'publish/unpublish; omit to leave as-is' },
        },
        required: ['slug'],
      },
    },
    run: async (env, input) => {
      const { slug, title, excerpt, body, find, replace, tags, published } = input;
      const existing = await readBlogPost(env, slug);
      if (!existing) return { ok: false, error: `blog post not found: ${slug}` };

      const patch = { updated_by: input.actor || 'nyo' };
      if (title     !== undefined) patch.title     = title;
      if (excerpt   !== undefined) patch.excerpt   = excerpt;
      if (tags      !== undefined) patch.tags      = tags;
      if (published !== undefined) patch.published = published;
      if (body !== undefined) {
        patch.body = body;
      } else if (find !== undefined) {
        const cur = existing.body || '';
        if (!cur.includes(find)) return { ok: false, error: `\`find\` text is not in the body — nothing changed (looked for: "${String(find).slice(0, 60)}…")` };
        patch.body = cur.split(find).join(replace ?? '');
      }

      const post = await patchBlogPost(env, slug, patch);
      return {
        ok: true,
        blog_slug: post.slug,
        post: { slug: post.slug, title: post.title, published: !!post.published },
        note: existing.published
          ? 'Post is published — the edge worker serves the edit within ~60s.'
          : 'Draft updated (not live).',
      };
    },
  },

  delete_blog_post: {
    def: {
      name: 'delete_blog_post',
      description: 'Delete one blog post by slug. Irreversible, and it does not take a live post off the public site by itself. Resolve the exact slug with list_blog_posts and confirm with the operator first.',
      input_schema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    run: async (env, input) => {
      await deleteBlogPost(env, input.slug);
      return { ok: true, slug: input.slug };
    },
  },

  publish_blog_post: {
    def: {
      name: 'publish_blog_post',
      description: 'Publish one blog post live on the public site. Marks it published, verifies the edge worker actually serves it (live=true means confirmed, not queued), pings IndexNow, and logs the attempt to the Outbox. This is the operator\'s approval gate: call it only when they say publish or ship.',
      input_schema: {
        type: 'object',
        properties: {
          slug:   { type: 'string', description: 'the blog post slug to publish' },
          deploy: { type: 'boolean', description: 'also kick the marketing-site rebuild (default true)' },
        },
        required: ['slug'],
      },
    },
    run: async (env, input) => publishBlogPostToProd(env, input.slug, {
      source: input.actor || 'nyo',
      deploy: input.deploy !== false,
    }),
  },

  // ── writing ────────────────────────────────────────────────
  read_voice_profile: {
    def: {
      name: 'read_voice_profile',
      description: 'Read the assembled writing voice: the brand voice doc plus the operator\'s learned editorial taste, and the founder\'s personal voice when voice="personal". Feed the result to draft_article or expand_article so everything is written in house voice.',
      input_schema: {
        type: 'object',
        properties: { voice: { type: 'string', enum: ['house', 'personal'], description: 'house (default) or personal' } },
        required: [],
      },
    },
    run: async (env, input) => readVoiceProfile(env, { voice: input?.voice === 'personal' ? 'personal' : 'house' }),
  },

  draft_article: {
    def: {
      name: 'draft_article',
      description: 'Write one article in house HTML, in a single reasoning step. Give it the topic (title) and, when there is one, the operator\'s raw draft as `body` or their interview as `expert_context`; it follows the AEO playbook, sticks to the existing tag taxonomy, and avoids repeating the posts you pass in. It returns the article and saves nothing.',
      input_schema: {
        type: 'object',
        properties: {
          title:          { type: 'string', description: 'the topic, question or angle to write about' },
          body:           { type: 'string', description: 'the operator\'s hand-written draft in plain prose; it becomes the definitive source' },
          source_text:    { type: 'string', description: 'other seed text to expand into an article (e.g. a social post)' },
          voice_doc:      { type: 'string', description: 'from read_voice_profile' },
          posts:          { type: 'array', description: 'recent post stubs from list_blog_posts, used for dedup + tag taxonomy' },
          target_keyword: { type: 'string', description: 'primary keyword to rank for' },
          expert_context: { type: 'string', description: 'the operator\'s interview answers, from read_aeo_question' },
          tags:           { type: 'array', items: { type: 'string' }, description: 'fallback tags if the writer picks none' },
        },
        required: [],
      },
    },
    run: async (env, input) => draftArticle(env, {
      title:          input.title || null,
      body:           input.body || null,
      source_text:    input.source_text || null,
      post:           input.post || null,
      voice_doc:      input.voice_doc || null,
      posts:          Array.isArray(input.posts) ? input.posts : null,
      target_keyword: input.target_keyword || null,
      expert_context: input.expert_context || null,
      tags:           Array.isArray(input.tags) ? input.tags : null,
    }),
  },

  expand_article: {
    def: {
      name: 'expand_article',
      description: 'Expand an existing article to 1600-2200 words and write its AEO FAQ, in a single reasoning step. Deepens the story with examples, failure modes and why-now, and returns the new excerpt, body and FAQ. It saves nothing: pass the result to save_blog_post and append_faq_schema.',
      input_schema: {
        type: 'object',
        properties: {
          post:      { type: 'object', description: 'the post from read_blog_post' },
          slug:      { type: 'string', description: 'alternative to post: read it by slug' },
          voice_doc: { type: 'string', description: 'from read_voice_profile' },
        },
        required: [],
      },
    },
    run: async (env, input) => expandArticle(env, {
      post:      input.post || null,
      slug:      input.slug || null,
      blog_slug: input.blog_slug || null,
      voice_doc: input.voice_doc || null,
    }),
  },

  append_faq_schema: {
    def: {
      name: 'append_faq_schema',
      description: 'Append one FAQPage JSON-LD block to a post body so answer engines can lift the Q&As. Use it right after saving an expanded article that produced an FAQ.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          faq:       { type: 'array', description: 'array of {q, a}' },
        },
        required: ['faq'],
      },
    },
    run: async (env, input) => appendFaqSchema(env, {
      blog_slug: slugArg(input),
      faq: input.faq,
    }),
  },

  // ── figures + covers (code-drawn, brand-locked) ────────────
  draft_figures: {
    def: {
      name: 'draft_figures',
      description: 'Design the set of editorial diagrams for one article, in a single reasoning step: it picks 3-5 templates that match the shapes of the article\'s ideas, anchors each to the sentence it illustrates, and drafts the cover slots. Returns specs to hand to render_figures; renders nothing itself.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string', description: 'the post to illustrate (title/excerpt/body are read from it when not passed)' },
          title:     { type: 'string' },
          excerpt:   { type: 'string' },
          body:      { type: 'string', description: 'the article body HTML' },
        },
        required: [],
      },
    },
    run: async (env, input) => draftFigures(env, {
      blog_slug: slugArg(input),
      title:   input.title || null,
      excerpt: input.excerpt || null,
      body:    input.body || null,
    }),
  },

  render_figures: {
    def: {
      name: 'render_figures',
      description: 'Render drafted figure specs into stored PNGs (brand SVG templates, no AI image model, zero cost). Returns each figure\'s URL with the anchor it belongs to, for embed_figures to place.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          specs:     { type: 'array', description: 'from draft_figures' },
        },
        required: ['specs'],
      },
    },
    run: async (env, input) => renderFigures(env, {
      blog_slug: slugArg(input),
      specs: input.specs,
    }),
  },

  embed_figures: {
    def: {
      name: 'embed_figures',
      description: 'Place rendered figures into the post body at their anchor sentences. Any figures from a previous run are stripped first, so re-running refreshes the illustrations instead of stacking duplicates.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          figures:   { type: 'array', description: 'from render_figures' },
        },
        required: ['figures'],
      },
    },
    run: async (env, input) => embedFiguresInPost(env, {
      blog_slug: slugArg(input),
      figures: input.figures,
      actor: input.actor || 'nyo',
    }),
  },

  draft_cover: {
    def: {
      name: 'draft_cover',
      description: 'Draft the three hero slots for an article cover (kicker, the highlighted word from the title, and the standfirst) in one cheap reasoning step. Use it when refreshing only the cover; draft_figures already returns these when it runs.',
      input_schema: {
        type: 'object',
        properties: {
          title:     { type: 'string' },
          excerpt:   { type: 'string' },
          blog_slug: { type: 'string', description: 'read title + excerpt from this post instead' },
        },
        required: [],
      },
    },
    run: async (env, input) => draftCover(env, {
      title: input.title || null,
      excerpt: input.excerpt || null,
      blog_slug: slugArg(input),
    }),
  },

  render_cover: {
    def: {
      name: 'render_cover',
      description: 'Render the article\'s hero cover PNG in the brand template and store it at a fresh cache-busted URL. Reliable by design: no AI image model, no API key, and it falls back to deterministic slots from the title and excerpt when no drafted cover is given. Pass the result to set_featured_image.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          title:     { type: 'string' },
          excerpt:   { type: 'string' },
          cover:     { type: 'object', description: 'optional {kicker, highlight, sub} from draft_cover or draft_figures' },
        },
        required: [],
      },
    },
    run: async (env, input) => renderCover(env, {
      blog_slug: slugArg(input),
      title: input.title || null,
      excerpt: input.excerpt || null,
      cover: input.cover || null,
    }),
  },

  set_featured_image: {
    def: {
      name: 'set_featured_image',
      description: 'Point one post at its featured image. Takes the URL of a rendered cover or a judged AI illustration. This is the only writer of a post\'s featured-image fields.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          url:       { type: 'string', description: 'the cover_url or winner_url to set' },
          model:     { type: 'string', description: 'what produced it, for the audit trail' },
          prompt:    { type: 'string', description: 'the image prompt, when there was one' },
        },
        required: [],
      },
    },
    run: async (env, input) => setFeaturedImage(env, {
      blog_slug:  slugArg(input),
      url:        input.url || null,
      cover_url:  input.cover_url || null,
      winner_url: input.winner_url || null,
      model:      input.model || null,
      prompt:     input.prompt || null,
      actor:      input.actor || 'nyo',
    }),
  },

  // ── AI illustration path (brief → candidates → vision judge) ─
  draft_visual_brief: {
    def: {
      name: 'draft_visual_brief',
      description: 'Draft the AI-illustration brief for one article in a single reasoning step: it picks the light behaviour that makes the article\'s argument visible and returns the finished image prompt in the house visual style.',
      input_schema: {
        type: 'object',
        properties: {
          title:     { type: 'string' },
          excerpt:   { type: 'string' },
          tags:      { type: 'array', items: { type: 'string' } },
          blog_slug: { type: 'string', description: 'read title/excerpt/tags from this post instead' },
        },
        required: [],
      },
    },
    run: async (env, input) => draftImageBrief(env, {
      title: input.title || null,
      excerpt: input.excerpt || null,
      tags: Array.isArray(input.tags) ? input.tags : null,
      blog_slug: slugArg(input),
    }),
  },

  render_images: {
    def: {
      name: 'render_images',
      description: 'Render N candidate AI images from one prompt and store them. Only their URLs come back — the image bytes never enter the conversation. Hand the candidates to judge_images to pick a winner.',
      input_schema: {
        type: 'object',
        properties: {
          blog_slug: { type: 'string' },
          prompt:    { type: 'string', description: 'from draft_visual_brief' },
          n:         { type: 'number', description: 'candidates to render (default 3, max 4)' },
          model:     { type: 'string', enum: [...IMAGE_MODELS, 'gpt-image-1', 'dall-e-3'], description: 'image model; defaults to gpt-image-1 when an OpenAI key is set, else flux-schnell' },
        },
        required: ['prompt'],
      },
    },
    run: async (env, input) => renderCandidateImages(env, {
      blog_slug: slugArg(input),
      prompt: input.prompt,
      n: input.n ?? null,
      model: input.model || null,
    }),
  },

  judge_images: {
    def: {
      name: 'judge_images',
      description: 'Score candidate images against the house visual-style doc in one vision step and return the winner\'s URL. It reads each candidate back from storage itself; when no vision model is configured it falls back to the first candidate rather than blocking the post.',
      input_schema: {
        type: 'object',
        properties: {
          candidates: { type: 'array', description: 'from render_images' },
          title:      { type: 'string', description: 'the article title the image is for' },
        },
        required: ['candidates'],
      },
    },
    run: async (env, input) => judgeCandidateImages(env, {
      candidates: input.candidates,
      title: input.title || null,
      blog_slug: slugArg(input),
    }),
  },

  // ── AEO questions: queue, interview, claim ─────────────────
  read_aeo_question: {
    def: {
      name: 'read_aeo_question',
      description: 'Read one AEO question with its interview state and the operator\'s answers formatted as expert context for the writer. Call it before drafting so the article is built on their expertise.',
      input_schema: {
        type: 'object',
        properties: { question_slug: { type: 'string', description: 'the aeo_questions slug' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const slug = input.question_slug || input.slug || null;
      const q = await readAeoQuestion(env, slug);
      if (!q) return { found: false, question_slug: slug };
      return {
        found: true,
        question_slug: q.slug,
        question: q.question,
        title: q.question,           // the question IS the article's working title
        target_keyword: q.target_keyword,
        notes: q.notes,
        voice: q.voice || 'house',
        status: q.status,
        interview_status: q.interview_status || null,
        expert_context: formatExpertContext(q.expert_context_json || null),
      };
    },
  },

  save_aeo_question: {
    def: {
      name: 'save_aeo_question',
      description: 'Create or patch one AEO question. With no slug it creates a new queued topic from `question`; with a slug it patches only the fields you pass. Pass status="drafted" together with blog_slug to record that the article for it has been written.',
      input_schema: {
        type: 'object',
        properties: {
          question_slug:  { type: 'string', description: 'omit to create a new question' },
          question:       { type: 'string', description: 'the topic / question text' },
          target_keyword: { type: 'string' },
          priority:       { type: 'number', description: 'lower = sooner' },
          notes:          { type: 'string', description: 'angle / context for the eventual article' },
          voice:          { type: 'string', enum: ['house', 'personal'] },
          status:         { type: 'string', enum: ['pending', 'drafting', 'drafted', 'published', 'failed'] },
          blog_slug:      { type: 'string', description: 'the article this question produced' },
          error:          { type: 'string', description: 'why it failed, with status=failed' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const slug = input.question_slug || null;
      const existing = slug ? await readAeoQuestion(env, slug) : null;

      if (!existing) {
        if (!input.question) return { ok: false, error: slug ? `AEO question not found: ${slug}` : 'question text required to create one' };
        const created = await addAeoQuestion(env, {
          question: input.question,
          target_keyword: input.target_keyword || null,
          notes: input.notes || null,
          priority: input.priority ?? 3,
        });
        if (input.voice === 'personal' || input.voice === 'house') await setAeoVoice(env, created.slug, input.voice);
        return { ok: true, question_slug: created.slug, question: created.question, created: true };
      }

      // Terminal states go through their own markers so the drafted/published
      // link and the error trail are recorded the same way everywhere.
      if (input.status === 'drafted' && input.blog_slug) {
        await markAeoQuestionDrafted(env, existing.slug, input.blog_slug);
        return { ok: true, question_slug: existing.slug, question: existing.question, status: 'drafted', blog_slug: input.blog_slug };
      }
      if (input.status === 'published' && input.blog_slug) {
        await markAeoQuestionPublished(env, existing.slug, input.blog_slug);
        return { ok: true, question_slug: existing.slug, question: existing.question, status: 'published', blog_slug: input.blog_slug };
      }
      if (input.status === 'failed') {
        await markAeoQuestionFailed(env, existing.slug, input.error || 'writer failed');
        return { ok: true, question_slug: existing.slug, question: existing.question, status: 'failed' };
      }

      const merged = await writeAeoQuestion(env, {
        slug:           existing.slug,
        question:       input.question       ?? existing.question,
        target_keyword: input.target_keyword ?? existing.target_keyword,
        priority:       input.priority       ?? existing.priority,
        status:         input.status         ?? existing.status,
        scheduled_for:  existing.scheduled_for,
        notes:          input.notes          ?? existing.notes,
      });
      if (input.voice === 'personal' || input.voice === 'house') await setAeoVoice(env, existing.slug, input.voice);
      return { ok: true, question_slug: merged.slug, question: merged.question };
    },
  },

  draft_interview_questions: {
    def: {
      name: 'draft_interview_questions',
      description: 'Draft the four expert-interview questions to ask the operator before an article is written, in one reasoning step. They target their lived experience: the mistake they keep seeing, the mechanism that works, a real example, and the counterintuitive part.',
      input_schema: {
        type: 'object',
        properties: {
          question_slug:  { type: 'string' },
          question:       { type: 'string', description: 'the topic to interview about' },
          target_keyword: { type: 'string' },
          notes:          { type: 'string' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({
      question_slug: input.question_slug || null,
      interview_questions: await generateInterviewQuestions(env, {
        slug: input.question_slug || null,
        question: input.question,
        target_keyword: input.target_keyword || null,
        notes: input.notes || null,
      }),
    }),
  },

  save_interview_questions: {
    def: {
      name: 'save_interview_questions',
      description: 'Save the drafted interview questions on one AEO question and mark its interview pending, so the queue skips it until the operator answers.',
      input_schema: {
        type: 'object',
        properties: {
          question_slug:       { type: 'string' },
          interview_questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['question_slug', 'interview_questions'],
      },
    },
    run: async (env, input) => {
      await saveInterviewQuestions(env, input.question_slug, input.interview_questions);
      return { ok: true, question_slug: input.question_slug, interview_status: 'pending' };
    },
  },

  save_interview_answers: {
    def: {
      name: 'save_interview_answers',
      description: 'Save the operator\'s raw interview answers on one AEO question and mark it ready to write. Call it the moment they answer, in whatever form they replied.',
      input_schema: {
        type: 'object',
        properties: {
          question_slug: { type: 'string' },
          answers:       { type: 'string', description: 'their raw answers, free text' },
        },
        required: ['question_slug', 'answers'],
      },
    },
    run: async (env, input) => {
      await saveInterviewAnswers(env, input.question_slug, input.answers);
      return { ok: true, question_slug: input.question_slug, interview_status: 'ready' };
    },
  },

  claim_aeo_question: {
    def: {
      name: 'claim_aeo_question',
      description: 'Claim one interviewed AEO question for writing, so only one run can ever write it. With no slug it claims the next ready question that is due. It refuses a question whose interview is not answered yet, and refuses one another run already claimed — treat either refusal as final rather than retrying.',
      input_schema: {
        type: 'object',
        properties: { question_slug: { type: 'string', description: 'omit to claim the next due ready question' } },
        required: [],
      },
    },
    run: async (env, input) => claimAeoQuestion(env, {
      question_slug: input.question_slug || null,
      slug: input.slug || null,
    }),
  },

  // ── editorial taste + OSINT-sourced suggestions ────────────
  save_aeo_feedback: {
    def: {
      name: 'save_aeo_feedback',
      description: 'Record the operator\'s reaction to an article idea (love, like, meh, reject, edit) with their own words about why. Call it whenever they react to an idea you proposed; the reactions are what the editorial-taste profile is learned from.',
      input_schema: {
        type: 'object',
        properties: {
          question_slug: { type: 'string', description: 'if the idea is a saved AEO question' },
          idea_title:    { type: 'string', description: 'if it is not a saved question yet' },
          reaction:      { type: 'string', enum: ['love', 'like', 'meh', 'reject', 'edit'] },
          note:          { type: 'string', description: 'their words: why, or how to change it' },
        },
        required: ['reaction'],
      },
    },
    run: async (env, input) => {
      await recordAeoFeedback(env, {
        question_slug: input.question_slug || input.slug || null,
        idea_title: input.idea_title || null,
        reaction: input.reaction,
        note: input.note || null,
      });
      return { ok: true, recorded: true, reaction: input.reaction };
    },
  },

  draft_taste_profile: {
    def: {
      name: 'draft_taste_profile',
      description: 'Draft the updated editorial-taste doc from the operator\'s recent reactions, in one reasoning step. It returns the knowledge doc to save and writes nothing, so the update stays visible before it lands.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const doc = await draftTasteProfile(env);
      return doc || { skipped: true, reason: 'no reactions recorded yet' };
    },
  },

  read_suggestion_policy: {
    def: {
      name: 'read_suggestion_policy',
      description: 'Read the AEO suggestion policy (daily limit, cap on the unreviewed pile, minimum signal score) together with how much room is left today. Call it first: it tells the next steps how many signals to develop and how good they must be.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'override the policy daily limit for this run' } },
        required: [],
      },
    },
    run: async (env, input) => readSuggestionPolicy(env, { limit: input?.limit ?? null }),
  },

  draft_suggestion_angles: {
    def: {
      name: 'draft_suggestion_angles',
      description: 'Develop scored industry signals into article angles in one reasoning step: a working title, the keyword, our specific take and why it is worth writing now. It deduplicates against existing posts and queued topics and saves nothing.',
      input_schema: {
        type: 'object',
        properties: {
          signals: { type: 'array', description: 'candidate signals from list_signals' },
          limit:   { type: 'number', description: 'how many to select at most' },
        },
        required: ['signals'],
      },
    },
    run: async (env, input) => draftSuggestionAngles(env, {
      signals: input.signals,
      limit: input.limit ?? null,
    }),
  },

  save_aeo_suggestions: {
    def: {
      name: 'save_aeo_suggestions',
      description: 'Save developed angles as pending AEO suggestions for the operator to approve or reject. Signals that already produced a suggestion are skipped, and each source signal is marked actioned so the same news is never suggested twice.',
      input_schema: {
        type: 'object',
        properties: {
          suggestions: { type: 'array', description: 'from draft_suggestion_angles' },
          signals:     { type: 'array', description: 'the source signals, for provenance' },
          limit:       { type: 'number' },
        },
        required: ['suggestions'],
      },
    },
    run: async (env, input) => saveAeoSuggestions(env, {
      suggestions: input.suggestions,
      signals: Array.isArray(input.signals) ? input.signals : null,
      limit: input.limit ?? null,
    }),
  },
};
