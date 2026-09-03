// Editorial plugin — retry_blog_publish. NEW cron entry tool: the re-publish
// step of the host outbox retry's blog channel (lib/outbox.js). The host wakes
// failed outbound_log rows and calls this tool by name; the outbound_log
// bookkeeping (retry markers, dedup, repairs) STAYS in the host — outbound_log
// is a host table this pack may never write.
//
// Two kinds flow through the blog channel, mirroring the host switch:
//   - a failed publish (pass slug)          → re-publish from D1 to prod;
//   - a failed AEO write (pass question_slug) → re-queue the question and
//     re-run the writer.
// A post that is already live is stale bookkeeping, not an undelivered send:
// it comes back {skipped:'already live'} so the host can repair the row
// instead of re-publishing (the 2026-07-11 outbox-flood lesson).

import { readBlogPost } from './blog-db.mjs';
import { runAeoCron } from './aeo-writer.mjs';
import { publishBlogPostToProd } from './publish.mjs';

export const def = {
  name: 'retry_blog_publish',
  description: 'Retry the blog leg of a failed outbound send. Pass `slug` to re-publish a post that never went live (already-live posts are skipped, not re-published), or `question_slug` to re-queue a failed AEO question and re-run the writer. Returns the publish/writer result.',
  input_schema: {
    type: 'object',
    properties: {
      slug:          { type: 'string', description: 'the blog post slug to re-publish' },
      question_slug: { type: 'string', description: 'instead: the failed aeo question to re-queue and re-write' },
      deploy:        { type: 'boolean', description: 'also kick the marketing-site rebuild (default true)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  if (input?.question_slug) {
    await api.db.prepare(
      `UPDATE plugin_editorial_aeo_questions SET status='pending', last_error=NULL, updated_at=? WHERE slug=?`,
    ).bind(Date.now(), input.question_slug).run();
    await api.log('aeo_question_requeued', { slug: input.question_slug, source: 'outbox-retry' });
    return runAeoCron(api, { actor: 'outbox-retry' });
  }

  const slug = input?.slug || null;
  if (!slug) return { ok: false, error: 'pass slug (re-publish) or question_slug (re-run writer)' };

  // If the post is ALREADY LIVE, the failed row is stale bookkeeping, not an
  // undelivered send — tell the host so it repairs the record instead of
  // re-publishing.
  const post = await readBlogPost(api, slug).catch(() => null);
  if (post?.published) return { ok: true, skipped: 'already live', slug };

  return publishBlogPostToProd(api, slug, {
    source: 'retry',
    deploy: input?.deploy !== false,
  });
}
