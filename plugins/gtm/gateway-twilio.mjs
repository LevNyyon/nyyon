// Boundary to ONE service: Twilio Lookup (is this number real, what carrier).
// Account SID and auth token live in the pack's own table.
async function creds(api) {
  const r = await api.DB.prepare("SELECT name, value FROM plugin_gtm_connections WHERE name IN ('twilio_sid','twilio_token')").all().catch(() => null);
  const map = Object.fromEntries((r?.results || []).map((x) => [x.name, x.value]));
  return map.twilio_sid && map.twilio_token ? { sid: map.twilio_sid, token: map.twilio_token } : null;
}
export const gateway = {
  slug: 'twilio',
  service: 'Twilio Lookup (lookups.twilio.com)',
  description: 'Phone number validation. Needs a Twilio account SID and auth token.',
  modes: {
    status: async (api) => ({ connected: !!(await creds(api)), label: 'Twilio Lookup' }),
    lookup: async (api, input) => {
      const c = await creds(api);
      if (!c) return { ok: false, error: 'Twilio is not connected. Paste the account SID and auth token to Nyo.' };
      const phone = String(input?.phone || input?.number || '').trim();
      if (!phone) return { ok: false, error: 'phone required' };
      try {
        const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}`, {
          signal: AbortSignal.timeout(20000),
          headers: { Authorization: 'Basic ' + btoa(`${c.sid}:${c.token}`) },
        });
        const text = await r.text();
        let d = null; try { d = JSON.parse(text); } catch { /* not json */ }
        if (!r.ok) return { ok: false, error: String(d?.message || `HTTP ${r.status}`).slice(0, 200) };
        return { ok: true, phone: d?.phone_number || phone, valid: !!d?.valid, country: d?.country_code || null, type: d?.line_type_intelligence?.type || null };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
  },
};
