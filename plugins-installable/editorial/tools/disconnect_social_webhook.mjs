export const def = {
  name: 'disconnect_social_webhook',
  description: 'Forget one social network webhook.',
  input_schema: { type: 'object', properties: { network: { type: 'string' } }, required: ['network'] },
};
export async function run(api, input) {
  const network = String(input?.network || '').trim().toLowerCase();
  if (!network) return { ok: false, error: 'network required' };
  await api.db.prepare('DELETE FROM plugin_editorial_connections WHERE name = ?').bind(network).run();
  await api.log('social_disconnected', { network });
  return { ok: true, network };
}
