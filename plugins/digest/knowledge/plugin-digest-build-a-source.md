# Build a new Digest source (prompt for an LLM)

Copy this to Claude Code, Expand build, or any capable assistant. It guides a person through building a plugin that adds a source to the nyyon Digest.

---

You are helping me build a nyyon plugin that adds a SOURCE to the Digest. A source is a gateway that advertises the capability `search`: the Digest discovers it by that capability, never by name, and asks it for results on each watched topic. Guide me step by step; ask what the service is, whether it needs a key, and what a result looks like. Then produce the files.

Contract (nyyon_plugin: 2):

1. `manifest.json`: name (kebab-case), title, version, description, icon, `requires.gateways` = [{ slug, modes: ["search","status"], purpose }], `requires.tables` = the plugin's own tables only, named `plugin_<name>_*` (put a key here if the service needs one; never in env), `provides.gateways` = [{ slug, modes, capability: "search", code_file }], `provides.tools`, `provides.knowledge` (one usage doc so Nyo knows when to call the tool), `provides.surfaces` (a small page to paste a key, if any).
2. `gateway-<slug>.mjs`: `export const gateway = { slug, service, description, capability: "search", modes: { status(api) -> { connected, label }, search(api, { query, limit }) -> { ok, query, results } } }`. Each result is `{ title, url, source, published_at, summary }` (source, published_at and summary may be null). The gateway only fetches and translates; it never scores, filters by judgment, or reads knowledge. Read a key with `api.DB.prepare("SELECT api_key FROM plugin_<name>_config WHERE id = 1").first()`.
3. `tools/<tool>.mjs`: `export const def = { name, description, input_schema }` and `export async function run(api, input)`; tools reach the service only through `api.gateway("<slug>", "search", input)`. Add `connect_<name>` / `disconnect_<name>` tools if a key is needed; verify the key with one real request before storing it.
4. `knowledge/plugin-<name>-usage.md`: when Nyo should use the tool, in plain words.
5. Rules: no em dashes in copy; honest errors (return `{ ok:false, error }` with the provider's real message); zero setup wherever possible; every constant a person might change lives in a knowledge doc, not in code.

Packaging: zip the folder (manifest.json at the top level of the folder) and install it from the Plugins page. Once active, the Digest's search source lists the provider automatically and uses it on the next Generate. The watched topics live in the Knowledge doc "Digest search topics".
