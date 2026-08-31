// Digest plugin — the pack's own WhatsApp send queue.
//
// cmd rode the host wa-sender (wa_send_queue) for scheduled digest sends;
// this host has no such lane, so the digest pack carries its own:
// plugin_digest_wa_queue. ASAP sends go straight through the whatsapp
// gateway (the host audits them in its outbox); a picked slot lands here as
// a queued row and run_digest's tick flushes what is due. Cancel flips the
// row to 'cancelled' before it fires.
//
// This file imports NOTHING (plugin lib contract). Every function takes
// `api` first. Tables: plugin_digest_wa_queue (own). Gateway:
// whatsapp(send).

const now = () => Date.now();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 18);

// Normalize a phone / jid into the chat id the whatsapp gateway expects.
// Accepts '+972 50-000-0000', '972500000000', '...@c.us', '...@lid',
// '...@g.us' — jids pass through verbatim, bare numbers become <digits>@c.us.
function toChatIdLocal(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/@(c\.us|g\.us|lid)$/i.test(s)) return s;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 16) return null;
  return digits + '@c.us';
}

export async function readWaQueueItem(api, id) {
  return api.db.prepare('SELECT * FROM plugin_digest_wa_queue WHERE id = ?').bind(String(id)).first();
}

// Enqueue one text send. No send_at → deliver NOW through the gateway and
// keep a 'sent' row for the card's audit trail; send_at (ms epoch, future)
// → store a 'queued' row the flusher delivers when due.
export async function enqueueWaSend(api, { chatId, text, send_at = null, source = 'digest', source_ref = null } = {}) {
  const chat = toChatIdLocal(chatId);
  if (!chat) throw new Error(`"${chatId}" does not parse as a WhatsApp chat id`);
  const body = String(text || '').trim();
  if (!body) throw new Error('text required');
  const id = 'q_' + uid();
  const at = Number(send_at) || null;

  if (at && at > now()) {
    await api.db.prepare(
      `INSERT INTO plugin_digest_wa_queue (id, chat_id, text, status, not_before, source, source_ref, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).bind(id, chat, body, at, source, source_ref, now()).run();
    await api.log('wa_queued', { queue_id: id, chat_id: chat, scheduled_for: at, source_ref });
    return { ok: true, queued: true, queue_id: id, scheduled_for: at };
  }

  // ASAP: send through the gateway right now (host outbox audits it), then
  // record the row as already sent so the card's trail stays whole.
  const res = await api.gateway('whatsapp', 'send', { chatId: chat, text: body });
  await api.db.prepare(
    `INSERT INTO plugin_digest_wa_queue (id, chat_id, text, status, not_before, source, source_ref, created_at, sent_at, message_id)
     VALUES (?, ?, ?, 'sent', NULL, ?, ?, ?, ?, ?)`,
  ).bind(id, chat, body, source, source_ref, now(), now(), res.messageId || null).run();
  await api.log('wa_sent_now', { queue_id: id, chat_id: chat, message_id: res.messageId || null, source_ref });
  return { ok: true, queued: true, queue_id: id, messageId: res.messageId || null, scheduled_for: null };
}

// Cancel a queued row before it fires. Cancelling something already sent /
// failed / cancelled reports the actual state instead of pretending.
export async function cancelWaQueueItem(api, id) {
  const row = await readWaQueueItem(api, id);
  if (!row) throw new Error(`queue item ${id} not found`);
  if (row.status !== 'queued') return { ok: false, id: row.id, status: row.status, error: `cannot cancel a ${row.status} send` };
  await api.db.prepare(`UPDATE plugin_digest_wa_queue SET status = 'cancelled' WHERE id = ? AND status = 'queued'`).bind(String(id)).run();
  await api.log('wa_queue_cancelled', { queue_id: row.id, chat_id: row.chat_id });
  return { ok: true, id: row.id, status: 'cancelled' };
}

// Deliver every due queued row. Claim-first (status flip) so a crashed tick
// can never double-send; a failed gateway call marks the row failed with
// the error, it does not retry forever.
export async function flushDueWaQueue(api, { limit = 10 } = {}) {
  const due = (await api.db.prepare(
    `SELECT id FROM plugin_digest_wa_queue
      WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
      ORDER BY not_before ASC LIMIT ?`,
  ).bind(now(), Math.max(1, Math.min(25, Number(limit) || 10))).all()).results || [];
  let sent = 0, failed = 0;
  for (const d of due) {
    // one-shot claim: only the flip winner delivers
    const claim = await api.db.prepare(
      `UPDATE plugin_digest_wa_queue SET status = 'sending' WHERE id = ? AND status = 'queued'`,
    ).bind(d.id).run();
    if (!(claim?.meta?.changes ?? claim?.changes ?? 0)) continue;
    const row = await readWaQueueItem(api, d.id);
    try {
      const res = await api.gateway('whatsapp', 'send', { chatId: row.chat_id, text: row.text });
      await api.db.prepare(
        `UPDATE plugin_digest_wa_queue SET status = 'sent', sent_at = ?, message_id = ? WHERE id = ?`,
      ).bind(now(), res.messageId || null, d.id).run();
      sent++;
    } catch (e) {
      await api.db.prepare(
        `UPDATE plugin_digest_wa_queue SET status = 'failed', error = ? WHERE id = ?`,
      ).bind(String(e?.message || e).slice(0, 300), d.id).run();
      failed++;
    }
  }
  if (sent || failed) await api.log('wa_queue_flushed', { due: due.length, sent, failed });
  return { ok: true, due: due.length, sent, failed };
}
