// GTM plugin — send_outreach. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { sendOutreach } from './gtm-outreach.mjs';

export const def = {
  name: 'send_outreach',
  description: "SEND outreach bubbles to one lead's WhatsApp right now, humanly paced (each bubble its own message, 4-9s jittered gaps, stops on the first failure, max 4 bubbles, every one logged). THIS MESSAGES A REAL PERSON — always show the operator the exact bubbles and get an explicit yes before calling it. A paced send can outlive the tool timeout: if this times out do NOT retry, the send is still running. A repeat to the same lead within 10 minutes is refused unless force:true, and only after the operator confirms a deliberate re-send.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'lead id' },
      bubbles: { type: 'array', items: { type: 'string' }, description: 'max 4' },
      force: { type: 'boolean', description: 'override the 10-minute repeat refusal — operator-confirmed only' },
    },
    required: ['id', 'bubbles'],
  },
};

export async function run(api, input) {
  return sendOutreach(api, {
    lead_id: input?.id, bubbles: input?.bubbles || [], force: !!input?.force,
  });
}
