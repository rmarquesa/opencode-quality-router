#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { StateStore } from "./store.mjs";
import { QuotaService } from "./quotas.mjs";
import { readFile } from "node:fs/promises";
import { matrixRows } from "./matrix.mjs";
import { modelOf } from "./routing.mjs";
const args = process.argv.slice(2);
const command = args.shift();
const index = args.indexOf("--config");
if (
  !["check", "quota", "matrix", "unblock"].includes(command) ||
  (index >= 0 && !args[index + 1])
) {
  console.error(
    "Usage: node src/cli.mjs <check|quota|matrix|unblock> [--config /path/to/quality-router.json] [--catalog /path/to/catalog.json] [--model provider/model]",
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
    else if (command === "unblock") {
      const modelIndex = args.indexOf("--model");
      if (modelIndex < 0 || !args[modelIndex + 1])
        throw new Error("Model required");
      const model = args[modelIndex + 1];
      modelOf(model);
      let cleared = false;
      await new StateStore(config.statePath).update((s) => {
        cleared = !!s.blocks[model];
        delete s.blocks[model];
      });
      console.log(JSON.stringify({ model, blockCleared: cleared }));
    } else if (command === "matrix") {
      const catalogIndex = args.indexOf("--catalog");
      if (catalogIndex < 0 || !args[catalogIndex + 1])
        throw new Error("Catalog required");
      const catalog = new Map(
        Object.entries(
          JSON.parse(await readFile(args[catalogIndex + 1], "utf8")),
        ),
      );
      const state = await new StateStore(config.statePath).read();
      console.log(
        JSON.stringify(
          {
            version: 1,
            generatedAt: new Date().toISOString(),
            rows: matrixRows(config, catalog, state),
          },
          null,
          2,
        ),
      );
    } else {
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
