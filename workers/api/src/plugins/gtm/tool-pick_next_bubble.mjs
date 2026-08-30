// GTM plugin — pick_next_bubble. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { pickNextBubble } from './outreach-wa.mjs';

export const def = {
  name: 'pick_next_bubble',
  description: "Pick the next message for a prospect who has NOT spoken yet: the next unsent bubble from their top saved angle, or the default first-touch template when they have no angle. Deterministic — no model call, so the words are exactly what was approved. Returns {needs_compose:true} instead when they HAVE replied, because then there is something to answer and compose_reply should write it. Reads the conversation from context (messages, answered, angles); never sends.",
  input_schema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string' },
      prospect: { type: 'object', description: 'the prospect card from read_prospect_thread' },
      messages: { type: 'array', items: { type: 'object' }, description: 'the conversation, oldest first, from read_prospect_thread' },
      answered: { type: 'boolean', description: 'has the prospect ever replied (from read_prospect_thread)' },
      angles: { type: 'array', items: { type: 'object' }, description: 'saved angles from read_lead_angles' },
      force_llm: { type: 'boolean', description: 'hand straight to compose_reply even on a first touch' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return pickNextBubble(api, {
    lead_id: input?.lead_id || null,
    prospect: input?.prospect || null,
    messages: input?.messages || [],
    answered: input?.answered ?? null,
    angles: input?.angles || [],
    force_llm: !!input?.force_llm,
  });
}
