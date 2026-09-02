import { useEffect, useState } from 'react';
import { readStatus, connect, disconnect, setActive, type Status } from './data';

// One card per provider — each is its own gateway to one service, and the
// operator decides which connected one is the active backup brain.
const PROVIDERS: { key: string; label: string; free: string; steps: { text: string; href?: string; link?: string }[]; placeholder: string }[] = [
  {
    key: 'gemini', label: 'Google Gemini',
    free: 'Free, no card, generous limits — the free tier that fits a tool-calling agent. Recommended.',
    steps: [
      { text: 'Sign in with any Google account and create an API key.', link: 'aistudio.google.com/apikey', href: 'https://aistudio.google.com/apikey' },
      { text: 'Copy the key and paste it below.' },
    ],
    placeholder: 'AIza...',
  },
  {
    key: 'groq', label: 'Groq',
    free: 'Free, no card, very fast — but tight per-minute token limits: expect pauses in long conversations.',
    steps: [
      { text: 'Create a free account.', link: 'console.groq.com/login', href: 'https://console.groq.com/login' },
      { text: 'Press Create API Key and copy it — shown once.', link: 'console.groq.com/keys', href: 'https://console.groq.com/keys' },
      { text: 'Paste it below.' },
    ],
    placeholder: 'gsk_...',
  },
];

export default function FreeLlm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => readStatus().then(setStatus).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { void load(); }, []);

  const doConnect = async (p: string) => {
    setBusy(p); setErr(null); setNote(null);
    try {
      const r = await connect(p, (keys[p] || '').trim());
      if (r.ok) { setNote(`${p} connected on ${r.model} — now the active backup brain.`); setKeys((k) => ({ ...k, [p]: '' })); }
      else setErr(r.error || 'the provider refused the key');
      await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };
  const doActive = async (p: string) => {
    setBusy(p); setErr(null);
    try { await setActive(p); setNote(`${p} is now the active backup brain.`); await load(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };
  const doForget = async (p: string) => {
    setBusy(p); setErr(null);
    try { await disconnect(p); setNote(`${p} forgotten.`); await load(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-2xl space-y-4">
      <header>
        <h1 className="text-lg font-semibold">Free LLM</h1>
        <p className="text-[12px] text-mute mt-1 leading-relaxed">
          Backup brains. Each provider below is its own gateway; connect any of them and Nyo keeps
          working when the main model has no key or no credit. Keys live in this plugin's own table —
          it cannot see your main model key.
        </p>
      </header>

      {note && <div className="text-[12px] text-emerald-700 dark:text-emerald-400">{note}</div>}
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-400">{err}</div>}

      {PROVIDERS.map((p) => {
        const st = status?.providers.find((x) => x.provider === p.key);
        return (
          <div key={p.key} className="hairline rounded-sm p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{p.label}</span>
                {st?.connected && st?.active && (
                  <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">active</span>
                )}
                {st?.connected && !st?.active && (
                  <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-card text-mute">connected</span>
                )}
              </div>
              {st?.connected && (
                <div className="flex gap-1.5">
                  {!st.active && (
                    <button onClick={() => void doActive(p.key)} disabled={busy === p.key}
                      className="text-[11px] px-2 py-0.5 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">use this</button>
                  )}
                  <button onClick={() => void doForget(p.key)} disabled={busy === p.key}
                    className="text-[11px] px-2 py-0.5 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40 text-mute">forget</button>
                </div>
              )}
            </div>
            <p className="text-[11px] text-mute leading-relaxed">{p.free}</p>
            {st?.connected ? (
              <div className="text-[12px] text-mute">running <span className="mono">{st.model}</span></div>
            ) : (
              <>
                <ol className="text-[11px] text-mute leading-relaxed pl-4 list-decimal space-y-0.5">
                  {p.steps.map((s, i) => (
                    <li key={i}>
                      {s.text}{' '}
                      {s.href && <a href={s.href} target="_blank" rel="noreferrer" className="underline hover:text-ink">{s.link}</a>}
                    </li>
                  ))}
                </ol>
                <div className="flex gap-2">
                  <input type="password" value={keys[p.key] || ''} onChange={(e) => setKeys((k) => ({ ...k, [p.key]: e.target.value }))}
                    placeholder={p.placeholder}
                    className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
                  <button onClick={() => void doConnect(p.key)} disabled={busy === p.key || !(keys[p.key] || '').trim()}
                    className="text-[12px] px-3 rounded-sm bg-ink text-paper disabled:opacity-40">
                    {busy === p.key ? 'connecting…' : 'connect'}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
