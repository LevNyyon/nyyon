// Where this install's public site lives (the site blog posts publish to and
// the Social/Blog surfaces link out to). No production origin is hardcoded in
// the app: set VITE_PUBLIC_SITE_URL at build time to your site's origin (the
// build-time mirror of the worker's PUBLIC_ORIGIN env var). Left empty, every
// surface that links to or previews the live site shows its "no public site
// connected" state instead of a dead link.
export const PUBLIC_SITE_URL: string =
  String(import.meta.env.VITE_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');

// Human-readable host for labels ("example.com"); empty when not configured.
export const PUBLIC_SITE_HOST: string = PUBLIC_SITE_URL.replace(/^https?:\/\//, '');

// Public URL of one blog post; empty string when no site origin is configured.
export function blogUrl(slug: string): string {
  return PUBLIC_SITE_URL ? `${PUBLIC_SITE_URL}/blog/${slug}` : '';
}
