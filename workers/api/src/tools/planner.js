// Planner — the day plan + weekly objectives, one verb per tool.
//
// Ported from tools/daily-planner.js under ARCHITECTURE-V2: same seven jobs,
// same names, but every result is wrapped in the spec's out shape ({plan},
// {plans}, {objectives}) so the key a caller reads is the key the next step
// would read off ctx.shared. All SQL + logging stays in lib/daily-planner.js
// (the /api/daily-plan routes delegate to the same functions, so the plan the
// panel shows and the plan the planner chat writes can never diverge).
//
// The plan is a self-contained JSON blob per day, deliberately NOT wired into
// the `tasks` table: it is the operator-approved day, editable in the panel
// and by the chat, not a task queue.

import {
  todayLocal, weekAnchor,
  readPlan, savePlan, updatePlan, searchPlans, recentPlans,
  readWeeklyObjectives, saveWeeklyObjectives,
} from '../lib/daily-planner.js';

export const tools = {
  read_daily_plan: {
    def: {
      name: 'read_daily_plan',
      description: "Read one day's plan (schedule blocks + to-dos). date is YYYY-MM-DD, default today. Call this before editing a day or to see what is already planned.",
      input_schema: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD; default today' } },
        required: [],
      },
    },
    // `date` is echoed back because the caller usually passed nothing and the
    // operator-local today was resolved here.
    run: async (env, input) => {
      const date = input?.date || (await todayLocal(env));
      const plan = await readPlan(env, date);
      return plan ? { date, plan } : { date, plan: null, note: 'no plan yet for this day' };
    },
  },

  save_daily_plan: {
    def: {
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
    },
    run: async (env, input) => {
      const date = input?.date || (await todayLocal(env));
      const plan = await savePlan(env, { date, plan: input, mode: input?.mode, actor: 'daily-planner' });
      return { date, plan };
    },
  },

  update_daily_plan: {
    def: {
      name: 'update_daily_plan',
      description: "Edit part of a day's plan during the day (tick a block or to-do done, add a to-do, shift the schedule). Pass ONLY the keys you are changing; everything else is kept as-is. date defaults to today.",
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD; default today' },
          mode: { type: 'string', enum: ['strategic', 'wing_it'] },
          summary: { type: 'string' },
          weekly_ref: { type: 'string' },
          schedule: { type: 'array', items: { type: 'object' } },
          todos: { type: 'array', items: { type: 'object' } },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const { date: rawDate, ...patch } = input || {};
      const date = rawDate || (await todayLocal(env));
      const plan = await updatePlan(env, { date, patch, actor: 'daily-planner' });
      return { date, plan };
    },
  },

  search_daily_plans: {
    def: {
      name: 'search_daily_plans',
      description: 'Search past daily plans by text (matches the summary, the to-dos and the blocks). Use it to recall or reuse an earlier day. An empty query returns the most recent plans.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 20, max 100' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const r = await searchPlans(env, input || {});
      return { query: r.query, plans: r.results };
    },
  },

  list_recent_plans: {
    def: {
      name: 'list_recent_plans',
      description: 'The most recent PAST daily plans, strictly before today (default the last 3). Call it at the start of planning to surface unfinished priorities and ask the operator what happened to each (done / carry over / drop).',
      input_schema: {
        type: 'object',
        properties: { days: { type: 'number', description: 'how many past plans, default 3' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const r = await recentPlans(env, input || {});
      return { days: r.days, before: r.before, plans: r.results };
    },
  },

  read_weekly_objectives: {
    def: {
      name: 'read_weekly_objectives',
      description: "Read a week's strategic objectives. week_start is that week's Sunday (YYYY-MM-DD); default is the current week. Read this in strategic mode before planning a day so the day points at the week.",
      input_schema: {
        type: 'object',
        properties: { week_start: { type: 'string', description: "the week's Sunday, YYYY-MM-DD; default this week" } },
        required: [],
      },
    },
    // weekAnchor, not "last Sunday": the workweek's last day comes from the
    // editable kpi-outreach note, so a weekend date rolls to the NEXT week.
    run: async (env, input) => {
      const week_start = input?.week_start || (await weekAnchor(env, await todayLocal(env)));
      const row = await readWeeklyObjectives(env, week_start);
      return row
        ? { week_start, objectives: row.objectives }
        : { week_start, objectives: [], note: 'no objectives set for this week yet' };
    },
  },

  set_weekly_objectives: {
    def: {
      name: 'set_weekly_objectives',
      description: "Set a week's strategic objectives — the 2-4 outcomes that move the business in the intended direction. objectives is a list of short outcome strings (or {text, done} objects) and REPLACES the week's list. week_start defaults to the current week's Sunday.",
      input_schema: {
        type: 'object',
        properties: {
          objectives: { type: 'array', items: { type: ['string', 'object'] }, description: 'short outcome strings, or {text, done}' },
          week_start: { type: 'string', description: "the week's Sunday, YYYY-MM-DD; default this week" },
        },
        required: ['objectives'],
      },
    },
    run: async (env, input) => {
      const week_start = input?.week_start || (await weekAnchor(env, await todayLocal(env)));
      const saved = await saveWeeklyObjectives(env, { week_start, objectives: input?.objectives, actor: 'daily-planner' });
      return { week_start, objectives: saved?.objectives || [] };
    },
  },
};
