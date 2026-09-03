// Editorial plugin — list_social_integrations. Reads the connection registry
// through the social gateway and answers with one row per channel this module
// posts through, so the Social page and Nyo see the same list.

import { socialSettings } from './social-posts.mjs';

export const def = {
  name: 'list_social_integrations',
  description: "List the social CONNECTIONS posts can go out through and whether each is configured: linkedin-company, linkedin-personal (the operator's personal profile) and facebook-company. Call this before drafting or approving so you name a channel that actually works.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { connections: await socialSettings(api) };
}
