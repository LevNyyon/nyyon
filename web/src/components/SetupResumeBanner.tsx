// The way back to an interview somebody walked away from.
//
// Setup can be postponed on purpose — the account exists, the app works, and
// nobody should be held in a fifteen-minute conversation to reach a product
// they already own. The cost of that choice is real though: until the voice
// documents are written, every draft the command center produces reads like
// the shipped defaults, which is to say like nobody. This says that once, in
// those terms, and offers the way back.
//
// Three rules keep it an offer rather than a nag:
//
//   1. It states the CONSEQUENCE, not the chore. "Finish setup" is a task;
//      "everything drafts in the default voice" is a reason.
//   2. It is dismissible, and a dismissal lasts the session. Anyone who has
//      decided not to do this today should not be asked again at lunch.
//   3. It never blocks anything. One slim bar above the page, no modal, no
//      toast, no interstitial.
//
// The same component backs the Settings entry (`inline`), where it is the
// answer to somebody who went LOOKING for it — so there it carries no dismiss
// and no apology.

import { useState } from 'react';
import { onboarding } from '../lib/api';
import { openSetupInterview } from './ModuleSetupGate';
import { X } from './Icons';

const DISMISS_KEY = 'nyyon.setup-banner.dismissed';

export function SetupResumeBanner({ onResumed, inline = false }: {
  onResumed: () => void;
  /** rendered inside Settings rather than above a page */
  inline?: boolean;
}) {
  const [hidden, setHidden] = useState(() => {
    if (inline) return false;
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  async function resume() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onboarding.resume();
      // Boot no longer lands on the interview — it is an overlay the shell
      // opens on request — so clearing the postponement is only half of
      // "finish with Nyo". Asking for the conversation is the other half, and
      // it is asked for HERE so every caller of this banner (the strip above a
      // page, the permanent entry in Settings) behaves the same.
      openSetupInterview('resume-banner');
      onResumed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function dismiss() {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* fine either way */ }
    setHidden(true);
  }

  if (hidden) return null;

  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-relaxed text-ink">
          Your voice documents are still the shipped defaults.
        </div>
        <div className="text-[12px] leading-relaxed text-mute">
          Nyo can finish the setup interview whenever you have fifteen minutes. Until then everything this app
          drafts is written in a generic voice, not yours.
        </div>
        {err && <div className="text-[12px] text-rose-600 mt-1">{err}</div>}
      </div>
      <button
        onClick={() => void resume()}
        disabled={busy}
        className="mono shrink-0 h-8 px-3 rounded-sm bg-ink text-paper text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
      >
        {busy ? 'opening…' : 'finish with Nyo'}
      </button>
    </>
  );

  if (inline) {
    return (
      <div className="hairline rounded-sm bg-card/80 p-4 flex items-start gap-3">{body}</div>
    );
  }

  return (
    <div className="shrink-0 border-b border-line bg-card/60 px-4 sm:px-6 py-2.5 flex items-start gap-3">
      {body}
      <button
        onClick={dismiss}
        title="Not now"
        aria-label="Dismiss until next session"
        className="shrink-0 h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm transition"
      >
        <X size={15} />
      </button>
    </div>
  );
}
