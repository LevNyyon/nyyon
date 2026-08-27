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
  callOpenAIText, callOpenAIJson, callOpenAIVision,
} from '../lib/openai.js';
import { getLlmHealth } from '../lib/llm.js';
import { listConnections, postToConnection } from '../lib/social-gateway.js';
import {
  probeLinkedIn, getMyProfile, getProfile, getFeed, getLiCompany, getLiCompanyJobs,
  searchPeople, listSentInvitations, sendDirectMessage, sendConnectionRequest, postText,
  listConversations, getConversationMessages, getSentMessages, reactToPost,
  connectLink,
} from '../lib/unipile.js';
import {
  renderImage, storeImageBytes, readImage, generateImage, IMAGE_MODELS,
} from '../lib/image-gateway.js';
import {
  checkWaHealth, listChats, searchWaChats, listWaGroups, readWaGroupInfo,
  sendText as waSendText, sendImage as waSendImage, sendDocument as waSendDocument,
  reactToMessage as waReact, replyToWaMessage, resolveWaLids, fetchWaContact,
  setChatListening, restartWaSession, backfillMessages, backfillWaLidMap,
} from '../lib/whatsapp.js';
import { ttsConfigured, synthesize } from '../lib/tts-gateway.js';
import { fetchText as webFetchText, head as webHead, postJson as webPostJson } from '../lib/web-gateway.js';
import { pdlEnrich, twilioLookup, serpSearch } from '../lib/gtm.js';
import { fetchTheorg, probeTheorg } from '../lib/gtm-context.js';
import { hfComplete, probeHf } from '../lib/hf-gateway.js';
import { withResolvedCredentials } from '../lib/gateway-config.js';

export const GATEWAYS = {
  llm: {
    slug: 'llm',
    service: 'Anthropic Messages API (fallback: local Ollama via circuit breaker)',
    description: 'The ONLY sanctioned LLM boundary. text/json/vision completions; vision always requires OPENAI_API_KEY.',
    modes: {
      text:   (env, input) => callOpenAIText(env, input),
      json:   (env, input) => callOpenAIJson(env, input),
      vision: (env, input) => callOpenAIVision(env, input),
      health: (env) => getLlmHealth(env),
    },
  },
  social: {
    slug: 'social',
    service: 'Make.com webhooks (LinkedIn company/personal, Facebook company)',
    description: 'Posts to social profiles through per-profile Make webhooks. No reasoning; pure payload translation.',
    modes: {
      connections: (env) => listConnections(env),
      post: (env, input) => postToConnection(env, input?.connection, input || {}),
    },
  },
  linkedin: {
    slug: 'linkedin',
    service: 'LinkedIn via Unipile (api.unipile.com — off until connected)',
    description: 'Reads/writes the operator LinkedIn account through Unipile (hosted sessions, hosted auth).',
    modes: {
      probe:        (env) => probeLinkedIn(env),
      connect_link: (env, input) => connectLink(env, input || {}),
      me:           (env) => getMyProfile(env),
      profile:      (env, input) => getProfile(env, input?.public_id),
      feed:         (env, input) => getFeed(env, input || {}),
      company:      (env, input) => getLiCompany(env, input?.universal_name),
      company_jobs: (env, input) => getLiCompanyJobs(env, input?.company_id),
      search:       (env, input) => searchPeople(env, input || {}),
      sent_invitations: (env) => listSentInvitations(env),
      dm:           (env, input) => sendDirectMessage(env, input || {}),
      connect:      (env, input) => sendConnectionRequest(env, input || {}),
      post:         (env, input) => postText(env, input || {}),
      // The Playwright reaction path had no mode, so the reaction tool was the
      // one LinkedIn caller still bypassing the gateway. Now it doesn't.
      react:        (env, input) => reactToPost(env, input || {}),
      conversations:        (env, input) => listConversations(env, input || {}),
      conversation_messages: (env, input) => getConversationMessages(env, input?.conversation_urn, input || {}),
      sent_messages:        (env, input) => getSentMessages(env, input || {}),
    },
  },
  image: {
    slug: 'image',
    service: 'image generation (OpenAI Images / Cloudflare Workers AI, model-routed)',
    description: 'Generates imagery. No knowledge of blogs or social — callers bring their own keys/prompts. Storage lives in the assets gateway.',
    modes: {
      models:   () => ({ models: IMAGE_MODELS }),
      render:   (env, input) => renderImage(env, input || {}),
      generate: (env, input) => generateImage(env, input || {}),
    },
  },
  assets: {
    slug: 'assets',
    service: 'asset storage (R2 when deployed, local simulation otherwise)',
    description: 'Binary asset store behind ASSETS_BASE_URL — featured images, lead photos, org-chart avatars.',
    modes: {
      store: (env, input) => storeImageBytes(env, input?.key, input?.bytes, input?.metadata || {}),
      read:  (env, input) => readImage(env, input?.key),
    },
  },
  whatsapp: {
    slug: 'whatsapp',
    service: 'WhatsApp service (bundled with the install; WA_BASE_URL)',
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
  web: {
    slug: 'web',
    service: 'the public web (generic http(s) fetch)',
    description: 'Shared bounded fetch for public pages/APIs. Users: gtm import/social-scan/photo, web_fetch tool, heartbeat feeds/articles, osint scrapers.',
    modes: {
      text: (env, input) => webFetchText(env, input || {}),
      head: (env, input) => webHead(env, input || {}),
      post_json: (env, input) => webPostJson(env, input || {}),
    },
  },
  // One slug per external service (the old bundled `enrich` slug split here):
  // each degrades to {skipped} when its secret is unset.
  pdl: {
    slug: 'pdl',
    service: 'People Data Labs person-enrich API',
    description: 'phone/name -> identity (GTM intake). Degrades to {skipped} without PDL_API_KEY.',
    modes: {
      person: (env, input) => pdlEnrich(env, input || {}),
    },
  },
  twilio: {
    slug: 'twilio',
    service: 'Twilio Lookup API',
    description: 'phone -> line type + carrier + CNAM. Degrades to {skipped} without TWILIO_ACCOUNT_SID/AUTH_TOKEN.',
    modes: {
      lookup: (env, input) => twilioLookup(env, input?.phone),
    },
  },
  serp: {
    slug: 'serp',
    service: 'SerpApi (Google Search + Lens)',
    description: 'name -> socials / company-from-LinkedIn / reverse image. Degrades to {skipped} without SERPAPI_KEY.',
    modes: {
      search: (env, input) => serpSearch(env, input || {}),
    },
  },
  hf: {
    slug: 'hf',
    service: 'Hugging Face Inference Providers (router.huggingface.co)',
    description: 'The writing fallback: heavy prose writers run here (open model picked for writing quality) while the Anthropic credit breaker is open. Model id: llm-models doc writer_fallback.',
    modes: {
      probe: (env) => probeHf(env),
      text:  (env, input) => hfComplete(env, input || {}),
    },
  },
  theorg: {
    slug: 'theorg',
    service: 'theorg.com GraphQL (public, no key)',
    description: 'company -> real org chart (names, titles, hierarchy, photos). Used by GTM Enrich.',
    modes: {
      probe:     (env) => probeTheorg(env),
      org_chart: (env, input) => fetchTheorg(env, input || {}),
    },
  },
};

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
