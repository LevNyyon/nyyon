// The gateway panel of the setup interview, and the last step of setup.
//
// One rule governs this whole surface: EVERY connection is optional. The
// command center is fully usable with none of them, and the panel says so at
// the top rather than implying a checklist the operator has to clear before
// they are allowed in. A first-run screen that looks like a gate is how an
// install dies in the first five minutes.
//
// It also degrades to nothing: on a build whose worker has no
// /api/onboarding/gateways route (404) the panel says the services can be
// connected later from Settings and gets out of the way. The interview is the
// product here; the gateways are a bonus.

import { useCallback, useEffect, useState } from 'react';
import { onboarding, OnboardingUnavailable, type OnboardingGateway } from '../lib/api';
// The field itself is shared with the prerequisite gate a module raises when it
// needs a service (components/ModuleSetupGate.tsx). Same rules about secrets
// and empty boxes, decided once — see GatewayFields.tsx.
import { GatewayFieldInput, gatewayConfigFrom, gatewayMissingRequired } from './GatewayFields';
import { Check, X } from './Icons';

type Draft = Record<string, string>;

export function OnboardingGateways({ onClose, asStep = false, onSkip }: {
  onClose: () => void;
  /** true = this IS the current step of setup, not a detour from the chat */
  asStep?: boolean;
  onSkip?: () => void;
}) {
  const [gateways, setGateways] = useState<OnboardingGateway[] | null>(null);
  const [loading, setLoading]   = useState(true);
  // Why there is no list: the route isn't there, the worker is down, or this
  // browser has no setup access. Null while everything is fine.
  const [absent, setAbsent]     = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [drafts, setDrafts]     = useState<Record<string, Draft>>({});
  const [saving, setSaving]     = useState<string | null>(null);
  const [errors, setErrors]     = useState<Record<string, string>>({});
  const [saved, setSaved]       = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await onboarding.gateways();
      setGateways(list);
      setAbsent(null);
    } catch (e) {
      setGateways(null);
      const status = e instanceof OnboardingUnavailable ? e.status : -1;
      setAbsent(
        status === 403
          ? 'This browser is not authorized to run setup, so connections cannot be changed from here.'
          : 'No connections offered during setup on this build. You can connect services later from Settings.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function setField(slug: string, key: string, value: string) {
    setDrafts((d) => ({ ...d, [slug]: { ...(d[slug] || {}), [key]: value } }));
  }

  async function connect(g: OnboardingGateway) {
    const config = gatewayConfigFrom(g.fields || [], drafts[g.slug] || {});
    setSaving(g.slug);
    setErrors((e) => ({ ...e, [g.slug]: '' }));
    try {
      const r = await onboarding.connectGateway(g.slug, config);
      if (r?.ok === false) throw new OnboardingUnavailable(200, r.error || 'the server refused those values');
      // Reflect it locally AND re-read, so `configured` is the server's word,
      // not ours — a gateway that stores but fails to validate should not
      // show a green tick.
      setSaved((s) => ({ ...s, [g.slug]: true }));
      setOpenSlug(null);
      setDrafts((d) => ({ ...d, [g.slug]: {} }));
      void load();
    } catch (e) {
      setErrors((er) => ({ ...er, [g.slug]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(null);
    }
  }

  return (
    // Takes over the conversation area of the setup card rather than sitting
    // beside it: the card is one column at every width, and connecting a
    // service is a short detour, not a second workspace.
    <aside className="absolute inset-0 z-10 bg-card flex flex-col">
      <div className="h-12 shrink-0 px-4 border-b border-line panel flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">
          {asStep ? 'Connect your services' : 'Connections'}
        </span>
        {!asStep && (
          <button
            onClick={onClose}
            title="Close connections"
            aria-label="Close connections"
            className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        <p className="text-[13px] leading-relaxed text-mute">
          Every connection here is <span className="text-ink font-medium">optional</span>. The command center works
          fully with none of them connected. Add one only if you want this machine to reach that service, and you can
          do it later from Settings instead.
        </p>

        {loading && <div className="mono text-[11px] uppercase tracking-wider text-mute">loading…</div>}

        {!loading && absent && (
          <div className="rounded-sm hairline bg-card/60 px-3 py-2.5 text-[12px] leading-relaxed text-mute">{absent}</div>
        )}

        {!loading && !absent && gateways && gateways.length === 0 && (
          <div className="rounded-sm hairline bg-card/60 px-3 py-2.5 text-[12px] leading-relaxed text-mute">
            Nothing to connect yet.
          </div>
        )}

        {!loading && !absent && gateways && gateways.length > 0 && (
          <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute pt-1">
            {gateways.length} services · {gateways.filter((g) => g.configured || saved[g.slug]).length} already configured
          </div>
        )}

        {gateways?.map((g) => {
          const fields = g.fields || [];
          const open = openSlug === g.slug;
          const connected = g.configured || saved[g.slug];
          const draft = drafts[g.slug] || {};
          // A required field that already has a value needs no input — an
          // empty box means "leave what is there", not "erase it".
          const missingRequired = gatewayMissingRequired(fields, draft);
          return (
            <div key={g.slug} className="rounded-sm hairline bg-card/60">
              <div className="px-3 py-2.5 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink truncate">{g.service || g.slug}</span>
                    {connected && (
                      <span className="mono inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.14em] text-emerald-600 shrink-0">
                        <Check size={11} /> connected
                      </span>
                    )}
                  </div>
                  <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute mt-0.5">
                    {g.slug}
                    {/* Where the value came from. "env" means the install
                        already had it — nothing to type. */}
                    {g.source && g.source !== 'none' && <span className="ml-1.5 text-mute/70">via {g.source}</span>}
                  </div>
                  {g.description && (
                    <p dir="auto" className="text-[12px] leading-relaxed text-mute mt-1.5">{g.description}</p>
                  )}
                </div>
                <button
                  onClick={() => setOpenSlug(open ? null : g.slug)}
                  className="mono text-[10px] uppercase tracking-wider px-2 h-6 rounded-sm hairline bg-card/60 text-mute hover:text-ink transition shrink-0"
                >
                  {open ? 'cancel' : connected ? 'update' : 'connect'}
                </button>
              </div>

              {open && (
                <form
                  onSubmit={(e) => { e.preventDefault(); void connect(g); }}
                  className="px-3 pb-3 pt-0 space-y-2 border-t border-line"
                >
                  {fields.length === 0 && (
                    <p className="text-[12px] text-mute pt-2">Nothing to fill in. Connecting just switches it on.</p>
                  )}
                  {/* Secrets are write-only and an empty box means "unchanged":
                      those rules live in GatewayFields, shared with the gate. */}
                  {fields.map((f) => (
                    <GatewayFieldInput
                      key={f.key}
                      field={f}
                      value={draft[f.key] ?? ''}
                      onChange={(v) => setField(g.slug, f.key, v)}
                    />
                  ))}
                  {errors[g.slug] && <div className="text-[12px] text-rose-600 pt-1">{errors[g.slug]}</div>}
                  <button
                    type="submit"
                    disabled={saving === g.slug || missingRequired}
                    className="mono w-full h-8 rounded-sm bg-ink text-paper text-[10px] uppercase tracking-[0.14em] disabled:opacity-40 transition"
                  >
                    {saving === g.slug ? 'saving…' : 'save connection'}
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      {/* As a STEP the screen owns the way forward: every connection here is
          optional, so "skip" must be as easy to reach as "done" — an operator
          with no services yet should not feel they are failing setup. */}
      {asStep && (
        <div className="shrink-0 border-t border-line px-4 py-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="mono flex-1 h-9 rounded-sm bg-emerald-500 text-white text-[11px] uppercase tracking-[0.14em] transition"
          >
            Done, continue
          </button>
          <button
            type="button"
            onClick={onSkip || onClose}
            className="mono h-9 px-3 rounded-sm hairline bg-card/60 text-[10px] uppercase tracking-wider text-mute hover:text-ink transition"
          >
            Skip for now
          </button>
        </div>
      )}
    </aside>
  );
}
