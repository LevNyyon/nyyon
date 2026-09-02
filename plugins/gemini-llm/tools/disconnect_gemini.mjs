export const def = {
  name: 'disconnect_gemini',
  description: 'Forget the Gemini key. Nyo falls back to whatever other brain is available.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  await api.db.prepare('DELETE FROM plugin_gemini_llm_config WHERE id = 1').run();
  await api.log('disconnected', {});
  return { ok: true, note: 'Gemini forgotten.' };
}
