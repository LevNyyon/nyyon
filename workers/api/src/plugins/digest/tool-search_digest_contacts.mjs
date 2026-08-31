// Digest plugin — search_digest_contacts. NEW tool for the drawer's "DM
// another contact" picker (cmd used GET /api/contacts?search=). contacts is
// a declared SELECT-only host read; writes go through the crm gateway.

export const def = {
  name: 'search_digest_contacts',
  description: 'Search the CRM contacts by name, email, or phone for the digest composer\'s recipient picker. Returns id, full_name, phone, email, linkedin_url (max `limit`, default 15).',
  input_schema: {
    type: 'object',
    properties: {
      search: { type: 'string' },
      limit:  { type: 'number', description: 'default 15' },
    },
    required: ['search'],
  },
};

export async function run(api, input) {
  const q = '%' + String(input.search || '').trim() + '%';
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 15));
  const r = await api.db.prepare(
    `SELECT id, full_name, phone, email, linkedin_url, status FROM contacts
      WHERE full_name LIKE ? OR email LIKE ? OR phone LIKE ?
      ORDER BY updated_at DESC LIMIT ?`,
  ).bind(q, q, q, limit).all();
  return { contacts: r.results || [] };
}
