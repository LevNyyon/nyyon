// Editorial plugin — save_interview_answers. Ported verbatim from the host
// blog tools (workers/api/src/tools/blog.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { saveInterviewAnswers } from './aeo-interview.mjs';

export const def = {
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
};

export async function run(api, input) {
  await saveInterviewAnswers(api, input.question_slug, input.answers);
  return { ok: true, question_slug: input.question_slug, interview_status: 'ready' };
}
