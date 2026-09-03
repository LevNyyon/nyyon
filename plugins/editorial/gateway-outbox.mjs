// The pack's own outbox: every outbound attempt is recorded here so a failed
// send is visible instead of silent. Pack-local table, no host dependency.
export const gateway = {
  slug: 'outbox',
  service: 'this pack\'s outbound record (plugin_editorial_outbox)',
  description: 'Records outbound attempts and their outcome.',
  modes: {
    begin: async (api, input) => {
      const id = 'ob_' + Math.abs(Date.now() ^ (Math.random() * 1e9 | 0)).toString(36);
      try {
        await api.DB.prepare(
          'INSERT INTO plugin_editorial_outbox (id, kind, target, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(id, String(input?.kind || 'unknown'), String(input?.target || ''), JSON.stringify(input?.payload ?? {}), 'pending', Date.now(), Date.now()).run();
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
      return { ok: true, id };
    },
    sent: async (api, input) => {
      try {
        await api.DB.prepare('UPDATE plugin_editorial_outbox SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
          .bind('sent', JSON.stringify(input?.result ?? {}), Date.now(), String(input?.id || '')).run();
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
      return { ok: true };
    },
    failed: async (api, input) => {
      try {
        await api.DB.prepare('UPDATE plugin_editorial_outbox SET status = ?, error = ?, updated_at = ? WHERE id = ?')
          .bind('failed', String(input?.error || 'unknown').slice(0, 500), Date.now(), String(input?.id || '')).run();
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
      return { ok: true };
    },
  },
};
