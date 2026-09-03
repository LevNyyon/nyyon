// Shared article UI — the pieces of the blog experience used by BOTH the Blog
// surface and the Hot Takes Publications tab (one implementation, no forks):
// date/number formatting, tag chips, KV meta rows, sortable column headers, and
// the in-place article editor. Moved from the host's components/ArticleBits.tsx;
// the data calls ride the pack's own invoke pipe (./blog-data).
//
// This build has no image renderer, so there is no cover thumbnail and no
// per-chart control bar. Articles are text.

import { useEffect, useRef, useState } from 'react';
import { api, type BlogPostWithTags } from './blog-data';

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(ts);
}

export function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function TagList({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.length === 0 && <span className="mono text-[10px] text-mute">—</span>}
      {tags.slice(0, 3).map((t) => (
        <span key={t} className="mono text-[9px] uppercase tracking-[0.12em] bg-paper hairline px-1.5 py-0.5 rounded-sm text-mute">{t}</span>
      ))}
      {tags.length > 3 && <span className="mono text-[9px] text-mute">+{tags.length - 3}</span>}
    </>
  );
}

export function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0 min-w-[80px]">{k}</span>
      <span className="mono text-[11px] text-ink">{v}</span>
    </div>
  );
}

export function ColHeader<K extends string>({
  k, label, sortKey, dir, onClick, className,
}: {
  k: K;
  label: string;
  sortKey: K;
  dir: 'asc' | 'desc';
  onClick: (k: K) => void;
  className?: string;
}) {
  const active = k === sortKey;
  return (
    <button
      onClick={() => onClick(k)}
      className={(className || '') + ' text-left flex items-center gap-1 hover:text-ink transition ' + (active ? 'text-ink' : '')}
    >
      <span className={className?.includes('text-right') ? 'ml-auto' : ''}>{label}</span>
      <span className="text-[8px] opacity-70">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </button>
  );
}

// ── Inline article editor ───────────────────────────────────────────
// Renders the draft the way it goes live (tags, H1, excerpt, body) and
// lets you edit in place: click any text and type, Enter makes new paragraphs,
// edits autosave (debounced) preserving the draft's published state. The body is
// ONE contentEditable region set imperatively once, so React never re-renders it
// out from under the caret (that was the "stops after one edit" bug). Media is a
// non-editable island so it can't be mangled.
// fullHeight: fill the parent (the full-screen editor popup) instead of the
// bounded in-page panel the Blog page embeds.
// flow: natural height, no inner scroll — for a popup that scrolls as ONE
// column (article + schedule + social) instead of nesting scroll areas.
export function InlineBodyEditor({ post, fullHeight = false, flow = false }: {
  post: BlogPostWithTags; fullHeight?: boolean; flow?: boolean;
}) {
  // Title/excerpt are UNCONTROLLED (defaultValue + ref). A controlled input would
  // let React overwrite the value on every render, which wipes the browser's
  // native undo stack — so Cmd+Z / Cmd+Shift+Z would break. Uncontrolled keeps
  // native undo/redo working in all three fields (title, excerpt, body).
  const titleRef   = useRef(post.title);
  const excerptRef = useRef(post.excerpt || '');
  const bodyRef    = useRef<HTMLDivElement>(null);
  // Element refs for the H1 + excerpt so both AUTO-GROW to their content — the
  // whole title and standfirst always visible, never an inline scroller.
  const titleEl    = useRef<HTMLTextAreaElement>(null);
  const excerptEl  = useRef<HTMLTextAreaElement>(null);
  // Mirror of the body HTML, kept fresh on every input — the unmount flush
  // saves from THIS, because by the time passive cleanup runs the DOM ref may
  // already be detached.
  const lastHtml   = useRef('');
  const alive      = useRef(true);
  const timer      = useRef<number | null>(null);
  const [status, setStatus]   = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Fill the body ONCE, then never let React touch it again. Mark embedded
  // media as non-editable islands.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = post.body || '';
    el.querySelectorAll('figure, img, script, iframe, table').forEach((n) => n.setAttribute('contenteditable', 'false'));
    lastHtml.current = el.innerHTML;
    const onInput = () => { lastHtml.current = el.innerHTML; schedule(); };
    // Undo/redo inside the body, driven off the browser's own edit history via
    // execCommand (verified to work), so it doesn't depend on the default key
    // routing. preventDefault avoids a double-undo. Cmd/Ctrl+Z = undo,
    // Cmd/Ctrl+Shift+Z or Ctrl+Y = redo. The input event execCommand fires then
    // autosaves the result. Textareas keep their own native undo (uncontrolled).
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); document.execCommand(e.shiftKey ? 'redo' : 'undo'); }
      else if (k === 'y') { e.preventDefault(); document.execCommand('redo'); }
    };
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Auto-size a textarea to its content (title + excerpt use this). Guard the
  // hidden-container case: scrollHeight is 0 while a css-hidden ancestor hides
  // the editor (the popup's page switch), and writing '0px' would squash the
  // field — leave the default height and re-grow on focus instead.
  function grow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    if (h > 0) el.style.height = `${h}px`;
  }
  useEffect(() => { grow(titleEl.current); grow(excerptEl.current); }, []);

  // Flush a pending debounce on unmount — closing the editor inside the save
  // window must not lose the last keystrokes.
  useEffect(() => () => {
    alive.current = false;
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; void save(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function currentBody(): string {
    const tmp = document.createElement('div');
    tmp.innerHTML = bodyRef.current ? bodyRef.current.innerHTML : lastHtml.current;
    tmp.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable')); // drop editing islands
    return tmp.innerHTML;
  }
  async function save() {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (alive.current) setStatus('saving');
    try {
      await api.updateBlogPost(post.slug, {
        title: titleRef.current.trim() || post.title,
        excerpt: excerptRef.current.trim() || null,
        body: currentBody(),
        tags: post.tags,                 // preserve
        published: post.published,       // keep the draft a draft
        published_at: post.published_at, // preserve
      });
      if (alive.current) { setStatus('saved'); setSavedAt(Date.now()); }
    } catch { if (alive.current) setStatus('error'); }
  }
  function schedule() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, 900);
  }

  const statusLabel =
    status === 'saving' ? 'saving…'
    : status === 'error' ? 'save failed — keep editing to retry'
    : savedAt ? `saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'click any text to edit · autosaves';

  const editableField = 'focus:outline-none focus:bg-amber-50 dark:focus:bg-amber-500/10 rounded transition ';

  return (
    <div className={fullHeight ? 'h-full flex flex-col' : ''}>
      <div className={'mb-1.5 mono text-[10px] uppercase tracking-[0.2em] ' + (fullHeight || flow ? 'px-4 sm:px-2 pt-2 shrink-0 ' : '') + (status === 'error' ? 'text-rose-600' : 'text-mute')}>{statusLabel}</div>
      <div className={
        fullHeight ? 'flex-1 min-h-0 bg-paper overflow-y-auto py-6 sm:py-8'
        : flow ? 'bg-paper py-4 sm:py-6'
        : 'hairline rounded-sm bg-paper max-h-[720px] overflow-y-auto py-8'
      }>
        {/* Reads like the live production article: tags, H1, excerpt, body. */}
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          {post.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {post.tags.map((t) => <span key={t} className="mono text-[10px] uppercase tracking-[0.14em] bg-card hairline px-2 py-1 rounded-sm text-mute">{t}</span>)}
            </div>
          )}
          {/* H1 title — editable (uncontrolled, keeps native undo), auto-grows */}
          <textarea
            ref={titleEl}
            defaultValue={post.title}
            onChange={(e) => { titleRef.current = e.target.value; grow(e.currentTarget); schedule(); }}
            onFocus={(e) => grow(e.currentTarget)}
            rows={1}
            spellCheck
            className={'w-full resize-none overflow-hidden bg-transparent text-3xl md:text-4xl font-semibold tracking-tight leading-[1.15] px-1.5 -mx-1.5 ' + editableField}
          />
          {/* excerpt / standfirst — editable (uncontrolled, keeps native undo), auto-grows */}
          <textarea
            ref={excerptEl}
            defaultValue={post.excerpt || ''}
            onChange={(e) => { excerptRef.current = e.target.value; grow(e.currentTarget); schedule(); }}
            onFocus={(e) => grow(e.currentTarget)}
            placeholder="excerpt / standfirst"
            rows={1}
            className={'w-full mt-4 resize-none overflow-hidden bg-transparent text-lg text-mute leading-relaxed px-1.5 -mx-1.5 placeholder:text-mute/50 ' + editableField}
          />
          {/* body — one editable article surface. Enter = new paragraph. Set once,
              never re-rendered by React (keeps the caret; fixes edit-stops-after-one). */}
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck
            className={
              'mt-8 text-[16px] leading-[1.8] text-ink focus:outline-none caret-ink ' +
              '[&_h2]:text-[24px] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mt-8 [&_h2]:mb-2 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-1 [&_p]:mb-4 ' +
              '[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-4 [&_li]:mb-1 [&_a]:underline ' +
              '[&_figure]:my-8 [&_figure]:text-center [&_img]:mx-auto [&_img]:max-w-full [&_img]:rounded-md [&_figcaption]:text-[12px] [&_figcaption]:text-mute [&_figcaption]:mt-2 ' +
              '[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-mute [&_[contenteditable=false]]:cursor-default'
            }
          />
        </div>
      </div>
    </div>
  );
}

