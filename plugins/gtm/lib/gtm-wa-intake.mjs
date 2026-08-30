// GTM ∩ WhatsApp intake — surface the people the operator already talks to as
// selectable lead candidates: DM chats (contacts AND anyone who ever messaged),
// senders seen inside groups, and live group rosters from the wa-gateway.
// Selected people become plugin_gtm_leads rows (name carried over, source
// noted) and flow into the normal Intake -> Enrich chain.
//
// Plugin lib (contract v2.1): imports NOTHING. Every exported function takes
// `api` first. Host tables (wa_chats, wa_messages, wa_lid_map, contacts) are
// SELECT-only host_reads; LID resolution goes through the whatsapp gateway
// (mode resolve_lids), which owns the wa_lid_map cache writes host-side.
// Phone helpers (normalizePhone / locatePhone) are duplicated from the host's
// gtm-phone.js — the lib-imports-nothing contract requires the copy.

const gid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── phone helpers (duplicated from lib/gtm-phone.js — pure, no api) ─────────

// Normalize one number to E.164 and flag validity.
function normalizePhone(number, defaultCC = '+972') {
  const raw = String(number || '');
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = defaultCC + d.replace(/\D/g, '').replace(/^0+/, '');
  const valid = /^\+\d{8,15}$/.test(d);
  return { normalized: valid ? d : raw, valid };
}

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

// Derive country and state/region from a phone number by its FORMAT only.
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

// ── WA intake proper ────────────────────────────────────────────────────────

// '972500000000@c.us' -> '+972500000000'; '@lid' / '@g.us' ids carry no phone.
function phoneFromWaId(waId) {
  const m = /^(\d{6,17})@c\.us$/.exec(String(waId || ''));
  if (!m) return null;
  const n = normalizePhone('+' + m[1]);
  return n.valid ? n.normalized : null;
}

async function leadPhoneSet(api) {
  const r = await api.db.prepare('SELECT normalized_phone FROM plugin_gtm_leads WHERE normalized_phone IS NOT NULL').all();
  return new Set((r.results || []).map((x) => x.normalized_phone));
}

async function contactPhoneSet(api) {
  const out = new Set();
  try {
    const r = await api.db.prepare('SELECT phone FROM contacts WHERE phone IS NOT NULL AND phone != \'\'').all();
    for (const row of r.results || []) {
      const n = normalizePhone(row.phone);
      if (n.valid) out.add(n.normalized);
    }
  } catch { /* contacts table optional */ }
  return out;
}

// Fill phones for @lid people from the gateway's LID<->PN map (the whatsapp
// gateway owns the wa_lid_map cache; a bounded number of unknown lids resolve
// per call, the rest warm up on later opens). Mutates in place.
async function fillLidPhones(api, people) {
  const lids = people.filter((p) => !p.phone && /@lid$/.test(p.wa_id)).map((p) => p.wa_id);
  if (!lids.length) return;
  const map = await api.gateway('whatsapp', 'resolve_lids', { lids });
  for (const p of people) {
    if (!p.phone && Object.prototype.hasOwnProperty.call(map, p.wa_id)) {
      const phone = map[p.wa_id];
      if (phone) {
        const n = normalizePhone(phone);
        p.phone = n.valid ? n.normalized : phone;
      }
    }
  }
}

function annotate(person, leadSet, contactSet) {
  return {
    ...person,
    already_lead: !!(person.phone && leadSet.has(person.phone)),
    is_contact:   !!(person.phone && contactSet.has(person.phone)),
  };
}

// Everyone WhatsApp knows about: DM chats (one row per person we have a chat
// with) merged with distinct group senders (people who messaged in groups —
// includes non-contacts). '@lid' senders surface with phone:null so the
// operator sees them but can't import them (the enrich chain needs a phone).
export async function listWaIntakePeople(api, { q = '', limit = 1000 } = {}) {
  const byId = new Map();

  const dms = await api.db.prepare(
    "SELECT id, name, last_message_at FROM wa_chats WHERE is_group = 0 AND id NOT LIKE '%@broadcast'",
  ).all();
  for (const c of dms.results || []) {
    byId.set(c.id, {
      wa_id: c.id, name: c.name || null, phone: phoneFromWaId(c.id),
      kind: 'chat', last_seen: c.last_message_at || null, messages: null,
    });
  }

  const senders = await api.db.prepare(
    `SELECT sender_id, sender_name, MAX(timestamp) AS t, COUNT(*) AS n
       FROM wa_messages
      WHERE from_me = 0 AND sender_id IS NOT NULL AND sender_id != ''
        AND sender_id NOT LIKE '%@g.us' AND sender_id NOT LIKE '%@broadcast'
      GROUP BY sender_id`,
  ).all();
  for (const s of senders.results || []) {
    const prev = byId.get(s.sender_id);
    if (prev) {
      prev.name = prev.name || s.sender_name || null;
      prev.last_seen = Math.max(prev.last_seen || 0, s.t || 0) || null;
      prev.messages = s.n;
    } else {
      byId.set(s.sender_id, {
        wa_id: s.sender_id, name: s.sender_name || null, phone: phoneFromWaId(s.sender_id),
        kind: 'group-sender', last_seen: s.t || null, messages: s.n,
      });
    }
  }

  const needle = String(q || '').trim().toLowerCase();
  let people = [...byId.values()];
  if (needle) {
    people = people.filter((p) =>
      (p.name || '').toLowerCase().includes(needle) || (p.phone || '').includes(needle) || p.wa_id.includes(needle));
  }
  people.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  people = people.slice(0, limit);
  await fillLidPhones(api, people);
  const leadSet = await leadPhoneSet(api);
  const contactSet = await contactPhoneSet(api);
  return people.map((p) => annotate(p, leadSet, contactSet));
}

export async function listWaIntakeGroups(api) {
  const r = await api.db.prepare(
    'SELECT id, name, last_message_at FROM wa_chats WHERE is_group = 1 ORDER BY last_message_at DESC',
  ).all();
  return r.results || [];
}

// Live roster for one group (via the whatsapp gateway), names resolved from
// the gateway payload first, then from messages we've persisted for that group.
export async function listWaGroupCandidates(api, groupId) {
  const info = await api.gateway('whatsapp', 'group_info', { group_id: groupId });
  const nameById = new Map();
  try {
    const r = await api.db.prepare(
      `SELECT sender_id, sender_name FROM wa_messages
        WHERE chat_id = ? AND sender_name IS NOT NULL AND sender_name != ''
        GROUP BY sender_id`,
    ).bind(groupId).all();
    for (const row of r.results || []) nameById.set(row.sender_id, row.sender_name);
  } catch { /* names stay null */ }

  const raw = (info.participants || []).map((p) => {
    const waId = typeof p === 'string' ? p : (p?.id?._serialized || p?.id || '');
    const gwName = typeof p === 'object' ? (p?.pushname || p?.name || p?.notify || null) : null;
    return {
      wa_id: waId,
      name: gwName || nameById.get(waId) || null,
      phone: phoneFromWaId(waId),
      kind: 'participant',
      is_admin: typeof p === 'object' ? !!(p?.isAdmin || p?.isSuperAdmin) : false,
    };
  }).filter((p) => p.wa_id);
  await fillLidPhones(api, raw);
  const leadSet = await leadPhoneSet(api);
  const contactSet = await contactPhoneSet(api);
  const participants = raw.map((p) => annotate(p, leadSet, contactSet));

  return { group: { id: info.id, name: info.name, participant_count: info.participant_count }, participants };
}

// Drain the LID backlog: every @lid the picker can show (DM chats + group
// senders) that has no fresh cache row, resolved one gateway-batch at a time.
// The picker calls this in a loop while open, so phones fill in live instead
// of trickling in per open. Returns progress so the loop knows when to stop.
export async function resolveWaIntakeBacklog(api, { limit = 50 } = {}) {
  const lidSet = new Set();
  const dms = await api.db.prepare(
    "SELECT id FROM wa_chats WHERE is_group = 0 AND id LIKE '%@lid'",
  ).all().catch(() => ({ results: [] }));
  for (const r of dms.results || []) lidSet.add(r.id);
  const senders = await api.db.prepare(
    `SELECT DISTINCT sender_id FROM wa_messages
      WHERE from_me = 0 AND sender_id LIKE '%@lid'`,
  ).all().catch(() => ({ results: [] }));
  for (const r of senders.results || []) lidSet.add(r.sender_id);

  const all = [...lidSet];
  if (!all.length) return { attempted: 0, resolved: 0, remaining: 0 };
  const NULL_TTL_MS = 7 * 24 * 3600 * 1000;
  const cached = await api.db.prepare('SELECT lid, phone, resolved_at FROM wa_lid_map').all().catch(() => ({ results: [] }));
  const fresh = new Set();
  for (const row of cached.results || []) {
    const stale = row.phone == null && (Date.now() - row.resolved_at) > NULL_TTL_MS;
    if (!stale) fresh.add(row.lid);
  }
  const backlog = all.filter((l) => !fresh.has(l));
  if (!backlog.length) return { attempted: 0, resolved: 0, remaining: 0 };

  // The gateway's resolve_lids mode resolves up to 50 unknown lids per call,
  // so the chunk stays within that bound (same cap as the original direct call).
  const chunk = backlog.slice(0, Math.min(limit, 50));
  const map = await api.gateway('whatsapp', 'resolve_lids', { lids: chunk });
  let resolved = 0;
  for (const phone of Object.values(map)) if (phone) resolved++;
  return { attempted: chunk.length, resolved, remaining: Math.max(0, backlog.length - chunk.length) };
}

// Import selected people as plugin_gtm_leads — same batch/dedupe/event
// conventions as importLeads, plus the name WhatsApp already knows and
// provenance in sources. Host rows are only ever read (SELECT), the copy is a
// separate INSERT into the plugin's own table.
export async function importWaLeads(api, { people = [], source = null } = {}) {
  const batch_id = gid('gb');
  let valid = 0, invalid = 0, duplicates = 0, created = 0;
  const leadSet = await leadPhoneSet(api);
  for (const person of people) {
    const n = normalizePhone(person?.phone || '');
    if (!n.valid) { invalid++; continue; }
    valid++;
    if (leadSet.has(n.normalized)) { duplicates++; continue; }
    leadSet.add(n.normalized);
    const g = locatePhone(n.normalized);
    const name = String(person?.name || '').trim() || null;
    const sources = name ? { name: { tool: 'whatsapp', at: Date.now() } } : {};
    await api.db.prepare(`
      INSERT INTO plugin_gtm_leads (id, phone, normalized_phone, status, source, batch_id, country, region, name, sources, created_at, updated_at)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(gid('gl'), n.normalized, n.normalized, source || 'whatsapp', batch_id, g.country, g.region, name, JSON.stringify(sources), Date.now(), Date.now()).run();
    created++;
  }
  const summary = { total: people.length, valid, invalid, duplicates, created, batch_id: created > 0 ? batch_id : null, via: 'whatsapp', source: source || 'whatsapp' };
  if (created > 0) {
    await api.db.prepare('INSERT INTO plugin_gtm_batches (id, source, via, total, created, duplicates, invalid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(batch_id, source || 'whatsapp', 'whatsapp', people.length, created, duplicates, invalid, Date.now()).run();
  }
  await api.log('leads_imported', summary);
  return summary;
}
