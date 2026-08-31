// Right-side drawer that opens when a digest item is clicked. Surfaces:
//   - the item's original title/summary + suggested_action
//   - the WhatsApp thread context (if applicable)
//   - LLM-drafted actions (Reply on WhatsApp / Discuss with Nyo / Dismiss)
//   - editable draft for the reply
//   - one-click Approve & Send → routes through the whatsapp gateway
// (Digest plugin port — cmd's draft-blog/social/take sections and the PDL
// phone-enrich button did not travel: those belong to other packs/gateways.)
//
// The drawer fetches /actions on open. Sending the reply marks the item
// read; closing without acting leaves the item in the brief.

import { LiPostMockup } from './LiPostMockup';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  type DigestItem,
  type DigestAction,
  type DigestActionsResponse,
  type DigestContext,
  type DigestRecipient,
  type DigestRecipientMode,
  type Contact,
} from './digest-data';
import { useChatState, navigateTo } from '../../lib/chat';
import { X, Sparkle, MessageSquare, Trash, Star, LinkedIn } from '../../components/Icons';
import { LinkedInText } from './LinkedInText';
import { fmtWhen } from './wa-time';
import { WaSlotPicker } from './WaSlotPicker';
import { HeatBar } from './HeatBar';

// Seed for the auto-opened contact picker. We prefer the metadata's
// `full_name` (if the worker resolved one); otherwise pull the first
// plausible Title-Case name out of the digest title, since most action
// titles follow patterns like "Pitch marketing help to Daniel" or
// "Help Ohad reach influencers".
function guessPersonName(fullNameMeta: string | null, fallbackText: string | null): string {
  if (fullNameMeta && fullNameMeta.trim()) return fullNameMeta.trim().split(/\s+/)[0];
  if (!fallbackText) return '';
  const m = fallbackText.match(/\b([A-Z][a-z]{1,20})\b/);
  return m ? m[1] : '';
}

// Format a WA sender id like `972508425412@c.us` into `+972 50 842 5412`.
// Falls back to the original id if it doesn't look like a phone.
function formatPhone(senderId: string | null | undefined): string {
  if (!senderId) return 'unknown';
  const base    = String(senderId).split('@')[0].split('-')[0];
  const digits  = base.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 16) return senderId;
  // Heuristic spacing: country code (1-3) + 2 + 3 + 4
  if (digits.length >= 11) {
    const cc = digits.slice(0, digits.length - 9);
    const a  = digits.slice(-9, -7);
    const b  = digits.slice(-7, -4);
    const c  = digits.slice(-4);
    return `+${cc} ${a} ${b} ${c}`;
  }
  return '+' + digits;
}

// Resolve the best display name for a thread message: contact lookup first,
// then sender_name (when it's a real name, not an id), then formatted phone.
function displayName(
  m: { from_me: number; sender_id: string | null; sender_name: string | null },
  participants: Record<string, { full_name: string | null }> | undefined,
): string {
  if (m.from_me) return 'me';
  if (m.sender_id && participants?.[m.sender_id]?.full_name) {
    return participants[m.sender_id]!.full_name!;
  }
  if (m.sender_name && !m.sender_name.includes('@')) return m.sender_name;
  if (m.sender_id) return formatPhone(m.sender_id);
  return 'someone';
}

type Props = {
  item: DigestItem;
  onClose: () => void;
  onChange: () => void;
};

function buildPreludeFromContext(ctx: DigestContext): string {
  const lines = [
    `Looking at this digest item:`,
    `· title: ${ctx.item.title}`,
    ctx.item.summary ? `· summary: ${ctx.item.summary}` : '',
    ctx.item.suggested_action ? `· suggested action: ${ctx.item.suggested_action}` : '',
  ].filter(Boolean);
  if (ctx.chat) lines.push(`· chat: ${ctx.chat.name || ctx.chat.id}`);
  if (ctx.thread && ctx.thread.length) {
    lines.push('');
    lines.push('Recent thread (oldest first):');
    for (const m of ctx.thread.slice(-12)) {
      const who = m.from_me ? 'me' : (m.sender_name || 'someone');
      const body = (m.body || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      lines.push(`  ${who}: ${body}`);
    }
  }
  if (ctx.mention) {
    const m = ctx.mention as Record<string, string | null | undefined>;
    lines.push('');
    lines.push(`Mention (${m.source || '?'}): ${String(m.text || '').slice(0, 300)}`);
    if (m.source_url) lines.push(`Source: ${m.source_url}`);
  }
  lines.push('');
  lines.push("What's your read? Suggest the next move.");
  return lines.join('\n');
}


// Like + suggested-comment row under the post mockup. Like fires for real
// (error-checked at the daemon); the comment is drafted on demand and posts
// ONLY the text the operator sees and approves.

// Copy the prepared message with visible confirmation. Lives in the drawer,
// beside the other per-person actions, so the card stays scannable.
function DrawerCopyDraft({ draft }: { draft: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');
  return (
    <button type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(draft); setState('ok'); }
        catch { setState('err'); }
        window.setTimeout(() => setState('idle'), 2500);
      }}
      className={'inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] rounded-sm px-2.5 py-1 transition ' + (state === 'ok' ? 'bg-emerald-600 text-white' : 'text-ink bg-paper hairline hover:bg-card')}
      title="Copy the prepared outreach message, paste it wherever you message them">
      {state === 'ok' ? 'copied ✓' : state === 'err' ? 'copy failed, select by hand' : 'copy draft'}
    </button>
  );
}

// The LinkedIn signal row. Like and comment are GONE: LinkedIn rejects both
// write endpoints (reactions 400, comments 422), and a button that silently
// fails is worse than no button. The post is read-only with a link to open
// it; engagement is recorded by the card's ✓ (which feeds lead heat).
function LiEngageRow({ item, meta, onChange }: {
  item: DigestItem;
  meta: { signal_id?: string; prospect_id?: string | null; draft?: string | null; liked_at?: number; commented_at?: number; comment_draft?: string | null; comment_posted?: string | null; name?: string; role?: string | null; company?: string | null; detail?: unknown; wa_url?: string | null; phone?: string | null; heat?: number; heat_band?: 'hot' | 'warm' | 'cold'; heat_factors?: string[] };
  onChange: () => void;
}) {
  const [snoozing, setSnoozing] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const permalink = (() => {
    const d = meta.detail && typeof meta.detail === 'object' ? meta.detail as { urn?: string; link?: string; url?: string } : null;
    if (d?.urn) return `https://www.linkedin.com/feed/update/${d.urn}/`;
    return d?.link || d?.url || null;
  })();
  return (
    <div className="space-y-2">
      {typeof meta.heat === 'number' && (
        <div className="flex items-center gap-2">
          <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">lead heat</span>
          <HeatBar score={meta.heat} band={meta.heat_band} factors={meta.heat_factors} size="md" showLabel />
          <span className="mono text-[10px] tabular-nums text-mute">{meta.heat}</span>
        </div>
      )}
      <LiPostMockup name={meta.name || ''} role={meta.role} company={meta.company} detail={meta.detail} />
      <div className="flex items-center gap-2 flex-wrap">
        {permalink && (
          <a href={permalink} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition"
            title="Open the post on LinkedIn — like or comment there yourself">
            open post ↗
          </a>
        )}
        <button
          type="button"
          disabled={snoozing || snoozed}
          onClick={async () => {
            setSnoozing(true);
            try {
              const r = await api.digestSnooze(item.id);
              if (!r.error) { setSnoozed(true); onChange(); }
            } catch { /* leave it as-is */ }
            finally { setSnoozing(false); }
          }}
          className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2.5 py-1 hover:bg-card transition disabled:opacity-50"
          title="Keep this person out of the brief for a week — their signals stop appearing until it expires"
        >
          {snoozed ? 'snoozed ✓' : snoozing ? 'snoozing…' : '💤 snooze a week'}
        </button>
        {meta.draft && <DrawerCopyDraft draft={meta.draft} />}
        {meta.wa_url && (
          <a href={meta.wa_url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-emerald-600 text-white rounded-sm px-2.5 py-1 hover:opacity-90 transition"
            title={'WhatsApp ' + (meta.phone || '')}>
            WhatsApp →
          </a>
        )}
      </div>
    </div>
  );
}

export function DigestItemDrawer({ item, onClose, onChange }: Props) {
  const [context, setContext]   = useState<DigestContext | null>(null);
  const [data, setData]         = useState<DigestActionsResponse | null>(null);
  const [drafts, setDrafts]     = useState<Record<string, string>>({});
  const [chosenMode, setChosenMode] = useState<DigestRecipientMode | null>(null);
  // Recipient-level pick. Mode alone isn't enough when the server returns
  // multiple recipients sharing a mode — e.g. OSINT items can surface
  // several `reply_to_ask` candidates (one per matched open question) plus
  // several `group` candidates (one per followed chat). When set, this
  // wins over chosenMode for activeRecipient resolution.
  const [chosenRecipientId, setChosenRecipientId] = useState<string | null>(null);
  const [busy, setBusy]         = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [doneMsg, setDoneMsg]   = useState<string | null>(null);
  const [doneQueueId, setDoneQueueId] = useState<string | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed]             = useState<number>(0);
  const { setPendingSend } = useChatState();

  // Thread list ref + a guard so we only scroll the target into view ONCE
  // per item — not on every parent re-render. The previous callback ref
  // re-fired scrollIntoView on every state tick (polling, timer ticks),
  // yanking the operator back to the target whenever they tried to scroll.
  const threadListRef    = useRef<HTMLUListElement | null>(null);
  const scrolledForItem  = useRef<string | null>(null);

  // Two-stage fetch: pull context first (cheap DB read, ~50ms) so the
  // target message is on screen INSTANTLY, then fetch actions (slow LLM
  // call, 5-15s) which fills in the draft + recipient options.
  useEffect(() => {
    let alive = true;
    setContext(null); setData(null);
    setError(null); setDoneMsg(null);
    setLoadStartedAt(Date.now()); setElapsed(0);
    setChosenMode(null);
    setChosenRecipientId(null);

    api.digestContext(item.id)
      .then((c) => { if (alive) setContext(c); })
      .catch(() => { /* non-fatal — actions call will surface real errors */ });

    api.digestActions(item.id)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setLoadStartedAt(null);
        // Mirror context too — actions response includes a fresh copy.
        if (r.context) setContext(r.context);
        const d: Record<string, string> = {};
        for (const a of r.actions) if (a.draft) d[a.type] = a.draft;
        setDrafts(d);
        const reply = r.actions.find((a) => a.type === 'reply_wa');
        if (reply?.recommended_mode) setChosenMode(reply.recommended_mode);
        // If the LLM picked private but the sender's phone never resolved
        // (so no native 'private' recipient exists), pop the contact picker
        // automatically. Server-supplied `recommended_target_name` is the
        // most reliable seed — it's pulled from metadata.full_name OR
        // regex'd out of the title/action by the same code that decided
        // the recommendation. Fall back to client-side guess if the
        // server didn't include one (older items, kinds we missed).
        if (reply?.recommended_mode === 'private') {
          const hasPrivate = (reply.recipients || []).some((r) => r.mode === 'private');
          if (!hasPrivate) {
            setShowContactSearch(true);
            const seed =
              (reply.recommended_target_name || '').trim() ||
              guessPersonName(reply.metadata?.full_name || null, reply.label || item.title);
            if (seed) setContactQuery(seed);
          }
        }
      })
      .catch((e) => { if (alive) { setError(String(e?.message || e)); setLoadStartedAt(null); } });
    return () => { alive = false; };
  }, [item.id]);

  // Tick the elapsed-seconds counter while the LLM drafts the reply.
  useEffect(() => {
    if (!loadStartedAt) return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - loadStartedAt) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [loadStartedAt]);

  // ESC closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  async function approveSend(a: DigestAction, sendAt?: number) {
    if (a.type !== 'reply_wa') return;
    const text = (drafts[a.type] || '').trim();
    if (!text) { setError('Draft is empty — write something first.'); return; }
    const target = activeRecipient || a.recipient;
    if (!target) { setError('No WhatsApp recipient resolved.'); return; }
    setBusy(a.type); setError(null);
    try {
      const ex = await api.executeDigestAction(item.id, { type: 'reply_wa', text, recipient: target, ...(sendAt ? { send_at: sendAt } : {}) });
      if (ex.error) throw new Error(ex.error);
      const qid = (ex && (ex.sent as { queue_id?: string } | undefined)?.queue_id) || null;
      setDoneQueueId(sendAt ? qid : null); // only a scheduled send is cancellable
      // Keep the drawer OPEN after sending — the operator may also want to draft
      // a blog/social take from the same item. The item stays in the brief until
      // they explicitly dismiss it (✕).
      setDoneMsg(sendAt
        ? `Scheduled for ${fmtWhen(sendAt)} to ${target.name}. Still here if you want more actions — dismiss when you're done.`
        : `Sent to ${target.name} (${target.mode === 'group' ? 'in the group' : 'as DM'}). Still here if you want more actions — dismiss when you're done.`);
      onChange();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  async function discussWithNyo() {
    setBusy('discuss'); setError(null);
    try {
      const ctx = data?.context || (await api.digestContext(item.id));
      const prelude = buildPreludeFromContext(ctx);
      setPendingSend(prelude);
      await api.executeDigestAction(item.id, { type: 'discuss' });
      navigateTo('nyo');
      onChange();
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy('dismiss'); setError(null);
    try {
      await api.executeDigestAction(item.id, { type: 'dismiss' });
      onChange();
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  const replyAction    = data?.actions.find((a) => a.type === 'reply_wa') || null;
  const wishlistAction = data?.actions.find((a) => a.type === 'add_to_wishlist') || null;
  const ctxLive        = context || data?.context || null;
  const thread         = ctxLive?.thread || [];
  const participants   = ctxLive?.participants || {};
  const targetMsg      = ctxLive?.message || null;
  const targetMsgId    = targetMsg?.id || null;

  // Center the target message in the thread list ONCE per item — the
  // moment the target row first paints. Resets when item.id changes so a
  // new item gets its own one-shot. After that, the operator's scroll is
  // theirs to control; we never auto-scroll again on re-renders.
  //
  // We set list.scrollTop directly rather than calling row.scrollIntoView,
  // because scrollIntoView with `block:'center'` walks every scrollable
  // ancestor — that includes the drawer body, so the page would also yank.
  // Touching scrollTop on the <ul> alone keeps the drawer scroll untouched.
  useEffect(() => {
    if (!targetMsgId) return;
    if (scrolledForItem.current === item.id) return;
    const list = threadListRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>('li[data-target="1"]');
    if (!row) return;
    list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.clientHeight) / 2);
    scrolledForItem.current = item.id;
  }, [item.id, targetMsgId, thread.length]);
  const serverRecipients = replyAction?.recipients || (replyAction?.recipient ? [replyAction.recipient] : []);

  // Ad-hoc recipient picked from the contact search. Lets the operator DM
  // someone who wasn't auto-resolved as the message sender — useful when the
  // person referenced in the digest item (e.g. "DM Ohad") differs from
  // whoever happened to post about them in the group, or when the sender id
  // came back as the group id (a known wa-gateway quirk for relayed messages).
  const [extraRecipient, setExtraRecipient] = useState<DigestRecipient | null>(null);
  // Search state for the inline contact picker.
  const [showContactSearch, setShowContactSearch] = useState(false);
  const [contactQuery, setContactQuery]           = useState('');
  const [contactResults, setContactResults]       = useState<Contact[]>([]);
  const [contactSearching, setContactSearching]   = useState(false);

  // Reset ad-hoc + search state whenever the drawer flips to a new digest
  // item — yesterday's pick of Ohad shouldn't leak into tomorrow's brief.
  useEffect(() => {
    setExtraRecipient(null);
    setShowContactSearch(false);
    setContactQuery('');
    setContactResults([]);
  }, [item.id]);

  // Debounced contact search — kicks 200ms after the operator stops typing
  // so we don't fire a request per keystroke.
  useEffect(() => {
    if (!showContactSearch || contactQuery.trim().length < 1) {
      setContactResults([]);
      return;
    }
    let alive = true;
    setContactSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const rows = await api.listContacts({ search: contactQuery.trim(), limit: 15 });
        if (alive) setContactResults(rows);
      } catch { /* swallow — surface via empty list */ }
      finally { if (alive) setContactSearching(false); }
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [contactQuery, showContactSearch]);

  // Stable per-render list: server-supplied recipients first, then the
  // ad-hoc one (only present if the operator picked it via the search box).
  const recipients: DigestRecipient[] = extraRecipient
    ? [...serverRecipients, extraRecipient]
    : serverRecipients;
  // Resolve which recipient is active. Three tiers, most specific first:
  //   1. `chosenRecipientId` — explicit per-row pick from the dropdown.
  //      Required when multiple recipients share a mode (OSINT items can
  //      surface several `reply_to_ask` or `group` candidates).
  //   2. `chosenMode` — legacy mode-only state used by the WA reply
  //      contact-picker side-effects. Still authoritative when no id
  //      pick has been made.
  //   3. First server recipient, then the replyAction's default.
  const activeRecipient = chosenRecipientId
    ? (recipients.find((r) => r.id === chosenRecipientId) || recipients[0] || replyAction?.recipient || null)
    : chosenMode
      ? (recipients.find((r) => r.mode === chosenMode && (chosenMode !== 'private' || !extraRecipient || r.id === extraRecipient.id))
         || recipients[recipients.length - 1] || recipients[0] || null)
      : (recipients[0] || replyAction?.recipient || null);

  // Turn a phone string like "+972 50-302-3702" into the WA chat id
  // 972503023702@c.us that wa-gateway expects.
  function phoneToWaId(phone: string): string | null {
    const digits = (phone || '').replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 16) return null;
    return `${digits}@c.us`;
  }

  function pickContact(c: Contact) {
    if (!c.phone) {
      setError(`${c.full_name || 'Contact'} has no phone on file — add one in Contacts before DMing.`);
      return;
    }
    const waId = phoneToWaId(c.phone);
    if (!waId) {
      setError(`Phone "${c.phone}" doesn't parse as a WhatsApp id.`);
      return;
    }
    const r: DigestRecipient = {
      kind: 'wa_chat',
      mode: 'private',
      id:    waId,
      name:  c.full_name || c.phone,
      label: `DM ${c.full_name || c.phone}`,
    };
    setExtraRecipient(r);
    setChosenMode('private');
    setShowContactSearch(false);
    setContactQuery('');
    setContactResults([]);
    setError(null);
  }

  const [wishlisted, setWishlisted] = useState(false);
  async function addToWishlist(a: DigestAction) {
    setBusy('add_to_wishlist'); setError(null);
    try {
      const r = await api.executeDigestAction(item.id, {
        type: 'add_to_wishlist',
        metadata: a.metadata,
      });
      const name  = r.contact?.full_name  || a.metadata?.full_name || 'contact';
      const extra = [
        r.contact?.linkedin_url ? 'LinkedIn' : null,
        r.contact?.email ? 'email' : null,
        r.contact?.phone ? 'phone' : null,
      ].filter(Boolean).join(' · ');
      setDoneMsg(extra ? `★ ${name} saved (${extra}).` : `★ ${name} saved.`);
      setWishlisted(true);
      onChange();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

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
        aria-label="Digest item actions"
      >
        {/* Header */}
        <header className="px-5 h-12 border-b border-line flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={
              'h-1.5 w-1.5 rounded-full shrink-0 ' +
              (item.urgency === 1 ? 'bg-rose-500' : item.urgency === 2 ? 'bg-amber-500' : 'bg-stone-400')
            } />
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute truncate">{item.source_label || 'digest item'}</span>
            {loadStartedAt && (
              <span className="inline-flex items-center gap-1.5 ml-2 mono text-[10px] uppercase tracking-[0.18em] text-ink">
                <Sparkle size={11} className="animate-spin" />
                drafting · {elapsed}s
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Star — mark person as interesting. Stays gold once clicked,
                so the operator gets immediate confirmation it was saved.
                Hover tooltip explains exactly what's persisted. */}
            {wishlistAction && (
              <div className="relative group">
                <button
                  onClick={() => addToWishlist(wishlistAction)}
                  disabled={busy === 'add_to_wishlist' || wishlisted}
                  aria-label="Mark as interesting"
                  className={
                    'h-8 w-8 grid place-items-center rounded-sm transition ' +
                    (wishlisted
                      ? 'text-amber-500'
                      : 'text-mute hover:text-amber-500 hover:bg-card/70')
                  }
                >
                  <Star size={16} className={wishlisted ? 'fill-current' : ''} />
                </button>
                <div
                  role="tooltip"
                  className="absolute right-0 top-full mt-2 w-72 z-50 hidden group-hover:block pointer-events-none"
                >
                  <div className="rounded-sm bg-ink text-paper text-[11px] leading-relaxed px-3 py-2 shadow-[0_8px_30px_-8px_rgba(10,10,10,0.4)]">
                    <div className="mono text-[10px] uppercase tracking-[0.18em] text-paper/60 mb-1">
                      {wishlisted ? 'saved ★' : 'mark as interesting'}
                    </div>
                    {wishlisted ? (
                      <div>Already in Contacts with the <span className="mono">wishlist</span> tag. Click stays disabled to avoid duplicates.</div>
                    ) : (
                      <>
                        <div>
                          Adds <span dir="auto" className="font-medium">{wishlistAction.metadata?.full_name || 'this person'}</span> to Contacts as a prospect tagged <span className="mono">wishlist</span>.
                        </div>
                        <ul className="mt-1.5 space-y-0.5 text-paper/80">
                          {wishlistAction.metadata?.phone && (
                            <li>· phone <span className="mono">{wishlistAction.metadata.phone}</span></li>
                          )}
                          {wishlistAction.metadata?.linkedin_url && (
                            <li>· LinkedIn auto-attached</li>
                          )}
                          {wishlistAction.metadata?.email && (
                            <li>· email <span className="mono">{wishlistAction.metadata.email}</span></li>
                          )}
                          <li>· digest context saved as notes</li>
                        </ul>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
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
          {/* Item summary — an LI signal renders the post as LinkedIn shows it */}
          <section>
            <h2 dir="auto" className="text-[15px] font-semibold leading-snug text-ink">{item.title}</h2>
            {(() => {
              if (item.kind !== 'li_signal' || !item.meta_json) return null;
              try {
                const m = JSON.parse(item.meta_json) as { signal_id?: string; name?: string; role?: string | null; company?: string | null; detail?: unknown };
                if (!m?.name || !m?.detail) return null;
                return (
                  <div className="mt-3">
                    <LiEngageRow key={m.signal_id || item.id} item={item} meta={m} onChange={onChange} />
                  </div>
                );
              } catch { return null; }
            })()}
            {item.summary && item.kind !== 'li_signal' && (
              <p dir="auto" className="text-[13px] text-mute mt-2 leading-relaxed whitespace-pre-wrap">
                <LinkedInText text={item.summary} />
              </p>
            )}
            {item.suggested_action && (
              <div dir="auto" className="mt-3 inline-flex items-center mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2 py-1">
                → {item.suggested_action}
              </div>
            )}
            {item.source_url && (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink transition"
              >
                Open original article ↗
              </a>
            )}
          </section>

          {/* Thread context — last 8 messages, oldest first. The exact
              message the reply will quote is highlighted in amber so the
              operator knows what they're responding to. Participants are
              resolved against contacts (name + LinkedIn badge) instead of
              raw WA ids. */}
          {thread.length > 0 && (
            <section>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2 flex items-center gap-2">
                <span>Recent thread · {thread.length}</span>
                {targetMsgId && (
                  <span className="text-amber-700">· ↪ reply target highlighted</span>
                )}
              </div>
              <ul ref={threadListRef} className="hairline rounded-sm bg-card/60 divide-y divide-line max-h-[300px] overflow-y-auto">
                {thread.slice(-20).map((m, i) => {
                  const isTarget = !!targetMsgId && m.id === targetMsgId;
                  const p = m.sender_id ? participants[m.sender_id] : null;
                  const name = displayName(m, participants);
                  return (
                    <li
                      key={m.id + ':' + i}
                      data-target={isTarget ? '1' : undefined}
                      className={
                        'px-3 py-2 text-[12px] relative ' +
                        (isTarget
                          ? 'bg-amber-100 dark:bg-amber-500/15 border-l-4 border-l-amber-500 shadow-[inset_0_0_0_1px_var(--color-amber-500,#f59e0b)]'
                          : '')
                      }
                    >
                      {/* No "↪ replying to this message" header here — the
                          standalone target-message card below is the canonical
                          pin. Inside the thread we only mark the row in amber
                          so the operator's eye lands on it during scan. */}
                      <div className="mono text-[10px] text-mute mb-0.5 flex items-baseline gap-1.5 flex-wrap">
                        <span dir="auto" className={m.from_me ? '' : 'text-ink font-medium'}>{name}</span>
                        {p?.linkedin_url && (
                          <a
                            href={p.linkedin_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={`${name} on LinkedIn`}
                            className="inline-flex items-center align-middle px-1 h-4 rounded-sm bg-[#0a66c2]/10 hover:bg-[#0a66c2]/20 text-[#0a66c2] transition"
                          >
                            <LinkedIn size={10} />
                          </a>
                        )}
                        <span>·</span>
                        <span>{new Date(m.timestamp).toLocaleString()}</span>
                      </div>
                      <div dir="auto" className={'text-ink leading-relaxed whitespace-pre-wrap break-words ' + (isTarget ? 'font-medium' : '')}>
                        {m.body ? <LinkedInText text={m.body} /> : <span className="text-mute">[empty]</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Target message — the exact message the reply will quote. Renders
              as soon as the cheap context call returns, BEFORE the slow LLM
              draft lands. Always sits directly above the reply card so the
              operator knows what they're responding to without scrolling. */}
          {targetMsg && (
            <section className="rounded-sm bg-amber-100 dark:bg-amber-500/15 border-l-4 border-l-amber-500 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.4)] p-4 space-y-2">
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-amber-800 dark:text-amber-300 font-semibold flex items-center gap-1">
                ↪ Replying to this message
              </div>
              <div className="mono text-[10px] text-mute flex items-baseline gap-1.5 flex-wrap">
                <span dir="auto" className="text-ink font-medium">
                  {displayName({ from_me: targetMsg.from_me, sender_id: targetMsg.sender_id, sender_name: targetMsg.sender_name }, participants)}
                </span>
                {targetMsg.sender_id && participants[targetMsg.sender_id]?.linkedin_url && (
                  <a
                    href={participants[targetMsg.sender_id].linkedin_url!}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="LinkedIn"
                    className="inline-flex items-center align-middle px-1 h-4 rounded-sm bg-[#0a66c2]/10 hover:bg-[#0a66c2]/20 text-[#0a66c2]"
                  >
                    <LinkedIn size={10} />
                  </a>
                )}
                <span>·</span>
                <span>{new Date(targetMsg.timestamp).toLocaleString()}</span>
                {ctxLive?.chat?.name && (
                  <>
                    <span>·</span>
                    <span dir="auto" className="text-mute">{ctxLive.chat.name}</span>
                  </>
                )}
              </div>
              <div dir="auto" className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap break-words">
                {targetMsg.body ? <LinkedInText text={targetMsg.body} /> : <span className="text-mute">[empty message]</span>}
              </div>
            </section>
          )}

          {/* Loading state — skeleton card so the user sees something where
              the reply action will land. Pulses while the LLM drafts. */}
          {!data && !error && (
            <section className="hairline rounded-sm bg-card/60 p-4 space-y-3 animate-pulse">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <MessageSquare size={14} />
                Drafting reply…
              </div>
              <div className="text-[11px] text-mute">
                Nyo is reading the thread and writing a reply in your voice. Usually 5–15 seconds.
                {elapsed > 20 && <span className="text-rose-700"> Taking longer than usual ({elapsed}s) — provider may be slow.</span>}
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-3/4 bg-line/80 rounded-sm" />
                <div className="h-3 w-full bg-line/60 rounded-sm" />
                <div className="h-3 w-5/6 bg-line/60 rounded-sm" />
                <div className="h-3 w-2/3 bg-line/40 rounded-sm" />
              </div>
              <div className="mono text-[10px] uppercase tracking-[0.18em] text-mute">elapsed · {elapsed}s</div>
            </section>
          )}

          {/* Reply action */}
          {replyAction && (
            <section className="hairline rounded-sm bg-card/60 p-4 space-y-3">
              <div>
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <MessageSquare size={14} />
                  {replyAction.label}
                </div>
              </div>

              {/* Recipient picker — compact native dropdown, ALWAYS shown so
                  the operator can override even on items where the server
                  only resolved one recipient. The last option ("DM another
                  contact…") expands a search box; picking a contact adds
                  them to the recipients list as an ad-hoc private DM. The
                  LLM-recommended mode renders with a small ★ suggested tag. */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">
                    deliver to
                  </label>
                  <select
                    value={
                      extraRecipient && activeRecipient?.id === extraRecipient.id
                        ? `extra:${extraRecipient.id}`
                        : (activeRecipient ? `rcpt:${activeRecipient.mode}:${activeRecipient.id}` : 'rcpt:group:')
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__pick_contact__') {
                        setShowContactSearch(true);
                        return;
                      }
                      if (v.startsWith('extra:')) {
                        // Already selected the ad-hoc one — no-op.
                        return;
                      }
                      if (v.startsWith('rcpt:')) {
                        // Composite value `rcpt:<mode>:<id>` — derive both
                        // pieces so chosenRecipientId disambiguates same-mode
                        // entries while chosenMode keeps the existing WA
                        // contact-picker side-effects working.
                        const rest    = v.slice('rcpt:'.length);
                        const colon   = rest.indexOf(':');
                        const mode    = (colon >= 0 ? rest.slice(0, colon) : rest) as DigestRecipientMode;
                        const rcptId  = colon >= 0 ? rest.slice(colon + 1) : '';
                        setExtraRecipient(null);
                        setChosenMode(mode);
                        setChosenRecipientId(rcptId || null);
                        return;
                      }
                      // Legacy fallback — bare-mode value from older flows.
                      setExtraRecipient(null);
                      setChosenMode(v as DigestRecipientMode);
                      setChosenRecipientId(null);
                    }}
                    className="h-8 px-2 pr-7 rounded-sm hairline bg-paper text-ink text-[12px] focus:border-ink focus:outline-none transition min-w-0 max-w-full"
                  >
                    {serverRecipients.map((r) => (
                      <option key={r.mode + ':' + r.id} value={`rcpt:${r.mode}:${r.id}`}>
                        {/* Prefer the server-supplied label (which already
                            encodes who/where, e.g. "Reply to Ohad's question
                            in IEC"). Fall back to a generic mode/name
                            descriptor for legacy recipients without one. */}
                        {r.label || (r.mode === 'group' ? `In group · ${r.name}` : r.mode === 'private' ? `Private DM · ${r.name}` : `${r.mode} · ${r.name}`)}
                        {replyAction.recommended_mode === r.mode && activeRecipient?.id === r.id ? '   ★ suggested' : ''}
                      </option>
                    ))}
                    {extraRecipient && (
                      <option value={`extra:${extraRecipient.id}`}>
                        Private DM · {extraRecipient.name}   (picked)
                      </option>
                    )}
                    <option value="__pick_contact__">DM another contact…</option>
                  </select>
                  {replyAction.recommended_reason && (
                    <span
                      className="mono text-[10px] uppercase tracking-[0.18em] text-amber-700 cursor-help"
                      title={`Nyo's pick: ${replyAction.recommended_reason}`}
                    >
                      ★ why?
                    </span>
                  )}
                </div>

                {/* Inline contact picker — collapses back once a contact is
                    chosen or the operator hits ✕. Searches contacts by
                    name/email/phone via the existing /api/contacts?search=. */}
                {showContactSearch && (
                  <div className="rounded-sm hairline bg-paper p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={contactQuery}
                        onChange={(e) => setContactQuery(e.target.value)}
                        placeholder="Type a name to DM…"
                        className="flex-1 h-7 px-2 rounded-sm hairline bg-card text-[12px] focus:border-ink focus:outline-none"
                      />
                      <button
                        onClick={() => { setShowContactSearch(false); setContactQuery(''); setContactResults([]); }}
                        className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink px-2"
                        title="Cancel"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="max-h-44 overflow-y-auto">
                      {contactSearching && (
                        <div className="text-[11px] text-mute italic px-1 py-1">Searching…</div>
                      )}
                      {!contactSearching && contactQuery && contactResults.length === 0 && (
                        <div className="text-[11px] text-mute italic px-1 py-1">No matches.</div>
                      )}
                      {contactResults.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => pickContact(c)}
                          disabled={!c.phone}
                          className={
                            'w-full text-left px-2 py-1.5 rounded-sm text-[12px] flex items-center gap-2 transition ' +
                            (c.phone ? 'hover:bg-card text-ink' : 'text-mute cursor-not-allowed')
                          }
                          title={c.phone ? `DM ${c.full_name} on WhatsApp` : 'No phone on file — add one in Contacts first'}
                        >
                          <span className="flex-1 truncate">{c.full_name || '(no name)'}</span>
                          <span className="mono text-[10px] text-mute shrink-0">{c.phone || 'no phone'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <textarea
                dir="auto"
                value={drafts.reply_wa ?? ''}
                onChange={(e) => setDrafts({ ...drafts, reply_wa: e.target.value })}
                rows={6}
                placeholder={replyAction.draft ? '' : 'Drafting…'}
                className="w-full resize-y rounded-sm hairline bg-paper px-3 py-2 text-[13px] leading-relaxed focus:border-ink focus:outline-none transition"
              />
              <div className="flex items-center justify-between">
                <div className="mono text-[10px] uppercase tracking-[0.18em] text-mute">
                  → {activeRecipient?.label || activeRecipient?.name || replyAction.recipient?.name || '?'}
                </div>
                <div className="min-w-0 flex-1 max-w-[420px]">
                  <WaSlotPicker
                    busy={busy === 'reply_wa'}
                    disabled={!drafts.reply_wa?.trim()}
                    phone={(activeRecipient || replyAction.recipient)?.id || null}
                    onSend={(atMs) => approveSend(replyAction, atMs)}
                    onOpenWa={() => {
                      const digits = String((activeRecipient || replyAction.recipient)?.id || '').replace(/\D/g, '');
                      if (!digits) return;
                      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(drafts.reply_wa || '')}`, '_blank');
                      api.digestWaManual(item.id, drafts.reply_wa || '')
                        .then(() => setDoneMsg('Sent by hand — counted in today\'s KPI.'))
                        .catch(() => {});
                    }}
                  />
                </div>
              </div>
            </section>
          )}

          {/* cmd's Draft-a-blog / Draft-a-take / Draft-a-social sections are
              not part of this pack: those pipelines live in the editorial
              pack. Turn a news card into content from its Blog / Social /
              Hot Takes surfaces instead. */}

          {/* Discuss with Nyo */}
          <section className="hairline rounded-sm bg-card/60 p-4 space-y-2">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <Sparkle size={14} />
              Discuss with Nyo
            </div>
            <p className="text-[11px] text-mute">
              Open this item in the full Nyo chat. Useful when you want a richer take, want to combine with other context, or need Nyo to fan-out into multiple tools.
            </p>
            <button
              onClick={discussWithNyo}
              disabled={busy === 'discuss'}
              className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm hairline text-ink hover:bg-card transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
            >
              {busy === 'discuss' ? 'opening…' : 'open in nyo →'}
            </button>
          </section>

          {/* Dismiss */}
          <section className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={dismiss}
              disabled={busy === 'dismiss'}
              className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm text-mute hover:text-rose-700 hover:bg-rose-50 transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
            >
              <Trash size={12} />
              {busy === 'dismiss' ? 'dismissing…' : 'mark read'}
            </button>
          </section>

          {error && (
            <div className="hairline rounded-sm bg-rose-50 text-rose-800 text-[12px] px-3 py-2">{error}</div>
          )}
          {doneMsg && doneQueueId ? (
              <button
                type="button"
                onClick={async () => {
                  const r = await api.digestWaUnschedule(item.id).catch((e) => ({ error: String(e) }));
                  if (!r.error) { setDoneMsg('Cancelled — nothing will send.'); setDoneQueueId(null); }
                }}
                className="mono text-[10px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm hairline text-mute hover:text-red-600 transition"
              >
                ✕ unschedule
              </button>
            ) : null}
            {doneMsg && (
            <div className="hairline rounded-sm bg-emerald-50 text-emerald-800 text-[12px] px-3 py-2">{doneMsg}</div>
          )}
        </div>
      </aside>
    </>
  );
}
