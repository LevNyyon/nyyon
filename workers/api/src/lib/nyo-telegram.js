// Nyo on Telegram — the operator's direct line to the business.
//
// Same design as the WhatsApp group bridge this ports: the newest unanswered
// inbound message is CLAIMED in sync_state BEFORE the model runs, so
// concurrent triggers can never double-reply, and an error releases the claim
// so the next trigger retries. Nyo's answer is the full chat pipeline
// (chat/index.js — whole tool pool, real data), drained from its SSE stream.
//
// Pairing: the bot is public by handle, so nothing answers until a chat is
// paired. The operator asks Nyo in the app for the pairing code (the
// get_telegram_pairing tool) and texts it to the bot once; the chat id lands
// in the `nyo-telegram` knowledge doc. Everything tunable lives in that doc.

import { readKnowledge, writeKnowledge, logEvent } from './db.js';
import { now } from './util.js';
import { sendTelegramText } from './telegram.js';

const DOC_SLUG = 'nyo-telegram';
const PAIR_KEY = 'nyo_tg_pair_code';
const PUSH_KEY = 'nyo_tg_push_ts';
const claimKey = (chatId) => `nyo_tg_answered:${chatId}`;
const hintKey = (chatId) => `nyo_tg_hinted:${chatId}`;

const DEFAULTS = { enabled: true, chat_ids: [], tier: 'mid', context_messages: 12, push_max_per_run: 5 };

const seedBody = (cfg) => `# Nyo on Telegram

The operator's direct Telegram line to Nyo. \`chat_ids\` holds the paired
chats (added automatically when the pairing code is texted to the bot);
\`tier\` picks the model tier; \`context_messages\` is how much of the thread
each answer sees. Set \`enabled\` false to mute the line without unpairing.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;

export async function nyoTelegramCfg(env) {
  let doc = await readKnowledge(env, DOC_SLUG);
  if (!doc) {
    await writeKnowledge(env, {
      slug: DOC_SLUG, title: 'Nyo on Telegram', body: seedBody(DEFAULTS),
      scope: 'global', module: null, parent_slug: 'knowledge-root',
    }).catch(() => {});
    doc = { body: seedBody(DEFAULTS) };
  }
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const parsed = m ? JSON.parse(m[1]) : null;
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
  } catch { /* malformed edit must not kill the line — defaults win */ }
  return DEFAULTS;
}

async function saveCfg(env, cfg) {
  await writeKnowledge(env, {
    slug: DOC_SLUG, title: 'Nyo on Telegram', body: seedBody(cfg),
    scope: 'global', module: null, parent_slug: 'knowledge-root',
  });
}

async function syncGet(env, key) {
  const r = await env.DB.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first().catch(() => null);
  return r?.value ?? null;
}
async function syncSet(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, String(value), now()).run();
}

// The pairing code: generated once per install, readable through the
// get_telegram_pairing tool. Texting it to the bot pairs that chat.
export async function pairingCode(env) {
  let code = await syncGet(env, PAIR_KEY);
  if (!code) {
    code = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => 'ACDEFHJKLMNPRTUVWXY34679'[b % 24]).join('');
    await syncSet(env, PAIR_KEY, code);
  }
  return code;
}

function sseTextFromResponse(res) {
  if (!res || !res.body) return Promise.resolve('');
  return (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = ''; let event = ''; let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:') && event === 'delta') {
          try { text += JSON.parse(line.slice(5).trim()).text || ''; } catch { /* partial frame */ }
        }
      }
    }
    return text.trim();
  })();
}

// One inbound Telegram update: store it, pair if it is the code, answer if
// the chat is paired. Called by the inbound route per update; safe to call
// spuriously.
export async function handleTelegramInbound(env, update) {
  const msg = update?.message || update?.edited_message;
  const chatId = String(msg?.chat?.id || '');
  const text = String(msg?.text || '').trim();
  if (!chatId || !text) return { ok: true, skipped: 'not a text message' };

  const msgId = `tg_${chatId}_${msg.message_id}`;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO telegram_messages (id, chat_id, from_me, body, timestamp) VALUES (?, ?, 0, ?, ?)',
  ).bind(msgId, chatId, text, (msg.date ? msg.date * 1000 : now())).run();

  const cfg = await nyoTelegramCfg(env);
  const paired = (cfg.chat_ids || []).map(String).includes(chatId);

  if (!paired) {
    const code = await pairingCode(env);
    if (text.toUpperCase() === code) {
      cfg.chat_ids = [...(cfg.chat_ids || []), chatId];
      await saveCfg(env, cfg);
      await logEvent(env, { kind: 'nyo_telegram_paired', actor: 'operator', payload: { chat_id: chatId } });
      await sendTelegramText(env, { chat_id: chatId, text: 'Paired. This chat is now your direct line to Nyo — ask away.' });
      return { ok: true, paired: true };
    }
    // One hint per chat, ever — a public bot handle must not become a
    // conversational surface for strangers.
    if (!(await syncGet(env, hintKey(chatId)))) {
      await syncSet(env, hintKey(chatId), '1');
      await sendTelegramText(env, { chat_id: chatId, text: 'This Nyo is private. If you are the operator, ask Nyo in the app for the pairing code and text it here.' }).catch(() => {});
    }
    return { ok: true, skipped: 'not paired' };
  }

  if (cfg.enabled === false) return { ok: true, skipped: 'disabled' };

  // Claim BEFORE the model call so concurrent updates cannot double-reply.
  const prevClaim = (await syncGet(env, claimKey(chatId))) || '';
  if (prevClaim === msgId) return { ok: true, skipped: 'already answered' };
  await syncSet(env, claimKey(chatId), msgId);

  try {
    const hist = (await env.DB.prepare(
      'SELECT from_me, body FROM telegram_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
    ).bind(chatId, Number(cfg.context_messages) || 12).all()).results.reverse();
    const messages = [];
    for (const r of hist) {
      const body = String(r.body || '').trim();
      if (!body) continue;
      const role = r.from_me ? 'assistant' : 'user';
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content += '\n' + body;
      else messages.push({ role, content: body });
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      // The claim was taken before the model ran, so a return that answers
      // NOTHING has to give it back — otherwise this message is marked
      // answered forever and the operator's next line is the only one Nyo
      // ever sees.
      await syncSet(env, claimKey(chatId), prevClaim);
      return { ok: true, skipped: 'nothing to answer' };
    }

    const { handleChat } = await import('../chat/index.js');
    const res = await handleChat(env, {
      messages, conversation_id: `telegram:${chatId}`, tier: cfg.tier || 'mid',
    });
    const reply = await sseTextFromResponse(res);
    if (!reply) {
      await syncSet(env, claimKey(chatId), prevClaim);
      await logEvent(env, { kind: 'nyo_telegram_empty', actor: 'nyo', payload: { msg_id: msgId } });
      return { ok: false, reason: 'empty reply' };
    }

    const sent = await sendTelegramText(env, { chat_id: chatId, text: reply });
    await env.DB.prepare(
      'INSERT OR IGNORE INTO telegram_messages (id, chat_id, from_me, body, timestamp) VALUES (?, ?, 1, ?, ?)',
    ).bind(`tg_out_${chatId}_${sent.message_id || now()}`, chatId, reply, now()).run();
    await logEvent(env, { kind: 'nyo_telegram_reply', actor: 'nyo', payload: { msg_id: msgId, chars: reply.length, parts: sent.parts } });
    return { ok: true, message_id: sent.message_id };
  } catch (e) {
    await syncSet(env, claimKey(chatId), prevClaim).catch(() => {});
    await logEvent(env, { kind: 'nyo_telegram_error', actor: 'nyo', payload: { msg_id: msgId, error: String(e?.message || e).slice(0, 300) } });
    return { ok: false, error: String(e?.message || e) };
  }
}

// Push Nyo's queued update messages (nyo_messages) to every paired chat.
// Runs on the hourly cron leg. Does NOT mark them delivered — the in-app chat
// still shows them; a timestamp watermark keeps Telegram from re-sending.
export async function nyoTelegramPush(env) {
  const cfg = await nyoTelegramCfg(env);
  const chats = (cfg.chat_ids || []).map(String);
  if (cfg.enabled === false || !chats.length) return { ok: true, skipped: 'no paired chats' };

  const since = Number(await syncGet(env, PUSH_KEY)) || (now() - 24 * 3600 * 1000);
  const rows = (await env.DB.prepare(
    'SELECT id, content, created_at FROM nyo_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?',
  ).bind(since, Number(cfg.push_max_per_run) || 5).all()).results || [];
  if (!rows.length) return { ok: true, pushed: 0 };

  // The watermark may only pass a message that actually reached a chat.
  // Advancing it regardless meant a Telegram outage silently discarded every
  // update queued during it — the operator simply never heard about them.
  let pushed = 0;
  let failed = 0;
  let watermark = since;
  for (const row of rows) {
    let delivered = false;
    for (const chatId of chats) {
      try { await sendTelegramText(env, { chat_id: chatId, text: row.content }); delivered = true; }
      catch { /* try the remaining chats before giving up on this message */ }
    }
    if (!delivered) { failed++; break; }   // stop: keep the queue ordered
    watermark = row.created_at;
    pushed++;
  }
  if (pushed) await syncSet(env, PUSH_KEY, watermark);
  await logEvent(env, { kind: 'nyo_telegram_pushed', actor: 'system', payload: { pushed, failed, chats: chats.length } });
  return { ok: true, pushed, failed };
}
