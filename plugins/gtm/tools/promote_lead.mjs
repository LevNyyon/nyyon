// GTM plugin — promote_lead. Ported from workers/api/src/tools/prospecting.js.
// The host original called lib/pipeline.js promoteLeadToPipeline(env, id, actor)
// directly; clients/contacts/pipeline are HOST tables a plugin may not write, so
// the same function is reached through the crm gateway's `promote` mode (which
// wraps promoteLeadToPipeline host-side — same idempotency, same result shape).

export const def = {
  name: 'promote_lead',
  description: "Promote a prospect into the Pipeline CRM as a linked contact + client at stage 'target'. Idempotent — re-running returns the existing client instead of creating a second one.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  return api.gateway('crm', 'promote', { id: input.id, actor: input.actor || 'operator' });
}
