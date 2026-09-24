import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// This entry point is deliberately a local simulator, never a live-mail launcher.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const keyPath = ".outreach-data/local-admin-api-key";
const baseUrl = "http://127.0.0.1:4310";
const statusOnly = process.argv.includes("--status");

async function main() {
  if (!statusOnly) {
    await mkdir(".outreach-data", { recursive: true, mode: 0o700 });
    try {
      const file = await open(keyPath, "wx", 0o600);
      try { await file.writeFile(randomBytes(32).toString("hex")); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chmod(keyPath, 0o600);
  }
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid local API key");

  if (statusOnly) {
    const response = await fetch(`${baseUrl}/v1/system/status`, {
      headers: { "x-admin-api-key": key }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  Object.assign(process.env, {
    NODE_ENV: "development", HOST: "127.0.0.1", PORT: "4310",
    DATABASE_URL: "postgres://gordion:gordion-local-only@127.0.0.1:54329/gordion_outreach",
    ADMIN_API_KEY: key, MAIL_PROVIDER: "simulated", LIVE_SEND_ENABLED: "false",
    GRAPH_ACCESS_STAGE: "read_only",
    LOCAL_DASHBOARD_ENABLED: "true",
  });
  delete process.env.GRAPH_WEBHOOK_CLIENT_STATE;
  delete process.env.PUBLIC_BASE_URL;
  execFileSync("docker", ["compose", "up", "-d", "--wait", "--wait-timeout", "60", "postgres"], {
    stdio: "inherit", timeout: 90_000,
  });
  await import("./migrate.js");
  console.log(`Local dashboard: ${baseUrl} – simulator only, no mail sending.`);
  await import("../src/server.js");
}

main().catch(() => {
  console.error("Local startup/status failed. Check Docker, ports 54329/4310 and the local key file. Existing data was not reset.");
  process.exitCode = 1;
});
