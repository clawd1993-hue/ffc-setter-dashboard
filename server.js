/**
 * FFC Setter Dashboard — SKELETON (minimal)
 * -----------------------------------------
 * Flow:  ManyChat (Telegram pipe)  --External Request-->  /manychat/inbound
 *        -> log msg, identify lead, run brain (suggest reply)
 *        -> APPROVE mode: queue suggestion, hold (setter sends from dashboard)
 *        -> AUTO mode:    return Dynamic Block v2 reply straight to ManyChat
 *        Setter dashboard = ManyChat-lookalike inbox (public/index.html)
 *        Hand off to saved ManyChat automations via POST /api/fire-flow (sendFlow)
 *
 * Deliberately cut for the skeleton: auth, SQLite (JSON file instead),
 * analytics, outcome-training, real voice transcription. Wire later.
 *
 * What's STUBBED and needs Michael: MANYCHAT_TOKEN (Settings->API, Pro plan),
 * ANTHROPIC_API_KEY (reuse ours) for real suggestions, and the real flow_ns
 * ids from GET /fb/page/getFlows for booking/qualify hand-offs.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3461;
// SEND_ENABLED: lets a HUMAN send from the dashboard (the Send button). Default off.
const SEND_ENABLED = (process.env.SEND_ENABLED || '').toLowerCase() === 'on';
// AUTO_SEND_ENABLED: lets the app AUTONOMOUSLY reply (Auto mode) with ZERO human. Default off, kept off.
const AUTO_SEND_ENABLED = (process.env.AUTO_SEND_ENABLED || '').toLowerCase() === 'on';
const MANYCHAT_TOKEN = process.env.MANYCHAT_TOKEN || '';        // Pro plan, Settings -> API
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';  // reuse ours
const MC_BASE = 'https://api.manychat.com';
// GHL — look up the lead's REAL checkout name by email (ManyChat name is often a nickname)
const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'tXCdfKQO75A9wknq5eOa';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const STORE = path.join(__dirname, 'conversations.json');

// ---------- Supabase (persistent store, survives deploys) ----------
// Uses PostgREST directly with the service-role key — no npm dependency.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SB_TABLE = 'ffc_setter_conversations';
const USE_DB = !!(SUPABASE_URL && SUPABASE_KEY);

async function sb(pathq, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

// upsert one conversation row (fire-and-forget on writes, awaited where it matters)
async function dbUpsert(c) {
  if (!USE_DB) return;
  const row = { id: c.id, subscriber_id: c.subscriber_id, name: c.name || '', updated: c.updated || Date.now(), data: c };
  await sb(`${SB_TABLE}?on_conflict=id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

// ---------- store (Supabase when configured, JSON file fallback for local) ----------
function loadFile() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { conversations: USE_DB ? [] : seed() }; }
}
function save(db) { if (!USE_DB) fs.writeFileSync(STORE, JSON.stringify(db, null, 2)); }
let db = loadFile();

async function bootLoad() {
  if (!USE_DB) return;
  try {
    const rows = await sb(`${SB_TABLE}?select=data&order=updated.desc`);
    db.conversations = (rows || []).map(r => r.data).filter(Boolean);
    console.log(`[db] loaded ${db.conversations.length} conversations from Supabase`);
  } catch (e) {
    console.error('[db] load failed, starting empty:', e.message);
    db.conversations = [];
  }
}

function seed() {
  // one demo convo so the dashboard renders live on first boot
  return [{
    id: 'demo-sarah',
    subscriber_id: '0000000001',
    name: 'Sarah J.',
    handle: '@sarahj_fit',
    channel: 'Telegram',
    avatarColor: '#F5A623',
    mode: 'approve',           // approve | auto
    tag: 'review',             // review | auto | hot
    updated: Date.now(),
    lead: { Stage: 'Qualifying', Source: 'Telegram Ad — Quote #4', 'Bought $6.95?': 'No', 'First msg': 'Today' },
    aiRead: ['Beginner', 'Price-sensitive', 'Warm'],
    nextStep: 'Push for the booking link once she reacts to price.',
    messages: [
      { dir: 'in',  text: 'hey saw your ad, what is this exactly?', t: Date.now() - 6e5 },
      { dir: 'out', text: "Hey Sarah! 🙌 It's the Faceless Funnel Challenge — a 10-day program to make money selling done-for-you digital products. Beginner-friendly. What's pulling you toward it?", t: Date.now() - 5e5 },
      { dir: 'in',  text: "i've never done anything online before tho", t: Date.now() - 4e5 },
      { dir: 'in',  text: 'how much is the elite thing again?', t: Date.now() - 1e5 },
    ],
    suggestion: { text: "Great question! The Challenge is just $6.95 to start. Elite is our full done-for-you tier — I'd rather walk you through what's included on a quick call so it actually fits your situation. Want me to grab you a time? 📅", confidence: 0.86 },
  }];
}

function convo(id) { return db.conversations.find(c => c.id === id); }
function touch(c) {
  c.updated = Date.now();
  save(db); // JSON fallback (no-op when USE_DB)
  if (USE_DB) dbUpsert(c).catch(e => console.error('[db] upsert failed:', e.message));
}

// ---------- ManyChat API helpers ----------
async function mc(endpoint, body) {
  if (!MANYCHAT_TOKEN) return { ok: false, stub: true, note: 'MANYCHAT_TOKEN not set — call skipped (skeleton)' };
  const r = await fetch(MC_BASE + endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MANYCHAT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: r.ok }));
}
// free-text reply to a subscriber (Telegram; no message_tag — Meta deprecated tags)
const sendText = (subscriber_id, text) =>
  mc('/fb/sending/sendContent', { subscriber_id, data: { version: 'v2', content: { type: 'telegram', messages: [{ type: 'text', text }] } } });
// fire a SAVED ManyChat automation (booking/qualify/tag sequence) — THE hand-off
const sendFlow = (subscriber_id, flow_ns) => mc('/fb/sending/sendFlow', { subscriber_id, flow_ns });
// GET helper (getInfo etc.)
async function mcGet(endpoint) {
  if (!MANYCHAT_TOKEN) return null;
  const r = await fetch(MC_BASE + endpoint, { headers: { Authorization: `Bearer ${MANYCHAT_TOKEN}` } });
  return r.json().catch(() => null);
}
// pull the lead's saved email (ManyChat system field) once, cache it on the convo
async function enrichEmail(c) {
  if (!c || c.email || !MANYCHAT_TOKEN || !c.subscriber_id) return;
  try {
    const r = await mcGet(`/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(c.subscriber_id)}`);
    const d = r && r.data;
    if (d) { if (d.email) c.email = d.email; if (!c.handle && d.user_name) c.handle = '@' + d.user_name; touch(c); }
  } catch (e) {}
}
// title-case a name GHL stores lowercase ("craig dunnicliff" -> "Craig Dunnicliff")
const tc = s => (s || '').trim().replace(/\b\w/g, m => m.toUpperCase());
// look up the lead's REAL name from their checkout record in GHL (matched by email) — cache on convo
async function enrichRealName(c) {
  if (!c || !GHL_API_KEY || c.realNameV2) return;
  if (!c.email) return; // need an email to match on
  try {
    const url = `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(c.email)}&limit=5`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } });
    const d = await r.json().catch(() => null);
    const email = (c.email || '').toLowerCase();
    const hit = (d && d.contacts || []).find(x => (x.email || '').toLowerCase() === email) || (d && d.contacts || [])[0];
    c.realNameV2 = true;
    if (hit) {
      // GHL sometimes stuffs the full name in firstName and repeats the surname → dedupe tokens, keep order
      const raw = `${hit.firstName || ''} ${hit.lastName || ''}`.trim() || hit.contactName || '';
      const seen = new Set(), uniq = [];
      for (const p of raw.split(/\s+/).filter(Boolean)) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(p); } }
      const full = tc(uniq.join(' '));
      const first = tc((hit.firstName || uniq[0] || '').trim().split(/\s+/)[0]); // single first name for messaging
      if (first) c.firstName = first;
      if (full) c.realName = full;
    }
    touch(c);
  } catch (e) { c.realNameV2 = true; }
}

// ---------- brain (suggestion) — real Claude if key, else stub ----------
async function suggest(c) {
  const lastIn = [...c.messages].reverse().find(m => m.dir === 'in');
  if (!ANTHROPIC_API_KEY) {
    return { text: `(stub suggestion — set ANTHROPIC_API_KEY) Re: "${lastIn ? lastIn.text : ''}"`, confidence: 0.5, stub: true };
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const transcript = c.messages.map(m => `${m.dir === 'in' ? 'Lead' : 'Setter'}: ${m.text}`).join('\n');
    const msg = await client.messages.create({
      model: 'claude-sonnet-5', max_tokens: 400,
      system: 'You are an FFC (Faceless Funnel Challenge) setter. Warm, concise, never pushy. Goal: qualify then book a call for the $5k Elite. Reply with ONLY the message to send.',
      messages: [{ role: 'user', content: `Conversation so far:\n${transcript}\n\nWrite the next reply.` }],
    });
    return { text: msg.content[0].text.trim(), confidence: 0.8 };
  } catch (e) {
    return { text: `(brain error: ${e.message})`, confidence: 0, stub: true };
  }
}

// ---------- server ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DEBUG: ring buffer of the last raw inbound payloads (to discover what ManyChat sends on media)
const RAW_INBOUND = [];
function captureRaw(tag, body) {
  RAW_INBOUND.unshift({ t: new Date().toISOString(), tag, body });
  if (RAW_INBOUND.length > 20) RAW_INBOUND.pop();
}
app.get('/api/debug/inbound', (req, res) => {
  if (req.query.key !== 'clawd26') return res.status(403).json({ error: 'nope' });
  res.json(RAW_INBOUND);
});

// 1) ManyChat External Request lands here on every inbound message
app.post('/manychat/inbound', async (req, res) => {
  // ManyChat passes subscriber fields; accept many possible shapes/keys
  const b = req.body || {};
  captureRaw('inbound', b);
  const pickv = (...ks) => { for (const k of ks) { if (b[k] != null && String(b[k]).trim() !== '') return String(b[k]).trim(); } return ''; };
  try { fs.appendFileSync(path.join(__dirname, 'inbound.log'), new Date().toISOString() + ' ' + JSON.stringify(b) + '\n'); } catch {}
  const sid = pickv('subscriber_id', 'id', 'user_id', 'contact_id', 'key') || 'unknown';
  const text = pickv('text', 'last_input_text', 'last_text_input', 'last_text', 'message', 'last_input');
  b.name = b.name || [pickv('first_name'), pickv('last_name')].filter(Boolean).join(' ') || pickv('full_name', 'username');
  let c = db.conversations.find(x => x.subscriber_id === sid);
  if (!c) {
    c = { id: 'mc-' + sid, subscriber_id: sid, name: b.name || 'Lead ' + sid.slice(-4), handle: b.user_name || '', channel: 'Telegram', avatarColor: '#0084FF', mode: 'approve', tag: 'review', updated: Date.now(), lead: {}, aiRead: [], nextStep: '', messages: [], suggestion: null };
    db.conversations.unshift(c);
  }
  // try to grab a media/attachment URL if ManyChat ever sends one (not in default payload yet)
  const mediaUrl = pickv('attachment_url', 'last_input_attachment', 'image_url', 'media_url', 'file_url', 'last_attachment_url');
  if (text) {
    c.messages.push({ dir: 'in', text, t: Date.now() });
  } else if (mediaUrl) {
    c.messages.push({ dir: 'in', text: '', mediaUrl, t: Date.now() });        // real image → render inline
  } else {
    // non-text user input (image/voice/sticker) with no URL — at least register it so it's not invisible
    c.messages.push({ dir: 'in', text: '📷 Sent an image / media — not viewable here yet (open ManyChat to see it)', t: Date.now(), media: true });
  }
  enrichEmail(c).catch(() => {}); // fire-and-forget: grab saved email on first contact
  const s = await suggest(c);
  c.suggestion = s; c.tag = c.mode === 'auto' ? 'auto' : 'review'; touch(c);

  if (c.mode === 'auto' && AUTO_SEND_ENABLED) {
    // AUTO: answer ManyChat directly with a Dynamic Block v2 (telegram supported)
    c.messages.push({ dir: 'out', text: s.text, t: Date.now() }); touch(c);
    return res.json({ version: 'v2', content: { type: 'telegram', messages: [{ type: 'text', text: s.text }] } });
  }
  // APPROVE: hold — return empty so ManyChat says nothing; setter sends from dashboard
  return res.json({ version: 'v2', content: { type: 'telegram', messages: [] } });
});

// 1b) MIRROR — ManyChat automations (e.g. the /start welcome flow) POST each of their
// steps here so the setter sees the full exchange the automation ran (email ask, access
// delivery, the lead's email reply). Does NOT generate an AI suggestion or send anything.
// Body: { subscriber_id, text, dir?: 'out'|'in' (default out), label? }
app.post('/manychat/mirror', (req, res) => {
  const b = req.body || {};
  const pickv = (...ks) => { for (const k of ks) { if (b[k] != null && String(b[k]).trim() !== '') return String(b[k]).trim(); } return ''; };
  try { fs.appendFileSync(path.join(__dirname, 'inbound.log'), new Date().toISOString() + ' MIRROR ' + JSON.stringify(b) + '\n'); } catch {}
  const sid = pickv('subscriber_id', 'id', 'user_id', 'contact_id', 'key');
  let text = pickv('text', 'message', 'last_input_text', 'last_text_input', 'last_text', 'last_input');
  const label = pickv('label');
  if (label) text = `⚙️ ${label}${text ? ': ' + text : ''}`;
  if (!sid || !text) return res.json({ ok: false, note: 'need subscriber_id + text' });
  const dir = pickv('dir', 'direction').toLowerCase().startsWith('in') ? 'in' : 'out';
  let c = db.conversations.find(x => x.subscriber_id === sid);
  if (!c) {
    b.name = b.name || [pickv('first_name'), pickv('last_name')].filter(Boolean).join(' ') || pickv('full_name', 'username');
    c = { id: 'mc-' + sid, subscriber_id: sid, name: b.name || 'Lead ' + sid.slice(-4), handle: pickv('user_name'), channel: 'Telegram', avatarColor: '#0084FF', mode: 'approve', tag: 'review', updated: Date.now(), lead: {}, aiRead: [], nextStep: '', messages: [], suggestion: null };
    db.conversations.unshift(c);
  }
  // dedupe: ignore identical dir+text within 15s (ManyChat can retry External Requests)
  const last = c.messages.at(-1);
  if (last && last.dir === dir && last.text === text && Date.now() - last.t < 15000) return res.json({ ok: true, deduped: true });
  c.messages.push({ dir, text, t: Date.now(), mirror: true });
  if (dir === 'in' && pickv('email')) c.email = c.email || pickv('email');
  touch(c);
  res.json({ ok: true });
});

// 2) dashboard feeds
// status is DERIVED from the last message: they messaged last -> "review" (needs reply);
// we messaged last -> "replied". Explicit follow-up stages (fu1..fue3) are a separate pipeline and win.
const PIPE_TAGS = ['fu1', 'fu2', 'fu3', 'fu4', 'fu5', 'fue1', 'fue2', 'fue3'];
function statusOf(c) {
  if (PIPE_TAGS.includes(c.tag)) return c.tag;     // a follow-up stage was explicitly set
  const last = c.messages && c.messages.at(-1);
  if (!last) return 'review';
  if (last.dir === 'out') return 'replied';        // we spoke last
  // last is inbound. Normally = review, UNLESS a setter manually marked it replied
  // AFTER that inbound (used when ManyChat isn't synced). Auto-reverts: any NEW inbound
  // (t > manualRepliedAt) wins back "review".
  if (c.manualRepliedAt && last.t <= c.manualRepliedAt) return 'replied';
  return 'review';
}
app.get('/api/conversations', (_req, res) =>
  res.json(db.conversations.map(c => ({ id: c.id, name: c.name, handle: c.handle, channel: c.channel, avatarColor: c.avatarColor, mode: c.mode, tag: statusOf(c), closed: !!c.closed, updated: c.updated, preview: (c.messages.at(-1) || {}).text || '' }))));

app.get('/api/conversation/:id', async (req, res) => {
  const c = convo(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.email) await enrichEmail(c); // backfill email on open
  if (!c.realNameV2) await enrichRealName(c); // backfill real checkout name from GHL
  res.json(c);
});

// 3) setter approves / sends own text -> push to ManyChat
app.post('/api/send', async (req, res) => {
  const { id, text } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  const out = (text || (c.suggestion && c.suggestion.text) || '').trim(); if (!out) return res.status(400).json({ error: 'empty' });
  if (!SEND_ENABLED) { return res.json({ ok: false, blocked: true, note: 'Sending is OFF (SEND_ENABLED not set). Nothing was sent to the lead.' }); }
  const r = await sendText(c.subscriber_id, out);
  c.messages.push({ dir: 'out', text: out, t: Date.now() }); c.suggestion = null; c.tag = 'replied'; touch(c);
  res.json({ ok: true, manychat: r });
});

// 4) hand off to a SAVED ManyChat flow (booking/qualify/etc) — sendFlow
app.post('/api/fire-flow', async (req, res) => {
  const { id, flow_ns, name } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  if (!SEND_ENABLED) { return res.json({ ok: false, blocked: true, note: 'Sending is OFF (SEND_ENABLED not set). Automation NOT fired to the lead.' }); }
  const r = await sendFlow(c.subscriber_id, flow_ns);
  c.messages.push({ dir: 'out', text: `⚙️ fired automation: ${name || flow_ns}`, t: Date.now() }); touch(c);
  res.json({ ok: true, manychat: r });
});

// 5) per-conversation Approve <-> Auto toggle
app.post('/api/mode', (req, res) => {
  const { id, mode } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  c.mode = mode === 'auto' ? 'auto' : 'approve'; c.tag = c.mode === 'auto' ? 'auto' : 'review'; touch(c);
  res.json({ ok: true, mode: c.mode });
});

// 5b) manually mark a lead "Replied" (ManyChat not synced). Auto-reverts to "review"
// on their next inbound message. Pass {id} or {email} or {name} to match.
app.post('/api/mark-replied', (req, res) => {
  const b = req.body || {};
  const want = (b.replied === false) ? false : true;
  let c = b.id && convo(b.id);
  if (!c && b.email) { const e = String(b.email).toLowerCase(); c = db.conversations.find(x => (x.email || '').toLowerCase() === e); }
  if (!c && b.name) { const n = String(b.name).toLowerCase().trim(); c = db.conversations.find(x => (x.name || '').toLowerCase().trim() === n || (x.realName || '').toLowerCase().trim() === n); }
  if (!c) return res.status(404).json({ error: 'not found', q: b });
  c.manualRepliedAt = want ? Date.now() : 0;
  touch(c);
  res.json({ ok: true, id: c.id, name: c.name, status: statusOf(c) });
});

// 6) close / reopen a lead (moves them to the Closed list)
app.post('/api/close', (req, res) => {
  const { id, closed } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  c.closed = closed === false ? false : true; touch(c);
  res.json({ ok: true, closed: c.closed });
});

// list saved flows (so we can grab flow_ns ids) — pass-through
app.get('/api/flows', async (_req, res) => {
  if (!MANYCHAT_TOKEN) return res.json({ stub: true, note: 'set MANYCHAT_TOKEN' });
  const r = await fetch(MC_BASE + '/fb/page/getFlows', { headers: { Authorization: `Bearer ${MANYCHAT_TOKEN}` } });
  res.json(await r.json().catch(() => ({ ok: r.ok })));
});

// ---------- canned / saved responses (stored in Supabase) ----------
const SB_CANNED = 'ffc_saved_replies';
app.get('/api/canned', async (_req, res) => {
  if (!USE_DB) return res.json([]);
  try { res.json(await sb(`${SB_CANNED}?select=id,title,text&order=created_at.asc`) || []); }
  catch (e) { res.json([]); }
});
app.post('/api/canned', async (req, res) => {
  const text = (req.body && req.body.text || '').trim(); if (!text) return res.status(400).json({ error: 'empty' });
  const title = (req.body && req.body.title || '').trim();
  if (!USE_DB) return res.status(503).json({ error: 'no db' });
  try { await sb(SB_CANNED, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ title, text }) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/canned/:id', async (req, res) => {
  if (!USE_DB) return res.status(503).json({ error: 'no db' });
  try { await sb(`${SB_CANNED}?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- bookmarks (setter quick links, stored in Supabase) ----------
const SB_BM = 'ffc_bookmarks';
app.get('/api/bookmarks', async (_req, res) => {
  if (!USE_DB) return res.json([]);
  try { res.json(await sb(`${SB_BM}?select=id,label,url&order=sort.asc,created_at.asc`) || []); }
  catch (e) { res.json([]); }
});
app.post('/api/bookmarks', async (req, res) => {
  const label = (req.body && req.body.label || '').trim();
  let url = (req.body && req.body.url || '').trim();
  if (!label || !url) return res.status(400).json({ error: 'label and url required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!USE_DB) return res.status(503).json({ error: 'no db' });
  try { await sb(SB_BM, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ label, url }) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bookmarks/:id', async (req, res) => {
  if (!USE_DB) return res.status(503).json({ error: 'no db' });
  try { await sb(`${SB_BM}?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_req, res) => res.json({ ok: true, manychat: !!MANYCHAT_TOKEN, brain: !!ANTHROPIC_API_KEY, db: USE_DB, convos: db.conversations.length }));

bootLoad().finally(() => {
  app.listen(PORT, () => console.log(`FFC Setter on http://localhost:${PORT}  (manychat:${!!MANYCHAT_TOKEN} brain:${!!ANTHROPIC_API_KEY} db:${USE_DB})`));
});
