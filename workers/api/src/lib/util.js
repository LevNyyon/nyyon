export function uid() {
  return crypto.randomUUID();
}
export function now() {
  return Date.now();
}
export function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// Numeric HTML character references, decimal and hex.
//
// Feeds write the same character several ways — &#39; &#039; &#x27; are all an
// apostrophe — so a fixed list of entities is a losing game: a zero-padded
// &#039; slipped through one and got stored verbatim in signal titles.
// Decoding by VALUE covers every padding and every codepoint at once.
//
// fromCodePoint, not fromCharCode: the latter truncates anything above
// U+FFFF, turning an emoji or a rare glyph into a broken character rather
// than leaving it alone. An unparseable reference is returned untouched —
// mangling text is worse than leaving an entity visible.
export function decodeNumericEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}
