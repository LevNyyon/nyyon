// The opening screen of a new Digest: Nyo asks four questions and derives the
// watched topics; beside it, the sources this install has, the ones it can
// install in one click, and a prompt for building a new one.
import { useEffect, useState } from 'react';
import { Chat } from '../../components/Chat';
import { sources, type DigestSources, type CatalogEntry } from './digest-data';

export function DigestOnboarding({ onDone }: { onDone: () => void }) {
  const [src, setSrc] = useState<DigestSources | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);

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
  const openPrompt = async () => { if (!prompt) setPrompt(await sources.buildPrompt()); setShowPrompt((v) => !v); };
  const copy = async () => { try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      <div className="flex-1 min-h-0 flex flex-col border-b lg:border-b-0 lg:border-r border-line">
        <div className="px-4 pt-4 pb-2 shrink-0">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">nyo · set up your digest</p>
        </div>
        <Chat
          agent="digest"
          autoStart="Let's set up my digest."
          placeholder="Answer in plain words"
          suggestions={[]}
        />
      </div>

      <aside className="w-full lg:w-[360px] shrink-0 overflow-y-auto p-4 space-y-4">
        <section className="space-y-2">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">watched topics</p>
          {src?.configured ? (
            <ul className="text-[12.5px] text-ink space-y-0.5">{src.topics.map((t) => <li key={t}>· {t}</li>)}</ul>
          ) : (
            <p className="text-[12px] text-mute leading-relaxed">None yet. Answer Nyo's four questions and they land here.</p>
          )}
        </section>

        <section className="space-y-2">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">sources on this install</p>
          {src?.providers.length ? src.providers.map((p) => (
            <div key={p.slug} className="flex items-center justify-between text-[12.5px]">
              <span className="text-ink">{p.label}</span>
              <span className={'mono text-[9px] uppercase tracking-[0.14em] ' + (p.connected ? 'text-emerald-700 dark:text-emerald-400' : 'text-mute')}>{p.connected ? 'ready' : 'needs a key'}</span>
            </div>
          )) : <p className="text-[12px] text-mute leading-relaxed">No search source yet. Add one below; the brief stays empty without it.</p>}
          {src?.calendar && <div className="flex items-center justify-between text-[12.5px]"><span className="text-ink">Calendar</span><span className="mono text-[9px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">ready</span></div>}
        </section>

        <section className="space-y-2">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">add a source</p>
          {note && <p className="text-[12px] text-emerald-700 dark:text-emerald-400">{note}</p>}
          {err && <p className="text-[12px] text-rose-700 dark:text-rose-400">{err}</p>}
          {catalog.map((e) => {
            const st = installed[e.name];
            const on = st === 'active';
            const working = st && st !== 'active' && st !== 'blocked' && st !== 'removed';
            return (
              <div key={e.name} className="hairline rounded-sm p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium">{e.title}</span>
                  {on ? <span className="mono text-[9px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">installed</span>
                    : working ? <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{st}…</span>
                    : <button onClick={() => void install(e)} disabled={busy === e.name} className="text-[11px] px-2 py-0.5 rounded-sm bg-ink text-paper disabled:opacity-40">{busy === e.name ? 'adding…' : 'add'}</button>}
                </div>
                <p className="text-[11px] text-mute leading-relaxed">{e.description}</p>
                {e.needs_key && !on && <p className="text-[10px] text-mute">Needs a free key; its page opens in the sidebar once added.</p>}
              </div>
            );
          })}
          {!catalog.length && <p className="text-[12px] text-mute">No installable sources are listed in this build.</p>}
        </section>

        <section className="space-y-2">
          <p className="mono text-[9px] uppercase tracking-[0.16em] text-mute">build your own</p>
          <p className="text-[12px] text-mute leading-relaxed">Any service with search can feed the digest. This prompt walks an assistant through building it as a plugin.</p>
          <div className="flex gap-2">
            <button onClick={() => void openPrompt()} className="text-[11px] px-2 py-0.5 rounded-sm hairline bg-paper hover:bg-card">{showPrompt ? 'hide prompt' : 'show prompt'}</button>
            {showPrompt && <button onClick={() => void copy()} className="text-[11px] px-2 py-0.5 rounded-sm bg-ink text-paper">{copied ? 'copied' : 'copy'}</button>}
          </div>
          {showPrompt && <pre className="text-[10.5px] leading-relaxed text-mute whitespace-pre-wrap hairline rounded-sm p-3 max-h-72 overflow-y-auto">{prompt || 'Loading…'}</pre>}
        </section>
      </aside>
    </div>
  );
}
