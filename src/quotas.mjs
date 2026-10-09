import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const iso = (value) => {
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
};
const pct = (n) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.min(100, n))
    : undefined;
export function normalizeGo(data) {
  const windows = ["rolling", "weekly", "monthly"].map((group) => {
    const w = data.usage?.[group];
    if (
      !w ||
      !["ok", "rate-limited"].includes(w.status) ||
      pct(w.percent) === undefined ||
      !iso(w.resetsAt)
    )
      throw new Error("Invalid Go quota contract");
    return {
      group,
      status:
        w.status === "rate-limited" || w.percent >= 100
          ? "exhausted"
          : "available",
      remainingPercent: 100 - pct(w.percent),
      resetAt: iso(w.resetsAt),
    };
  });
  return windows;
}
export function normalizeCopilot(data) {
  if (!data.quota_snapshots) throw new Error("No Copilot quota snapshots");
  return Object.entries(data.quota_snapshots).map(([group, w]) => ({
    group: group === "premium_interactions" ? "premium" : group,
    status:
      w.unlimited === true || w.has_quota === true
        ? "available"
        : w.has_quota === false || w.percent_remaining === 0
          ? "exhausted"
          : "unknown",
    remainingPercent: w.unlimited ? 100 : pct(w.percent_remaining),
    unlimited: w.unlimited === true,
    resetAt: iso(data.quota_reset_date_utc ?? data.quota_reset_date),
  }));
}
export function normalizeOpenAI(data) {
  const windows = [];
  for (const [group, w] of Object.entries(data.rate_limit ?? {})) {
    if (!w || typeof w !== "object" || pct(w.used_percent) === undefined)
      continue;
    windows.push({
      group,
      status: w.used_percent >= 100 ? "exhausted" : "available",
      remainingPercent: 100 - pct(w.used_percent),
      resetAt: iso(w.reset_at),
    });
  }
  if (
    data.rate_limit?.limit_reached &&
    !windows.some((w) => w.status === "exhausted")
  )
    windows.push({ group: "account", status: "exhausted" });
  for (const [model, w] of Object.entries(data.model_usage ?? {}))
    windows.push({
      group: "model",
      model,
      status:
        w.available === true
          ? "available"
          : w.available === false
            ? "exhausted"
            : "unknown",
      resetAt: iso(w.available_at),
    });
  if (!windows.length) throw new Error("No OpenAI quota windows");
  return windows;
}
export function normalizeAntigravity(data) {
  if (!Array.isArray(data.accounts) || !data.accounts.length)
    throw new Error("No Antigravity accounts");
  return data.accounts.flatMap((a, i) => {
    const groups =
      a.status === "ok" && a.groups?.length
        ? a.groups
        : [{ name: "gemini" }, { name: "non-gemini" }];
    return groups.map((g) => ({
      account: i + 1,
      group: g.name,
      status:
        a.status !== "ok" || pct(g.remainingPercent) === undefined
          ? "unknown"
          : g.remainingPercent > 0
            ? "available"
            : "exhausted",
      remainingPercent: pct(g.remainingPercent),
      resetAt: iso(g.resetTime),
    }));
  });
}
export class QuotaService {
  constructor(
    config,
    store,
    { fetchImpl = fetch, runCommand = run, clock = Date.now } = {},
  ) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl;
    this.run = runCommand;
    this.clock = clock;
    this.pending = new Map();
  }
  async refresh(provider, force = false) {
    if (this.pending.has(provider)) return this.pending.get(provider);
    const job = (async () => {
      const state = await this.store.read();
      const cached = state.observations[provider];
      const resetDue = cached?.windows?.some(
        (w) =>
          w.status === "exhausted" &&
          Date.parse(w.resetAt) <= this.clock() &&
          Date.parse(w.resetAt) > cached.checkedAt,
      );
      if (
        !force &&
        !resetDue &&
        cached &&
        this.clock() - cached.checkedAt < this.config.quotaTtlMs
      )
        return cached;
      const result = await this.query(provider);
      const observation = {
        ...result,
        checkedAt: this.clock(),
        ...(result.error && cached?.windows?.length
          ? { windows: cached.windows, stale: true }
          : {}),
      };
      await this.store.update((s) => {
        s.observations[provider] = observation;
      });
      return observation;
    })().finally(() => this.pending.delete(provider));
    this.pending.set(provider, job);
    return job;
  }
  async query(provider) {
    const adapter = this.config.quota?.[provider];
    if (!adapter?.enabled)
      return { windows: [], error: "Quota adapter disabled or unconfigured" };
    try {
      if (provider === "google") {
        if (!Array.isArray(adapter.command) || !adapter.command.length)
          return {
            windows: [],
            error: "Configure Antigravity quota CLI command",
          };
        const { stdout } = await this.run(
          adapter.command[0],
          adapter.command.slice(1),
          { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: process.env },
        );
        return { windows: normalizeAntigravity(JSON.parse(stdout)) };
      }
      if (provider === "opencode")
        return {
          windows: [],
          error:
            "Zen balance requires a Console credential; API-key quota adapter is not implemented",
        };
      const auth = JSON.parse(await readFile(this.config.authPath, "utf8"));
      const a = auth[provider];
      if (!a) return { windows: [], error: "No credential for provider" };
      let url, headers, normalize;
      if (provider === "opencode-go") {
        url = "https://opencode.ai/zen/go/v1/usage";
        headers = { Authorization: `Bearer ${a.key}` };
        normalize = normalizeGo;
      } else if (provider === "github-copilot") {
        url = "https://api.github.com/copilot_internal/user";
        normalize = normalizeCopilot;
        headers = {
          Authorization: `token ${a.refresh ?? a.access}`,
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "Editor-Version": "vscode/1.100.0",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
        };
      } else if (provider === "openai") {
        url = "https://chatgpt.com/backend-api/wham/usage";
        normalize = normalizeOpenAI;
        headers = {
          Authorization: `Bearer ${a.access}`,
          ...(a.accountId ? { "ChatGPT-Account-Id": a.accountId } : {}),
        };
      } else return { windows: [], error: "No built-in quota adapter" };
      const response = await this.fetch(url, {
        headers: { ...headers, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        return {
          windows: [],
          error: `Quota endpoint HTTP ${response.status}`,
          httpStatus: response.status,
        };
      return { windows: normalize(await response.json()) };
    } catch {
      return {
        windows: [],
        error:
          "Quota query failed (network, credential, command, or response contract)",
      };
    }
  }
  async refreshAll(providers, force = false) {
    await Promise.all(
      [...new Set(providers)].map((p) => this.refresh(p, force)),
    );
    return this.store.read();
  }
}
