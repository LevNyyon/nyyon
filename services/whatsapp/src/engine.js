// WhatsApp engine for the gateway. Vendored + extended from
// whatsapp-digest/src/wa.js: keeps the pinned WA Web version, self-heal /
// reconnect, and profile-lock cleanup, and ADDS send/reply/media/react/groups/
// history plus a message dispatcher so the webhook layer can fan out inbound
// messages. The whatsapp-web.js calls match OpenWA's own adapter.
import './env.js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR =
  process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'data', '.wa-session');
const PROFILE_DIR = path.join(SESSION_DIR, 'session');
const LINKED_MARKER = path.join(SESSION_DIR, '.linked');

const WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1041001125-alpha';
const WEB_VERSION_REMOTE = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WEB_VERSION}.html`;

let client = null;
let state = 'idle'; // idle | loading | qr | ready | auth_failure
let lastQr = null;
let readyWaiters = [];
let reconnectTimer = null;
let reconnectAttempts = 0;
let dispatcher = null; // (eventName, msg) => void, set by index.js
let bridgeCaptured = 0; // messages the raw inbound bridge has delivered
let bridgeWatchdog = null;
let sweepDone = false; // full deaf-window sweep runs once per process

function setState(s) {
  state = s;
}
export function getState() {
  return { state, hasQr: !!lastQr, linked: hasSavedSession() };
}
export function getLastQr() {
  return lastQr;
}
export function setDispatcher(fn) {
  dispatcher = fn;
}

function writeMarker() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(LINKED_MARKER, '1');
  } catch {}
}
function removeMarker() {
  try {
    fs.rmSync(LINKED_MARKER, { force: true });
  } catch {}
}
export function hasSavedSession() {
  try {
    return fs.existsSync(LINKED_MARKER);
  } catch {
    return false;
  }
}

export function ensureClient() {
  if (client) return client;
  cleanupProfile();
  setState('loading');

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
    webVersionCache: { type: 'remote', remotePath: WEB_VERSION_REMOTE },
  });

  client.on('loading_screen', (p, m) =>
    console.error(`[wa] loading_screen ${p}% ${m || ''}`)
  );
  client.on('change_state', (s) => console.error('[wa] change_state:', s));
  client.on('qr', (qr) => {
    console.error('[wa] qr received (scan it)');
    lastQr = qr;
    setState('qr');
  });
  client.on('authenticated', () => {
    console.error('[wa] authenticated');
    writeMarker();
    setState('loading');
  });
  client.on('auth_failure', (m) => {
    console.error('[wa] auth_failure:', m);
    removeMarker();
    setState('auth_failure');
  });
  client.on('ready', () => {
    console.error('[wa] ready');
    lastQr = null;
    reconnectAttempts = 0;
    writeMarker();
    setState('ready');
    readyWaiters.forEach((fn) => fn());
    readyWaiters = [];
    // The library's own message listeners died with the Jul 26 2026 WA Web
    // update (its injected window.Store bridge no longer exists), so inbound
    // capture is re-attached straight to WhatsApp's current module system.
    installRawInboundBridge().catch((e) =>
      console.error('[wa] raw inbound bridge install failed:', e?.message || e)
    );
  });
  client.on('disconnected', (r) => {
    console.error('[wa] disconnected:', r);
    if (r === 'LOGOUT' || r === 'UNPAIRED') removeMarker();
    setState('idle');
    scheduleReconnect();
  });

  // Webhook drivers: inbound messages, and our own outbound sends.
  client.on('message', (msg) => {
    try {
      if (dispatcher) dispatcher('message.received', msg);
    } catch (e) {
      console.error('[wa] dispatch(received) error:', e?.message || e);
    }
  });
  client.on('message_create', (msg) => {
    try {
      if (msg.fromMe && dispatcher) dispatcher('message.sent', msg);
    } catch (e) {
      console.error('[wa] dispatch(sent) error:', e?.message || e);
    }
  });

  client.initialize().catch((e) => {
    console.error('[wa] initialize error:', e?.message || e);
    setState('idle');
    scheduleReconnect();
  });

  return client;
}

// ---- raw inbound bridge ----------------------------------------------------
// whatsapp-web.js attaches its 'message'/'message_create' listeners to the
// window.Store bridge it injects at boot; the Jul 26 2026 WA Web update
// removed the structures that injection targets, so those events never fire
// anymore even though the session itself is healthy. This bridge subscribes
// directly to WhatsApp's own message collection (same module system the raw
// history fallback reads) and feeds the SAME dispatcher, so the store,
// webhooks, and the command-center pull-sync all resume unchanged.
//
// Scope: text + metadata. Media arrives as its type with an empty body (the
// full download path needs the library's models, which are the broken part).
async function installRawInboundBridge() {
  const page = client?.pupPage;
  if (!page) throw new Error('no page');

  // Node-side receiver. exposeFunction throws if it survived a same-page
  // reinstall — that's fine, the function is already there.
  try {
    await page.exposeFunction('__nyyonOnMsg', (m) => {
      try {
        if (!m || !m.id || !m.chatKey) return;
        // Shape a whatsapp-web.js-lite message so payload.fromMessage /
        // payload.minimal read it exactly like a library message.
        const msg = {
          id: { _serialized: m.id },
          from: m.fromMe ? '' : m.chatKey,
          to: m.fromMe ? m.chatKey : '',
          body: m.body || '',
          type: m.type || 'chat',
          timestamp: m.t || Math.floor(Date.now() / 1000), // seconds
          fromMe: !!m.fromMe,
          author: m.author || undefined,
          hasMedia: false,
          hasQuotedMsg: false,
          _data: { notifyName: m.notifyName || undefined },
        };
        bridgeCaptured++;
        console.error(`[wa] bridge captured ${msg.fromMe ? 'out' : 'in'} ${m.chatKey} ${m.id} (${m.type || 'chat'})`);
        if (dispatcher) dispatcher(msg.fromMe ? 'message.sent' : 'message.received', msg);
      } catch (e) {
        console.error('[wa] bridge dispatch error:', e?.message || e);
      }
    });
  } catch (e) {
    if (!/already exists|already registered/i.test(String(e?.message || e))) throw e;
  }

  // The Jul 26 build killed the GLOBAL Msg collection (it holds stale
  // notification junk; live traffic never lands there) and broke the
  // id._serialized getter. What still works, verified by probe: each CHAT's
  // own msgs collection receives live messages, and chat.t bumps on every
  // arrival. So: listen for chat.t changes, read that chat's fresh tail,
  // dedupe by a manually-built id, and hand each new message up.
  // First install since process start sweeps the whole deaf window (the page
  // cache can hold days-old first-touches); watchdog reinstalls after a page
  // reload only re-sweep the reload gap.
  const sweepMs = sweepDone ? 15 * 60 * 1000 : 96 * 3600 * 1000;
  const r = await page.evaluate((sweepMs) => {
    try {
      if (window.__nyyonBridgeInstalled) return { ok: true, note: 'already installed' };
      const req = window.require;
      if (!req) return { error: 'no require in page' };
      let Coll = null;
      try { Coll = req('WAWebCollections'); } catch { /* checked below */ }
      if (!Coll?.Chat?.on) return { error: 'WAWebCollections.Chat missing' };

      const seen = new Set();
      const widStr = (w) => {
        if (!w) return null;
        if (typeof w === 'string') return w;
        try { if (typeof w._serialized === 'string' && w._serialized) return w._serialized; } catch {}
        return w.user && w.server ? `${w.user}@${w.server}` : null;
      };
      const emitFresh = (chat, windowMs) => {
        try {
          const ckey = widStr(chat?.id);
          if (!ckey) return;
          const msgs = chat.msgs?.getModelsArray?.() || [];
          for (const m of msgs.slice(-10)) {
            // only messages inside the window (10 min for live events; the
            // install-time sweep passes the whole deaf-window span)
            if (!m || !m.t || m.t * 1000 < Date.now() - windowMs) continue;
            const raw = m.id || {};
            const mid = (typeof raw._serialized === 'string' && raw._serialized) ||
              [raw.fromMe ? 'true' : 'false', widStr(raw.remote) || ckey, raw.id || `${m.t}.${(m.body || '').length}`].join('_');
            if (seen.has(mid)) continue;
            seen.add(mid);
            window.__nyyonOnMsg({
              id: mid,
              chatKey: ckey,
              fromMe: !!raw.fromMe,
              body: m.body || m.caption || '',
              type: m.type || 'chat',
              t: m.t || 0,
              author: widStr(m.author) || undefined,
              notifyName: m.notifyName || (m.senderObj && m.senderObj.pushname) || undefined,
            });
          }
          if (seen.size > 6000) {
            const keep = [...seen].slice(-3000);
            seen.clear();
            keep.forEach((x) => seen.add(x));
          }
        } catch { /* one bad chat must not kill the listener */ }
      };
      // chat.t bumps on every arrival; read the tail then, and again shortly
      // after in case the message body lands a beat behind the bump.
      Coll.Chat.on('change:t', (chat) => { emitFresh(chat, 600000); setTimeout(() => emitFresh(chat, 600000), 1500); });
      Coll.Chat.on('add', (chat) => setTimeout(() => emitFresh(chat, 600000), 1500));
      // One-time sweep: whatever the deaf window left behind in the per-chat
      // caches (e.g. wa.me first-touches) gets emitted now. The store dedupes
      // by id, so a re-sweep is cheap noise, not duplicates.
      let swept = 0;
      if (sweepMs > 0) {
        for (const c of Coll.Chat.getModelsArray()) {
          if (c.t && c.t * 1000 > Date.now() - sweepMs) { emitFresh(c, sweepMs); swept++; }
        }
      }
      window.__nyyonBridgeInstalled = true;
      return { ok: true, swept };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  }, sweepMs);
  if (r?.error) throw new Error(r.error);
  if (r?.swept) console.error(`[wa] bridge sweep covered ${r.swept} recently-active chats`);
  sweepDone = true;
  console.error(`[wa] raw inbound bridge installed${r.note ? ` (${r.note})` : ''}`);

  // WhatsApp Web reloads its page from time to time (and wweb.js navigates it
  // on reconnects); a reload silently wipes the in-page listener. Re-check
  // every 60s and reinstall when it's gone.
  if (!bridgeWatchdog) {
    bridgeWatchdog = setInterval(async () => {
      if (state !== 'ready' || !client?.pupPage) return;
      try {
        const alive = await client.pupPage.evaluate(() => !!window.__nyyonBridgeInstalled);
        if (!alive) {
          console.error('[wa] bridge lost (page reloaded) — reinstalling');
          await installRawInboundBridge();
        }
      } catch { /* transient page states; next tick retries */ }
    }, 60000);
  }
}

// Read-only diagnostics for the raw bridge: what the page actually has.
// Optional chatId: also inspect that chat's own message collection.
export async function bridgeProbe(chatId = null) {
  const page = client?.pupPage;
  if (!page) return { error: 'no page' };
  const inPage = await page.evaluate((cid) => {
    const out = { installed: !!window.__nyyonBridgeInstalled, onMsg: typeof window.__nyyonOnMsg };
    try {
      const req = window.require;
      if (!req) { out.require = false; return out; }
      out.require = true;
      const Coll = (() => { try { return req('WAWebCollections'); } catch { return null; } })();
      out.collections = !!Coll;
      if (Coll?.Msg) {
        out.msgOn = typeof Coll.Msg.on;
        const arr = Coll.Msg.getModelsArray ? Coll.Msg.getModelsArray() : [];
        out.msgCount = arr.length;
        out.newest = arr.slice(-3).map((m) => ({
          id: (m.id && m.id._serialized) || null, t: m.t || null, type: m.type || null, isNewMsg: m.isNewMsg ?? null,
        }));
      } else out.msg = false;
      if (Coll?.Chat) {
        const chats = Coll.Chat.getModelsArray ? Coll.Chat.getModelsArray() : [];
        out.chatCount = chats.length;
        // newest chat activity the page believes in
        const newest = chats.map((c) => c.t || 0).sort((a, b) => b - a)[0] || null;
        out.newestChatT = newest;
        if (cid) {
          const digits = String(cid).split('@')[0];
          const chat = chats.find((c) => c.id?._serialized === cid)
            || chats.find((c) => c.id?.user === digits)
            || chats.find((c) => (c.contact?.phoneNumber?.user || c.contact?.id?.user) === digits);
          if (!chat) out.chat = { found: false };
          else {
            const msgs = chat.msgs?.getModelsArray?.() || [];
            out.chat = {
              found: true, key: chat.id?._serialized || null, t: chat.t || null,
              msgsLen: msgs.length,
              tail: msgs.slice(-4).map((m) => ({
                id: m.id?._serialized || null, fromMe: !!(m.id && m.id.fromMe),
                t: m.t || null, type: m.type || null, body: (m.body || '').slice(0, 40),
              })),
              // what event surface does the chat's msgs collection offer?
              msgsOn: typeof chat.msgs?.on,
              chatOn: typeof chat.on,
            };
          }
        }
      }
    } catch (e) { out.probeError = e?.message || String(e); }
    return out;
  }, chatId);
  return { state, bridgeCaptured, ...inPage };
}

function cleanupProfile() {
  try {
    if (process.platform !== 'win32') {
      execFileSync('pkill', ['-f', PROFILE_DIR], { stdio: 'ignore' });
    }
  } catch {
    /* pkill exits non-zero when nothing matches, fine */
  }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
    } catch {}
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= 6) {
    console.error('[wa] auto-reconnect gave up after 6 tries; POST /reset to retry');
    return;
  }
  const delay = Math.min(30000, 2000 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  console.error(
    `[wa] auto-reconnect in ${Math.round(delay / 1000)}s (try ${reconnectAttempts})`
  );
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await destroyClient();
    ensureClient();
  }, delay);
}

async function destroyClient() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await client?.destroy();
  } catch {}
  client = null;
  lastQr = null;
  setState('idle');
}

export async function stop() {
  await destroyClient();
  return getState();
}
export async function resetClient() {
  reconnectAttempts = 0;
  await destroyClient();
  cleanupProfile();
  ensureClient();
  return getState();
}

export function waitUntilReady(timeoutMs = 90000) {
  if (state === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    readyWaiters.push(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function ensureReadyOrThrow() {
  if (state === 'ready') return;
  ensureClient();
  const ok = await waitUntilReady(30000);
  if (ok) return;
  throw new Error(
    hasSavedSession()
      ? 'WhatsApp is reconnecting (restoring the saved login). Try again in a few seconds.'
      : 'WhatsApp is not linked yet. Open /link, scan the QR once, then retry.'
  );
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ---- send / reply / media / react (calls confirmed against OpenWA's adapter) ----
export async function sendText(chatId, text) {
  await ensureReadyOrThrow();
  const msg = await withTimeout(client.sendMessage(chatId, text), 30000, 'sendText');
  // Same failure shape as sendMedia: resolve means the text was delivered,
  // but the returned object can be malformed — reading .id blind threw
  // "Cannot read properties of undefined (reading 'id')" after a successful
  // send, and the operator's retry then delivered duplicates. Never throw here.
  const id = msg?.id?._serialized ?? null;
  return { ok: true, id, messageId: id, timestamp: msg?.timestamp ?? null };
}

export async function reply(chatId, quotedMessageId, text) {
  await ensureReadyOrThrow();
  const chat = await client.getChatById(chatId);
  const messages = await withTimeout(chat.fetchMessages({ limit: 100 }), 20000, 'fetchMessages');
  const quoted = messages.find((m) => m.id._serialized === quotedMessageId);
  if (!quoted) throw new Error(`Message ${quotedMessageId} not found in ${chatId}`);
  const msg = await quoted.reply(text);
  return { id: msg.id._serialized, messageId: msg.id._serialized, timestamp: msg.timestamp };
}

export async function sendMedia(chatId, { url, base64, mimetype, filename, caption } = {}) {
  await ensureReadyOrThrow();
  let media;
  if (url) media = await MessageMedia.fromUrl(url);
  else if (base64) {
    if (!mimetype) throw new Error('mimetype is required when sending base64 media');
    media = new MessageMedia(mimetype, base64, filename);
  } else throw new Error('media requires url or base64');
  const msg = await withTimeout(
    client.sendMessage(chatId, media, { caption }),
    60000,
    'sendMedia'
  );
  // The media HAS been delivered once sendMessage resolves. whatsapp-web.js can
  // resolve without a fully-formed message object, and reading msg.id._serialized
  // blind threw "Cannot read properties of undefined (reading 'id')" AFTER a
  // successful send. That 500 was logged as a failed send and re-fired by the
  // retry path, delivering the same image again and again. Never throw here.
  const id = msg?.id?._serialized ?? null;
  return { ok: true, id, messageId: id, timestamp: msg?.timestamp ?? null };
}

export async function react(chatId, messageId, emoji) {
  await ensureReadyOrThrow();
  let message;
  if (chatId) {
    const chat = await client.getChatById(chatId);
    const messages = await withTimeout(chat.fetchMessages({ limit: 100 }), 20000, 'fetchMessages');
    message = messages.find((m) => m.id._serialized === messageId);
  } else {
    message = await findMessageById(messageId);
  }
  if (!message) throw new Error(`Message ${messageId} not found`);
  await message.react(emoji || '');
  return { success: true };
}

// Nyo reacts with {messageId, reaction} and NO chatId; scan recent chats for it.
async function findMessageById(messageId) {
  const chats = await withTimeout(client.getChats(), 40000, 'getChats');
  chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const chat of chats.slice(0, 30)) {
    let msgs;
    try {
      msgs = await withTimeout(chat.fetchMessages({ limit: 50 }), 8000, 'fetch');
    } catch {
      continue;
    }
    const m = msgs.find((x) => x.id._serialized === messageId);
    if (m) return m;
  }
  return null;
}

// ---- read: groups / history ----
export async function getGroups() {
  await ensureReadyOrThrow();
  const chats = await withTimeout(client.getChats(), 40000, 'getChats');
  return chats.filter((c) => c.isGroup).map((g) => ({ id: g.id._serialized, name: g.name }));
}

// Look a phone number up on WhatsApp: registered?, pushname, profile photo,
// about, business flag. Read-only — used by the command-center GTM module's
// intake enrichment (number -> identity). Mirrors gtm-builder's /check-number.
export async function getContactInfo(number) {
  await ensureReadyOrThrow();
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) throw new Error('number required');
  const numId = await withTimeout(client.getNumberId(digits), 20000, 'getNumberId');
  if (!numId) return { on_whatsapp: false, number: digits };
  const contact = await withTimeout(client.getContactById(numId._serialized), 20000, 'getContactById');
  let photo = null, about = null;
  try { photo = await withTimeout(contact.getProfilePicUrl(), 15000, 'getProfilePicUrl'); } catch { /* private */ }
  try { about = await withTimeout(contact.getAbout(), 15000, 'getAbout'); } catch { /* private */ }
  return {
    on_whatsapp: true,
    number: digits,
    whatsapp_id: numId._serialized,
    name: contact.pushname || contact.name || null,
    pushname: contact.pushname || null,
    photo: photo || null,
    about: about || null,
    is_business: !!contact.isBusiness,
  };
}

// Resolve WhatsApp LIDs (privacy ids, '<digits>@lid') to real phone numbers
// via WhatsApp Web's own LID<->PN map (client.getContactLidAndPhone — batch,
// falls back to a server existence query per id). number is null when
// WhatsApp doesn't share the phone.
export async function resolveLids(lids = []) {
  await ensureReadyOrThrow();
  const ids = [...new Set([].concat(lids).map(String).filter((x) => /@lid$/.test(x)))].slice(0, 60);
  if (!ids.length) return [];
  const shape = (lid, m) => {
    const pn = m?.pn || null;   // '<digits>@c.us'
    return { lid, pn, number: pn ? pn.replace(/@c\.us$/, '') : null };
  };
  try {
    const mapped = await withTimeout(client.getContactLidAndPhone(ids), 60000, 'getContactLidAndPhone');
    const out = ids.map((lid, i) => shape(lid, mapped?.[i]));
    // The library call "succeeding" with all-null pns is the drifted-build
    // signature — fall through to the page scan in that case.
    if (out.some((r) => r.pn)) return out;
    throw new Error('all-null from library path');
  } catch {
    // The library's in-page retrieval is broken on the Jul 26 build. Read the
    // mapping straight off the chat/contact models instead: a lid chat's
    // contact carries its phone-number wid.
    return rawResolveLids(ids);
  }
}

async function rawResolveLids(ids) {
  const page = client?.pupPage;
  if (!page) return ids.map((lid) => ({ lid, pn: null, number: null, error: 'no page' }));
  const rows = await page.evaluate((lids) => {
    const req = window.require;
    if (!req) return lids.map((lid) => ({ lid, pn: null, error: 'no require' }));
    let Coll = null;
    try { Coll = req('WAWebCollections'); } catch { /* handled below */ }
    const widStr = (w) => {
      if (!w) return null;
      if (typeof w === 'string') return w;
      try { if (typeof w._serialized === 'string' && w._serialized) return w._serialized; } catch {}
      return w.user && w.server ? `${w.user}@${w.server}` : null;
    };
    const chats = Coll?.Chat?.getModelsArray ? Coll.Chat.getModelsArray() : [];
    const contacts = Coll?.Contact?.getModelsArray ? Coll.Contact.getModelsArray() : [];
    return lids.map((lid) => {
      let pn = null;
      const chat = chats.find((c) => widStr(c.id) === lid);
      if (chat) pn = widStr(chat.contact?.phoneNumber);
      if (!pn) {
        const ct = contacts.find((c) => widStr(c.id) === lid);
        if (ct) pn = widStr(ct.phoneNumber);
      }
      if (pn && !/@c\.us$/.test(pn)) pn = null;
      return { lid, pn };
    });
  }, ids);
  return rows.map((r) => ({ lid: r.lid, pn: r.pn || null, number: r.pn ? r.pn.replace(/@c\.us$/, '') : null, ...(r.error ? { error: r.error } : {}) }));
}

export async function resolveLid(lid) {
  const [r] = await resolveLids([lid]);
  if (!r) throw new Error('expected a <digits>@lid id');
  return r;
}

export async function getGroupInfo(groupId) {
  await ensureReadyOrThrow();
  const chat = await client.getChatById(groupId);
  if (!chat || !chat.isGroup) return null;
  const participants = (chat.participants || []).map((p) => ({
    id: p.id._serialized,
    number: p.id.user,
    name: p.name ? String(p.name) : undefined,
    isAdmin: !!p.isAdmin,
    isSuperAdmin: !!p.isSuperAdmin,
  }));
  return {
    id: chat.id._serialized,
    name: chat.name,
    description: chat.description ? String(chat.description) : undefined,
    owner: chat.owner?._serialized ? String(chat.owner._serialized) : undefined,
    participants,
    isReadOnly: !!chat.isReadOnly,
    isAnnounce: !!chat.isAnnounce,
  };
}

export async function getChatHistory(chatId, limit = 50) {
  await ensureReadyOrThrow();
  try {
    const chat = await client.getChatById(chatId);
    if (!chat) return [];
    const messages = await withTimeout(chat.fetchMessages({ limit }), 30000, 'fetchMessages');
    return messages.map((m) => ({
      id: m.id._serialized,
      from: m.from || '',
      to: m.to || '',
      chatId,
      body: m.body || '',
      type: m.type || 'chat',
      timestamp: Number(m.timestamp || 0) * 1000, // ms, matches OpenWA history
      fromMe: !!m.fromMe,
      isGroup: !!chat.isGroup,
      senderName: m._data?.notifyName || m.author || undefined,
    }));
  } catch (e) {
    // wweb.js's high-level path breaks whenever WhatsApp Web's internals
    // drift (the "r" era). Log the REAL failure, then read the chat straight
    // from the injected Store in the page — same data, none of the fragile
    // model serialization.
    console.error('[wa] fetchMessages broken, using raw Store fallback:', e?.message || e, e?.stack?.split('\n')[1] || '');
    return rawHistoryFromStore(chatId, limit);
  }
}

// Read a chat's messages directly from WhatsApp Web's own Store via
// page.evaluate — bypasses whatsapp-web.js model wrapping entirely.
async function rawHistoryFromStore(chatId, limit = 50) {
  const page = client?.pupPage;
  if (!page) throw new Error('no page available for raw history');
  const rows = await page.evaluate(async (cid, lim) => {
    const req = window.require;
    if (!req) return { error: 'no require in page' };
    const tryReq = (name) => { try { return req(name); } catch { return null; } };
    const Coll = tryReq('WAWebCollections');
    const WidF = tryReq('WAWebWidFactory');
    if (!Coll?.Chat || !WidF?.createWid) {
      const probes = ['WAWebCollections','WAWebWidFactory','WAWebChatCollection','WAWebMsgCollection','WAWebChatLoadMessages','WAWebMsgLoadEarlier']
        .map((n) => `${n}:${tryReq(n) ? 'ok' : 'no'}`).join(' ');
      return { error: 'modules missing — ' + probes };
    }
    let chat = null;
    try {
      const wid = WidF.createWid(cid);
      chat = Coll.Chat.get(wid);
      if (!chat) {
        const Finder = tryReq('WAWebFindChatAction') || tryReq('WAWebChatFind');
        const findChat = Finder?.findChat || Finder?.default?.findChat;
        if (findChat) chat = await findChat(wid, 'history-read').catch(() => null);
      }
      if (!chat) {
        // WA is migrating chat keys (c.us ↔ lid); a keyed get can miss even
        // though the chat is right there. Scan the collection: match by the
        // exact serialized id OR by phone digits on either the chat id or its
        // contact's phone-number wid.
        const digits = String(cid).split('@')[0];
        const all = Coll.Chat.getModelsArray ? Coll.Chat.getModelsArray() : [];
        chat = all.find((c) => c.id?._serialized === cid)
            || all.find((c) => c.id?.user === digits)
            || all.find((c) => (c.contact?.phoneNumber?.user || c.contact?.id?.user) === digits);
        if (!chat) {
          const sample = all.slice(0, 8).map((c) => c.id?._serialized).join(',');
          return { error: `chat not found (scanned ${all.length}; sample: ${sample})` };
        }
      }
    } catch (e) { return { error: 'chat lookup: ' + (e?.message || String(e)) }; }
    const diag = [];
    try {
      const Loader = tryReq('WAWebChatLoadMessages') || tryReq('WAWebMsgLoadEarlier');
      const loadEarlier = Loader?.loadEarlierMsgs || Loader?.default?.loadEarlierMsgs;
      diag.push('loader:' + (loadEarlier ? 'yes' : 'NO'));
      if (loadEarlier) {
        for (let i = 0; i < 5 && (chat.msgs.getModelsArray().length < lim); i++) {
          try {
            const more = await loadEarlier(chat);
            diag.push('round' + i + ':' + (more ? more.length : 'null'));
            if (!more || !more.length) break;
          } catch (e) { diag.push('round' + i + ':ERR ' + (e?.message || e)); break; }
        }
      }
    } catch (e) { diag.push('outer:' + (e?.message || e)); }
    if (!(chat.msgs?.getModelsArray?.() || []).length) {
      return { error: 'no msgs after load — ' + diag.join(' | ') + ' — chatKey:' + (chat.id?._serialized || '?') };
    }
    const models = chat.msgs?.getModelsArray?.() || [];
    return models.slice(-lim).map((m) => ({
      id: m.id?._serialized || null,
      fromMe: !!(m.id?.fromMe),
      body: m.body || m.caption || '',
      type: m.type || 'chat',
      t: m.t || 0,
      author: (m.author && m.author._serialized) || (m.from && m.from._serialized) || null,
      notifyName: m.notifyName || (m.senderObj && m.senderObj.pushname) || null,
    }));
  }, chatId, limit);
  if (rows && rows.error) throw new Error(`raw history: ${rows.error}`);
  return (rows || []).filter((m) => m.id).map((m) => ({
    id: m.id,
    from: m.fromMe ? 'me' : (m.author || chatId),
    to: m.fromMe ? chatId : 'me',
    chatId,
    body: m.body,
    type: m.type,
    timestamp: Number(m.t || 0) * 1000,
    fromMe: m.fromMe,
    isGroup: chatId.endsWith('@g.us'),
    senderName: m.notifyName || undefined,
  }));
}
