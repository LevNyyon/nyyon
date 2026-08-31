// Editorial plugin — scan_hottake_article. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api,
// callGateway → api.gateway, shared code in the pack's parallel lib (same
// function names, api first). stripHtml is inlined per the contract.

import { articleView, patchPackage, loadQualityRules } from './hot-takes.mjs';

// Crude tag-strip so a pasted page is cheap + safe to hand the model.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const def = {
  name: 'scan_hottake_article',
  description: 'Scan a package\'s written article for review: pull out the factual claims that matter (typed directly_supported / company_experience / opinion / unsupported, each confirmed or needing confirmation) and flag concrete quality weaknesses. Decision support for the operator — it never approves anything.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const view = await articleView(api, input.id);
  if (!view?.article?.body) return { error: 'no article yet — write it first' };
  const rules = await loadQualityRules(api);
  const plain = stripHtml(view.article.body).slice(0, 16000);
  const out = await api.gateway('llm', 'json', {
    system: `You are an editorial fact-and-quality reviewer. Apply these rules:\n${rules.body}\n\nReturn ONLY JSON: {"claims":[{"text","support":"directly_supported|company_experience|opinion|unsupported","source","status":"needs_confirmation|confirmed"}],"quality_flags":[{"kind","section","note","severity":"high|medium|low"}]}. claims = the 4-10 factual statements that MATTER to the argument (quote them short). status = needs_confirmation when support is unsupported or shaky, else confirmed. quality_flags = concrete weaknesses only; empty array if genuinely clean.`,
    prompt: `## Article: ${view.article.title}\n\n${plain}\n\n## The intended argument\n${view.package.take || ''}\n\n## Source under discussion\n${view.package.source_name || ''} ${view.package.source_url || ''}`,
    max_tokens: 1600,
    heavy: true,
  });
  const review = {
    claims: Array.isArray(out?.claims) ? out.claims : [],
    // Flags land unresolved: resolving one is an operator act, never the
    // scanner's.
    quality_flags: (Array.isArray(out?.quality_flags) ? out.quality_flags : []).map((f) => ({ ...f, resolved: false })),
    scanned_at: Date.now(),
  };
  const pkg = await patchPackage(api, input.id, { review, status: 'review' }, input.actor || 'hot-takes');
  return {
    package: pkg,
    open_claims: review.claims.filter((c) => c.status === 'needs_confirmation').length,
    flags: review.quality_flags.length,
  };
}
