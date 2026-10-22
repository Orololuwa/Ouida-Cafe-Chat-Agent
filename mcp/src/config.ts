// Every environment variable the service reads, checked once at startup.

export interface Config {
  port: number;
  host: string;
  mcpToken: string;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mcpToken = env.MCP_TOKEN;
  if (!mcpToken || mcpToken.length < 32) {
    console.error("MCP_TOKEN is missing or shorter than 32 characters. Set it in .env.");
    process.exit(1);
  }

  return {
    port: Number(env.PORT ?? 8020),
    // 127.0.0.1 when run directly; Docker sets HOST=0.0.0.0 so Caddy can reach it over the "web" network.
    host: env.HOST ?? "127.0.0.1",
    mcpToken,
    // Docker sets DB_PATH=/data/ouida.db on a mounted volume; locally it lands in ./data.
    dbPath: env.DB_PATH ?? "data/ouida.db",
  };
}
