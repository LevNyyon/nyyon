// Daily Planner plugin — save_daily_plan. Ported verbatim from the host module;
// every host import replaced by the capability object (api.db is scoped to the
// plugin_daily_planner_* tables, api.knowledge to the declared read set).

export const def = {
  name: 'save_daily_plan',
  description: "Write (or replace) a day's plan — this is what fills the plan panel. schedule = time blocks [{start:'HH:MM', end:'HH:MM', title, deliverable, focus}]. Mark each ~2-hour FOCUS SESSION block focus:true (the operator says how many fit in a day) — those are the day's backbone; supporting blocks are focus:false. todos = [{text, priority, star}], star:true for the extra-important few. mode 'strategic' (aligned to the week's objectives, set weekly_ref = that week's Sunday) or 'wing_it'. date defaults to today. Replaces the whole plan; use update_daily_plan to change part of one.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD; default today' },
      mode: { type: 'string', enum: ['strategic', 'wing_it'] },
      summary: { type: 'string', description: 'one line on what this day is about' },
      weekly_ref: { type: 'string', description: "the aligned week's Sunday (YYYY-MM-DD), strategic mode" },
      schedule: { type: 'array', items: { type: 'object' }, description: 'time blocks, each with a concrete deliverable' },
      todos: { type: 'array', items: { type: 'object' }, description: 'checklist items' },
    },
    required: ['schedule'],
  },
};

// kpi-outreach is the host note holding the operator timezone + workweek —
// declared in requires.knowledge so the read is visible at import time.
const KPI_DEFAULTS = { tz: 'UTC', work_days: [0, 1, 2, 3, 4] };
async function kpiCfg(api) {
  try {
    const doc = await api.knowledge('kpi-outreach');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const cfg = m ? JSON.parse(m[1]) : null;
    return cfg && typeof cfg === 'object' ? { ...KPI_DEFAULTS, ...cfg } : KPI_DEFAULTS;
  } catch { return KPI_DEFAULTS; }
}
async function todayLocal(api) {
  const cfg = await kpiCfg(api);
  try { return new Date().toLocaleDateString('en-CA', { timeZone: cfg.tz || 'UTC' }); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function normalizePlanBody(plan = {}) {
  const schedule = (Array.isArray(plan.schedule) ? plan.schedule : []).map((b, i) => ({
    id: b.id || `b${i + 1}`,
    start: b.start ? String(b.start).slice(0, 10) : null,
    end: b.end ? String(b.end).slice(0, 10) : null,
    title: String(b.title || '').slice(0, 400),
    deliverable: b.deliverable ? String(b.deliverable).slice(0, 400) : null,
    done: !!b.done,
    focus: !!b.focus,
  }));
  const todos = (Array.isArray(plan.todos) ? plan.todos : []).map((tk, i) => ({
    id: tk.id || `t${i + 1}`,
    text: String(tk.text || '').slice(0, 400),
    done: !!tk.done,
    star: !!tk.star,
    priority: Number.isFinite(tk.priority) ? tk.priority : i + 1,
  }));
  return {
    summary: String(plan.summary || '').slice(0, 1000),
    weekly_ref: plan.weekly_ref ? String(plan.weekly_ref).slice(0, 10) : null,
    schedule,
    todos,
  };
}
function rowToPlan(row) {
  if (!row) return null;
  let body = {};
  try { body = JSON.parse(row.plan || '{}'); } catch { body = {}; }
  const norm = normalizePlanBody(body);
  return {
    date: row.date, mode: row.mode || body.mode || 'wing_it',
    summary: norm.summary, weekly_ref: norm.weekly_ref,
    schedule: norm.schedule, todos: norm.todos,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
async function readPlan(api, date) {
  const row = await api.db
    .prepare('SELECT date, plan, mode, created_at, updated_at FROM plugin_daily_planner_plans WHERE date = ?')
    .bind(date).first();
  return rowToPlan(row);
}
async function savePlan(api, { date, plan = {}, mode }) {
  const t = Date.now();
  const m = mode || plan.mode || 'wing_it';
  const body = normalizePlanBody(plan);
  await api.db.prepare(
    `INSERT INTO plugin_daily_planner_plans (date, plan, mode, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET plan = excluded.plan, mode = excluded.mode, updated_at = excluded.updated_at`,
  ).bind(date, JSON.stringify({ mode: m, ...body }), m, t, t).run();
  await api.log('plan_saved', { date, mode: m, blocks: body.schedule.length, todos: body.todos.length });
  return readPlan(api, date);
}

export async function run(api, input) {
  const date = input?.date || (await todayLocal(api));
  const plan = await savePlan(api, { date, plan: input, mode: input?.mode });
  return { date, plan };
}
