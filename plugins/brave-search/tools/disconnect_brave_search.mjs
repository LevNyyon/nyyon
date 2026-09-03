export const def = {
  name: 'disconnect_brave_search',
  description: 'Forget the Brave Search key.',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function run(api) {
  await api.db.prepare('DELETE FROM plugin_brave_search_config WHERE id = 1').run();
  await api.log('disconnected', {});
  return { ok: true, note: 'Brave Search forgotten.' };
}
