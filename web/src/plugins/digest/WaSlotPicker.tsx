// ─── WaSlotPicker: ASAP or a two-slot day strip ───────────────────
// The shared send-time chooser for WhatsApp drafts: an ASAP button plus a
// compact horizontal strip of the next days, each offering the morning and
// evening wall-clock slots from the wa-send-slots knowledge doc (tz-correct
// via epochForWall). Used by the Digest cards and the digest drawer; any
// surface that sends a WA draft can mount it.
import { useEffect, useState } from 'react';
import { api } from './digest-data';
import { epochForWall } from './wa-time';

type Slots = { days_ahead: number; morning: string; evening: string; timezone: string; tz_by_prefix?: Record<string, string>; hold?: boolean };
type Day = { label: string; morning: number | null; evening: number | null };

// The slot clock follows the RECIPIENT: 09:30 for a New York number means
// 09:30 in New York. Longest phone-prefix match against the knowledge doc's
// tz_by_prefix wins; no phone or no match falls back to the doc timezone.
function recipientTz(slots: Slots, phone?: string | null): string {
  const fallback = slots.timezone || 'Asia/Jerusalem';
  const digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (!digits || !slots.tz_by_prefix) return fallback;
  let best = '';
  for (const pre of Object.keys(slots.tz_by_prefix)) {
    if (digits.startsWith(pre) && pre.length > best.length) best = pre;
  }
  return best ? slots.tz_by_prefix[best] : fallback;
}

export function WaSlotPicker({ disabled, busy, phone, onSend, onOpenWa }: {
  disabled?: boolean;
  busy?: boolean;
  phone?: string | null;
  onSend: (sendAt?: number) => void;
  // hold-mode fallback: open the chat manually with the message prefilled
  onOpenWa?: () => void;
}) {
  const [slots, setSlots] = useState<Slots | null>(null);
  useEffect(() => {
    api.digestWaSlots().then(setSlots).catch(() => {});
  }, []);

  // While the account is held, delivery is manual: one wa.me button, no queue.
  if (slots?.hold && onOpenWa) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[9px] uppercase tracking-[0.16em] text-amber-700">sending on hold · manual mode</span>
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenWa}
          className="mono text-[10px] uppercase tracking-[0.18em] bg-emerald-600 text-white rounded-sm px-3 py-1 hover:opacity-90 disabled:opacity-40 transition"
        >
          open in WhatsApp ↗
        </button>
      </div>
    );
  }

  const tzUsed = slots ? recipientTz(slots, phone) : null;
  const days: Day[] = (() => {
    if (!slots) return [];
    const tz = tzUsed || slots.timezone || 'Asia/Jerusalem';
    const parse = (hm: string) => { const [h, m] = hm.split(':').map(Number); return { h: h || 9, m: m || 0 }; };
    const mo = parse(slots.morning), ev = parse(slots.evening);
    const out: Day[] = [];
    for (let i = 0; i < (slots.days_ahead || 7); i++) {
      const d = new Date(Date.now() + i * 86400000);
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-').map(Number);
      const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric' }).format(d);
      const am = epochForWall(tz, p[0], p[1], p[2], mo.h, mo.m);
      const pm = epochForWall(tz, p[0], p[1], p[2], ev.h, ev.m);
      const morning = am > Date.now() ? am : null;
      const evening = pm > Date.now() ? pm : null;
      if (morning || evening) out.push({ label, morning, evening });
    }
    return out;
  })();

  const slotBtn = (at: number | null, label: string | undefined, title: string) => at ? (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => onSend(at)}
      className="mono text-[9px] px-1.5 py-0.5 rounded-sm hairline hover:bg-ink hover:text-paper disabled:opacity-40 transition"
      title={title}
    >
      {label}
    </button>
  ) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => onSend()}
          className="mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-3 py-1 hover:opacity-90 disabled:opacity-40 transition"
        >
          {busy ? '…' : 'ASAP →'}
        </button>
      </div>
      {tzUsed ? (
        <div className="mono text-[8px] uppercase tracking-[0.16em] text-mute">
          {tzUsed.split('/').pop()!.replace(/_/g, ' ')} time
        </div>
      ) : null}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {days.map((d) => (
          <div key={d.label} className="shrink-0 rounded-sm hairline bg-card/40 px-2 py-1.5 text-center">
            <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute mb-1">{d.label}</div>
            <div className="flex gap-1">
              {slotBtn(d.morning, slots?.morning, 'morning')}
              {slotBtn(d.evening, slots?.evening, 'evening')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
