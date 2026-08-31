// Editorial plugin — the Blog surface. Moved from the host's pages/Blog.tsx;
// same page, but the data layer now drives the pack's own tools through the
// scoped invoke route (./blog-data) instead of the removed /api/blog/* REST
// routes. Shared article UI (thumbnail, tags, meta rows, in-place editor)
// lives in the flat sibling ./ArticleBits — one implementation for this page
// and the Hot Takes Publications tab, no forks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, PUBLIC_SITE_URL, type BlogPostWithTags } from './blog-data';
import { SitePreview, PreviewModePill } from './SitePreview';
import { useChatState, openChat, navigateTo } from '../../lib/chat';
import { LinkedIn, Trash } from '../../components/Icons';
import { devUrl, fmtDate, timeAgo, fmtNum, Thumb, TagList, KV, ColHeader, InlineBodyEditor } from './ArticleBits';
import { useModulePrereqs } from '../../lib/module-status';
import { ModuleSetupGate } from '../../components/ModuleSetupGate';
import { DegradedNotice, ModuleStatusHold } from '../../components/DegradedNotice';

// Preview target: the operator's live public site. No origin is hardcoded
// here; it comes from blog-data.ts and stays empty until configured, in which
// case the preview surfaces below show their "no public site connected"
// state. Both preview states point at the same live site.
const STAGING_URL    = PUBLIC_SITE_URL;
const PROD_URL       = PUBLIC_SITE_URL;
const PREVIEW_MODE_KEY = 'nyyon.preview.mode.v1';
type PreviewMode = 'staging' | 'live';
function loadPreviewMode(): PreviewMode {
  try { return (localStorage.getItem(PREVIEW_MODE_KEY) as PreviewMode) || 'staging'; } catch { return 'staging'; }
}
function savePreviewMode(m: PreviewMode) { try { localStorage.setItem(PREVIEW_MODE_KEY, m); } catch { /* quota */ } }

type SortKey = 'views' | 'unique_visitors' | 'avg_scroll' | 'last_view' | 'published_at' | 'title';
type SortDir = 'asc' | 'desc';

const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
// Blog has two jobs: review new drafts, and track published-post performance.
//   review    → unpublished drafts Nyo wrote (has a body), newest first, with an Approve action
//   published → the analytics leaderboard (live posts)
//   all       → everything, incl. the empty seed stubs
type View = 'review' | 'published' | 'all';

export default function Blog() {
  const [posts, setPosts]             = useState<BlogPostWithTags[] | null>(null);
  const [view, setView]               = useState<View>('review');
  const [approvingSlug, setApproving] = useState<string | null>(null);
  const [deletingSlug, setDeleting]   = useState<string | null>(null);
  const [liveBanner, setLiveBanner]   = useState<{ kind: 'pending' | 'ok'; text: string } | null>(null);
  const approvePoll = useRef<number | null>(null);
  useEffect(() => () => { if (approvePoll.current) window.clearInterval(approvePoll.current); }, []);
  const [search, setSearch]           = useState('');
  // Default to newest-published first — after publishing a post you expect to
  // see it at the top, not sorted to the bottom of a views leaderboard (a fresh
  // post has ~0 views, which buried it several pages deep). Click the views
  // header to switch to the analytics leaderboard.
  const [sortKey, setSortKey]         = useState<SortKey>('published_at');
  const [sortDir, setSortDir]         = useState<SortDir>('desc');
  const [pageSize, setPageSize]       = useState<PageSize>(20);
  const [page, setPage]               = useState(0);
  const [openSlug, setOpenSlug]       = useState<string | null>(null);

  // What Blog needs of its own. The writer is the whole module, and a writer
  // with nobody's voice writes like nobody: that is the prerequisite. Reading,
  // editing, analytics and publishing are unaffected by it — so a skipped gate
  // leaves a working module that simply says whose voice it is using.
  const prereqs = useModulePrereqs('blog');
  const voiceIsDefault = prereqs.needsVoice;
  // Blocking and optional are different facts: without the BRAND voice the
  // writer refuses to draft; without the personal one those articles simply
  // fall back. Saying "defaults" for both would overstate one and understate
  // the other.
  const voiceBlocking = (prereqs.status?.missing ?? []).some((p) => p.kind === 'voice');
  // The static-site rebuild. Blog posts are served from D1 by the blog-edge
  // worker, so this only matters where the install actually wires a deploy
  // sidecar — when it is listed unmet, publishing genuinely cannot land.
  const publishOff = prereqs.needsGateway('deploy');
  const publishOffWhy = prereqs.gapFor('deploy')?.why
    || 'Publishing to the live site is not connected on this install.';

  async function refresh() {
    // Fetch everything (incl. drafts) once; the three views are split client-side.
    try { setPosts(await api.listBlogAnalytics(false)); }
    catch { setPosts([]); }
  }
  useEffect(() => {
    setPosts(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drafts pending approval = unpublished posts that actually have a body.
  // (The ~186 empty seed stubs are unpublished too but are NOT review items.)
  const reviewPosts    = useMemo(() => (posts || []).filter((p) => !p.published && !!p.body && p.body.trim().length > 0), [posts]);
  const publishedPosts = useMemo(() => (posts || []).filter((p) => !!p.published), [posts]);

  // Approve = publish to the public site (mirror to prod D1 + rebuild). One click,
  // reusing the same publish path the detail panel uses.
  async function approve(slug: string) {
    if (publishOff) return;   // the button is already off; this is the belt
    const p = (posts || []).find((x) => x.slug === slug);
    const title = p?.title || slug;
    if (!confirm(`Approve and publish "${title}"?\n\nThis publishes the post to the live site and triggers a rebuild.`)) return;
    setApproving(slug);
    if (approvePoll.current) { window.clearInterval(approvePoll.current); approvePoll.current = null; }
    try {
      const r = await api.publishBlogPost(slug);
      await refresh();
      // Posts go live via the blog-edge worker straight from D1 — no rebuild,
      // no sidecar. The backend already verified the edge actually serves it,
      // so r.ok/r.live IS "live on the public site". Trust that, not a sidecar.
      if (r.ok || r.live) {
        setLiveBanner({ kind: 'ok', text: `✓ "${title}" is live on the public site` });
        return;
      }
      // Not live yet (edge cache lag or a mirror error). Poll briefly, then say so.
      setLiveBanner({ kind: 'pending', text: `Publishing "${title}" — confirming it's live…` });
      let tries = 0;
      approvePoll.current = window.setInterval(async () => {
        tries++;
        try {
          const s = await api.blogLiveStatus(slug);
          if (s.live) {
            setLiveBanner({ kind: 'ok', text: `✓ "${title}" is live on the public site` });
            if (approvePoll.current) { window.clearInterval(approvePoll.current); approvePoll.current = null; }
            return;
          }
        } catch { /* keep polling */ }
        if (tries >= 30) { // ~6 min ceiling
          if (approvePoll.current) { window.clearInterval(approvePoll.current); approvePoll.current = null; }
          setLiveBanner({ kind: 'pending', text: `"${title}" deploy queued; still building — check the live site in a minute.` });
        }
      }, 12000);
    }
    catch (e: any) { alert('Publish failed: ' + String(e?.message || e)); }
    finally { setApproving(null); }
  }

  // Delete a post from local D1. For a published post this removes the draft
  // record here; it does NOT take it down from the public site (do that at the source).
  async function remove(slug: string) {
    const p = (posts || []).find((x) => x.slug === slug);
    const title = p?.title || slug;
    const live = !!p?.published;
    if (!confirm(`Delete "${title}"?\n\nThis removes the post from the Command Center${live ? '. It does NOT unpublish it from the public site — take the live post down separately.' : '.'}\n\nThis can't be undone.`)) return;
    setDeleting(slug);
    try { await api.deleteBlogPost(slug); if (openSlug === slug) setOpenSlug(null); await refresh(); }
    catch (e: any) { alert('Delete failed: ' + String(e?.message || e)); }
    finally { setDeleting(null); }
  }

  // Draft social posts from any article (published or not), then jump to the
  // Social module with Nyo open + briefed to refine them.
  const { setPendingSend } = useChatState();
  const [draftingSlug, setDraftingSlug] = useState<string | null>(null);
  async function draftSocial(post: BlogPostWithTags) {
    if (draftingSlug) return;
    setDraftingSlug(post.slug);
    try {
      const r = await api.generateSocialPosts(post.slug, false);
      // A domain miss (post not found, drafting skipped with 0 rows) comes back
      // ok:false without throwing — don't brief Nyo about drafts that don't exist.
      if (r && (r as { ok?: boolean }).ok === false) {
        alert('Draft social failed: ' + ((r as { reason?: string }).reason || 'drafting returned no posts'));
        return;
      }
      setPendingSend(
        `I just drafted social posts for the blog article "${post.title}" (slug: ${post.slug}). They're in the Social module awaiting approval.\n\nHelp me refine them: call list_social_posts with slug "${post.slug}" to see all three (company LinkedIn, personal LinkedIn, company Facebook), then as I ask for changes call edit_social_post with each post's id and the FULL new text so it updates live. This is shaping, not publishing, I approve them myself.\n\nWhen we're done, fold what you learned about how I want these posts written into the relevant voice doc (personal-voice / brand-voice / editorial-taste) with write_knowledge, read-and-append.\n\nStart by listing the three drafts and giving me a one-line read of each.`,
      );
      navigateTo('social');
      openChat();
    } catch (e: any) {
      alert('Draft social failed: ' + String(e?.message || e));
    } finally {
      setDraftingSlug(null);
    }
  }

  // Reset to page 0 when the view, search, or sort change.
  useEffect(() => { setPage(0); }, [view, search, sortKey, sortDir, pageSize]);

  const filtered = useMemo(() => {
    const base = view === 'review' ? reviewPosts : view === 'published' ? publishedPosts : (posts || []);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      (p.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [posts, reviewPosts, publishedPosts, view, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    // Review = a work queue: newest draft on top, always.
    if (view === 'review') { arr.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)); return arr; }
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (sortKey === 'title') { av = a.title.toLowerCase(); bv = b.title.toLowerCase(); }
      else if (sortKey === 'published_at') { av = a.published_at ?? 0; bv = b.published_at ?? 0; }
      else if (sortKey === 'last_view')    { av = a.last_view ?? 0;    bv = b.last_view ?? 0; }
      else if (sortKey === 'avg_scroll')   { av = a.avg_scroll;        bv = b.avg_scroll; }
      else if (sortKey === 'unique_visitors') { av = a.unique_visitors; bv = b.unique_visitors; }
      else                                 { av = a.views;             bv = b.views; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir, view]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage   = Math.min(page, totalPages - 1);
  const pageRows   = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir(k === 'title' ? 'asc' : 'desc');
    }
  }

  const gated = prereqs.phase === 'gate' && !!prereqs.status;

  // The list, its table and its pager — everything the gate stands in front of.
  const content = (
    <>
      {/* Table */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {posts === null && <div className="text-sm text-mute">Loading…</div>}
        {posts !== null && sorted.length === 0 && (
          <div className="text-sm text-mute">
            {view === 'review' ? 'Nothing to review — no drafts waiting. New posts Nyo writes land here.' : 'No posts match these filters.'}
          </div>
        )}
        {posts !== null && sorted.length > 0 && (
          <div className="overflow-x-auto">
          <ul className="hairline rounded-sm bg-card/80 divide-y divide-line min-w-[760px]">
            {view === 'review' ? (
              <li className="px-4 py-2 grid grid-cols-12 gap-3 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
                <span className="col-span-6">draft</span>
                <span className="col-span-2">written</span>
                <span className="col-span-2">tags</span>
                <span className="col-span-2 text-right">action</span>
              </li>
            ) : (
              <li className="px-4 py-2 grid grid-cols-12 gap-3 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
                <ColHeader k="title"            label="title"      sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-4" />
                <ColHeader k="published_at"     label="published"  sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1" />
                <span className="col-span-2">tags</span>
                <ColHeader k="views"            label="views"      sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                <ColHeader k="unique_visitors"  label="unique"     sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                <ColHeader k="avg_scroll"       label="scroll %"   sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-1 text-right" />
                <ColHeader k="last_view"        label="last view"  sortKey={sortKey} dir={sortDir} onClick={toggleSort} className="col-span-2 text-right" />
              </li>
            )}

            {pageRows.map((p) => (
              <BlogRow
                key={p.slug}
                post={p}
                review={view === 'review'}
                approving={approvingSlug === p.slug}
                onApprove={approve}
                publishOff={publishOff}
                publishOffWhy={publishOffWhy}
                onDelete={remove}
                deleting={deletingSlug === p.slug}
                onDraftSocial={draftSocial}
                drafting={draftingSlug === p.slug}
                open={openSlug === p.slug}
                onOpen={() => setOpenSlug(openSlug === p.slug ? null : p.slug)}
                onRegenerated={refresh}
              />
            ))}
          </ul>
          </div>
        )}
      </div>

      {/* Pagination footer */}
      {posts !== null && sorted.length > 0 && (
        <footer className="px-4 sm:px-6 py-3 border-t border-line bg-paper/60 shrink-0 flex items-center justify-between mono text-[10px] uppercase tracking-[0.18em] text-mute">
          <span>
            page {safePage + 1} / {totalPages} · showing {pageRows.length} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <PagerBtn disabled={safePage === 0}                onClick={() => setPage(0)}>« first</PagerBtn>
            <PagerBtn disabled={safePage === 0}                onClick={() => setPage(safePage - 1)}>‹ prev</PagerBtn>
            <PagerBtn disabled={safePage >= totalPages - 1}    onClick={() => setPage(safePage + 1)}>next ›</PagerBtn>
            <PagerBtn disabled={safePage >= totalPages - 1}    onClick={() => setPage(totalPages - 1)}>last »</PagerBtn>
          </div>
        </footer>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col">
      {/* "Going live" banner — after approve, tracks the rebuild until the post
          is actually served on the public site, then confirms it's live. */}
      {liveBanner && (
        <div className={'px-6 py-2 shrink-0 flex items-center justify-between gap-3 text-[12px] border-b border-line ' + (liveBanner.kind === 'ok' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300')}>
          <span className="flex items-center gap-2">
            {liveBanner.kind === 'pending' && <span className="inline-block h-2 w-2 rounded-full bg-current animate-pulse" />}
            {liveBanner.text}
          </span>
          <button onClick={() => setLiveBanner(null)} className="mono text-[10px] uppercase tracking-[0.18em] opacity-70 hover:opacity-100 transition">dismiss</button>
        </div>
      )}
      {/* Header + filters */}
      <header className="px-4 sm:px-6 py-4 border-b border-line bg-paper/60 shrink-0 space-y-3">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Blog</h1>
            <p className="text-xs text-mute mt-0.5">
              {posts === null
                ? 'loading…'
                : view === 'review'
                  ? `${sorted.length} draft${sorted.length === 1 ? '' : 's'} awaiting your approval${search ? ` matching "${search}"` : ''}`
                  : `${sorted.length} post${sorted.length === 1 ? '' : 's'}${search ? ` matching "${search}"` : ''} · all-time analytics`}
            </p>
          </div>
        </div>

        {!gated && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* View tabs — Nyo's drafts land in "Needs review" until you approve them. */}
            <div className="inline-flex rounded-sm hairline overflow-hidden shrink-0">
              <ViewTab active={view === 'review'} onClick={() => setView('review')}>
                Needs review{reviewPosts.length ? ` · ${reviewPosts.length}` : ''}
              </ViewTab>
              <ViewTab active={view === 'published'} onClick={() => setView('published')}>Published</ViewTab>
              <ViewTab active={view === 'all'} onClick={() => setView('all')}>All</ViewTab>
            </div>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, slug, tag…"
              className="h-9 px-3 rounded-sm hairline bg-card text-sm placeholder:text-mute/70 focus:border-ink focus:outline-none transition w-64"
            />

            <div className="ml-auto flex items-center gap-2">
              <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">per page</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(parseInt(e.target.value, 10) as PageSize)}
                className="h-9 px-2 rounded-sm hairline bg-card text-sm focus:border-ink focus:outline-none transition mono uppercase tracking-[0.04em] text-ink"
              >
                {PAGE_SIZES.map((n) => (<option key={n} value={n}>{n}</option>))}
              </select>
            </div>
          </div>
        )}

        {/* Whose voice is writing these drafts. Said once, plainly, where the
            drafts are — not hidden in a settings page. */}
        {!gated && (voiceIsDefault || publishOff) && (
          <DegradedNotice
            note={
              voiceBlocking
                ? <>Reading, editing, analytics and publishing all work. <strong className="font-semibold">New drafts do not</strong> — the writer needs your brand voice document and refuses to draft on the shipped placeholder.</>
                : voiceIsDefault && publishOff
                  ? <>Drafting, editing and analytics all work, on <strong className="font-semibold">shipped defaults</strong> rather than all of your own voice. Publishing to the live site is off.</>
                  : voiceIsDefault
                    ? <>Everything here works. Part of the writer is still running on <strong className="font-semibold">shipped defaults</strong> — articles that ask for a voice you have not written yet fall back to the stock one.</>
                    : <>Writing, editing and analytics all work. <strong className="font-semibold">Publishing is off</strong> — approved drafts stay here instead of going live.</>
            }
            items={prereqs.unmet.filter((p) => p.kind === 'voice' || p.kind === 'gateway')}
            onSetUp={prereqs.openSetup}
            actionLabel={voiceIsDefault ? 'teach it my voice' : 'connect'}
          />
        )}
      </header>

      {prereqs.phase === 'loading' ? <ModuleStatusHold /> : gated && prereqs.status ? (
        <ModuleSetupGate
          status={prereqs.status}
          slug="blog"
          onDone={prereqs.done}
          onSkip={prereqs.skip}
        >
          {content}
        </ModuleSetupGate>
      ) : content}
    </div>
  );
}

function PagerBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={
        'h-7 px-2 rounded-sm hairline bg-card transition ' +
        (disabled ? 'opacity-30 cursor-not-allowed' : 'hover:text-ink hover:border-ink')
      }
    >
      {children}
    </button>
  );
}

function BlogRow({
  post, review, approving, onApprove, publishOff, publishOffWhy, onDelete, deleting, onDraftSocial, drafting, open, onOpen, onRegenerated,
}: {
  post: BlogPostWithTags;
  review: boolean;
  approving: boolean;
  onApprove: (slug: string) => void;
  publishOff: boolean;
  publishOffWhy: string;
  onDelete: (slug: string) => void;
  deleting: boolean;
  onDraftSocial: (post: BlogPostWithTags) => void;
  drafting: boolean;
  open: boolean;
  onOpen: () => void;
  onRegenerated: () => void;
}) {
  const isStub = !post.published && !post.body;
  // Delete action (trash) shown on every collapsed row.
  const deleteBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); onDelete(post.slug); }}
      disabled={deleting}
      title="Delete this post from the Command Center"
      className={'h-8 w-8 grid place-items-center rounded-sm border border-line text-mute transition shrink-0 ' + (deleting ? 'cursor-wait opacity-60' : 'hover:text-rose-600 hover:border-rose-400/60')}
    >
      {deleting ? <span className="mono text-[10px]">…</span> : <Trash size={14} />}
    </button>
  );
  // Compact "draft social posts" action shown on the collapsed row.
  const socialBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); onDraftSocial(post); }}
      disabled={drafting}
      title="Draft social posts from this article, then refine with Nyo"
      className={'h-8 w-8 grid place-items-center rounded-sm border border-line text-mute transition shrink-0 ' + (drafting ? 'cursor-wait opacity-60' : 'hover:text-ink hover:border-ink/40')}
    >
      {drafting ? <span className="mono text-[10px]">…</span> : <LinkedIn size={14} />}
    </button>
  );

  if (review) {
    return (
      <li>
        <div onClick={onOpen} className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-[13px] hover:bg-card transition cursor-pointer">
          <div className="col-span-6 min-w-0 flex items-center gap-3">
            <Thumb post={post} />
            <div className="min-w-0">
              <div className="font-medium text-ink truncate flex items-center gap-2">
                {post.title}
                <span className="mono text-[9px] uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded-sm">draft</span>
              </div>
              <div className="mono text-[10px] text-mute truncate">/blog/{post.slug}</div>
            </div>
          </div>
          <span className="col-span-2 mono text-[10px] text-mute">{timeAgo(post.updated_at)}</span>
          <span className="col-span-2 flex flex-wrap gap-1"><TagList tags={post.tags} /></span>
          <div className="col-span-2 flex justify-end items-center gap-2">
            {deleteBtn}
            {socialBtn}
            <button
              onClick={(e) => { e.stopPropagation(); onApprove(post.slug); }}
              disabled={approving || publishOff}
              className={
                'h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.16em] transition ' +
                (publishOff ? 'hairline bg-card text-mute opacity-60 cursor-not-allowed'
                  : approving ? 'bg-card text-mute cursor-wait hairline' : 'bg-ink text-paper hover:opacity-90')
              }
              title={publishOff ? `${publishOffWhy} The draft stays here, edited and ready.` : 'Publish this draft to the public site'}
            >
              {publishOff ? 'publishing off' : approving ? 'publishing…' : 'Approve → publish'}
            </button>
          </div>
        </div>
        {open && <BlogDetail post={post} onRegenerated={onRegenerated} onDraftSocial={() => onDraftSocial(post)} drafting={drafting} publishOff={publishOff} publishOffWhy={publishOffWhy} />}
      </li>
    );
  }

  return (
    <li>
      <div onClick={onOpen} className="px-4 py-3 grid grid-cols-12 gap-3 items-baseline text-[13px] hover:bg-card transition cursor-pointer">
        <div className="col-span-4 min-w-0 flex items-center gap-3">
          <Thumb post={post} />
          <div className="min-w-0">
            <div className="font-medium text-ink truncate flex items-center gap-2">
              {post.title}
              {isStub && <span className="mono text-[9px] uppercase tracking-[0.2em] text-mute bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded-sm">stub</span>}
              {!post.published && !isStub && <span className="mono text-[9px] uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded-sm">draft</span>}
            </div>
            <div className="mono text-[10px] text-mute truncate">/blog/{post.slug}</div>
          </div>
        </div>
        <span className="col-span-1 mono text-[10px] text-mute">{fmtDate(post.published_at)}</span>
        <span className="col-span-2 flex flex-wrap gap-1"><TagList tags={post.tags} /></span>
        <span className="col-span-1 text-right mono text-[12px] text-ink">{fmtNum(post.views)}</span>
        <span className="col-span-1 text-right mono text-[12px] text-ink">{fmtNum(post.unique_visitors)}</span>
        <span className="col-span-1 text-right mono text-[12px] text-ink">
          {post.avg_scroll > 0 ? `${Math.round(post.avg_scroll)}%` : <span className="text-mute">—</span>}
        </span>
        <span className="col-span-2 flex items-center justify-end gap-2 mono text-[10px] text-mute">
          <span className="truncate">{timeAgo(post.last_view)}</span>
          {socialBtn}
          {deleteBtn}
        </span>
      </div>

      {open && <BlogDetail post={post} onRegenerated={onRegenerated} onDraftSocial={() => onDraftSocial(post)} drafting={drafting} publishOff={publishOff} publishOffWhy={publishOffWhy} />}
    </li>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'h-9 px-3 mono text-[10px] uppercase tracking-[0.16em] transition border-r border-line last:border-r-0 ' +
        (active ? 'bg-ink text-paper' : 'text-mute hover:text-ink bg-card')
      }
    >
      {children}
    </button>
  );
}

function BlogDetail({ post, onRegenerated, onDraftSocial, drafting, publishOff, publishOffWhy }: { post: BlogPostWithTags; onRegenerated: () => void; onDraftSocial: () => void; drafting: boolean; publishOff: boolean; publishOffWhy: string }) {
  const wordCount = post.body ? post.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const [previewMode, setPreviewMode] = useState<PreviewMode>(loadPreviewMode);
  const base = previewMode === 'live' ? PROD_URL : STAGING_URL;
  // An empty base means no public site is configured yet; the preview block
  // below says so instead of rendering a dead iframe.
  const publicUrl = base ? `${base}/blog/${post.slug}` : '';
  // External "open" link always points at production — local dev URL has
  // no meaning outside the operator's laptop.
  const prodUrl = PROD_URL ? `${PROD_URL}/blog/${post.slug}` : '';
  function flipMode(m: PreviewMode) { setPreviewMode(m); savePreviewMode(m); }
  const [regenerating, setRegenerating] = useState(false);
  const [imgError, setImgError]         = useState<string | null>(null);
  const [publishing, setPublishing]     = useState(false);
  const [publishMsg, setPublishMsg]     = useState<{ kind: 'ok' | 'err' | 'pending'; text: string } | null>(null);
  const pollRef = useRef<number | null>(null);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  async function regenerateImage() {
    setRegenerating(true);
    setImgError(null);
    try {
      await api.generateBlogImage(post.slug);
      onRegenerated();
    } catch (e: any) {
      setImgError(String(e?.message || e));
    } finally {
      setRegenerating(false);
    }
  }

  // Push this post from LOCAL → PROD D1, then trigger the marketing-site
  // rebuild. Every attempt lands in the Outbox under channel='blog'.
  async function publishToProd() {
    if (publishing) return;
    if (!confirm(`Publish "${post.title}" to the live site?\n\nThe post goes live straight away (edge-rendered from the database — no rebuild).`)) return;
    setPublishing(true);
    setPublishMsg(null);
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    try {
      const r = await api.publishBlogPost(post.slug);
      // r.ok/r.live is the edge-verified truth (the blog-edge worker serves it
      // from D1 — no sidecar, no rebuild). Trust it.
      if (r.ok || r.live) {
        setPublishMsg({ kind: 'ok', text: '✓ Live on the public site' });
        return;
      }
      // Not live yet — cache lag or a mirror error. Poll briefly then report.
      setPublishMsg({ kind: 'pending', text: r.mirror_error ? `Mirror issue: ${r.mirror_error} — confirming…` : 'Confirming it\'s live on the public site…' });
      let tries = 0;
      pollRef.current = window.setInterval(async () => {
        tries++;
        try {
          const s = await api.blogLiveStatus(post.slug);
          if (s.live) {
            setPublishMsg({ kind: 'ok', text: '✓ Live on the public site' });
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            return;
          }
        } catch { /* keep polling */ }
        if (tries >= 30) { // ~6 min ceiling
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setPublishMsg({ kind: 'pending', text: 'Deploy queued; still building — check the live link in a minute.' });
        }
      }, 12000);
    } catch (e: any) {
      setPublishMsg({ kind: 'err', text: String(e?.message || e) });
    } finally {
      setPublishing(false);
    }
  }

  // Drafts (unpublished, with a body) get true inline editing below. Published
  // posts keep the accurate live-site iframe preview.
  const isDraftEditable = !post.published && !!post.body;

  return (
    <div className="px-4 py-4 bg-paper/60 border-t border-line text-[12px] space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
        <KV k="views"        v={post.views} />
        <KV k="unique"       v={post.unique_visitors} />
        <KV k="avg scroll"   v={post.avg_scroll > 0 ? `${Math.round(post.avg_scroll)}%` : '—'} />
        <KV k="cta clicks"   v={post.cta_clicks} />
        <KV k="published"    v={fmtDate(post.published_at)} />
        <KV k="last view"    v={post.last_view ? new Date(post.last_view).toLocaleString() : '—'} />
        <KV k="updated"      v={new Date(post.updated_at).toLocaleString() + (post.updated_by ? ` · ${post.updated_by}` : '')} />
        <KV k="word count"   v={wordCount || '—'} />
      </div>

      {/* Featured image — preview + regenerate */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute">
            featured image{post.featured_image_model ? ` · ${post.featured_image_model}` : ''}
            {post.featured_image_generated_at && ` · ${new Date(post.featured_image_generated_at).toLocaleString()}`}
          </div>
          <button
            onClick={regenerateImage}
            disabled={regenerating}
            className={
              'mono text-[10px] uppercase tracking-[0.18em] transition ' +
              (regenerating ? 'text-mute' : 'text-mute hover:text-ink')
            }
          >
            {regenerating ? 'regenerating…' : (post.featured_image_url ? 'regenerate' : 'generate')}
          </button>
        </div>
        {post.featured_image_url ? (
          <div className="hairline rounded-sm overflow-hidden bg-paper aspect-[16/9] max-w-md">
            <img
              src={`${devUrl(post.featured_image_url)}?t=${post.featured_image_generated_at ?? 0}`}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <div className="hairline rounded-sm bg-card p-6 mono text-[10px] uppercase tracking-[0.18em] text-mute text-center">
            No image yet. Click <span className="text-ink">generate</span> to create one.
          </div>
        )}
        {imgError && (
          <div className="mt-2 mono text-[10px] text-rose-700 dark:text-rose-300">{imgError}</div>
        )}
      </div>

      {/* Publish to prod. Mirrors local D1 → prod D1 + triggers the
          marketing-site rebuild via the deploy sidecar. The result lands
          in the Outbox under channel='blog' so we get a permanent audit
          trail (and a retry button on failure). */}
      <div className="hairline rounded-sm bg-card/60 p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-0.5">publish to the public site</div>
          <div className="text-[11px] text-mute leading-relaxed">
            {publishOff
              ? `${publishOffWhy} The post stays here, edited and ready to go the moment it is.`
              : 'Pushes this exact post to the production D1 and kicks off a rebuild. Logged in Outbox.'}
          </div>
          {publishMsg && (
            <div className={'mt-1.5 text-[11px] ' + (publishMsg.kind === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : publishMsg.kind === 'pending' ? 'text-mute' : 'text-rose-700 dark:text-rose-300')}>
              {publishMsg.text}
            </div>
          )}
        </div>
        <button
          onClick={publishToProd}
          disabled={publishing || publishOff}
          title={publishOff ? publishOffWhy : undefined}
          className={
            'mono h-9 px-4 rounded-sm text-[11px] uppercase tracking-[0.18em] transition shrink-0 ' +
            (publishing || publishOff ? 'bg-card text-mute cursor-not-allowed' : 'bg-ink text-paper hover:opacity-90')
          }
        >
          {publishOff ? 'publishing off' : publishing ? 'publishing…' : 'publish →'}
        </button>
      </div>

      {/* Draft social posts from this article → review in the Social module,
          refine with Nyo. Works on any article, past ones included. */}
      <div className="hairline rounded-sm bg-card/60 p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-0.5">social posts</div>
          <div className="text-[11px] text-mute leading-relaxed">
            Draft LinkedIn + Facebook posts from this article (company + personal voice). Lands in the Social module for review, and opens Nyo to refine them.
          </div>
        </div>
        <button
          onClick={onDraftSocial}
          disabled={drafting}
          className={
            'mono h-9 px-4 rounded-sm text-[11px] uppercase tracking-[0.18em] transition shrink-0 ' +
            (drafting ? 'bg-card text-mute cursor-not-allowed' : 'bg-ink text-paper hover:opacity-90')
          }
        >
          {drafting ? 'drafting…' : 'Draft social posts'}
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {!isDraftEditable && <PreviewModePill mode={previewMode} onChange={flipMode} />}
            <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute truncate">
              {isDraftEditable ? 'click any section to edit · autosaves' : publicUrl ? publicUrl.replace(/^https?:\/\//, '') : 'no public site connected'}
            </span>
          </div>
          {prodUrl && <a href={prodUrl} target="_blank" rel="noopener noreferrer" className="mono text-[10px] uppercase tracking-[0.2em] text-mute hover:text-ink transition shrink-0">open live ↗</a>}
        </div>

        {isDraftEditable ? (
          <InlineBodyEditor post={post} />
        ) : post.body ? (
          publicUrl ? (
            <SitePreview
              key={`${post.slug}:${previewMode}`}
              src={publicUrl}
              title={post.title}
              className="w-full h-[640px] hairline rounded-sm bg-paper"
            />
          ) : (
            <div className="hairline rounded-sm bg-card p-6 mono text-[10px] uppercase tracking-[0.18em] text-mute text-center">
              No public site connected. Configure the site origin to preview the live page here.
            </div>
          )
        ) : (
          <div className="hairline rounded-sm bg-card p-6 mono text-[10px] uppercase tracking-[0.18em] text-mute text-center">
            Empty stub — body still pending. Ask Nyo to write it.
          </div>
        )}
      </div>
    </div>
  );
}
