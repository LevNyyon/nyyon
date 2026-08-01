// The honest degraded state.
//
// A module whose prerequisites are unmet still opens — the operator skipped the
// setup gate deliberately, and everything that does not need the missing piece
// keeps working. What is NOT allowed is pretending: the page says, in one line,
// exactly which capability is off and why, and offers the way to turn it on.
//
// Used by the five product pages. The `items` come straight from the worker's
// `/api/modules/:slug/status` (label + why are its words, not ours), so this
// component never invents a reason.

import type { ModulePrereq } from '../lib/module-status';

export function DegradedNotice({
  note,
  items = [],
  onSetUp,
  actionLabel = 'set it up',
  className = '',
}: {
  /** One sentence: what still works, and what is off. */
  note: React.ReactNode;
  /** The unmet prerequisites behind it, as the worker described them. */
  items?: ModulePrereq[];
  /** Bring the setup gate back. Omit to render the note alone. */
  onSetUp?: () => void;
  actionLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={
        'rounded-sm border border-amber-400/50 bg-amber-50/70 dark:bg-amber-500/10 ' +
        'px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200 ' +
        'flex items-start gap-x-3 gap-y-1.5 flex-wrap ' + className
      }
    >
      <span className="mono text-[9px] uppercase tracking-[0.18em] opacity-70 shrink-0 mt-[3px]">
        limited
      </span>
      <span className="flex-1 min-w-[12rem] leading-relaxed">{note}</span>
      {items.length > 0 && (
        <span className="flex items-center gap-1.5 flex-wrap">
          {items.map((p, i) => (
            <span
              key={(p.slug || p.label) + i}
              title={[p.why, p.degraded].filter(Boolean).join(' ') || undefined}
              className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-amber-400/50 cursor-help"
            >
              {p.label}
            </span>
          ))}
        </span>
      )}
      {onSetUp && (
        <button
          type="button"
          onClick={onSetUp}
          className="shrink-0 h-6 px-2 rounded-sm border border-amber-500/60 mono text-[10px] uppercase tracking-[0.15em] hover:bg-amber-200/60 dark:hover:bg-amber-500/20 transition"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// Held while the module's status read is in flight. Deliberately quiet: it
// exists so a page cannot paint itself and then be yanked away by a gate a
// moment later.
export function ModuleStatusHold() {
  return (
    <div className="flex-1 min-h-0 grid place-items-center">
      <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute/60">checking setup…</span>
    </div>
  );
}
