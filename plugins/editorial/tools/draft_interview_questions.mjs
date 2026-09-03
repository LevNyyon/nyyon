// Editorial plugin — draft_interview_questions. Ported verbatim from the host
// blog tools (workers/api/src/tools/blog.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { generateInterviewQuestions } from './aeo-interview.mjs';

export const def = {
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
};

export async function run(api, input) {
  return {
    question_slug: input.question_slug || null,
    interview_questions: await generateInterviewQuestions(api, {
      slug: input.question_slug || null,
      question: input.question,
      target_keyword: input.target_keyword || null,
      notes: input.notes || null,
    }),
  };
}
