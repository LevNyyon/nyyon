// The Nyo tool pool — one shared pool assembled from the nine family files.
//
// v2 (granular): every tool here is ONE verb on ONE noun, JSON in / JSON out.
// Anything that used to be a multi-step "tool" is now a WORKFLOW over these
// (workers/api/src/workflows/seeds/), which is why the pool reads flat and
// boring: complexity lives in the step lists, not inside a tool.
//
// Spread order is the order the model sees the defs in; families are ordered
// by how often the operator reaches for them.

import { flagsAsObject } from '../lib/db.js';
import { tools as coreTools } from './core.js';
import { tools as plannerTools } from './planner.js';
import { tools as waTools } from './wa.js';
import { tools as outreachTools } from './outreach.js';
import { tools as prospectingTools } from './prospecting.js';
import { tools as blogTools } from './blog.js';
import { tools as socialTools } from './social.js';
import { tools as hotTakesTools } from './hottakes.js';
import { tools as linkedinTools } from './li.js';
import { tools as pluginMgmtTools } from './plugins.js';
import { pluginTools } from '../plugins/index.js';

const TOOL_REGISTRY = {
  ...coreTools,
  ...plannerTools,
  ...waTools,
  ...outreachTools,
  ...prospectingTools,
  ...blogTools,
  ...socialTools,
  ...hotTakesTools,
  ...linkedinTools,
  ...pluginMgmtTools,
  // Installed plugins land last — the host pool always wins a name clash
  // (import validation refuses clashes anyway; this is defense in depth).
  ...pluginTools,
};

export async function visibleToolDefs(env) {
  const flags = await flagsAsObject(env);
  return Object.entries(TOOL_REGISTRY)
    .filter(([name]) => flags[`tool.${name}`] !== false) // default-on
    .map(([, t]) => t.def);
}

// `ctx` carries per-turn context the caller knows but the model doesn't — today
// just the active conversation id, so a tool can refuse to destroy the thread
// it is running inside. Optional: every other caller passes nothing.
export async function runTool(env, name, input, ctx = {}) {
  const t = TOOL_REGISTRY[name];
  if (!t) throw new Error(`unknown tool ${name}`);
  const flags = await flagsAsObject(env);
  if (flags[`tool.${name}`] === false) throw new Error(`tool ${name} is disabled by feature flag`);
  return t.run(env, input || {}, ctx);
}

