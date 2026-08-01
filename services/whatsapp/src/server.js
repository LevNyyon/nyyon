// Express app exposing the OpenWA-compatible REST subset both apps call, plus
// the human /link page. Single shared session: the :sid param is echoed back
// but every route targets the one engine. Bound to loopback by index.js.
import express from 'express';
import QRCode from 'qrcode';
import { API_KEY, SESSION_ID } from './config.js';
import * as engine from './engine.js';
import * as store from './webhooks/store.js';
import * as messages from './message-store.js';
import { LINK_PAGE } from './qr-page.js';

// Map our engine state to OpenWA's status vocabulary. CRITICAL: emit `qr` ONLY
// when a QR is actually waiting; a normal reconnect must read `initializing`,
// never `qr`, or another client wrongly demands a human scan.
function mapStatus() {
  const { state, hasQr } = engine.getState();
  if (hasQr) return 'qr';
  if (state === 'ready') return 'ready';
  if (state === 'auth_failure') return 'failed';
  return 'initializing'; // loading, idle, or reconnecting
}

function sessionView(sid = SESSION_ID) {
  const s = mapStatus();
  return { id: sid, sessionId: sid, status: s, state: s };
}

function scrub(w) {
  return {
    url: w.url,
    events: w.events,
    hasSecret: !!w.secret,
    retryCount: w.retryCount,
    active: w.active !== false,
  };
}

// Read handler wrapper: resolve -> JSON; map "not linked / reconnecting" to 503,
// everything else to 500, with a plain error envelope.
function wrap(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      res.json(data ?? { ok: true });
    } catch (e) {
      const msg = String(e?.message || e);
      const code = /not linked|reconnecting|not ready/i.test(msg) ? 503 : 500;
      res.status(code).json({ error: msg });
    }
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' })); // base64 media rides in the body

  // --- human link page (no API key; loopback only) ---
  app.get('/link', (req, res) => res.type('html').send(LINK_PAGE));
  app.get('/link/status', async (req, res) => {
    const status = mapStatus();
    let qr = null;
    const raw = engine.getLastQr();
    if (raw) {
      try {
        qr = await QRCode.toDataURL(raw);
      } catch {}
    }
    res.json({ status, qr });
  });

  const api = express.Router();

  // API-key auth on everything except /health. Re-enabled 2026-07-04.
  // The key (API_KEY, from .dev.vars) MUST equal the command center's WA_API_KEY
  // secret or the deployed worker gets 401. /health stays open so tunnel/uptime
  // probes work without the key.
  api.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.get('X-API-Key') !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  api.get('/health', (req, res) => res.json({ ok: true, pid: process.pid, sessionId: SESSION_ID }));

  // ---- message store: the gateway is the WhatsApp source of truth, so tools
  //      PULL from here (Nyo command-center sync, etc.) instead of receiving a
  //      webhook into their own API. ----
  api.get('/messages', (req, res) => res.json({
    messages: req.query.created_since != null
      ? messages.sinceCreated(req.query.created_since, req.query.limit)
      : messages.since(req.query.since, req.query.limit),
  }));
  api.get('/messages/chats', (req, res) => res.json({ chats: messages.chats() }));
  api.get('/messages/stats', (req, res) => res.json(messages.stats()));
  // Read-only bridge diagnostics: is the inbound hook alive, what does the
  // page's own message collection contain.
  api.get('/debug/bridge', wrap((req) => engine.bridgeProbe(req.query.chat || null)));

  // ---- sessions ----
  api.get('/sessions', (req, res) => res.json([sessionView()]));
  const sessionHandler = (req, res) => res.json(sessionView(req.params.sid));
  api.get('/sessions/:sid', sessionHandler);
  api.post('/sessions/:sid', sessionHandler);
  api.post('/sessions/:sid/start', (req, res) => {
    engine.ensureClient();
    res.json(sessionView(req.params.sid));
  });
  api.post('/sessions/:sid/stop', async (req, res) => {
    await engine.stop();
    res.json(sessionView(req.params.sid));
  });
  api.post('/sessions/:sid/restart', async (req, res) => {
    await engine.resetClient();
    res.json(sessionView(req.params.sid));
  });
  api.get('/sessions/:sid/qr', async (req, res) => {
    const raw = engine.getLastQr();
    if (!raw) return res.status(400).json({ error: 'no qr available', status: mapStatus() });
    try {
      const qrCode = await QRCode.toDataURL(raw);
      res.json({ qrCode, status: 'qr' });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- messages: send ----
  api.post(
    '/sessions/:sid/messages/send-text',
    wrap((req) => {
      const b = req.body || {};
      return engine.sendText(b.chatId || b.to, b.text ?? b.message ?? b.content);
    })
  );
  api.post(
    '/sessions/:sid/messages/reply',
    wrap((req) => {
      const b = req.body || {};
      return engine.reply(b.chatId || b.to, b.quotedMessageId || b.messageId, b.text ?? b.message);
    })
  );
  const mediaHandler = wrap((req) => {
    const b = req.body || {};
    return engine.sendMedia(b.chatId || b.to, {
      url: b.url,
      base64: b.base64 || b.data,
      mimetype: b.mimetype,
      filename: b.filename,
      caption: b.caption,
    });
  });
  api.post('/sessions/:sid/messages/send-image', mediaHandler);
  api.post('/sessions/:sid/messages/send-video', mediaHandler);
  api.post('/sessions/:sid/messages/send-audio', mediaHandler);
  api.post('/sessions/:sid/messages/send-document', mediaHandler);
  // react accepts Nyo's {messageId, reaction} (no chatId) and another client's
  // {chatId, messageId, emoji}.
  api.post(
    '/sessions/:sid/messages/react',
    wrap((req) => {
      const b = req.body || {};
      return engine.react(b.chatId || null, b.messageId, b.emoji ?? b.reaction ?? '');
    })
  );

  // ---- messages: read history (+ another client's /chats/:id/messages alias) ----
  const historyHandler = wrap((req) => {
    const limit = Math.min(500, Number(req.query.limit) || 50);
    return engine.getChatHistory(decodeURIComponent(req.params.chatId), limit);
  });
  api.get('/sessions/:sid/messages/history/:chatId', historyHandler);
  api.get('/sessions/:sid/chats/:chatId/messages', historyHandler);

  // ---- contacts: number -> WhatsApp identity (read-only, GTM intake enrich) ----
  api.get('/sessions/:sid/contacts/:number', wrap((req) => engine.getContactInfo(req.params.number)));

  // ---- LID resolution: '<digits>@lid' -> real phone (when WhatsApp shares it) ----
  api.get('/sessions/:sid/lids/:lid', wrap((req) => engine.resolveLid(decodeURIComponent(req.params.lid))));
  api.post('/sessions/:sid/lids', wrap((req) => engine.resolveLids(req.body?.lids || [])));

  // ---- groups ----
  api.get('/sessions/:sid/groups', wrap(() => engine.getGroups()));
  api.get('/sessions/:sid/groups/:groupId', async (req, res) => {
    try {
      const info = await engine.getGroupInfo(decodeURIComponent(req.params.groupId));
      // 404 (not 200 null): another client crashes on null.participants; it treats 404
      // as a clean "not found". Nyo throws on non-ok, which is fine here.
      if (!info) return res.status(404).json({ error: 'group not found' });
      res.json(info);
    } catch (e) {
      const msg = String(e?.message || e);
      const code = /not linked|reconnecting|not ready/i.test(msg) ? 503 : 500;
      res.status(code).json({ error: msg });
    }
  });

  // ---- webhooks ----
  api.post('/sessions/:sid/webhooks', (req, res) => {
    try {
      const rec = store.register(req.body || {});
      res.json({ ok: true, webhook: scrub(rec) });
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });
  api.get('/sessions/:sid/webhooks', (req, res) => res.json(store.list().map(scrub)));

  app.use('/api', api);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
