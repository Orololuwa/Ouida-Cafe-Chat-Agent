# Ouida Café

Ouida Café is an MCP-based ordering service. The server in `mcp/` manages the menu, prices orders, creates Paystack test payments, and stores its data in SQLite. The files in `agents/` contain the Chord teammate instructions that use the server.

## Run with Docker

### Prerequisites

- Docker with Docker Compose
- A Paystack **test** secret key (`sk_test_...`)

### 1. Configure the server

From the project root:

```bash
cp mcp/.env.example mcp/.env
```

Edit `mcp/.env` and set at least:

```dotenv
MCP_TOKEN=<a random string of at least 32 characters>
OWNER_MCP_TOKEN=<a different random string of at least 32 characters>
PAYSTACK_SECRET_KEY=sk_test_...
PUBLIC_BASE_URL=http://127.0.0.1:8020
PAYMENT_EMAIL_DOMAIN=orders.example.com
```

You can generate the two tokens with:

```bash
openssl rand -hex 32
```

Leave `NOTIFY_OWNER=false` unless you have also configured the Chord variables described in `mcp/.env.example`.

### 2. Create the Docker network and data directory

The Compose file expects an external Docker network named `web`:

```bash
docker network inspect web >/dev/null 2>&1 || docker network create web
mkdir -p data
```

On Linux, make the data directory writable by the container user:

```bash
sudo chown 1000:1000 data
```

### 3. Start the service

```bash
docker compose up -d --build
docker compose logs -f ouida-mcp
```

The server is available at `http://127.0.0.1:8020`. Confirm it is running:

```bash
curl http://127.0.0.1:8020/health
```

Stop it with:

```bash
docker compose down
```

The SQLite database is stored in `data/ouida.db` and remains there between container restarts.

## Run locally for development

This requires Node.js 22.13 or newer.

```bash
cd mcp
nvm use
cp .env.example .env
```

Set the required values in `.env` as shown above, then run:

```bash
npm install
npm run dev
```

The local database is created at `mcp/data/ouida.db`.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

For MCP tool details, deployment notes, and smoke-test instructions, see [`mcp/README.md`](mcp/README.md).
