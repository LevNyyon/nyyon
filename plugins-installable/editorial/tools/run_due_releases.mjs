// Editorial plugin — run_due_releases. NEW cron entry tool: the host
// scheduled handler used to import runDueReleases (as htRunDueReleases) from
// lib/hot-takes.js directly; it is rewired to invoke this tool by name. The
// ported lib deliberately takes the website-publish step as a { publish }
// dependency so hot-takes.mjs never imports publish.mjs (pack libs import
// nothing) — THIS tool is where the two meet: it hands publishBlogPostToProd
// in, exactly as the host's due-scan reached the shared blog pipeline.
// ctx stays null — the plugin runtime has no waitUntil to offer.

import { runDueReleases } from './hot-takes.mjs';
import { publishBlogPostToProd } from './publish.mjs';

export const def = {
  name: 'run_due_releases',
  description: 'Run the Hot Takes due-scan the cron runs hourly: publish every scheduled website whose time has come (real publishes — same trust as the Blog Approve button) and fire the scheduled LinkedIn legs that are due (dry-run unless the hottakes.live flag is on). Returns {live, posts_dry_run, website_published, posts_sent, errors}.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return runDueReleases(api, { ctx: null, publish: publishBlogPostToProd });
}
