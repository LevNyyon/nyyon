// Expand Build — the handoff surface between this running command center and a
// coding agent (Claude Code, Codex) working on it locally.
//
// It answers one question the installed app otherwise hides: where does my code
// actually live? The checkout IS the install — the packaged desktop app sits
// inside the repo at desktop/out/ and locates the source by walking up from its
// own binary, so there is no separate installed copy and no build output to
// sync. The path shown here is baked in by vite.config.ts at build time rather
// than guessed, because a plausible-but-wrong path would send an agent off to
// edit some other checkout.
//
// The prompt body is the `expand-build-prompt` knowledge note, not a literal in
// this file: it is a prompt, and prompts are knowledge. As an operator's build
// diverges from the shipped one, editing that note keeps the briefing true to
// THEIR codebase. `{{REPO}}` is substituted here, at render time.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const PROMPT_SLUG = 'expand-build-prompt';
const REPO = __NYYON_REPO_ROOT__;

// Clipboard is unavailable on insecure non-loopback origins, and the desktop
// shell can be opened over a LAN address. Fall back to a hidden textarea so the
// copy button is never a dead control.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}
      className="mono text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-sm hairline bg-card hover:bg-paper transition-colors shrink-0"
    >
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

function Row({ path, what }: { path: string; what: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-line/50 last:border-0">
      <code className="mono text-[11px] text-ink shrink-0 w-44">{path}</code>
      <span className="text-[12px] text-mute">{what}</span>
    </div>
  );
}

const LAYOUT: { path: string; what: string }[] = [
  { path: 'workers/api/',  what: 'The Cloudflare Worker. Gateways, tools, workflows, routes — the whole backend.' },
  { path: 'web/',          what: 'The React SPA you are looking at right now. One file per module under src/pages/.' },
  { path: 'db/',           what: 'schema.sql plus numbered migrations. A schema change is a new file here.' },
  { path: 'scripts/',      what: 'setup, dev server, and the knowledge + workflow seeds.' },
  { path: 'desktop/',      what: 'The app shell that starts the worker and the SPA. The packaged app lands in desktop/out/.' },
];

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: `cd ${REPO} && claude --model claude-fable-5`, what: 'Open a coding agent in the repo on Claude Fable 5 (the build model this prompt assumes), then paste the prompt below.' },
  { cmd: 'npm start',            what: 'Run it: worker on :8799, interface on :5180.' },
  { cmd: 'npm run package',      what: 'Rebuild the desktop app after your changes.' },
];

export function ExpandBuild() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.readKnowledge(PROMPT_SLUG)
      .then((doc) => setPrompt(doc.body.replaceAll('{{REPO}}', REPO)))
      .catch(() => setErr('Could not load the handoff prompt. It lives in Knowledge as “expand-build-prompt”.'));
  }, []);

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center gap-4 bg-card/60 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Expand build</h1>
        <div className="mono text-[10px] uppercase tracking-wider text-mute">keep building with a coding agent</div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <div className="max-w-3xl flex flex-col gap-5">

          {/* ── where the code lives ─────────────────────────────────── */}
          <section className="hairline rounded-sm bg-card/80 p-4">
            <h2 className="text-[13px] font-semibold mb-1">Your code lives here</h2>
            <p className="text-[12px] text-mute mb-3">
              This command center is not a black box. Everything it does is source you own, in one folder.
            </p>
            <div className="flex items-center gap-2 mb-3">
              <code className="mono text-[12px] flex-1 min-w-0 px-3 py-2 rounded-sm bg-paper hairline break-all">{REPO}</code>
              <CopyButton text={REPO} label="Copy path" />
            </div>
            <div className="mt-3">
              {LAYOUT.map((r) => <Row key={r.path} {...r} />)}
            </div>
            <p className="text-[12px] text-mute mt-3 pt-3 border-t border-line/50">
              There is no second, installed copy. The app you launch runs this folder directly, which is
              why edits show up as soon as you restart it. It also means the app has to stay inside the
              folder: move it out on its own and it can no longer find the code.
            </p>
          </section>

          {/* ── the prompt ───────────────────────────────────────────── */}
          <section className="hairline rounded-sm bg-card/80 p-4">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-[13px] font-semibold">Hand this to your coding agent</h2>
              {prompt && <CopyButton text={prompt} label="Copy prompt" />}
            </div>
            <p className="text-[12px] text-mute mb-3">
              Open Claude Code or Codex in the folder above and paste this first. It briefs the agent on
              the layout, the architecture it has to respect, and how to run what it changes. Add what you
              want at the end.
            </p>
            {err && <div className="text-[12px] text-red-600">{err}</div>}
            {!prompt && !err && <div className="text-[12px] text-mute">Loading…</div>}
            {prompt && (
              <pre className="mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words px-3 py-3 rounded-sm bg-paper hairline max-h-[26rem] overflow-y-auto">
                {prompt}
              </pre>
            )}
            <p className="text-[12px] text-mute mt-3">
              This text is a knowledge note (<code className="mono text-[11px]">expand-build-prompt</code>). As your
              build drifts from the one that shipped, edit it there so the briefing stays true.
            </p>
          </section>

          {/* ── commands ─────────────────────────────────────────────── */}
          <section className="hairline rounded-sm bg-card/80 p-4">
            <h2 className="text-[13px] font-semibold mb-3">The three commands you need</h2>
            <div className="flex flex-col gap-2">
              {COMMANDS.map((c) => (
                <div key={c.cmd}>
                  <div className="flex items-center gap-2">
                    <code className="mono text-[11px] flex-1 min-w-0 px-3 py-1.5 rounded-sm bg-paper hairline break-all">{c.cmd}</code>
                    <CopyButton text={c.cmd} />
                  </div>
                  <div className="text-[12px] text-mute mt-1 ml-0.5">{c.what}</div>
                </div>
              ))}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
