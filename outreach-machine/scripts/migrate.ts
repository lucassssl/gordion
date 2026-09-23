import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const migrationsDirectory = path.resolve(process.cwd(), "migrations");
const sql = postgres(databaseUrl, { max: 1 });

try {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations
  `;
  const appliedNames = new Set(applied.map((row) => row.filename));

  for (const file of files) {
    if (appliedNames.has(file)) continue;

    const contents = await readFile(path.join(migrationsDirectory, file), "utf8");
    await sql.unsafe(contents);
    process.stdout.write(`Applied ${file}\n`);
  }
} finally {
  await sql.end();
}
