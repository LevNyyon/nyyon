// Article-figure RENDERER — draw editorial diagrams + the featured cover to
// PNG (resvg WASM + bundled fonts) and store them in R2.
//
// This file is the host half of the `render` gateway's `figures` and `cover`
// modes. The editorial plugin owns everything that THINKS about figures (the
// spec drafter, the chart-selection knowledge, anchor placement/embedding, the
// judge, the routes/tools); WASM + binary fonts cannot travel in a plugin's
// single-file tools, so the pixel work stays here: specs in, stored URLs out.
//
// The template catalog (FIGURE_TEMPLATES / FEATURED_TEMPLATE) lives in
// article-figures-templates.js + article-figures-charts.js beside this file —
// the single source of pixel truth; the plugin carries only each template's
// slot DESCRIPTION for its drafter prompt.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '../../node_modules/@resvg/resvg-wasm/index_bg.wasm';

import interRegular from '../assets/fonts/Inter-Regular.ttf';
import interSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import interBold from '../assets/fonts/Inter-Bold.ttf';
import monoMedium from '../assets/fonts/JetBrainsMono-Medium.ttf';
import monoBold from '../assets/fonts/JetBrainsMono-Bold.ttf';

import { FIGURE_TEMPLATES, FEATURED_TEMPLATE } from './article-figures-templates.js';
import { storeImageBytes } from './image-gateway.js';
import { readBlogPost, logEvent, stripDashes } from './db.js';
import { now } from './util.js';

let wasmReady = null;

async function renderPng(svg, width) {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 },  // 2x for crisp
    font: {
      fontBuffers: [
        new Uint8Array(interRegular),
        new Uint8Array(interSemiBold),
        new Uint8Array(interBold),
        new Uint8Array(monoMedium),
        new Uint8Array(monoBold),
      ],
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  return resvg.render().asPng();
}

// Strip en/em dashes from every string in a figure/cover slot tree before it is
// rendered into a PNG. The body strip can't fix text baked into an image, so the
// no-dash rule has to be enforced here too (deep walk: strings, arrays, objects).
function stripSlots(v) {
  if (v == null) return v;
  if (typeof v === 'string') return stripDashes(v);
  if (Array.isArray(v)) return v.map(stripSlots);
  if (typeof v === 'object') { const o = {}; for (const k in v) o[k] = stripSlots(v[k]); return o; }
  return v;
}

// Render the designed specs to stored PNGs. A single template that fails to
// render is dropped (logged) rather than losing the whole set. Carries each
// spec's anchor/featured/alt through so the plugin can place the results.
export async function renderFigures(env, { blog_slug = null, slug = null, specs = null } = {}) {
  const target = blog_slug || slug || null;
  if (!target) throw new Error('render_figures: blog_slug required');
  if (!Array.isArray(specs) || !specs.length) throw new Error('render_figures: specs required');
  const startedAt = now();

  const figures = [];
  for (const spec of specs) {
    const tpl = FIGURE_TEMPLATES[spec.template];
    if (!tpl) continue;
    try {
      const svg = tpl.build(stripSlots(spec.slots));
      const png = await renderPng(svg, tpl.width);
      // Versioned key: the r2.dev CDN serves a same-key overwrite stale, so a
      // regenerated figure would never show up live (the regenerateCover lesson).
      const key = `blog-figures/${target}-fig-${startedAt}-${figures.length + 1}.png`;
      const url = await storeImageBytes(env, key, png, {
        kind: 'article_figure', template: spec.template, slug: target, generated_at: String(startedAt),
      });
      figures.push({
        template: spec.template, url, key, size_bytes: png.length, slots: spec.slots,
        anchor: spec.anchor || null, featured: !!spec.featured, alt: spec.alt || null,
        fig_label: spec.slots?.fig_label || null,
      });
    } catch (renderErr) {
      console.error(`[render-figures] ${spec.template} failed:`, renderErr?.message || renderErr);
    }
  }
  if (!figures.length) throw new Error('render_figures: no figures rendered successfully');
  await logEvent(env, { kind: 'article_figures_generated', actor: 'system', payload: { slug: target, count: figures.length } });
  return { blog_slug: target, figures };
}

// Render the cover PNG (1200x630 hero). Deterministic fallback slots (first
// tag + title + excerpt) mean this works with or without a drafted cover, so a
// failed draft still yields a real cover.
export async function renderCover(env, { blog_slug = null, slug = null, title = null, excerpt = null, cover = null } = {}) {
  const target = blog_slug || slug || null;
  let t = title, e = excerpt, firstTag = null;
  if (target) {
    const post = await readBlogPost(env, target);
    if (!post && !t) throw new Error(`render_cover: blog post not found: ${target}`);
    if (post) {
      t = t || post.title; e = e || post.excerpt;
      try {
        const parsed = JSON.parse(post.tags || '[]');
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') firstTag = parsed[0];
      } catch { /* tags may be a plain string or null — NYYON is the fallback */ }
    }
  }
  if (!t) throw new Error('render_cover: title required');

  const startedAt = now();
  const svg = FEATURED_TEMPLATE.build(stripSlots({
    kicker:    cover?.kicker || firstTag || 'NYYON',
    title:     t,
    highlight: cover?.highlight || '',
    sub:       cover?.sub || e || '',
  }));
  const png = await renderPng(svg, FEATURED_TEMPLATE.width);
  // Versioned key — a same-key overwrite is served stale by the r2.dev CDN, so
  // a refreshed cover would never reach the reader.
  const cover_key = `blog-figures/${target || 'cover'}-cover-${startedAt}.png`;
  const cover_url = await storeImageBytes(env, cover_key, png, {
    kind: 'article_cover', slug: target || '', generated_at: String(startedAt),
  });
  // Deliberately no generic `url` key: set_featured_image reads cover_url, and
  // a bare `url` in a workflow's shared context is a trap for later steps.
  return { blog_slug: target, cover_url, cover_key };
}
