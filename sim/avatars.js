// FFC setter simulator — AVATAR LIBRARY
// Each simulated lead = one avatar × one answer-style (× optional curveball).
// All leads share the same baseline knowledge (see prompts.js LEAD_BASE):
//   bought the $6.95 challenge (sell digital products via FACELESS IG reels),
//   watched the Elite webinar so they know a DFY program exists — but NOT its price/backend.
// The avatar defines their mindset, money reality, and which objection branch they're
// most likely to pull the setter toward (maps to the tree's 🟢 green / 🟡 yellow 2a-2f / 🔴 red).

const AVATARS = [
  { id:'broke_desperate',  label:'Broke & desperate',      mindset:'needs income NOW, stressed, price-sensitive', money:'almost none', leans:'🔴 red / financing', note:'wants it but genuinely tight on cash' },
  { id:'eager_newbie',     label:'Eager newbie',           mindset:'excited, optimistic, says yes easily',        money:'some savings',  leans:'🟢 green', note:'tests the happy path — risk of being too easy' },
  { id:'already_burned',   label:'Already burned',         mindset:'bought courses/coaching before, got nothing, defensive', money:'has it but guarded', leans:'🟡 2c (proof/guarantee)', note:'needs trust + proof' },
  { id:'tire_kicker',      label:'Tire-kicker',            mindset:'curious, non-committal, "just looking"',       money:'unclear',       leans:'🟡 2a (not sure / maybe)', note:'dodges commitment' },
  { id:'skeptical_analyst',label:'Skeptical analyst',      mindset:'logical, asks hard questions, wants proof/guarantee', money:'can afford', leans:'🟡 2c (guarantee/price)', note:'picks holes, needs evidence' },
  { id:'time_poor',        label:'Busy / time-poor',       mindset:'interested but "no time", needs it easy',      money:'can afford',    leans:'🟡 2e (time)', note:'objection = time, not money' },
  { id:'aggressive',       label:'Aggressive / rude',      mindset:'combative, blunt, tests composure',            money:'unclear',       leans:'🔴 red / drop', note:'adversarial — composure test' },
  { id:'confused',         label:'Confused / low-literacy',mindset:'short unclear replies, needs hand-holding',    money:'unclear',       leans:'🟡 2a', note:'ambiguous answers — routing stress test' },
  { id:'dreamer_nomoney',  label:'Dreamer, no money',      mindset:'wants it bad, genuinely cannot do $5k',        money:'none',          leans:'🔴 red → financing/downsell', note:'high desire, no funds' },
  { id:'ghoster',          label:'Ghoster',                mindset:'engages then goes quiet mid-convo',            money:'unclear',       leans:'silence → FU/nurture', note:'tests follow-up + nurture paths' },
  { id:'over_sharer',      label:'Over-sharer',            mindset:'dumps life story, drifts off-topic',           money:'unclear',       leans:'🟡 varies', note:'tests staying on script under noise' },
  { id:'ready_buyer',      label:'Ready buyer / high-intent',mindset:'basically wants in, low friction',           money:'ready',         leans:'🟢 green → book fast', note:'tests fast-track to booking' },
  { id:'partner_dependent',label:'Partner-dependent',      mindset:'"need to ask my wife/husband"',                money:'can afford',    leans:'🟡 2f (authority/partner)', note:'decision not solely theirs' },
  { id:'shiny_object',     label:'Shiny-object comparer',  mindset:'comparing to other gurus/programs, flaky',     money:'can afford',    leans:'🟡 2c / drop', note:'name-drops competitors' },
  { id:'scam_wary',        label:'Scam-wary',              mindset:'"is this legit / a scam?", guarded',           money:'unclear',       leans:'🟡 2c (proof/trust)', note:'needs legitimacy signals' },
  { id:'price_first',      label:'Price-first',            mindset:'opens with "how much" immediately',            money:'unclear',       leans:'tests PRICE-DEFLECTION hard rule', note:'fires the price objection early + often' },
];

// Answer style is orthogonal to avatar — how they TYPE, regardless of mindset.
const ANSWER_STYLES = [
  { id:'clean',      note:'gives clear, complete answers' },
  { id:'one_word',   note:'one or two word replies, minimal' },
  { id:'dodges',     note:'avoids the actual question, deflects' },
  { id:'counter_q',  note:'answers a question with a question' },
  { id:'over_share', note:'long rambling replies, extra detail' },
  { id:'off_topic',  note:'drifts to unrelated stuff' },
  { id:'goes_silent',note:'may stop replying mid-conversation' },
];

// Curveballs randomly injected to stress specific rules (optional per run).
const CURVEBALLS = [
  'asks the price very early',
  'asks "is this a scam"',
  'says they need to think about it',
  'suddenly goes cold / silent',
  'changes their mind after saying yes',
  'asks if there is a guarantee',
  'says they have no time this week',
];

module.exports = { AVATARS, ANSWER_STYLES, CURVEBALLS };
