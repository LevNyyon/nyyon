// Digest plugin — prioritize_signals. Ported from cmd's tools/digest.js
// pool: the sweep scores unscored signals, then refreshes the contacted
// chips (mechanical) and the heat bars.

import { sweepSignalPriorities, refreshContactedFlags } from './signal-priority.mjs';
import { refreshLeadHeat } from './lead-heat.mjs';

export const def = {
  name: 'prioritize_signals',
  description: 'Score every unread, unscored digest LI signal (bounded batch) so the brief reads super-relevant first and general activity last. Safe to run repeatedly; scored items are skipped. Rubric and thresholds live in the plugin-digest-signal-priority knowledge doc.',
  input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'max signals this run (default from the doc)' } } },
};

export async function run(api, input) {
  const swept = await sweepSignalPriorities(api, { limit: input?.limit });
  // keep the cards' contacted chips honest on every run (mechanical, no LLM)
  let flags = null, flagsError = null;
  try { flags = await refreshContactedFlags(api); } catch (e) { flagsError = String((e && e.message) || e).slice(0, 200); }
  let heat = null;
  try { heat = await refreshLeadHeat(api); } catch { /* heat is decoration; never fail the sweep for it */ }
  return { ...swept, contacted_flags: flags ? flags.changed : null, contacted_flags_error: flagsError, heat: heat ? heat.changed : null };
}
