// Editorial plugin — read_aeo_question. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readAeoQuestion } from './blog-db.mjs';
import { formatExpertContext } from './aeo-interview.mjs';

export const def = {
  name: 'read_aeo_question',
  description: 'Read one AEO question with its interview state and the operator\'s answers formatted as expert context for the writer. Call it before drafting so the article is built on their expertise.',
  input_schema: {
    type: 'object',
    properties: { question_slug: { type: 'string', description: 'the aeo_questions slug' } },
    required: [],
  },
};

export async function run(api, input) {
  const slug = input.question_slug || input.slug || null;
  const q = await readAeoQuestion(api, slug);
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
}
