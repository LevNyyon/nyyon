export const def = {
  name: 'read_website',
  description: 'Read a website and return its readable text (title, description, main content, capped). Use during digest setup to learn what the operator does from their own site instead of asking them.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'the site, with or without https://' } },
    required: ['url'],
  },
};
const strip = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
export async function run(api, input) {
  let url = String(input?.url || '').trim();
  if (!url) return { ok: false, error: 'url required' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let r;
  try { r = await api.gateway('web', 'text', { url }); }
  catch (e) { return { ok: false, error: `could not fetch ${url}: ${String(e?.message || e).slice(0, 120)}` }; }
  if (r?.ok === false || r?.error) return { ok: false, error: r?.error || `could not fetch ${url}` };
  const raw = String(r?.text ?? r?.body ?? r ?? '');
  const looksHtml = /<html|<body|<div|<p[ >]/i.test(raw);
  const title = (raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1]?.trim() || null;
  const description = (raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i) || [])[1]?.trim() || null;
  const text = (looksHtml ? strip(raw) : raw.replace(/\s+/g, ' ').trim()).slice(0, 8000);
  if (!text) return { ok: false, error: `${url} returned no readable text` };
  await api.log('website_read', { url, chars: text.length });
  return { ok: true, url, title, description, text };
}
