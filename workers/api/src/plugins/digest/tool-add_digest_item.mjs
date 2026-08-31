// Digest plugin — add_digest_item. Ported from cmd's tools/digest.js pool.

import { insertDigestItem } from './digest.mjs';

export const def = {
  name: 'add_digest_item',
  description: 'Manually drop something into the digest. Use when the operator says "remind me about X tomorrow" or "add this opportunity to the brief". Kind=opportunity for net-new chances; kind=note for free-form items.',
  input_schema: {
    type: 'object',
    properties: {
      kind:             { type: 'string', enum: ['opportunity', 'note', 'osint_mention', 'wa_message', 'wa_group', 'email'] },
      title:            { type: 'string' },
      summary:          { type: 'string' },
      source_label:     { type: 'string' },
      source_url:       { type: 'string' },
      urgency:          { type: 'number', description: '1 high · 2 medium · 3 low' },
      actionable:       { type: 'boolean' },
      suggested_action: { type: 'string' },
    },
    required: ['kind', 'title'],
  },
};

export async function run(api, input) {
  return {
    item: await insertDigestItem(api, {
      kind:       input.kind,
      title:      input.title,
      summary:    input.summary,
      source_label: input.source_label,
      source_url:   input.source_url,
      urgency:    input.urgency ?? 2,
      actionable: input.actionable ? 1 : 0,
      suggested_action: input.suggested_action,
    }),
  };
}
