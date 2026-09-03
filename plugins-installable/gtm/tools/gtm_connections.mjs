export const def = {
  name: 'gtm_connections',
  description: 'Which prospecting data services are connected on this install, and which are unavailable here. Use before promising enrichment, search or phone validation.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  const out = [];
  for (const [slug, label] of [['serp', 'SerpApi (search)'], ['pdl', 'People Data Labs (person enrichment)'], ['twilio', 'Twilio (phone validation)']]) {
    let st = null; try { st = await api.gateway(slug, 'status', {}); } catch { st = null; }
    out.push({ service: slug, label, connectable: true, connected: !!st?.connected });
  }
  for (const [slug, label] of [['linkedin', 'LinkedIn company and jobs'], ['theorg', 'Org charts'], ['assets', 'File storage']]) {
    out.push({ service: slug, label, connectable: false, connected: false, note: 'not available on this install' });
  }
  return { ok: true, services: out };
}
