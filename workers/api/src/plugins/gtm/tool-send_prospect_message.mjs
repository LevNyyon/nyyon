// GTM plugin — send_prospect_message. The Conversations composer's "send now".
// In the host this was POST /api/wa/send → the shared send_whatsapp tool
// (WhatsApp module — it STAYS in the host). The plugin cannot call host tools,
// so the pack carries its own one-job send: one text to one chat through the
// whatsapp gateway. The outbox audit and the wa_messages pre-insert (which is
// what makes the thread show the send at once) both live INSIDE the host
// gateway's send mode, so the guarantees are unchanged. Result shape matches
// the old route: {messageId, timestamp, chatId, outbox_id} or {error}.

export const def = {
  name: 'send_prospect_message',
  description: 'Send ONE WhatsApp text to a prospect conversation, immediately, through the outbox-audited gateway send. This is the operator\'s own "send now" — the words are exactly what was passed, nothing is drafted or rewritten here. Use schedule_send to queue instead of sending.',
  input_schema: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: 'WhatsApp chat id, e.g. 15551234567@c.us' },
      text: { type: 'string' },
    },
    required: ['chatId', 'text'],
  },
};

export async function run(api, input) {
  const chatId = String(input?.chatId || '').trim();
  const text = String(input?.text || '').trim();
  if (!chatId || !text) return { error: 'chatId and text are required' };
  try {
    // Outbox row + wa_messages pre-insert happen inside the gateway.
    const r = await api.gateway('whatsapp', 'send', { chatId, text });
    await api.log('outreach_message_sent', { chat_id: chatId, outbox_id: r?.outbox_id || null });
    return r;
  } catch (e) {
    // The old route answered {error} rather than throwing — keep that contract
    // so the composer shows the failure inline instead of a dead promise.
    return { error: String(e?.message || e) };
  }
}
