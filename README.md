# Verlyn Rebook

An AI agent system for salons that brings lapsed clients back and answers WhatsApp enquiries in Arabic and English, on top of the booking software they already use. It runs a 30-day pilot and measures results against a control group.

## Try it

Needs Node 24 or later.

```bash
npm install
```

```bash
npm run rebook -- demo
```

The demo uses fictional clients, a keyword stub instead of AI, and made-up outcomes, so never quote its numbers.

To test the agents yourself, add a Groq or OpenRouter key to `.env`, then open the test page:

```bash
npm run rebook -- ui
```

Then go to http://localhost:3100. You chat as a customer and see each step, the models used, anything the guards stopped, and the staff queue. **Simulate Groq limit** shows the move to OpenRouter on demand. The page only runs on this computer, sends nothing to WhatsApp, and erases everything when it stops. Messages do go to the AI models, so use made-up details. With no keys, it runs in stub mode.

Run `npm run rebook` to see every command.

## Staff dashboard

On the test page, click **Open staff dashboard** (http://localhost:3100/staff/).
It shares the test conversation: send a customer message in the chat, refresh the
dashboard, select the conversation, and reply as staff. Staff replies take over
the chat until **Close handoff and return to assistant** is clicked.

The dashboard includes booking requests, recorded appointments, manually entered
availability slots in the salon's timezone, and editable AED service prices.
Record a new booking against an available slot to reserve it. **Mark handled**
closes a request without creating an appointment; use it after handling a change
or cancellation elsewhere. Recording a booking does not notify the customer;
use the staff reply to communicate it. Pricing edits apply to new assistant turns.
The test chat and its dashboard reset together and are erased on restart.

For a persistent dashboard using the pilot's SQLite database:

```bash
npm run rebook -- dashboard
```

Open http://localhost:3200. This uses `DB_PATH` (default `rebook.db`) and
`SALON_PROFILE`, sharing the pilot's imported clients, messages and requests.
`DASHBOARD_PORT` changes the port. It runs on this computer only; replies are saved
and printed in the terminal. WhatsApp sending and an external calendar are not
connected to the dashboard yet.

## How the agents work together

```
WhatsApp message
   |
Code rules      opt-outs, staff-owned chats, voice notes, health, refunds (no model used)
   |
Router agent    works out the intent and language
   |
Specialist      Enquiry | Booking | Retention
   |
Code guard      invented prices, discounts, false confirmations, links, medical topics
   |
AI reviewer     a second model checks the draft (GUARD_LLM=off to skip)
   |
Orchestrator    saves requests, adds the link and AI disclosure, then sends
```

A separate Reporter agent writes the owner summary, using totals only. If it uses a number that isn't in the data, the code-written summary replaces it.

Agents only propose. The orchestrator in `src/agents/orchestrator.ts` is the only thing that acts. Anything uncertain or failing goes to staff, and the customer gets a holding message.

## Free models

The system tries Groq first, then OpenRouter's free models, using whichever keys are set. `LLM_PROVIDERS` changes the order and also acts as a hard limit.

- **Cycling:** each request starts at the next model in the rotation. A rate-limited or badly behaved model is benched for a while and the request moves on. If a whole provider is out, the next one takes over.
- **Limits:** when every Groq model is limited, the request moves to OpenRouter straight away. The last provider in the list can't hand over, so it waits once if a model frees up within 25 seconds. That includes Groq in Groq-only mode.
- **Validation:** every answer is checked against a schema, whichever model wrote it.

| | Groq | OpenRouter |
|---|---|---|
| Models | Chat models on a fixed list that your key can access (`GROQ_MODELS` overrides it). In November 2026 a free key had `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and the preview model `qwen/qwen3.8-27b` in rotation, with `openai/gpt-oss-safeguard-20b` as backup | Models with a `:free` id and a listed price of zero; `nvidia/` first (`PREFERRED_MODEL_PREFIXES`) |
| What keeps it free | **Staying on the free plan.** Groq bills by account plan, which this code can't check, so don't upgrade the account unless you mean to pay | Enforced in code, with no paid fallback |
| Limits | Per model, so cycling adds capacity. Measured on a free key in November 2026: 1,000 requests a day and 8,000 tokens a minute per model. Check your [limits page](https://console.groq.com/settings/limits) | 50 requests a day, or 1,000 once you've bought at least 10 credits; 20 a minute |
| Prompt storage | Not kept by default, but may be logged up to 30 days for troubleshooting or abuse checks. Zero data retention is available | Free endpoints may log prompts and use them to improve models |

Each customer reply uses 3 requests, or 2 with `GUARD_LLM=off`. Win-back templates and opt-outs use none. When everything is out, customers get the holding message and their conversations go to staff.

### Privacy

Before real customer messages go through any model:

1. Turn on zero data retention in Groq's Data Controls settings.
2. Set `LLM_PROVIDERS=groq`, so an outage can't send messages to free OpenRouter endpoints. Conversations go to staff instead.
3. Check Groq's terms on training and data location with legal advice. Its data page doesn't cover whether prompts are used for training.

The code also removes names, phone numbers, emails and ID numbers first (`src/privacy/redact.ts`), but it can't catch everything a customer types, such as someone else's name or an address.

## Running a pilot

1. Export clients and visits to CSV, using the columns from `npm run rebook -- sample`.
2. Copy `config/salon.example.json`, fill in the real services and prices, and point `SALON_PROFILE` to it.
3. Get the win-back templates approved by Meta. Their names must match the profile.
4. Import, then build the campaign, which fixes the control group:

```bash
npm run rebook -- import clients.csv visits.csv
```

```bash
npm run rebook -- campaign build pilot-1
```

5. Preview, then send. Nothing is really sent without `--live`:

```bash
npm run rebook -- campaign send pilot-1
```

```bash
npm run rebook -- campaign send pilot-1 --live
```

6. Staff work through `queue`, and `close <id>` returns a conversation to the assistant.
7. Re-import visits after the window, then run `report pilot-1`.

## Testing

```bash
npm test
```

```bash
npm run typecheck
```

The tests use scripted models and mocks, so they prove the safety logic rather than AI quality. To test real models with synthetic messages (about 24 requests, plus retries):

```bash
npm run rebook -- eval
```

## Not built or not verified yet

- Real WhatsApp traffic: the webhook and sender are only tested against mocks.
- Voice notes: they go to staff. Groq lists Whisper speech-to-text models, which could change this, but that isn't built.
- Direct booking: the system sends a link or a staff request. Check Fresha partner access separately.
- Gyms: the first version is salons only.
- Hosting the staff dashboard with staff authentication and live WhatsApp sending.
- Hosting and database backups.
