// Digest plugin — watch_wa_chat. NEW tool: flip a chat's auto_listen flag
// through the whatsapp gateway's set_listening mode (wa_chats is read-only
// for plugins; the gateway is the sanctioned write path).

export const def = {
  name: 'watch_wa_chat',
  description: 'Follow or unfollow one WhatsApp chat for the digest (auto_listen). Followed chats are what the WhatsApp channel scans. Pass the chat id (preferred) or a name_match.',
  input_schema: {
    type: 'object',
    properties: {
      chat_id:    { type: 'string', description: 'the stable chat id (…@g.us / …@c.us)' },
      name_match: { type: 'string', description: 'fallback: match the chat by name' },
      listening:  { type: 'boolean' },
    },
    required: ['listening'],
  },
};

export async function run(api, input) {
  const r = await api.gateway('whatsapp', 'set_listening', {
    chat_id: input.chat_id || undefined,
    name_match: input.name_match || undefined,
    listening: !!input.listening,
  });
  await api.log('chat_watch_toggled', { chat_id: input.chat_id || null, name_match: input.name_match || null, listening: !!input.listening });
  return r && typeof r === 'object' ? r : { ok: true };
}
