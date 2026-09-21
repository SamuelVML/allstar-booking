import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const config = fileURLToPath(
  new URL("../dist/server/wrangler.json", import.meta.url),
);

run([
  wrangler,
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  config,
]);
run([wrangler, "deploy", "--config", config]);

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
