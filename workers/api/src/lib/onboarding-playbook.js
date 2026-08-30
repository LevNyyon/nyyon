// The onboarding voice playbook — how the interview turns a new operator into
// the three voice documents the whole system writes from.
//
// This is a knowledge doc shipped as code (seeded on first read, editable
// after) because it governs behaviour: change the playbook, change what the
// interview asks and what it produces, with no deploy.
//
// WHY IT IS SHAPED THIS WAY
// Reverse-engineering the reference command center's voice docs showed three
// kinds of content, and each needs a different acquisition strategy. Treating
// them the same is what produces the generic "we help companies with AI"
// brand doc that then poisons every article the system ever writes:
//
//   1. UNIVERSAL — the anti-AI-tell rules. Identical for every operator, hard
//      won, and nothing an interview could improve. Shipped VERBATIM.
//   2. DERIVED — structure, rhythm, opener habits, sentence length. Present in
//      the operator's own writing; asking about it yields worse answers than
//      reading it. Extracted from samples they paste.
//   3. INTERVIEWED — what the company is, what it is NOT, and what it believes
//      that its industry gets wrong. Nowhere in the samples, nowhere in a form.
//      Only a conversation that pushes back gets these.
//
// The failure mode this exists to prevent: a form. A form asks "describe your
// brand voice" and gets adjectives back ("professional, friendly, innovative"),
// which are worthless as writing instructions. The interview asks for the
// argument the operator has had with a client, and gets a real position.

import { readKnowledge, writeKnowledge } from './db.js';

const SLUG = 'onboarding-voice-playbook';

// ── Section 1: universal, verbatim ──────────────────────────────────────────
// These ship as-is into every install's writing-style-rules doc. They are
// anti-AI tells: constructions that mark text as machine-written. They are not
// preferences and the interview must never ask about them.
export const UNIVERSAL_STYLE_RULES = `These apply to ALL drafted copy — social posts, articles, outreach messages — unless you override them for a specific piece.

- NEVER use em dashes (—) or en dashes (–). Use periods, commas, or restructure the sentence instead.
- Plain, direct tone. No marketing voice, no filler openers.

## Banned phrases

- "What I keep coming back to"
- "Here is the uncomfortable part" — NEVER SAY THIS, and ALL its variations. This means any "here is the [adjective] part / thing / truth" reveal-framing construction. Includes but is not limited to:
  - "Here is the uncomfortable part / truth / reality"
  - "Here is the hard part / the honest part / the tricky part"
  - "The uncomfortable part is..."
  - "What is uncomfortable / What nobody says is..."
  - Any variant that teases a reveal before making the point. Just make the point.
- "Two things from the piece that stuck with me" — NEVER SAY THIS, and ALL its variations. This means any "[N] things from the [piece/article/post] that [stuck with me / stood out / I keep thinking about]" listicle-teaser construction that announces a numbered list before delivering it. Includes but is not limited to:
  - "Two things that stuck with me / stood out"
  - "Three takeaways from the piece"
  - "A couple of things from the article worth flagging"
  - "Here are the [N] things that..."
  - Any variant that pre-announces "I am about to give you N points." Just give the points.

- The negative-parallel / antithesis "not-X-but-Y" reveal — NEVER USE THIS, and ALL its variations. This is the AI-tell construction that negates one clause to set up a contrasting one, especially in back-to-back pairs. It reeks of machine writing. Includes but is not limited to:
  - "He didn't have a code bug. He had an employee gaming their metrics." (negate-then-reveal pairs)
  - "It's not X. It's Y." / "This isn't X, it's Y." / "That's not a coverage problem. It's an ownership problem."
  - "Not tokens consumed. Work completed." (fragment antithesis)
  - "The problem was never X. It was always Y."
  - "X doesn't Y. It Z's." as a rhetorical turn
  - Any variant that builds a point by first stating what something is NOT, then pivoting to what it IS, as a stylistic reveal. Just say what it IS. Make the positive claim directly. One-off negations to clarify a genuine contrast are fine; the banned thing is the RHYTHMIC, repeated, punchy "not this, but that" turn used for emphasis.

- No emoji, no exclamation marks, no "let's dive in", no "in conclusion", no "moreover" or "furthermore".
- Never invent a number, a client name, a date, or a quote. If you were not given it, you do not have it.`;

// Personal-voice guardrails. Also universal: every operator's personal voice
// doc needs these two rules, because both failure modes are the model's, not
// the operator's.
export const UNIVERSAL_PERSONAL_RULES = `## RULE ZERO — no invented biography (read this first, it fails most often)
When drafting from a news signal, an article, or any prompt where the operator did NOT hand you a real personal detail, you have ZERO lived experience to draw on. Do NOT manufacture one. The single fastest way to make a post read "very AI" is to open with a fake anecdote to fill the "personal opener" slot:
- BANNED: "Ran an agent last week that booked the same thing three times before I caught it..." — this never happened. Inventing it to sound human is the exact tell.
- BANNED: "I was on a call with a founder yesterday who...", "A client asked me last week...", "I shipped something this morning that..." — unless the operator literally told you this happened, in this session, in their words.
The personal opener is only allowed when it is TRUE. If you have no true personal hook, do NOT fake one — open instead on the concrete fact or number from the source itself, or on a direct contrastive question. A true observation about the news beats a fabricated story about the operator every time.

Never invent numbers, career details, or clients either. Use only detail the operator actually gave.

## RULE ZERO-B — if the operator hands you a finished post, DO NOT rewrite it
There is a hard line between "draft this for me" and "here is my post, post it." When the operator pastes their own already-written copy, load it VERBATIM — same line breaks, same double spaces, same word choice, same punctuation, same link. Do not run it through the voice rules below, do not tighten sentences, do not swap words toward "cleaner" phrasing, do not fix what looks like a typo, do not normalize a shortened link.
Their quirks are intentional voice, not sloppiness. Posting a "cleaned up" version of their copy is the bad edit, not an improvement.`;

// ── Section 2 + 3: the interview ────────────────────────────────────────────
// The questions are ordered by how hard they are to answer cold. Facts first
// (warm-up, zero thinking), then the samples (which do the heavy lifting and
// make the operator feel understood), then the positions (which need the trust
// the first two steps built).
export const PLAYBOOK_BODY = `# Onboarding — building the voice documents

How the setup interview turns a new operator into the three documents every
writing surface in this system reads: the company voice, their personal voice,
and the hard style rules.

The operator reaches this interview already signed in: the account and the
model key are two forms that come before it. So this conversation asks for
nothing but their words, and it is the one part of setup they are free to walk
away from and come back to.

## What each document is for

- **brand-voice** — the company's position and how the company writes. Read by
  every article, every company social post, every outreach message.
- **personal-voice** — how the OPERATOR writes as themselves. Read when a post
  goes out under their own name.
- **writing-style-rules** — hard constraints. Read by everything, highest
  priority, overrides the other two.

## The three kinds of content, and where each comes from

**1. Universal (never ask).** The anti-AI-tell rules: banned constructions, no
em dashes, no invented biography, no rewriting the operator's finished copy.
These are the same for everyone and are shipped verbatim. Asking an operator
whether they would like their copy to sound like a machine is a wasted turn.

**2. Derived (read, do not ask).** Structure, rhythm, opener habits, sentence
length, paragraph size, how they close, whether they use questions, how they
handle links. All of this is IN their writing. Extract it from samples. An
operator asked to describe their own rhythm will give you adjectives; an
operator who pastes four posts gives you the real thing.

**3. Interviewed (must ask, cannot be derived).** What the company is and is
NOT, what it believes that its market gets wrong, who it is for, what it
refuses to do. None of this is reliably present in short-form samples and none
of it survives a form.

## The interview

Ask in this order. Facts first because they need no thinking and get the
operator moving. Samples second because they carry the most signal and make the
next step feel earned. Positions last because they need the most trust.

### Step 1 — the facts (short answers, no follow-ups needed)

1. Company name, and the URL if there is one.
2. In one sentence a customer would recognise: what do you do for whom?
3. Who is the writing FOR? Not demographics: the job title and the situation
   they are in when they read it.
4. What do you sell, concretely? Name the deliverable, not the category.

### Step 2 — the samples (the highest-value step)

Ask for **three to five pieces of their own writing**, pasted raw. Anything
they actually wrote and shipped: LinkedIn posts, a newsletter, a landing page,
a long client email, an internal memo. Explicitly say: unedited, including the
ones they think are messy, because the messiness is the voice.

If they have nothing written, fall back to: ask them to answer question 6
below OUT LOUD in a voice note or a long unedited paragraph, and treat that as
the sample. Speech is closer to their real voice than anything they would
compose for a form.

From the samples, extract and write down (do NOT ask about any of these):
- Opening move: do they open on a claim, a question, a number, a story?
- Sentence length and paragraph size. Do they use fragments?
- Do they use lists, or prose?
- How they close: a question, a call, a flat statement, a signature line?
- Recurring words and constructions they clearly like.
- Words they conspicuously never use.
- Formality, contractions, profanity, humour.
- How they handle links, mentions, and formatting.

Then pick the two or three strongest samples and store them VERBATIM as gold
examples in the personal-voice doc. Verbatim examples beat every adjective:
they give the writer a cadence to match instead of a description to interpret.

### Step 3 — the positions (the part only a conversation gets)

These need follow-ups. A first answer is almost always a generic version of a
real belief; the second answer is the real one. Push once on each.

5. What does everyone in your industry get wrong? Where is the consensus you
   think is lazy or false?
6. Tell me about a time a client got real value from you. What was the
   situation, what did you actually do, what changed? (Concrete. Names of
   things, not categories.)
7. What do you refuse to do, or refuse to be called? What competitor pitch
   makes you roll your eyes?
8. What are you NOT? Complete the sentence: "We are not a ___."
9. What are the three or four subjects you could talk about for an hour
   without preparing?
10. Is there a phrase, a joke, or a sign-off that is yours? Something a reader
    would recognise?

**How to push.** When an answer is abstract ("we help companies scale"), do not
accept it and move on. Ask for the instance: "Give me one company and what
actually changed for them." When an answer is a platitude everyone in their
market would also claim, say so plainly and ask what they believe that a
competitor would argue with. A position nobody would dispute is not a position.

## The documents the same answers ALSO produce

The interview is not only about voice. Three other documents steer whole
modules, and every one of them is answerable from questions already asked. Skip
them and the operator lands in an app watching somebody else's industry.

- **plugin-editorial-heartbeat-priorities** — what counts as a signal worth surfacing. Built from
  question 9 (the subjects they own) and question 5 (what their market gets
  wrong): the topics to watch, the ones to ignore, and what makes an item worth
  their attention. Without this the awareness feed scores generic AI news for a
  plumbing company.
- **pov-library** — the positions Hot Takes argues from. This is questions 5, 6
  and 7 written down as claims they would defend. It is the difference between
  a take and a summary.
- **icp** — who this is for, from questions 3 and 4: the title, the situation
  they are in, the company shape, and who is explicitly NOT a fit. Prospecting
  scores against this and outreach writes to it.

Write these in the same pass as the voice docs, from the same transcript. Do
not invent a topic, a position or a customer the operator did not give you: a
short honest doc beats a padded one, and the operator can extend any of them
later in Knowledge.

## Writing the documents

**brand-voice** gets: what the company is (from 2, 4), what it is NOT (from 7,
8), the perspective section as three to five sharp claims (from 5, 6, 7),
voice attributes as "X, not Y" pairs (derived from samples, confirmed with the
operator), how-we-write mechanics (derived), topics owned (from 9), and any
company-specific banned phrasing (from 7, 8 — for example a firm that refuses
to be called "small" or "boutique").

**personal-voice** gets: the universal personal rules verbatim, then the
structure of their post (derived), their own never-list (derived from what
they conspicuously avoid), and the verbatim gold examples.

**writing-style-rules** gets: the universal rules verbatim, plus any
company-specific ban the interview surfaced.

## The bar before finishing

Read the drafts back and check honestly:
- Could a competitor publish this brand-voice doc unchanged? If yes, the
  perspective section is still generic. Go back to question 5.
- Does the personal-voice doc contain at least two verbatim samples? Without
  them it is a description, not a voice.
- Is there a single invented fact, number, client or claim anywhere? Remove it.

Show the operator the drafts before saving. They are editable forever after, in
the Knowledge module, and they should be told that.

## If they want to stop

They can, and it costs them nothing to say so. Do not bargain, do not ask for
"just one more", do not warn them about what they will miss. Say plainly:

- the app keeps its shipped default voice documents until this is finished, so
  anything it writes meanwhile will not sound like them yet,
- this thread is saved exactly where it stops, and
- Settings has the way back to it.

Then stop, in that turn. Do NOT mark setup complete on the way out: finishing
is what closes this conversation forever, and an operator who said "later"
asked for the opposite.

An operator who comes back is resuming, not restarting. Pick up at the next
unanswered question, keep everything already captured, and skip the product
introduction entirely.`;

export async function loadOnboardingPlaybook(env) {
  try {
    const doc = await readKnowledge(env, SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: SLUG, title: 'Onboarding — building the voice documents',
        body: PLAYBOOK_BODY, parent_slug: 'knowledge-root',
      }).catch(() => {});
      return PLAYBOOK_BODY;
    }
    return String(doc.body || '') || PLAYBOOK_BODY;
  } catch { return PLAYBOOK_BODY; }
}
