// GTM plugin — promote_lead. Ported from workers/api/src/tools/prospecting.js.
// The host original called lib/pipeline.js promoteLeadToPipeline(env, id, actor)
// directly; clients/contacts/pipeline are HOST tables a plugin may not write, so
// the same function is reached through the crm gateway's `promote` mode (which
// wraps promoteLeadToPipeline host-side — same idempotency, same result shape).

export const def = {
  name: 'promote_lead',
  description: 'Promote a prospect into a CRM deal. Not available on this install: the host CRM here writes contacts but has no deal pipeline, so this reports that plainly.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  // Deal promotion is a host CRM mode this install does not carry (it writes
  // contacts only). Said plainly instead of throwing.
  return { ok: false, error: 'Promoting a lead into a deal is not available on this install. The lead stays in prospecting; write the contact instead.' };
}
