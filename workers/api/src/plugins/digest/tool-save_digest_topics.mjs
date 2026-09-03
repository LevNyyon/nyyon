export const def = {
  name: 'save_digest_topics',
  description: 'Save the watched topics the Digest searches for (max 5 short search queries). Replaces the list in the Digest search topics knowledge doc.',
  input_schema: {
    type: 'object',
    properties: { topics: { type: 'array', items: { type: 'string' }, description: 'up to 5 search queries' } },
    required: ['topics'],
  },
};
export async function run(api, input) {
  const topics = (Array.isArray(input?.topics) ? input.topics : [])
    .map((t) => String(t || '').trim().replace(/^#+\s*/, ''))
    .filter(Boolean).slice(0, 5);
  if (!topics.length) return { ok: false, error: 'no topics given' };
  const body = `# Digest search topics

One topic per line. The digest looks each of these up every run and files fresh headlines into the brief. Lines starting with # are ignored. Keep it to a handful.

${topics.join('\n')}
`;
  await api.saveKnowledge('plugin-digest-search-topics', { title: 'Digest search topics', body });
  await api.log('topics_saved', { count: topics.length });
  return { ok: true, topics };
}
