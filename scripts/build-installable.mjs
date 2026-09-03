// Installable plugins: sources live in plugins-installable/<name>/, and this
// turns each into plugins-dist/<name>-<version>.zip + .json — the artifacts a
// person installs from the Plugins page. Nothing here is bundled into the
// host; that is the point. Tool defs are read from the tool files so the
// manifest can never drift from the code.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
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
  // Tool files are written for the MATERIALIZED layout, where lib and tools sit
  // in one directory, so a tool may import './something.mjs'. Import them from
  // a flat temp copy or every such pack fails to build here.
  const tools = [];
  if (existsSync(join(dir, 'tools'))) {
    const flat = mkdtempSync(join(tmpdir(), 'pack-'));
    for (const sub of ['lib', 'tools']) {
      if (!existsSync(join(dir, sub))) continue;
      for (const f of readdirSync(join(dir, sub))) {
        try { cpSync(join(dir, sub, f), join(flat, f)); } catch { /* dirs are not tool code */ }
      }
    }
    for (const f of readdirSync(join(dir, 'tools')).filter((x) => x.endsWith('.mjs')).sort()) {
      const mod = await import(join(flat, f));
      if (!mod?.def?.name) throw new Error(`${name}/tools/${f}: no def export`);
      tools.push({ name: f.replace(/\.mjs$/, ''), code_file: `tools/${f}`, def: mod.def });
    }
  }
  m.provides.tools = tools;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  // A big pack (editorial is over a megabyte of inlined code) exceeds
  // execSync's default buffer, so the packer writes to a file.
  const tmpOut = join(tmpdir(), `pack-${name}.json`);
  execSync(`node ${join(REPO, 'scripts', 'pack-plugin.mjs')} ${dir} > ${tmpOut}`, { maxBuffer: 256 * 1024 * 1024 });
  const json = JSON.parse(readFileSync(tmpOut, 'utf8'));
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
