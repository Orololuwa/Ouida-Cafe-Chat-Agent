# ouida-mcp

MCP server for the Ouida Café order desk on Chord. It is the single source of truth for the menu and prices, prices every order itself, and is the only thing that decides an order is paid.

Runs in Docker on port 8020, on the shared `web` network, behind the existing Caddy proxy. Data lives in SQLite at `/data/ouida.db`, on a volume that survives redeploys.

## Tools

| Tool | What it does |
| --- | --- |
| `ping` | Connectivity check |
| `get_menu` | Every available item with its id and price, plus the per-plate fee |
| `create_order` | Validates and prices an order from item ids and quantities, saves it as `pending_payment`, returns a reference (`OU-7KQ3`) and a ready-to-send WhatsApp receipt |
| `create_payment_link` | Returns a Paystack checkout link for an order, reusing the current one while it's still usable. Each attempt has its own reference (`OU-7KQ3-1`, `-2`, …), at most 5 per order |
| `verify_payment` | Asks Paystack about every open attempt and marks the order `paid` only when one is `success`, for exactly the order total, in NGN |

Business outcomes (`item_not_found`, `payment_failed`, …) come back as normal results with a `status`. Only unexpected failures are tool errors (`Order system unavailable`).

`GET /paid` is the public page Paystack sends customers back to. It runs the same check as `verify_payment`, so an order is marked paid even if the customer never replies.

## Layout

```
src/
├── index.ts              entry point: config → database → HTTP server
├── config.ts             environment variables, checked once at startup
├── deps.ts               what tools and routes need at runtime (db, Paystack client, URLs)
├── http/
│   ├── app.ts            Express app: /health, /paid and /mcp
│   ├── auth.ts           bearer-token middleware
│   └── paid-page.ts      the public Paystack callback page
├── mcp/
│   ├── server.ts         buildServer(): registers every tool
│   ├── result.ts         result / tool-error helpers
│   └── tools/            one file per tool: schema, description, handler
├── domain/               business rules, no HTTP or MCP code
│   ├── types.ts          catalogue, order and payment-attempt shapes
│   ├── menu.ts           reads the catalogue and settings
│   ├── orders.ts         validation, pricing, references, saving
│   ├── receipt.ts        WhatsApp receipt rendering
│   └── payments.ts       attempts, the three checks, marking orders paid, messages
├── integrations/
│   └── paystack.ts       the two Paystack calls, timeouts, status mapping
└── db/
    ├── index.ts          opens the database, creates and upgrades tables, seeds
    └── seed/catalogue.json   the initial 33-item catalogue
test/                     node:test unit tests (in-memory database, fake Paystack)
scripts/smoke-test.sh     end-to-end checks against a running server
scripts/mcp-call.sh       call one tool by hand
```

To add a tool: put its rules in `domain/`, its MCP wrapper in `mcp/tools/`, and register it in `mcp/server.ts`. Outside services go in `integrations/`.

## Environment

In `mcp/.env` on each machine (never committed). See `.env.example`.

| Variable | Example | Notes |
| --- | --- | --- |
| `MCP_TOKEN` | 64 hex characters | Chord's bearer token; 32+ characters |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` | Paystack dashboard, test mode. The server refuses to start unless it begins with `sk_test_` |
| `PUBLIC_BASE_URL` | `https://ouida-mcp.eleven-sports.app` | Paystack's `callback_url` and `cancel_action`. Locally `http://127.0.0.1:8020` |
| `PAYMENT_EMAIL_DOMAIN` | `orders.eleven-sports.app` | Paystack needs an email; each order gets `ou-7kq3@<domain>` |
| `DB_PATH` | `data/ouida.db` | Docker sets `/data/ouida.db` |

## Develop

Needs Node 22.13+ (`nvm use` reads `.nvmrc`). `node:sqlite` prints an *ExperimentalWarning* at startup; that is expected.

```bash
cp .env.example .env   # then fill in MCP_TOKEN and PAYSTACK_SECRET_KEY, and set PUBLIC_BASE_URL=http://127.0.0.1:8020
npm install
npm run dev            # database at ./data/ouida.db
npm test
npm run typecheck
```

The catalogue is seeded from `src/db/seed/catalogue.json` only when it is empty, so later edits in the database survive restarts. New tables and columns are added on startup, so an existing database upgrades in place. To start over locally, delete `data/`.

## Deploy on the VPS

First time only, from `/srv/ouida-cafe`:

```bash
cp mcp/.env.example mcp/.env
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/" mcp/.env
mkdir -p data && sudo chown 1000:1000 data   # writable by the container's node user
```

Then set `PAYSTACK_SECRET_KEY`, `PUBLIC_BASE_URL` and `PAYMENT_EMAIL_DOMAIN` in `mcp/.env`. Each deploy:

```bash
docker compose up -d --build
docker compose logs -f
```

## Test

```bash
docker run --rm --network web curlimages/curl -s http://ouida-mcp:8020/health
scripts/smoke-test.sh https://ouida-mcp.eleven-sports.app "$MCP_TOKEN"
```

The smoke test creates a few real `pending_payment` orders and one Paystack test transaction. That is harmless: unpaid orders never reach the kitchen, and test mode moves no money. It ends by printing how to finish the payment by hand with a [Paystack test card](https://paystack.com/docs/payments/test-payments/):

| Card | Number | CVV | Result |
| --- | --- | --- | --- |
| Success | 4084 0840 8408 4081 | 408 | Paid |
| Declined | 4084 0800 0000 5408 | 001 | Fails |
| Insufficient funds | 4084 0800 0067 0037 | 787 | Fails |

Any future expiry date works.
