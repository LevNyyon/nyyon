// Editorial plugin — save_interview_questions. Ported verbatim from the host
// blog tools (workers/api/src/tools/blog.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { saveInterviewQuestions } from './aeo-interview.mjs';

export const def = {
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
};

export async function run(api, input) {
  await saveInterviewQuestions(api, input.question_slug, input.interview_questions);
  return { ok: true, question_slug: input.question_slug, interview_status: 'pending' };
}
