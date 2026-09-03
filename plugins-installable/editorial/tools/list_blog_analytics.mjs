// Editorial plugin — list_blog_analytics. Surface entry point for the old
// GET /api/blog/analytics route (workers/api/src/lib/db.js listBlogAnalytics):
// every blog post row joined with its web analytics — views, uniques, last
// view, average scroll depth and CTA clicks.
//
// web_events is a HOST table (the public site's analytics ingest) — read-only
// here via requires.host_reads; the posts themselves come from the pack's own
// plugin_editorial_blog_posts.

export const def = {
  name: 'list_blog_analytics',
  description: 'Blog posts with their analytics overlay: views, unique visitors, last view, avg scroll %, CTA clicks per post, sorted by views. published_only narrows to live posts.',
  input_schema: {
    type: 'object',
    properties: { published_only: { type: 'boolean', description: 'default false' } },
    required: [],
  },
};

export async function run(api, input) {
  const publishedOnly = Boolean(input?.published_only);
  const sql = `
    SELECT
      bp.slug, bp.title, bp.excerpt, bp.tags, bp.body,
      bp.published_at, bp.published, bp.updated_at, bp.updated_by,
      COALESCE(v.views, 0)            AS views,
      COALESCE(v.unique_visitors, 0)  AS unique_visitors,
      v.last_view                     AS last_view,
      COALESCE(s.avg_scroll, 0)       AS avg_scroll,
      COALESCE(c.cta_clicks, 0)       AS cta_clicks
    FROM plugin_editorial_blog_posts bp
    LEFT JOIN (
      SELECT page_path,
             COUNT(*)                       AS views,
             COUNT(DISTINCT cookie_id)      AS unique_visitors,
             MAX(created_at)                AS last_view
      FROM web_events
      WHERE event_type = 'visit' AND page_path LIKE '/blog/%'
      GROUP BY page_path
    ) v ON v.page_path = '/blog/' || bp.slug
    LEFT JOIN (
      SELECT page_path,
             AVG(CAST(json_extract(event_data, '$.depth') AS REAL)) AS avg_scroll
      FROM web_events
      WHERE event_type = 'scroll_depth' AND page_path LIKE '/blog/%'
      GROUP BY page_path
    ) s ON s.page_path = '/blog/' || bp.slug
    LEFT JOIN (
      SELECT page_path, COUNT(*) AS cta_clicks
      FROM web_events
      WHERE event_type = 'cta_click' AND page_path LIKE '/blog/%'
      GROUP BY page_path
    ) c ON c.page_path = '/blog/' || bp.slug
    ${publishedOnly ? 'WHERE bp.published = 1' : ''}
    ORDER BY views DESC, bp.published_at DESC
  `;
  const r = await api.db.prepare(sql).all();
  return { posts: r.results || [] };
}
