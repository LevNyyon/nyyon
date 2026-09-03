// Editorial plugin — save_aeo_question. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import {
  readAeoQuestion, addAeoQuestion, writeAeoQuestion, setAeoVoice,
  markAeoQuestionDrafted, markAeoQuestionPublished, markAeoQuestionFailed,
} from './blog-db.mjs';

export const def = {
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
};

export async function run(api, input) {
  const slug = input.question_slug || null;
  const existing = slug ? await readAeoQuestion(api, slug) : null;

  if (!existing) {
    if (!input.question) return { ok: false, error: slug ? `AEO question not found: ${slug}` : 'question text required to create one' };
    const created = await addAeoQuestion(api, {
      question: input.question,
      target_keyword: input.target_keyword || null,
      notes: input.notes || null,
      priority: input.priority ?? 3,
    });
    if (input.voice === 'personal' || input.voice === 'house') await setAeoVoice(api, created.slug, input.voice);
    return { ok: true, question_slug: created.slug, question: created.question, created: true };
  }

  // Terminal states go through their own markers so the drafted/published
  // link and the error trail are recorded the same way everywhere.
  if (input.status === 'drafted' && input.blog_slug) {
    await markAeoQuestionDrafted(api, existing.slug, input.blog_slug);
    return { ok: true, question_slug: existing.slug, question: existing.question, status: 'drafted', blog_slug: input.blog_slug };
  }
  if (input.status === 'published' && input.blog_slug) {
    await markAeoQuestionPublished(api, existing.slug, input.blog_slug);
    return { ok: true, question_slug: existing.slug, question: existing.question, status: 'published', blog_slug: input.blog_slug };
  }
  if (input.status === 'failed') {
    await markAeoQuestionFailed(api, existing.slug, input.error || 'writer failed');
    return { ok: true, question_slug: existing.slug, question: existing.question, status: 'failed' };
  }

  const merged = await writeAeoQuestion(api, {
    slug:           existing.slug,
    question:       input.question       ?? existing.question,
    target_keyword: input.target_keyword ?? existing.target_keyword,
    priority:       input.priority       ?? existing.priority,
    status:         input.status         ?? existing.status,
    scheduled_for:  existing.scheduled_for,
    notes:          input.notes          ?? existing.notes,
  });
  if (input.voice === 'personal' || input.voice === 'house') await setAeoVoice(api, existing.slug, input.voice);
  return { ok: true, question_slug: merged.slug, question: merged.question };
}
