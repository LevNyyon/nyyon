// Plugins — trade capabilities between nyyon systems.
//
// Import: paste the manifest JSON another system exported; the server
// validates the format contract, binds gateways mechanically, and reports
// either the binding or the exact blocking errors. Export: one click copies
// the sealed manifest for handing to another system. Code materializes via
// the applier (self-hosted: seconds; cloud: a CI deploy), and a plugin only
// reads "active" once its tools are live in the pool.

import { useEffect, useState } from 'react';

type PluginRow = {
  name: string; version: string; title: string; status: string;
  binding: Record<string, { via: string; target: string }>;
  report: { step?: string; errors?: string[]; error?: string };
  installed_at: number; updated_at: number;
};

// The registry entry: everything one plugin put into this system, with paths.
type PluginReg = {
  name: string; title: string; version: string; status: string;
  origin: { system?: string } | null; path: string;
  tools: { name: string; path: string; description: string }[];
  gateways: { slug: string; installed_as: string; path: string; service: string }[];
  gateway_bindings: { slug: string; via: string; target: string }[];
  requires_gateways: { slug: string; modes: string[] }[];
  workflows: { slug: string; name: string; steps: string[] }[];
  knowledge: { slug: string; title: string }[];
  tables: string[];
  surfaces: { slug: string; path: string | null }[];
};

const STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-700 bg-emerald-500/10',
  bound: 'text-amber-700 bg-amber-500/10',
  materialized: 'text-amber-700 bg-amber-500/10',
  blocked: 'text-rose-700 bg-rose-500/10',
  removed: 'text-mute bg-line/40',
};

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  // Ignoring the status turned a 401 into an empty plugin list, which reads as
  // "nothing installed" — the most alarming possible way to say "signed out".
  if (r.status === 401) throw new Error('session expired — reload the page to sign in');
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export function Plugins() {
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [reg, setReg] = useState<Record<string, PluginReg>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [paste, setPaste] = useState('');
  const [srcUrl, setSrcUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Each half fails on its own: a broken registry must not blank the list, and
  // a failed poll must surface instead of silently rejecting every 15s.
  const reload = () => Promise.all([
    j<{ plugins: PluginRow[] }>('/api/plugins')
      .then((d) => setRows(d.plugins || []))
      .catch((e) => setNote(`Could not load plugins: ${String(e?.message || e)}`)),
    j<{ plugins: PluginReg[] }>('/api/plugins/registry')
      .then((d) => setReg(Object.fromEntries((d.plugins || []).map((p) => [p.name, p]))))
      .catch(() => { /* the registry is detail; the list above still renders */ }),
  ]);
  useEffect(() => { reload(); const t = setInterval(reload, 15000); return () => clearInterval(t); }, []);

  const doImport = async () => {
    setBusy(true); setNote(null);
    try {
      const manifest = JSON.parse(paste);
      const r = await j<{ ok: boolean; status?: string; errors?: string[] }>('/api/plugins/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }),
      });
      setNote(r.ok ? `Imported — status: ${r.status}. Code activates when the applier finishes.` : `Blocked:\n${(r.errors || []).join('\n')}`);
      if (r.ok) setPaste('');
      reload();
    } catch (e) {
      setNote(`Not valid JSON: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  // The primary path: install FROM A SOURCE. The URL is recorded with the
  // plugin, so "where did this come from" and "is there a newer version" are
  // answerable later — the two questions a pasted blob can never answer.
  const doImportUrl = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await j<{ ok: boolean; status?: string; errors?: string[]; error?: string; source?: { source_url?: string; ref?: string } }>(
        '/api/plugins/import-url',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: srcUrl.trim() }) },
      );
      setNote(r.ok
        ? `Imported from ${r.source?.source_url || srcUrl}${r.source?.ref ? ` @ ${r.source.ref}` : ''} — status: ${r.status}.`
        : `Blocked:\n${(r.errors || [r.error]).filter(Boolean).join('\n')}`);
      if (r.ok) setSrcUrl('');
      reload();
    } catch (e) {
      setNote(`Could not fetch that source: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  // A package is the authoring form: manifest.json plus real .mjs/.md files.
  // The server assembles it back into the same manifest the paste box takes.
  const doImportPackage = async (file: File) => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/plugins/import-package', {
        method: 'POST', headers: { 'content-type': 'application/zip' }, body: file,
      });
      const d = await r.json();
      setNote(d.ok
        ? `Imported ${file.name} — status: ${d.status}. Code activates when the applier finishes.`
        : `Blocked:\n${(d.errors || [d.error]).filter(Boolean).join('\n')}`);
      reload();
    } catch (e) {
      setNote(`Could not read the package: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  const doExport = async (name: string) => {
    const m = await j<object>(`/api/plugins/${encodeURIComponent(name)}/export`);
    await navigator.clipboard.writeText(JSON.stringify(m, null, 2));
    setNote(`"${name}" manifest copied to the clipboard — paste it into the other system's Plugins page.`);
  };

  const doRemove = async (name: string) => {
    if (!confirm(`Remove plugin "${name}"? Its workflows disable and its code is cleaned up. Tables and data stay.`)) return;
    await j(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
    reload();
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <header>
        <h1 className="text-lg font-semibold">Plugins</h1>
        <p className="text-[12px] text-mute mt-1">
          Capabilities traded between nyyon systems. Code travels verbatim and runs against a
          capability boundary: its own tables, only the gateways it declared. Importing a plugin
          is still a decision to trust its author. Format: docs/plugin-format.md.
        </p>
      </header>

      <section className="hairline rounded-sm bg-card/80 p-4 space-y-2">
        <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute">Install from a source</div>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 h-9 px-2.5 text-[12px] mono rounded-sm hairline bg-bg outline-none focus:border-emerald-500"
            placeholder="https://github.com/owner/plugin  (or a link to a .zip / manifest.json)"
            value={srcUrl}
            onChange={(e) => setSrcUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && srcUrl.trim() && !busy) doImportUrl(); }}
          />
          <button
            className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-bg disabled:opacity-40 shrink-0"
            disabled={busy || !srcUrl.trim()} onClick={doImportUrl}
          >{busy ? 'Installing…' : 'Install'}</button>
        </div>
        <p className="text-[11px] text-mute">
          A source is recorded with the plugin, so you can see where it came from and re-install a newer version later.
        </p>

        <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute pt-2">Or paste a manifest</div>
        <textarea
          className="w-full h-32 text-[12px] mono p-2 rounded-sm bg-bg hairline"
          placeholder='Paste the manifest JSON another system exported ({"nyyon_plugin":1, ...})'
          value={paste} onChange={(e) => setPaste(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-bg disabled:opacity-40"
            disabled={busy || !paste.trim()} onClick={doImport}
          >{busy ? 'Importing…' : 'Import'}</button>
          <label className="text-[11px] text-mute hover:text-ink cursor-pointer">
            or upload a .zip package
            <input
              type="file" accept=".zip,application/zip" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doImportPackage(f); e.target.value = ''; }}
            />
          </label>
          {note && <pre className="text-[11px] text-mute whitespace-pre-wrap flex-1">{note}</pre>}
        </div>
      </section>

      <section className="space-y-2">
        <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute">Installed</div>
        {!rows.length && <div className="text-[12px] text-mute">Nothing installed yet.</div>}
        {rows.map((r) => (
          <div key={r.name} className="hairline rounded-sm bg-card/80 p-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{r.title}</span>
              <span className="mono text-[10px] text-mute">{r.name} · v{r.version}</span>
              <span className={`mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full ${STATUS_TONE[r.status] || 'text-mute bg-line/40'}`}>{r.status}</span>
              <span className="flex-1" />
              <button className="text-[11px] text-mute hover:text-ink" onClick={() => doExport(r.name)}>Copy JSON</button>
              <a
                className="text-[11px] text-mute hover:text-ink"
                href={`/api/plugins/${encodeURIComponent(r.name)}/package`}
                download
              >Download .zip</a>
              {r.status !== 'removed' && (
                <button className="text-[11px] text-rose-700/70 hover:text-rose-700" onClick={() => doRemove(r.name)}>Remove</button>
              )}
            </div>
            {Object.keys(r.binding || {}).length > 0 && (
              <div className="mt-1 text-[11px] text-mute">
                gateways: {Object.entries(r.binding).map(([slug, b]) => `${slug} → ${b.target} (${b.via})`).join(' · ')}
              </div>
            )}
            {r.status === 'blocked' && (
              <pre className="mt-1 text-[11px] text-rose-700/90 whitespace-pre-wrap">{(r.report?.errors || [r.report?.error]).filter(Boolean).join('\n')}</pre>
            )}
            {reg[r.name] && (
              <button className="mt-1 text-[11px] text-mute hover:text-ink" onClick={() => setOpen((o) => ({ ...o, [r.name]: !o[r.name] }))}>
                {open[r.name] ? '▾ registry' : '▸ registry'}
              </button>
            )}
            {open[r.name] && reg[r.name] && <PluginRegistry p={reg[r.name]} />}
          </div>
        ))}
      </section>
    </div>
  );
}

// One plugin's full registry: every component it put into this system, with
// the real paths its code lives at. This IS the Registry — plugin-scoped.
function PluginRegistry({ p }: { p: PluginReg }) {
  const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="mt-1.5">
      <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{label}</div>
      <div className="text-[11px] mt-0.5 space-y-0.5">{children}</div>
    </div>
  );
  const none = <span className="text-mute">none</span>;
  return (
    <div className="mt-2 pl-3 border-l border-line/70">
      <Section label="Path">
        <span className="mono text-[10px]">{p.path}/</span>
        {p.origin?.system && <span className="text-mute"> · from {p.origin.system}</span>}
      </Section>
      <Section label={`Tools (${p.tools.length})`}>
        {p.tools.length ? p.tools.map((t) => (
          <div key={t.name}><span className="mono text-[10px]">{t.name}</span> — <span className="mono text-[10px] text-mute">{t.path}</span>
            {t.description && <div className="text-mute">{t.description.slice(0, 110)}</div>}</div>
        )) : none}
      </Section>
      <Section label={`Gateways (${p.gateways.length} bundled · ${p.gateway_bindings.length} bound)`}>
        {p.gateways.map((g) => (
          <div key={g.slug}><span className="mono text-[10px]">{g.installed_as}</span> — <span className="mono text-[10px] text-mute">{g.path}</span></div>
        ))}
        {p.gateway_bindings.map((b) => (
          <div key={b.slug}><span className="mono text-[10px]">{b.slug}</span> → <span className="mono text-[10px]">{b.target}</span> <span className="text-mute">({b.via})</span></div>
        ))}
        {!p.gateways.length && !p.gateway_bindings.length && none}
      </Section>
      <Section label={`Workflows (${p.workflows.length})`}>
        {p.workflows.length ? p.workflows.map((w) => (
          <div key={w.slug}><span className="mono text-[10px]">{w.slug}</span> — {w.steps.join(' → ') || <span className="text-mute">observability-only</span>}</div>
        )) : none}
      </Section>
      <Section label={`Knowledge (${p.knowledge.length})`}>
        {p.knowledge.length ? p.knowledge.map((k) => (
          <div key={k.slug}><span className="mono text-[10px]">{k.slug}</span> — {k.title}</div>
        )) : none}
      </Section>
      <Section label={`Tables (${p.tables.length})`}>
        {p.tables.length ? p.tables.map((t) => <div key={t} className="mono text-[10px]">{t}</div>) : none}
      </Section>
      <Section label={`Surfaces (${p.surfaces.length})`}>
        {p.surfaces.length ? p.surfaces.map((sf) => (
          <div key={sf.slug}><span className="mono text-[10px]">{sf.slug}</span>{sf.path && <span className="mono text-[10px] text-mute"> — {sf.path}</span>}</div>
        )) : <span className="text-mute">none — v1 plugins ship no UI surfaces</span>}
      </Section>
    </div>
  );
}
