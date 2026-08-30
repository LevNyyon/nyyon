// Daily Planner plugin — read_weekly_objectives. Ported verbatim from the host module;
// every host import replaced by the capability object (api.db is scoped to the
// plugin_daily_planner_* tables, api.knowledge to the declared read set).

export const def = {
  name: 'read_weekly_objectives',
  description: "Read a week's strategic objectives. week_start is that week's Sunday (YYYY-MM-DD), or pass any `date` to have its workweek anchored for you; default is the current week. Read this in strategic mode before planning a day so the day points at the week.",
  input_schema: {
    type: 'object',
    properties: {
      week_start: { type: 'string', description: "the week's Sunday, YYYY-MM-DD; default this week" },
      date: { type: 'string', description: 'any day (YYYY-MM-DD) — its workweek is anchored server-side' },
    },
    required: [],
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
async function weekAnchor(api, dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  let lastWork = 4;
  const cfg = await kpiCfg(api);
  if (Array.isArray(cfg.work_days) && cfg.work_days.length) lastWork = Math.max(...cfg.work_days);
  const wd = d.getUTCDay();
  if (wd > lastWork) d.setUTCDate(d.getUTCDate() + (7 - wd));
  else d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}
function rowToObjectives(row) {
  if (!row) return null;
  let objectives = [];
  try { objectives = JSON.parse(row.objectives || '[]'); } catch { objectives = []; }
  if (!Array.isArray(objectives)) objectives = [];
  return { week_start: row.week_start, objectives, created_at: row.created_at, updated_at: row.updated_at };
}
async function readObjectives(api, weekStart) {
  const row = await api.db
    .prepare('SELECT week_start, objectives, created_at, updated_at FROM plugin_daily_planner_objectives WHERE week_start = ?')
    .bind(weekStart).first();
  return rowToObjectives(row);
}

export async function run(api, input) {
  const week_start = input?.week_start
    || (await weekAnchor(api, input?.date || (await todayLocal(api))));
  const row = await readObjectives(api, week_start);
  return row
    ? { week_start, objectives: row.objectives, created_at: row.created_at, updated_at: row.updated_at }
    : { week_start, objectives: [], note: 'no objectives set for this week yet' };
}
