import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { validateConfig } from "./routing.mjs";
export async function loadConfig(options = {}) {
  const base = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
  );
  const path = resolve(
    options.configPath ??
      process.env.OPENCODE_QUALITY_ROUTER_CONFIG ??
      join(base, "quality-router.json"),
  );
  const config = validateConfig(JSON.parse(await readFile(path, "utf8")));
  config.authPath ??= join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );
  config.statePath ??= join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "quality-router",
    "state.json",
  );
  return config;
}
