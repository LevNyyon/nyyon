// Daily Planner plugin — the surface's data layer.
//
// The host REST routes this page used to call are gone: a plugin surface
// drives its OWN plugin's tools through the scoped invoke route, so the page
// and the planner chat write through the exact same seven verbs and can never
// diverge. The types live here too — they travel with the module.

export type PlanBlock = {
  id: string;
  start: string | null;
  end: string | null;
  title: string;
  deliverable: string | null;
  done: boolean;
  focus: boolean;
};
export type PlanTodo = { id: string; text: string; done: boolean; star: boolean; priority: number };
export type DailyPlan = {
  date: string;
  mode: 'strategic' | 'wing_it';
  summary: string;
  weekly_ref: string | null;
  schedule: PlanBlock[];
  todos: PlanTodo[];
  created_at: number;
  updated_at: number;
};
export type WeeklyObjective  = { id: string; text: string; done: boolean };
export type WeeklyObjectives = { week_start: string; objectives: WeeklyObjective[]; created_at: number; updated_at: number };

async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const r = await fetch(`/api/plugins/daily-planner/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

type ObjectivesResult = { week_start: string; objectives: WeeklyObjective[]; created_at?: number; updated_at?: number };
const toRow = (r: ObjectivesResult): WeeklyObjectives => ({
  week_start: r.week_start,
  objectives: r.objectives || [],
  created_at: r.created_at ?? 0,
  updated_at: r.updated_at ?? 0,
});

export const planner = {
  dailyPlan: (date?: string) =>
    invoke<{ date: string; plan: DailyPlan | null }>('read_daily_plan', date ? { date } : {}),
  saveDailyPlan: (plan: Partial<DailyPlan>) =>
    invoke<{ date: string; plan: DailyPlan }>('save_daily_plan', plan).then((r) => r.plan),
  searchDailyPlans: (q: string, limit = 30) =>
    invoke<{ query: string; plans: DailyPlan[] }>('search_daily_plans', { query: q, limit }).then((r) => r.plans),
  // `week` = a literal week_start; `date` = any day, anchored to its workweek
  // by the tool (the convention lives server-side, never re-derived here).
  weeklyObjectives: ({ week, date }: { week?: string; date?: string } = {}) =>
    invoke<ObjectivesResult>('read_weekly_objectives', { week_start: week, date })
      .then((r) => ({ week_start: r.week_start, objectives: toRow(r) })),
  saveWeeklyObjectives: (objectives: WeeklyObjective[], week_start?: string) =>
    invoke<ObjectivesResult>('set_weekly_objectives', { objectives, week_start }).then(toRow),
};
