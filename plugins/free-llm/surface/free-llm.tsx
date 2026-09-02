import { useEffect, useState } from 'react';
import { readStatus, connect, disconnect, type Status, type ProviderOption } from './data';

// Two providers, both free, both no card. Whoever lands here has no model
// working, so the page has to carry the whole errand: what to click, where,
// and what to bring back. Copy stays out of the code path so the page reads
// the same as it behaves.
const GUIDE: Record<string, { blurb: string; steps: { text: string; href?: string; link?: string }[] }> = {
  groq: {
    blurb: 'Free, no card, about 1,000 requests a day on Llama 3.3 70B, and very fast. Best choice for daily use.',
    steps: [
      { text: 'Create a free Groq account (Google or email, no card).', link: 'console.groq.com/login', href: 'https://console.groq.com/login' },
      { text: 'Open API Keys and press Create API Key.', link: 'console.groq.com/keys', href: 'https://console.groq.com/keys' },
      { text: 'Copy the key that starts with gsk_ and paste it below. It is shown once.' },
    ],
  },
  cloudflare: {
    blurb: 'Free on any Cloudflare account, no card. The daily allowance is small, so keep this as a safety net rather than a daily driver.',
    steps: [
      { text: 'Open your Cloudflare dashboard and copy the account id from the address bar.', link: 'dash.cloudflare.com', href: 'https://dash.cloudflare.com' },
      { text: 'Create an API token with the Workers AI permission.', link: 'dash.cloudflare.com/profile/api-tokens', href: 'https://dash.cloudflare.com/profile/api-tokens' },
      { text: 'Paste the token and the account id below.' },
    ],
  },
};

export default function FreeLlm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [provider, setProvider] = useState('groq');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => readStatus().then(setStatus).catch((e) => setErr(String(e?.message || e)));
  // useEffect must get void back, not the promise load() returns.
  useEffect(() => { void load(); }, []);

  const providers: ProviderOption[] = status?.providers || [
    { key: 'groq', label: 'Groq', default_model: 'llama-3.3-70b-versatile', signup: 'console.groq.com/keys' },
    { key: 'cloudflare', label: 'Cloudflare Workers AI', default_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', signup: 'dash.cloudflare.com' },
  ];

  const save = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await connect({ provider, api_key: apiKey, model: model || undefined, account_id: accountId || undefined });
      if (r.ok) { setNote(`${r.label} connected, running ${r.model}.`); setApiKey(''); }
      else setErr(r.error || 'the provider refused the key');
      await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  const check = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const s = await readStatus(true);
      setStatus(s);
      setNote(s.answering ? `Answering on ${s.model}.` : null);
      if (!s.answering) setErr(s.error || 'the provider did not answer');
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  const forget = async () => {
    setBusy(true); setErr(null);
    try { const r = await disconnect(); setNote(r.note || 'Disconnected.'); await load(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">Free LLM</h1>
        <p className="text-[12px] text-mute mt-1 leading-relaxed">
          A backup brain. Connect a free provider and Nyo keeps working when the main model has
          no key or no credit. The key is stored in this plugin's own table, and this plugin
          cannot see your main model key.
        </p>
      </header>

      <div className="hairline rounded-sm p-4 bg-card space-y-1">
        <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">status</div>
        {status?.connected ? (
          <div className="text-[13px]">
            <span className="text-emerald-700 dark:text-emerald-400">{status.label} connected</span>
            <span className="text-mute"> running {status.model}</span>
          </div>
        ) : (
          <div className="text-[13px] text-mute">Nothing connected yet.</div>
        )}
        {status?.connected && (
          <div className="flex gap-2 pt-2">
            <button onClick={check} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">
              {busy ? 'checking…' : 'check it answers'}
            </button>
            <button onClick={forget} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">
              disconnect
            </button>
          </div>
        )}
      </div>

      <div className="hairline rounded-sm p-4 space-y-3">
        <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">connect a provider</div>
        <div className="flex gap-1.5">
          {providers.map((p) => (
            <button key={p.key} onClick={() => setProvider(p.key)}
              className={`text-[12px] px-2.5 py-1 rounded-sm ${provider === p.key ? 'bg-ink text-paper' : 'hairline bg-paper text-mute hover:text-ink'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-mute leading-relaxed">{GUIDE[provider].blurb}</p>
        <ol className="text-[11px] text-mute leading-relaxed space-y-1 pl-4 list-decimal">
          {GUIDE[provider].steps.map((st, i) => (
            <li key={i}>
              {st.text}{' '}
              {st.href && (
                <a href={st.href} target="_blank" rel="noreferrer" className="underline hover:text-ink">{st.link}</a>
              )}
            </li>
          ))}
        </ol>

        <label className="block">
          <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">api key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'groq' ? 'gsk_…' : 'your Cloudflare API token'}
            className="mt-0.5 w-full h-8 px-2 rounded-sm hairline bg-paper text-[12px] outline-none focus:border-emerald-500" />
        </label>

        {provider === 'cloudflare' && (
          <label className="block">
            <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">account id</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)}
              placeholder="from your Cloudflare dashboard URL"
              className="mt-0.5 w-full h-8 px-2 rounded-sm hairline bg-paper text-[12px] outline-none focus:border-emerald-500" />
          </label>
        )}

        <label className="block">
          <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">model (optional)</span>
          <input value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={providers.find((p) => p.key === provider)?.default_model || ''}
            className="mt-0.5 w-full h-8 px-2 rounded-sm hairline bg-paper text-[12px] outline-none focus:border-emerald-500" />
        </label>

        <button onClick={save} disabled={busy || !apiKey.trim()}
          className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-paper disabled:opacity-40">
          {busy ? 'connecting…' : 'connect and test'}
        </button>

        {note && <div className="text-[12px] text-emerald-700 dark:text-emerald-400">{note}</div>}
        {err && <div className="text-[12px] text-rose-700 dark:text-rose-400">{err}</div>}
      </div>
    </div>
  );
}
