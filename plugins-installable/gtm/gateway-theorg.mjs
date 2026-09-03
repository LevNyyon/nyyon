// Org-chart lookups came from a scraping service running beside the app. Not
// on this install; every call says so.
const OFF = { ok: false, error: 'Org chart lookups are not available on this install.' };
export const gateway = {
  slug: 'theorg',
  service: 'org charts (not available on this install)',
  description: 'Reports honestly that org chart lookups are off.',
  modes: { org_chart: async () => OFF, probe: async () => ({ ok: false, connected: false, error: OFF.error }) },
};
