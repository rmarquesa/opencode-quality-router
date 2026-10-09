#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { StateStore } from "./store.mjs";
import { QuotaService } from "./quotas.mjs";
const args = process.argv.slice(2);
const command = args.shift();
const index = args.indexOf("--config");
if (!["check", "quota"].includes(command) || (index >= 0 && !args[index + 1])) {
  console.error(
    "Usage: node src/cli.mjs <check|quota> [--config /path/to/quality-router.json]",
  );
  process.exitCode = 2;
} else
  try {
    const config = await loadConfig(
      index >= 0 ? { configPath: args[index + 1] } : {},
    );
    if (command === "check")
      console.log(
        JSON.stringify({ valid: true, agents: Object.keys(config.agents) }),
      );
    else {
      const store = new StateStore(config.statePath);
      const service = new QuotaService(config, store);
      const providers = Object.values(config.agents).flatMap((p) =>
        p.candidates.map((c) => c.model.split("/")[0]),
      );
      const state = await service.refreshAll(providers, true);
      console.log(
        JSON.stringify({ observations: state.observations }, null, 2),
      );
    }
  } catch {
    console.error(
      "Configuration or quota-state operation failed. Check paths, JSON, and filesystem permissions.",
    );
    process.exitCode = 1;
  }
