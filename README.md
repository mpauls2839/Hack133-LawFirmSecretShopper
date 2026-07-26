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

Expose the server (`ngrok http 3000`), set `PUBLIC_BASE_URL` to that HTTPS URL, wire GHL inbound SMS to:

```text
POST {PUBLIC_BASE_URL}/webhooks/gohighlevel
```

Start one conversation:

```bash
npm run start:conversation -- config/persona.json
```

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
- Workflow webhooks without signatures: set `GHL_VALIDATE_SIGNATURE=false`
- Tests: `npm test`
