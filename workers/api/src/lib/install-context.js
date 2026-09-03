// "This install right now" — Nyo's situational grounding (composed per turn).
//
// A usable Nyo knows where it lives: which modules are actually installed,
// whether the operator has done the interview, whether the voice docs exist,
// and what has been happening. Composed fresh from D1 on every conversation
// turn and welded into the system prompt, so Nyo never answers from a
// training-data memory of some other install. Cheap: three small queries.
// Never throws — grounding degrades to nothing rather than killing chat.

const VOICE_SLUGS = ['writing-style-rules', 'brand-voice', 'personal-voice'];

export async function composeInstallContext(env) {
  try {
    const [install, plugins, voice, events] = await Promise.all([
      import('./install.js').then((m) => m.readInstallState(env)).catch(() => null),
      env.DB.prepare(`SELECT name, status FROM plugins ORDER BY name`).all().then((r) => r.results || []).catch(() => []),
      env.DB.prepare(`SELECT slug FROM knowledge_docs WHERE slug IN ('${VOICE_SLUGS.join("','")}') AND length(trim(body)) > 40`).all().then((r) => (r.results || []).map((x) => x.slug)).catch(() => []),
      env.DB.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM events WHERE created_at > ?`).bind(Date.now() - 86400000).first().catch(() => null),
    ]);

    const lines = ['## This install right now (live, trust this over memory)'];

    const missing = VOICE_SLUGS.filter((v) => !voice.includes(v));
    if (install && !install.setup_complete) {
      lines.push(`- Setup: the interview has NOT been done. Voice docs missing: ${missing.join(', ') || 'none'}. This system has no voice of its own yet — anything you draft is generic. When the operator asks for drafted copy, voice work, or anything meant to sound like them, say so plainly and point them at the **finish with Nyo** banner (it opens the interview). Nudge naturally and at most once per conversation; never block an answer on it.`);
    } else if (missing.length) {
      lines.push(`- Voice docs missing or empty: ${missing.join(', ')}. Drafting reads whatever voice docs exist; mention the gap when it matters.`);
    } else {
      lines.push('- Setup complete; voice docs present.');
    }

    const active = plugins.filter((p) => p.status === 'active').map((p) => p.name);
    const broken = plugins.filter((p) => p.status !== 'active').map((p) => `${p.name} (${p.status})`);
    lines.push(`- Modules installed: ${active.join(', ') || 'none'}${broken.length ? ` — needs attention: ${broken.join(', ')}` : ''}. Their tools are in your pool; anything else is NOT on this install (it may exist as an installable plugin — the Plugins page).`);

    if (events?.n) {
      lines.push(`- Activity: ${events.n} event${events.n === 1 ? '' : 's'} in the last 24h (list_events for the trail).`);
    } else {
      lines.push('- Activity: quiet — no events in the last 24h.');
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}
