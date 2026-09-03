// Installable plugins: sources live in plugins-installable/<name>/, and this
// turns each into plugins-dist/<name>-<version>.zip + .json — the artifacts a
// person installs from the Plugins page. Nothing here is bundled into the
// host; that is the point. Tool defs are read from the tool files so the
// manifest can never drift from the code.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
const REPO = new URL('..', import.meta.url).pathname;
const SRC = join(REPO, 'plugins-installable');
const DIST = join(REPO, 'plugins-dist');
mkdirSync(DIST, { recursive: true });
const DESK = join(homedir(), 'Desktop', 'nyyon-plugins');
// The in-app catalog: manifests served as static files so a page (the digest's
// opening screen) can offer one-click install through /api/plugins/import.
const CATALOG = join(REPO, 'web', 'public', 'plugin-catalog');
mkdirSync(CATALOG, { recursive: true });
const catalog = [];
for (const name of readdirSync(SRC).filter((n) => existsSync(join(SRC, n, 'manifest.json')))) {
  const dir = join(SRC, name);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  // refresh embedded tool defs from the tool files
  const tools = [];
  if (existsSync(join(dir, 'tools'))) {
    for (const f of readdirSync(join(dir, 'tools')).filter((x) => x.endsWith('.mjs')).sort()) {
      const mod = await import(join(dir, 'tools', f));
      tools.push({ name: f.replace(/\.mjs$/, ''), code_file: `tools/${f}`, def: mod.def });
    }
  }
  m.provides.tools = tools;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const packed = execSync(`node ${join(REPO, 'scripts', 'pack-plugin.mjs')} ${dir}`, { encoding: 'utf8' });
  const json = JSON.parse(packed);
  const base = `${name}-${m.version}`;
  writeFileSync(join(DIST, `${base}.json`), JSON.stringify(json.manifest, null, 2) + '\n');
  execSync(`cd ${SRC} && rm -f ${join(DIST, base)}.zip && zip -qr ${join(DIST, base)}.zip ${name} -x "*.DS_Store"`);
  if (existsSync(DESK)) { copyFileSync(join(DIST, `${base}.zip`), join(DESK, `${base}.zip`)); copyFileSync(join(DIST, `${base}.json`), join(DESK, `${base}.json`)); }
  writeFileSync(join(CATALOG, `${name}.json`), JSON.stringify(json.manifest) + '\n');
  catalog.push({ name, title: m.title, version: m.version, description: m.description, capabilities: (m.provides.gateways || []).map((g) => g.capability).filter(Boolean), needs_key: !!(m.requires.tables || []).length, file: `/plugin-catalog/${name}.json` });
  console.log(`✓ ${base}: ${tools.length} tools, ${(m.provides.gateways || []).length} gateway(s), ${(m.provides.knowledge || []).length} doc(s)`);
}
writeFileSync(join(CATALOG, 'index.json'), JSON.stringify({ plugins: catalog }, null, 2) + '\n');
console.log(`catalog: ${catalog.length} installable plugin(s) → web/public/plugin-catalog/`);
