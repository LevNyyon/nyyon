import { useCallback, useEffect, useState } from 'react';
import { SignIn } from './components/SignIn';
import { Onboarding } from './components/Onboarding';
import { OnboardingKey } from './components/OnboardingKey';
import { OnboardingAccount } from './components/OnboardingAccount';
import { SetupResumeBanner } from './components/SetupResumeBanner';
import { OPEN_INTERVIEW_EVENT, announcePrereqsChanged } from './components/ModuleSetupGate';
import { AUTH_EVENT, onboarding } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ChatDrawer } from './components/ChatDrawer';
import { Knowledge }       from './pages/Knowledge';
import { Registry }        from './pages/Registry';
import { ExpandBuild }     from './pages/ExpandBuild';
import { Activity }        from './pages/Activity';
import { Settings }        from './pages/Settings';
import { Prospecting } from './pages/Prospecting';
import { Outreach } from './pages/Outreach';
import { Blog } from './pages/Blog';
import { Social } from './pages/Social';
import { HotTakes } from './pages/HotTakes';
import { Nyo } from './pages/Nyo';
import { DailyPlanner } from './pages/DailyPlanner';
import { MessageSquare, Menu } from './components/Icons';
import { applyTheme, loadTheme, watchSystemTheme } from './lib/theme';
import { ChatProvider, useChatState } from './lib/chat';

// Every routable surface: the seven product modules (mirrored by
// lib/theme.ts SurfaceSlug, which drives the sidebar) plus the five pinned
// system pages from components/Sidebar.tsx. Kept as a value, not just a union,
// so a stale persisted nav can be rejected at runtime — an operator whose last
// session ended on a since-removed surface would otherwise land on a blank page.
const NAVS = [
  'nyo', 'daily-planner', 'prospecting', 'outreach', 'blog', 'social', 'hot-takes',
  'knowledge', 'registry', 'activity', 'expand-build', 'settings',
] as const;
export type Nav = typeof NAVS[number];

const NAV_KEY       = 'nyyon.nav.v1';
const CHAT_OPEN_KEY = 'nyyon.chat.open.v1';

// Section title for the mobile top bar (desktop shows the sidebar rail instead).
const NAV_TITLES: Partial<Record<Nav, string>> = { nyo: 'Nyo', 'daily-planner': 'Daily Planner', 'hot-takes': 'Hot Takes', 'expand-build': 'Expand build' };
const navTitle = (n: Nav) => NAV_TITLES[n] ?? n.charAt(0).toUpperCase() + n.slice(1);

// What the app opens into. Setup is a SEQUENCE, the server names the point in
// it, and the sequence is now TWO steps long:
//   checking   — asking the worker how far this install has been claimed
//   account    — nobody owns this install yet: the credential form (step 1)
//   llm-key    — owned, signed in, no model key yet (step 2)
//   app        — normal: the shell, or the sign-in screen on a 401
//
// The voice interview used to be step three, and boot used to land on it. It
// no longer does. Nothing about the interview changed — same engine, same
// playbook, same server — but it is now a PREREQUISITE rather than a stage:
// Hot Takes asks for the voice documents when you open Hot Takes, Outreach asks
// for WhatsApp when you open Outreach (components/ModuleSetupGate.tsx). Asking
// for fifteen minutes of someone's writing before they have seen the product is
// asking them to describe a voice for a machine they have not met.
//
// It is still reachable from here, as an OVERLAY over the app: the resume
// banner opens it, and so does any module gate that needs the documents. The
// shell owns that overlay because the conversation belongs over the whole app,
// not inside one page's scroll area.
//
// `account` stays first because it is the only step that has to happen outside
// the app: it creates the login. Everything after it runs signed in.
type Boot = 'checking' | 'account' | 'llm-key' | 'app';

export default function App() {
  // Auth gate: any 401 from the API layer flips this on. Rendering the sign-in
  // screen INSTEAD of the shell (rather than over it) keeps every page from
  // firing doomed requests behind a modal.
  const [needsAuth, setNeedsAuth] = useState(false);

  // First-run gate, checked BEFORE the auth gate gets to decide anything. On a
  // fresh install there is no admin to sign in as, so a login box is a dead
  // end; the account form is what creates it. Anything other than an explicit
  // `needed: true` — a 404 from a worker without the route, an offline dev
  // server, a malformed answer — falls through to the ordinary behaviour.
  // Setup is the exception, never the default.
  const [boot, setBoot] = useState<Boot>('checking');
  const [editAccount, setEditAccount] = useState(false);
  const [bootStep, setBootStep] = useState<string | null>(null);
  // They postponed the interview and are running on the shipped default voice
  // documents. Not an error state and not a nag — it is what the banner offers
  // to fix, and only the server's word decides it. Deliberately NOT raised for
  // an operator who simply has not done the interview yet: they were never
  // walked into it, so there is nothing they postponed, and the module gates
  // are where they meet it.
  const [setupDeferred, setSetupDeferred] = useState(false);
  // The interview, over the app. Opened by the resume banner and by any module
  // gate that needs the voice documents; never by boot.
  const [interviewOpen, setInterviewOpen] = useState(false);

  // Re-asked after every step, rather than each screen guessing what comes
  // next: the worker owns the sequence, so a step that turns out to be
  // unnecessary (a model key already in the install's env, say) is skipped
  // because the server never asks for it, not because the client knows.
  const checkBoot = useCallback(async () => {
    try {
      const s = await onboarding.state();
      setBootStep(s?.step ?? null);
      setSetupDeferred(s?.setup_deferred === true);
      // `needed: false` = finished, or postponed. Either way: the app.
      if (s?.needed !== true)      { setBoot('app'); return; }
      if (s?.has_admin !== true)   { setBoot('account'); return; }
      if (s?.llm_ready === false)  { setBoot('llm-key'); return; }
      // Account and model key are behind them. That is all of setup now — the
      // voice documents are asked for by the modules that read them.
      setBoot('app');
    } catch {
      setBoot('app');
    }
  }, []);

  useEffect(() => { void checkBoot(); }, [checkBoot]);

  // A module gate (or anything else) asking for the interview. One listener, so
  // the conversation has exactly one place it can be opened from and exactly
  // one place it can be closed.
  useEffect(() => {
    const h = () => setInterviewOpen(true);
    window.addEventListener(OPEN_INTERVIEW_EVENT, h);
    return () => window.removeEventListener(OPEN_INTERVIEW_EVENT, h);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setNeedsAuth(true);
    window.addEventListener(AUTH_EVENT, onUnauthorized);
    // A cheap probe so an expired session shows the door immediately instead
    // of after the first page happens to fetch. Held until the first-run check
    // has answered: during onboarding there is no session to have, and a 401
    // here would only be noise.
    if (boot === 'app') {
      fetch('/api/system/health').then((r) => { if (r.status === 401) setNeedsAuth(true); }).catch(() => {});
    }
    return () => window.removeEventListener(AUTH_EVENT, onUnauthorized);
  }, [boot]);

  // Where a session opens. The Daily Planner is the default because it is the
  // only surface that is useful on day one with nothing configured: it asks
  // what today is for and answers in the operator's own words. Knowledge — the
  // old default — opens on a tree of rules nobody has read yet, which reads as
  // documentation rather than a product. A returning operator lands wherever
  // they left off.
  const [nav, setNav] = useState<Nav>(() => {
    const saved = localStorage.getItem(NAV_KEY) as Nav | null;
    return saved && NAVS.includes(saved) ? saved : 'daily-planner';
  });
  const [chatOpen, setChatOpen] = useState<boolean>(() => localStorage.getItem(CHAT_OPEN_KEY) === '1');
  // Off-canvas sidebar state (mobile only; desktop keeps the static rail).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const handleNav = (n: Nav) => { setNav(n); setSidebarOpen(false); };

  // Apply persisted theme on mount + react to OS changes when in system mode.
  useEffect(() => {
    applyTheme(loadTheme());
    return watchSystemTheme(() => loadTheme());
  }, []);

  useEffect(() => { localStorage.setItem(NAV_KEY, nav); }, [nav]);
  useEffect(() => {
    localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? '1' : '0');
    // Let pages (e.g. Social) reflow their content out from under the fixed
    // 460px drawer when it opens.
    window.dispatchEvent(new CustomEvent('nyyon:chat-toggled', { detail: chatOpen }));
  }, [chatOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Cross-page nav: other surfaces fire 'nyyon:nav-to' with detail.target to
  // switch nav (e.g. Digest's "Discuss with Nyo" button hops to the Nyo page).
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<{ target?: Nav }>).detail?.target;
      if (target && NAVS.includes(target)) setNav(target);
    };
    window.addEventListener('nyyon:nav-to', handler);
    return () => window.removeEventListener('nyyon:nav-to', handler);
  }, []);

  // Cross-page "open the Nyo drawer" (e.g. Social's "Edit with Nyo" button) —
  // opens the drawer alongside the current page rather than navigating away.
  useEffect(() => {
    const handler = () => setChatOpen(true);
    window.addEventListener('nyyon:open-chat', handler);
    return () => window.removeEventListener('nyyon:open-chat', handler);
  }, []);

  // A page that suppresses the mobile top bar (Daily Planner) still needs a way
  // to reach the off-canvas sidebar, so it asks for it by event.
  useEffect(() => {
    const handler = () => setSidebarOpen(true);
    window.addEventListener('nyyon:open-menu', handler);
    return () => window.removeEventListener('nyyon:open-menu', handler);
  }, []);

  // Hold the shell (and the sign-in screen) for the one round trip that says
  // how far this install has been claimed. Blank rather than a spinner: it is
  // a single local request, and a flashed spinner reads worse than a beat of
  // paper.
  if (boot === 'checking') return <div className="h-full bg-paper" aria-busy="true" />;

  // Step 1. The only screen that runs before there is an account, and the only
  // one nobody can skip: it creates the login and signs them in. Everything
  // after it happens inside their own install.
  if (boot === 'account') return <OnboardingAccount onDone={() => void checkBoot()} />;

  // Step 2, and the last one. Everything this install writes runs on a model,
  // so this is the one connection worth asking for before the operator has
  // seen anything — and it is skippable too ("Later" postpones setup).
  // Step 2. "Back" here re-opens step one in EDIT mode: the account already
  // exists and cannot be un-created, so going back means changing it, which is
  // what somebody who mistyped their username actually wants.
  if (boot === 'llm-key') {
    if (editAccount) {
      return (
        <OnboardingAccount
          mode="edit"
          onDone={() => { setEditAccount(false); void checkBoot(); }}
          onCancel={() => setEditAccount(false)}
        />
      );
    }
    return (
      <OnboardingKey
        // Setup just finished, so send them somewhere worth arriving at
        // EXPLICITLY rather than trusting the remembered nav — a browser that
        // has seen this app before would otherwise reopen whatever page the
        // last session ended on, which for a brand new install is nobody's
        // idea of a first screen.
        onReady={() => { setNav('daily-planner'); void checkBoot(); }}
        onLater={() => { setNav('daily-planner'); void checkBoot(); }}
        onBack={() => setEditAccount(true)}
      />
    );
  }

  // Nothing renders until there is a session — otherwise every page below
  // fires requests that can only come back 401.
  if (needsAuth) return <SignIn />;

  return (
    <ChatProvider>
    <div className="flex h-full">
      <Sidebar active={nav} onNav={handleNav} mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Mobile top bar — hamburger + current section. Hidden on desktop (lg+), where the static rail shows.
            Skipped on the Daily Planner: that page's own header already carries a
            title and its actions, so both bars together burned ~104px of a phone
            screen to say one thing. It renders the hamburger itself and asks for
            the menu via 'nyyon:open-menu' (same event pattern as nav-to / open-chat). */}
        {nav !== 'daily-planner' && (
          <div className="lg:hidden h-12 shrink-0 border-b border-line panel flex items-center gap-1 px-2">
            <button onClick={() => setSidebarOpen(true)} aria-label="Open menu" className="h-10 w-10 grid place-items-center text-ink">
              <Menu size={22} />
            </button>
            <span className="font-semibold tracking-tight text-[15px]">{navTitle(nav)}</span>
          </div>
        )}
        {/* They postponed the interview, so the voice documents are still the
            shipped defaults and everything this app writes will read as
            somebody else. Said once, above the content, dismissible for the
            session — a modal or a repeated toast would punish the choice the
            product deliberately offered them. */}
        {setupDeferred && <SetupResumeBanner onResumed={() => void checkBoot()} />}
        {nav === 'nyo'    && <Nyo />}
        {nav === 'daily-planner' && <DailyPlanner />}
        {nav === 'prospecting' && <Prospecting />}
        {nav === 'outreach'  && <Outreach />}
        {nav === 'blog'      && <Blog />}
        {nav === 'social'    && <Social />}
        {nav === 'hot-takes' && <HotTakes />}
        {nav === 'knowledge' && <Knowledge />}
        {nav === 'registry'  && <Registry />}
        {nav === 'activity'  && <Activity />}
        {nav === 'expand-build' && <ExpandBuild />}
        {nav === 'settings'  && <Settings />}
      </main>

      {/* The setup interview, over the app. SAME component, same engine and
          same playbook as the setup sequence — it is not a second interview,
          it is the one interview, reached from wherever the operator ran into
          the documents it writes. Closing it re-reads setup state (a finish
          drops the resume banner) and tells every mounted gate to look again,
          so the module they came from opens the moment its documents exist. */}
      {interviewOpen && (
        <Onboarding
          initialStep={bootStep}
          onLeave={() => {
            setInterviewOpen(false);
            void checkBoot();
            announcePrereqsChanged();
          }}
        />
      )}

      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />

      {/* Hide the floating launcher when Nyo is the full-page surface — no need to open the drawer too.
          Also hidden on the Daily Planner: that page has its OWN chat (the planner
          thread) with its own trigger, and on mobile the floating button would land
          on top of the plan and compete with it. Two chat entry points on one screen
          reads as one. */}
      {!chatOpen && nav !== 'nyo' && nav !== 'daily-planner' && (
        <FloatingLauncher onOpen={() => setChatOpen(true)} />
      )}
    </div>
    </ChatProvider>
  );
}

// Floating Nyo launcher with unread-badge + streaming pulse. Lives inside the
// ChatProvider so it can read `hasUnseen` + `streaming` from the shared chat
// state. When the user gives Nyo a task and closes the drawer / navigates away,
// the chat() promise keeps running against ChatProvider state; the badge here
// is how Nyo signals "I have an update for you" — clicking opens the drawer
// and Chat.tsx clears the flag on mount.
//
// Desktop only (`hidden lg:grid`): on a phone the bubble sits on top of page
// content, and every surface is already reachable from the off-canvas menu —
// Nyo included, as its own full-page surface. The unread/streaming badge is a
// desktop affordance in consequence; the sidebar carries no chat state, so there
// is no mobile badge to fall back to.
function FloatingLauncher({ onOpen }: { onOpen: () => void }) {
  const { hasUnseen, unseenCount, streaming } = useChatState();
  // Show the count when proactive Nyo messages came in (wake-up briefings,
  // post-publish notifications). Fall back to the plain unread dot if we
  // know SOMETHING happened but lost count (e.g. operator was on a tool
  // result mid-stream when the page reloaded).
  const showCount = unseenCount > 0 && !streaming;
  const showDot   = hasUnseen && !showCount && !streaming;
  const titleText =
    streaming   ? 'Nyo is working… (⌘J)' :
    showCount   ? `Nyo has ${unseenCount} new update${unseenCount === 1 ? '' : 's'} (⌘J)` :
    showDot     ? 'Nyo has an update (⌘J)' :
                  'Open Nyo (⌘J)';
  return (
    <button
      onClick={onOpen}
      title={titleText}
      aria-label={titleText}
      className={
        'fixed bottom-5 right-5 h-12 w-12 rounded-full bg-ink text-paper hidden lg:grid place-items-center shadow-[0_8px_30px_-8px_rgba(10,10,10,0.4)] z-40 hover:scale-105 transition-transform ' +
        (streaming || showCount || showDot ? 'animate-pulse' : '')
      }
    >
      <MessageSquare size={20} />
      {streaming && (
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-paper" aria-hidden />
      )}
      {showCount && (
        <span
          className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 ring-2 ring-paper text-paper mono text-[10px] font-semibold leading-none grid place-items-center"
          aria-hidden
        >
          {unseenCount > 9 ? '9+' : unseenCount}
        </span>
      )}
      {showDot && (
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-paper" aria-hidden />
      )}
    </button>
  );
}
