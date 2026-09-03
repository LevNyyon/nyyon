import { useEffect, useState } from 'react';
import { api, onboarding, modulePrereqs, FeatureFlag, GatewayStatus } from '../lib/api';
import { SetupResumeBanner } from '../components/SetupResumeBanner';
import {
  loadTheme, saveTheme, type Theme,
  loadSidebarSlugs, saveSidebarSlugs,
  SURFACE_MODULES, type SurfaceSlug,
} from '../lib/theme';
import { Sun, Moon, Monitor, Check } from '../components/Icons';

// One button, one deep link. Cloudflare's Deploy to Workers page reads the
// repo and walks the person through creating the worker, the database and the
// bucket in THEIR OWN account. No credential of theirs passes through here.
const REPO_URL = 'https://github.com/LevNyyon/nyyon';
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(REPO_URL)}`;
// The token path is the one an AI agent can actually use: the operator creates
// a scoped token on a pre-filled Cloudflare page and pastes it to the agent,
// which deploys headless. `wrangler login` needs a human at a browser.
const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens/create?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%5D&name=nyyon-deploy&accountId=%2A&zoneId=all';
const AGENT_PROMPT = `Install nyyon for me. Clone ${REPO_URL}, cd into it, then deploy it to my Cloudflare account using this token:

CLOUDFLARE_API_TOKEN=<paste your token here>

Run \`npm install\`, then \`CLOUDFLARE_API_TOKEN=<token> npm run deploy\`.
When it finishes, give me the URL and the setup link it prints.`;

function DeployCard() {
  return (
    <section className="hairline rounded-sm p-4 space-y-2.5">
      <h2 className="text-[13px] font-semibold">Running this locally? Put it online</h2>
      <p className="text-[12px] text-mute leading-relaxed">
        If this install is running on your own machine, this puts a copy in your own Cloudflare
        account: your worker, your database, your data. The free tier is enough and no card is
        asked for. A deployed install is already online, so this is only useful locally.
      </p>
      <ol className="text-[12px] text-mute leading-relaxed pl-4 list-decimal space-y-1">
        <li>Create a Cloudflare token. The link opens the page with the right permissions already ticked.</li>
        <li>Paste the prompt below to Claude, with your token in it. It deploys and gives you the address.</li>
      </ol>
      <div className="flex items-center gap-3 flex-wrap">
        <a href={TOKEN_URL} target="_blank" rel="noreferrer noopener"
           className="text-[12px] px-3 h-8 inline-flex items-center rounded-sm bg-ink text-paper">
          Create the token
        </a>
        <button
          onClick={() => { navigator.clipboard.writeText(AGENT_PROMPT).catch(() => {}); }}
          className="text-[12px] px-3 h-8 inline-flex items-center rounded-sm hairline bg-paper hover:bg-card">
          copy the prompt
        </button>
        <a href={DEPLOY_URL} target="_blank" rel="noreferrer noopener"
           className="text-[12px] text-mute hover:text-ink underline underline-offset-2">
          or use the one-click button
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener"
           className="text-[12px] text-mute hover:text-ink underline underline-offset-2">see the code</a>
      </div>
      <p className="text-[11px] text-mute leading-relaxed">
        Cloudflare opens in a new tab and gives you a live address plus a one-time setup link when
        it finishes. The new copy starts empty; nothing here travels with it.
      </p>
    </section>
  );
}

export function Settings() {
  return (
    <div className="h-full flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center bg-card/60 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-10 max-w-3xl">
        <UnfinishedSetup />
        <DeployCard />
        <Appearance />
        <NyoBrain />
        <SidebarPlacement />
        <Connections />
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

// ─── Connections ────────────────────────────────────────────────
// One surface for every external service, driven by the live gateway registry.
//
// This replaced a bespoke "WhatsApp connection" panel that had rotted into
// something actively misleading: it hardcoded the old dev port (:8788, the
// worker moved to :8799), offered to register a webhook against a daemon this
// build no longer ships, and explained how to repair a wa-gateway pairing that
// a shipped install never has. A panel per service also guarantees the next
// one rots the same way. The registry already knows every gateway, which
// credentials it needs and whether they resolve — so render THAT.

function Connections() {
  const [rows, setRows] = useState<GatewayStatus[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () => modulePrereqs.gatewayStatus()
    .then((d) => setRows(d.gateways || []))
    .catch((e) => setNote(`Could not read connections: ${String(e?.message || e)}`));
  useEffect(() => { load(); }, []);

  const save = async (slug: string) => {
    setBusy(slug); setNote(null);
    try {
      const r = await modulePrereqs.connectGateway(slug, draft);
      setNote(r.configured
        ? `${slug} connected.`
        : `${slug}: still missing ${(r.missing || []).join(', ') || 'required values'}`);
      setOpen(null); setDraft({});
      await load();
    } catch (e) {
      setNote(`${slug}: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(null); }
  };

  return (
    <Section
      title="Connections"
      hint="External services this install can reach. A gateway with no credentials simply stays off — the modules that use it say so and keep working in whatever degraded form they can."
    >
      {!rows && <div className="text-[12px] text-mute">Loading…</div>}
      {rows?.length === 0 && <div className="text-[12px] text-mute">No gateways require configuration.</div>}
      <div className="space-y-1.5">
        {(rows || []).map((g) => (
          <div key={g.slug} className="hairline rounded-sm bg-card/80 p-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${g.configured ? 'bg-emerald-500' : 'bg-stone-400'}`} />
              <span className="mono text-[12px]">{g.slug}</span>
              <span className="text-[11px] text-mute">
                {g.configured ? `connected${g.source && g.source !== 'none' ? ` · ${g.source}` : ''}` : 'not connected'}
              </span>
              <span className="flex-1" />
              {(g.fields || []).length > 0 && (
                <button
                  className="text-[11px] text-mute hover:text-ink"
                  onClick={() => { setOpen(open === g.slug ? null : g.slug); setDraft({}); setNote(null); }}
                >{open === g.slug ? 'cancel' : (g.configured ? 'update' : 'connect')}</button>
              )}
            </div>
            {!g.configured && (g.missing || []).length > 0 && (
              <div className="mt-1 text-[11px] text-mute">needs: {(g.missing || []).join(', ')}</div>
            )}
            {open === g.slug && (
              <div className="mt-2 space-y-1.5">
                {(g.fields || []).map((f) => (
                  <label key={f.key} className="block">
                    <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">
                      {f.label || f.key}{f.required === false ? ' (optional)' : ''}
                    </span>
                    <input
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={f.help || f.key}
                      value={draft[f.key] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="mt-0.5 w-full h-8 px-2 rounded-sm hairline bg-paper text-[12px] outline-none focus:border-emerald-500"
                    />
                  </label>
                ))}
                <button
                  className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-paper disabled:opacity-40"
                  disabled={busy === g.slug}
                  onClick={() => save(g.slug)}
                >{busy === g.slug ? 'Saving…' : 'Save'}</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {note && <div className="mt-2 text-[11px] text-mute">{note}</div>}
    </Section>
  );
}

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
  { key: 'nyo_low',      label: 'Nyo · Low',   hint: 'the fast, cheap chat tier' },
  { key: 'nyo_mid',      label: 'Nyo · Mid',   hint: 'the default chat tier' },
  { key: 'nyo_high',     label: 'Nyo · High',  hint: 'hard reasoning in chat' },
  { key: 'writer',       label: 'Writers',      hint: 'heavy background writers from installed modules' },
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
