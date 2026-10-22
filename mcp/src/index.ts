import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { createApp } from "./http/app.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
console.log(`[db] using ${config.dbPath}`);

const app = createApp({ db, mcpToken: config.mcpToken });
app.listen(config.port, config.host, () => {
  console.log(`ouida-mcp listening on http://${config.host}:${config.port}`);
});
