# Editorial: what it is and how to connect it

Editorial is the writing side of your command center. It adds three pages to the sidebar.

- **Blog** — write articles with the AEO writer: it interviews you, drafts, and keeps the piece in your voice. Posts live in this install.
- **Hot Takes** — you drop a link or a thought, it works up an angle and produces a post.
- **Social** — drafts for LinkedIn and Facebook, and posting through your own webhooks.

## Install it

1. Open **Plugins** in the sidebar.
2. Upload `editorial-2.0.0.zip`.
3. Wait about a minute. The page shows it move from accepted to active, then Blog, Hot Takes and Social appear in the sidebar.

Nothing else is required to start writing. The rest below is optional and only needed for publishing outward.

## What it needs

**A model key.** Already set if you finished setup. Editorial uses the same Anthropic key as everything else, on the standard tier. No second key.

**Nothing else is mandatory.** Everything below is for pushing posts out of this install.

## Connect social posting (optional)

This install never holds your LinkedIn or Facebook password. You create a small automation that accepts a message and posts it, then give Editorial its web address.

1. Make a free account at make.com.
2. Create a scenario. For the first step choose **Webhooks** then **Custom webhook**, and press **Add**. Make gives you a URL that looks like `https://hook.eu2.make.com/abc123...`. Copy it.
3. Add a second step: **LinkedIn** (or **Facebook Pages**) then *Create a post*. Connect your account there, inside Make, where it belongs.
4. In that step's text field, insert the webhook's `text` value. The message Editorial sends looks like `{ "text": "...", "url": "...", "image_url": null }`.
5. Turn the scenario on.
6. Come back here, open **Nyo**, and say: *connect my linkedin webhook, the URL is https://hook.eu2.make.com/abc123*. Nyo stores it and confirms.

Repeat for Facebook with the network name `facebook`. To check what is connected, ask Nyo *which social networks are connected*. To remove one, ask Nyo to *disconnect the linkedin webhook*.

The same works with any endpoint that accepts JSON, not just Make. Zapier, n8n, or your own worker are all fine.

## What is off on this install, and why

Editorial was built for a host with more machinery. On this install it works fully as a writer and reports the rest honestly instead of failing quietly.

- **Images.** Covers, article figures and social cards need an image renderer this install does not carry. Anything that would produce an image says so in one sentence. Text articles and posts are unaffected.
- **Vision.** Judging candidate images needs a vision model; the model connection here is text and JSON. Image judging is skipped and says so.
- **Calendar scheduling.** Scheduling a release into a calendar needs a calendar connection this install does not have. Publish now instead, or track the date in your plan.
- **WhatsApp delivery.** Works only if you have connected WhatsApp; otherwise it reports that it is not connected.

None of these block writing, editing, or publishing text.

## Where things go

Articles and posts are stored in this install and shown on the Blog page. This build has no public website deploy, so publishing means the post is final and stored here, ready to copy out or push through a webhook. Every outbound attempt is recorded, so a failed send is visible rather than silent.

## Check status any time

Ask Nyo:

- *which social networks are connected*
- *list my blog posts*
- *what is in the editorial outbox*
- *what does Editorial need that is not connected*

## Your voice

Editorial reads your writing rules from Knowledge and follows them on every draft. After installing, open **Knowledge** and fill in these, which ship with starter text:

- **Brand** and **Brand voice** — how the company sounds.
- **Personal voice** — how you sound when you write as yourself.
- **Writing style rules** — the hard rules, already sensible by default.
- **Company profile** and **Ideal customer profile** — who you are and who you are writing for.

Edit a doc and the next draft follows it. No code, no redeploy.
