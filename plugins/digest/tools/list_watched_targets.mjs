// Digest plugin — list_watched_targets. NEW read-only tool for the
// digest's OSINT watch list. The targets belong to the editorial pack
// (plugin_editorial_osint_targets, declared SELECT-only host read) — adding,
// scraping and removing them stays in that pack; this just shows what feeds
// the digest's OSINT channel.

export const def = {
  name: 'list_watched_targets',
  description: 'List the OSINT targets the editorial pack watches (name, domain, mention count, last hit) — the feed behind the digest\'s OSINT channel. Read-only: manage targets from the editorial pack (or ask Nyo to use its osint tools).',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  try {
    const targets = (await api.db.prepare(
      'SELECT id, name, domain, notes FROM plugin_editorial_osint_targets ORDER BY name ASC',
    ).all()).results || [];
    const out = [];
    for (const t of targets) {
      let n = 0, last = null;
      try {
        const s = await api.db.prepare(
          'SELECT COUNT(*) n, MAX(COALESCE(posted_at, created_at)) last FROM plugin_editorial_osint_mentions WHERE target_id = ?',
        ).bind(t.id).first();
        n = s?.n ?? 0; last = s?.last ?? null;
      } catch { /* mentions table absent — counts stay 0 */ }
      out.push({ ...t, mentions_count: n, last_mention_at: last });
    }
    return { targets: out };
  } catch {
    return { targets: [], note: 'editorial pack (osint targets) not installed on this host' };
  }
}
