// Digest plugin — wall-clock helpers for the WA slot picker + card labels.
// Extracted from cmd's components/ScheduleSend.tsx (the full ScheduleSend
// control belongs to the gtm pack; the digest surface only needs the two
// time functions, so they travel as this slim sibling instead).

// what the epoch reads as on a wall clock in tz (browser-local when tz unset)
function wallParts(epoch: number, tz?: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(epoch))) if (x.type !== 'literal') p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute };
}

// epoch for a wall-clock time in tz (fixed-point iteration handles DST edges)
export function epochForWall(tz: string | undefined, y: number, m: number, d: number, hh: number, mm: number): number {
  if (!tz) return new Date(y, m - 1, d, hh, mm).getTime();
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const diff = Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

export const fmtWhen = (epoch: number, tz?: string) =>
  new Date(epoch).toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: tz, timeZoneName: tz ? 'short' : undefined,
  });
