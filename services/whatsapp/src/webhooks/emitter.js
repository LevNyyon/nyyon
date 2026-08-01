// Fan one WhatsApp event out to every matching subscriber, independently.
// Envelope matches OpenWA's webhook.service: {event, timestamp(ISO), sessionId,
// idempotencyKey, deliveryId, data}. We ALSO duplicate the message under a
// `payload` key, because another client reads `body.data` and Nyo reads `body.payload`
// — including both lets one envelope satisfy both apps unchanged.
import crypto from 'node:crypto';
import * as store from './store.js';
import { SESSION_ID } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}
function idempotencyKey(event, id) {
  return crypto.createHash('sha256').update(`${event}:${SESSION_ID}:${id || ''}`).digest('hex');
}
// Lenient match: a sub registered with ['message'] still gets message.received
// (Nyo registers 'message'; another client registers 'message.received'). message.sent
// only reaches subs that ask for it explicitly or '*'.
function eventMatches(events, event) {
  const evs = Array.isArray(events) && events.length ? events : ['message.received'];
  if (evs.includes('*') || evs.includes(event)) return true;
  if (event === 'message.received' && evs.includes('message')) return true;
  return false;
}

export async function dispatch(event, data) {
  const subs = store.list().filter((s) => s.active !== false && eventMatches(s.events, event));
  if (!subs.length) return;

  const idemKey = idempotencyKey(event, data.id);
  // allSettled is the crux: one down/slow app must never block the other.
  await Promise.allSettled(subs.map((s) => deliver(s, event, data, idemKey)));
}

async function deliver(sub, event, data, idemKey) {
  const delivery = crypto.randomUUID();
  const maxRetries = Number.isFinite(sub.retryCount) ? sub.retryCount : 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      idempotencyKey: idemKey,
      deliveryId: delivery,
      data, // another client reads body.data
      payload: data, // Nyo reads body.payload
    });
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'wa-gateway-webhook/1.0',
      'X-OpenWA-Event': event,
      'X-OpenWA-Idempotency-Key': idemKey,
      'X-OpenWA-Delivery-Id': delivery,
      'X-OpenWA-Retry-Count': String(attempt),
    };
    if (sub.secret) headers['X-OpenWA-Signature'] = sign(sub.secret, body);
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true;
      console.error(`[webhook] ${sub.url} -> HTTP ${res.status} (attempt ${attempt})`);
    } catch (e) {
      console.error(`[webhook] ${sub.url} -> ${e?.message || e} (attempt ${attempt})`);
    }
    if (attempt < maxRetries) await sleep(1000 * (attempt + 1));
  }
  return false;
}
