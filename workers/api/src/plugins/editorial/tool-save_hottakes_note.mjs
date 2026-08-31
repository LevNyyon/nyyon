// Editorial plugin — save_hottakes_note. Surface entry point for the old
// PUT /api/knowledge/:slug write the Sources tab's note editors did. Own
// plugin-editorial-* docs ONLY — api.saveKnowledge enforces the same rule, the
// guard here just gives a readable error instead of a capability failure.

export const def = {
  name: 'save_hottakes_note',
  description: 'Save one of the pack\'s own editorial notes (slug must start plugin-editorial-). The drafter, reviewer and scheduler read these live, so an edit applies on the next run.',
  input_schema: {
    type: 'object',
    properties: {
      slug:  { type: 'string' },
      title: { type: 'string' },
      body:  { type: 'string' },
    },
    required: ['slug', 'title', 'body'],
  },
};

export async function run(api, input) {
  const slug = String(input.slug || '');
  if (!slug.startsWith('plugin-editorial-')) {
    return { error: 'only this pack\'s own plugin-editorial-* notes can be saved here' };
  }
  await api.saveKnowledge(slug, { title: input.title, body: input.body });
  const doc = await api.knowledge(slug);
  await api.log('note_saved', { slug });
  return { doc };
}
