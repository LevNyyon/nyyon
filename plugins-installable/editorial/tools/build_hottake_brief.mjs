// Editorial plugin — build_hottake_brief. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api,
// callGateway → api.gateway, shared code in the pack's parallel lib (same
// function names, api first). topicContext is inlined per the contract.

import { readPackage, patchPackage, loadPlaybook, loadPatterns } from './hot-takes.mjs';

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
  name: 'build_hottake_brief',
  description: 'Build the short editorial brief from a package\'s approved take: argument, audience, why-now, 3-5 supporting points, evidence, likely objections, conclusion, and the publication pattern that fits. Run before the article is written so the operator can adjust cheaply.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const pkg = await readPackage(api, input.id);
  if (!pkg) return { error: 'package not found' };
  if (!pkg.take) return { error: 'no take yet — run draft_hottake_take first' };
  const [playbook, patterns] = await Promise.all([loadPlaybook(api), loadPatterns(api)]);
  const out = await api.gateway('llm', 'json', {
    system: `${playbook.body}\n\nReturn ONLY JSON: {"argument","audience","why_now","points":[3-5 strings],"evidence":[strings],"objections":[strings],"conclusion","pattern"}. pattern = which publication pattern fits (name it). Points must each ADVANCE the argument, not restate it.`,
    prompt: `## Publication patterns\n${patterns.body}\n\n## The approved take\n${pkg.take}\nBelieve: ${pkg.believe || ''}\nMisunderstood: ${pkg.misunderstood || ''}\nWho cares: ${pkg.who_cares || ''}\nReader action: ${pkg.reader_action || ''}\n\n## The topic\n${topicContext(pkg)}`,
    max_tokens: 1200,
    heavy: true,
  });
  if (!out?.argument || !Array.isArray(out.points)) return { error: 'brief builder returned no argument/points' };
  return { package: await patchPackage(api, input.id, { brief: out, status: 'brief' }, input.actor || 'hot-takes') };
}
