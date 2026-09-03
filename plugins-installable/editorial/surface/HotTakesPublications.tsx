// Hot Takes — Publications tab. The blog section's review/publish experience
// transplanted onto the Hot Takes pipeline, in three areas over ONE joined view:
//
//   Needs Review            unpublished drafts with a body (any origin — Nyo,
//                           digest, or a hot-take package), inline-editable
//   Scheduled Publications  releases with a date — the hourly scheduler
//                           publishes the website FOR REAL when due
//   Published               live posts with their analytics leaderboard
//
// The one deliberate change from the Blog page: "Approve → publish" becomes
// "Approve → schedule" — the operator picks a future date/time instead of
// publishing on the spot (Publish now lives in the editor popup's schedule
// strip). There is NO row dropdown: clicking a publication opens the
// full-screen editor popup, which carries the whole release — article,
// schedule, social legs, stats + live preview once published.
// Scheduling a plain blog draft adopts it into the release pipeline server-side
// (a lightweight package), so social legs and the due-scan all run through the
// one package machinery.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type BlogPostWithTags, type HotTakePackage, type HotTakePost, type HotTakePipeline, type SocialIdentity,
} from './hot-takes-data';
import { fmtDate, timeAgo, fmtNum, TagList, KV, ColHeader, InlineBodyEditor } from './ArticleBits';
import { SitePreview } from './SitePreview';
import { LinkedIn, Trash, Pencil, X, Calendar as CalendarIcon, Check, Refresh } from '../../components/Icons';
import { PUBLIC_SITE_URL, PUBLIC_SITE_HOST } from './hot-takes-data';

type PipePkg = HotTakePackage & { posts: HotTakePost[]; next_action: string };
type Row = { post: BlogPostWithTags | null; pkg: PipePkg | null; slug: string; title: string };

type SortKey = 'views' | 'unique_visitors' | 'avg_scroll' | 'last_view' | 'published_at' | 'title';
type SortDir = 'asc' | 'desc';

// The operator's live public site, from lib/site.ts. Empty until a site
// origin is configured; the published view then says so instead of linking.
const PROD_URL = PUBLIC_SITE_URL;

const STATUS_LABEL: Record<string, string> = {
  article: 'Article', review: 'Needs review', ready: 'Ready',
  scheduled: 'Scheduled', published: 'Published', complete: 'Complete',
};
const STATUS_TONE: Record<string, string> = {
  article: 'bg-violet-100 text-violet-800', review: 'bg-amber-100 text-amber-900',
  ready: 'bg-emerald-100 text-emerald-800', scheduled: 'bg-blue-100 text-blue-800',
  published: 'bg-emerald-100 text-emerald-800', complete: 'bg-emerald-100 text-emerald-800',
};
const CHANNEL_SHORT: Record<string, string> = { 'linkedin-company': 'C', 'linkedin-personal': 'P' };
const CHANNEL_LABEL: Record<string, string> = {
  'linkedin-company': 'Company LinkedIn',
  'linkedin-personal': 'Personal LinkedIn',
};
const LEG_TONE: Record<string, string> = {
  posted: 'bg-emerald-100 text-emerald-800',
  scheduled: 'bg-blue-100 text-blue-800',
  failed: 'bg-rose-100 text-rose-800',
  ready: 'bg-stone-100 text-stone-700',
  draft: 'bg-stone-100 text-stone-600',
  skipped: 'bg-stone-100 text-stone-500',
  not_planned: 'bg-stone-100 text-stone-500',
};

function fmtWhen(ts?: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Phone-vs-desktop, live (rotations included) — drives the tap-to-select flow.
function useIsMobile(): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const on = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// Collapsible section headers render as color-coded TAGS — each section owns a
// tone, so the page scans as labeled regions rather than plain text rows.
function SectionHead({ open, onToggle, label, count, tone = 'bg-stone-100 text-stone-700' }: {
  open: boolean; onToggle: () => void; label: string; count: number; tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={'inline-flex items-center gap-2 px-2.5 py-1 rounded-sm mono text-[10px] uppercase tracking-[0.16em] font-semibold transition hover:opacity-85 ' + tone}
      >
        <span className={'text-[9px] transition-transform ' + (open ? 'rotate-90' : '')}>▶</span>
        <span>{label}</span>
        <span className="opacity-70 tabular-nums">{count}</span>
      </button>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={'mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm shrink-0 ' + (STATUS_TONE[status] || 'bg-stone-100 text-stone-700')}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

// The per-publication social markers — one mini chip per LinkedIn leg (C/P),
// toned by state, so a row shows at a glance that legs exist and where they are.
function LegChips({ posts, className }: { posts: HotTakePost[]; className?: string }) {
  const legs = posts.filter((p) => p.channel in CHANNEL_SHORT);
  if (!legs.length) return null;
  return (
    <span className={'inline-flex items-center gap-1 ' + (className || '')}>
      {legs.map((p) => (
        <span
          key={p.id}
          title={`${CHANNEL_LABEL[p.channel] || p.channel} · ${p.status}${p.scheduled_at ? ` · ${fmtWhen(p.scheduled_at)}` : ''}`}
          className={'inline-flex items-center gap-0.5 mono text-[9px] px-1 py-0.5 rounded-sm ' + (LEG_TONE[p.status] || 'bg-stone-100 text-stone-600')}
        >
          <LinkedIn size={10} />{CHANNEL_SHORT[p.channel]}
        </span>
      ))}
    </span>
  );
}

// ── the schedule popup ───────────────────────────────────────────────────────
// One picker for every Schedule click — rows, detail panels, the editor. Pops
// as a centered overlay (the operator asked for a popup, not an embedded
// calendar): quick picks up top for the common cases, the month grid under
// them, tap-size time chips, and a plain-English readout on the confirm.
// Times are deliberately UNEVEN inside the classic posting windows (early
// morning, mid-morning, lunch, mid/late afternoon) — on-the-hour posts read
// as scheduled by a machine.
const TIME_CHIPS = ['08:47', '10:13', '12:24', '15:37', '17:12'];

function quickPicks(): { label: string; ts: number }[] {
  const at = (daysAhead: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const now = new Date();
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: 'Tomorrow 8:47', ts: at(1, 8, 47) },
    { label: 'Tomorrow 12:24', ts: at(1, 12, 24) },
    { label: 'In 2 days 9:13', ts: at(2, 9, 13) },
    { label: 'Next Monday 8:47', ts: at(toMonday, 8, 47) },
  ];
}

// "Asia/Jerusalem · GMT+3" — so the picked time is never ambiguous.
function localZoneLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const offMin = -new Date().getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const mins = abs % 60;
  return `${tz} · GMT${sign}${Math.floor(abs / 60)}${mins ? ':' + String(mins).padStart(2, '0') : ''}`;
}

function SchedulePickerModal({ initial, busy, onConfirm, onCancel, label }: {
  initial: number | null; busy: boolean; onConfirm: (at: number) => void; onCancel: () => void; label: string;
}) {
  const init = useMemo(() => {
    if (initial) return new Date(initial);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 47, 0, 0); // sensible default: tomorrow, early posting window, uneven
    return d;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [viewY, setViewY] = useState(init.getFullYear());
  const [viewM, setViewM] = useState(init.getMonth());
  const [sel, setSel] = useState({ y: init.getFullYear(), m: init.getMonth(), d: init.getDate() });
  const [time, setTime] = useState(() =>
    `${String(init.getHours()).padStart(2, '0')}:${String(init.getMinutes()).padStart(2, '0')}`);

  const ts = useMemo(() => {
    const [hh, mm] = time.split(':').map((n) => parseInt(n, 10));
    return new Date(sel.y, sel.m, sel.d, hh || 0, mm || 0, 0, 0).getTime();
  }, [sel, time]);

  // A quick pick sets date + time + view together — one tap, done.
  function applyTs(t: number) {
    const d = new Date(t);
    setSel({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate() });
    setViewY(d.getFullYear()); setViewM(d.getMonth());
    setTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  }

  const first = new Date(viewY, viewM, 1);
  const startPad = first.getDay(); // Sunday-first
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const cells: (number | null)[] = [
    ...(Array.from({ length: startPad }, () => null) as null[]),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const readout = new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const picks = useMemo(quickPicks, []);
  const chip = (active: boolean) =>
    'h-8 px-2.5 rounded-sm text-[11px] transition ' +
    (active ? 'bg-ink text-paper font-medium' : 'hairline bg-card text-mute hover:text-ink');

  function nav(delta: number) {
    const d = new Date(viewY, viewM + delta, 1);
    setViewY(d.getFullYear()); setViewM(d.getMonth());
  }

  return (
    // stopPropagation on the backdrop too — rows render this inline, and a
    // bubbled click would toggle the row underneath while closing the popup.
    <div className="fixed inset-0 z-[70] bg-black/30 grid place-items-center p-3" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="w-full max-w-sm rounded-sm hairline bg-paper shadow-xl p-4 space-y-3 select-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium text-ink">{label}</div>
          <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute" title="All times are in your local zone">{localZoneLabel()}</div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {picks.map((p) => (
            <button key={p.label} type="button" onClick={() => applyTs(p.ts)}
              className={chip(Math.abs(p.ts - ts) < 60_000)}>
              {p.label}
            </button>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <button type="button" onClick={() => nav(-1)} aria-label="Previous month"
              className="h-9 w-9 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card transition text-base">‹</button>
            <span className="text-xs font-medium text-ink">{monthLabel}</span>
            <button type="button" onClick={() => nav(1)} aria-label="Next month"
              className="h-9 w-9 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card transition text-base">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-0.5">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <span key={i} className="h-6 grid place-items-center mono text-[9px] uppercase text-mute">{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d === null) return <span key={i} />;
              const dayTs = new Date(viewY, viewM, d).getTime();
              const isPast = dayTs < todayStart.getTime();
              const isSel = sel.y === viewY && sel.m === viewM && sel.d === d;
              const isToday = dayTs === todayStart.getTime();
              return (
                <button
                  key={i} type="button" disabled={isPast}
                  onClick={() => setSel({ y: viewY, m: viewM, d })}
                  className={'h-9 rounded-sm text-xs tabular-nums transition ' +
                    (isSel ? 'bg-ink text-paper font-medium'
                      : isPast ? 'text-mute/40 cursor-not-allowed'
                      : 'text-ink hover:bg-card') +
                    (isToday && !isSel ? ' hairline' : '')}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {TIME_CHIPS.map((t) => (
            <button key={t} type="button" onClick={() => setTime(t)} className={chip(time === t)}>{t}</button>
          ))}
          <input
            type="time" value={time} onChange={(e) => setTime(e.target.value)}
            aria-label="Custom time"
            className="h-8 px-2 rounded-sm bg-paper border border-line text-xs text-ink mono tabular-nums focus:outline-none focus:border-ink/40"
          />
        </div>

        <div className="border-t border-line pt-3 flex items-center gap-2">
          <span className="text-xs font-medium text-ink flex-1 min-w-0 truncate">{readout}</span>
          <button onClick={onCancel} className="h-9 px-3 rounded-sm border border-line text-xs text-mute hover:text-ink transition shrink-0">Cancel</button>
          <button
            onClick={() => onConfirm(ts)}
            disabled={busy || !Number.isFinite(ts)}
            className="h-9 px-4 rounded-sm bg-ink text-paper text-xs font-medium hover:opacity-90 transition disabled:opacity-50 shrink-0"
          >
            {busy ? 'Scheduling…' : label}
          </button>
        </div>
      </div>
    </div>
  );
}

// Kept as the name rows/detail panels render — now simply the popup.
function SchedulePopover(props: {
  initial: number | null; busy: boolean; onConfirm: (at: number) => void; onCancel: () => void; label: string;
}) {
  return <SchedulePickerModal {...props} />;
}

export function PublicationsTab({ bump, refresh, focusSlug, onConsumeFocus, onOpenEditor, draftingPkg, onConsumeDrafting }: {
  bump: number;
  refresh: () => void;
  focusSlug: string | null;
  onConsumeFocus: () => void;
  onOpenEditor: (id: string) => void;
  draftingPkg: HotTakePackage | null;
  onConsumeDrafting: () => void;
}) {
  const [posts, setPosts] = useState<BlogPostWithTags[] | null>(null);
  const [pipe, setPipe] = useState<HotTakePipeline | null>(null);
  // Published starts COLLAPSED — the working sections lead.
  const [open, setOpen] = useState<Record<string, boolean>>({ review: true, scheduled: true, published: false });
  const [focusPending, setFocusPending] = useState<string | null>(null); // Social-tab jump target, resolved into the popup
  const [editorRow, setEditorRow] = useState<Row | null>(null); // full-screen editor popup
  const [editorAutoDraft, setEditorAutoDraft] = useState(false); // the Topics "Draft a Take" handoff — chain runs inside the popup
  const [err, setErr] = useState<string | null>(null);
  // Mobile: tapping a card SELECTS it; a sticky action header carries the acts.
  const isMobile = useIsMobile();
  const [mobileSel, setMobileSel] = useState<Row | null>(null);
  const [mobileSchedOpen, setMobileSchedOpen] = useState(false);
  const [mobileBusy, setMobileBusy] = useState<string | null>(null);

  // Published-section leaderboard state (same semantics as the Blog page).
  const [sortKey, setSortKey] = useState<SortKey>('published_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(20);

  async function load() {
    try {
      const [all, p] = await Promise.all([api.listBlogAnalytics(false), api.hotTakePipeline()]);
      setPosts(all);
      setPipe(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load');
    }
  }
  useEffect(() => { load(); }, [bump]);

  // Arriving from the Social Posts tab with a target publication — there is no
  // dropdown anymore, so the jump goes straight into the full-screen popup once
  // the rows have loaded.
  useEffect(() => {
    if (focusSlug) { setFocusPending(focusSlug); onConsumeFocus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSlug]);

  // ONE joined view: every package that reached an article, keyed by slug.
  const pkgBySlug = useMemo(() => {
    const m = new Map<string, PipePkg>();
    if (pipe) {
      for (const group of [pipe.in_flight, pipe.needs_review, pipe.ready, pipe.scheduled, pipe.published]) {
        for (const p of group) if (p.blog_slug) m.set(p.blog_slug, p);
      }
    }
    return m;
  }, [pipe]);

  const rows = useMemo(() => {
    const bySlug = new Map<string, Row>();
    for (const post of posts || []) {
      bySlug.set(post.slug, { post, pkg: pkgBySlug.get(post.slug) || null, slug: post.slug, title: post.title });
    }
    // A scheduled package whose draft row is missing locally still deserves a row.
    for (const [slug, pkg] of pkgBySlug) {
      if (!bySlug.has(slug)) bySlug.set(slug, { post: null, pkg, slug, title: pkg.headline || pkg.title || slug });
    }
    return [...bySlug.values()];
  }, [posts, pkgBySlug]);

  // Keep the mobile selection pointing at the FRESH row after a reload —
  // otherwise the action header shows pre-action state (e.g. "Schedule" right
  // after scheduling).
  useEffect(() => {
    setMobileSel((prev) => (prev ? rows.find((r) => r.slug === prev.slug) || null : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Resolve a pending Social-tab jump into the popup as soon as its row exists.
  useEffect(() => {
    if (!focusPending) return;
    const found = rows.find((r) => r.slug === focusPending);
    if (found) { setEditorRow(found); setEditorAutoDraft(false); setFocusPending(null); }
  }, [focusPending, rows]);

  // Topics → "Draft a Take": open the popup IMMEDIATELY for a package that has
  // no article yet — the popup itself runs the drafting chain behind a progress
  // screen and morphs into the editor when the draft lands.
  useEffect(() => {
    if (!draftingPkg) return;
    const pipePkg = { ...draftingPkg, posts: [], next_action: '' } as PipePkg;
    setEditorRow({
      post: null,
      pkg: pipePkg,
      slug: draftingPkg.blog_slug || '',
      title: draftingPkg.headline || draftingPkg.title || 'Untitled topic',
    });
    setEditorAutoDraft(true);
    onConsumeDrafting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftingPkg]);

  const needsReview = useMemo(
    () => rows
      .filter((r) => r.post && !r.post.published && !!r.post.body && r.post.body.trim().length > 0 && r.pkg?.status !== 'scheduled')
      .sort((a, b) => (b.post!.updated_at || 0) - (a.post!.updated_at || 0)),
    [rows],
  );
  const scheduled = useMemo(
    () => rows
      .filter((r) => r.pkg?.status === 'scheduled' && !r.post?.published)
      // LIFO by EDIT time — what you just worked on sits on top, findable.
      .sort((a, b) =>
        Math.max(b.post?.updated_at || 0, b.pkg!.updated_at || 0) -
        Math.max(a.post?.updated_at || 0, a.pkg!.updated_at || 0)),
    [rows],
  );
  const published = useMemo(() => {
    const arr = rows.filter((r) => !!r.post?.published);
    arr.sort((a, b) => {
      const pa = a.post!; const pb = b.post!;
      let av: number | string = 0; let bv: number | string = 0;
      if (sortKey === 'title') { av = pa.title.toLowerCase(); bv = pb.title.toLowerCase(); }
      else if (sortKey === 'published_at') { av = pa.published_at ?? 0; bv = pb.published_at ?? 0; }
      else if (sortKey === 'last_view') { av = pa.last_view ?? 0; bv = pb.last_view ?? 0; }
      else if (sortKey === 'avg_scroll') { av = pa.avg_scroll; bv = pb.avg_scroll; }
      else if (sortKey === 'unique_visitors') { av = pa.unique_visitors; bv = pb.unique_visitors; }
      else { av = pa.views; bv = pb.views; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'title' ? 'asc' : 'desc'); }
  }

  if (!posts || !pipe) {
    return <div className="flex-1 grid place-items-center text-sm text-mute">{err || 'Loading publications…'}</div>;
  }

  // The mobile action header's acts, against the selected row.
  async function mobileAct(tag: string, fn: () => Promise<unknown>) {
    setMobileBusy(tag); setErr(null);
    try {
      const r = (await fn()) as { error?: string } | undefined;
      if (r?.error) { setErr(r.error); return; }
      load(); refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setMobileBusy(null);
    }
  }
  const mobileSchedule = (at: number) => {
    if (!mobileSel) return;
    void mobileAct('sched', () =>
      (mobileSel.pkg ? api.hotTakeSchedule(mobileSel.pkg.id, { website_at: at }) : api.hotTakeScheduleBlog(mobileSel.slug, { website_at: at }))
        .then((r) => { setMobileSchedOpen(false); return r; }));
  };
  function mobileDelete() {
    if (!mobileSel) return;
    const liveWarning = mobileSel.post?.published ? ' It does NOT unpublish it from the public site — take the live post down separately.' : '';
    if (!confirm(`Delete "${mobileSel.title}"?\n\nThis removes the post from the Command Center.${liveWarning}\n\nThis can't be undone.`)) return;
    const slug = mobileSel.slug;
    setMobileSel(null);
    void mobileAct('del', () => api.deleteBlogPost(slug));
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* mobile-only: the selected take's actions, as an additional header */}
      {isMobile && mobileSel && (
        <div className="sm:hidden sticky top-0 z-20 px-4 py-2 bg-paper/95 backdrop-blur border-b border-line space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-ink flex-1 min-w-0 truncate">{mobileSel.title}</span>
            <button
              onClick={() => { setMobileSel(null); setMobileSchedOpen(false); }}
              aria-label="Dismiss selection"
              className="h-7 w-7 grid place-items-center rounded-sm text-mute hover:text-ink transition shrink-0"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { setEditorRow(mobileSel); setEditorAutoDraft(false); }}
              className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition"
            >
              Open
            </button>
            {!mobileSel.post?.published && (
              <button
                onClick={() => setMobileSchedOpen(true)}
                disabled={!!mobileBusy}
                className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-mute hover:text-ink transition disabled:opacity-50"
              >
                {mobileSel.pkg?.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
              </button>
            )}
            {mobileSel.pkg?.status === 'scheduled' && !mobileSel.post?.published && (
              <button
                onClick={() => mobileSel.pkg && void mobileAct('cancel', () => api.hotTakeCancelSchedule(mobileSel.pkg!.id))}
                disabled={!!mobileBusy}
                className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
              >
                {mobileBusy === 'cancel' ? '…' : 'Cancel'}
              </button>
            )}
            <button
              onClick={mobileDelete}
              disabled={!!mobileBusy}
              className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
            >
              {mobileBusy === 'del' ? '…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {mobileSchedOpen && mobileSel && (
        <SchedulePickerModal
          initial={mobileSel.pkg?.scheduled_at || null}
          busy={mobileBusy === 'sched'}
          onConfirm={mobileSchedule}
          onCancel={() => setMobileSchedOpen(false)}
          label={mobileSel.pkg?.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
        />
      )}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-6">
        {err && <div className="text-xs text-rose-600">{err}</div>}

        <section>
          <SectionHead open={!!open.review} onToggle={() => setOpen((o) => ({ ...o, review: !o.review }))} label="Needs Review" count={needsReview.length} tone="bg-amber-100 text-amber-900" />
          {open.review && (needsReview.length === 0
            ? <div className="text-sm text-mute px-1 py-2">Nothing to review — new drafts land here.</div>
            : (
              <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
                {needsReview.map((r) => (
                  <PublicationRow
                    key={r.slug} row={r} kind="review"
                    onEdit={() => { setEditorRow(r); setEditorAutoDraft(false); }}
                    onChanged={() => { load(); refresh(); }}
                    mobile={isMobile}
                    selected={mobileSel?.slug === r.slug}
                    onSelect={() => { setMobileSel((prev) => (prev?.slug === r.slug ? null : r)); setMobileSchedOpen(false); }}
                  />
                ))}
              </ul>
            ))}
        </section>

        <section>
          <SectionHead open={!!open.scheduled} onToggle={() => setOpen((o) => ({ ...o, scheduled: !o.scheduled }))} label="Scheduled Publications" count={scheduled.length} tone="bg-blue-100 text-blue-800" />
          {open.scheduled && (scheduled.length === 0
            ? <div className="text-sm text-mute px-1 py-2">Nothing scheduled. Approve a draft above and pick its publication date.</div>
            : (
              <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
                {scheduled.map((r) => (
                  <PublicationRow
                    key={r.slug} row={r} kind="scheduled"
                    onEdit={() => { setEditorRow(r); setEditorAutoDraft(false); }}
                    onChanged={() => { load(); refresh(); }}
                    mobile={isMobile}
                    selected={mobileSel?.slug === r.slug}
                    onSelect={() => { setMobileSel((prev) => (prev?.slug === r.slug ? null : r)); setMobileSchedOpen(false); }}
                  />
                ))}
              </ul>
            ))}
        </section>

        <section>
          <SectionHead open={!!open.published} onToggle={() => setOpen((o) => ({ ...o, published: !o.published }))} label="Published" count={published.length} tone="bg-emerald-100 text-emerald-800" />
          {open.published && (published.length === 0
            ? <div className="text-sm text-mute px-1 py-2">Nothing live yet.</div>
            : (
              <div className="overflow-x-auto">
                <ul className="hairline rounded-sm bg-card/80 divide-y divide-line min-w-[760px]">
                  <li className="px-4 py-2 grid grid-cols-12 gap-3 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
                    <ColHeader k="title" label="title" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-4" />
                    <ColHeader k="published_at" label="published" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1" />
                    <span className="col-span-2">tags</span>
                    <ColHeader k="views" label="views" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                    <ColHeader k="unique_visitors" label="unique" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                    <ColHeader k="avg_scroll" label="scroll %" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                    <ColHeader k="last_view" label="last view" sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-2 text-right" />
                  </li>
                  {published.slice(0, shown).map((r) => (
                    <PublicationRow
                      key={r.slug} row={r} kind="published"
                      onEdit={() => { setEditorRow(r); setEditorAutoDraft(false); }}
                      onChanged={() => { load(); refresh(); }}
                      mobile={isMobile}
                      selected={mobileSel?.slug === r.slug}
                      onSelect={() => { setMobileSel((prev) => (prev?.slug === r.slug ? null : r)); setMobileSchedOpen(false); }}
                    />
                  ))}
                </ul>
                {published.length > shown && (
                  <button onClick={() => setShown((n) => n + 50)} className="mt-2 h-8 px-3 rounded-sm hairline bg-card mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink transition">
                    Show more ({published.length - shown} more)
                  </button>
                )}
              </div>
            ))}
        </section>
      </div>

      {editorRow && (
        <EditorModal
          row={editorRow}
          autoDraft={editorAutoDraft}
          onClose={() => { setEditorRow(null); setEditorAutoDraft(false); load(); }}
          // Scheduling no longer closes the editor — social offsets are the next
          // step of the same flow. Lists refresh behind the popup.
          onScheduled={() => { load(); refresh(); }}
          onOpenReview={onOpenEditor}
        />
      )}
    </div>
  );
}

// One list row. No dropdown: on DESKTOP clicking the row (or the pencil) opens
// the full-screen editor popup and the inline buttons cover the quick acts; on
// MOBILE a tap SELECTS the row (taller card, whole title visible) and the
// sticky action header above carries the acts.
function PublicationRow({ row, kind, onChanged, onEdit, mobile, selected, onSelect }: {
  row: Row;
  kind: 'review' | 'scheduled' | 'published';
  onChanged: () => void;
  onEdit: () => void;
  mobile: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const rowClick = mobile ? onSelect : onEdit;
  const { post, pkg, slug } = row;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [schedOpen, setSchedOpen] = useState(false);

  async function run(tag: string, fn: () => Promise<unknown>) {
    setBusy(tag); setErr(null);
    try {
      const r = (await fn()) as { error?: string } | undefined;
      if (r?.error) { setErr(r.error); return; }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  // Schedule (adopting a plain draft server-side when there is no package yet).
  const schedule = (at: number) => run('sched', () =>
    (pkg ? api.hotTakeSchedule(pkg.id, { website_at: at }) : api.hotTakeScheduleBlog(slug, { website_at: at }))
      .then((r) => { setSchedOpen(false); return r; }));

  async function remove() {
    const title = row.title;
    const liveWarning = post?.published ? ' It does NOT unpublish it from the public site — take the live post down separately.' : '';
    if (!confirm(`Delete "${title}"?\n\nThis removes the post from the Command Center.${liveWarning}\n\nThis can't be undone.`)) return;
    await run('del', () => api.deleteBlogPost(slug));
  }

  const meta = (
    <div className="min-w-0">
      {/* Mobile shows the WHOLE title (wraps); desktop keeps the one-line truncate. */}
      <div className="font-medium text-ink flex items-center gap-2 flex-wrap sm:flex-nowrap sm:truncate break-words">
        {row.title}
        {kind === 'review' && <span className="mono text-[9px] uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded-sm shrink-0">draft</span>}
        {pkg && kind !== 'published' && <StatusChip status={pkg.status} />}
      </div>
      <div className="mono text-[10px] text-mute truncate">/blog/{slug}</div>
    </div>
  );

  return (
    <li>
      {kind === 'published' ? (
        <div onClick={rowClick} title="Open this publication" className={'px-4 py-4 sm:py-3 grid grid-cols-12 gap-3 items-baseline text-[13px] hover:bg-card transition cursor-pointer ' + (mobile && selected ? 'bg-card ring-1 ring-ink/30' : '')}>
          <div className="col-span-4 min-w-0 flex items-center gap-3">
            {meta}
          </div>
          <span className="col-span-1 mono text-[10px] text-mute">{fmtDate(post?.published_at)}</span>
          <span className="col-span-2 flex flex-wrap gap-1 items-center">
            <TagList tags={post?.tags || []} />
            {pkg && <LegChips posts={pkg.posts} />}
          </span>
          <span className="col-span-1 text-right mono text-[12px] text-ink">{fmtNum(post?.views || 0)}</span>
          <span className="col-span-1 text-right mono text-[12px] text-ink">{fmtNum(post?.unique_visitors || 0)}</span>
          <span className="col-span-1 text-right mono text-[12px] text-ink">
            {post && post.avg_scroll > 0 ? `${Math.round(post.avg_scroll)}%` : <span className="text-mute">—</span>}
          </span>
          <span className="col-span-2 text-right mono text-[10px] text-mute">{timeAgo(post?.last_view)}</span>
        </div>
      ) : (
        <div onClick={rowClick} title={mobile ? 'Select this publication' : 'Open this publication'} className={'px-4 py-4 sm:py-3 flex items-center gap-3 text-[13px] hover:bg-card transition cursor-pointer flex-wrap ' + (mobile && selected ? 'bg-card ring-1 ring-ink/30' : '')}>
          <div className="flex-1 min-w-0">{meta}</div>
          {pkg && <LegChips posts={pkg.posts} className="shrink-0" />}
          {kind === 'scheduled' && pkg?.scheduled_at && (
            <span className="mono text-[10px] text-blue-700 dark:text-blue-300 shrink-0 inline-flex items-center gap-1">
              <CalendarIcon size={12} /> {fmtWhen(pkg.scheduled_at)}
            </span>
          )}
          {kind === 'review' && <span className="mono text-[10px] text-mute shrink-0 hidden sm:inline">{timeAgo(post?.updated_at)}</span>}
          <span className="shrink-0 hidden sm:flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={onEdit}
              title="Edit this article in the full-screen editor"
              className="h-8 w-8 grid place-items-center rounded-sm border border-line text-mute transition hover:text-ink hover:border-ink/40"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={remove}
              disabled={busy === 'del'}
              title="Delete this post from the Command Center"
              className={'h-8 w-8 grid place-items-center rounded-sm border border-line text-mute transition ' + (busy === 'del' ? 'cursor-wait opacity-60' : 'hover:text-rose-600 hover:border-rose-400/60')}
            >
              {busy === 'del' ? <span className="mono text-[10px]">…</span> : <Trash size={14} />}
            </button>
            {kind === 'review' && (
              schedOpen ? (
                <SchedulePopover initial={null} busy={busy === 'sched'} onConfirm={schedule} onCancel={() => setSchedOpen(false)} label="Schedule" />
              ) : (
                <button
                  onClick={() => setSchedOpen(true)}
                  title="Approve this draft and pick the date it publishes to the public site"
                  className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition"
                >
                  Schedule
                </button>
              )
            )}
            {kind === 'scheduled' && (
              schedOpen ? (
                <SchedulePopover initial={pkg?.scheduled_at || null} busy={busy === 'sched'} onConfirm={schedule} onCancel={() => setSchedOpen(false)} label="Reschedule" />
              ) : (
                <>
                  <button
                    onClick={() => setSchedOpen(true)}
                    className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition"
                  >
                    Reschedule
                  </button>
                  <button
                    onClick={() => pkg && run('cancel', () => api.hotTakeCancelSchedule(pkg.id))}
                    disabled={!!busy}
                    title="Back to Needs Review — nothing publishes"
                    className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
                  >
                    {busy === 'cancel' ? '…' : 'Cancel'}
                  </button>
                </>
              )
            )}
          </span>
        </div>
      )}
      {err && <div className="px-4 pb-2 text-xs text-rose-600">{err}</div>}
    </li>
  );
}

// ─── the full-screen editor popup ────────────────────────────────────────────
// The whole release in one popup, scrolling as ONE column: the article, the
// publication schedule (embedded date picker), and the social legs
// (offset-after-publication + inline text). The sticky header carries the attention strip — blue: done, gray:
// still needs the operator — each icon jumping to its section.
// The take → brief → article stages the in-popup drafter narrates. Copy
// matters: it's what makes the wait acceptable.
const CHAIN_STAGES: { key: 'take' | 'brief' | 'article'; title: string; sub: string }[] = [
  { key: 'take', title: 'Drafting the take', sub: 'The argument this article will make — specific and opinionated.' },
  { key: 'brief', title: 'Building the brief', sub: 'Structure, audience, evidence, and the objections to answer.' },
  { key: 'article', title: 'Writing the article', sub: 'The full draft in your voice. This is the long step — usually about a minute.' },
];

function EditorModal({ row, autoDraft = false, onClose, onScheduled, onOpenReview }: {
  row: Row;
  autoDraft?: boolean;
  onClose: () => void;
  onScheduled: () => void;
  onOpenReview: (pkgId: string) => void;
}) {
  const { pkg: initialPkg } = row;
  // post + slug are STATE: the Draft-a-Take handoff opens this popup before an
  // article exists, and the in-popup chain fills them in when the draft lands.
  const [post, setPost] = useState<BlogPostWithTags | null>(row.post);
  const [slug, setSlug] = useState(row.slug);
  const [pkg, setPkg] = useState<PipePkg | null>(initialPkg);
  const [step, setStep] = useState<'article' | 'social'>('article');
  const [schedOpen, setSchedOpen] = useState(false);
  const [drafting, setDrafting] = useState(false); // the "Drafting social posts…" interstitial after a reroute
  const [identities, setIdentities] = useState<Record<string, SocialIdentity> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [redraftTick, setRedraftTick] = useState(0); // remounts leg cards ONLY after a redraft (typing must not remount)
  // Eagerly seeded on a Draft-a-Take handoff so the FIRST paint is already the
  // progress screen (the chain effect only fires after mount — without this the
  // opening frame would flash "Nothing to edit").
  const [chainStage, setChainStage] = useState<'take' | 'brief' | 'article' | null>(
    autoDraft && !row.post && !row.pkg?.blog_slug ? 'take' : null,
  );
  const [chainErr, setChainErr] = useState<string | null>(null);
  const [donePopup, setDonePopup] = useState(false);
  const chainStarted = useRef(false);
  const sawUnapproved = useRef(false);
  const doneNagged = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fresh package (legs + review) on open — the row's copy can be stale. The
  // identities drive the poster header on each post preview. When this popup
  // was opened by Draft a Take, run the drafting chain immediately.
  useEffect(() => {
    if (initialPkg?.id) void reloadPkg(initialPkg.id);
    api.hotTakeSocialIdentities().then(setIdentities).catch(() => {});
    if (autoDraft && !row.post && initialPkg && !initialPkg.blog_slug && !chainStarted.current) {
      chainStarted.current = true;
      void runChain(initialPkg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Draft-a-Take chain, running INSIDE the popup. Statuses advance
  // server-side per step, so a failure midway resumes from where it stopped.
  async function runChain(p: HotTakePackage) {
    setChainErr(null);
    try {
      let status = p.status;
      let newSlug: string | null = p.blog_slug || null;
      if (status === 'topic') {
        setChainStage('take');
        const r = await api.hotTakeDraftTake(p.id);
        if (r.error) throw new Error(r.error);
        status = 'take';
      }
      if (status === 'take') {
        setChainStage('brief');
        const r = await api.hotTakeBuildBrief(p.id);
        if (r.error) throw new Error(r.error);
        status = 'brief';
      }
      if (status === 'brief') {
        setChainStage('article');
        const r = await api.hotTakeWriteArticle(p.id);
        if (r.error || !r.slug) throw new Error(r.error || 'article write failed');
        newSlug = r.slug;
      }
      if (!newSlug) throw new Error('no article draft was produced');
      const fetched = await api.getBlogPost(newSlug);
      setPost(fetched);
      setSlug(newSlug);
      await reloadPkg(p.id);
      setChainStage(null);
      onScheduled(); // refresh the lists behind the popup
    } catch (e) {
      setChainErr(e instanceof Error ? e.message : 'drafting failed');
    }
  }

  // Retry resumes: refetch the package so the chain starts from its CURRENT
  // server-side status, not the stale one we opened with.
  async function retryChain() {
    if (!initialPkg) return;
    setChainErr(null);
    try {
      const r = await api.hotTakePackage(initialPkg.id);
      void runChain({ ...initialPkg, ...r.package });
    } catch {
      void runChain(initialPkg);
    }
  }

  async function reloadPkg(id: string): Promise<PipePkg | null> {
    try {
      const r = await api.hotTakePackage(id);
      const merged = { ...(pkg || ({} as PipePkg)), ...r.package, posts: r.posts, next_action: r.next_action } as PipePkg;
      setPkg((prev) => ({ ...(prev || ({} as PipePkg)), ...r.package, posts: r.posts, next_action: r.next_action }));
      return merged;
    } catch { return pkg; /* keep the row copy */ }
  }

  // After adopting a plain blog draft (first schedule / draft-social on a
  // package-less row) the package exists server-side but this modal doesn't
  // know its id yet — find it by slug in the pipeline.
  async function findPkgBySlug(): Promise<PipePkg | null> {
    try {
      const p = await api.hotTakePipeline();
      for (const group of [p.in_flight, p.needs_review, p.ready, p.scheduled, p.published]) {
        const found = group.find((x) => x.blog_slug === slug);
        if (found) { setPkg(found); return found; }
      }
    } catch { /* leave as-is */ }
    return null;
  }

  const legs = (pkg?.posts || []).filter((p) => p.channel in CHANNEL_SHORT);
  const base = pkg?.scheduled_at || null;
  const isScheduled = pkg?.status === 'scheduled' && !!pkg?.scheduled_at;

  // "Finished editing?" — fires ONCE, only after the operator has moved the
  // legs from a not-all-approved state to all-approved in THIS session (an
  // already-approved package opening does not nag).
  useEffect(() => {
    const planned = legs.filter((l) => l.status !== 'not_planned' && l.status !== 'skipped');
    const allApproved = planned.length > 0 && planned.every((l) => ['scheduled', 'posted'].includes(l.status));
    if (!allApproved) { if (legs.length) sawUnapproved.current = true; return; }
    if (sawUnapproved.current && !doneNagged.current) {
      doneNagged.current = true;
      setDonePopup(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);
  const openClaims = pkg
    ? ((pkg.review as { claims?: { status: string }[] } | null)?.claims || []).filter((c) => c.status === 'needs_confirmation').length
    : 0;

  // Schedule → reroute to the social page, with the posts ALREADY drafted:
  // confirm in the popup, book the release, land on the next stage. If the legs
  // have no text yet the drafter runs automatically while the page shows a
  // drafting interstitial.
  async function schedule(at: number) {
    setBusy('sched'); setErr(null);
    try {
      const r = await (pkg
        ? api.hotTakeSchedule(pkg.id, { website_at: at })
        : api.hotTakeScheduleBlog(slug, { website_at: at }));
      if ((r as { error?: string }).error) { setErr((r as { error?: string }).error!); return; }
      setSchedOpen(false);
      setFlash('Scheduled'); setTimeout(() => setFlash(null), 1800);
      onScheduled();
      setStep('social'); // the reroute — social posts are the next stage
      const fresh = pkg ? await reloadPkg(pkg.id) : await findPkgBySlug();
      const freshLegs = (fresh?.posts || []).filter((p) => p.channel in CHANNEL_SHORT);
      const hasText = freshLegs.some((p) => (p.body || '').trim() !== '');
      if (!hasText) {
        setDrafting(true);
        try {
          const dr = await (fresh ? api.hotTakeDraftSocial(fresh.id) : api.hotTakeDraftSocialBlog(slug));
          if ((dr as { error?: string })?.error) {
            setErr((dr as { error?: string }).error!);
          } else {
            if (fresh) await reloadPkg(fresh.id); else await findPkgBySlug();
            setRedraftTick((t) => t + 1);
          }
        } finally {
          setDrafting(false);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'schedule failed');
    } finally {
      setBusy(null);
    }
  }

  async function cancelSchedule() {
    if (!pkg) return;
    setBusy('cancel'); setErr(null);
    try {
      await api.hotTakeCancelSchedule(pkg.id);
      await reloadPkg(pkg.id);
      onScheduled();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'cancel failed');
    } finally {
      setBusy(null);
    }
  }

  async function draftSocial() {
    setBusy('social'); setErr(null);
    try {
      const r = await (pkg ? api.hotTakeDraftSocial(pkg.id) : api.hotTakeDraftSocialBlog(slug));
      if ((r as { error?: string })?.error) { setErr((r as { error?: string }).error!); return; }
      if (pkg) await reloadPkg(pkg.id); else await findPkgBySlug();
      setRedraftTick((t) => t + 1); // new bodies — remount the leg editors so textareas show them
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'draft failed');
    } finally {
      setBusy(null);
    }
  }

  function onLegPatched(updated: HotTakePost) {
    setPkg((prev) => (prev ? { ...prev, posts: (prev.posts || []).map((p) => (p.id === updated.id ? updated : p)) } : prev));
  }

  // Publish immediately, skipping the schedule. MUST close the modal on
  // success: the article editor saves `published` from its (now stale) prop, so
  // a later autosave from this open editor would write published:0 and silently
  // unpublish the article.
  async function publishNow() {
    if (!window.confirm(`Publish "${row.title}" to the live site right now?`)) return;
    setBusy('pub'); setErr(null);
    try {
      const r = await (pkg ? api.hotTakePublishWebsite(pkg.id) : api.publishBlogPost(slug));
      if ((r as { error?: string })?.error) { setErr((r as { error?: string }).error!); return; }
      onScheduled();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'publish failed');
    } finally {
      setBusy(null);
    }
  }

  // ── the attention strip: blue = done, gray = still needs the operator ──
  // A leg counts as done only when APPROVED (or already posted) — text and a
  // time alone leave it gray, because held posts never fire.
  const legDone = (ch: string) => {
    const l = legs.find((p) => p.channel === ch);
    return !!l && (l.body || '').trim() !== '' && ['scheduled', 'posted'].includes(l.status);
  };
  const aspects: {
    key: string; label: string; done: boolean;
    icon: (p: { size?: number; className?: string }) => React.ReactElement;
    go: () => void; tag?: string;
  }[] = [
    { key: 'article', label: 'Article body', done: !!(post?.body || '').trim(), icon: Pencil, go: () => setStep('article') },
    { key: 'schedule', label: 'Publication date', done: !!post?.published || isScheduled, icon: CalendarIcon, go: () => { if (!post?.published) setSchedOpen(true); } },
    { key: 'leg-c', label: 'Company LinkedIn post', done: legDone('linkedin-company'), icon: LinkedIn, go: () => setStep('social'), tag: 'C' },
    { key: 'leg-p', label: 'Personal LinkedIn post', done: legDone('linkedin-personal'), icon: LinkedIn, go: () => setStep('social'), tag: 'P' },
    ...(pkg ? [{
      key: 'review', label: 'Claims review',
      done: openClaims === 0 && ['ready', 'scheduled', 'published', 'complete'].includes(pkg.status),
      // The claims/quality review lives in the package editor — hand off
      // cleanly instead of stacking popup on popup.
      icon: Check, go: () => { onClose(); onOpenReview(pkg.id); },
    }] : []),
  ];

  const isDraftEditable = !!post && !post.published && !!post.body;

  return (
    <div className="fixed inset-0 z-50 bg-paper flex flex-col">
      {/* header — title, step pills, Schedule (opens the popup), the attention strip */}
      <div className="shrink-0 border-b border-line bg-paper/95 backdrop-blur px-3 sm:px-5 py-2 space-y-1.5">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-sm font-medium text-ink truncate min-w-0 flex-1">{row.title}</span>
          {flash && <span className="mono text-[10px] uppercase text-emerald-600 shrink-0">{flash}</span>}
          {!post?.published && (
            <button
              onClick={() => setSchedOpen(true)}
              title="Pick when this publishes to the public site"
              className="h-8 px-3 sm:px-4 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition shrink-0"
            >
              {isScheduled ? 'Reschedule' : 'Schedule'}
            </button>
          )}
          <button onClick={onClose} aria-label="Close editor" className="h-8 w-8 grid place-items-center rounded-sm text-mute hover:text-ink transition shrink-0">
            <X size={17} />
          </button>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 -mx-1 px-1">
          {aspects.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.key}
                title={`${a.label} — ${a.done ? 'done' : 'needs attention'}`}
                aria-label={`${a.label} — ${a.done ? 'done' : 'needs attention'}`}
                onClick={a.go}
                className={'h-7 w-8 rounded-sm grid place-items-center shrink-0 transition relative ' +
                  (a.done ? 'text-blue-600 dark:text-blue-400 hover:bg-card' : 'text-mute/50 hover:text-mute hover:bg-card')}
              >
                <Icon size={14} />
                {a.tag && <span className="absolute bottom-0 right-0.5 mono text-[7px] font-bold">{a.tag}</span>}
              </button>
            );
          })}
        </div>
        {err && <div className="text-xs text-rose-600">{err}</div>}
      </div>

      {/* the two pages. The article page stays MOUNTED (css-hidden on the social
          step) so the contentEditable keeps its edits — a remount would re-init
          from the stale row prop and appear to lose text. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={'max-w-4xl mx-auto sm:px-4 pb-24 ' + (step === 'article' ? '' : 'hidden')}>
          {!post && (chainStage || chainErr) ? (
            // ── the Draft-a-Take progress screen — what's happening, and that
            //    it's fine for it to take a bit. Morphs into the editor when
            //    the article lands.
            <div className="px-4 sm:px-2 pt-10 max-w-md mx-auto space-y-6">
              <div className="text-center space-y-1">
                <div className="text-base font-semibold text-ink">Drafting this publication</div>
                <p className="text-[12px] text-mute leading-relaxed">
                  Three passes, each building on the last. You'll land in the editor the moment the draft is ready.
                </p>
              </div>
              <div className="space-y-3">
                {CHAIN_STAGES.map((s, i) => {
                  const currentIdx = CHAIN_STAGES.findIndex((c) => c.key === chainStage);
                  const state = chainErr && i === (currentIdx === -1 ? 0 : currentIdx)
                    ? 'error'
                    : currentIdx === -1 || i < currentIdx ? 'done'
                    : i === currentIdx ? 'current'
                    : 'pending';
                  return (
                    <div key={s.key} className={'flex items-start gap-3 ' + (state === 'pending' ? 'opacity-45' : '')}>
                      <span className={'h-7 w-7 rounded-full grid place-items-center shrink-0 mt-0.5 ' +
                        (state === 'done' ? 'bg-blue-600 text-white'
                          : state === 'current' ? 'hairline bg-card text-ink'
                          : state === 'error' ? 'bg-rose-100 text-rose-700'
                          : 'hairline bg-card text-mute')}>
                        {state === 'done' ? <Check size={13} />
                          : state === 'current' ? <Refresh size={13} className="animate-spin" />
                          : state === 'error' ? <X size={13} />
                          : <span className="mono text-[10px]">{i + 1}</span>}
                      </span>
                      <div className="min-w-0">
                        <div className={'text-[13px] font-medium ' + (state === 'error' ? 'text-rose-700' : 'text-ink')}>{s.title}</div>
                        <div className="text-[11px] text-mute leading-relaxed">{s.sub}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {chainErr ? (
                <div className="text-center space-y-2">
                  <div className="text-xs text-rose-600">{chainErr}</div>
                  <button
                    onClick={retryChain}
                    className="h-9 px-4 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition"
                  >
                    Retry — resumes where it stopped
                  </button>
                </div>
              ) : (
                <p className="text-center text-[11px] text-mute">Leaving this popup won't lose progress — each finished step is saved.</p>
              )}
            </div>
          ) : isDraftEditable ? (
            <InlineBodyEditor post={post!} flow />
          ) : post?.published ? (
            // Published: the full-screen view is the numbers + the live page.
            <div className="px-4 sm:px-2 pt-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
                <KV k="views" v={post.views} />
                <KV k="unique" v={post.unique_visitors} />
                <KV k="avg scroll" v={post.avg_scroll > 0 ? `${Math.round(post.avg_scroll)}%` : '—'} />
                <KV k="cta clicks" v={post.cta_clicks} />
                <KV k="published" v={fmtDate(post.published_at)} />
                <KV k="last view" v={post.last_view ? new Date(post.last_view).toLocaleString() : '—'} />
                <KV k="updated" v={new Date(post.updated_at).toLocaleString()} />
                <KV k="word count" v={post.body ? post.body.trim().split(/\s+/).filter(Boolean).length : '—'} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute truncate">{PROD_URL ? `${PROD_URL}/blog/${slug}`.replace(/^https?:\/\//, '') : 'no public site connected'}</span>
                {PROD_URL && <a href={`${PROD_URL}/blog/${slug}`} target="_blank" rel="noopener noreferrer" className="mono text-[10px] uppercase tracking-[0.2em] text-mute hover:text-ink transition shrink-0">open live ↗</a>}
              </div>
              {PROD_URL ? (
                <SitePreview src={`${PROD_URL}/blog/${slug}`} title={post.title} className="w-full h-[560px] hairline rounded-sm bg-paper" />
              ) : (
                <div className="hairline rounded-sm bg-card p-6 mono text-[10px] uppercase tracking-[0.18em] text-mute text-center">
                  No public site connected. Configure the site origin to preview the live page here.
                </div>
              )}
            </div>
          ) : (
            <div className="p-6 text-sm text-mute">Nothing to edit — the article body is missing.</div>
          )}

          {/* slim schedule summary — the popup does the picking. Hidden while
              the drafting chain runs (the progress screen owns the view). */}
          {post && !post.published && (
            <div className="mx-4 sm:mx-2 mt-4 hairline rounded-sm bg-card/60 p-3 flex items-center gap-3 flex-wrap">
              <CalendarIcon size={14} className="text-mute shrink-0" />
              <div className="flex-1 min-w-0 text-[11px] text-mute leading-relaxed">
                {isScheduled && pkg?.scheduled_at
                  ? <>Publishes <span className="text-ink font-medium">{fmtWhen(pkg.scheduled_at)}</span> — the hourly scheduler pushes it live, then the social posts follow their offsets.</>
                  : 'Not scheduled yet — pick when this goes live on the public site.'}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setSchedOpen(true)}
                  className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] bg-ink text-paper hover:opacity-90 transition"
                >
                  {isScheduled ? 'Reschedule' : 'Schedule'}
                </button>
                {isScheduled && (
                  <button
                    onClick={cancelSchedule}
                    disabled={!!busy}
                    title="Back to Needs Review — nothing publishes"
                    className="h-8 px-2.5 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
                  >
                    {busy === 'cancel' ? '…' : 'Cancel'}
                  </button>
                )}
                <button
                  onClick={publishNow}
                  disabled={!!busy}
                  title="Skip the schedule and go live immediately"
                  className="h-8 px-2.5 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-mute hover:text-ink transition disabled:opacity-50"
                >
                  {busy === 'pub' ? 'publishing…' : 'publish now'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* the social page — where scheduling reroutes to */}
        {step === 'social' && (
          <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-24 pt-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute">social posts · this publication</div>
              <button
                onClick={draftSocial}
                disabled={!!busy || drafting}
                className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] border border-line text-mute hover:text-ink transition disabled:opacity-50"
              >
                {busy === 'social' ? 'drafting…' : legs.length ? 'redraft posts' : 'draft social posts'}
              </button>
            </div>

            {drafting ? (
              <div className="hairline rounded-sm bg-card/60 p-8 grid place-items-center text-center space-y-2">
                <Refresh size={18} className="animate-spin text-mute" />
                <div className="text-sm text-ink font-medium">Drafting social posts…</div>
                <div className="text-[11px] text-mute">Writing the company and personal LinkedIn legs from the article.</div>
              </div>
            ) : legs.length === 0 ? (
              <p className="text-[11px] text-mute leading-relaxed px-1">
                No social posts yet — draft the company + personal LinkedIn legs from this article.
              </p>
            ) : (
              <div className="space-y-3">
                {!base && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Schedule the publication to control how long after it each post goes out.
                  </p>
                )}
                {legs.map((leg) => (
                  <LegCard
                    key={`${leg.id}:${redraftTick}`}
                    leg={leg} base={base}
                    identity={identities?.[leg.channel] || null}
                    articleTitle={row.title}
                    onPatched={onLegPatched}
                    onRedrafted={async () => { if (pkg) await reloadPkg(pkg.id); setRedraftTick((t) => t + 1); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* the schedule popup — the ONE picker for this publication */}
      {schedOpen && (
        <SchedulePickerModal
          initial={pkg?.scheduled_at || null}
          busy={busy === 'sched'}
          onConfirm={schedule}
          onCancel={() => setSchedOpen(false)}
          label={isScheduled ? 'Reschedule' : 'Schedule'}
        />
      )}

      {/* all posts approved → offer the way out */}
      {donePopup && (
        <div className="fixed inset-0 z-[70] bg-black/30 grid place-items-center p-4" onClick={() => setDonePopup(false)}>
          <div className="w-full max-w-sm rounded-sm hairline bg-paper p-4 space-y-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-ink">All posts approved</div>
            <p className="text-[11px] text-mute leading-relaxed">
              Every planned post is approved and will go out at its time. Finished editing this publication?
            </p>
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-sm bg-ink text-paper text-xs font-medium hover:opacity-90 transition">Done</button>
              <button onClick={() => setDonePopup(false)} className="flex-1 h-9 rounded-sm border border-line text-xs text-mute hover:text-ink transition">Keep editing</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── one social leg: offset-after-publication + inline text ──────────────────
// "How long after the publication is live should this post go out" — presets
// plus a custom minutes field. The stored truth stays an absolute scheduled_at;
// the offset is derived against the package's website date, and rescheduling
// the website preserves it (scheduleRelease carries offsets across).
const OFFSET_PRESETS: { label: string; min: number }[] = [
  { label: 'with publication', min: 0 },
  { label: '3 min after', min: 3 },
  { label: '15 min after', min: 15 },
  { label: '45 min after', min: 45 },
  { label: '1 h after', min: 60 },
  { label: '2 h after', min: 120 },
  { label: '4 h after', min: 240 },
  { label: '1 day after', min: 1440 },
  { label: '2 days after', min: 2880 },
];

// One social post on the editor's Social page — a SELF-CONTAINED unit:
// the control bar on top (timing · Skip Post · Redraft · Approve as the main
// CTA, with an explicit saving/saved indicator), the LinkedIn-native preview
// under it showing the WHOLE post (the textarea auto-grows — no inner
// scrolling), the notes field, and nothing else. A post only ever fires while
// APPROVED (status 'scheduled' — the one state the due-scan sends).
// Top-level ON PURPOSE: holds textareas — defined inside EditorModal it would
// remount on every parent render and drop focus after one keystroke.
function LegCard({ leg, base, identity, articleTitle, onPatched, onRedrafted }: {
  leg: HotTakePost;
  base: number | null;
  identity: SocialIdentity | null;
  articleTitle: string;
  onPatched: (p: HotTakePost) => void;
  onRedrafted: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [len, setLen] = useState((leg.body || '').length);
  const bodyTimer = useRef<number | null>(null);
  const notesTimer = useRef<number | null>(null);
  const offTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const curMin = base && leg.scheduled_at ? Math.round((leg.scheduled_at - base) / 60000) : null;
  const preset = curMin !== null ? OFFSET_PRESETS.find((p) => p.min === curMin) : undefined;
  const selValue = custom ? 'custom' : preset ? String(preset.min) : curMin !== null ? 'custom' : '';
  const planned = leg.status !== 'not_planned' && leg.status !== 'skipped';
  const posted = leg.status === 'posted';
  const approved = leg.status === 'scheduled';
  const savingState = busy === 'save' || busy === 'notes' ? 'saving…' : saved ? 'saved' : null;

  const isCompany = leg.channel === 'linkedin-company';
  const posterName = identity?.name || (isCompany ? 'Company page' : 'Personal profile');
  const initials = posterName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  // The whole post, no scrolling: the textarea grows to fit its content.
  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  useEffect(() => { autoGrow(); }, []);

  async function patch(tag: string, patchBody: Partial<HotTakePost>) {
    setBusy(tag); setErrMsg(null);
    try {
      const updated = await api.hotTakePatchPost(leg.id, patchBody);
      onPatched(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(null);
    }
  }
  // Timing is NOT approval — the offset only books when the post would go,
  // the Approve button decides whether it goes at all.
  function setOffset(min: number) {
    if (!base) return;
    void patch('sched', { scheduled_at: base + min * 60000 });
  }
  function onBodyInput(v: string) {
    autoGrow();
    setLen(v.length);
    if (bodyTimer.current) window.clearTimeout(bodyTimer.current);
    bodyTimer.current = window.setTimeout(() => { void patch('save', { body: v }); }, 800);
  }
  function onNotesInput(v: string) {
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => { void patch('notes', { notes: v }); }, 800);
  }
  function onCustomOffset(v: string) {
    if (offTimer.current) window.clearTimeout(offTimer.current);
    offTimer.current = window.setTimeout(() => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) setOffset(n);
    }, 600);
  }
  async function redraft() {
    if (!window.confirm('Redraft this post? The current text is replaced with a fresh draft.')) return;
    setBusy('redraft'); setErrMsg(null);
    try {
      const r = await api.hotTakeDraftSocial(leg.package_id, leg.channel as 'linkedin-company' | 'linkedin-personal');
      if (r.error) { setErrMsg(r.error); return; }
      onRedrafted();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'redraft failed');
    } finally {
      setBusy(null);
    }
  }

  const ctl = 'h-8 px-2.5 rounded-sm mono text-[10px] uppercase tracking-[0.14em] border border-line text-mute hover:text-ink transition disabled:opacity-50';

  return (
    <div className={'space-y-2 ' + (planned ? '' : 'opacity-60')}>
      {/* the unit's control bar — timing, skip, redraft, and Approve as THE CTA */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute shrink-0">{CHANNEL_LABEL[leg.channel] || leg.channel}</span>
        <select
          value={selValue}
          disabled={!base || !!busy || !planned || posted}
          title={base ? 'How long after the publication goes live this post goes out' : 'Schedule the publication first'}
          onChange={(e) => {
            if (e.target.value === 'custom') { setCustom(true); return; }
            setCustom(false);
            setOffset(Number(e.target.value));
          }}
          className="h-8 px-2 rounded-sm bg-paper border border-line text-xs text-ink focus:outline-none disabled:opacity-50"
        >
          <option value="" disabled>timing…</option>
          {OFFSET_PRESETS.map((p) => <option key={p.min} value={String(p.min)}>{p.label}</option>)}
          <option value="custom">custom…</option>
        </select>
        {(custom || (curMin !== null && !preset)) && (
          <span className="flex items-center gap-1">
            <input
              type="number" min={0} step={5}
              defaultValue={curMin ?? 60}
              disabled={!base || !!busy || !planned || posted}
              onChange={(e) => onCustomOffset(e.target.value)}
              className="w-20 h-8 px-2 rounded-sm bg-paper border border-line text-xs text-ink mono tabular-nums focus:outline-none disabled:opacity-50"
            />
            <span className="mono text-[9px] uppercase text-mute">min</span>
          </span>
        )}
        {!posted && (
          planned ? (
            <button onClick={() => void patch('plan', { status: 'not_planned' })} disabled={!!busy} className={ctl} title="Skip this post — the release completes without it">
              Skip Post
            </button>
          ) : (
            <button onClick={() => void patch('plan', { status: 'draft' })} disabled={!!busy} className={ctl} title="Bring this post back into the release">
              Restore
            </button>
          )
        )}
        {!posted && planned && (
          <button onClick={redraft} disabled={!!busy} className={ctl} title="Replace the text with a fresh draft (same fine-tuned instructions)">
            {busy === 'redraft' ? 'Redrafting…' : 'Redraft'}
          </button>
        )}
        {savingState && <span className={'mono text-[9px] uppercase ' + (savingState === 'saved' ? 'text-emerald-600' : 'text-mute')}>{savingState}</span>}
        <span className="mono text-[9px] text-mute">{len} chars</span>
        <span className="ml-auto shrink-0">
          {posted ? (
            <span className="mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm bg-emerald-100 text-emerald-800">posted</span>
          ) : planned ? (
            approved ? (
              <button
                onClick={() => void patch('hold', { status: 'ready' })}
                disabled={!!busy}
                title="Approved — goes out at its time. Click to hold it back."
                className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.14em] bg-emerald-600 text-white hover:opacity-90 transition disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Check size={12} /> Approved
              </button>
            ) : (
              <button
                onClick={() => void patch('approve', { status: 'scheduled' })}
                disabled={!!busy || len === 0 || !leg.scheduled_at}
                title={len === 0 ? 'Write the post first' : !leg.scheduled_at ? 'Schedule the publication first — the post needs its time' : 'Approve — this post goes out at its time'}
                className="h-8 px-4 rounded-sm mono text-[10px] uppercase tracking-[0.14em] bg-ink text-paper hover:opacity-90 transition disabled:opacity-50"
              >
                Approve
              </button>
            )
          ) : null}
        </span>
      </div>

      {/* the post, as LinkedIn will show it — whole, no scrolling */}
      <div className="rounded-md hairline bg-paper overflow-hidden shadow-sm">
        <div className="flex items-start gap-2.5 px-3.5 pt-3">
          {identity?.avatar_url ? (
            <img
              src={identity.avatar_url} alt=""
              className={'h-11 w-11 object-cover shrink-0 ' + (isCompany ? 'rounded-md' : 'rounded-full')}
            />
          ) : (
            <div className={'h-11 w-11 grid place-items-center bg-ink text-paper text-sm font-semibold shrink-0 ' + (isCompany ? 'rounded-md' : 'rounded-full')}>
              {initials || 'N'}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink leading-tight truncate">{posterName}</div>
            {identity?.headline && <div className="text-[11px] text-mute leading-tight truncate">{identity.headline}</div>}
            <div className="text-[11px] text-mute leading-tight mt-0.5">
              {posted && leg.posted_at
                ? `Posted ${timeAgo(leg.posted_at)} · 🌐`
                : base && leg.scheduled_at
                  ? `Scheduled · ${fmtWhen(leg.scheduled_at)} · 🌐`
                  : 'Not timed yet · 🌐'}
            </div>
          </div>
          <LinkedIn size={15} className="text-mute/70 shrink-0" />
        </div>
        <textarea
          ref={taRef}
          dir="auto"
          defaultValue={leg.body || ''}
          onChange={(e) => onBodyInput(e.target.value)}
          disabled={!planned || posted}
          placeholder="The post text, exactly as it will appear — edits save automatically."
          rows={3}
          className="w-full bg-transparent border-0 px-3.5 py-2.5 text-[13px] text-ink leading-relaxed placeholder:text-mute/50 focus:outline-none resize-none overflow-hidden disabled:opacity-60"
        />
        {/* the link card the post carries. Text only: this build ships no images. */}
        <div className="border-t border-line">
          <div className="px-3.5 py-2 bg-card/60">
            <div className="text-[12px] font-medium text-ink truncate">{articleTitle}</div>
            <div className="text-[10px] text-mute">{PUBLIC_SITE_HOST || 'your public site'}</div>
          </div>
        </div>
      </div>

      <input
        defaultValue={leg.notes || ''}
        onChange={(e) => onNotesInput(e.target.value)}
        disabled={!planned || posted}
        placeholder={isCompany ? 'Company notes (kept separate from the post)' : 'Author notes (kept separate from the post)'}
        className="w-full h-8 px-3 rounded-sm bg-paper border border-line text-xs text-mute focus:outline-none focus:border-ink/40 disabled:opacity-60"
      />

      {leg.error && <div className="text-[10px] text-rose-600 truncate" title={leg.error}>{leg.error}</div>}
      {errMsg && <div className="text-xs text-rose-600">{errMsg}</div>}
    </div>
  );
}
