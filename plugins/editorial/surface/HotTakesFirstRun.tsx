// Hot Takes · module first run.
//
// NOT app onboarding and NOT a modal: this is a takeover panel that lives
// inside the Hot Takes page, under its own header, and it opens exactly once —
// the first time an operator lands on the module. Any decision they make (set
// it up, or skip it) is recorded server-side, so it never opens on its own
// again. The rest of the app stays reachable behind it the whole time.
//
// The honesty rules the panel is built around:
//   · It reads what setup already learned instead of re-asking. If those notes
//     are still the shipped placeholders it SAYS SO and asks for one line,
//     rather than confidently scouting the wrong industry.
//   · Every feed offered here has been fetched and parsed by the worker before
//     it reached the screen, and each card shows the item count we saw. A feed
//     the operator pastes gets the same check before it can be ticked.
//   · Everything is optional. Skipping leaves a module that is empty and works.

import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type HotTakeSetupState, type SourceProposal, type SourceProposals,
  type FeedCheck, type FirstIngestResult,
} from './hot-takes-data';
import { Check, X, Refresh, Sparkle, Globe, Newspaper } from '../../components/Icons';

type Stage = 'read' | 'pick' | 'done';

function hostOf(url?: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function ago(ts?: number | null): string {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}
const keyOf = (p: SourceProposal) => `${p.kind}:${p.url}`;

// ─── small shared bits (house style: mono labels, hairline, emerald accent) ──
function Label({ children }: { children: React.ReactNode }) {
  return <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">{children}</span>;
}

function Btn({ children, onClick, disabled, tone = 'line', title }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  tone?: 'ink' | 'line' | 'ghost'; title?: string;
}) {
  const cls = tone === 'ink'
    ? 'bg-ink text-paper'
    : tone === 'ghost'
      ? 'text-mute hover:text-ink'
      : 'border border-line text-ink hover:bg-card';
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`h-8 px-3 rounded-sm text-xs font-medium disabled:opacity-50 shrink-0 ${cls}`}>
      {children}
    </button>
  );
}

// Free-text list: type, Enter to add, click a chip to drop it. Used for the
// operator's OWN words — the topics, keywords and ignore list that get written
// into the heartbeat-priorities note verbatim.
function TagInput({ label, hint, values, onChange, placeholder }: {
  label: string; hint?: string; values: string[];
  onChange: (next: string[]) => void; placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...values, ...parts.filter((p) => !values.includes(p))]);
    setDraft('');
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <Label>{label}</Label>
        {hint && <span className="text-[11px] text-mute">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <button key={v} type="button" onClick={() => onChange(values.filter((x) => x !== v))}
            title="remove"
            className="inline-flex items-center gap-1 h-6 px-2 rounded-sm bg-card hairline text-[12px] text-ink hover:text-rose-600">
            {v}<X size={11} />
          </button>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full h-9 px-3 rounded-sm bg-paper border border-line text-[13px] text-ink focus:outline-none focus:border-ink/40"
      />
    </div>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function HotTakesFirstRun({ state, onClose }: {
  state: HotTakeSetupState;
  // Called with `true` when something was applied, so the page can refresh its
  // tabs; `false` after a skip (nothing changed but the panel must close).
  onClose: (changed: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>('read');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [scout, setScout] = useState<SourceProposals | null>(null);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState<SourceProposal[]>([]);      // operator-pasted, already validated
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteCheck, setPasteCheck] = useState<FeedCheck | null>(null);
  const [watchers, setWatchers] = useState<Record<string, boolean>>({});

  const [topics, setTopics] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [ignore, setIgnore] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const [applied, setApplied] = useState<{ sources: number; kept: number; listeners: number; watch: boolean } | null>(null);
  const [ingest, setIngest] = useState<FirstIngestResult | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const docs = state.personalisation?.docs || {};
  const docList = useMemo(() => Object.values(docs), [docs]);
  const personalised = Boolean(state.personalisation?.personalised);

  const allProposals = useMemo(
    () => [...(scout?.proposals || []), ...extra],
    [scout, extra],
  );
  const pickedSources = allProposals.filter((p) => chosen[keyOf(p)]);
  const pickedWatchers = useMemo(() => {
    const brands = (scout?.brands || []).map((n) => ({ name: n, kind: 'brand' as const }));
    const comps = (scout?.competitors || []).map((n) => ({ name: n, kind: 'competitor' as const }));
    return [...brands, ...comps].filter((w) => watchers[w.name]);
  }, [scout, watchers]);

  // Proposal keywords become the STARTING point for the operator's own words —
  // they are editable chips, never saved as-is without being seen.
  useEffect(() => {
    if (!scout?.ok) return;
    setKeywords((k) => (k.length ? k : (scout.keywords || []).slice(0, 12)));
    setIgnore((k) => (k.length ? k : (scout.ignore || []).slice(0, 8)));
  }, [scout]);

  async function propose() {
    setBusy('propose'); setErr(null);
    try {
      const r = await api.hotTakeProposeSources(hint.trim());
      setScout(r);
      if (r.ok) {
        // Nothing is pre-ticked. The operator chooses; we do not decide for them.
        setStage('pick');
      } else if (r.reason === 'llm_failed') {
        setErr(r.message || 'the model could not be reached');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'could not scout sources'); }
    finally { setBusy(null); }
  }

  async function checkPasted() {
    const u = pasteUrl.trim();
    if (!u) return;
    setBusy('paste'); setErr(null); setPasteCheck(null);
    try {
      const r = await api.hotTakeValidateFeed(u);
      setPasteCheck(r);
      if (r.ok) {
        const p: SourceProposal = {
          kind: 'rss', name: hostOf(r.url) || u, url: r.url, query: null,
          theme: 'general', why: 'added by you',
          items: r.items || 0, latest_at: r.latest_at ?? null, sample: r.sample || [],
        };
        if (!allProposals.some((x) => keyOf(x) === keyOf(p))) setExtra((xs) => [...xs, p]);
        setChosen((m) => ({ ...m, [keyOf(p)]: true }));
        setPasteUrl('');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'could not check that URL'); }
    finally { setBusy(null); }
  }

  async function save(runIngest: boolean) {
    setBusy(runIngest ? 'save-run' : 'save'); setErr(null);
    try {
      const r = await api.hotTakeApplySetup({
        sources: pickedSources.map((p) => ({
          kind: p.kind, name: p.name, url: p.url, query: p.query, theme: p.theme,
          // The proof travels with the pick: `items` is the count this feed was
          // validated with, and its presence is what tells the server this URL
          // has already been fetched. Drop it and every save re-fetches.
          items: p.items,
        })),
        targets: pickedWatchers.map((w) => ({ name: w.name, kind: w.kind })),
        watch: { topics, keywords, ignore, note: note.trim() },
        ran_ingest: runIngest,
      });
      setApplied({
        sources: r.summary?.sources_added || 0,
        kept: r.summary?.sources_kept || 0,
        listeners: r.summary?.listeners_added || 0,
        watch: Boolean(r.summary?.watch_written),
      });
      if (r.failed?.length) setErr(`${r.failed.length} could not be saved: ${r.failed.map((f) => f.name).join(', ')}`);
      setStage('done');
      if (runIngest) {
        setBusy('ingest');
        setIngest(await api.hotTakeFirstIngest());
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'could not save'); }
    finally { setBusy(null); }
  }

  async function skip() {
    setBusy('skip'); setErr(null);
    try { await api.hotTakeSkipSetup(); onClose(false); }
    catch (e) { setErr(e instanceof Error ? e.message : 'could not skip'); setBusy(null); }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* header */}
        <div className="space-y-1.5">
          <Label>Hot Takes · first run</Label>
          <h2 className="text-xl font-semibold text-ink">Tell the feed what to watch</h2>
          <p className="text-[13px] text-mute">
            The Topics tab is only as good as the sources behind it. Right now this install watches{' '}
            <span className="mono text-[12px] text-ink">{state.sources.enabled}</span> source
            {state.sources.enabled === 1 ? '' : 's'} that shipped with it, which is almost certainly
            somebody else's industry. This takes a minute, and you can skip it.
          </p>
        </div>

        {err && (
          <div className="hairline rounded-sm bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{err}</div>
        )}

        {/* ── stage: what we already know ─────────────────────────────── */}
        {stage === 'read' && (
          <>
            <section className="panel rounded-sm p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Label>What setup already told us</Label>
              </div>
              <ul className="space-y-1.5">
                {docList.map((d) => (
                  <li key={d.slug} className="flex items-center gap-2 text-[13px]">
                    <span className={'inline-block h-1.5 w-1.5 rounded-full ' + (d.personal ? 'bg-emerald-500' : 'bg-line')} />
                    <span className="text-ink">{d.label}</span>
                    <span className="mono text-[10px] text-mute">{d.slug}</span>
                    <span className="ml-auto mono text-[10px] uppercase tracking-[0.14em]">
                      {d.personal
                        ? <span className="text-emerald-700">yours</span>
                        : <span className="text-mute">{d.exists ? 'shipped default' : 'not written'}</span>}
                    </span>
                  </li>
                ))}
              </ul>

              {personalised ? (
                <p className="text-[13px] text-mute">
                  Good — there is enough here to scout from. I will read these, propose feeds and
                  news queries for your field, and fetch every one of them before showing it to you.
                </p>
              ) : (
                <p className="text-[13px] text-mute">
                  These are still the placeholder notes this product ships with. Nothing here says
                  what you do, so anything I proposed would be a guess dressed up as a
                  recommendation. Give me one line instead, or fill the notes in Knowledge and come
                  back.
                </p>
              )}
            </section>

            {!personalised && (
              <section className="panel rounded-sm p-4 space-y-2">
                <Label>In one line</Label>
                <input
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && hint.trim()) propose(); }}
                  placeholder="What you do, and who it is for. e.g. independent structural engineers in Israel, mostly residential retrofits"
                  className="w-full h-10 px-3 rounded-sm bg-paper border border-line text-[13px] text-ink focus:outline-none focus:border-ink/40"
                />
                <p className="text-[11px] text-mute">
                  This is only used to scout sources. What you keep gets written into your own
                  <span className="mono text-[11px] text-ink"> heartbeat-priorities</span> note, which you can edit any time.
                </p>
              </section>
            )}

            <div className="flex items-center gap-2">
              <Btn tone="ink" onClick={propose} disabled={busy === 'propose' || (!personalised && !hint.trim())}>
                {busy === 'propose' ? 'Scouting and checking feeds…' : 'Scout my sources'}
              </Btn>
              <Btn tone="ghost" onClick={skip} disabled={Boolean(busy)}>Skip — I will add sources myself</Btn>
            </div>
            {busy === 'propose' && (
              <p className="text-[12px] text-mute flex items-center gap-2">
                <Refresh size={12} /> Fetching each candidate feed. Anything that does not answer is dropped, not offered.
              </p>
            )}

            {scout && !scout.ok && scout.reason === 'no_material' && (
              <p className="text-[13px] text-mute">{scout.message}</p>
            )}
          </>
        )}

        {/* ── stage: pick ─────────────────────────────────────────────── */}
        {stage === 'pick' && scout?.ok && (
          <>
            {scout.industry && (
              <div className="hairline rounded-sm bg-card px-3 py-2 text-[13px] text-ink flex items-start gap-2">
                <Sparkle size={14} />
                <span>{scout.industry}</span>
              </div>
            )}

            <section className="space-y-2">
              <div className="flex items-baseline gap-2">
                <Label>Sources that answered</Label>
                <span className="text-[11px] text-mute">
                  {allProposals.length} of {(scout.fetches || 0)} URLs fetched came back as a real feed. Item counts are what we actually parsed.
                </span>
              </div>

              {allProposals.length === 0 && (
                <div className="hairline rounded-sm px-3 py-3 text-[13px] text-mute">
                  Nothing validated. Rather than offer you a list of plausible-looking URLs that
                  404, I am offering none — paste a feed you already read below, or skip and add
                  sources later from Approved Sources.
                </div>
              )}

              <ul className="space-y-1.5">
                {allProposals.map((p) => {
                  const k = keyOf(p);
                  const on = Boolean(chosen[k]);
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => setChosen((m) => ({ ...m, [k]: !on }))}
                        className={'w-full text-left hairline rounded-sm px-3 py-2.5 transition flex gap-3 items-start ' +
                          (on ? 'bg-emerald-50/70 border-emerald-500/40' : 'bg-card/60 hover:bg-card')}
                      >
                        <span className={'mt-0.5 h-4 w-4 rounded-sm shrink-0 flex items-center justify-center ' +
                          (on ? 'bg-emerald-600 text-white' : 'border border-line')}>
                          {on && <Check size={11} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-[13px] font-medium text-ink">{p.name}</span>
                            <span className="mono text-[10px] uppercase tracking-[0.14em] text-mute inline-flex items-center gap-1">
                              {p.kind === 'gnews' ? <Newspaper size={10} /> : <Globe size={10} />}
                              {p.kind === 'gnews' ? 'news query' : 'feed'}
                            </span>
                            <span className="mono text-[11px] text-emerald-700 tabular-nums">{p.items} items</span>
                            {p.latest_at ? <span className="mono text-[10px] text-mute">latest {ago(p.latest_at)}</span> : null}
                          </span>
                          <span className="block mono text-[11px] text-mute truncate">
                            {p.kind === 'gnews' ? p.query : hostOf(p.url)}
                          </span>
                          {p.why && <span className="block text-[12px] text-mute mt-0.5">{p.why}</span>}
                          {p.sample?.[0] && (
                            <span className="block text-[12px] text-ink/70 mt-1 truncate">“{p.sample[0]}”</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {Boolean(scout.rejected?.length) && (
                <div>
                  <button type="button" onClick={() => setShowRejected((v) => !v)}
                    className="mono text-[10px] uppercase tracking-[0.16em] text-mute hover:text-ink">
                    {showRejected ? '▾' : '▸'} {scout.rejected!.length} candidates did not answer
                  </button>
                  {showRejected && (
                    <ul className="mt-1.5 space-y-1">
                      {scout.rejected!.map((r, i) => (
                        <li key={i} className="text-[12px] text-mute flex gap-2">
                          <span className="text-ink/60">{r.name || hostOf(r.url)}</span>
                          <span className="mono text-[11px] truncate">{r.url}</span>
                          <span className="ml-auto mono text-[10px] text-rose-600/80 shrink-0">{r.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {/* paste your own — same proof as everything above */}
            <section className="panel rounded-sm p-4 space-y-2">
              <Label>Paste your own feed</Label>
              <div className="flex gap-2">
                <input
                  value={pasteUrl}
                  onChange={(e) => { setPasteUrl(e.target.value); setPasteCheck(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') checkPasted(); }}
                  placeholder="https://…/feed"
                  className="flex-1 h-9 px-3 rounded-sm bg-paper border border-line text-[13px] text-ink focus:outline-none focus:border-ink/40"
                />
                <Btn onClick={checkPasted} disabled={busy === 'paste' || !pasteUrl.trim()}>
                  {busy === 'paste' ? 'Checking…' : 'Check'}
                </Btn>
              </div>
              {pasteCheck && !pasteCheck.ok && (
                <p className="text-[12px] text-rose-600">{pasteCheck.error} — not added.</p>
              )}
              <p className="text-[11px] text-mute">Checked the same way as the list above: fetched and parsed before it can be added.</p>
            </section>

            {/* brand + competitor listeners */}
            {Boolean((scout.brands?.length || 0) + (scout.competitors?.length || 0)) && (
              <section className="panel rounded-sm p-4 space-y-2">
                <div className="flex items-baseline gap-2">
                  <Label>Names to listen for</Label>
                  <span className="text-[11px] text-mute">Mentions of these feed the same topic queue.</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[...(scout.brands || []).map((n) => ({ n, kind: 'brand' })), ...(scout.competitors || []).map((n) => ({ n, kind: 'competitor' }))].map(({ n, kind }) => (
                    <button key={kind + n} type="button"
                      onClick={() => setWatchers((m) => ({ ...m, [n]: !m[n] }))}
                      className={'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-[12px] transition ' +
                        (watchers[n] ? 'bg-emerald-600 text-white' : 'hairline bg-card text-ink hover:bg-paper')}>
                      {n}
                      <span className={'mono text-[9px] uppercase tracking-[0.14em] ' + (watchers[n] ? 'text-white/70' : 'text-mute')}>{kind}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* the operator's own words */}
            <section className="panel rounded-sm p-4 space-y-4">
              <div>
                <Label>What matters to you</Label>
                <p className="text-[11px] text-mute mt-1">
                  Written into your <span className="mono text-[11px] text-ink">heartbeat-priorities</span> note in
                  your words. It is what every incoming item is scored against, and you can edit it later.
                </p>
              </div>
              <TagInput label="Topics that matter" values={topics} onChange={setTopics}
                placeholder="Type a topic and press Enter" />
              <TagInput label="Names and keywords to catch" values={keywords} onChange={setKeywords}
                hint="prefilled from the scout — edit freely" placeholder="Add a keyword and press Enter" />
              <TagInput label="Not relevant" values={ignore} onChange={setIgnore}
                hint="the neighbouring subject that keeps showing up" placeholder="Add something to ignore" />
              <div className="space-y-1.5">
                <Label>Anything else</Label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                  placeholder="Optional. One or two sentences on what makes an item worth your attention."
                  className="w-full px-3 py-2 rounded-sm bg-paper border border-line text-[13px] text-ink focus:outline-none focus:border-ink/40" />
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <Btn tone="ink" onClick={() => save(true)} disabled={Boolean(busy)}>
                {busy === 'save-run' ? 'Saving…' : `Save and run the first sweep${pickedSources.length ? ` (${pickedSources.length})` : ''}`}
              </Btn>
              <Btn onClick={() => save(false)} disabled={Boolean(busy)}>
                {busy === 'save' ? 'Saving…' : 'Save without running'}
              </Btn>
              <Btn tone="ghost" onClick={skip} disabled={Boolean(busy)}>Skip</Btn>
            </div>
            <p className="text-[11px] text-mute">
              The first sweep pulls every enabled source, scores what came back, and clusters it, so
              the Topics tab opens with real cards. It takes about a minute.
            </p>
          </>
        )}

        {/* ── stage: done ─────────────────────────────────────────────── */}
        {stage === 'done' && (
          <>
            <section className="panel rounded-sm p-4 space-y-2">
              <Label>Set up</Label>
              <ul className="text-[13px] text-ink space-y-1">
                <li>
                  {applied?.sources ?? 0} source{applied?.sources === 1 ? '' : 's'} added
                  {applied?.kept ? ` (${applied.kept} were already watched)` : ''}
                </li>
                <li>{applied?.listeners ?? 0} name{applied?.listeners === 1 ? '' : 's'} being listened for</li>
                <li>{applied?.watch ? 'Your priorities written into heartbeat-priorities' : 'No priorities written'}</li>
              </ul>
            </section>

            {busy === 'ingest' && (
              <p className="text-[13px] text-mute flex items-center gap-2">
                <Refresh size={13} /> Pulling your sources for the first time…
              </p>
            )}

            {ingest && (
              <section className="panel rounded-sm p-4 space-y-3">
                <Label>First sweep</Label>
                {ingest.ok ? (
                  <p className="text-[13px] text-ink">
                    <span className="mono tabular-nums text-emerald-700">{ingest.inserted}</span> new items pulled,{' '}
                    <span className="mono tabular-nums text-emerald-700">{ingest.scored}</span> scored.
                    {ingest.topics?.length ? ' Waiting for you on Topics:' : ''}
                  </p>
                ) : (
                  <p className="text-[13px] text-rose-600">The sweep did not finish: {ingest.error}. Your sources are saved — run it again from Topics.</p>
                )}
                {Boolean(ingest.topics?.length) && (
                  <ul className="space-y-1">
                    {ingest.topics.slice(0, 5).map((t) => (
                      <li key={t.id} className="text-[13px] text-ink truncate">· {t.title}</li>
                    ))}
                  </ul>
                )}
                {!ingest.topics?.length && ingest.ok && (
                  <p className="text-[12px] text-mute">
                    Nothing has cleared the score gates yet — that is normal on one pull. The hourly
                    sweep keeps going; check Topics later today, or lower the gates on Approved Sources.
                  </p>
                )}
              </section>
            )}

            <div className="flex items-center gap-2">
              <Btn tone="ink" onClick={() => onClose(true)} disabled={busy === 'ingest'}>Open Topics</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
