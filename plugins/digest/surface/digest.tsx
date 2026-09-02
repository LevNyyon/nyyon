// Digest plugin — morning brief page (ported from cmd's pages/Digest.tsx).
// Pulls actionable items from WA groups, OSINT mentions, content signals,
// calendar, LinkedIn signals and system attention into one feed.
// Pack deviations: the outreach KPI strip and its attempts drawer did not
// travel (outreach-module data, host writes a plugin may not perform), and
// the OSINT targets panel is read-only (targets belong to the editorial
// pack).
// Layout: hero (date + counts + "generate" button), then three urgency-grouped
// sections (Action needed / This week / Background). Each card surfaces a
// clear action, the source, and one-click mark-read / star / open.

import { useEffect, useMemo, useState } from 'react';
import { api, type DigestItem, type DigestStats, type DigestKind, type DigestChannel, type DigestChannelSource, type WaChat, type WatchedTarget } from './digest-data';
import { DigestItemDrawer } from './DigestItemDrawer';
import { fmtWhen } from './wa-time';
import { WaSlotPicker } from './WaSlotPicker';
import { HeatBar } from './HeatBar';
import { Coffee, Star, X, Sparkle, Radio, Calendar as CalendarIcon, Search, Newspaper, Clock, LinkedIn } from '../../components/Icons';
import {
  getDigestGenState,
  subscribeDigestGen,
  startDigestGeneration,
  type DigestGenState,
} from './digestBackground';

type Tab = 'brief' | 'channels';
const TAB_KEY = 'nyyon.digest.tab.v1';

const KIND_TONE: Record<DigestKind, string> = {
  wa_message:          'bg-emerald-100 text-emerald-800',
  wa_group:            'bg-emerald-50  text-emerald-700',
  osint_mention:       'bg-violet-100  text-violet-800',
  osint_insight:       'bg-violet-50   text-violet-700',
  content_opportunity: 'bg-sky-100     text-sky-800',
  email:               'bg-blue-100    text-blue-800',
  note:                'bg-stone-100   text-stone-700',
  opportunity:         'bg-amber-100   text-amber-900',
  li_signal:           'bg-indigo-100  text-indigo-800',
  attention:           'bg-rose-100    text-rose-800',
};
const KIND_LABEL: Record<DigestKind, string> = {
  wa_message:          'DM',
  wa_group:            'group',
  osint_mention:       'signal',
  osint_insight:       'insight',
  content_opportunity: 'content',
  email:               'email',
  note:                'note',
  opportunity:         'opportunity',
  li_signal:           'linkedin',
  attention:           'attention',
};





// Category filters for the brief feed. These are CLIENT-SIDE predicates over
// the loaded items — the API returns everything (it only filters unread/
// starred server-side), so all category narrowing happens here.
//
// Most categories key straight off item.kind. The exception is Calendar:
// calendar events are stored under kind 'opportunity' (see pullCalendar in
// workers/api/src/lib/digest.js) and are only distinguishable by
// ref_kind === 'calendar_events'. So Calendar matches on ref_kind, and
// "Opportunities" explicitly excludes calendar rows to avoid double-counting.
type CatKey =
  | 'wa_group' | 'wa_message'
  | 'osint_mention' | 'osint_insight' | 'content_opportunity'
  | 'opportunity' | 'calendar' | 'li_signal' | 'attention'
  | 'src_li' | 'src_prospecting';

// The signal's origin pool, stamped at card creation (meta.origin).
function metaOrigin(i: DigestItem): string | null {
  try { return JSON.parse(i.meta_json || '{}').origin ?? null; } catch { return null; }
}

const CATEGORIES: { key: CatKey; label: string; dot: string; match: (it: DigestItem) => boolean }[] = [
  { key: 'wa_group',            label: 'Groups',        dot: 'bg-emerald-500', match: (i) => i.kind === 'wa_group' },
  { key: 'wa_message',          label: 'DMs',           dot: 'bg-emerald-400', match: (i) => i.kind === 'wa_message' },
  { key: 'osint_mention',       label: 'Signals',       dot: 'bg-violet-500',  match: (i) => i.kind === 'osint_mention' },
  { key: 'osint_insight',       label: 'Insights',      dot: 'bg-violet-400',  match: (i) => i.kind === 'osint_insight' },
  { key: 'content_opportunity', label: 'Content',       dot: 'bg-sky-500',     match: (i) => i.kind === 'content_opportunity' },
  { key: 'opportunity',         label: 'Opportunities', dot: 'bg-amber-500',   match: (i) => i.kind === 'opportunity' && i.ref_kind !== 'calendar_events' },
  { key: 'calendar',            label: 'Calendar',      dot: 'bg-orange-500',  match: (i) => i.ref_kind === 'calendar_events' },
  { key: 'li_signal',           label: 'LinkedIn',      dot: 'bg-indigo-500',  match: (i) => i.kind === 'li_signal' },
  { key: 'attention',           label: 'Attention',     dot: 'bg-rose-500',    match: (i) => i.kind === 'attention' },
  // source-of-signal filters: which pool the person comes from
  { key: 'src_li',              label: 'LI Outreach',   dot: 'bg-indigo-300',  match: (i) => i.kind === 'li_signal' && metaOrigin(i) !== 'prospecting' },
  { key: 'src_prospecting',     label: 'Prospecting',   dot: 'bg-teal-500',    match: (i) => i.kind === 'li_signal' && metaOrigin(i) === 'prospecting' },
];

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function todayLabel(): string {
  // Day + hour-minute, e.g. "Sunday, May 31 · 4:52 PM". The hour anchors
  // the brief to the operator's current moment so a quick glance answers
  // "is this fresh enough?" without checking the wall clock.
  const d = new Date();
  const day  = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

export default function Digest() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'brief');
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  // The selector is hidden on mobile (cards own the screen there), so a
  // phone visitor persisted onto 'channels' must land on the brief instead.
  useEffect(() => {
    if (tab === 'channels' && window.matchMedia('(max-width: 639px)').matches) setTab('brief');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="h-full flex flex-col">
      <div className="hidden sm:block px-4 sm:px-6 pt-4 border-b border-line bg-paper/60 shrink-0">
        <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit mb-3">
          {(['brief', 'channels'] as Tab[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.18em] transition ' +
                (tab === k ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
              }
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      {tab === 'brief'    && <BriefPane />}
      {tab === 'channels' && <ChannelsPane />}
    </div>
  );
}

// (cmd's KPI top bar + outreach-log drawer lived here — dropped in the
// pack port: outreachKpi reads and WRITES outreach-module host tables,
// which a plugin may not do. The outreach pack owns that surface.)

function BriefPane() {
  const [items, setItems]   = useState<DigestItem[] | null>(null);
  const [stats, setStats]   = useState<DigestStats | null>(null);
  const [hideRead, setHideRead] = useState(true);
  // Generation state lives in lib/digestBackground.ts — the in-flight
  // Promise survives sidebar nav so the user can leave and come back to a
  // still-running (or just-finished) run. We just mirror it into local
  // state via subscribe().
  const [gen, setGen] = useState<DigestGenState>(() => getDigestGenState());
  const [activeItem, setActiveItem] = useState<DigestItem | null>(null);
  // Active category filters (multi-select). Empty set = show everything.
  // Deliberately NOT persisted: a category filter is a transient view, so every
  // load starts fresh at "all / unread" rather than resurrecting a stale filter
  // (with an inert read-toggle) the operator has long forgotten setting.
  const [cats, setCats] = useState<Set<CatKey>>(new Set());
  function toggleCat(k: CatKey) {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  // Time window: 'all' (default) or the last 24h. Orthogonal to the category
  // chips — it composes with them (AND). Like a category, an active window shows
  // read + unread within it ("everything that happened"), so the unread toggle
  // only governs the plain, unfiltered default view.
  const [timeWin, setTimeWin] = useState<'all' | '24h'>('all');
  function clearFilters() { setCats(new Set()); setTimeWin('all'); }

  async function refresh() {
    // Load the FULL set (read + unread) and do the unread narrowing on the
    // client. This lets category filters (Calendar, Content, …) reach items
    // the operator has already read — those never appear in an unread-only
    // fetch, which is why picking Calendar used to show nothing. The backend
    // hard-deletes rows older than 14 days (see pruneStaleDigestItems), so the
    // table stays well under this cap — the feed never silently truncates.
    const [it, st] = await Promise.all([
      api.listDigest({ limit: 1500 }),
      api.digestStats(),
    ]);
    setItems(it);
    setStats(st);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // Ongoing feed: cron-inserted cards (LI signals and the rest) appear on
  // their own, no Generate click, no navigation needed.
  useEffect(() => {
    const t = setInterval(() => { refresh(); }, 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the background-generation singleton. When a run settles we just
  // refresh the list — newly-pulled items are unread, so they appear at the top
  // of the default "showing unread" feed on their own. We deliberately do NOT
  // flip to "showing all" here: with the full read+unread fetch that would bury
  // the N new items in the entire read backlog. Subscribing on mount also picks
  // up runs already in flight from earlier sidebar navigations.
  useEffect(() => {
    const unsub = subscribeDigestGen((s) => {
      setGen(s);
      // Any settled run refreshes the list + stats (new items appear, the
      // "last updated" timestamp ticks forward, any failure surfaces).
      if (!s.running && s.result) refresh();
    });
    return unsub;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  function generate() {
    // Fire-and-forget — the singleton handles the lifecycle. Click during
    // an in-flight run is a no-op (returns the same Promise).
    startDigestGeneration();
  }

  const generating   = gen.running;
  const genStartedAt = gen.running ? gen.started_at : null;
  const lastGen      = gen.result;

  // Force a re-render once a second so the "Updated 3m ago" line keeps
  // ticking and the in-flight elapsed counter advances without a full
  // refetch. Cheap — single setState every 1s.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function markRead(id: string) {
    await api.patchDigestItem(id, { read: true });
    refresh();
  }
  async function toggleStar(id: string, on: boolean) {
    await api.patchDigestItem(id, { starred: !on });
    refresh();
  }

  // "Discuss with Nyo" used to be a card-level action; it now lives inside
  // DigestItemDrawer (opened by clicking a card).

  // Per-category TOTALS (read + unread) over the loaded set. The badge on a
  // chip is "how many cards a click surfaces" — clicking a category shows all of
  // it, read or unread — so the count is the category total, not the unread-only
  // subset the default feed shows. KIND categories are mutually exclusive
  // (break after the first match); the SOURCE chips are a second axis — a
  // LinkedIn signal also belongs to its origin pool — so they count
  // independently, never inside the exclusive walk.
  const catCounts = useMemo(() => {
    const c = Object.fromEntries(CATEGORIES.map((cat) => [cat.key, 0])) as Record<CatKey, number>;
    const sourceKeys: CatKey[] = ['src_li', 'src_prospecting'];
    for (const it of items || []) {
      for (const cat of CATEGORIES) {
        if (sourceKeys.includes(cat.key)) continue;
        if (cat.match(it)) { c[cat.key]++; break; }
      }
      for (const key of sourceKeys) {
        const cat = CATEGORIES.find((x) => x.key === key)!;
        if (cat.match(it)) c[key]++;
      }
    }
    return c;
  }, [items]);

  // Build the visible list. The unread toggle governs ONLY the plain default
  // view; any explicit filter — a category, or the 24h window — is a "show me
  // these" that surfaces read + unread within it.
  const filtered = useMemo(() => {
    if (!items) return [] as DigestItem[];
    let list: DigestItem[] = items;
    if (cats.size > 0) {
      list = list.filter((it) => CATEGORIES.some((c) => cats.has(c.key) && c.match(it)));
    }
    if (timeWin === '24h') {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      list = list.filter((it) => it.created_at >= cutoff);
    }
    if (cats.size === 0 && timeWin === 'all' && hideRead) {
      list = list.filter((it) => it.read_at === null);
    }
    return list;
  }, [items, cats, hideRead, timeWin]);

  const grouped = useMemo(() => {
    const high: DigestItem[] = [];
    const mid:  DigestItem[] = [];
    const low:  DigestItem[] = [];
    const done: DigestItem[] = [];
    for (const it of filtered) {
      // Dismissed (read) cards sink to the bottom section instead of holding
      // their spot in the urgency groups — hitting ✕ visibly moves the card
      // down, so what's left to review always sits together at the top.
      if (it.read_at !== null) done.push(it);
      else if (it.urgency === 1) high.push(it);
      else if (it.urgency === 2) mid.push(it);
      else low.push(it);
    }
    // Most recently dismissed first, so the card you just ✕'d is findable.
    done.sort((a, b) => (b.read_at || 0) - (a.read_at || 0));
    // Within each urgency group, scored signals order by relevance: the
    // reasoning tool's priority (meta.priority) wins, unscored items keep
    // their natural (recency) order below the scored ones.
    const pr = (it: DigestItem) => {
      try { return Number(JSON.parse(it.meta_json || '{}').priority ?? -1); } catch { return -1; }
    };
    for (const g of [high, mid, low]) g.sort((a, b) => pr(b) - pr(a));
    return { high, mid, low, done };
  }, [filtered]);

  // Count of items that landed in the brief in the last 24h (read + unread) —
  // the badge on the 24h chip = how many cards it surfaces.
  const last24hCount = useMemo(() => {
    if (!items) return 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let n = 0;
    for (const it of items) if (it.created_at >= cutoff) n++;
    return n;
  }, [items]);

  // Any explicit filter (a category or the time window) is active — the unread
  // toggle doesn't apply and its control goes inert.
  const hasExplicit = cats.size > 0 || timeWin === '24h';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="px-4 sm:px-6 py-3 sm:py-5 border-b border-line bg-paper/60 shrink-0">
        <div className="flex items-baseline justify-between flex-wrap gap-2 sm:gap-4">
          <div>
            <div className="hidden sm:flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em] text-mute mb-1">
              <Coffee size={12} />
              <span>{todayLabel()}</span>
              {/* "Updated Nm ago" — pulled from /api/digest/stats. Stays
                  visible whether or not a run is in flight; the elapsed
                  counter ticks every second via setTick. */}
              {stats?.last_generated_at && (() => {
                const ago = timeAgo(stats.last_generated_at);
                // timeAgo returns "just now" for < 60s — read it as a full
                // phrase instead of "updated just now ago".
                const label = ago === 'just now' ? 'updated just now' : `updated ${ago} ago`;
                return (
                  <>
                    <span className="text-mute/50">·</span>
                    <span title={new Date(stats.last_generated_at).toLocaleString()}>{label}</span>
                  </>
                );
              })()}
            </div>
            <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">
              {stats?.unread ? `${stats.unread} thing${stats.unread === 1 ? '' : 's'} for you today` : 'All caught up'}
            </h1>
            {stats && (
              <p className="text-xs text-mute mt-1">
                {stats.action_count > 0 && <span><span className="text-rose-700 font-medium">{stats.action_count}</span> need action</span>}
                {stats.action_count > 0 && stats.high > 0 && <span> · </span>}
                {stats.high > 0 && <span><span className="text-rose-700">{stats.high}</span> high urgency</span>}
                {stats.starred > 0 && <span> · {stats.starred} starred</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHideRead(!hideRead)}
              disabled={hasExplicit}
              title={hasExplicit ? 'A category or time filter shows all its items — clear it to filter by unread' : undefined}
              className={
                'h-9 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.18em] transition ' +
                (hasExplicit
                  ? 'bg-card text-mute opacity-60'
                  : hideRead ? 'bg-card text-mute hover:text-ink' : 'bg-ink text-paper')
              }
            >
              {hasExplicit || !hideRead ? 'showing all' : 'showing unread'}
            </button>
            <button
              onClick={generate}
              disabled={generating}
              className={
                'inline-flex items-center gap-1.5 h-9 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.18em] transition ' +
                (generating
                  ? 'bg-ink text-paper opacity-90'
                  : 'bg-ink text-paper hover:opacity-90 disabled:opacity-40')
              }
            >
              <Sparkle size={12} className={generating ? 'animate-spin' : ''} />
              {generating ? 'scanning channels…' : 'generate'}
            </button>
          </div>
        </div>
        {/* Filter bar. Two orthogonal axes:
             · a TIME window ("24h" = everything that landed in the brief in the
               last 24 hours, read + unread), set apart by a divider; and
             · CATEGORY chips (Groups / Signals / Opportunities / Calendar / …),
               multi-select, "all" clears them.
            Both compose (AND). Every category is always shown; empty ones render
            dimmed + disabled. A badge = how many cards that filter surfaces. */}
        {items && items.length > 0 && (
          <div className="mt-3 flex items-center gap-1.5 flex-nowrap overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap sm:overflow-visible">
            <button
              onClick={() => setTimeWin(timeWin === '24h' ? 'all' : '24h')}
              title="Everything that landed in the brief in the last 24 hours"
              className={
                'shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition ' +
                (timeWin === '24h' ? 'bg-ink text-paper' : 'bg-card text-mute hover:text-ink')
              }
            >
              <Clock size={11} />
              24h
              <span className={timeWin === '24h' ? 'text-paper/60' : 'text-mute/60'}>{last24hCount}</span>
            </button>
            <span className="mx-1 h-4 w-px bg-line shrink-0" />
            <button
              onClick={() => setCats(new Set())}
              className={
                'shrink-0 whitespace-nowrap h-7 px-2.5 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition ' +
                (cats.size === 0 ? 'bg-ink text-paper' : 'bg-card text-mute hover:text-ink')
              }
            >
              all
            </button>
            {CATEGORIES.map((c) => {
              const on    = cats.has(c.key);
              const empty = catCounts[c.key] === 0;
              return (
                <button
                  key={c.key}
                  onClick={() => toggleCat(c.key)}
                  disabled={empty && !on}
                  className={
                    'shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition ' +
                    (on
                      ? 'bg-ink text-paper'
                      : empty
                        ? 'bg-card text-mute/40 cursor-not-allowed'
                        : 'bg-card text-mute hover:text-ink')
                  }
                >
                  <span className={'h-1.5 w-1.5 rounded-full ' + c.dot + (on || !empty ? '' : ' opacity-40')} />
                  {c.label}
                  <span className={on ? 'text-paper/60' : 'text-mute/60'}>{catCounts[c.key]}</span>
                </button>
              );
            })}
          </div>
        )}
        {/* Live progress strip — visible while a run is in flight + sticks
            around after for one cycle so the operator can read the result. */}
        {(generating || lastGen) && (
          <div className="mt-3 flex items-baseline gap-3 flex-wrap text-[11px]">
            {generating ? (
              <span className="inline-flex items-center gap-1.5 text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-ink animate-pulse" />
                Scanning enabled channels{genStartedAt ? <span className="text-mute mono"> · {Math.max(0, Math.floor((Date.now() - genStartedAt) / 1000))}s</span> : null}
              </span>
            ) : lastGen?.onboarding_needed ? (
              <span className="text-ink">
                Nothing to digest yet — this install isn't onboarded. {' '}
                <button
                  className="underline underline-offset-2 hover:opacity-80"
                  onClick={() => window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target: 'nyo' } }))}
                >Talk to Nyo to onboard</button>
                {' '}— connect WhatsApp, pick your sources, and the brief fills on its own.
              </span>
            ) : lastGen ? (
              <>
                <span className={lastGen.error ? 'text-rose-700' : lastGen.generated > 0 ? 'text-emerald-700' : 'text-mute'}>
                  {lastGen.error
                    ? '✗ Generate failed'
                    : lastGen.generated > 0
                      ? `✓ Pulled ${lastGen.generated} new item${lastGen.generated === 1 ? '' : 's'}`
                      : '· No new activity (everything already in the brief)'}
                  {typeof lastGen.pruned === 'number' && lastGen.pruned > 0 && (
                    <span className="text-mute"> · archived {lastGen.pruned} stale</span>
                  )}
                  <span className="text-mute mono"> · {lastGen.ms}ms</span>
                </span>
                {lastGen.per_source && (
                  <span className="flex items-center gap-2 mono text-mute">
                    {Object.entries(lastGen.per_source).map(([src, info]) => (
                      <span key={src} className={info.error ? 'text-rose-700' : info.count > 0 ? 'text-emerald-700' : ''}>
                        {src}{info.error ? '✗' : ''} +{info.count}
                        {info.skipped && <span className="text-mute/70"> ({info.skipped})</span>}
                      </span>
                    ))}
                  </span>
                )}
                {lastGen.error && (
                  <span className="text-rose-700">{lastGen.error}</span>
                )}
              </>
            ) : null}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-8 overflow-x-hidden">
          {!items && <div className="text-sm text-mute">Loading…</div>}
          {items && filtered.length === 0 && (
            hasExplicit ? (
              // A category and/or time filter is active but nothing matches it.
              <div className="text-center py-16 space-y-3">
                <div className="text-4xl">🔍</div>
                <div className="text-sm text-mute">
                  {timeWin === '24h' && cats.size === 0 ? 'Nothing new in the last 24 hours.' : 'Nothing in this filter right now.'}{' '}
                  <button className="text-ink underline underline-offset-2" onClick={clearFilters}>Clear filters</button>
                </div>
              </div>
            ) : hideRead && items.length > 0 ? (
              // Rows exist but they're all read — the operator has cleared the
              // brief. This is the "all caught up" reward, not a filter miss, so
              // offer to reveal the read items rather than a dead Clear-filters.
              <div className="text-center py-16 space-y-3">
                <div className="text-4xl">☕</div>
                <div className="text-sm text-mute">
                  You're all caught up — nothing unread.{' '}
                  <button className="text-ink underline underline-offset-2" onClick={() => setHideRead(false)}>Show {items.length} read item{items.length === 1 ? '' : 's'}</button>
                </div>
              </div>
            ) : (
              // Genuinely empty brief (fresh install / everything cleared).
              // First open explains itself: what feeds it, what comes out.
              // Static copy, no model call, gone once the brief has items.
              <div className="max-w-xl mx-auto py-12 space-y-3">
                <div className="hairline rounded-lg bg-card/50 px-4 py-3 text-left">
                  <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute mb-1.5">nyo · how this works</p>
                  <p className="text-[12.5px] leading-relaxed text-mute">
                    The digest reads the channels you connect (WhatsApp chats and groups,
                    news and web sources) and turns everything that piled up into one short
                    brief: what needs action, what's worth knowing, what can wait. It fills
                    on its own each morning, or right now with <span className="text-ink">Generate</span>.
                    Nothing here leaves this install.
                  </p>
                </div>
                <div className="text-center text-sm text-mute pt-2">
                  <span className="text-4xl block mb-2">☕</span>
                  Nothing in the brief yet. Connect channels via Nyo, then hit <span className="text-ink">Generate</span>.
                </div>
              </div>
            )
          )}

          <Section
            title="Action needed"
            tone="high"
            items={grouped.high}
            onRead={markRead}
            onStar={toggleStar}
            onOpen={setActiveItem}
          />
          <Section
            title="This week"
            tone="mid"
            items={grouped.mid}
            onRead={markRead}
            onStar={toggleStar}
            onOpen={setActiveItem}
          />
          <Section
            title="Background"
            tone="low"
            items={grouped.low}
            onRead={markRead}
            onStar={toggleStar}
            onOpen={setActiveItem}
          />
          <Section
            title="Dismissed"
            tone="low"
            items={grouped.done}
            onRead={markRead}
            onStar={toggleStar}
            onOpen={setActiveItem}
          />
        </div>
      </div>
      {activeItem && (
        <DigestItemDrawer
          item={activeItem}
          onClose={() => setActiveItem(null)}
          onChange={() => { refresh(); }}
        />
      )}
    </div>
  );
}

function Section({
  title, tone, items, onRead, onStar, onOpen,
}: {
  title: string;
  tone: 'high' | 'mid' | 'low';
  items: DigestItem[];
  onRead: (id: string) => void;
  onStar: (id: string, on: boolean) => void;
  onOpen: (item: DigestItem) => void;
}) {
  if (items.length === 0) return null;
  const dotTone = tone === 'high' ? 'bg-rose-500' : tone === 'mid' ? 'bg-amber-500' : 'bg-stone-400';
  return (
    <section>
      <div className="flex items-center gap-2 mb-3 mono text-[10px] uppercase tracking-[0.2em] text-mute">
        <span className={'h-1.5 w-1.5 rounded-full ' + dotTone} />
        <span>{title}</span>
        <span className="text-mute/60">· {items.length}</span>
      </div>
      <ul className="space-y-2">
        {items.map((it) => <Card key={it.id} item={it} onRead={onRead} onStar={onStar} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

function Card({
  item, onRead, onStar, onOpen,
}: {
  item: DigestItem;
  onRead: (id: string) => void;
  onStar: (id: string, on: boolean) => void;
  onOpen: (item: DigestItem) => void;
}) {
  const starred = item.starred === 1;
  const isRead  = item.read_at !== null;
  // External = outside-world news/signal cards (OSINT + content ideas). They
  // render differently from internal WhatsApp/opportunity cards: the primary
  // action is READ the source, not open a reply panel.
  const isExternal = item.kind === 'osint_mention' || item.kind === 'osint_insight' || item.kind === 'content_opportunity' || item.kind === 'li_signal';
  // LI signal cards carry their action payload (prepared draft, WhatsApp
  // match from the CRM/GTM pool) in meta_json — parsed defensively.
  const liMeta = (() => {
    if (item.kind !== 'li_signal' || !item.meta_json) return null;
    try {
      return JSON.parse(item.meta_json) as {
        draft?: string | null; wa_url?: string | null; phone?: string | null;
        prospect_id?: string | null; profile_url?: string | null;
        name?: string | null; role?: string | null; company?: string | null; detail?: unknown;
        wa_queued_at?: number; wa_scheduled_for?: number | null;
        priority?: number; priority_reason?: string; origin?: string | null;
        heat?: number; heat_band?: 'hot' | 'warm' | 'cold'; heat_factors?: string[];
        contacted?: { why?: string; at?: number } | null;
      };
    } catch { return null; }
  })();
  // Stops icon-button clicks from bubbling to the card-level open handler.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // ── WA composer: editable auto-saving draft + ASAP / slot picker ──
  // The draft persists server-side (meta_json.draft); the first edit
  // snapshots the AI original so the send can teach the voice doc.
  const [waOpen, setWaOpen] = useState(false);
  const [waText, setWaText] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);
  const [waPitches, setWaPitches] = useState<{ key: string; label: string; text: string }[] | null>(null);
  const [waDone, setWaDone] = useState<string | null>(
    liMeta?.wa_queued_at ? (liMeta.wa_scheduled_for ? `scheduled ${fmtWhen(liMeta.wa_scheduled_for)}` : 'queued ✓') : null,
  );
  const [waErr, setWaErr] = useState<string | null>(null);
  const waDraft = waText ?? liMeta?.draft ?? '';
  useEffect(() => {
    if (!waOpen || waPitches) return;
    api.digestWaPitches().then((r) => setWaPitches(r.pitches)).catch(() => {});
  }, [waOpen, waPitches]);
  // A pitch fills the textarea (and rides the same auto-save + learning
  // path); placeholders substitute from the card's person, and an empty
  // {company}/{role} drops cleanly.
  function applyPitch(t: string) {
    const firstName = (liMeta?.name || '').trim().split(/\s+/)[0] || '';
    let out = t.replace('{first_name}', firstName).replace('{name}', firstName).replace('{company}', liMeta?.company || '').replace('{role}', liMeta?.role || '');
    out = out.replace(/ ב\.\s*$/u, '.').replace(/\s{2,}/g, ' ').trim();
    setWaText(out);
  }
  // Auto-save 800ms after the operator stops typing.
  useEffect(() => {
    if (waText === null) return;
    const t = window.setTimeout(() => {
      api.patchDigestItem(item.id, { draft: waText }).catch(() => {});
    }, 800);
    return () => window.clearTimeout(t);
  }, [waText, item.id]);
  async function waSend(sendAt?: number) {
    const body = waDraft.trim();
    if (!body || waBusy) return;
    setWaBusy(true); setWaErr(null);
    try {
      const r = await api.digestWaSend(item.id, { text: body, ...(sendAt ? { send_at: sendAt } : {}) });
      if (r.error) { setWaErr(r.error); return; }
      setWaDone(sendAt ? `scheduled ${fmtWhen(sendAt)}` : 'queued ✓');
    } catch (e) {
      setWaErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWaBusy(false);
    }
  }

  // Scraped headlines arrive as "Claude: 20 Pros & Cons … - DigitalDefynd" — the
  // "Target: " prefix is redundant with the badge/host, so strip it for a clean read.
  const title = isExternal ? item.title.replace(/^[^:]{1,24}:\s+/, '') : item.title;
  // The reasoning tool's verdict: score chip + its one-line reason. A local
  // override reflects a feedback-triggered rescore without a full reload.
  const [prioLocal, setPrioLocal] = useState<{ score: number; reason: string } | null>(null);
  const [prioOpen, setPrioOpen] = useState(false);
  const [prioComment, setPrioComment] = useState('');
  const [prioBusy, setPrioBusy] = useState(false);
  const [prioNote, setPrioNote] = useState<string | null>(null);
  const prio = prioLocal ? prioLocal.score : (typeof liMeta?.priority === 'number' ? liMeta.priority : null);
  const prioReason = prioLocal ? prioLocal.reason : (liMeta?.priority_reason || '');
  async function sendPrioFeedback() {
    const c = prioComment.trim();
    if (!c || prioBusy) return;
    setPrioBusy(true); setPrioNote(null);
    try {
      const r = await api.digestPriorityFeedback(item.id, c);
      if (r.error) { setPrioNote(r.error); return; }
      if (r.rescored?.ok && typeof r.rescored.score === 'number') {
        setPrioLocal({ score: r.rescored.score, reason: r.rescored.reason || '' });
      }
      setPrioComment('');
      setPrioNote(`learned (${r.rules} taste rules) and rescored`);
    } catch (e) { setPrioNote(e instanceof Error ? e.message : String(e)); }
    finally { setPrioBusy(false); }
  }
  const host = (() => {
    if (!item.source_url) return null;
    try { return new URL(item.source_url).host.replace(/^www\./, ''); } catch { return null; }
  })();
  // Calendar events are stored kind='opportunity' but are their own category
  // (matched on ref_kind). Give them a distinct label/tone so a Calendar-filtered
  // card doesn't wear the amber "opportunity" badge and read like a data error.
  const isCal = item.ref_kind === 'calendar_events';
  const tone  = isCal ? 'bg-orange-100 text-orange-900' : (KIND_TONE[item.kind]  || 'bg-stone-100 text-stone-700');
  const label = isCal ? 'calendar' : (KIND_LABEL[item.kind] || String(item.kind));
  return (
    <li
      onClick={() => onOpen(item)}
      className={
        'group hairline rounded-sm bg-card/80 p-4 transition hover:border-ink/40 cursor-pointer ' +
        (isRead ? (isExternal ? 'opacity-75' : 'opacity-60') : '') +
        (item.urgency === 1 ? ' border-l-2 border-l-rose-500' : '')
      }
    >
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        {liMeta ? (
          <>
            {/* top-left: priority first, then ONE source chip (kind + host +
                origin said the same thing three ways; the origin pool is the
                one that matters) */}
            {prio !== null && (
              <button
                type="button"
                onClick={(e) => { stop(e); setPrioOpen((v) => !v); }}
                title={prioReason}
                className={'mono text-[9px] px-1.5 py-0.5 rounded-sm hairline hover:bg-card transition cursor-pointer shrink-0 ' + (item.urgency === 1 ? 'text-rose-700' : item.urgency === 2 ? 'text-amber-700' : 'text-mute')}
              >
                P{prio}
              </button>
            )}
            <span className={'mono text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded-sm shrink-0 ' + tone}>
              {liMeta.origin === 'prospecting' ? 'prospecting' : 'li outreach'}
            </span>
            {typeof liMeta.heat === 'number' && (
              <HeatBar score={liMeta.heat} band={liMeta.heat_band} factors={liMeta.heat_factors} />
            )}
            {liMeta.contacted ? (
              <span
                className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-emerald-500/10 text-emerald-700 shrink-0"
                title={liMeta.contacted.why || 'already contacted'}
              >
                ✓ contacted
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className={'mono text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded-sm shrink-0 ' + tone}>
              {label}
            </span>
            <span className="text-[11px] text-mute truncate">{isExternal ? (host || item.source_label) : item.source_label}</span>
          </>
        )}
        <span className="text-[10px] text-mute mono">· {timeAgo(item.created_at)}</span>

        <span className="ml-auto flex items-center gap-1" onClick={stop}>
          {/* Star stays subtle (reveals on hover) — it's the rarer action. */}
          <button
            onClick={(e) => { stop(e); onStar(item.id, starred); }}
            aria-label={starred ? 'Unstar' : 'Star'}
            title={starred ? 'Unstar' : 'Star'}
            className={'h-7 w-7 grid place-items-center rounded-sm transition ' + (starred ? 'text-amber-500 hover:text-amber-600' : 'text-mute opacity-0 group-hover:opacity-100 hover:text-ink')}
          >
            <Star size={14} className={starred ? 'fill-current' : ''} />
          </button>
          {/* Dismiss is ALWAYS visible so "close out a post I don't care about"
              is one obvious click. With the brief's default unread filter on,
              dismissing removes the card from view immediately. */}
          {/* ✓ = I engaged with them on LinkedIn: counts toward their heat
              and clears this card. Their other signals keep flowing —
              muting is the drawer's explicit snooze button. */}
          {!isRead && liMeta && (
            <button
              onClick={async (e) => {
                stop(e);
                try {
                  const r = await api.digestActed(item.id);
                  if (!r.error) onRead(item.id); // it leaves the brief like a dismiss
                } catch { /* leave the card in place */ }
              }}
              aria-label="I engaged with them — count it toward their heat"
              title="I engaged with them (liked/commented on LinkedIn myself) — counts toward their heat; their signals keep flowing"
              className="h-7 w-7 grid place-items-center rounded-sm text-mute/70 hover:text-emerald-600 hover:bg-emerald-50 transition"
            >
              <span className="text-[13px] leading-none">✓</span>
            </button>
          )}
          {!isRead && (
            <button
              onClick={(e) => { stop(e); onRead(item.id); }}
              aria-label="Dismiss — not interesting"
              title="Dismiss — not interesting"
              className="h-7 w-7 grid place-items-center rounded-sm text-mute/70 hover:text-rose-600 hover:bg-rose-50 transition"
            >
              <X size={14} />
            </button>
          )}
        </span>
      </div>
      {/* An LI signal is somebody's POST: name it, so the feed never shows a
          wall of post text with no idea whose it is. Other kinds keep the
          plain title. */}
      {liMeta?.name ? (
        <>
          <div className="flex items-center gap-2 min-w-0">
            <span aria-hidden
              className="shrink-0 h-6 w-6 rounded-full bg-ink/10 text-ink grid place-items-center mono text-[9px] tracking-wide">
              {String(liMeta.name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '·'}
            </span>
            <span dir="auto" className="text-[13px] font-semibold text-ink truncate">{liMeta.name}</span>
            {(liMeta.role || liMeta.company) && (
              <span dir="auto" className="text-[11px] text-mute truncate min-w-0">
                {[liMeta.role, liMeta.company].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          {item.summary && (
            <p dir="auto" style={{ unicodeBidi: 'plaintext', textAlign: 'start' }}
              className="text-[12px] text-mute mt-1.5 leading-relaxed line-clamp-3 break-words">{item.summary}</p>
          )}
        </>
      ) : (
        <>
          <div dir="auto" className="text-[14px] text-ink font-medium leading-snug break-words">{title}</div>
          {item.summary && (
            <p dir="auto" className="text-[12px] text-mute mt-1.5 leading-relaxed line-clamp-3 break-words">{item.summary}</p>
          )}
        </>
      )}
      <div className="mt-3 flex items-center gap-3 flex-wrap" onClick={stop}>
        {prio !== null && prioReason ? (
          <div dir="auto" className="mt-1 text-[11px] leading-snug text-mute italic">
            {prioReason}
          </div>
        ) : null}
        {prioOpen ? (
          <div onClick={stop} className="mt-2 rounded-sm hairline bg-paper p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="mono text-[9px] uppercase tracking-[0.18em] text-mute">why P{prio}</span>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem('nyyon:open-doc', 'plugin-digest-signal-priority');
                  window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target: 'knowledge' } }));
                  window.dispatchEvent(new CustomEvent('nyyon:knowledge-open', { detail: { slug: 'plugin-digest-signal-priority' } }));
                }}
                className="mono text-[9px] uppercase tracking-[0.16em] text-mute hover:text-ink transition"
                title="the plugin-digest-signal-priority knowledge doc: rubric, thresholds, and your learned taste rules"
              >
                rules →
              </button>
            </div>
            <div dir="auto" className="text-[12px] leading-snug">{prioReason || 'no reason recorded'}</div>
            <textarea
              dir="auto"
              value={prioComment}
              onChange={(e) => setPrioComment(e.target.value)}
              rows={2}
              placeholder="disagree? say why — the scorer learns your taste"
              className="w-full resize-y rounded-sm hairline bg-card/40 px-2 py-1.5 text-[12px] leading-snug focus:border-ink focus:outline-none transition"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">{prioNote || ''}</span>
              <button
                type="button"
                disabled={prioBusy || !prioComment.trim()}
                onClick={sendPrioFeedback}
                className="mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 disabled:opacity-40 transition"
              >
                {prioBusy ? 'learning…' : 'teach →'}
              </button>
            </div>
          </div>
        ) : null}
        {waOpen && liMeta ? (
          <div onClick={stop} className="mt-2 rounded-sm hairline bg-paper p-2 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setWaText(liMeta.draft || '')}
                className="mono text-[9px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm hairline text-mute hover:text-ink hover:bg-card transition"
              >
                AI draft
              </button>
              {(waPitches || []).map((pz) => (
                <button
                  key={pz.key}
                  type="button"
                  dir="auto"
                  onClick={() => applyPitch(pz.text)}
                  className="text-[10px] px-2 py-0.5 rounded-sm hairline text-mute hover:text-ink hover:bg-card transition"
                >
                  {pz.label}
                </button>
              ))}
            </div>
            <textarea
              dir="auto"
              value={waDraft}
              onChange={(e) => setWaText(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-sm hairline bg-card/40 px-2.5 py-2 text-[12px] leading-relaxed focus:border-ink focus:outline-none transition"
              placeholder="draft…"
            />
            <div className="flex items-center gap-2 min-w-0 mono text-[9px] uppercase tracking-[0.18em] text-mute">
              <span className="min-w-0 break-words">{waErr ? <span className="text-red-600 normal-case break-words">{waErr}</span> : waDone || 'auto-saves · learns from your edits'}</span>
              {waDone ? (
                <button
                  type="button"
                  disabled={waBusy}
                  onClick={async () => {
                    setWaBusy(true);
                    try {
                      const r = await api.digestWaUnschedule(item.id);
                      if (r.error) setWaErr(r.error);
                      else { setWaDone(null); setWaErr(null); }
                    } catch (e) { setWaErr(e instanceof Error ? e.message : String(e)); }
                    finally { setWaBusy(false); }
                  }}
                  className="px-1.5 py-0.5 rounded-sm hairline text-mute hover:text-red-600 disabled:opacity-40 transition"
                  title="cancel the queued send"
                >
                  ✕ unschedule
                </button>
              ) : null}
            </div>
            <WaSlotPicker
              disabled={!waDraft.trim() || !!waDone}
              busy={waBusy}
              phone={liMeta.phone}
              onSend={waSend}
              onOpenWa={() => {
                const digits = String(liMeta.phone || '').replace(/\D/g, '');
                if (!digits) return;
                window.open(`https://wa.me/${digits}?text=${encodeURIComponent(waDraft)}`, '_blank');
                // the click IS the outreach act in hold mode: count it
                api.digestWaManual(item.id, waDraft)
                  .then(() => setWaDone('sent by hand ✓'))
                  .catch(() => {});
              }}
            />
          </div>
        ) : null}
        {isExternal ? (
          <>
            {/* News/signal: reading the source is the primary act; the panel is
                for turning it into a blog/social take. */}
            {(liMeta?.phone || liMeta?.wa_url) ? (
              <button
                type="button"
                onClick={(e) => { stop(e); setWaOpen((v) => !v); }}
                className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-emerald-600 text-white rounded-sm px-2.5 py-1 hover:opacity-90 transition"
                title={'WhatsApp ' + (liMeta.phone || '') + ' — edit the draft, then ASAP or pick a slot'}
              >
                {waDone ? `WhatsApp ${waDone}` : waOpen ? 'WhatsApp ▴' : 'WhatsApp →'}
              </button>
            ) : null}
            {liMeta?.profile_url && (
              <a
                href={liMeta.profile_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => { stop(e); if (liMeta.draft) navigator.clipboard.writeText(liMeta.draft).catch(() => {}); }}
                className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2.5 py-1 hover:bg-card transition"
                title="Message on LinkedIn — the draft is copied on click, their profile opens"
              >
                in message
              </a>
            )}
            {item.source_url && (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
                title="Open the source"
              >
                {item.kind === 'li_signal' ? 'View post ↗' : 'Read ↗'}
              </a>
            )}
          </>
        ) : (
          <>
            <button
              onClick={(e) => { stop(e); onOpen(item); }}
              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
              title="Open the action panel for this item"
            >
              <Sparkle size={12} />
              Open
            </button>
            {item.suggested_action && (
              <span className="inline-flex items-center mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2 py-1">
                → {item.suggested_action}
              </span>
            )}
            {item.source_url && (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
              >
                open source ↗
              </a>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// Prelude construction moved to DigestItemDrawer.buildPreludeFromContext.

// ─── Channels pane ──────────────────────────────────────────
// Mirrors the OSINT Listeners aesthetic — toggle, cadence, last run, totals.
const CH_ICON: Record<DigestChannelSource, (p: { size?: number }) => React.ReactNode> = {
  attention:      (p) => <Sparkle {...p} />,
  li_signals:     (p) => <LinkedIn {...p} />,
  whatsapp:       (p) => <Radio {...p} />,
  calendar:       (p) => <CalendarIcon {...p} />,
  osint:          (p) => <Search {...p} />,
  osint_insights: (p) => <Sparkle {...p} />,
  heartbeat:      (p) => <Search {...p} />,
  email:          (p) => <Newspaper {...p} />,
};

function ChannelsPane() {
  const [channels, setChannels] = useState<DigestChannel[] | null>(null);
  const [saving, setSaving]     = useState<DigestChannelSource | null>(null);

  async function refresh() { setChannels(await api.listDigestChannels()); }
  useEffect(() => { refresh(); }, []);

  async function toggle(source: DigestChannelSource, enabled: boolean) {
    setSaving(source);
    try { await api.patchDigestChannel(source, { enabled: enabled ? 1 : 0 }); await refresh(); }
    finally { setSaving(null); }
  }
  async function setCadence(source: DigestChannelSource, cadence: DigestChannel['cadence']) {
    setSaving(source);
    try { await api.patchDigestChannel(source, { cadence }); await refresh(); }
    finally { setSaving(null); }
  }

  const enabledCount = (channels || []).filter((c) => c.enabled).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-4xl space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Channels</h2>
        <p className="text-xs text-mute">
          Sources the digest pulls from when you hit <span className="text-ink">Generate</span>. Disable a channel to skip it.
          {channels && <span> · <span className="text-ink">{enabledCount} of {channels.length}</span> enabled</span>}
        </p>
      </div>

      {!channels && <div className="text-sm text-mute">Loading…</div>}
      {channels && (
        <div className="overflow-x-auto">
        <ul className="hairline rounded-sm bg-card/80 divide-y divide-line min-w-[720px]">
          <li className="px-4 py-2 grid grid-cols-12 gap-3 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
            <span className="col-span-1">on</span>
            <span className="col-span-3">channel</span>
            <span className="col-span-2">cadence</span>
            <span className="col-span-2 text-right">last pull</span>
            <span className="col-span-2 text-right">runs · added</span>
            <span className="col-span-2 text-right">status</span>
          </li>
          {channels.map((ch) => (
            <li key={ch.source} className="px-4 py-3 grid grid-cols-12 gap-3 items-baseline text-[13px] hover:bg-card transition">
              <span className="col-span-1">
                <button
                  onClick={() => toggle(ch.source, !ch.enabled)}
                  disabled={saving === ch.source}
                  aria-pressed={!!ch.enabled}
                  className={
                    'relative h-5 w-9 rounded-full transition ' +
                    (ch.enabled ? 'bg-ink' : 'bg-line') +
                    (saving === ch.source ? ' opacity-40' : '')
                  }
                >
                  <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-paper transition ' + (ch.enabled ? 'left-[18px]' : 'left-0.5')} />
                </button>
              </span>
              <span className="col-span-3 min-w-0 flex items-center gap-2">
                <span className="text-mute">{(CH_ICON[ch.source] ?? CH_ICON.osint)({ size: 14 })}</span>
                <span className="min-w-0">
                  <div className="font-medium text-ink truncate">{ch.label}</div>
                  <div className="mono text-[10px] text-mute truncate">{ch.source} · {ch.notes || ''}</div>
                </span>
              </span>
              <span className="col-span-2">
                <select
                  value={ch.cadence}
                  onChange={(e) => setCadence(ch.source, e.target.value as DigestChannel['cadence'])}
                  disabled={saving === ch.source}
                  className="h-7 px-2 rounded-sm hairline bg-paper text-[12px] mono uppercase tracking-[0.04em] focus:border-ink focus:outline-none"
                >
                  <option value="manual">manual</option>
                  <option value="hourly">hourly</option>
                  <option value="daily">daily</option>
                </select>
              </span>
              <span className="col-span-2 text-right mono text-[10px] text-mute">{ch.last_run_at ? timeAgo(ch.last_run_at) + ' ago' : '—'}</span>
              <span className="col-span-2 text-right mono text-[11px] tabular-nums">{ch.total_runs} · +{ch.total_added}</span>
              <span className="col-span-2 text-right mono text-[10px]">
                {ch.last_status === 'ok'    && <span className="text-emerald-700">ok</span>}
                {ch.last_status === 'error' && <span className="text-rose-700">err</span>}
                {!ch.last_status            && <span className="text-mute">—</span>}
                {ch.last_error              && <span className="text-mute"> · {ch.last_error.slice(0, 30)}</span>}
              </span>
            </li>
          ))}
        </ul>
        </div>
      )}

      <FollowedChatsPanel />
      <WatchedTargetsPanel />
    </div>
  );
}

// Watched-targets panel — sits below the WA followed-chats panel inside
// the Channels tab. Same intent as FollowedChatsPanel but for OSINT: the
// operator can see at-a-glance which brands/topics the OSINT cron is
// scraping (HN, Reddit, DuckDuckGo) and how many mentions each target has
// produced. Add/remove flows live in Nyo (write_osint_target / delete_osint_target)
// so the operator can say "start watching Mistral" or "stop watching Gemini"
// from chat. The panel surfaces state + per-row scrape-now + remove.
function WatchedTargetsPanel() {
  const [targets, setTargets] = useState<WatchedTarget[] | null>(null);
  const [note, setNote]       = useState<string | null>(null);

  async function refresh() {
    const r = await api.listWatchedTargets();
    setTargets(r.targets);
    setNote(r.note || null);
  }
  useEffect(() => { refresh(); }, []);

  if (!targets) {
    return <div className="mt-6 text-sm text-mute">Loading watched targets…</div>;
  }

  const sorted = [...targets].sort((a, b) => (b.last_mention_at || 0) - (a.last_mention_at || 0));

  return (
    <div className="mt-6 space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight">OSINT targets watched</h3>
        <p className="text-xs text-mute">
          {targets.length} target{targets.length === 1 ? '' : 's'} sweep daily across HN, Reddit, DuckDuckGo.
          {' '}
          <span className="text-mute">Targets belong to the editorial pack — manage them there, or ask Nyo to use its osint tools.</span>
        </p>
      </div>

      {targets.length === 0 ? (
        <div className="hairline rounded-sm bg-card/60 px-4 py-3 text-xs text-mute italic">
          {note || 'No OSINT targets yet. Add one from the editorial pack (or ask Nyo).'}
        </div>
      ) : (
        <div className="overflow-x-auto">
        <ul className="hairline rounded-sm bg-card/80 divide-y divide-line min-w-[560px]">
          <li className="px-4 py-2 grid grid-cols-12 gap-3 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
            <span className="col-span-6">target</span>
            <span className="col-span-3 text-right">mentions</span>
            <span className="col-span-3 text-right">last hit</span>
          </li>
          {sorted.map((t) => (
            <li key={t.id} className="px-4 py-2.5 grid grid-cols-12 gap-3 items-baseline text-[13px]">
              <span className="col-span-6 min-w-0 truncate">
                <span className="font-medium">{t.name}</span>
                {t.domain && (
                  <span className="ml-2 mono text-[10px] text-mute uppercase tracking-[0.12em]">{t.domain}</span>
                )}
              </span>
              <span className="col-span-3 text-right mono text-[11px] tabular-nums">
                {t.mentions_count ?? 0}
              </span>
              <span className="col-span-3 text-right mono text-[10px] text-mute">
                {t.last_mention_at ? timeAgo(t.last_mention_at) + ' ago' : '—'}
              </span>
            </li>
          ))}
        </ul>
        </div>
      )}
    </div>
  );
}

// Followed-chats panel — sits under the channel toggles inside the
// Channels tab. Shows every WhatsApp chat with auto_listen=1 (what the
// digest actually pulls from), plus a one-click unfollow toggle. The
// add-chat path lives in Nyo (pack tool: watch_wa_chat) on purpose so
// "follow the IEC group" works as a natural request; the panel just
// surfaces the current state + lets the operator turn things OFF when
// the listener gets noisy.
function FollowedChatsPanel() {
  const [chats, setChats]     = useState<WaChat[] | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter]   = useState('');

  async function refresh() {
    setChats(await api.listWaChats());
  }
  useEffect(() => { refresh(); }, []);

  async function toggleListen(id: string, on: boolean) {
    setBusy(id);
    try { await api.watchWaChat(id, on); await refresh(); }
    finally { setBusy(null); }
  }

  if (!chats) {
    return <div className="mt-4 text-sm text-mute">Loading chats…</div>;
  }

  const followed = chats.filter((c) => c.auto_listen);
  const others   = chats.filter((c) => !c.auto_listen);

  const q = filter.trim().toLowerCase();
  const candidates = q
    ? others.filter((c) => (c.name || c.id).toLowerCase().includes(q))
    // No filter typed → show the most-recently-active 12 so the operator
    // can pick from "what's actually moving" without wading through 391
    // dormant group memberships.
    : [...others]
        .sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0))
        .slice(0, 12);

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">WhatsApp chats followed</h3>
          <p className="text-xs text-mute">
            {followed.length} of {chats.length} chats. The digest only pulls from these.
            {' '}
            <span className="text-mute">Ask Nyo "follow the IEC group" or "unfollow X" to change this from chat.</span>
          </p>
        </div>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
        >
          {showAll ? 'hide candidates ↑' : '+ add chat ↓'}
        </button>
      </div>

      {followed.length === 0 ? (
        <div className="hairline rounded-sm bg-card/60 px-4 py-3 text-xs text-mute italic">
          No chats followed yet. Open the candidates list or ask Nyo to follow the chat by name.
        </div>
      ) : (
        <div className="overflow-x-auto">
        <ul className="hairline rounded-sm bg-card/80 divide-y divide-line min-w-[480px]">
          {followed
            .sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0))
            .map((c) => (
              <li key={c.id} className="px-4 py-2.5 grid grid-cols-12 gap-3 items-baseline text-[13px]">
                <span className="col-span-7 min-w-0 truncate" dir="auto">
                  {c.name || <span className="mono text-mute">{c.id}</span>}
                  {c.is_group ? <span className="ml-2 mono text-[10px] text-mute uppercase tracking-[0.18em]">group</span> : null}
                </span>
                <span className="col-span-3 text-right mono text-[10px] text-mute">
                  {c.last_message_at ? timeAgo(c.last_message_at) + ' ago' : 'no msgs'}
                </span>
                <span className="col-span-2 text-right">
                  <button
                    onClick={() => toggleListen(c.id, false)}
                    disabled={busy === c.id}
                    className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-rose-700 transition disabled:opacity-40"
                    title="Stop following this chat"
                  >
                    {busy === c.id ? '…' : 'unfollow'}
                  </button>
                </span>
              </li>
            ))}
        </ul>
        </div>
      )}

      {showAll && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter candidates by name…"
              className="flex-1 h-8 px-3 rounded-sm hairline bg-paper text-[12px] focus:border-ink focus:outline-none"
            />
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">
              {q ? `${candidates.length} match` : 'top 12 active'}
            </span>
          </div>
          <ul className="hairline rounded-sm bg-card/60 divide-y divide-line max-h-72 overflow-y-auto overflow-x-auto">
            {candidates.length === 0 && (
              <li className="px-4 py-3 text-xs text-mute italic">No matches.</li>
            )}
            {candidates.map((c) => (
              <li key={c.id} className="px-4 py-2 grid grid-cols-12 gap-3 items-baseline text-[12px] min-w-[480px]">
                <span className="col-span-7 min-w-0 truncate" dir="auto">
                  {c.name || <span className="mono text-mute">{c.id}</span>}
                  {c.is_group ? <span className="ml-2 mono text-[10px] text-mute uppercase tracking-[0.18em]">group</span> : null}
                </span>
                <span className="col-span-3 text-right mono text-[10px] text-mute">
                  {c.last_message_at ? timeAgo(c.last_message_at) + ' ago' : '—'}
                </span>
                <span className="col-span-2 text-right">
                  <button
                    onClick={() => toggleListen(c.id, true)}
                    disabled={busy === c.id}
                    className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-emerald-700 transition disabled:opacity-40"
                    title="Start following this chat"
                  >
                    {busy === c.id ? '…' : 'follow'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
