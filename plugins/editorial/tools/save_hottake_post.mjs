// Editorial plugin — save_hottake_post. Surface entry point for the old
// PATCH /api/hot-takes/posts/:postId route: patch one release leg — text,
// notes, image, status (approve = 'scheduled', hold = 'ready', skip =
// 'not_planned') or its scheduled time.

import { patchPost } from './hot-takes.mjs';

export const def = {
  name: 'save_hottake_post',
  description: 'Patch one Hot Takes release leg (a social post): body, notes, image_url, status or scheduled_at. Approving is status:"scheduled" — the one state the hourly due-scan sends; "ready" holds it back; "not_planned" skips it.',
  input_schema: {
    type: 'object',
    properties: {
      id:           { type: 'string' },
      body:         { type: 'string' },
      notes:        { type: 'string' },
      image_url:    { type: 'string' },
      status:       { type: 'string', description: 'draft|ready|scheduled|not_planned|skipped' },
      scheduled_at: { type: 'number', description: 'ms epoch' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  const { id, actor, ...patch } = input || {};
  try {
    return { post: await patchPost(api, id, patch, actor || 'operator') };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
