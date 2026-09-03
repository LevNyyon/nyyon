// Digest plugin: morning brief page.
// Pulls search headlines for the operator's topics and the calendar
// look-ahead into one feed.
// Layout: hero (date + counts + "generate" button), then three urgency-grouped
// sections (Action needed / This week / Background). Each card surfaces a
// clear action, the source, and one-click mark-read / star / open.

import { useEffect, useMemo, useState } from 'react';
import { api, parseMeta, type DigestItem, type DigestStats, type DigestKind } from './digest-data';
import { DigestItemDrawer } from './DigestItemDrawer';
import { DigestOnboarding } from './DigestOnboarding';
import { sources as sourcesApi, type DigestSources } from './digest-data';
import { Coffee, Star, X, Sparkle, Clock } from '../../components/Icons';
import {
  getDigestGenState,
  subscribeDigestGen,
  startDigestGeneration,
  type DigestGenState,
} from './digestBackground';

const KIND_TONE: Record<DigestKind, string> = {
  news:        'bg-sky-100     text-sky-800',
  note:        'bg-stone-100   text-stone-700',
  opportunity: 'bg-amber-100   text-amber-900',
};
const KIND_LABEL: Record<DigestKind, string> = {
  news:        'news',
  note:        'note',
  opportunity: 'opportunity',
};

// Category filters for the brief feed. CLIENT-SIDE predicates over the
// loaded items: the API returns everything (it only filters unread/starred
// server-side), so all category narrowing happens here.
//
// Calendar events are stored under kind 'opportunity' (see pullCalendar in
// lib/digest.mjs) and are only distinguishable by ref_kind ===
// 'calendar_events'. So Calendar matches on ref_kind, and "Opportunities"
// explicitly excludes calendar rows to avoid double-counting.
type CatKey = 'news' | 'opportunity' | 'calendar' | 'note';

const CATEGORIES: { key: CatKey; label: string; dot: string; match: (it: DigestItem) => boolean }[] = [
  { key: 'news',        label: 'News',          dot: 'bg-sky-500',    match: (i) => i.kind === 'news' },
  { key: 'opportunity', label: 'Opportunities', dot: 'bg-amber-500',  match: (i) => i.kind === 'opportunity' && i.ref_kind !== 'calendar_events' },
  { key: 'calendar',    label: 'Calendar',      dot: 'bg-orange-500', match: (i) => i.ref_kind === 'calendar_events' },
  { key: 'note',        label: 'Notes',         dot: 'bg-stone-400',  match: (i) => i.kind === 'note' },
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
  // the brief to the operator's current moment.
  const d = new Date();
  const day  = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

export default function Digest() {
  // The digest IS the brief. What feeds it is whatever this install has
  // (probed at generate time); the knobs that matter live in Knowledge
  // (topics, policy), not in a toggle grid.
  return (
    <div className="h-full flex flex-col">
      <BriefPane />
    </div>
  );
}

function BriefPane() {
  const [items, setItems]   = useState<DigestItem[] | null>(null);
  const [stats, setStats]   = useState<DigestStats | null>(null);
  const [hideRead, setHideRead] = useState(true);
  // Generation state lives in digestBackground.ts: the in-flight Promise
  // survives sidebar nav so the user can leave and come back to a
  // still-running (or just-finished) run.
  const [gen, setGen] = useState<DigestGenState>(() => getDigestGenState());
  const [activeItem, setActiveItem] = useState<DigestItem | null>(null);
  // A new digest opens on Nyo: until topics exist and a search source is
  // installed, the onboarding screen IS the page.
  const [src, setSrc] = useState<DigestSources | null>(null);
  const [srcFailed, setSrcFailed] = useState(false);
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  // Keep asking. A plugin install rebuilds and reloads the app, and one failed
  // read during that window used to pin the page on the brief for good.
  useEffect(() => {
    let alive = true;
    const tick = () => sourcesApi.read().then((r) => { if (alive) { setSrc(r); setSrcFailed(false); } }).catch(() => { if (alive) setSrcFailed(true); });
    void tick();
    const t = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // Active category filters (multi-select). Empty set = show everything.
  // Deliberately NOT persisted: a category filter is a transient view.
  const [cats, setCats] = useState<Set<CatKey>>(new Set());
  function toggleCat(k: CatKey) {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  // Time window: 'all' (default) or the last 24h. Composes with the
  // category chips (AND). Like a category, an active window shows read +
  // unread within it, so the unread toggle only governs the plain view.
  const [timeWin, setTimeWin] = useState<'all' | '24h'>('all');
  function clearFilters() { setCats(new Set()); setTimeWin('all'); }

  async function refresh() {
    // Load the FULL set (read + unread) and do the unread narrowing on the
    // client, so category filters can reach items the operator has already
    // read. The backend hard-deletes rows older than delete_after_days, so
    // the table stays well under this cap.
    const [it, st] = await Promise.all([
      api.listDigest({ limit: 1500 }),
      api.digestStats(),
    ]);
    setItems(it);
    setStats(st);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // Ongoing feed: cron-inserted cards appear on their own, no Generate
  // click, no navigation needed.
  useEffect(() => {
    const t = setInterval(() => { refresh(); }, 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the background-generation singleton. When a run settles we just
  // refresh the list: newly-pulled items are unread, so they appear at the
  // top of the default "showing unread" feed on their own.
  useEffect(() => {
    const unsub = subscribeDigestGen((s) => {
      setGen(s);
      if (!s.running && s.result) refresh();
    });
    return unsub;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  function generate() {
    // Fire-and-forget: the singleton handles the lifecycle. A click during
    // an in-flight run is a no-op (returns the same Promise).
    startDigestGeneration();
  }

  const generating   = gen.running;
  const genStartedAt = gen.running ? gen.started_at : null;
  const lastGen      = gen.result;

  // Re-render once a second so "updated 3m ago" keeps ticking and the
  // in-flight elapsed counter advances without a refetch.
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

  // Per-category TOTALS (read + unread) over the loaded set: the badge on a
  // chip is "how many cards a click surfaces". Categories are mutually
  // exclusive (break after the first match).
  const catCounts = useMemo(() => {
    const c = Object.fromEntries(CATEGORIES.map((cat) => [cat.key, 0])) as Record<CatKey, number>;
    for (const it of items || []) {
      for (const cat of CATEGORIES) {
        if (cat.match(it)) { c[cat.key]++; break; }
      }
    }
    return c;
  }, [items]);

  // Build the visible list. The unread toggle governs ONLY the plain default
  // view; any explicit filter surfaces read + unread within it.
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
      // their spot in the urgency groups.
      if (it.read_at !== null) done.push(it);
      else if (it.urgency === 1) high.push(it);
      else if (it.urgency === 2) mid.push(it);
      else low.push(it);
    }
    // Most recently dismissed first, so the card you just dismissed is findable.
    done.sort((a, b) => (b.read_at || 0) - (a.read_at || 0));
    // Within each urgency group, scored cards order by relevance
    // (meta.priority); unscored items keep their recency order below.
    const pr = (it: DigestItem) => Number(parseMeta(it).priority ?? -1);
    for (const g of [high, mid, low]) g.sort((a, b) => pr(b) - pr(a));
    return { high, mid, low, done };
  }, [filtered]);

  // Count of items that landed in the brief in the last 24h (read + unread).
  const last24hCount = useMemo(() => {
    if (!items) return 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let n = 0;
    for (const it of items) if (it.created_at >= cutoff) n++;
    return n;
  }, [items]);

  // Any explicit filter (a category or the time window) is active: the
  // unread toggle does not apply and its control goes inert.
  const hasExplicit = cats.size > 0 || timeWin === '24h';

  // Sources unknown yet (first read, or the app is mid-rebuild): a quiet
  // holding state, never the brief pretending to be the answer.
  if (!src && !skipOnboarding && (items?.length ?? 0) === 0) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center text-[12px] text-mute">
        {srcFailed ? 'Reconnecting…' : 'Loading…'}
      </div>
    );
  }
  if (src && !src.ready && !skipOnboarding && (items?.length ?? 0) === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <DigestOnboarding onDone={() => { sourcesApi.read().then(setSrc).catch(() => {}); refresh(); }} />
        <div className="px-4 py-1.5 border-t border-line text-[11px] text-mute shrink-0">
          <button className="underline underline-offset-2 hover:text-ink" onClick={() => setSkipOnboarding(true)}>Skip to the brief</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="px-4 sm:px-6 py-3 sm:py-5 border-b border-line bg-paper/60 shrink-0">
        <div className="flex items-baseline justify-between flex-wrap gap-2 sm:gap-4">
          <div>
            <div className="hidden sm:flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em] text-mute mb-1">
              <Coffee size={12} />
              <span>{todayLabel()}</span>
              {stats?.last_generated_at && (() => {
                const ago = timeAgo(stats.last_generated_at);
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
              title={hasExplicit ? 'A category or time filter shows all its items. Clear it to filter by unread' : undefined}
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
              {generating ? 'scanning...' : 'generate'}
            </button>
          </div>
        </div>
        {/* Filter bar: a TIME window (24h) set apart by a divider, then
            CATEGORY chips (multi-select, "all" clears them). Both compose
            (AND). Empty categories render dimmed + disabled. */}
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
        {/* Live progress strip: visible while a run is in flight and sticks
            around after so the operator can read the result. */}
        {(generating || lastGen) && (
          <div className="mt-3 flex items-baseline gap-3 flex-wrap text-[11px]">
            {generating ? (
              <span className="inline-flex items-center gap-1.5 text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-ink animate-pulse" />
                Scanning sources{genStartedAt ? <span className="text-mute mono"> · {Math.max(0, Math.floor((Date.now() - genStartedAt) / 1000))}s</span> : null}
              </span>
            ) : lastGen?.onboarding_needed ? (
              <span className="text-ink">
                Nothing to digest yet: this install is not onboarded. {' '}
                <button
                  className="underline underline-offset-2 hover:opacity-80"
                  onClick={() => window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target: 'nyo' } }))}
                >Talk to Nyo to onboard</button>
                {' '}(add a search provider and your topics, or connect the calendar) and the brief fills on its own.
              </span>
            ) : lastGen ? (
              <>
                <span className={lastGen.error ? 'text-rose-700' : lastGen.generated > 0 ? 'text-emerald-700' : 'text-mute'}>
                  {lastGen.error
                    ? 'Generate failed'
                    : lastGen.generated > 0
                      ? `Pulled ${lastGen.generated} new item${lastGen.generated === 1 ? '' : 's'}`
                      : 'No new activity (everything already in the brief)'}
                  {typeof lastGen.pruned === 'number' && lastGen.pruned > 0 && (
                    <span className="text-mute"> · archived {lastGen.pruned} stale</span>
                  )}
                  <span className="text-mute mono"> · {lastGen.ms}ms</span>
                </span>
                {lastGen.per_source && (
                  <span className="flex items-center gap-2 mono text-mute">
                    {Object.entries(lastGen.per_source).map(([src, info]) => (
                      <span key={src} className={info.error ? 'text-rose-700' : info.count > 0 ? 'text-emerald-700' : ''}>
                        {src}{info.error ? ' !' : ''} +{info.count}
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
          {!items && <div className="text-sm text-mute">Loading...</div>}
          {items && filtered.length === 0 && (
            hasExplicit ? (
              <div className="text-center py-16 space-y-3">
                <div className="text-4xl">🔍</div>
                <div className="text-sm text-mute">
                  {timeWin === '24h' && cats.size === 0 ? 'Nothing new in the last 24 hours.' : 'Nothing in this filter right now.'}{' '}
                  <button className="text-ink underline underline-offset-2" onClick={clearFilters}>Clear filters</button>
                </div>
              </div>
            ) : hideRead && items.length > 0 ? (
              // Rows exist but they are all read: the "all caught up" reward.
              <div className="text-center py-16 space-y-3">
                <div className="text-4xl">☕</div>
                <div className="text-sm text-mute">
                  You are all caught up, nothing unread.{' '}
                  <button className="text-ink underline underline-offset-2" onClick={() => setHideRead(false)}>Show {items.length} read item{items.length === 1 ? '' : 's'}</button>
                </div>
              </div>
            ) : (
              // Genuinely empty brief (fresh install / everything cleared).
              <div className="text-center py-16 space-y-3">
                <div className="text-4xl">☕</div>
                <div className="text-sm text-mute">Nothing in the brief yet. Hit <span className="text-ink">Generate</span>.</div>
              </div>
            )
          )}

          <Section title="Action needed" tone="high" items={grouped.high} onRead={markRead} onStar={toggleStar} onOpen={setActiveItem} />
          <Section title="This week"     tone="mid"  items={grouped.mid}  onRead={markRead} onStar={toggleStar} onOpen={setActiveItem} />
          <Section title="Background"    tone="low"  items={grouped.low}  onRead={markRead} onStar={toggleStar} onOpen={setActiveItem} />
          <Section title="Dismissed"     tone="low"  items={grouped.done} onRead={markRead} onStar={toggleStar} onOpen={setActiveItem} />
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
  // A news card's primary act is READ the source; internal cards (calendar,
  // opportunities, notes) open the drawer.
  const isExternal = item.kind === 'news';
  const meta = parseMeta(item);
  // Stops icon-button clicks from bubbling to the card-level open handler.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // Headlines can arrive as "Outlet: headline"; the outlet already shows on
  // the badge/host, so strip the prefix for a clean read.
  const title = isExternal ? item.title.replace(/^[^:]{1,24}:\s+/, '') : item.title;
  // The scorer's verdict: score chip + its one-line reason. A local override
  // reflects a feedback-triggered rescore without a full reload.
  const [prioLocal, setPrioLocal] = useState<{ score: number; reason: string } | null>(null);
  const [prioOpen, setPrioOpen] = useState(false);
  const [prioComment, setPrioComment] = useState('');
  const [prioBusy, setPrioBusy] = useState(false);
  const [prioNote, setPrioNote] = useState<string | null>(null);
  const prio = prioLocal ? prioLocal.score : (typeof meta.priority === 'number' ? meta.priority : null);
  const prioReason = prioLocal ? prioLocal.reason : (meta.priority_reason || '');
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
  // (matched on ref_kind). Give them a distinct label/tone.
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
          {label}
        </span>
        <span className="text-[11px] text-mute truncate">{isExternal ? (host || item.source_label) : item.source_label}</span>
        <span className="text-[10px] text-mute mono">· {timeAgo(item.created_at)}</span>

        <span className="ml-auto flex items-center gap-1" onClick={stop}>
          {/* Star stays subtle (reveals on hover): it is the rarer action. */}
          <button
            onClick={(e) => { stop(e); onStar(item.id, starred); }}
            aria-label={starred ? 'Unstar' : 'Star'}
            title={starred ? 'Unstar' : 'Star'}
            className={'h-7 w-7 grid place-items-center rounded-sm transition ' + (starred ? 'text-amber-500 hover:text-amber-600' : 'text-mute opacity-0 group-hover:opacity-100 hover:text-ink')}
          >
            <Star size={14} className={starred ? 'fill-current' : ''} />
          </button>
          {/* Dismiss is ALWAYS visible so "close out a card I do not care
              about" is one obvious click. */}
          {!isRead && (
            <button
              onClick={(e) => { stop(e); onRead(item.id); }}
              aria-label="Dismiss, not interesting"
              title="Dismiss, not interesting"
              className="h-7 w-7 grid place-items-center rounded-sm text-mute/70 hover:text-rose-600 hover:bg-rose-50 transition"
            >
              <X size={14} />
            </button>
          )}
        </span>
      </div>
      <div dir="auto" className="text-[14px] text-ink font-medium leading-snug break-words">{title}</div>
      {item.summary && (
        <p dir="auto" className="text-[12px] text-mute mt-1.5 leading-relaxed line-clamp-3 break-words">{item.summary}</p>
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
                rules
              </button>
            </div>
            <div dir="auto" className="text-[12px] leading-snug">{prioReason || 'no reason recorded'}</div>
            <textarea
              dir="auto"
              value={prioComment}
              onChange={(e) => setPrioComment(e.target.value)}
              rows={2}
              placeholder="disagree? say why, the scorer learns your taste"
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
                {prioBusy ? 'learning...' : 'teach'}
              </button>
            </div>
          </div>
        ) : null}
        {isExternal ? (
          item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
              title="Open the source"
            >
              Read ↗
            </a>
          )
        ) : (
          <>
            <button
              onClick={(e) => { stop(e); onOpen(item); }}
              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
              title="Open the panel for this item"
            >
              <Sparkle size={12} />
              Open
            </button>
            {item.suggested_action && (
              <span className="inline-flex items-center mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2 py-1">
                {item.suggested_action}
              </span>
            )}
            {item.source_url && (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
              >
                open link ↗
              </a>
            )}
          </>
        )}
      </div>
    </li>
  );
}
