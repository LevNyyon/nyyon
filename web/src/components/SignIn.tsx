// The sign-in screen.
//
// The worker's gate serves its own HTML login page, but only for requests it
// handles — in local dev the SPA is served by Vite on a different port, so
// that page is never reached and the app would just sit there failing every
// read. This is the app's own front door: it renders whenever a request comes
// back 401, and on success reloads so the whole shell re-reads with the
// session cookie in place.
import { useState } from 'react';
import { signIn } from '../lib/api';

export function SignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    const r = await signIn(username.trim(), password);
    if (r.ok) { window.location.reload(); return; }
    setBusy(false);
    setPassword('');
    setError(r.error || 'Sign-in failed');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper px-4">
      <form onSubmit={submit} className="w-[min(22rem,100%)]">
        <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-1">nyyon</div>
        <h1 className="text-[18px] font-semibold mb-5">Sign in</h1>

        <label className="block mb-3">
          <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">User</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-card text-[13px] outline-none focus:border-emerald-500"
          />
        </label>

        <label className="block mb-4">
          <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-card text-[13px] outline-none focus:border-emerald-500"
          />
        </label>

        {error && <div className="text-[12px] text-rose-600 mb-3">{error}</div>}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full h-9 rounded-sm bg-emerald-500 text-white mono text-[11px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
        >
          {busy ? 'signing in…' : 'sign in'}
        </button>
      </form>
    </div>
  );
}
