// Digest plugin — list_watched_chats. NEW tool for the digest's
// followed-chats panel (cmd used GET /api/wa/chats). wa_chats is a declared
// SELECT-only host read; the follow toggle goes through the whatsapp
// gateway (watch_wa_chat).

export const def = {
  name: 'list_watched_chats',
  description: 'List WhatsApp chats with their follow state (auto_listen) and last activity — the digest only pulls from followed chats. Use to answer "which chats feed my brief?" before following/unfollowing one.',
  input_schema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'default 500' } },
    required: [],
  },
};

export async function run(api, input) {
  const limit = Math.max(1, Math.min(1000, Number(input?.limit) || 500));
  const r = await api.db.prepare(
    `SELECT id, name, is_group, auto_listen, last_message_at FROM wa_chats
      ORDER BY COALESCE(last_message_at, 0) DESC LIMIT ?`,
  ).bind(limit).all();
  return { chats: r.results || [] };
}
