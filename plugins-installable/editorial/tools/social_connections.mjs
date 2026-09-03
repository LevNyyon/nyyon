export const def = {
  name: 'social_connections',
  description: 'Which social networks are connected for posting, and when each was set. Use before offering to publish, and to answer "can I post to LinkedIn?".',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  const r = await api.gateway('social', 'connections', {});
  return r?.ok ? r : { ok: false, error: r?.error || 'could not read connections' };
}
