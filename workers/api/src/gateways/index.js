// GATEWAYS registry — the single machine-readable pool of service boundaries.
//
// nyyon-lite layer 1. Each entry wraps ONE external service class with a
// uniform surface: { slug, service, description, modes: { name: fn(env, input) } }.
// Entries are thin adapters over the existing lib/ implementations (zero
// behavior change); as the gateway extraction sweep proceeds, more services
// move out of fused libs and register here.
//
// Call through callGateway(env, slug, mode, input) — used by the dev-invoke
// API today, and the intended seam for tools as the refactor lands.

import {
  callOpenAIText, callOpenAIJson,
} from '../lib/openai.js';
import { getLlmHealth } from '../lib/llm.js';
import {
  checkWaHealth, listChats, searchWaChats, listWaGroups, readWaGroupInfo,
  sendText as waSendText, sendImage as waSendImage, sendDocument as waSendDocument,
  reactToMessage as waReact, replyToWaMessage, resolveWaLids, fetchWaContact,
  setChatListening, restartWaSession, backfillMessages, backfillWaLidMap,
} from '../lib/whatsapp.js';
import { ttsConfigured, synthesize } from '../lib/tts-gateway.js';
import { probeTelegram, sendTelegramText } from '../lib/telegram.js';
import { fetchText as webFetchText, fetchBytes as webFetchBytes } from '../lib/web-gateway.js';
import { promoteLeadToPipeline, listPipeline, updateDeal } from '../lib/pipeline.js';
import { writeContact as crmWriteContact } from '../lib/db.js';
import { withResolvedCredentials } from '../lib/gateway-config.js';
import { pluginGateways } from '../plugins/index.js';

export const GATEWAYS = {
  llm: {
    slug: 'llm',
    service: 'Anthropic Messages API',
    description: 'The ONLY sanctioned LLM boundary. text/json completions.',
    modes: {
      text:   (env, input) => callOpenAIText(env, input),
      json:   (env, input) => callOpenAIJson(env, input),
      health: (env) => getLlmHealth(env),
    },
  },
  whatsapp: {
    slug: 'whatsapp',
    service: 'an external WhatsApp gateway service (WA_BASE_URL; unconfigured until connected in Settings)',
    description: 'WhatsApp session, chats, and sends through the local gateway daemon.',
    modes: {
      health:     (env) => checkWaHealth(env),
      chats:      (env) => listChats(env),
      search:     (env, input) => searchWaChats(env, input || {}),
      groups:     (env) => listWaGroups(env),
      group_info: (env, input) => readWaGroupInfo(env, input?.group_id),
      send:          (env, input) => waSendText(env, input || {}),
      send_image:    (env, input) => waSendImage(env, input || {}),
      send_document: (env, input) => waSendDocument(env, input || {}),
      react:         (env, input) => waReact(env, input || {}),
      reply:      (env, input) => replyToWaMessage(env, input || {}),
      // Session + cache maintenance. They talk to the same daemon, so they
      // belong on this boundary rather than being reached from a tool directly.
      restart:           (env, input) => restartWaSession(env, input || {}),
      backfill_messages: (env, input) => backfillMessages(env, input || {}),
      backfill_lids:     (env, input) => backfillWaLidMap(env, input || {}),
      set_listening:     (env, input) => setChatListening(env, input || {}),
      // resolveWaLids returns a Map (lid → phone|null); expose it as a plain
      // object so it survives JSON at the gateway boundary.
      resolve_lids: async (env, input) => Object.fromEntries(await resolveWaLids(env, input?.lids || [])),
      contact:    (env, input) => fetchWaContact(env, input?.number),
    },
  },

  telegram: {
    slug: 'telegram',
    service: 'Telegram Bot API (the operator\'s direct Nyo line)',
    description: 'Sends messages as the Nyo bot. Inbound updates arrive through the bundled poll service, not here.',
    modes: {
      probe: (env) => probeTelegram(env),
      send:  (env, input) => sendTelegramText(env, input || {}),
    },
  },
  tts: {
    slug: 'tts',
    service: 'text-to-speech service (TTS_BASE_URL — off until connected)',
    description: 'Text-to-speech for Nyo voice mode. probe reports config; synthesize streams WAV (route-only, not JSON-safe for the dev bench).',
    modes: {
      probe: (env) => ({ configured: ttsConfigured(env) }),
      synthesize: async (env, input) => {
        const r = await synthesize(env, input || {});
        return { ok: r.ok, status: r.status, note: 'audio body not returned over the dev bench — use POST /api/nyo/tts for the WAV' };
      },
    },
  },
  // The install's CRM store (clients + contacts + pipeline). An INTERNAL host
  // gateway: plugins may not touch these tables, so the boundary to them is a
  // gateway like any external service — declared, mode-scoped, no reasoning.
  crm: {
    slug: 'crm',
    service: 'the host CRM store (clients, contacts, pipeline deals)',
    description: 'Promote a lead into the pipeline, upsert a contact, read/update deals. The plugin-safe boundary to the clients/contacts tables.',
    modes: {
      promote: (env, input) => promoteLeadToPipeline(env, input?.id, input?.actor || 'plugin'),
      write_contact: (env, input) => crmWriteContact(env, input || {}),
      pipeline: (env) => listPipeline(env),
      update_deal: (env, input) => updateDeal(env, input?.id, input?.patch || {}, input?.actor || 'plugin'),
    },
    configFields: [],
  },

  // WASM + bundled-font rendering (social cards, article figures, covers,
  // featured-image candidates) stays HOST: plugin tool files are single .mjs
  // and cannot carry binary assets. The boundary to that renderer is a gateway.

  // The outbound audit log. Every send CLAIM/RESULT flows through here so the
  // operator's Outbox view stays whole no matter who is sending.

  // First-run receipts. A module's setup flow records "done" here; the host
  // prereq panel reads all rows. One row per module key, plugin rows included.
  setup: {
    slug: 'setup',
    service: 'the host module_setup receipt store',
    description: 'Read or write a module first-run receipt (status, summary).',
    modes: {
      read: async (env, input) => (await env.DB.prepare('SELECT * FROM module_setup WHERE module = ?').bind(String(input?.module || '')).first()) || null,
      write: async (env, input) => {
        const t = Date.now();
        await env.DB.prepare(
          `INSERT INTO module_setup (module, status, completed_at, actor, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(module) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at, actor = excluded.actor, summary = excluded.summary, updated_at = excluded.updated_at`,
        ).bind(String(input?.module || ''), String(input?.status || 'done'), input?.completed_at || t, input?.actor || 'plugin', input?.summary || null, t, t).run();
        return { ok: true };
      },
    },
    configFields: [],
  },

  // The operator calendar mirror.

  web: {
    slug: 'web',
    service: 'the public web (generic http(s) fetch)',
    description: 'Shared bounded fetch for public pages/APIs. Users: gtm import/social-scan/photo, web_fetch tool, heartbeat feeds/articles, osint scrapers.',
    modes: {
      text: (env, input) => webFetchText(env, input || {}),
      // Binary fetch — plugin packages arrive as zip archives.
      bytes: (env, input) => webFetchBytes(env, input || {}),
    },
  },
  // One slug per external service (the old bundled `enrich` slug split here):
  // each degrades to {skipped} when its secret is unset.
};

// Bundled plugin gateways (namespaced plugin-<name>-<slug>) join the registry.
for (const [slug, gw] of Object.entries(pluginGateways)) GATEWAYS[slug] = gw;

// The host knows no plugin by name. A plugin that ships a model boundary
// advertises capability:'llm-backup' on its gateway, and this is how the chat
// fallback finds it. Any future free-model plugin works with no host change.

export function listGateways() {
  return Object.values(GATEWAYS).map((g) => ({
    slug: g.slug,
    service: g.service,
    description: g.description,
    modes: Object.keys(g.modes),
  }));
}

export async function callGateway(env, slug, mode, input) {
  const g = GATEWAYS[slug];
  if (!g) throw new Error(`unknown gateway "${slug}" — options: ${Object.keys(GATEWAYS).join(', ')}`);
  const fn = g.modes[mode];
  if (!fn) throw new Error(`gateway "${slug}" has no mode "${mode}" — options: ${Object.keys(g.modes).join(', ')}`);
  // Credentials resolve DB-first, env-second (lib/gateway-config.js). A Worker
  // cannot write its own secrets, so a gateway connected through the in-app
  // onboarding chat has its key in D1, not in env — this is where that value
  // gets laid over env so every `env.WA_API_KEY` below keeps working unchanged.
  // No-op (returns the same object) when nothing is configured in the DB.
  return fn(await withResolvedCredentials(env), input);
}
