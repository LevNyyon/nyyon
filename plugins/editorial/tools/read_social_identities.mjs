// Editorial plugin — read_social_identities. Surface entry point for the old
// GET /api/hot-takes/social-identities route: who appears as the poster in
// each channel's post preview. From the editable identities note, never code.

import { loadSocialIdentities } from './hot-takes.mjs';

export const def = {
  name: 'read_social_identities',
  description: 'The poster identities for the social-post previews, keyed by channel (name, headline, avatar_url) — from the editable plugin-editorial-hottakes-social-identities note.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { identities: await loadSocialIdentities(api) };
}
