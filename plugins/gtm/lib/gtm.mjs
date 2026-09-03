// GTM plugin — lead store + identity enrichment + company context (lib).
// Ported from workers/api/src/lib/gtm.js and workers/api/src/lib/gtm-context.js
// under the plugin capability contract: every function that needs the outside
// world takes `api` as its FIRST argument (api.db / api.gateway / api.knowledge /
// api.saveKnowledge / api.log). This file imports NOTHING.
//
// The intake + identity-enrichment layer: lead store, phone-list import, and the
// per-lead enrichment chain (accuracy order):
//   locate (at import) → company-from-LinkedIn-result → PDL → Twilio → Google
// External services are reached ONLY through declared gateways:
//   web(text) · pdl(person) · twilio(lookup) · serp(search) · llm(text)
// pdl, serp and twilio are the pack's OWN bundled gateways: each one reads the
// key the operator pasted, and answers a plain "not connected" when there is
// none, so every step degrades to a skip rather than a failure.
//
// Provenance model (ported): leads.sources = {field:{tool,at}}; disagreements
// append to leads.conflicts instead of overwriting; removed social links are
// tombstoned in leads.dismissed so searches never re-add them.

const now = () => Date.now();
const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ── phone helpers (duplicated from lib/gtm-phone.js — lib files import nothing) ─
// Derive country and state/region from a phone number by its FORMAT only (no
// network call). For +1 (NANP) we map the area code to a US state, Canadian
// province, or Caribbean country. Otherwise we map the calling code to a country.

const ST = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
  NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

// US area code -> state abbreviation
const US = {
  '205':'AL','251':'AL','256':'AL','334':'AL','659':'AL','938':'AL','907':'AK',
  '480':'AZ','520':'AZ','602':'AZ','623':'AZ','928':'AZ','479':'AR','501':'AR','870':'AR',
  '209':'CA','213':'CA','279':'CA','310':'CA','323':'CA','341':'CA','350':'CA','408':'CA','415':'CA','424':'CA','442':'CA','510':'CA','530':'CA','559':'CA','562':'CA','619':'CA','626':'CA','628':'CA','650':'CA','657':'CA','661':'CA','669':'CA','707':'CA','714':'CA','747':'CA','760':'CA','805':'CA','818':'CA','820':'CA','831':'CA','840':'CA','858':'CA','909':'CA','916':'CA','925':'CA','949':'CA','951':'CA',
  '303':'CO','719':'CO','720':'CO','970':'CO','983':'CO','203':'CT','475':'CT','860':'CT','959':'CT',
  '302':'DE','202':'DC',
  '239':'FL','305':'FL','321':'FL','352':'FL','386':'FL','407':'FL','561':'FL','656':'FL','689':'FL','727':'FL','754':'FL','772':'FL','786':'FL','813':'FL','850':'FL','863':'FL','904':'FL','941':'FL','954':'FL',
  '229':'GA','404':'GA','470':'GA','478':'GA','678':'GA','706':'GA','762':'GA','770':'GA','912':'GA','943':'GA','808':'HI','208':'ID','986':'ID',
  '217':'IL','224':'IL','309':'IL','312':'IL','331':'IL','447':'IL','464':'IL','618':'IL','630':'IL','708':'IL','730':'IL','773':'IL','779':'IL','815':'IL','847':'IL','872':'IL',
  '219':'IN','260':'IN','317':'IN','463':'IN','574':'IN','765':'IN','812':'IN','930':'IN',
  '319':'IA','515':'IA','563':'IA','641':'IA','712':'IA','316':'KS','620':'KS','785':'KS','913':'KS',
  '270':'KY','364':'KY','502':'KY','606':'KY','859':'KY','225':'LA','318':'LA','337':'LA','504':'LA','985':'LA','207':'ME',
  '240':'MD','301':'MD','410':'MD','443':'MD','667':'MD',
  '339':'MA','351':'MA','413':'MA','508':'MA','617':'MA','774':'MA','781':'MA','857':'MA','978':'MA',
  '231':'MI','248':'MI','269':'MI','313':'MI','517':'MI','586':'MI','616':'MI','679':'MI','734':'MI','810':'MI','906':'MI','947':'MI','989':'MI',
  '218':'MN','320':'MN','507':'MN','612':'MN','651':'MN','763':'MN','952':'MN','228':'MS','601':'MS','662':'MS','769':'MS',
  '314':'MO','417':'MO','557':'MO','573':'MO','636':'MO','660':'MO','816':'MO','406':'MT','308':'NE','402':'NE','531':'NE',
  '702':'NV','725':'NV','775':'NV','603':'NH',
  '201':'NJ','551':'NJ','609':'NJ','640':'NJ','732':'NJ','848':'NJ','856':'NJ','862':'NJ','908':'NJ','973':'NJ','505':'NM','575':'NM',
  '212':'NY','315':'NY','332':'NY','347':'NY','363':'NY','516':'NY','518':'NY','585':'NY','607':'NY','631':'NY','646':'NY','680':'NY','716':'NY','718':'NY','838':'NY','845':'NY','914':'NY','917':'NY','929':'NY','934':'NY',
  '252':'NC','336':'NC','472':'NC','704':'NC','743':'NC','828':'NC','910':'NC','919':'NC','980':'NC','984':'NC','701':'ND',
  '216':'OH','220':'OH','234':'OH','283':'OH','326':'OH','330':'OH','380':'OH','419':'OH','440':'OH','513':'OH','567':'OH','614':'OH','740':'OH','937':'OH',
  '405':'OK','539':'OK','572':'OK','580':'OK','918':'OK','458':'OR','503':'OR','541':'OR','971':'OR',
  '215':'PA','223':'PA','267':'PA','272':'PA','412':'PA','445':'PA','484':'PA','570':'PA','582':'PA','610':'PA','717':'PA','724':'PA','814':'PA','835':'PA','878':'PA','401':'RI',
  '803':'SC','839':'SC','843':'SC','854':'SC','864':'SC','605':'SD','423':'TN','615':'TN','629':'TN','731':'TN','865':'TN','901':'TN','931':'TN',
  '210':'TX','214':'TX','254':'TX','281':'TX','325':'TX','346':'TX','361':'TX','409':'TX','430':'TX','432':'TX','469':'TX','512':'TX','682':'TX','713':'TX','726':'TX','737':'TX','806':'TX','817':'TX','830':'TX','832':'TX','903':'TX','915':'TX','936':'TX','940':'TX','945':'TX','956':'TX','972':'TX','979':'TX',
  '385':'UT','435':'UT','801':'UT','802':'VT',
  '276':'VA','434':'VA','540':'VA','571':'VA','686':'VA','703':'VA','757':'VA','804':'VA','826':'VA','948':'VA',
  '206':'WA','253':'WA','360':'WA','425':'WA','509':'WA','564':'WA','304':'WV','681':'WV',
  '262':'WI','274':'WI','414':'WI','534':'WI','608':'WI','715':'WI','920':'WI','307':'WY',
};

// US territories (country = United States)
const USTERR = { '787':'Puerto Rico','939':'Puerto Rico','671':'Guam','340':'U.S. Virgin Islands','684':'American Samoa','670':'Northern Mariana Islands' };

// Canadian area code -> province/territory (country = Canada)
const CANADA = {
  '403':'Alberta','587':'Alberta','780':'Alberta','825':'Alberta','368':'Alberta',
  '236':'British Columbia','250':'British Columbia','604':'British Columbia','672':'British Columbia','778':'British Columbia','257':'British Columbia',
  '204':'Manitoba','431':'Manitoba','584':'Manitoba','506':'New Brunswick','709':'Newfoundland and Labrador','879':'Newfoundland and Labrador',
  '782':'Nova Scotia','902':'Nova Scotia','867':'Northern Canada',
  '226':'Ontario','249':'Ontario','343':'Ontario','365':'Ontario','382':'Ontario','416':'Ontario','437':'Ontario','519':'Ontario','548':'Ontario','613':'Ontario','647':'Ontario','683':'Ontario','705':'Ontario','742':'Ontario','753':'Ontario','807':'Ontario','905':'Ontario',
  '367':'Quebec','418':'Quebec','438':'Quebec','450':'Quebec','514':'Quebec','579':'Quebec','581':'Quebec','819':'Quebec','873':'Quebec','263':'Quebec','354':'Quebec',
  '306':'Saskatchewan','639':'Saskatchewan','474':'Saskatchewan',
};

// Other NANP (+1) countries -> country, no region
const CARIB = {
  '242':'Bahamas','246':'Barbados','264':'Anguilla','268':'Antigua and Barbuda','284':'British Virgin Islands','345':'Cayman Islands','441':'Bermuda','473':'Grenada','649':'Turks and Caicos','658':'Jamaica','664':'Montserrat','721':'Sint Maarten','758':'Saint Lucia','767':'Dominica','784':'Saint Vincent and the Grenadines','809':'Dominican Republic','829':'Dominican Republic','849':'Dominican Republic','868':'Trinidad and Tobago','869':'Saint Kitts and Nevis','876':'Jamaica',
};

// ITU country calling codes -> country (non-NANP). Longest-prefix matched.
const CALLING = {
  '1':'United States/Canada','7':'Russia','20':'Egypt','27':'South Africa','30':'Greece','31':'Netherlands','32':'Belgium','33':'France','34':'Spain','36':'Hungary','39':'Italy','40':'Romania','41':'Switzerland','43':'Austria','44':'United Kingdom','45':'Denmark','46':'Sweden','47':'Norway','48':'Poland','49':'Germany',
  '51':'Peru','52':'Mexico','53':'Cuba','54':'Argentina','55':'Brazil','56':'Chile','57':'Colombia','58':'Venezuela','60':'Malaysia','61':'Australia','62':'Indonesia','63':'Philippines','64':'New Zealand','65':'Singapore','66':'Thailand',
  '81':'Japan','82':'South Korea','84':'Vietnam','86':'China','90':'Turkey','91':'India','92':'Pakistan','93':'Afghanistan','94':'Sri Lanka','95':'Myanmar','98':'Iran',
  '212':'Morocco','213':'Algeria','216':'Tunisia','218':'Libya','220':'Gambia','221':'Senegal','233':'Ghana','234':'Nigeria','251':'Ethiopia','254':'Kenya','255':'Tanzania','256':'Uganda','260':'Zambia','263':'Zimbabwe',
  '350':'Gibraltar','351':'Portugal','352':'Luxembourg','353':'Ireland','354':'Iceland','355':'Albania','356':'Malta','357':'Cyprus','358':'Finland','359':'Bulgaria','370':'Lithuania','371':'Latvia','372':'Estonia','373':'Moldova','374':'Armenia','375':'Belarus','376':'Andorra','377':'Monaco','378':'San Marino','380':'Ukraine','381':'Serbia','382':'Montenegro','383':'Kosovo','385':'Croatia','386':'Slovenia','387':'Bosnia and Herzegovina','389':'North Macedonia',
  '420':'Czech Republic','421':'Slovakia','423':'Liechtenstein',
  '852':'Hong Kong','853':'Macau','855':'Cambodia','856':'Laos','880':'Bangladesh','886':'Taiwan',
  '960':'Maldives','961':'Lebanon','962':'Jordan','963':'Syria','964':'Iraq','965':'Kuwait','966':'Saudi Arabia','967':'Yemen','968':'Oman','970':'Palestine','971':'United Arab Emirates','972':'Israel','973':'Bahrain','974':'Qatar','975':'Bhutan','976':'Mongolia','977':'Nepal','992':'Tajikistan','993':'Turkmenistan','994':'Azerbaijan','995':'Georgia','996':'Kyrgyzstan','998':'Uzbekistan',
};

function nanp(area) {
  if (US[area]) return { country: 'United States', region: ST[US[area]], area_code: area };
  if (USTERR[area]) return { country: 'United States', region: USTERR[area], area_code: area };
  if (CANADA[area]) return { country: 'Canada', region: CANADA[area], area_code: area };
  if (CARIB[area]) return { country: CARIB[area], region: null, area_code: area };
  return { country: null, region: null, area_code: area };
}

function locatePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return { country: null, region: null, area_code: null };
  if (digits.length === 11 && digits[0] === '1') return nanp(digits.slice(1, 4));
  if (digits.length === 10) return nanp(digits.slice(0, 3)); // NANP without country code
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (CALLING[code]) return { country: CALLING[code], region: null, area_code: null };
  }
  return { country: null, region: null, area_code: null };
}

// Calling code -> ISO2 country, for building Truecaller search URLs.
const CC_ISO = {
  '1':'us','7':'ru','20':'eg','27':'za','30':'gr','31':'nl','32':'be','33':'fr','34':'es','36':'hu','39':'it','40':'ro','41':'ch','43':'at','44':'gb','45':'dk','46':'se','47':'no','48':'pl','49':'de',
  '51':'pe','52':'mx','53':'cu','54':'ar','55':'br','56':'cl','57':'co','58':'ve','60':'my','61':'au','62':'id','63':'ph','64':'nz','65':'sg','66':'th','81':'jp','82':'kr','84':'vn','86':'cn','90':'tr','91':'in','92':'pk','93':'af','94':'lk','95':'mm','98':'ir',
  '212':'ma','213':'dz','216':'tn','218':'ly','220':'gm','221':'sn','233':'gh','234':'ng','251':'et','254':'ke','255':'tz','256':'ug','260':'zm','263':'zw',
  '350':'gi','351':'pt','352':'lu','353':'ie','354':'is','355':'al','356':'mt','357':'cy','358':'fi','359':'bg','370':'lt','371':'lv','372':'ee','373':'md','374':'am','375':'by','376':'ad','377':'mc','378':'sm','380':'ua','381':'rs','382':'me','383':'xk','385':'hr','386':'si','387':'ba','389':'mk','420':'cz','421':'sk','423':'li',
  '852':'hk','853':'mo','855':'kh','856':'la','880':'bd','886':'tw','960':'mv','961':'lb','962':'jo','963':'sy','964':'iq','965':'kw','966':'sa','967':'ye','968':'om','970':'ps','971':'ae','972':'il','973':'bh','974':'qa','975':'bt','976':'mn','977':'np','992':'tj','993':'tm','994':'az','995':'ge','996':'kg','998':'uz',
};

// Best-effort outward link to a Truecaller search for a number. The operator has
// their own Truecaller login; this just lands them on the right search.
function truecallerUrl(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits[0] === '1') {
    const iso = CANADA[digits.slice(1, 4)] ? 'ca' : 'us';
    return `https://www.truecaller.com/search/${iso}/${digits.slice(1)}`;
  }
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (CC_ISO[code]) return `https://www.truecaller.com/search/${CC_ISO[code]}/${digits.slice(len)}`;
  }
  return `https://www.truecaller.com/search/us/${digits}`;
}

// Normalize one number to E.164 and flag validity.
function normalizePhone(number, defaultCC = '+972') {
  const raw = String(number || '');
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = defaultCC + d.replace(/\D/g, '').replace(/^0+/, '');
  const valid = /^\+\d{8,15}$/.test(d);
  return { normalized: valid ? d : raw, valid };
}

// Parse pasted text (one per line, or a CSV with a phone column) into candidates.
function parsePhoneList(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let idx = 0;
  if (/[a-z]/i.test(lines[0]) && lines[0].includes(',')) {
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    idx = Math.max(0, headers.indexOf('phone'));
    lines.shift();
  }
  return lines
    .map((l) => (l.includes(',') ? l.split(',')[idx] : l).trim())
    .filter((p) => /\d/.test(p));
}

// ── lead store (the only way anything touches plugin_gtm_leads) ──────────────

const LEAD_COLS = new Set([
  'phone', 'normalized_phone', 'status', 'source', 'batch_id', 'country', 'region',
  'name', 'photo', 'socials', 'linkedin', 'email', 'company', 'position',
  'line_type', 'carrier', 'sources', 'conflicts', 'dismissed', 'active_tool',
  'icp_fit', 'icp_reasons',
  'company_li_id', 'open_positions', 'positions_checked_at', 'outreach_lang', 'client_id',
  'steps',
  'company_staff_count', 'company_context', 'company_checked_at',
]);

// ── the enrichment chain, as data ────────────────────────────────────────────
// The five steps enrichFullOne runs, in order, each with the predicate that
// decides whether a call that RAN actually found anything. `label` travels with
// the persisted record so a surface renders what the chain reports rather than
// keeping its own copy of the step list.
const ENRICH_STEPS = [
  { key: 'li',      label: 'LinkedIn', found: (r) => !!r.company },
  { key: 'pdl',     label: 'PDL',      found: (r) => !!(r.matched && (r.name || r.company)) },
  { key: 'twilio',  label: 'Twilio',   found: (r) => !!(r.line_type || r.carrier || r.caller_name) },
  { key: 'serp',    label: 'SerpApi',  found: (r) => (r.added || 0) > 0 || (r.linkedin_verified || 0) > 0 },
  { key: 'confirm', label: 'Confirm',  found: (r) => !!r.company },
];

// Steps outside the enrichment chain (the manual ICP match) live in the SAME
// steps column; every chain writer must carry them forward or a re-enrich
// silently erases the record of a run it knows nothing about.
const ENRICH_KEYS = new Set(ENRICH_STEPS.map((d) => d.key));
const foreignSteps = (prior) => (Array.isArray(prior) ? prior : []).filter((s) => s && !ENRICH_KEYS.has(s.key));

// Turn one step's return value into a persisted verdict. Every step returns
// either data, {skipped:<why>}, or {error:<msg>} — this is the only place that
// mapping lives, so "why is that dot amber" has exactly one answer.
function stepVerdict(def, r, at) {
  const base = { key: def.key, label: def.label, at };
  if (!r || typeof r !== 'object') return { ...base, status: 'empty', reason: null };
  if (r.skipped)         return { ...base, status: 'skipped', reason: String(r.skipped) };
  if (r.error)           return { ...base, status: 'error',   reason: String(r.error) };
  if (r.matched === false) return { ...base, status: 'empty', reason: 'no match for this phone number' };
  const found = def.found(r);
  return { ...base, status: found ? 'found' : 'empty', reason: found ? null : (r.note ? String(r.note) : null) };
}

export async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

export async function listLeads(api, { batch_id = null, status = null, q = null, stage = null, limit = 500 } = {}) {
  const where = [];
  const binds = [];
  if (batch_id) { where.push('batch_id = ?'); binds.push(batch_id); }
  if (status)   { where.push('status = ?');   binds.push(status); }
  if (q)        { where.push('(name LIKE ? OR company LIKE ? OR phone LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (stage === 'green') {
    // SQL prefilter — a strict SUPERSET of leadState's green (two-word name +
    // company + linkedin-ish + position); leadState below stays the authority.
    // Without this, stage:'green' hauled EVERY lead's wide row (big JSON
    // columns) out of D1 just to keep the green few — ~12s reads once the
    // first big import landed.
    where.push(`name LIKE '% %' AND company IS NOT NULL AND position IS NOT NULL AND (linkedin IS NOT NULL OR socials LIKE '%linkedin%')`);
  }
  const sql = `SELECT * FROM plugin_gtm_leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const r = await api.db.prepare(sql).bind(...binds, Math.min(500, limit)).all();
  let leads = r.results || [];
  if (stage) leads = leads.filter((l) => leadState(l) === stage);
  return leads.map((l) => ({
    ...l,
    state: leadState(l),
    confidence: evaluateConfidence(l),
    truecaller_url: truecallerUrl(l.normalized_phone || l.phone),
    // null on leads enriched before 0056 — the surface falls back to inferring
    // from provenance for those rather than showing them as never-run.
    steps: parseJson(l.steps, null),
  }));
}

export async function updateLead(api, id, fields) {
  const cols = Object.keys(fields || {}).filter((k) => LEAD_COLS.has(k));
  if (!cols.length) return getLead(api, id);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const vals = cols.map((c) => fields[c] ?? null);
  await api.db.prepare(`UPDATE plugin_gtm_leads SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...vals, now(), id).run();
  return getLead(api, id);
}

export async function findByPhone(api, normalized) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE normalized_phone = ? LIMIT 1').bind(normalized).first();
}

// new_count powers the module's auto-resume: on mount it looks for any batch
// still carrying un-enriched leads (the client-side enrich loop died mid-run —
// tab switch, closed browser, network blip) and picks the drain back up
// without the operator having to notice or click anything.
export async function listBatches(api) {
  const r = await api.db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM plugin_gtm_leads l WHERE l.batch_id = b.id AND l.status = 'new') AS new_count
     FROM plugin_gtm_batches b ORDER BY b.created_at DESC LIMIT 100`,
  ).all();
  return r.results || [];
}

// A linkedin.com/company/ page is the COMPANY, never the person — and it can
// arrive in either place a person's profile is read from (the `linkedin` column
// or a socials entry typed 'linkedin'). One definition, so completeness, the
// "needs" hint and the rendered profile link can never disagree.
export const isCompanyLinkedin = (u) => /linkedin\.com\/company\//i.test(String(u || ''));
const personLinkedin = (lead, socials) =>
  (lead.linkedin && !isCompanyLinkedin(lead.linkedin) ? lead.linkedin : null)
  || (socials.find((s) => s.type === 'linkedin' && !isCompanyLinkedin(s.url))?.url ?? null);

// Enrichment signal (matches the UI dot): green = first + last name + company +
// linkedin + position; red = none; yellow = partial. Green gates Enrich+Outreach.
export function leadState(lead) {
  let socials = [];
  try { socials = lead.socials ? JSON.parse(lead.socials) : []; } catch { socials = []; }
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const signals = [
    parts.length >= 1,
    parts.length >= 2,
    !!lead.company,
    // The PERSON's profile. A /company/ page is not one, in EITHER place it can
    // land — counting it made a lead read green while the very same row reported
    // "needs: linkedin", and green gates Qualification + Outreach.
    !!personLinkedin(lead, socials),
    !!lead.position,
  ];
  const n = signals.filter(Boolean).length;
  return n === signals.length ? 'green' : n === 0 ? 'red' : 'yellow';
}

// ── confidence (derived-on-read, like leadState) ─────────────────────────────
// Distinct from leadState, which measures COMPLETENESS (do we have the fields).
// Confidence measures whether the identity HOLDS TOGETHER across sources — the
// "this might be the wrong person" signal. Pure function of the lead's own
// persisted fields (conflicts, sources, linkedin, line_type), so it is always
// fresh: the next read after an enrich or a manual edit recomputes it from the
// new data, no stored column to go stale. Returns { score 0-100, level
// 'green'|'yellow', flags: [{severity, label, detail}] }.
function prettyTool(t) {
  const map = {
    wa_fetch_name: 'WhatsApp', wa_fetch_photo: 'WhatsApp',
    pdl_enrich: 'People Data Labs', twilio_lookup: 'Twilio caller ID',
    serp_search: 'Google', manual: 'your manual edit',
    company_from_linkedin: 'LinkedIn', linkedin_company: 'LinkedIn',
  };
  return map[t] || t || 'a source';
}
function confNameTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-zÀ-ɏ\s'-]/g, ' ')
    .split(/[\s'-]+/).filter((t) => t.length >= 2);
}
export function linkedinSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

// ── linkedin identity verification ──────────────────────────────────────────
// The cardinal rule: a LinkedIn profile is only THIS lead's profile if the
// names are a relative match (a little different is fine — nicknames,
// transliteration; wildly different is a namesake/wrong person). We verify
// against two independent signals: the profile URL slug (usually the
// latinized name) and the search-result title ("Name - Title | LinkedIn").

// Hebrew-name transliteration variants (shachar/shahar, yitzchak/yitzhak…):
// normalize both sides the same way so spelling variance doesn't read as a
// different person.
const translit = (t) => t.replace(/ch/g, 'h').replace(/ph/g, 'f').replace(/ck/g, 'k');
const latinToks = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z]+/).filter((t) => t.length >= 2).map(translit);

function lev2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

const tokStrongMatch = (a, b) =>
  a === b
  || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)))
  || (Math.min(a.length, b.length) >= 4 && lev2(a, b) <= 1)
  // squished-name slugs ("orlatovitz", "yorubin") — the name token appears
  // INSIDE the concatenated slug token; require ≥4 chars so tiny tokens don't
  // false-match
  || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));

// How many of the lead's name tokens find a counterpart in the candidate tokens.
function nameTokenOverlap(leadName, candidateToks) {
  const nToks = latinToks(leadName);
  if (!nToks.length || !candidateToks.length) return { overlap: 0, verifiable: false, total: nToks.length };
  const overlap = nToks.filter((n) => candidateToks.some((c) => tokStrongMatch(n, c))).length;
  return { overlap, verifiable: true, total: nToks.length };
}

// Slug vs lead name: 'match' | 'mismatch' | 'unverifiable' (Hebrew-only name,
// or an opaque/custom slug that carries no name tokens).
export function slugNameCheck(leadName, url) {
  const slug = linkedinSlug(url);
  if (!slug) return 'unverifiable';
  const slugToks = slug.split(/[-_.]/).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/.test(t)).map(translit);
  if (!slugToks.length) return 'unverifiable';
  const { overlap, verifiable, total } = nameTokenOverlap(leadName, slugToks);
  if (!verifiable) return 'unverifiable';
  if (overlap === 0) return 'mismatch';
  // one shared token on a multi-token name (e.g. only the first name) is weak —
  // exactly the namesake trap — unless the slug itself only carries one token.
  if (total >= 2 && overlap < 2 && slugToks.length >= 2) return 'mismatch';
  return 'match';
}

// Does a LinkedIn search result belong to this lead? 'yes' | 'no' | 'unknown'.
// title is the SERP result title, e.g. "Dana Levin - VP Product at X | LinkedIn".
export function linkedinBelongsTo(leadName, { url, title }) {
  const slugVerdict = slugNameCheck(leadName, url);
  const t = String(title || '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '');
  const titleName = t.split(' - ')[0].trim();
  const { overlap, verifiable, total } = nameTokenOverlap(leadName, latinToks(titleName));
  const titleStrong = verifiable && (total >= 2 ? overlap >= 2 : overlap >= 1);
  const titleZero = verifiable && overlap === 0 && latinToks(titleName).length >= 2;
  if (titleStrong || slugVerdict === 'match') {
    // positive evidence wins unless the OTHER signal outright contradicts
    if (slugVerdict === 'mismatch' && !titleStrong) return 'no';
    if (titleZero && slugVerdict !== 'match') return 'no';
    return 'yes';
  }
  if (slugVerdict === 'mismatch' || titleZero) return 'no';
  return 'unknown'; // cross-script name (e.g. Hebrew vs Latin) or opaque slug — cannot verify
}

// Levenshtein-tolerant person-name match (<=2 edits on first AND last token).
function levName(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

export function namesMatch(a, b) {
  const ta = String(a || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const tb = String(b || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const first = levName(ta[0], tb[0]) <= 2 && Math.min(ta[0].length, tb[0].length) >= 3 ? true : ta[0] === tb[0];
  const la = ta[ta.length - 1], lb = tb[tb.length - 1];
  const last = ta.length < 2 || tb.length < 2 ? true : (levName(la, lb) <= 2 && Math.min(la.length, lb.length) >= 3 ? true : la === lb);
  return first && last;
}

export function evaluateConfidence(lead) {
  const flags = [];       // problems, worst-first
  const positives = [];   // reasons to trust it (shown on green)
  const conflicts = parseJson(lead.conflicts, []);
  const sources = parseJson(lead.sources, {});
  const nToks = confNameTokens(lead.name);
  const hasName = nToks.length >= 1;
  const hasFullName = nToks.length >= 2;
  const nameSrc = sources?.name?.tool;

  // ── Evidence: how much identity we actually hold. This is the base — an
  //    empty lead has NOTHING to be confident about, so it starts near zero
  //    (the old model started at 100 and only subtracted for contradictions,
  //    which is why a blank profile read 100%).
  let score = 0;
  if (hasFullName) score += 28;
  else if (hasName) score += 13;
  if (lead.linkedin) score += 20;
  if (lead.company)  score += 12;
  if (lead.position) score += 8;
  if (lead.email)    score += 8;

  // ── Consistency: recorded source conflicts. The enrichers log a name
  //    conflict exactly when e.g. WhatsApp and PDL/Twilio disagree — the case
  //    the operator described. A hard conflict caps the dot at yellow.
  let hardConflict = false;
  for (const c of (Array.isArray(conflicts) ? conflicts : [])) {
    if (!c || !c.value) continue;
    if (c.field === 'name') {
      hardConflict = true; score -= 40;
      flags.push({ severity: 'high', label: 'Name mismatch',
        detail: `On file "${lead.name || '?'}", but ${prettyTool(c.tool)} says "${c.value}".` });
    } else if (c.field === 'company') {
      score -= 16;
      flags.push({ severity: 'medium', label: 'Company mismatch',
        detail: `On file "${lead.company || '?'}", but ${prettyTool(c.tool)} says "${c.value}".` });
    } else {
      score -= 6;
      flags.push({ severity: 'low', label: `${c.field} mismatch`,
        detail: `${prettyTool(c.tool)} says "${c.value}".` });
    }
  }

  // ── LinkedIn slug vs name: corroboration when it matches, contradiction
  //    when it doesn't (the "this profile is someone else" check).
  let liMatchesName = false;
  if (lead.linkedin && hasName) {
    const slug = linkedinSlug(lead.linkedin);
    if (slug) {
      const slugToks = slug.split(/[-_.]/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/.test(t));
      if (slugToks.length >= 1) {
        const overlap = slugToks.filter((t) => nToks.some((n) => n === t || n.startsWith(t) || t.startsWith(n)));
        if (overlap.length) { liMatchesName = true; score += 12; }
        else {
          hardConflict = true; score -= 35;
          flags.push({ severity: 'high', label: 'LinkedIn does not match name',
            detail: `The linked profile /in/${slug} does not match the name "${lead.name}".` });
        }
      }
    }
  }

  // ── Low-evidence notices — the reasons a thin lead is NOT trustworthy yet.
  if (!hasName) {
    flags.push({ severity: 'high', label: 'No identity yet',
      detail: 'Only a phone number so far — nothing to verify. Run enrich to try to identify the person.' });
  } else if (!lead.linkedin && !lead.email && !lead.company) {
    flags.push({ severity: 'medium', label: 'Thin, unconfirmed profile',
      detail: `Name from ${prettyTool(nameSrc)} with no LinkedIn, company, or email to confirm it belongs to this number.` });
  }

  // ── Non-mobile line — a landline/VOIP often carries a business name.
  if (lead.line_type && !/mobile|wireless/i.test(lead.line_type)) {
    score -= 5;
    flags.push({ severity: 'low', label: `${lead.line_type} line`,
      detail: `Twilio reports a ${lead.line_type} line${lead.carrier ? ` (${lead.carrier})` : ''}; the name may be a business, not the person.` });
  }

  // ── Positive corroboration — why a clean lead earns its green.
  if (!hardConflict) {
    if (liMatchesName) positives.push('LinkedIn profile matches the name');
    if (hasFullName && lead.company && lead.position) positives.push('Full name, company, and role on file');
    if (nameSrc === 'pdl_enrich' || nameSrc === 'manual') positives.push(`Name confirmed via ${prettyTool(nameSrc)}`);
  }

  score = Math.max(0, Math.min(100, score));
  // red   = no usable identity to judge (nothing to be confident about)
  // yellow = a flagged inconsistency, or partial/unconfirmed data
  // green  = well-corroborated and consistent
  const level = !hasName ? 'red'
    : hardConflict ? 'yellow'
    : score >= 75 ? 'green'
    : 'yellow';
  return { score, level, flags, positives };
}

// ── provenance helpers ───────────────────────────────────────────────────────

// The merges themselves are pure and return VALUES; the *string* variants below
// are what the column writers want.
export function mergedSources(lead, upd) {
  let s = {};
  try { s = lead.sources ? JSON.parse(lead.sources) : {}; } catch { s = {}; }
  const at = new Date().toISOString();
  for (const [field, tool] of Object.entries(upd || {})) s[field] = { tool, at };
  return s;
}

export function mergedConflicts(lead, adds) {
  let c = [];
  try { c = lead.conflicts ? JSON.parse(lead.conflicts) : []; } catch { c = []; }
  const at = new Date().toISOString();
  // dedupe on field+value — re-running an enricher must not stack the same
  // conflict (the rejected-linkedin path re-fires on every serp pass)
  for (const a of adds) {
    if (c.some((x) => x.field === a.field && x.value === a.value)) continue;
    c.push({ ...a, at });
  }
  return c;
}

function mergeSources(lead, upd) { return JSON.stringify(mergedSources(lead, upd)); }
function mergeConflicts(lead, adds) { return JSON.stringify(mergedConflicts(lead, adds)); }

function parseJson(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } }

// ── import: phone list → lead rows ──────────────────────────────────────────

async function toNumbers(api, { text, url }) {
  if (url && String(url).trim()) {
    const r = await api.gateway('web', 'text', { url, max_bytes: 2_000_000 });
    if (!r.ok) throw new Error(`url fetch HTTP ${r.status}`);
    text = r.text;
  }
  return parsePhoneList(text || '');
}

export async function importLeads(api, { text, url, source } = {}) {
  const via = url && String(url).trim() ? 'url' : 'paste';
  const batch_id = gid('gb');
  const numbers = await toNumbers(api, { text, url });
  let valid = 0, invalid = 0, duplicates = 0, created = 0;
  for (const number of numbers) {
    const n = normalizePhone(number);
    if (!n.valid) { invalid++; continue; }
    valid++;
    if (await findByPhone(api, n.normalized)) { duplicates++; continue; }
    const g = locatePhone(n.normalized);
    await api.db.prepare(`
      INSERT INTO plugin_gtm_leads (id, phone, normalized_phone, status, source, batch_id, country, region, created_at, updated_at)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)
    `).bind(gid('gl'), number, n.normalized, source || null, batch_id, g.country, g.region, now(), now()).run();
    created++;
  }
  const summary = { total: numbers.length, valid, invalid, duplicates, created, batch_id: created > 0 ? batch_id : null, via, source: source || null };
  if (created > 0) {
    await api.db.prepare('INSERT INTO plugin_gtm_batches (id, source, via, total, created, duplicates, invalid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(batch_id, source || null, via, numbers.length, created, duplicates, invalid, now()).run();
  }
  await api.log('leads_imported', summary);
  return summary;
}

// ── SaaS lookups (via the host gateways; each degrades to {skipped} without
//    its key, exactly as before — the gateway carries the secret + the usage
//    meter, the plugin never sees a credential) ────────────────────────────────

// Each wrapper TRANSLATES its gateway's raw answer into the flat shape the
// enrichment passes below read. The gateways stay dumb boundaries (they hand
// back what the vendor said); the shape the module reasons about is decided
// exactly once, here.
export async function pdlEnrich(api, { phone, name, region, country } = {}) {
  const r = await api.gateway('pdl', 'person', { phone, name, region, country });
  if (!r?.ok) return { skipped: r?.error || 'People Data Labs is not connected' };
  if (!r.found || !r.person) return { matched: false };
  const p = r.person || {};
  const exp = (p.experience || []).find((e) => e?.is_primary) || (p.experience || [])[0] || {};
  const profiles = (p.profiles || [])
    .map((x) => ({ type: x?.network || null, url: x?.url ? (/^https?:/i.test(x.url) ? x.url : `https://${x.url}`) : null }))
    .filter((x) => x.url);
  return {
    matched: true,
    likelihood: r.likelihood ?? null,
    name: p.full_name || null,
    company: p.job_company_name || exp?.company?.name || null,
    job_title: p.job_title || exp?.title?.name || null,
    email: p.work_email || (p.emails || [])[0]?.address || null,
    region: p.location_region || null,
    country: p.location_country || null,
    profiles,
  };
}

export async function twilioLookup(api, number) {
  const r = await api.gateway('twilio', 'lookup', { phone: number });
  if (!r?.ok) return { skipped: r?.error || 'Twilio is not connected' };
  return { valid: !!r.valid, line_type: r.type || null, carrier: r.carrier || null, caller_name: r.caller_name || null, country: r.country || null };
}

export async function serpSearch(api, { q, num = 10 } = {}) {
  const r = await api.gateway('serp', 'search', { q, num });
  if (!r?.ok) return { skipped: r?.error || 'SerpApi is not connected' };
  // The gateway answers {url}; every reader below reads `link`. Carry both, so
  // neither side has to know the other's name for the same thing.
  return { query: r.query, results: (r.results || []).map((x) => ({ ...x, link: x.url })) };
}

// ── small shared LLM helper ─────────────────────────────────────────────────

export async function gtmLLM(api, { system, prompt, model = null, maxTokens = 4000, heavy = false } = {}) {
  // Delegates to the single LLM boundary (the llm gateway): provider switch,
  // circuit breaker (light calls fall back local; heavy:true throws LlmDownError
  // so outreach drafting pauses rather than running on a 3B), and retry all
  // live there. Signature kept so GTM call sites stay untouched.
  return api.gateway('llm', 'text', { system, prompt, model, max_tokens: maxTokens, heavy });
}

export function extractJson(txt) {
  const s = String(txt || '');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

// ── socials extraction (regex over known hosts; optional website fetch) ─────

const SOCIAL = [
  ['linkedin', /(?:[\w.-]*\.)?linkedin\.com\/[^\s"'<>)]+/ig],
  ['twitter', /(?:[\w.-]*\.)?(?:twitter\.com|x\.com)\/[^\s"'<>)]+/ig],
  ['instagram', /(?:[\w.-]*\.)?instagram\.com\/[^\s"'<>)]+/ig],
  ['facebook', /(?:[\w.-]*\.)?(?:facebook\.com|fb\.com)\/[^\s"'<>)]+/ig],
  ['github', /(?:[\w.-]*\.)?github\.com\/[^\s"'<>)]+/ig],
  ['youtube', /(?:[\w.-]*\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>)]+/ig],
  ['tiktok', /(?:[\w.-]*\.)?tiktok\.com\/[^\s"'<>)]+/ig],
  ['telegram', /t\.me\/[^\s"'<>)]+/ig],
];
const SOCIAL_HOST = /(linkedin|twitter|x|instagram|facebook|fb|github|youtube|youtu|tiktok)\.|t\.me/i;

export async function extractSocials(api, { text, website } = {}) {
  let corpus = String(text || '');
  const urls = corpus.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  const site = website || urls.find((u) => !SOCIAL_HOST.test(u)) || null;
  if (site) {
    try {
      const r = await api.gateway('web', 'text', { url: site, max_bytes: 200000 });
      if (r.ok) corpus += ' ' + r.text;
    } catch { /* site down — fine */ }
  }
  const found = new Map();
  for (const [type, re] of SOCIAL) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(corpus))) {
      let u = m[0].replace(/[).,'"]+$/, '');
      if (!/^https?:/i.test(u)) u = 'https://' + u;
      if (!found.has(u)) found.set(u, { type, url: u });
    }
  }
  return { socials: [...found.values()], website: site };
}

// ── enrichment passes (each re-reads the lead; conflict-aware writes) ────────

// PDL pass: phone-anchored identity. PAID — hard-skipped when name+company are
// already present (the cheaper sources already did the job).
export async function pdlEnrichOne(api, l) {
  if (l.name && l.company) return { skipped: 'name + company already present, PDL is paid' };
  await updateLead(api, l.id, { active_tool: 'pdl' });
  try {
    const res = await pdlEnrich(api, { phone: l.normalized_phone || l.phone, name: l.name || undefined, region: l.region || undefined, country: l.country || undefined });
    if (res.skipped || res.error || res.matched === false) { await updateLead(api, l.id, { active_tool: null }); return res; }
    const socials = parseJson(l.socials, []);
    const dismissed = new Set(parseJson(l.dismissed, []));
    const seen = new Set(socials.map((s) => s.url));
    const at = new Date().toISOString();
    for (const p of res.profiles || []) if (p.url && !seen.has(p.url) && !dismissed.has(p.url)) { socials.push({ ...p, src: 'pdl_enrich', at }); seen.add(p.url); }
    const srcUpd = {}, conflicts = [];
    const fields = { status: 'enriched', socials: JSON.stringify(socials), active_tool: null };
    if (res.name) { if (!l.name) { fields.name = res.name; srcUpd.name = 'pdl_enrich'; } else if (!eqCI(res.name, l.name)) conflicts.push({ field: 'name', value: res.name, tool: 'pdl_enrich' }); }
    if (res.company) { if (!l.company) { fields.company = res.company; srcUpd.company = 'pdl_enrich'; } else if (!eqCI(res.company, l.company)) conflicts.push({ field: 'company', value: res.company, tool: 'pdl_enrich' }); }
    if (res.job_title && !l.position) { fields.position = res.job_title; srcUpd.position = 'pdl_enrich'; }
    if (res.email && !l.email) { fields.email = res.email; srcUpd.email = 'pdl_enrich'; }
    if (res.region && !l.region) { fields.region = res.region; srcUpd.region = 'pdl_enrich'; }
    if (res.country && !l.country) { fields.country = res.country; srcUpd.country = 'pdl_enrich'; }
    fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(api, l.id, fields);
    return { matched: res.matched, likelihood: res.likelihood, name: res.name, company: res.company };
  } catch (e) {
    await updateLead(api, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// Twilio pass: line type + carrier always; CNAM name only if still nameless.
export async function twilioEnrichOne(api, l) {
  await updateLead(api, l.id, { active_tool: 'twilio' });
  try {
    const r = await twilioLookup(api, l.normalized_phone || l.phone);
    if (r.skipped || r.error) { await updateLead(api, l.id, { active_tool: null }); return r; }
    const srcUpd = {}, conflicts = [];
    const fields = { line_type: r.line_type || null, carrier: r.carrier || null, active_tool: null };
    if (r.line_type) srcUpd.line_type = 'twilio_lookup';
    if (r.carrier)   srcUpd.carrier = 'twilio_lookup';
    if (r.caller_name) {
      if (!l.name) { fields.name = r.caller_name; srcUpd.name = 'twilio_lookup'; }
      else if (!eqCI(r.caller_name, l.name)) conflicts.push({ field: 'name', value: r.caller_name, tool: 'twilio_lookup' });
    }
    fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(api, l.id, fields);
    return { valid: r.valid, line_type: r.line_type, carrier: r.carrier, caller_name: r.caller_name };
  } catch (e) {
    await updateLead(api, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// Google (SerpApi) pass. HARD-GATED: requires an already-sourced name — never
// search an invented name into a false identity.
export async function serpEnrichOne(api, l) {
  if (!l.name || !String(l.name).trim()) return { skipped: 'no sourced name yet — get a name from PDL, Twilio or a manual edit first' };
  await updateLead(api, l.id, { active_tool: 'google' });
  try {
    const where = [l.region, l.country].filter(Boolean).join(' ');
    const q = `"${l.name}"${where ? ' ' + where : ''} linkedin OR twitter OR instagram`;
    const res = await serpSearch(api, { q, num: 10 });
    if (res.skipped || res.error) { await updateLead(api, l.id, { active_tool: null }); return res; }
    const results = res.results || [];
    const corpus = results.map((r) => `${r.link} ${r.title} ${r.snippet || ''}`).join('\n');
    const soc = await extractSocials(api, { text: corpus });
    const socials = parseJson(l.socials, []);
    const dismissed = new Set(parseJson(l.dismissed, []));
    const seen = new Set(socials.map((s) => s.url));
    const at = new Date().toISOString();
    let added = 0;
    // LinkedIn URLs are handled separately below with identity verification —
    // never let the raw corpus scrape attach someone else's profile.
    for (const s of soc.socials) {
      if (!s.url || seen.has(s.url) || dismissed.has(s.url)) continue;
      if (s.type === 'linkedin') continue;
      socials.push({ ...s, src: 'serp_search', at }); seen.add(s.url); added++;
    }

    // ── LinkedIn: verified-only. Each /in/ RESULT is checked against the
    // lead's name (result title + URL slug). A profile whose name is wildly
    // different is a namesake or a stray link in the search page — attaching
    // it was the old behavior's cardinal sin (and the wrong company/title got
    // derived from it next). Now: 'yes' → attach; 'no'/'unknown' → NEVER
    // auto-attach; the best rejected candidate is recorded as a CONFLICT so
    // the operator sees it and can approve by hand (a manual edit clears the
    // conflict). Cross-script names (Hebrew name vs Latin profile) land in
    // 'unknown' — unverifiable is not verification.
    const liResults = results.filter((r) => /linkedin\.com\/in\//i.test(r.link || ''));
    const verdicts = liResults.map((r) => ({ url: r.link, title: r.title, verdict: linkedinBelongsTo(l.name, { url: r.link, title: r.title }) }));
    const verified = verdicts.filter((v) => v.verdict === 'yes' && !dismissed.has(v.url));
    const rejected = verdicts.filter((v) => v.verdict !== 'yes' && !dismissed.has(v.url));
    for (const v of verified) {
      if (seen.has(v.url)) continue;
      socials.push({ type: 'linkedin', url: v.url, src: 'serp_search', at }); seen.add(v.url); added++;
    }

    const fields = { socials: JSON.stringify(socials), active_tool: null };
    // Promote to the lead's linkedin field only from a verified or trusted
    // origin: serp entries above are pre-verified; wa/pdl entries came from the
    // person's own WhatsApp about or a phone-anchored PDL match. Even then, a
    // hard slug-vs-name mismatch blocks promotion.
    if (!l.linkedin) {
      const cand = socials.find((s) => s.type === 'linkedin' && /linkedin\.com\/in\//i.test(s.url)
        && ['serp_search', 'extract_socials', 'pdl_enrich'].includes(s.src)
        && slugNameCheck(l.name, s.url) !== 'mismatch');
      if (cand) fields.linkedin = cand.url;
      else if (rejected.length) {
        // surface the candidate we REFUSED to auto-attach — visible, reviewable
        fields.conflicts = mergeConflicts(l, [{ field: 'linkedin', value: rejected[0].url, tool: 'serp_search' }]);
        await api.log('linkedin_rejected', { id: l.id, name: l.name, url: rejected[0].url, verdict: rejected[0].verdict });
      }
    }
    await updateLead(api, l.id, fields);
    return { query: q, found: soc.socials.length, added, linkedin_verified: verified.length, linkedin_rejected: rejected.length };
  } catch (e) {
    await updateLead(api, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// Company (and title) off the person's LinkedIn search result — cheap,
// authoritative, kills confabulated companies. Regex first, LLM fallback.
//
// The guard covers BOTH fields it can fill. It used to bail on `l.company`
// alone, which meant a lead whose company arrived from PDL / WhatsApp / a manual
// edit could never have its TITLE read off LinkedIn — the function returned
// before fetching the profile, so the `job_title` branch below was unreachable
// and the title stayed empty however plainly it was on the page. That also made
// the operator's rerun button a no-op for exactly that case.
export async function companyFromLinkedinOne(api, l) {
  if (!l.linkedin) return { skipped: 'no linkedin' };
  if (l.company && l.position) return { skipped: 'company + title already on file' };
  await updateLead(api, l.id, { active_tool: 'linkedin' });
  try {
    const slug = (String(l.linkedin).match(/\/in\/([^/?#]+)/) || [])[1] || '';
    const q = l.name ? `${l.name} site:linkedin.com/in` : `site:linkedin.com/in/${slug}`;
    const res = await serpSearch(api, { q, num: 8 });
    if (res.skipped || res.error) { await updateLead(api, l.id, { active_tool: null }); return res; }
    const results = res.results || [];
    // Exact-slug hit = the lead's own (already verified) profile. The fallback
    // must ALSO pass identity verification — the old `any /in/ result` fallback
    // happily read the company/title off a total stranger's profile whenever the
    // slug didn't appear, poisoning company AND position in one shot.
    const hit = (slug && results.find((o) => (o.link || '').toLowerCase().includes('/in/' + slug.toLowerCase())))
      || results.find((o) => /linkedin\.com\/in\//i.test(o.link || '') && linkedinBelongsTo(l.name, { url: o.link, title: o.title }) === 'yes');
    if (!hit) { await updateLead(api, l.id, { active_tool: null }); return { company: null, note: 'no name-verified linkedin result found' }; }
    // "Name - Title at Company" parses with a regex; messy headlines fall to the LLM.
    const t = String(hit.title || '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '').replace(/[.…]+\s*$/, '').trim();
    let company = null, job_title = null;
    const dash = t.indexOf(' - ');
    if (dash !== -1) {
      const rest = t.slice(dash + 3);
      const m = rest.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (m) { job_title = m[1].trim() || null; company = m[2].replace(/\s*\(.*?\)\s*$/, '').trim() || null; }
      else job_title = rest || null;
    }
    if (!company) {
      try {
        const txt = await gtmLLM(api, {
          system: 'Extract the person\'s CURRENT company and job title from a LinkedIn search result. Headlines are messy: "EIR @Notable, GTM Nerd!" means title "EIR", company "Notable". Return ONLY strict JSON {"company": string|null, "job_title": string|null}.',
          prompt: `Title: ${hit.title}\nSnippet: ${hit.snippet || ''}`,
          model: null, // llm gateway resolves the configured default (was NYO_MODEL_MID)
          maxTokens: 300,
        });
        const o = extractJson(txt);
        company = o.company || company;
        job_title = o.job_title || job_title;
      } catch { /* keep regex result */ }
    }
    const srcUpd = {}, conflicts = [], fields = { active_tool: null };
    // Now that this can run with a company already on file, it must follow the
    // module's provenance rule like every other source does: fill an empty
    // field, but record a disagreement instead of overwriting one.
    if (company) {
      if (!l.company) { fields.company = company; srcUpd.company = 'company_from_linkedin'; }
      else if (!eqCI(company, l.company)) conflicts.push({ field: 'company', value: company, tool: 'company_from_linkedin' });
    }
    if (job_title && !l.position) { fields.position = job_title; srcUpd.position = 'company_from_linkedin'; }
    if (Object.keys(srcUpd).length) fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(api, l.id, fields);
    return { company: company || null, position: job_title || null, from: hit.link };
  } catch (e) {
    await updateLead(api, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// The full chain for one lead, accuracy order. Each step re-reads the lead so a
// later step sees what an earlier one wrote (SERP needs the name; PDL skips
// itself once name+company exist).
export async function enrichFullOne(api, id) {
  const at = now();
  let l = await getLead(api, id);
  // If a previous pass surfaced a linkedin, resolve the company off it before
  // paying for PDL.
  const liBefore = l.linkedin || null;
  const cfl = await companyFromLinkedinOne(api, l);
  const pdl = await pdlEnrichOne(api, await getLead(api, id));
  const twilio = await twilioEnrichOne(api, await getLead(api, id));
  const serp = await serpEnrichOne(api, await getLead(api, id));
  // Deterministic finalize: with a linkedin on file, the company read off it is
  // authoritative (kills "Elon University"-style confabulation). It exists to
  // catch the profile SERP just attached, which the earlier pass never saw.
  //
  // Skipped when the earlier pass already FETCHED this exact profile: that pass
  // reads company and title off the same result, so re-reading an unchanged URL
  // is the identical SerpApi query twice in one chain. (A step-2 that merely
  // self-skipped costs nothing to repeat — it returns before any search.)
  l = await getLead(api, id);
  const alreadyRead = !!liBefore && l.linkedin === liBefore && !cfl?.skipped;
  const confirm = alreadyRead
    ? { skipped: 'same LinkedIn profile already read earlier this run' }
    : await companyFromLinkedinOne(api, l);

  // Mark the chain as RUN unconditionally — even when every source failed or
  // was skipped. status means "attempted", the red/yellow/green state carries
  // quality. Without this, a lead whose sources all skip stays 'new' and
  // enrichBatchStep re-selects it forever (the UI loop never terminates).
  const cur = await updateLead(api, id, { status: 'enriched' });

  // Persist what each step DID, so "skipped on purpose" survives as a distinct
  // fact from "ran and found nothing". Wrapped: the `steps` column arrives by a
  // MANUAL migration, so if a deploy ever lands ahead of it, a missing column
  // must not take the whole enrichment chain down with it.
  // Non-chain verdicts (the manual ICP match) are carried forward, not wiped —
  // this pass replaces only what it actually re-ran.
  const results = { li: cfl, pdl, twilio, serp, confirm };
  const steps = [...ENRICH_STEPS.map((d) => stepVerdict(d, results[d.key], at)), ...foreignSteps(parseJson(cur?.steps, null))];
  try {
    await updateLead(api, id, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: step verdicts not persisted (is the steps column migrated?)', e?.message || e);
  }

  const done = await getLead(api, id);
  await api.log('lead_enriched', { id, state: leadState(done), steps: steps.map((s) => `${s.key}:${s.status}`) });
  return { id, state: leadState(done), steps, company_from_linkedin: cfl, pdl, twilio, serp, confirm };
}

// Resume the TAIL of the chain after the operator has typed something in by
// hand. Two steps gate themselves on fields a human most often supplies:
//   * SerpApi — hard-gated on already having a sourced NAME
//   * Confirm — the finalize LinkedIn pass, needs a linkedin and no company yet
// Typing a name or pasting a profile URL unblocks exactly those two, so this
// re-runs only them.
//
// It deliberately does NOT re-run PDL / Twilio: Twilio bills per lookup and PDL
// is paid, and nothing the operator typed changes what either would return for
// the same phone number. Re-running the full chain to pick up one manual edit
// is how a "just refresh it" button quietly becomes expensive.
//
// Verdicts are MERGED over whatever is already recorded, so the steps this pass
// didn't touch keep their previous result instead of being reset to unknown.
export async function enrichResumeOne(api, id) {
  const at = now();
  const serp = await serpEnrichOne(api, await getLead(api, id));
  const confirm = await companyFromLinkedinOne(api, await getLead(api, id));

  const results = { serp, confirm };
  const current = await getLead(api, id);
  const prior = parseJson(current?.steps, null);
  const byKey = new Map((Array.isArray(prior) ? prior : []).map((s) => [s.key, s]));
  for (const d of ENRICH_STEPS) {
    if (!(d.key in results)) continue;
    byKey.set(d.key, stepVerdict(d, results[d.key], at));
  }
  // Only the keys we actually know about — a step with no record at all is left
  // OUT rather than written as 'idle', so a resume on a lead enriched before
  // the steps column doesn't claim its earlier steps never ran. The page infers
  // those. Non-chain verdicts (the manual ICP match) ride along untouched.
  const steps = [...ENRICH_STEPS.map((d) => byKey.get(d.key)).filter(Boolean), ...foreignSteps(prior)];
  try {
    await updateLead(api, id, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: resume verdicts not persisted (is the steps column migrated?)', e?.message || e);
  }

  const done = await getLead(api, id);
  await api.log('lead_enriched', { id, mode: 'resume', state: leadState(done), steps: steps.map((s) => `${s.key}:${s.status}`) });
  return { id, mode: 'resume', state: leadState(done), steps, serp, confirm };
}

// Batch stepper: enrich the next `limit` un-enriched leads of a batch. The UI /
// Nyo calls this in a loop while remaining > 0 — keeps each Worker invocation
// well inside its budget instead of one long background chain.
export async function enrichBatchStep(api, { batch_id, limit = 2 } = {}) {
  const r = await api.db.prepare("SELECT id FROM plugin_gtm_leads WHERE batch_id = ? AND status = 'new' ORDER BY created_at LIMIT ?")
    .bind(batch_id, Math.min(5, Math.max(1, limit))).all();
  const ids = (r.results || []).map((x) => x.id);
  const results = [];
  for (const id of ids) results.push(await enrichFullOne(api, id));
  const rem = await api.db.prepare("SELECT COUNT(*) AS n FROM plugin_gtm_leads WHERE batch_id = ? AND status = 'new'").bind(batch_id).first();
  return { enriched: results.length, remaining: rem?.n ?? 0, results };
}

// Manual field edit: '' clears a field; removed social URLs are tombstoned into
// dismissed; a manual edit resolves (clears) matching conflicts.
export async function manualEditLead(api, id, body = {}) {
  const l = await getLead(api, id);
  if (!l) throw new Error('no such lead');
  const fields = {};
  const srcUpd = {};   // provenance to stamp
  const srcDrop = [];  // provenance to remove, for values we cleared
  for (const k of ['name', 'linkedin', 'email', 'company', 'position']) {
    if (body[k] !== undefined) {
      fields[k] = String(body[k] || '').trim() || null;
      if (fields[k]) srcUpd[k] = 'manual';
    }
  }
  if (body.socials !== undefined) {
    const next = Array.isArray(body.socials) ? body.socials : [];
    const prev = parseJson(l.socials, []);
    const nextUrls = new Set(next.map((s) => s.url));
    const dismissed = parseJson(l.dismissed, []);
    for (const s of prev) if (s.url && !nextUrls.has(s.url)) dismissed.push(s.url);
    fields.socials = JSON.stringify(next);
    fields.dismissed = JSON.stringify([...new Set(dismissed)]);
  }
  // Correcting the COMPANY's LinkedIn is a targeted key, never a whole-socials
  // rewrite: the browser holds a stale copy of that array, and replacing the
  // column with it would tombstone whatever an enrichment pass added in between.
  // The read-modify-write therefore happens here, against the current row.
  if (body.company_linkedin !== undefined) {
    const url = String(body.company_linkedin || '').trim();
    // Seeded from whatever the socials branch already staged, not straight from
    // the row: a request carrying BOTH keys must not have one silently dropped.
    const prev = fields.socials !== undefined ? parseJson(fields.socials, []) : parseJson(l.socials, []);
    const kept = prev.filter((s) => !isCompanyLinkedin(s.url));
    fields.socials = JSON.stringify(url ? [...kept, { type: 'linkedin_company', url, src: 'manual' }] : kept);
    // Blacklist only the company links we actually replaced, so enrichment can
    // never re-attach the wrong company. Other socials keep their state.
    const dismissed = fields.dismissed !== undefined ? parseJson(fields.dismissed, []) : parseJson(l.dismissed, []);
    for (const s of prev) if (isCompanyLinkedin(s.url) && s.url !== url) dismissed.push(s.url);
    fields.dismissed = JSON.stringify([...new Set(dismissed)]);
    // EVERYTHING the old link produced is now about the wrong company: the
    // resolve snapshot, the company id the jobs API is keyed on, the open roles
    // fetched with that id, and the recorded Company step describing them.
    // Leaving any of it means a surface confidently reporting another company's
    // facts — and resolveLiCompany skipping the re-resolve for a month, because
    // company_checked_at is still fresh.
    fields.company_context = null;
    fields.company_li_id = null;
    fields.company_checked_at = null;
    fields.open_positions = null;
    fields.positions_checked_at = null;
    // The headcount belonged to the wrong company too, and the resolve COALESCES
    // rather than clobbers, so leaving it would carry a wrong number forward
    // forever. A figure the operator typed by hand is theirs, and survives.
    const srcs = parseJson(l.sources, {});
    if (srcs?.company_staff_count?.tool !== 'manual') fields.company_staff_count = null;
    // Absent on a lead predating the steps column — parseJson yields null, so
    // the column is simply left out rather than written blind.
    const steps = parseJson(l.steps, null);
    if (Array.isArray(steps)) fields.steps = JSON.stringify(steps.filter((s) => s && s.key !== 'company'));
  }
  // Headcount is fetched, but correctable — LinkedIn matches the wrong company
  // often enough, and the ICP leans on this number harder than on any other
  // single fact. Stored as an integer so the ICP prompt and the Size column read
  // it the same way the resolve writes it; null clears it back to "not checked".
  if (body.company_staff_count !== undefined) {
    const raw = body.company_staff_count;
    const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      fields.company_staff_count = null;
      // Drop the provenance WITH the value it described, or the stamp outlives
      // it and mislabels whatever lands next.
      srcDrop.push('company_staff_count');
    } else {
      // Rejected, not coerced. Number([]) and Number(false) are both 0, which
      // would store a real "0 employees" — and the ICP prompt is told a number
      // is a fact while "not checked" is not. So only a number or a numeric
      // string is even considered; String(x) on anything else is not evidence.
      if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('company_staff_count must be a number');
      const n = typeof raw === 'number' ? raw : Number(raw.trim());
      if (!Number.isFinite(n) || n < 0) throw new Error('company_staff_count must be a non-negative number');
      fields.company_staff_count = Math.round(n);
      srcUpd.company_staff_count = 'manual';
    }
  }
  // Manual edit resolves conflicts on the fields it touched.
  const conflicts = parseJson(l.conflicts, []).filter((c) => !(c.field in fields));
  fields.conflicts = JSON.stringify(conflicts);
  if (Object.keys(srcUpd).length) fields.sources = mergeSources(l, srcUpd);
  // Applied AFTER the merge, which rebuilds from the stored row and would
  // otherwise resurrect a stamp we just dropped.
  if (srcDrop.length) {
    const s = parseJson(fields.sources !== undefined ? fields.sources : l.sources, {});
    for (const k of srcDrop) delete s[k];
    fields.sources = JSON.stringify(s);
  }
  await updateLead(api, id, fields);
  await api.log('lead_updated', { id, changed: Object.keys(fields).filter((k) => !['conflicts', 'sources', 'dismissed'].includes(k)) });
  return getLead(api, id);
}

// ── the patch writer ────────────────────────────────────────────────────────

const asColumnJson = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));

// Write named columns onto a lead, coalesce-never-clobber: a key that is absent
// from the patch leaves its column alone, and an explicit null is a deliberate
// clear. Provenance, conflicts, tombstones, step verdicts and an ICP verdict
// ride along in their own arguments so a caller never has to hand-encode them.
export async function saveLeadPatch(api, {
  id, lead_patch = {}, sources = null, conflicts = null, dismissed = null, steps = null,
  icp_fit = null, icp_reasons = null, icp_gaps = null, rejected_linkedin = null, actor = 'operator',
} = {}) {
  if (!id) throw new Error('save_lead: id required');
  const fields = { ...lead_patch };
  // Whatever ran, nothing is in flight once we have persisted — a stale
  // active_tool leaves the surface spinning on a run that ended.
  fields.active_tool = null;
  if (sources) fields.sources = asColumnJson(sources);
  if (conflicts) fields.conflicts = asColumnJson(conflicts);
  if (dismissed) fields.dismissed = asColumnJson(dismissed);
  if (icp_fit) {
    fields.icp_fit = icp_fit;
    fields.icp_reasons = JSON.stringify({ reasons: icp_reasons || [], gaps: icp_gaps || [] });
  }
  delete fields.steps; // written separately below — see the migration note
  await updateLead(api, id, fields);

  // The `steps` column arrives by a MANUAL migration. If a deploy ever lands
  // ahead of it, a missing column must not take the whole save with it.
  let nextSteps = Array.isArray(steps) ? [...steps] : null;
  if (icp_fit) {
    const base = nextSteps ?? parseJson((await getLead(api, id))?.steps, null) ?? [];
    nextSteps = [...base.filter((s) => s && s.key !== 'icp'), { key: 'icp', label: 'ICP match', status: 'found', reason: icp_fit, at: now() }];
  }
  if (nextSteps) {
    try {
      await updateLead(api, id, { steps: JSON.stringify(nextSteps) });
    } catch (e) {
      console.error('gtm: step verdicts not persisted (is the steps column migrated?)', e?.message || e);
    }
  }

  const lead = await getLead(api, id);
  if (rejected_linkedin) {
    await api.log('linkedin_rejected', { id, name: lead?.name, url: rejected_linkedin.url, verdict: rejected_linkedin.verdict, actor });
  }
  if (lead_patch.linkedin === null) {
    await api.log('linkedin_cleared', { id, name: lead?.name, actor });
  }
  await api.log('lead_enriched', { id, state: leadState(lead), steps: (nextSteps || []).map((s) => `${s.key}:${s.status}`), icp_fit: icp_fit || undefined, actor });
  return { lead: { ...lead, state: leadState(lead), confidence: evaluateConfidence(lead) } };
}

// ═════════════════════════════════════════════════════════════════════════════
// GTM · company context and ICP fit. The company facts come from the two
// sources this install has — a SerpApi search and a fetch of the company's own
// site — and are cached on the lead; the ICP verdict is the LLM reading those
// facts against the brand-baseline `brand-icp` doc.
// ═════════════════════════════════════════════════════════════════════════════

// ── knowledge doc helpers (the control surfaces live in knowledge docs) ─────

export async function gtmDoc(api, slug, fallback = '') {
  try {
    const d = await api.knowledge(slug);
    return d?.body || fallback;
  } catch { return fallback; }
}

export async function readYou(api) {
  try { return JSON.parse(await gtmDoc(api, 'plugin-gtm-you', '{}')); } catch { return {}; }
}

// ── the fully identified prospects ──────────────────────────────────────────

// Green leads for the Verified Contacts and Qualification tabs. One query: the
// state filter already does the work, and the caller merges angles and contact
// status on top.
export async function greenLeads(api) {
  return listLeads(api, { stage: 'green' });
}

// ── ICP fit ──────────────────────────────────────────────────────────────────

export async function scoreIcpFit(api, leadId) {
  const lead = await getLead(api, leadId);
  if (!lead) return { error: 'no lead' };
  // The scorer judges name + title + company; without them the verdict is
  // noise. Enforced here — not just in a surface — so every caller (GTM
  // Enrich, Prospecting Qualification, the Nyo tool) shares one definition
  // and no LLM call is spent on a meaningless prospect.
  if (!String(lead.name || '').trim() || !lead.company || !lead.position) {
    return { error: 'needs a name, company and title before ICP match' };
  }
  // Single source of truth: the brand-baseline ICP (brand-icp, a HOST doc
  // declared in requires.knowledge). No gtm-specific ICP copy — the ICP is the
  // ICP, defined once in the brand tree.
  const icp = await gtmDoc(api, 'brand-icp', 'ICP not written yet — judge loosely by seniority + reachability.');
  // Company facts gathered by companyContextForLead. The ICP is mostly a
  // statement about COMPANIES (size band, geography, what they build), so
  // without these the model was inferring everything from a brand name it may
  // never have heard of.
  const size = Number.isFinite(Number(lead.company_staff_count)) ? Number(lead.company_staff_count) : null;
  let ctx = null;
  try { ctx = JSON.parse(lead.company_context || 'null'); } catch { ctx = null; }
  const ctxLine = ctx && !ctx.error
    ? [ctx.summary, ctx.industry, ctx.hq, ctx.website].filter(Boolean).join(' · ')
    : '(not checked)';
  const system = `Score how well a prospect fits this Ideal Customer Profile.

ICP:
${icp}

Return STRICT JSON only:
{"fit":"strong|medium|weak","reasons":["1-2 word tag"],"gaps":["1-2 word tag"]}
Each reason and gap is a 1 to 2 word tag, ultra glanceable, NOT a sentence and NOT a phrase (e.g. "Israeli founder", "reachable exec", "enterprise", "wrong stage", "no build need"). At most 3 of each. Judge only against the ICP. If a disqualifier applies, fit is weak.
Company facts come from a web search of the company. "unknown" or "not checked" means we have not looked it up — treat it as missing evidence, NEVER as a zero and never as a disqualifier on its own.`;
  const prompt = `PROSPECT: ${lead.name} - ${lead.position || '?'} at ${lead.company || '?'} (${[lead.region, lead.country].filter(Boolean).join(', ') || 'location unknown'})
COMPANY: ${lead.company || '?'} — ${size !== null ? `${size} employees` : 'headcount unknown'}
COMPANY CONTEXT: ${ctxLine}

Produce the JSON.`;
  try {
    const out = extractJson(await gtmLLM(api, { system, prompt, model: null }));
    const fit = ['strong', 'medium', 'weak'].includes(out.fit) ? out.fit : 'weak';
    const fresh = await updateLead(api, leadId, { icp_fit: fit, icp_reasons: JSON.stringify({ reasons: out.reasons || [], gaps: out.gaps || [] }) });
    // Record the run in the lead's step history so a surface can show WHEN the
    // ICP match ran, not just its result. Merged over the row updateLead just
    // returned — NOT the pre-LLM read — so an enrich that finished during the
    // multi-second LLM call keeps its verdicts. A separate write on purpose:
    // the `steps` column arrives by a MANUAL migration, and a missing column
    // must not take the scoring — already persisted above — down with it.
    try {
      let prior = [];
      try { prior = JSON.parse(fresh?.steps) || []; } catch { prior = []; }
      const steps = (Array.isArray(prior) ? prior : []).filter((s) => s && s.key !== 'icp');
      steps.push({ key: 'icp', label: 'ICP match', status: 'found', reason: fit, at: now() });
      await updateLead(api, leadId, { steps: JSON.stringify(steps) });
    } catch (e) {
      console.error('gtm: icp step verdict not persisted (is the steps column migrated?)', e?.message || e);
    }
    await api.log('icp_scored', { id: leadId, fit });
    return { fit, reasons: out.reasons || [], gaps: out.gaps || [] };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ── the company behind the lead ─────────────────────────────────────────────

// Everything we can learn about the COMPANY behind a lead, from the two sources
// this install actually has: a SerpApi search for the company, and a fetch of
// whatever site that search points at. The model turns both into a small fact
// sheet, which is cached on the lead and read back by the ICP match.
//
// PARTIAL BY DESIGN. Search may be unconnected, the site may be down, the model
// may find no headcount. Whatever lands is kept, whatever failed is named in
// errors[], and facts already on the lead are never overwritten with nothing —
// a checked row must not start reading as unchecked.
const COMPANY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function companyContextForLead(api, leadId, { refresh = false } = {}) {
  const at = now();
  const lead = await getLead(api, leadId);
  if (!lead) return { error: 'no lead' };
  if (!lead.company) return { error: 'no company on the lead yet' };

  let stored = null;
  try { stored = JSON.parse(lead.company_context || 'null'); } catch { stored = null; }
  const fresh = lead.company_checked_at && (at - lead.company_checked_at) < COMPANY_MAX_AGE_MS;
  if (!refresh && fresh && stored && !stored.error) {
    return {
      company: lead.company, cached: true, staff_count: lead.company_staff_count ?? null,
      summary: stored.summary ?? null, industry: stored.industry ?? null,
      hq: stored.hq ?? null, website: stored.website ?? null, errors: [],
    };
  }

  const errors = [];
  const res = await serpSearch(api, { q: `"${lead.company}" company official site employees`, num: 8 });
  if (res.skipped) errors.push(String(res.skipped));
  const results = res.results || [];
  // The company's own site: the first result that is not a directory or a
  // social network. Its text is far better evidence than a snippet.
  const site = results.map((r) => r.link).find((u) => u && !SOCIAL_HOST.test(u) && !/wikipedia|crunchbase|glassdoor|indeed|bloomberg|zoominfo/i.test(u)) || null;
  let siteText = '';
  if (site) {
    try {
      const w = await api.gateway('web', 'text', { url: site, max_bytes: 120000 });
      if (w?.ok) siteText = String(w.text || '').slice(0, 12000);
      else errors.push(`could not read ${site}`);
    } catch (e) { errors.push(`could not read ${site}: ${String(e.message || e).slice(0, 120)}`); }
  }
  const corpus = [
    results.map((r) => `${r.title} — ${r.link}\n${r.snippet || ''}`).join('\n\n'),
    siteText ? `SITE (${site}):\n${siteText}` : '',
  ].filter(Boolean).join('\n\n');

  let facts = {};
  if (corpus.trim()) {
    try {
      facts = extractJson(await gtmLLM(api, {
        system: 'You are given search results and website text about ONE company. Return STRICT JSON only: {"summary": string|null, "industry": string|null, "hq": string|null, "website": string|null, "linkedin": string|null, "staff_count": number|null}. summary is at most 25 words, plain, about what the company does. staff_count is an employee headcount ONLY if the text states one; otherwise null. Never guess a number.',
        prompt: `COMPANY: ${lead.company}\n\n${corpus}`,
        model: null,
        maxTokens: 600,
      }));
    } catch (e) { errors.push(`could not read the company: ${String(e.message || e).slice(0, 120)}`); }
  } else if (!errors.length) {
    errors.push('nothing found for this company');
  }

  const staffFresh = Number.isFinite(Number(facts?.staff_count)) ? Number(facts.staff_count) : null;
  // COALESCE, never clobber: a pass that found no headcount must not erase one
  // we already hold (hand-entered ones especially).
  const staff = staffFresh ?? (lead.company_staff_count ?? null);
  const answered = !!(facts?.summary || facts?.industry || staffFresh !== null);
  const snapshot = answered
    ? {
        summary: facts.summary ?? null, industry: facts.industry ?? null, hq: facts.hq ?? null,
        website: facts.website || site || null, linkedin: facts.linkedin ?? null,
        staff_count: staff, at,
      }
    : { ...(stored && !stored.error ? stored : {}), error: errors[0] || 'nothing found', at };

  let srcs = {};
  try { srcs = JSON.parse(lead.sources || '{}') || {}; } catch { srcs = {}; }
  if (staffFresh !== null) srcs.company_staff_count = { tool: 'company_context', at: new Date().toISOString() };
  try {
    await updateLead(api, leadId, {
      company_staff_count: staff,
      company_context: JSON.stringify(snapshot),
      company_checked_at: at,
      ...(staffFresh !== null ? { sources: JSON.stringify(srcs) } : {}),
    });
  } catch (e) {
    console.error('gtm: company context not persisted (are the company_* columns migrated?)', e?.message || e);
  }

  // Record the pass in the lead's step history, merged over whatever else is
  // recorded there, so a surface can show WHEN the company was last checked.
  const summary = [
    staff !== null ? `${staff} employees` : null,
    snapshot.industry || null,
    snapshot.website || null,
  ].filter(Boolean).join(' · ');
  try {
    const after = await getLead(api, leadId);
    const prior = parseJson(after?.steps, null);
    const steps = (Array.isArray(prior) ? prior : []).filter((s) => s && s.key !== 'company');
    steps.push({ key: 'company', label: 'Company', status: answered ? 'found' : 'empty', reason: answered ? summary : (errors[0] || 'nothing found'), at });
    await updateLead(api, leadId, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: company step verdict not persisted (is the steps column migrated?)', e?.message || e);
  }

  await api.log('company_context', { id: leadId, staff_count: staff, found: answered, errors: errors.length });
  return {
    company: lead.company,
    staff_count: staff,
    summary: snapshot.summary ?? null,
    industry: snapshot.industry ?? null,
    hq: snapshot.hq ?? null,
    website: snapshot.website ?? null,
    errors: [...new Set(errors)],
  };
}
