// Step three of setup: a conversation, not a wizard.
//
// The operator already has an account and a model key by the time they get
// here, and they are signed in — this screen is the last thing standing
// between them and the app, which is exactly why it must never feel like a
// gate. The interview (driven entirely by the worker, which reads the
// onboarding playbook) collects their facts, samples of their own writing and
// their real positions, and writes their voice documents. Finish it and the
// command center writes like them. Postpone it and the app runs on the shipped
// defaults until they come back, which they can do from the banner or from
// Settings at any time.
//
// Four things this screen has to get right:
//
// 1. LONG PASTES. Step 2 of the playbook asks for three to five whole pieces
//    of the operator's own writing. The composer grows with the text, sends on
//    ⌘/Ctrl+Enter (so Enter can make a paragraph without firing the message),
//    and every bubble renders with `whitespace-pre-wrap` — their line breaks,
//    double spaces and quirks reach the server exactly as pasted. Nothing here
//    trims, normalises or "cleans up" what they wrote; that text IS the voice.
// 2. RTL. `dir="auto"` on every bubble and on the composer, same as the
//    Outreach inbox: the first strong letter decides direction, so a Hebrew
//    sample reads right-to-left next to an English one in the same thread.
// 3. RESUMING. The worker stores the transcript, so a refresh mid-interview
//    replays the real conversation. A local copy is kept only as a fallback
//    for when that read fails — losing four pasted posts to a blip is
//    unforgivable.
// 4. DEGRADING. Every failure mode ends somewhere the operator can act: a
//    build without the routes, a browser that lacks setup access, an install
//    someone else already claimed. All of them offer the ordinary sign-in
//    screen rather than trapping them in a chat that cannot answer.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  onboarding, OnboardingUnavailable,
  type OnboardingMessage, type OnboardingThreadMessage,
} from '../lib/api';
import { OnboardingGateways } from './OnboardingGateways';
import { Network, Mic } from './Icons';

// Dictation. Setup asks people to talk about what they believe and what they
// have built, and that is answered far better out loud than typed — the
// playbook even falls back to "say it out loud" when an operator has no
// writing samples. Speech recognition is browser-native and absent in some
// browsers, so the button only appears where it actually works.
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
function speechCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null;
}

// Fallback copy of the thread, for when the server transcript can't be read.
const STORE_KEY = 'nyyon.onboarding.v1';

// The rail REPORTS the server's stage; it never advances on its own, and when
// the server names something we don't recognise we print its word instead of
// guessing which chip to light.
//
// It shows THIS CONVERSATION's two halves and nothing else. It used to carry
// the account and model-key steps as lit chips, because this screen was step
// three of a four-step corridor and seeing two greens told an operator most of
// setup was behind them. That corridor is gone: setup ends at the model key,
// and this conversation is now reached from wherever the operator ran into the
// documents it writes (a module's prerequisite gate, the resume banner,
// Settings). Chips for two steps that happened weeks ago would be archaeology.
//
// The interview's own internal phases (facts, samples, positions, drafts) all
// light the same first chip — they are one conversation to the person having
// it, and four chips creeping forward while nothing visibly changes read as a
// progress bar that lies.
const STEPS = [
  { id: 'nyo',      label: 'Your voice', match: /(welcome|facts|intro|start|company|basic|interview|sample|position|belief|perspective|draft|review|document)/ },
  { id: 'gateways', label: 'Services',   match: /(gateway|service|connect)/ },
] as const;

function matchStep(raw: string | null): number {
  if (!raw) return -1;
  const s = raw.toLowerCase();
  return STEPS.findIndex((st) => st.match.test(s));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// What the page reads out of the server's opaque `state` blob. Anything it
// cannot find stays null/empty and simply isn't rendered.
type Progress = { step: string | null; docs: string[]; connected: string[] };
function readProgress(state: unknown, prev: Progress): Progress {
  if (!state || typeof state !== 'object') return prev;
  const s = state as Record<string, unknown>;
  return {
    step: str(s.step) ?? prev.step,
    docs: 'docs_saved' in s ? strList(s.docs_saved) : prev.docs,
    connected: 'gateways_connected' in s ? strList(s.gateways_connected) : prev.connected,
  };
}

type Item = { role: 'user' | 'assistant' | 'tool'; content: string; tool_name?: string | null };

// Only real turns go back up. Tool rows are the server's own beats.
const toMessages = (items: Item[]): OnboardingMessage[] =>
  items.filter((m): m is Item & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant');

function loadLocal(): Item[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    if (!Array.isArray(p?.messages)) return [];
    return p.messages.filter(
      (m: unknown): m is Item =>
        !!m && typeof m === 'object' &&
        ['user', 'assistant', 'tool'].includes((m as Item).role) &&
        typeof (m as Item).content === 'string',
    );
  } catch { return []; }
}

// A tool row printed as a beat. The stored content is a raw result blob
// ({"ok":true,"slug":"serp"}) — dumping that into the conversation is
// debugging output, not a beat, so it is read for its meaning and thrown away.
function toolBeat(m: Item): { ok: boolean; text: string } {
  const label = (m.tool_name || 'step').replace(/_/g, ' ').trim();
  let ok = true;
  let detail = '';
  try {
    const p = JSON.parse(m.content) as Record<string, unknown>;
    if (p && typeof p === 'object') {
      if (p.ok === false) ok = false;
      detail = str(p.slug) || str(p.title) || str(p.key) || str(p.error) || '';
      if (p.configured === false) detail = detail ? `${detail} · not configured` : 'not configured';
    }
  } catch {
    // Not JSON. A short human line is worth showing; anything longer is noise.
    const body = m.content.trim();
    if (body.length <= 80) detail = body;
  }
  return { ok, text: detail ? `${label} · ${detail}` : label };
}

export function Onboarding({ initialStep, onLeave }: {
  initialStep?: string | null;
  /** into the app — they postponed, finished, or hit a wall here */
  onLeave: () => void;
}) {
  const [items, setItems]   = useState<Item[]>([]);
  const [input, setInput]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  // Set when the interview cannot continue AT ALL on this browser (no routes,
  // no setup access, install already claimed). The only offer left is the door.
  const [dead, setDead]     = useState(false);
  const [progress, setProgress] = useState<Progress>({ step: initialStep ?? null, docs: [], connected: [] });
  const [done, setDone]     = useState(false);

  const [panelOpen, setPanelOpen]   = useState(false);
  // The server hands the gateways step to the app: keys are copy-paste work,
  // so they get real form fields instead of being read out in a chat. Once the
  // operator finishes or skips, the conversation resumes.
  const [gatewayStepDone, setGatewayStepDone] = useState(false);
  // Leaving, either way. Separate busy flags from the conversation's, so
  // neither control can be pressed twice while its request is in flight.
  const [leaving, setLeaving] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const endRef  = useRef<HTMLDivElement | null>(null);
  const taRef   = useRef<HTMLTextAreaElement | null>(null);
  const started = useRef(false);

  // Dictation. Interim results are shown live so the operator can see it is
  // hearing them, but only final segments are appended to the real input —
  // otherwise a long answer accumulates every revision the recogniser made on
  // its way to the sentence.
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationAvailable = useRef(!!speechCtor()).current;

  const stopDictation = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    recRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  const toggleDictation = useCallback(() => {
    if (listening) { stopDictation(); return; }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    // Left to the browser's own locale so an operator dictating Hebrew is not
    // forced through an English recogniser.
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let settled = '';
      let pending = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i];
        const text = seg[0]?.transcript ?? '';
        if (seg.isFinal) settled += text; else pending += text;
      }
      if (settled) {
        setInput((prev) => (prev ? `${prev.replace(/\s+$/, '')} ${settled.trim()}` : settled.trim()));
      }
      setInterim(pending);
    };
    rec.onerror = () => stopDictation();
    rec.onend = () => { recRef.current = null; setListening(false); setInterim(''); };
    recRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { stopDictation(); }
  }, [listening, stopDictation]);

  // Never leave the microphone open behind a closed screen.
  useEffect(() => stopDictation, [stopDictation]);

  // Turn an OnboardingUnavailable into something the operator can act on. The
  // status is the whole story: 404 = setup is finished or this build has no
  // interview; 401 = the session went away (setup belongs to the signed-in
  // operator from step one onward); 403 = this browser is not the setup
  // machine, which can only happen before an account exists.
  const explain = useCallback((e: unknown): { message: string; fatal: boolean } => {
    const status = e instanceof OnboardingUnavailable ? e.status : -1;
    if (status === 404) return { message: 'Setup is already finished on this install, or this build has no setup interview.', fatal: true };
    if (status === 403) return { message: 'This browser is not authorized to run setup. Open the app on the machine it is installed on, or use the setup link the installer printed.', fatal: true };
    if (status === 401) return { message: 'Your session expired. Sign in again and the interview picks up where it stopped.', fatal: true };
    return { message: e instanceof Error ? e.message : String(e), fatal: false };
  }, []);

  // "Later." The account exists, so leaving here is not abandoning setup — it
  // is going into the app with the shipped default voice documents while this
  // thread waits exactly where it stopped. The server records the
  // postponement (which is NOT completion) and the app raises the way back.
  const leave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    try { await onboarding.defer(); } catch { /* going in anyway — the banner reads server state */ }
    onLeave();
  }, [leaving, onLeave]);

  // The other ending, and the irreversible one: this closes the setup surface
  // for good. Only offered once the documents exist — see `canFinish`.
  const finish = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    try {
      await onboarding.finish('operator');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFinishing(false);
    }
  }, [finishing]);

  // One request per turn. The whole thread goes up; the worker keeps its own
  // record and takes what it needs.
  //
  // `resend: false` sends NO messages — a nudge that asks the worker to answer
  // from the transcript it already holds. That is what a retry needs after a
  // turn failed late: re-posting the operator's words would store them twice.
  const runTurn = useCallback(async (thread: Item[], opts: { resend?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const turn = await onboarding.chat(opts.resend === false ? [] : toMessages(thread));
      const reply = typeof turn?.reply === 'string' ? turn.reply : '';
      setItems(reply ? [...thread, { role: 'assistant', content: reply }] : thread);
      setProgress((p) => readProgress(turn?.state, p));
      // `done` means the interview called finish_setup: the documents are
      // written and this surface has just closed itself server-side.
      if (turn?.done) setDone(true);
    } catch (e) {
      // Keep the operator's message in the thread — it may be a 900-word
      // sample, and it is theirs.
      setItems(thread);
      const { message, fatal } = explain(e);
      setError(message);
      if (fatal) setDead(true);
    } finally {
      setBusy(false);
    }
  }, [explain]);

  // Mount: replay the server's transcript, fall back to the local copy, and
  // only ask for an opening question when there is genuinely nothing yet.
  //
  // The ref guard is the ONLY guard: StrictMode mounts, unmounts and remounts,
  // and an abort-on-cleanup here would cancel the one hydration that ran and
  // leave the second pass short-circuited by the ref — an empty thread on a
  // conversation the server already has.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let thread: Item[] = [];
      try {
        const rows = await onboarding.transcript();
        thread = rows.map((r: OnboardingThreadMessage) => ({
          role: r.role, content: String(r.content ?? ''), tool_name: r.tool_name ?? null,
        }));
      } catch (e) {
        const { message, fatal } = explain(e);
        if (fatal) { setDead(true); setError(message); setHydrating(false); return; }
        thread = loadLocal();   // worker blip: the browser copy is better than nothing
      }
      setItems(thread);
      setHydrating(false);
      if (thread.length === 0) void runTurn([]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Never write an empty thread over a good one: a failed hydrate leaves
  // `items` empty for a moment, and that must not erase the copy that is the
  // whole point of this fallback.
  useEffect(() => {
    if (hydrating || items.length === 0) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ messages: items.slice(-200) })); }
    catch { /* quota — the interview still works, the local fallback just won't */ }
  }, [items, hydrating]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [items, busy, done]);

  // Grow the composer with the text instead of scrolling a two-line box —
  // pasting a whole post into a 2-row textarea makes it unreviewable. Empty
  // box: clear the inline height and let `rows` govern, rather than trusting a
  // scrollHeight measured before the layout settled (that reads absurdly large
  // on first paint and leaves half a screen of empty box).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = input ? `${Math.min(el.scrollHeight, 320)}px` : '';
  }, [input]);

  // `text` lets a STEP hand its outcome back to the conversation ("done with
  // services", "skipped") without the operator having to type it.
  function send(text?: string) {
    const body = text ?? input;
    // Only the emptiness check trims. What gets sent is the raw value:
    // trailing blank lines and double spaces are part of how they write.
    if (!body.trim() || busy || dead) return;
    const next: Item[] = [...items, { role: 'user', content: body }];
    setItems(next);
    if (text === undefined) setInput('');
    void runTurn(next);
  }

  // Retry, without ever storing the operator's words twice. The worker's own
  // transcript decides: if it already ends with what they said, the turn only
  // needs a nudge; if their message never landed, it goes up again.
  async function retry() {
    if (busy) return;
    setError(null);
    let rows: Item[] | null = null;
    try {
      rows = (await onboarding.transcript()).map((r: OnboardingThreadMessage) => ({
        role: r.role, content: String(r.content ?? ''), tool_name: r.tool_name ?? null,
      }));
    } catch { rows = null; }
    if (!rows) { void runTurn(items); return; }   // can't check — send it as it stands
    const lastLocal  = [...items].reverse().find((m) => m.role === 'user')?.content ?? null;
    const lastServer = [...rows].reverse().find((m) => m.role === 'user')?.content ?? null;
    if (lastLocal && lastLocal !== lastServer) { void runTurn(items); return; }
    setItems(rows);
    void runTurn(rows, { resend: false });
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘/Ctrl+Enter sends. Plain Enter makes a new line, because this composer
    // exists to hold multi-paragraph pastes.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  }

  // The server says "gateways" when the voice docs are done. The app takes the
  // step from there — an API key belongs in a form field, not in a chat
  // transcript that also stores it as a message.
  const gatewayStep = /gateway|service/i.test(progress.step || '') && !gatewayStepDone && !done && !dead;
  // Everything setup exists to produce is produced, and the services screen is
  // behind them: from here closing setup is the operator's to do, whether or
  // not the guide gets round to offering it.
  const canFinish = progress.docs.length >= 2 && gatewayStepDone && !done && !dead && !busy;
  const activeIdx  = matchStep(progress.step);
  const lines      = input ? input.split('\n').length : 0;

  // Setup is a moment, not a workspace: one card, floated on the app's own
  // background, so it reads as a thing you finish and leave rather than a
  // surface you live in. The card is a fixed height so the conversation
  // scrolls INSIDE it — a card that grows with the transcript would drift back
  // into looking like the app.

  return (
    <div className="fixed inset-0 z-50 bg-paper overflow-y-auto">
      <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-3xl">

          {/* ── above the card: identity + the two ways out ─────────────── */}
          <div className="flex items-center justify-between gap-3 mb-3 px-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute truncate">nyyon · setup</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setPanelOpen((v) => !v)}
                title="Connect services — all optional"
                className={
                  'mono inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm hairline text-[10px] uppercase tracking-wider transition ' +
                  (panelOpen ? 'bg-ink text-paper' : 'bg-card/60 text-mute hover:text-ink')
                }
              >
                <Network size={12} />
                <span className="hidden sm:inline">Connections</span>
                {progress.connected.length > 0 && <span className="text-emerald-600">{progress.connected.length}</span>}
              </button>
              {/* The way out, in plain sight and in plain words. An operator
                  who cannot see one spends the interview wondering whether
                  they are trapped in it, which is a worse tax than the
                  fifteen minutes. */}
              <button
                onClick={() => void leave()}
                disabled={leaving}
                title="Go into the app — this conversation waits here"
                className="mono h-7 px-2.5 rounded-sm text-[10px] uppercase tracking-wider text-mute hover:text-ink transition disabled:opacity-40"
              >
                {leaving ? 'opening…' : 'Finish later'}
              </button>
            </div>
          </div>

          {/* ── the card ───────────────────────────────────────────────── */}
          <div className="bg-card hairline rounded-lg shadow-xl overflow-hidden flex flex-col h-[min(78vh,44rem)]">

            {/* header: what this conversation is, and the two halves of it.
                No "step N of the whole setup" any more — this is not a stage in
                a corridor, it is a thing the operator came to do (or came back
                to), and it can be left half-done without failing anything. */}
            <div className="shrink-0 px-5 pt-4 pb-3 border-b border-line">
              <div className="flex items-baseline justify-between gap-3 mb-2.5">
                <h1 className="text-[15px] font-semibold">
                  {activeIdx >= 0 ? STEPS[activeIdx].label : 'Your voice'}
                </h1>
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-mute shrink-0">
                  stop any time
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {STEPS.map((s, i) => {
                  const isActive = activeIdx === i;
                  const isPast   = activeIdx > i;
                  return (
                    <div key={s.id} className="flex-1 min-w-0" title={s.label}>
                      <div
                        className={
                          'h-1 rounded-full transition-colors ' +
                          (isPast ? 'bg-emerald-500' : isActive ? 'bg-ink' : 'bg-[var(--color-line)]')
                        }
                      />
                      <div
                        className={
                          'mono text-[8px] uppercase tracking-[0.12em] mt-1.5 truncate transition-colors ' +
                          (isActive ? 'text-ink' : isPast ? 'text-emerald-600' : 'text-mute/60')
                        }
                      >
                        {s.label}
                      </div>
                    </div>
                  );
                })}
              </div>
              {progress.docs.length > 0 && (
                <div className="mono text-[9px] uppercase tracking-[0.14em] text-emerald-600 mt-2.5 truncate">
                  ✓ written: {progress.docs.join(' · ')}
                </div>
              )}
            </div>

      {/* `relative` so the connections panel can take this area over without
          covering the step header — the operator keeps their bearings while
          they go off to connect something. */}
      <div className="flex-1 min-h-0 flex relative">
        {/* ── the conversation ─────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6">
            <div className="mx-auto w-full max-w-2xl space-y-5">
              {items.length === 0 && !busy && !error && (
                <p className="text-[13px] leading-relaxed text-mute">
                  This is the setup conversation. It writes your voice documents from your own words, and everything it
                  writes stays editable afterwards in Knowledge.
                </p>
              )}

              {items.map((m, i) => {
                if (m.role === 'tool') {
                  const b = toolBeat(m);
                  return (
                    <div key={i} className="flex justify-center">
                      <span
                        dir="auto"
                        className={
                          'mono text-[9px] uppercase tracking-[0.16em] px-2 py-1 rounded-sm bg-card/60 hairline ' +
                          (b.ok ? 'text-mute' : 'text-rose-600')
                        }
                      >
                        {b.ok ? '✓' : '✗'} {b.text}
                      </span>
                    </div>
                  );
                }
                const isUser = m.role === 'user';
                const prev = items[i - 1];
                const showLabel = !prev || prev.role !== m.role;
                return (
                  <div key={i} className={'flex flex-col ' + (isUser ? 'items-end' : 'items-start')}>
                    {showLabel && (
                      <div className={'mono text-[10px] uppercase tracking-[0.18em] text-mute mb-1 ' + (isUser ? 'mr-1' : 'ml-1')}>
                        {isUser ? 'You' : 'Setup'}
                      </div>
                    )}
                    {/* dir="auto" + whitespace-pre-wrap: the first strong letter
                        picks the direction, and the text renders exactly as it
                        was typed or pasted. */}
                    <div
                      dir="auto"
                      className={
                        'text-[13px] leading-relaxed whitespace-pre-wrap break-words ' +
                        (isUser
                          ? 'max-w-[85%] bg-ink text-paper rounded-2xl rounded-tr-sm px-3.5 py-2 shadow-sm'
                          : 'max-w-[90%] bg-card/80 hairline text-ink rounded-2xl rounded-tl-sm px-3.5 py-2')
                      }
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}

              {busy && (
                <div className="flex flex-col items-start">
                  <div className="mono text-[10px] uppercase tracking-[0.18em] text-mute mb-1 ml-1">Setup</div>
                  <div className="bg-card/80 hairline rounded-2xl rounded-tl-sm px-3.5 py-2.5 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-mute animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-mute animate-bounce" style={{ animationDelay: '140ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-mute animate-bounce" style={{ animationDelay: '280ms' }} />
                    <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute ml-1.5">thinking</span>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-sm hairline bg-card/60 px-3 py-2.5">
                  <div className="text-[12px] text-rose-600 leading-relaxed">{error}</div>
                  <div className="mt-2 flex items-center gap-2">
                    {!dead && (
                      <button
                        onClick={() => void retry()}
                        disabled={busy}
                        className="mono text-[10px] uppercase tracking-wider px-2 h-7 rounded-sm hairline bg-card/60 text-mute hover:text-ink transition disabled:opacity-40"
                      >
                        Retry
                      </button>
                    )}
                    {/* Every failure here still ends somewhere they can act.
                        They already have an account, so the door is the app
                        itself, not a login form. */}
                    <button
                      onClick={onLeave}
                      className="mono text-[10px] uppercase tracking-wider px-2 h-7 rounded-sm hairline bg-card/60 text-mute hover:text-ink transition"
                    >
                      Go to the app
                    </button>
                  </div>
                </div>
              )}

              <div ref={endRef} />
            </div>
          </div>

          {/* The interview normally closes itself: the guide calls finish_setup
              once the documents are written and the services screen is behind
              them. When it doesn't — a model that drifts, a turn that runs out
              of hops — the operator is left with everything done and no way to
              say so, on the one surface that is supposed to end. This strip is
              that way, and it appears only in exactly that state. */}
          {canFinish && (
            <div className="shrink-0 border-t border-line bg-card/40 px-4 py-2.5 flex items-center gap-3">
              <span className="text-[12px] leading-relaxed text-mute min-w-0 flex-1">
                Your voice documents are written. You can keep talking, or close setup here.
              </span>
              <button
                type="button"
                onClick={() => void finish()}
                disabled={finishing}
                className="mono shrink-0 h-8 px-3 rounded-sm bg-emerald-500 text-white text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
              >
                {finishing ? 'finishing…' : 'finish setup'}
              </button>
            </div>
          )}

          {/* ── composer ───────────────────────────────────────────────── */}
          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="shrink-0 border-t border-line bg-card/40 px-4 py-3"
          >
            <div className="mx-auto w-full max-w-2xl">
              <textarea
                ref={taRef}
                dir="auto"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                disabled={dead}
                placeholder="Type, or paste a whole post. Line breaks are kept exactly as you write them."
                // text-base under lg: iOS Safari zooms the page on any focused
                // input under 16px, which throws the layout off mid-answer.
                className="w-full resize-none rounded-sm hairline bg-card/90 px-3 py-2 text-base lg:text-[13px] leading-relaxed placeholder:text-mute focus:border-emerald-500 focus:outline-none transition max-h-[320px] overflow-y-auto disabled:opacity-50"
              />
              <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                <span className="mono text-[10px] tracking-wider text-mute">
                  {listening
                    ? (interim ? `listening · ${interim.slice(-60)}` : 'listening…')
                    : input.length > 400
                      ? `${input.length.toLocaleString()} chars · ${lines} line${lines === 1 ? '' : 's'} · kept verbatim`
                      : '⌘↵ to send · ↵ for a new line'}
                </span>
                <div className="flex items-center gap-2">
                  {dictationAvailable && !dead && (
                    <button
                      type="button"
                      onClick={toggleDictation}
                      title={listening ? 'Stop dictation' : 'Dictate your answer'}
                      aria-label={listening ? 'Stop dictation' : 'Dictate your answer'}
                      aria-pressed={listening}
                      className={
                        'inline-flex items-center justify-center h-7 w-7 rounded-sm transition ' +
                        (listening ? 'bg-rose-500 text-white' : 'hairline bg-card/60 text-mute hover:text-ink')
                      }
                    >
                      <Mic size={13} />
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!input.trim() || busy || dead}
                    className="mono inline-flex items-center h-7 px-3 rounded-sm bg-ink text-paper text-[11px] uppercase tracking-wider disabled:opacity-40"
                  >
                    Send →
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>

        {/* The interview is over: the conversation closes and the last thing on
            screen is the one action left. Leaving a dead chat box under a
            finished setup invites people to keep typing at something that has
            stopped listening. */}
        {done && !dead && (
          <aside className="absolute inset-0 z-20 bg-card flex flex-col">
            <div className="h-12 shrink-0 px-4 border-b border-line panel flex items-center">
              <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Setup complete</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
              <div className="rounded-sm hairline bg-card/70 p-4">
                <div className="mono text-[10px] uppercase tracking-[0.18em] text-emerald-600 mb-2">✓ done</div>
                <p className="text-[13px] leading-relaxed text-mute mb-1">
                  Your voice documents are written. Everything the command center drafts from here reads them
                  first.
                </p>
                <p className="text-[12px] leading-relaxed text-mute mb-4">
                  All of it stays editable in the Knowledge module — the documents are yours, not a setting you
                  had one chance to get right.
                </p>
                {progress.docs.length > 0 && (
                  <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute mb-4 break-words">
                    written: {progress.docs.join(' · ')}
                  </div>
                )}
                <button
                  onClick={onLeave}
                  className="mono w-full h-9 rounded-sm bg-emerald-500 text-white text-[11px] uppercase tracking-[0.14em] transition"
                >
                  open the command center
                </button>
              </div>
            </div>
          </aside>
        )}

        {(panelOpen || gatewayStep) && !done && (
          <OnboardingGateways
            asStep={gatewayStep && !panelOpen}
            onClose={() => { setPanelOpen(false); if (gatewayStep) { setGatewayStepDone(true); send('Done with services.'); } }}
            onSkip={() => { setGatewayStepDone(true); send('Skip services for now.'); }}
          />
        )}
      </div>
          </div>

          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute/70 text-center mt-3">
            everything written here stays editable in Knowledge
          </p>
        </div>
      </div>
    </div>
  );
}
