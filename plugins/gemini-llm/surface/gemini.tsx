import { useEffect, useState } from 'react';
import { readStatus, connect, disconnect, type Status } from './data';

export default function Gemini() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => readStatus().then(setStatus).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { void load(); }, []);

  const doConnect = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await connect(key.trim());
      if (r.ok) { setNote(`Connected on ${r.model}.`); setKey(''); } else setErr(r.error || 'Gemini refused the key');
      await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-xl space-y-4">
      <header>
        <h1 className="text-lg font-semibold">Gemini</h1>
        <p className="text-[12px] text-mute mt-1 leading-relaxed">
          Google Gemini as a backup brain — free, no card, limits generous enough for real
          tool-calling conversations. The key lives in this plugin's own table.
        </p>
      </header>

      {note && <div className="text-[12px] text-emerald-700 dark:text-emerald-400">{note}</div>}
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-400">{err}</div>}

      <div className="hairline rounded-sm p-4 space-y-2.5">
        {status?.connected ? (
          <>
            <div className="text-[13px]">
              <span className="text-emerald-700 dark:text-emerald-400">Connected</span>
              <span className="text-mute"> running <span className="mono">{status.model}</span></span>
            </div>
            <button onClick={() => { setBusy(true); void disconnect().then(load).finally(() => setBusy(false)); }} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40 text-mute">forget</button>
          </>
        ) : (
          <>
            <ol className="text-[12px] text-mute leading-relaxed pl-4 list-decimal space-y-1">
              <li>
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
                   className="underline hover:text-ink">Sign in with any Google account and create an API key</a> — free, no card.
              </li>
              <li>Paste it here.</li>
            </ol>
            <div className="flex gap-2">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza..."
                className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
              <button onClick={() => void doConnect()} disabled={busy || !key.trim()}
                className="text-[12px] px-3 rounded-sm bg-ink text-paper disabled:opacity-40">
                {busy ? 'connecting…' : 'connect'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
