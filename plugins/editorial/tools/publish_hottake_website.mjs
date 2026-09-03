// Editorial plugin — publish_hottake_website. Surface entry point for the old
// POST /api/hot-takes/packages/:id/publish-website route, restored to the lib
// publishWebsite path the host route had to approximate: publish through the
// shared blog pipeline (social:false — Hot Takes owns its own two legs),
// and auto-complete the package when everything
// else already shipped.

import { publishWebsite } from './hot-takes.mjs';
import { publishBlogPostToProd } from './publish.mjs';

export const def = {
  name: 'publish_hottake_website',
  description: 'Publish a package\'s article to the live site right now, skipping the schedule: shared blog publish (edge-verified, IndexNow, Outbox audit), the package moves to published, and the release auto-completes if its legs are already done. Operator approval gate — call only on an explicit publish.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  try {
    return await publishWebsite(api, input.id, {
      actor: input.actor || 'operator',
      publish: publishBlogPostToProd,
    });
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
