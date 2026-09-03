export const def = {
  name: 'disconnect_gtm_service',
  description: 'Forget the stored key for one prospecting data service (serp, pdl or twilio).',
  input_schema: { type: 'object', properties: { service: { type: 'string', enum: ['serp', 'pdl', 'twilio'] } }, required: ['service'] },
};
export async function run(api, input) {
  const s = String(input?.service || '').trim().toLowerCase();
  if (!['serp', 'pdl', 'twilio'].includes(s)) return { ok: false, error: 'service must be serp, pdl or twilio' };
  const names = s === 'twilio' ? ['twilio_sid', 'twilio_token'] : [`${s}_api_key`];
  for (const n of names) await api.db.prepare('DELETE FROM plugin_gtm_connections WHERE name = ?').bind(n).run();
  await api.log('service_disconnected', { service: s });
  return { ok: true, service: s };
}
