// Web gateway — the shared boundary for generic public-web fetches (one
// service class: "the outside web"). Callers bring a URL; this translates to
// {ok, status, content_type, text|bytes} with bounded timeouts and size caps.
// No reasoning, no HTML opinion beyond a byte cap — strippers/readability stay
// in the tools that need them.
//
// Users: gtm.js (phone-list URL import, website social-scan, lead-photo
// download), the web_fetch tool, heartbeat (feed pull + article text), and
// osint (all keyless scrapers + the feed HEAD probe).

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES  = 500_000;

export async function fetchText(env, { url, timeout_ms = DEFAULT_TIMEOUT_MS, max_bytes = DEFAULT_MAX_BYTES, headers, header_names } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('web gateway: url must be http(s)');
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout_ms), redirect: 'follow' });
  const raw = await r.text();
  // header_names: response headers the caller wants back (lowercased keys).
  const headers_out = {};
  for (const h of header_names || []) headers_out[h.toLowerCase()] = r.headers.get(h) ?? null;
  return {
    ok: r.ok, status: r.status, status_text: r.statusText,
    content_type: r.headers.get('content-type') || null,
    headers_out,
    truncated: raw.length > max_bytes,
    text: raw.slice(0, max_bytes),
  };
}

// Existence probe — HEAD only, no body. For "is there a feed at this path"
// checks where GETting the whole document would be waste.
export async function head(env, { url, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('web gateway: url must be http(s)');
  const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeout_ms), redirect: 'follow' });
  return { ok: r.ok, status: r.status };
}


export async function fetchBytes(env, { url, timeout_ms = 20_000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('web gateway: url must be http(s)');
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout_ms), redirect: 'follow' });
  if (!r.ok) return { ok: false, status: r.status, bytes: null, content_type: null };
  return {
    ok: true, status: r.status,
    content_type: r.headers.get('content-type') || null,
    bytes: await r.arrayBuffer(),
  };
}
