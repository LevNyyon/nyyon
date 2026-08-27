-- GTM knowledge, deduplicated. The brand tree is the single source of truth for
-- ICP / positioning / voice; the GTM code reads it live rather than keeping
-- copies. The old gtm-* copies + the four split outreach docs are dropped in
-- favour of ONE self-contained outreach doc, so the module owns exactly three
-- docs: the runbook, the operator record, and the writing guide.
-- (Author-specific doc content was removed for the shipped product; the bodies
-- below are neutral templates the operator edits into their own voice.)

-- Drop the duplicates + the split/seed outreach docs (leaf docs, no children).
DELETE FROM knowledge_docs WHERE slug IN (
  'gtm-icp', 'gtm-outreach-playbook', 'gtm-outreach-rules',
  'gtm-outreach-examples', 'gtm-outreach-spec'
);

-- The single outreach control surface (GTM-specific; brand voice/positioning
-- are read live from the brand tree, never copied in here).
INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)
VALUES ('gtm-outreach', 'GTM · Outreach — the writing guide', 'The single control surface for first-touch outreach. The angles generator reads THIS doc + your positioning doc ([[brand-positioning]]) + the operator''s [[gtm-you]] record. Edit this to change how outreach is written.

Positioning and brand voice are NOT repeated here — they live once in your brand knowledge docs and are read live. ICP scoring reads [[brand-icp]]. This is the only outreach writing doc.

## Mission
Describe your target market here: who you reach, where they are, and the default language of a first touch. Channel: WhatsApp. A first touch is never a sale — the goal is a yes to a short talk WITH the prospect, earned by proof of work.

## Strategy — pick the warmest REAL angle, never invent one
1. Warm mutual: a real shared person who vouches for you to the prospect.
2. Timely trigger: a real recent event (a raise, a key hire, a launch, a new office).
3. Right-door referral: you tried the real owner of the relevant function, name them and their role, then ask to talk to the prospect.
No real mutual or trigger, then it is a cold touch: lead with who you are and one line of what you do, honest, no fake warmth. Selective, never desperate.

## The spine: proof of work before the ask
The ask only ever COMPLETES work you already did and showed. Naming the specific person you already tried, and their role, IS the proof.
- Strong: you found the person and tried them, you ask only for the warm nudge.
- Banned: asking the prospect to identify someone whose title is one LinkedIn search away, that makes them your research assistant, low status, reads rude.

## Decision tree (run before writing)
1. Real mutual? then Warm mutual (warmest).
2. Else real recent trigger? then Timely trigger (name the local owner if findable).
3. Else Organizational referral. Is the function FINDABLE (marketing, sales, ops, growth, eng)?
   - YES: you must have the named person. Pattern: tried to reach <name>, did not work, ask to connect. No name means insufficient context, go get the name.
   - NO (genuinely internal: special projects, the owner of some messy initiative): a discovery ask is allowed ("who owns <role> at your company?").
4. Always include the source line (how you found them).

## Hard rules
- Ask = a short talk WITH the prospect, never "connect me to X".
- Positioning: include ONE plain line of what your company does (from gtm-you.business / your positioning doc), a reason, not a pitch. State the outcome you deliver, never a service list.
- No selling: banned phrases include "would you be open to", "let''s connect", "synergies", "opportunities", "potential", "I noticed", "Hi I''m X", and anything that asks to buy or book.
- Texting punctuation, not formal writing: no emoji, no hyphens, no em or en dashes. Never end a bubble with a period (a period only splits two sentences inside one bubble, rarely). One question mark, on the ask. Minimal commas. No links, titles, signatures, or small-talk filler.
- Length: 2 to 4 short bubbles, under about 45 words total. Bubble 1 = who you are + the tiny "how I found you" parenthetical. Then the proof of work and the one positioning line. Last bubble = the one-tap ask.
- Facts: every name, role, trigger, mutual must be real. A missing input is a context problem, flag it ("insufficient context: missing X"), never invent it.

## Skeleton
hi <first name>, <your first name> (<source>)
<proof of work or trigger>. <one-tap ask>

## Exemplar bank (REPLACE with your own real sent messages — the generator imitates what it finds here)
Forms (adapt to your market and language, show the FEEL only, never copy verbatim):
- cold: hi [name], [your name] from [your company]
- via a mutual: hi [name], [mutual] pointed me your way
- right door: hi [name], I tried reaching [person] who owns [function] and it did not quite work out
- the ask: worth 15 minutes?
BAD:
- who leads marketing at your company? (findable role, no proof of work, lazy, makes them do your homework)
- I tried to figure out who leads marketing and could not (admits you skipped a 30-second search, weak)
- we help companies like yours do X, interested? (selling, banned in a first touch)
- one long paragraph, commas everywhere, an emoji on the ask (wrong format for texting)

## Voice — avoid template smell
Write the way people actually text in your market: clipped, informal, no formal opener or closer, drop linking words. Add notes here on your market''s texting register, and keep two or three of your own best sent messages in the exemplar bank as the voice anchor.

## Self-check (gate every draft, rewrite until all pass)
- [ ] reads like a real text in the prospect''s language, no translation smell
- [ ] 2 to 4 short bubbles, under the length cap
- [ ] texting punctuation: no hyphens, no dashes, no emoji, no period ending a bubble, one question mark on the ask
- [ ] the "how I found you" is present
- [ ] proof of work present and SPECIFIC (a named person for findable roles)
- [ ] no discovery ask on a findable role
- [ ] the ask is one tap, no request for the recipient''s time in a cold first touch
- [ ] zero sell
- [ ] every fact (name, role, trigger, mutual) is real, nothing invented

## Pacing (implemented by gtm_send_outreach; defaults tunable here)
Send like a person texting, not a bot pasting a block. Each bubble is its OWN message, in order, never concatenated. Human gap 4 to 9 seconds jittered every time (a constant gap reads automated), scaled loosely to the next bubble''s length, cap ~12s. All bubbles land in the same thread. If any bubble fails to send, STOP, do not fire the rest into a half-sent thread.', 'global', NULL, 'module-gtm', strftime('%s','now')*1000)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, parent_slug=excluded.parent_slug, updated_at=excluded.updated_at;

-- Refresh the runbook with the single-source knowledge map.
INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)
VALUES ('module-gtm', 'Module · GTM — leads, enrichment, outreach', 'GTM Builder folded into the command center. One module, four tabs:

- **Intake** — paste/CSV/URL phone lists to E.164 normalize to dedupe to offline geo-locate to lead rows. Enrichment chain per lead (accuracy order): WhatsApp (shared wa-gateway contact lookup) to company-from-LinkedIn (SerpApi) to PDL (paid, gated: skipped when name+company already present) to Twilio (line type; CNAM name only if still nameless) to Google search (HARD-GATED: requires an already-sourced name, never search an invented one). Per-field provenance in `sources`; disagreements recorded in `conflicts`, never overwritten; removed links tombstoned in `dismissed`.
- **Enrich** — GREEN leads only (first+last name + company + linkedin + position). Org chart from theorg (slug override for namesakes; CEO-mismatch means org_status=warn which BLOCKS outreach), ICP fit scored against [[brand-icp]], open roles via linkedin-gateway (company id cached on the lead; jobs via LinkedIn public guest API from the gateway residential IP).
- **Outreach** — per green lead, one Opus call assembles [[gtm-you]] + [[brand-positioning]] + [[gtm-outreach]] + the verified org into ranked angles with draft bubbles (strict JSON; invented-person guard; dash scrub). Edit bubbles inline; send per-bubble via wa.me links OR paced gateway send (4-9s jittered gaps, stop on failure, 10-min double-send guard, logged to gtm_sends + outbox).
- **You** — operator profile JSON in [[gtm-you]]: name/role/business/location/about + WhatsApp groups + warm connections. Consumed by Enrich (contact matching, "your contact is here") and Outreach (positioning + mutuals).

## Knowledge map — SINGLE SOURCE per fact, read live (no gtm-* copies of brand content)

The brand tree is the source of truth for anything that is not outreach-mechanics. The GTM module reads it live; it does not keep its own copies. When positioning/ICP/voice changes, edit the brand doc — the GTM behaviour follows automatically.

| Read at runtime by | Doc it reads | Where it lives |
|---|---|---|
| score_icp_fit (Enrich to ICP) | [[brand-icp]] | brand tree — the ICP, defined once |
| angles: what you do / what to avoid | [[brand-positioning]] | brand tree |
| angles: the positioning one-liner + mutuals | [[gtm-you]] `.business` / `.connections` | this module (operator record) |
| angles: strategy, language rules, exemplars, self-check, pacing | [[gtm-outreach]] | this module (outreach-specific, the only outreach doc) |

So the module owns exactly THREE docs: this runbook, [[gtm-you]] (operator record), and [[gtm-outreach]] (the writing guide). Everything else is read from the brand tree.

Nyo tools: gtm_import_leads, gtm_list_leads, gtm_read_lead, gtm_update_lead, gtm_enrich_lead, gtm_check_whatsapp, gtm_org_chart, gtm_score_icp, gtm_open_roles, gtm_outreach_angles, gtm_save_angles, gtm_send_outreach (CONFIRM with the operator before sending; refuses re-sends within 10 min unless force), gtm_lead_to_pipeline, gtm_green_leads, gtm_you, gtm_enrich_sources. Gateways: the SHARED wa-gateway + linkedin-gateway (same throttles as everything else); PDL/SerpApi/Twilio are optional secrets (PDL_API_KEY, SERPAPI_KEY, TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN), tools degrade gracefully when unset; system_health reports them. theorg is a public GraphQL API (health-checked).', 'global', NULL, 'knowledge-root', strftime('%s','now')*1000)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, parent_slug=excluded.parent_slug, updated_at=excluded.updated_at;
