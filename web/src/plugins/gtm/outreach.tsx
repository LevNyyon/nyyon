// Outreach — approach the prospects Prospecting surfaced (GTM plugin surface).
//
//   Conversations — a WhatsApp inbox filtered to PROSPECTS, reading like the
//        phone app. Split three ways: ACTIVE (they answered), UNANSWERED (only
//        our messages) and DEAD (retired by hand, or nothing for weeks).
//        Default shows Active only; "see all" widens it. Opening one puts the
//        thread in the middle, and on the right the suggested message OFFERED
//        beside it plus the prospect/company card. The composer stays the
//        operator's own — a suggestion only lands there if they pick it up.
//
//   Queue — the cohorts. A queue is a group who share a reason to be
//        approached, so the COPY belongs to the cohort: one sequence, written
//        once, personalised per recipient by variables and language. Adding
//        someone STAGES them; nothing is scheduled until you select people and
//        press go live. Answering removes a prospect from automation
//        permanently; the engine re-checks that before every send.
//
// Thin client over the GTM pack's OWN tools via /api/plugins/gtm/invoke/* —
// the same tools Nyo drives. Sending goes through send_prospect_message,
// which rides the outbox-audited whatsapp gateway send.
//
// SENDING is the only part that needs WhatsApp. The threads, the prospects,
// the cohorts and their drafted messages all live in this database, so without
// the gateway the module still opens and still works as a reading-and-writing
// surface — it says sending is off and keeps the send controls off, rather
// than queueing messages that will fail at the boundary.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  api, type OutreachThread, type OutreachThreadDetail, type OutreachDraft, type OutreachProspect,
  type OutreachStatus, type OutreachCounts, type OutreachCohortMember, type OutreachTickResult,
  type OutreachCohort, type OutreachSequence, type OutreachSequenceStep,
  type OutreachGoLiveResult, type OutreachApproveResult, type SequenceScope, OUTREACH_VARIABLES,
  type CohortStatus, COHORT_STATUSES, OUTREACH_CHANNELS, OUTREACH_WIRED_CHANNELS, WEEKDAY_LABELS,
} from './outreach-data';
import { WhatsApp, Search, Send, Sparkle, Refresh, LinkedIn, User, Check, Trash, X } from '../../components/Icons';
import { ScheduleSend, fmtWhen, epochForWall, toWallInput, type ScheduleDefaults, type ScheduleSendHandle } from './ScheduleSend';
import { GtmOrgChart } from './GtmOrgChart';
import type { GtmOrgPerson, GtmGreenLead } from './outreach-data';
import { useModulePrereqs } from '../../lib/module-status';
import { ModuleSetupGate } from '../../components/ModuleSetupGate';
import { DegradedNotice, ModuleStatusHold } from '../../components/DegradedNotice';

type Tab = 'conversations' | 'cohorts';
const TAB_KEY = 'nyyon.outreach.tab.v1';

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
const SENTIMENT_DOT: Record<string, string> = {
  positive: 'bg-emerald-500', neutral: 'bg-stone-400', negative: 'bg-rose-500',
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

function whenText(ts: number | null): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

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
          {t.sentiment && <span className={`w-1.5 h-1.5 rounded-full ${SENTIMENT_DOT[t.sentiment] || ''}`} title={`Last reply read as ${t.sentiment}`} />}
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
  // The company org chart behind this prospect. It is the same data the
  // company-context workflow caches on the lead, so this is a plain read —
  // opening a conversation never triggers an enrichment fetch.
  const [org, setOrg] = useState<GtmOrgPerson[] | null>(null);
  useEffect(() => {
    let live = true;
    setOrg(null);
    if (!p.lead_id) return;
    api.gtmLeadDetail(p.lead_id)
      .then((d) => { if (live) setOrg(d.org || []); })
      .catch(() => { if (live) setOrg([]); });
    return () => { live = false; };
  }, [p.lead_id]);

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

        {(p.company_staff_count != null || p.company_linkedin) && (
          <Field label="Company">
            {p.company_staff_count != null && <div>{p.company_staff_count.toLocaleString()} on LinkedIn</div>}
            {p.company_linkedin && (
              <a href={p.company_linkedin} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-1 text-sky-600 hover:underline">
                <LinkedIn size={11} /> company page
              </a>
            )}
            {p.org_status === 'warn' && (
              <div className="mt-1 text-[11px] text-amber-600">Company unverified — {p.org_note || 'possible namesake'}</div>
            )}
          </Field>
        )}

        {p.open_positions.length > 0 && (
          <Field label={`Open roles · ${p.open_positions.length}`}>
            <ul className="space-y-1">
              {p.open_positions.slice(0, 5).map((r, i) => (
                <li key={i} className="truncate">
                  {r.url
                    ? <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.title || 'role'}</a>
                    : (r.title || 'role')}
                  {r.location && <span className="text-mute"> · {r.location}</span>}
                </li>
              ))}
            </ul>
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
        {p.lead_id && org && org.length > 0 && (
          <Field label="Org chart">
            <GtmOrgChart people={org} lead={{ ...(p as unknown as GtmGreenLead), company: p.company }} />
          </Field>
        )}
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
            {/* The rest of the approved sequence — the follow-ups the cohort
                would send, available to fire by hand right now. */}
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
                      there is a WhatsApp chat with their number — start one from the Cohorts tab.
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

// ── cohort settings ────────────────────────────────────────────────────────
// Everything that makes a cohort behave the way it does, in one place: its run
// state, when it is allowed to send, which languages it is authored in, and the
// drip itself as a flow you read top to bottom.
const COHORT_TONE: Record<CohortStatus, string> = {
  active:   'text-emerald-600 border-emerald-500/30 bg-emerald-500/10',
  paused:   'text-amber-600 border-amber-500/30 bg-amber-500/10',
  finished: 'text-sky-600 border-sky-500/30 bg-sky-500/10',
  canceled: 'text-mute border-[var(--color-line)] bg-transparent',
};
const COHORT_WHY: Record<CohortStatus, string> = {
  active: 'running — due messages send',
  paused: 'held — nothing inside this cohort sends until it is active again',
  finished: 'everyone has been through the sequence',
  canceled: 'abandoned — will not run again',
};
// A short, honest list. Anything else can be typed in.
const TZ_CHOICES = ['Asia/Jerusalem', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC'];

function CohortSettings({ cohort, onClose, onSaved }: {
  cohort: OutreachCohort;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(cohort.name);
  const [status, setStatus] = useState<CohortStatus>(cohort.status);
  const [tz, setTz] = useState(cohort.timezone || '');
  // One window per weekday. Seeded from whatever the cohort already had: its
  // per-day windows if it has them, otherwise its single from/to pair spread
  // across its eligible days — so opening the modal never silently retimes a
  // cohort that was configured the old way.
  const [wins, setWins] = useState<Record<number, { start: string; end: string }>>(() => {
    if (cohort.send_windows && Object.keys(cohort.send_windows).length) {
      const out: Record<number, { start: string; end: string }> = {};
      for (const [d, w] of Object.entries(cohort.send_windows)) out[Number(d)] = { start: w.start, end: w.end };
      return out;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const from = `${pad(cohort.start_hour ?? 9)}:00`;
    const to = `${pad(Math.min(cohort.end_hour ?? 19, 23))}:${(cohort.end_hour ?? 19) >= 24 ? '59' : '00'}`;
    const seedDays = cohort.send_days?.length ? cohort.send_days : [1, 2, 3, 4, 5];
    return Object.fromEntries(seedDays.map((d) => [d, { start: from, end: to }]));
  });
  // Kept only to keep sending the legacy shape alongside send_windows.
  const startHour = cohort.start_hour ?? 9;
  const endHour = cohort.end_hour ?? 19;
  const [langs, setLangs] = useState<string[]>(cohort.languages?.length ? cohort.languages : ['en']);

  const [seq, setSeq] = useState<OutreachSequence | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What this edit does to people already in the cohort. Defaults to the
  // conservative one: a hand-written message is somebody's deliberate work and
  // should not be swept away by a press that was about the group.
  const [scope, setScope] = useState<SequenceScope>('new_only');
  const [outcome, setOutcome] = useState<{ replaced: number; kept: number; withdrawn: number } | null>(null);

  useEffect(() => {
    api.outreachSequence(cohort.id)
      .then((r) => {
        setSeq(r.sequence.steps.length ? r.sequence
          : { default_language: langs[0] || 'en', steps: [{ delay_hours: 0, channel: 'whatsapp', trigger: 'no_reply', bodies: { [langs[0] || 'en']: '' } }] });
        if (r.languages.length) setLangs(r.languages);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [cohort.id]);

  // Which bubble's timing editor is open, if any.
  const [timingStep, setTimingStep] = useState<number | null>(null);

  // When each message would actually land, walked through THIS cohort's own
  // eligible sending times from a go-live now. Mirrors the server's
  // nextWindowOpening: a delay lands you at a moment, and if that moment is
  // outside the window the message waits for the next opening. Showing the raw
  // "+72h" instead would promise a Saturday 3am send the sender will never make.
  const projected = useMemo(() => {
    const mins = (hm: string) => { const m = hm.match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
    const open = (at: number): number => {
      // No windows configured at all → nothing can be promised; return as-is.
      if (!Object.keys(wins).length) return at;
      for (let i = 0; i < 14; i++) {
        const probe = new Date(at + i * 86400000);
        const w = wins[probe.getDay()];
        if (!w) continue;
        const s0 = mins(w.start); const e0 = mins(w.end);
        if (s0 === null || e0 === null || e0 <= s0) continue;
        const day = new Date(probe); day.setHours(0, 0, 0, 0);
        const openAt = day.getTime() + s0 * 60000;
        const shutAt = day.getTime() + e0 * 60000;
        if (at <= openAt) return openAt;
        if (at < shutAt) return at;
      }
      return at;
    };
    const out: number[] = [];
    let t = open(Date.now());
    for (let i = 0; i < (seq?.steps.length || 0); i++) {
      if (i > 0) t = open(t + (seq!.steps[i].delay_hours || 0) * 3600000);
      out.push(t);
    }
    return out;
  }, [seq, wins]);

  const dirty = () => setSaved(false);
  function patchStep(i: number, patch: Partial<OutreachSequenceStep>) {
    setSeq((s) => (s ? { ...s, steps: s.steps.map((st, n) => (n === i ? { ...st, ...patch } : st)) } : s)); dirty();
  }
  function setBody(i: number, lang: string, text: string) {
    setSeq((s) => (s ? { ...s, steps: s.steps.map((st, n) => (n === i ? { ...st, bodies: { ...st.bodies, [lang]: text } } : st)) } : s)); dirty();
  }
  function addStep() {
    setSeq((s) => (s ? { ...s, steps: [...s.steps, { delay_hours: 72, channel: 'whatsapp', trigger: 'no_reply', bodies: { [langs[0] || 'en']: '' } }] } : s)); dirty();
  }
  function removeStep(i: number) {
    setSeq((s) => (s ? { ...s, steps: s.steps.filter((_, n) => n !== i) } : s)); dirty();
  }
  function toggleLang(l: string) {
    setLangs((prev) => (prev.includes(l) ? (prev.length > 1 ? prev.filter((x) => x !== l) : prev) : [...prev, l])); dirty();
  }

  // Ask the model for this box's copy. It lands in the textarea for reading and
  // editing — nothing is saved until the operator presses save.
  async function draft(i: number, lang: string) {
    setDrafting(`${i}:${lang}`); setErr(null);
    try {
      const r = await api.outreachDraftStep(cohort.id, { step_index: i, language: lang });
      if (r.error || !r.draft) { setErr(r.error || 'nothing came back'); return; }
      setBody(i, lang, r.draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setDrafting(null); }
  }

  async function save() {
    setSaving(true); setErr(null); setOutcome(null);
    try {
      const meta = await api.outreachCohortUpdate(cohort.id, {
        name, status, timezone: tz || null, start_hour: startHour, end_hour: endHour,
        // send_windows supersedes start_hour/end_hour/send_days on the server;
        // the older fields still go up so a cohort stays readable to anything
        // that has not been taught the new shape.
        send_days: Object.keys(wins).map(Number).sort(),
        send_windows: Object.fromEntries(Object.entries(wins).map(([d, w]) => [d, { start: w.start, end: w.end }])),
        languages: langs,
      });
      if (meta.error) { setErr(meta.error); return; }
      if (seq) {
        const r = await api.outreachSaveSequence(cohort.id, { ...seq, default_language: langs[0] || 'en' }, scope);
        if (r.error) { setErr(r.error); return; }
        setOutcome({
          replaced: r.edits_replaced || 0, kept: r.edits_kept || 0, withdrawn: r.approvals_withdrawn || 0,
        });
      }
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  const unknownVars = new Set<string>();
  for (const st of seq?.steps || []) {
    for (const body of Object.values(st.bodies)) {
      for (const m of String(body || '').matchAll(/\{([a-z_]+)\}/g)) {
        if (!(OUTREACH_VARIABLES as readonly string[]).includes(m[1])) unknownVars.add(m[1]);
      }
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-3xl hairline rounded-sm bg-card shadow-xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
          <span className="mono text-[10px] uppercase tracking-[0.2em]">bulk edit · {cohort.name}</span>
          <span className="mono text-[10px] text-mute ml-auto">{cohort.total} prospect{cohort.total === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} className="text-mute hover:text-ink" aria-label="Close"><X size={13} /></button>
        </div>

        <div className="p-4 overflow-y-auto min-h-0 space-y-4">
          {err && <div className="px-3 py-2 rounded-sm border border-rose-500/30 bg-rose-500/10 text-[12px] text-rose-600">{err}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL}>name</span>
              <input value={name} onChange={(e) => { setName(e.target.value); dirty(); }}
                className="mt-1 w-full h-8 hairline rounded-sm bg-paper px-2 text-[13px] focus:outline-none" />
            </label>
            <label className="block">
              <span className={LABEL}>status</span>
              <select value={status} onChange={(e) => { setStatus(e.target.value as CohortStatus); dirty(); }}
                className="mt-1 w-full h-8 hairline rounded-sm bg-paper px-2 text-[13px] focus:outline-none"
                title={COHORT_WHY[status]}>
                {COHORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <div className="text-[11px] text-mute -mt-2">{COHORT_WHY[status]}</div>

          <label className="block sm:max-w-xs">
            <span className={LABEL}>timezone</span>
            <input list="tz-choices" value={tz} onChange={(e) => { setTz(e.target.value); dirty(); }}
              placeholder="account default"
              className="mt-1 w-full h-8 hairline rounded-sm bg-paper px-2 text-[13px] focus:outline-none" />
            <datalist id="tz-choices">{TZ_CHOICES.map((z) => <option key={z} value={z} />)}</datalist>
          </label>

          {/* Eligible sending times — one window PER DAY, to the minute. Days run
              down the side because that is the axis you scan ("what happens on
              Friday?"), with the times beside each. A day switched off sends
              nothing at all; there is no separate day list to contradict it. */}
          <div>
            <span className={LABEL}>eligible sending times</span>
            <div className="mt-1.5 hairline rounded-sm divide-y divide-[var(--color-line)]">
              {WEEKDAY_LABELS.map((label, d) => {
                const on = !!wins[d];
                return (
                  <div key={label} className="flex items-center gap-2 px-2 py-1.5">
                    <label className="flex items-center gap-2 w-24 shrink-0 cursor-pointer">
                      <input type="checkbox" checked={on}
                        onChange={() => {
                          setWins((prev) => {
                            const n = { ...prev };
                            if (on) delete n[d]; else n[d] = { start: '09:00', end: '17:00' };
                            return n;
                          });
                          dirty();
                        }}
                        className="h-3 w-3 accent-current cursor-pointer" />
                      <span className={'mono text-[10px] uppercase tracking-[0.12em] ' + (on ? 'text-ink' : 'text-mute/60')}>
                        {label}
                      </span>
                    </label>
                    {on ? (
                      <div className="flex items-center gap-1.5">
                        <input type="time" value={wins[d].start}
                          onChange={(e) => { setWins((prev) => ({ ...prev, [d]: { ...prev[d], start: e.target.value } })); dirty(); }}
                          className="h-7 hairline rounded-sm bg-paper px-1.5 text-[12px] focus:outline-none" />
                        <span className="text-mute text-[11px]">to</span>
                        <input type="time" value={wins[d].end}
                          onChange={(e) => { setWins((prev) => ({ ...prev, [d]: { ...prev[d], end: e.target.value } })); dirty(); }}
                          className="h-7 hairline rounded-sm bg-paper px-1.5 text-[12px] focus:outline-none" />
                        {wins[d].end <= wins[d].start && (
                          <span className="text-[10px] text-rose-600">end must be after start</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[11px] text-mute/60">nothing sends</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-1 text-[10px] text-mute/80">
              Wall-clock in {tz || 'the account default zone'}. Every day switched off means this cohort never sends.
            </div>
          </div>

          <div>
            <span className={LABEL}>languages</span>
            <div className="flex gap-1 mt-1">
              {['en', 'he'].map((l) => (
                <button key={l} type="button" onClick={() => toggleLang(l)}
                  className={
                    'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.1em] hairline transition ' +
                    (langs.includes(l) ? 'bg-ink text-paper' : 'bg-paper text-mute hover:text-ink')
                  }
                  title="Each prospect gets the variant matching them — authored, never machine-translated">
                  {l}
                </button>
              ))}
              <span className="mono text-[9px] text-mute self-center ml-2">first is the default</span>
            </div>
          </div>

          {/* ── the drip, as the conversation it will actually be ──
              Bubbles down the thread rather than a stack of form boxes: the
              question being answered is "does this read like something a person
              would send", and a form cannot show that. Each bubble is editable
              where it sits, and carries the moment it would go — projected
              through THIS cohort's own eligible sending times, from a go-live
              now, so the timing is checked against the same windows the sender
              will use. Click the time to change the wait. */}
          <div>
            <div className="flex items-center gap-2">
              <span className={LABEL}>the conversation</span>
              {unknownVars.size > 0 && (
                <span className="mono text-[9px] text-rose-600">
                  unknown: {[...unknownVars].map((u) => `{${u}}`).join(' ')}
                </span>
              )}
              <span className="mono text-[9px] text-mute ml-auto">
                {OUTREACH_VARIABLES.map((v) => `{${v}}`).join(' ')}
              </span>
            </div>

            <div className="mt-2 rounded-sm bg-paper/60 hairline p-3 space-y-3">
              {(seq?.steps || []).map((st, i) => (
                <div key={i} className="flex flex-col items-end">
                  {/* When this one lands, and the wait that puts it there. */}
                  <button type="button" onClick={() => setTimingStep(timingStep === i ? null : i)}
                    className="mono text-[9px] text-mute hover:text-ink mb-1 inline-flex items-center gap-1"
                    title="Click to change how long this waits">
                    {i === 0 ? 'as soon as approved' : fmtWhen(projected[i], tz || undefined)}
                    {i > 0 && <span className="text-mute/60">· after {humanGap(st.delay_hours)}</span>}
                  </button>
                  {timingStep === i && i > 0 && (
                    <div className="mb-1 flex items-center gap-1.5 hairline rounded-sm bg-card px-2 py-1">
                      <span className="mono text-[9px] text-mute">wait</span>
                      <input type="number" min={0} value={Math.floor(st.delay_hours / 24)}
                        onChange={(e) => patchStep(i, { delay_hours: Math.max(0, Number(e.target.value) || 0) * 24 + (st.delay_hours % 24) })}
                        className="w-12 h-6 hairline rounded-sm bg-paper px-1 text-[11px] focus:outline-none" />
                      <span className="mono text-[9px] text-mute">d</span>
                      <input type="number" min={0} max={23} value={st.delay_hours % 24}
                        onChange={(e) => patchStep(i, { delay_hours: Math.floor(st.delay_hours / 24) * 24 + Math.min(23, Math.max(0, Number(e.target.value) || 0)) })}
                        className="w-12 h-6 hairline rounded-sm bg-paper px-1 text-[11px] focus:outline-none" />
                      <span className="mono text-[9px] text-mute">h</span>
                      <button type="button" onClick={() => setTimingStep(null)}
                        className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-ink ml-1">done</button>
                    </div>
                  )}

                  {/* The bubble. Outgoing green, matching the real thread view. */}
                  <div className="max-w-[85%] w-full rounded-sm bg-emerald-50 dark:bg-emerald-950/40 hairline px-2.5 py-2">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="mono text-[9px] text-mute">{i + 1}</span>
                      <select value={st.channel} onChange={(e) => patchStep(i, { channel: e.target.value })}
                        className="h-5 hairline rounded-sm bg-card px-1 text-[10px] focus:outline-none"
                        title="Only WhatsApp is wired to a sender today">
                        {OUTREACH_CHANNELS.map((c) => (
                          <option key={c} value={c}>{c}{OUTREACH_WIRED_CHANNELS.includes(c) ? '' : ' (not wired)'}</option>
                        ))}
                      </select>
                      <select value={st.trigger} onChange={(e) => patchStep(i, { trigger: e.target.value })}
                        className="h-5 hairline rounded-sm bg-card px-1 text-[10px] focus:outline-none"
                        title="The condition that decides whether this step fires at all">
                        <option value="no_reply">only if no reply</option>
                        <option value="always">always</option>
                      </select>
                      {!OUTREACH_WIRED_CHANNELS.includes(st.channel) && (
                        <span className="mono text-[9px] text-amber-600">cannot send yet</span>
                      )}
                      {(seq?.steps.length || 0) > 1 && (
                        <button type="button" onClick={() => removeStep(i)} className="ml-auto text-mute hover:text-rose-600" title="Remove this message">
                          <Trash size={11} />
                        </button>
                      )}
                    </div>

                    {langs.map((lang) => (
                      <div key={lang} className={langs.length > 1 ? 'mt-1.5' : ''}>
                        {langs.length > 1 && (
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="mono text-[9px] text-mute">{lang}</span>
                            <button type="button" onClick={() => draft(i, lang)}
                              disabled={drafting === `${i}:${lang}`}
                              className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-ink disabled:opacity-40 inline-flex items-center gap-1"
                              title="Draft this message from the cohort and who is in it — you read and edit it before anything is saved">
                              <Sparkle size={9} /> {drafting === `${i}:${lang}` ? 'writing…' : 'generate'}
                            </button>
                          </div>
                        )}
                        {/* Edited where it sits: no border, no box — it looks like
                            the message, and typing changes the message. */}
                        <textarea
                          value={st.bodies[lang] || ''}
                          onChange={(e) => setBody(i, lang, e.target.value)}
                          rows={Math.max(2, Math.ceil((st.bodies[lang] || '').length / 52))}
                          dir={lang === 'he' ? 'rtl' : 'ltr'}
                          placeholder={lang === 'he' ? 'היי {first_name}…' : 'Hi {first_name}, …'}
                          className="w-full resize-y bg-transparent border-0 p-0 text-[12px]/[17px] focus:outline-none placeholder:text-mute/50"
                        />
                        {langs.length === 1 && (
                          <button type="button" onClick={() => draft(i, lang)}
                            disabled={drafting === `${i}:${lang}`}
                            className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-ink disabled:opacity-40 inline-flex items-center gap-1 mt-0.5"
                            title="Draft this message from the cohort and who is in it — you read and edit it before anything is saved">
                            <Sparkle size={9} /> {drafting === `${i}:${lang}` ? 'writing…' : 'generate'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex justify-end">
                <button type="button" onClick={addStep}
                  className="mono text-[9px] uppercase tracking-[0.16em] text-mute hover:text-ink">
                  + message
                </button>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-mute/80">
              Times assume the cohort goes live now and run through its eligible sending
              times{tz ? ` in ${tz}` : ''} — the same windows the sender uses.
            </div>
          </div>
        </div>

        {/* Who this edit reaches. A bulk edit is about the GROUP, so the default
            protects the individual work: hand-written messages survive it. */}
        <div className="px-4 pt-3 border-t border-[var(--color-line)]">
          <div className={LABEL}>apply this copy to</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {([
              ['new_only', 'new members and everyone unedited',
                'People whose message you rewrote by hand keep their own words. Everyone else, and everyone added from now on, gets this copy.'],
              ['everyone', 'everyone — replace hand-written messages',
                'Overwrites per-person edits in this cohort with the copy above. Their individual wording is lost.'],
            ] as [SequenceScope, string, string][]).map(([v, label, why]) => (
              <label key={v} className="flex items-start gap-2 cursor-pointer group">
                <input type="radio" name="seq-scope" checked={scope === v}
                  onChange={() => { setScope(v); dirty(); }}
                  className="mt-[3px] h-3 w-3 accent-current cursor-pointer shrink-0" />
                <span className="block min-w-0">
                  <span className={'block text-[11px]/[15px] ' + (scope === v ? 'text-ink' : 'text-mute group-hover:text-ink')}>{label}</span>
                  <span className="block text-[10px]/[14px] text-mute/80">{why}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-1.5 text-[10px]/[14px] text-mute/80">
            Either way, anyone whose next message this changes needs approving again —
            an approval stands for words you read, and the words are changing.
          </div>
        </div>

        <div className="px-4 py-3 flex items-center gap-2">
          <button type="button" onClick={onClose} className={btnQ}>close</button>
          {saved && (
            <span className="mono text-[9px] text-emerald-600">
              saved
              {outcome && (outcome.replaced || outcome.kept || outcome.withdrawn) ? (
                <span className="text-mute">
                  {' · '}
                  {outcome.replaced ? `${outcome.replaced} edit${outcome.replaced === 1 ? '' : 's'} replaced · ` : ''}
                  {outcome.kept ? `${outcome.kept} edit${outcome.kept === 1 ? '' : 's'} kept · ` : ''}
                  {outcome.withdrawn} approval{outcome.withdrawn === 1 ? '' : 's'} withdrawn
                </span>
              ) : null}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving || unknownVars.size > 0}
            className="ml-auto h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] bg-ink text-paper disabled:opacity-40"
          >
            {saving ? 'saving…' : 'save cohort'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── the cohort sheet ───────────────────────────────────────────────────────
// Grouped by cohort, because that is the unit the work is organised in: each
// cohort is a header row you can collapse — its status, its counts, its
// settings — with the people inside it underneath in the Prospecting idiom.
// Rows read as packed cards rather than a spreadsheet line: enough vertical
// room for a face and a two-line prospect block, without losing the column
// alignment that makes a hundred of them scannable.
const QTd = 'py-2 px-2 align-middle';

// "72" reads as a number to check; "3 days" reads as a gap to feel.
function humanGap(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  if (!h) return 'no wait';
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); const r = h % 24;
  return r ? `${d}d ${r}h` : `${d} day${d === 1 ? '' : 's'}`;
}
const QDASH = <span className="block text-[11px]/[14px] text-mute/50">—</span>;

type QTone = 'live' | 'staged' | 'blocked' | 'answered' | 'idle';
const Q_TINT: Record<QTone, string> = {
  live:     'border-l-emerald-500 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.10]',
  staged:   'border-l-amber-400 bg-amber-400/[0.07] hover:bg-amber-400/[0.11]',
  blocked:  'border-l-rose-400 bg-rose-500/[0.05] hover:bg-rose-500/[0.09]',
  answered: 'border-l-sky-400 bg-sky-500/[0.06] hover:bg-sky-500/[0.10]',
  idle:     'border-l-transparent hover:bg-paper/60',
};
// The run state now reads off the row's left stripe alone — a coloured dot
// beside a coloured stripe said the same thing twice, and the slot was better
// spent on the conversation status. Q_WHY survives as the stripe's explanation,
// carried on the Prospect cell.
const Q_WHY: Record<QTone, string> = {
  live: 'scheduled — messages are running',
  staged: 'staged — waiting for you to go live',
  blocked: 'cannot go live yet',
  answered: 'they replied — automation is off, this is yours now',
  idle: 'finished, paused or stopped',
};
function cohortTone(r: OutreachCohortMember): QTone {
  if (r.answered) return 'answered';
  if (r.blocked) return 'blocked';
  if (r.staged) return 'staged';
  if (r.status === 'active') return 'live';
  return 'idle';
}

function QTh({ children, className = '', title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <th title={title} className={'font-normal py-1 px-1.5 whitespace-nowrap ' + className}>{children}</th>;
}

// ── where their actual conversation stands ──────────────────────────────────
// Four states, derived on the server from the messages themselves and shared
// with the Conversations tab, so a prospect cannot read one thing here and
// another there. This is about the CONVERSATION; the row's left stripe is about
// their place in the RUN. They are different questions and both are shown.
type Convo = OutreachCohortMember['conversation'];
const CONVO_STYLE: Record<Convo, string> = {
  untouched: 'text-mute/70 border-[var(--color-line)]',
  touched:   'text-amber-600 border-amber-500/30 bg-amber-500/10',
  active:    'text-sky-600 border-sky-500/30 bg-sky-500/10',
  dead:      'text-rose-600/70 border-rose-500/25 bg-rose-500/[0.07]',
};
const CONVO_WHY: Record<Convo, string> = {
  untouched: 'nothing has ever been sent to them',
  touched: 'we have sent, they have not replied',
  active: 'they replied — the automation is permanently off them',
  dead: 'marked dead, or nothing has happened for a long time',
};

// ── the confirm popover ─────────────────────────────────────────────────────
// The same dark, cell-anchored box Prospecting stages its inline edits behind,
// and for the same reason: an edit that committed on blur would let a stray
// double-click plus a keystroke silently change what a real prospect receives.
// Portalled, so the sheet's own scroll container can never clip it.
function ConfirmPop({ anchor, title, children, actions, err, busy, onCancel }: {
  anchor: DOMRect | undefined;
  title: string;
  children: React.ReactNode;
  actions: { label: string; onClick: () => void; primary?: boolean }[];
  err?: string | null;
  busy?: boolean;
  onCancel: () => void;
}) {
  if (!anchor) return null;
  return createPortal(
    <>
      {/* Click-away closes. Behind the box, above everything else. */}
      <button type="button" className="fixed inset-0 z-[209] cursor-default" onClick={onCancel} aria-label="Cancel" />
      <div
        style={{
          position: 'fixed',
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - 312)),
          top: Math.min(anchor.bottom + 4, window.innerHeight - 160),
          zIndex: 210, width: 304,
        }}
        className="rounded-sm bg-ink text-paper text-[11px] leading-snug px-3 py-2 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.55)]"
      >
        <div className="mono text-[9px] uppercase tracking-[0.15em] text-paper/60 mb-1">{title}</div>
        {children}
        {err && <div className="text-rose-300 mt-1.5 break-words">{err}</div>}
        <div className="flex gap-1.5 justify-end mt-2">
          <button type="button" onClick={onCancel}
            className="h-6 px-2 rounded-sm mono text-[9px] uppercase tracking-[0.12em] bg-paper/10 hover:bg-paper/20 transition">
            cancel
          </button>
          {actions.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} disabled={busy}
              className={'h-6 px-2 rounded-sm mono text-[9px] uppercase tracking-[0.12em] transition disabled:opacity-40 '
                + (a.primary ? 'bg-paper text-ink hover:opacity-90' : 'bg-paper/10 hover:bg-paper/20')}>
              {busy ? '…' : a.label}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── the Scheduled Send cell, edited in place ────────────────────────────────
// The picker works in the COHORT's timezone, not the browser's, because that is
// the zone the column displays and the zone the send is measured in. Reuses
// ScheduleSend's DST-safe wall-clock conversion rather than growing a second one.
//
// Choosing a time stages a confirm popover offering BOTH outcomes, because
// "when does it go" and "am I happy for it to go" are the two questions a
// manual schedule raises at once, and making the second one a separate hunt
// through another cell is how a message sits unapproved for a week.
function SendingEditor({ row, anchor, sendOff, onCancel, onSaved }: {
  row: OutreachCohortMember;
  anchor: DOMRect | undefined;
  /** no sender connected — the time can still be set, approval is not offered */
  sendOff: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const tz = row.timezone;
  const [wall, setWall] = useState(() => toWallInput(row.next_send_at || Date.now() + 3600000, tz));
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const parse = (w: string) => {
    const m = w.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return m ? epochForWall(tz, +m[1], +m[2], +m[3], +m[4], +m[5]) : null;
  };

  // Staged on blur or Enter, exactly like Prospecting: nothing is written until
  // the popover is answered. An unchanged time closes without nagging.
  function propose() {
    const at = parse(wall);
    if (at === null) { setErr('pick a date and time'); return; }
    if (at === row.next_send_at) { onCancel(); return; }
    setErr(null);
    setPending(at);
  }

  async function commit(alsoApprove: boolean) {
    if (pending === null) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.outreachReschedule(row.lead_id, pending);
      if (r.error) { setErr(r.error); return; }
      if (alsoApprove) {
        const ap = await api.outreachApprove([row.lead_id], true);
        if (ap.error) { setErr(ap.error); return; }
        if (ap.refused?.length) { setErr(ap.refused[0].reason); return; }
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function unschedule() {
    setBusy(true); setErr(null);
    try {
      const r = await api.outreachCohortControl(row.lead_id, 'unschedule');
      if ('error' in r && r.error) { setErr(r.error); return; }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const zoneName = tz.split('/').pop()?.replace(/_/g, ' ');

  return (
    <>
      <div className="flex items-center gap-1.5">
        <input ref={ref} type="datetime-local" value={wall}
          onChange={(e) => setWall(e.target.value)}
          onBlur={propose}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                              if (e.key === 'Enter') { e.preventDefault(); propose(); } }}
          className="h-6 hairline rounded-sm bg-paper px-1 text-[11px] focus:outline-none" />
        <span className="mono text-[9px] text-mute" title={tz}>{zoneName}</span>
        {row.next_send_at && (
          <button type="button" disabled={busy} onClick={unschedule}
            className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-amber-600 disabled:opacity-40"
            title="Back to a draft — keeps their place and their approval, just no send time">
            clear
          </button>
        )}
      </div>
      {pending !== null && (
        <ConfirmPop
          anchor={anchor} title={row.next_send_at ? 'move this send?' : 'schedule this send?'}
          err={err} busy={busy} onCancel={() => { setPending(null); onCancel(); }}
          actions={sendOff
            ? [{ label: 'schedule', onClick: () => commit(false), primary: true }]
            : [
              { label: 'schedule', onClick: () => commit(false) },
              { label: 'schedule + approve', onClick: () => commit(true), primary: true },
            ]}
        >
          {row.next_send_at && (
            <div className="text-paper/50 line-through truncate">{fmtWhen(row.next_send_at, tz)}</div>
          )}
          <div className="text-paper truncate">{fmtWhen(pending, tz)}</div>
          <div className="text-paper/60 mt-1.5">
            {sendOff
              ? 'Sending is off, so this only records when it would go. Nothing leaves until a sender is connected.'
              : row.approved
                ? 'Already approved — it stays approved; only the time changes.'
                : 'Approving here saves coming back to the State cell. The sender will not deliver it otherwise.'}
          </div>
        </ConfirmPop>
      )}
    </>
  );
}

// ── the State cell — a small dropdown ───────────────────────────────────────
// State shows two facts (scheduled-or-draft, approved-or-not), so the menu
// offers exactly those two and nothing else. Only the options that apply to
// THIS row are listed: a menu full of greyed-out entries is a menu that makes
// you read it twice.
function StateMenu({ row, anchor, sendOff, sendOffWhy, onCancel, onSaved }: {
  row: OutreachCohortMember;
  anchor: DOMRect | undefined;
  sendOff: boolean;
  sendOffWhy: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try {
      const r = await fn() as { error?: string; refused?: { reason: string }[] };
      if (r?.error) { setErr(r.error); return; }
      // approve() reports per-person refusals in a list, not as an error.
      if (r?.refused?.length) { setErr(r.refused[0].reason); return; }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  // Withdrawing and unscheduling are always available — they only ever REMOVE
  // something from the run. What is off without a sender is the pair that
  // clears a message to leave.
  const items: { label: string; why: string; onClick: () => void; off?: boolean }[] = [];
  if (row.approved) {
    items.push({ label: 'withdraw approval', why: 'the sender holds this message again',
      onClick: () => run(() => api.outreachApprove([row.lead_id], false)) });
  } else {
    items.push({ label: 'approve', why: sendOff ? sendOffWhy : 'lapses once this message is sent', off: sendOff,
      onClick: () => { if (!sendOff) run(() => api.outreachApprove([row.lead_id], true)); } });
  }
  if (row.next_state === 'draft') {
    items.push({ label: 'go live', why: sendOff ? sendOffWhy : "give them a send time from the cohort's cadence", off: sendOff,
      onClick: () => { if (!sendOff) run(() => api.outreachGoLive([row.lead_id])); } });
  } else {
    items.push({ label: 'unschedule', why: 'back to a draft — keeps their place and approval',
      onClick: () => run(() => api.outreachCohortControl(row.lead_id, 'unschedule')) });
  }

  if (!anchor) return null;
  return createPortal(
    <>
      <button type="button" className="fixed inset-0 z-[209] cursor-default" onClick={onCancel} aria-label="Close" />
      <div
        style={{
          position: 'fixed',
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - 232)),
          top: Math.min(anchor.bottom + 4, window.innerHeight - 140),
          zIndex: 210, width: 224,
        }}
        className="rounded-sm bg-ink text-paper shadow-[0_8px_30px_-8px_rgba(0,0,0,0.55)] py-1"
      >
        {items.map((it) => (
          <button key={it.label} type="button" disabled={busy || !!it.off} onClick={it.onClick}
            title={it.off ? it.why : undefined}
            className="w-full text-left px-3 py-1.5 hover:bg-paper/10 disabled:opacity-40 disabled:hover:bg-transparent transition">
            <span className="block mono text-[9px] uppercase tracking-[0.14em]">{it.label}{it.off ? ' · off' : ''}</span>
            <span className="block text-[10px]/[13px] text-paper/50">{it.why}</span>
          </button>
        ))}
        {err && <div className="px-3 py-1.5 text-[10px] text-rose-300 break-words">{err}</div>}
      </div>
    </>,
    document.body,
  );
}

// Double-click a message to rewrite it for that one person. Committing is staged
// behind the same confirm popover Prospecting uses: an edit that saved on blur
// would let a stray double-click plus a keystroke change what a real prospect
// receives. Blur and Enter PROPOSE; only the popover writes.
function MessageEditor({ row, anchor, sendOff, onCancel, onSaved }: {
  row: OutreachCohortMember;
  anchor: DOMRect | undefined;
  /** no sender connected — editing still saves, approving is not offered */
  sendOff: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const original = String(row.override_text || row.next_text || '').trim();
  const [text, setText] = useState(original);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  function propose() {
    const next = text.trim();
    if (next === original) { onCancel(); return; }   // untouched — don't nag
    setErr(null);
    setPending(next);
  }

  async function commit(alsoApprove: boolean) {
    if (pending === null) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.outreachEditMessage(row.lead_id, pending, false);
      if (r.error) { setErr(r.error); return; }
      if (alsoApprove) {
        const ap = await api.outreachApprove([row.lead_id], true);
        if (ap.error) { setErr(ap.error); return; }
        if (ap.refused?.length) { setErr(ap.refused[0].reason); return; }
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function reset() {
    setBusy(true); setErr(null);
    try {
      const r = await api.outreachEditMessage(row.lead_id, '', true);
      if (r.error) { setErr(r.error); return; }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={propose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); propose(); }
        }}
        rows={3}
        className="w-full hairline rounded-sm bg-paper px-2 py-1.5 text-[11px]/[15px] focus:outline-none focus:border-ink/30 resize-y"
        placeholder="The message this person receives…"
      />
      <div className="flex items-center gap-2 mt-1">
        <span className="mono text-[9px] text-mute/70">click away or ⌘↵ to save · esc to cancel</span>
        {row.edited && (
          <button type="button" disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={reset}
            className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-rose-600 disabled:opacity-40 ml-auto"
            title="Drop this edit and go back to the cohort's own copy">
            reset to cohort copy
          </button>
        )}
      </div>

      {pending !== null && (
        <ConfirmPop
          anchor={anchor} title="save this message?" err={err} busy={busy}
          onCancel={() => { setPending(null); onCancel(); }}
          actions={sendOff
            ? [{ label: 'save', onClick: () => commit(false), primary: true }]
            : [
              { label: 'save', onClick: () => commit(false) },
              { label: 'save + approve', onClick: () => commit(true), primary: true },
            ]}
        >
          <div className="text-paper/50 line-through max-h-16 overflow-auto whitespace-pre-wrap break-words">{original || '(empty)'}</div>
          <div className="text-paper max-h-24 overflow-auto whitespace-pre-wrap break-words mt-0.5">{pending}</div>
          <div className="text-paper/60 mt-1.5">
            For {row.name || 'this person'} only — the cohort's copy is untouched.
            {sendOff
              ? ' Sending is off, so the edit is saved and nothing is cleared to leave.'
              : row.approved ? ' Saving withdraws the approval, so approve here if you are happy with it.' : ''}
          </div>
        </ConfirmPop>
      )}
    </>
  );
}

function Cohorts({ sendOff, sendOffWhy }: { sendOff: boolean; sendOffWhy: string }) {
  const [rows, setRows] = useState<OutreachCohortMember[] | null>(null);
  const [cohorts, setCohorts] = useState<OutreachCohort[]>([]);
  const [stateFilter, setStateFilter] = useState<'all' | QTone>('all');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<OutreachCohort | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  const [goneLive, setGoneLive] = useState<OutreachGoLiveResult | null>(null);
  const [tick, setTick] = useState<OutreachTickResult | null>(null);
  const [ticking, setTicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which row's message is open for inline editing, and the result of the last
  // approve press (which can partly refuse, so it has to be shown, not assumed).
  const [editingMsg, setEditingMsg] = useState<string | null>(null);
  // `${lead_id}:${which}` — one cell open at a time, by construction.
  const [editingCell, setEditingCell] = useState<string | null>(null);
  // The rect the open cell's confirm popover hangs off. Captured at open time
  // from the cell itself, so the box lands under the thing being edited.
  const [anchor, setAnchor] = useState<DOMRect | undefined>(undefined);
  const openCell = (id: string, which: string, el: HTMLElement | null) => {
    setAnchor(el?.getBoundingClientRect());
    setEditingCell(`${id}:${which}`);
  };
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState<OutreachApproveResult | null>(null);

  async function load() {
    try {
      const r = await api.outreachCohortMembers('all', 'all');
      setRows(r.members);
      setCohorts(r.cohorts || []);
      setLive(r.live);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { load(); }, []);

  async function act(leadId: string, action: 'pause' | 'resume' | 'stop' | 'remove') {
    setBusy(leadId); setErr(null);
    try {
      const r = action === 'remove'
        ? await api.outreachCohortRemove(leadId)
        : await api.outreachCohortControl(leadId, action);
      if ('error' in r && r.error) { setErr(r.error); return; }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function goLiveNow() {
    const ids = [...sel];
    if (!ids.length || sendOff) return;
    setGoing(true); setErr(null);
    try {
      const r = await api.outreachGoLive(ids);
      if (r.error) { setErr(r.error); return; }
      setGoneLive(r); setSel(new Set()); await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setGoing(false); }
  }

  // Approve the selected messages. Per message, not per person — approving does
  // not schedule anybody, and it lapses the moment that message is sent.
  async function approveNow(approve: boolean) {
    const ids = [...sel].filter((id) => approvableIds.includes(id));
    if (!ids.length || sendOff) return;
    setApproving(true); setErr(null);
    try {
      const r = await api.outreachApprove(ids, approve);
      if (r.error) { setErr(r.error); return; }
      setApproved(r); setSel(new Set()); await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setApproving(false); }
  }

  async function preview() {
    setTicking(true); setErr(null);
    try { setTick(await api.outreachCohortTick({ dry_run: true, force: true })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setTicking(false); }
  }

  const all = rows || [];
  const needle = q.trim().toLowerCase();
  const visible = all.filter((r) =>
    (stateFilter === 'all' || cohortTone(r) === stateFilter)
    && (!needle || [r.name, r.company, r.position, r.next_text, r.last_sent_text]
          .some((v) => String(v || '').toLowerCase().includes(needle))));

  // Group the visible people under their cohort, in the cohort list's order.
  const byCohort = new Map<string, OutreachCohortMember[]>();
  for (const r of visible) {
    const k = r.cohort_id || 'oq_default';
    if (!byCohort.has(k)) byCohort.set(k, []);
    byCohort.get(k)!.push(r);
  }
  const shown = cohorts.filter((c) => byCohort.has(c.id) || !needle);

  // Two different gates over two different sets, and a row can be in both:
  //   go live  — a STAGED person gets a send time (about the person)
  //   approve  — this particular message is fit to leave (about the words)
  // Both are confined to rows the filters are currently SHOWING, so a filter
  // change can never act on somebody off-screen.
  const readyIds = visible.filter((r) => r.staged && !r.blocked).map((r) => r.lead_id);
  // `answered` is the STORED flag and only gets written when the sender next
  // runs, so somebody who replied minutes ago still reads false. The derived
  // conversation state is the live truth — check both, or the sheet offers to
  // approve a message for a person already mid-conversation.
  const approvableIds = visible
    .filter((r) => !!r.next_text && !r.answered && r.conversation !== 'active' && !r.blocked && !r.approved)
    .map((r) => r.lead_id);
  // Anything selectable at all — the checkbox is enabled for either gate.
  const selectableIds = [...new Set([...readyIds, ...approvableIds])];
  const selReady = [...sel].filter((id) => readyIds.includes(id));
  const selApprovable = [...sel].filter((id) => approvableIds.includes(id));
  const counts = {
    staged: all.filter((r) => r.staged && !r.blocked).length,
    blocked: all.filter((r) => !!r.blocked && !r.answered).length,
    live: all.filter((r) => r.status === 'active' && !r.answered).length,
    answered: all.filter((r) => r.answered).length,
    // Going out today and still unapproved — the number the operator is here for.
    dueToday: all.filter((r) => r.due_today && !r.answered).length,
    awaiting: all.filter((r) => r.due_today && !r.answered && !r.approved && !r.blocked).length,
  };

  function toggle(id: string) {
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleCohortSel(ids: string[]) {
    setSel((prev) => {
      const n = new Set(prev);
      const allIn = ids.length > 0 && ids.every((i) => n.has(i));
      for (const i of ids) { if (allIn) n.delete(i); else n.add(i); }
      return n;
    });
  }
  function toggleCollapse(id: string) {
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  const selStyle = 'h-8 hairline rounded-sm bg-card px-2 text-xs focus:outline-none';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-5 pt-3 pb-2 flex items-center gap-2 flex-wrap shrink-0">
        {/* The flag says whether the engine WOULD deliver; a missing gateway
            says whether it could. Reading "live" with no sender connected is
            the one thing this pill must never do. */}
        <span
          className={
            'mono text-[9px] uppercase tracking-[0.16em] px-1.5 py-1 rounded-sm border ' +
            (live && !sendOff ? 'text-emerald-600 border-emerald-500/30 bg-emerald-500/10'
                              : 'text-amber-600 border-amber-500/30 bg-amber-500/10')
          }
          title={sendOff ? `no sender connected — ${sendOffWhy}`
                : live ? 'approved messages are sent on schedule'
                       : 'paused — the queue runs but delivers nothing'}
        >
          {sendOff ? 'no sender' : live ? 'live' : 'paused'}
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Filter name / company / message…"
          className="h-8 w-52 hairline rounded-sm bg-card px-2.5 text-xs focus:outline-none" />
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as 'all' | QTone)} className={selStyle} title="Where each person is in the run">
          <option value="all">any state</option>
          <option value="staged">staged ({counts.staged})</option>
          <option value="blocked">blocked ({counts.blocked})</option>
          <option value="live">live ({counts.live})</option>
          <option value="answered">answered ({counts.answered})</option>
          <option value="idle">finished / paused</option>
        </select>
        <button type="button" onClick={preview} disabled={ticking} className={btnQ} title="Show exactly what the next run would send, without sending it">
          {ticking ? 'checking…' : 'preview run'}
        </button>
        {selApprovable.length > 0 && (
          <button type="button" onClick={() => approveNow(true)} disabled={approving || sendOff}
            className={
              'h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] inline-flex items-center gap-1 ' +
              (sendOff ? 'hairline bg-card text-mute opacity-60 cursor-not-allowed'
                       : 'bg-sky-600 text-white hover:opacity-90 disabled:opacity-40')
            }
            title={sendOff
              ? `${sendOffWhy} Approving would clear a message for a send that cannot happen.`
              : 'Approve exactly these messages. Approval lapses once each one is sent, so the next message needs approving again.'}>
            <Check size={11} /> approve ({selApprovable.length})
          </button>
        )}
        {selReady.length > 0 && (
          <button type="button" onClick={goLiveNow} disabled={going || sendOff}
            className={
              'h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] inline-flex items-center gap-1 ' +
              (sendOff ? 'hairline bg-card text-mute opacity-60 cursor-not-allowed'
                       : 'bg-emerald-600 text-white hover:opacity-90 disabled:opacity-40')
            }
            title={sendOff
              ? `${sendOffWhy} Going live would schedule sends that cannot leave.`
              : "Schedule these people to start receiving their cohort's sequence"}>
            <Send size={11} /> go live ({selReady.length})
          </button>
        )}
        <span className="mono text-[9px] text-mute ml-auto">
          {counts.awaiting > 0 && (
            <span className="text-amber-600">{counts.awaiting} awaiting approval today · </span>
          )}
          {counts.staged} staged · {counts.live} live · {counts.answered} answered
        </span>
      </div>

      {err && <div className="mx-4 sm:mx-5 mb-2 px-3 py-2 rounded-sm border border-rose-500/30 bg-rose-500/10 text-[12px] text-rose-600 shrink-0">{err}</div>}

      {/* Two different reasons nothing goes out, and they are not the same
          fact: a deliberate pause, or no connection at all. Say whichever is
          true — never dress the second up as the first. Sending is the normal
          state and is not announced. */}
      {sendOff ? (
        <div className="mx-4 sm:mx-5 mb-2 px-3 py-1.5 rounded-sm hairline bg-card text-[11px] text-mute shrink-0">
          <span className="text-ink">Approve</span> and <span className="text-ink">go live</span> are the two actions off while sending is — they clear a message to leave. Cohorts, sequences, timing and every drafted message still edit.
        </div>
      ) : !live ? (
        <div className="mx-4 sm:mx-5 mb-2 px-3 py-1.5 rounded-sm hairline bg-card text-[11px] text-mute shrink-0">
          Sending is <span className="text-ink">paused</span>, so the queue schedules people but delivers nothing. Resume it in Settings.
        </div>
      ) : null}

      {goneLive && (
        <div className="mx-4 sm:mx-5 mb-2 hairline rounded-sm bg-card p-2.5 text-[11px] shrink-0 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className={LABEL}>scheduled · {goneLive.live.length}</div>
            {goneLive.live.map((l) => (
              <div key={l.lead_id} className="mt-0.5 truncate">
                <span className="font-semibold">{l.name || l.lead_id}</span>
                <span className="text-mute"> — {l.steps} message{l.steps === 1 ? '' : 's'}</span>
              </div>
            ))}
            {goneLive.blocked.length > 0 && (
              <>
                <div className={LABEL + ' mt-1.5'}>not scheduled · {goneLive.blocked.length}</div>
                {goneLive.blocked.map((b) => (
                  <div key={b.lead_id} className="mt-0.5 text-mute truncate">
                    <span className="font-semibold text-ink">{b.name || b.lead_id}</span> — {b.reason}
                  </div>
                ))}
              </>
            )}
          </div>
          <button onClick={() => setGoneLive(null)} className="text-mute hover:text-ink shrink-0"><X size={12} /></button>
        </div>
      )}

      {approved && (
        <div className="mx-4 sm:mx-5 mb-2 hairline rounded-sm bg-card p-2.5 text-[11px] shrink-0 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className={LABEL}>approved · {approved.approved.length}</div>
            {approved.approved.map((a) => (
              <div key={a.lead_id} className="mt-0.5 truncate">
                <span className="font-semibold">{a.name || a.lead_id}</span>
                <span className="text-mute"> — message {(a.step ?? 0) + 1}</span>
              </div>
            ))}
            {approved.refused.length > 0 && (
              <>
                <div className={LABEL + ' mt-1.5'}>not approved · {approved.refused.length}</div>
                {approved.refused.map((b) => (
                  <div key={b.lead_id} className="mt-0.5 text-mute truncate">
                    <span className="font-semibold text-ink">{b.name || b.lead_id}</span> — {b.reason}
                  </div>
                ))}
              </>
            )}
          </div>
          <button onClick={() => setApproved(null)} className="text-mute hover:text-ink shrink-0"><X size={12} /></button>
        </div>
      )}

      {tick && (
        <div className="mx-4 sm:mx-5 mb-2 hairline rounded-sm bg-card p-2.5 text-[11px] shrink-0 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className={LABEL}>preview · {tick.due ?? 0} due</div>
            {!tick.results?.length && <div className="text-mute mt-0.5">Nothing is due right now.</div>}
            {tick.results?.map((r, i) => (
              <div key={i} className="mt-0.5 truncate">
                <span className="mono text-[9px] text-mute uppercase tracking-[0.14em]">{r.action}</span>{' '}
                <span className="font-semibold">{r.name || r.lead_id}</span>
                {r.text && <span className="text-mute"> — {r.text}</span>}
                {r.error && <span className="text-rose-600"> — {r.error}</span>}
              </div>
            ))}
          </div>
          <button onClick={() => setTick(null)} className="text-mute hover:text-ink shrink-0"><X size={12} /></button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {rows === null && <div className="text-sm text-mute py-16 text-center">Loading cohorts…</div>}
        {rows !== null && cohorts.length === 0 && (
          <div className="text-sm text-mute py-16 text-center leading-relaxed">
            No cohorts yet. Create one from Prospecting → Qualification by selecting prospects
            <br />and choosing <span className="text-ink">add to cohort</span>.
          </div>
        )}
        {/* No global thead: the headers repeat INSIDE each cohort, below its
            title row, so a cohort you scroll to always carries its own labels
            instead of relying on one strip far above. `table-fixed` is
            deliberately NOT used — auto layout is what lets every column shrink
            to its content while Next message takes whatever is left. */}
        {rows !== null && cohorts.length > 0 && (
          <table className="w-full border-collapse text-left">
            <tbody>
              {shown.map((c) => {
                const members = byCohort.get(c.id) || [];
                const isCollapsed = collapsed.has(c.id);
                // Select-all on a cohort covers everything actionable in it —
                // staged people to go live AND messages waiting for approval.
                const cohortReady = members.filter((m) => selectableIds.includes(m.lead_id)).map((m) => m.lead_id);
                const allSel = cohortReady.length > 0 && cohortReady.every((i) => sel.has(i));
                return (
                  <Fragment key={c.id}>
                    {/* ── the cohort itself ── */}
                    <tr className="border-b border-line bg-paper/70 whitespace-nowrap">
                      <td className={QTd + ' pl-2'}>
                        {cohortReady.length > 0 && (
                          <input type="checkbox" checked={allSel} onChange={() => toggleCohortSel(cohortReady)}
                            title={`Select the ${cohortReady.length} staged prospect${cohortReady.length === 1 ? '' : 's'} here`}
                            className="block h-3 w-3 accent-current cursor-pointer" />
                        )}
                      </td>
                      <td className={QTd} colSpan={3}>
                        <button type="button" onClick={() => toggleCollapse(c.id)}
                          className="flex items-center gap-1.5 group" title={isCollapsed ? 'Expand' : 'Collapse'}>
                          <span className="mono text-[10px]/[14px] text-mute w-2">{isCollapsed ? '▸' : '▾'}</span>
                          <span className="block font-semibold text-[11px]/[14px] group-hover:underline">{c.name}</span>
                          <span className={`mono text-[8px]/[14px] uppercase tracking-[0.14em] px-1 rounded-sm border ${COHORT_TONE[c.status]}`}
                            title={COHORT_WHY[c.status]}>
                            {c.status}
                          </span>
                        </button>
                      </td>
                      <td className={QTd} colSpan={3}>
                        <span className="block mono text-[9px]/[14px] text-mute truncate">
                          {members.length} shown · {c.total} total · {c.answered} answered
                          {c.has_sequence ? '' : ' · no sequence yet'}
                          {c.timezone ? ` · ${c.timezone}` : ''}
                        </span>
                      </td>
                      <td className={QTd + ' text-center'} colSpan={1}>
                        {!c.has_sequence && <span className="block mono text-[9px]/[14px] text-amber-600">setup</span>}
                      </td>
                      <td className={QTd + ' pr-2 text-right'}>
                        <button type="button" onClick={() => setEditing(c)}
                          className="inline-flex items-center whitespace-nowrap h-6 px-2.5 rounded-sm bg-ink text-paper mono text-[9px] uppercase tracking-[0.14em] hover:opacity-90"
                          title="Edit the whole cohort at once — status, sending window, languages and the message flow everyone receives">
                          bulk edit
                        </button>
                      </td>
                    </tr>

                    {/* ── this cohort's column headers ── */}
                    {!isCollapsed && members.length > 0 && (
                      <tr className="mono text-[9px] uppercase tracking-[0.14em] text-mute border-b border-line bg-paper/40">
                        <QTh className="w-px pl-2" title="select rows, then approve or go live">Pick</QTh>
                        <QTh className="w-px" title="untouched — never messaged · touched — we spoke, they have not · active — they replied · dead — marked, or long silent">Status</QTh>
                        <QTh className="w-px" title="name, with their company and role. Row colour is their place in the run: green live · amber staged · red blocked · blue they replied">Prospect</QTh>
                        {/* The only column given room: it holds the words that are
                            about to go to a person, which is what this sheet is for.
                            w-full against auto layout = "take whatever is left". */}
                        <QTh className="w-full" title="the next message, rendered for THIS person in their language. Double-click to rewrite it for them alone.">Next message</QTh>
                        <QTh className="w-px" title="draft — no send time yet · scheduled — it has one. Plus whether you have approved it.">State</QTh>
                        <QTh className="w-px" title="when it goes out, in the cohort's own timezone">Scheduled Send</QTh>
                        <QTh className="w-px text-center" title="how many of the cohort's messages they have ACTUALLY received">Sent</QTh>
                        <QTh className="w-px" title="the last message we actually sent them">Last sent</QTh>
                        <QTh className="w-px pr-2 text-right" title="pause, resume or take them out of the cohort">Run</QTh>
                      </tr>
                    )}

                    {/* ── its people ── */}
                    {!isCollapsed && members.length === 0 && (
                      <tr className="border-b border-line/60">
                        <td className={QTd} colSpan={9}>
                          <span className="block text-[11px]/[14px] text-mute pl-6">nobody here yet</span>
                        </td>
                      </tr>
                    )}
                    {!isCollapsed && members.map((r) => {
                      const tone = cohortTone(r);
                      const selectable = selectableIds.includes(r.lead_id);
                      return (
                        <Fragment key={r.lead_id}>
                        <tr className={'border-l-2 border-b border-line/60 transition-colors ' + Q_TINT[tone]}>
                          <td className={QTd + ' pl-2 w-px'}>
                            {selectable ? (
                              <input type="checkbox" checked={sel.has(r.lead_id)} disabled={!!r.blocked}
                                onChange={() => toggle(r.lead_id)}
                                title={r.blocked || (r.staged ? 'Select, then approve and/or go live' : 'Select, then approve this message')}
                                className="block h-3 w-3 accent-current cursor-pointer disabled:cursor-not-allowed disabled:opacity-40" />
                            ) : <span className="block w-3" />}
                          </td>
                          {/* Where their CONVERSATION stands, read first because it
                              is the question that decides what to do with the row.
                              A different question from the stripe, which is about
                              their place in the run — the dot was redundant beside
                              a coloured stripe, so this took its slot. */}
                          <td className={QTd + ' w-px'}>
                            <span
                              className={'block mono text-[8px]/[14px] uppercase tracking-[0.14em] px-1 rounded-sm border w-fit ' + CONVO_STYLE[r.conversation]}
                              title={CONVO_WHY[r.conversation] + (r.dead_by === 'stale' ? ' (went quiet)' : r.dead_by === 'marked' ? ' (you marked it)' : '')}>
                              {r.conversation}
                            </span>
                          </td>
                          {/* Name plain, company and role as tags — one column
                              instead of three, and the eye still lands on the name. */}
                          <td className={QTd + ' w-px max-w-[260px]'}
                            title={`${[r.name, r.company, r.position].filter(Boolean).join(' · ')}\n${Q_WHY[tone]}`}>
                            <div className="flex items-center gap-2 min-w-0">
                              <Avatar name={r.name} photo={r.photo} size={28} />
                              <div className="min-w-0">
                                <div className="truncate text-[12px]/[15px] font-medium">{r.name || '—'}</div>
                                <div className="truncate mt-0.5">
                                  {r.company && (
                                    <span className="mono text-[8px] uppercase tracking-[0.12em] px-1 py-px rounded-sm border border-[var(--color-line)] text-mute">
                                      {r.company}
                                    </span>
                                  )}
                                  {r.position && (
                                    <span className="mono text-[8px] uppercase tracking-[0.12em] px-1 py-px rounded-sm bg-paper/70 text-mute/80 ml-1">
                                      {r.position}
                                    </span>
                                  )}
                                  {!r.company && !r.position && <span className="text-[10px] text-mute/50">—</span>}
                                </div>
                              </div>
                            </div>
                          </td>
                          {/* Double-click rewrites this message for this person
                              alone. Nothing is saved without the confirm step. */}
                          <td className={QTd + ' w-full max-w-0'}
                            onDoubleClick={(e) => { if (r.next_text && !r.answered) { setAnchor(e.currentTarget.getBoundingClientRect()); setEditingMsg(r.lead_id); } }}
                            title={r.next_text && !r.answered ? 'Double-click to rewrite this message for this person' : undefined}>
                            {r.answered ? (
                              <span className="block truncate text-[11px]/[14px] text-mute">stopped — they replied</span>
                            ) : r.blocked ? (
                              <span className="block truncate text-[11px]/[14px] text-rose-600" title="Fix this before they can go live">{r.blocked}</span>
                            ) : r.next_text ? (
                              <span className="block truncate text-[11px]/[14px] cursor-text" title={r.next_text}>
                                {r.edited && (
                                  <span className="mono text-[8px] uppercase tracking-[0.14em] text-sky-600 mr-1" title="Edited for this person — the cohort's copy is unchanged">edited</span>
                                )}
                                {r.next_text}
                              </span>
                            ) : (
                              <span className="block truncate text-[11px]/[14px] text-mute">
                                {r.status === 'paused' ? 'paused'
                                  : r.exhausted || r.status === 'done' ? 'sequence finished'
                                  : r.status === 'stopped' ? `stopped${r.stop_reason ? ` — ${r.stop_reason}` : ''}`
                                  : '—'}
                              </span>
                            )}
                          </td>

                          {/* draft vs scheduled, and whether it is approved to go.
                              A single click opens the menu — a dropdown you have to
                              double-click is a dropdown nobody finds. */}
                          <td className={QTd + ' w-px whitespace-nowrap'}
                            onClick={(e) => { if (!r.answered && r.next_state) openCell(r.lead_id, 'state', e.currentTarget); }}
                            title={!r.answered && r.next_state ? 'Click to approve, or change whether this is scheduled' : undefined}>
                            {editingCell === `${r.lead_id}:state` && (
                              <StateMenu row={r} anchor={anchor} sendOff={sendOff} sendOffWhy={sendOffWhy}
                                onCancel={() => setEditingCell(null)}
                                onSaved={async () => { setEditingCell(null); await load(); }} />
                            )}
                            {r.answered || !r.next_state ? QDASH : (
                              <span className="block leading-[14px]">
                                <span className={'mono text-[8px] uppercase tracking-[0.14em] px-1 rounded-sm border '
                                  + (r.next_state === 'scheduled'
                                    ? 'text-emerald-600 border-emerald-500/30 bg-emerald-500/10'
                                    : 'text-amber-600 border-amber-500/30 bg-amber-500/10')}
                                  title={r.next_state === 'scheduled' ? 'has a send time' : 'written, but nobody has gone live yet'}>
                                  {r.next_state}
                                </span>
                                {r.approval_required && (
                                  r.approved
                                    ? <span className="mono text-[8px] uppercase tracking-[0.14em] text-sky-600 ml-1" title="You approved this exact message. Approval lapses once it is sent.">approved</span>
                                    : <span className="mono text-[8px] uppercase tracking-[0.14em] text-mute/70 ml-1" title="The sender will not deliver this until you approve it">needs ok</span>
                                )}
                              </span>
                            )}
                          </td>

                          {/* When it goes out, in the cohort's own zone. */}
                          <td className={QTd + ' w-px whitespace-nowrap'}
                            onDoubleClick={(e) => { if (!r.answered) openCell(r.lead_id, 'sending', e.currentTarget); }}
                            title={r.answered ? undefined : 'Double-click to change when this goes out'}>
                            {editingCell === `${r.lead_id}:sending` ? (
                              <SendingEditor row={r} anchor={anchor} sendOff={sendOff}
                                onCancel={() => setEditingCell(null)}
                                onSaved={async () => { setEditingCell(null); await load(); }} />
                            ) : r.next_send_label ? (
                              <span className={'block mono text-[9px]/[14px] ' + (r.due_today ? 'text-ink font-semibold' : 'text-mute')}
                                title={`${r.next_send_label} ${r.next_send_zone || ''} · ${r.timezone}`}>
                                {r.due_today && <span className="text-amber-600">today </span>}
                                {r.next_send_label}
                                <span className="text-mute/70"> {r.next_send_zone}</span>
                              </span>
                            ) : r.staged ? (
                              <span className="block mono text-[9px]/[14px] text-amber-600">not scheduled</span>
                            ) : QDASH}
                          </td>

                          {/* How many they have ACTUALLY received — 0/3 until the
                              first one has really gone out, not 1/3. */}
                          <td className={QTd + ' w-px text-center'}>
                            {r.ladder_length
                              ? <span className="block mono text-[10px]/[14px] text-mute whitespace-nowrap"
                                  title={`${r.sent_count} of ${r.ladder_length} messages sent`}>
                                  {r.sent_count}/{r.ladder_length}
                                </span>
                              : QDASH}
                          </td>
                          {/* Last, deliberately: what we already said matters
                              less, in the moment, than what is about to go out. */}
                          <td className={QTd + ' w-px max-w-[200px]'}>
                            {r.last_sent_text ? (
                              <span className="block truncate text-[11px]/[14px]" title={r.last_sent_text}>
                                {r.last_sent_text}
                                <span className="mono text-[9px]/[14px] text-mute"> · {whenText(r.last_sent_at)}</span>
                              </span>
                            ) : QDASH}
                          </td>
                          <td className={QTd + ' pr-2 text-right whitespace-nowrap'}>
                            {!r.answered && (r.status === 'active' || r.status === 'paused') && (
                              <button type="button" disabled={busy === r.lead_id}
                                onClick={() => act(r.lead_id, r.status === 'active' ? 'pause' : 'resume')}
                                className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-ink disabled:opacity-40 mr-2 align-middle">
                                {r.status === 'active' ? 'pause' : 'resume'}
                              </button>
                            )}
                            <button type="button" disabled={busy === r.lead_id} onClick={() => act(r.lead_id, 'remove')}
                              className="text-mute hover:text-rose-600 disabled:opacity-40 align-middle"
                              title="Take out of the cohort — the conversation itself is untouched">
                              <Trash size={11} />
                            </button>
                          </td>
                        </tr>
                        {editingMsg === r.lead_id && (
                          <tr className={'border-l-2 border-b border-line/60 ' + Q_TINT[tone]}>
                            <td className={QTd} colSpan={2} />
                            <td className={QTd + ' pb-2'} colSpan={7}>
                              <MessageEditor
                                row={r}
                                anchor={anchor}
                                sendOff={sendOff}
                                onCancel={() => setEditingMsg(null)}
                                onSaved={async () => { setEditingMsg(null); await load(); }}
                              />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <CohortSettings cohort={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </div>
  );
}

// ── the module ─────────────────────────────────────────────────────────────
export default function Outreach() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'conversations');
  const go = (t: Tab) => { setTab(t); localStorage.setItem(TAB_KEY, t); };

  // Asked for the first time Outreach is opened, not during onboarding.
  const prereqs = useModulePrereqs('outreach');
  const gated = prereqs.phase === 'gate' && !!prereqs.status;
  const sendOff = prereqs.needsGateway('whatsapp');
  const sendOffWhy = prereqs.gapFor('whatsapp')?.why
    || 'WhatsApp is not connected, so nothing can leave this machine.';

  const content = tab === 'conversations'
    ? <Conversations sendOff={sendOff} sendOffWhy={sendOffWhy} />
    : <Cohorts sendOff={sendOff} sendOffWhy={sendOffWhy} />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 pt-5 shrink-0">
        <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">
          <WhatsApp size={12} />
          <span>Outreach · the prospects worth approaching</span>
        </div>
        {!gated && (
          <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit">
            {([['conversations', 'Conversations'], ['cohorts', 'Cohorts']] as [Tab, string][]).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => go(k)}
                className={
                  'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.18em] transition ' +
                  (tab === k ? 'bg-paper text-ink' : 'text-mute hover:text-ink')
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {!gated && sendOff && (
          <DegradedNotice
            className="mt-3"
            note={<>Conversations, prospects, cohorts and drafted messages all read and edit normally. <strong className="font-semibold">Sending is off</strong> — nothing goes out, and nothing is queued to go out.</>}
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
