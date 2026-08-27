// TTS gateway — the boundary to the local Piper TTS daemon (one service).
//
// TTS_BASE_URL points at the tunneled gateway (your TTS tunnel hostname); the
// optional TTS_API_KEY rides as X-API-Key. No reasoning here: text in, WAV
// stream out. The /api/nyo/tts route is a thin caller.

import { withResolvedCredentials } from './gateway-config.js';

export function ttsConfigured(env) {
  return !!(env.TTS_BASE_URL || '').trim();
}

// Returns the upstream fetch Response (audio/wav body) so the route can
// stream it straight through without buffering.

export async function synthesize(env, { text, length_scale = 0.95 } = {}) {
  env = await withResolvedCredentials(env); // TTS_BASE_URL/TTS_API_KEY may live in D1
  const base = (env.TTS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('voice not configured (TTS_BASE_URL unset)');
  const t = String(text || '').trim();
  if (!t) throw new Error('empty text');
  return fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.TTS_API_KEY ? { 'X-API-Key': env.TTS_API_KEY } : {}) },
    body: JSON.stringify({ text: t.slice(0, 2000), length_scale }),
    signal: AbortSignal.timeout(30_000),
  });
}
