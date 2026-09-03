// Daily Planner plugin — search_daily_plans. Ported verbatim from the host module;
// every host import replaced by the capability object (api.db is scoped to the
// plugin_daily_planner_* tables, api.knowledge to the declared read set).

export const def = {
  name: 'search_daily_plans',
  description: 'Search past daily plans by text (matches the summary, the to-dos and the blocks). Use it to recall or reuse an earlier day. An empty query returns the most recent plans.',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 20, max 100' } }, required: [] },
};

// Smaller models (and any model under pressure) routinely pass an array
// parameter as a JSON STRING. Treating that as "not an array" saved an EMPTY
// plan and reported success, which is worse than an error: the operator sees
// a blank day and no reason. Parse the string, then carry on.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    try { const p = JSON.parse(t); return Array.isArray(p) ? p : [p]; } catch { return []; }
  }
  if (v && typeof v === 'object') return [v];
  return [];
}
function normalizePlanBody(plan = {}) {
  const schedule = asArray(plan.schedule).map((b, i) => ({
    id: b.id || `b${i + 1}`,
    start: b.start ? String(b.start).slice(0, 10) : null,
    end: b.end ? String(b.end).slice(0, 10) : null,
    title: String(b.title || '').slice(0, 400),
    deliverable: b.deliverable ? String(b.deliverable).slice(0, 400) : null,
    done: !!b.done,
    focus: !!b.focus,
  }));
  const todos = asArray(plan.todos).map((tk, i) => ({
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

export async function run(api, input) {
  const q = String(input?.query || '');
  const like = `%${q.toLowerCase()}%`;
  const lim = Math.min(Math.max(1, Number(input?.limit) || 20), 100);
  const r = await api.db.prepare(
    `SELECT date, plan, mode, created_at, updated_at FROM plugin_daily_planner_plans
     WHERE ? = '' OR LOWER(plan) LIKE ? ORDER BY date DESC LIMIT ?`,
  ).bind(q, like, lim).all();
  return { query: q, plans: (r.results || []).map(rowToPlan) };
}
