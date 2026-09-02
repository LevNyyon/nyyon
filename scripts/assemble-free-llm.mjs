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
const GW_MODES = ['discover', 'status', 'probe', 'chat'];
const manifest = {
  nyyon_plugin: 2,
  name: 'free-llm',
  title: 'Free LLM',
  version: '2.1.0',
  description: 'A backup brain on Groq: free, no card, fast (tight per-minute limits). Nyo uses it whenever the main model has no key or no credit. Other providers — like Gemini — install as their own plugins; the host discovers every backup brain by capability, never by name.',
  icon: 'Sparkle',
  origin: { system: 'nyyon-app' },
  requires: {
    gateways: [
      { slug: 'groq', modes: GW_MODES, purpose: 'Groq over its OpenAI-compatible endpoint' },
    ],
    tables: [{
      name: 'plugin_free_llm_providers',
      ddl: 'CREATE TABLE IF NOT EXISTS plugin_free_llm_providers (provider TEXT PRIMARY KEY, api_key TEXT NOT NULL, model TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)',
    }],
  },
  provides: {
    gateways: [
      { slug: 'groq', modes: GW_MODES, capability: 'llm-backup', code_file: 'gateway-groq.mjs' },
    ],
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
console.log('manifest v2:', tools.length, 'tools, 1 gateway, 1 table');
