-- GTM knowledge, deduplicated. The brand tree (brand-icp, lev-positioning,
-- brand-messaging, nyyon-brand-voice) is the single source of truth for ICP /
-- positioning / voice; the GTM code reads it live rather than keeping copies.
-- The old gtm-* copies + the four split outreach docs are dropped in favour of
-- ONE self-contained outreach doc that absorbs gtm-blackbox docs/outreach-
-- messaging.md, so the command center no longer depends on that repo.

-- Drop the duplicates + the split/seed outreach docs (leaf docs, no children).
DELETE FROM knowledge_docs WHERE slug IN (
  'gtm-icp', 'gtm-outreach-playbook', 'gtm-outreach-rules',
  'gtm-outreach-examples', 'gtm-outreach-spec'
);

-- The single outreach control surface (GTM-specific; brand voice/positioning
-- are read live from the brand tree, never copied in here).
INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)
VALUES ('gtm-outreach', 'GTM · Outreach — the writing guide', 'The single control surface for first-touch outreach. The angles generator reads THIS doc + [[lev-positioning]] (who Nyyon is / what to avoid) + the operator''s [[gtm-you]] record. Edit this to change how outreach is written.

Positioning and brand voice are NOT repeated here — they live once in the brand tree ([[lev-positioning]], [[brand-messaging]], [[nyyon-brand-voice]]) and are read live. ICP scoring reads [[brand-icp]]. (Absorbs the old gtm-blackbox docs/outreach-messaging.md — this is its only home now.)

## Mission
Israeli founders running North American companies (classic profile: NYC office, US phone, English LinkedIn). Channel: WhatsApp. Language: Hebrew by default. A first touch is never a sale — the goal is a yes to a short talk WITH the prospect, earned by proof of work.

## Strategy — pick the warmest REAL angle, never invent one
1. Warm mutual: a real shared person who vouches for you to the prospect.
2. Timely trigger: a real recent event (a raise, a key hire, a launch, a new office).
3. Right-door referral: you tried the real owner of the relevant function, name them and their role, then ask to talk to the prospect.
No real mutual or trigger, then it is a cold touch: lead with who you are and one line of what you do, honest, no fake warmth. Selective, never desperate.

## The spine: proof of work before the ask
The ask only ever COMPLETES work you already did and showed. Naming the specific person you already tried, and their role, IS the proof.
- Strong: you found the person and tried them, you ask only for the warm nudge.
- Banned: asking the founder to identify someone whose title is one LinkedIn search away, that makes them your research assistant, low status, reads rude.

## Decision tree (run before writing)
1. Real mutual? then Warm mutual (warmest).
2. Else real recent trigger? then Timely trigger (name the local owner if findable).
3. Else Organizational referral. Is the function FINDABLE (marketing, sales, ops, growth, eng)?
   - YES: you must have the named person. Pattern: tried to reach <name>, did not work, ask to connect. No name means insufficient context, go get the name.
   - NO (genuinely internal: special projects, the owner of some messy initiative): a discovery ask is allowed ("מי אחראי על <role>").
4. Always include the source line (how you found them).

## Hard rules
- Ask = a short talk WITH the prospect, never "connect me to X".
- Positioning: include ONE plain line of what Nyyon does (from gtm-you.business / lev-positioning), a reason, not a pitch. NEVER the retired marketing frame (marketing, landing pages, funnels, campaigns, fractional CMO). Nyyon is a forward-deployed AI consultancy.
- No selling: banned phrases include "would you be open to", "let''s connect", "synergies", "opportunities", "potential", "I noticed", "Hi I''m X", and anything that asks to buy or book.
- Texting punctuation, not formal writing: no emoji, no hyphens, no em or en dashes. Never end a bubble with a period. One question mark, on the ask. Minimal commas. No links, titles, signatures, or "מה שלומך" filler.
- Length: Hebrew 2 to 3 bubbles under ~30 words (English up to 4 under ~45). Bubble 1 = who you are + the tiny "how I found you" parenthetical. Then proof of work + the one positioning line. Last bubble = the one-tap ask.
- Facts: every name, role, trigger, mutual must be real. A missing input is a context problem, flag it ("insufficient context: missing X"), never invent it.

## Skeleton (Hebrew, the real sent style)
היי <first name>, לב (<source>)
<proof of work or trigger>. <one-tap ask>

## Exemplar bank
GOOD (real, sent):
- היי עידן, לב (דרך הקבוצה של גיא פרנקלין) / ניסיתי להגיע לנדב שאחראי אצלכם על השיווק ולא כ"כ הסתייע. תוכל לחבר בינינו?
  why: findable role, named person, proof of work, one-tap ask. The canonical one.
- היי עידן, לב (דרך הקבוצה של גיא פרנקלין) / מי אחראי אצלכם על פרויקטים פנימיים מיוחדים? אשמח לשבת איתו אם תוכל לחבר בינינו
  why: a discovery ask is fine here, the role is not findable on LinkedIn.
- היי תומר, לב / אסף שלח אותי אליך, אמר שאתה האדם לדבר איתו על פרוייקטים חיצוניים בחברה. שווה קפה קצר?
  why: the mutual carries it, and the vouch names the specific subject (external projects).
BAD:
- מי מוביל אצלכם את השיווק? (findable role, no proof of work, lazy, makes them do your homework)
- ניסיתי להבין מי מוביל את השיווק ולא הצלחתי (admits you skipped a 30-second search, weak)
- אנחנו עוזרים לחברות כמוכם לבצע X, מעוניין? (selling, banned in a first touch)
- one long paragraph, commas everywhere, a 🙏🏼 on the ask (wrong format, translation smell, emoji)
English forms (adapt):
- cold: hi [name], Lev from Nyyon
- via mutual: hi [name], [mutual] pointed me your way
- right door: hi [name], I tried reaching [person] who owns [function] and it did not quite work out
- ask: worth 15 minutes?

## Voice — avoid translation smell
Israelis clip. Do not write grammatically perfect sentences end to end. Drop linking words (אשר, מאחר, לפיכך, בנוסף). No formal opener or closer. Real texting forms: כ"כ, אצלכם, "שווה קפה?", "לא ממש הלך", "תוכל לחבר?". The two GOOD org-referral examples are the voice anchor.

## Self-check (gate every draft, rewrite until all pass)
- [ ] Hebrew reads like a real Israeli text, no translation smell
- [ ] 2 to 3 short bubbles, under ~30 words
- [ ] texting punctuation: no hyphens, no dashes, no emoji, no period ending a bubble, one question mark on the ask
- [ ] the "how I found you" is present
- [ ] proof of work present and SPECIFIC (a named person for findable roles)
- [ ] no discovery ask on a findable role
- [ ] the ask is one tap, no request for the recipient''s time in a cold first touch
- [ ] zero sell, never the retired marketing frame
- [ ] every fact (name, role, trigger, mutual) is real, nothing invented

## Pacing (implemented by gtm_send_outreach; defaults tunable here)
Send like a person texting, not a bot pasting a block. Each bubble is its OWN message, in order, never concatenated. Human gap 4 to 9 seconds jittered every time (a constant gap reads automated), scaled loosely to the next bubble''s length, cap ~12s. All bubbles land in the same thread. If any bubble fails to send, STOP, do not fire the rest into a half-sent thread.', 'global', NULL, 'module-gtm', strftime('%s','now')*1000)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, parent_slug=excluded.parent_slug, updated_at=excluded.updated_at;

-- Refresh the runbook with the single-source knowledge map.
INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)
VALUES ('module-gtm', 'Module · GTM — leads, enrichment, outreach', 'GTM Builder folded into the command center. One module, four tabs:

- **Intake** — paste/CSV/URL phone lists to E.164 normalize to dedupe to offline geo-locate to lead rows. Enrichment chain per lead (accuracy order): WhatsApp (shared wa-gateway contact lookup) to company-from-LinkedIn (SerpApi) to PDL (paid, gated: skipped when name+company already present) to Twilio (line type; CNAM name only if still nameless) to Google search (HARD-GATED: requires an already-sourced name, never search an invented one). Per-field provenance in `sources`; disagreements recorded in `conflicts`, never overwritten; removed links tombstoned in `dismissed`.
- **Enrich** — GREEN leads only (first+last name + company + linkedin + position). Org chart from theorg (slug override for namesakes; CEO-mismatch means org_status=warn which BLOCKS outreach), ICP fit scored against [[brand-icp]], open roles via linkedin-gateway (company id cached on the lead; jobs via LinkedIn public guest API from the gateway residential IP).
- **Outreach** — per green lead, one Opus call assembles [[gtm-you]] + [[lev-positioning]] + [[gtm-outreach]] + the verified org into ranked angles with draft bubbles (strict JSON; invented-person guard; dash scrub). Edit bubbles inline; send per-bubble via wa.me links OR paced gateway send (4-9s jittered gaps, stop on failure, 10-min double-send guard, logged to gtm_sends + outbox).
- **You** — operator profile JSON in [[gtm-you]]: name/role/business/location/about + WhatsApp groups + warm connections. Consumed by Enrich (contact matching, "your contact is here") and Outreach (positioning + mutuals).

## Knowledge map — SINGLE SOURCE per fact, read live (no gtm-* copies of brand content)

The brand tree is the source of truth for anything that is not outreach-mechanics. The GTM module reads it live; it does not keep its own copies. When positioning/ICP/voice changes, edit the brand doc — the GTM behaviour follows automatically.

| Read at runtime by | Doc it reads | Where it lives |
|---|---|---|
| score_icp_fit (Enrich to ICP) | [[brand-icp]] | brand tree — the ICP, defined once |
| angles: who Nyyon is / retired-frame ban | [[lev-positioning]] | brand tree |
| angles: the positioning one-liner + mutuals | [[gtm-you]] `.business` / `.connections` | this module (operator record) |
| angles: strategy, Hebrew rules, exemplars, self-check, pacing | [[gtm-outreach]] | this module (outreach-specific, the only outreach doc) |

So the module owns exactly THREE docs: this runbook, [[gtm-you]] (operator record), and [[gtm-outreach]] (the writing guide). Everything else is read from the brand tree. The retired marketing/agency/fractional-CMO frame is banned in outreach — Nyyon is a forward-deployed AI consultancy ([[lev-positioning]]).

Nyo tools: gtm_import_leads, gtm_list_leads, gtm_read_lead, gtm_update_lead, gtm_enrich_lead, gtm_check_whatsapp, gtm_org_chart, gtm_score_icp, gtm_open_roles, gtm_outreach_angles, gtm_save_angles, gtm_send_outreach (CONFIRM with the operator before sending; refuses re-sends within 10 min unless force), gtm_lead_to_pipeline, gtm_green_leads, gtm_you, gtm_enrich_sources. Gateways: the SHARED wa-gateway + linkedin-gateway (same throttles as everything else); PDL/SerpApi/Twilio are optional secrets (PDL_API_KEY, SERPAPI_KEY, TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN), tools degrade gracefully when unset; system_health reports them. theorg is a public GraphQL API (health-checked).', 'global', NULL, 'knowledge-root', strftime('%s','now')*1000)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, parent_slug=excluded.parent_slug, updated_at=excluded.updated_at;

