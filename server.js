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
// Telegram media (via the ffc-tg-proxy that sits in front of ManyChat)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';           // FFC setter bot token (for getFile + download)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';       // Whisper transcription for voice notes
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

// ---- automation name <-> flow_ns cache (so the AI can reference flows by name) ----
// Only these are setter-sendable in the script; hide system/default/untitled flows from the brain.
const SENDABLE_FLOWS = ['Welcome VN', 'What is FFC', 'FFC Access Link', 'Proof', 'Booking Link'];
let FLOW_MAP = {};        // lowercased name -> flow_ns
let FLOW_MAP_AT = 0;
async function refreshFlowMap() {
  if (!MANYCHAT_TOKEN) return FLOW_MAP;
  if (Date.now() - FLOW_MAP_AT < 10 * 60000 && Object.keys(FLOW_MAP).length) return FLOW_MAP; // 10-min cache
  try {
    const r = await fetch(MC_BASE + '/fb/page/getFlows', { headers: { Authorization: `Bearer ${MANYCHAT_TOKEN}` } });
    const d = await r.json();
    const flows = (d && d.data && d.data.flows) || [];
    const m = {};
    for (const f of flows) { if (f.name && f.ns) m[f.name.toLowerCase().trim()] = f.ns; }
    FLOW_MAP = m; FLOW_MAP_AT = Date.now();
  } catch (e) { console.error('[flows] refresh failed:', e.message); }
  return FLOW_MAP;
}
// resolve an automation name the AI used -> flow_ns (exact, then contains match)
function flowNsByName(name) {
  const n = (name || '').toLowerCase().trim();
  if (!n) return null;
  if (FLOW_MAP[n]) return FLOW_MAP[n];
  const key = Object.keys(FLOW_MAP).find(k => k.includes(n) || n.includes(k));
  return key ? FLOW_MAP[key] : null;
}
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
      // if the display name is still a nameless "Lead 1234" placeholder, upgrade it to the real name
      if (full && /^Lead \d{4}$/.test(c.name || '')) c.name = full;
    }
    touch(c);
  } catch (e) { c.realNameV2 = true; }
}

// ---------- the 7-Labs DM-setting playbook (the AI's reference for the ideal convo arc) ----------
const MAIN_SCRIPT = `FACELESS FUNNEL CHALLENGE — DM-SETTING SCRIPT (7 LABS, "Paul")
GOLDEN RULE: when there's a LIVE conversation, work the live chat to book them — be human, show passion.

ARC: Welcome VN (greeting) → STEP 1 (tried online before / first look?) → bridge → "What is FFC" VN → "watched the first video?" → STEP 2 "why now?" → STEP 3 (acknowledge their why + dig: situation + invested-before/what-was-missing) → STEP 4 THE GATE (every lead, before ANY link) → branch 🟢/🟡/🔴.

AUTOMATIONS — what each one already SAYS (so you NEVER repeat its content in your own text):
- "Welcome VN" = the opening greeting voice note. It already says: "Hey, it's Paul here! Congrats on taking the first step, excited to connect and help you get started. Let's dive in and get you to that first sale!" (greets them by name). → So right after firing Welcome VN, your text is ONLY the clean Step 1 question — do NOT write "hey", "hi", or "Paul here" again.
- "What is FFC" = the explainer voice note on how the whole thing works. Fire it after the Step 1 bridge; don't re-explain it in text.
- "FFC Access Link" = sends their training access/login page. Fire it if they can't find the link.
- "Proof" = testimonials / student results. Fire it in the green/yellow branch when showing what's possible.
- "Booking Link" = the call-booking link. Fire it only after they say YES to a call.
Rule: when you fire an automation, your text must NOT duplicate what that automation already says.

STEP 1 (clean text, no greeting — the Welcome VN already greeted them): "Quick one before we dive in, have you tried building something online before, or is this your first real look into it?"
 - Beginner → "Sure, no worries then you're exactly who this was built for. Most of our best students started from zero. Let me send you a quick voice note so you get how the whole thing works" → then fire What is FFC.
 - Tried before → "Ah nice, so you already know the game. That makes this easier, the part most people get stuck on is the offer, not the tech. Let me send you a quick voice note on how we do it differently" → then fire What is FFC.
 → then: "So have you had a chance to watch the first video of the training yet?"

STEP 2 "WHY NOW": "why now? what changed recently that made you go 'ok, I need to figure this out' this month rather than next year?"
 - Not watched the video → "no worries! it's only 10 min and everything after makes way more sense once you've seen it 🙌 while you get to it, why now?"
 ACKNOWLEDGE their answer in THEIR words, one line. Never the generic "wake up whenever you want" line.

STEP 3: respond to their WHY NOW (acknowledge + next question in ONE message), goal = learn (1) their situation (working / own business / in between) and (2) have they invested in help before + what was missing.
 - "have you tried anything before to get out of it, a course/coaching, or is this your first real go?"
 - If burned/scammed before → "what was missing last time - the info, or the support after you invested?"
 - support/doing-it-alone was missing → "so it wasn't the info, it was doing it alone — that's exactly who this works best for."

STEP 4 — THE GATE (EVERY LEAD, BEFORE ANY LINK): "If we walked you through how our team can shortcut all this for you, and it felt like the right fit, are you in a position to invest in that right now, or would it be more of a future thing?"

🟢 GREEN (yes / would find a way / open): goal+proof → "let's get you moving 👌 you said you want [their thing], let me show you what that looks like" [Proof] → plan+ask: "we build your site, load proven products, set up your first ad so you're selling in days not months. Our Head Coach can walk you through it on a quick call — want me to grab you a spot this week?" → on YES → send Booking Link.
🟡 YELLOW (future / not sure / just curious → NO link yet; never say "no pressure"): ISOLATE "is it more the investment side, or more that you're not sure this'd actually work for you?" → answer ONCE by type (price-with-income: "if the investment wasn't a factor, would you actually want to do this?"; price-no-income: value first, max 3 msgs, never a number; fit/doubt: "what would make this a yes for you?"; time: "will next month really be less busy? we build it so it doesn't eat your week"; partner: "if you asked them today would you say it's the right move?") → PROOF + proposal → "want me to grab you a spot this week?" → YES → Booking Link.
🔴 RED (hard no money for now → no call/proof/link): ONE message — "no worries 🙏 then the right move right now is the challenge, not Elite. You've got the training + products, get first sales on your own, I'm here for questions. When you're in a better spot, reach back and we'll set up the call. I'll check in on [date] 🙌"`;

// strip internal/system lines (automation narration, placeholders) so the AI reasons on the REAL convo only
function cleanMsgs(c) {
  return (c.messages || []).filter(m => {
    const t = (m.text || '').trim();
    if (!t) return false;
    if (/^⚙️ fired automation:/.test(t)) return false;        // internal: "fired automation: X"
    if (/^📷 Sent an image/.test(t)) return false;            // media placeholder noise
    if (m.mirror && /(bot sent setup message|path - bot sent|online soon$|training video reminder)/i.test(t)) return false; // welcome-flow narration
    return true;
  });
}
function transcriptOf(c) {
  return cleanMsgs(c).map(m => `${m.dir === 'in' ? 'Lead' : 'Setter'}: ${m.text}`).join('\n');
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
    await refreshFlowMap();
    const transcript = transcriptOf(c);
    const msg = await client.messages.create({
      model: 'claude-sonnet-5', max_tokens: 500,
      system: `You are Paul, an FFC (Faceless Funnel Challenge) DM setter. Warm, human, concise, never pushy. Goal: follow the script below to qualify the lead and book a call for the $5k Elite.
Read the transcript, work out WHERE in the script the lead is, and produce the next scripted move — adapted to their exact words, not copy-paste. Acknowledge what they actually said in one line before the next question. Never skip the Gate before sending any link. Use the script's wording and ONLY the emojis the script itself uses — do NOT add emojis (no 👇 etc.) that aren't in the script.

A single move can be MULTIPLE steps in order — e.g. fire the "Welcome VN" automation THEN send the Step 1 message. Available automations you may fire (use the exact name): ${SENDABLE_FLOWS.join(', ')}.

OUTPUT FORMAT — reply with ONLY a JSON array of steps, in order, no prose around it:
[{"fire":"Welcome VN"}, {"say":"Hey, it's Paul here! ..."}]
Use {"fire":"<automation name>"} to fire an automation, {"say":"<message>"} to send a text. Most turns are just one {"say":...}. Fire an automation only where the script calls for it (Welcome VN at the very start, What is FFC after Step 1, FFC Access Link if they can't find it, Proof + Booking Link in the green/yellow branches). Output valid JSON only.

SCRIPT:
${MAIN_SCRIPT}`,
      messages: [{ role: 'user', content: `Conversation so far:\n${transcript}\n\nGive the next move as a JSON array of steps, following the script for where this lead is.` }],
    });
    const out = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const steps = parseSteps(out);
    return { steps, text: steps.filter(s => s.type === 'message').map(s => s.text).join('\n'), confidence: 0.8 };
  } catch (e) {
    return { text: `(brain error: ${e.message})`, confidence: 0, stub: true };
  }
}

// turn the AI's JSON step array into normalized steps; fall back to one plain message on any parse miss
function parseSteps(out) {
  let raw = (out || '').trim();
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const steps = [];
      for (const s of arr) {
        if (s && typeof s.say === 'string' && s.say.trim()) steps.push({ type: 'message', text: s.say.trim() });
        else if (s && typeof s.fire === 'string' && s.fire.trim()) steps.push({ type: 'flow', name: s.fire.trim(), flow_ns: flowNsByName(s.fire) });
      }
      if (steps.length) return steps;
    }
  } catch {}
  return [{ type: 'message', text: (out || '').trim() }]; // not JSON → treat whole thing as one message
}

// ---------- Follow-Up suggestion generator (Phase 1) ----------
// The lead went quiet after we spoke. Draft the next NUDGE from Michael's proven FU bank,
// fitting wherever the conversation actually is. Suggestion-only — a setter approves it.
const FU_BANK = `PRE-BOOKING FOLLOW-UP LADDERS (one a day, escalating). Pick the line that fits where the convo actually is; don't repeat anything already sent.

NEVER REPLIED AT ALL (opening nudges): "[name]?" · "👀" · "I'd like to get a quick picture of where you're at and what you're after, so I can point you in the right direction. Is this your first time building something online, or have you had a go before?"

QUIET AFTER "did you watch the first video?": "👋" · "Quick one before we dive in, step one is the first training video, it's 10 minutes 👇 did you watch it yet?" (resend access link)

QUIET AFTER "why now?": "Just popping back here 😊" · "hey [name], you said you want [their goal, their words]. Is that still the plan or has something changed since we spoke?"

SHARED POOL LINES — each sent ONCE per lead EVER (check the transcript; never reuse one already sent):
- "Just curious where your head's at. 1 to 10, how serious are you about actually making this happen?"
- "Real quick, where are you at with this - still looking into it or has it dropped down the list?"
- "I don't want to keep filling up your inbox, so I'll leave you with one last message 😊 Is there a better time for us to pick this up?"  (the close — only near the end)

BUMPS (no-question pokes): "👋" · "Are you getting my messages? 🙂" — use at most ONCE, only early (FU1/FU2), never twice.

LATE / BREAK-UP: "Hey [name] 👋 how's the challenge going, did you get your first products up yet? And you said [their reason], how's that looking now?"`;

async function generateFuSuggestion(c, step) {
  if (!ANTHROPIC_API_KEY) { c.fuSuggestion = { text: '(set ANTHROPIC_API_KEY)', step, t: Date.now(), stub: true }; return; }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const transcript = transcriptOf(c);
    const tone = step <= 2 ? 'gentle' : step <= 4 ? 'a bit more direct' : 'a graceful break-up (give them an easy out)';
    const msg = await client.messages.create({
      model: 'claude-sonnet-5', max_tokens: 200,
      system: `You are Paul, an FFC (Faceless Funnel Challenge) DM setter. A lead has gone quiet after we last messaged them — write the NEXT follow-up NUDGE. This is follow-up #${step}, so tone = ${tone}.

CRITICAL: The follow-up message MUST come from the FU BANK below (or a short custom nudge in that exact style). NEVER re-send or re-ask a line from the main script — the script is ONLY to help you work out what STAGE they went quiet at. Re-sending the script question (e.g. "have you tried building something online before…") is WRONG. A follow-up is a light nudge to re-engage, not a repeat of the question they ignored.

How to pick:
- Figure out the LAST thing we said that they didn't answer, and which FU-bank ladder that maps to:
  · They never replied to the very first setter message → "NEVER REPLIED AT ALL" ladder (FU1 is literally just "[name]?").
  · Went quiet after "did you watch the first video?" → that ladder.
  · Went quiet after "why now?" → that ladder.
- Use follow-up #${step} = the Nth rung of that ladder (gentle early, more direct later).
- NEVER reuse a line already in the transcript — especially the once-ever pool lines ("1 to 10", "where are you at", the "one last message" close).
- Fill tokens ([name], [their reason], [their goal]) from the transcript; drop them if unknown.
- Output ONLY the message text. One short message. No preamble, no quotes.

FU BANK (your ONLY source for the nudge):
${FU_BANK}

SCRIPT (reference ONLY — to identify the stage; do NOT copy lines from it):
${MAIN_SCRIPT}`,
      messages: [{ role: 'user', content: `Transcript so far:\n${transcript}\n\nWrite follow-up #${step}.` }],
    });
    const fuOut = (msg.content.find(b => b.type === 'text') || {}).text || '';
    c.fuSuggestion = { text: fuOut.trim(), step, t: Date.now() };
  } catch (e) {
    c.fuSuggestion = { text: `(FU brain error: ${e.message})`, step, t: Date.now(), stub: true };
  }
  touch(c);
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
  } else if (b.name && /^Lead \d{4}$/.test(c.name || '')) {
    c.name = b.name; // upgrade a nameless "Lead 1234" placeholder once a real name arrives
  }
  if (text) {
    c.messages.push({ dir: 'in', text, t: Date.now() });
    // BRIDGE: match this text to a recent proxy text to link tgId <-> this convo
    if (!c.tgId) {
      const n = norm(text);
      if (n && !COMMON.has(n) && n.length >= 3) {
        const hit = TG_TEXTS.find(e => e.norm === n && Date.now() - e.t < BRIDGE_WINDOW);
        if (hit && !convoByTg(hit.tgId)) linkTg(hit.tgId, c);
      }
    }
  } else {
    // media (null text): the proxy delivers the REAL file — don't log a placeholder.
    // record a media event so an unlinked proxy media can timing-match to this convo,
    // and claim any already-held media for a tgId within the window.
    MC_MEDIA.unshift({ convoId: c.id, t: Date.now(), claimed: !!c.tgId });
    if (MC_MEDIA.length > 60) MC_MEDIA.pop();
    if (c.tgId && HELD_MEDIA[c.tgId]) { const held = HELD_MEDIA[c.tgId]; delete HELD_MEDIA[c.tgId]; held.forEach(m => pushMedia(c, m)); }
    else if (!c.tgId) {
      const tgId = Object.keys(HELD_MEDIA).find(k => (HELD_MEDIA[k] || []).some(m => Date.now() - m.t < BRIDGE_WINDOW));
      if (tgId) linkTg(tgId, c);
    }
  }
  enrichEmail(c).catch(() => {}); // fire-and-forget: grab saved email on first contact
  const s = text ? await suggest(c) : c.suggestion; // only re-suggest on real text
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
  const MC_OK = { version: 'v2', content: { messages: [] } }; // ManyChat-compatible response (no "invalid format" warning)
  if (!sid || !text) return res.json(MC_OK);
  const dir = pickv('dir', 'direction').toLowerCase().startsWith('in') ? 'in' : 'out';
  let c = db.conversations.find(x => x.subscriber_id === sid);
  if (!c) {
    b.name = b.name || [pickv('first_name'), pickv('last_name')].filter(Boolean).join(' ') || pickv('full_name', 'username');
    c = { id: 'mc-' + sid, subscriber_id: sid, name: b.name || 'Lead ' + sid.slice(-4), handle: pickv('user_name'), channel: 'Telegram', avatarColor: '#0084FF', mode: 'approve', tag: 'review', updated: Date.now(), lead: {}, aiRead: [], nextStep: '', messages: [], suggestion: null };
    db.conversations.unshift(c);
  }
  // dedupe: ignore identical dir+text within 15s (ManyChat can retry External Requests)
  const last = c.messages.at(-1);
  if (last && last.dir === dir && last.text === text && Date.now() - last.t < 15000) return res.json(MC_OK);
  // mirrored automation narration (e.g. the Welcome flow). Status is derived purely from who
  // spoke last: an OUTBOUND welcome = we spoke last = "Replied" (waiting on them) → FU if they go
  // silent. Only the lead actually messaging back (via /manychat/inbound) = "Needs review".
  c.messages.push({ dir, text, t: Date.now(), mirror: true });
  if (dir === 'in' && pickv('email')) c.email = c.email || pickv('email');
  touch(c);
  res.json(MC_OK);
});

// 2) dashboard feeds
// status is DERIVED from the last message: they messaged last -> "review" (needs reply);
// we messaged last & recent -> "replied"; we messaged last & gone quiet -> escalates into the
// follow-up ladder FU1..FU5 by how long they've been silent (Follow-Up system, Phase 1 plumbing).
// Cumulative hours of silence (from our last message) to reach each step. CONFIG — tweakable.
// FU1 @1h, FU2 @+12h(=13), FU3 @+24h(=37), FU4 @+24h(=61), FU5 @+72h(=133).
const FU_THRESHOLDS_H = [1, 13, 37, 61, 133];
function fuStepForSilence(hours) {
  let step = 0;
  for (let i = 0; i < FU_THRESHOLDS_H.length; i++) if (hours >= FU_THRESHOLDS_H[i]) step = i + 1;
  return step; // 0 = not overdue yet; 1..5 = FU step
}
function statusOf(c) {
  const last = c.messages && c.messages.at(-1);
  if (!last) return 'review';
  // Only a REAL setter reply (outbound, NOT a bot/automation mirror) counts as "we replied".
  // A fired automation / welcome mirror does NOT — a setter still needs to pick the lead up.
  if (last.dir === 'out' && !last.mirror) {         // a human setter spoke last
    const step = fuStepForSilence((Date.now() - last.t) / 3600000);
    return step ? ('fu' + step) : 'replied';        // recent = replied; aged = fu1..fu5
  }
  // last was the lead (inbound) OR only a bot automation (mirror) → a setter needs to act = review.
  // Exception: a setter manually marked replied AFTER the last inbound (auto-reverts on next inbound).
  if (last.dir === 'in' && c.manualRepliedAt && last.t <= c.manualRepliedAt) return 'replied';
  return 'review';
}
app.get('/api/conversations', (_req, res) =>
  // display name = real GHL checkout name whenever we have it; TG name / "Lead 1234" is only a fallback
  res.json(db.conversations.map(c => ({ id: c.id, name: c.realName || c.name, handle: c.handle, channel: c.channel, avatarColor: c.avatarColor, mode: c.mode, tag: statusOf(c), closed: !!c.closed, callBooked: !!c.callBooked, updated: c.updated, preview: (c.messages.at(-1) || {}).text || '' }))));

app.get('/api/conversation/:id', async (req, res) => {
  const c = convo(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.email) await enrichEmail(c); // backfill email on open
  if (!c.realNameV2) await enrichRealName(c); // backfill real checkout name from GHL
  // upgrade a leftover "Lead 1234" placeholder if we already know the real name (e.g. mirror-created leads)
  if (c.realName && /^Lead \d{4}$/.test(c.name || '')) { c.name = c.realName; touch(c); }
  // Follow-Up suggestion: if this lead is overdue (fu1..fu5) and we spoke last, draft the next
  // nudge (once per step). Non-blocking — the thread auto-refreshes to pick it up in a few sec.
  const st = statusOf(c);
  if (req.query.refu) delete c.fuSuggestion; // ?refu=1 forces a fresh FU draft (e.g. after a prompt change)
  if (/^fu[1-5]$/.test(st)) {
    const step = parseInt(st.slice(2), 10);
    if (!c.fuSuggestion || c.fuSuggestion.step !== step) {
      if (!c.fuSuggestion || !c.fuSuggestion.pending) {
        c.fuSuggestion = { text: '', step, pending: true, t: Date.now() };
        generateFuSuggestion(c, step).catch(() => {}); // fire-and-forget
      }
    }
  } else if (c.fuSuggestion) {
    delete c.fuSuggestion; // no longer overdue (lead replied etc.) — clear stale draft
  }
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

// 3b) setter approves a MULTI-STEP suggestion (fire automation(s) + message(s)) — run in order
app.post('/api/send-sequence', async (req, res) => {
  const { id, steps } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  const seq = Array.isArray(steps) && steps.length ? steps : (c.suggestion && c.suggestion.steps) || [];
  if (!seq.length) return res.status(400).json({ error: 'no steps' });
  if (!SEND_ENABLED) { return res.json({ ok: false, blocked: true, note: 'Sending is OFF (SEND_ENABLED not set). Nothing was sent to the lead.' }); }
  const done = [];
  const GAP_MS = 3000; // human-like pause between stacked messages/automations
  let first = true;
  for (const s of seq) {
    if (!first) await new Promise(r => setTimeout(r, GAP_MS));
    first = false;
    if (s.type === 'flow' || s.fire) {
      const name = s.name || s.fire;
      const ns = s.flow_ns || flowNsByName(name);
      if (!ns) { done.push({ skipped: name, reason: 'no matching automation' }); continue; }
      await sendFlow(c.subscriber_id, ns);
      c.messages.push({ dir: 'out', text: `⚙️ fired automation: ${name}`, t: Date.now() });
      done.push({ fired: name });
    } else {
      const t = (s.text || s.say || '').trim(); if (!t) continue;
      await sendText(c.subscriber_id, t);
      c.messages.push({ dir: 'out', text: t, t: Date.now() });
      done.push({ sent: t });
    }
  }
  c.suggestion = null; c.tag = 'replied'; touch(c);
  res.json({ ok: true, steps: done });
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

// ---------- Telegram media ingest (from ffc-tg-proxy) ----------
// Resolve a Telegram file_id -> fresh temporary download URL (file_path expires, file_id doesn't)
async function tgFileUrl(fileId) {
  if (!TG_BOT_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const d = await r.json().catch(() => null);
  const fp = d && d.result && d.result.file_path;
  return fp ? `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fp}` : null;
}

// transcribe a voice/audio file_id with Whisper -> set message.transcript + readable text
async function transcribeVoice(c, msg) {
  if (!OPENAI_API_KEY) return;
  try {
    const url = await tgFileUrl(msg.fileId);
    if (!url) return;
    const audio = await (await fetch(url)).arrayBuffer();
    const form = new FormData();
    form.append('file', new Blob([audio]), 'voice.ogg');
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form,
    });
    const d = await r.json().catch(() => null);
    if (d && d.text) { msg.transcript = d.text.trim(); msg.text = `🎙️ Voice note (transcribed): ${msg.transcript}`; touch(c); }
  } catch (e) { console.error('[whisper] failed:', e.message); }
}

// ====== BRIDGE: link a lead's Telegram id <-> their ManyChat convo ======
// ManyChat hides the Telegram id, so we link the PERSON once (by matching a text both
// sides saw, or by the timing of a media event), cache it on the convo (c.tgId), then
// all their media flows into that one thread. Media before any link is held + flushed.
const BRIDGE_WINDOW = 25000;                 // ms: how close the two sides must be to match
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const COMMON = new Set(['hi','hey','hello','yo','ok','okay','yes','no','yep','nope','sure','k','hiya','thanks','ty','👍','🙏']);
const TG_TEXTS = [];        // recent proxy texts: {tgId, name, username, norm, t}
const MC_MEDIA = [];        // recent ManyChat null-text (media) events: {convoId, t, claimed}
const HELD_MEDIA = {};      // tgId -> [messages] waiting for a link
const MEDIA_LABEL = { image: '📷 Photo', voice: '🎙️ Voice note', audio: '🎵 Audio', video: '🎬 Video', document: '📄 File' };
const convoByTg = tgId => db.conversations.find(c => c.tgId === tgId);

function pushMedia(c, m) {
  c.messages.push(m); touch(c);
  if (m.mediaType === 'voice' || m.mediaType === 'audio') transcribeVoice(c, m);
}
function linkTg(tgId, c) {         // bind a tgId to a convo + flush any held media
  if (!c || c.tgId === tgId) return;
  c.tgId = tgId;
  const held = HELD_MEDIA[tgId] || [];
  delete HELD_MEDIA[tgId];
  held.forEach(m => pushMedia(c, m));
  touch(c);
}

// unified feed from the ffc-tg-proxy: every Telegram message (text for linking, media to show)
app.post('/ingest/tg', async (req, res) => {
  const b = req.body || {};
  const tgId = String(b.subscriber_id || b.tgId || '').trim();
  if (!tgId) return res.status(400).json({ error: 'need tgId' });

  // --- MEDIA ---
  if (b.file_id) {
    const type = b.type || 'document';
    const label = type === 'document' ? ('📄 ' + (b.file_name || 'File')) : (MEDIA_LABEL[type] || '📎 Attachment');
    const msg = { dir: 'in', t: b.t || Date.now(), mediaType: type, fileId: b.file_id, text: b.caption || label, mirror: true };
    const linked = convoByTg(tgId);
    if (linked) { pushMedia(linked, msg); return res.json({ ok: true, id: linked.id, linked: true }); }
    // not linked yet: try to timing-match a very recent ManyChat media event, else hold
    const slot = MC_MEDIA.find(s => !s.claimed && Date.now() - s.t < BRIDGE_WINDOW);
    if (slot) { slot.claimed = true; const c = db.conversations.find(x => x.id === slot.convoId); if (c) { linkTg(tgId, c); pushMedia(c, msg); return res.json({ ok: true, id: c.id, linkedByTiming: true }); } }
    (HELD_MEDIA[tgId] = HELD_MEDIA[tgId] || []).push(msg);
    return res.json({ ok: true, held: true });
  }

  // --- TEXT (used only to link; the message itself is logged via ManyChat) ---
  const n = norm(b.text);
  if (n && !COMMON.has(n) && n.length >= 3) {
    TG_TEXTS.unshift({ tgId, name: b.name || '', username: b.username || '', norm: n, t: Date.now() });
    if (TG_TEXTS.length > 80) TG_TEXTS.pop();
    const linked = convoByTg(tgId);
    if (linked) linked.updated = Date.now();
  }
  res.json({ ok: true });
});

// serve a Telegram file through us so the bot token never hits the browser
app.get('/tg-file/:fileId', async (req, res) => {
  try {
    const url = await tgFileUrl(req.params.fileId);
    if (!url) return res.status(404).send('no file');
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('fetch fail');
    res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).send(e.message); }
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

// mark a lead as Call Booked → drops them in the Call Booked bucket (pass {booked:false} to undo)
app.post('/api/call-booked', (req, res) => {
  const { id, booked } = req.body; const c = convo(id); if (!c) return res.status(404).json({ error: 'not found' });
  c.callBooked = booked === false ? false : true; touch(c);
  res.json({ ok: true, callBooked: c.callBooked });
});

// hard-delete a conversation (test cleanup) — removes from memory + Supabase + unlinks tgId
app.delete('/api/conversation/:id', async (req, res) => {
  const id = req.params.id;
  const idx = db.conversations.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [gone] = db.conversations.splice(idx, 1);
  if (gone && gone.tgId) { for (const k of Object.keys(HELD_MEDIA)) if (k === gone.tgId) delete HELD_MEDIA[k]; }
  save(db);
  if (USE_DB) { try { await sb(`${SB_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); } catch (e) { return res.json({ ok: true, memory: true, dbWarn: e.message }); } }
  res.json({ ok: true, deleted: id });
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
