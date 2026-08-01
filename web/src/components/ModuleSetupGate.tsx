// The one surface a module raises when it is missing something it needs.
//
// Setup stops at the model key now. Everything that used to sit in the corridor
// behind it — the voice interview, the service connections — has moved to the
// moment it is actually needed, which is the moment the operator opens the
// module that uses it. This is that moment, and there is ONE of it, driven by
// the server's prerequisite table (/api/modules/:slug/status) rather than five
// bespoke empty states that would each drift on their own.
//
// FOUR RULES, in order of how easy they are to get wrong:
//
// 1. IT NEVER BLOCKS. "Skip, I'll do this later" is always there, and taking it
//    hands the page straight back (the page then renders degraded and says so —
//    components/DegradedNotice.tsx). A module the operator paid for and
//    installed is theirs to open half-configured; a wall is how a product loses
//    somebody in the first five minutes. Every prerequisite therefore states
//    what still works without it.
// 2. IT NAMES THE THING, NOT THE CHORE. "Outreach reads and sends WhatsApp
//    messages, so it needs the WhatsApp connection" is a reason. "Setup
//    incomplete" is a task. The server writes those sentences
//    (lib/module-prereqs.js `why`), because the reason belongs next to the
//    declaration that justifies it — never invented here.
// 3. THE FIX IS RIGHT HERE. A gateway gets its real connect form inline — the
//    same fields the setup screen renders, from the same shared component
//    (GatewayFields.tsx). The voice documents get Nyo's interview: the same
//    engine and the same playbook the setup sequence runs, opened over the app
//    by the shell.
// 4. IT KNOWS NOTHING ABOUT ANY MODULE. Everything on screen comes from the
//    status payload. Adding a prerequisite to a module is a line in the
//    worker's table, never a change here.
//
// WHO DECIDES WHEN THIS SHOWS: the page does (lib/module-status.ts holds the
// read, the skip and the phase). This component is handed the status and the
// two endings — `onDone` when the gap is closed, `onSkip` when the operator
// walks past it — and owns nothing but the screen in between.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { modulePrereqs, type ModulePrereqField } from '../lib/api';
import { GatewayFieldInput, gatewayConfigFrom, gatewayMissingRequired } from './GatewayFields';
import { Check, Network, Sparkle } from './Icons';

// ── the shell's two signals ─────────────────────────────────────────────────
// Fired at the shell, which owns the interview overlay (App.tsx). The gate does
// not mount the conversation itself: it belongs over the whole app, not inside
// one page's scroll area, and the shell has to know when it is open.
export const OPEN_INTERVIEW_EVENT = 'nyyon:open-setup-interview';
// Fired BY the shell when the interview closes, and here after a connect lands:
// anything showing prerequisite state should re-read it.
export const PREREQS_CHANGED_EVENT = 'nyyon:prereqs-changed';

export function openSetupInterview(reason: string) {
  window.dispatchEvent(new CustomEvent(OPEN_INTERVIEW_EVENT, { detail: { reason } }));
}
export function announcePrereqsChanged() {
  window.dispatchEvent(new CustomEvent(PREREQS_CHANGED_EVENT));
}

// ── what this renders ───────────────────────────────────────────────────────
// Structural, not imported, on purpose: the page hands over whatever its own
// reader parsed (lib/module-status.ts trims the payload to what it needs) and
// this component asks the worker itself for the rest. Typing the prop to one
// module's exact shape would couple two readers that have no reason to agree.
type GatePrereq = {
  kind: string;
  slug?: string;
  slugs?: string[];
  label: string;
  why: string;
  degraded?: string;
  fix?: string;
  fields?: ModulePrereqField[];
  requires?: 'all' | 'any';
  interview_available?: boolean;
  llm_ready?: boolean;
};
type GateStatus = {
  ready?: boolean;
  label?: string;
  missing: GatePrereq[];
  optional?: GatePrereq[];
};

function keyOf(p: GatePrereq): string {
  return p.kind === 'voice' ? `voice:${(p.slugs || []).join(',')}` : `${p.kind}:${p.slug || p.label}`;
}

/**
 * Rendered by a page INSTEAD of its body while a requirement is outstanding.
 *
 *   {prereqs.phase === 'gate' && prereqs.status ? (
 *     <ModuleSetupGate slug="outreach" status={prereqs.status}
 *                      onDone={prereqs.done} onSkip={prereqs.skip}>
 *       {body}
 *     </ModuleSetupGate>
 *   ) : body}
 *
 * `children` are the page's own body, rendered only in the one case where this
 * component finds nothing left to ask for (a requirement satisfied between the
 * page's read and this one) — so a race can never leave a blank screen.
 */
export function ModuleSetupGate({ slug, status, onDone, onSkip, children }: {
  slug: string;
  status: GateStatus;
  /** the gap is closed — re-read and show the module */
  onDone: () => void;
  /** "later" — show the module, degraded */
  onSkip: () => void;
  children?: ReactNode;
}) {
  // The page's reader keeps only what it renders; the connect form needs the
  // FIELDS as well, so this asks the worker directly. Until that answers (or if
  // it fails) the passed-in status is what is on screen — the gate is never
  // blank and never waits.
  const [detail, setDetail] = useState<GateStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      const full = await modulePrereqs.one(slug);
      setDetail(full);
      // Everything asked for has been done — hand the module back. This is the
      // path that closes the gate after a connect or after the interview.
      if (full.ready) onDone();
    } catch {
      // A worker without the route, or an offline one. Whatever the page
      // already handed over stays on screen; a failed read is not a reason to
      // hide a module.
      setDetail(null);
    }
  }, [slug, onDone]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const h = () => void reload();
    window.addEventListener(PREREQS_CHANGED_EVENT, h);
    return () => window.removeEventListener(PREREQS_CHANGED_EVENT, h);
  }, [reload]);

  const live = detail || status;
  const outstanding = live.missing || [];
  const optional = live.optional || [];
  const title = live.label || slug;

  // Nothing left to ask for: the page's body, not an empty card.
  if (outstanding.length === 0) return <>{children ?? null}</>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 sm:py-12 space-y-4">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute">{title}</div>
          <h1 className="text-[19px] font-semibold tracking-tight mt-1">
            {outstanding.length === 1
              ? `${title} needs one thing first`
              : `${title} needs ${outstanding.length} things first`}
          </h1>
          <p className="text-[13px] leading-relaxed text-mute mt-1.5">
            Set it up here in a couple of minutes, or skip it and come back — the module opens either way.
          </p>
        </div>

        {outstanding.map((p) => (
          <PrereqCard
            key={keyOf(p)}
            prereq={p}
            onFixed={() => { announcePrereqsChanged(); void reload(); }}
          />
        ))}

        {/* The way past, in plain sight and in plain words, as reachable as the
            fix. An operator who cannot see one assumes there isn't one. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <button
            onClick={onSkip}
            className="mono h-9 px-3 rounded-sm hairline bg-card/60 text-[10px] uppercase tracking-wider text-mute hover:text-ink transition"
          >
            Skip, I'll do this later
          </button>
          <span className="text-[12px] leading-relaxed text-mute min-w-[12rem] flex-1">
            {outstanding.map((p) => p.degraded).filter(Boolean).join(' ')
              || 'The module opens with whatever it already has.'}
          </span>
        </div>

        {optional.length > 0 && (
          <div className="pt-4">
            <div className="mono text-[9px] uppercase tracking-[0.16em] text-mute mb-2">Also useful, not required</div>
            <ul className="space-y-1.5">
              {optional.map((p) => (
                <li key={keyOf(p)} className="text-[12px] leading-relaxed text-mute">
                  <span className="text-ink">{p.label}</span> — {p.why}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ── one prerequisite, with its fix ──────────────────────────────────────────
function PrereqCard({ prereq, onFixed }: { prereq: GatePrereq; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  const isGateway = prereq.kind === 'gateway';
  return (
    <div className="rounded-sm hairline bg-card/70">
      <div className="px-4 py-3.5 flex items-start gap-3">
        <span className="mt-0.5 text-mute shrink-0">
          {isGateway ? <Network size={15} /> : <Sparkle size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">{prereq.label}</div>
          <p dir="auto" className="text-[13px] leading-relaxed text-mute mt-1">{prereq.why}</p>
          {prereq.degraded && (
            <p className="text-[12px] leading-relaxed text-mute/80 mt-1">{prereq.degraded}</p>
          )}
        </div>
        {isGateway && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="mono shrink-0 text-[10px] uppercase tracking-wider px-2.5 h-7 rounded-sm hairline bg-card/60 text-mute hover:text-ink transition"
          >
            {open ? 'cancel' : 'connect'}
          </button>
        )}
      </div>

      {isGateway && open && (
        <GatewayConnect prereq={prereq} onDone={() => { setOpen(false); onFixed(); }} />
      )}
      {!isGateway && <VoiceFix prereq={prereq} />}
    </div>
  );
}

// The service, connected right here. Same fields, same rules and the same
// component as the setup screen — the only difference is that this one asks
// about a single gateway, because a single module wanted it.
function GatewayConnect({ prereq, onDone }: { prereq: GatePrereq; onDone: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = prereq.fields || [];
  const incomplete = gatewayMissingRequired(fields, draft, prereq.requires || 'all');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !prereq.slug) return;
    setBusy(true);
    setError(null);
    try {
      const r = await modulePrereqs.connectGateway(prereq.slug, gatewayConfigFrom(fields, draft));
      // The server's word, not ours: a gateway that stored the values and is
      // still short of what it needs must not report itself connected.
      if (!r?.configured) {
        setError(r?.error || `Saved, but it still needs: ${(r?.missing || []).join(', ') || 'more'}.`);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // No fields in the payload means this build's status route is older than the
  // form. Say where to do it rather than render an empty form.
  if (fields.length === 0) {
    return (
      <div className="px-4 pb-4 pt-3 border-t border-line">
        <p className="text-[12px] leading-relaxed text-mute">
          Connect it from Settings → Connections. Nothing else here needs filling in.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="px-4 pb-4 pt-0 border-t border-line">
      {/* Bundled services get a one-click path before the manual fields. Asking
          someone to type the address of a daemon we ship, and start ourselves,
          would be theatre. The manual fields stay below for the operator who
          runs their own gateway elsewhere. */}
      <BundledServiceOffer slug={prereq.slug} onDone={onDone} />
      {prereq.requires === 'any' && (
        <p className="text-[12px] leading-relaxed text-mute pt-2">Any one of these is enough.</p>
      )}
      {fields.map((f) => (
        <GatewayFieldInput
          key={f.key}
          field={f}
          value={draft[f.key] ?? ''}
          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
        />
      ))}
      {error && <div className="text-[12px] text-rose-600 pt-2">{error}</div>}
      <button
        type="submit"
        disabled={busy || incomplete}
        className="mono mt-3 h-8 px-3 rounded-sm bg-ink text-paper text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
      >
        {busy ? 'saving…' : 'save connection'}
      </button>
    </form>
  );
}

// Services this app ships and can install for itself, keyed by gateway slug.
// The address is fixed because the shell is what starts them, on this machine.
const BUNDLED: Record<string, { service: string; label: string; url: string; note: string }> = {
  whatsapp: {
    service: 'whatsapp',
    label: 'WhatsApp',
    // Same host and port desktop/main.cjs starts it on.
    url: 'http://127.0.0.1:2785/api',
    note: 'Runs on this Mac. The first setup downloads a browser engine, so give it a few minutes.',
  },
};

// The one-click path for a service we ship.
//
// Renders nothing at all outside the desktop app, or once the service is
// installed — in a browser tab there is no shell to install anything, and the
// manual fields below remain the honest answer for an operator pointing at a
// gateway they host themselves.
//
// The two-step dance matters: the SHELL installs and starts the daemon (only it
// can run npm), then the PAGE saves the connection through the ordinary connect
// API (only it is authenticated). Neither half can do the other's job.
function BundledServiceOffer({ slug, onDone }: { slug?: string; onDone: () => void }) {
  const bundled = slug ? BUNDLED[slug] : undefined;
  const shell = typeof window !== 'undefined' ? window.nyyonDesktop : undefined;
  const [state, setState] = useState<NyyonServiceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bundled || !shell) return;
    let alive = true;
    shell.serviceStatus(bundled.service).then((s) => { if (alive) setState(s); }).catch(() => {});
    const off = shell.onServiceProgress((p) => {
      if (p.name !== bundled.service) return;
      setPct(p.pct);
      setLabel(p.label);
    });
    return () => { alive = false; off(); };
  }, [bundled, shell]);

  if (!bundled || !shell) return null;
  if (state?.installed && state?.running) return null;

  async function setUp() {
    if (!bundled || !shell || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await shell.installService(bundled.service);
      if (!r?.ok) { setError(r?.error || 'The install did not finish.'); setBusy(false); return; }
      // Now record the connection the ordinary way, so the gateway reports
      // itself configured through the same resolver as everything else.
      const saved = await modulePrereqs.connectGateway(bundled.service, { WA_BASE_URL: bundled.url });
      if (!saved?.configured) {
        setError(saved?.error || `Installed, but the connection still needs: ${(saved?.missing || []).join(', ') || 'more'}.`);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="pt-3 pb-1">
      <p className="text-[12px] leading-relaxed text-mute">{bundled.note}</p>
      {busy && (
        <div className="mt-2">
          <div className="h-1 rounded-full bg-paper overflow-hidden hairline">
            <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mono text-[10px] uppercase tracking-wider text-mute mt-1">{label || 'working'}</div>
        </div>
      )}
      {error && <div className="text-[12px] text-rose-600 pt-2">{error}</div>}
      <button
        type="button"
        onClick={() => void setUp()}
        disabled={busy}
        className="mono mt-2 h-8 px-3 rounded-sm bg-ink text-paper text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
      >
        {busy ? 'setting up…' : `set up ${bundled.label} here`}
      </button>
      <p className="text-[11px] text-mute mt-2">Or point this at a gateway you host yourself:</p>
    </div>
  );
}

// The voice documents. The fix is Nyo's interview — the SAME conversation the
// setup sequence runs, on the same playbook, opened over the app by the shell.
// Once setup has been closed for good (install.js stamps that permanently) the
// interview no longer exists, and the honest fix is the Knowledge module, where
// those documents live and stay editable forever. Offering a button that 404s
// would be worse than offering none.
function VoiceFix({ prereq }: { prereq: GatePrereq }) {
  const canInterview = prereq.interview_available !== false && prereq.fix !== 'knowledge';
  const noModel = canInterview && prereq.llm_ready === false;
  const slugs = prereq.slugs || [];
  return (
    <div className="px-4 pb-4 pt-0 border-t border-line">
      {slugs.length > 0 && (
        <div className="mono text-[9px] uppercase tracking-[0.16em] text-mute pt-3 pb-2 truncate">
          still the shipped default: {slugs.join(' · ')}
        </div>
      )}
      {canInterview ? (
        <>
          <button
            type="button"
            disabled={noModel}
            onClick={() => openSetupInterview(`prereq:${slugs.join(',') || prereq.label}`)}
            className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm bg-ink text-paper text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
          >
            <Check size={12} /> talk to Nyo — about fifteen minutes
          </button>
          <p className="text-[12px] leading-relaxed text-mute mt-2">
            {noModel
              ? 'Add a model key in Settings first — the interview is itself a conversation with the model.'
              : 'It asks about your business and how you write, then writes the documents from your own words. Stop any time; everything it writes stays editable in Knowledge.'}
          </p>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target: 'knowledge' } }))}
            className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm hairline bg-card/60 text-[10px] uppercase tracking-wider text-mute hover:text-ink transition"
          >
            open Knowledge
          </button>
          <p className="text-[12px] leading-relaxed text-mute mt-2">
            Setup is finished on this install, so these are edited like any other note: open the document and replace
            the placeholder with how you actually write.
          </p>
        </>
      )}
    </div>
  );
}
