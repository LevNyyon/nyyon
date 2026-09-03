export const def = {
  name: 'read_digest_topics',
  description: 'Read the watched topics the Digest currently searches for.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  let doc = null;
  try { doc = await api.knowledge('plugin-digest-search-topics'); } catch { doc = null; }
  const topics = String(doc?.body || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { ok: true, topics, configured: topics.length > 0 && !(topics.length === 1 && topics[0] === 'AI agents') };
}
