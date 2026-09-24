import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { buildHttpApp } from "./http/app.js";
import { prepareAutomaticCampaigns } from './services/preparation.js';

const config = loadConfig();
const sql = createDatabase(config);
const app = buildHttpApp(config, sql);
let preparationRunning = false;
const preparationTimer = config.LOCAL_DASHBOARD_ENABLED ? setInterval(() => {
  if (preparationRunning) return;
  preparationRunning = true;
  void prepareAutomaticCampaigns(sql).catch(() => app.log.error('Automatic preparation failed; no mail sent'))
    .finally(() => { preparationRunning = false; });
}, 30_000) : null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  if (preparationTimer) clearInterval(preparationTimer);
  await app.close();
  await sql.end({ timeout: 5 });
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });
