// Blog featured-image CANDIDATE RENDERER — sits on top of the generic
// image-gateway and renders N candidate images for a post into R2.
//
// This file is the host half of the `render` gateway's `images` mode. The
// editorial plugin owns everything that THINKS about featured images (the
// visual-brief drafter, the style knowledge doc, the vision judge, the
// featured-image write-back, the routes/tools); the model keys + R2 byte
// handling stay here: prompt in, stored candidate URLs out.

import { renderImage, storeImageBytes } from './image-gateway.js';
import { logEvent } from './db.js';
import { now } from './util.js';

// How many candidates to render per blog. The plugin's vision judge picks the
// winner from the stored URLs.
const CANDIDATES_PER_RUN = 3;

// Negative prompt for the Workers-AI (flux/sdxl) models — steers them away
// from the things the house style forbids. (Was referenced but never defined,
// which made every Workers-AI render throw "NEGATIVE is not defined".)
const NEGATIVE = 'text, words, letters, captions, watermark, logo, signature, brand marks, people, faces, hands, body parts, phones, computers, buildings, blurry, low quality, distorted, deformed, jpeg artifacts';

// Workers don't have a global RNG seed control but Math.random() is fine for
// picking diverse Flux seeds. We use ints in the uint32 range — what Flux expects.
function randomSeed() {
  return Math.floor(Math.random() * 0xFFFFFFFF);
}

// Render N candidates and store them. ⚙️ The loop stays inside this one mode
// because the raw bytes must never enter the model's context: each candidate
// is written to R2 and only its URL travels onward.
export async function renderCandidateImages(env, { blog_slug = null, slug = null, prompt = null, n = null, model = null } = {}) {
  const target = blog_slug || slug || null;
  if (!target) throw new Error('render_images: blog_slug required');
  if (!prompt) throw new Error('render_images: prompt required');

  const count = Number(n) > 0 ? Math.min(Number(n), 4) : CANDIDATES_PER_RUN;
  const chosen = model || (env.OPENAI_API_KEY ? 'gpt-image-1' : 'flux-schnell');
  const isDalle = ['dall-e-3', 'dall-e-2', 'gpt-image-1'].includes(chosen);
  const startedAt = now();

  let rendered;
  if (isDalle) {
    rendered = [];
    for (let i = 0; i < count; i++) rendered.push(await renderImage(env, { prompt, model: chosen }));
  } else {
    const seeds = Array.from({ length: count }, randomSeed);
    rendered = await Promise.all(seeds.map((seed) => renderImage(env, {
      prompt, model: chosen, width: 1280, height: 720, negative_prompt: NEGATIVE, steps: 4, seed,
    })));
  }

  const candidates = [];
  for (let i = 0; i < rendered.length; i++) {
    const c = rendered[i];
    const key = `blog/${target}-cand-${startedAt}-${i + 1}.png`;
    const url = await storeImageBytes(env, key, c.bytes, {
      kind: 'blog_featured_candidate', slug: target, model: c.model, seed: String(c.seed ?? ''), generated_at: String(startedAt),
    });
    candidates.push({ url, key, model: c.model, seed: c.seed ?? null, size_bytes: c.size_bytes, width: c.width, height: c.height });
  }
  await logEvent(env, { kind: 'blog_image_candidates_rendered', actor: 'system', payload: { slug: target, count: candidates.length, model: chosen } });
  return { blog_slug: target, prompt, candidates };
}
