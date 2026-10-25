import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import type { AppDeps } from "./deps.js";
import { createNotifier } from "./domain/notifications.js";
import { createApp } from "./http/app.js";
import { createChordClient } from "./integrations/chord.js";
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

const deps: AppDeps = {
  db,
  paystack: createPaystackClient(config.paystackSecretKey),
  publicBaseUrl: config.publicBaseUrl,
  paymentEmailDomain: config.paymentEmailDomain,
};
if (config.notifyOwner && config.chord) {
  const notifier = createNotifier({ ...deps, chord: createChordClient(config.chord) });
  deps.notifier = notifier;
  notifier.requeueRecentPending();
  console.log("[notify] owner notifications on");
}

const app = createApp(deps, { mcpToken: config.mcpToken, ownerMcpToken: config.ownerMcpToken });
app.listen(config.port, config.host, () => {
  console.log(`ouida-mcp listening on http://${config.host}:${config.port} (Paystack test mode, public URL ${config.publicBaseUrl})`);
});
