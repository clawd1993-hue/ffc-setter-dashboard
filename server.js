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
const MANYCHAT_TOKEN = process.env.MANYCHAT_TOKEN || '';        // Pro plan, Settings -> API
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';  // reuse ours
const MC_BASE = 'https://api.manychat.com';
const STORE = path.join(__dirname, 'conversations.json');

// ---------- tiny JSON store (cut SQLite for skeleton) ----------
function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { conversations: seed() }; }
}
function save(db) { fs.writeFileSync(STORE, JSON.stringify(db, null, 2)); }
let db = load();

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
function touch(c) { c.updated = Date.now(); save(db); }

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
// free-text reply to a subscriber
const sendText = (subscriber_id, text) =>
  mc('/fb/sending/sendContent', { subscriber_id, data: { version: 'v2', content: { messages: [{ type: 'text', text }] } }, message_tag: 'ACCOUNT_UPDATE' });
// fire a SAVED ManyChat automation (booking/qualify/tag sequence) — THE hand-off
const sendFlow = (subscriber_id, flow_ns) => mc('/fb/sending/sendFlow', { subscriber_id, flow_ns });

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

// 1) ManyChat External Request lands here on every inbound message
app.post('/manychat/inbound', async (req, res) => {
  // ManyChat passes subscriber fields; accept many possible shapes/keys
  const b = req.body || {};
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
  if (text) c.messages.push({ dir: 'in', text, t: Date.now() });
  const s = await suggest(c);
  c.suggestion = s; c.tag = c.mode === 'auto' ? 'auto' : 'review'; touch(c);

  if (c.mode === 'auto') {
    // AUTO: answer ManyChat directly with a Dynamic Block v2 (telegram supported)
    c.messages.push({ dir: 'out', text: s.text, t: Date.now() }); touch(c);
    return res.json({ version: 'v2', content: { type: 'telegram', messages: [{ type: 'text', text: s.text }] } });
  }
  // APPROVE: hold — return empty so ManyChat says nothing; setter sends from dashboard
  return res.json({ version: 'v2', content: { type: 'telegram', messages: [] } });
});

// 2) dashboard feeds
app.get('/api/conversations', (_req, res) =>
  res.json(db.conversations.map(c => ({ id: c.id, name: c.name, handle: c.handle, channel: c.channel, avatarColor: c.avatarColor, mode: c.mode, tag: c.tag, updated: c.updated, preview: (c.messages.at(-1) || {}).text || '' }))));

app.get('/api/conversation/:id', (req, res) => {
  const c = convo(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

// 3) setter approves / sends own text -> push to ManyChat
app.post('/api/send', async (req, res) => {
  const { id, text } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  const out = (text || (c.suggestion && c.suggestion.text) || '').trim(); if (!out) return res.status(400).json({ error: 'empty' });
  const r = await sendText(c.subscriber_id, out);
  c.messages.push({ dir: 'out', text: out, t: Date.now() }); c.suggestion = null; c.tag = 'auto'; touch(c);
  res.json({ ok: true, manychat: r });
});

// 4) hand off to a SAVED ManyChat flow (booking/qualify/etc) — sendFlow
app.post('/api/fire-flow', async (req, res) => {
  const { id, flow_ns } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  const r = await sendFlow(c.subscriber_id, flow_ns);
  c.messages.push({ dir: 'out', text: `⚙️ fired flow ${flow_ns}`, t: Date.now() }); touch(c);
  res.json({ ok: true, manychat: r });
});

// 5) per-conversation Approve <-> Auto toggle
app.post('/api/mode', (req, res) => {
  const { id, mode } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  c.mode = mode === 'auto' ? 'auto' : 'approve'; c.tag = c.mode === 'auto' ? 'auto' : 'review'; touch(c);
  res.json({ ok: true, mode: c.mode });
});

// list saved flows (so we can grab flow_ns ids) — pass-through
app.get('/api/flows', async (_req, res) => {
  if (!MANYCHAT_TOKEN) return res.json({ stub: true, note: 'set MANYCHAT_TOKEN' });
  const r = await fetch(MC_BASE + '/fb/page/getFlows', { headers: { Authorization: `Bearer ${MANYCHAT_TOKEN}` } });
  res.json(await r.json().catch(() => ({ ok: r.ok })));
});

app.get('/health', (_req, res) => res.json({ ok: true, manychat: !!MANYCHAT_TOKEN, brain: !!ANTHROPIC_API_KEY, convos: db.conversations.length }));

app.listen(PORT, () => console.log(`FFC Setter skeleton on http://localhost:${PORT}  (manychat:${!!MANYCHAT_TOKEN} brain:${!!ANTHROPIC_API_KEY})`));
