# Prospecting and Outreach: what it is and how to connect it

This plugin adds two pages to the sidebar.

- **Prospecting**: build a list of people worth talking to. Upload their numbers, enrich what you know, look up the company behind each one, and score how well they fit.
- **Outreach**: work that list. Draft the first message, queue it, send it, and keep every reply in one thread.

## Install it

1. Open **Plugins** in the sidebar.
2. Upload `gtm-3.0.0.zip`.
3. Wait about a minute. Prospecting and Outreach appear in the sidebar.

You can browse both pages immediately. Adding data sources is what makes them useful.

## What it needs

**A model key.** Already set if you finished setup. Scoring and drafting use the same one.

**Data sources are optional and separate.** Connect only what you want to pay for. Each is your own account and key; nothing is shared and no key is stored outside this install. An unconnected source is not an error: the step records itself as skipped and the rest of the chain runs.

## Connect the data sources

Talk to Nyo. Say what you are connecting and paste the key; Nyo stores it and confirms.

**Search results (SerpApi)**. Finds a person's LinkedIn profile, their socials, and the company behind them.
1. Make an account at serpapi.com. The free tier is enough to try it.
2. Copy the API key from your dashboard.
3. Tell Nyo: *connect serpapi, the key is ...*

**Person enrichment (People Data Labs)**. Turns a phone number into a fuller record.
1. Make an account at peopledatalabs.com and copy the API key.
2. Tell Nyo: *connect people data labs, the key is ...*

**Phone validation (Twilio Lookup)**. Checks a number is real, and which kind of line it is.
1. In your Twilio console copy the **Account SID** and the **Auth Token**.
2. Tell Nyo: *connect twilio, the sid is ... and the token is ...*

To see what is connected, ask Nyo *which prospecting services are connected*. To remove one, ask Nyo to *disconnect people data labs*.

## Sending messages: read this before you rely on Outreach

**Outreach sends over WhatsApp, and WhatsApp is the only channel it has. Sending needs a WhatsApp connection on this install.**

Everything up to the send works without it: upload a list, enrich it, score fit, draft the first message, review it, and queue it. The moment a queued message is due, it needs WhatsApp connected.

If WhatsApp is not connected, Nyo says so rather than pretending a message went out, and the queue simply waits. Every attempt is recorded, so a failed send is visible.

If you want Outreach to actually deliver, connect WhatsApp in Settings first. If you would rather send another way, that is a new channel plugin; ask Nyo for the plugin-building prompt.

## What it does, end to end

1. **Import** a list of phone numbers. Each becomes a lead, located from its prefix.
2. **Enrich** it: company and title read off the person's LinkedIn search result, then People Data Labs, then Twilio line validation, then a socials search. Each step records what it did, including why it skipped.
3. **Company context**: search the company, read its own site, and store what it does, its industry, HQ and headcount when a page states one.
4. **ICP match**: score the prospect against your ICP doc and save strong, medium or weak with reason and gap tags.
5. **Angles**: draft ranked ways in, with the actual message bubbles.
6. **Outreach**: open the conversation, take the suggested first message, and either send it now or queue it for a time you pick. A queued message is cancellable until it fires, and the same message can never be sent twice.
7. **Replies** land back in the same thread, and the prospect moves to answered.

## Check status any time

Ask Nyo:

- *which prospecting services are connected*
- *is whatsapp connected*
- *show me my outreach queue*
- *who has replied*

## Your rules

The scoring and drafting rules live in **Knowledge** as editable docs that ship with this plugin: who you are and who you can name (`plugin-gtm-you`), how a first touch is argued (`plugin-gtm-outreach`), the default first message (`plugin-gtm-outreach-first-touch`), how a suggested reply is written (`plugin-gtm-outreach-reply-drafting`), and when a queued send fires (`plugin-gtm-schedule`). Open Knowledge, edit a doc, and the next run follows it. No code, no redeploy.
