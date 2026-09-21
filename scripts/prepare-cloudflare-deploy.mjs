import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL("../dist/server/wrangler.json", import.meta.url);
const databaseId = requiredEnvironmentVariable("CLOUDFLARE_D1_DATABASE_ID");
const databaseName = requiredEnvironmentVariable("CLOUDFLARE_D1_DATABASE_NAME");
const workerName = requiredEnvironmentVariable("CLOUDFLARE_WORKER_NAME");

const config = JSON.parse(await readFile(configPath, "utf8"));
const database = config.d1_databases?.find(
  (candidate) => candidate.binding === "DB",
);

if (!database) {
  throw new Error("The generated Worker configuration has no DB binding.");
}

config.name = workerName;
config.topLevelName = workerName;
config.keep_vars = true;
database.database_id = databaseId;
database.database_name = databaseName;
database.migrations_dir = "../../drizzle";

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared ${workerName} for D1 database ${databaseName}.`);

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required build variable: ${name}`);
  return value;
}
