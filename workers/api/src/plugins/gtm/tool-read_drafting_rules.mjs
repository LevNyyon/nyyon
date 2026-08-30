// GTM plugin — read_drafting_rules. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { loadDraftingRules } from './outreach-wa.mjs';

export const def = {
  name: 'read_drafting_rules',
  description: 'Read how suggested replies are written and how much conversation the tab loads (the outreach-reply-drafting knowledge doc): the rules text plus thread_limit / message_limit / draft_context_messages / draft_context_chars.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return loadDraftingRules(api);
}
