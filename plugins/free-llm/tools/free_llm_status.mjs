export const def = {
  name: 'free_llm_status',
  description: "What free backup model this install has connected, if any. Pass check:true to spend one tiny request confirming it still answers.",
  input_schema: {
    type: 'object',
    properties: { check: { type: 'boolean', description: 'also make one real request to confirm it answers' } },
    required: [],
  },
};

export async function run(api, input) {
  const status = await api.gateway('backup-llm', 'status', {});
  if (!status?.connected) return { connected: false, providers: status?.providers || [] };
  if (!input?.check) return status;
  const probe = await api.gateway('backup-llm', 'probe', {});
  return { ...status, answering: !!probe?.ok, error: probe?.ok ? null : probe?.error || null };
}
