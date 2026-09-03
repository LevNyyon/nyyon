export const def = {
  name: 'gtm_connections',
  description: 'Which prospecting data services are connected on this install (SerpApi for search, People Data Labs for person enrichment, Twilio for phone validation) and whether WhatsApp, the only sending channel, is connected. Use before promising enrichment, search, phone validation or a send.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  const out = [];
  for (const [slug, label] of [['serp', 'SerpApi (search)'], ['pdl', 'People Data Labs (person enrichment)'], ['twilio', 'Twilio (phone validation)']]) {
    let st = null; try { st = await api.gateway(slug, 'status', {}); } catch { st = null; }
    out.push({ service: slug, label, connectable: true, connected: !!st?.connected });
  }
  // Sending is the one thing this module cannot do on its own: the WhatsApp
  // connection belongs to the host, so report it here rather than letting a
  // queued message be the first place the operator learns it is missing.
  let wa = null;
  try { wa = await api.gateway('whatsapp', 'health', {}); } catch { wa = null; }
  return {
    ok: true,
    services: out,
    sending: {
      channel: 'whatsapp',
      connected: !!(wa?.ok ?? wa?.connected),
      note: (wa?.ok ?? wa?.connected)
        ? 'WhatsApp is connected — queued messages can be sent.'
        : 'WhatsApp is not connected on this install. Everything up to the send works; a queued message waits until WhatsApp is connected in Settings.',
    },
  };
}
