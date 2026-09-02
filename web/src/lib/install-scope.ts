// Local caches belong to ONE install.
//
// The SPA keeps transcripts in localStorage so a reload does not lose the
// conversation. Those caches had no idea which install they came from, so a
// rebuilt (or reset, or reprovisioned) install booted with an empty database
// and the previous install's chat still on screen — the app confidently
// showing history that no longer exists anywhere.
//
// Every install stamps itself once at first boot. When that stamp changes,
// every scoped cache is dropped exactly once.
const STAMP_KEY = 'nyyon.install.v1';
const SCOPED_KEYS = ['nyyon.chat.v1', 'nyyon.planner.v1', 'nyyon.onboarding.v1', 'nyyon.nyo.tier.v1', 'nyyon.nyo.speech.v1'];

export function reconcileInstallScope(installId: string | null | undefined): void {
  if (!installId) return;                       // unknown: never destroy on a guess
  try {
    const seen = localStorage.getItem(STAMP_KEY);
    if (seen === installId) return;
    // No stamp but caches present means they predate this mechanism, so their
    // install is UNKNOWN — and an unknown install is not this one. Dropping
    // them costs one transcript on first upgrade; keeping them is how a fresh
    // install shows somebody else's conversation.
    for (const k of SCOPED_KEYS) localStorage.removeItem(k);
    localStorage.setItem(STAMP_KEY, installId);
  } catch { /* private mode: nothing cached anyway */ }
}
