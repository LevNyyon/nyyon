export const def = {
  name: 'digest_sources',
  description: 'What feeds the Digest on this install: installed search providers (discovered by capability), whether the calendar source is present, and the watched topics. Use to answer "where does my brief pull from?" or before onboarding.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  let providers = [];
  try {
    const found = await api.discoverGateways('search');
    providers = await Promise.all(found.map(async (p) => {
      let st = null; try { st = p.status ? await p.status() : null; } catch { st = null; }
      return { slug: p.slug, label: st?.label || p.label, connected: st ? !!st.connected : true, note: st?.note || null };
    }));
  } catch { providers = []; }
  let calendar = false;
  try { await api.db.prepare('SELECT 1 FROM calendar_events LIMIT 1').all(); calendar = true; } catch { calendar = false; }
  let topics = [];
  try {
    const doc = await api.knowledge('plugin-digest-search-topics');
    topics = String(doc?.body || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { topics = []; }
  const configured = topics.length > 0 && !(topics.length === 1 && topics[0] === 'AI agents');
  return { ok: true, providers, calendar, topics, configured, ready: configured && providers.some((p) => p.connected) };
}
