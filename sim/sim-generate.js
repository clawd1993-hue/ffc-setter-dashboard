#!/usr/bin/env node
/*
 * FFC SETTER SIMULATOR — generator (OFFLINE / ISOLATED)
 * ----------------------------------------------------------------------------
 * HARD ISOLATION (Michael's rule 2026-11-27):
 *   This script NEVER calls ManyChat, the real /api/send, /api/fire-flow, or any
 *   real lead. It only: (1) reads the resolved script tree, (2) runs a lead-bot vs
 *   setter-bot text loop via the Anthropic API, (3) writes transcripts to /api/sims
 *   for human review. Meta/ManyChat never see anything. Run it by hand, offline.
 *
 * USAGE:
 *   node sim-generate.js --dry --n 8          # fabricate N fake transcripts (NO API) → POST to dashboard
 *   node sim-generate.js --n 100              # real run (needs ANTHROPIC key + a finished tree)
 *   node sim-generate.js --tree ./tree.json   # use a local tree file instead of /api/sim-tree
 *
 * STATUS: skeleton. --dry works end-to-end now. Real bot loop is stubbed at runPair()
 *   until the whiteboard tree is finished + exported (flow.html "Export tree" → /api/sim-tree).
 */
const { AVATARS, ANSWER_STYLES, CURVEBALLS } = require('./avatars');
const { leadPrompt, setterPrompt } = require('./prompts');

const BASE = process.env.SIM_BASE || 'https://ffc-setter-dashboard.onrender.com';
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DRY = has('--dry');
const N = parseInt(val('--n', '8'), 10);
const MAX_TURNS = 24;

// ---- tree loader (resolved nodes+edges). Export from the whiteboard: flow.html → "Export tree". ----
async function loadTree() {
  const local = val('--tree', null);
  if (local) return JSON.parse(require('fs').readFileSync(local, 'utf8'));
  const r = await fetch(`${BASE}/api/sim-tree?t=${Date.now()}`, { cache: 'no-store' });
  const d = await r.json();
  return d.tree || null;
}
function nodeText(n) {
  if (!n) return '';
  if (n.steps) return n.steps.map(s => s.t === 'flow' ? `⚡${s.name}` : s.text).join('  ⏎  ');
  return n.text || n.title || '';
}
function entryNode(tree) { // top-most node with no incoming edge
  const hasIn = new Set((tree.edges || []).map(e => e.to));
  return (tree.nodes || []).find(n => !hasIn.has(n.id)) || (tree.nodes || [])[0];
}

// ---- the two bots. REAL implementation stubbed until the tree is final. ----
async function callClaude(system, messages) {
  // TODO(real): POST api.anthropic.com/v1/messages with key from ~/.openclaw/credentials.
  // Kept unimplemented on purpose so an accidental run can't burn tokens before we're ready.
  throw new Error('callClaude not wired yet — use --dry, or wire the Anthropic call when the tree is final.');
}
async function runPair(tree, avatar, style, curveball) {
  const rules = tree.rules || [];
  let node = entryNode(tree);
  const turns = [];
  const convo = [];
  for (let t = 0; t < MAX_TURNS && node; t++) {
    // setter sends current node
    turns.push({ role: 'setter', text: nodeText(node), nodeId: node.id, expectedNodeId: node.id });
    convo.push({ role: 'assistant', content: nodeText(node) });
    if (!(tree.edges || []).some(e => e.from === node.id)) break; // terminal
    // lead replies
    const leadMsg = await callClaude(leadPrompt(avatar, style, curveball), convo);
    turns.push({ role: 'lead', text: leadMsg });
    convo.push({ role: 'user', content: leadMsg });
    // setter picks next node
    const pick = JSON.parse(await callClaude(setterPrompt(tree, rules, node.id), convo));
    if (pick.done) break;
    node = (tree.nodes || []).find(n => n.id === pick.nodeId);
  }
  return { turns, outcome: node ? (node.id) : 'incomplete' };
}

// ---- --dry: fabricate a plausible transcript so the dashboard + review flow is testable NOW ----
function dryPair(avatar, style) {
  const t = [
    { role: 'setter', text: 'Let me send you a quick voice note so you get how the whole thing works 🙌', nodeId: 'n1', expectedNodeId: 'n1' },
    { role: 'lead', text: style.id === 'one_word' ? 'k' : 'ok watched it' },
    { role: 'setter', text: "Nice, so you've seen the whole picture now 👌 And so why now? What changed recently?", nodeId: 'why_watched', expectedNodeId: 'why_watched' },
    { role: 'lead', text: avatar.id === 'broke_desperate' ? 'need money fast bro' : 'just want to finally make this work' },
    { role: 'setter', text: 'That makes sense. And have you ever invested in yourself like this before?', nodeId: 's3_generic', expectedNodeId: 's3_generic' },
  ];
  return { turns: t, outcome: 'nurture' };
}

async function main() {
  const tree = DRY ? null : await loadTree();
  if (!DRY && !tree) { console.error('No tree found. Export it from flow.html first, or use --dry.'); process.exit(1); }
  const sims = [];
  for (let i = 0; i < N; i++) {
    const avatar = AVATARS[i % AVATARS.length];
    const style = ANSWER_STYLES[Math.floor(Math.random() * ANSWER_STYLES.length)];
    const curveball = Math.random() < 0.4 ? CURVEBALLS[Math.floor(Math.random() * CURVEBALLS.length)] : null;
    const { turns, outcome } = DRY ? dryPair(avatar, style) : await runPair(tree, avatar, style, curveball);
    sims.push({
      id: `sim_${String(i + 1).padStart(3, '0')}`,
      avatar: avatar.label, answerStyle: style.id, curveball: curveball || null,
      status: 'unreviewed', outcome,
      checks: deterministicChecks(turns, tree), // pre-run auto-checks so flagged ones float up
      turns,
    });
  }
  // write to the dashboard (NOT a real conversation row — the __sims__ special row)
  const r = await fetch(`${BASE}/api/sims`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sims }) });
  console.log(`posted ${sims.length} sims → ${BASE}/sim-review.html  (${r.status})`);
}

// ---- deterministic checks: the part no "dumb judge" is needed for ----
function deterministicChecks(turns, tree) {
  const ids = new Set((tree && tree.nodes || []).map(n => n.id));
  const out = { onScript: true, routingOk: true, validTerminal: null };
  for (const t of turns) {
    if (t.role !== 'setter') continue;
    if (tree && t.nodeId && !ids.has(t.nodeId)) out.onScript = false;        // referenced a node that doesn't exist
    if (t.expectedNodeId && t.nodeId !== t.expectedNodeId) out.routingOk = false; // took the wrong edge
  }
  return out;
}

main().catch(e => { console.error(e); process.exit(1); });
