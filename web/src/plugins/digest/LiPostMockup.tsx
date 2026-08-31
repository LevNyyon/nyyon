import { useState } from 'react';

// The post as LinkedIn shows it: author line, body with see-more, engagement
// bar. Shared by LI Outreach (Signals) and the Digest drawer. Every value is
// captured data — a missing field renders as absent, never as a zero.

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 2592000) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / 2592000) + 'mo';
}

// Initials stand in for the profile photo — we never fetched one, and a stock
// avatar would dress up data we do not have.
function initials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')) || '·';
}

// The post as LinkedIn shows it: author line, body, engagement bar. Every value
// is captured data — a missing field renders as absent, never as a zero.
export type LiPostMockupProps = {
  name: string; role?: string | null; company?: string | null; detail: unknown;
  // when provided, the bar's thumbs-up becomes the LIVE like control
  // No like button: LinkedIn's write endpoints reject reactions (400), so the
  // post is read-only. Engagement is recorded by the card's ✓ instead.
};
export function LiPostMockup({ name, role, company, detail }: LiPostMockupProps) {
  const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
  const text = String(d.text ?? d.excerpt ?? d.snippet ?? '').trim();
  const urn = typeof d.urn === 'string' ? d.urn : null;
  const postedAt = typeof d.posted_at === 'number' ? d.posted_at : null;
  const reactions = typeof d.reactions === 'number' ? d.reactions : null;
  const comments = typeof d.comments === 'number' ? d.comments : null;
  const isRepost = d.is_repost === true || d.is_repost === 1;
  // LinkedIn's canonical permalink for an activity urn.
  const permalink = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;

  const [open, setOpen] = useState(false);
  const LIMIT = 400;
  const long = text.length > LIMIT;
  const shown = long && !open ? text.slice(0, LIMIT).replace(/\s+\S*$/, '') : text;
  const subtitle = [role, company].filter(Boolean).join(' · ');

  return (
    <div className="hairline rounded-md bg-paper overflow-hidden">
      <div className="p-3 space-y-2.5">
        <div className="flex items-start gap-2.5 min-w-0">
          <span aria-hidden
            className="shrink-0 h-9 w-9 rounded-full bg-ink/10 text-ink grid place-items-center mono text-[11px] tracking-wide">
            {initials(name)}
          </span>
          <div className="min-w-0 flex-1">
            <div dir="auto" className="text-[13px] font-semibold text-ink leading-tight truncate">{name}</div>
            {subtitle && <div dir="auto" className="text-[11px] text-mute leading-tight truncate">{subtitle}</div>}
            <div className="text-[10px] text-mute leading-tight mt-0.5 flex items-center gap-1">
              {postedAt ? <span>{timeAgo(postedAt)}</span> : <span className="italic">date not captured</span>}
              <span aria-hidden>·</span>
              <span aria-hidden title="public post">🌐</span>
              {isRepost && (
                <span className="mono text-[9px] uppercase tracking-[0.14em] px-1 py-0.5 rounded-sm hairline text-mute ml-1">
                  repost
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Posts mix Hebrew and English, often line by line. `plaintext` gives
            EACH paragraph its own direction from its first strong character, so
            a Hebrew line reads right-to-left with its punctuation in place
            while an English line beside it stays LTR. */}
        {text ? (
          <div dir="auto" style={{ unicodeBidi: 'plaintext', textAlign: 'start' }}
            className="text-[13px] leading-[1.55] text-ink whitespace-pre-wrap break-words">
            {shown}
            {long && !open && <span className="text-mute">… </span>}
            {long && (
              <button type="button" onClick={() => setOpen((o) => !o)}
                className="text-mute hover:text-ink mono text-[10px] uppercase tracking-[0.14em] ml-0.5">
                {open ? 'see less' : 'see more'}
              </button>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-mute italic">No text captured for this post.</div>
        )}
      </div>

      <div className="border-t border-line px-3 py-2 flex items-center gap-3 text-[11px] text-mute"
        title="LinkedIn's own counts, as they stood when we captured the post">
        {reactions != null && <span>👍 {reactions.toLocaleString()}</span>}
        {comments != null && <span>💬 {comments.toLocaleString()}</span>}
        {reactions == null && comments == null && <span className="italic">engagement not captured</span>}
        {permalink && (
          <a href={permalink} target="_blank" rel="noreferrer"
            className="ml-auto mono text-[10px] uppercase tracking-[0.14em] text-sky-500 hover:underline shrink-0">
            view on linkedin ↗
          </a>
        )}
      </div>
    </div>
  );
}

