// Bootstrap: load env, wire the engine's message dispatcher to the webhook
// emitter, start the WhatsApp client, and serve the REST API on loopback. The
// port bind doubles as the single-instance lock (EADDRINUSE -> exit).
import './env.js';
import { PORT } from './config.js';
import * as engine from './engine.js';
import * as emitter from './webhooks/emitter.js';
import * as payload from './payload.js';
import * as store from './message-store.js';
import { createApp } from './server.js';

// Local message store — the gateway is the WhatsApp source of truth.
store.init();

// Every WhatsApp event: normalize ONCE, persist it (source of truth, regardless
// of whether any webhook is registered), then fan out to any subscribers.
engine.setDispatcher((event, msg) => {
  (async () => {
    let data;
    try { data = await payload.fromMessage(msg); }
    catch { data = payload.minimal(msg); }
    store.persist(data);
    emitter.dispatch(event, data).catch((e) => console.error('[emitter]', e?.message || e));
  })().catch((e) => console.error('[dispatch]', e?.message || e));
});

// Start linking / restoring the saved session immediately.
engine.ensureClient();

const app = createApp();
const server = app.listen(PORT, '127.0.0.1', () => {
  console.error(`[gateway] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.error(`[gateway] link page:  http://127.0.0.1:${PORT}/link`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[gateway] port ${PORT} already in use - another instance is running. Exiting.`);
  } else {
    console.error('[gateway] server error:', e?.message || e);
  }
  process.exit(1);
});

async function shutdown(sig) {
  console.error(`[gateway] ${sig} received, shutting down`);
  try {
    server.close();
  } catch {}
  try {
    await engine.stop();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[gateway] uncaughtException:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[gateway] unhandledRejection:', e?.message || e));
