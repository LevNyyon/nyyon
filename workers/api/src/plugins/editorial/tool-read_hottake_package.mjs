// Editorial plugin — read_hottake_package. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first). releaseChannels is
// async in the pack (it reads a knowledge doc instead of env), so it is
// awaited here; the result shape is unchanged.

import { readPackage, listPosts, computeNextAction, releaseChannels } from './hot-takes.mjs';

export const def = {
  name: 'read_hottake_package',
  description: 'Read one Hot Takes package by id: its full topic/take/brief/article/review state, its social legs, and the single next action the operator should take.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const pkg = await readPackage(api, input.id);
  if (!pkg) return { found: false };
  const posts = await listPosts(api, input.id);
  return { found: true, package: pkg, posts, next_action: computeNextAction(pkg, posts, await releaseChannels(api)) };
}
