// Outreach — approach the prospects Prospecting surfaced (GTM plugin surface).
//
// ONE screen: a WhatsApp inbox filtered to PROSPECTS, reading like the phone
// app. Split three ways: ACTIVE (they answered), UNANSWERED (only our messages)
// and DEAD (retired by hand, or silent for weeks); FRESH prospects nobody has
// messaged yet appear too, so a first touch starts here. Default shows Active
// only; "see all" widens it. Opening one puts the thread in the middle, and on
// the right the suggested message OFFERED beside it plus the prospect card. The
// composer stays the operator's own — a suggestion only lands there if they
// pick it up, and from there it goes out now or waits in the queue.
//
// Thin client over the GTM pack's OWN tools via /api/plugins/gtm/invoke/* —
// the same tools Nyo drives. Sending goes through send_prospect_message,
// which rides the outbox-audited whatsapp gateway send.
//
// SENDING is the only part that needs WhatsApp. The threads, the prospects and
// the drafted messages all live in this database, so without the gateway the
// module still opens and still works as a reading-and-writing surface — it says
// sending is off and keeps the send controls off, rather than queueing messages
// that will fail at the boundary.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type OutreachThread, type OutreachThreadDetail, type OutreachDraft, type OutreachProspect,
  type OutreachStatus, type OutreachCounts,
} from './outreach-data';
import { WhatsApp, Search, Send, Sparkle, Refresh, LinkedIn, User, X } from '../../components/Icons';
import { ScheduleSend, fmtWhen, epochForWall, toWallInput, type ScheduleDefaults, type ScheduleSendHandle } from './ScheduleSend';
import { useModulePrereqs } from '../../lib/module-status';
import { ModuleSetupGate } from '../../components/ModuleSetupGate';
import { DegradedNotice, ModuleStatusHold } from '../../components/DegradedNotice';


// ── local snapshot cache: paint instantly, revalidate in the background ─────
// The sidebar list and recently-opened conversations are mirrored into
// localStorage, so reopening the module never starts from an empty screen —
// the snapshot renders at once and the live fetch replaces it when it lands.
const LIST_CACHE = 'nyyon.outreach.threads.v1';
const THREAD_CACHE = 'nyyon.outreach.thread.v1:';
const THREAD_CACHE_INDEX = 'nyyon.outreach.thread.v1.index';
const THREAD_CACHE_MAX = 15;
function cacheRead<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function cacheWrite(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked — cache is best-effort */ }
}
function cacheThreadDetail(chatId: string, d: OutreachThreadDetail) {
  cacheWrite(THREAD_CACHE + chatId, { ...d, messages: (d.messages || []).slice(-80) });
  const idx = (cacheRead<string[]>(THREAD_CACHE_INDEX) || []).filter((id) => id !== chatId);
  idx.push(chatId);
  while (idx.length > THREAD_CACHE_MAX) {
    const evict = idx.shift();
    if (evict) { try { localStorage.removeItem(THREAD_CACHE + evict); } catch { /* noop */ } }
  }
  cacheWrite(THREAD_CACHE_INDEX, idx);
}
const CARD = 'hairline rounded-sm bg-card';
const LABEL = 'mono text-[9px] uppercase tracking-[0.2em] text-mute';
// Matches the Prospecting toolbar buttons so the two sheets read as one system.
const btnQ = 'h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition bg-card text-mute hover:text-ink disabled:opacity-40';

// ── time formatting — the phone app's rules ────────────────────────────────
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function listStamp(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hhmm(ts);
  const days = Math.floor((now.getTime() - ts) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return DAYS[d.getDay()];
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}
function dayDivider(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── avatar — photo when we have one, else a tinted initial (deterministic, so
// a person keeps the same colour across renders).
const TINTS = [
  'bg-violet-500/15 text-violet-600', 'bg-sky-500/15 text-sky-600',
  'bg-emerald-500/15 text-emerald-600', 'bg-amber-500/15 text-amber-600',
  'bg-rose-500/15 text-rose-600', 'bg-teal-500/15 text-teal-600',
];
function tintOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}
function Avatar({ name, photo, size = 40 }: { name: string | null; photo?: string | null; size?: number }) {
  const label = (name || '?').trim();
  const initial = label.charAt(0).toUpperCase() || '?';
  if (photo) {
    return (
      <img
        src={photo} alt="" width={size} height={size}
        className="rounded-full object-cover shrink-0 hairline"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={`rounded-full shrink-0 flex items-center justify-center font-semibold ${tintOf(label)}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

const FIT_TONE: Record<string, string> = {
  strong: 'text-emerald-600 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-600 border-amber-500/30 bg-amber-500/10',
  weak:   'text-mute border-[var(--color-line)] bg-transparent',
};

// The three states a conversation can be in, and how each reads at a glance.
const STATUS_CHIP: Record<OutreachStatus, string> = {
  active: 'text-emerald-600 border-emerald-500/30 bg-emerald-500/10',
  unanswered: 'text-mute border-[var(--color-line)] bg-transparent',
  dead: 'text-rose-600/70 border-rose-500/25 bg-rose-500/5',
  // fresh = fully enriched in Prospecting, no conversation yet — ready for a first touch
  fresh: 'text-sky-600 border-sky-500/30 bg-sky-500/10',
  // scheduled = a queued send is waiting to fire (same chip as unanswered's
  // spot in the row, tinted like the ⏲ strip)
  scheduled: 'text-sky-700 border-sky-500/30 bg-sky-500/10',
};

// ── the conversation list ──────────────────────────────────────────────────
function ThreadRow({ t, active, onOpen }: { t: OutreachThread; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        'w-full text-left px-3 py-2.5 flex items-start gap-3 transition border-b border-[var(--color-line)] ' +
        (active ? 'bg-paper' : 'hover:bg-paper/60')
      }
    >
      <Avatar name={t.name} photo={t.photo} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-[13px] truncate flex-1">{t.name || t.chat_id.split('@')[0]}</span>
          <span className={'mono text-[9px] shrink-0 ' + (t.uncaught ? 'text-emerald-600' : 'text-mute')}>
            {listStamp(t.last_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {/* The list has no delivery status, so it shows the neutral single
              tick — "the last message here was ours", nothing stronger. */}
          {t.last_from_me === true && <span className="mono text-[9px] text-mute shrink-0">✓</span>}
          <span dir="auto" className="text-[12px] text-mute truncate flex-1">
            {t.scheduled_text ? `⏲ ${t.scheduled_text}` : t.never_messaged ? 'No messages yet' : (t.last_text || '—')}
          </span>
          {t.uncaught && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="They spoke last" />}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {t.company && <span className="mono text-[9px] text-mute truncate max-w-[45%]">{t.company}</span>}
          {/* Only worth stating when it is NOT the default view's status. */}
          {t.status !== 'active' && (
            <span
              className={`mono text-[8px] uppercase tracking-[0.14em] px-1 py-px rounded-sm border ${STATUS_CHIP[t.status]}`}
              title={t.status === 'dead'
                ? (t.dead_by === 'marked' ? `Marked dead${t.dead_reason ? ` — ${t.dead_reason}` : ''}` : 'No activity for weeks')
                : 'We have written, they have not answered yet'}
            >
              {t.status}
            </span>
          )}
          {t.icp_fit && (
            <span className={`mono text-[8px] uppercase tracking-[0.14em] px-1 py-px rounded-sm border ${FIT_TONE[t.icp_fit] || FIT_TONE.weak}`}>
              {t.icp_fit}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ── the prospect context card ──────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)]">
      <div className={LABEL}>{label}</div>
      <div className="text-[12px] mt-1 break-words">{children}</div>
    </div>
  );
}

function ProspectCard({ p, onClose }: { p: OutreachProspect; onClose?: () => void }) {
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 py-3 border-b border-[var(--color-line)] flex items-start gap-3">
        <Avatar name={p.name} photo={p.photo} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[13px] truncate">{p.name || 'Unknown'}</div>
          {p.position && <div className="text-[11px] text-mute truncate">{p.position}</div>}
          {p.company && <div className="text-[11px] truncate">{p.company}</div>}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-mute hover:text-ink shrink-0 lg:hidden" aria-label="Close context">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="overflow-y-auto min-h-0 flex-1">
        {p.icp_fit && (
          <Field label="ICP fit">
            <span className={`mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border ${FIT_TONE[p.icp_fit] || FIT_TONE.weak}`}>
              {p.icp_fit}
            </span>
            {p.icp_reasons.length > 0 && (
              <ul className="mt-2 space-y-1 text-mute">
                {p.icp_reasons.slice(0, 5).map((r, i) => <li key={i}>· {r}</li>)}
              </ul>
            )}
            {p.icp_gaps.length > 0 && (
              <ul className="mt-2 space-y-1 text-mute">
                {p.icp_gaps.slice(0, 4).map((g, i) => <li key={i} className="opacity-70">gap · {g}</li>)}
              </ul>
            )}
          </Field>
        )}

        {(p.company_staff_count != null || p.company_linkedin || p.company_summary || p.company_industry || p.company_site) && (
          <Field label="Company">
            {p.company_summary && <div>{p.company_summary}</div>}
            {(p.company_industry || p.company_hq) && (
              <div className="text-mute mt-1">{[p.company_industry, p.company_hq].filter(Boolean).join(' · ')}</div>
            )}
            {p.company_staff_count != null && <div className="mt-1">{p.company_staff_count.toLocaleString()} employees</div>}
            {p.company_site && (
              <a href={p.company_site} target="_blank" rel="noreferrer" className="block mt-1 text-sky-600 hover:underline truncate">
                {p.company_site.replace(/^https?:\/\/(www\.)?/, '')}
              </a>
            )}
            {p.company_linkedin && (
              <a href={p.company_linkedin} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-1 text-sky-600 hover:underline">
                <LinkedIn size={11} /> company page
              </a>
            )}
          </Field>
        )}

        <Field label="Reach">
          <div className="space-y-1">
            {p.phone && (
              <div>
                <a
                  href={`https://wa.me/${String(p.phone).replace(/[^\d]/g, '')}`}
                  target="_blank" rel="noreferrer"
                  className="mono text-[11px] text-sky-600 hover:underline"
                  title="Open WhatsApp chat"
                >{p.phone}</a>
              </div>
            )}
            {p.email && <div className="break-all">{p.email}</div>}
            {p.linkedin && (
              <div>
                <a href={p.linkedin} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-600 hover:underline">
                  <LinkedIn size={11} /> profile
                </a>
              </div>
            )}
            {(p.country || p.region) && <div className="text-mute">{[p.region, p.country].filter(Boolean).join(', ')}</div>}
          </div>
        </Field>

        <div className="px-3 py-2">
          <div className={LABEL}>Lead</div>
          <div className="mono text-[10px] text-mute mt-1 break-all">{p.lead_id}</div>
        </div>
      </div>
    </div>
  );
}

// ── the suggested message ──────────────────────────────────────────────────
// Offered alongside the conversation, never typed into the box for you. The
// operator reads it, then chooses: use it as-is, redraft, or ignore it and
// write their own. On a first touch it is the GTM angle they already approved;
// once the prospect has replied it is composed from that angle plus the thread.
function DraftPanel({ draft, drafting, inBox, onUse, onRedraft }: {
  draft: OutreachDraft | null;
  drafting: boolean;
  inBox: boolean;
  onUse: (body: string) => void;
  onRedraft: () => void;
}) {
  // Say which of the two it is, because they carry different trust: an angle
  // bubble is text the operator already approved, a composed reply is not.
  const label = drafting ? 'drafting…'
    : draft?.source === 'angle'
      ? (draft.first_touch ? 'approved GTM angle · first touch' : `approved GTM angle · follow-up ${(draft.step ?? 0) + 1}`)
    : draft?.source === 'llm' ? `composed reply${draft.based_on_messages ? ` · from ${draft.based_on_messages} messages` : ''}`
    : draft?.source === 'template' ? 'default first touch · outreach-first-touch doc'
    : 'no suggestion';

  return (
    <div className="shrink-0 border-b border-[var(--color-line)]">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <Sparkle size={11} />
        <span className={LABEL}>suggested</span>
        <button
          type="button"
          onClick={onRedraft}
          disabled={drafting}
          className="ml-auto inline-flex items-center gap-1 mono text-[9px] uppercase tracking-[0.16em] text-mute hover:text-ink disabled:opacity-40"
          title="Compose a different suggestion"
        >
          <Refresh size={10} /> redraft
        </button>
      </div>
      <div className="px-3 pb-1"><span className="mono text-[9px]/[14px] text-mute">{label}</span></div>

      <div className="px-3 pb-3">
        {drafting && <div className="text-[12px] text-mute py-2">Thinking…</div>}

        {!drafting && draft?.draft && (
          <>
            <div dir="auto" className="text-[12px] leading-relaxed rounded-sm hairline bg-paper px-2.5 py-2 whitespace-pre-wrap break-words max-h-44 overflow-y-auto">
              {draft.draft}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={() => onUse(draft.draft || '')}
                disabled={inBox}
                className="h-7 px-3 rounded-sm mono text-[9px] uppercase tracking-[0.16em] bg-ink text-paper disabled:opacity-40 transition"
                title={inBox ? 'Already in the composer' : 'Put this in the composer to edit or send'}
              >
                {inBox ? 'in the box' : 'use this'}
              </button>
              {draft.angle?.rationale && (
                <span className="text-[10px] text-mute truncate flex-1" title={draft.angle.rationale}>
                  {draft.angle.rationale}
                </span>
              )}
            </div>
            {/* The rest of the approved angle's bubbles, available to put in
                the composer one at a time. */}
            {!!draft.alternatives?.length && (
              <div className="mt-3">
                <div className={LABEL}>then</div>
                {draft.alternatives.map((alt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onUse(alt)}
                    className="w-full text-left text-[11px] text-mute hover:text-ink mt-1.5 leading-snug"
                    title="Put this one in the composer instead"
                  >
                    · {alt}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {!drafting && !draft?.draft && (
          <div className="text-[11px] text-mute leading-relaxed py-1">
            {draft?.reason || 'Nothing to suggest here yet.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── the conversation ───────────────────────────────────────────────────────
function Bubble({ m, prev }: { m: OutreachThreadDetail['messages'][number]; prev?: OutreachThreadDetail['messages'][number] }) {
  const showDay = !prev || dayDivider(prev.at) !== dayDivider(m.at);
  return (
    <>
      {showDay && (
        <div className="flex justify-center my-3">
          <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute px-2 py-1 rounded-sm bg-card hairline">
            {dayDivider(m.at)}
          </span>
        </div>
      )}
      <div className={'flex mb-1.5 ' + (m.from_me ? 'justify-end' : 'justify-start')}>
        {/* dir="auto": the FIRST strong letter decides the direction, so a
            Hebrew message reads right-to-left and an English one left-to-
            right, correctly aligned, even in the same conversation */}
        <div
          dir="auto"
          className={
            'max-w-[76%] px-2.5 py-1.5 rounded-lg text-[13px] leading-snug whitespace-pre-wrap break-words ' +
            (m.from_me
              ? 'bg-emerald-500/15 rounded-br-sm'
              : 'bg-card hairline rounded-bl-sm')
          }
        >
          {m.body}
          <span className="mono text-[9px] text-mute ml-2 align-bottom float-right mt-1.5">
            {m.at ? hhmm(m.at) : ''}
            {/* One tick = we asked WhatsApp to send it. Two = WhatsApp echoed
                it back. Never claim delivery we cannot actually see. */}
            {m.from_me && (
              <span
                className={m.status === 'confirmed' ? 'text-sky-500' : 'text-mute'}
                title={m.status === 'confirmed' ? 'WhatsApp confirmed this went out' : 'Sent to WhatsApp — no confirmation echo yet'}
              >
                {' '}{m.status === 'confirmed' ? '✓✓' : '✓'}
              </span>
            )}
          </span>
        </div>
      </div>
    </>
  );
}

// Every bucket at zero. Used both for the cold-open state and whenever the
// server answers without a `counts` block (an empty inbox does exactly that) —
// the header reads counts.* unguarded, so a missing block would blank the page.
const ZERO_COUNTS: OutreachCounts = { active: 0, unanswered: 0, dead: 0, fresh: 0, scheduled: 0 };

function Conversations({ sendOff, sendOffWhy }: { sendOff: boolean; sendOffWhy: string }) {
  // Hydrate from the local snapshot so the module never opens empty; the
  // first live fetch replaces it within a second or two.
  const [threads, setThreads] = useState<OutreachThread[] | null>(
    () => cacheRead<{ threads: OutreachThread[] }>(LIST_CACHE)?.threads ?? null,
  );
  const [counts, setCounts] = useState<OutreachCounts>(
    () => cacheRead<{ counts: OutreachCounts }>(LIST_CACHE)?.counts ?? ZERO_COUNTS,
  );
  // Default view is the live conversations only. "See all" widens it to the
  // one-sided and the dead, which is a review activity, not the daily one.
  const [seeAll, setSeeAll] = useState(false);
  const [marking, setMarking] = useState(false);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OutreachThreadDetail | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState<OutreachDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false); // mobile context drawer

  // Schedule-first composer: the default action queues the message for a
  // time picked in the ScheduleSend popover (presets come from the
  // gtm-schedule knowledge doc); send-now is the secondary action. Pending
  // schedules show above the box.
  const [schedules, setSchedules] = useState<{ id: string; bubbles: string[]; send_at: number; status: string; error?: string | null }[]>([]);
  const [schedDefaults, setSchedDefaults] = useState<ScheduleDefaults | null>(null);
  // which lead the strip belongs to — guards stale responses on fast switching
  const schedFor = useRef<string | null>(null);
  const schedRef = useRef<ScheduleSendHandle | null>(null);
  async function loadSchedules(leadId: string) {
    try {
      const r = await api.gtmSchedules(leadId);
      if (schedFor.current !== leadId) return; // conversation changed while in flight
      setSchedules(r.schedules || []);
      if (r.defaults) setSchedDefaults(r.defaults);
    } catch { /* best-effort — the strip just stays empty */ }
  }

  // a scheduled entry the operator clicked open — full text + reschedule
  const [schedView, setSchedView] = useState<{ id: string; bubbles: string[]; send_at: number; status: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  // Which chat the composer's text belongs to, so a suggestion never overwrites
  // something already typed, and never leaks into the next conversation.
  const typedFor = useRef<string | null>(null);

  async function loadThreads() {
    try {
      // 'working' = everything except dead — an unanswered first touch stays
      // on screen; 'see all' only adds the dead pile.
      const r = await api.outreachWaThreads({ q, status: seeAll ? 'all' : 'working' });
      const c = r.counts ?? ZERO_COUNTS;
      setThreads(r.threads);
      setCounts(c);
      // snapshot only the default view — a search or see-all result would
      // paint the wrong list on the next cold open
      if (!q && !seeAll) cacheWrite(LIST_CACHE, { threads: r.threads, counts: c, at: Date.now() });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // Debounced so typing does not fire a request per keystroke; also re-runs
  // when the see-all toggle flips, since the filter is applied server-side.
  useEffect(() => {
    const h = setTimeout(() => { loadThreads(); }, 250);
    return () => clearTimeout(h);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [q, seeAll]);

  // Live picture: the sidebar re-pulls every 30s (each server read also
  // triggers the gateway's incremental sync, so this tracks the phone).
  useEffect(() => {
    const t = window.setInterval(() => { loadThreads(); }, 30000);
    return () => window.clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [q, seeAll]);

  // The open conversation re-reads every 10s. The composer's text lives in
  // its own state, so a refresh never touches what's being typed; the stale
  // guard keeps a slow response from painting the wrong chat.
  useEffect(() => {
    if (!openId) return;
    const t = window.setInterval(async () => {
      try {
        const d = await api.outreachWaThread({ chat_id: openId });
        if (!d.error) {
          setDetail((prev) => (prev && prev.chat_id === d.chat_id ? d : prev));
          cacheThreadDetail(openId, d);
        }
      } catch { /* transient — next tick retries */ }
    }, 10000);
    return () => window.clearInterval(t);
  }, [openId]);

  // Mark the open conversation dead (or revive it). Keyed by lead, so it holds
  // across every chat id that person has.
  async function toggleDead(leadId: string, dead: boolean) {
    setMarking(true); setErr(null);
    try {
      const r = await api.outreachMarkDead(leadId, dead);
      if (r.error) { setErr(r.error); return; }
      await loadThreads();
      // A revived conversation stays open; a killed one leaves the default view.
      if (dead && !seeAll) { setOpenId(null); setDetail(null); setDraft(null); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setMarking(false); }
  }

  async function openThread(chatId: string) {
    setOpenId(chatId);
    // paint the cached snapshot immediately; the live read replaces it
    const snap = cacheRead<OutreachThreadDetail>(THREAD_CACHE + chatId);
    setLoadingThread(!snap);
    setDetail(snap); setDraft(null); setErr(null);
    if (typedFor.current !== chatId) { setText(''); typedFor.current = null; }
    // a new conversation gets its own schedules strip
    const leadId = threads?.find((t) => t.chat_id === chatId)?.lead_id || null;
    schedFor.current = leadId;
    setSchedules([]);
    if (leadId) loadSchedules(leadId);
    try {
      const d = await api.outreachWaThread({ chat_id: chatId });
      if (d.error) { setErr(d.error); setLoadingThread(false); return; }
      setDetail(d);
      cacheThreadDetail(chatId, d);
      // the threads list is server-filtered, so the open chat may not be in
      // it — the prospect card is the authoritative lead id fallback
      if (!schedFor.current && d.prospect?.lead_id) {
        schedFor.current = d.prospect.lead_id;
        loadSchedules(d.prospect.lead_id);
      }
      suggest(chatId, false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThread(false);
    }
  }

  // The suggestion is OFFERED, never installed: it renders beside the thread
  // and only reaches the composer when the operator picks it up. The box stays
  // theirs, so what is about to be sent is always what they chose to write.
  async function suggest(chatId: string, force: boolean) {
    setDrafting(true);
    try {
      setDraft(await api.outreachDraft({ chat_id: chatId, force_llm: force }));
    } catch (e) {
      setDraft({ draft: null, source: 'none', reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setDrafting(false);
    }
  }

  function useDraft(body: string) {
    setText(body);
    typedFor.current = openId;
    boxRef.current?.focus();
  }

  async function send() {
    if (!openId || !text.trim() || sending || sendOff) return;
    setSending(true); setErr(null);
    try {
      const r = await api.waSend(openId, text.trim());
      if (r.error) { setErr(r.error); return; }
      setText(''); typedFor.current = null;
      // The send pre-inserts into wa_messages, so a re-read shows it at once.
      const d = await api.outreachWaThread({ chat_id: openId });
      if (!d.error) { setDetail(d); cacheThreadDetail(openId, d); }
      setDraft(null);
      loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // The lead behind the open conversation. The threads list is server-
  // filtered (search / see-all), so the open chat can drop out of it while
  // still on screen — the prospect card is the fallback.
  const openLeadId = () => open?.lead_id || detail?.prospect?.lead_id || null;

  // The DEFAULT action: queue the message for the time picked in the
  // popover. One live schedule per lead+content, atomic claim, no
  // auto-retry — it fires once or not at all, never twice.
  async function scheduleMsg(atMs: number) {
    const leadId = openLeadId();
    const body = text.trim();
    if (!body || sending || sendOff) return;
    if (!leadId) { setErr('this conversation has no linked prospect — scheduling needs one (send now still works)'); return; }
    if (!Number.isFinite(atMs) || atMs < Date.now()) { setErr('pick a future time to schedule'); return; }
    setSending(true); setErr(null);
    try {
      const r = await api.gtmSchedule(leadId, [body], atMs);
      if (r.error) { setErr(r.error); return; }
      setText(''); typedFor.current = null;
      setDraft(null);
      schedFor.current = leadId;
      loadSchedules(leadId);
      // the sidebar reflects the queued send IMMEDIATELY (optimistic patch),
      // then the server read confirms it
      setThreads((prev) => prev?.map((t) => t.lead_id === leadId
        ? { ...t, scheduled_text: body, scheduled_at: atMs, status: (t.status === 'fresh' || t.never_messaged) ? 'scheduled' as const : t.status }
        : t) ?? prev);
      loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function cancelSchedule(id: string) {
    try {
      const r = await api.gtmCancelSchedule(id);
      if (r.error) setErr(r.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    const leadId = schedFor.current || openLeadId();
    if (leadId) loadSchedules(leadId);
    loadThreads(); // a cancelled schedule leaves the sidebar right away
  }

  // Change a queued send's time: cancel the row, requeue the same text.
  // (The dup index only covers LIVE rows, so cancel-then-schedule is clean.)
  async function reschedule(sc: { id: string; bubbles: string[] }, atMs: number) {
    if (!Number.isFinite(atMs) || atMs < Date.now()) { setErr('pick a future time'); return; }
    const leadId = schedFor.current || openLeadId();
    setErr(null);
    try {
      const c = await api.gtmCancelSchedule(sc.id);
      if (c.error) { setErr(c.error); return; }
      const r = leadId
        ? await api.gtmSchedule(leadId, sc.bubbles, atMs)
        : { error: 'no linked prospect for this conversation' };
      if (r.error) setErr(`NOT rescheduled — the original was cancelled but requeueing failed: ${r.error}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSchedView(null);
      if (leadId) { schedFor.current = leadId; loadSchedules(leadId); }
      loadThreads();
    }
  }

  // Stick to the newest message whenever the thread changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.chat_id, detail?.count]);

  // Grow the composer to fit — a suggested draft is two or three sentences, and
  // a one-row box hides most of it behind a scrollbar.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text, openId]);

  const open = useMemo(() => threads?.find((t) => t.chat_id === openId) || null, [threads, openId]);
  const waiting = useMemo(() => (threads || []).filter((t) => t.uncaught).length, [threads]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {err && (
        <div className="mx-4 sm:mx-6 mt-3 px-3 py-2 rounded-sm border border-rose-500/30 bg-rose-500/10 text-[12px] text-rose-600">
          {err}
        </div>
      )}

      <div className="flex-1 min-h-0 px-4 sm:px-6 py-4">
        <div className={`${CARD} h-full min-h-0 flex overflow-hidden`}>

          {/* ── list ─────────────────────────────────────────────── */}
          <div className={
            'flex-col min-h-0 w-full lg:w-[320px] lg:shrink-0 border-r border-[var(--color-line)] ' +
            (openId ? 'hidden lg:flex' : 'flex')
          }>
            <div className="p-2.5 border-b border-[var(--color-line)] shrink-0">
              <div className="flex items-center gap-2 px-2.5 h-8 rounded-full bg-paper hairline">
                <Search size={12} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search prospects"
                  className="bg-transparent outline-none text-[12px] flex-1 min-w-0"
                />
                {q && <button type="button" onClick={() => setQ('')} className="text-mute hover:text-ink" aria-label="Clear"><X size={11} /></button>}
              </div>
              <div className="flex items-center justify-between mt-2 px-1 gap-2">
                <span className={LABEL}>{threads ? `${threads.length} shown` : 'loading'}</span>
                {waiting > 0 && <span className="mono text-[9px] text-emerald-600 shrink-0">{waiting} waiting on you</span>}
              </div>
              <button
                type="button"
                onClick={() => setSeeAll((v) => !v)}
                className="mt-1.5 w-full flex items-center gap-2 px-1 py-1 rounded-sm hover:bg-paper/70 transition"
                title={seeAll
                  ? 'Showing every conversation, including one-sided and dead ones'
                  : 'Showing only conversations they have answered'}
              >
                <span
                  className={
                    'w-7 h-4 rounded-full shrink-0 transition relative ' +
                    (seeAll ? 'bg-emerald-500' : 'bg-[var(--color-line)]')
                  }
                >
                  <span
                    className={
                      'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ' +
                      (seeAll ? 'left-3.5' : 'left-0.5')
                    }
                  />
                </span>
                <span className={LABEL}>see all</span>
                <span className="mono text-[9px] text-mute ml-auto">
                  {seeAll
                    ? `${counts.active} active · ${counts.scheduled ?? 0} scheduled · ${counts.fresh ?? 0} fresh · ${counts.unanswered} unanswered · ${counts.dead} dead`
                    : `${counts.unanswered + counts.dead} hidden`}
                </span>
              </button>
            </div>
            <div className="overflow-y-auto min-h-0 flex-1">
              {threads === null && <div className="p-4 text-[12px] text-mute">Loading conversations…</div>}
              {threads?.length === 0 && (
                <div className="p-4 text-[12px] text-mute leading-relaxed">
                  {!seeAll && (counts.unanswered + counts.dead) > 0 ? (
                    <>
                      No one has answered yet. {counts.unanswered} conversation{counts.unanswered === 1 ? '' : 's'} still
                      one-sided{counts.dead ? `, ${counts.dead} dead` : ''} — turn on <span className="text-ink">see all</span> to view them.
                    </>
                  ) : (
                    <>
                      No prospect conversations yet. A prospect appears here once they exist in the lead store
                      <span className="text-ink"> and </span>
                      there is a WhatsApp chat with their number.
                    </>
                  )}
                </div>
              )}
              {threads?.map((t) => (
                <ThreadRow key={t.chat_id} t={t} active={t.chat_id === openId} onOpen={() => openThread(t.chat_id)} />
              ))}
            </div>
          </div>

          {/* ── conversation ─────────────────────────────────────── */}
          {/* min-w-0: without it any nowrap child (the schedules strip) sets
              this column's min width to its content and shoves the side
              panel off screen */}
          <div className={'flex-col min-h-0 min-w-0 flex-1 ' + (openId ? 'flex' : 'hidden lg:flex')}>
            {!openId && (
              <div className="flex-1 flex items-center justify-center text-[12px] text-mute">
                Pick a conversation to see the prospect beside it.
              </div>
            )}

            {openId && (
              <>
                <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-[var(--color-line)] shrink-0">
                  <button
                    type="button"
                    onClick={() => { setOpenId(null); setDetail(null); setDraft(null); }}
                    className="lg:hidden text-mute hover:text-ink"
                    aria-label="Back to conversations"
                  >
                    ←
                  </button>
                  <Avatar name={detail?.prospect?.name || open?.name || null} photo={detail?.prospect?.photo || open?.photo} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[13px] truncate">
                      {detail?.prospect?.name || open?.name || openId.split('@')[0]}
                    </div>
                    <div className="text-[10px] text-mute truncate">
                      {[detail?.prospect?.position, detail?.prospect?.company].filter(Boolean).join(' · ') || openId.split('@')[0]}
                    </div>
                  </div>
                  {/* Retire a conversation by hand. Nothing is deleted — the
                      same button brings it back, and time-based death is
                      derived separately. */}
                  {open?.lead_id && (
                    <button
                      type="button"
                      disabled={marking}
                      onClick={() => toggleDead(open.lead_id, !open.dead_marked)}
                      className={
                        'mono text-[9px] uppercase tracking-[0.16em] px-2 h-6 rounded-sm hairline transition disabled:opacity-40 shrink-0 ' +
                        (open.dead_marked ? 'text-emerald-600 hover:bg-emerald-500/10' : 'text-mute hover:text-ink')
                      }
                      title={open.dead_marked
                        ? 'Bring this conversation back into the working list'
                        : 'Retire this conversation — it drops out of the default view'}
                    >
                      {open.dead_marked ? 'revive' : 'mark dead'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowCard(true)}
                    className="lg:hidden text-mute hover:text-ink"
                    aria-label="Prospect context"
                  >
                    <User size={15} />
                  </button>
                </div>

                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 bg-paper">
                  {loadingThread && <div className="text-[12px] text-mute py-4 text-center">Loading conversation…</div>}
                  {!loadingThread && detail?.messages.length === 0 && (
                    <div className="text-[12px] text-mute py-6 text-center">
                      No messages yet — this is a first touch.
                    </div>
                  )}
                  {detail?.messages.map((m, i) => (
                    <Bubble key={m.id || i} m={m} prev={i > 0 ? detail.messages[i - 1] : undefined} />
                  ))}
                </div>

                {/* composer — the operator's own words. The suggestion lives in
                    the side panel and only arrives here if they pick it up.
                    The message gets its own row; the actions sit below it.
                    SCHEDULE is the default (Enter opens the time popover);
                    send-now is the quiet secondary button. */}
                <div className="shrink-0 border-t border-[var(--color-line)]">
                  {schedules.filter((s) => ['scheduled', 'claimed', 'failed', 'partial'].includes(s.status)).length > 0 && (
                    <div className="px-3 pt-2 space-y-0.5">
                      {/* min-w-0 on every row and truncating child: without it
                          the flex item's content width wins and a long message
                          widens the whole column, shoving the side panel off
                          screen */}
                      {schedules.filter((s) => ['scheduled', 'claimed', 'failed', 'partial'].includes(s.status)).map((sc) => (
                        <div key={sc.id} className="flex items-center gap-2 min-w-0 mono text-[10px] text-mute">
                          <span className={'shrink-0 ' + (sc.status === 'failed' || sc.status === 'partial' ? 'text-rose-600' : 'text-sky-700')}>
                            {sc.status === 'failed' || sc.status === 'partial' ? `✗ ${sc.status}` : `⏲ ${sc.status}`}
                          </span>
                          <span className="shrink-0">{fmtWhen(sc.send_at, schedDefaults?.timezone || undefined)}</span>
                          <button
                            type="button"
                            onClick={() => setSchedView(sc)}
                            className="truncate flex-1 min-w-0 text-left text-ink/80 hover:text-ink hover:underline"
                            dir="auto"
                            title="Show the full scheduled message"
                          >{sc.bubbles[0]}</button>
                          {sc.status === 'scheduled' && (
                            <button type="button" onClick={() => cancelSchedule(sc.id)} className="shrink-0 hover:text-rose-600" title="Cancel this scheduled send">cancel</button>
                          )}
                          {(sc.status === 'failed' || sc.status === 'partial') && (
                            <button type="button" onClick={() => cancelSchedule(sc.id)} className="shrink-0 hover:text-ink" title={`${sc.error || 'did not complete'} — clear from this list`}>dismiss</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="p-2.5 pb-0">
                    <textarea
                      ref={boxRef}
                      value={text}
                      onChange={(e) => { setText(e.target.value); typedFor.current = openId; }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (!text.trim() || sendOff) return;
                          if (!openLeadId()) { setErr('this conversation has no linked prospect — scheduling needs one (send now still works)'); return; }
                          schedRef.current?.open();
                        }
                      }}
                      rows={1}
                      dir="auto"
                      placeholder={sendOff ? 'Write and keep a reply — sending is off' : 'Write your own message'}
                      className="w-full resize-none overflow-y-auto px-3 py-2 rounded-2xl bg-paper hairline text-[13px] leading-snug outline-none"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 pt-1.5">
                    {/* No connection, no send buttons — and the reason, right
                        where the button used to be. The box still works: the
                        suggested draft is worth keeping either way. */}
                    {sendOff ? (
                      <span className="mr-auto text-[11px] text-amber-700 dark:text-amber-300 leading-snug" title={sendOffWhy}>
                        Sending is off — {sendOffWhy} Drafting and reading still work.
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={send}
                          disabled={!text.trim() || sending}
                          className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center hairline bg-card text-mute hover:text-ink disabled:opacity-40 transition"
                          aria-label="Send now"
                          title="Send now instead of scheduling"
                        >
                          <Send size={14} />
                        </button>
                        <ScheduleSend
                          ref={schedRef}
                          variant="label"
                          size="md"
                          label="schedule"
                          busy={sending}
                          disabled={!text.trim() || !openLeadId()}
                          defaults={schedDefaults}
                          onSchedule={scheduleMsg}
                          onSendNow={send}
                        />
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── suggestion + prospect context ────────────────────── */}
          {openId && detail?.prospect && (
            <div className="hidden lg:flex flex-col min-h-0 w-[300px] shrink-0 border-l border-[var(--color-line)]">
              <DraftPanel
                draft={draft} drafting={drafting}
                inBox={!!draft?.draft && draft.draft === text}
                onUse={useDraft}
                onRedraft={() => openId && suggest(openId, true)}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ProspectCard p={detail.prospect} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* mobile context drawer */}
      {showCard && detail?.prospect && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setShowCard(false)} aria-label="Close" />
          <div className="absolute right-0 top-0 bottom-0 w-[86%] max-w-[340px] bg-card hairline flex flex-col">
            <ProspectCard p={detail.prospect} onClose={() => setShowCard(false)} />
          </div>
        </div>
      )}

      {/* scheduled-message viewer: full text, clear close, change time */}
      {schedView && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setSchedView(null)} aria-label="Close" />
          <div className="relative bg-card hairline rounded-sm shadow-xl w-[min(28rem,92vw)] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="mono text-[9px] uppercase tracking-[0.2em] text-mute">Scheduled message</div>
                <div className="mono text-[11px] text-sky-700 mt-1">⏲ fires {fmtWhen(schedView.send_at, schedDefaults?.timezone || undefined)}</div>
              </div>
              <button
                type="button"
                onClick={() => setSchedView(null)}
                className="w-7 h-7 shrink-0 rounded-sm hairline flex items-center justify-center text-mute hover:text-ink"
                aria-label="Close"
                title="Close"
              >
                <X size={13} />
              </button>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto mb-3">
              {schedView.bubbles.map((b, i) => (
                <div key={i} dir="auto" className="text-[13px] leading-snug whitespace-pre-wrap break-words rounded-sm bg-paper hairline px-2.5 py-2">{b}</div>
              ))}
            </div>
            <SchedViewFooter
              sched={schedView}
              tz={schedDefaults?.timezone || undefined}
              onReschedule={(at) => reschedule(schedView, at)}
              onCancel={() => { cancelSchedule(schedView.id); setSchedView(null); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Footer of the scheduled-message viewer: change the fire time in the doc
// timezone, or cancel the queued send entirely.
function SchedViewFooter({ sched, tz, onReschedule, onCancel }: {
  sched: { send_at: number };
  tz?: string;
  onReschedule: (atMs: number) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [at, setAt] = useState(() => toWallInput(sched.send_at, tz));
  return (
    <div className="flex items-center justify-between gap-2">
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1">
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className="flex-1 min-w-0 h-8 px-2 rounded-sm hairline bg-paper mono text-[10px]"
            title={tz ? `Interpreted as ${tz}` : 'Local time'}
          />
          <button
            type="button"
            onClick={() => {
              const m = at.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
              if (m) onReschedule(epochForWall(tz, +m[1], +m[2], +m[3], +m[4], +m[5]));
            }}
            className="h-8 px-2.5 rounded-sm bg-emerald-500 text-white mono text-[10px] uppercase tracking-[0.12em]"
          >
            set
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className={btnQ}>change schedule</button>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] text-rose-600 hover:bg-rose-500/10 transition"
      >
        cancel send
      </button>
    </div>
  );
}

// ── the module ─────────────────────────────────────────────────────────────
export default function Outreach() {
  // Asked for the first time Outreach is opened, not during onboarding.
  const prereqs = useModulePrereqs('outreach');
  const gated = prereqs.phase === 'gate' && !!prereqs.status;
  const sendOff = prereqs.needsGateway('whatsapp');
  const sendOffWhy = prereqs.gapFor('whatsapp')?.why
    || 'WhatsApp is not connected, so nothing can leave this machine.';

  const content = <Conversations sendOff={sendOff} sendOffWhy={sendOffWhy} />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 pt-5 shrink-0">
        <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">
          <WhatsApp size={12} />
          <span>Outreach · the prospects worth approaching</span>
        </div>
        {!gated && sendOff && (
          <DegradedNotice
            className="mt-3"
            note={<>Conversations, prospects and drafted messages all read and edit normally. <strong className="font-semibold">Sending is off</strong> — nothing goes out, and nothing is queued to go out.</>}
            items={prereqs.unmet.filter((p) => p.kind === 'gateway')}
            onSetUp={prereqs.openSetup}
            actionLabel="connect whatsapp"
          />
        )}
      </div>

      {prereqs.phase === 'loading' ? <ModuleStatusHold /> : gated && prereqs.status ? (
        <ModuleSetupGate
          status={prereqs.status}
          slug="outreach"
          onDone={prereqs.done}
          onSkip={prereqs.skip}
        >
          {content}
        </ModuleSetupGate>
      ) : content}
    </div>
  );
}
