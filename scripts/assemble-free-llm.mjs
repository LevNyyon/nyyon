import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const PACK = '/Users/levkerzhner/Dev/nyyon-app/plugins/free-llm';
const toolFiles = readdirSync(join(PACK, 'tools')).filter((f) => f.endsWith('.mjs')).sort();
const tools = [];
for (const f of toolFiles) {
  const mod = await import(join(PACK, 'tools', f));
  const name = f.replace(/\.mjs$/, '');
  if (mod.def?.name !== name) throw new Error(`def mismatch in ${f}`);
  tools.push({ name, code_file: `tools/${f}`, def: mod.def });
}
const manifest = {
  nyyon_plugin: 2,
  name: 'free-llm',
  title: 'Free LLM',
  version: '1.0.0',
  description: 'A backup brain. Connect a free model provider (Groq or Cloudflare Workers AI) and Nyo keeps working when the main model has no key or no credit. Ships its own gateway, its own key store, and its own page.',
  icon: 'Sparkle',
  origin: { system: 'nyyon-app' },
  requires: {
    // It needs a backup-llm gateway AND brings its own: the host has no such
    // boundary, so the binder resolves this to the bundled implementation.
    gateways: [{ slug: 'backup-llm', modes: ['chat', 'status', 'probe'], purpose: 'reach the free provider over its OpenAI-compatible endpoint' }],
    tables: [{
      name: 'plugin_free_llm_config',
      ddl: 'CREATE TABLE IF NOT EXISTS plugin_free_llm_config (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT, account_id TEXT, updated_at INTEGER NOT NULL)',
    }],
  },
  provides: {
    gateways: [{
      slug: 'backup-llm',
      modes: ['chat', 'status', 'probe'],
      capability: 'llm-backup',
      code_file: 'gateway-backup-llm.mjs',
    }],
    tools,
    workflows: [],
    knowledge: [],
    surfaces: [{
      slug: 'free-llm',
      title: 'Free LLM',
      icon: 'Sparkle',
      page_file: 'surface/free-llm.tsx',
      files: [{ path: 'data.ts', code_file: 'surface/data.ts' }],
    }],
  },
};
writeFileSync(join(PACK, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest:', tools.length, 'tools, 1 gateway, 1 table, 1 surface');
