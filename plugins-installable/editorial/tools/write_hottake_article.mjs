// Editorial plugin — write_hottake_article. Surface entry point for the old
// POST /api/hot-takes/packages/:id/write-article route (the host kept it on
// lib writeArticleFromBrief; here that lib entry gets its own thin tool). The
// heavy compose step is composeAndSavePost from the AEO writer, handed in as
// the { compose } seam the lib requires (lib files import nothing).

import { writeArticleFromBrief } from './hot-takes.mjs';
import { composeAndSavePost } from './aeo-writer.mjs';

export const def = {
  name: 'write_hottake_article',
  description: 'Write the full article from a package\'s approved brief — the long step (about a minute): seed from the take + brief, compose in house HTML, save as a blog draft and link it back to the package (status → review). Never overwrites an approved take; run it once the brief is approved.',
  input_schema: {
    type: 'object',
    properties: {
      id:    { type: 'string', description: 'package id' },
      voice: { type: 'string', enum: ['house', 'personal'], description: 'default house' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  try {
    return await writeArticleFromBrief(api, input.id, {
      voice: input.voice || 'house',
      actor: input.actor || 'operator',
      compose: composeAndSavePost,
    });
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
