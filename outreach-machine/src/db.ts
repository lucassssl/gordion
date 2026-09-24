import postgres from "postgres";
import type { AppConfig } from "./config.js";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(config: Pick<AppConfig, "DATABASE_URL">) {
  return postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: postgres.camel,
    onnotice: () => undefined,
  });
}
