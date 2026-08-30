// WORKFLOWS layer registry (nyyon-lite layer 3).
//
// A workflow is an ordered list of EXISTING tools with no business logic of
// its own — a generic runner threads a shared context through the steps.
// Today the definitions live in the D1 `workflows` table (surfaced via
// lib/db.js listWorkflows) and are display-only; the executing runner lands in
// refactor step 7. This index is the layer-dir entry point the validator
// enforces and the home for the runner + any code-defined workflow specs.
//
// Re-exported so the workflow layer has a single machine-readable seam while
// the D1-backed definitions and the (pending) runner converge here.

export { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns } from '../lib/db.js';
export { runWorkflow, validateWorkflowSteps, seedSystemWorkflows } from './runner.js';

// The per-family workflow catalogs the runner seeds from — re-exported here so
// the layer directory has one machine-readable entry point (what the validator
// walks, and what a new family adds itself to).
export { workflows as coreWorkflows } from './seeds/core.js';
export { workflows as blogWorkflows } from './seeds/blog.js';
export { workflows as socialWorkflows } from './seeds/social.js';
export { workflows as hotTakesWorkflows } from './seeds/hottakes.js';
