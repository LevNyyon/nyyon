// Editorial plugin — read_signal. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { readSignalContent, signalQuestionSeed } from './heartbeat.mjs';

export const def = {
  name: 'read_signal',
  description: 'Read the full article behind one signal, not just its headline (fetched and cached on first read). Use before reacting to a piece of news, and as the first step of turning a signal into an article — it also returns the question, notes and expert context that seed one.',
  input_schema: { type: 'object', properties: { signal_id: { type: 'string' } }, required: ['signal_id'] },
};

export async function run(api, input) {
  const sig = await readSignalContent(api, input.signal_id);
  if (!sig) return { ok: false, error: 'signal not found' };
  // The seed keys (question/notes/priority/expert_context) are deterministic
  // field selection done in the lib — they exist so the question-writing
  // step downstream reads them straight off the context.
  const seed = signalQuestionSeed(sig);
  return {
    ok: !!sig.full_text,
    signal_id: sig.id,
    title: sig.title,
    source: sig.source_name,
    url: sig.url,
    summary: sig.summary || null,
    angle: sig.suggested_angle || null,
    content: sig.full_text || null,
    ...seed,
    ...(sig.full_text ? {} : { error: `couldn't fetch the article (paywall, JS-only, or blocked). URL: ${sig.url}` }),
  };
}
