// Editorial plugin — draft_hottake_take. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api,
// callGateway → api.gateway, shared code in the pack's parallel lib (same
// function names, api first). topicContext is inlined per the contract.

import { readPackage, patchPackage, listPackages, loadPovLibrary, loadPlaybook } from './hot-takes.mjs';

// The topic as the drafters see it — one shape, so take and brief argue about
// the same facts.
function topicContext(pkg) {
  return [
    `TOPIC: ${pkg.title || 'Untitled'}`,
    pkg.summary ? `What happened: ${pkg.summary}` : '',
    pkg.why_it_matters ? `Why it may matter: ${pkg.why_it_matters}` : '',
    pkg.source_name || pkg.source_url ? `Source: ${pkg.source_name || ''} ${pkg.source_url || ''}`.trim() : '',
    pkg.company_notes ? `Company notes: ${pkg.company_notes}` : '',
    pkg.author_notes ? `Author notes: ${pkg.author_notes}` : '',
  ].filter(Boolean).join('\n');
}

export const def = {
  name: 'draft_hottake_take',
  description: 'Propose the company\'s take on a package\'s topic: a specific, defensible argument (never a neutral summary) plus what the company believes, what is commonly misunderstood, who should care, and what the reader should do differently. Saves it on the package for the operator to confirm or rewrite.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const pkg = await readPackage(api, input.id);
  if (!pkg) return { error: 'package not found' };
  const [pov, playbook, prior] = await Promise.all([
    loadPovLibrary(api), loadPlaybook(api),
    listPackages(api, { statuses: ['published', 'complete'], limit: 6 }),
  ]);
  const priorTakes = prior.filter((p) => p.take).map((p) => `- ${p.title}: ${p.take}`).join('\n');
  const out = await api.gateway('llm', 'json', {
    system: `${playbook.body}\n\nReturn ONLY JSON: {"take","believe","misunderstood","who_cares","reader_action"}. take = the proposed argument, 1-3 sentences, specific and opinionated. The other four are one sentence each.`,
    prompt: `## Point-of-View Library\n${pov.body}\n\n${priorTakes ? `## Prior published takes (stay consistent, don't repeat)\n${priorTakes}\n\n` : ''}## The topic\n${topicContext(pkg)}`,
    max_tokens: 900,
    heavy: true,
  });
  if (!out?.take) return { error: 'drafter returned no take' };
  return {
    package: await patchPackage(api, input.id, {
      take: out.take, believe: out.believe || null, misunderstood: out.misunderstood || null,
      who_cares: out.who_cares || null, reader_action: out.reader_action || null,
      status: 'take',
    }, input.actor || 'hot-takes'),
  };
}
