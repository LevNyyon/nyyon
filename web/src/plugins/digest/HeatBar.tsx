// ─── HeatBar: how warm a lead is, as a filling bar ───────────────
// The score comes from the server (lib/lead-heat.js, weights in the
// lead-heat knowledge doc) already banded hot/warm/cold; this only draws
// it. Hovering names the facts that produced the score, so the bar is
// explainable rather than a mystery number.

export function HeatBar({ score, band, factors, size = 'sm', showLabel = false }: {
  score: number;
  band?: 'hot' | 'warm' | 'cold' | string;
  factors?: string[];
  size?: 'sm' | 'md';
  showLabel?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const b = band || (pct >= 60 ? 'hot' : pct >= 30 ? 'warm' : 'cold');
  const fill = b === 'hot' ? 'bg-rose-500' : b === 'warm' ? 'bg-amber-500' : 'bg-stone-400';
  const text = b === 'hot' ? 'text-rose-700' : b === 'warm' ? 'text-amber-700' : 'text-mute';
  const h = size === 'md' ? 'h-1.5' : 'h-1';
  const w = size === 'md' ? 'w-20' : 'w-12';
  const title = [`heat ${pct}/100 · ${b}`, ...(factors || [])].join('\n');

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={title}>
      <span className={`${w} ${h} rounded-full bg-line/70 overflow-hidden inline-block`}>
        <span className={`block h-full rounded-full transition-all ${fill}`} style={{ width: `${pct}%` }} />
      </span>
      {showLabel && <span className={`mono text-[9px] uppercase tracking-[0.14em] ${text}`}>{b}</span>}
    </span>
  );
}
