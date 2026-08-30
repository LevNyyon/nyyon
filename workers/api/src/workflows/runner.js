// The minimal workflow runner (nyyon-lite layer 3, "Phase 2" the 0013
// migration promised). A workflow is an ordered list of EXISTING tools with no
// logic of its own; this generic runner threads a shared context through the
// steps and writes the full audit trail (workflow_runs + workflow_step_runs).
//
// Step shapes accepted (the D1 `workflows.steps` JSON array):
//   "tool_name"                          — run with the shared ctx input
//   { "tool": "tool_name" }              — same
//   { "tool": "tool_name", "input": {} } — fixed input, merged over shared ctx
//   { "tool": "tool_name", "optional": true } — a failure is RECORDED, not fatal
// Each step's result lands in ctx.results[i] and (if an object) is shallow-
// merged into ctx.shared so later steps can consume earlier outputs — the
// "generic runner threads a shared context" contract, nothing smarter.
//
// `optional` exists because some steps are genuinely best-effort: a figure
// that fails to render must never destroy the article that was already saved.
// It is error POLICY, not branching — the step list stays linear and every
// step still runs in order.

import { runTool } from '../tools/index.js';
import { uid, now } from '../lib/util.js';

function normalizeStep(s, i) {
  if (typeof s === 'string') return { tool: s, input: null, optional: false, index: i };
  if (s && typeof s === 'object' && typeof s.tool === 'string') {
    return { tool: s.tool, input: s.input ?? null, optional: s.optional === true, index: i };
  }
  return null;
}

// Validate steps against the live tool pool — used by write_workflow and the
// dev bench so an authored workflow can't reference a tool that doesn't exist.
export async function validateWorkflowSteps(env, steps) {
  const problems = [];
  if (!Array.isArray(steps) || !steps.length) return ['steps must be a non-empty array'];
  const { visibleToolDefs } = await import('../tools/index.js');
  const pool = new Set((await visibleToolDefs(env)).map((d) => d.name));
  steps.forEach((s, i) => {
    const st = normalizeStep(s, i);
    if (!st) problems.push(`step ${i}: not a tool name or {tool, input} object`);
    else if (!pool.has(st.tool)) problems.push(`step ${i}: tool "${st.tool}" not in the shared pool`);
  });
  return problems;
}

export async function runWorkflow(env, slug, input = {}, { trigger_kind = 'manual' } = {}) {
  const row = await env.DB.prepare(
    'SELECT slug, name, steps, status FROM workflows WHERE slug = ?',
  ).bind(slug).first();
  if (!row) return { ok: false, error: `unknown workflow "${slug}"` };
  if (row.status === 'disabled') return { ok: false, error: `workflow "${slug}" is disabled` };

  let rawSteps;
  try { rawSteps = JSON.parse(row.steps); } catch { return { ok: false, error: 'steps JSON is invalid' }; }
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).map(normalizeStep).filter(Boolean);
  if (!steps.length) return { ok: false, error: 'workflow has no runnable steps (observability-only definition?)' };

  const runId = 'wr_' + uid();
  const startedAt = now();
  await env.DB.prepare(
    `INSERT INTO workflow_runs (id, workflow_slug, status, trigger_kind, trigger_payload, started_at)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).bind(runId, slug, trigger_kind, JSON.stringify(input || {}), startedAt).run();

  const ctx = { input: input || {}, shared: { ...(input || {}) }, results: [] };
  const skipped = []; // optional steps that failed — reported, never fatal
  for (const step of steps) {
    const stepId = 'wsr_' + uid();
    const t0 = now();
    await env.DB.prepare(
      `INSERT INTO workflow_step_runs (id, run_id, step_index, step_name, step_type, input, started_at)
       VALUES (?, ?, ?, ?, 'tool', ?, ?)`,
    ).bind(stepId, runId, step.index, step.tool, JSON.stringify(step.input ?? ctx.shared), t0).run();
    try {
      const result = await runTool(env, step.tool, step.input ? { ...ctx.shared, ...step.input } : ctx.shared);
      ctx.results.push({ tool: step.tool, ok: true, result });
      if (result && typeof result === 'object' && !Array.isArray(result)) Object.assign(ctx.shared, result);
      await env.DB.prepare(
        `UPDATE workflow_step_runs SET status='succeeded', output=?, finished_at=? WHERE id=?`,
      ).bind(JSON.stringify(result).slice(0, 20000), now(), stepId).run();
    } catch (e) {
      const error = String(e?.message || e).slice(0, 1000);
      ctx.results.push({ tool: step.tool, ok: false, optional: step.optional, error });
      await env.DB.prepare(
        `UPDATE workflow_step_runs SET status=?, error=?, finished_at=? WHERE id=?`,
      ).bind(step.optional ? 'skipped' : 'failed', error, now(), stepId).run();
      // Best-effort step: record it and carry on with whatever context we have.
      if (step.optional) { skipped.push({ step: step.index, tool: step.tool, error }); continue; }
      await env.DB.prepare(
        `UPDATE workflow_runs SET status='failed', error=?, finished_at=? WHERE id=?`,
      ).bind(`step ${step.index} (${step.tool}): ${error}`, now(), runId).run();
      return { ok: false, run_id: runId, failed_step: step.index, tool: step.tool, error, results: ctx.results };
    }
  }

  await env.DB.prepare(
    `UPDATE workflow_runs SET status='succeeded', output=?, finished_at=? WHERE id=?`,
  ).bind(JSON.stringify({ steps: steps.length, skipped }).slice(0, 20000), now(), runId).run();
  return { ok: true, run_id: runId, steps: steps.length, skipped, results: ctx.results, output: ctx.shared };
}

// The system workflow catalog (architecture v2): every definition lives in a
// per-family file under seeds/, so a family owns its own chains and two
// families can never collide in one list. Each entry is
// { slug, name, description, trigger, steps } — steps are tool names or
// {tool, input?, optional?} objects the runner above understands.
//
// Seeding UPSERTS, but only over rows still marked source='system'. INSERT OR
// IGNORE was wrong across a definition change: the stale row already in D1 won
// forever, so the architecture-v2 step lists could never land (the one-step
// `social-drafts-for-article` row would have kept calling a tool that no longer
// exists, failing every publish fan-out). An operator edit still wins, because
// writeWorkflow stamps source='nyo' on any edited row and the UPDATE skips it.
import { workflows as coreWorkflows } from './seeds/core.js';

// The prospecting + outreach seed files went with the GTM plugin conversion,
// and the blog/social/hottakes seed files with the editorial one: each pack
// ships its workflow slugs in its own manifest now.
const SYSTEM_WORKFLOWS = [
  ...coreWorkflows,
];

export async function seedSystemWorkflows(env) {
  const t = now();
  for (const w of SYSTEM_WORKFLOWS) {
    await env.DB.prepare(
      `INSERT INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'system', 'active', ?, ?, 'system')
       ON CONFLICT(slug) DO UPDATE SET
         name=excluded.name, description=excluded.description,
         trigger=excluded.trigger, steps=excluded.steps, updated_at=excluded.updated_at
       WHERE workflows.source = 'system'`,
    ).bind(
      w.slug, w.name, w.description || '',
      JSON.stringify(w.trigger || { kind: 'on-demand' }),
      JSON.stringify(w.steps || []), t, t,
    ).run();
  }
  return { seeded: SYSTEM_WORKFLOWS.length };
}
