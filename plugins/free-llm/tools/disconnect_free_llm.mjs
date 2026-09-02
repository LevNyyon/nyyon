export const def = {
  name: 'disconnect_free_llm',
  description: 'Forget the connected free model provider and its key. Nyo goes back to the main model only.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  await api.db.prepare('DELETE FROM plugin_free_llm_config WHERE id = 1').run();
  await api.log('disconnected', {});
  return { ok: true, note: 'Disconnected. The key is gone from this install.' };
}
