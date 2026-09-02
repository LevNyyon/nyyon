export const def = {
  name: 'gemini_status',
  description: 'Is Gemini connected as a backup brain, and on which model? Pass check:true to confirm it answers with a real request.',
  input_schema: { type: 'object', properties: { check: { type: 'boolean' } }, required: [] },
};

export async function run(api, input) {
  const st = await api.gateway('gemini', 'status', {});
  if (!st?.connected || !input?.check) return st;
  const probe = await api.gateway('gemini', 'probe', {});
  return { ...st, answering: !!probe?.ok, error: probe?.ok ? null : probe?.error };
}
