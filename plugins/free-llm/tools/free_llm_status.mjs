export const def = {
  name: 'free_llm_status',
  description: 'Every free provider this install knows: connected or not, which model, and which one is the active backup brain. Pass check:true to also confirm the active one answers with a real request.',
  input_schema: {
    type: 'object',
    properties: { check: { type: 'boolean' } },
    required: [],
  },
};

export async function run(api, input) {
  const providers = [];
  for (const p of ['groq']) {
    const s = await api.gateway(p, 'status', {});
    providers.push({ provider: p, ...s });
  }
  const active = providers.find((p) => p.connected && p.active);
  if (!input?.check || !active) return { providers, active: active?.provider || null };
  const probe = await api.gateway(active.provider, 'probe', {});
  return { providers, active: active.provider, answering: !!probe?.ok, error: probe?.ok ? null : probe?.error };
}
