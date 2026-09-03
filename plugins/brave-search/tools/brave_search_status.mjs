export const def = {
  name: 'brave_search_status',
  description: 'Is Brave Search connected? Pass check:true to confirm it answers with a real query.',
  input_schema: { type: 'object', properties: { check: { type: 'boolean' } }, required: [] },
};
export async function run(api, input) {
  const st = await api.gateway('brave', 'status', {});
  if (!st?.connected || !input?.check) return st;
  const p = await api.gateway('brave', 'probe', {});
  return { ...st, answering: !!p?.ok, error: p?.ok ? null : p?.error };
}
