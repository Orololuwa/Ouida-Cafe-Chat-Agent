// Every environment variable the service reads, checked once at startup.

export interface ChordConfig {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  menuTeammateId: string;
}

export interface Config {
  port: number;
  host: string;
  mcpToken: string;
  ownerMcpToken: string;
  dbPath: string;
  paystackSecretKey: string;
  publicBaseUrl: string; // no trailing slash
  paymentEmailDomain: string;
  notifyOwner: boolean;
  chord?: ChordConfig;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mcpToken = env.MCP_TOKEN;
  if (!mcpToken || mcpToken.length < 32) {
    throw new ConfigError("MCP_TOKEN is missing or shorter than 32 characters. Set it in .env.");
  }

  // A second token so the owner line cannot be reached with the customer token, or the other way round.
  const ownerMcpToken = env.OWNER_MCP_TOKEN;
  if (!ownerMcpToken || ownerMcpToken.length < 32) {
    throw new ConfigError("OWNER_MCP_TOKEN is missing or shorter than 32 characters. Set it in .env.");
  }
  if (ownerMcpToken === mcpToken) {
    throw new ConfigError("OWNER_MCP_TOKEN must be different from MCP_TOKEN.");
  }

  // Test mode only in v1: refuse anything that isn't a Paystack test key.
  const paystackSecretKey = env.PAYSTACK_SECRET_KEY ?? "";
  if (!paystackSecretKey.startsWith("sk_test_")) {
    throw new ConfigError("PAYSTACK_SECRET_KEY must be a Paystack test key (sk_test_…). Live keys are not allowed yet.");
  }

  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(publicBaseUrl)) {
    throw new ConfigError("PUBLIC_BASE_URL must be an origin like https://ouida-mcp.eleven-sports.app (no path).");
  }

  const paymentEmailDomain = env.PAYMENT_EMAIL_DOMAIN ?? "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(paymentEmailDomain)) {
    throw new ConfigError("PAYMENT_EMAIL_DOMAIN must be a domain like orders.eleven-sports.app.");
  }

  const notifyOwner = (env.NOTIFY_OWNER ?? "").trim().toLowerCase() === "true";
  let chord: ChordConfig | undefined;
  if (notifyOwner) {
    const baseUrl = (env.CHORD_BASE_URL ?? "").replace(/\/+$/, "");
    const apiKey = env.CHORD_API_KEY ?? "";
    const workspaceId = env.CHORD_WORKSPACE_ID ?? "";
    const menuTeammateId = env.MENU_TEAMMATE_ID ?? "";
    if (!/^https?:\/\/[^/\s]+$/.test(baseUrl)) {
      throw new ConfigError("CHORD_BASE_URL must be an origin like https://api.chordhq.xyz when NOTIFY_OWNER=true.");
    }
    if (!apiKey || !workspaceId || !menuTeammateId) {
      throw new ConfigError(
        "NOTIFY_OWNER=true needs CHORD_BASE_URL, CHORD_API_KEY, CHORD_WORKSPACE_ID and MENU_TEAMMATE_ID.",
      );
    }
    chord = { baseUrl, apiKey, workspaceId, menuTeammateId };
  }

  return {
    port: Number(env.PORT ?? 8020),
    // 127.0.0.1 when run directly; Docker sets HOST=0.0.0.0 so Caddy can reach it over the "web" network.
    host: env.HOST ?? "127.0.0.1",
    mcpToken,
    ownerMcpToken,
    // Docker sets DB_PATH=/data/ouida.db on a mounted volume; locally it lands in ./data.
    dbPath: env.DB_PATH ?? "data/ouida.db",
    paystackSecretKey,
    publicBaseUrl,
    paymentEmailDomain,
    notifyOwner,
    ...(chord ? { chord } : {}),
  };
}
