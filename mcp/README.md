# ouida-mcp

MCP server for the Ouida Café order desk on Chord. It is the single source of truth for the menu and prices, and prices every order itself.

Runs in Docker on port 8020, on the shared `web` network, behind the existing Caddy proxy. Data lives in SQLite at `/data/ouida.db`, on a volume that survives redeploys.

## Tools

| Tool | What it does |
| --- | --- |
| `ping` | Connectivity check |
| `get_menu` | Every available item with its id and price, plus the per-plate fee |
| `create_order` | Validates and prices an order from item ids and quantities, saves it as `pending_payment`, returns a reference (`OU-7KQ3`) and a ready-to-send WhatsApp receipt |

Business outcomes (`item_not_found`, `wrong_section`, …) come back as normal results with a `status`. Only unexpected failures are tool errors (`Order system unavailable`).

## Layout

```
src/
├── index.ts              entry point: config → database → HTTP server
├── config.ts             environment variables, checked once at startup
├── http/
│   ├── app.ts            Express app: /health and /mcp
│   └── auth.ts           bearer-token middleware
├── mcp/
│   ├── server.ts         buildServer(): registers every tool
│   ├── result.ts         result / tool-error helpers
│   └── tools/            one file per tool: schema, description, handler
├── domain/               business rules, no HTTP or MCP code
│   ├── types.ts          catalogue, settings and order shapes
│   ├── menu.ts           reads the catalogue and settings
│   ├── orders.ts         validation, pricing, references, saving
│   └── receipt.ts        WhatsApp receipt rendering
└── db/
    ├── index.ts          opens the database, creates tables, seeds
    └── seed/catalogue.json   the initial 33-item catalogue
test/                     node:test unit tests against an in-memory database
scripts/smoke-test.sh     end-to-end checks against a running server
```

To add a tool: put its rules in `domain/`, its MCP wrapper in `mcp/tools/`, and register it in `mcp/server.ts`.

## Develop

Needs Node 22.13+ (`nvm use` reads `.nvmrc`). `node:sqlite` prints an *ExperimentalWarning* at startup; that is expected.

```bash
cp .env.example .env   # then set MCP_TOKEN (32+ characters)
npm install
npm run dev            # database at ./data/ouida.db
npm test
npm run typecheck
```

The catalogue is seeded from `src/db/seed/catalogue.json` only when it is empty, so later edits in the database survive restarts. To reseed locally, delete `data/`.

## Deploy on the VPS

First time only, from `~/srv/ouida-cafe`:

```bash
cp mcp/.env.example mcp/.env
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/" mcp/.env
mkdir -p data && sudo chown 1000:1000 data   # writable by the container's node user
```

Then, each time:

```bash
docker compose up -d --build
docker compose logs -f
```

## Test

```bash
docker run --rm --network web curlimages/curl -s http://ouida-mcp:8020/health
scripts/smoke-test.sh https://ouida-mcp.eleven-sports.com "$MCP_TOKEN"
```

The smoke test creates two real `pending_payment` orders. That is harmless in v1: unpaid orders never reach the kitchen.
