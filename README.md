# Law Firm Secret Shopper Agent

An event-driven SMS agent that secret-shops law firms. It opens with a persona-based inquiry, stays idle until the firm replies, continues the thread like a real prospect, and stops when it gets a booking link or 12 hours elapse.

## How it works

```text
CLI/HTTP start ──► GoHighLevel SMS ──► law firm
                                         │
                                 firm replies via SMS
                                         ▼
                            GHL webhook wakes this service
                                         ▼
                       SQLite stores turn → QStash process job
                                         ▼
                    LLM (Claude Haiku 4.5) drafts reply / detects booking link
                                         ▼
                 booking link → goal_reached (stop)
                 reply text   → delayed QStash send → GHL SMS
                 12h timer    → expired (stop)
```

**Lifecycle:** `active` → `goal_reached` | `expired`

## Stack

| Piece | Role |
|---|---|
| Node + Express | HTTP service |
| GoHighLevel | Send/receive SMS |
| Upstash QStash | Process, delayed send, 12h expiry |
| SQLite | Conversation state |
| Anthropic Claude Haiku 4.5 | Dynamic SMS replies (or stub in tests) |
| Maritime.sh | Optional production host (public HTTPS + sleep/wake) |

## Local quick start

```bash
npm install
cp .env.example .env
# fill GHL_*, QSTASH_*, LLM_API_KEY (Anthropic), PUBLIC_BASE_URL
npm run dev
```

Expose with `ngrok http 3000`, set `PUBLIC_BASE_URL` to that HTTPS URL, wire GHL inbound (below).

Start one conversation:

```bash
npm run start:conversation -- config/persona.json
```

Or via HTTP (requires `START_CONVERSATION_TOKEN`):

```bash
curl -sS -X POST "$PUBLIC_BASE_URL/conversations/start" \
  -H "Content-Type: application/json" \
  -H "x-start-token: $START_CONVERSATION_TOKEN" \
  -d @config/persona.json
```

## Deploy to Maritime (Claude Haiku 4.5)

Maritime hosts this Express app. Replies still use the Anthropic API (`LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-haiku-4-5`).

1. Ensure the repo has a root `Dockerfile` (committed) and push your branch.
2. Install/login CLI:

```bash
npm i -g maritime-cli
maritime login
```

3. Create a public web agent from GitHub:

```bash
maritime create secret-shopper \
  --repo https://github.com/mpauls2839/Hack133-LawFirmSecretShopper \
  --branch main \
  --public --port 3000
```

4. Copy the public HTTPS URL from `maritime info secret-shopper` / the dashboard.
5. Import secrets (example `maritime.env`, do not commit secrets):

```bash
PUBLIC_BASE_URL=https://<maritime-public-host>
PORT=3000
DATA_DIR=/data
LLM_PROVIDER=anthropic
LLM_MODEL=claude-haiku-4-5
LLM_API_KEY=<anthropic_api_key>
START_CONVERSATION_TOKEN=<long_random_secret>
GHL_PRIVATE_TOKEN=...
GHL_LOCATION_ID=...
GHL_FROM_NUMBER=+17407614801
GHL_VALIDATE_SIGNATURE=false
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...
QSTASH_VALIDATE_SIGNATURE=true
REPLY_DELAY_SECONDS=45
CONVERSATION_TTL_HOURS=12
```

```bash
maritime env import secret-shopper ./maritime.env --reload
```

6. Point the GHL Workflow webhook at:

```text
POST https://<maritime-public-host>/webhooks/gohighlevel
```

7. Smoke:

```bash
curl -sS https://<maritime-public-host>/health
maritime logs secret-shopper -f
```

Redeploy after code changes:

```bash
maritime deploy secret-shopper --source github \
  --repo https://github.com/mpauls2839/Hack133-LawFirmSecretShopper \
  --branch main -w
```

## Wire inbound SMS (GHL Workflow)

Private Integrations can send SMS but do **not** forward inbound messages. Use a Workflow:

1. Trigger: **Customer Replied**, filter **Reply Channel = SMS**.
2. Action: Webhook/Custom Webhook → `{PUBLIC_BASE_URL}/webhooks/gohighlevel`.
3. Set `GHL_VALIDATE_SIGNATURE=false` for unsigned Workflow posts.

The parser accepts marketplace `InboundMessage` JSON and the default Workflow contact envelope (`phone`, nested `message`). Missing `to` falls back to `GHL_FROM_NUMBER`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/conversations/start` | Start conversation (header `x-start-token`) |
| `POST` | `/webhooks/gohighlevel` | Inbound SMS from GHL |
| `POST` | `/jobs/process-inbound` | QStash: decide next turn |
| `POST` | `/jobs/send-reply` | QStash: send delayed SMS |
| `POST` | `/jobs/expire-conversation` | QStash: 12h cutoff |

## Stop conditions

1. **Booking link** — inbound scheduling URL (or LLM-classified booking link)
2. **Timeout** — 12-hour expiry job

## Notes

- One conversation at a time (hackathon scope)
- Tests: `npm test` (uses stub LLM)
