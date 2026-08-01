/// <reference types="vite/client" />

// Absolute path of the checkout this build came from, baked in by
// vite.config.ts. The Expand Build page shows it as the place to point a
// coding agent at — a guessed path would send the agent somewhere real but
// wrong, so it is resolved at build time rather than assumed.
declare const __NYYON_REPO_ROOT__: string;

// The desktop shell's bridge (desktop/preload.cjs). Present only when the SPA
// is running inside the app — in a plain browser tab there is no shell, so
// every caller has to treat this as optional rather than assume it.
type NyyonServiceState = { installed: boolean; running: boolean; paired?: boolean; heavy?: boolean };
interface Window {
  nyyonDesktop?: {
    isDesktop: true;
    serviceStatus: (name: string) => Promise<NyyonServiceState>;
    installService: (name: string) => Promise<{ ok: boolean; error?: string } & Partial<NyyonServiceState>>;
    onServiceProgress: (cb: (p: { name: string; pct: number; label: string }) => void) => () => void;
  };
}
