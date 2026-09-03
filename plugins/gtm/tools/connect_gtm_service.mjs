export const def = {
  name: 'connect_gtm_service',
  description: "Connect a prospecting data service by storing its key in this plugin's own table. service is 'serp' (SerpApi, search results), 'pdl' (People Data Labs, person enrichment) or 'twilio' (phone validation; needs both sid and token). Use when the operator pastes a key in chat.",
  input_schema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['serp', 'pdl', 'twilio'] },
      api_key: { type: 'string', description: 'the key, for serp and pdl' },
      sid: { type: 'string', description: 'Twilio account SID' },
      token: { type: 'string', description: 'Twilio auth token' },
    },
    required: ['service'],
  },
};
const NAMES = { serp: 'SerpApi', pdl: 'People Data Labs', twilio: 'Twilio Lookup' };
export async function run(api, input) {
  const service = String(input?.service || '').trim().toLowerCase();
  if (!NAMES[service]) return { ok: false, error: 'service must be serp, pdl or twilio' };
  const put = async (name, value) => {
    await api.db.prepare(
      'INSERT INTO plugin_gtm_connections (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    ).bind(name, String(value), Date.now()).run();
  };
  if (service === 'twilio') {
    const sid = String(input?.sid || '').trim(); const token = String(input?.token || '').trim();
    if (!sid || !token) return { ok: false, error: 'Twilio needs both the account SID and the auth token' };
    await put('twilio_sid', sid); await put('twilio_token', token);
  } else {
    const k = String(input?.api_key || '').trim();
    if (!k) return { ok: false, error: 'api_key required' };
    await put(`${service}_api_key`, k);
  }
  const st = await api.gateway(service, 'status', {}).catch(() => null);
  await api.log('service_connected', { service });
  return { ok: true, service, connected: !!st?.connected, note: `${NAMES[service]} is connected.` };
}
