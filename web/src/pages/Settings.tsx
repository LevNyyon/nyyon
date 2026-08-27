import { useEffect, useState } from 'react';
import { api, onboarding, FeatureFlag } from '../lib/api';
import { SetupResumeBanner } from '../components/SetupResumeBanner';
import {
  loadTheme, saveTheme, type Theme,
  loadSidebarSlugs, saveSidebarSlugs,
  SURFACE_MODULES, type SurfaceSlug,
} from '../lib/theme';
import { Sun, Moon, Monitor, Check } from '../components/Icons';

export function Settings() {
  return (
    <div className="h-full flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center bg-card/60 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-10 max-w-3xl">
        <UnfinishedSetup />
        <Appearance />
        <NyoBrain />
        <SidebarPlacement />
        <WhatsAppConnection />
        <FeatureFlags />
      </div>
    </div>
  );
}

// ─── unfinished setup ────────────────────────────────────────
// The permanent home of the way back into the interview. The banner above the
// page is dismissible for a reason; this is not, because an operator who opens
// Settings looking for "where do I finish that thing" must find it.
//
// Renders NOTHING on an install whose setup is done, which is the common case
// — a settings page that lists a completed step is clutter with a checkmark.
function UnfinishedSetup() {
  const [deferred, setDeferred] = useState(false);

  async function refresh() {
    try {
      const s = await onboarding.state();
      setDeferred(s?.setup_deferred === true);
    } catch { setDeferred(false); }   // no setup surface on this build
  }
  useEffect(() => { void refresh(); }, []);

  if (!deferred) return null;

  return (
    <Section title="Setup" hint="The voice interview was postponed. Nyo picks it up exactly where it stopped.">
      {/* No reload on resume: the banner asks the shell to open the interview
          over the app, and reloading here would throw that request away before
          anything could answer it. Re-reading this section is enough. */}
      <SetupResumeBanner inline onResumed={() => void refresh()} />
    </Section>
  );
}

// ─── appearance ──────────────────────────────────────────────
function Appearance() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  function pick(t: Theme) {
    setTheme(t);
    saveTheme(t);
  }

  const opts: { key: Theme; label: string; Icon: (p: any) => any }[] = [
    { key: 'light',  label: 'Light',  Icon: Sun },
    { key: 'dark',   label: 'Dark',   Icon: Moon },
    { key: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <Section title="Appearance" hint="Theme persists in this browser only.">
      <div className="flex gap-2">
        {opts.map(({ key, label, Icon }) => {
          const on = theme === key;
          return (
            <button
              key={key}
              onClick={() => pick(key)}
              className={
                'flex items-center gap-2 h-10 px-4 rounded-sm hairline text-sm transition ' +
                (on
                  ? 'bg-ink text-paper shadow-[inset_0_0_0_1px_var(--color-ink)]'
                  : 'bg-card/80 text-mute hover:text-ink')
              }
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ─── sidebar module placement ────────────────────────────────
function SidebarPlacement() {
  const [slugs, setSlugs] = useState<SurfaceSlug[]>(() => loadSidebarSlugs());

  function toggle(slug: SurfaceSlug) {
    const next = slugs.includes(slug) ? slugs.filter((s) => s !== slug) : [...slugs, slug];
    // Preserve canonical order from SURFACE_MODULES.
    const ordered = SURFACE_MODULES.map((m) => m.slug).filter((s) => next.includes(s));
    setSlugs(ordered);
    saveSidebarSlugs(ordered);
  }

  return (
    <Section title="Sidebar modules" hint="Off = hidden from the sidebar (Nyo can still use its tools).">
      <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
        {SURFACE_MODULES.map(({ slug, label }) => {
          const on = slugs.includes(slug);
          return (
            <li key={slug} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="mono text-[10px] uppercase tracking-wider text-mute">{slug}</div>
              </div>
              <Toggle on={on} onToggle={() => toggle(slug)} label={`Show ${label} in sidebar`} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ─── Nyo brain — which LLM provider powers the chat ──────────
function NyoBrain() {
  const [brain, setBrain] = useState<Awaited<ReturnType<typeof api.brain>> | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() { setBrain(await api.brain()); }
  useEffect(() => { refresh(); }, []);

  const provider = brain?.provider;
  const ready = !!(brain && brain.key_set);

  return (
    <Section
      title="Nyo brain"
      hint="Per-surface model choices save to the llm-models knowledge doc and apply immediately — no deploy. Blank resets a field to its wrangler.jsonc default."
    >
      <div className="hairline rounded-sm bg-card/80 p-5 flex items-start gap-3">
        <span
          className={
            'mt-1 inline-block h-2 w-2 rounded-full shrink-0 ' +
            (busy ? 'bg-stone-400 animate-pulse'
              : ready ? 'bg-emerald-500'
              : brain ? 'bg-rose-500'
              : 'bg-stone-400 animate-pulse')
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-sm">
              {provider ? `Provider · ${provider}` : 'loading…'}
            </span>
            <button
              onClick={async () => { setBusy(true); try { await refresh(); } finally { setBusy(false); } }}
              className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
            >
              recheck ↻
            </button>
          </div>
          {brain && (
            <div className="mono text-[11px] text-mute mt-1">
              model <span className="text-ink">{brain.model || '—'}</span>
              <span className="mx-2">·</span>
              api key {brain.key_set ? <span className="text-emerald-700">set ✓</span> : <span className="text-rose-700">missing</span>}
            </div>
          )}
        </div>
      </div>

      {brain && <ModelEditor brain={brain} onSaved={refresh} />}

      <div className="mt-3 text-[12px] text-mute leading-relaxed">
        Supported providers today: <span className="mono text-ink">anthropic</span> · <span className="mono text-ink">openai</span>.
        Tool-use loop is provider-agnostic — same Nyo tools work either way; only the call format differs.
      </div>

      {/* The path here used to be hardcoded to ~/nyyon-command-center, which is
          wherever the AUTHOR happened to clone it, not the operator. Every
          install that lives anywhere else was being sent to a file that does
          not exist. __NYYON_REPO_ROOT__ is the real checkout, baked in by
          vite.config.ts. */}
      {brain && !brain.key_set && (
        <div className="mt-3 hairline rounded-sm bg-paper p-3 text-[12px] text-mute leading-relaxed">
          API key for <span className="mono text-ink">{provider}</span> not set.{' '}
          <a
            href={provider === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.anthropic.com/settings/keys'}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-ink transition"
          >
            Get a key
          </a>
          , then add it to{' '}
          <span className="mono text-ink break-all">{__NYYON_REPO_ROOT__}/workers/api/.dev.vars</span> as{' '}
          <span className="mono text-ink">{provider === 'openai' ? 'OPENAI_API_KEY=sk-...' : 'ANTHROPIC_API_KEY=sk-ant-...'}</span>{' '}
          and restart the app.
        </div>
      )}
    </Section>
  );
}

// ─── WhatsApp / wa-gateway connection ────────────────────────────
type WaProbe = Awaited<ReturnType<typeof api.waProbe>>;

function WhatsAppConnection() {
  const [probe, setProbe] = useState<WaProbe | null>(null);
  const [busy, setBusy]   = useState<'probe' | 'register' | 'test' | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function runProbe() {
    setBusy('probe');
    try {
      const p = await api.waProbe();
      setProbe(p);
      setLastResult(null);
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => { runProbe(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function registerWebhook() {
    setBusy('register');
    setLastResult(null);
    try {
      // Worker registers itself by URL — we just say "use my origin + /api/wa/inbound".
      // In dev the worker is at :8788; in prod it's the same host as the ops UI.
      const inbound = `${location.protocol}//localhost:8788/api/wa/inbound`;
      const r = await api.waRegisterWebhook(inbound);
      setLastResult(`Register webhook → HTTP ${r.http}  ·  ${r.ok ? 'OK' : 'failed'}\nbody: ${r.body.slice(0, 200)}`);
      await runProbe();
    } catch (e) {
      setLastResult(`Register webhook → error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    setLastResult(null);
    try {
      const r = await api.waTestInbound('972549999000@c.us', '[settings test] synthetic inbound');
      const verdict = r.result.accepted
        ? `✓ accepted + persisted, person_id=${r.result.person_id ?? '(no identity yet)'}`
        : `· chat policy = off (expected) — toggle the chat on in Channels → Chats, then re-run`;
      setLastResult(`Synthetic inbound → ${verdict}`);
    } catch (e) {
      setLastResult(`Test inbound → error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  // Pick a single-line status pill from probe state.
  const status = !probe
    ? { tone: 'neutral', label: '…', detail: 'probing' }
    : probe.reachable
      ? { tone: 'good', label: 'connected', detail: `${probe.url} · session ${probe.session_id}` }
      : probe.http === 401
        ? { tone: 'warn', label: 'auth required', detail: 'wa-gateway replied 401 — set WA_API_KEY in workers/api/.dev.vars' }
        : probe.http
          ? { tone: 'bad', label: `HTTP ${probe.http}`, detail: probe.error || 'see worker log' }
          : { tone: 'bad', label: 'offline', detail: probe.error || `${probe.url} not reachable` };

  return (
    <Section
      title="WhatsApp connection"
      hint="The WhatsApp connection. This app ships its own gateway and starts it for you — setup generates the key, so there is normally nothing to configure here. Point it elsewhere only if you host a gateway yourself."
    >
      {/* Status pill */}
      <div className="hairline rounded-sm bg-card/80 p-4 mb-4 flex items-start gap-3">
        <span
          className={
            'mt-1 inline-block h-2 w-2 rounded-full shrink-0 ' +
            (status.tone === 'good'
              ? 'bg-emerald-500'
              : status.tone === 'warn'
                ? 'bg-amber-500'
                : status.tone === 'bad'
                  ? 'bg-rose-500'
                  : 'bg-stone-400 animate-pulse')
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-sm">wa-gateway · {status.label}</span>
            <button
              onClick={runProbe}
              disabled={busy === 'probe'}
              className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
            >
              {busy === 'probe' ? '· probing' : 'recheck ↻'}
            </button>
          </div>
          <div className="mono text-[11px] text-mute mt-1 break-all">{status.detail}</div>
        </div>
      </div>

      {/* Configured values + what to fix */}
      {probe && (
        <ul className="hairline rounded-sm bg-card/80 divide-y divide-line text-[12px] mb-4">
          <KvRow k="WA_BASE_URL"   v={probe.url} />
          <KvRow k="WA_SESSION_ID" v={probe.session_id} />
          <KvRow
            k="WA_API_KEY"
            v={probe.api_key_configured ? 'set ✓' : 'not set — add to .dev.vars'}
            tone={probe.api_key_configured ? 'good' : 'warn'}
          />
          {probe.http !== null && <KvRow k="last probe" v={`HTTP ${probe.http}`} />}
        </ul>
      )}

      {/* Webhooks list if wa-gateway returned one */}
      {probe?.webhooks !== null && probe?.webhooks !== undefined && (
        <div className="hairline rounded-sm bg-card/80 p-4 mb-4">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">registered webhooks</div>
          <pre className="mono text-[11px] text-mute whitespace-pre-wrap break-all leading-snug">
{JSON.stringify(probe.webhooks, null, 2)}
          </pre>
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-wrap gap-2 mb-4">
        <ActionBtn onClick={registerWebhook} pending={busy === 'register'}>
          Register Nyyon webhook with wa-gateway
        </ActionBtn>
        <ActionBtn onClick={sendTest} pending={busy === 'test'}>
          Send synthetic inbound
        </ActionBtn>
      </div>

      {/* Last action result */}
      {lastResult && (
        <pre className="hairline rounded-sm bg-paper p-3 text-[11px] mono leading-snug whitespace-pre-wrap break-all text-ink">
{lastResult}
        </pre>
      )}

      {/* Inline help when 401.
          Never print a key here. This used to show a literal
          "WA_API_KEY=dev-admin-key", which both taught a known credential and
          was wrong for this app: setup generates a unique key per install and
          writes it to both sides, so a 401 means they have drifted apart, not
          that a value needs typing in. */}
      {probe?.http === 401 && (
        <div className="mt-4 text-[12px] text-mute leading-relaxed">
          <span className="mono text-ink">401</span> from the WhatsApp gateway means its key and this app's no longer match.
          Setup generates one key for both, so re-running it re-pairs them:
          <pre className="mt-2 mono text-[11px] bg-paper p-3 rounded-sm hairline overflow-x-auto leading-snug">
npm run setup</pre>
          Then click <span className="mono text-ink">recheck ↻</span>. If you point this at a gateway you host
          yourself, set its key in Settings → Connections instead.
        </div>
      )}
    </Section>
  );
}

function KvRow({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'warn' | 'bad' }) {
  const toneClass =
    tone === 'good' ? 'text-emerald-700' :
    tone === 'warn' ? 'text-amber-700' :
    tone === 'bad'  ? 'text-rose-700' :
    'text-ink';
  return (
    <li className="px-4 py-2.5 flex items-center justify-between gap-3">
      <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">{k}</span>
      <span className={'mono text-[11px] truncate text-right ' + toneClass}>{v}</span>
    </li>
  );
}

function ActionBtn({ onClick, pending, children }: { onClick: () => void; pending?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className={
        'h-9 px-4 rounded-sm hairline mono text-[10px] uppercase tracking-[0.18em] transition ' +
        (pending
          ? 'opacity-60 cursor-wait text-mute'
          : 'text-mute hover:text-ink hover:border-ink hover:bg-card-hi')
      }
    >
      {pending ? '· running' : children}
    </button>
  );
}

// ─── feature flags ───────────────────────────────────────────
function FeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.listFlags().then(setFlags).catch(() => {});
  }, []);

  async function flip(key: string, current: boolean) {
    setSaving(key);
    await api.setFlag(key, !current);
    setFlags((prev) => prev.map((f) => (f.key === key ? { ...f, value: !current ? 1 : 0 } : f)));
    setSaving(null);
  }

  const byScope: Record<string, FeatureFlag[]> = {};
  for (const f of flags) (byScope[f.scope] ||= []).push(f);

  return (
    <Section title="Feature flags" hint="Surface flags gate UI panels. Tool flags gate which capabilities Nyo can call.">
      {flags.length === 0 ? (
        <div className="text-mute text-sm">No flags registered.</div>
      ) : (
        <div className="space-y-6">
          {Object.entries(byScope).map(([scope, items]) => (
            <div key={scope}>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">{scope}</div>
              <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
                {items.map((f) => {
                  const on = f.value === 1;
                  return (
                    <li key={f.key} className="flex items-center justify-between px-4 py-3">
                      <div className="min-w-0 flex-1 pr-4">
                        <div className="mono text-[12px]">{f.key}</div>
                        {f.description && <div className="text-[11px] text-mute mt-0.5">{f.description}</div>}
                      </div>
                      <Toggle on={on} onToggle={() => flip(f.key, on)} pending={saving === f.key} label={`Toggle ${f.key}`} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── shared ──────────────────────────────────────────────────
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1">{title}</h2>
      {hint && <p className="text-xs text-mute mb-3">{hint}</p>}
      {children}
    </section>
  );
}

function Toggle({ on, onToggle, pending, label }: { on: boolean; onToggle: () => void; pending?: boolean; label: string }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      disabled={pending}
      onClick={onToggle}
      className={
        'relative h-6 w-10 rounded-full transition shrink-0 ' +
        (on ? 'bg-ink' : 'bg-line') +
        (pending ? ' opacity-40' : '')
      }
    >
      <span
        className={
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-paper transition-transform shadow ' +
          (on ? 'translate-x-4' : 'translate-x-0')
        }
      >
        {on && <Check size={12} className="absolute inset-0 m-auto text-ink" />}
      </span>
    </button>
  );
}

// ─── per-surface model editor (writes the llm-models knowledge doc) ──────────
const MODEL_FIELDS: { key: keyof Omit<import('../lib/api').NyoModelMap, 'source'>; label: string; hint: string }[] = [
  { key: 'nyo_low',      label: 'Nyo · Low',   hint: 'local model via the Ollama tunnel' },
  { key: 'nyo_mid',      label: 'Nyo · Mid',   hint: 'the default chat tier' },
  { key: 'nyo_high',     label: 'Nyo · High',  hint: 'hard reasoning in chat' },
  { key: 'writer',       label: 'Writers',      hint: 'digest synthesis · AEO articles · GTM angles' },
  { key: 'writer_small', label: 'Utility',      hint: 'cheap "mini/haiku" call sites' },
  { key: 'vision',       label: 'Vision',       hint: 'image judging (featured-image picker)' },
  { key: 'writer_fallback', label: 'Fallback writer', hint: 'Hugging Face model used while Anthropic credit is out (blank = writers pause)' },
];

function ModelEditor({ brain, onSaved }: { brain: import('../lib/api').BrainInfo; onSaved: () => Promise<void> | void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const val = (k: string) => (draft[k] !== undefined ? draft[k] : (brain.models as any)[k] || '');
  const dirty = MODEL_FIELDS.some(({ key }) => draft[key] !== undefined && draft[key] !== (brain.models as any)[key]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const patch: Record<string, string> = {};
      for (const { key } of MODEL_FIELDS) {
        if (draft[key] !== undefined) patch[key] = draft[key].trim() || (brain.defaults as any)[key];
      }
      await api.saveNyoModels(patch);
      setDraft({});
      await onSaved();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="mt-3 hairline rounded-sm bg-card/80 p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute">Models per surface</span>
        <span className="mono text-[10px] text-mute">{brain.models.source === 'doc' ? 'from llm-models doc' : 'wrangler defaults'}</span>
      </div>
      <div className="space-y-2">
        {MODEL_FIELDS.map(({ key, label, hint }) => (
          <div key={key} className="grid grid-cols-12 gap-3 items-center">
            <div className="col-span-4 min-w-0">
              <div className="text-xs font-medium">{label}</div>
              <div className="text-[10px] text-mute truncate">{hint}</div>
            </div>
            <input
              value={val(key)}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              placeholder={(brain.defaults as any)[key]}
              className="col-span-8 h-8 hairline rounded-sm bg-paper px-2.5 text-xs mono focus:outline-none focus:border-ink"
            />
          </div>
        ))}
      </div>
      {err && <div className="text-xs text-rose-700">{err}</div>}
      <div className="flex justify-end gap-2">
        {dirty && (
          <button onClick={() => setDraft({})} className="h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] text-mute hover:text-ink">
            discard
          </button>
        )}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] bg-ink text-paper disabled:opacity-40"
        >
          {saving ? 'saving…' : 'save models'}
        </button>
      </div>
    </div>
  );
}
