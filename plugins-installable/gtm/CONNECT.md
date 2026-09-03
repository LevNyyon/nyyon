# Prospecting and Outreach: what it is and how to connect it

This plugin adds two pages to the sidebar.

- **Prospecting** — build a list of companies and people worth talking to: search for them, enrich what you know, score how well they fit, and keep the ones that matter.
- **Outreach** — work that list: draft the first message, pace the sending, watch for replies, and keep the thread in one place.

## Install it

1. Open **Plugins** in the sidebar.
2. Upload `gtm-2.0.0.zip`.
3. Wait about a minute. Prospecting and Outreach appear in the sidebar.

You can browse both pages immediately. Adding data sources is what makes them useful.

## What it needs

**A model key.** Already set if you finished setup. Scoring and drafting use the same one.

**Data sources are optional and separate.** Connect only what you want to pay for. Each is your own account and key; nothing is shared and no key is stored outside this install.

## Connect the data sources

Talk to Nyo. Say what you are connecting and paste the key; Nyo stores it and confirms.

**Search results (SerpApi)** — finds companies and pages by query.
1. Make an account at serpapi.com. The free tier is enough to try it.
2. Copy the API key from your dashboard.
3. Tell Nyo: *connect serpapi, the key is ...*

**Person enrichment (People Data Labs)** — turns a name, email or profile into a fuller record.
1. Make an account at peopledatalabs.com and copy the API key.
2. Tell Nyo: *connect people data labs, the key is ...*

**Phone validation (Twilio Lookup)** — checks a number is real before you use it.
1. In your Twilio console copy the **Account SID** and the **Auth Token**.
2. Tell Nyo: *connect twilio, the sid is ... and the token is ...*

To see what is connected, ask Nyo *which prospecting services are connected*. To remove one, ask Nyo to *disconnect people data labs*.

## What is off on this install, and why

- **LinkedIn company and job lookups.** These need a signed-in LinkedIn session running as its own service beside the app. This install has none, so those lookups report that in one sentence. Everything else keeps working.
- **Org charts.** Same reason: they came from a separate scraping service.
- **File storage.** Plugins do not get object storage here, so anything that would save a file reports it.
- **CRM deal stages.** The CRM on this install writes contacts but has no deal pipeline, so promoting a lead to a deal says so. Contacts are still written and the outreach thread continues.

## Sending messages

Outreach drafts and paces messages. Actually sending over WhatsApp works only if WhatsApp is connected on this install; if it is not, Nyo will say so rather than pretend a message went out. Every attempt is recorded, so a failed send is visible.

## Check status any time

Ask Nyo:

- *which prospecting services are connected*
- *what can Prospecting do on this install*
- *show me my outreach queue*

## Your rules

The scoring and drafting rules live in **Knowledge** as editable docs that ship with this plugin: who counts as a good fit, which titles to target, how the first message should sound, and how fast to send. Open Knowledge, edit a doc, and the next run follows it. No code, no redeploy.
