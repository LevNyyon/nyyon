// LinkedIn company and jobs lookups need a signed-in LinkedIn session running
// as a separate service. This install carries none, so every call reports one
// sentence instead of failing oddly. If a LinkedIn plugin is installed later
// its gateway takes over by the same slug.
const OFF = {
  ok: false,
  error: 'LinkedIn lookups are not available on this install. They need a LinkedIn connection running as its own service.',
};
export const gateway = {
  slug: 'linkedin',
  service: 'LinkedIn company and jobs (not available on this install)',
  description: 'Reports honestly that LinkedIn lookups are off.',
  modes: { company: async () => OFF, company_jobs: async () => OFF },
};
