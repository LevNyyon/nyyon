// Map a whatsapp-web.js Message into the object both consumers parse. The
// emitter puts THIS object under BOTH the envelope's `data` key (another client reads
// `payload.data`) and its `payload` key (Nyo reads `raw.payload`). Timestamp
// stays in SECONDS (OpenWA convention; both apps convert to ms). The field set
// is the union of what another client's `normalise` and Nyo's `normalizePayload` read.
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // ~8MB; bigger files travel as a stub

export async function fromMessage(msg) {
  const fromMe = !!msg.fromMe;
  // For our own sends the chat is the recipient (`to`), not `from` (= us).
  const chatId = fromMe ? msg.to || msg.from || '' : msg.from || '';
  const isGroup = String(chatId).endsWith('@g.us');
  const notifyName = msg._data?.notifyName || undefined;
  // In a group the real sender is the participant (author); in a DM it's `from`.
  const senderId = isGroup ? msg.author || undefined : msg.author || msg.from || undefined;

  const data = {
    id: msg.id?._serialized,
    messageId: msg.id?._serialized, // Nyo reads messageId as an id fallback
    from: msg.from || '',
    to: msg.to || '',
    chatId,
    body: msg.body || '',
    type: msg.type || 'chat',
    timestamp: msg.timestamp, // seconds
    fromMe,
    isGroup,
    author: msg.author || undefined, // group participant id
    notifyName,
    senderName: notifyName,
    pushName: notifyName,
    sender: { id: senderId, formattedName: notifyName, pushname: notifyName },
  };

  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const bytes = Math.floor((media.data.length * 3) / 4);
        data.media =
          bytes <= MAX_MEDIA_BYTES
            ? { mimetype: media.mimetype, data: media.data, filename: media.filename || undefined }
            : { mimetype: media.mimetype, filename: media.filename || undefined, omitted: 'too_large', bytes };
      }
    } catch {
      /* media download can fail; still deliver the text envelope */
    }
  }

  if (msg.hasQuotedMsg) {
    try {
      const q = await msg.getQuotedMessage();
      data.quotedMessage = { id: q.id?._serialized, body: q.body || '' };
    } catch {}
  }

  return data;
}

// Fallback when the rich build throws (e.g. a getter blew up): a minimal
// envelope so the message still gets delivered.
export function minimal(msg) {
  const fromMe = !!msg.fromMe;
  const chatId = fromMe ? msg.to || msg.from || '' : msg.from || '';
  return {
    id: msg.id?._serialized,
    messageId: msg.id?._serialized,
    from: msg.from || '',
    to: msg.to || '',
    chatId,
    body: msg.body || '',
    type: msg.type || 'chat',
    timestamp: msg.timestamp,
    fromMe,
    isGroup: String(chatId).endsWith('@g.us'),
    author: msg.author || undefined,
  };
}
