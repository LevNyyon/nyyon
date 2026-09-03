import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SocialPost, type SocialChannel, type SocialConnection } from './social-data';
import { LinkedIn, Refresh, Check, X, Newspaper, MessageSquare, Trash } from '../../components/Icons';
import { useChatState, openChat } from '../../lib/chat';
import { useModulePrereqs } from '../../lib/module-status';
import { ModuleSetupGate } from '../../components/ModuleSetupGate';
import { DegradedNotice, ModuleStatusHold } from '../../components/DegradedNotice';
import { blogUrl } from '../../lib/site';

// Social — every published article auto-drafts three posts (company LinkedIn,
// personal LinkedIn, company Facebook). The operator reviews/edits, then
// approves. Approving POSTs through the Make-webhook gateway and logs the send
// to the Outbox + activity feed.
//
// Editorial plugin surface: a thin client over the pack's OWN tools via
// /api/plugins/editorial/invoke/* (see ./social-data) — the same tools Nyo
// drives, so a Nyo edit and a page edit land in the same row.
//
// Posting is the ONLY thing here that needs an outside connection. Without the
// webhooks the module still drafts, still edits, still queues — it just says so
// and keeps the Approve buttons off, per channel, rather than firing a request
// that comes back as a raw gateway error.

const CHANNEL_LABELS: Record<SocialChannel, string> = {
  'linkedin-company':  'LinkedIn · Company',
  'linkedin-personal': 'LinkedIn · Personal',
  'facebook-company':  'Facebook · Company',
};

const REFRESH_MS = 5000;
type Tab = 'review' | 'posted' | 'settings';

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)     return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const humanize = (slug: string) => slug.replace(/-\d+$/, '').replace(/-/g, ' ');

export default function Social() {
  const [tab, setTab] = useState<Tab>('review');
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [connections, setConnections] = useState<SocialConnection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { setPendingSend } = useChatState();

  // What this module needs of its own, asked for the first time it is opened.
  const prereqs = useModulePrereqs('social');

  // Reflow the page out from under the fixed Nyo drawer when it's open.
  const [chatOpen, setChatOpen] = useState<boolean>(() => localStorage.getItem('nyyon.chat.open.v1') === '1');
  useEffect(() => {
    const h = (e: Event) => setChatOpen(!!(e as CustomEvent).detail);
    window.addEventListener('nyyon:chat-toggled', h);
    return () => window.removeEventListener('nyyon:chat-toggled', h);
  }, []);

  // In-app confirm modal. The desktop app's WKWebView silently swallows
  // window.confirm(), so we render our own — portable to any wrapper.
  const [confirmState, setConfirmState] = useState<{ message: string; confirmLabel: string; danger: boolean; onConfirm: () => void } | null>(null);
  const askConfirm = (message: string, onConfirm: () => void, opts: { confirmLabel?: string; danger?: boolean } = {}) =>
    setConfirmState({ message, onConfirm, confirmLabel: opts.confirmLabel ?? 'Confirm', danger: opts.danger ?? false });

  const fetchPosts = async () => {
    try { setPosts(await api.listSocialPosts()); setError(null); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
  useEffect(() => { fetchPosts(); api.socialSettings().then(setConnections).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(fetchPosts, REFRESH_MS); return () => clearInterval(t); }, []);

  const drafts = useMemo(() => (posts ?? []).filter((p) => p.status === 'draft'), [posts]);
  const released = useMemo(() => (posts ?? []).filter((p) => p.status === 'posted' || p.status === 'failed'), [posts]);

  // Drafts grouped by article, newest article first.
  const groups = useMemo(() => {
    const m = new Map<string, SocialPost[]>();
    for (const p of drafts) { (m.get(p.blog_slug) ?? m.set(p.blog_slug, []).get(p.blog_slug)!).push(p); }
    return [...m.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.created_at)) - Math.max(...a[1].map((x) => x.created_at)));
  }, [drafts]);

  // Can this exact channel actually publish? Two sources agree on the answer:
  // the module's prerequisite read, and the settings the page already loads.
  // An UNKNOWN connection counts as live — nothing gets disabled on a fact we
  // do not have.
  const connMap = useMemo(() => {
    const m = new Map<SocialChannel, boolean>();
    for (const c of connections ?? []) m.set(c.connection, !!c.configured);
    return m;
  }, [connections]);
  const gatewayDark = prereqs.needsGateway('social');
  const channelLive = (ch: SocialChannel) => !gatewayDark && (connMap.get(ch) ?? true);
  const publishingOff =
    gatewayDark || (connections !== null && connections.length > 0 && connections.every((c) => !c.configured));
  const someChannelDark =
    publishingOff || (connections !== null && connections.some((c) => !c.configured));
  const offReason = (ch: SocialChannel) =>
    gatewayDark
      ? prereqs.gapFor('social')?.why || 'No posting webhook is connected yet — drafting still works.'
      : `${CHANNEL_LABELS[ch]} has no webhook configured — connect it in Settings.`;

  const doApprove = async (p: SocialPost) => {
    setBusy(p.id);
    try {
      const r = await api.approveSocialPost(p.id);
      if (r && r.ok === false) setError(`${CHANNEL_LABELS[p.channel]}: ${r.error || 'push failed'}`);
      await fetchPosts();
    } catch (e) { setError(`${CHANNEL_LABELS[p.channel]}: ${(e as Error)?.message || e}`); await fetchPosts(); }
    finally { setBusy(null); }
  };
  const approve = (p: SocialPost) => {
    if (!channelLive(p.channel)) return;   // the button is already off; this is the belt
    askConfirm(`Post to ${CHANNEL_LABELS[p.channel]} now? This publishes live.`, () => doApprove(p), { confirmLabel: 'Post now' });
  };
  // Only the channels that can actually publish. "Approve all 3" on an install
  // with one webhook would have failed two of them with a raw gateway error.
  const approveAll = (rows: SocialPost[]) => {
    const live = rows.filter((p) => channelLive(p.channel));
    if (!live.length) return;
    askConfirm(`Post all ${live.length} to their channels now? This publishes live.`, async () => { for (const p of live) await doApprove(p); }, { confirmLabel: `Post all ${live.length}` });
  };
  const skip = async (p: SocialPost) => {
    setBusy(p.id);
    try { await api.skipSocialPost(p.id); await fetchPosts(); }
    catch (e) { setError(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };
  const saveEdit = async (id: string, content: string) => {
    try { await api.editSocialPost(id, content); await fetchPosts(); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
  // Open the Nyo drawer briefed on this exact post. Nyo shapes it live via the
  // edit_social_post tool; our 5s poll reflects the change in place. When done,
  // Nyo folds what it learned back into the voice/taste knowledge docs.
  const shapeWithNyo = (p: SocialPost) => {
    const kind = p.channel === 'linkedin-personal' ? 'personal LinkedIn' : p.channel.startsWith('facebook') ? 'company Facebook' : 'company LinkedIn';
    const voiceDoc = p.channel === 'linkedin-personal' ? 'plugin-editorial-personal-voice' : 'brand-voice';
    setPendingSend(
      `Let's improve, adjust, and shape a social post together. It's the ${CHANNEL_LABELS[p.channel]} post for the blog article "${p.blog_title || humanize(p.blog_slug)}". Its social post id is ${p.id}.\n\nCurrent draft:\n"""\n${p.content}\n"""\n\nAs I ask for changes, call edit_social_post with that id and the FULL new text so it updates live in the Social module. This is shaping, not publishing, I approve it myself.\n\nWhen we're done, capture what you learned about how I want ${kind} posts written (tone, length, what to cut, what to lead with) and save it with write_knowledge into the ${voiceDoc} doc (or plugin-editorial-editorial-taste for cross-cutting taste). Read the doc first and append, do not overwrite what's already good.\n\nStart with a quick read and ask what I'd like to change.`,
    );
    openChat();
  };

  const deletePost = (p: SocialPost) =>
    askConfirm(`Delete this ${CHANNEL_LABELS[p.channel]} post? This can't be undone.`, async () => {
      setBusy(p.id);
      try { await api.deleteSocialPost(p.id); await fetchPosts(); }
      catch (e) { setError(String((e as Error)?.message || e)); }
      finally { setBusy(null); }
    }, { confirmLabel: 'Delete', danger: true });
  const deleteGroup = (slug: string, title: string, count: number) =>
    askConfirm(`Delete all ${count} social ${count === 1 ? 'post' : 'posts'} for "${title}"? This can't be undone.`, async () => {
      try { await api.deleteSocialGroup(slug); await fetchPosts(); }
      catch (e) { setError(String((e as Error)?.message || e)); }
    }, { confirmLabel: 'Delete all', danger: true });

  const gated = prereqs.phase === 'gate' && !!prereqs.status;

  // Everything below the header. While the gate is up this is what the gate
  // wraps: unmounted until the operator either connects the webhooks or says
  // "not now".
  const content = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {tab === 'review' && (
        posts === null ? <Empty>Loading…</Empty> :
        groups.length === 0 ? <Empty>No drafts waiting. When a blog post goes live, three social posts appear here for approval.</Empty> :
        <div className="p-4 sm:p-5 space-y-5">
          {groups.map(([slug, rows]) => {
            const standalone = slug.startsWith('standalone:');
            const title = standalone ? 'Standalone post' : (rows[0]?.blog_title || humanize(slug));
            const postable = rows.filter((p) => channelLive(p.channel));
            return (
              <article key={slug} className="rounded-sm border border-line bg-card/30 overflow-hidden">
                <div className="px-4 py-3 border-b border-line flex items-center gap-3">
                  <Newspaper size={15} className="text-mute shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">{standalone ? 'Standalone' : 'Blog article'}</div>
                    <div className="text-sm font-medium truncate">{title}</div>
                  </div>
                  {!standalone && blogUrl(slug) !== '' && (
                    <a href={blogUrl(slug)} target="_blank" rel="noreferrer" className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink shrink-0">open ↗</a>
                  )}
                  <button
                    onClick={() => approveAll(rows)}
                    disabled={postable.length === 0}
                    title={postable.length === 0
                      ? 'None of these channels can publish yet — the drafts stay here, edited and ready.'
                      : postable.length < rows.length
                        ? `Only ${postable.length} of ${rows.length} channels are connected — the rest stay as drafts.`
                        : undefined}
                    className={
                      'h-7 px-3 rounded-sm border text-[11px] mono uppercase tracking-[0.18em] transition shrink-0 ' +
                      (postable.length === 0
                        ? 'border-line text-mute opacity-60 cursor-not-allowed'
                        : 'border-emerald-400/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/40')
                    }
                  >
                    {postable.length === 0
                      ? 'Publishing off'
                      : `Approve all ${postable.length}${postable.length < rows.length ? ` of ${rows.length}` : ''}`}
                  </button>
                  <button
                    onClick={() => deleteGroup(slug, title, rows.length)}
                    title="Delete all drafts for this article"
                    className="h-7 w-7 grid place-items-center rounded-sm border border-line text-mute hover:text-rose-600 hover:border-rose-400/60 transition shrink-0"
                  >
                    <Trash size={13} />
                  </button>
                </div>
                <div className="divide-y divide-line">
                  {rows.map((p) => (
                    <DraftRow
                      key={p.id}
                      post={p}
                      busy={busy === p.id}
                      canPost={channelLive(p.channel)}
                      offReason={offReason(p.channel)}
                      onApprove={() => approve(p)}
                      onSkip={() => skip(p)}
                      onSave={saveEdit}
                      onNyo={() => shapeWithNyo(p)}
                      onDelete={() => deletePost(p)}
                    />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {tab === 'posted' && (
        released.length === 0 ? <Empty>Nothing released yet. Approved posts show here, and also land in the Outbox + Activity feed.</Empty> :
        <ul>
          {released.map((p) => (
            <li key={p.id} className={'border-b border-line border-l-2 px-4 sm:px-6 py-3 ' + (p.status === 'failed' ? 'border-l-rose-500 bg-rose-50/40 dark:bg-rose-950/20' : 'border-l-emerald-500')}>
              <div className="flex items-center gap-3">
                <span className={'mono text-[9px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm ' + (p.status === 'failed' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300')}>
                  {p.status}
                </span>
                <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">{CHANNEL_LABELS[p.channel]}</span>
                <span className="text-sm truncate text-mute" title={p.blog_title || p.blog_slug}>{p.blog_title || humanize(p.blog_slug)}</span>
                <span className="ml-auto mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">{timeAgo(p.posted_at || p.updated_at)}</span>
                {p.status === 'failed' && (
                  <button
                    onClick={() => doApprove(p)}
                    disabled={busy === p.id || !channelLive(p.channel)}
                    title={channelLive(p.channel) ? 'Send this one again' : offReason(p.channel)}
                    className={
                      'shrink-0 h-6 px-2 rounded-sm border text-[10px] mono uppercase tracking-[0.18em] transition ' +
                      (channelLive(p.channel)
                        ? 'border-rose-400/60 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/40'
                        : 'border-line text-mute opacity-60 cursor-not-allowed')
                    }
                  >
                    {busy === p.id ? '…' : 'Retry'}
                  </button>
                )}
                <button onClick={() => deletePost(p)} title="Delete this record" className="shrink-0 h-6 w-6 grid place-items-center rounded-sm border border-line text-mute hover:text-rose-600 hover:border-rose-400/60 transition">
                  <Trash size={12} />
                </button>
              </div>
              <div className="mt-1.5 text-[13px] text-mute whitespace-pre-wrap break-words line-clamp-3">{p.content}</div>
              {p.status === 'failed' && p.error && <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">⚠ {p.error}</div>}
            </li>
          ))}
        </ul>
      )}

      {tab === 'settings' && (
        <div className="p-4 sm:p-6 max-w-2xl space-y-3">
          <p className="text-[13px] text-mute leading-relaxed">
            These are the gateways the Social module posts through. Each is a Make webhook configured in the worker env. Approving a post sends it to the matching gateway.
            {someChannelDark && ' A channel with no webhook still collects drafts — its Approve button stays off until it is connected.'}
          </p>
          {connections === null ? <Empty>Loading…</Empty> : connections.map((c) => (
            <div key={c.connection} className="rounded-sm border border-line bg-card/40 px-4 py-3 flex items-center gap-3">
              <span className="text-sm font-medium">{c.label}</span>
              <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">{c.network}</span>
              <span className={'ml-auto mono text-[10px] uppercase tracking-[0.18em] px-2 py-1 rounded-sm flex items-center gap-1 ' + (c.configured ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300')}>
                {c.configured ? <><Check size={11} /> Connected</> : 'Not connected'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className={'flex flex-col h-full min-h-0 transition-[padding] duration-300 ' + (chatOpen ? 'sm:pr-[480px]' : '')}>
      <header className="border-b border-line bg-paper/60 px-4 sm:px-6 py-3 flex flex-col gap-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <LinkedIn size={16} className="text-mute" />
          <h1 className="font-semibold tracking-tight text-base">Social</h1>
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">
            {drafts.length} awaiting · {released.filter((p) => p.status === 'posted').length} posted
          </span>
          {/* The tabs belong to the working module, not to its setup. */}
          {!gated && (
            <div className="ml-auto flex items-center gap-1">
              {(['review', 'posted', 'settings'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={
                    'h-7 px-3 rounded-sm text-[11px] mono uppercase tracking-[0.18em] transition ' +
                    (tab === t ? 'bg-card text-ink shadow-[inset_0_0_0_1px_var(--color-line)]' : 'text-mute hover:text-ink')
                  }
                >
                  {t === 'review' ? 'Needs approval' : t === 'posted' ? 'Posted' : 'Settings'}
                </button>
              ))}
              <button onClick={fetchPosts} className="ml-1 h-7 px-2 rounded-sm border border-line text-[11px] text-mute hover:text-ink hover:border-ink/40 transition" title="Refresh">
                <Refresh size={12} />
              </button>
            </div>
          )}
        </div>
        {/* What is off, said once, where the actions are. Voice and posting are
            separate facts: one changes how the drafts read, the other decides
            whether anything can leave at all. */}
        {!gated && (publishingOff || prereqs.needsVoice) && (
          <DegradedNotice
            note={
              publishingOff && prereqs.needsVoice
                ? <>Drafting, editing and queueing all work, on <strong className="font-semibold">shipped voice defaults</strong>. <strong className="font-semibold">Publishing is off</strong> — nothing can leave for LinkedIn or Facebook.</>
                : publishingOff
                  ? <>Drafting, editing and queueing all work. <strong className="font-semibold">Publishing is off</strong> — nothing can leave for LinkedIn or Facebook until a posting webhook is connected.</>
                  : <>Everything here works. The drafts are written on <strong className="font-semibold">shipped voice defaults</strong> — they read like the sample that came with the app until you teach Nyo yours.</>
            }
            items={prereqs.unmet.filter((p) => p.kind === 'gateway' || p.kind === 'voice')}
            onSetUp={() => (prereqs.status ? prereqs.openSetup() : setTab('settings'))}
            actionLabel={prereqs.status ? 'set it up' : 'see settings'}
          />
        )}
        {error && (
          <div className="rounded-sm border border-rose-300/60 bg-rose-50/60 dark:bg-rose-950/30 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100"><X size={12} /></button>
          </div>
        )}
      </header>

      {prereqs.phase === 'loading' ? <ModuleStatusHold /> : gated && prereqs.status ? (
        <ModuleSetupGate
          status={prereqs.status}
          slug="social"
          onDone={prereqs.done}
          onSkip={prereqs.skip}
        >
          {content}
        </ModuleSetupGate>
      ) : content}

      {confirmState && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 px-4" onClick={() => setConfirmState(null)}>
          <div className="w-full max-w-sm rounded-sm border border-line bg-paper shadow-[0_20px_60px_-15px_rgba(10,10,10,0.5)] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-ink leading-relaxed whitespace-pre-wrap mb-4">{confirmState.message}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmState(null)} className="h-8 px-3 rounded-sm border border-line text-[11px] mono uppercase tracking-[0.18em] text-mute hover:text-ink transition">
                Cancel
              </button>
              <button
                autoFocus
                onClick={() => { const fn = confirmState.onConfirm; setConfirmState(null); fn(); }}
                className={'h-8 px-3 rounded-sm border text-[11px] mono uppercase tracking-[0.18em] transition ' + (confirmState.danger ? 'border-rose-400/60 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/40' : 'border-emerald-400/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/40')}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DraftRow({ post, busy, canPost, offReason, onApprove, onSkip, onSave, onNyo, onDelete }: { post: SocialPost; busy: boolean; canPost: boolean; offReason: string; onApprove: () => void; onSkip: () => void; onSave: (id: string, content: string) => void; onNyo: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(post.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = text.trim() !== post.content.trim();
  // Sync in external changes (Nyo shaping via the 5s poll) — but never yank
  // the text out from under the operator while they're typing in it.
  useEffect(() => {
    if (taRef.current && document.activeElement === taRef.current) return;
    setText(post.content);
  }, [post.content]);
  // Autosave: 900ms after typing pauses, the edit persists on its own.
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await onSave(post.id, text);
        setSaveState('saved');
        window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      } catch { setSaveState('idle'); }
    }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const preview = post.content.split('\n').find((l) => l.trim()) || post.content;

  return (
    <div>
      {/* Collapsed row — click to expand and edit/approve. */}
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-card/50 transition">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0 whitespace-nowrap">{CHANNEL_LABELS[post.channel]}</span>
        {!canPost && (
          <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-amber-400/50 text-amber-700 dark:text-amber-300 shrink-0" title={offReason}>
            not connected
          </span>
        )}
        <span className="flex-1 truncate text-[13px] text-mute">{preview}</span>
        {post.image_url && <span className="mono text-[9px] uppercase tracking-[0.18em] text-mute opacity-60 shrink-0" title="cover image attached">img</span>}
        <span className="mono text-[10px] text-mute shrink-0">{post.content.length}</span>
        <span className={'text-mute text-sm leading-none transition-transform shrink-0 ' + (open ? 'rotate-90' : '')}>›</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(14, Math.max(5, text.split('\n').length + 1))}
            className="w-full text-[13px] leading-relaxed rounded-sm bg-paper border border-line px-3 py-2 focus:outline-none focus:border-ink/40 resize-y"
          />
          {!canPost && (
            <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">{offReason} The draft is saved and stays here.</div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button onClick={onNyo} title="Open Nyo briefed on this post to improve, adjust and shape it live together" className="h-7 px-3 rounded-sm border border-line text-[11px] mono uppercase tracking-[0.18em] text-mute hover:text-ink hover:border-ink/40 transition flex items-center gap-1.5">
              <MessageSquare size={12} /> Improve · Adjust · Shape
            </button>
            {(dirty || saveState !== 'idle') && (
              <span className="mono text-[10px] uppercase tracking-[0.15em] text-mute">
                {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : 'Autosaves…'}
              </span>
            )}
            <button onClick={onDelete} title="Delete this post" className="ml-auto h-7 w-7 grid place-items-center rounded-sm border border-line text-mute hover:text-rose-600 hover:border-rose-400/60 transition">
              <Trash size={13} />
            </button>
            <button onClick={onSkip} disabled={busy} className="h-7 px-3 rounded-sm border border-line text-[11px] mono uppercase tracking-[0.18em] text-mute hover:text-ink transition">
              Skip
            </button>
            <button
              onClick={onApprove}
              disabled={busy || dirty || !canPost}
              title={!canPost ? offReason : dirty ? 'Autosaving your edit — a moment' : 'Approve and post live'}
              className={'h-7 px-3 rounded-sm border text-[11px] mono uppercase tracking-[0.18em] transition flex items-center gap-1.5 ' + (busy || dirty || !canPost ? 'border-line text-mute opacity-60 cursor-not-allowed' : 'border-emerald-400/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/40')}
            >
              <Check size={12} /> {!canPost ? 'Posting off' : busy ? 'Posting…' : 'Approve → post'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-mute text-sm max-w-lg mx-auto">{children}</div>;
}
