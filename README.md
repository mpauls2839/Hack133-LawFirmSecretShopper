# Law Firm Secret Shopper Agent

An event-driven SMS agent that secret-shops law firms. It opens with a persona-based inquiry, stays idle until the firm replies, continues the thread like a real prospect, and stops when it gets a booking link or 12 hours elapse.

## How it works

```text
CLI start ──► GoHighLevel SMS ──► law firm
                                      │
                              firm replies via SMS
                                      ▼
                         GHL webhook wakes this service
                                      ▼
                    SQLite stores turn → QStash process job
                                      ▼
                 LLM decides: booking link? or draft reply?
                                      ▼
              booking link → goal_reached (stop)
              reply text   → delayed QStash send → GHL SMS
              12h timer    → expired (stop)
```

**Lifecycle:** `active` → `goal_reached` | `expired`

While active, each inbound SMS is acknowledged immediately, then processed asynchronously. Replies are delayed slightly so they feel human. After a terminal state, further inbound texts are recorded but not answered.

## Stack

| Piece | Role |
|---|---|
| Node + Express | HTTP service |
| GoHighLevel | Send/receive SMS (Twilio under the hood) |
| Upstash QStash | Wake-ups for process, delayed send, 12h expiry |
| SQLite | Conversation + message + job state |
| Stub / OpenAI / Anthropic | Turn decision + booking-link classification |

## Quick start

```bash
npm install
cp .env.example .env
# fill GHL_*, QSTASH_*, PUBLIC_BASE_URL
npm run dev
```

Expose the server (`ngrok http 3000`), set `PUBLIC_BASE_URL` to that HTTPS URL, then wire inbound SMS (see below).

Start one conversation:

```bash
npm run start:conversation -- config/persona.json
```

## Wire inbound SMS (GHL Workflow)

Private Integrations can send SMS but do **not** forward inbound messages to your app. Use a Workflow Custom Webhook (or the default Workflow webhook action):

1. Automation → Workflows → create e.g. `Secret Shopper Inbound SMS`.
2. Trigger: **Customer Replied**, filter **Reply Channel = SMS**.
3. Action: **Custom Webhook** or **Webhook** → `POST` → `{PUBLIC_BASE_URL}/webhooks/gohighlevel`.

The parser accepts both marketplace `InboundMessage` JSON and the default GHL Workflow contact envelope (`phone`, nested `message`, `customData`). When `to` is missing, it falls back to `GHL_FROM_NUMBER`.

Optional Custom Webhook body (explicit mapping):

```json
{
  "type": "InboundMessage",
  "messageType": "SMS",
  "locationId": "<your GHL_LOCATION_ID>",
  "messageId": "{{message.id}}",
  "from": "{{contact.phone}}",
  "to": "+17407614801",
  "body": "{{message.body}}"
}
```

Set `to` to your GHL sending number (`GHL_FROM_NUMBER`) if you map fields explicitly. Publish the workflow.

Workflow Custom Webhooks are unsigned, so set:

```bash
GHL_VALIDATE_SIGNATURE=false
```

Then restart the server. Confirm the startup log shows your ngrok HTTPS `PUBLIC_BASE_URL` (not `http://localhost:3000`), or QStash job callbacks will miss the tunnel.

Smoke-test without waiting on a real firm reply:

```bash
curl -sS -X POST "$PUBLIC_BASE_URL/webhooks/gohighlevel" \
  -H 'Content-Type: application/json' \
  -d '{
    "type":"InboundMessage","messageType":"SMS",
    "messageId":"test-inbound-1",
    "from":"+18476917564","to":"+17407614801",
    "body":"Yes we handle personal injury. Do you want a consult?"
  }'
```

Expect `accepted: true` and `reason: "queued"`. Check ngrok inspector (`:4040`), SQLite inbound rows, then a delayed outbound SMS after `REPLY_DELAY_SECONDS`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/webhooks/gohighlevel` | Inbound SMS from GHL |
| `POST` | `/jobs/process-inbound` | QStash: decide next turn |
| `POST` | `/jobs/send-reply` | QStash: send delayed SMS |
| `POST` | `/jobs/expire-conversation` | QStash: 12h cutoff |

## Stop conditions

1. **Booking link** — inbound text contains a scheduling URL (Calendly, Cal.com, etc., or LLM-classified booking link)
2. **Timeout** — exact 12-hour expiry job fires

## Notes

- One conversation at a time (hackathon scope)
- GHL may append STOP/sender compliance text on the first SMS; that is platform policy, not this agent
- Tests: `npm test`
