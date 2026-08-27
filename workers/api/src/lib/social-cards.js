// Social-card generator — code-drawn, brand-locked SVG cards rendered to PNG
// in-worker via resvg (WASM). No AI image model in the loop: the layout is a
// fixed template, an LLM only fills the text slots (headline, labels, items),
// so every card is pixel-exact brand and costs one cheap text call (~$0.001).
//
// Visual system (approved June 2026, replaces AI-image attempts for social):
// strict paper/ink monochrome — paper #FAFAF9, ink #0A0A0A, warm
// grays — Inter for headlines, JetBrains Mono for kickers/labels. Same tokens
// as the public site's CSS variables. Templates:
//
//   split     1200x627  two-state contrast (scattered gray noise vs ink grid)
//   statement 1080x1080 one sharp claim, oversized type
//   checklist 1200x627  3-5 checked items — criteria/tests/steps
//   flow      1200x627  entry → step boxes → exit, for process articles
//
// Callers: HTTP route /api/social-cards/generate, Nyo tool
// generate_social_card. All funnel through generateSocialCard().

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '../../node_modules/@resvg/resvg-wasm/index_bg.wasm';

import interRegular from '../assets/fonts/Inter-Regular.ttf';
import interSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import interBold from '../assets/fonts/Inter-Bold.ttf';
import monoMedium from '../assets/fonts/JetBrainsMono-Medium.ttf';
import monoBold from '../assets/fonts/JetBrainsMono-Bold.ttf';

import { storeImageBytes } from './image-gateway.js';
import { readBlogPost, logEvent, logWorkflowRun } from './db.js';
import { callOpenAIText } from './openai.js';
import { now } from './util.js';

// ─── brand tokens (mirror the public site's CSS variables) ──────────────
const PAPER  = '#FAFAF9';
const INK    = '#0A0A0A';
const MUTE   = '#78716C';
const LINE   = '#E7E5E4';
const CARDHI = '#F5F5F4';

// Google-Fonts static instances rename non-RIBBI weights into their own
// family ("Inter SemiBold", "JetBrains Mono Medium"), so font-family lists
// carry both spellings — resvg picks whichever the buffer registered as.
const SANS      = 'Inter';
const SANS_SEMI = 'Inter SemiBold, Inter';
const MONO      = 'JetBrains Mono';
const MONO_MED  = 'JetBrains Mono Medium, JetBrains Mono';

// ─── svg helpers ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Crude width estimate (px) — good enough to shrink type that would overflow.
// Inter ~0.55em average advance, JetBrains Mono is fixed at 0.6em.
function fitSize(text, maxWidth, baseSize, { mono = false, min = 0.55 } = {}) {
  const factor = mono ? 0.62 : 0.55;
  let size = baseSize;
  const floor = Math.round(baseSize * min);
  while (size > floor && text.length * size * factor > maxWidth) size -= 2;
  return size;
}

function frame(w, h, inset = 26) {
  return `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" fill="none" stroke="${INK}" stroke-width="2"/>`;
}

function kicker(x, y, text) {
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="4" fill="${INK}">${esc(text)}</text>`;
}

// Brand-mark placeholder, top-right — an abstract two-bar mark (64x70 path,
// fill #262424) standing in until the operator's own logo replaces it: swap
// LOGO_PATH (and the fill) to rebrand every card at once.
const LOGO_PATH = 'M33,0 L64,0 L64,66 L33,50 L33,0 Z M0,4 L31,20 L31,70 L0,70 L0,4 Z';

function wordmark(w, y = 92) {
  const mh = 26;                                // mark height
  const mw = Math.round(mh * (64 / 70));        // mark width, source ratio
  const mx = w - 62 - mw;
  const my = y - 21;                            // optically centered on the kicker baseline
  return `<g transform="translate(${mx} ${my}) scale(${(mh / 70).toFixed(4)})"><path d="${LOGO_PATH}" fill="#262424"/></g>`;
}

// Mark only, no text — for layouts where the full lockup gets crowded
// (statement square: the top-right decorative circle).
function markOnly(x, y, height = 30) {
  return `<g transform="translate(${x} ${y}) scale(${(height / 70).toFixed(4)})"><path d="${LOGO_PATH}" fill="#262424"/></g>`;
}

function tri(cx, cy, r, rot, fill, stroke = null) {
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = ((rot + i * 120 - 90) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  const s = stroke ? ` stroke="${stroke}" stroke-width="2.5"` : '';
  return `<polygon points="${pts.join(' ')}" fill="${fill}"${s}/>`;
}

function sq(cx, cy, side, rot, fill, stroke = null) {
  const s = stroke ? ` stroke="${stroke}" stroke-width="2.5"` : '';
  return `<rect x="${(cx - side / 2).toFixed(1)}" y="${(cy - side / 2).toFixed(1)}" width="${side}" height="${side}" fill="${fill}"${s} transform="rotate(${rot} ${cx} ${cy})"/>`;
}

function circ(cx, cy, r, fill, stroke = null) {
  const s = stroke ? ` stroke="${stroke}" stroke-width="2.5"` : '';
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${s}/>`;
}

function arrow(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hl = 14;
  const bx = x2 - hl * Math.cos(ang);
  const by = y2 - hl * Math.sin(ang);
  const p1 = [bx + 7 * Math.sin(ang), by - 7 * Math.cos(ang)];
  const p2 = [bx - 7 * Math.sin(ang), by + 7 * Math.cos(ang)];
  return `<line x1="${x1}" y1="${y1}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${INK}" stroke-width="3"/>`
       + `<polygon points="${x2},${y2} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}" fill="${INK}"/>`;
}

function headlineBlock(w, slots, yHead = 550, ySub = 588) {
  const hSize = fitSize(slots.headline, w - 124, 52);
  const out = [`<text x="62" y="${yHead}" font-family="${SANS}" font-weight="700" font-size="${hSize}" letter-spacing="-1.5" fill="${INK}">${esc(slots.headline)}</text>`];
  if (slots.subline) {
    const sSize = fitSize(slots.subline, w - 124, 24);
    out.push(`<text x="62" y="${ySub}" font-family="${SANS}" font-weight="400" font-size="${sSize}" fill="${MUTE}">${esc(slots.subline)}</text>`);
  }
  return out.join('');
}

// ─── templates ─────────────────────────────────────────────────────────────
// Each: { width, height, slots: <description for the LLM drafter>, build(slots) }

const TEMPLATES = {
  split: {
    width: 1200, height: 627,
    slots: 'kicker (section label, <=24 chars), left_label & right_label (the two contrasted states, <=14 chars each, CAPS), headline (<=34 chars), subline (<=64 chars)',
    build(slots) {
      const w = 1200, h = 627;
      const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
      p.push(`<rect width="${w}" height="${h}" fill="${PAPER}"/>`);
      p.push(frame(w, h));
      p.push(kicker(62, 92, slots.kicker || 'FIELD NOTE'));
      p.push(wordmark(w));

      // left: the same nine shapes, scattered and faint
      p.push(sq(208, 198, 86, 17, LINE));
      p.push(circ(330, 226, 44, 'none', MUTE));
      p.push(tri(252, 318, 52, 28, MUTE));
      p.push(sq(372, 330, 64, -21, 'none', MUTE));
      p.push(circ(170, 308, 30, CARDHI, MUTE));
      p.push(tri(400, 198, 40, -50, LINE));
      p.push(sq(456, 272, 40, 38, 'none', MUTE));
      p.push(circ(232, 388, 24, LINE));
      p.push(tri(330, 408, 34, 12, MUTE));

      p.push(`<line x1="600" y1="148" x2="600" y2="438" stroke="${INK}" stroke-width="3"/>`);

      // right: same shapes, solid ink, perfect grid
      const kinds = ['sq', 'circ', 'tri'];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const cx = 800 + col * 92, cy = 200 + row * 92;
          const k = kinds[(row + col) % 3];
          if (k === 'sq')   p.push(sq(cx, cy, 64, 0, INK));
          if (k === 'circ') p.push(circ(cx, cy, 33, INK));
          if (k === 'tri')  p.push(tri(cx, cy, 40, 0, INK));
        }
      }

      p.push(`<text x="290" y="478" text-anchor="middle" font-family="${MONO_MED}" font-weight="500" font-size="17" letter-spacing="3.5" fill="${MUTE}">${esc((slots.left_label || '').toUpperCase())}</text>`);
      p.push(`<text x="892" y="478" text-anchor="middle" font-family="${MONO_MED}" font-weight="500" font-size="17" letter-spacing="3.5" fill="${MUTE}">${esc((slots.right_label || '').toUpperCase())}</text>`);
      p.push(headlineBlock(w, slots));
      p.push('</svg>');
      return p.join('');
    },
  },

  statement: {
    width: 1080, height: 1080,
    slots: 'kicker (<=28 chars), lines (array of 3-5 strings, the claim broken into lines, <=18 chars each), footer (<=46 chars)',
    build(slots) {
      const w = 1080, h = 1080;
      const lines = (slots.lines || []).slice(0, 5);
      const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
      p.push(`<rect width="${w}" height="${h}" fill="${PAPER}"/>`);
      p.push(circ(850, 270, 230, CARDHI, INK));
      p.push(sq(800, 755, 110, 12, INK));
      p.push(circ(930, 930, 46, 'none', INK));
      p.push(frame(w, h, 28));
      p.push(kicker(72, 122, slots.kicker || 'NOTE'));
      p.push(markOnly(w - 72 - 27, 94));

      const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
      const size = fitSize('x'.repeat(longest), w - 200, 82);
      const lineGap = Math.round(size * 1.22);
      let y = Math.round((h / 2) - ((lines.length - 1) * lineGap) / 2 + size * 0.1) + 60;
      for (const ln of lines) {
        p.push(`<text x="72" y="${y}" font-family="${SANS}" font-weight="700" font-size="${size}" letter-spacing="-2.5" fill="${INK}">${esc(ln)}</text>`);
        y += lineGap;
      }
      p.push(`<line x1="72" y1="${y - Math.round(lineGap * 0.4)}" x2="252" y2="${y - Math.round(lineGap * 0.4)}" stroke="${INK}" stroke-width="5"/>`);
      if (slots.footer) {
        p.push(`<text x="72" y="${y + 34}" font-family="${MONO_MED}" font-weight="500" font-size="22" letter-spacing="0.5" fill="${MUTE}">${esc(slots.footer)}</text>`);
      }
      p.push('</svg>');
      return p.join('');
    },
  },

  checklist: {
    width: 1200, height: 627,
    slots: 'kicker (<=26 chars), headline (<=46 chars), items (array of 3-5 strings, <=40 chars each), footer (<=64 chars)',
    build(slots) {
      const w = 1200, h = 627;
      const items = (slots.items || []).slice(0, 5);
      const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
      p.push(`<rect width="${w}" height="${h}" fill="${PAPER}"/>`);
      p.push(circ(1174, 601, 200, CARDHI, INK));
      p.push(frame(w, h));
      p.push(kicker(62, 92, slots.kicker || 'NOTE'));
      p.push(wordmark(w));

      const hSize = fitSize(slots.headline || '', w - 124, 50);
      p.push(`<text x="62" y="180" font-family="${SANS}" font-weight="700" font-size="${hSize}" letter-spacing="-1.5" fill="${INK}">${esc(slots.headline || '')}</text>`);

      // 5 items get tighter rows than 3 so the block stays inside the frame
      const rowGap = items.length > 4 ? 64 : 78;
      let y = items.length > 4 ? 218 : 238;
      for (const label of items) {
        p.push(`<rect x="70" y="${y}" width="44" height="44" fill="${INK}"/>`);
        p.push(`<polyline points="80,${y + 23} 90,${y + 33} 106,${y + 11}" fill="none" stroke="${PAPER}" stroke-width="5"/>`);
        const iSize = fitSize(label, 900, 29);
        p.push(`<text x="140" y="${y + 32}" font-family="${SANS_SEMI}" font-weight="600" font-size="${iSize}" letter-spacing="-0.5" fill="${INK}">${esc(label)}</text>`);
        y += rowGap;
      }
      if (slots.footer) {
        p.push(`<text x="62" y="585" font-family="${MONO_MED}" font-weight="500" font-size="19" fill="${MUTE}">${esc(slots.footer)}</text>`);
      }
      p.push('</svg>');
      return p.join('');
    },
  },

  flow: {
    width: 1200, height: 627,
    slots: 'kicker (<=26 chars), steps (array of 3-4 short CAPS words, <=8 chars each), step_caption (<=52 chars, describes the chain), headline (<=44 chars), subline (<=64 chars)',
    build(slots) {
      const w = 1200, h = 627;
      const steps = (slots.steps || []).slice(0, 4);
      const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
      p.push(`<rect width="${w}" height="${h}" fill="${PAPER}"/>`);
      p.push(frame(w, h));
      p.push(kicker(62, 92, slots.kicker || 'NOTE'));
      p.push(wordmark(w));

      // entry dot → ink boxes → exit dot, centered
      const boxW = 168, boxH = 66, gap = 56, midY = 280;
      const chainW = steps.length * boxW + (steps.length - 1) * gap;
      let x = Math.round((w - chainW) / 2);
      p.push(circ(x - 64, midY, 8, INK));
      p.push(arrow(x - 56, midY, x - 4, midY));
      steps.forEach((label, i) => {
        p.push(`<rect x="${x}" y="${midY - boxH / 2}" width="${boxW}" height="${boxH}" fill="${INK}"/>`);
        const sSize = fitSize(label, boxW - 24, 20, { mono: true });
        p.push(`<text x="${x + boxW / 2}" y="${midY + 7}" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="${sSize}" letter-spacing="2" fill="${PAPER}">${esc(label.toUpperCase())}</text>`);
        x += boxW;
        if (i < steps.length - 1) {
          p.push(arrow(x + 4, midY, x + gap - 4, midY));
          x += gap;
        }
      });
      p.push(arrow(x + 4, midY, x + 56, midY));
      p.push(circ(x + 64, midY, 8, INK));

      if (slots.step_caption) {
        p.push(`<text x="${w / 2}" y="400" text-anchor="middle" font-family="${MONO_MED}" font-weight="500" font-size="17" letter-spacing="3.5" fill="${MUTE}">${esc(slots.step_caption.toUpperCase())}</text>`);
      }
      p.push(headlineBlock(w, slots));
      p.push('</svg>');
      return p.join('');
    },
  },
};

export const SOCIAL_CARD_TEMPLATES = Object.keys(TEMPLATES);

// ─── slot drafter ──────────────────────────────────────────────────────────
// One cheap text call: reads the article, picks a template (unless forced),
// writes the slot text. Hard limits re-enforced in code after parsing.
// Card copy follows the operator's editable brand voice (the brand-voice doc),
// matching every other drafting path; the inline voice line is the fallback.
async function withBrandVoice(env, base) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'brand-voice'").first();
    if (row?.body) return `${base}\n\nBrand voice (operator-editable):\n${String(row.body).slice(0, 1500)}`;
  } catch { /* fallback */ }
  return base;
}
const DRAFTER_SYSTEM = `You write the text for the company's social cards. Who the company is and how it sounds comes from the operator-editable brand voice appended below; absent one, default to: declarative, concrete, zero hype, no exclamation marks. Cards are strict paper/ink editorial — the text must carry the idea on its own.

You get an article (title, excerpt, tags) and the menu of card templates with their slots and character limits. Pick the ONE template that fits the article's shape:
- split: the article contrasts two things or states
- statement: the article has one sharp quotable claim
- checklist: the article lists tests, criteria, or steps for a decision
- flow: the article describes a process or pipeline

Respect every character limit EXACTLY — overlong text gets shrunk and looks weak. Kickers are short caps section labels: "FIELD NOTE", "PLAYBOOK", or the article's topic. Footers usually cite the article: "From: <short title>".

Output ONLY a JSON object:
{ "template": "<split|statement|checklist|flow>", "slots": { ...slot fields for that template... } }`;

export async function draftCardSlots(env, { title, excerpt, tags, template }) {
  const menu = Object.entries(TEMPLATES)
    .filter(([k]) => !template || k === template)
    .map(([k, t]) => `${k}: ${t.slots}`)
    .join('\n');
  const prompt = [
    `Title: ${title}`,
    excerpt ? `Excerpt: ${excerpt}` : null,
    Array.isArray(tags) && tags.length ? `Tags: ${tags.slice(0, 4).join(', ')}` : null,
    '',
    template ? `Use template "${template}".` : 'Pick the best template.',
    'Templates and slots:',
    menu,
  ].filter(Boolean).join('\n');

  const raw = await callOpenAIText(env, {
    system: await withBrandVoice(env, DRAFTER_SYSTEM),
    prompt,
    response_format: { type: 'json_object' },
  });
  const parsed = JSON.parse(raw);
  const tpl = TEMPLATES[parsed.template] ? parsed.template : (template || 'statement');
  return { template: tpl, slots: parsed.slots || {} };
}

// ─── png renderer ──────────────────────────────────────────────────────────
let wasmReady = null;

async function renderPng(svg, width) {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 },  // 2x for crisp feeds
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

// ─── the three steps, separately callable ─────────────────────────────────
// The tool layer runs them as three workflow steps (draft_card → render_card →
// save_social_card); generateSocialCard below is the same three in one call for
// the callers that still want a single shot. One implementation, two shapes.

// Render one card PNG into R2. No DB write, no LLM: slots in, stored image out.
// Idempotent per (blog_slug, template) — the same R2 key is overwritten, which
// is what makes "regenerate" replace a card instead of littering the bucket.
export async function renderSocialCard(env, { blog_slug = null, template, slots } = {}) {
  const tplKey = TEMPLATES[template] ? template : 'statement';
  const tpl = TEMPLATES[tplKey];
  const png = await renderPng(tpl.build(slots || {}), tpl.width);

  const stamp = now();
  const key = `social/${blog_slug || `custom-${stamp}`}-${tplKey}.png`;
  const url = await storeImageBytes(env, key, png, {
    kind:         'social_card',
    template:     tplKey,
    slug:         blog_slug || '',
    generated_at: String(stamp),
  });
  return { url, key, template: tplKey, width: tpl.width, height: tpl.height, size_bytes: png.length };
}

// Record a rendered card in social_cards. Split from the render so a re-render
// of the same key can be recorded (or not) independently of the pixels.
export async function saveSocialCardRecord(env, { card, blog_slug = null, slots = null, actor = 'system' } = {}) {
  if (!card?.url || !card?.template) throw new Error('social-cards: card {url, template} required');
  const t = now();
  await env.DB.prepare(
    `INSERT INTO social_cards (slug, template, url, r2_key, slots_json, width, height, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    blog_slug || null, card.template, card.url, card.key || null, JSON.stringify(slots || {}),
    card.width || null, card.height || null, actor, t,
  ).run();

  await logEvent(env, {
    kind:  'social_card_generated',
    actor,
    payload: { slug: blog_slug || null, template: card.template, url: card.url, size_bytes: card.size_bytes || null },
  });
  return { ...card, slug: blog_slug || null, slots: slots || {}, created_at: t };
}

/**
 * Generate a social card and persist it.
 *
 *   env, {
 *     slug,        // blog post slug — title/excerpt/tags come from the post
 *     title,       // OR a custom title (+ optional excerpt) with no slug
 *     excerpt,
 *     template,    // optional: force split|statement|checklist|flow
 *     slots,       // optional: full slot override — skips the LLM drafter
 *     actor,       // nyo | operator | system
 *   }
 *
 * Idempotent per (slug, template): same R2 key is overwritten on regenerate.
 */
export async function generateSocialCard(env, opts = {}) {
  const startedAt = now();
  let post = null;
  if (opts.slug) {
    post = await readBlogPost(env, opts.slug);
    if (!post) throw new Error(`social-cards: blog post not found: ${opts.slug}`);
  } else if (!opts.title) {
    throw new Error('social-cards: slug or title required');
  }
  const title = post?.title || opts.title;
  const excerpt = post?.excerpt || opts.excerpt || '';
  let tags = post?.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }

  try {
    let template = opts.template || null;
    let slots = opts.slots || null;
    if (!slots) {
      const draft = await draftCardSlots(env, { title, excerpt, tags, template });
      template = draft.template;
      slots = draft.slots;
    }
    const rendered = await renderSocialCard(env, { blog_slug: opts.slug || null, template, slots });
    template = rendered.template;
    await saveSocialCardRecord(env, {
      card: rendered, blog_slug: opts.slug || null, slots, actor: opts.actor || 'system',
    });
    const { url, key, width, height, size_bytes } = rendered;

    await logWorkflowRun(env, {
      workflow_slug:   'social-card',
      status:          'succeeded',
      trigger_kind:    'manual',
      trigger_payload: { slug: opts.slug || null, title, template },
      output:          { url, template, slots },
      started_at:      startedAt,
    });

    return { url, key, template, slots, width, height, size_bytes };
  } catch (e) {
    const msg = e?.message || String(e);
    await logEvent(env, {
      kind:  'social_card_failed',
      actor: opts.actor || 'system',
      payload: { slug: opts.slug || null, error: msg.slice(0, 300) },
    });
    await logWorkflowRun(env, {
      workflow_slug:   'social-card',
      status:          'failed',
      trigger_kind:    'manual',
      trigger_payload: { slug: opts.slug || null, title },
      error:           msg,
      started_at:      startedAt,
    });
    throw e;
  }
}

export async function listSocialCards(env, { slug = null, limit = 50 } = {}) {
  const rows = slug
    ? await env.DB.prepare('SELECT * FROM social_cards WHERE slug = ? ORDER BY created_at DESC LIMIT ?').bind(slug, limit).all()
    : await env.DB.prepare('SELECT * FROM social_cards ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return rows.results || [];
}
