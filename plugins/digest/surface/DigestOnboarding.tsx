// The opening screen of a new Digest: Nyo asks four questions and derives the
// watched topics; beside it, the sources this install has, the ones it can
// install in one click, and a prompt for building a new one.
import { useEffect, useRef, useState } from 'react';
import { Chat } from '../../components/Chat';
import { sources, type DigestSources, type CatalogEntry } from './digest-data';

export function DigestOnboarding({ onDone }: { onDone: () => void }) {
  const [src, setSrc] = useState<DigestSources | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [copied, setCopied] = useState(false);
  // A cached thread that the server no longer has (the digest was reset) must
  // not be resumed: Nyo would sit where it left off instead of starting.
  const [threadChecked, setThreadChecked] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem('nyyon.agent.digest.v1');
        const cached = raw ? JSON.parse(raw)?.conversationId : null;
        if (cached) {
          const r = await fetch('/api/chat/conversations?agent=digest&limit=100').then((x) => x.json()).catch(() => null);
          const ids = new Set(((r?.conversations || []) as { id: string }[]).map((c) => c.id));
          if (!ids.has(cached)) localStorage.removeItem('nyyon.agent.digest.v1');
        }
      } catch { /* cache unreadable: start fresh */ }
      setThreadChecked(true);
    })();
  }, []);
  // When a provider becomes ready after the chat started, tell Nyo so it
  // continues instead of waiting for a click it cannot see.
  const readyCount = src ? src.providers.filter((p) => p.connected).length : null;
  const lastReady = useRef<number | null>(null);
  useEffect(() => {
    if (readyCount === null) return;
    if (lastReady.current !== null && readyCount > lastReady.current) {
      const names = (src?.providers || []).filter((p) => p.connected).map((p) => p.label).join(', ');
      window.dispatchEvent(new CustomEvent('nyyon:agent-send', { detail: { agent: 'digest', text: `Sources ready now: ${names}.` } }));
    }
    lastReady.current = readyCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyCount]);

  const load = async () => {
    const [s, c, i] = await Promise.all([sources.read().catch(() => null), sources.catalog(), sources.installed().catch(() => ({}))]);
    setSrc(s); setCatalog(c); setInstalled(i);
  };
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 8000); return () => clearInterval(t); }, []);
  useEffect(() => { if (src?.configured && src?.ready) onDone(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [src?.configured, src?.ready]);

  const [note, setNote] = useState<string | null>(null);
  const install = async (e: CatalogEntry) => {
    setBusy(e.name); setErr(null); setNote(`Adding ${e.title}…`);
    try {
      const r = await sources.install(e);
      if (!r.ok) { setErr(`${e.title}: ${(r.errors || [r.error || 'install refused']).join('; ')}`); setNote(null); }
      else setNote(`${e.title} accepted (${r.status || 'bound'}). Building it now; this takes about a minute.`);
    } catch (x) { setErr(`${e.title}: ${String((x as Error)?.message || x)}`); setNote(null); }
    finally { setBusy(null); void load(); }
  };
  const copyPrompt = async () => {
    const text = prompt || await sources.buildPrompt();
    if (!prompt) setPrompt(text);
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      <div className="flex-1 min-h-0 flex flex-col border-b lg:border-b-0 lg:border-r border-line">
        <div className="px-4 pt-4 pb-2 shrink-0 flex items-center justify-between">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">nyo · digest setup</p>
          <button
            onClick={() => { try { localStorage.removeItem('nyyon.agent.digest.v1'); } catch { /* ignore */ } window.location.reload(); }}
            className="mono text-[9px] uppercase tracking-[0.14em] text-mute hover:text-ink">start over</button>
        </div>
        {threadChecked && (
          <Chat
            agent="digest"
            autoStart="Let's set up my digest."
            placeholder="Answer in plain words"
            suggestions={[]}
          />
        )}
      </div>

      <aside className="w-full lg:w-[280px] shrink-0 overflow-y-auto p-4 space-y-5">
        <section className="space-y-1.5">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">topics</p>
          {src?.configured
            ? src.topics.map((t) => <div key={t} className="text-[12.5px] text-ink truncate">{t}</div>)
            : <div className="text-[12px] text-mute">none yet</div>}
        </section>

        <section className="space-y-1.5">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">sources</p>
          {src?.providers.map((p) => (
            <div key={p.slug} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-ink truncate">{p.label}</span>
              <span className={'mono text-[9px] uppercase tracking-[0.14em] shrink-0 ' + (p.connected ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>{p.connected ? 'ready' : 'needs key'}</span>
            </div>
          ))}
          {src?.calendar && <div className="flex items-center justify-between text-[12.5px]"><span className="text-ink">Calendar</span><span className="mono text-[9px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">ready</span></div>}
          {catalog.filter((e) => installed[e.name] !== 'active').map((e) => {
            const st = installed[e.name];
            const working = st && st !== 'blocked' && st !== 'removed';
            return (
              <div key={e.name} className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="text-mute truncate">{e.title}{e.needs_key ? <span className="mono text-[9px] uppercase tracking-[0.14em] ml-1.5">key</span> : null}</span>
                {working
                  ? <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute shrink-0">{st}…</span>
                  : <button onClick={() => void install(e)} disabled={busy === e.name} className="text-[11px] px-2.5 py-0.5 rounded-sm bg-ink text-paper disabled:opacity-40 shrink-0">{busy === e.name ? '…' : 'add'}</button>}
              </div>
            );
          })}
          {note && <p className="text-[11px] text-emerald-700 dark:text-emerald-400 leading-snug">{note}</p>}
          {err && <p className="text-[11px] text-rose-700 dark:text-rose-400 leading-snug">{err}</p>}
        </section>

        <section className="space-y-1.5">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">build your own</p>
          <button onClick={() => void copyPrompt()} className="text-[11px] px-2.5 py-0.5 rounded-sm hairline bg-paper hover:bg-card">{copied ? 'copied' : 'copy the prompt'}</button>
        </section>
      </aside>
    </div>
  );
}
