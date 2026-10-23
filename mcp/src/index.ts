import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { createApp } from "./http/app.js";
import { createPaystackClient } from "./integrations/paystack.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const db = openDatabase(config.dbPath);
console.log(`[db] using ${config.dbPath}`);

const app = createApp(
  {
    db,
    paystack: createPaystackClient(config.paystackSecretKey),
    publicBaseUrl: config.publicBaseUrl,
    paymentEmailDomain: config.paymentEmailDomain,
  },
  { mcpToken: config.mcpToken },
);
app.listen(config.port, config.host, () => {
  console.log(`ouida-mcp listening on http://${config.host}:${config.port} (Paystack test mode, public URL ${config.publicBaseUrl})`);
});
