// Editorial plugin — lib/cards-figures.mjs. The ORCHESTRATION halves of the
// host's social-cards.js + article-figures.js + blog-images.js in one pack
// lib (contract v2.1; imports NOTHING, every exported fn takes `api` first).
//
// What lives here: the LLM slot/spec/brief drafting, figure placement in the
// article body, record-keeping in plugin tables, and the decisions about WHAT
// to render. What stays HOST: resvg WASM, bundled fonts, and R2 storage —
// reached exclusively through api.gateway('render', mode):
//
//   card    → renders one social card PNG   (mirrors host renderSocialCard)
//   figures → renders a set of figure specs (mirrors host renderFigures)
//   cover   → renders the 1200x630 hero     (mirrors host renderCover)
//   images  → renders N AI candidates       (mirrors host renderCandidateImages)
//
// Port notes (behavioral deltas from the host originals):
// - blog_posts → plugin_editorial_blog_posts; social_cards →
//   plugin_editorial_social_cards.
// - The runtime-seeded knowledge docs are re-slugged to the plugin namespace:
//   figure-chart-selection → plugin-editorial-figure-chart-selection,
//   visual-style → plugin-editorial-visual-style (api.knowledge to read,
//   api.saveKnowledge to seed — never raw SQL on knowledge_docs). The
//   brand-voice doc is a declared HOST read (the host originals read it with
//   raw SQL; api.knowledge here).
// - The card/figure template SVG builders stay host-side behind the render
//   gateway; the pack keeps only each template's SLOT DESCRIPTION (the LLM
//   drafter's menu) — duplicated text, still one renderer.
// - logWorkflowRun (host workflow_runs table) is not reachable from a plugin:
//   those trails become api.log('workflow_run', {...}) bus events.
// - The vision judge sent raw candidate BYTES read from R2; R2 reads stay
//   host, so the judge now passes the candidates' stored URLs to
//   api.gateway('llm','vision') (callOpenAIVision accepts http(s) URLs).
//   Any judge failure still falls back to candidate 1, so a flaky call or an
//   unreachable URL never blocks a post.
// - The host checked env.OPENAI_API_KEY to skip the judge / pick the image
//   model; plugins see no env, so the judge is always ATTEMPTED (falling back
//   on error) and a null model lets the host render gateway pick its default.
// - generateBlogFeaturedImage no longer re-stores the winner's bytes at
//   blog/<slug>.png (that copy needed R2 access): the winning CANDIDATE's
//   stored URL becomes the featured image, with the same ?v= cache-bust.

const CHART_GUIDE_SLUG  = 'plugin-editorial-figure-chart-selection';
const VISUAL_STYLE_SLUG = 'plugin-editorial-visual-style';

const now = () => Date.now();

// Duplicated from host lib/db.js stripDashes (pure).
function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

// Duplicated from host lib/openai.js parseJsonLoose (pure).
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* noop */ } }
  throw new Error(`LLM returned non-JSON: ${String(text).slice(0, 200)}`);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readPost(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

// Strip en/em dashes from every string in a figure/cover slot tree before it
// is rendered into a PNG. The body strip can't fix text baked into an image,
// so the no-dash rule has to be enforced here too (deep walk).
function stripSlots(v) {
  if (v == null) return v;
  if (typeof v === 'string') return stripDashes(v);
  if (Array.isArray(v)) return v.map(stripSlots);
  if (typeof v === 'object') { const o = {}; for (const k in v) o[k] = stripSlots(v[k]); return o; }
  return v;
}

// Card/figure copy follows the operator's editable brand voice, matching every
// other drafting path; the inline voice line is the fallback. (Host read this
// with raw SQL on knowledge_docs; here it is a declared host-doc read.)
async function withVoice(api, base) {
  try {
    const doc = await api.knowledge('plugin-editorial-brand-voice');
    if (doc?.body) return `${base}\n\nBrand voice (operator-editable):\n${String(doc.body)}`;
  } catch { /* fallback */ }
  return base;
}

// ════════════════════════════════════════════════════════════════════════════
// SOCIAL CARDS (from social-cards.js)
// Code-drawn, brand-locked SVG cards rendered to PNG host-side. No AI image
// model in the loop: the layout is a fixed host template, an LLM only fills
// the text slots, so every card is pixel-exact brand and costs one cheap call.
// ════════════════════════════════════════════════════════════════════════════

// The templates' slot descriptions — the LLM drafter's menu. The SVG builders
// (and canvas sizes) live host-side behind api.gateway('render','card').
const CARD_TEMPLATE_SLOTS = {
  split:     'kicker (section label, <=24 chars), left_label & right_label (the two contrasted states, <=14 chars each, CAPS), headline (<=34 chars), subline (<=64 chars)',
  statement: 'kicker (<=28 chars), lines (array of 3-5 strings, the claim broken into lines, <=18 chars each), footer (<=46 chars)',
  checklist: 'kicker (<=26 chars), headline (<=46 chars), items (array of 3-5 strings, <=40 chars each), footer (<=64 chars)',
  flow:      'kicker (<=26 chars), steps (array of 3-4 short CAPS words, <=8 chars each), step_caption (<=52 chars, describes the chain), headline (<=44 chars), subline (<=64 chars)',
};

export const SOCIAL_CARD_TEMPLATES = Object.keys(CARD_TEMPLATE_SLOTS);

const CARD_DRAFTER_SYSTEM = `You write the text for the company's social cards. Who the company is and how it sounds comes from the operator-editable brand voice appended below; absent one, default to: declarative, concrete, zero hype, no exclamation marks. Cards are strict paper/ink editorial — the text must carry the idea on its own.

You get an article (title, excerpt, tags) and the menu of card templates with their slots and character limits. Pick the ONE template that fits the article's shape:
- split: the article contrasts two things or states
- statement: the article has one sharp quotable claim
- checklist: the article lists tests, criteria, or steps for a decision
- flow: the article describes a process or pipeline

Respect every character limit EXACTLY — overlong text gets shrunk and looks weak. Kickers are short caps section labels: "FIELD NOTE", "PLAYBOOK", or the article's topic. Footers usually cite the article: "From: <short title>".

Output ONLY a JSON object:
{ "template": "<split|statement|checklist|flow>", "slots": { ...slot fields for that template... } }`;

// One cheap text call: reads the article, picks a template (unless forced),
// writes the slot text.
export async function draftCardSlots(api, { title, excerpt, tags, template }) {
  const menu = Object.entries(CARD_TEMPLATE_SLOTS)
    .filter(([k]) => !template || k === template)
    .map(([k, slots]) => `${k}: ${slots}`)
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

  const raw = await api.gateway('llm', 'text', {
    system: await withVoice(api, CARD_DRAFTER_SYSTEM),
    prompt,
    response_format: { type: 'json_object' },
  });
  const parsed = JSON.parse(raw);
  const tpl = CARD_TEMPLATE_SLOTS[parsed.template] ? parsed.template : (template || 'statement');
  return { template: tpl, slots: parsed.slots || {} };
}

// Render one card PNG into storage — pure passthrough to the host renderer.
// Idempotent per (blog_slug, template): the same storage key is overwritten,
// which is what makes "regenerate" replace a card instead of littering.
export async function renderSocialCard(api, { blog_slug = null, template, slots } = {}) {
  return api.gateway('render', 'card', { blog_slug, template, slots });
}

// Record a rendered card in plugin_editorial_social_cards. Split from the
// render so a re-render of the same key can be recorded (or not) independently
// of the pixels.
export async function saveSocialCardRecord(api, { card, blog_slug = null, slots = null, actor = 'system' } = {}) {
  if (!card?.url || !card?.template) throw new Error('social-cards: card {url, template} required');
  const t = now();
  await api.db.prepare(
    `INSERT INTO plugin_editorial_social_cards (slug, template, url, r2_key, slots_json, width, height, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    blog_slug || null, card.template, card.url, card.key || null, JSON.stringify(slots || {}),
    card.width || null, card.height || null, actor, t,
  ).run();

  await api.log('social_card_generated', {
    slug: blog_slug || null, template: card.template, url: card.url, size_bytes: card.size_bytes || null, actor,
  });
  return { ...card, slug: blog_slug || null, slots: slots || {}, created_at: t };
}

/**
 * Generate a social card and persist it.
 *
 *   api, {
 *     slug,        // blog post slug — title/excerpt/tags come from the post
 *     title,       // OR a custom title (+ optional excerpt) with no slug
 *     excerpt,
 *     template,    // optional: force split|statement|checklist|flow
 *     slots,       // optional: full slot override — skips the LLM drafter
 *     actor,       // nyo | operator | system
 *   }
 */
export async function generateSocialCard(api, opts = {}) {
  const startedAt = now();
  let post = null;
  if (opts.slug) {
    post = await readPost(api, opts.slug);
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
      const draft = await draftCardSlots(api, { title, excerpt, tags, template });
      template = draft.template;
      slots = draft.slots;
    }
    const rendered = await renderSocialCard(api, { blog_slug: opts.slug || null, template, slots });
    template = rendered.template;
    await saveSocialCardRecord(api, {
      card: rendered, blog_slug: opts.slug || null, slots, actor: opts.actor || 'system',
    });
    const { url, key, width, height, size_bytes } = rendered;

    await api.log('workflow_run', {
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
    await api.log('social_card_failed', { slug: opts.slug || null, error: msg.slice(0, 300), actor: opts.actor || 'system' });
    await api.log('workflow_run', {
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

export async function listSocialCards(api, { slug = null, limit = 50 } = {}) {
  const rows = slug
    ? await api.db.prepare('SELECT * FROM plugin_editorial_social_cards WHERE slug = ? ORDER BY created_at DESC LIMIT ?').bind(slug, limit).all()
    : await api.db.prepare('SELECT * FROM plugin_editorial_social_cards ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return rows.results || [];
}

// ════════════════════════════════════════════════════════════════════════════
// ARTICLE FIGURES (from article-figures.js)
// 3-5 editorial diagrams per post, anchored into the body, plus the hero cover.
// ════════════════════════════════════════════════════════════════════════════

// Each template's SLOT DESCRIPTION — the drafter's menu, mirrored verbatim
// from the host's article-figures-templates.js + article-figures-charts.js
// (where the SVG builders stay, behind api.gateway('render','figures')).
const FIGURE_SLOT_MENU = {
  layers: 'fig_label (<=42 chars caps), layers (array of 2-3 objects, top to bottom, each { band_label (<=40 chars caps), items (array of 2-5 short CAPS chips <=14 chars each), dark (bool — true paints the band solid ink) }), boundary_label (optional <=22 chars caps — a dashed trust/handoff line drawn after the first band), caption (optional <=72 chars)',
  contrast: 'fig_label (<=42 chars caps), left & right (each { heading (<=34 chars caps), mode ("chain" = a vertical stack of step boxes, or "hub" = a center label ringed by nodes), nodes (array of short CAPS labels <=14 chars — 2-4 for chain, 3-6 for hub), center (<=10 chars caps, only for hub mode), note (optional <=40 chars caps, small print under the side) }), caption (optional <=72 chars)',
  cycle: 'fig_label (<=42 chars caps), center (<=12 chars caps — the goal the loop serves), nodes (array of 3-6 short CAPS labels <=14 chars, in loop order), caption (optional <=72 chars)',
  fanout: 'fig_label (<=42 chars caps), source (<=22 chars caps — the one event/agent at the top), targets (array of 2-4 objects { label (<=18 chars caps), sub (optional <=22 chars), outcome (optional <=24 chars — draws a second box below for the resulting angle/state) }), caption (optional <=72 chars)',
  columns: 'fig_label (<=42 chars caps), header (optional <=24 chars caps — a routing box above the columns), columns (array of 2-4 objects { title (<=18 chars caps), items (array of 2-5 short CAPS labels <=18 chars), style ("ink" solid | "outline" | "ghost") }), caption (optional <=72 chars)',
  grid: 'fig_label (<=42 chars caps), panels (array of exactly 4 objects { title (<=22 chars caps), rows (array of 2-5 short strings <=40 chars) }), caption (optional <=72 chars)',
  funnel: 'fig_label (<=42 chars caps), stages (array of 3-5 objects top to bottom, each { label (<=20 chars caps), sub (optional <=16 chars — a count or drop-off note) }), caption (optional <=72 chars)',
  timeline: 'fig_label (<=42 chars caps), milestones (array of 3-5 objects left to right, each { label (<=16 chars caps), sub (optional <=18 chars — a date or note) }), caption (optional <=72 chars)',
  quadrant: 'fig_label (<=42 chars caps), x_axis (<=18 chars caps — horizontal axis name), y_axis (<=18 chars caps — vertical axis name), quadrants (array of EXACTLY 4 objects in order top-left, top-right, bottom-left, bottom-right, each { label (<=22 chars caps), highlight (bool — paints it solid ink as the target) }), caption (optional <=72 chars)',
  pyramid: 'fig_label (<=42 chars caps), tiers (array of 3-5 objects TOP apex to BOTTOM base, each { label (<=24 chars caps), sub (optional <=30 chars) }), caption (optional <=72 chars)',
  venn: 'fig_label (<=42 chars caps), left_label (<=16 chars caps), right_label (<=16 chars caps), overlap_label (<=14 chars caps — what the two share), caption (optional <=72 chars)',
  table: 'fig_label (<=42 chars caps), columns (array of 2-3 option header strings <=16 chars caps), rows (array of 3-6 objects { label (<=26 chars — the criterion), cells (array matching columns length, each <=14 chars or "YES"/"NO") }), caption (optional <=72 chars)',
  pipeline: 'fig_label (<=42 chars caps), stages (array of 3-5 short CAPS labels <=12 chars each), stage_caption (optional <=56 chars caps), caption (optional <=72 chars)',
  radial: 'fig_label (<=42 chars caps), center (<=14 chars caps), spokes (array of 3-6 objects { label (<=16 chars caps), sub (optional <=16 chars) }), caption (optional <=72 chars)',
  bigstat: 'fig_label (<=42 chars caps), stats (array of 2-4 objects { value (<=8 chars — the number, e.g. "10X", "73%", "1/2"), label (<=28 chars — what it measures) }), caption (optional <=72 chars)',
  progression: 'fig_label (<=42 chars caps), steps (array of 3-5 objects left to right, ascending, each { label (<=16 chars caps), sub (optional <=18 chars) }), caption (optional <=72 chars)',
  chart_line: 'fig_label (<=42 chars caps), x (array of 2-12 time labels), series (array of 1-5 { name (<=16 chars), values (array of numbers, same length as x) }), focus (optional: name of the ONE series that is the story — it prints in the accent), unit (optional, e.g. "%"), caption (optional <=72 chars)',
  chart_multiples: 'fig_label (<=42 chars caps), x_first (<=8 chars, first time label), x_last (<=8 chars, last time label), series (array of 2-8 { name (<=14 chars), values (array of 4-24 numbers) }), focus (optional: one name to print in the accent), unit (optional), caption (optional <=72 chars)',
  chart_area: 'fig_label (<=42 chars caps), x (array of 3-12 time labels), series (array of 2-5 { name (<=16 chars), values (numbers, same length as x) }, bottom band first), mode ("stacked" absolute | "share" always sums to 100% | "stream" centered, for texture over precision), unit (optional), caption (optional <=72 chars)',
  chart_column: 'fig_label (<=42 chars caps), x (array of 2-8 period labels), series (array of 1-3 { name (<=14 chars), values (numbers, same length as x) } — ONE series = plain columns), mode ("grouped" | "stacked", only matters with 2+ series), focus_x (optional: one x label whose column prints in the accent), unit (optional), caption (optional <=72 chars)',
  chart_slope: 'fig_label (<=42 chars caps), start_label (<=10 chars, e.g. "2019"), end_label (<=10 chars), items (array of 2-8 { label (<=16 chars), start (number), end (number) }), focus (optional: one label to print in the accent; default = biggest mover), unit (optional), caption (optional <=72 chars)',
  chart_arrow: 'fig_label (<=42 chars caps), from_label (<=12 chars, what the tail is, e.g. "2015"), to_label (<=12 chars, the head), items (array of 3-10 { label (<=20 chars), from (number), to (number) }), unit (optional), caption (optional <=72 chars)',
  chart_bar: 'fig_label (<=42 chars caps), items (array of 2-10 { label (<=22 chars), value (number), note (optional <=14 chars, prints after the value) }), sort ("desc" default | "none" to keep given order), accent_label (optional: one label to print in the accent; default = the largest), unit (optional, "%" for shares), caption (optional <=72 chars)',
  chart_bar_stacked: 'fig_label (<=42 chars caps), legend (array of 2-5 segment names, <=14 chars each), rows (array of 2-8 { label (<=20 chars), values (numbers, one per legend entry) }), mode ("share" each row scaled to 100% — right for surveys | "absolute" raw values), unit (optional), caption (optional <=72 chars)',
  chart_bar_grouped: 'fig_label (<=42 chars caps), legend (array of 2-3 value names, <=14 chars each), groups (array of 2-6 { label (<=20 chars), values (numbers, one per legend entry) }), unit (optional), caption (optional <=72 chars)',
  chart_bar_split: 'fig_label (<=42 chars caps), left_name (<=14 chars, prints in the accent), right_name (<=14 chars, prints in ink), rows (array of 3-12 { label (<=12 chars, the shared category, e.g. an age band), left (number), right (number) }), unit (optional), caption (optional <=72 chars)',
  chart_dot: 'fig_label (<=42 chars caps), legend (array of 1-4 value names <=14 chars — dot 1 is ink, dot 2 accent, then mute/hollow), rows (array of 3-10 { label (<=20 chars), values (numbers, one per legend entry) }), unit (optional), caption (optional <=72 chars)',
  chart_pie: 'fig_label (<=42 chars caps), slices (array of 2-5 { label (<=16 chars), value (number) } — biggest first; the FIRST slice prints in the accent), mode ("donut" default | "pie"), center_stat (optional <=8 chars, prints inside a donut, e.g. "73%"), center_label (optional <=16 chars under the stat), unit (optional, default "%"), caption (optional <=72 chars)',
  chart_parliament: 'fig_label (<=42 chars caps), parties (array of 2-8 { label (<=14 chars), seats (integer) } in seating order left to right; the FIRST prints in the accent), majority (optional integer — draws the majority line with this number), caption (optional <=72 chars)',
  chart_waffle: 'fig_label (<=42 chars caps), parts (array of 1-4 { label (<=18 chars), value (number) } — of a total; FIRST part prints in the accent), total (optional, default = sum of parts or 100), unit (optional, default "%"), caption (optional <=72 chars)',
  chart_treemap: 'fig_label (<=42 chars caps), items (array of 3-12 { label (<=16 chars), value (number) } — biggest prints in the accent), unit (optional), caption (optional <=72 chars)',
  chart_marimekko: 'fig_label (<=42 chars caps), legend (array of 2-4 segment names <=14 chars), columns (array of 2-6 { label (<=14 chars), total (number — sets the column WIDTH), values (numbers, one per legend entry — set the column\'s internal split) }), unit (optional), caption (optional <=72 chars)',
  chart_scatter: 'fig_label (<=42 chars caps), x_label (<=20 chars caps), y_label (<=20 chars caps), points (array of 5-40 { x (number), y (number), label (optional <=14 chars — ONLY the points worth naming), size (optional number — makes it a bubble chart, scaled by AREA), hot (optional true — prints in the accent) }), unit_x (optional), unit_y (optional), caption (optional <=72 chars)',
  chart_heatmap: 'fig_label (<=42 chars caps), x (array of 3-14 column labels <=8 chars), y (array of 2-8 row labels <=16 chars), values (array of rows, each an array of numbers matching x — higher = darker), unit (optional), show_values (optional true — print the number in each cell), caption (optional <=72 chars)',
  chart_sankey: 'fig_label (<=42 chars caps), flows (array of 2-9 { from (<=16 chars), to (<=16 chars), value (number) } — the LARGEST flow prints in the accent), unit (optional), caption (optional <=72 chars)',
  chart_prop_area: 'fig_label (<=42 chars caps), items (array of 2-4 { label (<=16 chars), value (number) } — biggest first; the LAST (smallest) prints in the accent so the contrast lands), shape ("circle" default | "square"), unit (optional), caption (optional <=72 chars)',
};

export const FIGURE_TEMPLATE_NAMES = Object.keys(FIGURE_SLOT_MENU);

const FIGURES_DRAFTER_SYSTEM = `You are a technical figure designer for nyyon, a white-glove AI-native marketing agency. You turn an article into a SET of editorial diagrams that TELL THE ARTICLE'S STORY — each diagram placed at the exact point it illustrates.

You receive the article (title, excerpt, body text) and a menu of templates in two families: DIAGRAMS (story shapes) and DATA CHARTS (chart_*, real numbers on real scales — the selection guide below says which to use when). Pick what matches the shape of the idea, not habit. The diagram shapes:

- contrast: TWO things compared side by side — old vs new, A vs B, the wrong way vs the right way.
- layers: a STACKED architecture or a boundary between planes — tiers, build-plane over operate-plane, a trust boundary.
- cycle: a LOOP or repeating process — a feedback loop, stages that circle a central goal, learn-and-adapt.
- fanout: ONE thing branching into MANY — one event → many outcomes, one input → many states, one capability used by many teams.
- columns: a CATEGORIZED breakdown into 3-4 parallel groups — tiers, pillars, model types, job categories.
- grid: a CONTROL ROOM of 4 panels — dashboards, four named views/jobs each with a list of rows.
- funnel: a NARROWING sequence — a demand/conversion funnel, stages that shrink (impressions → clicks → pipeline → won).
- timeline: events along TIME — phases, a rollout, a week-by-week or before→after sequence on a horizontal axis.
- quadrant: a 2x2 POSITIONING MATRIX with two named axes — where to be vs not be, plotted on two dimensions.
- pyramid: a HIERARCHY of tiers, wide base to narrow apex — a maturity model, a hierarchy of needs/value.
- venn: an INTERSECTION of two things — where human + AI overlap, the shared zone between two domains.
- table: a CRITERIA × OPTIONS comparison — rows of attributes scored across 2-3 options (yes/no, short cells).
- pipeline: a LINEAR left→right process — a production line of stages, each with one job (NOT a loop; use cycle for loops).
- radial: a CENTRAL hub with radiating members — an ecosystem, a data spine every tool plugs into, dependencies around a core.
- bigstat: 2-4 OVERSIZED NUMBERS — headline metrics or a stark quantified claim (cost, speed, percentage).
- progression: ASCENDING steps — growth/escalation/maturity stages rising left to right (headcount → leverage).

RULES — follow all of them:
1. Design 3-4 figures (5 only for very long articles).
2. USE A WIDE VARIETY OF SHAPES from the FULL menu — diagrams AND charts (a chart ONLY where the article carries real numbers). A strong set uses 3-4 DIFFERENT templates and reaches beyond the obvious contrast+columns — if the article has a number worth enlarging use bigstat, a process use pipeline/cycle, a maturity arc use pyramid/progression, two dimensions use quadrant, a shared zone use venn, a sequence in time use timeline, a hub use radial. Do NOT repeat a template in one set unless the article genuinely contains two separate instances of that exact shape.
3. Map the article's KEY MOVES to templates: the central comparison, the mechanism/architecture, the process or loop, the breakdown of parts, the headline number, the maturity arc. Build one figure per real move — pick the shape that fits that move best.
4. For EACH figure, set "anchor": copy a SHORT EXACT phrase (6-12 words) from the article body, VERBATIM (same words, same order), marking the sentence that figure illustrates. The figure is placed right after that sentence. Choose anchors SPREAD ACROSS the article — intro, middle, and later sections — NEVER all near the top. Two figures must not share an anchor.
5. Mark exactly ONE figure "featured": true — the one that best captures the article's central idea (usually the main mechanism or the core comparison).
6. Set "alt": one plain-English sentence describing the figure, for accessibility.
7. Fill every slot the template needs. Respect character limits. Use CAPS where a slot says caps. Keep labels terse and concrete — nyyon voice: declarative, zero hype.
8. Also design the "cover" — the article's hero/featured image. Provide: "kicker" (a short topic label in caps, <=26 chars, e.g. "AI-NATIVE MARKETING" or "FIELD NOTE"); "highlight" (ONE word or short phrase copied EXACTLY from the article title that carries the idea — it prints in the accent colour, <=24 chars); "sub" (a one-line standfirst, <=84 chars — usually a sharpened version of the excerpt). The title itself is supplied separately; do not repeat it.

Output ONLY valid JSON, no markdown:
{ "figures": [ { "template": "<name>", "anchor": "<exact phrase from body>", "featured": false, "alt": "<one sentence>", "slots": { ... } } ], "cover": { "kicker": "...", "highlight": "...", "sub": "..." } }`;

// ─── knowledge: chart selection ──────────────────────────────────────────────
// Which chart to use when — the Datawrapper method, mapped to our chart_*
// templates. Lives in the plugin-editorial-figure-chart-selection knowledge
// doc (seeded below, editable live); this constant is only the seed + fallback.
export const CHART_GUIDE_DEFAULT = `DATA CHARTS — when an idea is backed by REAL NUMBERS, draw the numbers, not a metaphor. Pick by GOAL (the chart's main statement is the compass; once you know the goal, most chart types can simply be ignored):

CHANGE OVER TIME
- chart_line: the default for a value moving across months/years, up to 5 series. More than ~5 overlapping lines is spaghetti — use chart_multiples.
- chart_multiples: many series, one mini panel each, ONE shared scale.
- chart_area: how a total's internal breakdown shifted over time (mode "share" for a 100% view). Composition is the story, not precise values.
- chart_column: just a FEW points in time (five years of incidents). Many periods → chart_line.
- chart_slope: only the first and last point across categories — when the wiggles between are not the story.
- chart_arrow: compact before→after for many categories; a bit less mainstream to read.

SHARES OF A WHOLE
- chart_bar: percentages compare better as bars than pie slices — a 3-point gap is visible in a bar, invisible in a pie. The DEFAULT for shares.
- chart_pie: only a simple, obvious split (2-4 slices, one dominant); donut mode carries a center stat.
- chart_parliament: seats and votes.
- chart_waffle: an illustrative of-100 share; trades precision for warmth.
- chart_treemap: proportions across MANY categories (to ~12).
- chart_marimekko: shares AND absolute size at once (column width = size).
- chart_bar_stacked mode "share": survey / Likert rows.

AMOUNTS
- chart_bar: the workhorse — sorted, direct-labeled.
- chart_bar_grouped: 2-3 values compared within each category.
- chart_bar_stacked mode "absolute": totals split into parts.
- chart_bar_split: two components mirrored (in/out, male/female — population pyramids).
- chart_dot: several values per category in little space.
- chart_prop_area: 2-4 magnitudes as area-true shapes — impact over precision.
- bigstat (diagram): when ONE number IS the story, print it huge instead of charting it.

RELATIONSHIPS
- chart_scatter: does X relate to Y? Label only points worth naming; hot:true accents them; size makes it a bubble chart (area-true).
- chart_heatmap: a matrix of intensity (day × time, category × stage); also the fix for an unreadable dot cloud.

FLOWS
- chart_sankey: volume flowing source → destination (money, leads, energy).

CHART RULES (the renderer enforces the hard ones):
- Bars, columns, areas and waffles always start at zero; lines may zoom.
- Direct labels beat legends — the templates label line ends and bar ends themselves.
- NEVER invent numbers. Chart templates are ONLY for real figures present in the article or supplied by the operator. If the text gestures at magnitude without numbers, use a diagram (story shape) instead.
- Familiar beats fancy for a mainstream audience; one less-common shape (slope, arrow, marimekko) can wake up a chart-heavy piece.
- Small screens: prefer bars (grow down) over columns (grow right).
- GEO MAPS (choropleth/symbol/locator) are NOT renderable here (no shape data): use chart_bar or chart_heatmap by region instead.`;

// doc > coded default; seeds the doc on first read so it shows in Knowledge.
async function withChartGuide(api, base) {
  try {
    const doc = await api.knowledge(CHART_GUIDE_SLUG);
    if (!doc) {
      await api.saveKnowledge(CHART_GUIDE_SLUG, { title: 'Figures · which chart to use when', body: CHART_GUIDE_DEFAULT }).catch(() => {});
      return `${base}\n\n${CHART_GUIDE_DEFAULT}`;
    }
    return `${base}\n\n${String(doc.body || CHART_GUIDE_DEFAULT)}`;
  } catch { return `${base}\n\n${CHART_GUIDE_DEFAULT}`; }
}

async function draftFigureSpecs(api, { title, excerpt, body_text }) {
  const menu = FIGURE_TEMPLATE_NAMES
    .map((name) => `${name}: ${FIGURE_SLOT_MENU[name]}`)
    .join('\n\n');

  const prompt = [
    `Article title: ${title}`,
    `Excerpt: ${excerpt || '(none)'}`,
    '',
    'Article body (text only — copy anchors verbatim from this):',
    body_text.replace(/<[^>]+>/g, '').slice(0, 6000),  // strip HTML, cap
    '',
    'Templates and their slots:',
    menu,
    '',
    'Design 3-4 figures with varied shapes, each anchored to the sentence it illustrates, spread across the article.',
  ].join('\n');

  const raw = await api.gateway('llm', 'text', {
    system: await withChartGuide(api, await withVoice(api, FIGURES_DRAFTER_SYSTEM)),
    prompt,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = parseJsonLoose(raw);
    const figures = (parsed.figures || []).slice(0, 5);
    for (const fig of figures) {
      if (!FIGURE_SLOT_MENU[fig.template]) fig.template = 'contrast';  // fallback
    }
    return { figures, cover: parsed.cover || null };
  } catch (e) {
    throw new Error(`article-figures: draft parse error: ${e.message}`);
  }
}

// ─── placement ────────────────────────────────────────────────────────────────
// Tag-stripped, whitespace-collapsed view of the body with an index map back to
// original offsets — lets us locate an anchor sentence even across inline tags.
function buildPlainMap(html) {
  let plain = '', inTag = false, prevSpace = false;
  const map = [];
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') { inTag = true; continue; }
    if (ch === '>') { inTag = false; continue; }
    if (inTag) continue;
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      plain += ' '; map.push(i); prevSpace = true;
    } else {
      plain += ch.toLowerCase(); map.push(i); prevSpace = false;
    }
  }
  return { plain, map };
}

// Insert each figure after the block (</p>, </h2>, …) containing its anchor
// sentence. Unanchored / not-found figures are spread evenly across remaining
// block boundaries. Returns { body, placed }.
function embedFigures(body, figures) {
  const figHtml = (f) =>
    `<figure><img src="${f.url}" alt="${esc(f.alt || f.fig_label || 'Editorial diagram')}" loading="lazy" /></figure>`;

  const blockRe = /<\/(?:p|h2|h3|ul|ol|blockquote)>/gi;
  const ends = [];
  let bm;
  while ((bm = blockRe.exec(body))) ends.push(bm.index + bm[0].length);
  if (ends.length === 0) return { body: body + figures.map(figHtml).join(''), placed: figures.length };

  const { plain, map } = buildPlainMap(body);
  const used = new Set();
  const placements = [];
  const unplaced = [];

  const blockEndAfter = (origIdx) => {
    for (const e of ends) if (e > origIdx && !used.has(e)) return e;
    return null;
  };

  for (const fig of figures) {
    let origIdx = -1;
    if (fig.anchor) {
      const a = String(fig.anchor).toLowerCase().replace(/\s+/g, ' ').trim();
      const raw = body.toLowerCase().indexOf(a);
      if (raw >= 0) origIdx = raw;
      else {
        const pi = plain.indexOf(a);
        if (pi >= 0) origIdx = map[pi];
        else if (a.length > 24) {
          const pi2 = plain.indexOf(a.slice(0, 24));   // prefix fallback
          if (pi2 >= 0) origIdx = map[pi2];
        }
      }
    }
    if (origIdx >= 0) {
      const e = blockEndAfter(origIdx);
      if (e != null) { placements.push({ offset: e, html: figHtml(fig) }); used.add(e); continue; }
    }
    unplaced.push(figHtml(fig));
  }

  // spread unplaced figures across the remaining block boundaries
  const free = ends.filter((e) => !used.has(e));
  if (unplaced.length && free.length) {
    const step = Math.max(1, Math.floor(free.length / (unplaced.length + 1)));
    let fi = step;
    for (const html of unplaced) {
      const e = free[Math.min(fi, free.length - 1)];
      if (!used.has(e)) { placements.push({ offset: e, html }); used.add(e); }
      fi += step;
    }
  }

  placements.sort((x, y) => y.offset - x.offset);   // splice from end to start
  let out = body;
  for (const pl of placements) out = out.slice(0, pl.offset) + pl.html + out.slice(pl.offset);
  return { body: out, placed: placements.length };
}

// ─── granular steps (v2) ─────────────────────────────────────────────────────
// generateArticleFigures below does the whole job in one call. These are the
// same stages as separate steps, so a workflow can order them and a failed
// render can be skipped without costing the article that was already saved.

// Step 1 — design the set (one LLM step). Reads the post when the caller only
// carries a slug, so it works both right after a save and standalone.
export async function draftFigures(api, { blog_slug = null, slug = null, title = null, excerpt = null, body = null } = {}) {
  let t = title, e = excerpt, b = body;
  const target = blog_slug || slug || null;
  if (!b || !t) {
    if (!target) throw new Error('draft_figures: blog_slug (or title + body) required');
    const post = await readPost(api, target);
    if (!post) throw new Error(`draft_figures: blog post not found: ${target}`);
    t = t || post.title; e = e || post.excerpt; b = b || post.body;
  }
  // Strip any previously embedded figures so the drafter reads the prose, not
  // the last run's images, and anchors land on real sentences.
  const clean = String(b || '').replace(/<figure>\s*<img[^>]*blog-figures\/[^>]*>\s*<\/figure>/gi, '');
  const { figures, cover } = await draftFigureSpecs(api, { title: t, excerpt: e, body_text: clean });
  if (!figures?.length) throw new Error('draft_figures: no figure specs generated');
  return { blog_slug: target, specs: figures, cover: cover || null };
}

// Step 2 — render the designed specs to stored PNGs, host-side. The host
// renderer drops (and logs) any single template that fails rather than losing
// the whole set, and logs article_figures_generated itself.
export async function renderFigures(api, { blog_slug = null, slug = null, specs = null } = {}) {
  const target = blog_slug || slug || null;
  if (!target) throw new Error('render_figures: blog_slug required');
  if (!Array.isArray(specs) || !specs.length) throw new Error('render_figures: specs required');
  return api.gateway('render', 'figures', { blog_slug: target, specs: specs.map((s) => ({ ...s, slots: stripSlots(s.slots) })) });
}

// Step 3 — place the rendered figures in the body at their anchor sentences.
// Always strips the previous run's figures first, so re-running is idempotent
// instead of stacking duplicate images down the article.
export async function embedFiguresInPost(api, { blog_slug = null, slug = null, figures = null, actor = 'system' } = {}) {
  const target = blog_slug || slug || null;
  if (!target) throw new Error('embed_figures: blog_slug required');
  if (!Array.isArray(figures) || !figures.length) throw new Error('embed_figures: figures required');

  const post = await readPost(api, target);
  if (!post) throw new Error(`embed_figures: blog post not found: ${target}`);
  const workBody = String(post.body || '').replace(/<figure>\s*<img[^>]*blog-figures\/[^>]*>\s*<\/figure>/gi, '');
  const { body, placed } = embedFigures(workBody, figures);

  await api.db.prepare(
    `UPDATE plugin_editorial_blog_posts SET body=?, updated_at=?, updated_by=? WHERE slug=?`,
  ).bind(stripDashes(body), now(), actor, target).run();
  await api.log('article_figures_embedded', { slug: target, placed, actor });
  return { ok: true, blog_slug: target, placed };
}

// Step 4 — draft the three hero slots (one cheap LLM step, no body, no menu).
export async function draftCover(api, { title = null, excerpt = null, blog_slug = null, slug = null } = {}) {
  let t = title, e = excerpt;
  if (!t) {
    const target = blog_slug || slug || null;
    if (!target) throw new Error('draft_cover: title (or blog_slug) required');
    const post = await readPost(api, target);
    if (!post) throw new Error(`draft_cover: blog post not found: ${target}`);
    t = post.title; e = e || post.excerpt;
  }
  const cover = await draftCoverSlots(api, { title: t, excerpt: e });
  return { cover: cover || { kicker: null, highlight: '', sub: e || null } };
}

// Step 5 — render the cover PNG host-side. Deterministic fallback slots (first
// tag + title + excerpt) are resolved HERE from the plugin's own post row and
// baked into the cover object, so the render gateway never needs to consult a
// blog table. Returns { blog_slug, cover_url, cover_key } — deliberately no
// generic `url` key (set_featured_image reads cover_url; a bare `url` in a
// workflow's shared context is a trap for later steps).
export async function renderCover(api, { blog_slug = null, slug = null, title = null, excerpt = null, cover = null } = {}) {
  const target = blog_slug || slug || null;
  let t = title, e = excerpt, firstTag = null;
  if (target) {
    const post = await readPost(api, target);
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

  return api.gateway('render', 'cover', {
    blog_slug: target,
    title: stripDashes(t),
    excerpt: e || '',
    cover: stripSlots({
      kicker:    cover?.kicker || firstTag || 'NYYON',
      highlight: cover?.highlight || '',
      sub:       cover?.sub || e || '',
    }),
  });
}

// Step 6 — point the post at an image. The ONLY writer of the featured-image
// fields, whether the winner came from a code-drawn cover or the AI judge.
export async function setFeaturedImage(api, { blog_slug = null, slug = null, url = null, cover_url = null, winner_url = null, model = null, prompt = null, actor = 'system' } = {}) {
  const target = blog_slug || slug || null;
  const image = url || winner_url || cover_url || null;
  if (!target) throw new Error('set_featured_image: blog_slug required');
  if (!image) throw new Error('set_featured_image: url required');

  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_blog_posts SET featured_image_url=?, featured_image_model=?, featured_image_prompt=COALESCE(?, featured_image_prompt), featured_image_generated_at=?, updated_at=?, updated_by=? WHERE slug=?`,
  ).bind(image, model || 'article-cover', prompt, t, t, actor, target).run();
  await api.log('blog_featured_image_set', { slug: target, url: image, model: model || 'article-cover', actor });
  return { ok: true, blog_slug: target, featured_image_url: image };
}

// The whole job in one call: draft specs + cover, render, embed, set featured.
export async function generateArticleFigures(api, opts = {}) {
  const startedAt = now();

  if (!opts.slug) throw new Error('article-figures: slug required');

  let post = null;
  try {
    post = await readPost(api, opts.slug);
    if (!post) throw new Error(`blog post not found: ${opts.slug}`);
  } catch (e) {
    await api.log('article_figures_failed', { slug: opts.slug, error: `read: ${String(e.message).slice(0, 200)}`, actor: opts.actor || 'system' });
    throw e;
  }

  try {
    // Work on a copy of the body. In replace mode strip any figures already
    // embedded (a prior run) so we can regenerate cleanly; otherwise skip if
    // figures are present.
    let workBody = post.body || '';
    if (opts.replace) {
      workBody = workBody.replace(
        /<figure>\s*<img[^>]*blog-figures\/[^>]*>\s*<\/figure>/gi, '',
      );
    } else if (workBody.includes('blog-figures/')) {
      return { ok: false, reason: 'figures_already_embedded', slug: opts.slug };
    }

    // Draft figure specs + cover via LLM (varied templates, anchored to sentences)
    const { figures: figureSpecs, cover } = await draftFigureSpecs(api, {
      title: post.title,
      excerpt: post.excerpt,
      body_text: workBody,
    });

    if (!figureSpecs || figureSpecs.length === 0) {
      throw new Error('no figure specs generated');
    }

    // Render the set host-side (the renderer drops individual failures and
    // carries anchor/featured/alt through on each rendered figure).
    const rendered = await api.gateway('render', 'figures', {
      blog_slug: post.slug,
      specs: figureSpecs.map((s) => ({ ...s, slots: stripSlots(s.slots) })),
    });
    const figures = rendered?.figures || [];
    if (figures.length === 0) {
      throw new Error('no figures rendered successfully');
    }

    // Embed figures at their anchor sentences (story-placed, spread out)
    const { body: enrichedBody, placed } = embedFigures(workBody, figures);

    // Render the dedicated FEATURED COVER (1200x630 hero) and use it as the
    // featured image. Falls back to the LLM-flagged in-body figure if the
    // cover can't be drafted/rendered for any reason.
    let featuredUrl = (figures.find((f) => f.featured) || figures[0]).url;
    let coverUrl = null;
    try {
      let firstTag = null;
      try {
        const parsedTags = JSON.parse(post.tags || '[]');
        if (Array.isArray(parsedTags) && typeof parsedTags[0] === 'string') firstTag = parsedTags[0];
      } catch { if (Array.isArray(post.tags)) firstTag = post.tags[0] || null; }
      const coverRes = await api.gateway('render', 'cover', {
        blog_slug: post.slug,
        title: stripDashes(post.title),
        excerpt: post.excerpt || '',
        cover: stripSlots({
          kicker:    cover?.kicker || firstTag || 'NYYON',
          highlight: cover?.highlight || '',
          sub:       cover?.sub || post.excerpt || '',
        }),
      });
      coverUrl = coverRes?.cover_url || null;
      if (coverUrl) featuredUrl = coverUrl;
    } catch (coverErr) {
      console.error(`[article-figures] cover render failed for ${post.slug}:`, coverErr?.message || coverErr);
    }

    await api.db.prepare(
      `UPDATE plugin_editorial_blog_posts SET body=?, featured_image_url=?, featured_image_model=?, featured_image_generated_at=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(stripDashes(enrichedBody), featuredUrl, 'article-cover', startedAt, now(), opts.actor || 'system', post.slug).run();

    // (The host render gateway already logs article_figures_generated; this
    // adds the workflow-run trail the host wrote to workflow_runs.)
    await api.log('workflow_run', {
      workflow_slug: 'article-figures',
      status: 'succeeded',
      trigger_kind: opts.trigger_kind || 'manual',
      trigger_payload: { slug: post.slug, title: post.title },
      output: { count: figures.length, placed, featured_url: featuredUrl, templates: figures.map((f) => f.template), figures: figures.map((f) => ({ template: f.template, url: f.url, anchor: f.anchor })) },
      started_at: startedAt,
    });

    return {
      ok: true,
      slug: post.slug,
      title: post.title,
      count: figures.length,
      placed,
      templates: figures.map((f) => f.template),
      figures,
      featured_url: featuredUrl,
      started_at: startedAt,
    };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await api.log('article_figures_failed', { slug: opts.slug, error: msg, actor: opts.actor || 'system' });
    await api.log('workflow_run', {
      workflow_slug: 'article-figures',
      status: 'failed',
      trigger_kind: opts.trigger_kind || 'manual',
      trigger_payload: { slug: opts.slug, title: post?.title },
      error: msg,
      started_at: startedAt,
    });
    throw e;
  }
}

// Lightweight cover-slot drafter: derives just the three hero slots from the
// title + excerpt. Far cheaper than draftFigureSpecs (no body, no template
// menu, tiny max_tokens) so a full-catalogue cover backfill won't exhaust the
// LLM's per-minute token budget the way the heavy drafter does.
const COVER_SYSTEM = `You design the hero cover for an editorial blog by Nyyon, a white-glove AI-native marketing agency. Given an article title and excerpt, return ONLY raw JSON with the three requested fields. Always spell the brand "Nyyon" with a capital N.`;

async function draftCoverSlots(api, { title, excerpt }) {
  const prompt = [
    `Title: ${title}`,
    `Excerpt: ${excerpt || ''}`,
    '',
    'Return JSON: {',
    '  "kicker": "<short topic label in CAPS, <=26 chars, e.g. AI-NATIVE MARKETING>",',
    '  "highlight": "<ONE word or short phrase copied EXACTLY from the Title, <=24 chars, the idea-carrying part that prints in the accent colour>",',
    '  "sub": "<one-line standfirst, <=84 chars, a sharpened version of the excerpt>"',
    '}',
  ].join('\n');
  const raw = await api.gateway('llm', 'text', {
    system: await withVoice(api, COVER_SYSTEM),
    prompt,
    response_format: { type: 'json_object' },
    max_tokens: 400,
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return { kicker: parsed.kicker || null, highlight: parsed.highlight || '', sub: parsed.sub || null };
}

// Re-render ONLY the featured cover for an existing post. No body change —
// used to refresh branding on covers generated by an older engine. The host
// renderer writes a fresh versioned key (a same-key overwrite is served stale
// by the CDN), so the live image URL updates via a guaranteed cache miss.
export async function regenerateCover(api, opts = {}) {
  const startedAt = now();
  if (!opts.slug) throw new Error('regenerate-cover: slug required');

  const post = await readPost(api, opts.slug);
  if (!post) throw new Error(`blog post not found: ${opts.slug}`);

  let firstTag = null;
  try {
    const t = JSON.parse(post.tags || '[]');
    if (Array.isArray(t) && t.length && typeof t[0] === 'string') firstTag = t[0];
  } catch { /* tags may be a plain string or null — fall back to NYYON */ }

  // Deterministic slots: used as-is, or as the fallback when LLM polish fails.
  let coverSlots = {
    kicker:    firstTag || 'NYYON',
    highlight: '',
    sub:       post.excerpt || '',
  };
  let model = 'article-cover';

  // Polish: re-draft the cover's kicker/highlight/standfirst via the same LLM
  // drafter the original generator uses, so the refreshed cover keeps the
  // accent highlight word and custom standfirst.
  if (opts.polish) {
    try {
      const cover = await draftCoverSlots(api, { title: post.title, excerpt: post.excerpt });
      if (cover) {
        coverSlots = {
          kicker:    cover.kicker || coverSlots.kicker,
          highlight: cover.highlight || '',
          sub:       cover.sub || coverSlots.sub,
        };
        model = 'article-cover-llm';
      }
    } catch (e) {
      console.error(`[regenerate-cover] LLM draft failed for ${post.slug}, using deterministic slots:`, e?.message || e);
    }
  }

  const rendered = await api.gateway('render', 'cover', {
    blog_slug: post.slug,
    title: stripDashes(post.title),
    excerpt: post.excerpt || '',
    cover: stripSlots(coverSlots),
  });
  const coverUrl = rendered?.cover_url;
  if (!coverUrl) throw new Error('regenerate-cover: renderer returned no cover_url');

  await api.db.prepare(
    `UPDATE plugin_editorial_blog_posts SET featured_image_url=?, featured_image_model=?, featured_image_generated_at=?, updated_at=?, updated_by=? WHERE slug=?`,
  ).bind(coverUrl, model, startedAt, now(), opts.actor || 'system', post.slug).run();

  await api.log('article_cover_regenerated', { slug: post.slug, featured_url: coverUrl, model, actor: opts.actor || 'system' });

  return { ok: true, slug: post.slug, featured_url: coverUrl, model, started_at: startedAt };
}

// ─── single-figure regenerate ────────────────────────────────────────────────
// Redesign ONE in-article chart, optionally steered by operator instructions —
// the editor's per-chart "Change" button. Never touches the rest of the body:
// it finds the one <figure> block, drafts a single replacement spec (the
// operator's instructions lead the prompt when given), renders it host-side,
// and splices it in place.
const SINGLE_DRAFTER_SYSTEM = `You are a technical figure designer for nyyon, a white-glove AI-native marketing agency. You redesign ONE editorial diagram inside an existing article.

You receive the article's title/excerpt, the text surrounding the figure being replaced (marked [THE FIGURE SITS HERE]), the current figure's description, optional OPERATOR INSTRUCTIONS, and a menu of diagram templates (each is a STORY SHAPE — pick the one matching the shape of the idea at that point in the article).

RULES:
1. Design exactly ONE figure. It must illustrate the point made in the surrounding text.
2. If OPERATOR INSTRUCTIONS are present they OVERRIDE everything else — follow them literally (template choice, content, framing).
3. Without instructions, produce a genuinely different, better take than the current figure — a sharper shape or sharper labels, not a cosmetic reshuffle.
4. Fill every slot the chosen template needs. Respect character limits. Use CAPS where a slot says caps. Terse, concrete labels — nyyon voice: declarative, zero hype.
5. Set "alt": one plain-English sentence describing the figure.

Output ONLY valid JSON, no markdown:
{ "template": "<name>", "alt": "<one sentence>", "slots": { ... } }`;

export async function regenerateOneFigure(api, opts = {}) {
  const startedAt = now();
  const { slug, src, instructions } = opts;
  if (!slug) throw new Error('regenerate-figure: slug required');
  if (!src) throw new Error('regenerate-figure: src required');

  const post = await readPost(api, slug);
  if (!post) throw new Error(`blog post not found: ${slug}`);
  const body = post.body || '';

  // Identify the figure by the stable blog-figures/... path segment of its img
  // src — identical in dev-rewritten and public URLs, so the client can send
  // whichever it is displaying.
  const pathMatch = String(src).match(/blog-figures\/[^"'?\s]+/);
  if (!pathMatch) throw new Error('regenerate-figure: src is not an article figure');
  const pathKey = pathMatch[0];

  const figRe = /<figure\b[^>]*>[\s\S]*?<\/figure>/gi;
  let block = null;
  let blockStart = -1;
  let fm;
  while ((fm = figRe.exec(body))) {
    if (fm[0].includes(pathKey)) { block = fm[0]; blockStart = fm.index; break; }
  }
  if (!block) throw new Error('regenerate-figure: figure not found in article body');

  const currentAlt = (block.match(/alt="([^"]*)"/i) || [])[1] || '';

  // Plain-text context around the figure, so the replacement illustrates the
  // same point in the article's story.
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const before = strip(body.slice(0, blockStart));
  const after = strip(body.slice(blockStart + block.length));
  const context = `${before.slice(-700)}\n[THE FIGURE SITS HERE]\n${after.slice(0, 400)}`;

  const menu = FIGURE_TEMPLATE_NAMES
    .map((name) => `${name}: ${FIGURE_SLOT_MENU[name]}`)
    .join('\n\n');

  const prompt = [
    `Article title: ${post.title}`,
    `Excerpt: ${post.excerpt || '(none)'}`,
    '',
    'Text surrounding the figure being replaced:',
    context,
    '',
    `Current figure's description (alt): ${currentAlt || '(none)'}`,
    instructions ? `\nOPERATOR INSTRUCTIONS — follow these above all else:\n${String(instructions).slice(0, 1000)}` : '',
    '',
    'Templates and their slots:',
    menu,
    '',
    'Design the ONE replacement figure now. Return the JSON.',
  ].filter((l) => l !== null).join('\n');

  try {
    const raw = await api.gateway('llm', 'text', {
      system: await withChartGuide(api, await withVoice(api, SINGLE_DRAFTER_SYSTEM)),
      prompt,
      response_format: { type: 'json_object' },
    });
    const spec = parseJsonLoose(raw);
    if (!spec || typeof spec !== 'object' || !spec.slots) throw new Error('drafter returned no figure spec');
    if (!FIGURE_SLOT_MENU[spec.template]) spec.template = 'contrast'; // fallback, same as the batch drafter

    // Render the one figure host-side (a specs array of one). The host writes
    // a fresh versioned key, so the CDN can never serve the old image.
    const rendered = await api.gateway('render', 'figures', {
      blog_slug: post.slug,
      specs: [{ template: spec.template, alt: spec.alt || null, slots: stripSlots(spec.slots) }],
    });
    const fig = rendered?.figures?.[0];
    if (!fig?.url) throw new Error('renderer returned no figure');

    const alt = spec.alt || currentAlt || 'Editorial diagram';
    const figureHtml = `<figure><img src="${fig.url}" alt="${esc(alt)}" loading="lazy" /></figure>`;
    const nextBody = body.slice(0, blockStart) + figureHtml + body.slice(blockStart + block.length);

    await api.db.prepare(
      `UPDATE plugin_editorial_blog_posts SET body=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(stripDashes(nextBody), now(), opts.actor || 'operator', post.slug).run();

    await api.log('article_figure_regenerated', {
      slug: post.slug, replaced: pathKey, url: fig.url, template: spec.template, instructed: !!instructions, actor: opts.actor || 'operator', started_at: startedAt,
    });

    return { ok: true, slug: post.slug, url: fig.url, alt, template: spec.template, figure_html: figureHtml };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await api.log('article_figure_regenerate_failed', { slug, replaced: pathKey, error: msg, actor: opts.actor || 'operator' });
    throw e;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURED IMAGES (from blog-images.js)
// AI candidate renders + the vision judge; the winner becomes the cover.
// ════════════════════════════════════════════════════════════════════════════

// How many candidates to render per blog. Vision judge picks the winner.
const CANDIDATES_PER_RUN = 3;

// ─── Nyyon visual style ────────────────────────────────────────────────────
// Deep navy space + electric blue/violet light physics; light BEHAVIOR as the
// cinematic metaphor. Approved June 2026 ("Noise → Signal" locked the style).
const NYYON_STYLE_BLOCK = `Cinematic CGI render. Deep navy space background (very dark blue-black, #0B0F2E tone). Electric blue and violet light energy — volumetric, photorealistic light physics, high-end visual effects quality. No text overlays (except a minimal scale bar if described). No people, no faces, no hands, no body parts. No logos, no brand marks, no watermarks. No physical objects with brand associations (no phones, computers, buildings). Abstract light and energy only.`;

// ─── Brief drafter system prompt ──────────────────────────────────────────
const BRIEF_SYSTEM = `You design cinematic featured images for a premium AI marketing blog (Nyyon). The visual language is: deep navy space, electric blue and violet light energy, cinematic CGI, photorealistic light physics.

Your job: read the article's core argument, then describe a LIGHT BEHAVIOR SCENE that makes that argument VISIBLE. A reader glancing for 2 seconds should FEEL the concept.

Think in light metaphors:
- Refraction / prism → transformation, reinterpretation, splitting one thing into its components
- Convergence → multiple inputs unifying into one output, focus, synthesis
- Diffusion → noise, scatter, lack of direction, wasted energy
- Focused beam → precision, signal, direct path, clarity
- Splitting / divergence → choice, separation, two paths from one origin
- Acceleration / motion blur → speed, velocity, time compression
- Interference / wave overlap → conflict, resonance, two forces meeting
- Absorption → disappearance, simplification, hidden depth
- Cascading reflection → compounding, multiplication, exponential growth

Process silently:
1. What is the single core tension or transformation in this article?
2. Which light behavior maps to it most precisely?
3. How do I compose the scene so the metaphor is spatially clear — left to right, before/after, contrast, etc.?
4. What 2-word label pair (e.g. "Noise / Signal", "Old / New", "Scatter / Focus") would I put on a minimal scale bar at the bottom?

Output format — TWO parts separated by | :
SCENE: [max 40 words describing exactly what the viewer sees — light behavior, spatial arrangement, directionality]
LABEL: [left label] / [right label]

No style, color, or brand mentions in your output — those are appended.

Examples:

Article: "AI models that look the same but have completely different internal architectures"
SCENE: Two identical beams enter from the left. The top beam passes through an invisible surface and exits as one clean bright line. The bottom beam hits the same surface and scatters into dozens of dim crossing rays.
LABEL: Replicated / Rebuilt

Article: "Compounding marketing systems that grow faster over time"
SCENE: A single point of light on the far left emits one beam that splits at each reflection point, doubling each time, filling the right side of the frame with an expanding cascade of bright beams.
LABEL: Linear / Compound

Article: "How AI turns raw data noise into actionable decisions"
SCENE: Left side scattered diffuse electric blue light spreading in all directions. Center an invisible refractive surface. Right side all that scattered light bends into one sharp violet-white beam.
LABEL: Noise / Signal

Article: "Why most AI features fail to reach real users"
SCENE: A strong bright beam on the left loses intensity at each successive translucent barrier, arriving at the right edge as a faint diffuse glow — same origin, diminished output.
LABEL: Launched / Delivered`;

// The visual style lives in the editable plugin-editorial-visual-style doc,
// seeded from the approved June-2026 direction on first read. BOTH the
// generator prompt and the vision judge read this one doc, so the two can
// never contradict. Editing the doc changes both sides together.
async function getVisualStyle(api) {
  try {
    const doc = await api.knowledge(VISUAL_STYLE_SLUG);
    if (doc?.body?.trim()) return doc.body.trim();
    await api.saveKnowledge(VISUAL_STYLE_SLUG, {
      title: 'Visual style — blog covers + figures (read by generator AND judge)',
      body: NYYON_STYLE_BLOCK,
    });
  } catch { /* fall through to the coded default */ }
  return NYYON_STYLE_BLOCK;
}

function composePrompt({ style, visualBrief, label }) {
  const labelBar = label
    ? ` At the very bottom: a thin white horizontal line spanning 70% of the width, small dot on far left labeled "${label.split('/')[0].trim()}" in clean white sans-serif caps, small dot on far right labeled "${label.split('/')[1].trim()}" in clean white sans-serif caps. Minimal, understated.`
    : '';
  return `${style || NYYON_STYLE_BLOCK} ${visualBrief}${labelBar}`;
}

// Returns { scene, label } — scene is the light behavior description,
// label is the "Left / Right" pair for the scale bar (may be null).
async function draftVisualBrief(api, { title, excerpt, tags }) {
  const prompt = [
    `Title: ${title}`,
    excerpt ? `Excerpt: ${excerpt}` : null,
    Array.isArray(tags) && tags.length ? `Tags: ${tags.slice(0, 4).join(', ')}` : null,
    '',
    'Draft the scene and label now.',
  ].filter(Boolean).join('\n');

  try {
    const raw = String(await api.gateway('llm', 'text', { system: BRIEF_SYSTEM, prompt })).trim();
    // Parse "SCENE: ... | LABEL: ..." or just treat the whole thing as scene.
    const sceneMatch = raw.match(/SCENE:\s*([\s\S]+?)(?:\nLABEL:|$)/i);
    const labelMatch = raw.match(/LABEL:\s*(.+)/i);
    const scene = (sceneMatch?.[1] || raw).trim().replace(/^["']|["']$/g, '');
    const label = labelMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
    return { scene, label };
  } catch (e) {
    return {
      scene: `Scattered electric blue light on the left converges through an invisible refractive surface into a single focused beam on the right, embodying the transformation described in "${title}".`,
      label: null,
    };
  }
}

// Vision judge rubric — built from the SAME style doc the generator uses.
const judgeSystem = (style) => `You evaluate AI-generated featured-image candidates for a premium B2B publication (Nyyon) and pick the best one for a specific article.

You will see N candidates. The target aesthetic, verbatim from the house style guide:

${style}

Score each 0-100:

- composition (0-35): Confident, intentional composition that fills the frame with visual weight and purpose. Elements should relate to each other deliberately. Random scatter = low. Deliberate tension and balance = high.
- topic_aptness (0-25): Does the image abstractly gesture at the article's core argument? Disconnected generic pattern = low.
- aesthetic_polish (0-25): How faithfully does the candidate execute the target aesthetic above — its materials, lighting, palette, and finish? Off-style execution (wrong medium, wrong palette, wrong rendering style) = low.
- brand_fit (0-10): Feels premium editorial and matches the style guide's palette and restrictions. Any stock-photo or generic AI look = 0.
- artifacts (0-5): NO unrequested text, labels, numbers, signatures, watermarks, faces, hands, or people. Any of those = 0.

Total = sum (max 100).

Output ONLY a JSON object:
{ "winner": <1-based index of best>, "scores": [{"composition":N,"topic_aptness":N,"aesthetic_polish":N,"brand_fit":N,"artifacts":N,"total":N}, ...], "reasoning": "<one short sentence about why the winner won>" }`;

// ─── granular steps (v2) ─────────────────────────────────────────────────────

// Step 1 — the visual brief. Returns the finished image prompt too, so the
// render step needs nothing but what this puts in context.
export async function draftImageBrief(api, { title = null, excerpt = null, tags = null, blog_slug = null, slug = null } = {}) {
  let t = title, e = excerpt, tg = tags;
  if (!t) {
    const target = blog_slug || slug || null;
    if (!target) throw new Error('draft_visual_brief: title (or blog_slug) required');
    const post = await readPost(api, target);
    if (!post) throw new Error(`draft_visual_brief: blog post not found: ${target}`);
    t = post.title; e = e || post.excerpt;
    if (!tg) { try { tg = JSON.parse(post.tags || '[]'); } catch { tg = []; } }
  }
  const style = await getVisualStyle(api);
  const { scene, label } = await draftVisualBrief(api, { title: t, excerpt: e, tags: tg });
  return { scene, label, prompt: composePrompt({ style, visualBrief: scene, label }) };
}

// Step 2 — render N candidates and store them, host-side. The render loop and
// the raw bytes stay behind the gateway: each candidate is written to storage
// there and only its URL travels onward. A null model lets the host pick its
// default (it can see which image keys are configured; the plugin cannot).
export async function renderCandidateImages(api, { blog_slug = null, slug = null, prompt = null, n = null, model = null } = {}) {
  const target = blog_slug || slug || null;
  if (!target) throw new Error('render_images: blog_slug required');
  if (!prompt) throw new Error('render_images: prompt required');
  return api.gateway('render', 'images', {
    blog_slug: target,
    prompt,
    n: Number(n) > 0 ? Math.min(Number(n), 4) : CANDIDATES_PER_RUN,
    model: model || null,
  });
}

// Step 3 — the vision judge. Scores all candidates in ONE vision call by their
// stored URLs (the R2 byte-read stays host; callOpenAIVision accepts http(s)
// URLs). Falls back to the first candidate when the judge is unavailable or
// errors, so a flaky call never blocks a post.
export async function judgeCandidateImages(api, { candidates = null, title = null, blog_slug = null, slug = null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) throw new Error('judge_images: candidates required');
  let t = title;
  if (!t) {
    const post = await readPost(api, String(blog_slug || slug || ''));
    t = post?.title || 'Untitled';
  }

  if (list.length === 1) {
    return { winner_url: list[0].url, winner_index: 0, scores: null, reasoning: 'single candidate' };
  }

  const style = await getVisualStyle(api);
  let winnerIdx = 0, report = null;
  try {
    const raw = await api.gateway('llm', 'vision', {
      system: judgeSystem(style),
      prompt: `Article title: "${t}"\n\nThere are ${list.length} candidate images below in order. Score each, then pick the winner.`,
      images: list.map((c) => c.url),
      response_format: { type: 'json_object' },
    });
    report = JSON.parse(raw);
    const idx = Number(report?.winner) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < list.length) winnerIdx = idx;
  } catch (e) {
    report = { error: String(e?.message || e).slice(0, 300) };
  }
  const winner = list[winnerIdx];
  return {
    winner_url: winner.url,
    winner_index: winnerIdx,
    model: winner.model,
    scores: report?.scores || null,
    reasoning: report?.reasoning || report?.error || null,
  };
}

/**
 * Generate the featured image for a blog post and persist the URL back to
 * plugin_editorial_blog_posts.
 *
 *   api, { slug, title, excerpt, tags?, prompt_override?, model?, actor? }
 *
 * The winner's stored candidate URL (with a ?v= cache-bust) becomes the
 * featured image — the host original re-stored the winner's bytes at
 * blog/<slug>.png, a copy that needed R2 access and stays host-side.
 */
export async function generateBlogFeaturedImage(api, opts) {
  if (!opts?.slug)  throw new Error('blog-images: slug required');
  if (!opts?.title) throw new Error('blog-images: title required');

  const startedAt = now();
  // Operator can hand-craft a prompt to override the LLM brief drafter; that
  // path skips the drafting call entirely.
  let scene  = null;
  let label  = null;
  let prompt = opts.prompt_override;
  const style = await getVisualStyle(api);
  if (!prompt) {
    const brief = await draftVisualBrief(api, { title: opts.title, excerpt: opts.excerpt, tags: opts.tags });
    scene  = brief.scene;
    label  = brief.label;
    prompt = composePrompt({ style, visualBrief: scene, label });
  }
  const N = opts.candidates || CANDIDATES_PER_RUN;

  try {
    // 1. Render N candidates host-side (model default resolved there).
    const rendered = await api.gateway('render', 'images', {
      blog_slug: opts.slug,
      prompt,
      n: N,
      model: opts.model || null,
    });
    const candidates = rendered?.candidates || [];
    if (!candidates.length) throw new Error('no candidates rendered');

    // 2. Vision judge picks the winner; candidate 0 on any judge trouble.
    const judged = await judgeCandidateImages(api, { candidates, title: opts.title });
    const winnerIdx = judged.winner_index || 0;
    const winner = candidates[winnerIdx];
    const judgeReport = { scores: judged.scores, reasoning: judged.reasoning };

    // 3. Persist the winner. Cache-bust with a version query so a regenerated
    //    cover always renders fresh even through CDN caches.
    const generatedAt = now();
    const versionedUrl = `${winner.url}${winner.url.includes('?') ? '&' : '?'}v=${generatedAt}`;
    await api.db.prepare(
      `UPDATE plugin_editorial_blog_posts
          SET featured_image_url          = ?,
              featured_image_prompt       = ?,
              featured_image_model        = ?,
              featured_image_generated_at = ?
        WHERE slug = ?`,
    ).bind(versionedUrl, prompt, winner.model, generatedAt, opts.slug).run();

    await api.log('blog_image_generated', {
      slug: opts.slug, model: winner.model, size_bytes: winner.size_bytes, candidates_total: candidates.length, judge_winner: winnerIdx + 1, actor: opts.actor || 'system',
    });

    await api.log('workflow_run', {
      workflow_slug:   'blog-featured-image',
      status:          'succeeded',
      trigger_kind:    opts.actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { slug: opts.slug, title: opts.title },
      output: {
        url: winner.url,
        model: winner.model,
        size_bytes: winner.size_bytes,
        visual_brief: scene,
        candidates_total: candidates.length,
        judge_winner: winnerIdx + 1,
        judge_report: judgeReport,
      },
      started_at: startedAt,
    });

    return {
      url:          versionedUrl,
      key:          winner.key,
      model:        winner.model,
      prompt,
      generated_at: generatedAt,
      size_bytes:   winner.size_bytes,
      width:        winner.width,
      height:       winner.height,
      slug:         opts.slug,
      visual_brief: scene,
      candidates_total: candidates.length,
      judge_winner:     winnerIdx + 1,
      judge_report:     judgeReport,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    await api.log('blog_image_failed', { slug: opts.slug, error: msg.slice(0, 300), actor: opts.actor || 'system' });
    await api.log('workflow_run', {
      workflow_slug:   'blog-featured-image',
      status:          'failed',
      trigger_kind:    opts.actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { slug: opts.slug },
      error:           msg,
      started_at:      startedAt,
    });
    throw e;
  }
}

/**
 * Convenience: look up a blog post by slug and generate (or regenerate) its
 * featured image. Used by the manual ops button + Nyo tool.
 */
export async function regenerateBlogFeaturedImage(api, slug, { actor, prompt_override, model } = {}) {
  const post = await readPost(api, slug);
  if (!post) throw new Error(`blog post not found: ${slug}`);
  let tags = post.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
  return generateBlogFeaturedImage(api, {
    slug,
    title:   post.title,
    excerpt: post.excerpt,
    tags,
    actor,
    prompt_override,
    model,
  });
}
