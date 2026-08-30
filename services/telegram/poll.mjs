#!/usr/bin/env node
// Telegram long-poll bridge — the only inbound path for Nyo's Telegram line.
//
// Workers cannot hold a long-poll open, so this tiny service does: it asks
// api.telegram.org for updates (50s holds, zero traffic when quiet) and hands
// each one to the worker at /api/telegram/inbound, authenticated with the
// install's TELEGRAM_INBOUND_KEY. It keeps no state beyond the update offset,
// reads its config straight from the worker's .dev.vars, and survives every
// error by backing off — systemd (or the desktop shell) just keeps it alive.
//
// No token configured = sleep and re-check, so the service can run from first
// boot and come alive the moment the operator pastes a bot token.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_PORT = process.env.NYYON_API_PORT || '8799';
const INBOUND = `http://127.0.0.1:${API_PORT}/api/telegram/inbound`;
const DEV_VARS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workers', 'api', '.dev.vars');

function readVars() {
  const vars = {};
  try {
    for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) vars[m[1]] = m[2];
    }
  } catch { /* not created yet — setup hasn't run */ }
  return vars;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let offset = 0;

console.log(`[telegram-poll] up — delivering to ${INBOUND}`);
for (;;) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_INBOUND_KEY: key } = readVars();
  if (!token || !key) { await sleep(30_000); continue; }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=50&offset=${offset}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    const j = await res.json();
    if (!j.ok) {
      // 409 = another consumer (a stale webhook or second poller) — loud, then wait.
      console.error('[telegram-poll] getUpdates:', j.description || res.status);
      await sleep(15_000);
      continue;
    }
    for (const update of j.result || []) {
      offset = update.update_id + 1;
      try {
        const r = await fetch(INBOUND, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) console.error('[telegram-poll] inbound', r.status, await r.text().catch(() => ''));
      } catch (e) {
        console.error('[telegram-poll] worker unreachable:', e?.message || e);
        await sleep(5_000);
      }
    }
  } catch (e) {
    console.error('[telegram-poll]', e?.message || e);
    await sleep(10_000);
  }
}
