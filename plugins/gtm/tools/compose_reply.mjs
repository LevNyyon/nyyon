// GTM plugin — compose_reply. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { composeReply } from './outreach-wa.mjs';

export const def = {
  name: 'compose_reply',
  description: "Write ONE reply to a prospect who has answered, grounded in the conversation, the saved angle and the drafting rules — a single model call. A no-op passthrough when the context already carries a draft (pick_next_bubble found an approved bubble), so an approved message is never overwritten. Returns a suggestion only; sending is a separate operator action via send_whatsapp.",
  input_schema: {
    type: 'object',
    properties: {
      prospect: { type: 'object', description: 'the prospect card from read_prospect_thread' },
      messages: { type: 'array', items: { type: 'object' }, description: 'the conversation, oldest first' },
      angles: { type: 'array', items: { type: 'object' }, description: 'saved angles from read_lead_angles' },
      rules: { type: 'string', description: 'the drafting rules text from read_drafting_rules' },
      limits: { type: 'object', description: 'the drafting limits from read_drafting_rules' },
      answered: { type: 'boolean' },
      draft: { type: 'string', description: 'an already-picked draft — present means passthrough' },
      source: { type: 'string', description: "where an already-picked draft came from ('angle' | 'template')" },
      needs_compose: { type: 'boolean', description: 'set by pick_next_bubble when a fresh reply is wanted' },
      force_llm: { type: 'boolean', description: 'compose even when a draft is already present' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return composeReply(api, {
    prospect: input?.prospect || null,
    messages: input?.messages || [],
    angles: input?.angles || [],
    rules: input?.rules ?? null,
    limits: input?.limits ?? null,
    answered: input?.answered ?? null,
    draft: input?.draft ?? null,
    source: input?.source ?? null,
    needs_compose: !!input?.needs_compose,
    force_llm: !!input?.force_llm,
  });
}
