// Right-side drawer that opens when a digest item is clicked. Surfaces:
//   - the item's title / summary / suggested action / link
//   - for calendar cards, the underlying event (when, where, link)
//   - a draft note that auto-saves on the card
//   - snooze, star, and mark read
// Closing without acting leaves the item in the brief.

import { useEffect, useState } from 'react';
import {
  api,
  parseMeta,
  type DigestItem,
  type DigestAction,
  type DigestContext,
} from './digest-data';
import { X, Star, Trash } from '../../components/Icons';

type Props = {
  item: DigestItem;
  onClose: () => void;
  onChange: () => void;
};

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function DigestItemDrawer({ item, onClose, onChange }: Props) {
  const [context, setContext] = useState<DigestContext | null>(null);
  const [actions, setActions] = useState<DigestAction[] | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [starred, setStarred] = useState(item.starred === 1);
  const [isRead, setIsRead]   = useState(item.read_at !== null);
  const [snoozed, setSnoozed] = useState(false);

  // Draft note: persists server-side (meta_json.draft), auto-saves 800ms
  // after the operator stops typing.
  const [draft, setDraft] = useState<string | null>(null);
  const savedDraft = parseMeta(item).draft ?? '';
  const draftText = draft ?? savedDraft;
  const [draftNote, setDraftNote] = useState<string | null>(null);
  useEffect(() => {
    if (draft === null) return;
    const t = window.setTimeout(() => {
      api.patchDigestItem(item.id, { draft })
        .then(() => setDraftNote('saved'))
        .catch((e) => setDraftNote(e instanceof Error ? e.message : String(e)));
    }, 800);
    return () => window.clearTimeout(t);
  }, [draft, item.id]);

  useEffect(() => {
    let alive = true;
    setContext(null); setActions(null);
    setError(null); setDoneMsg(null); setSnoozed(false);
    setDraft(null); setDraftNote(null);
    setStarred(item.starred === 1); setIsRead(item.read_at !== null);
    api.digestActions(item.id)
      .then((r) => {
        if (!alive) return;
        setActions(r.actions);
        if (r.context) setContext(r.context);
      })
      .catch((e) => { if (alive) setError(String(e?.message || e)); });
    return () => { alive = false; };
  }, [item.id, item.starred, item.read_at]);

  // ESC closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  async function toggleStar() {
    setBusy('star'); setError(null);
    try {
      const r = await api.executeDigestAction(item.id, { type: 'star', starred: !starred });
      if (r.error) throw new Error(r.error);
      setStarred(!starred);
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function markRead(read: boolean) {
    setBusy('mark_read'); setError(null);
    try {
      const r = await api.executeDigestAction(item.id, { type: 'mark_read', read });
      if (r.error) throw new Error(r.error);
      setIsRead(read);
      onChange();
      if (read) onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function snooze() {
    setBusy('snooze'); setError(null);
    try {
      const r = await api.digestSnooze(item.id);
      if (r.error) throw new Error(r.error);
      setSnoozed(true);
      setDoneMsg(`Snoozed${r.until ? ` until ${fmtWhen(r.until)}` : ''}${r.archived && r.archived > 1 ? `, ${r.archived} cards archived` : ''}.`);
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const openLink  = actions?.find((a) => a.type === 'open_link') || null;
  const snoozeAct = actions?.find((a) => a.type === 'snooze') || null;
  const event     = context?.event || null;
  const isCal     = item.ref_kind === 'calendar_events';

  return (
    <>
      {/* backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/25 backdrop-blur-[1px] z-40"
      />
      <aside
        className="fixed top-0 right-0 h-full w-full sm:w-[520px] bg-paper border-l border-line z-50 shadow-[-16px_0_40px_-20px_rgba(10,10,10,0.18)] flex flex-col"
        role="dialog"
        aria-label="Digest item"
      >
        {/* Header */}
        <header className="px-5 h-12 border-b border-line flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={
              'h-1.5 w-1.5 rounded-full shrink-0 ' +
              (item.urgency === 1 ? 'bg-rose-500' : item.urgency === 2 ? 'bg-amber-500' : 'bg-stone-400')
            } />
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute truncate">{item.source_label || 'digest item'}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleStar}
              disabled={busy === 'star'}
              aria-label={starred ? 'Unstar' : 'Star'}
              title={starred ? 'Unstar' : 'Star: pinned cards stay visible across day rolls'}
              className={
                'h-8 w-8 grid place-items-center rounded-sm transition ' +
                (starred ? 'text-amber-500' : 'text-mute hover:text-amber-500 hover:bg-card/70')
              }
            >
              <Star size={16} className={starred ? 'fill-current' : ''} />
            </button>
            <button
              onClick={onClose}
              title="Close"
              className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Item summary */}
          <section>
            <h2 dir="auto" className="text-[15px] font-semibold leading-snug text-ink">{item.title}</h2>
            {item.summary && (
              <p dir="auto" className="text-[13px] text-mute mt-2 leading-relaxed whitespace-pre-wrap">{item.summary}</p>
            )}
            {item.suggested_action && (
              <div dir="auto" className="mt-3 inline-flex items-center mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2 py-1">
                {item.suggested_action}
              </div>
            )}
            {(openLink?.url || item.source_url) && (
              <div className="mt-3">
                <a
                  href={openLink?.url || item.source_url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => { api.executeDigestAction(item.id, { type: 'open_link' }).catch(() => {}); }}
                  className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
                  title="Open the link"
                >
                  {isCal ? 'Open invite ↗' : 'Open link ↗'}
                </a>
              </div>
            )}
          </section>

          {/* Calendar event context */}
          {event && (
            <section className="hairline rounded-sm bg-card/60 p-4 space-y-1.5">
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-1">Event</div>
              <div className="text-[13px] text-ink font-medium" dir="auto">{event.title}</div>
              <div className="text-[12px] text-mute">
                {event.all_day ? 'All day · ' : ''}{fmtWhen(event.starts_at)}{event.ends_at ? ` to ${new Date(event.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
              </div>
              {event.location && <div className="text-[12px] text-mute" dir="auto">Where: {event.location}</div>}
              {event.platform && <div className="text-[12px] text-mute">Via: {event.platform}</div>}
              {event.status && <div className="mono text-[10px] uppercase tracking-[0.16em] text-mute">{event.status}</div>}
              {event.description && (
                <p dir="auto" className="text-[12px] text-mute leading-relaxed whitespace-pre-wrap pt-1">{event.description}</p>
              )}
            </section>
          )}

          {/* Draft note */}
          <section className="hairline rounded-sm bg-card/60 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-medium text-ink">Draft note</div>
              <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">{draftNote || 'auto-saves'}</span>
            </div>
            <textarea
              dir="auto"
              value={draftText}
              onChange={(e) => { setDraft(e.target.value); setDraftNote(null); }}
              rows={5}
              placeholder="Jot what you want to do with this..."
              className="w-full resize-y rounded-sm hairline bg-paper px-3 py-2 text-[13px] leading-relaxed focus:border-ink focus:outline-none transition"
            />
          </section>

          {/* Snooze */}
          <section className="hairline rounded-sm bg-card/60 p-4 space-y-2">
            <div className="text-[13px] font-medium text-ink">Snooze</div>
            <p className="text-[11px] text-mute">
              {snoozeAct?.description || 'Keep this out of the brief for a while.'}
            </p>
            <button
              onClick={snooze}
              disabled={busy === 'snooze' || snoozed}
              className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm hairline text-ink hover:bg-card transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
            >
              {snoozed ? 'snoozed' : busy === 'snooze' ? 'snoozing...' : 'snooze'}
            </button>
          </section>

          {/* Mark read / unread */}
          <section className="flex items-center justify-end gap-2 pt-1">
            {isRead ? (
              <button
                onClick={() => markRead(false)}
                disabled={busy === 'mark_read'}
                className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm text-mute hover:text-ink hover:bg-card transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
              >
                {busy === 'mark_read' ? 'working...' : 'mark unread'}
              </button>
            ) : (
              <button
                onClick={() => markRead(true)}
                disabled={busy === 'mark_read'}
                className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm text-mute hover:text-rose-700 hover:bg-rose-50 transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
              >
                <Trash size={12} />
                {busy === 'mark_read' ? 'dismissing...' : 'mark read'}
              </button>
            )}
          </section>

          {error && (
            <div className="hairline rounded-sm bg-rose-50 text-rose-800 text-[12px] px-3 py-2">{error}</div>
          )}
          {doneMsg && (
            <div className="hairline rounded-sm bg-emerald-50 text-emerald-800 text-[12px] px-3 py-2">{doneMsg}</div>
          )}
        </div>
      </aside>
    </>
  );
}
