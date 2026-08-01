// whatsapp — the shared wa-gateway surface: sends, chats, groups, session.
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
//
// This is the ONE place WhatsApp is touched. Outreach, Prospecting and Nyo all
// call these tools instead of the daemon, and every tool here reaches it only
// through callGateway(env, 'whatsapp', mode, input) — no raw fetch, no second
// send path that could bypass the audit trail.
//
// Sends are outbox-audited inside lib/whatsapp.js (beginSend → markSent /
// markFailed, plus a wa_sent activity event), so a failed send leaves a visible
// failed row rather than a silent drop. Nothing here retries: a repeat send is
// an operator decision, never an automatic one.
//
// Workflow steps hand a tool the whole shared context, so every run() picks the
// exact keys it needs off `input` rather than forwarding it wholesale.

import { callGateway } from '../gateways/index.js';

export const tools = {
  // ── outbound ────────────────────────────────────────────────
  send_whatsapp: {
    def: {
      name: 'send_whatsapp',
      description: 'Send a WhatsApp text message. chatId can be a phone like "+972 50-302-3702", a canonical chat id like "972503023702@c.us", or a group id like "120363...@g.us". The session is primed automatically if it is asleep. Use find_wa_chat first when you only know the person by name.',
      input_schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'phone or canonical chatId' },
          text:   { type: 'string' },
        },
        required: ['chatId', 'text'],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'send', {
      chatId: input?.chatId, text: input?.text,
    }),
  },

  send_whatsapp_image: {
    def: {
      name: 'send_whatsapp_image',
      description: 'Send an image to a WhatsApp chat. The URL must be publicly fetchable from the machine running the WhatsApp gateway.',
      input_schema: {
        type: 'object',
        properties: {
          chatId:  { type: 'string', description: 'phone or canonical chatId' },
          url:     { type: 'string' },
          caption: { type: 'string' },
        },
        required: ['chatId', 'url'],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'send_image', {
      chatId: input?.chatId, url: input?.url, caption: input?.caption,
    }),
  },

  send_whatsapp_document: {
    def: {
      name: 'send_whatsapp_document',
      description: 'Send a document (PDF, deck, spreadsheet) to a WhatsApp chat. filename is what the recipient sees, so give it a sensible one.',
      input_schema: {
        type: 'object',
        properties: {
          chatId:   { type: 'string', description: 'phone or canonical chatId' },
          url:      { type: 'string' },
          filename: { type: 'string' },
          mimetype: { type: 'string', description: 'e.g. application/pdf' },
        },
        required: ['chatId', 'url', 'filename'],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'send_document', {
      chatId: input?.chatId, url: input?.url, filename: input?.filename, mimetype: input?.mimetype,
    }),
  },

  react_whatsapp: {
    def: {
      name: 'react_whatsapp',
      description: 'React to a WhatsApp message with an emoji. Use when the operator wants to acknowledge a message without writing a reply.',
      input_schema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'the waMessageId of the message to react to' },
          reaction:  { type: 'string', description: 'emoji, e.g. ❤️ 🔥 👍' },
        },
        required: ['messageId', 'reaction'],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'react', {
      messageId: input?.messageId, reaction: input?.reaction,
    }),
  },

  // ── reads ───────────────────────────────────────────────────
  list_wa_groups: {
    def: {
      name: 'list_wa_groups',
      description: 'List every WhatsApp group on the connected session, live from the gateway with the local cache as fallback. Each row carries id, name, participant_count (null when the gateway is unreachable), auto_listen, can_send, messages_count and last_message_at; `source` tells you whether it came from the gateway or the cache. Use it to find a group by name or to decide which groups the digest should follow.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => callGateway(env, 'whatsapp', 'groups', {}),
  },

  list_wa_chats: {
    def: {
      name: 'list_wa_chats',
      description: "List WhatsApp chats from the local cache (groups AND 1:1 DMs), optionally filtered. Use it to answer 'what chats are we watching', 'show active chats we don't follow yet', and similar surveys. To find one PERSON by name use find_wa_chat instead — DM chats usually have no stored name.",
      input_schema: {
        type: 'object',
        properties: {
          listening_only:     { type: 'boolean', description: 'only chats the digest follows (auto_listen=1)' },
          not_listening_only: { type: 'boolean', description: 'only chats the digest ignores (auto_listen=0)' },
          name_contains:      { type: 'string',  description: 'case-insensitive substring filter on chat name or id' },
          with_messages_only: { type: 'boolean', description: 'drop chats with no stored messages' },
          limit:              { type: 'number',  description: 'cap rows returned, default 50, max 500' },
        },
        required: [],
      },
    },
    run: async (env, input = {}) => {
      const all = await callGateway(env, 'whatsapp', 'chats', {});
      let rows = Array.isArray(all) ? all : [];
      if (input.listening_only)     rows = rows.filter((r) => !!r.auto_listen);
      if (input.not_listening_only) rows = rows.filter((r) => !r.auto_listen);
      if (input.with_messages_only) rows = rows.filter((r) => (r.messages_count || 0) > 0 || r.last_message_at);
      if (input.name_contains) {
        const q = String(input.name_contains).toLowerCase();
        rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.id || '').toLowerCase().includes(q));
      }
      // Most-recent first so the model sees the operator's live chats, not a
      // wall of dormant ones, when the cap bites.
      rows.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
      const cap = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 500);
      return {
        chats: rows.slice(0, cap),
        total_in_db: (Array.isArray(all) ? all : []).length,
        total_listening: (Array.isArray(all) ? all : []).filter((r) => r.auto_listen).length,
      };
    },
  },

  find_wa_chat: {
    def: {
      name: 'find_wa_chat',
      description: "Find a WhatsApp chat or person by partial name or phone — use this (NOT list_wa_chats) whenever the operator names a contact, e.g. 'I met David Kogan' or 'did I message Sarah'. WhatsApp barely names 1:1 DMs, so this searches chat names, sender pushnames AND the CRM by phone, token-based and case-insensitive. Returns ranked matches with chat_id, best-known name, phone, is_group, last_message_at and matched_on. No matches means the person isn't in the stored WhatsApp data or the CRM yet — ask the operator for a number.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'partial name or phone, e.g. "David Kogan" or "0545492444"' },
          limit: { type: 'number', description: 'max matches, default 15' },
        },
        required: ['query'],
      },
    },
    run: async (env, input) => ({
      query: input?.query,
      matches: await callGateway(env, 'whatsapp', 'search', { query: input?.query, limit: input?.limit ?? 15 }),
    }),
  },

  read_group_participants: {
    def: {
      name: 'read_group_participants',
      description: 'Read a WhatsApp group\'s participant roster — phone numbers, display names where known, admin flags. Use after list_wa_groups when you need to know exactly who is in a group. Needs the gateway session to be ready; returns an error otherwise.',
      input_schema: {
        type: 'object',
        properties: { groupId: { type: 'string', description: 'canonical group id, ends with @g.us' } },
        required: ['groupId'],
      },
    },
    run: async (env, input) => {
      // Steps upstream of this one name the key group_id; accept both spellings
      // so a threaded context doesn't have to be renamed to reach the roster.
      const groupId = input?.groupId || input?.group_id;
      const info = await callGateway(env, 'whatsapp', 'group_info', { group_id: groupId });
      // `raw` is the gateway's whole group blob — megabytes of member metadata
      // the caller never reads. Return the roster, not the dump.
      return {
        group_id: info?.id ?? groupId,
        name: info?.name ?? null,
        participant_count: info?.participant_count ?? (info?.participants || []).length,
        participants: info?.participants || [],
        auto_listen: info?.auto_listen ?? 0,
        can_send: info?.can_send ?? 0,
      };
    },
  },

  // ── chat policy ─────────────────────────────────────────────
  set_chat_listening: {
    def: {
      name: 'set_chat_listening',
      description: "Turn the digest's listener ON or OFF for one WhatsApp chat. Use whenever the operator says 'follow the X group', 'watch X', 'add X to the digest', 'unfollow X' or 'stop watching X'. Pass chat_id when you know it, otherwise name_match. If name_match hits several chats nothing is changed and the candidates come back — ask the operator which one, then call again with chat_id.",
      input_schema: {
        type: 'object',
        properties: {
          chat_id:    { type: 'string',  description: 'canonical chat id ending in @c.us or @g.us; preferred when known' },
          name_match: { type: 'string',  description: 'substring of the chat name (case-insensitive); used only when chat_id is omitted' },
          listening:  { type: 'boolean', description: 'true = follow / start listening, false = unfollow / stop listening' },
        },
        required: ['listening'],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'set_listening', {
      chat_id: input?.chat_id, name_match: input?.name_match, listening: !!input?.listening,
    }),
  },

  // ── session + cache maintenance ─────────────────────────────
  restart_wa_session: {
    def: {
      name: 'restart_wa_session',
      description: 'Bounce the WhatsApp session — stop it, start it, poll until it reports ready. Use when sends fail, the session wedges, or history pulls hang. No QR re-scan is needed if the session was linked before. Returns the new status, or errors after ~25s.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => callGateway(env, 'whatsapp', 'restart', {}),
  },

  backfill_wa_messages: {
    def: {
      name: 'backfill_wa_messages',
      description: 'Pull recent history the WhatsApp gateway holds into the local message cache so the digest, threads and funnel have data to read. Use right after a QR-link or when the operator says no messages are flowing. Deduped on message id, so re-running is safe. Without chatId it covers every chat the digest follows.',
      input_schema: {
        type: 'object',
        properties: {
          limit:  { type: 'number', description: 'max messages per chat (default 50)' },
          chatId: { type: 'string', description: 'optional — narrow to one chat' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const r = await callGateway(env, 'whatsapp', 'backfill_messages', {
        limit: input?.limit, chatId: input?.chatId || null,
      });
      // Everything fetched but not inserted was already cached — reporting it as
      // `skipped` is what tells the operator "nothing new" apart from "nothing came back".
      return {
        inserted: r?.inserted ?? 0,
        skipped: Math.max(0, (r?.fetched ?? 0) - (r?.inserted ?? 0)),
        fetched: r?.fetched ?? 0,
        chats_scanned: r?.chats_scanned ?? 0,
        per_chat: r?.per_chat ?? {},
        warning: r?.warning ?? null,
      };
    },
  },

  backfill_lid_map: {
    def: {
      name: 'backfill_lid_map',
      description: 'Resolve outbound WhatsApp @lid (privacy-id) chats to real phone numbers and cache them, so lead↔chat matching knows you already messaged someone on a lid chat. Fixes people showing as "not contacted" in GTM and the KPI. Runs hourly on its own; call it to refresh now.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'max lids to resolve this call (default 50)' } },
        required: [],
      },
    },
    run: async (env, input) => callGateway(env, 'whatsapp', 'backfill_lids', { limit: input?.limit || 50 }),
  },
};
