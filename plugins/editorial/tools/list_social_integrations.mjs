// Editorial plugin — list_social_integrations. Ported verbatim from the host
// social tools (workers/api/src/tools/social.js); callGateway → api.gateway,
// no other logic.

export const def = {
  name: 'list_social_integrations',
  description: "List the social CONNECTIONS posts can go out through and whether each is configured: linkedin-company (the Nyyon page, the default for LinkedIn), linkedin-personal (the operator's personal profile, opt-in), facebook-company. Call this before drafting or approving so you name a channel that actually works.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { connections: await api.gateway('social', 'connections', {}) };
}
