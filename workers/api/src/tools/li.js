// linkedin — the shared LinkedIn surface: session probe, profile/feed/DM reads,
// DMs, connection requests, posts and reactions.
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
//
// This is the ONE place the operator's LinkedIn account is touched by a tool.
// Every run() reaches the daemon only through callGateway(env, 'linkedin', mode,
// input) — no raw fetch, no second write path that could bypass the audit trail.
//
// Sends are outbox-audited inside lib/linkedin.js (beginSend → markSent /
// markFailed), so a failed DM, connect or post leaves a visible failed row
// instead of a silent drop. Nothing here retries: LinkedIn flags accounts that
// hammer, so a repeat send is an operator decision, never an automatic one. The
// send tools THROW on failure rather than returning ok:false, so a caller can
// never mistake a rejected send for a delivered one.
//
// These 11 primitives are the ONLY LinkedIn path in the product: the paced LI
// Outreach engine that used to sit beside them (lib/li-outreach.js) was cut
// with its module, so every LinkedIn call is now an operator/Nyo action that
// logs its own event here.
//
// Auth lives in the gateway daemon's cookies.json. A "no linkedin cookies" /
// "session not ready" error means the operator must re-capture cookies — point
// them at the linkedin-endpoints knowledge doc.
//
// Workflow steps hand a tool the whole shared context, so every run() picks the
// exact keys it needs off `input` rather than forwarding it wholesale.

import { callGateway } from '../gateways/index.js';
import { logEvent } from '../lib/db.js';

// The daemon's list payloads vary by endpoint (items / posts / elements / a bare
// array). Pinning one key per tool is what lets the next workflow step read the
// rows straight off ctx.shared instead of re-sniffing the shape.
function rows(data, ...keys) {
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return Array.isArray(data) ? data : [];
}

// Never let a logging failure mask (or undo) a send that actually went out.
function logLi(env, kind, actor, payload) {
  return logEvent(env, { kind, actor: actor || 'nyo', payload })
    .catch((e) => console.error(`${kind} logEvent failed:`, e?.message || e));
}

export const tools = {
  // ── session ─────────────────────────────────────────────────
  probe_linkedin: {
    def: {
      name: 'probe_linkedin',
      description: 'Probe the LinkedIn gateway session. Returns reachable/ready/cookies_loaded plus the logged-in profile when ready. Call this before any other LinkedIn tool so you can tell the operator "the session needs new cookies" instead of relaying a confusing 500.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => callGateway(env, 'linkedin', 'probe', {}),
  },

  // ── reads ───────────────────────────────────────────────────
  read_linkedin_profile: {
    def: {
      name: 'read_linkedin_profile',
      description: 'Read one LinkedIn profile by public_id (the URL slug, e.g. "jane-doe"). Returns the profile blob — headline, current_company, summary, locations, experience, education. Use it when the operator asks about a person, or before drafting a message tailored to them.',
      input_schema: {
        type: 'object',
        properties: { public_id: { type: 'string', description: 'the URL slug, not the full URL' } },
        required: ['public_id'],
      },
    },
    run: async (env, input) => callGateway(env, 'linkedin', 'profile', { public_id: input?.public_id }),
  },

  read_my_linkedin_profile: {
    def: {
      name: 'read_my_linkedin_profile',
      description: "Read the operator's own LinkedIn profile. Use it when drafting content or messages \"as them\" so the voice, role and company line up with what their profile actually says.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => callGateway(env, 'linkedin', 'me', {}),
  },

  get_linkedin_feed: {
    def: {
      name: 'get_linkedin_feed',
      description: "Read recent posts from the operator's LinkedIn home feed. Use it to answer \"what is my network talking about this week\" or to find industry signal worth weighing in on.",
      input_schema: {
        type: 'object',
        properties: { count: { type: 'number', description: 'posts to pull, default 20, max 50' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const count = Math.min(Math.max(Number(input?.count) || 20, 1), 50);
      const data = await callGateway(env, 'linkedin', 'feed', { count });
      const items = rows(data, 'items', 'posts', 'elements');
      return { items, count: items.length };
    },
  },

  list_linkedin_dms: {
    def: {
      name: 'list_linkedin_dms',
      description: 'List LinkedIn DM conversation threads, newest first. Each row carries the conversation_urn that read_linkedin_dm needs, plus the other participant and a last-message preview. Fast read — use it to survey the inbox before opening one thread.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'threads to return, default 25' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const limit = Math.max(Number(input?.limit) || 25, 1);
      const data = await callGateway(env, 'linkedin', 'conversations', { limit });
      const conversations = rows(data, 'conversations', 'items', 'elements');
      return { conversations, count: conversations.length };
    },
  },

  read_linkedin_dm: {
    def: {
      name: 'read_linkedin_dm',
      description: 'Read the messages of one LinkedIn DM thread. Pass the conversation_urn from list_linkedin_dms. Use it before replying so you answer what was actually said.',
      input_schema: {
        type: 'object',
        properties: {
          conversation_urn: { type: 'string', description: 'thread id from list_linkedin_dms' },
          limit:            { type: 'number', description: 'messages to return, default 25' },
        },
        required: ['conversation_urn'],
      },
    },
    run: async (env, input) => {
      const conversation_urn = input?.conversation_urn;
      const data = await callGateway(env, 'linkedin', 'conversation_messages', {
        conversation_urn, limit: Math.max(Number(input?.limit) || 25, 1),
      });
      const messages = rows(data, 'messages', 'items', 'elements');
      return { conversation_urn, messages, count: messages.length };
    },
  },

  search_linkedin_people: {
    def: {
      name: 'search_linkedin_people',
      description: 'Search LinkedIn people by keywords (name, headline, company, role). Returns lightweight rows with the profile_urn_id that send_linkedin_dm and send_linkedin_connection take. Use it to find a person you only know by name or description.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'e.g. "head of marketing fintech tel aviv"' },
          limit:    { type: 'number', description: 'results to return, default 10, max 50' },
        },
        required: ['keywords'],
      },
    },
    run: async (env, input) => {
      const keywords = input?.keywords;
      const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 50);
      const data = await callGateway(env, 'linkedin', 'search', { keywords, limit });
      // The daemon spells the urn three ways depending on the search backend.
      // Normalising to profile_urn_id here is what makes a result row directly
      // passable into the send tools without a translation step in between.
      const results = rows(data, 'people', 'results', 'elements').map((p) => ({
        ...p,
        profile_urn_id: p.profile_urn_id || p.urn_id || p.urnId || null,
        public_id: p.public_id || p.publicId || null,
        headline: p.headline || p.jobtitle || null,
      }));
      return { keywords, results, count: results.length };
    },
  },

  // ── writes ──────────────────────────────────────────────────
  send_linkedin_dm: {
    def: {
      name: 'send_linkedin_dm',
      description: 'Send one direct message to a LinkedIn profile by their profile_urn_id (get it from search_linkedin_people). Sends immediately and cannot be unsent — get the operator\'s approval on the copy first unless they explicitly told you to fire. Daily send etiquette and caps live in the li-outreach-throttle knowledge doc; a rejected send throws instead of reporting success.',
      input_schema: {
        type: 'object',
        properties: {
          profile_urn_id: { type: 'string', description: "the recipient's profile URN id, usually from search_linkedin_people" },
          body:           { type: 'string', description: 'the message body, in the operator\'s voice (see the li-outreach voice doc)' },
          actor:          { type: 'string', description: 'who initiated: operator | nyo | system. Default nyo.' },
        },
        required: ['profile_urn_id', 'body'],
      },
    },
    run: async (env, input) => {
      const profile_urn_id = input?.profile_urn_id;
      const body = input?.body;
      // Throws on gateway error AND on a business-level rejection, leaving a
      // failed outbox row behind — never a silent "sent" for a DM that vanished.
      const res = await callGateway(env, 'linkedin', 'dm', { profile_urn_id, body });
      const out = {
        ok: true,
        message_id: res?.message_id || res?.id || res?.urn || null,
        outbox_id: res?.outbox_id || null,
      };
      await logLi(env, 'li_dm_sent', input?.actor, {
        profile_urn_id, chars: String(body || '').length,
        preview: String(body || '').slice(0, 120),
        message_id: out.message_id, outbox_id: out.outbox_id,
      });
      return out;
    },
  },

  send_linkedin_connection: {
    def: {
      name: 'send_linkedin_connection',
      description: 'Send one LinkedIn connection request, optionally with a short personal note (LinkedIn caps the note at 300 characters). Get the operator\'s approval on the note first. Weekly invite etiquette lives in the li-outreach-throttle knowledge doc. Returns the invitation urn when LinkedIn really accepted it.',
      input_schema: {
        type: 'object',
        properties: {
          profile_urn_id: { type: 'string', description: "the recipient's profile URN id, usually from search_linkedin_people" },
          note:           { type: 'string', description: 'optional personal note, max 300 chars' },
          profile_urn:    { type: 'string', description: 'optional member urn — pass it when you have it so the gateway can skip a dead profile lookup' },
          actor:          { type: 'string', description: 'who initiated: operator | nyo | system. Default nyo.' },
        },
        required: ['profile_urn_id'],
      },
    },
    run: async (env, input) => {
      const profile_urn_id = input?.profile_urn_id;
      const note_text = input?.note || null;
      const res = await callGateway(env, 'linkedin', 'connect', {
        profile_urn_id, note: note_text, profile_urn: input?.profile_urn || null,
      });
      const out = {
        ok: true,
        invitation_urn: res?.invitation_urn || res?.urn || res?.id || null,
        outbox_id: res?.outbox_id || null,
      };
      await logLi(env, 'li_connect_sent', input?.actor, {
        profile_urn_id, with_note: !!note_text,
        invitation_urn: out.invitation_urn, outbox_id: out.outbox_id,
      });
      return out;
    },
  },

  post_linkedin_text: {
    def: {
      name: 'post_linkedin_text',
      description: 'EMERGENCY FALLBACK ONLY — do not use this to publish. Use post_to_social (the Make-webhook gateway, connections linkedin-company / linkedin-personal) for real LinkedIn posts. This tool drives headless Chromium and can hang or fail silently, so it reads the post back from the feed to confirm. Report exactly what it returns: never call a post live unless verified is true.',
      input_schema: {
        type: 'object',
        properties: {
          body:       { type: 'string', description: 'the post body, in the operator\'s voice (see the brand-voice knowledge doc)' },
          visibility: { type: 'string', enum: ['ANYONE', 'CONNECTIONS'], description: 'default ANYONE' },
          actor:      { type: 'string', description: 'who initiated: operator | nyo | system. Default nyo.' },
        },
        required: ['body'],
      },
    },
    run: async (env, input) => {
      const body = input?.body;
      // postText resolves (never throws) with the whole verdict — {posted,
      // verified, post_url, note|error} — because "the gateway errored but the
      // post is live" is a real outcome the caller has to see, not an exception.
      const res = await callGateway(env, 'linkedin', 'post', {
        body, visibility: input?.visibility || 'ANYONE',
      });
      await logLi(env, res?.posted ? 'li_post_published' : 'li_post_failed', input?.actor, {
        verified: !!res?.verified, post_url: res?.post_url || null,
        outbox_id: res?.outbox_id || null,
        preview: String(body || '').slice(0, 120),
        error: res?.error || null,
      });
      return res;
    },
  },

  react_linkedin_post: {
    def: {
      name: 'react_linkedin_post',
      description: 'React to one LinkedIn post by its full /feed/update/urn:li:activity:... URL. Use it sparingly — automated reactions get accounts flagged. Reserve it for posts by people in the pipeline or by people worth signal-boosting.',
      input_schema: {
        type: 'object',
        properties: {
          post_url: { type: 'string', description: 'full /feed/update/urn:li:activity:... URL' },
          reaction: { type: 'string', enum: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'], description: 'default LIKE' },
          actor:    { type: 'string', description: 'who initiated: operator | nyo | system. Default nyo.' },
        },
        required: ['post_url'],
      },
    },
    run: async (env, input) => {
      const post_url = input?.post_url;
      const reaction = input?.reaction || 'LIKE';
      const res = await callGateway(env, 'linkedin', 'react', { post_url, reaction });
      const out = { ok: res?.ok !== false, post_url, reaction };
      await logLi(env, 'li_post_reacted', input?.actor, out);
      return out;
    },
  },
};
