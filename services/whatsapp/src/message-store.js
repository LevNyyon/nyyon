// Message store — the gateway is the WhatsApp source of truth. Every message the
// engine sees (inbound + our own sends) is persisted here, independent of whether
// any webhook is registered, so ANY tool (Nyo, another client, …) can pull it via
// GET /api/messages?since=. Uses Node's built-in SQLite (no native dependency).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'messages.db');

let db = null;

export function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT,
      from_me     INTEGER,
      sender_id   TEXT,
      sender_name TEXT,
      body        TEXT,
      type        TEXT,
      ts          INTEGER,        -- ms epoch (payload is seconds; stored *1000)
      is_group    INTEGER,
      raw         TEXT,
      created_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts   ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  `);
  console.error(`[store] messages.db ready at ${DB_PATH}`);
}

// Persist a NORMALIZED payload (payload.fromMessage output). Idempotent on id.
export function persist(data) {
  if (!db || !data?.id) return;
  const tsMs       = data.timestamp ? Math.round(Number(data.timestamp) * 1000) : Date.now();
  const senderId   = data.sender?.id || data.author || (data.fromMe ? null : data.from) || null;
  const senderName = data.senderName || data.notifyName || data.pushName || null;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, chat_id, from_me, sender_id, sender_name, body, type, ts, is_group, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(data.id), data.chatId || '', data.fromMe ? 1 : 0, senderId, senderName,
      data.body || '', data.type || 'chat', tsMs, data.isGroup ? 1 : 0,
      JSON.stringify(data), Date.now(),
    );
  } catch (e) {
    console.error('[store] persist error:', e?.message || e);
  }
}

// Pull messages newer than `sinceMs`, oldest-first, capped. This is what the
// command-center pull-sync calls to keep its D1 cache current.
export function since(sinceMs, limit) {
  if (!db) return [];
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db.prepare(`
    SELECT id, chat_id, from_me, sender_id, sender_name, body, type, ts, is_group, created_at
      FROM messages
     WHERE ts > ?
     ORDER BY ts ASC
     LIMIT ?
  `).all(Number(sinceMs) || 0, cap);
}

// Pull by WHEN THE ROW WAS PERSISTED, not the message's own timestamp. The
// bridge's deaf-window sweep stores days-old messages long after their ts —
// a ts cursor never sees them; a created_at cursor always does.
export function sinceCreated(sinceMs, limit) {
  if (!db) return [];
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db.prepare(`
    SELECT id, chat_id, from_me, sender_id, sender_name, body, type, ts, is_group, created_at
      FROM messages
     WHERE created_at > ?
     ORDER BY created_at ASC
     LIMIT ?
  `).all(Number(sinceMs) || 0, cap);
}

// Chats derived from stored messages: one row per chat, newest message wins.
export function chats() {
  if (!db) return [];
  return db.prepare(`
    SELECT chat_id AS id, is_group,
           MAX(ts) AS last_message_at,
           (SELECT body FROM messages m2 WHERE m2.chat_id = m1.chat_id ORDER BY ts DESC LIMIT 1) AS last_snippet,
           COUNT(*) AS messages_count
      FROM messages m1
     WHERE chat_id != ''
     GROUP BY chat_id
     ORDER BY last_message_at DESC
  `).all();
}

export function stats() {
  if (!db) return { total: 0 };
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS latest FROM messages').get();
  return { total: r?.n || 0, latest: r?.latest || null };
}
