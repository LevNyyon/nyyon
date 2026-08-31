// GTM plugin lib — outreach thread stats. Ported from
// workers/api/src/lib/outreach-threads.js: the "did they reply, is it a real
// conversation, is there a reply I haven't caught, how did they feel" layer
// behind the Digest KPI drawer. One row per conversation (WhatsApp chat_id or
// LinkedIn conversation_urn) in plugin_gtm_outreach_threads, refreshed from the
// messages we already have (wa_messages is a declared host READ). Sentiment is
// scored on the LATEST inbound message through the `llm` gateway (writer_small
// tier) and cached — re-scored only when a newer inbound arrives, against the
// editable `plugin-gtm-outreach-sentiment` knowledge doc. Everything logs; the
// model is reached only via the gateway.
//
// Lib contract: no imports; every exported function takes `api` first.

const waMs = (t) => (t == null ? null : (Number(t) < 1e12 ? Number(t) * 1000 : Number(t)));

// ── sentiment rubric — editable knowledge doc (same pattern as the
// outreach-signature rubric in outreach-classify.mjs) so the operator can
// sharpen "what counts as negative" without a deploy.
const SENT_SLUG = 'plugin-gtm-outreach-sentiment';

const SENTIMENT_DEFAULT = `How to score a prospect's reply to our cold outreach:
- positive — warm, interested, thankful, asks a question back, wants to talk.
- neutral — genuinely open/undecided: polite acknowledgement with no lean either way, a logistics question, "let me think about it", "circle back in a few months" with no rejection attached.
- negative — ANY decline or rejection, even when phrased politely or briefly. This includes: "not interested", "not for me", "no thanks", "not right now" (as a brush-off, not a real future intent), "please stop messaging me", "remove me", ignoring the pitch to complain, or a reply that is clearly trying to end the conversation rather than continue it.

The single most common mistake is calling a POLITE rejection "neutral" just because the wording is soft. Politeness is a tone, not a signal of openness — judge the actual decision being communicated, not how nicely it's phrased. "Thanks but not interested" and "not interested, thanks" are BOTH negative, not neutral.

Judge tone in Hebrew or English. Some Hebrew phrasings that are NEGATIVE (not neutral) even though they read as polite: "לא מעוניין/ת", "לא רלוונטי כרגע" (when used as a brush-off), "תוריד/י אותי מהרשימה", "תפסיק/י לשלוח לי", "לא בשבילי".`;

function sentimentSeedBody(rubric) {
  return `Outreach sentiment — the rubric used to score how a prospect feels in their reply, for the Digest KPI drawer.

Scored on the LATEST inbound message per thread, cached until a newer inbound arrives. Edit this note to tune what counts as negative vs neutral — e.g. add phrasings from your market that read as a polite decline. Changes apply to newly-scored replies with no deploy.

---
${rubric}
`;
}

// writer_small tier from the host `llm-models` doc (a declared host knowledge
// read). Plugins see no env vars, so the doc value falls straight back to the
// coded default (the host's own default) instead of ANTHROPIC_SMALL_MODEL.
const WRITER_SMALL_DEFAULT = 'claude-haiku-4-5-20251001';
function cleanModelId(v) {
  const s = String(v ?? '').trim();
  return s && s.length <= 120 && !/\s{2,}|\n/.test(s) ? s : null;
}
async function writerSmallModel(api) {
  try {
    const doc = await api.knowledge('llm-models');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    return cleanModelId(src.writer_small) || WRITER_SMALL_DEFAULT;
  } catch {
    return WRITER_SMALL_DEFAULT;
  }
}

export async function loadSentimentRubric(api) {
  try {
    const doc = await api.knowledge(SENT_SLUG);
    if (!doc) {
      await api.saveKnowledge(SENT_SLUG, {
        title: 'Outreach · sentiment rubric (Digest)',
        body: sentimentSeedBody(SENTIMENT_DEFAULT),
      }).catch(() => {});
      return { rubric: SENTIMENT_DEFAULT, source: 'defaults' };
    }
    const body = String(doc.body || '');
    const idx = body.indexOf('\n---\n');
    return { rubric: (idx >= 0 ? body.slice(idx + 5) : body).trim() || SENTIMENT_DEFAULT, source: 'doc' };
  } catch {
    return { rubric: SENTIMENT_DEFAULT, source: 'defaults' };
  }
}

export async function saveSentimentRubric(api, rubric) {
  const clean = String(rubric || '').trim() || SENTIMENT_DEFAULT;
  await api.saveKnowledge(SENT_SLUG, {
    title: 'Outreach · sentiment rubric (Digest)',
    body: sentimentSeedBody(clean),
  });
  await api.log('outreach_sentiment_rubric_updated', { chars: clean.length });
  return { rubric: clean, source: 'doc' };
}

// ── sentiment: score how the prospect FEELS in their reply ──────────────────
async function scoreSentiment(api, items) { // items: [{ key, text }]
  const map = new Map();
  if (!items.length) return map;
  const model = await writerSmallModel(api);
  const { rubric } = await loadSentimentRubric(api);
  const system = `You score how a prospect FEELS in their reply to our cold outreach, for a sales dashboard. For each numbered reply, classify the sentiment as positive, neutral, or negative.

${rubric}

Return STRICT JSON: {"scores":[{"i":<number>,"s":"positive|neutral|negative","why":"<=5 words"}]}`;
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    const prompt = chunk.map((it, n) => `[${n}] ${String(it.text || '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n');
    let raw;
    try { raw = await api.gateway('llm', 'text', { system, prompt, model, max_tokens: Math.min(2000, 300 + chunk.length * 40), heavy: false }); }
    catch { continue; }
    const s = String(raw || '');
    const re = /"i"\s*:\s*(\d+)[\s\S]{0,40}?"s"\s*:\s*"(positive|neutral|negative)"(?:[\s\S]{0,24}?"why"\s*:\s*"([^"]{0,80})")?/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const it = chunk[Number(m[1])];
      if (it) map.set(it.key, { sentiment: m[2], reason: (m[3] || '').slice(0, 80) });
    }
  }
  return map;
}

async function upsertThread(api, row) {
  const t = Date.now();
  await api.db.prepare(
    `INSERT INTO plugin_gtm_outreach_threads (key, channel, name, replied, uncaught, msgs_in, msgs_out, last_inbound_text, last_inbound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name=excluded.name, replied=excluded.replied, uncaught=excluded.uncaught,
       msgs_in=excluded.msgs_in, msgs_out=excluded.msgs_out,
       last_inbound_text=excluded.last_inbound_text, last_inbound_at=excluded.last_inbound_at,
       updated_at=excluded.updated_at`,
  ).bind(row.key, row.channel, row.name || null, row.replied, row.uncaught, row.msgs_in || 0, row.msgs_out || 0,
    row.last_inbound_text || null, row.last_inbound_at || 0, t).run().catch(() => {});
}

async function scoreAndStore(api, needScore) {
  if (!needScore.length) return 0;
  const scores = await scoreSentiment(api, needScore);
  let n = 0;
  for (const it of needScore) {
    const sc = scores.get(it.key);
    if (!sc) continue;
    await api.db.prepare(
      'UPDATE plugin_gtm_outreach_threads SET sentiment=?, sentiment_reason=?, sentiment_at=? WHERE key=?',
    ).bind(sc.sentiment, sc.reason, it.at || 0, it.key).run().catch(() => {});
    n++;
  }
  if (n) await api.log('outreach_sentiment_scored', { n });
  return n;
}

// ── LinkedIn: refresh from the daemon's per-conversation threads summary ─────
export async function refreshLiThreads(api, threads = []) {
  if (!Array.isArray(threads) || !threads.length) return 0;
  const needScore = [];
  for (const th of threads) {
    const key = th.conversation_urn;
    if (!key) continue;
    const replied = (th.msgs_in || 0) > 0 ? 1 : 0;
    // uncaught = they have unread messages for us, OR they replied and the last
    // message in the thread is theirs (we haven't answered since).
    const uncaught = ((th.unread_count || 0) > 0 || (replied && !th.last_from_me)) ? 1 : 0;
    const ex = await api.db.prepare('SELECT sentiment_at FROM plugin_gtm_outreach_threads WHERE key=?').bind(key).first().catch(() => null);
    await upsertThread(api, {
      key, channel: 'linkedin', name: th.name, replied, uncaught,
      msgs_in: th.msgs_in, msgs_out: th.msgs_out,
      last_inbound_text: th.last_inbound_text, last_inbound_at: th.last_inbound_at || 0,
    });
    if (replied && th.last_inbound_text && (!ex || ex.sentiment_at !== (th.last_inbound_at || 0))) {
      needScore.push({ key, text: th.last_inbound_text, at: th.last_inbound_at || 0 });
    }
  }
  await scoreAndStore(api, needScore);
  return threads.length;
}

// ── WhatsApp: refresh from wa_messages for the given outreach chats ──────────
export async function refreshWaThreads(api, chats = []) { // chats: [{ key(chat_id), name }]
  const needScore = [];
  // Only messages with REAL text count. WhatsApp stores empty-body from_me=0
  // rows (delivery/read receipts, echoes) — often at the exact timestamp of our
  // own outbound — which must NOT be mistaken for a reply.
  const HAS_TEXT = "body IS NOT NULL AND length(trim(body)) > 0";
  for (const chat of chats) {
    const key = chat.key;
    if (!key) continue;
    const agg = await api.db.prepare(
      `SELECT SUM(CASE WHEN from_me=1 THEN 1 ELSE 0 END) AS out_n,
              SUM(CASE WHEN from_me=0 THEN 1 ELSE 0 END) AS in_n
       FROM wa_messages WHERE chat_id=? AND ${HAS_TEXT}`,
    ).bind(key).first().catch(() => null);
    // latest REAL inbound vs latest REAL outbound — uncaught only if they spoke last
    const lastIn = await api.db.prepare(`SELECT body, timestamp FROM wa_messages WHERE chat_id=? AND from_me=0 AND ${HAS_TEXT} ORDER BY timestamp DESC LIMIT 1`).bind(key).first().catch(() => null);
    const lastOut = await api.db.prepare(`SELECT timestamp FROM wa_messages WHERE chat_id=? AND from_me=1 AND ${HAS_TEXT} ORDER BY timestamp DESC LIMIT 1`).bind(key).first().catch(() => null);
    const replied = (agg?.in_n || 0) > 0 ? 1 : 0;
    const lastInAt = lastIn ? waMs(lastIn.timestamp) : 0;
    const lastOutAt = lastOut ? waMs(lastOut.timestamp) : 0;
    const uncaught = (replied && lastInAt > lastOutAt) ? 1 : 0;
    const ex = await api.db.prepare('SELECT sentiment_at FROM plugin_gtm_outreach_threads WHERE key=?').bind(key).first().catch(() => null);
    await upsertThread(api, {
      key, channel: 'whatsapp', name: chat.name, replied, uncaught,
      msgs_in: agg?.in_n || 0, msgs_out: agg?.out_n || 0,
      last_inbound_text: lastIn?.body || null, last_inbound_at: lastInAt,
    });
    if (replied && lastIn?.body && (!ex || ex.sentiment_at !== lastInAt)) needScore.push({ key, text: lastIn.body, at: lastInAt });
  }
  await scoreAndStore(api, needScore);
  return chats.length;
}

// ── read: stats for a set of conversation keys (for the drawer) ─────────────
export async function getThreadStats(api, keys = []) {
  const out = new Map();
  const uniq = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 90) {
    const c = uniq.slice(i, i + 90);
    const r = (await api.db.prepare(
      `SELECT key, channel, replied, uncaught, msgs_in, msgs_out, sentiment, sentiment_reason, last_inbound_text, last_inbound_at
       FROM plugin_gtm_outreach_threads WHERE key IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const row of r) out.set(row.key, row);
  }
  return out;
}
