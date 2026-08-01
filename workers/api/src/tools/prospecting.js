// Prospecting — lead identification, one verb per tool (nyyon-lite layer 2).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
//
// The old gtm_enrich_lead ran the whole accuracy-ordered chain inside one call.
// Here the chain IS the `enrich-lead` workflow: every source is a lookup that
// returns what it found and writes nothing, reconcile_identity makes every merge
// decision, and save_lead is the only writer. Nothing in this file calls another
// tool; the order lives in the workflow's step list.
//
// Context threading: the lookups also echo their raw result under a namespaced
// key (`wa`, `li`, `pdl`, `twilio`, `serp`) because the runner shallow-merges
// each step's result into one shared context — a bare {skipped:"…"} from three
// different sources would otherwise be indistinguishable by the time
// reconcile_identity reads it.

import {
  getLead, leadState, evaluateConfidence, auditLinkedinIdentity,
  lookupWaIdentity, lookupCompanyFromLinkedin, enrichPersonPdl, lookupLineTwilio,
  searchSocialsSerp, reconcileIdentity, saveLeadPatch,
} from '../lib/gtm.js';
import {
  readYou as gtmReadYou, listOrgChart, fetchOrgChartFor, saveOrgChart,
  fetchCompanyProfile, fetchOpenRoles, scoreIcpFromFacts,
} from '../lib/gtm-context.js';
import { readAngles, saveAngles, draftAnglesForLead, greenLeadsWithStatus } from '../lib/gtm-outreach.js';
import { promoteLeadToPipeline } from '../lib/pipeline.js';
import { saveLimits as gtmSaveLimits, gtmApiUsage } from '../lib/gtm-usage.js';

// Every lookup accepts its subject explicitly but falls back to the lead the
// workflow already read, so a step is runnable standalone AND inside the chain.
const leadPhone = (input) => input.phone || input.lead?.normalized_phone || input.lead?.phone || null;
const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const tools = {
  read_lead: {
    def: {
      name: 'read_lead',
      description: 'Read one prospect (GTM lead) with its derived state, confidence, cached org chart and stored outreach angles. Start every prospecting workflow here — the later steps read the lead off this result.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const lead = await getLead(env, input.id);
      if (!lead) return { error: 'not found' };
      return {
        lead: { ...lead, state: leadState(lead), confidence: evaluateConfidence(lead) },
        org_people: await listOrgChart(env, input.id),
        angles: await readAngles(env, input.id),
        // Stored people are not a fetch: save_org_chart must never replace live
        // rows with the copy it was just handed back.
        org_fetched: false,
      };
    },
  },

  lookup_wa_identity: {
    def: {
      name: 'lookup_wa_identity',
      description: "Look a phone number up on WhatsApp: registered?, display name, profile photo, about text, business flag. Read-only, nothing is sent and nothing is saved. Use as the first identity source for a new lead — it is free and the most accurate.",
      input_schema: { type: 'object', properties: { phone: { type: 'string' }, id: { type: 'string', description: 'lead id — the profile photo is copied into permanent storage under it' } }, required: [] },
    },
    run: async (env, input) => {
      const wa = await lookupWaIdentity(env, { phone: leadPhone(input), lead_id: input.id || input.lead?.id || null });
      return { wa, ...wa };
    },
  },

  lookup_company_from_linkedin: {
    def: {
      name: 'lookup_company_from_linkedin',
      description: "Read a person's current company and job title off their own name-verified LinkedIn result. Self-skips when there is no LinkedIn profile on file, or when company AND title are both already known. Saves nothing.",
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, linkedin: { type: 'string', description: "the PERSON's linkedin.com/in/ url" } },
        required: [],
      },
    },
    run: async (env, input) => {
      const l = leadNow(input);
      const li = await lookupCompanyFromLinkedin(env, {
        name: input.name || l.name || input.wa_name || null,
        linkedin: input.linkedin || l.linkedin || null,
        company: l.company || null,
        position: l.position || null,
      });
      return { li, ...li };
    },
  },

  enrich_person_pdl: {
    def: {
      name: 'enrich_person_pdl',
      description: 'Enrich a phone-anchored person through People Data Labs (name, company, title, email, social profiles). PAID per call — it self-skips whenever a name and a company are already known, so run the free sources first. Saves nothing.',
      input_schema: {
        type: 'object',
        properties: { phone: { type: 'string' }, name: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const l = leadNow(input);
      const pdl = await enrichPersonPdl(env, {
        phone: leadPhone(input),
        name: input.name || l.name || input.wa_name || null,
        company: l.company || input.li_company || null,
        region: input.region || l.region || null,
        country: input.country || l.country || null,
      });
      return { pdl, ...pdl };
    },
  },

  lookup_line_twilio: {
    def: {
      name: 'lookup_line_twilio',
      description: "Look up a phone number's line type (mobile / landline / voip), carrier and caller-ID name through Twilio. Billed per lookup. Saves nothing.",
      input_schema: { type: 'object', properties: { phone: { type: 'string' } }, required: [] },
    },
    run: async (env, input) => {
      const twilio = await lookupLineTwilio(env, { phone: leadPhone(input) });
      return { twilio, ...twilio };
    },
  },

  search_socials_serp: {
    def: {
      name: 'search_socials_serp',
      description: "Search the web for a named person's social profiles. Hard-gated on a name that came from a real source — never invent one. LinkedIn hits come back as UNATTACHED candidates: deciding which (if any) is really this person is reconcile_identity's job. Saves nothing.",
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const l = leadNow(input);
      const serp = await searchSocialsSerp(env, {
        name: input.name || l.name || input.wa_name || input.pdl_name || null,
        region: input.region || l.region || null,
        country: input.country || l.country || null,
      });
      return { serp, ...serp };
    },
  },

  fetch_org_chart: {
    def: {
      name: 'fetch_org_chart',
      description: "Fetch a company's real org chart (names, titles, reporting lines) from theorg.com. Pass theorg_slug to override the company match for namesake companies — a pasted theorg.com/org/… URL works too. Saves nothing; save_org_chart persists it.",
      input_schema: {
        type: 'object',
        properties: { company: { type: 'string' }, theorg_slug: { type: 'string' } },
        required: [],
      },
    },
    run: async (env, input) => {
      const l = leadNow(input);
      return fetchOrgChartFor(env, {
        company: input.company || l.company || input.li_company || input.pdl_company || null,
        slug: input.theorg_slug || l.theorg_slug || null,
      });
    },
  },

  fetch_company_profile: {
    def: {
      name: 'fetch_company_profile',
      description: "Resolve a company on LinkedIn: its company id (what the jobs API needs) and its headcount (the size band the ICP is written in). Cached per lead behind the gtm-policy windows, so running it over a whole list only pays for rows never checked or gone stale. Saves nothing.",
      input_schema: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          company_linkedin_url: { type: 'string', description: 'a linkedin.com/company/ page — beats the guessed slug' },
          refresh: { type: 'boolean', description: 'ignore the cache window and re-resolve' },
        },
        required: [],
      },
    },
    run: async (env, input) => fetchCompanyProfile(env, {
      lead: input.lead || null,
      company: input.company || null,
      company_linkedin_url: input.company_linkedin_url || null,
      refresh: !!input.refresh,
    }),
  },

  fetch_open_roles: {
    def: {
      name: 'fetch_open_roles',
      description: "Fetch a company's currently open roles from LinkedIn's public jobs API. Needs the LinkedIn company id from fetch_company_profile; without one it self-skips. Saves nothing.",
      input_schema: { type: 'object', properties: { company_id: { type: 'string' } }, required: [] },
    },
    run: async (env, input) => fetchOpenRoles(env, { company_id: input.company_id || input.lead?.company_li_id || null }),
  },

  reconcile_identity: {
    def: {
      name: 'reconcile_identity',
      description: "Merge every raw source result gathered so far into ONE lead patch: fill-don't-overwrite precedence, per-field provenance, disagreements recorded as conflicts instead of overwritten, LinkedIn profiles verified against the name (namesakes rejected, tombstoned URLs never re-attached), a per-source step verdict, and the CEO-mismatch org warning. Decides only — save_lead writes. Pass clean_identity:true to instead tear down a LinkedIn that was confirmed to be the wrong person.",
      input_schema: {
        type: 'object',
        properties: {
          clean_identity: { type: 'boolean', description: 'true = clear the wrong-person LinkedIn, tombstone the URL, drop what was derived from it' },
        },
        required: [],
      },
    },
    // Pure decision step: no env, no I/O — it reads the shared context and
    // returns the patch, which is what makes it safe to re-run.
    run: async (env, input) => reconcileIdentity(input),
  },

  score_icp: {
    def: {
      name: 'score_icp',
      description: 'Score a prospect against the editable brand-icp knowledge doc using their real company facts (headcount, open roles, org chart): strong / medium / weak plus short reason and gap tags. Refuses without a name, company and title — a verdict without those is noise. Saves nothing.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
    },
    run: async (env, input) => {
      // Score the RECONCILED identity: inside enrich-lead the patch is newer
      // than the row it came from, and a lead identified this run should be
      // scored this run rather than on the next pass.
      const lead = input.lead ? leadNow(input) : (input.id ? await getLead(env, input.id) : null);
      if (!lead) return { error: 'no lead' };
      return scoreIcpFromFacts(env, {
        lead,
        org_people: Array.isArray(input.org_people) ? input.org_people : [],
        staff_count: input.staff_count ?? input.company_profile?.staff_count ?? null,
        positions: Array.isArray(input.positions) ? input.positions : null,
      });
    },
  },

  save_lead: {
    def: {
      name: 'save_lead',
      description: "Persist a reconciled lead patch: fields, provenance, conflicts, tombstones, step verdicts and any ICP verdict, then log the activity event. The only writer for an enriched lead — it writes exactly the keys reconcile_identity decided to write and leaves every other column alone.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lead_patch: { type: 'object' },
          sources: { type: 'object' },
          conflicts: { type: 'array', items: { type: 'object' } },
          dismissed: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'object' } },
          icp_fit: { type: 'string', enum: ['strong', 'medium', 'weak'] },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => saveLeadPatch(env, {
      id: input.id || input.lead?.id,
      lead_patch: input.lead_patch || {},
      sources: input.sources || null,
      conflicts: input.conflicts || null,
      dismissed: input.dismissed || null,
      steps: input.steps || null,
      icp_fit: input.icp_fit || null,
      icp_reasons: input.icp_reasons || null,
      icp_gaps: input.icp_gaps || null,
      rejected_linkedin: input.rejected_linkedin || null,
      actor: input.actor || 'operator',
    }),
  },

  save_org_chart: {
    def: {
      name: 'save_org_chart',
      description: "Persist a freshly fetched org chart for a lead: replaces the stored people, copies their photos into permanent storage (theorg's expire), and stamps the org verdict on the lead. Skips itself when this run did not actually fetch a chart, so a failed lookup can never wipe a chart already on file.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          org_company: { type: 'string' },
          org_people: { type: 'array', items: { type: 'object' } },
          org_status: { type: 'string', enum: ['saved', 'warn', 'none'] },
          org_note: { type: 'string' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => saveOrgChart(env, {
      id: input.id || input.lead?.id,
      org_company: input.org_company || null,
      org_people: Array.isArray(input.org_people) ? input.org_people : [],
      org_status: input.org_status || null,
      org_note: input.org_note ?? null,
      theorg_slug: input.theorg_slug || null,
      org_fetched: input.org_fetched === true,
    }),
  },

  draft_angles: {
    def: {
      name: 'draft_angles',
      description: "Draft ranked outreach angles and WhatsApp message bubbles for a fully identified prospect, from the operator profile, the outreach playbook and the VERIFIED org chart. A DRAFT only — it never sends and never saves; sending stays an explicit, operator-approved action. Blocked while the company is unverified (org_status 'warn').",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
    },
    run: async (env, input) => {
      const lead = input.lead ? leadNow(input) : (input.id ? await getLead(env, input.id) : null);
      if (!lead) return { angles_payload: null, error: 'no lead' };
      const org_people = Array.isArray(input.org_people) && input.org_people.length
        ? input.org_people
        : await listOrgChart(env, lead.id);
      return draftAnglesForLead(env, { lead, org_people });
    },
  },

  save_angles: {
    def: {
      name: 'save_angles',
      description: 'Persist an outreach-angles payload for a prospect (whole-payload replace — read it, edit the bubbles, save it back). Refuses an empty payload, so a blocked or failed draft can never wipe angles the operator already has. Saving is not sending.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' }, payload: { type: 'object' } },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const id = input.id || input.lead?.id;
      const payload = input.payload || input.angles_payload || null;
      if (!payload) return { ok: false, skipped: input.blocked || 'no angles payload to save — nothing was overwritten' };
      return saveAngles(env, id, payload);
    },
  },

  list_green_leads: {
    def: {
      name: 'list_green_leads',
      description: 'List the fully identified (GREEN) prospects ready for qualification and outreach. Each row carries warm-contact flags, any stored angles, and its contact status: not_contacted, contacted, or replied. Use to answer "who did I contact", "who replied", "who is still untouched".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ leads: await greenLeadsWithStatus(env) }),
  },

  read_you: {
    def: {
      name: 'read_you',
      description: "Read the operator profile that drives outreach positioning and warm-path matching (name, role, business, location, WhatsApp groups, warm connections). It lives in the gtm-you knowledge doc — edit it with write_knowledge, not here.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ you: await gtmReadYou(env) }),
  },

  promote_lead: {
    def: {
      name: 'promote_lead',
      description: "Promote a prospect into the Pipeline CRM as a linked contact + client at stage 'target'. Idempotent — re-running returns the existing client instead of creating a second one.",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => promoteLeadToPipeline(env, input.id, input.actor || 'operator'),
  },

  audit_identities: {
    def: {
      name: 'audit_identities',
      description: "Audit every prospect whose assigned LinkedIn profile does not match their name (the namesake / wrong-person bug) and report match / unverifiable / mismatch. REPORT ONLY — fixing a mismatch is the clean-identity workflow, run once per reported lead. Use after big imports, or whenever a LinkedIn assignment looks wrong.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => auditLinkedinIdentity(env, { fix: false }),
  },

  update_api_limits: {
    def: {
      name: 'update_api_limits',
      description: 'Update the paid-enrichment API limits (the gtm-api-limits knowledge doc): per provider monthly_limit / renewal_day (1-28) / warn_at_pct, plus twilio.balance_warn_usd. Pass only the fields to change. Use when the operator states their real plan caps or renewal dates.',
      input_schema: {
        type: 'object',
        properties: {
          pdl:     { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
          serpapi: { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
          twilio:  { type: 'object', properties: { balance_warn_usd: { type: 'number' } } },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ limits: await gtmSaveLimits(env, input || {}) }),
  },

  // The read side of the same meters update_api_limits writes. ARCHITECTURE-V2
  // lists only the writer, but the GTM Usage panel (GET /api/gtm/usage) needs a
  // pool tool to read from now that tools/gtm.js is gone — the alternative was a
  // module reaching past the pool into lib/gtm-usage.js.
  read_api_usage: {
    def: {
      name: 'read_api_usage',
      description: 'Read the paid-enrichment API meters: per provider (PDL, SerpApi, Twilio) the calls used this period, the configured monthly limit and renewal day, the warn threshold, and whether the cap is close. Read-only — edit the caps with update_api_limits.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => gtmApiUsage(env),
  },
};
