# ouida-mcp

MCP server for the Ouida Café order desk on Chord.

Runs in Docker on port 8020, on the shared `web` network, behind the existing Caddy proxy.

## Run on the VPS

```bash
cd ~/srv/ouida-mcp
cp .env.example .env
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d --build
docker compose logs -f
```

## Test

```bash
docker run --rm --network web curlimages/curl -s http://ouida-mcp:8020/health
```
