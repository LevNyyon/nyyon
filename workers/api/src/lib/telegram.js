// Telegram Bot API — transport only (the boundary the `telegram` gateway owns).
//
// The operator creates a bot once with @BotFather and pastes the token; from
// then on Nyo lives in that bot's chat. Inbound updates arrive through the
// bundled long-poll service (services/telegram/poll.mjs) which POSTs them to
// /api/telegram/inbound — this file never polls, it only speaks outward.
//
// Config (lib/gateway-config.js resolves DB-first, then env):
//   TELEGRAM_BOT_TOKEN   from @BotFather

import { withResolvedCredentials } from './gateway-config.js';

const MAX_MSG = 4096; // Telegram's hard per-message cap

async function call(env, method, body = null, { timeoutMs = 20000 } = {}) {
  env = await withResolvedCredentials(env);
  const token = env.TELEGRAM_BOT_TOKEN || '';
  if (!token) return { ok: false, http: 0, error: 'TELEGRAM_BOT_TOKEN not configured' };
  const init = { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeoutMs) };
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
  } catch (e) {
    return { ok: false, http: 0, error: `telegram unreachable: ${String(e?.message || e)}` };
  }
  const j = await res.json().catch(() => null);
  if (!j?.ok) return { ok: false, http: res.status, error: j?.description || res.statusText };
  return { ok: true, http: res.status, data: j.result };
}

export async function probeTelegram(env) {
  const r = await call(env, 'getMe', null, { timeoutMs: 10000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, bot: { id: r.data?.id, username: r.data?.username, name: r.data?.first_name } };
}

// Send one text message. Long texts split at Telegram's 4096 cap on the last
// newline before the limit, so answers never get half-lost.
export async function sendTelegramText(env, { chat_id, text }) {
  if (!chat_id || !text) throw new Error('chat_id + text required');
  const chunks = [];
  let rest = String(text);
  while (rest.length > MAX_MSG) {
    let cut = rest.lastIndexOf('\n', MAX_MSG);
    if (cut < MAX_MSG * 0.5) cut = MAX_MSG;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  let last = null;
  for (const chunk of chunks) {
    const r = await call(env, 'sendMessage', { chat_id, text: chunk });
    if (!r.ok) throw new Error(r.error);
    last = r.data;
  }
  return { ok: true, message_id: last?.message_id ?? null, parts: chunks.length };
}
