// GTM plugin — save_drafting_rules. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { saveDraftingRules } from './outreach-wa.mjs';

export const def = {
  name: 'save_drafting_rules',
  description: 'Change how suggested replies are written (the outreach-reply-drafting knowledge doc): the full rules text and/or the numeric limits. Pass only what changes. Use for "make the drafts shorter" or "load more history".',
  input_schema: {
    type: 'object',
    properties: {
      rules: { type: 'string', description: 'the full drafting rules text (replaces it)' },
      limits: {
        type: 'object',
        description: '{thread_limit, message_limit, draft_context_messages, draft_context_chars}',
        properties: {
          thread_limit: { type: 'number' },
          message_limit: { type: 'number' },
          draft_context_messages: { type: 'number' },
          draft_context_chars: { type: 'number' },
        },
      },
    },
    required: [],
  },
};

export async function run(api, input) {
  return saveDraftingRules(api, { rules: input?.rules, limits: input?.limits });
}
