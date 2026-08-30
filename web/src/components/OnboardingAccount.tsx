// STEP ONE of setup, and the reason the rest of it was reordered.
//
// A username and a password. No model, no conversation, no waiting: this form
// creates the account and signs them in, so within about ten seconds of
// unzipping the thing they are inside their own install and everything after
// this happens as its owner. Setup used to end here, which meant a new
// operator spent fifteen minutes answering interview questions from outside a
// product they could not yet look at.
//
// It is also the last screen the setup token (or loopback) protects. From the
// moment this succeeds the session cookie is what proves setup access, and the
// token is burned server-side in the same write that stores the password.

import { useState } from 'react';
import { onboarding, signIn, clearSetupToken, OnboardingUnavailable } from '../lib/api';

// `mode='edit'` is the way BACK from a later step. The account cannot be
// un-created, so going back rewrites it instead — which is what an operator
// who mistyped their username on the very first screen actually needs.
export function OnboardingAccount({ onDone, mode = 'create', onCancel }: {
  onDone: () => void;
  mode?: 'create' | 'edit';
  onCancel?: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  // Same shape the server enforces AND the sign-in form demands: a non-email
  // account cannot be typed into the type="email" login field later.
  const emailOk  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username.trim());
  const ready    = emailOk && password.length >= 8 && confirm === password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = mode === 'edit'
        ? await onboarding.updateAccount(username.trim(), password)
        : await onboarding.createAccount(username.trim(), password);
      if (r?.ok === false) throw new Error(r.error || 'could not create the account');
      // The token has just been burned server-side; holding a dead one in
      // session storage only means sending a header that can never match.
      clearSetupToken();
      // The worker signs them in as part of creating the account. If it says
      // it did not (no gate secret), fall back to the ordinary login with the
      // credential they just chose rather than stranding them.
      if (!r?.signed_in) await signIn(username.trim(), password).catch(() => undefined);
      onDone();
    } catch (e2) {
      const status = e2 instanceof OnboardingUnavailable ? e2.status : -1;
      setErr(
        status === 403
          ? 'This browser is not authorized to set up this install. Open it on the machine it runs on, or use the setup link the installer printed.'
          : status === 404
            ? 'This install has already been claimed. Sign in instead.'
            : e2 instanceof Error ? e2.message : String(e2),
      );
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-paper overflow-y-auto">
      <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-lg">
          <div className="flex items-center gap-2 mb-3 px-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
            <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute">nyyon · setup</span>
          </div>

          <form onSubmit={submit} className="bg-card hairline rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-line">
              <div className="flex items-baseline justify-between gap-3">
                <h1 className="text-[15px] font-semibold">Create your account</h1>
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-mute shrink-0">{mode === 'edit' ? 'Account' : 'Step 1 of 2'}</span>
              </div>
            </div>

            <div className="px-5 py-5">
              <p className="text-[13px] leading-relaxed text-mute mb-4">
                This is your command center, so it starts with your login. Pick one now and you are signed in for
                the rest of setup. Nothing leaves this install.
              </p>

              <label className="block mb-3">
                <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">Email</span>
                <input
                  type="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  spellCheck={false}
                  className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-paper text-[13px] outline-none focus:border-emerald-500"
                />
              </label>
              <label className="block mb-3">
                <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-paper text-[13px] outline-none focus:border-emerald-500"
                />
                {tooShort && <span className="block mt-1 text-[11px] text-mute">At least 8 characters.</span>}
              </label>
              <label className="block mb-4">
                <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">Repeat password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-paper text-[13px] outline-none focus:border-emerald-500"
                />
                {mismatch && <span className="block mt-1 text-[11px] text-rose-600">These do not match.</span>}
              </label>

              {err && <div className="text-[12px] text-rose-600 mb-3">{err}</div>}

              <button
                type="submit"
                disabled={!ready || busy}
                className="mono w-full h-9 rounded-sm bg-emerald-500 text-white text-[11px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
              >
                {busy ? (mode === 'edit' ? 'saving…' : 'creating…') : (mode === 'edit' ? 'save and continue' : 'create account and continue')}
              </button>
              {mode === 'edit' && onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  className="mono w-full mt-2 h-8 text-[10px] uppercase tracking-wider text-mute hover:text-ink transition disabled:opacity-40"
                >
                  cancel
                </button>
              )}
            </div>
          </form>

          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute/70 text-center mt-3">
            one short step left after this one
          </p>
        </div>
      </div>
    </div>
  );
}
