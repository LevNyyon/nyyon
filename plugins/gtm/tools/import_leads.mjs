// GTM plugin — import_leads. The host had no tool for this: POST /api/gtm/import
// called lib importLeads directly. Result is the import summary flat (the shape
// the surface reads as GtmImportResult): { total, valid, invalid, duplicates,
// created, batch_id, via, source }. batch_id is null when nothing was created.

import { importLeads } from './gtm.mjs';

export const def = {
  name: 'import_leads',
  description: 'Import a phone list as a new batch: paste text (one number per line, or a CSV with a "phone" column) or give a URL to fetch. Numbers are normalized, deduplicated against every existing lead, and located off the phone prefix (country/region). Returns the tallies and the new batch_id (null when every number was invalid or already known).',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'pasted numbers or CSV text' },
      url: { type: 'string', description: 'a URL to fetch the list from (takes precedence over text)' },
      source: { type: 'string', description: 'where this list came from — the batch label' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return importLeads(api, { text: input?.text, url: input?.url, source: input?.source });
}
