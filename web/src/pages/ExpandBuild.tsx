// Expand build is ONE prompt and nothing else. The operator copies it into a
// coding agent; the prompt itself makes the agent ask what they want, find its
// own bearings in the repo, place the work in the right layer, and prove it
// before claiming it works. No manual steps live here: a step list on a screen
// goes stale, a prompt that teaches the agent to ask does not.
import { useEffect, useState } from 'react';

const PROMPT_SLUG = 'expand-build-prompt';

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function ExpandBuild() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => {
    fetch(`/api/knowledge/${PROMPT_SLUG}`)
      .then((r) => r.json())
      .then((d) => setPrompt(String(d?.doc?.body ?? d?.body ?? '').trim() || null))
      .catch(() => setErr('Could not load the prompt. It lives in Knowledge as "expand-build-prompt".'));
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Expand build</h1>
          <p className="text-[13px] text-mute leading-relaxed">
            Copy this into Claude, or any capable coding agent, in a session that can read this
            install. It will ask what you want and take it from there.
          </p>
        </header>

        {err && <p className="text-[12.5px] text-rose-700 dark:text-rose-400">{err}</p>}

        <div className="flex items-center gap-2">
          <button
            onClick={async () => setState((await copyText(prompt || '')) ? 'ok' : 'fail')}
            disabled={!prompt}
            className="text-[12px] px-3 h-8 rounded-sm bg-ink text-paper disabled:opacity-40"
          >
            {state === 'ok' ? 'copied' : state === 'fail' ? 'copy failed' : 'copy the prompt'}
          </button>
          <a
            href={`/api/knowledge/${PROMPT_SLUG}`}
            onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target: 'knowledge', slug: PROMPT_SLUG } })); }}
            className="text-[12px] text-mute hover:text-ink underline underline-offset-2"
          >
            edit it in Knowledge
          </a>
        </div>

        <pre className="hairline rounded-sm bg-card/50 p-4 text-[11.5px] leading-relaxed whitespace-pre-wrap text-mute">
          {prompt ?? 'Loading…'}
        </pre>
      </div>
    </div>
  );
}
