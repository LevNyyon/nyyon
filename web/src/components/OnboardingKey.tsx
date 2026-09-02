// Step two of setup: the model key.
//
// The interview after this is itself an LLM call. With no model key there is
// literally nothing to talk to, so a chat box here could only ever fail
// silently — the worst possible first minute with a product. The key is taken
// plainly, then PROVED with a real request before the operator is allowed past.
// A typo that gets stored happily and then breaks the next screen is the
// failure this exists to prevent.
//
// The operator is already signed in by the time they see this (the account is
// step one), so this request rides their session, not the setup token.
import { useState } from 'react';
import { onboarding } from '../lib/api';

export function OnboardingKey({ onReady, onLater, onBack }: { onReady: () => void; onLater: () => void; onBack?: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'anthropic' is the primary path; 'groq' is the free one for people with
  // no Claude account. Switching clears the field — the keys look nothing
  // alike and a half-typed one from the other provider only breeds confusion.
  const [mode, setMode] = useState<'anthropic' | 'groq'>('anthropic');
  const switchTo = (m: 'anthropic' | 'groq') => {
    setMode(m); setKey(''); setError(null);
    // The deep link opens alongside the form, so "set up here" means exactly
    // that: the key page is already in front of them when they look.
    if (m === 'groq') window.open('https://console.groq.com/keys', '_blank', 'noopener');
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onboarding.saveLlmKey(key.trim(), mode);
      if (r?.ok) { onReady(); return; }
      setError(r?.error || 'That key could not be verified.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  // The account already exists, so an operator who has to go and find a key
  // is not locked out of their own install while they look for it. Postponing
  // here postpones the interview too — both need the model — and the app
  // carries the way back.
  async function later() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onboarding.defer();
      onLater();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
                <h1 className="text-[15px] font-semibold">Connect a model</h1>
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-mute shrink-0">Step 2 of 2</span>
              </div>
            </div>

            <div className="px-5 py-5">
              <div className="flex gap-1.5 mb-3">
                <button type="button" onClick={() => switchTo('anthropic')}
                  className={`text-[12px] px-2.5 py-1 rounded-sm transition ${mode === 'anthropic' ? 'bg-ink text-paper' : 'hairline bg-paper text-mute hover:text-ink'}`}>
                  Anthropic
                </button>
                <button type="button" onClick={() => switchTo('groq')}
                  className={`text-[12px] px-2.5 py-1 rounded-sm transition ${mode === 'groq' ? 'bg-ink text-paper' : 'hairline bg-paper text-mute hover:text-ink'}`}>
                  Groq · free
                </button>
              </div>

              {mode === 'anthropic' ? (
                <p className="text-[13px] leading-relaxed text-mute mb-4">
                  The rest of setup is a conversation, and the conversation runs on a model. Paste an
                  Anthropic API key to begin. It is stored on this install only, and you can change it
                  later in Settings.
                </p>
              ) : (
                <ol className="text-[13px] leading-relaxed text-mute mb-4 pl-4 list-decimal space-y-1">
                  <li>
                    <a href="https://console.groq.com/login" target="_blank" rel="noreferrer noopener"
                       className="underline underline-offset-2 hover:text-ink transition">Create a free Groq account</a>
                    {' '}— Google or email, no card.
                  </li>
                  <li>
                    <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer noopener"
                       className="underline underline-offset-2 hover:text-ink transition">Press Create API Key</a>
                    {' '}and copy it — it is shown once.
                  </li>
                  <li>Paste it below. Fast, but expect pauses in long conversations (tight per-minute limits).</li>
                </ol>
              )}

              <label className="block mb-4">
                <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">
                  {mode === 'anthropic' ? 'Anthropic API key' : 'Groq API key'}
                </span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={mode === 'anthropic' ? 'sk-ant-...' : 'gsk_...'}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500"
                />
                {mode === 'anthropic' && (
                  <span className="block mt-1.5 text-[11px] text-mute">
                    Don't have one?{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline underline-offset-2 hover:text-ink transition"
                    >
                      Create a key at console.anthropic.com
                    </a>
                    , then paste it here — or use Groq above, free with no card.
                  </span>
                )}
              </label>

              {error && <div className="text-[12px] text-rose-600 mb-3">{error}</div>}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!key.trim() || busy}
                  className="mono flex-1 h-9 rounded-sm bg-emerald-500 text-white text-[11px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
                >
                  {busy ? 'verifying…' : 'verify and continue'}
                </button>
                <button
                  type="button"
                  onClick={() => void later()}
                  disabled={busy}
                  title="Go into the app and add the key later from Settings"
                  className="mono h-9 px-3 rounded-sm hairline bg-card/60 text-[10px] uppercase tracking-wider text-mute hover:text-ink transition disabled:opacity-40"
                >
                  Later
                </button>
              </div>
              {onBack && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={onBack}
                    disabled={busy}
                    className="mono text-[10px] uppercase tracking-wider text-mute hover:text-ink transition disabled:opacity-40"
                  >
                    ← Change account details
                  </button>
                </div>
              )}
              <div className="hidden">
              </div>
            </div>
          </form>

          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute/70 text-center mt-3">
            the key is checked with a real request before setup begins
          </p>
        </div>
      </div>
    </div>
  );
}
