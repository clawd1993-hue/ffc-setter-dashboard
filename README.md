# FFC Setter Dashboard — Skeleton

ManyChat-lookalike inbox for FFC setters. **ManyChat owns the Telegram pipe; this is the brain + inbox on top.**
Companion plan: `workspace/memory/ai-appointment-2.0.md` + build spec `ai-appointment-2.0-build-spec.md`.

## Run
```bash
cd ffc-setter-dashboard
npm install
PORT=3461 node server.js        # or: npm start
# open http://localhost:3461
```
Boots with stubs (no token/key) so you can see the UI + flow immediately. One demo conversation is seeded.

## The loop
```
Telegram lead --> ManyChat --External Request--> POST /manychat/inbound
  -> log msg, run brain (suggest reply)
  -> APPROVE mode: hold (empty Dynamic Block); setter sends from dashboard
  -> AUTO mode:    return Dynamic Block v2 reply to ManyChat (telegram)
Setter dashboard: convo list · thread + AI suggestion · lead panel · Approve/Auto toggle
Hand off to a SAVED ManyChat automation: POST /api/fire-flow {id, flow_ns}  (sendFlow)
```

## Endpoints
- `POST /manychat/inbound` — ManyChat External Request receiver (set this as the URL in a Default-Reply/keyword step)
- `GET /api/conversations`, `GET /api/conversation/:id` — dashboard feeds
- `POST /api/send {id,text}` — setter approves/sends → ManyChat `sendContent`
- `POST /api/fire-flow {id,flow_ns}` — fire a saved flow → ManyChat `sendFlow`
- `POST /api/mode {id,mode}` — approve|auto per conversation
- `GET /api/flows` — list saved flows (to grab `flow_ns` ids) via `getFlows`
- `GET /health`

## What's STUBBED (wire next, in order)
1. **MANYCHAT_TOKEN** — ManyChat Pro plan → Settings → API. Unlocks sendContent/sendFlow/getFlows + External Request.
2. **ANTHROPIC_API_KEY** — reuse ours → real suggestions (currently placeholder text). Model `claude-sonnet-5` in `suggest()`.
3. **Real flow_ns ids** — `GET /api/flows`, copy the booking/qualify flow namespaces into the dashboard hand-off buttons.
4. **Subscriber field mapping** — `/manychat/inbound` maps `subscriber_id/name/text` loosely; map to the actual ManyChat External Request payload fields.
5. **RAG / FFC knowledge base** — load FFC objection/qualify playbook into the brain system prompt (fork Ethan's `discord-support-bot/ai-helper-claude.js`).

## Deliberately CUT from the skeleton (add later if needed)
auth/login, SQLite (uses `conversations.json`), analytics, outcome-training logging, real voice-note transcription (UI only), multi-setter assignment.

## Deploy later
Same pattern as other FFC services (Render web service or launchd on the mini). Keep `/manychat/inbound` publicly reachable (ngrok/Render) so ManyChat can hit it.
