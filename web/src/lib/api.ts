// Thin REST client + Nyo chat SSE helper.

export type Event = { id: string; kind: string; actor: string; payload: any; created_at: number };

// Nyo conversation history. `messages` on the detail mirrors the Msg shape the
// Chat component renders, so a resumed thread drops straight into state.
export type ConversationSummary = {
  // `turns` counts operator messages, not raw persisted rows (one exchange
  // writes an assistant row per model hop plus a row per tool call).
  id: string; title: string; turns: number; created_at: number; updated_at: number;
};
export type ConversationDetail = {
  id: string; title: string; created_at: number; updated_at: number; truncated?: boolean;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    tool_events?: Array<{ name: string; input?: unknown; result?: unknown; error?: string }>;
    ts?: number;
  }>;
};

export type SystemHealthLevel = 'green' | 'yellow' | 'red' | 'off';
export type SystemHealthCheck = {
  name: string;
  status: SystemHealthLevel;
  severity: 'critical' | 'degraded';
  note: string | null;
};
export type SystemHealth = {
  overall: SystemHealthLevel;
  checks: SystemHealthCheck[];
  ts: number;
};

export type KnowledgeDoc = {
  slug: string; title: string; body: string;
  scope: 'global' | 'module';
  module: string | null;
  // Tree parent. Null for the root doc (`nyyon-root`). Forms the "context
  // route" — walk parents up to root for the breadcrumb chain.
  parent_slug: string | null;
  updated_at: number;
};
// One step in the breadcrumb chain root → … → self. Returned by
// `/api/knowledge/:slug/path`. Used by the Knowledge page header and by
// Nyo when answering "what context do I need to understand X".
export type KnowledgePathStep = { slug: string; title: string };

export type FeatureFlag = {
  key: string;
  value: number;
  scope: 'surface' | 'tool' | 'module';
  description: string | null;
  updated_at: number;
};

// A 401 means the session cookie is missing or expired. Every read in the app
// funnels through here, so this is the one place that can tell the shell to
// show the sign-in screen instead of each page inventing its own error state.
export const AUTH_EVENT = 'nyyon:unauthorized';

async function j<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
    throw new Error('401 unauthorized');
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// Sign in against the worker's gate. The cookie it sets is what every later
// request rides on, so a success here is followed by a reload, not by state
// juggling — the whole shell re-reads with the session in place.
export async function signIn(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/__gate/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json().catch(() => ({}));
  return r.ok && body?.ok ? { ok: true } : { ok: false, error: body?.error || `sign-in failed (${r.status})` };
}

export type NyoModelMap = {
  nyo_low: string; nyo_mid: string; nyo_high: string;
  writer: string; writer_small: string; vision: string;
  writer_fallback: string;
  source?: 'doc' | 'defaults';
};
export type BrainInfo = {
  provider: 'anthropic' | 'openai' | string;
  model: string | null;
  key_set: boolean;
  models: NyoModelMap;
  defaults: Omit<NyoModelMap, 'source'>;
};

// ─── Hot Takes / Blog / Social types removed — the modules ship as the
// editorial plugin; its materialized page surfaces carry their own data
// layer (fetch /api/plugins/editorial/invoke/<tool>).

export const api = {
  health: () => j<{ ok: boolean }>('/health'),

  systemHealth: () => j<SystemHealth>('/api/system/health'),
  brain:  () => j<BrainInfo>('/api/nyo/brain'),
  saveNyoModels: (patch: Partial<NyoModelMap>) =>
    j<{ models: NyoModelMap }>('/api/nyo/models', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.models),

  // Nyo pending-message queue — background workers (AEO cron, image gen, etc)
  // queue assistant turns; Chat polls + injects them.
  listNyoPending: () =>
    j<{ messages: Array<{ id: string; content: string; kind: string | null; ref_kind: string | null; ref_id: string | null; payload: unknown; created_at: number }> }>(
      '/api/nyo/pending',
    ).then((r) => r.messages),
  deliverNyoMessage: (id: string) =>
    j<{ ok: boolean }>(`/api/nyo/pending/${encodeURIComponent(id)}/deliver`, { method: 'POST' }),

  // Conversation history — browse past Nyo threads and reopen one. The server
  // has always persisted every turn; these read it back so a finished thread
  // can be resumed instead of lost when the drawer closes.
  listConversations: (limit = 40) =>
    j<{ conversations: ConversationSummary[]; total: number }>(`/api/chat/conversations?limit=${limit}`),
  readConversation: (id: string) =>
    j<ConversationDetail>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) =>
    j<{ id: string; title: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    j<{ ok: boolean; id: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Proactive wake-up — surveys state, autofires missed AEO publish, queues a
  // morning briefing as a Nyo message. Idempotent server-side (skips when
  // nothing changed since last wake-up).
  systemWakeUp: (autofire = true) =>
    j<{ queued: boolean; message_id?: string; fired?: unknown; summary?: string; reason?: string }>(
      '/api/system/wake-up',
      { method: 'POST', body: JSON.stringify({ autofire }) },
    ),

  events: (limit = 100) =>
    j<{ events: Event[] }>(`/api/events?limit=${limit}`).then((r) => r.events),

  listKnowledge: () => j<{ docs: KnowledgeDoc[] }>('/api/knowledge').then((r) => r.docs),
  readKnowledge: (slug: string) => j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`).then((r) => r.doc),
  readKnowledgePath: (slug: string) =>
    j<{ path: KnowledgePathStep[] }>(`/api/knowledge/${slug}/path`).then((r) => r.path),
  writeKnowledge: (slug: string, patch: Partial<KnowledgeDoc> & { title: string; body: string }) =>
    j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.doc),
  deleteKnowledge: (slug: string) =>
    j<{ ok: boolean }>(`/api/knowledge/${slug}`, { method: 'DELETE' }),

  // wa-gateway connection management (ops Settings → WhatsApp)
  waProbe: () => j<{
    url: string;
    api_key_configured: boolean;
    session_id: string;
    reachable: boolean;
    http: number | null;
    sessions: unknown;
    webhooks: unknown;
    error: string | null;
  }>('/api/wa/probe'),
  waRegisterWebhook: (inbound_url: string, events: string[] = ['message']) =>
    j<{ http: number; ok: boolean; body: string; url: string }>('/api/wa/register-webhook', {
      method: 'POST', body: JSON.stringify({ inbound_url, events }),
    }),
  waTestInbound: (chat_id: string, body_text?: string) =>
    j<{ synthetic_payload: unknown; result: { ok: boolean; accepted?: boolean; reason?: string; chat_id?: string; person_id?: string | null } }>('/api/wa/test-inbound', {
      method: 'POST', body: JSON.stringify({ chat_id, body_text }),
    }),

  // The outbox-audited send (beginSend → gateway → markSent, and the sent
  // message is pre-inserted into wa_messages so the thread reflects it at once).
  waSend: (chatId: string, text: string) =>
    j<{ messageId?: string; timestamp?: number; chatId?: string; outbox_id?: string; error?: string }>(
      '/api/wa/send', { method: 'POST', body: JSON.stringify({ chatId, text }) },
    ),

  listFlags: () => j<{ flags: FeatureFlag[] }>('/api/feature-flags').then((r) => r.flags),
  setFlag:   (key: string, value: boolean) =>
    j<{ ok: boolean }>(`/api/feature-flags/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

};

// ─── Module prerequisites ───────────────────────────────────────────────────
// What a module needs before it is worth opening. Setup stops at the model key,
// so everything else — the voice interview, the service connections — is asked
// for HERE, by the module that needs it, at the moment the operator opens it.
//
// One payload shape for two kinds of prerequisite, because one component
// renders both (components/ModuleSetupGate.tsx):
//
//   voice    knowledge documents that must be the operator's own rather than
//            the placeholders the app shipped. `slugs` names the ones that are
//            still ours. Fixed by Nyo's interview while setup is still open,
//            and by editing the note in Knowledge once it has closed.
//   gateway  an external service that is not configured. `fields` is the
//            connect form, straight from the server's own resolver — a secret
//            field reports only whether it is `set`, never its value.
//   setup    a first run the module owns itself (Hot Takes' source panel).
//            Reported so the gate can mention it; there is no generic fix.
export type ModulePrereqKind = 'voice' | 'gateway' | 'setup';
export type ModulePrereqField = {
  key: string; label?: string; required?: boolean; secret?: boolean;
  help?: string | null; set?: boolean; source?: string;
};
export type ModulePrereq = {
  kind: ModulePrereqKind;
  /** gateway slug, or the module-owned setup key */
  slug?: string;
  /** voice: the documents still carrying the shipped placeholder */
  slugs?: string[];
  label: string;
  /** what this unlocks, in the operator's terms */
  why: string;
  /** what still works without it — the gate never hard-blocks */
  degraded?: string;
  /** how the gate offers to fix it */
  fix?: 'interview' | 'connect' | 'knowledge' | 'module';
  fields?: ModulePrereqField[];
  /** gateway: 'any' = one credential is enough */
  requires?: 'all' | 'any';
  /** voice: the setup interview is still reachable on this install */
  interview_available?: boolean;
  /** voice: the interview is itself a model call */
  llm_ready?: boolean;
};
export type ModuleStatus = {
  module: string;
  label: string;
  /** every REQUIRED prerequisite is satisfied */
  ready: boolean;
  missing: ModulePrereq[];
  optional: ModulePrereq[];
};
export type AllModuleStatus = {
  modules: ModuleStatus[];
  voice: Array<{ slug: string; label: string; exists: boolean; personal: boolean; shipped: boolean }>;
  interview_available: boolean;
  llm_ready: boolean;
  not_ready: string[];
};

export const modulePrereqs = {
  one: (slug: string) => j<ModuleStatus>(`/api/modules/${encodeURIComponent(slug)}/status`),
  all: () => j<AllModuleStatus>('/api/modules/status'),
  // The gate's inline connect form. Deliberately the POST-SETUP twin
  // (/api/gateways, not /api/onboarding/gateways): the onboarding routes stop
  // answering the moment setup completes, and this surface has to keep working
  // for the life of the install.
  connectGateway: (slug: string, config: Record<string, string>) =>
    j<{ slug: string; configured: boolean; missing?: string[]; error?: string }>('/api/gateways', {
      method: 'POST', body: JSON.stringify({ slug, config }),
    }),
  // Every gateway with its live configured/missing state — the same resolver
  // the gateways themselves read through, so Settings never invents its own.
  gatewayStatus: () => j<{ gateways: GatewayStatus[] }>('/api/gateways'),
  // Installed plugins' pages. A surface is data, so it appears the moment the
  // plugin is active — no rebuild, no restart.
  pluginSurfaces: () => j<{ surfaces: PluginSurfaceDef[] }>('/api/plugins/surfaces'),
};

export type { PluginSurfaceDef } from '../components/PluginSurface';
import type { PluginSurfaceDef } from '../components/PluginSurface';

export type GatewayStatus = {
  slug: string;
  configured: boolean;
  source?: 'db' | 'env' | 'none';
  missing?: string[];
  fields?: { key: string; label?: string; required?: boolean; secret?: boolean; help?: string }[];
};

// ─── Setup ──────────────────────────────────────────────────────────────────
// The first-run sequence. Its FIRST step runs before an admin exists, so none
// of it can ride the shared `j()` helper — a 401 there fires AUTH_EVENT and
// drops the operator into the sign-in screen in the middle of setup. These
// calls surface the status instead and let the caller decide what a failure
// means (404 = this build has no setup surface, or setup is already finished).
//
// From step two onward the operator IS signed in and these routes are cookie
// gated like any other, so a 401 here means the session went away, not that
// the build lacks the feature.

// `step` is whatever the server calls the current stage. The client maps it to
// its own progress rail loosely and never invents one when it is absent. The
// rest is what the interview has actually produced so far — the page reports
// those, it does not compute them.
export type OnboardingState = {
  /** Can this install keep data? A container without a mounted disk cannot,
   *  and the boot screen must say so rather than take someone through setup. */
  storage?: {
    persistent: boolean;
    allowed?: boolean;
    why?: string | null;
    host?: string | null;
    /** the host's settings page for this instance, when we can name it */
    settings_url?: string | null;
  };
  /** false = no model key yet, so the interview cannot run at all */
  llm_ready?: boolean;
  /** fingerprint of THIS install's database; local caches are scoped to it */
  install_id?: string | null;
  /** boot should land on the setup surface (not finished, not postponed) */
  needed: boolean;
  /** an account exists: they can sign in, and step one is behind them */
  has_admin: boolean;
  /** the interview finished and the setup surface is closed for good */
  setup_complete?: boolean;
  /** they said "later": in the app, on the shipped default voice docs */
  setup_deferred?: boolean;
  step?: string | null;
  message_count?: number;
  docs_saved?: string[];
  gateways_connected?: string[];
};
export type OnboardingGatewayField = {
  key: string; label?: string; required?: boolean; secret?: boolean;
  help?: string | null;
  // Already has a value on this machine (usually from the install's env). A
  // required field that is `set` needs no input — blank means "leave it".
  set?: boolean;
};
export type OnboardingGateway = {
  slug: string;
  service?: string;
  description?: string;
  configured: boolean;
  source?: string;
  fields?: OnboardingGatewayField[];
};
export type OnboardingMessage = { role: 'user' | 'assistant'; content: string };
// The stored transcript also carries `tool` rows — the beats where the
// interview did something (connected a service, saved a voice doc). They are
// shown, never sent back.
export type OnboardingThreadMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string | null;
  created_at?: number;
};
// `state` is deliberately opaque: the server owns the interview, the client
// only peeks at the few fields it can render honestly.
export type OnboardingTurn = { reply?: string; state?: Record<string, unknown> | null; done?: boolean };

// Setup access. On a machine other than the one the worker runs on, the
// onboarding routes want the token the installer printed. It arrives as
// ?setup_token=… once; we keep it for the session and strip it back out of the
// address bar, because a token in a URL ends up in history and logs.
const SETUP_TOKEN_KEY = 'nyyon.setup-token';
function captureSetupToken(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('setup_token');
    if (!fromUrl) return sessionStorage.getItem(SETUP_TOKEN_KEY) || '';
    sessionStorage.setItem(SETUP_TOKEN_KEY, fromUrl);
    url.searchParams.delete('setup_token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  } catch { return ''; }
}
let SETUP_TOKEN = captureSetupToken();
export function clearSetupToken() {
  SETUP_TOKEN = '';
  try { sessionStorage.removeItem(SETUP_TOKEN_KEY); } catch { /* ignore */ }
}

// status 0 = never reached the server (offline, dev worker down).
export class OnboardingUnavailable extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message || `onboarding unavailable (${status})`);
    this.name = 'OnboardingUnavailable';
    this.status = status;
  }
}

async function ob<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init || {};
  let r: Response;
  try {
    r = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(SETUP_TOKEN ? { 'X-Setup-Token': SETUP_TOKEN } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      ...rest,
    });
  } catch (e) {
    throw new OnboardingUnavailable(0, e instanceof Error ? e.message : 'network error');
  }
  const text = await r.text().catch(() => '');
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { /* html error page from a route that doesn't exist */ } }
  if (!r.ok) throw new OnboardingUnavailable(r.status, body?.error ? String(body.error) : `${r.status} ${r.statusText}`);
  return (body ?? {}) as T;
}

export const onboarding = {
  state: () => ob<OnboardingState>('/api/onboarding/state'),
  // "I know this instance will not keep anything — let me look around." Recorded
  // server-side in the temporary database it concerns, so a restart re-asks.
  allowEphemeral: () => ob<{ ok: boolean; error?: string }>('/api/onboarding/allow-ephemeral', { method: 'POST' }),
  // STEP ONE: the account. A form, no model, no conversation. `signed_in`
  // means the worker already issued the session cookie, so the app carries
  // straight on into step two instead of stopping at a login box for a
  // password chosen ten seconds ago.
  // Going back from a later step. The account cannot be un-created, so "back"
  // rewrites it — the mistyped-username escape hatch.
  updateAccount: (username: string, password: string) =>
    ob<{ ok?: boolean; username?: string; signed_in?: boolean; error?: string }>('/api/onboarding/account/update', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  createAccount: (username: string, password: string) =>
    ob<{ ok?: boolean; username?: string; signed_in?: boolean; error?: string }>('/api/onboarding/account', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  // The interview as the SERVER has it. Read on mount so a refresh (or a
  // second tab) resumes the real conversation instead of a browser-local copy
  // of it.
  transcript: () =>
    ob<{ messages?: OnboardingThreadMessage[] }>('/api/onboarding/transcript')
      .then((r) => (Array.isArray(r?.messages) ? r.messages : [])),
  // Full transcript every turn — the server owns the interview state, the
  // client just carries the conversation.
  chat: (messages: OnboardingMessage[]) =>
    ob<OnboardingTurn>('/api/onboarding/chat', { method: 'POST', body: JSON.stringify({ messages }) }),
  // Step one, and deliberately not a chat turn: the interview is itself an LLM
  // call, so this has to succeed before there is anything to talk to. The
  // worker proves the key with a real request rather than just storing it.
  saveLlmKey: (key: string, provider = 'anthropic') =>
    ob<{ ok?: boolean; error?: string; verified?: boolean }>('/api/onboarding/llm-key', {
      method: 'POST', body: JSON.stringify({ key, provider }),
    }),
  gateways: () =>
    ob<{ gateways?: OnboardingGateway[] }>('/api/onboarding/gateways')
      .then((r) => (Array.isArray(r?.gateways) ? r.gateways : [])),
  connectGateway: (slug: string, config: Record<string, string>) =>
    ob<{ ok?: boolean; error?: string }>('/api/onboarding/gateways', {
      method: 'POST', body: JSON.stringify({ slug, config }),
    }),
  // THE LAST STEP. Irreversible: after this every route above 404s.
  finish: (reason = 'interview') =>
    ob<{ ok?: boolean; setup_complete?: boolean; error?: string }>('/api/onboarding/finish', {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  // "Later." Deliberately NOT finish: it leaves the surface alive so `resume`
  // has something to come back to.
  defer: () =>
    ob<{ ok?: boolean; setup_deferred?: boolean; error?: string }>('/api/onboarding/defer', { method: 'POST' }),
  resume: () =>
    ob<{ ok?: boolean; setup_deferred?: boolean; error?: string }>('/api/onboarding/resume', { method: 'POST' }),
};

// Chat helper. Streams SSE events from /api/chat.
export type ChatEvent =
  | { kind: 'start'; conversation_id: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; name: string; input: any }
  | { kind: 'tool_result'; name: string; ok: boolean; result?: any; error?: string }
  | { kind: 'done'; conversation_id: string }
  | { kind: 'error'; message: string };

export async function chat(
  messages: { role: 'user' | 'assistant'; content: string | any[] }[],
  conversation_id: string | null,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
  tier?: 'low' | 'mid' | 'high',
  speech?: boolean,
  agent?: string,
) {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, conversation_id, tier, speech, agent }),
      signal,
    });
  } catch (e) {
    // Stop pressed before the response arrived — clean exit, not an error.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!res.ok || !res.body) {
    onEvent({ kind: 'error', message: `${res.status} ${res.statusText}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let idx; (idx = buffer.indexOf('\n\n')) >= 0; ) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          onEvent({ kind: event as ChatEvent['kind'], ...parsed } as ChatEvent);
        } catch {
          /* swallow malformed sse frames */
        }
      }
    }
  } catch (e) {
    // Stop pressed mid-stream — the reader read() rejects; end cleanly.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
