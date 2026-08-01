// Just-in-time module prerequisites — the page's half of the gate.
//
// Onboarding is short on purpose: the account, a model key, and out. Everything
// a module needs of its own — the operator's voice for a writer, a connected
// service for a sender — is asked for HERE, the first time that module is
// opened, and never as one long wizard up front.
//
// The worker owns the answer (`GET /api/modules/:slug/status`, read through
// `modulePrereqs.one`). This hook adds the two rules that make it safe to mount
// in a product page:
//
//   1. A read that fails IS NOT a prerequisite failure. A 404 (a worker built
//      before these routes existed), a network blip, or a body that doesn't
//      parse all resolve to `null` — "unknown" — and an unknown status leaves
//      the page exactly as it was: no gate, no banner, nothing disabled.
//   2. Skipping is per session, not forever. The gate always offers a way past
//      itself; the page then renders DEGRADED and says plainly what it cannot
//      do, rather than pretending or failing at the moment of use.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { modulePrereqs, type ModulePrereq, type ModuleStatus } from './api';
import { navigateTo } from './chat';

export type { ModulePrereq, ModuleStatus };

const SKIP_PREFIX = 'nyyon.module-gate.skipped.v1:';

function readSkip(slug: string): boolean {
  try { return sessionStorage.getItem(SKIP_PREFIX + slug) === '1'; } catch { return false; }
}
function writeSkip(slug: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(SKIP_PREFIX + slug, '1');
    else sessionStorage.removeItem(SKIP_PREFIX + slug);
  } catch { /* private mode — the flag just doesn't persist */ }
}

/**
 * `null` = unknown, never "not ready". A 401 has already told the shell to show
 * the sign-in screen (the shared reader raises it), and every other failure is
 * a fact about this build or this network, not about the operator's setup.
 */
export async function readModuleStatus(slug: string): Promise<ModuleStatus | null> {
  try {
    const s = await modulePrereqs.one(slug);
    if (!s || typeof s !== 'object') return null;
    // Defensive: a half-built route can answer without the lists.
    return {
      ...s,
      missing: Array.isArray(s.missing) ? s.missing : [],
      optional: Array.isArray(s.optional) ? s.optional : [],
      ready: typeof s.ready === 'boolean' ? s.ready : !(s.missing || []).length,
    };
  } catch {
    return null;
  }
}

export type ModulePrereqs = {
  /** loading = hold the body (avoids painting a page that is about to be gated). */
  phase: 'loading' | 'gate' | 'body';
  status: ModuleStatus | null;
  /** everything unmet — blocking and optional together; empty when unknown. */
  unmet: ModulePrereq[];
  /** unmet items that only degrade the module rather than block it. */
  optional: ModulePrereq[];
  /** the operator's own voice docs are still the shipped placeholders. */
  needsVoice: boolean;
  /** this named gateway is on the unmet list (blocking or optional). */
  needsGateway: (gatewaySlug: string) => boolean;
  /** the unmet entry for a gateway, for a precise tooltip. */
  gapFor: (gatewaySlug: string) => ModulePrereq | null;
  /** re-read the status (after connecting something elsewhere). */
  refresh: () => void;
  /** the gate finished its work. */
  done: () => void;
  /** "not now" — render the body degraded for the rest of this session. */
  skip: () => void;
  /** bring the gate back (from the degraded banner). */
  reopen: () => void;
  /**
   * The action behind every "set it up" affordance on a degraded page.
   *
   * The gate only ever asks for what a module REQUIRES, so a page degraded by
   * an optional gap (Prospecting's enrichers, a second voice document) would
   * get a button that opens nothing. This sends those to where the fix really
   * lives instead — a gateway is connected in Settings, a voice document is
   * written in Knowledge. Never a button that does nothing.
   */
  openSetup: () => void;
};

export function useModulePrereqs(slug: string): ModulePrereqs {
  const [status, setStatus] = useState<ModuleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [skipped, setSkipped] = useState(() => readSkip(slug));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    readModuleStatus(slug).then((s) => {
      if (!alive) return;
      setStatus(s);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [slug, tick]);

  const refresh = useCallback(() => setTick((v) => v + 1), []);
  const skip = useCallback(() => { writeSkip(slug, true); setSkipped(true); }, [slug]);
  const done = useCallback(() => { writeSkip(slug, false); setSkipped(false); setTick((v) => v + 1); }, [slug]);
  const reopen = done;

  const unmet = useMemo(
    () => (status ? [...status.missing, ...status.optional] : []),
    [status],
  );

  const needsGateway = useCallback(
    (gw: string) => unmet.some((p) => p.kind === 'gateway' && p.slug === gw),
    [unmet],
  );
  const gapFor = useCallback(
    (gw: string) => unmet.find((p) => p.kind === 'gateway' && p.slug === gw) || null,
    [unmet],
  );

  const openSetup = useCallback(() => {
    // Something is REQUIRED and unmet — the gate has a form for it.
    if (status && !status.ready) { done(); return; }
    navigateTo(unmet.some((p) => p.kind === 'gateway') ? 'settings' : 'knowledge');
  }, [status, unmet, done]);

  const phase: ModulePrereqs['phase'] =
    loading ? 'loading' : status && !status.ready && !skipped ? 'gate' : 'body';

  return {
    phase,
    status,
    unmet,
    optional: status?.optional ?? [],
    needsVoice: unmet.some((p) => p.kind === 'voice'),
    needsGateway,
    gapFor,
    refresh,
    done,
    skip,
    reopen,
    openSetup,
  };
}
