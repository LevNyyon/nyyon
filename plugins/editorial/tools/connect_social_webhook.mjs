export const def = {
  name: 'connect_social_webhook',
  description: "Connect a social network for posting by storing the operator's own webhook URL (for example a Make.com scenario with a Webhook trigger that posts to LinkedIn or Facebook). No account credentials reach this install. Use when the operator pastes a webhook URL in chat.",
  input_schema: {
    type: 'object',
    properties: {
      network: { type: 'string', description: 'linkedin, linkedin-company, facebook, or another name you will reuse' },
      url: { type: 'string', description: 'the webhook URL that accepts JSON and posts on their behalf' },
    },
    required: ['network', 'url'],
  },
};
export async function run(api, input) {
  const network = String(input?.network || '').trim().toLowerCase();
  const url = String(input?.url || '').trim();
  if (!network) return { ok: false, error: 'network required' };
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'the webhook URL must start with https://' };
  const t = Date.now();
  await api.db.prepare(
    'INSERT INTO plugin_editorial_connections (name, url, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET url=excluded.url, updated_at=excluded.updated_at',
  ).bind(network, url, t).run();
  await api.log('social_connected', { network });
  return { ok: true, network, note: `${network} is connected. Posts go to that webhook; nothing else about the account is stored.` };
}
