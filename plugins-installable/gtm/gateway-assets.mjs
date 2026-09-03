// Binary asset storage is a host capability (object storage) that plugins do
// not receive. Prospecting works without it; only stored files are off.
export const gateway = {
  slug: 'assets',
  service: 'binary asset storage (not available on this install)',
  description: 'Reports honestly that file storage is off.',
  modes: { store: async () => ({ ok: false, error: 'File storage is not available to this plugin on this install.' }) },
};
